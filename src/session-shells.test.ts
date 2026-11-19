import { assert, test } from 'orca/testing'
import { execFile } from 'node:child_process'
import { readSessionShells } from './session-shells'

const sid = '01234567-abcd-4000-abcd-123456789abc'
const second = '11234567-abcd-4000-abcd-123456789abc'
const terminal = 'term_11234567-abcd-4000-abcd-123456789abc'
const id = 'chat:' + sid
const ctx = { workspaceId: 'identity:here', terminals: [{ id: terminal, title: 'PRIVATE_TITLE' }] }
const agent = {
  paneKey: 'structured-agent-session-' + sid + ':pane',
  orcaSessionId: sid,
  agentType: 'antigravity',
  state: 'working',
  structuredHostOwned: true,
  subagentObservation: 'live'
}
const sibling = {
  ...agent,
  paneKey: 'structured-agent-session-' + second + ':pane',
  orcaSessionId: second,
  toolName: 'shell',
  toolInput: 'PRIVATE_CMD'
}
function snapshot(agents: unknown[], extra: unknown[] = []) {
  return { result: { worktrees: [{ worktreeId: 'raw', hostId: 'local', address: { worktree: ctx.workspaceId }, agents }, ...extra] } }
}

test('automatic selection requires the actual focused tab; never guesses by workspace or carries a disappeared surface', async () => {
  const s = snapshot([agent, sibling])
  const noFocus = await readSessionShells(ctx, s, null)
  assert.equal(noFocus.status, 'select')
  assert.equal(noFocus.options.length, 3)
  assert.deepEqual(noFocus.rows, [])
  assert.deepEqual((await readSessionShells(ctx, s, 'chat:invalid', { focus: id })).rows, [])
  const result = await readSessionShells(ctx, s, null, { focus: id, journal: async () => [] })
  assert.equal(result.selected, id)
  assert.equal(result.rows.length, 0)
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false)
  assert.equal(
    (await readSessionShells(ctx, snapshot([agent], [{ worktreeId: 'foreign', hostId: 'local', agents: [agent] }]), id)).status,
    'select'
  )
})

test('only an exact selected local chat owns its live commands and currently working children', async () => {
  const sub = { id: 'a', kind: 'agent', description: 'builder', state: 'working', membership: 'live' }
  const job = {
    id: 'c',
    kind: 'command',
    state: 'working',
    membership: 'live',
    firstObservedAt: 100,
    operation: { input: 'node private.js SECRET' }
  }
  const s = snapshot([
    {
      ...agent,
      state: 'done',
      toolName: 'shell',
      toolInput: 'npm PRIVATE',
      children: [
        sub,
        job,
        { ...job, id: 'old', state: 'done' },
        { ...job, id: 'pause', state: 'waiting' },
        { ...job, id: 'p', membership: 'settled' },
        { ...sub, id: 'other', state: 'idle' }
      ]
    },
    sibling
  ])
  const r = await readSessionShells(ctx, s, id, {
    journal: async () => {
      throw Error('settled turn must not query journal')
    }
  })
  assert.deepEqual(r.rows, [{ kind: 'background', name: 'node', state: 'running', since: 100 }])
  assert.deepEqual(
    r.subagents.map((a) => a.label),
    ['builder']
  )
  assert.equal(JSON.stringify(r).includes('SECRET'), false)
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false)
  const stale = await readSessionShells(
    ctx,
    snapshot([{ ...agent, state: 'done', subagentObservation: 'unverifiable', children: [sub, job] }]),
    id
  )
  assert.deepEqual(stale.rows, [])
  assert.deepEqual(stale.subagents, [])
})

test('provider lookup reads only the selected local chat under its canonical workspace ID', async () => {
  let calls = 0
  const lookup = async (workspace: string, ids: string[]) => {
    calls++
    assert.equal(workspace, 'raw')
    assert.deepEqual(ids, [sid])
    return new Map([
      [
        sid,
        [
          { state: 'working' as const, updatedAt: 100 },
          { state: 'idle' as const, updatedAt: 101 }
        ]
      ]
    ])
  }
  const r = await readSessionShells(ctx, snapshot([{ ...agent, state: 'done', children: [] }, sibling]), id, { providerChildren: lookup })
  assert.equal(r.subagents.length, 1)
  assert.equal(r.subagents[0].statusSource, 'antigravity')
  assert.equal(
    (await readSessionShells(ctx, snapshot([{ ...agent, state: 'done', children: [] }]), null, { providerChildren: lookup })).subagents
      .length,
    0
  )
  assert.equal(calls, 1)
})

test('a managed PTY must be local, connected and owned by the selected workspace; excludes shell args and terminal output', async () => {
  const t = {
    handle: terminal,
    worktreeId: 'raw',
    tabId: 'tab',
    leafId: 'pane',
    executionHostId: 'local',
    ptyId: 'pty',
    title: 'PRIVATE_TITLE',
    preview: 'PRIVATE OUTPUT',
    connected: true
  }
  const s = snapshot([{ state: 'working', paneKey: 'tab:pane', toolName: 'Bash', toolInput: 'git status --token=PRIVATE' }])
  const probe = (changes: Record<string, unknown>) =>
    readSessionShells(ctx, s, 'terminal:' + terminal, {
      terminal: async (handle) => {
        assert.equal(handle, terminal)
        return { ok: true, result: { terminal: { ...t, ...changes } } }
      }
    })
  const r = await probe({})
  assert.deepEqual(r.rows, [
    { kind: 'terminal', state: 'connected', name: '' },
    { kind: 'shell', state: 'running', name: 'git' }
  ])
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false)
  for (const changes of [
    { executionHostId: 'remote' },
    { worktreeId: 'other' },
    { orphaned: true },
    { verdict: 'unverifiable' },
    { handle: 'different' }
  ]) {
    const bad = await probe(changes)
    assert.equal(bad.status, 'unavailable')
    assert.deepEqual(bad.rows, [])
  }
  assert.deepEqual((await probe({ exitCause: 'user' })).rows, [])
})

test('an ordinary execute tool or a completed underlying main turn cannot become a foreground shell', async () => {
  for (const fields of [
    { toolName: 'execute', toolInput: '{"ServerName":"x","ToolName":"y","command":"git"}' },
    { toolName: 'execute', toolInput: 'unknown' },
    { toolName: 'Bash', mainAgent: { state: 'done' }, toolInput: 'git' }
  ]) {
    const r = await readSessionShells(ctx, snapshot([{ ...agent, ...fields }]), id, { journal: async () => [] })
    assert.equal(r.rows.length, 0)
  }
})

test('SQLite limits running shell metadata to the selected root active turn; includes parallel shells and excludes MCP', async () => {
  if (process.platform !== 'darwin') return
  const schema = `PRAGMA user_version=2;
  CREATE TABLE journal_chat_state(session_id,epoch,workspace_id);
  CREATE TABLE journal_items(session_id,epoch,hidden,root,kind,turn_marker,sequence,sequence_index,ordinal,item_id,lifecycle_state,turn_item_id,payload_json);
  INSERT INTO journal_chat_state VALUES ('${sid}',1,'raw'),('${second}',1,'other');
  INSERT INTO journal_items VALUES ('${sid}',1,0,1,'turn',1,4,0,0,'active','running',NULL,'{}');`
  const rows = [
    [sid, 'active', 'running', 1, 'execute', { command: 'git status --secret=SECRET' }],
    [sid, 'active', 'running', 1, 'Bash', { cmd: 'python3 PRIVATE.py' }],
    [sid, 'active', 'completed', 1, 'shell', { command: 'npm SECRET' }],
    [sid, 'before', 'running', 1, 'shell', { command: 'go SECRET' }],
    [sid, 'active', 'running', 0, 'shell', { command: 'cargo SECRET' }],
    [sid, 'active', 'running', 1, 'execute', { ServerName: 'test', ToolName: 'private', command: 'sh SECRET' }],
    [second, 'active', 'running', 1, 'run_command', { command: 'bash SECRET' }]
  ]
  const inserts = rows
    .map(
      ([session, turn, state, root, name, input], i) =>
        `INSERT INTO journal_items VALUES ('${session}',1,0,${root},'tool-call',0,${10 + i},0,0,'c${i}','${state}','${turn}','${JSON.stringify({ observedAt: 100 + i, body: { name, input } })}');`
    )
    .join('\n')
  const journal = (sql: string) =>
    new Promise<unknown>((resolve, reject) =>
      execFile(
        '/usr/bin/sqlite3',
        ['-json', ':memory:', schema + inserts + sql],
        { timeout: 2000, maxBuffer: 96 * 1024, encoding: 'utf8' },
        (err, stdout) => {
          if (err) reject(err)
          else resolve(JSON.parse(stdout || '[]'))
        }
      )
    )
  const r = await readSessionShells(ctx, snapshot([{ ...agent, toolName: 'Bash' }]), id, { journal })
  assert.deepEqual(
    r.rows.map((x) => [x.name, x.since]),
    [
      ['python3', 101],
      ['git', 100]
    ]
  )
  assert.equal(JSON.stringify(r).includes('SECRET'), false)
  const foreign = { result: { worktrees: [{ worktreeId: "other's workspace", hostId: 'local', address: { worktree: ctx.workspaceId }, agents: [agent] }] } }
  assert.deepEqual((await readSessionShells(ctx, foreign, id, { journal })).rows, [])
})
