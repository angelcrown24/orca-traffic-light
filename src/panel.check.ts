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
  antigravityWorking: { settings: { nativeActivity: true }, requests: { ...requests,
    'session.shells': () => ({ status: 'ready', options: [{ id: 'chat:demo', kind: 'chat', provider: 'antigravity', number: 1 }],
      selected: 'chat:demo', mainWorking: true, turnActivity: { tools: 13, commands: 1, edits: 3 }, rows: [], subagents: [],
      turnTools: [
        { name: 'read_file', count: 6, state: 'completed' }, { name: 'edit_file', count: 2, state: 'completed' },
        { name: 'search', count: 1, state: 'failed' }, { name: 'execute', count: 1, state: 'completed' },
      ], tree: [
        { id: 'active-edit', kind: 'edit', toolName: 'edit_file', state: 'running', children: [] },
        ...['view-a','view-b'].map(id => ({ id, kind: 'tool' as const, toolName: 'view_file', state: 'running' as const, children: [] })),
      ] }),
    'native.get': () => ({ status: 'ready', resources: [], activities: [] })
  } },
  antigravityChild: { settings: { nativeActivity: true, antigravityChildStatus: true }, requests: { ...requests,
    'session.shells': () => ({ status: 'ready', options: [{ id: 'chat:demo', kind: 'chat', provider: 'Antigravity', number: 1 }], selected: 'chat:demo',
      rows: [{ kind: 'background', name: 'node', state: 'running' }],
      subagents: [{ agentType: 'Antigravity', role: 'subagent', state: 'working', toolName: null, statusSource: 'antigravity', statusUpdatedAt: 1700000000041 }],
      tree: [
        { id: 'provider-child', kind: 'subagent', state: 'working', statusSource: 'antigravity', statusUpdatedAt: 1700000000041, children: [] },
        { id: 'background-job', kind: 'background', name: 'node', state: 'running', children: [] }
      ] }),
    'native.get': () => ({ status: 'ready', resources: [], activities: [] })
  } },
  jevBadges: { settings: { nativeActivity: true }, requests: { ...requests,
    'session.shells': () => ({ status: 'ready', options: [{ id: 'chat:demo', kind: 'chat', provider: 'Codex', number: 1 }], selected: 'chat:demo',
      rows: [{ kind: 'background', name: 'pytest', state: 'running' }],
      subagents: [
        { agentType: 'Codex', role: 'subagent', label: 'test_runner', state: 'working', toolName: null },
        { agentType: 'Codex', role: 'subagent', label: 'reviewer', state: 'working', toolName: null },
        { agentType: 'Codex', role: 'subagent', label: 'verifier', state: 'monitoring', toolName: null }
      ],
      tree: [
        { id: 'tests', kind: 'subagent', name: 'test_runner', state: 'working', children: [
          { id: 'test-command', kind: 'background', name: 'pytest', state: 'running', children: [] }
        ] },
        { id: 'review', kind: 'subagent', name: 'reviewer', state: 'working', children: [
          { id: 'verify', kind: 'subagent', name: 'verifier', state: 'monitoring', children: [] }
        ] }
      ] }),
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
