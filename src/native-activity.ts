import { classifyResources, type ResourceObservation } from './resource-classifier'

/** A deliberately narrow view of an Orca workspace agent's current reported activity. */
export type NativeActivity = {
  agentType: string | null
  state: 'working' | 'blocked' | 'waiting' | 'done'
  toolName: string | null
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
  for (const value of row.agents) {
    const agent = object(value)
    const state = agent?.state
    if (state !== 'working' && state !== 'blocked' && state !== 'waiting' && state !== 'done') continue
    activities.push({ agentType: label(agent?.agentType), state, toolName: label(agent?.toolName) })
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
