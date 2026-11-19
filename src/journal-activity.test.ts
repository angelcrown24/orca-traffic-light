import { execFile } from 'node:child_process'
import { assert, test } from 'orca/testing'
import { journalEpoch, journalQuery, readJournalActivity } from './journal-activity'

const id = 'codex_12345678_abcd_1234_abcd_123456789abc'
const meta = { kind: 'meta', version: 2, format: 1 }

test('journal query validates session ID and requests no message or output fields', () => {
  assert.equal(journalQuery("x';DROP TABLE journal_sessions;--", 'workspace'), null)
  assert.equal(journalQuery('another/session', 'workspace'), null)
  const sql = journalQuery(id, 'workspace')!
  assert.equal(sql.includes("'$.body.output'"), false)
  assert.equal(sql.includes("'$.body.input'"), true)
  assert.equal(sql.includes('epoch=(SELECT epoch FROM current)'), true)
  assert.equal(sql.includes("lifecycle_state FROM latest_turn)='running'"), true)
  assert.equal(sql.includes('turn_item_id=(SELECT item_id FROM latest_turn)'), true)
})

test('returns resource names only and deduplicates them', async () => {
  const result = await readJournalActivity(id, 'workspace', async () => [meta,
    { kind: 'call', name: 'shell', input: 'cat /Users/me/.codex/skills/ui-ux-pro-max/SKILL.md secret-token' },
    { kind: 'call', name: 'shell', input: 'cat /Users/me/.codex/skills/ui-ux-pro-max/SKILL.md' },
    { kind: 'call', name: 'mcp__figma__read', input: 'sensitive' },
  ])
  assert.deepEqual(result, { status: 'ready', activeResources: [], resources: [
    { category: 'skill', name: 'ui-ux-pro-max', evidence: 'inferred' },
    { category: 'mcp', name: 'figma', evidence: 'observed' },
  ] })
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(JSON.stringify(result).includes('sensitive'), false)
})

test('marks only tool calls belonging to the running root turn as active', async () => {
  const result = await readJournalActivity(id, 'workspace', async () => [meta,
    { kind: 'call', name: 'shell', input: 'cat /tmp/skills/current/SKILL.md', active: 1, is_root: 1 },
    { kind: 'call', name: 'shell', input: 'cat /tmp/skills/old/SKILL.md', active: 0 },
  ])
  assert.deepEqual(result.activeResources, [{ category: 'skill', name: 'current', evidence: 'inferred' }])
  assert.equal(result.resources.length, 2)
  const noTurn = await readJournalActivity(id, 'workspace', async () => [meta,
    { kind: 'call', name: 'shell', input: 'cat /tmp/skills/current/SKILL.md', active: 0 },
  ])
  assert.deepEqual(noTurn.activeResources, [])
})

test('uses explicit journal MCP identity without treating slash-named built-ins as MCP', async () => {
  const result = await readJournalActivity(id, 'workspace', async () => [meta,
    { kind: 'call', name: 'hindsight/hindsight_search_pages', input: 'private', active: 1, is_root: 1, mcp_server: 'hindsight', mcp_tool: 'hindsight_search_pages' },
    { kind: 'call', name: 'collaboration/spawn_agent', input: 'private', active: 1, is_root: 1, mcp_server: null, mcp_tool: null }
  ])
  assert.deepEqual(result.activeResources, [{ category: 'mcp', name: 'hindsight', evidence: 'observed' }])
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('marks child calls active only for the exact live working producer in the current turn', async () => {
  const rows = [meta,
    { kind: 'call', name: 'shell', input: 'cat /skills/live/SKILL.md', active: 1, is_root: 0, producer: 'live-child' },
    { kind: 'call', name: 'shell', input: 'cat /skills/done/SKILL.md', active: 1, is_root: 0, producer: 'done-child' },
    { kind: 'call', name: 'shell', input: 'cat /skills/old/SKILL.md', active: 0, is_root: 0, producer: 'live-child' },
    { kind: 'call', name: 'shell', input: 'cat /skills/root/SKILL.md', active: 1, is_root: 1, producer: null }
  ]
  const r = await readJournalActivity(id, 'workspace', async () => rows, new Set(['live-child']))
  assert.deepEqual(r.activeResources?.map((x) => x.name), ['live', 'root'])
  const noChildren = await readJournalActivity(id, 'workspace', async () => rows)
  assert.deepEqual(noChildren.activeResources?.map((x) => x.name), ['root'])
})

test('fails closed for old or malformed schemas and runtime errors', async () => {
  assert.equal((await readJournalActivity(id, 'workspace', async () => [{ ...meta, version: 4 }])).status, 'unavailable')
  assert.equal((await readJournalActivity(id, 'workspace', async () => [{ ...meta, format: 0 }])).status, 'unavailable')
  assert.equal((await readJournalActivity(id, 'workspace', async () => [meta, { kind: 'message', name: 'shell' }])).status, 'unavailable')
  assert.equal((await readJournalActivity(id, 'workspace', async () => { throw new Error('private input') })).status, 'unavailable')
})

test('reports truncated results rather than claiming full history', async () => {
  const rows = Array.from({ length: 301 }, () => ({ kind: 'call', name: 'shell', input: '' }))
  assert.equal((await readJournalActivity(id, 'workspace', async () => [meta, ...rows])).status, 'truncated')
})

test('retains the root Antigravity dispatch time outside the visible calls, independent of later roster queries', async () => {
  const base = { kind: 'call', name: 'invoke_subagent', at_ms: 1700000000000, seq: 1, idx: 0, is_root: 1, state: 'completed' }
  const other = [
    { name: 'manage_subagents', input: '{"Action":"list"}' }, { state: 'failed' }, { state: 'running' },
    { is_root: 0 }, { mcp_server: 'custom', mcp_tool: 'invoke_subagent' }, { name: 'unrelated_tool' }
  ].map(changes => ({ ...base, at_ms: base.at_ms + 5000, ...changes }))
  const recent = Array.from({ length: 30 }, (_, i) => ({ ...base, seq: i + 2, name: 'read_file', at_ms: base.at_ms + 6000 + i }))
  const read = (rows: unknown[]) => readJournalActivity(id, 'workspace', async () => [meta, ...rows])
  assert.equal((await read(other)).lastSubagentInvocationAt, undefined)
  const result = await read([...other, ...recent, base, { ...base, at_ms: base.at_ms - 1000 }])
  assert.equal(result.lastSubagentInvocationAt, base.at_ms)
  assert.ok(result.recentTools?.every(tool => tool.name === 'read_file'))
})

test('decodes Antigravity wrapper calls and file reads from a UUID session and omits free-form titles', async () => {
  const uuid = '12345678-abcd-4123-9123-123456789abc'
  assert.ok(journalQuery(uuid, 'workspace'))
  const base = { kind: 'call', seq: 5, idx: 0, at_ms: 1700000000000, state: 'completed', active: 0, is_root: 1 }
  const r = await readJournalActivity(uuid, 'workspace', async () => [meta,
    { ...base, name: 'execute', input: '{"ServerName":"jev","ToolName":"jev_rank","Arguments":{"private":"secret"}}' },
    { ...base, idx: 1, name: 'Running view_file', input: '{"AbsolutePath":"/agent/skills/panel-design/SKILL.md"}' },
    { ...base, idx: 2, name: 'read_file', input: '{"Path":"/agent/skills/probe/SKILL.md"}' },
    { ...base, idx: 3, name: 'private question here?', input: '{}' },
    { ...base, idx: 4, name: 'read_file', state: 'running', active: 0 },
  ])
  assert.deepEqual(r.resources.map(x => x.name), ['jev', 'panel-design', 'probe'])
  assert.deepEqual(r.recentTools?.map(x => [x.name, x.state]), [['jev/jev_rank', 'completed'], ['view_file', 'completed'], ['read_file', 'completed'], ['read_file', 'unknown']])
  assert.equal(JSON.stringify(r).includes('secret'), false)
  assert.equal(JSON.stringify(r).includes('private question'), false)
})

test('a delegated working session does not mark the settled parent’s calls as in use', async () => {
  const call = { kind: 'call', active: 1, seq: 1, idx: 0, at_ms: 1, state: 'running' }
  const result = await readJournalActivity(id, 'workspace', async () => [meta,
    { ...call, name: 'mcp__parent__run', is_root: 1 },
    { ...call, idx: 1, name: 'mcp__child__run', is_root: 0, producer: 'child' }
  ], new Set(['child']), false)
  assert.deepEqual(result.activeResources?.map(x => x.name), ['child'])
  assert.deepEqual(result.recentTools?.map(x => x.state), ['unknown', 'running'])
})

test('SQLite pins the read epoch to its canonical workspace, including names with apostrophes', async () => {
  if (process.platform !== 'darwin') return
  const schema = "CREATE TABLE journal_chat_state(session_id,epoch,workspace_id);" +
    "INSERT INTO journal_chat_state VALUES ('" + id + "',42,'repo::/one''s folder');"
  const epochs = (workspace: string) => new Promise<unknown>((resolve, reject) => {
    execFile('/usr/bin/sqlite3', ['-json', ':memory:', schema + journalEpoch(id, workspace)],
      { timeout: 2000, maxBuffer: 4096, encoding: 'utf8' }, (err, stdout) => {
        if (err) return reject(err)
        resolve(JSON.parse(stdout || '[]'))
      })
  })
  assert.deepEqual(await epochs("repo::/one's folder"), [{ epoch: 42 }])
  assert.deepEqual(await epochs("repo::/one's folder::workspace:other"), [])
  assert.equal(journalEpoch(id, ''), null)
})
