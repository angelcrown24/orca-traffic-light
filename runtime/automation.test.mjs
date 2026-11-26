import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { recommendCapabilities } from './skill-recommend.mjs'
import { createAutomation } from './automation.mjs'
import { removeBootstrap } from './bootstrap.mjs'

const fake = `const rl=require('node:readline').createInterface({input:process.stdin});let count=0;rl.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result;if(q.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}}};else if(q.method==='tools/list')result={tools:[{name:'counter',inputSchema:{type:'object'}}]};else result={content:[{type:'text',text:String(++count)}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n')})`
const record = { id: 'server', name: 'Fixture MCP', kind: 'mcp' }
const item = {
  ...record,
  description: 'count values',
  available: true,
  providers: [],
  source: 'fixture'
}
async function confirmInstructions(runtime) {
  const preview = await runtime.previewBootstrap()
  return runtime.enableBootstrap(preview.revision)
}
async function fixture(t, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'traffic-auto-'))
  await mkdir(join(home, 'project', 'nested'), { recursive: true })
  await mkdir(join(home, 'other'))
  const workspace = await realpath(join(home, 'project'))
  const other = await realpath(join(home, 'other'))
  const events = []
  const runtime = await createAutomation({
    home,
    onEvent: (e) => events.push(e),
    resolveRecord: async () => ({ command: process.execPath, args: ['-e', fake] }),
    ...extra
  })
  t.after(async () => {
    await runtime.close()
    await rm(home, { recursive: true, force: true })
  })
  return { home, workspace, other, runtime, events }
}
async function access(home, cwd, op, extra = {}) {
  const lease = JSON.parse(
    await readFile(join(home, '.agents', 'traffic-light', 'automation.json'), 'utf8')
  )
  const response = await fetch(lease.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lease.token },
    body: JSON.stringify({ op, cwd, ...extra })
  })
  return response.json()
}
const grant = (runtime, path, id = 'workspace') =>
  runtime.grant({ workspaceId: id, workspacePath: path, records: [record], items: [item] })
const counter = (data) => data.result.content[0].text

test('creation and status make no files; grant/search/start never start MCP', async (t) => {
  let resolutions = 0
  const { home, workspace, runtime } = await fixture(t, {
    resolveRecord: async () => {
      resolutions++
      return { command: process.execPath, args: ['-e', fake] }
    }
  })
  assert.equal((await runtime.status()).setup, false)
  await assert.rejects(lstat(join(home, '.agents')), { code: 'ENOENT' })
  await grant(runtime, workspace)
  const search = await access(home, workspace, 'search', { query: 'count' })
  assert.equal(search.result.items.length, 1)
  const start = await access(home, workspace, 'start')
  assert.ok(start.result.session)
  assert.equal(resolutions, 0)
  assert.equal(
    (await access(home, workspace, 'tools', { session: start.result.session, id: 'server' })).ok,
    true
  )
  assert.equal(resolutions, 1)
})

test('each conversation receives isolated state and events carry workspace/session IDs', async (t) => {
  const { home, workspace, runtime, events } = await fixture(t)
  await grant(runtime, workspace)
  const a = (await access(home, workspace, 'start')).result.session,
    b = (await access(home, workspace, 'start')).result.session
  assert.notEqual(a, b)
  const call = (session) =>
    access(home, workspace, 'call', { session, id: 'server', tool: 'counter', arguments: {} })
  assert.equal(counter(await call(a)), '1')
  assert.equal(counter(await call(a)), '2')
  assert.equal(counter(await call(b)), '1')
  assert.ok(events.every((x) => x.workspaceId === 'workspace' && [a, b].includes(x.sessionId)))
  assert.equal((await runtime.status()).workspaces[0].sessions, 2)
})

test('canonical cwd, not focused UI, controls workspace; longest nested root wins', async (t) => {
  const { home, workspace, other, runtime } = await fixture(t)
  await grant(runtime, workspace)
  await grant(runtime, other, 'other')
  const session = (await access(home, workspace, 'start')).result.session
  assert.equal(
    (await access(home, other, 'tools', { session, id: 'server' })).error.code,
    'SESSION_UNAVAILABLE'
  )
  const nested = join(workspace, 'nested')
  await grant(runtime, nested, 'nested')
  assert.equal(
    (await access(home, nested, 'tools', { session, id: 'server' })).error.code,
    'SESSION_UNAVAILABLE'
  )
  await symlink(workspace, join(home, 'alias'))
  assert.equal(
    (await access(home, join(home, 'alias'), 'search', { query: 'count' })).result.items.length,
    1
  )
  assert.equal(
    (await access(home, home, 'search', { query: 'count' })).error.code,
    'WORKSPACE_DISABLED'
  )
})

test('new grants change future sessions only; explicit revoke invalidates existing handles', async (t) => {
  const { home, workspace, runtime } = await fixture(t)
  await grant(runtime, workspace)
  const session = (await access(home, workspace, 'start')).result.session
  await runtime.grant({
    workspaceId: 'workspace',
    workspacePath: workspace,
    records: [{ ...record, id: 'new' }],
    items: [{ ...item, id: 'new' }]
  })
  assert.equal(
    (await access(home, workspace, 'search', { session, query: 'count' })).result.items[0].id,
    'server'
  )
  assert.equal(
    (await access(home, workspace, 'search', { query: 'count' })).result.items[0].id,
    'new'
  )
  assert.equal(
    (await access(home, workspace, 'tools', { session, id: 'new' })).error.code,
    'NOT_SELECTED'
  )
  await runtime.revoke('workspace')
  assert.equal(
    (await access(home, workspace, 'tools', { session, id: 'server' })).error.code,
    'WORKSPACE_DISABLED'
  )
})

test('selected search is bounded to ten metadata entries and does not expose private records', async (t) => {
  const { home, workspace, runtime } = await fixture(t)
  const records = Array.from({ length: 15 }, (_, i) => ({
    ...record,
    id: 'server-' + i,
    secret: 'never-public'
  }))
  await runtime.grant({
    workspaceId: 'workspace',
    workspacePath: workspace,
    records,
    items: records.map((x) => ({ ...item, id: x.id }))
  })
  const result = await access(home, workspace, 'search', { query: '' })
  assert.equal(result.result.items.length, 10)
  assert.equal(result.result.limited, true)
  assert.ok(!JSON.stringify(result).includes('never-public'))
})

test('competing live runtime cannot overwrite rendezvous or remove the owner on close', async (t) => {
  const { home, workspace, runtime } = await fixture(t)
  await grant(runtime, workspace)
  const path = join(home, '.agents', 'traffic-light', 'automation.json'),
    before = await readFile(path)
  const competing = await createAutomation({ home })
  await assert.rejects(grant(competing, workspace), { code: 'AUTOMATION_IN_USE' })
  await competing.close()
  assert.deepEqual(await readFile(path), before)
  assert.equal((await access(home, workspace, 'search', { query: 'count' })).ok, true)
})

test('bootstrap preserves original bytes and symlinks, creates missing bridge, and removes only its blocks', async (t) => {
  const { home, runtime } = await fixture(t)
  await mkdir(join(home, '.agents'))
  await mkdir(join(home, '.codex'))
  await mkdir(join(home, '.gemini'))
  const ssot = join(home, '.agents', 'AGENTS.md')
  const original = 'User rules without trailing newline'
  await writeFile(ssot, original)
  await symlink(ssot, join(home, '.codex', 'AGENTS.md'))
  await symlink(ssot, join(home, '.gemini', 'GEMINI.md'))
  const result = await confirmInstructions(runtime)
  assert.equal(result.setup, true)
  assert.ok(result.providers.every((x) => x.state === 'ready'))
  assert.equal((await lstat(join(home, '.codex', 'AGENTS.md'))).isSymbolicLink(), true)
  assert.ok((await readFile(ssot, 'utf8')).startsWith(original))
  assert.match(
    await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8'),
    /Read the shared agent instructions/
  )
  await confirmInstructions(runtime)
  assert.equal((await readFile(ssot, 'utf8')).split('traffic-light:auto:start').length, 2)
  await writeFile(ssot, (await readFile(ssot, 'utf8')) + '\nUser addition\n')
  await runtime.disableBootstrap()
  assert.equal(await readFile(ssot, 'utf8'), original + '\nUser addition\n')
  assert.equal((await lstat(join(home, '.codex', 'AGENTS.md'))).isSymbolicLink(), true)
  await assert.rejects(lstat(join(home, '.claude', 'CLAUDE.md')), { code: 'ENOENT' })
})

test('bootstrap refuses modified managed content without overwriting unrelated instructions', async (t) => {
  const { home, runtime } = await fixture(t)
  await confirmInstructions(runtime)
  const path = join(home, '.agents', 'AGENTS.md')
  const edited = (await readFile(path, 'utf8'))
    .replace('Shared capabilities', 'My edit')
    .replace('Traffic Light shared capabilities', 'Changed managed title')
  await writeFile(path, edited)
  await assert.rejects(runtime.enableBootstrap(), { code: 'BOOTSTRAP_CONFLICT' })
  await assert.rejects(runtime.disableBootstrap(), { code: 'BOOTSTRAP_CONFLICT' })
  assert.equal(await readFile(path, 'utf8'), edited)
})

test('stable installed CLI uses cwd and distinct handles without per-session pasted instructions', async (t) => {
  const { home, workspace, other, runtime } = await fixture(t, { rankEnv: { TYPESAFE_BASE_URL: 'https://disabled.invalid' } })
  await grant(runtime, workspace)
  await confirmInstructions(runtime)
  const cli = join(home, '.agents', 'traffic-light', 'auto-cli.mjs')
  async function run(args, cwd = workspace, input = '') {
    const p = spawn(process.execPath, [cli, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '',
      err = ''
    p.stdout.on('data', (x) => (out += x))
    p.stderr.on('data', (x) => (err += x))
    p.stdin.end(input)
    const code = await new Promise((r) => p.on('close', r))
    return { code, out, err }
  }
  const found = await run(['search', 'count'])
  assert.equal(found.code, 0)
  assert.equal(JSON.parse(found.out).items.length, 1)
  assert.deepEqual(JSON.parse((await run(['recommend', 'help count values'])).out).items.map(x => x.id), [record.id])
  const a = JSON.parse((await run(['start'])).out).session,
    b = JSON.parse((await run(['start'])).out).session
  assert.notEqual(a, b)
  const call = await run(['--session', a, 'call', 'server', 'counter'], workspace, '{}')
  assert.equal(call.code, 0)
  assert.match(call.out, /'?1/)
  assert.equal((await run(['--session', a, 'tools', 'server'], other)).code, 1)
  const malformed = await run(
    ['--session', a, 'call', 'server', 'counter'],
    workspace,
    '{secret-value'
  )
  assert.equal(malformed.code, 1)
  assert.ok(!malformed.err.includes('secret-value'))
  assert.equal((await run(['--session', a, 'end'])).code, 0)
  assert.equal((await run(['--session', a, 'tools', 'server'])).code, 1)
})

test('an unresponsive lease owner is not declared dead or overwritten', async (t) => {
  const { createServer } = await import('node:http')
  const { home, workspace, runtime } = await fixture(t)
  const owner = createServer(() => {})
  await new Promise((r) => owner.listen(0, '127.0.0.1', r))
  t.after(async () => {
    owner.closeAllConnections()
    await new Promise((r) => owner.close(r))
  })
  const base = join(home, '.agents', 'traffic-light')
  await mkdir(base, { recursive: true })
  const path = join(base, 'automation.json')
  const lease = JSON.stringify({
    version: 1,
    instance: 'existing-owner',
    endpoint: `http://127.0.0.1:${owner.address().port}/v1/automation`,
    token: 'x'.repeat(43)
  })
  await writeFile(path, lease, { mode: 0o600 })
  await assert.rejects(grant(runtime, workspace), { code: 'AUTOMATION_IN_USE' })
  assert.equal(await readFile(path, 'utf8'), lease)
})

test('dangling provider symlink fails before any instruction rewrite', async (t) => {
  const { home, runtime } = await fixture(t)
  await mkdir(join(home, '.agents'))
  await mkdir(join(home, '.codex'))
  const ssot = join(home, '.agents', 'AGENTS.md')
  await writeFile(ssot, 'preserve these bytes')
  const bridge = join(home, '.codex', 'AGENTS.md')
  await symlink(join(home, 'missing-target'), bridge)
  await assert.rejects(runtime.enableBootstrap(), { code: 'BOOTSTRAP_CONFLICT' })
  assert.equal(await readFile(ssot, 'utf8'), 'preserve these bytes')
  assert.equal((await lstat(bridge)).isSymbolicLink(), true)
})

test('oversized instruction file is refused without truncation', async (t) => {
  const { home, runtime } = await fixture(t)
  await mkdir(join(home, '.agents'))
  const ssot = join(home, '.agents', 'AGENTS.md')
  const original = 'x'.repeat(1024 * 1024 + 1)
  await writeFile(ssot, original)
  await assert.rejects(runtime.enableBootstrap(), { code: 'BOOTSTRAP_CONFLICT' })
  assert.equal((await readFile(ssot)).length, original.length)
})

test('concurrent start requests cannot exceed the conversation session limit', async (t) => {
  const { home, workspace, runtime } = await fixture(t)
  await grant(runtime, workspace)
  for (let i = 0; i < 19; i++) assert.equal((await access(home, workspace, 'start')).ok, true)
  const attempts = await Promise.all([
    access(home, workspace, 'start'),
    access(home, workspace, 'start')
  ])
  assert.equal(attempts.filter((x) => x.ok).length, 1)
  assert.equal(attempts.find((x) => !x.ok).error.code, 'SESSION_LIMIT')
  assert.equal((await runtime.status()).workspaces[0].sessions, 20)
})

test('prepare verifies ownership without enabling workspaces or installing instructions', async t => {
  const { home, workspace, runtime } = await fixture(t)
  const status = await runtime.prepare()
  assert.deepEqual(status.workspaces, [])
  assert.equal(status.setup, false)
  assert.equal((await access(home, workspace, 'search', { query: '' })).error.code, 'WORKSPACE_DISABLED')
  await assert.rejects(lstat(join(home, '.agents', 'AGENTS.md')), { code: 'ENOENT' })
  await assert.rejects(lstat(join(home, '.agents', 'traffic-light', 'auto-cli.mjs')), { code: 'ENOENT' })
})

test('Jev suggestions and observed use are linked by handle and item, never by name or workspace alone', async t => {
  const received = []
  let modelAvailable = true
  const ranker = createServer(async (req, res) => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: modelAvailable ? [{ name: 'kev:fixture', capabilities: ['decision'] }] : [] }))
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received.push(JSON.parse(Buffer.concat(chunks).toString()))
    res.end(JSON.stringify({ answers: { s0: { type: 'noul', noul: 0.8 }, s1: { type: 'noul', noul: 0.91 }, any: { type: 'noul', noul: 0.9 } } }))
  })
  await new Promise(resolve => ranker.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => ranker.close(resolve)))
  let reads = 0
  const recommendations = []
  const { home, workspace, runtime, events } = await fixture(t, {
    rankEnv: { TYPESAFE_BASE_URL: 'http://127.0.0.1:' + ranker.address().port },
    onRecommendations: (workspaceId, rows) => { assert.equal(workspaceId, 'project'); recommendations.push(...rows) },
    resolveRecord: async record => { reads++; return record.kind === 'skill' ? { path: record.path, content: await readFile(record.path, 'utf8') } : { command: process.execPath, args: ['-e', fake] } }
  })
  const skill = { id: 'ui', kind: 'skill', name: 'interface guide', description: 'Accessible UI' }
  const storage = { id: 'db', kind: 'skill', name: 'schema guide', description: 'SQL schemas' }
  const path = join(home, 'private-skill-body.md')
  await writeFile(path, 'Private full instructions.')
  const grantSkills = allowed => runtime.grant({
    workspaceId: 'project', workspacePath: workspace, records: [record, { ...allowed, path }],
    items: [item, skill, storage]
  })
  await grantSkills(skill)
  const { session } = (await access(home, workspace, 'start')).result
  await grantSkills(storage)
  const query = 'Fix icon contrast'
  const before = await access(home, workspace, 'recommend', { session, query })
  assert.equal(before.result.method, 'kev')
  assert.deepEqual(before.result.items.map(i => i.id), [skill.id, item.id])
  assert.deepEqual(received[0].state, { task: query, capabilities: { s0: 'MCP server: Fixture MCP. count values', s1: 'Skill: interface guide. Accessible UI' } })
  const [skillRec, serverRec] = recommendations
  assert.deepEqual(Object.keys(skillRec).sort(), ['at','id','kind','name'])
  assert.deepEqual((await access(home, workspace, 'recommend', { query })).result.items.map(i => i.id), [storage.id, item.id])
  assert.equal(reads, 0)
  assert.equal(events.length, 0)
  const read = await access(home, workspace, 'skill', { session, id: before.result.items[0].id })
  assert.equal(read.result.content, 'Private full instructions.')
  assert.equal(reads, 1)
  assert.equal(events.at(-1).state, 'succeeded')
  assert.equal(events.at(-1).recommendationId, skillRec.id)
  const { session: other } = (await access(home, workspace, 'start')).result
  const callServer = session => access(home, workspace, 'call', { session, id: record.id, tool: 'counter', arguments: {} })
  await callServer(other)
  assert.equal(events.at(-1).recommendationId, undefined)
  await access(home, workspace, 'tools', { session, id: record.id })
  assert.equal(events.at(-1).recommendationId, undefined)
  await access(home, workspace, 'call', { session, id: record.id, tool: 'unadvertised-private-text', arguments: {} })
  assert.equal(events.at(-1).state, 'failed')
  assert.equal(events.at(-1).recommendationId, undefined)
  assert.equal(events.at(-1).name, 'Fixture MCP')
  await callServer(session)
  assert.equal(events.at(-1).capabilityName, 'Fixture MCP')
  assert.equal(events.at(-1).name, 'Fixture MCP · counter')
  assert.equal(events.at(-1).recommendationId, serverRec.id)
  assert.equal(events.at(-2).recommendationId, serverRec.id)
  assert.equal(events.at(-1).operation, 'call')
  const count = recommendations.length
  modelAvailable = false
  const fallback = await access(home, workspace, 'recommend', { session, query: 'count' })
  assert.equal(fallback.result.method, 'keywords')
  assert.deepEqual(fallback.result.items.map(item => item.id), [record.id])
  assert.equal(recommendations.length, count)
  await callServer(session)
  assert.equal(events.at(-1).recommendationId, undefined)
  await access(home, workspace, 'end', { session })
  assert.equal((await callServer(session)).error.code, 'SESSION_UNAVAILABLE')
})

test('a remote Jev configuration falls back to bounded keyword matches', async () => {
  const candidates = Array.from({ length: 6 }, (_, i) => ({ id: String(i), name: 'fixture', kind: 'skill', description: i ? 'interface' : 'storage' }))
  const env = { TYPESAFE_BASE_URL: 'https://api.typesafe.ai' }
  assert.deepEqual(await recommendCapabilities('Improve interface', candidates, env), { method: 'keywords', items: candidates.slice(1, 4) })
  assert.deepEqual((await recommendCapabilities('contrast', candidates, env)).items, [])
})

test('restoring an enabled workspace preserves an older launcher until its file changes are confirmed', async t => {
  const { home, workspace, runtime } = await fixture(t)
  const ssot = join(home, '.agents', 'AGENTS.md'), base = join(home, '.agents', 'traffic-light')
  await mkdir(join(home, '.agents'))
  await writeFile(ssot, 'My instructions')
  await confirmInstructions(runtime)
  const manifestPath = join(base, 'bootstrap.json'), cli = join(base, 'auto-cli.mjs')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const hash = value => createHash('sha256').update(value).digest('hex')
  const older = (await readFile(ssot, 'utf8')).replace(/^- When a skill or external tool[^\n]*\n/m, '')
  await writeFile(ssot, older)
  const actual = await realpath(ssot)
  const file = manifest.files.find(f => f.path === actual)
  file.blockHash = hash(older.match(/<!-- traffic-light:auto:start -->[\s\S]*?<!-- traffic-light:auto:end -->/)[0])
  file.inserted = file.inserted.replace(/^- When a skill or external tool[^\n]*\n/m, '')
  await writeFile(cli, 'old launcher')
  manifest.cliHash = hash('old launcher')
  await writeFile(manifestPath, JSON.stringify(manifest))
  await grant(runtime, workspace)
  assert.equal(await readFile(cli, 'utf8'), 'old launcher')
  assert.equal(await readFile(ssot, 'utf8'), older)
  const preview = await runtime.previewBootstrap()
  await runtime.enableBootstrap(preview.revision)
  assert.match(await readFile(cli, 'utf8'), /recommend "task"/)
  assert.match(await readFile(ssot, 'utf8'), /recommend "short task description"/)
  await removeBootstrap({ home })
  assert.equal(await readFile(ssot, 'utf8'), 'My instructions')
})

test('preview is read-only, names canonical symlink targets and rejects retargeting before install', async t => {
  const { home, runtime } = await fixture(t)
  await mkdir(join(home, '.codex'))
  const instructions = join(home, 'personal.md'), other = join(home,'other.md')
  await writeFile(instructions, 'Personal text')
  await writeFile(other, 'Other text')
  const logical = join(home,'.codex','AGENTS.md')
  await symlink(instructions, logical)
  const preview = await runtime.previewBootstrap()
  assert.deepEqual(preview.files.map(f => f.path).sort(), ['~/.agents/AGENTS.md','~/.claude/CLAUDE.md','~/.codex/AGENTS.md','~/.gemini/GEMINI.md'].sort())
  assert.equal(preview.files.find(f => f.path === '~/.codex/AGENTS.md').target, '~/personal.md')
  await assert.rejects(lstat(join(home,'.agents')), {code:'ENOENT'})
  await rm(logical)
  await symlink(other,logical)
  await assert.rejects(runtime.enableBootstrap(preview.revision), /changed/)
  assert.equal(await readFile(other,'utf8'),'Other text')
  await assert.rejects(lstat(join(home,'.agents','AGENTS.md')), {code:'ENOENT'})
})

test('removal preserves files a user already unconfigured and restores the rest', async t => {
  const { home, runtime } = await fixture(t)
  await confirmInstructions(runtime)
  const codex = join(home,'.codex','AGENTS.md'), gemini = join(home,'.gemini','GEMINI.md')
  await writeFile(codex, 'Replacement instructions')
  await rm(gemini)
  await runtime.disableBootstrap()
  assert.equal(await readFile(codex, 'utf8'), 'Replacement instructions')
  await assert.rejects(lstat(join(home,'.agents','AGENTS.md')), {code:'ENOENT'})
  await assert.rejects(lstat(gemini), {code:'ENOENT'})
})

test('a broken launcher link keeps global cleanup discoverable without starting a connection', async t => {
  const { home, runtime } = await fixture(t)
  await confirmInstructions(runtime)
  const launcher = join(home, '.agents', 'traffic-light', 'auto-cli.mjs')
  await rm(launcher)
  await symlink(join(home, 'missing'), launcher)
  const status = await runtime.status()
  assert.equal(status.setup, false)
  assert.equal(status.managed, true)
  await assert.rejects(runtime.disableBootstrap(), {code:'BOOTSTRAP_CONFLICT'})
  assert.ok((await lstat(launcher)).isSymbolicLink())
})

test('the installer itself refuses an unconfirmed first write', async t => {
  const { home, runtime } = await fixture(t)
  await assert.rejects(runtime.enableBootstrap(), /confirm/i)
  await assert.rejects(lstat(join(home, '.agents')), { code: 'ENOENT' })
})
