import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { panelLanguage } from './panel-language'
import type { ToolboxCatalog, ToolboxState } from './toolbox-types'

const catalog: ToolboxCatalog = { items: [
  { id: 'skill:design', kind: 'skill', name: 'design-guide', description: 'Accessible interface design.', providers: ['Shared', 'Codex'], source: 'Shared skills', available: true, sharing: { state: 'shared', canSync: false } },
  { id: 'mcp:figma', kind: 'mcp', name: 'figma-local', description: 'Work with local Figma documents.', providers: ['Claude'], source: 'Claude settings', available: true, sharing: { state: 'shared', canSync: false } },
  { id: 'mcp:disabled', kind: 'mcp', name: 'disabled-server', description: 'Explicitly disabled.', providers: ['Codex'], source: 'Codex settings', available: false, reason: 'Disabled in its source configuration.' }
], warnings: [] }
const initial = (): ToolboxState => ({ workspaceId: 'workspace-a', selected: [], bundle: null, events: [] })
const calls = () => ({ workspace: true, calls: [] })

test('uses English by default and reserves Korean for Korean language tags', () => {
  for (const locale of [undefined, null, '', 'en-AU', 'fr-FR', 'kok-IN', 'koi']) {
    assert.equal(panelLanguage(locale), 'en')
  }
  for (const locale of ['ko', 'ko-KR', ' KO_KR ']) assert.equal(panelLanguage(locale), 'ko')
})

test('renders English throughout the panel when the host language has no translation', async () => {
  const host = mockHost({ requests: { 'calls.get': calls, 'toolbox.catalog': () => catalog, 'toolbox.state': initial } })
  const view = await mount(panel, { host, locale: 'kok-IN' })
  try {
    assert.ok(view.find({ text: 'Detected items' }))
    await view.select({ label: 'Traffic Light views' }, 'library')
    assert.ok(view.find({ text: 'Skill · Codex' }))
    await view.press({ text: 'Import 1' })
    assert.ok(view.find({ text: 'Needs review' }))
    await view.select({ label: 'Traffic Light views' }, 'structure')
    assert.ok(view.find({ text: 'Discovered: 1 skill · 2 MCP servers' }))
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('discovers metadata only when a catalog view is opened', async () => {
  let scans = 0
  const host = mockHost({ requests: { 'calls.get': calls, 'toolbox.catalog': () => { scans++; return catalog }, 'toolbox.state': initial } })
  const view = await mount(panel, { host })
  try {
    assert.equal(scans, 0)
    await view.select({ label: 'Traffic Light views' }, 'structure')
    assert.equal(scans, 1)
    assert.equal(Boolean(view.find({ text: 'Capability flow' })), true)
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
    await view.press({ text: 'Skills' })
    assert.equal(Boolean(view.find({ label: 'design-guide' })), true)
    assert.equal(view.find({ label: 'figma-local' }), null)
    assert.equal(view.valueOf({ label: 'design-guide' }), false)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('import separates provider sources, updates and conflicts from the browsable shared library', async () => {
  const inventory: ToolboxCatalog = { items: [
    ...Array.from({ length: 31 }, (_, index) => ({ ...catalog.items[0], id: `shared-${index}`, name: `Shared ${index + 1}`, sharing: { state: 'shared' as const, canSync: false } })),
    ...(['provider', 'update', 'conflict'] as const).map(state => ({ ...catalog.items[1], id: state, name: `${state} item`, sharing: { state, canSync: state !== 'conflict' } }))
  ], warnings: [] }
  let current = initial()
  const host = mockHost({ requests: { 'calls.get': calls, 'toolbox.catalog': () => inventory, 'toolbox.state': () => current } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    await view.press({ text: 'Next' })
    assert.equal(Boolean(view.find({ label: 'Shared 31' })), true)
    await view.press({ text: 'Import 3' })
    assert.equal(view.find({ label: 'Shared 31' }), null)
    for (const status of ['provider', 'update', 'conflict']) assert.equal(Boolean(view.find({ text: `${status} item` })), true)
    assert.equal(view.find({ text: 'Next' }), null)
    await view.press({ text: 'Shared library 33' })
    assert.equal(Boolean(view.find({ label: 'Shared 1' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('architecture labels provider counts directly and keeps connection details collapsed', async () => {
  const host = mockHost({ requests: { 'calls.get': calls, 'toolbox.catalog': () => catalog, 'toolbox.state': initial } })
  const view = await mount(panel, { host, locale: 'ko-KR' })
  try {
    await view.select({ label: 'Traffic Light 보기' }, 'structure')
    assert.equal(Boolean(view.find({ text: '스킬 1' })), true)
    assert.equal(Boolean(view.find({ text: 'MCP 1' })), true)
    assert.equal(view.find({ text: '제공자 전용 내장 도구와 비공개 플러그인을 공용 도구로 변환하지는 않습니다.' }), null)
    await view.toggle({ label: '연결 방식' })
    assert.equal(Boolean(view.find({ text: '제공자 전용 내장 도구와 비공개 플러그인을 공용 도구로 변환하지는 않습니다.' })), true)
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
    await view.press({ label: 'Connection settings' })
    await view.toggle({ label: 'Manual connection' })
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
    await view.press({ label: 'Connection settings' })
    await view.toggle({ label: 'Manual connection' })
    await view.press({ label: 'Clear selection' })
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
    await view.press({ label: 'Connection settings' })
    await view.toggle({ label: 'Manual connection' })
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
    assert.equal(view.find({ type: 'EmptyState' }), null)
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
    await view.press({ label: '연결 설정' })
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
    await view.press({ label: 'Connection settings' })
    await view.toggle({ label: 'Manual connection' })
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
    await view.press({ label: 'Connection settings' })
    await view.toggle({ label: 'Manual connection' })
    assert.equal(view.find({ text: 'Prepare use instructions' })?.disabled, true)
    assert.equal(view.find({ label: 'Guide 25' })?.disabled, true)
    assert.equal(view.find({ label: 'Guide 1' })?.disabled, false)
    assert.equal(Boolean(view.find({ text: 'Revoke the existing instructions before preparing a new selection.' })), true)
    assert.equal(Boolean(view.find({ text: 'Up to 24 capabilities per selection.' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('automatic connection changes only after explicit enable or apply', async () => {
  let current: ToolboxState = { ...initial(), selected: ['skill:design'], automation: { enabled: false, setup: false, providers: [{ name: 'Codex', state: 'unconfigured' }], sessions: 0, appliedIds: [] } }
  const updates: boolean[] = []
  const host = mockHost({ requests: {
    'calls.get': calls, 'toolbox.catalog': () => catalog, 'toolbox.state': () => current,
    'toolbox.select': input => { current = { ...current, selected: input.ids }; return current },
    'toolbox.automation': input => {
      updates.push(input.enabled)
      current = { ...current, automation: { enabled: input.enabled, setup: true, providers: [{ name: 'Codex', state: 'ready' }], sessions: 1, appliedIds: [...current.selected] } }
      return current
    }
  } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    assert.deepEqual(updates, [])
    assert.equal(view.find({ text: 'Prepare use instructions' }), null)
    await view.press({ text: 'Connect' })
    assert.ok(view.find({ type: 'Badge', text: 'Enabled' }))
    assert.equal(view.find({ type: 'Badge', text: 'Enabled · 1' }), null)
    await view.press({ text: 'Import 1' })
    assert.ok(view.find({ type: 'Badge', text: 'Enabled · 1' }))
    await view.press({ text: 'Shared library 2' })
    assert.deepEqual(updates, [true])
    await view.toggle({ label: 'figma-local' })
    assert.deepEqual(updates, [true])
    assert.equal(Boolean(view.find({ text: 'Selection has unapplied changes.' })), true)
    assert.ok(view.find({ type: 'Badge', text: 'Enabled · 1' }))
    await view.press({ text: 'Apply selection' })
    assert.deepEqual(updates, [true, true])
    assert.equal(view.find({ text: 'Selection has unapplied changes.' }), null)
    await view.press({ label: 'Connection settings' })
    assert.equal(Boolean(view.find({ text: 'Apply this selection to new supported agent sessions. Existing conversations keep their previous configuration.' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('import groups equivalent names by kind, compares safely, and grants no workspace access when one source is added', async () => {
  const base = { ...catalog.items[1], name: 'jev', sharing: { state: 'provider' as const, canSync: true } }
  const first = { ...base, id: 'codex', providers: ['Codex'] }
  const second = { ...base, id: 'claude', providers: ['Claude'] }
  const direct = { ...base, id: 'blender', name: 'blender' }
  const items = [first, second, direct]
  const invoked: string[] = []
  let comparisons = 0
  const host = mockHost({ requests: {
    'calls.get': calls, 'toolbox.state': initial, 'toolbox.catalog': () => ({ items, warnings: [] }),
    'toolbox.compare': ({ id }) => {
      comparisons++
      assert.equal(id, 'codex')
      return { sources: [{ id: 'codex', variant: 1, transport: 'stdio', envCount: 2 }, { id: 'claude', variant: 2, transport: 'http' }], differences: ['transport', 'environment'] }
    },
    'toolbox.sync': input => {
      assert.equal(input.preserveProviderCopies, true)
      invoked.push(...input.ids)
      return { catalog: { items: items.map(item => input.ids.includes(item.id) ? { ...item, sharing: { state: 'shared', canSync: false } } : item), warnings: [] },
        results: [{ id: input.ids[0], name: 'jev', status: 'synced', message: 'Registered.' }] }
    }
  } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    await view.press({ text: 'Import 2' })
    await view.type({ label: 'Search capabilities' }, 'jev')
    assert.equal(view.find({ label: 'jev' }), null)
    assert.equal(comparisons, 0)
    await view.press({ text: 'Choose source' })
    assert.equal(comparisons, 1)
    assert.equal(Boolean(view.find({ text: 'Differences · Transport, Environment' })), true)
    assert.deepEqual(invoked, [])
    await view.press({ text: 'Add from Claude' })
    assert.deepEqual(invoked, ['claude'])
    assert.ok(view.find({ text: 'Added · Claude' }))
    assert.ok(view.find({ text: 'Compare' }))
    assert.ok(view.find({ text: 'Import 2' }))
    await view.press({ text: 'Shared library 1' })
    assert.equal(view.valueOf({ label: 'jev' }), false)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('comparing a shared skill shows matching copies without overwrite, and direct import exposes conflicts', async () => {
  const shared = { ...catalog.items[0], id: 'shared' }
  const source = { ...shared, id: 'provider', providers: ['Claude'], sharing: { state: 'provider' as const, canSync: true } }
  const direct = { ...source, id: 'other', name: 'other' }
  let writes = 0
  const host = mockHost({ requests: {
    'calls.get': calls, 'toolbox.state': initial, 'toolbox.catalog': () => ({ items: [shared, source, direct], warnings: [] }),
    'toolbox.compare': () => ({ sources: [{ id: 'shared', variant: 1, fileCount: 3 }, { id: 'provider', variant: 1, fileCount: 3 }], differences: [] }),
    'toolbox.sync': input => {
      writes++
      assert.deepEqual(input.ids, ['other'])
      return { results: [{ id: 'other', name: 'other', status: 'conflict', message: 'An existing shared copy was preserved.' }], catalog: { items: [shared, source, direct], warnings: [] } }
    }
  } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    await view.press({ text: 'Import 2' })
    await view.type({ label: 'Search capabilities' }, 'design-guide')
    await view.press({ text: 'Compare' })
    assert.equal(Boolean(view.find({ text: 'Already shared' })), true)
    await view.press({ text: 'Close' })
    assert.equal(Boolean(view.find({ text: 'Import 1' })), true)
    assert.equal(Boolean(view.find({ text: 'Already shared' })), true)
    assert.equal(view.find({ text: 'Add' }), null)
    assert.equal(writes, 0)
    await view.type({ label: 'Search capabilities' }, 'other', { replace: true })
    await view.press({ text: 'Add' })
    assert.equal(writes, 1)
    assert.equal(Boolean(view.find({ text: 'An existing shared copy was preserved.' })), true)
    assert.equal(view.find({ text: 'Added' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('legacy provider selections can be removed independently, and incompatible sources explain why import is unavailable', async () => {
  const old = { ...catalog.items[1], sharing: { state: 'provider' as const, canSync: true } }
  const blocked = { ...catalog.items[2], sharing: { state: 'provider' as const, canSync: false } }
  const items = [catalog.items[0], old, blocked]
  let current = { ...initial(), selected: [old.id] }
  const host = mockHost({ requests: {
    'calls.get': calls, 'toolbox.catalog': () => ({ items, warnings: [] }), 'toolbox.state': () => current,
    'toolbox.select': ({ ids }) => { current = { ...current, selected: ids }; return current }
  } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    assert.equal(view.find({ label: old.name }), null)
    await view.press({ text: 'Selected only' })
    assert.equal(view.valueOf({ label: old.name }), true)
    await view.toggle({ label: old.name })
    assert.deepEqual(current.selected, [])
    assert.equal(Boolean(view.find({ label: 'design-guide' })), true)
    await view.press({ text: 'Import 2' })
    await view.type({ label: 'Search capabilities' }, blocked.name)
    await view.press({ text: 'Review' })
    assert.equal(Boolean(view.find({ text: blocked.reason! })), true)
    assert.equal(view.find({ text: 'Add' }), null)
    assert.equal(view.find({ text: 'Copy adaptation request' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('same-workspace terminal updates preserve searches and an empty filter can be reset in one step', async () => {
  const host = mockHost({ requests: { 'calls.get': calls, 'toolbox.catalog': () => catalog, 'toolbox.state': initial } })
  const view = await mount(panel, { host, locale: 'ko-KR' })
  try {
    await view.select({ label: 'Traffic Light 보기' }, 'library')
    await view.type({ label: '기능 검색' }, 'unmatched-name')
    await view.emit('workspace.changed', { context: { workspaceId: 'workspace-a', displayName: 'A', branch: 'main', terminals: [{ id: 'new-terminal' }] } })
    assert.equal(view.valueOf({ label: '기능 검색' }), 'unmatched-name')
    await view.press({ text: '필터 초기화' })
    assert.ok(view.find({ label: 'design-guide' }))
  } finally { await view.unmount() }
})

test('clearing an applied selection shows the grant still in use and its connection control', async () => {
  let current: ToolboxState = { ...initial(), selected: ['skill:design'], automation: { enabled: true, setup: true, appliedIds: ['skill:design'], providers: [], sessions: 2 } }
  let autoChanges = 0
  const host = mockHost({ requests: {
    'calls.get': calls, 'toolbox.catalog': () => catalog, 'toolbox.state': () => current,
    'toolbox.select': ({ ids }) => { current = { ...current, selected: ids }; return current },
    'toolbox.automation': () => { autoChanges++; return current }
  } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    await view.press({ label: 'Clear selection' })
    assert.ok(view.find({ text: 'New sessions still use 1 previously applied item.' }))
    await view.press({ type: 'Button', text: 'Connection settings' })
    assert.equal(view.valueOf({ label: 'Connect automatically in new sessions' }), true)
    assert.equal(autoChanges, 0)
  } finally { await view.unmount() }
})

test('late workspace state reads cannot replace a newer selection', async () => {
  let phase = 0, notifyFirst!: () => void, notifySecond!: () => void, complete!: (value: ToolboxState) => void
  const first = new Promise<void>(resolve => { notifyFirst = resolve })
  const second = new Promise<void>(resolve => { notifySecond = resolve })
  const fresh = { ...initial(), selected: ['skill:design'] }
  const host = mockHost({ requests: { 'calls.get': calls, 'toolbox.catalog': () => catalog, 'toolbox.state': () => {
    if (!phase) return initial()
    if (phase++ === 1) return new Promise<ToolboxState>(resolve => { complete = resolve; notifyFirst() })
    notifySecond()
    return fresh
  } } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    phase = 1
    const older = view.post('toolbox.changed', {})
    await first
    const newer = view.post('toolbox.changed', {})
    await second
    complete(initial())
    await Promise.all([older, newer])
    await view.rerender()
    assert.equal(view.valueOf({ label: 'design-guide' }), true)
  } finally { await view.unmount() }
})
