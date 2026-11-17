import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { ToolboxCatalog, ToolboxState } from './toolbox-types'

const catalog: ToolboxCatalog = { items: [
  { id: 'skill:design', kind: 'skill', name: 'design-guide', description: 'Accessible interface design.', providers: ['Shared', 'Codex'], source: 'Shared skills', available: true },
  { id: 'mcp:figma', kind: 'mcp', name: 'figma-local', description: 'Work with local Figma documents.', providers: ['Claude'], source: 'Claude settings', available: true },
  { id: 'mcp:disabled', kind: 'mcp', name: 'disabled-server', description: 'Explicitly disabled.', providers: ['Codex'], source: 'Codex settings', available: false, reason: 'Disabled in its source configuration.' }
], warnings: [] }
const initial = (): ToolboxState => ({ workspaceId: 'workspace-a', selected: [], bundle: null, events: [] })
const calls = () => ({ workspace: true, calls: [] })

test('does not discover capabilities until Library is opened', async () => {
  let scans = 0
  const host = mockHost({ requests: { 'calls.get': calls, 'toolbox.catalog': () => { scans++; return catalog }, 'toolbox.state': initial } })
  const view = await mount(panel, { host })
  try {
    assert.equal(scans, 0)
    await view.select({ label: 'Traffic Light views' }, 'structure')
    assert.equal(scans, 0)
    assert.equal(Boolean(view.find({ text: 'One library. Only what you need.' })), true)
    await view.select({ label: 'Traffic Light views' }, 'library')
    assert.equal(scans, 1)
    assert.equal(Boolean(view.find({ label: 'design-guide' })), true)
    await view.select({ label: 'Traffic Light views' }, 'activity')
    await view.select({ label: 'Traffic Light views' }, 'library')
    assert.equal(scans, 1)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('search and type filters do not start tools or change selections', async () => {
  const host = mockHost({ requests: { 'calls.get': calls, 'toolbox.catalog': () => catalog, 'toolbox.state': initial } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    await view.type({ label: 'Search capabilities' }, 'figma')
    assert.equal(Boolean(view.find({ label: 'figma-local' })), true)
    assert.equal(view.find({ label: 'design-guide' }), null)
    await view.type({ label: 'Search capabilities' }, '', { replace: true })
    await view.select({ label: 'Show' }, 'skill')
    assert.equal(Boolean(view.find({ label: 'design-guide' })), true)
    assert.equal(view.find({ label: 'figma-local' }), null)
    assert.equal(Boolean(view.find({ text: 'Selected · 0' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('selection is explicit and preparing requires a separate action', async () => {
  let current = initial(), prepares = 0
  const host = mockHost({ requests: {
    'calls.get': calls, 'toolbox.catalog': () => catalog, 'toolbox.state': () => current,
    'toolbox.select': input => { assert.equal(input.workspaceId, 'workspace-a'); current = { ...current, selected: input.ids }; return current },
    'toolbox.prepare': () => { prepares++; current = { ...current, bundle: { id: 'bundle-1', names: ['design-guide'], instructions: 'Use only the selected guide through the shared runner.', createdAt: 1700000000000 } }; return current }
  } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    assert.equal(view.valueOf({ label: 'design-guide' }), false)
    await view.toggle({ label: 'design-guide' })
    assert.deepEqual(current.selected, ['skill:design'])
    assert.equal(prepares, 0)
    await view.press({ text: 'Prepare use instructions' })
    assert.equal(prepares, 1)
    assert.equal(Boolean(view.find({ text: 'Instructions ready' })), true)
    assert.equal(Boolean(view.find({ label: 'Guide to paste into your agent' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('clearing a selection preserves an existing bundle until explicit revocation', async () => {
  let current: ToolboxState = { ...initial(), selected: ['skill:design'], bundle: { id: 'bundle-1', names: ['design-guide'], instructions: 'Short guide.', createdAt: 1700000000000 } }
  let revokes = 0
  const host = mockHost({ requests: {
    'calls.get': calls, 'toolbox.catalog': () => catalog, 'toolbox.state': () => current,
    'toolbox.select': input => { current = { ...current, selected: input.ids }; return current },
    'toolbox.revoke': () => { revokes++; current = { ...current, bundle: null }; return current }
  } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    await view.press({ text: 'Clear selection' })
    assert.deepEqual(current.selected, [])
    assert.equal(revokes, 0)
    assert.equal(Boolean(view.find({ text: 'Instructions ready' })), true)
    await view.press({ text: 'Revoke these instructions' })
    assert.equal(revokes, 1)
    assert.equal(view.find({ text: 'Instructions ready' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('resets selection on workspace changes and reloads only current workspace state', async () => {
  let current: ToolboxState = { ...initial(), selected: ['skill:design'], bundle: { id: 'bundle-1', names: ['design-guide'], instructions: 'Old workspace guide.', createdAt: 1700000000000 } }
  const host = mockHost({ requests: { 'calls.get': calls, 'toolbox.catalog': () => catalog, 'toolbox.state': () => current } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    assert.equal(Boolean(view.find({ text: 'Instructions ready' })), true)
    current = { ...initial(), workspaceId: 'workspace-b' }
    await view.emit('workspace.changed', { context: null })
    assert.equal(view.find({ text: 'Instructions ready' }), null)
    assert.equal(view.valueOf({ label: 'design-guide' }), false)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('failed discovery can be retried without showing a false ready state', async () => {
  let fail = true
  const host = mockHost({ requests: { 'calls.get': calls, 'toolbox.catalog': () => { if (fail) throw new Error('unavailable'); return catalog }, 'toolbox.state': initial } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    assert.equal(Boolean(view.find({ text: 'Could not read the library. Your existing setup is unchanged.' })), true)
    assert.equal(view.find({ text: 'Instructions ready' }), null)
    fail = false
    await view.press({ text: 'Try again' })
    assert.equal(Boolean(view.find({ label: 'design-guide' })), true)
    assert.equal(view.find({ text: 'Could not read the library. Your existing setup is unchanged.' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('runner events distinguish actual success from failure and Korean labels', async () => {
  const current: ToolboxState = { ...initial(), events: [
    { id: '1', bundleId: 'bundle', kind: 'skill', name: 'design-guide', state: 'succeeded', startedAt: 1, finishedAt: 2 },
    { id: '2', bundleId: 'bundle', kind: 'mcp', name: 'figma-local', state: 'failed', startedAt: 2, finishedAt: 3 }
  ] }
  const host = mockHost({ requests: { 'calls.get': calls, 'toolbox.catalog': () => catalog, 'toolbox.state': () => current } })
  const view = await mount(panel, { host, locale: 'ko-KR' })
  try {
    await view.select({ label: 'Traffic Light 보기' }, 'library')
    await view.toggle({ label: '공통 실행기 활동 · 2' })
    assert.equal(Boolean(view.find({ text: '완료' })), true)
    assert.equal(Boolean(view.find({ text: '실패' })), true)
    assert.equal(Boolean(view.find({ text: '스킬 읽기' })), true)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  } finally { await view.unmount() }
})

test('copying instructions uses the exact current bundle and provides manual fallback', async () => {
  const current: ToolboxState = { ...initial(), selected: ['skill:design'], bundle: { id: 'bundle-1', names: ['design-guide'], instructions: 'Short guide.', createdAt: 1700000000000 } }
  let copied = false, attempts = 0
  const host = mockHost({ requests: {
    'calls.get': calls, 'toolbox.catalog': () => catalog, 'toolbox.state': () => current,
    'toolbox.copy': input => { assert.deepEqual(input, { workspaceId: 'workspace-a', bundleId: 'bundle-1' }); attempts++; return { copied } }
  } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    assert.equal(attempts, 0)
    await view.press({ text: 'Copy instructions' })
    assert.equal(attempts, 1)
    assert.equal(Boolean(view.find({ text: 'Could not copy automatically. Select the guide text below and copy it manually.' })), true)
    copied = true
    await view.press({ text: 'Copy instructions' })
    assert.equal(Boolean(view.find({ text: 'Copied' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('large libraries render one page and keep selected items when browsing pages', async () => {
  const large: ToolboxCatalog = { items: Array.from({ length: 61 }, (_, index) => ({ ...catalog.items[0], id: `skill-${index}`, name: `Guide ${index + 1}` })), warnings: [] }
  const host = mockHost({ requests: { 'calls.get': calls, 'toolbox.catalog': () => large, 'toolbox.state': initial } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    assert.equal(Boolean(view.find({ label: 'Guide 1' })), true)
    assert.equal(view.find({ label: 'Guide 31' }), null)
    await view.press({ text: 'Next' })
    assert.equal(view.find({ label: 'Guide 1' }), null)
    assert.equal(Boolean(view.find({ label: 'Guide 31' })), true)
    await view.press({ text: 'Next' })
    assert.equal(Boolean(view.find({ label: 'Guide 61' })), true)
    await view.type({ label: 'Search capabilities' }, 'Guide 1')
    assert.equal(Boolean(view.find({ label: 'Guide 1' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('cannot replace prepared instructions or select more than the bundle limit', async () => {
  const items = Array.from({ length: 25 }, (_, index) => ({ ...catalog.items[0], id: `skill-${index}`, name: `Guide ${index + 1}` }))
  const current: ToolboxState = { ...initial(), selected: items.slice(0, 24).map(item => item.id), bundle: { id: 'bundle-1', names: ['Guide 1'], instructions: 'Existing guide.', createdAt: 1700000000000 } }
  const host = mockHost({ requests: { 'calls.get': calls, 'toolbox.catalog': () => ({ items, warnings: [] }), 'toolbox.state': () => current } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    assert.equal(view.find({ text: 'Prepare use instructions' })?.disabled, true)
    assert.equal(view.find({ label: 'Guide 25' })?.disabled, true)
    assert.equal(view.find({ label: 'Guide 1' })?.disabled, false)
    assert.equal(Boolean(view.find({ text: 'Revoke the existing instructions before preparing a new selection.' })), true)
    assert.equal(Boolean(view.find({ text: 'Up to 24 capabilities per selection.' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})
