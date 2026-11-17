import { defineCheck } from 'orca/testing'
import type { ToolboxCatalog, ToolboxState } from './toolbox-types'

const catalog: ToolboxCatalog = { items: [
  { id: 'design', kind: 'skill', name: 'ui-ux-pro-max', description: 'Design clear, accessible interfaces with a shared visual language.', providers: ['Shared', 'Codex', 'Claude'], source: 'Shared skills', available: true },
  { id: 'figma', kind: 'mcp', name: 'figma-local', description: 'Inspect and update documents through your local Figma bridge.', providers: ['Claude', 'Codex'], source: 'Provider settings', available: true },
  { id: 'review', kind: 'skill', name: 'code-review', description: 'Review changes for correctness, maintainability and regressions.', providers: ['Shared'], source: 'Shared skills', available: true },
  { id: 'unity', kind: 'mcp', name: 'unityMCP', description: 'Connect to the Unity Editor.', providers: ['Antigravity'], source: 'Provider settings', available: false, reason: 'Disabled in source configuration.' }
], warnings: [] }
const selection: ToolboxState = { workspaceId: 'demo', selected: ['design', 'figma'], bundle: null, events: [] }
const requests = {
  'calls.get': () => ({ workspace: true, calls: [] }),
  'toolbox.catalog': () => catalog,
  'toolbox.state': () => selection,
}
export default defineCheck({
  fresh: {},
  library: { requests, persisted: { workspace: { 'traffic-light.tab': 'library' } } },
  instructions: { requests: { ...requests, 'toolbox.state': () => ({ ...selection, bundle: { id: 'demo-bundle', names: ['ui-ux-pro-max', 'figma-local'], createdAt: 1700000000000, instructions: 'Use only this selected bundle for the task.\nRead a skill or list one server’s tools only when needed.\nnode toolbox-cli.mjs --bundle selected.json list' } }) }, persisted: { workspace: { 'traffic-light.tab': 'library' } } },
  structure: { requests, persisted: { workspace: { 'traffic-light.tab': 'structure' } } },
  libraryEmpty: { requests: { ...requests, 'toolbox.catalog': () => ({ items: [], warnings: [] }), 'toolbox.state': () => ({ ...selection, selected: [] }) }, persisted: { workspace: { 'traffic-light.tab': 'library' } } },
})
