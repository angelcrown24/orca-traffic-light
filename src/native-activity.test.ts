import { assert, test } from 'orca/testing'
import { parseNativeActivity, parseNativeResources, nativeWorkingChildIds, antigravityChildSessionIds, type ProviderChildStatus } from './native-activity'

test('identifies only live working child provider IDs in the exact local workspace', () => {
  const sid = 'codex_12345678_abcd_1234_abcd_123456789abc'
  const parent = { structuredHostOwned: true, paneKey: `structured-agent-session-${sid}:pane`, state: 'working', subagentObservation: 'live', children: [
    { providerId: 'live-child', membership: 'live', state: 'working', children: [{ providerId: 'live-grandchild', membership: 'live', state: 'working' }] },
    { providerId: 'done-child', membership: 'live', state: 'done' },
    { providerId: 'stale-child', membership: 'stale', state: 'working', children: [{ providerId: 'unverified-grandchild', membership: 'live', state: 'working' }] },
    { providerId: 'unknown-child', state: 'working' },
    { providerId: 'ambiguous', membership: 'live', state: 'working' },
    { providerId: 'ambiguous', membership: 'live', state: 'working' }
  ] }
  const snapshot = { result: { worktrees: [{ hostId: 'local', address: { worktree: 'identity:one' }, agents: [parent] }] } }
  assert.deepEqual([...nativeWorkingChildIds(snapshot, 'identity:one').get(sid)!], ['live-child', 'live-grandchild'])
  assert.equal(nativeWorkingChildIds(snapshot, 'identity:other').size, 0)
  const stale = { result: { worktrees: [{ hostId: 'local', address: { worktree: 'identity:one' }, agents: [{ ...parent, subagentObservation: 'unverifiable' }] }] } }
  assert.equal(nativeWorkingChildIds(stale, 'identity:one').size, 0)
  const finished = { result: { worktrees: [{ hostId: 'local', address: { worktree: 'identity:one' }, agents: [{ ...parent, state: 'done' }] }] } }
  assert.equal(nativeWorkingChildIds(finished, 'identity:one').size, 0)
})

test('extracts only activity for the exact workspace and drops private data', () => {
  const response = { result: { worktrees: [
    { address: { worktree: 'identity:one' }, agents: [
      { agentType: 'codex', state: 'working', toolName: 'Read', prompt: 'private', toolInput: 'secret', lastAssistantMessage: 'private' },
      { agentType: 'claude', state: 'waiting', toolName: null }
    ] },
    { address: { worktree: 'identity:other' }, agents: [{ agentType: 'gemini', state: 'working', toolName: 'Other' }] }
  ] } }
  const result = parseNativeActivity(response, 'identity:one')
  assert.deepEqual(result, [
    { agentType: 'codex', state: 'working', toolName: 'Read' },
    { agentType: 'claude', state: 'waiting', toolName: null }
  ])
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('returns no rows for missing, malformed or ambiguous workspace data', () => {
  assert.deepEqual(parseNativeActivity(null, 'identity:one'), [])
  assert.deepEqual(parseNativeActivity({ result: { worktrees: [] } }, 'identity:one'), [])
  const row = { address: { worktree: 'identity:one' }, agents: [] }
  assert.deepEqual(parseNativeActivity({ result: { worktrees: [row, row] } }, 'identity:one'), [])
  assert.deepEqual(parseNativeActivity({ result: { worktrees: [row] } }, ''), [])
  assert.deepEqual(parseNativeActivity({ result: { worktrees: [{ ...row, agents: [null, { state: 'bad' }] }] } }, 'identity:one'), [])
})

test('reports bounded subagent state only for the matching workspace without private task text', () => {
  const child = { id: 'child-1', description: 'subagent_audit', state: 'working', membership: 'live', prompt: 'private prompt', toolInput: 'secret' }
  const response = { result: { worktrees: [
    { address: { worktree: 'identity:one' }, agents: [
      { agentType: 'codex', state: 'working', subagentObservation: 'live', children: [child, child,
        { id: 'child-2', state: 'idle', membership: 'live', description: 'Private free-form task' },
        { id: 'child-3', state: 'unverifiable', membership: 'live', description: 'reviewer' },
        { id: 'bad id!', state: 'working' }, { id: 'child-4', state: 'unknown' }] }
    ] },
    { address: { worktree: 'identity:other' }, agents: [{ agentType: 'codex', state: 'working', children: [{ id: 'foreign', state: 'working' }] }] }
  ] } }
  const result = parseNativeActivity(response, 'identity:one')
  assert.deepEqual(result, [
    { agentType: 'codex', state: 'working', toolName: null },
    { agentType: 'codex', state: 'working', toolName: null, role: 'subagent', label: 'subagent_audit' },
    { agentType: 'codex', state: 'waiting', toolName: null, role: 'subagent' },
    { agentType: 'codex', state: 'unverifiable', toolName: null, role: 'subagent', label: 'reviewer' }
  ])
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(JSON.stringify(result).includes('foreign'), false)
})

test('marks child status unverifiable when its parent observation is stale', () => {
  const response = { result: { worktrees: [{ worktreeId: 'one', agents: [{ agentType: 'codex', state: 'working', subagentObservation: 'unverifiable', children: [{ id: 'child', membership: 'live', state: 'working' }] }] }] } }
  assert.equal(parseNativeActivity(response, 'one')[1].state, 'unverifiable')
})

test('legacy subagent rows follow host freshness and never override the canonical roster', () => {
  const id = '12345678-abcd-4123-9123-123456789abc'
  const parent = { state: 'working', agentType: 'antigravity', paneKey: 'structured-agent-session-' + id + ':pane',
    structuredHostOwned: true, subagentObservation: 'live', subagents: [
      { id: 'worker-1', state: 'working', startedAt: 1, description: 'Private free-form task' },
      { id: 'bad-time', state: 'working' }, { id: 'bad-state', state: 'bogus', startedAt: 1 }
    ] }
  const snapshot = (extra: Record<string, unknown>) => ({ result: { worktrees: [{ worktreeId: 'one', hostId: 'local', agents: [{ ...parent, ...extra }] }] } })
  const expected = { agentType: 'antigravity', state: 'working', toolName: null, role: 'subagent' }
  assert.deepEqual(parseNativeActivity(snapshot({}), 'one').slice(1), [expected])
  assert.deepEqual([...nativeWorkingChildIds(snapshot({}), 'one').get(id)!], ['worker-1'])
  assert.deepEqual(parseNativeActivity(snapshot({ subagentObservation: 'unverifiable' }), 'one').slice(1), [{ ...expected, state: 'unverifiable' }])
  assert.equal(nativeWorkingChildIds(snapshot({ subagentObservation: 'unverifiable' }), 'one').size, 0)
  for (const children of [[], null, [{ id: 'cmd', providerId: 'shell', kind: 'command', membership: 'live', state: 'working' }]]) {
    assert.deepEqual(parseNativeActivity(snapshot({ children }), 'one').slice(1), [])
    assert.deepEqual([...nativeWorkingChildIds(snapshot({ children }), 'one').get(id)!], [])
  }
  const monitoring = [{ id: 'agent', providerId: 'monitoring-agent', kind: 'agent', state: 'monitoring', membership: 'live' }]
  assert.deepEqual(parseNativeActivity(snapshot({ children: monitoring }), 'one').slice(1), [{ ...expected, state: 'monitoring' }])
  assert.deepEqual([...nativeWorkingChildIds(snapshot({ children: monitoring }), 'one').get(id)!], [])
})

test('attaches a delegation timestamp only to its exact local parent without visible child rows', () => {
  const [a, b] = ['12345678-abcd-4123-9123-123456789ab1', '12345678-abcd-4123-9123-123456789ab2']
  const parent = (id: string) => ({ agentType: 'antigravity', state: 'done', orcaSessionId: id, paneKey: 'structured-agent-session-' + id + ':pane' })
  const agents = [parent(a), { ...parent(b), children: [{ id: 'a', kind: 'agent', membership: 'live', state: 'working' }], subagentObservation: 'live' },
    { ...parent(a), orcaSessionId: b }]
  const snapshot = (hostId: string) => ({ result: { worktrees: [{ worktreeId: 'one', hostId, agents }] } })
  const times = new Map([[a, 1], [b, 2]])
  const timestamps = (hostId: string, workspace: string) => parseNativeActivity(snapshot(hostId), workspace, times).map(row => row.lastSubagentInvocationAt)
  assert.deepEqual(timestamps('local', 'one'), [1, undefined, undefined, undefined])
  assert.deepEqual(timestamps('remote', 'one'), [undefined, undefined, undefined, undefined])
  assert.deepEqual(timestamps('local', 'other'), [])
})

test('provider evidence fills a verified Antigravity parent with no host agent rows', () => {
  const id = '12345678-abcd-4123-9123-123456789abc'
  const parent = { state: 'working', agentType: 'antigravity', orcaSessionId: id,
    paneKey: 'structured-agent-session-' + id + ':pane', structuredHostOwned: true }
  const hostChild = { id: 'job', kind: 'command', state: 'working', membership: 'live' }
  const snapshot = (extra: Record<string, unknown>) => ({ result: { worktrees: [{ worktreeId: 'one', hostId: 'local', agents: [{ ...parent, ...extra }] }] } })
  const dispatch = new Map([[id, 20]])
  const statuses: ProviderChildStatus[] = [{ state: 'working', updatedAt: 21 }, { state: 'idle', updatedAt: 22 }, { state: 'unverifiable', updatedAt: 23 }]
  const provider = new Map([[id, statuses]])
  for (const roster of [{}, { children: [] }, { children: [hostChild] }]) {
    const data = snapshot(roster)
    assert.deepEqual(antigravityChildSessionIds(data, 'one'), [id])
    const rows = parseNativeActivity(data, 'one', dispatch, provider)
    assert.deepEqual(rows.slice(1), statuses.map(status => ({
      agentType: 'antigravity', role: 'subagent', toolName: null, state: status.state,
      statusSource: 'antigravity', statusUpdatedAt: status.updatedAt
    })))
    assert.equal(rows[0].lastSubagentInvocationAt, undefined)
    assert.equal(nativeWorkingChildIds(data, 'one').size, 0)
    assert.deepEqual(antigravityChildSessionIds(data, 'other'), [])
  }
  for (const extra of [{ children: null }, { children: [null] }, { children: [{ ...hostChild, kind: 'unknown' }] },
    { children: [{ ...hostChild, children: [{ ...hostChild, kind: 'agent' }] }] }, { children: [{ ...hostChild, kind: 'agent' }], subagentObservation: 'live' },
    { subagents: [{}] }, { agentType: 'gemini' }, { structuredHostOwned: false }]) {
    const data = snapshot(extra)
    assert.deepEqual(antigravityChildSessionIds(data, 'one'), [])
    assert.equal(parseNativeActivity(data, 'one', dispatch, provider).some(row => row.statusSource), false)
  }
  const invalid = new Map([[id, [{ state: 'working', updatedAt: NaN } as ProviderChildStatus]]])
  assert.equal(parseNativeActivity(snapshot({}), 'one', dispatch, invalid)[0].lastSubagentInvocationAt, 20)
  const bounded = new Map([[id, Array.from({ length: 51 }, () => statuses[0])]])
  assert.equal(parseNativeActivity(snapshot({}), 'one', dispatch, bounded).length, 51)
})

test('looks up provider observations only for a unique pane in a sampled local workspace', () => {
  const ids = Array.from({ length: 6 }, (_, i) => '12345678-abcd-4123-9123-123456789ab' + i)
  const [a,b] = ids
  const agent = (id: string, updatedAt = 0) => ({ state: 'done', agentType: 'antigravity',
    orcaSessionId: id, paneKey: 'structured-agent-session-' + id + ':pane', updatedAt })
  const row = (worktreeId: string, hostId: string, agents: ReturnType<typeof agent>[]) => ({ worktreeId, hostId, agents })
  const lookup = (rows: ReturnType<typeof row>[]) => antigravityChildSessionIds({ result: { worktrees: rows } }, 'one')
  assert.deepEqual(lookup([row('one', 'remote', [agent(a)])]), [])
  assert.deepEqual(lookup([row('one', 'local', [agent(a), agent(a), agent(b)])]), [b])
  assert.deepEqual(lookup([row('one', 'local', [agent(a)]), row('other', 'local', [agent(a)])]), [])
  assert.deepEqual(lookup([row('one', 'local', ids.map(agent))]).sort(), ids.slice(2))
  const duplicate = { result: { worktrees: [row('one','local',[agent(a),agent(a)])] } }
  const records = new Map([[a, [{ state: 'working' as const, updatedAt: 2 }]]])
  assert.deepEqual(parseNativeActivity(duplicate, 'one', new Map([[a, 1]]), records).map(parent => parent.lastSubagentInvocationAt), [undefined, undefined])
})

test('does not present non-live or unknown child membership as working', () => {
  const children = [
    { id: 'current', state: 'working', membership: 'live' },
    { id: 'settled', state: 'working', membership: 'settled' },
    { id: 'missing', state: 'working' },
    { id: 'unknown', state: 'working', membership: 'unexpected' }
  ]
  const response = { result: { worktrees: [{ worktreeId: 'one', agents: [{ agentType: 'codex', state: 'working', subagentObservation: 'live', children }] }] } }
  assert.deepEqual(parseNativeActivity(response, 'one').slice(1).map((x) => x.state), ['working', 'unverifiable', 'unverifiable', 'unverifiable'])
})


test('classifies only active tool input within the exact workspace', () => {
  const snapshot = { result: { worktrees: [
    { address: { worktree: 'identity:one' }, agents: [
      { state: 'working', toolName: 'shell', toolInput: 'cat /tmp/skills/ui-ux-pro-max/SKILL.md', prompt: 'do not retain' },
      { state: 'done', toolName: 'mcp__stale__tool' }
    ] },
    { address: { worktree: 'identity:two' }, agents: [{ state: 'working', toolName: 'mcp__private__tool' }] }
  ] } }
  assert.deepEqual(parseNativeResources(snapshot, 'identity:one'), [{ category: 'skill', name: 'ui-ux-pro-max', evidence: 'inferred' }])
  assert.deepEqual(parseNativeResources(snapshot, 'identity:two'), [{ category: 'mcp', name: 'private', evidence: 'observed' }])
  assert.deepEqual(parseNativeResources(snapshot, 'identity:missing'), [])
})

test('extracts bounded local structured session IDs only from the exact workspace', async () => {
  const { nativeSessionIds } = await import('./native-activity')
  const id = 'codex_12345678_abcd_1234_abcd_123456789abc'
  const data = { result: { worktrees: [
    { hostId: 'local', address: { worktree: 'identity:one' }, agents: [
      { structuredHostOwned: true, paneKey: `structured-agent-session-${id}:pane` },
      { structuredHostOwned: false, paneKey: `structured-agent-session-${id}:other` },
      { structuredHostOwned: true, paneKey: 'structured-agent-session-bad:quoted' }
    ] },
    { hostId: 'local', address: { worktree: 'identity:other' }, agents: [{ structuredHostOwned: true, paneKey: 'structured-agent-session-codex_87654321_abcd_1234_abcd_123456789abc:pane' }] }
  ] } }
  assert.deepEqual(nativeSessionIds(data, 'identity:one'), { ids: [id], truncated: false })
  assert.deepEqual(nativeSessionIds(data, 'identity:missing'), { ids: [], truncated: false })
  data.result.worktrees[0].hostId = 'ssh:remote'
  assert.deepEqual(nativeSessionIds(data, 'identity:one'), { ids: [], truncated: false })
})

test('matches raw and id-prefixed worktree IDs without exposing adjacent workspaces', async () => {
  const { nativeSessionIds } = await import('./native-activity')
  const raw = '0ce59f20-9453-4cea-bb22-fa72d95fecd9::/Users/mac'
  const session = 'codex_12345678_abcd_1234_abcd_123456789abc'
  const one = { worktreeId: raw, identity: null, hostId: 'local', address: { worktree: `id:${raw}` }, agents: [
    { agentType: 'codex', state: 'working', toolName: 'shell', toolInput: 'cat /tmp/skills/ui-ux-pro-max/SKILL.md', structuredHostOwned: true, paneKey: `structured-agent-session-${session}:pane` }
  ] }
  const other = { worktreeId: `${raw}::workspace:other`, identity: null, hostId: 'local', address: { worktree: `id:${raw}::workspace:other` }, agents: [
    { agentType: 'other', state: 'working', toolName: 'mcp__private__run' }
  ] }
  const snapshot = { result: { worktrees: [one, other] } }
  for (const id of [raw, `id:${raw}`]) {
    assert.deepEqual(parseNativeActivity(snapshot, id), [{ agentType: 'codex', state: 'working', toolName: 'shell' }])
    assert.deepEqual(parseNativeResources(snapshot, id), [{ category: 'skill', name: 'ui-ux-pro-max', evidence: 'inferred' }])
    assert.deepEqual(nativeSessionIds(snapshot, id), { ids: [session], truncated: false })
  }
  const duplicate = { result: { worktrees: [one, { ...one, address: { worktree: 'identity:different' } }] } }
  assert.deepEqual(parseNativeActivity(duplicate, raw), [])
  assert.deepEqual(parseNativeResources(duplicate, raw), [])
  assert.deepEqual(nativeSessionIds(duplicate, raw), { ids: [], truncated: false })
})

test('matches stable identity without substring or ambiguous matches', async () => {
  const { nativeSessionIds } = await import('./native-activity')
  const session = 'codex_12345678_abcd_1234_abcd_123456789abc'
  const row = { worktreeId: 'raw', identity: { key: 'wt2:local:one' }, hostId: 'local', address: { worktree: 'identity:wt2:local:one' }, agents: [
    { agentType: 'codex', state: 'working', toolName: 'mcp__example__run', structuredHostOwned: true, paneKey: `structured-agent-session-${session}:pane` }
  ] }
  const snapshot = { result: { worktrees: [row] } }
  assert.equal(parseNativeActivity(snapshot, 'identity:wt2:local:one').length, 1)
  assert.deepEqual(parseNativeResources(snapshot, 'identity:wt2:local:one'), [{ category: 'mcp', name: 'example', evidence: 'observed' }])
  assert.deepEqual(nativeSessionIds(snapshot, 'identity:wt2:local:one'), { ids: [session], truncated: false })
  assert.deepEqual(parseNativeActivity(snapshot, 'identity:wt2:local:on'), [])
  const ambiguous = { result: { worktrees: [row, { ...row, worktreeId: 'different' }] } }
  assert.deepEqual(parseNativeActivity(ambiguous, 'identity:wt2:local:one'), [])
  assert.deepEqual(parseNativeResources(ambiguous, 'identity:wt2:local:one'), [])
  assert.deepEqual(nativeSessionIds(ambiguous, 'identity:wt2:local:one'), { ids: [], truncated: false })
})

test('selects current UUID and settled native sessions while rejecting mismatched ownership and prioritizing work', async () => {
  const { nativeJournalSessions } = await import('./native-activity')
  const ids = Array.from({ length: 7 }, (_, i) => '12345678-abcd-4123-9123-123456789ab' + i)
  const agents = ids.map((id, i) => ({ orcaSessionId: id, paneKey: 'structured-agent-session-' + id + ':pane', agentType: 'antigravity', state: i === 6 ? 'working' : 'done', updatedAt: i,
    ...(i === 6 ? { structuredHostOwned: true } : {}) }))
  const data = { result: { worktrees: [{ hostId: 'local', worktreeId: 'this', agents: [
    ...agents, { ...agents[6], orcaSessionId: ids[1] }, { ...agents[1], structuredHostOwned: false }
  ] }] } }
  const { sessions, truncated } = nativeJournalSessions(data, 'this')
  assert.equal(truncated, true)
  assert.deepEqual(sessions.map(s => s.id), [ids[6], ids[5], ids[4], ids[3]])
  const mismatch = { result: { worktrees: [{ hostId: 'local', worktreeId: 'this', agents: [{ ...agents[6], orcaSessionId: ids[1] }, { ...agents[1], structuredHostOwned: false }] }] } }
  assert.equal(nativeJournalSessions(mismatch, 'this').sessions.length, 0)
})

test('discovers active agent descendants in verified workflow and monitor nodes without displaying the containers', () => {
  const sid = '01234567-abcd-4123-abcd-123456789abc'
  const sub = { kind: 'agent', id: 'nested', providerId: 'nested', description: 'reviewer', membership: 'live', state: 'working' }
  const wrapper = { kind: 'workflow', id: 'workflow', membership: 'live', state: 'monitoring', children: [
    { kind: 'monitor', id: 'watch', membership: 'live', state: 'monitoring', children: [sub] }
  ] }
  const snapshot = (membership: string) => ({ result: { worktrees: [{ worktreeId: 'one', hostId: 'local', agents: [
    { structuredHostOwned: true, paneKey: 'structured-agent-session-' + sid + ':leaf', state: 'working',
      subagentObservation: 'live', children: [{ ...wrapper, membership }] }
  ] }] } })
  for (const membership of ['live', 'settled']) {
    const data = snapshot(membership)
    assert.deepEqual(parseNativeActivity(data, 'one').filter(r => r.role).map(r => [r.label, r.state]),
      [['reviewer', membership === 'live' ? 'working' : 'unverifiable']])
    assert.deepEqual([...nativeWorkingChildIds(data, 'one').get(sid)!], membership === 'live' ? ['nested'] : [])
  }
})
