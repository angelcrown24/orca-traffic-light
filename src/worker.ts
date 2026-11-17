import type { OrcaWorkerApi } from 'orca/worker'
import type { Call } from './protocol'

// Identifiers are used only to pair events. Inputs and outputs are never retained.
type ObservedCall = { call: Call; order: number }
const LIMIT = 100

export default function activate(orca: OrcaWorkerApi): void {
  const terminals = new Map<string, Map<string, ObservedCall>>()
  let order = 0

  orca.hooks.on('agent.tool.before', (event) => {
    if (!event.terminalId || !event.callId) return
    let calls = terminals.get(event.terminalId)
    if (!calls) {
      if (terminals.size >= LIMIT) terminals.delete(terminals.keys().next().value!)
      calls = new Map()
    }
    // Most recently used terminals remain in the bounded cache.
    terminals.delete(event.terminalId)
    terminals.set(event.terminalId, calls)
    const id = JSON.stringify([event.terminalId, event.callId])
    calls.delete(event.callId)
    calls.set(event.callId, { call: { id, tool: event.tool, agent: event.agent, state: 'running' }, order: ++order })
    while (calls.size > LIMIT) calls.delete(calls.keys().next().value!)
    orca.panels.post('calls.changed', {})
  })
  orca.hooks.on('agent.tool.after', (event) => {
    if (!event.terminalId || !event.callId) return
    const calls = terminals.get(event.terminalId)
    const observed = calls?.get(event.callId)
    if (!observed || observed.call.agent !== event.agent || observed.call.tool !== event.tool) return
    calls!.set(event.callId, { ...observed, call: { ...observed.call, state: 'finished' } })
    orca.panels.post('calls.changed', {})
  })
  orca.panels.handle('calls.get', async () => {
    const context = await orca.host.call('workspace.readContext')
    const calls = context?.terminals.flatMap(({ id }) => [...(terminals.get(id)?.values() ?? [])]) ?? []
    calls.sort((a, b) => b.order - a.order)
    return { workspace: Boolean(context), calls: calls.map(({ call }) => call) }
  })
}
