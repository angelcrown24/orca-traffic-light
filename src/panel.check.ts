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
  'activity.terminals': () => ({ status: 'disabled' as const, openTerminals: 0, rows: [] }),
  'toolbox.activity': () => ({ workspaceId: 'demo', recommendations: [], events: [] }),
  'toolbox.catalog': () => catalog,
  'toolbox.state': () => selection,
}
export default defineCheck({
  fresh: { requests },
  terminalActivity: { settings: { nativeActivity:true }, requests: { ...requests,
    'activity.terminals': () => ({ status:'ready', openTerminals:2, rows:[
      {terminal:1, agent:'codex', state:'working', tools:['exec_command','Read']},
      {terminal:2, agent:'claude', state:'blocked', tools:[]}
    ] })
  } },
  terminalUnavailable: { settings: { nativeActivity:true }, requests: { ...requests,
    'activity.terminals': () => ({status:'partial',openTerminals:1,rows:[{terminal:1,state:'observed',tools:['Read']}]})
  } },
  jevBadges: { settings: { nativeActivity:true }, requests: { ...requests,
    'activity.terminals': () => ({status:'ready',openTerminals:1,rows:[{terminal:1,agent:'codex',state:'working',tools:['Read']}] }),
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
  skillReview: { requests: { ...requests, 'toolbox.skillReview': () => ({
    scanned: 28, checked: 28, skipped: 0, partial: false, identicalGroups: 2,
    findings: [
      { key: 'report-file', name: 'report-export', kind: 'missing', providers: ['Shared', 'Codex'], ids: ['report'], stamp: 'report-v1', evidence: ['scripts/export.sh'], line: 18 },
      { key: 'release-update', name: 'release-check', kind: 'update', providers: ['Claude Code'], ids: ['release'], stamp: 'release-v2', workspaceCount: 2, evidence: ['SKILL.md', 'scripts/verify.sh'] },
      { key: 'handoff-next', name: 'handoff-notes', kind: 'successor', providers: ['Codex', 'Gemini CLI'], ids: ['handoff', 'handoff-v2'], successorId: 'handoff-v2', stamp: 'handoff-next', evidence: ['handoff-notes-v2'], line: 12 }
    ]
  }), 'toolbox.catalog': () => ({ ...catalog, items: [...catalog.items,
    { ...catalog.items[0], id: 'report', name: 'report-export' },
    { ...catalog.items[0], id: 'release', name: 'release-check', providers: ['Shared', 'Claude Code'], sharing: { state: 'update', canSync: true } },
    { ...catalog.items[0], id: 'handoff', name: 'handoff-notes' },
    { ...catalog.items[0], id: 'handoff-v2', name: 'handoff-notes-v2' }
  ] }) }, persisted: { workspace: { 'traffic-light.tab': 'review' } } },
  import: { requests: { ...requests, 'toolbox.catalog': () => ({ ...catalog, items: [
    ...catalog.items, { ...catalog.items[1], id: 'figma-other', providers: ['Gemini CLI'], source: 'Provider settings', sharing: { state: 'provider', canSync: true } },
    { ...catalog.items[1], id: 'blender', name: 'blender', providers: ['Claude Code'], source: 'Provider settings', sharing: { state: 'provider', canSync: true } },
    { ...catalog.items[2], id: 'review-agent', name: 'review-agent', providers: ['Claude Code'], source: '.claude/skills', available: false, providerOnly: 'skill-execution', sharing: { state: 'provider', canSync: false } }
  ] }) }, persisted: { workspace: { 'traffic-light.tab': 'library', 'traffic-light.library-view': 'import' } } },
  instructions: { requests: { ...requests, 'toolbox.state': () => ({ ...selection, bundle: { id: 'demo-bundle', names: ['ui-ux-pro-max', 'figma-local'], createdAt: 1700000000000, instructions: 'Use only this selected bundle for the task.\nRead a skill or list one server’s tools only when needed.\nnode toolbox-cli.mjs --bundle selected.json list' } }) }, persisted: { workspace: { 'traffic-light.tab': 'library', 'traffic-light.manual-open': true } } },
  structure: { requests, persisted: { workspace: { 'traffic-light.tab': 'structure' } } },
  libraryEmpty: { requests: { ...requests, 'toolbox.catalog': () => ({ items: [], warnings: [] }), 'toolbox.state': () => ({ ...selection, selected: [], automation: { enabled: false, setup: false, providers: [], sessions: 0 } }) }, persisted: { workspace: { 'traffic-light.tab': 'library' } } },
})
