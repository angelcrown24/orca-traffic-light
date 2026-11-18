import { assert, test } from 'orca/testing'
import { createNativeReader, resolveOrcaCli } from './native-reader'

test('native reader never fetches without explicit opt-in', async () => {
  let count = 0
  const read = createNativeReader(async () => false, async () => 'identity:one', async () => { count++; return {} })
  assert.deepEqual(await read(), { status: 'disabled', activities: [], resources: [] })
  assert.equal(count, 0)
})

test('native reader shares concurrent reads, filters workspace and discards on opt-out', async () => {
  let enabled = true
  let fetches = 0
  let release!: (value: unknown) => void
  const snapshot = () => { fetches++; return new Promise<unknown>((resolve) => { release = resolve }) }
  const read = createNativeReader(async () => enabled, async () => 'identity:one', snapshot)
  const a = read()
  const b = read()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  release({ result: { worktrees: [{ address: { worktree: 'identity:one' }, agents: [{ agentType: 'codex', state: 'working', toolName: 'Read', prompt: 'private' }] }] } })
  const results = await Promise.all([a, b])
  assert.equal(fetches, 1)
  assert.deepEqual(results[0], { status: 'ready', activities: [{ agentType: 'codex', state: 'working', toolName: 'Read' }], resources: [], activeResources: [] })
  assert.equal(JSON.stringify(results).includes('private'), false)
  const c = read()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  enabled = false
  release({ result: { worktrees: [] } })
  assert.deepEqual(await c, { status: 'disabled', activities: [], resources: [] })
})

test('native reader reports failure without leaking raw errors', async () => {
  const read = createNativeReader(async () => true, async () => 'identity:one', async () => { throw new Error('private prompt') })
  assert.deepEqual(await read(), { status: 'unavailable', activities: [], resources: [] })
})


test('CLI resolution avoids the unrelated Linux orca binary and never uses a shell', () => {
  assert.equal(resolveOrcaCli('linux'), 'orca-ide')
  assert.equal(resolveOrcaCli('darwin'), 'orca')
  assert.equal(resolveOrcaCli('win32'), null)
  assert.equal(resolveOrcaCli('linux', '/path with spaces/orca'), '/path with spaces/orca')
  assert.equal(resolveOrcaCli('linux', '/usr/local/bin/orca'), '/usr/local/bin/orca')
  assert.equal(resolveOrcaCli('linux', 'orca\nmalicious'), null)
})

test('native reader drops a snapshot if the workspace changes during a read', async () => {
  let workspace = 'identity:one'
  let release!: (value: unknown) => void
  const read = createNativeReader(async () => true, async () => workspace, () => new Promise((resolve) => { release = resolve }))
  const pending = read()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  workspace = 'identity:two'
  release({ result: { worktrees: [{ address: { worktree: 'identity:one' }, agents: [{ agentType: 'codex', state: 'working', toolName: 'private' }] }] } })
  assert.deepEqual(await pending, { status: 'disabled', activities: [], resources: [] })
})


test('retains only classified resource labels in the active workspace and clears on opt-out or workspace change', async () => {
  let enabled = true
  let workspace = 'identity:one'
  let toolInput = 'cat /home/me/.agents/skills/ui-ux-pro-max/SKILL.md private content'
  const read = createNativeReader(async () => enabled, async () => workspace, async () => ({ result: { worktrees: [
    { address: { worktree: 'identity:one' }, agents: [{ state: 'working', toolName: 'shell', toolInput, prompt: 'secret prompt' }] },
    { address: { worktree: 'identity:two' }, agents: [{ state: 'working', toolName: 'mcp__other__query', toolInput: 'secret' }] }
  ] } }))
  let result = await read()
  assert.deepEqual(result.resources, [{ category: 'skill', name: 'ui-ux-pro-max', evidence: 'inferred' }])
  assert.equal(JSON.stringify(result).includes('private'), false)
  toolInput = ''
  result = await read()
  assert.equal(result.resources.length, 1)
  workspace = 'identity:two'
  result = await read()
  assert.deepEqual(result.resources, [{ category: 'mcp', name: 'other', evidence: 'observed' }])
  enabled = false
  assert.deepEqual((await read()).resources, [])
  enabled = true
  workspace = 'identity:one'
  assert.deepEqual((await read()).resources, [])
})

test('explicit reset discards in-flight data and retained labels', async () => {
  let release!: (snapshot: unknown) => void
  const read = createNativeReader(async () => true, async () => 'identity:one', () => new Promise((resolve) => { release = resolve }))
  const pending = read()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  read.clear()
  release({ result: { worktrees: [{ address: { worktree: 'identity:one' }, agents: [{ state: 'working', toolName: 'mcp__test__do' }] }] } })
  assert.deepEqual(await pending, { status: 'disabled', activities: [], resources: [] })
})

test('merges bounded journal resources only when opted in and only for matching local sessions', async () => {
  const id = 'codex_12345678_abcd_1234_abcd_123456789abc'
  let enabled = false
  let queries = 0
  const snapshot = { result: { worktrees: [{ hostId: 'local', address: { worktree: 'identity:one' }, agents: [{ structuredHostOwned: true, paneKey: `structured-agent-session-${id}:pane`, state: 'working', toolName: 'shell' }] }] } }
  const read = createNativeReader(async () => enabled, async () => 'identity:one', async () => snapshot, async (sid) => {
    queries++
    assert.equal(sid, id)
    return { status: 'truncated', resources: [{ category: 'skill', name: 'ui-ux-pro-max', evidence: 'inferred' }] }
  })
  assert.equal((await read()).status, 'disabled')
  assert.equal(queries, 0)
  enabled = true
  const result = await read()
  assert.equal(queries, 1)
  assert.equal(result.journalStatus, 'truncated')
  assert.equal(result.resources[0].name, 'ui-ux-pro-max')
})

test('discards journal results if workspace changes while reading', async () => {
  const id = 'codex_12345678_abcd_1234_abcd_123456789abc'
  let workspace = 'identity:one'
  const snapshot = { result: { worktrees: [{ hostId: 'local', address: { worktree: 'identity:one' }, agents: [{ structuredHostOwned: true, paneKey: `structured-agent-session-${id}:pane` }] }] } }
  const read = createNativeReader(async () => true, async () => workspace, async () => snapshot, async () => {
    workspace = 'identity:other'
    return { status: 'ready', resources: [{ category: 'skill', name: 'private', evidence: 'inferred' }] }
  })
  assert.deepEqual(await read(), { status: 'disabled', activities: [], resources: [] })
})

test('active resources follow the working agent turn and clear after it finishes', async () => {
  const id = 'codex_12345678_abcd_1234_abcd_123456789abc'
  const otherId = 'codex_87654321_abcd_1234_abcd_123456789abc'
  let state = 'working'
  const snapshot = () => ({ result: { worktrees: [{ hostId: 'local', address: { worktree: 'identity:one' }, agents: [
    { structuredHostOwned: true, paneKey: `structured-agent-session-${id}:pane`, state, toolName: 'shell', toolInput: 'cat /tmp/skills/current/SKILL.md' },
    { structuredHostOwned: true, paneKey: `structured-agent-session-${otherId}:pane`, state: 'done', toolName: 'mcp__stale__run' }
  ] }] } })
  const resource = { category: 'skill' as const, name: 'current', evidence: 'inferred' as const }
  const read = createNativeReader(async () => true, async () => 'identity:one', async () => snapshot(), async (sid) => ({
    status: 'ready', resources: [resource], activeResources: sid === id ? [resource] : [{ category: 'mcp', name: 'stale', evidence: 'observed' }]
  }))
  assert.deepEqual((await read()).activeResources, [resource])
  state = 'done'
  const finished = await read()
  assert.deepEqual(finished.activeResources, [])
  assert.equal(finished.resources.some((item) => item.name === 'current'), true)
})

test('uses an exact workspace returned on a truncated page and reports unavailability when it is missing', async () => {
  let workspace = 'one'
  const read = createNativeReader(async () => true, async () => workspace, async () => ({
    result: { truncated: true, worktrees: [{ worktreeId: 'one', agents: [{ agentType: 'gemini', state: 'working', toolName: 'read_file' }] }] }
  }))
  const found = await read()
  assert.equal(found.activities[0].toolName, 'read_file')
  workspace = 'two'
  assert.equal((await read()).status, 'unavailable')
})

test('retains the latest native call from a quiet session while filling the rest by timestamp', async () => {
  const busy = 'codex_12345678_abcd_1234_abcd_123456789abc'
  const quiet = '12345678-abcd-4123-9123-123456789abc'
  const agents = [[busy, 'codex'], [quiet, 'antigravity']].map(([id, agentType]) => ({
    orcaSessionId: id, paneKey: 'structured-agent-session-' + id + ':pane', agentType, state: 'done'
  }))
  const read = createNativeReader(async () => true, async () => 'one', async () => ({
    result: { worktrees: [{ worktreeId: 'one', hostId: 'local', agents }] }
  }), async id => ({
    status: 'ready', resources: [],
    recentTools: (id === busy ? Array.from({ length: 30 }, (_, i) => 100 + i) : [1, 2]).map(observedAt => ({
      id: id + ':' + observedAt, observedAt, name: 'read_file', state: 'completed'
    }))
  }))
  const tools = (await read()).recentTools!
  assert.equal(tools.length, 30)
  assert.deepEqual(tools.map(t => t.observedAt), [...Array.from({ length: 29 }, (_, i) => 129 - i), 2])
  assert.equal(tools[29].agentType, 'antigravity')
})
