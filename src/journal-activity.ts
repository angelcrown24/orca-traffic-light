import { execFile } from 'node:child_process'
import { validSessionId } from './native-activity'
import { classifyResources, nativeToolName, type ResourceObservation } from './resource-classifier'

/** Internal Orca journal schema and privacy boundary: no raw inputs leave this module. */
export type JournalToolCall = { id: string; name: string; observedAt: number; state: 'running' | 'completed' | 'failed' | 'unknown' }
export type JournalResult = { recentTools?: JournalToolCall[]; lastSubagentInvocationAt?: number; status: 'ready' | 'unavailable' | 'truncated'; resources: ResourceObservation[]; activeResources?: ResourceObservation[] }
type Query = (sql: string) => Promise<unknown>
const MAX_CALLS = 300

/** Do not accept a path, quote, or arbitrary SQL as an identifier. */
export function journalEpoch(sessionId: string, workspaceId: string): string | null {
  if (!validSessionId(sessionId) || !workspaceId || workspaceId.length > 4096 || /[\x00-\x1f\x7f]/.test(workspaceId)) return null
  const owner = "'" + workspaceId.replace(/'/g, "''") + "'"
  return `SELECT epoch FROM journal_chat_state WHERE session_id='${sessionId}' AND workspace_id=${owner}`
}

export function journalQuery(sessionId: string, workspaceId: string): string | null {
  const epoch = journalEpoch(sessionId, workspaceId)
  if (!epoch) return null
  // sessionId is strictly validated before interpolation. SQLite JSON extracts only the
  // tool name and a bounded input; messages and tool outputs never reach the worker.
  return `WITH current AS (${epoch}), latest_turn AS (
    SELECT item_id, lifecycle_state FROM journal_items
    WHERE session_id='${sessionId}' AND epoch=(SELECT epoch FROM current)
      AND hidden=0 AND root=1 AND kind='turn' AND turn_marker=1
    ORDER BY sequence DESC, sequence_index DESC, ordinal DESC LIMIT 1
  ), calls AS (
    SELECT payload_json, sequence, sequence_index, turn_item_id, root, producer_agent_id, lifecycle_state FROM journal_items
    WHERE session_id='${sessionId}' AND epoch=(SELECT epoch FROM current)
      AND kind='tool-call' AND hidden=0 AND (SELECT user_version FROM pragma_user_version)=2
    ORDER BY sequence DESC, sequence_index DESC LIMIT ${MAX_CALLS + 1}
  )
  SELECT 'meta' AS kind, (SELECT user_version FROM pragma_user_version) AS version,
    (SELECT count(*) FROM current) AS format, NULL AS name, NULL AS input, NULL AS active,
    NULL AS mcp_server, NULL AS mcp_tool, NULL AS is_root, NULL AS producer,
    NULL AS seq, NULL AS idx, NULL AS at_ms, NULL AS state
  UNION ALL
  SELECT 'call', NULL, NULL, substr(json_extract(payload_json,'$.body.name'),1,256),
    -- Prefer a single structured read path or command. Truncating an entire JSON
    -- object mid-string otherwise drops valid skill references from long previews.
    CASE WHEN json_extract(payload_json,'$.body.name') IN ('invoke_subagent','manage_subagents') THEN NULL
      WHEN json_type(payload_json,'$.body.input')='object' AND lower(json_extract(payload_json,'$.body.name')) IN
      ('bash','shell','execute','terminal','run_command','run_shell_command','exec_command','functions.exec_command','functions/exec_command')
      THEN substr(coalesce(json_extract(payload_json,'$.body.input.command'),json_extract(payload_json,'$.body.input.cmd'),
        json_extract(payload_json,'$.body.input.CommandLine'),json_extract(payload_json,'$.body.input.command_line')),1,8192)
      ELSE substr(coalesce(json_extract(payload_json,'$.body.input.Path'), json_extract(payload_json,'$.body.input.path'),
      json_extract(payload_json,'$.body.input.file_path'), json_extract(payload_json,'$.body.input.AbsolutePath'),
      json_extract(payload_json,'$.body.input.absolute_path'), json_extract(payload_json,'$.body.input.command'),
      json_extract(payload_json,'$.body.input.cmd'), json_extract(payload_json,'$.body.input')),1,8192) END,
    CASE WHEN (SELECT lifecycle_state FROM latest_turn)='running'
      AND turn_item_id=(SELECT item_id FROM latest_turn) THEN 1 ELSE 0 END,
    substr(coalesce(json_extract(payload_json,'$.body.mcpIdentity.server'), CASE WHEN json_extract(payload_json,'$.body.name')='execute' THEN json_extract(payload_json,'$.body.input.ServerName') END),1,128),
    substr(coalesce(json_extract(payload_json,'$.body.mcpIdentity.tool'), CASE WHEN json_extract(payload_json,'$.body.name')='execute' THEN json_extract(payload_json,'$.body.input.ToolName') END),1,256),
    root, producer_agent_id, sequence, sequence_index, json_extract(payload_json,'$.observedAt'), lifecycle_state FROM calls;`
}

/** Run only on macOS and only against the running user's local Orca journal, read-only. */
export function queryLocalJournal(sql: string): Promise<unknown> {
  if (process.platform !== 'darwin' || !process.env.HOME) return Promise.reject(new Error('unavailable'))
  const file = `${process.env.HOME}/Library/Application Support/orca/agent-session-domain.db`
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sqlite3', ['-readonly', '-json', file, sql],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
        if (error) return reject(new Error('unavailable'))
        try { resolve(JSON.parse(stdout)) } catch { reject(new Error('unavailable')) }
      })
  })
}

/** Only display labels returned by the classifier, never commands, prompts or outputs. */
export async function readJournalActivity(sessionId: string, workspaceId: string, query: Query = queryLocalJournal, workingChildren: ReadonlySet<string> = new Set(), rootWorking = true): Promise<JournalResult> {
  const sql = journalQuery(sessionId, workspaceId)
  if (!sql) return { status: 'unavailable', resources: [] }
  try {
    const value = await query(sql)
    if (!Array.isArray(value) || !value.length) return { status: 'unavailable', resources: [] }
    const meta = value[0]
    if (!meta || meta.kind !== 'meta' || meta.version !== 2 || meta.format !== 1) return { status: 'unavailable', resources: [] }
    const calls = value.slice(1)
    if (calls.some((x) => !x || x.kind !== 'call' || typeof x.name !== 'string')) return { status: 'unavailable', resources: [] }
    const resources: ResourceObservation[] = []
    const seen = new Set<string>()
    const activeSeen = new Set<string>()
    const activeResources: ResourceObservation[] = []
    const recentTools: JournalToolCall[] = []
    let lastSubagentInvocationAt = 0
    for (const item of calls.slice(0, MAX_CALLS)) {
      const owner = (item.is_root === 1 && rootWorking) || (item.is_root === 0 && typeof item.producer === 'string' && workingChildren.has(item.producer))
      const active = item.active === 1 && owner
      const identity = { server: item.mcp_server, tool: item.mcp_tool }
      const name = nativeToolName(item.name, item.input, identity)
      // Antigravity records dispatch and roster queries as separate calls. Only a
      // root dispatch is evidence of delegation. Its return says nothing about the child.
      if (item.name === 'invoke_subagent' && item.is_root === 1 && item.state === 'completed' &&
          identity.server == null && identity.tool == null && Number.isSafeInteger(item.at_ms) && item.at_ms > lastSubagentInvocationAt) {
        lastSubagentInvocationAt = item.at_ms
      }
      if (name && Number.isSafeInteger(item.seq) && Number.isSafeInteger(item.idx) && Number.isSafeInteger(item.at_ms) && item.at_ms > 0) {
        const state = item.state === 'completed' || item.state === 'failed' ? item.state : item.state === 'running' && active ? 'running' : 'unknown'
        recentTools.push({ id: sessionId + ':' + item.seq + ':' + item.idx, name, observedAt: item.at_ms, state })
      }
      for (const resource of classifyResources(item.name, item.input, identity)) {
        const key = `${resource.category}:${resource.name}`
        if (!seen.has(key)) { seen.add(key); resources.push(resource) }
        if (active && !activeSeen.has(key)) { activeSeen.add(key); activeResources.push(resource) }
      }
    }
    return { status: calls.length > MAX_CALLS ? 'truncated' : 'ready', resources, activeResources,
      ...(lastSubagentInvocationAt ? { lastSubagentInvocationAt } : {}),
      ...(recentTools.length ? { recentTools: recentTools.sort((a, b) => b.observedAt - a.observedAt).slice(0, 30) } : {}) }
  } catch { return { status: 'unavailable', resources: [] } }
}
