import { assert, test } from 'orca/testing'
import { execFile } from 'node:child_process'
import { readSessionShells, type SessionWorkNode } from './session-shells'

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
          { key: 'a'.repeat(32), state: 'working' as const, updatedAt: 100 },
          { key: 'b'.repeat(32), state: 'idle' as const, updatedAt: 101 }
        ]
      ]
    ])
  }
  const r = await readSessionShells(ctx, snapshot([{ ...agent, state: 'done', children: [] }, sibling]), id, { providerChildren: lookup })
  assert.equal(r.subagents.length, 1)
  assert.equal(r.subagents[0].statusSource, 'antigravity')
  assert.deepEqual(r.tree, [{ id: 'a'.repeat(32), kind: 'subagent', state: 'working', statusSource: 'antigravity', statusUpdatedAt: 100, children: [] }])
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
  assert.deepEqual(r.tree?.map(n => [n.kind, n.state, n.children.map(c => [c.kind, c.name])]), [['terminal', 'connected', [['shell', 'git']]]])
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
    [sid, 'active', 'running', 1, 'Running functions/shell_command', { command: '/opt/homebrew/bin/python3 PRIVATE.py' }],
    [sid, 'active', 'completed', 1, 'shell', { command: 'npm SECRET' }],
    [sid, 'before', 'running', 1, 'shell', { command: 'go SECRET' }],
    [sid, 'active', 'running', 0, 'shell', { command: 'cargo SECRET' }],
    [sid, 'active', 'running', 1, 'execute', { ServerName: 'test', ToolName: 'private', command: 'sh SECRET' }],
    [second, 'active', 'running', 1, 'run_command', { command: 'bash SECRET' }],
    [sid, 'active', 'running', 1, 'shell', '/bin/zsh -lc PRIVATE'],
    [sid, 'active', 'running', 1, 'Running execute', 'unknown PRIVATE']
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
      ['zsh', 107],
      ['python3', 101],
      ['git', 100]
    ]
  )
  assert.equal(new Set(r.tree?.map(n => n.id)).size, 3)
  assert.equal(JSON.stringify(r).includes('SECRET'), false)
  const foreign = { result: { worktrees: [{ worktreeId: "other's workspace", hostId: 'local', address: { worktree: ctx.workspaceId }, agents: [agent] }] } }
  assert.deepEqual((await readSessionShells(ctx, foreign, id, { journal })).rows, [])
})

test('links interleaved flat Orca records by ownership and keeps siblings distinct through updates', async () => {
  const running = { kind: 'agent', membership: 'live', state: 'working', firstObservedAt: 500, lastMessage: 'PRIVATE text' }
  const reviewer = { ...running, id: 'PRIVATE-reviewer', description: 'reviewer', firstObservedAt: 510 }
  const builder = { ...running, id: 'PRIVATE-builder', name: 'builder', operation: { toolName: 'Bash', basis: 'open', input: 'npm test PRIVATE_TOKEN', observedAt: 600 } }
  const workflow = { ...running, id: 'PRIVATE-flow', parentChildWorkId: builder.id, kind: 'workflow', state: 'done', membership: 'settled', name: 'private_title' }
  const nested = { ...running, id: 'PRIVATE-grandchild', parentChildWorkId: workflow.id, description: 'compiler', state: 'monitoring' }
  const job = { ...running, id: 'PRIVATE-job', parentChildWorkId: reviewer.id, kind: 'command', operation: { input: '/usr/bin/git status --token PRIVATE_TOKEN' } }
  const settled = { ...running, id: 'PRIVATE-done', parentChildWorkId: reviewer.id, state: 'done', membership: 'settled' }
  const rows = [nested, job, settled, reviewer, workflow, builder]
  const read = (children: unknown[]) => readSessionShells(ctx, snapshot([{ ...agent, children }, sibling]), id, { journal: async () => [] })
  const r = await read(rows)
  function branch(nodes: SessionWorkNode[]): unknown[] {
    return nodes.map(node => [node.kind, node.name ?? null, node.state, node.since ?? null, branch(node.children)])
  }
  assert.deepEqual(branch(r.tree!), [
    ['subagent', 'builder', 'working', 500, [
      ['shell', 'npm', 'running', 600, []], ['workflow', null, 'context', null, [['subagent', 'compiler', 'monitoring', 500, []]]]
    ]],
    ['subagent', 'reviewer', 'working', 510, [['background', 'git', 'running', 500, []]]]
  ])
  assert.ok(!JSON.stringify(r).includes('PRIVATE') && !JSON.stringify(r).includes('private_title'))
  const keys = (nodes: SessionWorkNode[]): string[] => nodes.flatMap(n => [n.id, ...keys(n.children)]).sort()
  assert.deepEqual(r.tree, (await read([...rows].reverse())).tree)
  assert.equal(new Set(keys(r.tree!)).size, 6)
  assert.ok(keys(r.tree!).every(key => /^[a-f0-9]{32}$/.test(key)))
  assert.deepEqual((await read([workflow, settled])).tree, [])
  const ended = await read([job, { ...reviewer, state: 'done', membership: 'settled' }])
  assert.deepEqual(branch(ended.tree!), [['subagent', 'reviewer', 'context', null, [['background', 'git', 'running', 500, []]]]])
})

test('drops dangling, cyclical, duplicate and contradictory ownership; accepts matching older nested projections', async () => {
  const child = (id: string, parent?: string) => ({ id, kind: 'agent', state: 'working', membership: 'live', description: id,
    ...(parent ? { parentChildWorkId: parent } : {}) })
  const top = { ...child('top'), children: [child('nested'), child('both', 'top'), child('contradicts', 'missing')] }
  const children = [child('zombie', 'contradicts'), child('a', 'b'), child('b', 'a'), child('bystander', 'a'),
    child('orphan', 'foreign'), child('dupe'), child('dupe'), child('unowned', 'dupe'), top, child('both', 'top')]
  const r = await readSessionShells(ctx, snapshot([{ ...agent, children }]), id, { journal: async () => [] })
  assert.deepEqual(r.tree?.map(n => [n.name, n.children.map(c => c.name)]), [['top', ['both', 'nested']]])
  const stale = await readSessionShells(ctx, snapshot([{ ...agent, subagentObservation: 'unverifiable', children }]), id, { journal: async () => [] })
  assert.deepEqual(stale.tree, [])
})

test('legacy subagent task IDs keep their start time; terminal and unrelated-session information stays out of the selected chat', async () => {
  const legacy = { id: 'private-provider-id', state: 'working', startedAt: 40, description: 'Private task: TOKEN' }
  const r = await readSessionShells(ctx, snapshot([{ ...agent, state: 'done', subagents: [legacy] },
    { ...sibling, children: [{ id: 'other', kind: 'agent', membership: 'live', state: 'working', description: 'unrelated' }] }]), id)
  assert.deepEqual(r.tree?.map(n => [n.kind, n.name, n.since, n.children]), [['subagent', undefined, 40, []]])
  assert.ok(!JSON.stringify(r).includes('TOKEN') && !JSON.stringify(r).includes('provider-id') && !JSON.stringify(r).includes('unrelated'))
})

test('an oversized roster reports unavailable rather than an idle session', async () => {
  const children = Array.from({ length: 1001 }, (_, i) => ({ kind: 'agent', id: 'c' + i, state: 'working', membership: 'live' }))
  const r = await readSessionShells(ctx, snapshot([{ ...agent, children }]), id, { journal: async () => [] })
  assert.equal(r.status, 'unavailable')
})

test('Codex child shells require matching producer, precise thread and current child turn; they can outlive the main turn', async () => {
  if (process.platform !== 'darwin') return
  const worker = { id: 'PRIVATE-host', providerId: 'PRIVATE-thread', kind: 'agent', state: 'working', membership: 'live',
    description: 'tester', invocation: { generation: 2, invocationId: 'PRIVATE:turn' },
    operation: { toolName: 'Bash', basis: 'open', input: 'npm test PRIVATE', observedAt: 12 } }
  const task = { id: 'PRIVATE-job', kind: 'command', state: 'working', membership: 'live', parentChildWorkId: worker.id }
  const key = 'codex:PRIVATE-thread:PRIVATE%3Aturn:'
  const schema = `PRAGMA user_version=2;
    CREATE TABLE journal_chat_state(session_id,epoch,workspace_id);
    CREATE TABLE journal_items(session_id,epoch,hidden,root,kind,turn_marker,sequence,sequence_index,ordinal,item_id,lifecycle_state,turn_item_id,payload_json,producer_agent_id);
    INSERT INTO journal_chat_state VALUES ('${sid}','epoch:PRIVATE','raw');
    INSERT INTO journal_items VALUES ('${sid}','epoch:PRIVATE',0,1,'turn',1,1,0,0,'old','completed',NULL,'{}',NULL);`
  const rows = [
    [key + '2', 'PRIVATE-thread', 'running', 'npm test --token PRIVATE'],
    [key + '3', 'PRIVATE-thread', 'running', 'git status PRIVATE'],
    ['codex:PRIVATE-thread:old:0', 'PRIVATE-thread', 'running', 'cargo test'],
    ['codex:someone-else:PRIVATE%3Aturn:5', 'PRIVATE-thread', 'running', 'ls'],
    [key + '9', 'wrong-producer', 'running', 'tsc'],
    [key + '4', 'PRIVATE-thread', 'completed', 'gh'],
    [key + 'untrusted', 'PRIVATE-thread', 'running', 'sh'],
  ]
  const inserts = rows.map(([item, producer, state, cmd], i) =>
    `INSERT INTO journal_items VALUES ('${sid}','epoch:PRIVATE',0,0,'tool-call',0,${10+i},0,0,'${item}','${state}',NULL,'${JSON.stringify({ observedAt: 100 + i, body: { name: 'functions.exec_command', input: { cmd } } })}','${producer}');`).join('\n')
  const journal = (sql: string) => new Promise<unknown>((resolve, reject) => execFile('/usr/bin/sqlite3', ['-json', ':memory:', schema + inserts + sql],
    { timeout: 2000, encoding: 'utf8', maxBuffer: 96000 }, (error, out) => error ? reject(error) : resolve(JSON.parse(out || '[]'))))
  const read = (children: unknown[], agentType = 'codex') => readSessionShells(ctx, snapshot([{ ...agent, agentType, state: 'done', children }]), id, { journal })
  const r = await read([worker, task])
  assert.deepEqual(r.tree?.map(n => [n.name, n.children.map(c => [c.kind, c.name ?? ''])]), [
    ['tester', [['shell', 'git'], ['shell', 'npm'], ['background', '']]]
  ])
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false)
  for (const reply of [
    await read([worker, { ...worker, id: 'duplicate', operation: undefined }]),
    await read([{ ...worker, invocation: undefined }]),
    await read([{ ...worker, invocation: { ...worker.invocation, generation: 0 } }]),
    await read([worker], 'gemini'),
  ]) assert.deepEqual(reply.rows.map(row => row.name), ['npm'])
})
