import { execFile } from 'node:child_process'
import {
  antigravityChildSessionIds,
  parseNativeActivity,
  sessionId,
  workspaceRow,
  type NativeActivity,
  type ProviderChildStatus
} from './native-activity'
import { queryLocalJournal } from './journal-activity'
import { resolveOrcaCli } from './native-reader'

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
const shellTools = new Set([
  'bash',
  'shell',
  'terminal',
  'run_command',
  'run_shell_command',
  'exec_command',
  'functions.exec_command',
  'functions/exec_command'
])
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

function shellPreview(agent: Row): SessionShellRow | null {
  if (agent.state !== 'working' || (object(agent.mainAgent)?.state ?? agent.state) !== 'working' || typeof agent.toolName !== 'string')
    return null
  const tool = agent.toolName.replace(/^Running /, '').toLowerCase()
  let input: unknown = agent.toolInput
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
  return { kind: 'shell', name: program(cmd ?? input) || (tool === 'bash' ? 'bash' : ''), state: 'running' }
}

// Isolate running root shell calls from the selected conversation and current turn. Filtering here
// avoids moving a session’s command lines, tool outputs or messages into the worker via SQLite.
async function runningJournalShells(id: string, workspace: string, query: NonNullable<Sources['journal']>): Promise<SessionShellRow[]> {
  if (!workspace || workspace.length > 4096 || /[\x00-\x1f\x7f]/.test(workspace)) return []
  const owner = "'" + workspace.replace(/'/g, "''") + "'"
  const sql = `WITH epoch AS (SELECT epoch FROM journal_chat_state WHERE session_id='${id}' AND workspace_id=${owner}),
  turn AS (SELECT item_id,lifecycle_state FROM journal_items WHERE session_id='${id}' AND epoch=(SELECT epoch FROM epoch)
    AND hidden=0 AND root=1 AND kind='turn' AND turn_marker=1 ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT 1),
  calls AS (SELECT lower(json_extract(payload_json,'$.body.name')) AS tool,
    json_extract(payload_json,'$.observedAt') AS at_ms,
    coalesce(json_extract(payload_json,'$.body.input.command'), json_extract(payload_json,'$.body.input.cmd'),
      json_extract(payload_json,'$.body.input.CommandLine'), json_extract(payload_json,'$.body.input.command_line')) AS cmd
    FROM journal_items WHERE session_id='${id}' AND epoch=(SELECT epoch FROM epoch) AND hidden=0 AND root=1
    AND kind='tool-call' AND lifecycle_state='running' AND turn_item_id=(SELECT item_id FROM turn)
    AND (SELECT lifecycle_state FROM turn)='running' AND (SELECT user_version FROM pragma_user_version)=2
    AND json_extract(payload_json,'$.body.mcpIdentity') IS NULL AND json_extract(payload_json,'$.body.input.ServerName') IS NULL
    AND json_extract(payload_json,'$.body.input.ToolName') IS NULL)
  SELECT tool, at_ms, CASE WHEN lower(substr(trim(cmd),1,instr(trim(cmd)||' ',' ')-1)) IN (${[...programs].map((s) => "'" + s + "'").join(',')})
    THEN lower(substr(trim(cmd),1,instr(trim(cmd)||' ',' ')-1)) END AS program FROM calls
    WHERE tool IN (${[...shellTools].map((s) => "'" + s + "'").join(',')}) OR (tool='execute' AND typeof(cmd)='text')
    ORDER BY at_ms DESC LIMIT 30;`
  const out = await query(sql)
  if (!Array.isArray(out)) return []
  return out
    .flatMap((value) => {
      const item = object(value)
      if (!item || typeof item.tool !== 'string' || !(shellTools.has(item.tool) || item.tool === 'execute')) return []
      const since = at(item.at_ms)
      return [
        {
          kind: 'shell' as const,
          name: typeof item.program === 'string' && programs.has(item.program) ? item.program : item.tool === 'bash' ? 'bash' : '',
          state: 'running' as const,
          ...(since ? { since } : {})
        }
      ]
    })
    .slice(0, 30)
}

function backgroundCommands(agent: Row): SessionShellRow[] {
  if (agent.subagentObservation !== 'live' || !Array.isArray(agent.children)) return []
  const rows: SessionShellRow[] = [],
    seen = new Set<string>()
  let budget = 100
  function visit(nodes: unknown[], depth: number) {
    for (const value of nodes) {
      if (--budget < 0 || rows.length >= 30) return
      const child = object(value)
      if (!child || typeof child.id !== 'string' || seen.has(child.id) || child.membership !== 'live') continue
      seen.add(child.id)
      if (child.kind === 'command' && (child.state === 'working' || child.state === 'monitoring')) {
        const since = at(child.firstObservedAt)
        rows.push({ kind: 'background', name: program(object(child.operation)?.input), state: 'running', ...(since ? { since } : {}) })
      }
      if (depth < 3 && child.state !== 'unverifiable' && Array.isArray(child.children)) visit(child.children, depth + 1)
    }
  }
  visit(agent.children, 1)
  return rows
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
  const owners = new Map<string, Row | null>()
  for (const agent of agents) {
    const id = sessionId(agent)
    if (id) owners.set(id, owners.has(id) ? null : agent)
  }
  // A duplicated Orca session ID is ambiguous even if its other pane is in a different workspace.
  const worktrees = object(object(snapshot)?.result)?.worktrees
  if (Array.isArray(worktrees)) {
    for (const value of worktrees) {
      const other = object(value)
      if (!other || other === row || other.hostId !== 'local' || !Array.isArray(other.agents)) continue
      for (const item of other.agents) {
        const id = sessionId(object(item))
        if (id) owners.delete(id)
      }
    }
  }
  const options: ShellOption[] = []
  for (const [id, owner] of owners) {
    if (!owner) continue
    const provider = typeof owner.agentType === 'string' && knownProviders.has(owner.agentType.toLowerCase()) ? owner.agentType : undefined
    options.push({ id: 'chat:' + id, kind: 'chat', number: options.length + 1, ...(provider ? { provider } : {}) })
  }
  const terminals = [...new Set(context.terminals.map((t) => t.id).filter((id) => terminalHandle.test(id)))].slice(0, 50)
  terminals.forEach((id, i) => options.push({ id: 'terminal:' + id, kind: 'terminal', number: i + 1 }))
  const choice = options.find((o) => o.id === (selected ?? sources.focus))
  const result: SessionShells = { ...emptyShells(choice ? 'ready' : 'select'), options, selected: choice?.id ?? null }
  if (!choice) return result

  const handle = choice.id.slice(choice.id.indexOf(':') + 1)
  let agent = owners.get(handle)
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
    result.rows.push({ kind: 'terminal', name: programs.has(String(terminal.title)) ? String(terminal.title) : '', state: 'connected' })
    const matches =
      typeof terminal.tabId === 'string' && typeof terminal.leafId === 'string'
        ? agents.filter((a) => a.paneKey === terminal.tabId + ':' + terminal.leafId)
        : []
    agent = matches.length === 1 ? matches[0] : null
  }
  if (!agent) return result
  const rootWork = agent.state === 'working' && (object(agent.mainAgent)?.state ?? agent.state) === 'working'
  const shells =
    choice.kind === 'chat' && rootWork && typeof row.worktreeId === 'string'
      ? await runningJournalShells(handle, row.worktreeId, sources.journal ?? queryLocalJournal).catch(() => []) : []
  const preview = shellPreview(agent)
  const foreground = shells.length ? shells : preview ? [preview] : []
  result.rows.push(...foreground, ...backgroundCommands(agent))
  // Restrict the existing host roster parser (and optional provider fallback) to this parent.
  const scope = { result: { worktrees: [{ ...row, agents: [agent] }] } }
  const provider =
    choice.kind === 'chat' &&
    sources.providerChildren &&
    typeof row.worktreeId === 'string' &&
    antigravityChildSessionIds(scope, ws).includes(handle)
      ? await sources.providerChildren(row.worktreeId, [handle]).catch(() => undefined)
      : undefined
  result.subagents = parseNativeActivity(scope, ws, new Map(), provider).filter(
    (a) => a.role === 'subagent' && (a.state === 'working' || a.state === 'monitoring')
  )
  return result
}
