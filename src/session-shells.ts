import { execFile } from 'node:child_process'
import {
  antigravityChildSessionIds,
  localSessionOwners,
  mainAgentWorking,
  workspaceRow,
  type NativeActivity,
  type ProviderChildStatus
} from './native-activity'
import { journalEpoch, queryLocalJournal } from './journal-activity'
import { resolveOrcaCli } from './native-reader'
import { hostWorkTree, type ChildShellOwner, type SessionWorkNode } from './host-work-tree'
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
  'functions/exec_command',
  'shell_command',
  'functions.shell_command',
  'functions/shell_command'
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

// A root call must be in its open main turn. A Codex child call must name both the
// verified producer and its exact open child turn, which can outlive the main turn.
async function runningJournalShells(id: string, workspace: string, rootWorking: boolean,
    owners: ReadonlyMap<string, ChildShellOwner>, query: NonNullable<Sources['journal']>) {
  const result = new Map<SessionWorkNode | null, SessionWorkNode[]>()
  const epoch = journalEpoch(id, workspace)
  if (!epoch) return result
  const literal = (v: string) => "'" + v.replace(/'/g, "''") + "'"
  const bindings = [...owners].slice(0, 50).map(([thread, { prefix }]) => '(' + literal(thread) + ',' + literal(prefix) + ')')
  const ownerList = bindings.length ? 'codex(thread, prefix) AS (VALUES ' + bindings.join(',') + '),' : ''
  const root = rootWorking ? "(root=1 AND turn_item_id=(SELECT item_id FROM turn) AND (SELECT lifecycle_state FROM turn)='running')" : '0'
  const child = bindings.length ? 'OR (root=0 AND EXISTS (SELECT 1 FROM codex WHERE thread=producer_agent_id AND substr(item_id,1,length(prefix))=prefix))' : ''
  const sql = `WITH epoch AS (${epoch}),
  turn AS (SELECT item_id,lifecycle_state FROM journal_items WHERE session_id='${id}' AND epoch=(SELECT epoch FROM epoch)
    AND hidden=0 AND root=1 AND kind='turn' AND turn_marker=1 ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT 1),
  ${ownerList}
  calls AS (SELECT epoch, item_id, ${bindings.length ? 'CASE WHEN root=0 THEN producer_agent_id END' : 'NULL'} AS owner,
    lower(json_extract(payload_json,'$.body.name')) AS raw_tool,
    json_extract(payload_json,'$.observedAt') AS at_ms,
    coalesce(json_extract(payload_json,'$.body.input.command'), json_extract(payload_json,'$.body.input.cmd'),
      json_extract(payload_json,'$.body.input.CommandLine'), json_extract(payload_json,'$.body.input.command_line'),
      CASE WHEN json_type(payload_json,'$.body.input')='text'
        AND lower(json_extract(payload_json,'$.body.name')) NOT IN ('execute','running execute')
        THEN json_extract(payload_json,'$.body.input') END) AS cmd
    FROM journal_items WHERE session_id='${id}' AND epoch=(SELECT epoch FROM epoch) AND hidden=0
    AND kind='tool-call' AND lifecycle_state='running' AND (${root} ${child})
    AND (SELECT user_version FROM pragma_user_version)=2
    AND json_extract(payload_json,'$.body.mcpIdentity') IS NULL AND json_extract(payload_json,'$.body.input.ServerName') IS NULL
    AND json_extract(payload_json,'$.body.input.ToolName') IS NULL),
  normalized AS (SELECT CASE WHEN raw_tool LIKE 'running %' THEN substr(raw_tool,9) ELSE raw_tool END AS tool,
    epoch, item_id, owner, at_ms, ltrim(replace(substr(cmd,1,512),char(9),' ')) AS line FROM calls WHERE cmd IS NULL OR typeof(cmd)='text'),
  shells AS (SELECT epoch, item_id, owner, tool, at_ms,
    row_number() OVER (PARTITION BY owner IS NULL ORDER BY at_ms DESC, item_id) AS bucket, substr(line,1,instr(line||' ',' ')-1) AS executable FROM normalized
    WHERE tool IN (${[...shellTools].map((s) => "'" + s + "'").join(',')}) OR (tool='execute' AND line IS NOT NULL)
    ),
  programs(name) AS (VALUES ${[...programs].map((s) => "('" + s + "')").join(',')})
  SELECT epoch, item_id, owner, tool, at_ms, (SELECT name FROM programs WHERE executable=name OR (executable NOT GLOB '*[^a-zA-Z0-9_./+-]*' AND executable LIKE '%/'||name) LIMIT 1) AS program
    FROM shells WHERE bucket<=30 ORDER BY at_ms DESC, item_id;`
  const out = await query(sql)
  if (!Array.isArray(out)) return result
  for (const value of out.slice(0, 60)) {
    const item = object(value)
    if (!item || typeof item.tool !== 'string' || !(shellTools.has(item.tool) || item.tool === 'execute')) continue
    const epoch = item.epoch, itemId = item.item_id
    if ((typeof epoch !== 'string' && typeof epoch !== 'number') || !String(epoch).length || String(epoch).length > 256 ||
        typeof itemId !== 'string' || !itemId.length || itemId.length > 4096) continue
    const owner = typeof item.owner === 'string' ? owners.get(item.owner) : undefined
    if (item.owner !== null && (!owner || !itemId.startsWith(owner.prefix) || !/^(0|[1-9][0-9]{0,15})$/.test(itemId.slice(owner.prefix.length)))) continue
    if (item.owner === null && !rootWorking) continue
    const since = at(item.at_ms)
    const name = typeof item.program === 'string' && programs.has(item.program) ? item.program : item.tool === 'bash' ? 'bash' : ''
    const key = owner?.node ?? null
    const group = result.get(key) ?? []
    group.push({ id: workId(id, 'journal-shell', epoch, itemId), children: [], kind: 'shell', ...(name ? { name } : {}),
      state: 'running', ...(since ? { since } : {}) })
    result.set(key, group)
  }
  return result
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
  const calls = choice.kind === 'chat' && (rootWorking || host.codexOwners.size) && typeof row.worktreeId === 'string'
    ? await runningJournalShells(handle, row.worktreeId, rootWorking, host.codexOwners, sources.journal ?? queryLocalJournal).catch(() => null) : null
  const preview = rootWorking ? shellLabel(agent.toolName, agent.toolInput) : null
  const branch = choice.kind === 'terminal' ? result.tree[0].children : result.tree
  const rootCalls = calls?.get(null) ?? []
  branch.push(...rootCalls)
  if (!rootCalls.length && preview !== null) {
    branch.push({ id: workId(handle, 'foreground-preview', preview), kind: 'shell', ...(preview ? { name: preview } : {}), state: 'running', children: [] })
  }
  for (const [owner, shells] of calls ?? []) {
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
