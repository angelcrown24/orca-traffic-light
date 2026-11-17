import { classifyResources, type ResourceObservation } from './resource-classifier'

/** A deliberately narrow view of an Orca workspace agent's current reported activity. */
export type NativeActivity = {
  agentType: string | null
  state: 'working' | 'blocked' | 'waiting' | 'done' | 'unverifiable'
  toolName: string | null
  role?: 'subagent'
  label?: string
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

/**
 * Extract only status labels for the exact workspace address. This intentionally does not
 * return agent prompts, tool inputs, assistant messages or any other fields from the response.
 * A missing or ambiguous workspace address returns no rows rather than guessing.
 */
export function parseNativeActivity(response: unknown, workspaceId: string): NativeActivity[] {
  const row = workspaceRow(response, workspaceId)
  if (!row || !Array.isArray(row.agents)) return []
  const activities: NativeActivity[] = []
  const seenChildren = new Set<string>()
  const addChildren = (children: unknown, parentType: string | null, observation: unknown, depth: number): void => {
    if (!Array.isArray(children) || depth > 3 || seenChildren.size >= 50) return
    for (const value of children.slice(0, 50)) {
      if (seenChildren.size >= 50) break
      const child = object(value)
      if (!child || typeof child.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(child.id) || seenChildren.has(child.id)) continue
      const state = child.state
      if (state !== 'working' && state !== 'blocked' && state !== 'waiting' && state !== 'idle' && state !== 'unverifiable') continue
      seenChildren.add(child.id)
      // Only short machine-style task identifiers are displayed, never arbitrary descriptions or prompts.
      const name = typeof child.description === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(child.description) ? child.description : undefined
      activities.push({ agentType: parentType, state: observation !== 'live' || child.membership !== 'live' || state === 'unverifiable' ? 'unverifiable' : state === 'idle' ? 'waiting' : state,
        toolName: null, role: 'subagent', ...(name ? { label: name } : {}) })
      addChildren(child.children, parentType, observation, depth + 1)
    }
  }
  for (const value of row.agents) {
    const agent = object(value)
    const state = agent?.state
    if (state !== 'working' && state !== 'blocked' && state !== 'waiting' && state !== 'done') continue
    const agentType = label(agent?.agentType)
    activities.push({ agentType, state, toolName: label(agent?.toolName) })
    addChildren(agent?.children, agentType, agent?.subagentObservation, 1)
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

/** Only local structured sessions in the exact current workspace are eligible for local journal access. */
export function nativeSessionIds(response: unknown, workspaceId: string): { ids: string[]; truncated: boolean } {
  const row = workspaceRow(response, workspaceId)
  if (!row || row.hostId !== 'local' || !Array.isArray(row.agents)) return { ids: [], truncated: false }
  const ids = new Set<string>()
  for (const value of row.agents) {
    const agent = object(value)
    if (agent?.structuredHostOwned !== true || typeof agent.paneKey !== 'string') continue
    const match = /^structured-agent-session-([a-z][a-z0-9-]{0,31}_[a-f0-9]{8}_[a-f0-9]{4}_[a-f0-9]{4}_[a-f0-9]{4}_[a-f0-9]{12}):[^:]+$/.exec(agent.paneKey)
    if (match) ids.add(match[1])
  }
  const all = [...ids]
  return { ids: all.slice(0, 4), truncated: all.length > 4 }
}

/** Working sessions must also belong to the exact current workspace and host. */
export function nativeWorkingSessionIds(response: unknown, workspaceId: string): Set<string> {
  const row = workspaceRow(response, workspaceId)
  if (!row || row.hostId !== 'local' || !Array.isArray(row.agents)) return new Set()
  const eligible = new Set(nativeSessionIds(response, workspaceId).ids)
  const working = new Set<string>()
  for (const value of row.agents) {
    const agent = object(value)
    if (agent?.state !== 'working' || agent.structuredHostOwned !== true || typeof agent.paneKey !== 'string') continue
    const match = /^structured-agent-session-([^:]+):[^:]+$/.exec(agent.paneKey)
    if (match && eligible.has(match[1])) working.add(match[1])
  }
  return working
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
    if (parent?.structuredHostOwned !== true || typeof parent.paneKey !== 'string') continue
    const id = /^structured-agent-session-([^:]+):[^:]+$/.exec(parent.paneKey)?.[1]
    if (!id || !eligible.has(id)) continue
    const group = parents.get(id) ?? []
    group.push(parent)
    parents.set(id, group)
  }
  for (const [id, group] of parents) {
    if (group.length !== 1 || group[0].subagentObservation !== 'live' || !Array.isArray(group[0].children)) continue
    const states = new Map<string, boolean>()
    for (const value of group[0].children.slice(0, 50)) {
      const child = object(value)
      if (!child || typeof child.providerId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(child.providerId)) continue
      const live = child.membership === 'live' && child.state === 'working'
      states.set(child.providerId, states.has(child.providerId) ? false : live)
    }
    result.set(id, new Set([...states].filter(([, live]) => live).map(([childId]) => childId)))
  }
  return result
}
