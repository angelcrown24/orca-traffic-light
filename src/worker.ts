import type { OrcaWorkerApi } from 'orca/worker'
import type { Call } from './protocol'
import { sessionToolName } from './session-tool-label'
import { createTerminalReader } from './terminal-activity'
import { classifyResources, directJevCommand, type ResourceObservation } from './resource-classifier'
import { createToolboxManager } from '../runtime/toolbox-manager.mjs'

const toolboxManagers = new Set<ReturnType<typeof createToolboxManager>>()
export async function deactivate(): Promise<void> {
  await Promise.allSettled([...toolboxManagers].map(manager => manager.dispose()))
  toolboxManagers.clear()
}

// Identifiers are used only to pair events. Inputs and outputs are never retained.
type ObservedCall = { call: Call; order: number; callId?: string; displayName?: string; resources: ResourceObservation[]; startedAt: number }
const LIMIT = 100
// A missing completion hook must not leave a "currently active" badge indefinitely.
const ACTIVE_MAX_AGE_MS = 5 * 60_000

function mergeResources(items: ResourceObservation[]): ResourceObservation[] {
  const unique = new Map<string, ResourceObservation>()
  for (const item of items) {
    const key = `${item.category}:${item.name}`
    const previous = unique.get(key)
    if (!previous || item.evidence === 'observed') unique.set(key, item)
  }
  // Workspace calls arrive newest first. Keep their order when enforcing the cap.
  return [...unique.values()].slice(0, LIMIT)
}

export default function activate(orca: OrcaWorkerApi): void {
  const toolbox = createToolboxManager({
    getContext: () => orca.host.call('workspace.readContext'),
    getWorkspaces: () => orca.host.call('workspace.list'),
    post: () => orca.panels.post('toolbox.changed', {}),
    postSkillsChanged: () => orca.panels.post('toolbox.skillsChanged', {}),
    postBatchProgress: progress => orca.panels.post('toolbox.skillBatchProgress', progress),
    loadSelection: id => orca.storage.get(`toolbox-selection:${id}`),
    saveSelection: (id, ids) => orca.storage.set(`toolbox-selection:${id}`, ids),
    loadAutomation: () => orca.storage.get('toolbox-automation'),
    saveAutomation: entries => orca.storage.set('toolbox-automation', entries)
  })
  toolboxManagers.add(toolbox)
  orca.panels.handle('toolbox.activity', toolbox.activity)
  orca.panels.handle('toolbox.catalog', toolbox.catalog)
  orca.panels.handle('toolbox.state', toolbox.state)
  orca.panels.handle('toolbox.select', toolbox.select)
  orca.panels.handle('toolbox.prepare', toolbox.prepare)
  orca.panels.handle('toolbox.revoke', toolbox.revoke)
  orca.panels.handle('toolbox.copy', toolbox.copy)
  orca.panels.handle('toolbox.copyAdaptation', toolbox.copyAdaptation)
  orca.panels.handle('toolbox.previewAgentInstructions', toolbox.previewAgentInstructions)
  orca.panels.handle('toolbox.automation', toolbox.setAutomation)
  orca.panels.handle('toolbox.removeAgentInstructions', toolbox.removeAgentInstructions)
  orca.panels.handle('toolbox.skillReview', toolbox.skillReview)
  orca.panels.handle('toolbox.previewSkillChange', toolbox.previewSkillChange)
  orca.panels.handle('toolbox.applySkillChange', toolbox.applySkillChange)
  orca.panels.handle('toolbox.skillChangeHistory', toolbox.skillChangeHistory)
  orca.panels.handle('toolbox.undoSkillChange', toolbox.undoSkillChange)
  orca.panels.handle('toolbox.previewSkillBatch', toolbox.previewSkillBatch)
  orca.panels.handle('toolbox.applySkillBatch', toolbox.applySkillBatch)
  orca.panels.handle('toolbox.skillBatchStatus', toolbox.skillBatchStatus)
  orca.panels.handle('toolbox.undoSkillBatch', toolbox.undoSkillBatch)
  orca.panels.handle('toolbox.previewSkills', toolbox.previewSkills)
  orca.panels.handle('toolbox.inspectSkills', toolbox.inspectSkills)
  orca.panels.handle('toolbox.reviewSkills', toolbox.reviewSkills)
  orca.panels.handle('toolbox.copySkillReview', toolbox.copySkillReview)
  orca.panels.handle('toolbox.compare', toolbox.compare)
  orca.panels.handle('toolbox.unshare', toolbox.unshare)
  orca.panels.handle('toolbox.sync', toolbox.sync)
  void toolbox.initialize()
  const terminals = new Map<string, Map<number, ObservedCall>>()
  let order = 0
  function labelsFor(event: { tool: string; input: unknown }) {
    const tool = sessionToolName(event.tool) ?? 'Tool'
    const label = directJevCommand(event.tool, event.input) ??
      (tool.toLowerCase() === 'execute' ? sessionToolName(event.tool, event.input) : undefined)
    return { tool, displayName: label === tool ? undefined : label }
  }
  function terminalCalls(id: string) {
    let calls = terminals.get(id)
    if (!calls) {
      if (terminals.size >= LIMIT) terminals.delete(terminals.keys().next().value!)
      calls = new Map()
    }
    terminals.delete(id)
    terminals.set(id, calls)
    return calls
  }
  function latestWithId(calls: Map<number, ObservedCall>, event: { agent: string; callId?: string }, tool: string) {
    if (!event.callId) return undefined
    let latest: ObservedCall | undefined
    for (const row of calls.values()) {
      if (row.callId === event.callId && row.call.agent === event.agent && row.call.tool === tool) latest = row
    }
    return latest
  }

  orca.hooks.on('agent.tool.before', (event) => {
    if (!event.terminalId) return
    const calls = terminalCalls(event.terminalId)
    const { tool, displayName } = labelsFor(event)
    const existing = latestWithId(calls, event, tool)
    if (existing?.call.state === 'running') {
      const resources = mergeResources([...existing.resources, ...classifyResources(event.tool, event.input)])
      calls.set(existing.order, { ...existing, resources, displayName: existing.displayName ?? displayName })
      orca.panels.post('calls.changed', {})
      return
    }
    const index = ++order
    const startedAt = Date.now()
    const id = JSON.stringify([startedAt, index])
    calls.set(index, { call: { id, tool, agent: event.agent, state: 'running' }, order: index, callId: event.callId, displayName, resources: classifyResources(event.tool, event.input), startedAt })
    while (calls.size > LIMIT) calls.delete(calls.keys().next().value!)
    orca.panels.post('calls.changed', {})
  })
  orca.hooks.on('agent.tool.after', (event) => {
    if (!event.terminalId) return
    const calls = terminalCalls(event.terminalId)
    const { tool, displayName } = labelsFor(event)
    const exact = latestWithId(calls, event, tool)
    const matches = [...calls.values()].filter(observed =>
      observed.call.state === 'running' && observed.call.agent === event.agent && observed.call.tool === tool &&
      (!event.callId || !observed.callId || event.callId === observed.callId))
    if (exact && exact.call.state !== 'running') return
    const observed = exact ?? (matches.length === 1 ? matches[0] : undefined)
    if (observed) {
      calls.set(observed.order, { ...observed, callId: observed.callId ?? event.callId, call: { ...observed.call, state: 'finished' }, displayName: observed.displayName ?? displayName, resources: mergeResources([...observed.resources, ...classifyResources(event.tool, event.input)]) })
    } else if (matches.length > 1) {
      for (const row of matches) calls.set(row.order, { ...row, call: { ...row.call, state: 'uncertain' } })
    } else {
      // We saw an end but cannot identify its start. Keep it visible without claiming success.
      const index = ++order
      const startedAt = Date.now()
      calls.set(index, { call: { id: JSON.stringify([startedAt, index]), tool, agent: event.agent, state: 'uncertain' }, order: index, callId: event.callId, displayName, resources: classifyResources(event.tool, event.input), startedAt })
    }
    while (calls.size > LIMIT) calls.delete(calls.keys().next().value!)
    orca.panels.post('calls.changed', {})
  })
  const activity = createTerminalReader({
    context: () => orca.host.call('workspace.readContext'),
    enabled: async () => (await orca.settings.get('nativeActivity')) === true,
    list: workspaceId => orca.host.call('agents.list', { workspaceId }),
    tools: terminalId => {
      const now = Date.now()
      return [...(terminals.get(terminalId)?.values() ?? [])].filter(row =>
        row.call.state === 'running' && now >= row.startedAt && now - row.startedAt <= ACTIVE_MAX_AGE_MS
      ).map(row => row.displayName ?? row.call.tool)
    }
  })
  orca.settings.onDidChange(({ key }) => { if (key === 'nativeActivity') activity.clear() })
  orca.panels.handle('activity.terminals', activity.read)
  orca.panels.handle('calls.get', async () => {
    const context = await orca.host.call('workspace.readContext')
    const calls = context?.terminals.flatMap(({ id }) => [...(terminals.get(id)?.values() ?? [])]) ?? []
    calls.sort((a, b) => b.startedAt - a.startedAt || b.order - a.order)
    const now = Date.now()
    return { workspace: Boolean(context), calls: calls.slice(0, 30).map(({ call, displayName, startedAt }) => ({ ...call, tool: displayName ?? call.tool, startedAt })), resources: mergeResources(calls.flatMap(({ resources }) => resources)),
      activeResources: mergeResources(calls.filter(({ call, startedAt }) => call.state === 'running' && now >= startedAt && now - startedAt <= ACTIVE_MAX_AGE_MS).flatMap(({ resources }) => resources)) }
  })
}
