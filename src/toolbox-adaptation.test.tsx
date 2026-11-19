import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { CatalogItem, ToolboxState } from './toolbox-types'

const restricted: CatalogItem = {
  id: 'provider-skill', name: 'review-agent', kind: 'skill', providers: ['Codex'], source: '.codex/skills',
  description: '', available: false, providerOnly: 'skill-execution', skillRequirements: 'Claude Code only',
  sharing: { state: 'provider', canSync: false }
}
const state = (): ToolboxState => ({ workspaceId: 'workspace-a', selected: [], events: [], bundle: null })
const calls = () => ({ workspace: true, calls: [] })

test('shows provider requirements before import and only copies a localized request on demand', async () => {
  let current = state(), attempts = 0
  const host = mockHost({ requests: {
    'calls.get': calls, 'toolbox.state': () => current, 'toolbox.catalog': () => ({ items: [restricted], warnings: [] }),
    'toolbox.copyAdaptation': input => {
      assert.deepEqual(input, { workspaceId: 'workspace-a', id: restricted.id, language: 'ko' })
      attempts++
      return { copied: attempts > 1, prompt: '테스트 요청' }
    }
  } })
  const view = await mount(panel, { host, locale: 'ko-KR' })
  try {
    await view.select({ label: 'Traffic Light 보기' }, 'library')
    await view.press({ text: '가져오기 1' })
    assert.ok(view.find({ text: '제공자 전용' }))
    assert.equal(view.find({ text: '추가' }), null)
    assert.equal(view.find({ text: '변환 요청 복사' }), null)
    await view.press({ text: '확인' })
    assert.ok(view.find({ text: 'Claude Code only' }))
    assert.ok(view.find({ text: '사용할 에이전트에 요청을 붙여넣으세요. 변환본의 작동 여부는 테스트해야 확인할 수 있습니다.' }))
    assert.equal(attempts, 0)
    await view.press({ text: '변환 요청 복사' })
    assert.ok(view.find({ label: '변환 요청' }))
    assert.ok(view.find({ text: '아래 요청을 선택해 복사하세요.' }))
    await view.press({ text: '변환 요청 복사' })
    assert.ok(view.find({ text: '요청 복사됨' }))
    assert.equal(view.find({ label: '변환 요청' }), null)
    current = { ...state(), workspaceId: 'workspace-b' }
    await view.emit('workspace.changed', { context: null })
    assert.equal(view.find({ text: '요청 복사됨' }), null)
    assert.equal(attempts, 2)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('a mixed group keeps its exact adapter request available if comparison fails and imports only the chosen portable copy', async () => {
  const portable: CatalogItem = { id: 'portable', name: 'devtools', description: '', kind: 'mcp', source: 'Claude settings', providers: ['Claude Code'], available: true, sharing: { state: 'provider', canSync: true } }
  const gated: CatalogItem = { ...portable, id: 'restricted', providers: ['Codex'], source: 'Codex settings', available: false, providerOnly: 'transport', sharing: { state: 'provider', canSync: false } }
  let items = [gated, portable], comparisons = 0, writes = 0
  const host = mockHost({ requests: {
    'calls.get': calls, 'toolbox.state': state, 'toolbox.catalog': () => ({ items, warnings: [] }),
    'toolbox.compare': () => {
      if (++comparisons === 1) throw Error('Unavailable')
      return { sources: [{ id: gated.id, variant: null }, { id: portable.id, variant: 1 }], differences: [] }
    },
    'toolbox.copyAdaptation': input => {
      assert.deepEqual(input, { workspaceId: 'workspace-a', id: gated.id, language: 'en' })
      return { copied: true, prompt: 'Portable request' }
    },
    'toolbox.sync': ({ ids }) => {
      assert.deepEqual(ids, [portable.id])
      writes++
      items = [gated, { ...portable, sharing: { state: 'shared', canSync: false } }]
      return { catalog: { items, warnings: [] }, results: [{ id: portable.id, name: portable.name, status: 'synced', message: '' }] }
    }
  } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    await view.press({ text: 'Import 1' })
    assert.ok(view.find({ text: 'Source restrictions vary' }))
    await view.press({ text: 'Choose source' })
    assert.ok(view.find({ text: 'Could not compare sources.' }))
    assert.ok(view.find({ text: 'Compatibility review' }))
    assert.equal(view.find({ text: 'Add from Claude' }), null)
    await view.press({ text: 'Copy adaptation request' })
    assert.ok(view.find({ text: 'Request copied' }))
    await view.press({ text: 'Retry' })
    assert.equal(view.find({ text: 'Request copied' }), null)
    assert.equal(view.find({ text: 'Add from Codex' }), null)
    assert.equal(writes, 0)
    await view.press({ text: 'Add from Claude' })
    assert.equal(writes, 1)
    await view.press({ text: 'Compare' })
    assert.ok(view.find({ text: 'Copy adaptation request' }))
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('already-shared provider-specific tools offer adaptation in their details and remain deselectable', async () => {
  const shared: CatalogItem = { ...restricted, providerOnly: 'native-tool', sharing: { state: 'shared', canSync: false } }
  let current = { ...state(), selected: [shared.id] }
  const host = mockHost({ requests: {
    'calls.get': calls, 'toolbox.state': () => current, 'toolbox.catalog': () => ({ items: [shared], warnings: [] }),
    'toolbox.select': ({ ids }) => { current = { ...current, selected: ids }; return current }
  } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    await view.press({ label: 'Details: review-agent' })
    assert.ok(view.find({ text: 'Copy adaptation request' }))
    assert.equal(view.find({ text: 'Add' }), null)
    await view.toggle({ label: shared.name })
    assert.deepEqual(current.selected, [])
    assert.equal(view.find({ label: shared.name })?.disabled, true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})
