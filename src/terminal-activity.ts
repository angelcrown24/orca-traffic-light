import type { HostMethods } from 'orca/host'

type Agent = HostMethods['agents.list']['result']['agents'][number]
type Context = HostMethods['workspace.readContext']['result']
export type TerminalAgent = {
  terminal: number
  agent?: string
  state: 'working' | 'waiting' | 'blocked' | 'observed'
  tools: string[]
}
export type TerminalActivity = {
  status: 'ready' | 'partial' | 'disabled' | 'unavailable'
  openTerminals: number
  rows: TerminalAgent[]
}

const empty = (status: TerminalActivity['status']): TerminalActivity => ({ status, openTerminals: 0, rows: [] })

export function createTerminalReader(deps: {
  enabled: () => Promise<boolean>
  context: () => Promise<Context>
  list: (workspace: string) => Promise<{ agents: Agent[] }>
  tools: (terminal: string) => string[]
}) {
  let generation = 0
  const read = async (): Promise<TerminalActivity> => {
    const start = generation
    if (!await deps.enabled()) return empty('disabled')
    const workspaceId = (await deps.context())?.workspaceId
    if (!workspaceId) return empty('unavailable')

    let listing: Agent[] = [], status: TerminalActivity['status'] = 'ready'
    try { listing = (await deps.list(workspaceId)).agents }
    catch { status = 'partial' } // Terminal hooks are independent of permission to read the roster.
    if (start !== generation || !await deps.enabled()) return empty('disabled')
    const current = await deps.context()
    if (current?.workspaceId !== workspaceId || start !== generation) return empty('unavailable')

    const rows: TerminalAgent[] = []
    const terminals = [...new Set(current.terminals.map(t => t.id))]
    const agents = new Map(listing.filter(row => row.terminalId && row.state !== 'done').map(row => [row.terminalId, row]))
    for (const [index, terminalId] of terminals.entries()) {
      const agent = agents.get(terminalId)
      const tools = [...new Set(deps.tools(terminalId))]
      if (!agent && !tools.length) continue
      const provider = agent?.agent && /^[a-z][a-z0-9-]{0,32}$/i.test(agent.agent) ? agent.agent : null
      rows.push({ terminal: index + 1, ...(provider ? { agent: provider } : {}),
        state: agent && agent.state !== 'done' ? agent.state : 'observed', tools })
    }
    return { status, openTerminals: terminals.length, rows }
  }
  return { read, clear: () => { generation++ } }
}
