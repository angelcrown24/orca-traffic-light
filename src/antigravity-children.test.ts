import { assert, test } from 'orca/testing'
import { execFile } from 'node:child_process'
import { readAntigravityChildren } from './antigravity-children'

const id = (n: number) => '01234567-abcd-4000-abcd-' + String(n).padStart(12, '0')
const workspace = id(1) + '::/project::workspace:' + id(2), parent = id(3), session = id(4)
const now = Date.UTC(2026, 10, 19, 3), home = '/fixture', owners = [{ session, native: parent }]
const row = (n: number, status: string, offset = 0) => ({ child: id(n), parent, status, at_ms: now + offset })
const read = (rows: unknown, links: unknown = owners) => readAntigravityChildren('id:' + workspace, [session], {
  home, now: () => now, journal: async () => links, summaries: async () => rows
})

test('scopes provider states to a recent direct child and never infers ongoing work from a stale report', async () => {
  const children = await read([row(10, 'CASCADE_RUN_STATUS_RUNNING', -30_000), row(11, 'CASCADE_RUN_STATUS_BUSY'),
    row(12, 'CASCADE_RUN_STATUS_RUNNING', -121_000), row(13, 'CASCADE_RUN_STATUS_IDLE', -300_000),
    row(14, 'CASCADE_RUN_STATUS_RUNNING', 60_000), row(15, 'unknown'), row(16, 'CASCADE_RUN_STATUS_IDLE', -86_400_001)])
  assert.deepEqual(children.get(session)?.map(c => c.state), ['working', 'working', 'unverifiable', 'idle', 'unverifiable', 'unverifiable'])
  assert.deepEqual(Object.keys(children.get(session)![0]).sort(), ['state', 'updatedAt'])
  assert.equal((await read([row(10, 'unknown'), row(10, 'unknown')])).size, 0)
  assert.equal((await read([row(10, 'unknown')], [...owners, ...owners])).size, 0)
  assert.equal((await read([{ ...row(10, 'unknown'), parent: id(6) }])).size, 0)
  assert.equal((await read([{ ...row(10, 'unknown'), child: parent }])).size, 0)
})

test('does not query a provider index without exact local session and workspace ownership', async () => {
  let reads = 0
  const options = { home, now: () => now, journal: async () => [], summaries: async () => { reads++; return [] } }
  for (const [scope, ids] of [[workspace, [session]], ['foreign', [session]], [workspace, ['invalid']]] as const) {
    assert.equal((await readAntigravityChildren(scope, [...ids], options)).size, 0)
  }
  assert.equal(reads, 0)
})

function fixtureQuery(schema: string, sql: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sqlite3', ['-json', ':memory:', schema + sql], { encoding: 'utf8', timeout: 2000, maxBuffer: 128 * 1024 }, (error, stdout) => {
      if (error) return reject(error)
      try { resolve(JSON.parse(stdout || '[]')) } catch (e) { reject(e) }
    })
  })
}

test('SQL resolves only the proven local Antigravity account and matching parent and child workspace, prioritizing fresh working rows', async () => {
  if (process.platform !== 'darwin') return
  const r = { sessionId: session, provider: 'antigravity', location: { workspaceId: workspace, executionHostId: 'local' }, accountHome: { variable: 'GEMINI_HOME', path: home + '/.gemini' },
    providerHandleChain: [{ linkId: 'proven', handle: { agent: 'antigravity', transport: 'acp', nativeId: parent } }], lease: { provenHandleLinkId: 'proven' } }
  const domain = (binding: typeof r, workspaceKey: string) => `CREATE TABLE agent_session_records(session_id,record_json); CREATE TABLE journal_chat_state(session_id,workspace_id);
    INSERT INTO agent_session_records VALUES ('${session}','${JSON.stringify(binding)}'); INSERT INTO journal_chat_state VALUES ('${session}','${workspaceKey}');`
  const sqlRow = (child: string, parentId: string, depth: number, status: string, uri: string, offset = 0, killed = 0) =>
    `INSERT INTO conversation_summaries VALUES ('${child}','${parentId}',${depth},'CASCADE_RUN_STATUS_${status}','${new Date(now + offset).toISOString()}','["file://${uri}"]',${killed});`
  const provider = 'CREATE TABLE conversation_summaries(conversation_id PRIMARY KEY,parent_conversation_id,nesting_depth,status,last_modified_time,workspace_uris,killed);' +
    sqlRow(parent, '', 0, 'IDLE', '/project') + sqlRow(id(8), parent, 1, 'RUNNING', '/project', -30_000) +
    Array.from({ length: 15 }, (_, i) => sqlRow(id(100 + i), parent, 1, 'IDLE', '/project')).join('') +
    sqlRow(id(9), parent, 1, 'RUNNING', '/other') + sqlRow(id(10), id(9), 2, 'RUNNING', '/project') + sqlRow(id(11), parent, 1, 'RUNNING', '/project', 0, 1)
  async function check(binding = r, key = workspace) {
    let reads = 0
    const out = await readAntigravityChildren(workspace, [session], { home, now: () => now,
      journal: sql => fixtureQuery(domain(binding, key), sql), summaries: sql => {
        reads++; assert.ok(!/\b(?:title|preview|raw_summary|tool_input|step_payload|agent_name)\b/.test(sql))
        return fixtureQuery(provider, sql)
      } })
    return { out, reads }
  }
  const { out } = await check()
  assert.equal(out.get(session)?.length, 12)
  assert.deepEqual(out.get(session)?.[0], { state: 'working', updatedAt: now - 30_000 })
  assert.ok(out.get(session)?.slice(1).every(row => row.state === 'idle'))
  for (const binding of [{ ...r, provider: 'gemini' }, { ...r, accountHome: { ...r.accountHome, path: '/untrusted' } },
    { ...r, location: { ...r.location, executionHostId: 'remote' } }, { ...r, lease: { provenHandleLinkId: 'different' } },
    { ...r, providerHandleChain: [...r.providerHandleChain, ...r.providerHandleChain] }]) {
    assert.equal((await check(binding)).reads, 0)
  }
  assert.equal((await check(r, 'another')).reads, 0)
})
