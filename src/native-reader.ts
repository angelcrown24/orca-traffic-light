import { execFile } from 'node:child_process'
import { antigravityChildSessionIds, parseNativeActivity, parseNativeResources, parseNativeActiveResources, nativeJournalSessions, workspaceRow, nativeWorkingChildIds, type NativeActivity, type ProviderChildStatus } from './native-activity'
import type { ResourceObservation } from './resource-classifier'
import { readJournalActivity, type JournalResult, type JournalToolCall } from './journal-activity'

export type NativeToolCall = JournalToolCall & { agentType: string | null }
export type NativeResult = { recentTools?: NativeToolCall[]; status: 'disabled' | 'ready' | 'unavailable'; activities: NativeActivity[]; resources: ResourceObservation[]; activeResources?: ResourceObservation[]; journalStatus?: JournalResult['status'] }
type FetchSnapshot = () => Promise<unknown>
type GetEnabled = () => Promise<boolean>
type GetWorkspace = () => Promise<string | null>
type ChildStatusReader = {
  enabled: GetEnabled
  read: (workspaceId: string, sessionIds: string[]) => Promise<ReadonlyMap<string, readonly ProviderChildStatus[]>>
}

/** Resolve a single executable; never interpret an override as a shell command. */
export function resolveOrcaCli(platform: string, override?: string): string | null {
  if (override !== undefined && override !== '') {
    if (override !== override.trim() || /[\u0000-\u001f\u007f]/.test(override)) return null
    return override
  }
  if (platform === 'linux') return 'orca-ide'
  if (platform === 'darwin') return 'orca'
  return null
}

/** No shell and a bounded response. Never persist or log stdout/stderr. */
export function fetchSnapshot(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const command = resolveOrcaCli(process.platform, process.env.ORCA_CLI_COMMAND)
    if (!command) return reject(new Error('snapshot unavailable'))
    execFile(command, ['worktree', 'ps', '--environment', 'local', '--json'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(new Error('snapshot unavailable'))
      try {
        const result: unknown = JSON.parse(stdout)
        if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true || !('result' in result) ||
          !result.result || typeof result.result !== 'object' || !('worktrees' in result.result) || !Array.isArray(result.result.worktrees)) throw new Error('invalid snapshot')
        resolve(result)
      } catch { reject(new Error('snapshot unavailable')) }
    })
  })
}

/** Requests are deduplicated and never issued until the setting is explicitly true. */
export function createNativeReader(enabled: GetEnabled, workspace: GetWorkspace, fetch: FetchSnapshot,
  journal: (sessionId: string, children: ReadonlySet<string>, workspaceId: string, rootWorking: boolean) => Promise<JournalResult> =
    (id, children, owner, rootWorking) => readJournalActivity(id, owner, undefined, children, rootWorking),
  childStatus?: ChildStatusReader) {
  let inFlight: Promise<NativeResult> | null = null
  let workspaceId: string | null = null
  let epoch = 0
  const observed = new Map<string, ResourceObservation>()
  const clear = () => { epoch++; workspaceId = null; observed.clear() }
  const empty = (status: 'disabled' | 'unavailable'): NativeResult => ({ status, activities: [], resources: [] })
  const read = async (): Promise<NativeResult> => {
    if (inFlight) return inFlight
    inFlight = (async (): Promise<NativeResult> => {
      try {
        if (!(await enabled())) { clear(); return empty('disabled') }
        const id = await workspace()
        if (!id) { clear(); return empty('unavailable') }
        if (workspaceId !== id) { clear(); workspaceId = id }
        const requestEpoch = epoch
        const snapshot = await fetch()
        if (epoch !== requestEpoch || !(await enabled()) || (await workspace()) !== id) {
          clear()
          return empty('disabled')
        }
        const owner = workspaceRow(snapshot, id)
        if (!owner || !Array.isArray(owner.agents)) { clear(); return empty('unavailable') }
        const { sessions, truncated } = nativeJournalSessions(snapshot, id)
        const children = nativeWorkingChildIds(snapshot, id)
        const lookupChildren = async () => {
          if (!childStatus) return undefined
          const ids = antigravityChildSessionIds(snapshot, id)
          if (!ids.length || !(await childStatus.enabled()) || epoch !== requestEpoch || (await workspace()) !== id) return undefined
          return typeof owner.worktreeId === 'string' ? childStatus.read(owner.worktreeId, ids) : undefined
        }
        const [journals, providerChildren] = await Promise.all([
          Promise.all(sessions.map(async (s): Promise<JournalResult> => typeof owner.worktreeId === 'string' && owner.worktreeId
            ? journal(s.id, children.get(s.id) ?? new Set(), owner.worktreeId, s.rootWorking)
            : { status: 'unavailable', resources: [] })),
          lookupChildren().catch(() => undefined)
        ])
        const visibleChildren = providerChildren && await childStatus?.enabled().catch(() => false) ? providerChildren : undefined
        if (epoch !== requestEpoch || !(await enabled()) || (await workspace()) !== id) {
          clear()
          return empty('disabled')
        }
        const journalStatus: JournalResult['status'] | undefined = sessions.length === 0 ? undefined
          : journals.some((x) => x.status === 'unavailable') ? 'unavailable'
          : truncated || journals.some((x) => x.status === 'truncated') ? 'truncated' : 'ready'
        const newestFirst = (a: NativeToolCall, b: NativeToolCall) => b.observedAt - a.observedAt
        const recentTools = journals.flatMap((j, i) => (j.recentTools ?? []).map(call => ({
          ...call, agentType: sessions[i].agentType, state: call.state === 'running' && !sessions[i].working ? 'unknown' as const : call.state
        }))).sort(newestFirst).slice(0, 30)
        const active = new Map<string, ResourceObservation>()
        const invocations = new Map<string, number>()
        const currentResources = parseNativeActiveResources(snapshot, id)
        for (let i = 0; i < journals.length; i++) {
          const at = journals[i].lastSubagentInvocationAt
          if (sessions[i].agentType?.toLowerCase() === 'antigravity' && at) invocations.set(sessions[i].id, at)
          if (sessions[i].working) currentResources.push(...(journals[i].activeResources ?? []))
        }
        for (const resource of currentResources) {
          const key = `${resource.category}:${resource.name}`
          const previous = active.get(key)
          if (!previous || resource.evidence === 'observed') active.set(key, resource)
        }
        for (const resource of [...parseNativeResources(snapshot, id), ...journals.flatMap((x) => x.resources)]) {
          const key = `${resource.category}:${resource.name}`
          const previous = observed.get(key)
          if (!previous || resource.evidence === 'observed') observed.set(key, resource)
        }
        while (observed.size > 100) observed.delete(observed.keys().next().value!)
        return { status: 'ready', ...(recentTools.length ? { recentTools } : {}), activities: parseNativeActivity(snapshot, id, invocations, visibleChildren), resources: [...observed.values()], activeResources: [...active.values()].slice(-100), ...(journalStatus ? { journalStatus } : {}) }
      } catch { return empty('unavailable') }
    })()
    try { return await inFlight } finally { inFlight = null }
  }
  read.clear = clear
  return read
}
