import { defineCheck } from 'orca/testing'
import type { ToolboxCatalog, ToolboxState } from './toolbox-types'

const catalog: ToolboxCatalog = { items: [
  { id: 'design', kind: 'skill', name: 'ui-ux-pro-max', description: 'Design clear, accessible interfaces with a shared visual language.', providers: ['Shared', 'Codex', 'Claude Code'], source: 'Shared skills', available: true, sharing: { state: 'shared', canSync: false } },
  { id: 'figma', kind: 'mcp', name: 'figma-local', description: 'Inspect and update documents through your local Figma bridge.', providers: ['Claude Code', 'Codex'], source: 'Provider settings', available: true, sharing: { state: 'provider', canSync: true } },
  { id: 'review', kind: 'skill', name: 'code-review', description: 'Review changes for correctness, maintainability and regressions.', providers: ['Shared'], source: 'Shared skills', available: true, sharing: { state: 'shared', canSync: false } },
  { id: 'unity', kind: 'mcp', name: 'unityMCP', description: 'Connect to the Unity Editor.', providers: ['Antigravity'], source: 'Provider settings', available: false, reason: 'Disabled in source configuration.' }
], warnings: [] }
const selection: ToolboxState = { workspaceId: 'demo', selected: ['design', 'figma'], bundle: null, events: [{ id: 'sample-call', bundleId: 'sample-session', name: 'figma-local', kind: 'mcp', state: 'running', startedAt: 1700000000000 }], automation: { enabled: true, setup: true, providers: [{ name: 'Codex', state: 'ready' }, { name: 'Gemini', state: 'ready' }, { name: 'Claude', state: 'ready' }], appliedIds: ['design'], sessions: 1 } }
const requests = {
  'calls.get': () => ({ workspace: true, calls: [] }),
  'toolbox.activity': () => ({ workspaceId: 'demo', recommendations: [], events: [] }),
  'toolbox.catalog': () => catalog,
  'toolbox.state': () => selection,
}
export default defineCheck({
  fresh: { requests },
  recommendations: { requests: { ...requests, 'toolbox.activity': () => ({
    workspaceId: 'demo',
    recommendations: [
      { id: 'rec-a', name: 'ui-ux-pro-max', kind: 'skill', at: 1700000000020 },
      { id: 'rec-b', name: 'figma-local', kind: 'mcp', at: 1700000000010 }
    ],
    events: [{ id: 'read-a', bundleId: 'demo', name: 'ui-ux-pro-max', kind: 'skill', operation: 'skill', recommendationId: 'rec-a', state: 'succeeded', startedAt: 1700000000030 }]
  }) } },
  library: { requests, persisted: { workspace: { 'traffic-light.tab': 'library' } } },
  import: { requests: { ...requests, 'toolbox.catalog': () => ({ ...catalog, items: [
    ...catalog.items, { ...catalog.items[1], id: 'figma-other', providers: ['Gemini CLI'] },
    { ...catalog.items[1], id: 'blender', name: 'blender', providers: ['Claude Code'] }
  ] }) }, persisted: { workspace: { 'traffic-light.tab': 'library', 'traffic-light.library-view': 'import' } } },
  instructions: { requests: { ...requests, 'toolbox.state': () => ({ ...selection, bundle: { id: 'demo-bundle', names: ['ui-ux-pro-max', 'figma-local'], createdAt: 1700000000000, instructions: 'Use only this selected bundle for the task.\nRead a skill or list one server’s tools only when needed.\nnode toolbox-cli.mjs --bundle selected.json list' } }) }, persisted: { workspace: { 'traffic-light.tab': 'library', 'traffic-light.manual-open': true } } },
  structure: { requests, persisted: { workspace: { 'traffic-light.tab': 'structure' } } },
  libraryEmpty: { requests: { ...requests, 'toolbox.catalog': () => ({ items: [], warnings: [] }), 'toolbox.state': () => ({ ...selection, selected: [], automation: { enabled: false, setup: false, providers: [], sessions: 0 } }) }, persisted: { workspace: { 'traffic-light.tab': 'library' } } },
})
