import { assert, test } from 'orca/testing'
import { createNativeReader, resolveOrcaCli } from './native-reader'

test('native reader never fetches without explicit opt-in', async () => {
  let count = 0
  const read = createNativeReader(async () => false, async () => 'identity:one', async () => { count++; return {} })
  assert.deepEqual(await read(), { status: 'disabled', activities: [] })
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
  assert.deepEqual(results[0], { status: 'ready', activities: [{ agentType: 'codex', state: 'working', toolName: 'Read' }] })
  assert.equal(JSON.stringify(results).includes('private'), false)
  const c = read()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  enabled = false
  release({ result: { worktrees: [] } })
  assert.deepEqual(await c, { status: 'disabled', activities: [] })
})

test('native reader reports failure without leaking raw errors', async () => {
  const read = createNativeReader(async () => true, async () => 'identity:one', async () => { throw new Error('private prompt') })
  assert.deepEqual(await read(), { status: 'unavailable', activities: [] })
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
  assert.deepEqual(await pending, { status: 'disabled', activities: [] })
})
