import { assert, test } from 'orca/testing'
import { journalQuery, readJournalActivity } from './journal-activity'

const id = 'codex_12345678_abcd_1234_abcd_123456789abc'
const meta = { kind: 'meta', version: 2, format: 1 }

test('journal query validates session ID and requests no message or output fields', () => {
  assert.equal(journalQuery("x';DROP TABLE journal_sessions;--"), null)
  assert.equal(journalQuery('another/session'), null)
  const sql = journalQuery(id)!
  assert.equal(sql.includes("'$.body.output'"), false)
  assert.equal(sql.includes("'$.body.input'"), true)
  assert.equal(sql.includes('epoch=(SELECT epoch FROM current)'), true)
  assert.equal(sql.includes("lifecycle_state FROM latest_turn)='running'"), true)
  assert.equal(sql.includes('turn_item_id=(SELECT item_id FROM latest_turn)'), true)
})

test('returns resource names only and deduplicates them', async () => {
  const result = await readJournalActivity(id, async () => [meta,
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
  const result = await readJournalActivity(id, async () => [meta,
    { kind: 'call', name: 'shell', input: 'cat /tmp/skills/current/SKILL.md', active: 1, is_root: 1 },
    { kind: 'call', name: 'shell', input: 'cat /tmp/skills/old/SKILL.md', active: 0 },
  ])
  assert.deepEqual(result.activeResources, [{ category: 'skill', name: 'current', evidence: 'inferred' }])
  assert.equal(result.resources.length, 2)
  const noTurn = await readJournalActivity(id, async () => [meta,
    { kind: 'call', name: 'shell', input: 'cat /tmp/skills/current/SKILL.md', active: 0 },
  ])
  assert.deepEqual(noTurn.activeResources, [])
})

test('uses explicit journal MCP identity without treating slash-named built-ins as MCP', async () => {
  const result = await readJournalActivity(id, async () => [meta,
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
  const r = await readJournalActivity(id, async () => rows, new Set(['live-child']))
  assert.deepEqual(r.activeResources?.map((x) => x.name), ['live', 'root'])
  const noChildren = await readJournalActivity(id, async () => rows)
  assert.deepEqual(noChildren.activeResources?.map((x) => x.name), ['root'])
})

test('fails closed for old or malformed schemas and runtime errors', async () => {
  assert.equal((await readJournalActivity(id, async () => [{ ...meta, version: 4 }])).status, 'unavailable')
  assert.equal((await readJournalActivity(id, async () => [{ ...meta, format: 0 }])).status, 'unavailable')
  assert.equal((await readJournalActivity(id, async () => [meta, { kind: 'message', name: 'shell' }])).status, 'unavailable')
  assert.equal((await readJournalActivity(id, async () => { throw new Error('private input') })).status, 'unavailable')
})

test('reports truncated results rather than claiming full history', async () => {
  const rows = Array.from({ length: 301 }, () => ({ kind: 'call', name: 'shell', input: '' }))
  assert.equal((await readJournalActivity(id, async () => [meta, ...rows])).status, 'truncated')
})

test('decodes Antigravity wrapper calls and file reads from a UUID session and omits free-form titles', async () => {
  const uuid = '12345678-abcd-4123-9123-123456789abc'
  assert.ok(journalQuery(uuid))
  const base = { kind: 'call', seq: 5, idx: 0, at_ms: 1700000000000, state: 'completed', active: 0, is_root: 1 }
  const r = await readJournalActivity(uuid, async () => [meta,
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
