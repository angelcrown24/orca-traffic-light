import { assert, mockHost, mount, test } from 'orca/testing'
import { ArchitectureDiagram, topology } from './toolbox-architecture'
import type { CatalogItem, ToolboxState } from './toolbox-types'

const items: CatalogItem[] = [
  { id: 'one', name: 'Shared skill', kind: 'skill', description: '', source: 'Shared', providers: ['Codex', 'Claude Code', 'Shared'], available: true, sharing: { state: 'shared', canSync: false } },
  { id: 'two', name: 'Other skill', kind: 'skill', description: '', source: 'Gemini', providers: ['Gemini CLI'], available: true },
  { id: 'three', name: 'MCP tool', kind: 'mcp', description: '', source: 'Antigravity', providers: ['Antigravity'], available: true }
]
const state: ToolboxState = { workspaceId: 'workspace', selected: ['one', 'two'], bundle: null,
  automation: { enabled: true, setup: true, appliedIds: ['one'], providers: [], sessions: 2 },
  events: [{ id: 'event', bundleId: 'bundle', name: 'Shared skill', kind: 'skill', state: 'succeeded', startedAt: 1, finishedAt: 2 }]
}

test('topology counts unique catalog entries separately from provider appearances and unapplied selections', () => {
  const result = topology(items, state)
  assert.deepEqual(result.catalog, { skills: 2, mcp: 1 })
  assert.equal(result.providers.reduce((sum, provider) => sum + provider.skills, 0), 3)
  assert.deepEqual(result.shared, { skills: 1, mcp: 0 })
  assert.equal(result.selected, 2)
  assert.equal(result.applied, 1)
  assert.equal(result.sessions, 2)
  assert.equal(result.running, 0)
  assert.equal(result.succeeded, 1)
})

test('architecture draws real provider, catalog, allowlist and runtime nodes with themed connectors', async () => {
  const view = await mount(() => <ArchitectureDiagram items={items} state={state} ko /> , { host: mockHost(), theme: 'dark' })
  try {
    assert.equal(Boolean(view.find({ text: 'Codex' })), true)
    assert.equal(Boolean(view.find({ text: 'Claude' })), true)
    assert.equal(Boolean(view.find({ text: '공용 저장소' })), true)
    assert.equal(Boolean(view.find({ text: '스킬 1' })), true)
    assert.equal(Boolean(view.find({ text: 'MCP 서버 0' })), true)
    assert.equal(Boolean(view.find({ text: '새 세션에 적용 1' })), true)
    assert.equal(Boolean(view.find({ text: '연결 세션 2' })), true)
    assert.equal(Boolean(view.find({ text: '완료 1' })), true)
    assert.equal(view.findAll({ text: '▼' }).length, 4)
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
  } finally { await view.unmount() }
})
