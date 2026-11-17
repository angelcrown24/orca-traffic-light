import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createAutomation } from './automation.mjs'
import { installBootstrap, removeBootstrap, bootstrapStatus } from './bootstrap.mjs'

const fake = `const rl=require('node:readline').createInterface({input:process.stdin});let count=0;rl.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;let result;if(q.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}}};else if(q.method==='tools/list')result={tools:[{name:'counter',inputSchema:{type:'object'}}]};else result={content:[{type:'text',text:String(++count)}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n')})`
const record = { id: 'server', name: 'Fixture MCP', kind: 'mcp' }
const item = {
  ...record,
  description: 'count values',
  available: true,
  providers: [],
  source: 'fixture'
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
  const result = await runtime.enableBootstrap()
  assert.equal(result.setup, true)
  assert.ok(result.providers.every((x) => x.state === 'ready'))
  assert.equal((await lstat(join(home, '.codex', 'AGENTS.md'))).isSymbolicLink(), true)
  assert.ok((await readFile(ssot, 'utf8')).startsWith(original))
  assert.match(
    await readFile(join(home, '.claude', 'CLAUDE.md'), 'utf8'),
    /Read the shared agent instructions/
  )
  await runtime.enableBootstrap()
  assert.equal((await readFile(ssot, 'utf8')).split('traffic-light:auto:start').length, 2)
  await writeFile(ssot, (await readFile(ssot, 'utf8')) + '\nUser addition\n')
  await runtime.disableBootstrap()
  assert.equal(await readFile(ssot, 'utf8'), original + '\nUser addition\n')
  assert.equal((await lstat(join(home, '.codex', 'AGENTS.md'))).isSymbolicLink(), true)
  await assert.rejects(lstat(join(home, '.claude', 'CLAUDE.md')), { code: 'ENOENT' })
})

test('bootstrap refuses modified managed content without overwriting unrelated instructions', async (t) => {
  const { home, runtime } = await fixture(t)
  await runtime.enableBootstrap()
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
  const { home, workspace, other, runtime } = await fixture(t)
  await grant(runtime, workspace)
  await runtime.enableBootstrap()
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
