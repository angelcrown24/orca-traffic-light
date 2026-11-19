import { readAntigravityChildren } from './antigravity-children'
import { readSessionFocus } from './session-focus'
import { emptyShells, readSessionShells } from './session-shells'

type Context = { workspaceId?: string; terminals: { id: string }[] } | null
type Monitor = {
  context: () => Promise<Context>
  snapshot: () => Promise<unknown>
  enabled: () => Promise<boolean>
  providerEnabled: () => Promise<boolean>
  focus?: typeof readSessionFocus
  inspect?: typeof readSessionShells
}

export function createSessionMonitor({ context, snapshot, enabled, providerEnabled, focus = readSessionFocus, inspect = readSessionShells }: Monitor) {
  let generation = 0
  const read = async (input: { selected: string | null }) => {
    try {
      if (!await enabled()) return emptyShells('disabled')
      if (!input || (input.selected !== null && (typeof input.selected !== 'string' || input.selected.length > 160))) return emptyShells('unavailable')
      const version = generation
      const original = await context()
      const workspace = original?.workspaceId
      if (!workspace || !original) return emptyShells('unavailable')
      const currentContext = async () => {
        if (version !== generation || !await enabled()) return null
        const value = await context()
        return value?.workspaceId === workspace && version === generation ? value : null
      }
      const data = await snapshot()
      const current = await currentContext()
      if (!current) return emptyShells('unavailable')
      const auto = input.selected === null
      const target = auto ? await focus(workspace, data, current.terminals) : null
      const provider = await providerEnabled()
      const beforeRead = await currentContext()
      if (!beforeRead) return emptyShells('unavailable')
      const result = await inspect(beforeRead, data, input.selected, {
        focus: target,
        providerChildren: provider ? async (workspaceId, sessions) =>
          await currentContext() && await providerEnabled() && version === generation
            ? readAntigravityChildren(workspaceId, sessions) : new Map() : undefined
      })
      const latest = await currentContext()
      if (!latest) return emptyShells('unavailable')
      if (auto && result.selected && await focus(workspace, data, latest.terminals) !== target) return emptyShells('unavailable')
      if (result.selected?.startsWith('terminal:') && !latest.terminals.some(t => 'terminal:' + t.id === result.selected)) return emptyShells('unavailable')
      if ((provider && !await providerEnabled()) || !await currentContext()) return emptyShells('unavailable')
      return result
    } catch { return emptyShells('unavailable') }
  }
  read.clear = () => { generation++ }
  return read
}
