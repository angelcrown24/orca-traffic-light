import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

test('shows observed calls and does not label finished as successful', async () => {
  const host = mockHost({ requests: { 'calls.get': () => ({ workspace: true, calls: [{ id: '1', tool: 'Read', agent: 'claude', state: 'finished' }] }) } })
  const view = await mount(panel, { host })
  assert.equal(Boolean(view.find({ text: 'Read' })), true)
  assert.equal(Boolean(view.find({ text: 'Finished' })), true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('clears stale calls on refresh failure and recovers on retry', async () => {
  let failing = false
  const host = mockHost({ requests: { 'calls.get': () => {
    if (failing) throw new Error('unavailable')
    return { workspace: true, calls: [{ id: '1', tool: 'Read', agent: 'claude', state: 'finished' }] }
  } } })
  const view = await mount(panel, { host })
  assert.equal(Boolean(view.find({ text: 'Read' })), true)
  failing = true
  await view.post('calls.changed', {})
  assert.equal(view.find({ text: 'Read' }), null)
  assert.equal(Boolean(view.find({ text: 'Could not load tool calls.' })), true)
  failing = false
  await view.press({ text: 'Retry' })
  assert.equal(Boolean(view.find({ text: 'Read' })), true)
  assert.equal(view.find({ text: 'Could not load tool calls.' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('native activity is off by default and only requested after explicit opt-in', async () => {
  let requests = 0
  const host = mockHost({ settings: { nativeActivity: false }, requests: {
    'calls.get': () => ({ workspace: true, calls: [] }),
    'native.get': () => { requests++; return { status: 'ready', activities: [{ agentType: 'codex', state: 'working', toolName: 'Read' }], resources: [] } }
  } })
  const view = await mount(panel, { host })
  try {
  assert.equal(requests, 0)
  assert.equal(Boolean(view.find({ text: 'Optional: Orca CLI returns prompts, tool inputs and assistant messages from all workspaces to this plugin. On macOS, recent tool inputs for current-workspace chats are also read from Orca’s local journal. Only agent states, tool names and detected resource names are displayed; inputs and conversation data are not saved, logged or sent by this plugin.' })), true)
  await view.toggle({ label: 'Show current native chat activity' })
  assert.equal(requests > 0, true)
  assert.equal(Boolean(view.find({ text: 'codex: Read' })), true)
  await view.toggle({ label: 'Show current native chat activity' })
  assert.equal(view.find({ text: 'codex: Read' }), null)
  } finally { await view.unmount() }
})


test('does not request native activity while the panel is hidden', async () => {
  let requests = 0
  const host = mockHost({ settings: { nativeActivity: true }, requests: {
    'calls.get': () => ({ workspace: true, calls: [] }),
    'native.get': () => { requests++; return { status: 'ready', activities: [], resources: [] } }
  } })
  const view = await mount(panel, { host, visible: false })
  try {
    assert.equal(requests, 0)
    await view.emit('workspace.changed', { context: null })
    assert.equal(requests, 0)
    await view.setVisible(true)
    await view.emit('workspace.changed', { context: null })
    assert.equal(requests, 1)
    await view.setVisible(false)
    await view.emit('workspace.changed', { context: null })
    assert.equal(requests, 1)
  } finally { await view.unmount() }
})


test('shows observed resource names and marks inferred references accurately', async () => {
  const host = mockHost({ requests: { 'calls.get': () => ({ workspace: true, calls: [], resources: [
    { category: 'skill', name: 'ui-ux-pro-max', evidence: 'inferred' },
    { category: 'mcp', name: 'figma-local', evidence: 'observed' }
  ] }) } })
  const view = await mount(panel, { host })
  try {
    assert.equal(Boolean(view.find({ text: 'ui-ux-pro-max' })), true)
    assert.equal(Boolean(view.find({ text: 'figma-local' })), true)
    assert.equal(Boolean(view.find({ text: 'Inferred' })), true)
    assert.equal(Boolean(view.find({ text: 'Observed' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('merges native and terminal resources without falsely upgrading evidence', async () => {
  const host = mockHost({ settings: { nativeActivity: true }, requests: {
    'calls.get': () => ({ workspace: true, calls: [], resources: [{ category: 'skill', name: 'ux', evidence: 'inferred' }] }),
    'native.get': () => ({ status: 'ready', activities: [], resources: [{ category: 'plugin', name: 'example', evidence: 'observed' }] })
  } })
  const view = await mount(panel, { host })
  try {
    assert.equal(Boolean(view.find({ text: 'ux' })), true)
    assert.equal(Boolean(view.find({ text: 'example' })), true)
    assert.equal(Boolean(view.find({ text: 'Inferred' })), true)
    assert.equal(Boolean(view.find({ text: 'Observed' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})
