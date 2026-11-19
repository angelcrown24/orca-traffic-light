import type { OrcaWorkerApi } from 'orca/worker'
import type { Call } from './protocol'
import { readAntigravityChildren } from './antigravity-children'
import { createNativeReader, fetchSnapshot } from './native-reader'
import { classifyResources, directJevCommand, type ResourceObservation } from './resource-classifier'
import { createToolboxManager } from '../runtime/toolbox-manager.mjs'

const toolboxManagers = new Set<ReturnType<typeof createToolboxManager>>()
export async function deactivate(): Promise<void> {
  await Promise.allSettled([...toolboxManagers].map(manager => manager.dispose()))
  toolboxManagers.clear()
}

// Identifiers are used only to pair events. Inputs and outputs are never retained.
type ObservedCall = { call: Call; order: number; callId?: string; lookup?: string | null; resources: ResourceObservation[]; startedAt: number }
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
  return [...unique.values()].slice(-LIMIT)
}

export default function activate(orca: OrcaWorkerApi): void {
  const toolbox = createToolboxManager({
    getContext: () => orca.host.call('workspace.readContext'),
    getWorkspaces: () => orca.host.call('workspace.list'),
    post: () => orca.panels.post('toolbox.changed', {}),
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
  orca.panels.handle('toolbox.automation', toolbox.setAutomation)
  orca.panels.handle('toolbox.compare', toolbox.compare)
  orca.panels.handle('toolbox.sync', toolbox.sync)
  void toolbox.initialize()
  const terminals = new Map<string, Map<string, ObservedCall>>()
  let order = 0

  orca.hooks.on('agent.tool.before', (event) => {
    if (!event.terminalId) return
    let calls = terminals.get(event.terminalId)
    if (!calls) {
      if (terminals.size >= LIMIT) terminals.delete(terminals.keys().next().value!)
      calls = new Map()
    }
    // Most recently used terminals remain in the bounded cache.
    terminals.delete(event.terminalId)
    terminals.set(event.terminalId, calls)
    const index = ++order
    const key = event.callId ? `id:${event.callId}` : `anonymous:${index}`
    const id = JSON.stringify([event.terminalId, key])
    calls.delete(key)
    calls.set(key, { call: { id, tool: event.tool, agent: event.agent, state: 'running' }, order: index, callId: event.callId, lookup: directJevCommand(event.tool, event.input), resources: classifyResources(event.tool, event.input), startedAt: Date.now() })
    while (calls.size > LIMIT) calls.delete(calls.keys().next().value!)
    orca.panels.post('calls.changed', {})
  })
  orca.hooks.on('agent.tool.after', (event) => {
    if (!event.terminalId) return
    let calls = terminals.get(event.terminalId)
    if (!calls) {
      if (terminals.size >= LIMIT) terminals.delete(terminals.keys().next().value!)
      calls = new Map()
      terminals.set(event.terminalId, calls)
    }
    const exactKey = event.callId ? `id:${event.callId}` : undefined
    const exact = exactKey ? calls.get(exactKey) : undefined
    if (exact && exact.call.agent === event.agent && exact.call.tool === event.tool && exact.call.state === 'finished') return
    const matches = [...calls.entries()].filter(([, observed]) =>
      observed.call.state === 'running' && observed.call.agent === event.agent && observed.call.tool === event.tool &&
      (!event.callId || !observed.callId || event.callId === observed.callId))
    const chosen = exactKey && exact?.call.state === 'running' && exact.call.agent === event.agent && exact.call.tool === event.tool
      ? [exactKey, exact] as const : matches.length === 1 ? matches[0] : undefined
    if (chosen) {
      const [key, observed] = chosen
      calls.set(key, { ...observed, call: { ...observed.call, state: 'finished' }, lookup: observed.lookup ?? directJevCommand(event.tool, event.input), resources: mergeResources([...observed.resources, ...classifyResources(event.tool, event.input)]) })
    } else if (matches.length > 1) {
      for (const [key, observed] of matches) calls.set(key, { ...observed, call: { ...observed.call, state: 'uncertain' } })
    } else {
      // We saw an end but cannot identify its start. Keep it visible without claiming success.
      const index = ++order
      const key = `unpaired:${index}`
      calls.set(key, { call: { id: JSON.stringify([event.terminalId, key]), tool: event.tool, agent: event.agent, state: 'uncertain' }, order: index, lookup: directJevCommand(event.tool, event.input), resources: classifyResources(event.tool, event.input), startedAt: Date.now() })
    }
    while (calls.size > LIMIT) calls.delete(calls.keys().next().value!)
    orca.panels.post('calls.changed', {})
  })
  const nativeRead = createNativeReader(
    async () => (await orca.settings.get('nativeActivity')) === true,
    async () => (await orca.host.call('workspace.readContext'))?.workspaceId ?? null,
    fetchSnapshot, undefined, {
      enabled: async () => process.platform === 'darwin' && (await orca.settings.get('antigravityChildStatus')) === true,
      read: readAntigravityChildren
    }
  )
  orca.settings.onDidChange(({ key }) => { if (key === 'nativeActivity' || key === 'antigravityChildStatus') nativeRead.clear() })
  orca.panels.handle('native.get', nativeRead)
  orca.panels.handle('calls.get', async () => {
    const context = await orca.host.call('workspace.readContext')
    const calls = context?.terminals.flatMap(({ id }) => [...(terminals.get(id)?.values() ?? [])]) ?? []
    calls.sort((a, b) => b.order - a.order)
    const now = Date.now()
    return { workspace: Boolean(context), calls: calls.map(({ call, lookup }) => lookup ? { ...call, tool: lookup } : call), resources: mergeResources(calls.flatMap(({ resources }) => resources)),
      activeResources: mergeResources(calls.filter(({ call, startedAt }) => call.state === 'running' && now >= startedAt && now - startedAt <= ACTIVE_MAX_AGE_MS).flatMap(({ resources }) => resources)) }
  })
}
