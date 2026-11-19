import { defineCheck } from 'orca/testing'
import type { ToolboxCatalog, ToolboxState } from './toolbox-types'

const catalog: ToolboxCatalog = { items: [
  { id: 'design', kind: 'skill', name: 'ui-ux-pro-max', description: 'Design clear, accessible interfaces with a shared visual language.', providers: ['Shared', 'Codex', 'Claude Code'], source: 'Shared skills', available: true, sharing: { state: 'shared', canSync: false } },
  { id: 'figma', kind: 'mcp', name: 'figma-local', description: 'Inspect and update documents through your local Figma bridge.', providers: ['Shared', 'Claude Code', 'Codex'], source: 'Shared MCP registry', available: true, sharing: { state: 'shared', canSync: false } },
  { id: 'review', kind: 'skill', name: 'code-review', description: 'Review changes for correctness, maintainability and regressions.', providers: ['Shared', 'Gemini CLI'], source: 'Shared skills', available: true, sharing: { state: 'shared', canSync: false } },
  { id: 'unity', kind: 'mcp', name: 'unityMCP', description: 'Connect to the Unity Editor.', providers: ['Antigravity'], source: 'Provider settings', available: false, reason: 'Disabled in source configuration.' }
], warnings: [] }
const selection: ToolboxState = { workspaceId: 'demo', selected: ['design', 'figma'], bundle: null, events: [{ id: 'sample-call', bundleId: 'sample-session', name: 'figma-local', kind: 'mcp', state: 'running', startedAt: 1700000000000 }], automation: { enabled: true, setup: true, providers: [{ name: 'Codex', state: 'ready' }, { name: 'Gemini', state: 'ready' }, { name: 'Claude', state: 'ready' }], appliedIds: ['design', 'figma'], sessions: 1 } }
const requests = {
  'calls.get': () => ({ workspace: true, calls: [] }),
  'session.shells': () => ({ status: 'disabled' as const, options: [], selected: null, rows: [], subagents: [] }),
  'toolbox.activity': () => ({ workspaceId: 'demo', recommendations: [], events: [] }),
  'toolbox.catalog': () => catalog,
  'toolbox.state': () => selection,
}
export default defineCheck({
  fresh: { requests },
  antigravityChild: { settings: { nativeActivity: true, antigravityChildStatus: true }, requests: { ...requests,
    'session.shells': () => ({ status: 'ready', options: [{ id: 'chat:demo', kind: 'chat', provider: 'Antigravity', number: 1 }], selected: 'chat:demo',
      rows: [{ kind: 'background', name: 'node', state: 'running' }],
      subagents: [{ agentType: 'Antigravity', role: 'subagent', state: 'working', toolName: null, statusSource: 'antigravity', statusUpdatedAt: 1700000000041 }] }),
    'native.get': () => ({ status: 'ready', resources: [], activities: [] })
  } },
  jevBadges: { settings: { nativeActivity: true }, requests: { ...requests,
    'session.shells': () => ({ status: 'ready', options: [{ id: 'chat:demo', kind: 'chat', provider: 'Codex', number: 1 }], selected: 'chat:demo',
      rows: [{ kind: 'shell', name: 'zsh', state: 'running' }], subagents: [] }),
    'native.get': () => ({
      status: 'ready', journalStatus: 'ready', resources: [{ category: 'plugin', name: 'design-tools', evidence: 'observed' }],
      activities: [
        { agentType: 'Codex', state: 'working', toolName: 'shell' },
        { agentType: 'Antigravity', state: 'done', toolName: null },
      ],
      recentTools: [{ id: 'file-read', name: 'read_file', agentType: 'Antigravity', observedAt: 1700000000041, state: 'completed' }]
    }),
    'toolbox.activity': () => ({
    workspaceId: 'demo',
    recommendations: [
      { id: 'rec-a', name: 'ui-ux-pro-max', kind: 'skill', at: 1700000000020 },
      { id: 'rec-b', name: 'figma-local', kind: 'mcp', at: 1700000000010 }
    ],
    events: [
      { id: 'read-a', bundleId: 'demo', capabilityName: 'ui-ux-pro-max', name: 'ui-ux-pro-max', kind: 'skill', operation: 'skill', recommendationId: 'rec-a', state: 'running', startedAt: 1700000000030 },
      { id: 'call-b', bundleId: 'demo', capabilityName: 'figma-local', name: 'figma-local · get_selection', kind: 'mcp', operation: 'call', recommendationId: 'rec-b', state: 'succeeded', startedAt: 1700000000040 },
      { id: 'read-c', bundleId: 'demo', capabilityName: 'code-review', name: 'code-review', kind: 'skill', operation: 'skill', state: 'succeeded', startedAt: 1700000000050 }
    ]
  }) } },
  library: { requests, persisted: { workspace: { 'traffic-light.tab': 'library' } } },
  import: { requests: { ...requests, 'toolbox.catalog': () => ({ ...catalog, items: [
    ...catalog.items, { ...catalog.items[1], id: 'figma-other', providers: ['Gemini CLI'], source: 'Provider settings', sharing: { state: 'provider', canSync: true } },
    { ...catalog.items[1], id: 'blender', name: 'blender', providers: ['Claude Code'], source: 'Provider settings', sharing: { state: 'provider', canSync: true } },
    { ...catalog.items[2], id: 'review-agent', name: 'review-agent', providers: ['Claude Code'], source: '.claude/skills', available: false, providerOnly: 'skill-execution', sharing: { state: 'provider', canSync: false } }
  ] }) }, persisted: { workspace: { 'traffic-light.tab': 'library', 'traffic-light.library-view': 'import' } } },
  instructions: { requests: { ...requests, 'toolbox.state': () => ({ ...selection, bundle: { id: 'demo-bundle', names: ['ui-ux-pro-max', 'figma-local'], createdAt: 1700000000000, instructions: 'Use only this selected bundle for the task.\nRead a skill or list one server’s tools only when needed.\nnode toolbox-cli.mjs --bundle selected.json list' } }) }, persisted: { workspace: { 'traffic-light.tab': 'library', 'traffic-light.manual-open': true } } },
  structure: { requests, persisted: { workspace: { 'traffic-light.tab': 'structure' } } },
  libraryEmpty: { requests: { ...requests, 'toolbox.catalog': () => ({ items: [], warnings: [] }), 'toolbox.state': () => ({ ...selection, selected: [], automation: { enabled: false, setup: false, providers: [], sessions: 0 } }) }, persisted: { workspace: { 'traffic-light.tab': 'library' } } },
})
