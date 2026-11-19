import { childRoster } from './native-activity'
import { workId } from './work-id'

export type SessionWorkNode = {
  id: string
  kind: 'subagent' | 'shell' | 'edit' | 'background' | 'terminal' | 'workflow' | 'monitor'
  name?: string
  state: 'working' | 'monitoring' | 'running' | 'connected' | 'context'
  since?: number
  statusSource?: 'antigravity'
  statusUpdatedAt?: number
  children: SessionWorkNode[]
}

// Internal binding for a running Codex thread's exact provider turn. Never serialized.
export type ChildShellOwner = { prefix: string; node: SessionWorkNode }
type Row = Record<string, unknown>
type ShellLabel = (tool: unknown, input: unknown) => string | null
const object = (v: unknown): Row | null => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Row : null
const timestamp = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined
// Mirror Orca's bounded IDs internally, including provider-specific separators. These never leave the worker.
const validHostId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 &&
  v.trim() === v && !/[\x00-\x1f\x7f]/.test(v)
const kindOf = (raw: Row) => {
  switch (raw.kind) {
    case undefined: case 'agent': return 'subagent'
    case 'command': return 'background'
    case 'workflow': case 'monitor': return raw.kind
    default: return null
  }
}
const states = new Set(['working', 'monitoring', 'waiting', 'blocked', 'idle', 'done'])

function taskName(raw: Row): string | undefined {
  if (typeof raw.name === 'string' && /^(?:[a-z][a-z0-9_-]{0,31}|[A-Z][a-z]{1,20})$/.test(raw.name)) return raw.name
  if (typeof raw.description === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(raw.description)) return raw.description
  return undefined
}

// Orca's canonical roster is flat, with parentChildWorkId describing ownership.
// Older projections nested the same records in children. Validate both before linking.
export function hostWorkTree(agent: Row, session: string, shellLabel: ShellLabel, program: (input: unknown) => string) {
  const codexOwners = new Map<string, ChildShellOwner>()
  if (agent.subagentObservation !== 'live') return { nodes: [], codexOwners }
  const producerIds = new Map<string, unknown>()
  type Entry = { raw: Row; owner: string | null; flat: boolean; nested: boolean }
  const entries = new Map<string, Entry>()
  const ambiguous = new Set<string>()
  let visited = 0
  function collect(rows: unknown[], nestedOwner: string | null, depth: number) {
    for (const value of rows) {
      if (++visited > 1000 || depth > 16) throw Error('Child roster exceeds supported bounds')
      const raw = object(value)
      if (!raw) continue
      if (typeof raw.providerId === 'string') {
        const previous = producerIds.get(raw.providerId)
        producerIds.set(raw.providerId, previous === undefined || previous === raw.id ? raw.id ?? null : null)
      }
      if (!validHostId(raw.id)) continue
      const explicit = raw.parentChildWorkId
      if (explicit !== undefined && (!validHostId(explicit) || (nestedOwner !== null && explicit !== nestedOwner))) {
        ambiguous.add(raw.id)
        continue
      }
      const owner = typeof explicit === 'string' ? explicit : nestedOwner
      const old = entries.get(raw.id)
      if (old) {
        // A nested and flat representation can agree. Conflicting or duplicate records
        // cannot establish one owner or a reliable current state.
        if ((nestedOwner === null ? old.flat : old.nested) || old.owner !== owner || old.raw.kind !== raw.kind ||
            old.raw.state !== raw.state || old.raw.membership !== raw.membership) ambiguous.add(raw.id)
        if (nestedOwner === null) { old.flat = true; old.raw = raw }
        else old.nested = true
      } else entries.set(raw.id, { raw, owner, flat: nestedOwner === null, nested: nestedOwner !== null })
      if (Array.isArray(raw.children)) collect(raw.children, raw.id, depth + 1)
    }
  }
  collect(childRoster(agent), null, 0)
  const byOwner = new Map<string | null, Row[]>()
  for (const [id, { owner, raw }] of entries) {
    if (ambiguous.has(id)) continue
    const siblings = byOwner.get(owner) ?? []
    siblings.push(raw)
    byOwner.set(owner, siblings)
  }

  // Heartbeats may reorder the host roster. Keep siblings in their original start order.
  for (const siblings of byOwner.values()) {
    siblings.sort((a, b) => (timestamp(a.firstObservedAt) ?? Infinity) - (timestamp(b.firstObservedAt) ?? Infinity)
      || String(a.id).localeCompare(String(b.id)))
  }

  function childrenOf(owner: string | null, depth: number): SessionWorkNode[] {
    const nodes: SessionWorkNode[] = []
    for (const raw of byOwner.get(owner) ?? []) {
      if (depth > 16) throw Error('Child roster exceeds supported depth')
      const kind = kindOf(raw)
      if (!kind || (raw.membership !== 'live' && raw.membership !== 'settled') || !states.has(String(raw.state))) continue
      const hostId = raw.id as string
      const id = workId(session, 'host', hostId)
      const children = childrenOf(hostId, depth + 1)
      if (raw.membership !== 'live' || (raw.state !== 'working' && raw.state !== 'monitoring')) {
        const name = kind === 'subagent' ? taskName(raw) : undefined
        if (children.length) nodes.push({ id, kind, ...(name ? { name } : {}), state: 'context', children })
        continue
      }
      const op = object(raw.operation)
      const name = kind === 'background' ? (shellLabel(op?.toolName, op?.input) ?? program(op?.input)) : taskName(raw)
      const since = timestamp(raw.firstObservedAt)
      const state = raw.state === 'monitoring' ? 'monitoring' : kind === 'background' ? 'running' : 'working'
      const opSince = timestamp(op?.observedAt)
      if (kind === 'subagent' && raw.state === 'working' && op && opSince && (op.basis === 'open' || op.basis === 'reported')) {
        const executable = shellLabel(op.toolName, op.input)
        if (executable !== null) children.unshift({ id: workId(session, 'child-shell', hostId, opSince), kind: 'shell',
          ...(executable ? { name: executable } : {}), state: 'running', since: opSince, children: [] })
      }
      const node: SessionWorkNode = { id, kind, state, ...(name ? { name } : {}), ...(since ? { since } : {}), children }
      nodes.push(node)
      const threadId = raw.providerId, invocation = object(raw.invocation), turnId = invocation?.invocationId, generation = invocation?.generation
      // Codex journal keys encode the thread, turn and ordinal. A provider ID alone
      // cannot distinguish resumed runs. Only bind one unambiguous, current invocation.
      if (agent.agentType === 'codex' && kind === 'subagent' && state === 'working' &&
          typeof threadId === 'string' && producerIds.get(threadId) === hostId && validHostId(threadId) &&
          validHostId(turnId) && turnId !== threadId && typeof generation === 'number' && Number.isSafeInteger(generation) && generation > 0) {
        try {
          const prefix = 'codex:' + encodeURIComponent(threadId) + ':' + encodeURIComponent(turnId) + ':'
          codexOwners.set(threadId, { prefix, node })
        } catch { /* An ill-formed provider identifier cannot bind a journal item. */ }
      }
    }
    return nodes
  }
  // A dangling owner, a cycle, or an ambiguous owner is unreachable from this selected session.
  return { nodes: childrenOf(null, 0), codexOwners }
}
