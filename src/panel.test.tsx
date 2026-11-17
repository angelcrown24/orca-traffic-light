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
    'native.get': () => { requests++; return { status: 'ready', activities: [{ agentType: 'codex', state: 'working', toolName: 'Read' }] } }
  } })
  const view = await mount(panel, { host })
  try {
  assert.equal(requests, 0)
  assert.equal(Boolean(view.find({ text: 'Optional: Orca CLI returns prompts, tool inputs and assistant messages from all workspaces to this plugin. Only current workspace agent states and tool names are displayed; conversation data is not saved, logged or sent by this plugin.' })), true)
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
    'native.get': () => { requests++; return { status: 'ready', activities: [] } }
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
