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

/**
 * Extract only status labels for the exact workspace address. This intentionally does not
 * return agent prompts, tool inputs, assistant messages or any other fields from the response.
 * A missing or ambiguous workspace address returns no rows rather than guessing.
 */
export function parseNativeActivity(response: unknown, workspaceId: string): NativeActivity[] {
  if (!workspaceId) return []
  const result = object(object(response)?.result)
  if (!Array.isArray(result?.worktrees)) return []
  const matches = result.worktrees.map(object).filter((row) => object(row?.address)?.worktree === workspaceId)
  if (matches.length !== 1 || !Array.isArray(matches[0]?.agents)) return []
  const activities: NativeActivity[] = []
  for (const value of matches[0].agents) {
    const agent = object(value)
    const state = agent?.state
    if (state !== 'working' && state !== 'blocked' && state !== 'waiting' && state !== 'done') continue
    activities.push({ agentType: label(agent?.agentType), state, toolName: label(agent?.toolName) })
  }
  return activities
}
