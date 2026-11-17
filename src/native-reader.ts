import { execFile } from 'node:child_process'
import { parseNativeActivity, parseNativeResources, parseNativeActiveResources, nativeSessionIds, nativeWorkingSessionIds, nativeWorkingChildIds, type NativeActivity } from './native-activity'
import type { ResourceObservation } from './resource-classifier'
import { readJournalActivity, type JournalResult } from './journal-activity'

export type NativeResult = { status: 'disabled' | 'ready' | 'unavailable'; activities: NativeActivity[]; resources: ResourceObservation[]; activeResources?: ResourceObservation[]; journalStatus?: JournalResult['status'] }
type FetchSnapshot = () => Promise<unknown>
type GetEnabled = () => Promise<boolean>
type GetWorkspace = () => Promise<string | null>

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
    execFile(command, ['worktree', 'ps', '--json'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(new Error('snapshot unavailable'))
      try {
        const result: unknown = JSON.parse(stdout)
        if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true || !('result' in result) ||
          !result.result || typeof result.result !== 'object' || !('worktrees' in result.result) || !Array.isArray(result.result.worktrees) ||
          ('truncated' in result.result && result.result.truncated === true)) throw new Error('invalid snapshot')
        resolve(result)
      } catch { reject(new Error('snapshot unavailable')) }
    })
  })
}

/** Requests are deduplicated and never issued until the setting is explicitly true. */
export function createNativeReader(enabled: GetEnabled, workspace: GetWorkspace, fetch: FetchSnapshot, journal: (sessionId: string, children: ReadonlySet<string>) => Promise<JournalResult> = (id, children) => readJournalActivity(id, undefined, children)) {
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
        const sessions = nativeSessionIds(snapshot, id)
        const children = nativeWorkingChildIds(snapshot, id)
        const journals = await Promise.all(sessions.ids.map((sessionId) => journal(sessionId, children.get(sessionId) ?? new Set())))
        if (epoch !== requestEpoch || !(await enabled()) || (await workspace()) !== id) {
          clear()
          return empty('disabled')
        }
        const journalStatus: JournalResult['status'] | undefined = sessions.ids.length === 0 ? undefined
          : journals.some((x) => x.status === 'unavailable') ? 'unavailable'
          : sessions.truncated || journals.some((x) => x.status === 'truncated') ? 'truncated' : 'ready'
        const workingSessions = nativeWorkingSessionIds(snapshot, id)
        const active = new Map<string, ResourceObservation>()
        const currentResources = parseNativeActiveResources(snapshot, id)
        for (let i = 0; i < journals.length; i++) {
          if (workingSessions.has(sessions.ids[i])) currentResources.push(...(journals[i].activeResources ?? []))
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
        return { status: 'ready', activities: parseNativeActivity(snapshot, id), resources: [...observed.values()], activeResources: [...active.values()].slice(-100), ...(journalStatus ? { journalStatus } : {}) }
      } catch { return empty('unavailable') }
    })()
    try { return await inFlight } finally { inFlight = null }
  }
  read.clear = clear
  return read
}
