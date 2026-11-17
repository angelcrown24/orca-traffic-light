import { assert, test } from 'orca/testing'
import { parseNativeActivity, parseNativeResources, nativeWorkingChildIds } from './native-activity'

test('identifies only live working child provider IDs in the exact local workspace', () => {
  const sid = 'codex_12345678_abcd_1234_abcd_123456789abc'
  const parent = { structuredHostOwned: true, paneKey: `structured-agent-session-${sid}:pane`, state: 'working', subagentObservation: 'live', children: [
    { providerId: 'live-child', membership: 'live', state: 'working' },
    { providerId: 'done-child', membership: 'live', state: 'done' },
    { providerId: 'stale-child', membership: 'stale', state: 'working' },
    { providerId: 'unknown-child', state: 'working' },
    { providerId: 'ambiguous', membership: 'live', state: 'working' },
    { providerId: 'ambiguous', membership: 'live', state: 'working' }
  ] }
  const snapshot = { result: { worktrees: [{ hostId: 'local', address: { worktree: 'identity:one' }, agents: [parent] }] } }
  assert.deepEqual([...nativeWorkingChildIds(snapshot, 'identity:one').get(sid)!], ['live-child'])
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
