import { execFile } from 'node:child_process'
import {
  antigravityChildSessionIds,
  localSessionOwners,
  mainAgentWorking,
  workspaceRow,
  type NativeActivity,
  type ProviderChildStatus
} from './native-activity'
import { queryLocalJournal } from './journal-activity'
import { readSessionJournal, shellTools, type TurnActivity } from './session-work-journal'
import { resolveOrcaCli } from './native-reader'
import { hostWorkTree, type SessionWorkNode } from './host-work-tree'
import { workId } from './work-id'

export type { SessionWorkNode } from './host-work-tree'

type Row = Record<string, unknown>
type Context = { workspaceId?: string; terminals: readonly { id: string }[] } | null
export type ShellOption = { id: string; kind: 'chat' | 'terminal'; provider?: string; number: number }
export type SessionShellRow = {
  kind: 'shell' | 'background' | 'terminal'
  name: string
  state: 'running' | 'waiting' | 'connected' | 'unknown'
  since?: number
}
export type SessionShells = {
  status: 'ready' | 'select' | 'unavailable' | 'disabled'
  options: ShellOption[]
  selected: string | null
  rows: SessionShellRow[]
  subagents: NativeActivity[]
  tree?: SessionWorkNode[]
  mainWorking?: true
  turnActivity?: TurnActivity
}
type Sources = {
  focus?: string | null
  terminal?: (handle: string) => Promise<unknown>
  journal?: (sql: string) => Promise<unknown>
  providerChildren?: (workspaceId: string, sessionIds: string[]) => Promise<ReadonlyMap<string, readonly ProviderChildStatus[]>>
}
const object = (v: unknown): Row | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Row) : null)
const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}'
const terminalHandle = new RegExp('^term_' + uuid + '$')
const knownProviders = new Set(['antigravity', 'claude', 'codex', 'copilot', 'cursor', 'droid', 'gemini', 'grok', 'omp', 'opencode', 'pi'])
const programs = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'pwsh',
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'deno',
  'python',
  'python3',
  'uv',
  'pip',
  'pip3',
  'git',
  'gh',
  'go',
  'cargo',
  'make',
  'cmake',
  'docker',
  'podman',
  'ssh',
  'rsync',
  'curl',
  'rg',
  'ls',
  'cat',
  'find',
  'sqlite3',
  'pytest',
  'tsc',
  'swift',
  'xcodebuild'
])
const at = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined)

export function emptyShells(status: SessionShells['status']): SessionShells {
  return { status, options: [], selected: null, rows: [], subagents: [] }
}

function program(value: unknown): string {
  const first = typeof value === 'string' ? /^\s*([\w./+-]+)(?:\s|$)/.exec(value.slice(0, 512))?.[1] : undefined
  const base = first?.split('/').pop()
  return base && programs.has(base) ? base : ''
}

function terminalShow(handle: string): Promise<unknown> {
  const cli = resolveOrcaCli(process.platform, process.env.ORCA_CLI_COMMAND)
  if (!cli || !terminalHandle.test(handle)) return Promise.reject(Error('Unsupported terminal'))
  return new Promise((resolve, reject) => {
    execFile(
      cli,
      ['terminal', 'show', '--environment', 'local', '--terminal', handle, '--json'],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 512 * 1024 },
      (error, data) => {
        try {
          if (error) throw error
          resolve(JSON.parse(data))
        } catch {
          reject(Error('Terminal unavailable'))
        }
      }
    )
  })
}

function shellLabel(toolName: unknown, rawInput: unknown): string | null {
  if (typeof toolName !== 'string') return null
  const tool = toolName.replace(/^running /i, '').toLowerCase()
  let input: unknown = rawInput
  if (typeof input === 'string' && input.length <= 16_384 && input.trimStart().startsWith('{')) {
    try {
      input = JSON.parse(input)
    } catch {
      /* Keep opaque previews generic. */
    }
  }
  const args = object(input)
  if (args && ('ServerName' in args || 'ToolName' in args || 'mcpIdentity' in args)) return null
  const cmd = args?.cmd ?? args?.command ?? args?.CommandLine ?? args?.command_line
  if (!shellTools.has(tool) && !(tool === 'execute' && typeof cmd === 'string')) return null
  return program(cmd ?? input) || (tool === 'bash' ? 'bash' : '')
}

export async function readSessionShells(
  context: Context,
  snapshot: unknown,
  selected: string | null,
  sources: Sources = {}
): Promise<SessionShells> {
  const ws = context?.workspaceId
  const row = ws && workspaceRow(snapshot, ws)
  if (!context || !ws || !row || row.hostId !== 'local' || !Array.isArray(row.agents)) return emptyShells('unavailable')
  const agents = row.agents.map(object).filter((a): a is Row => !!a)
  const owners = localSessionOwners(snapshot, row)
  const options: ShellOption[] = []
  for (const [id, owner] of owners) {
    const provider = typeof owner.agentType === 'string' && knownProviders.has(owner.agentType.toLowerCase()) ? owner.agentType : undefined
    options.push({ id: 'chat:' + id, kind: 'chat', number: options.length + 1, ...(provider ? { provider } : {}) })
  }
  const terminals = [...new Set(context.terminals.map((t) => t.id).filter((id) => terminalHandle.test(id)))].slice(0, 50)
  terminals.forEach((id, i) => options.push({ id: 'terminal:' + id, kind: 'terminal', number: i + 1 }))
  const choice = options.find((o) => o.id === (selected ?? sources.focus))
  const result: SessionShells = { ...emptyShells(choice ? 'ready' : 'select'), options, selected: choice?.id ?? null }
  if (!choice) return result
  result.tree = []

  const handle = choice.id.slice(choice.id.indexOf(':') + 1)
  let agent: Row | null = owners.get(handle) ?? null
  if (choice.kind === 'terminal') {
    const data = await (sources.terminal ?? terminalShow)(handle).catch(() => null)
    const reply = object(data)
    const terminal = object(object(reply?.result)?.terminal)
    if (
      reply?.ok !== true ||
      !terminal ||
      terminal.handle !== handle ||
      typeof row.worktreeId !== 'string' ||
      terminal.worktreeId !== row.worktreeId ||
      terminal.executionHostId !== 'local' ||
      terminal.orphaned === true
    )
      return { ...result, status: 'unavailable' }
    if (terminal.exitCause || terminal.verdict === 'exited' || terminal.connected === false) return result
    if (terminal.connected !== true || !terminal.ptyId || (terminal.verdict !== undefined && terminal.verdict !== 'live'))
      return { ...result, status: 'unavailable' }
    const name = programs.has(String(terminal.title)) ? String(terminal.title) : ''
    result.rows.push({ kind: 'terminal', name, state: 'connected' })
    result.tree.push({ id: workId(handle, 'terminal'), kind: 'terminal', ...(name ? { name } : {}), state: 'connected', children: [] })
    const matches =
      typeof terminal.tabId === 'string' && typeof terminal.leafId === 'string'
        ? agents.filter((a) => a.paneKey === terminal.tabId + ':' + terminal.leafId)
        : []
    agent = matches.length === 1 ? matches[0] : null
  }
  if (!agent) return result
  let host: ReturnType<typeof hostWorkTree>
  try { host = hostWorkTree(agent, handle, shellLabel, program) }
  catch { return { ...result, status: 'unavailable', rows: [], tree: [] } }
  const rootWorking = mainAgentWorking(agent)
  const preview = rootWorking ? shellLabel(agent.toolName, agent.toolInput) : null
  const updatedAt = at(agent.updatedAt)
  const previewEvent = preview !== null && typeof agent.toolName === 'string' && updatedAt
    ? { tool: agent.toolName.replace(/^running /i, '').toLowerCase(), updatedAt } : undefined
  const journal = choice.kind === 'chat' && (rootWorking || host.codexOwners.size) && typeof row.worktreeId === 'string'
    ? await readSessionJournal(handle, row.worktreeId, rootWorking, host.codexOwners, programs, sources.journal ?? queryLocalJournal, previewEvent).catch(() => null) : null
  const mainStartedAt = at(object(agent.mainAgent)?.stateStartedAt ?? agent.stateStartedAt)
  const afterSettledTurn = journal?.turnEndedAt && mainStartedAt && mainStartedAt > journal.turnEndedAt
  const mainWorking = rootWorking && (!journal?.turnSettled || afterSettledTurn)
  if (choice.kind === 'chat' && mainWorking) {
    result.mainWorking = true
    if (journal?.activity) result.turnActivity = journal.activity
  }
  const branch = choice.kind === 'terminal' ? result.tree[0].children : result.tree
  const rootCalls = journal?.calls.get(null) ?? []
  branch.push(...rootCalls)
  const previewMatchesTurn = !afterSettledTurn || (updatedAt && mainStartedAt && updatedAt >= mainStartedAt)
  if (mainWorking && previewMatchesTurn && preview !== null && !journal?.previewEnded && !rootCalls.some(node => node.kind === 'shell')) {
    branch.push({ id: workId(handle, 'foreground-preview', preview), kind: 'shell', ...(preview ? { name: preview } : {}), state: 'running', children: [] })
  }
  for (const [owner, shells] of journal?.calls ?? []) {
    // The host preview is a fallback for the same producer. Preserve its genuine background children.
    if (owner) owner.children = [...shells, ...owner.children.filter(n => n.kind !== 'shell')]
  }
  branch.push(...host.nodes)
  const scope = { result: { worktrees: [{ ...row, agents: [agent] }] } }
  if (choice.kind === 'chat' && sources.providerChildren && typeof row.worktreeId === 'string' && antigravityChildSessionIds(scope, ws).includes(handle)) {
    const provider = await sources.providerChildren(row.worktreeId, [handle]).catch(() => undefined)
    const children = provider?.get(handle)?.slice(0, 50) ?? []
    for (const child of children.sort((a, b) => String(a?.key).localeCompare(String(b?.key)))) {
      if (child?.state !== 'working' || !at(child.updatedAt) || !child.key || !/^[a-f0-9]{32}$/.test(child.key)) continue
      branch.push({ id: child.key, kind: 'subagent', state: 'working', statusSource: 'antigravity', statusUpdatedAt: child.updatedAt, children: [] })
    }
  }
  // Retain the earlier flat response for callers while deriving it from the same live nodes.
  const agentType = choice.provider ?? (typeof agent.agentType === 'string' && knownProviders.has(agent.agentType) ? agent.agentType : null)
  function flatten(nodes: SessionWorkNode[]) {
    for (const node of nodes) {
      if (node.state !== 'context') {
        if (node.kind === 'subagent' && (node.state === 'working' || node.state === 'monitoring')) {
          result.subagents.push({ role: 'subagent', state: node.state, agentType, toolName: null, ...(node.name ? { label: node.name } : {}),
            ...(node.statusSource ? { statusSource: node.statusSource, statusUpdatedAt: node.statusUpdatedAt } : {}) })
        } else if (node.kind === 'shell' || node.kind === 'background') {
          result.rows.push({ kind: node.kind, name: node.name ?? '', state: 'running', ...(node.since ? { since: node.since } : {}) })
        }
      }
      flatten(node.children)
    }
  }
  flatten(branch)
  return result
}
