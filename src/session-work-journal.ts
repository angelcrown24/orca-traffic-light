import { journalEpoch } from './journal-activity'
import type { ChildShellOwner, SessionWorkNode } from './host-work-tree'
import { workId } from './work-id'

export type TurnActivity = { tools: number; commands: number; edits: number }
type JournalWork = { calls: Map<SessionWorkNode | null, SessionWorkNode[]>; turnSettled?: boolean; turnEndedAt?: number; previewEnded?: boolean; activity?: TurnActivity }
const maxSummaryItems = 1000
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= maxSummaryItems
const object = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null
const at = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined

export const shellTools = new Set([
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
const editTools = new Set(['edit_file', 'write_file', 'replace_file_content', 'multi_replace_file_content', 'write_to_file',
  'edit', 'write', 'multiedit', 'apply_patch', 'functions.apply_patch', 'functions/apply_patch'])

// A root call must be in its open main turn. A Codex child call must name both the
// verified producer and its exact open child turn, which can outlive the main turn.
export async function readSessionJournal(id: string, workspace: string, rootWorking: boolean,
    owners: ReadonlyMap<string, ChildShellOwner>, programs: ReadonlySet<string>, query: (sql: string) => Promise<unknown>,
    preview?: { tool: string; updatedAt: number }) {
  const result: JournalWork = { calls: new Map() }
  const epoch = journalEpoch(id, workspace)
  if (!epoch) return result
  const literal = (v: string) => "'" + v.replace(/'/g, "''") + "'"
  const bindings = [...owners].slice(0, 50).map(([thread, { prefix }]) => '(' + literal(thread) + ',' + literal(prefix) + ')')
  const ownerList = bindings.length ? 'codex(thread, prefix) AS (VALUES ' + bindings.join(',') + '),' : ''
  const root = rootWorking ? "(root=1 AND turn_item_id=(SELECT item_id FROM turn) AND (SELECT lifecycle_state FROM turn)='running')" : '0'
  const child = bindings.length ? 'OR (root=0 AND EXISTS (SELECT 1 FROM codex WHERE thread=producer_agent_id AND substr(item_id,1,length(prefix))=prefix))' : ''
  const toolNames = [...shellTools].map(literal).join(',')
  const editNames = [...editTools].map(literal).join(',')
  const closedPreview = preview && at(preview.updatedAt) && (shellTools.has(preview.tool) || preview.tool === 'execute')
    ? `tool=${literal(preview.tool)} AND ended_ms>=${preview.updatedAt}` : '0'
  const inputFields = ['command', 'cmd', 'CommandLine', 'command_line']
  const command = 'coalesce(' + inputFields.map(key => {
    const path = `'$.body.input.${key}'`
    return `CASE WHEN json_type(payload_json,${path})='text' THEN json_extract(payload_json,${path}) END`
  }).join(',') + ')'
  const rawName = "lower(json_extract(payload_json,'$.body.name'))"
  const nonMcp = `json_extract(payload_json,'$.body.mcpIdentity') IS NULL AND json_extract(payload_json,'$.body.input.ServerName') IS NULL
    AND json_extract(payload_json,'$.body.input.ToolName') IS NULL`
  const normalize = (name: string) => `CASE WHEN ${name} LIKE 'running %' THEN substr(${name},9) ELSE ${name} END`
  const normalizedName = normalize(rawName)
  // Count the same root turn even when every command has already returned and the model is still working.
  // Read at most one extra eligible row to detect overflow. A partial total is never published.
  const sql = `WITH epoch AS (${epoch}),
  turn AS (SELECT item_id,lifecycle_state,json_extract(payload_json,'$.body.completedAt') AS ended_at FROM journal_items WHERE session_id='${id}' AND epoch=(SELECT epoch FROM epoch)
    AND hidden=0 AND root=1 AND kind='turn' AND turn_marker=1 ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT 1),
  ${ownerList}
  turn_items AS (
    SELECT kind,
      CASE WHEN kind='tool-call' AND ${nonMcp} THEN ${normalizedName} END AS tool,
      CASE WHEN kind='tool-call' THEN typeof(${command})='text' END AS has_command,
      CASE WHEN kind='tool-call' AND lifecycle_state IN ('completed','failed','cancelled')
        THEN json_extract(payload_json,'$.observedAt') END AS ended_ms
    FROM journal_items WHERE session_id='${id}' AND epoch=(SELECT epoch FROM epoch) AND hidden=0 AND ${root}
      AND kind IN ('tool-call','diff') LIMIT ${maxSummaryItems + 1}),
  counts AS (SELECT count(*) AS total, count(*) FILTER (WHERE kind='tool-call') AS tools,
    count(*) FILTER (WHERE tool IN (${toolNames}) OR (tool='execute' AND has_command)) AS commands,
    count(*) FILTER (WHERE kind='diff') AS edits,
    count(*) FILTER (WHERE (${closedPreview}) AND (tool<>'execute' OR has_command)
      AND typeof(ended_ms)='integer')>0 AS preview_ended FROM turn_items),
  calls AS (SELECT epoch, item_id, ${bindings.length ? 'CASE WHEN root=0 THEN producer_agent_id END' : 'NULL'} AS owner,
    ${rawName} AS raw_tool,
    json_extract(payload_json,'$.observedAt') AS at_ms,
    CASE WHEN ${normalizedName} IN (${editNames}) THEN NULL ELSE coalesce(${command},
      CASE WHEN json_type(payload_json,'$.body.input')='text'
        AND ${rawName} NOT IN ('execute','running execute')
        THEN json_extract(payload_json,'$.body.input') END) END AS cmd
    FROM journal_items WHERE session_id='${id}' AND epoch=(SELECT epoch FROM epoch) AND hidden=0
    AND kind='tool-call' AND lifecycle_state='running' AND (${root} ${child})
    AND (SELECT user_version FROM pragma_user_version)=2
    AND ${nonMcp}),
  normalized AS (SELECT ${normalize('raw_tool')} AS tool,
    epoch, item_id, owner, at_ms, ltrim(replace(substr(cmd,1,512),char(9),' ')) AS line FROM calls WHERE cmd IS NULL OR typeof(cmd)='text'),
  live AS (SELECT epoch, item_id, owner, tool, at_ms,
    row_number() OVER (PARTITION BY owner IS NULL ORDER BY at_ms DESC, item_id) AS bucket, substr(line,1,instr(line||' ',' ')-1) AS executable FROM normalized
    WHERE tool IN (${toolNames}) OR (tool='execute' AND line IS NOT NULL) OR (owner IS NULL AND tool IN (${editNames}))
    ),
  programs(name) AS (VALUES ${[...programs].map((s) => "('" + s + "')").join(',')})
  SELECT 'call' AS row_type, NULL AS turn_state, NULL AS ended_at, NULL AS preview_ended, NULL AS total, NULL AS tools, NULL AS commands, NULL AS edits,
    epoch, item_id, owner, tool, at_ms, (SELECT name FROM programs WHERE executable=name OR (executable NOT GLOB '*[^a-zA-Z0-9_./+-]*' AND executable LIKE '%/'||name) LIMIT 1) AS program
    FROM live WHERE bucket<=30
  UNION ALL
  SELECT 'turn', turn.lifecycle_state, turn.ended_at, counts.preview_ended, counts.total, counts.tools, counts.commands, counts.edits, NULL,NULL,NULL,NULL,NULL,NULL
    FROM turn, counts WHERE ${rootWorking ? 1 : 0}=1 AND (SELECT user_version FROM pragma_user_version)=2
  ORDER BY at_ms DESC, item_id;`
  const out = await query(sql)
  if (!Array.isArray(out)) return result
  for (const value of out.slice(0, 61)) {
    const item = object(value)
    if (item?.row_type === 'turn') {
      result.turnSettled = item.turn_state !== 'running'
      result.turnEndedAt = at(item.ended_at)
      result.previewEnded = item.preview_ended === 1
      if (!result.turnSettled && rootWorking && count(item.total) && count(item.tools) && count(item.commands) && count(item.edits)
          && item.total === item.tools + item.edits && item.commands <= item.tools) {
        result.activity = { tools: item.tools, commands: item.commands, edits: item.edits }
      }
      continue
    }
    if (!item || typeof item.tool !== 'string') continue
    const isEdit = item.owner === null && editTools.has(item.tool)
    if (!isEdit && !shellTools.has(item.tool) && item.tool !== 'execute') continue
    const epoch = item.epoch, itemId = item.item_id
    if ((typeof epoch !== 'string' && typeof epoch !== 'number') || !String(epoch).length || String(epoch).length > 256 ||
        typeof itemId !== 'string' || !itemId.length || itemId.length > 4096) continue
    const owner = typeof item.owner === 'string' ? owners.get(item.owner) : undefined
    if (item.owner !== null && (!owner || !itemId.startsWith(owner.prefix) || !/^(0|[1-9][0-9]{0,15})$/.test(itemId.slice(owner.prefix.length)))) continue
    if (item.owner === null && !rootWorking) continue
    const since = at(item.at_ms)
    const name = isEdit ? '' : typeof item.program === 'string' && programs.has(item.program) ? item.program : item.tool === 'bash' ? 'bash' : ''
    const key = owner?.node ?? null
    const group = result.calls.get(key) ?? []
    group.push({ id: workId(id, isEdit ? 'journal-edit' : 'journal-shell', epoch, itemId), children: [], kind: isEdit ? 'edit' : 'shell', ...(name ? { name } : {}),
      state: 'running', ...(since ? { since } : {}) })
    result.calls.set(key, group)
  }
  return result
}
