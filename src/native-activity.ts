import { classifyResources, nativeToolName, type ResourceObservation } from './resource-classifier'

export type ProviderChildStatus = { state: 'working' | 'idle' | 'waiting' | 'unverifiable'; updatedAt: number }

/** A deliberately narrow view of an Orca workspace agent's current reported activity. */
export type NativeActivity = {
  agentType: string | null
  state: 'working' | 'monitoring' | 'blocked' | 'waiting' | 'done' | 'idle' | 'unverifiable'
  toolName: string | null
  role?: 'subagent'
  label?: string
  lastSubagentInvocationAt?: number
  statusSource?: 'antigravity'
  statusUpdatedAt?: number
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function label(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 256) : null
}

/** Resolve only exact Orca identifiers. Refuse duplicate or conflicting matches. */
function workspaceRow(response: unknown, workspaceId: string): Record<string, unknown> | null {
  if (!workspaceId) return null
  const result = object(object(response)?.result)
  if (!Array.isArray(result?.worktrees)) return null
  const comparable = (id: string): string => id.startsWith('id:') ? id.slice(3) : id
  const sought = comparable(workspaceId)
  const matches = result.worktrees.map(object).filter((row) => {
    if (!row) return false
    const identity = object(row.identity)?.key
    const candidates = [row.worktreeId, object(row.address)?.worktree,
      typeof identity === 'string' && identity ? `identity:${identity}` : null]
    return candidates.some((candidate) => typeof candidate === 'string' && comparable(candidate) === sought)
  })
  return matches.length === 1 ? matches[0] : null
}

/** A globally capped page may still contain the exact requested workspace. */
export function missingFromPartialSnapshot(response: unknown, workspaceId: string): boolean {
  return object(object(response)?.result)?.truncated === true && !workspaceRow(response, workspaceId)
}

const validChildId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
const isChildAgent = (child: Record<string, unknown>) => child.kind === undefined || child.kind === 'agent'
const legacyChildState = (state: unknown) => state === 'working' || state === 'waiting' || state === 'idle' || state === 'blocked' || state === 'unverifiable'

// Modern children, even an empty array, supersede the provider's legacy roster.
function childRoster(parent: Record<string, unknown>): unknown[] {
  if (parent.children !== undefined) return Array.isArray(parent.children) ? parent.children : []
  if (!Array.isArray(parent.subagents)) return []
  return parent.subagents.slice(0, 50).flatMap(value => {
    const child = object(value)
    if (!child || !validChildId(child.id) || !legacyChildState(child.state) ||
        typeof child.startedAt !== 'number' || !Number.isSafeInteger(child.startedAt) || child.startedAt < 0) return []
    return [{ id: child.id, providerId: child.id, kind: 'agent', membership: 'live', state: child.state, description: child.description }]
  })
}

// An absent roster, an empty one, or a canonical list of known non-agent work
// leaves room for the provider's observation. Unknown host data takes precedence.
function providerMaySupplyChildren(parent: Record<string, unknown>): boolean {
  if (parent.agentType !== 'antigravity') return false
  if (parent.children === undefined) return parent.subagents === undefined || (Array.isArray(parent.subagents) && !parent.subagents.length)
  return Array.isArray(parent.children) && parent.children.length <= 50 && parent.children.every(value => {
    const child = object(value)
    return child && validChildId(child.id) && (child.kind === 'command' || child.kind === 'workflow' || child.kind === 'monitor') &&
      (child.membership === 'live' || child.membership === 'settled') &&
      (legacyChildState(child.state) || child.state === 'monitoring' || child.state === 'done') &&
      (child.children === undefined || (Array.isArray(child.children) && !child.children.length))
  })
}

// A local journal belongs to a single pane in a single workspace. Multiple valid
// claims to the same sampled session make a provider-side lookup ambiguous.
function uniqueJournalSessionIds(response: unknown, workspaceId: string): Set<string> {
  const sampled = nativeJournalSessions(response, workspaceId).sessions
  const eligible = new Set(sampled.map(session => session.id))
  if (!eligible.size) return eligible
  const result = object(object(response)?.result)
  const seen = new Set<string>()
  for (const value of Array.isArray(result?.worktrees) ? result.worktrees : []) {
    const row = object(value)
    if (row?.hostId !== 'local' || !Array.isArray(row.agents)) continue
    for (const rawAgent of row.agents) {
      const id = sessionId(object(rawAgent))
      if (!id || !eligible.has(id)) continue
      if (seen.has(id)) eligible.delete(id)
      seen.add(id)
    }
  }
  return eligible
}

export function antigravityChildSessionIds(response: unknown, workspaceId: string): string[] {
  const row = workspaceRow(response, workspaceId)
  if (row?.hostId !== 'local' || !Array.isArray(row.agents)) return []
  const eligible = uniqueJournalSessionIds(response, workspaceId)
  return row.agents.flatMap(value => {
    const agent = object(value)
    const id = sessionId(agent)
    return id && eligible.has(id) && agent && providerMaySupplyChildren(agent) ? [id] : []
  })
}

/**
 * Extract only status labels for the exact workspace address. This intentionally does not
 * return agent prompts, tool inputs, assistant messages or any other fields from the response.
 * A missing or ambiguous workspace address returns no rows rather than guessing.
 */
export function parseNativeActivity(response: unknown, workspaceId: string, invocations: ReadonlyMap<string, number> = new Map(),
  providerChildren: ReadonlyMap<string, readonly ProviderChildStatus[]> = new Map()): NativeActivity[] {
  const row = workspaceRow(response, workspaceId)
  if (!row || !Array.isArray(row.agents)) return []
  const activities: NativeActivity[] = []
  const uniqueIds = invocations.size || providerChildren.size ? uniqueJournalSessionIds(response, workspaceId) : new Set<string>()
  let childCount = 0
  const addChildren = (children: unknown, parentType: string | null, liveParent: boolean, depth: number, seen: Set<string>): void => {
    if (!Array.isArray(children) || depth > 3 || childCount >= 50) return
    for (const value of children.slice(0, 50)) {
      if (childCount >= 50) break
      const child = object(value)
      if (!child || !isChildAgent(child) || !validChildId(child.id) || seen.has(child.id)) continue
      const state = child.state
      if (state !== 'working' && state !== 'monitoring' && state !== 'blocked' && state !== 'waiting' && state !== 'idle' && state !== 'unverifiable') continue
      seen.add(child.id)
      childCount++
      const live = liveParent && child.membership === 'live'
      // Only short machine-style task identifiers are displayed, never arbitrary descriptions or prompts.
      const name = typeof child.description === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(child.description) ? child.description : undefined
      activities.push({ agentType: parentType, state: !live ? 'unverifiable' : state === 'idle' ? 'waiting' : state,
        toolName: null, role: 'subagent', ...(name ? { label: name } : {}) })
      addChildren(child.children, parentType, live && state !== 'unverifiable', depth + 1, seen)
    }
  }
  for (const value of row.agents) {
    const agent = object(value)
    const state = agent?.state
    if (!agent || (state !== 'working' && state !== 'blocked' && state !== 'waiting' && state !== 'done')) continue
    const agentType = label(agent.agentType)
    const parent: NativeActivity = { agentType, state, toolName: typeof agent.toolName === 'string' ? nativeToolName(agent.toolName, agent.toolInput) : null }
    activities.push(parent)
    const before = childCount
    addChildren(childRoster(agent), agentType, agent.subagentObservation === 'live', 1, new Set())
    const id = sessionId(agent)
    if (childCount === before && id && uniqueIds.has(id)) {
      const supplemental = providerChildren.get(id)
      if (Array.isArray(supplemental) && providerMaySupplyChildren(agent)) {
        for (const child of supplemental.slice(0, 50 - childCount)) {
          if (!child || (child.state !== 'working' && child.state !== 'idle' && child.state !== 'waiting' && child.state !== 'unverifiable') ||
              !Number.isSafeInteger(child.updatedAt) || child.updatedAt <= 0) continue
          activities.push({ agentType, role: 'subagent', toolName: null, state: child.state, statusSource: 'antigravity', statusUpdatedAt: child.updatedAt })
          childCount++
        }
      }
      const at = childCount === before ? invocations.get(id) : undefined
      if (typeof at === 'number' && Number.isSafeInteger(at) && at > 0) parent.lastSubagentInvocationAt = at
    }
  }
  return activities
}

/** Classify only the current tool preview for the exact workspace. Never retain input. */
export function parseNativeResources(response: unknown, workspaceId: string): ResourceObservation[] {
  const row = workspaceRow(response, workspaceId)
  if (!row || !Array.isArray(row.agents)) return []
  const resources: ResourceObservation[] = []
  for (const value of row.agents) {
    const agent = object(value)
    if (!agent || (agent.state !== 'working' && agent.state !== 'blocked' && agent.state !== 'waiting')) continue
    if (typeof agent.toolName !== 'string') continue
    resources.push(...classifyResources(agent.toolName, agent.toolInput))
  }
  return resources
}

/** Classify only a currently working agent's reported tool, never a stale finished tool. */
export function parseNativeActiveResources(response: unknown, workspaceId: string): ResourceObservation[] {
  const row = workspaceRow(response, workspaceId)
  if (!row || !Array.isArray(row.agents)) return []
  const resources: ResourceObservation[] = []
  for (const value of row.agents) {
    const agent = object(value)
    if (agent?.state !== 'working' || typeof agent.toolName !== 'string') continue
    resources.push(...classifyResources(agent.toolName, agent.toolInput))
  }
  return resources
}

/** A journal ID must be one of the two canonical Orca forms, even when taken from a structured pane. */
export const validSessionId = (value: string): boolean =>
  /^(?:[a-z][a-z0-9-]{0,31}_[a-f0-9]{8}_[a-f0-9]{4}_[a-f0-9]{4}_[a-f0-9]{4}_[a-f0-9]{12}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(value)

function sessionId(agent: Record<string, unknown> | null): string | null {
  if (!agent || typeof agent.paneKey !== 'string' || agent.structuredHostOwned === false) return null
  const id = /^structured-agent-session-([^:]+):[^:]+$/.exec(agent.paneKey)?.[1]
  if (!id || !validSessionId(id)) return null
  if (agent.orcaSessionId != null && agent.orcaSessionId !== id) return null
  // Settled structured sessions can lose the live-ownership flag. Their explicit
  // local session ID must still agree with the pane before its history can be read.
  return agent.structuredHostOwned === true || (agent.state === 'done' && agent.orcaSessionId === id) ? id : null
}

export function nativeJournalSessions(response: unknown, workspaceId: string) {
  const row = workspaceRow(response, workspaceId)
  const sessions = new Map<string, { id: string; agentType: string | null; working: boolean; updatedAt: number }>()
  if (row?.hostId === 'local' && Array.isArray(row.agents)) {
    for (const value of row.agents) {
      const agent = object(value)
      const id = sessionId(agent)
      if (!agent || !id) continue
      const working = agent.state === 'working'
      if (sessions.get(id)?.working && !working) continue
      sessions.set(id, { id, agentType: label(agent.agentType), working, updatedAt: typeof agent.updatedAt === 'number' ? agent.updatedAt : 0 })
    }
  }
  const sorted = [...sessions.values()].sort((a, b) => Number(b.working) - Number(a.working) || b.updatedAt - a.updatedAt)
  return { sessions: sorted.slice(0, 4), truncated: sorted.length > 4 }
}

export function nativeSessionIds(response: unknown, workspaceId: string): { ids: string[]; truncated: boolean } {
  const { sessions, truncated } = nativeJournalSessions(response, workspaceId)
  return { ids: sessions.map(s => s.id), truncated }
}

export function nativeWorkingSessionIds(response: unknown, workspaceId: string): Set<string> {
  return new Set(nativeJournalSessions(response, workspaceId).sessions.filter(s => s.working).map(s => s.id))
}

/** Only live, working children of the exact local session can make their tool calls active. */
export function nativeWorkingChildIds(response: unknown, workspaceId: string): Map<string, Set<string>> {
  const row = workspaceRow(response, workspaceId)
  const result = new Map<string, Set<string>>()
  if (!row || row.hostId !== 'local' || !Array.isArray(row.agents)) return result
  const eligible = nativeWorkingSessionIds(response, workspaceId)
  const parents = new Map<string, Record<string, unknown>[]>()
  for (const value of row.agents) {
    const parent = object(value)
    if (!parent) continue
    const id = sessionId(parent)
    if (!id || !eligible.has(id)) continue
    const group = parents.get(id) ?? []
    group.push(parent)
    parents.set(id, group)
  }
  for (const [id, group] of parents) {
    if (group.length !== 1 || group[0].subagentObservation !== 'live') continue
    const states = new Map<string, boolean>()
    let budget = 50
    const visit = (children: unknown[], depth: number, liveParent: boolean) => {
      for (const value of children) {
        if (--budget < 0) break
        const child = object(value)
        if (!child || !isChildAgent(child)) continue
        const live = liveParent && child.membership === 'live' && child.state === 'working'
        if (validChildId(child.providerId)) {
          states.set(child.providerId, states.has(child.providerId) ? false : live)
        }
        if (depth < 3 && Array.isArray(child.children)) visit(child.children, depth + 1, live)
      }
    }
    visit(childRoster(group[0]), 1, true)
    result.set(id, new Set([...states].filter(([, live]) => live).map(([childId]) => childId)))
  }
  return result
}
