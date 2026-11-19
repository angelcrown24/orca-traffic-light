import { journalEpoch } from './journal-activity'
import type { ChildShellOwner, SessionWorkNode } from './host-work-tree'
import { sessionEditTools, sessionShellTools, sessionTitleTools, sessionToolName } from './session-tool-label'
import { workId } from './work-id'

export type TurnActivity = { tools: number; commands: number; edits: number }
export type TurnTool = { name: string; count: number; state: 'completed' | 'failed' | 'cancelled' }
type JournalWork = {
  calls: Map<SessionWorkNode | null, SessionWorkNode[]>
  turnSettled?: boolean
  turnEndedAt?: number
  previewEnded?: boolean
  activity?: TurnActivity
  turnTools: TurnTool[]
  turnToolsLimited?: true
}
const maxSummaryItems = 1000
const maxRecent = 30
const maxLive = 30
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= maxSummaryItems
const object = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null
const at = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined

const literal = (v: string) => "'" + v.replace(/'/g, "''") + "'"
const joined = (items: Iterable<string>) => [...items].map(literal).join(',')
const shellNames = joined(sessionShellTools)
const decoratedNames = joined(sessionTitleTools)

/** Admit identifiers only; a free-form provider title or an input never leaves SQLite. */
function identifier(column: string, max: number, namespace = false): string {
  const alphabet = namespace ? 'A-Za-z0-9._/-' : 'A-Za-z0-9._-'
  return `CASE WHEN typeof(${column})='text' AND length(${column}) BETWEEN 1 AND ${max}
    AND instr(${column},char(0))=0 AND ${column} GLOB '[a-zA-Z0-9]*' AND ${column} NOT GLOB '*[^${alphabet}]*'
    ${namespace ? `AND (instr(${column},'/')=0 OR ${column} GLOB 'functions/*')` : ''} THEN ${column} END`
}

// Root calls belong to the selected chat's open turn. Codex child calls additionally
// require the exact thread + invocation turn, including when they outlive the parent.
export async function readSessionJournal(id: string, workspace: string, rootWorking: boolean,
    owners: ReadonlyMap<string, ChildShellOwner>, programs: ReadonlySet<string>, query: (sql: string) => Promise<unknown>,
    preview?: { tool: string; updatedAt: number }) {
  const result: JournalWork = { calls: new Map(), turnTools: [] }
  const epoch = journalEpoch(id, workspace)
  if (!epoch) return result
  const bindings = [...owners].slice(0, 50).map(([thread, { prefix }]) => '(' + literal(thread) + ',' + literal(prefix) + ')')
  const ownerList = bindings.length ? 'codex(thread, prefix) AS (VALUES ' + bindings.join(',') + '),' : ''
  const scope = `session_id='${id}' AND epoch=(SELECT epoch FROM epoch) AND hidden=0 AND (SELECT user_version FROM pragma_user_version)=2`
  const root = rootWorking ? "(root=1 AND turn_item_id=(SELECT item_id FROM turn) AND (SELECT lifecycle_state FROM turn)='running')" : '0'
  const child = bindings.length ? 'OR (root=0 AND EXISTS (SELECT 1 FROM codex WHERE thread=producer_agent_id AND substr(item_id,1,length(prefix))=prefix))' : ''
  const owner = bindings.length ? 'CASE WHEN root=0 THEN producer_agent_id END' : 'NULL'
  const closedPreview = preview && at(preview.updatedAt) && (sessionShellTools.has(preview.tool) || preview.tool === 'execute')
    ? `lower(tool)=${literal(preview.tool)} AND at_ms>=${preview.updatedAt}` : '0'
  // Each lane has a distinct bound. Even an oversized turn can return its 30 latest
  // settled calls, while completed calls can never displace an open call in the live lane.
  const fields = 'kind, epoch, item_id, lifecycle_state, sequence, sequence_index, ordinal, payload_json'
  const args = "json_extract(payload_json,'$.body.input')"
  const inputType = "json_type(payload_json,'$.body.input')"
  const inputValue = (key: string) => `coalesce(json_extract(payload_json,'$.body.input.${key}'), json_extract(wrapped,'$.${key}'))`
  const command = 'coalesce(' + ['command', 'cmd', 'CommandLine', 'command_line'].map(key => {
    const path = `'$.body.input.${key}'`, inner = `'$.${key}'`
    return `CASE WHEN json_type(payload_json,${path})='text' THEN json_extract(payload_json,${path})
      WHEN json_type(wrapped,${inner})='text' THEN json_extract(wrapped,${inner}) END`
  }).join(',') + ')'
  const sql = `WITH epoch AS (${epoch}),
  turn AS (SELECT item_id,lifecycle_state,json_extract(payload_json,'$.body.completedAt') AS ended_at FROM journal_items
    WHERE ${scope} AND root=1 AND kind='turn' AND turn_marker=1 ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT 1),
  ${ownerList}
  turn_items AS (SELECT ${fields} FROM journal_items WHERE ${scope} AND ${root} AND kind IN ('tool-call','diff') LIMIT ${maxSummaryItems + 1}),
  recent AS (SELECT ${fields} FROM journal_items WHERE ${scope} AND ${root} AND kind='tool-call'
    AND lifecycle_state IN ('completed','failed','cancelled','interrupted') ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT ${maxRecent + 1}),
  open_calls AS (SELECT ${fields}, ${owner} AS owner,
    row_number() OVER (PARTITION BY root ORDER BY sequence DESC,sequence_index DESC,ordinal DESC) AS bucket
    FROM journal_items WHERE ${scope} AND kind='tool-call' AND lifecycle_state='running' AND (${root} ${child})),
  samples AS (SELECT 'stats' AS lane, NULL AS owner, ${fields} FROM turn_items
    UNION ALL SELECT 'recent',NULL,${fields} FROM recent
    UNION ALL SELECT 'call',owner,${fields} FROM open_calls WHERE bucket<=${maxLive}),
  names AS (SELECT *, json_extract(payload_json,'$.body.name') AS title,
    CASE WHEN kind='tool-call' AND ${inputType}='text' AND length(${args})<=16384
      AND substr(ltrim(${args}),1,1)='{' AND json_valid(${args}) THEN ${args} END AS wrapped
    FROM samples),
  stripped AS (SELECT *, CASE WHEN lower(title) LIKE 'running %' THEN substr(title,9) ELSE title END AS bare FROM names),
  parts AS (SELECT *, substr(bare,1,instr(bare||' ',' ')-1) AS first_word FROM stripped),
  metadata AS (SELECT lane,owner,epoch,item_id,CASE WHEN lifecycle_state='interrupted'
      OR (lifecycle_state='failed' AND json_extract(payload_json,'$.body.endedAs')='interrupted') THEN 'cancelled' ELSE lifecycle_state END AS lifecycle_state,
    kind,sequence,sequence_index,ordinal,
    CASE WHEN bare!=first_word AND lower(title) LIKE 'running %' AND lower(first_word) IN (${decoratedNames})
      THEN first_word ELSE ${identifier('bare', 260, true)} END AS tool,
    json_extract(payload_json,'$.observedAt') AS at_ms,
    CASE WHEN json_extract(payload_json,'$.body.mcpIdentity') IS NOT NULL
      OR (${inputValue('ServerName')} IS NOT NULL AND ${inputValue('ToolName')} IS NOT NULL) OR (lower(bare)='execute' AND
      (${inputValue('ServerName')} IS NOT NULL OR ${inputValue('ToolName')} IS NOT NULL)) THEN 1
      WHEN bare GLOB 'mcp__*' THEN 2 ELSE 0 END AS is_mcp,
    CASE WHEN json_extract(payload_json,'$.body.mcpIdentity') IS NOT NULL THEN json_extract(payload_json,'$.body.mcpIdentity.server')
      WHEN lower(bare)='execute' THEN ${inputValue('ServerName')} END AS server,
    CASE WHEN json_extract(payload_json,'$.body.mcpIdentity') IS NOT NULL THEN json_extract(payload_json,'$.body.mcpIdentity.tool')
      WHEN lower(bare)='execute' THEN ${inputValue('ToolName')} END AS operation,
    CASE WHEN lower(first_word) IN (${shellNames},'execute') THEN coalesce(${command}, CASE WHEN lower(first_word)!='execute' AND ${inputType}='text' AND wrapped IS NULL
      THEN ${args} END) END AS cmd
    FROM parts),
  classified AS (SELECT lane,owner,epoch,item_id,lifecycle_state,kind,sequence,sequence_index,ordinal,tool,at_ms,is_mcp,
    ${identifier('server',128)} AS server, ${identifier('operation',128)} AS operation,
    CASE WHEN NOT is_mcp AND (lower(tool) IN (${shellNames}) OR (lower(tool)='execute' AND cmd IS NOT NULL)) THEN 1 ELSE 0 END AS is_shell,
    CASE WHEN lane='call' AND NOT is_mcp THEN ltrim(replace(substr(cmd,1,512),char(9),' ')) END AS line
    FROM metadata),
  counts AS (SELECT count(*) AS total, count(*) FILTER (WHERE kind='tool-call') AS tools, coalesce(sum(is_shell),0) AS commands,
    count(*) FILTER (WHERE kind='diff') AS edits, count(*) FILTER (WHERE is_shell=1 AND lifecycle_state IN ('completed','failed','cancelled','interrupted')
    AND typeof(at_ms)='integer' AND (${closedPreview}))>0 AS preview_ended FROM classified WHERE lane='stats'),
  programs(name) AS (VALUES ${[...programs].map(n => '(' + literal(n) + ')').join(',')}),
  visible AS (SELECT *, substr(line,1,instr(line||' ',' ')-1) AS executable FROM classified WHERE lane!='stats')
  SELECT lane,owner,CASE WHEN lane='call' THEN epoch END AS epoch, CASE WHEN lane='call' THEN item_id END AS item_id,
    lifecycle_state,tool,at_ms,is_mcp,server,operation,is_shell,
    (SELECT name FROM programs WHERE executable=name OR (executable NOT GLOB '*[^a-zA-Z0-9_./+-]*' AND executable LIKE '%/'||name) LIMIT 1) AS program,
    sequence,sequence_index,ordinal,NULL AS total,NULL AS tools,NULL AS commands,NULL AS edits,NULL AS preview_ended
    FROM visible
  UNION ALL
  SELECT 'turn',NULL,NULL,NULL,turn.lifecycle_state,NULL,turn.ended_at,NULL,NULL,NULL,NULL,NULL,
    NULL,NULL,NULL,counts.total,counts.tools,counts.commands,counts.edits,counts.preview_ended
    FROM turn, counts WHERE ${rootWorking ? 1 : 0}=1
  ORDER BY lane,sequence DESC,sequence_index DESC,ordinal DESC;`
  const rows = await query(sql)
  if (!Array.isArray(rows)) return result
  const recent = new Map<string, TurnTool>()
  let recentCalls = 0
  for (const raw of rows.slice(0, 2 * maxLive + maxRecent + 2)) {
    const row = object(raw)
    if (!row) continue
    if (row.lane === 'turn') {
      result.turnSettled = row.lifecycle_state !== 'running'
      result.turnEndedAt = at(row.at_ms)
      result.previewEnded = row.preview_ended === 1
      if (!result.turnSettled && rootWorking && count(row.total) && count(row.tools) && count(row.commands) && count(row.edits)
          && row.total === row.tools + row.edits && row.commands <= row.tools) {
        result.activity = { tools: row.tools, commands: row.commands, edits: row.edits }
      }
      continue
    }
    const declaredMcp = row.is_mcp === 1
    const isMcp = declaredMcp || row.is_mcp === 2
    // A malformed MCP wrapper cannot become an ordinary execute/edit call.
    const identity = declaredMcp ? { server: row.server, tool: row.operation } : undefined
    const toolName = sessionToolName(row.tool, undefined, identity)
    if (row.lane === 'recent') {
      const state = row.lifecycle_state
      if (!rootWorking || (state !== 'completed' && state !== 'failed' && state !== 'cancelled')) continue
      if (++recentCalls > maxRecent) { result.turnToolsLimited = true; continue }
      if (!toolName) continue
      const seen = recent.get(toolName)
      if (seen) seen.count++
      else recent.set(toolName, { name: toolName, count: 1, state })
      continue
    }
    if (row.lane !== 'call' || row.lifecycle_state !== 'running') continue
    const epoch = row.epoch, itemId = row.item_id
    if ((typeof epoch !== 'string' && typeof epoch !== 'number') || !String(epoch).length || String(epoch).length > 256 ||
        typeof itemId !== 'string' || !itemId.length || itemId.length > 4096) continue
    const owner = typeof row.owner === 'string' ? owners.get(row.owner) : undefined
    if (row.owner !== null && (!owner || !itemId.startsWith(owner.prefix) || !/^(0|[1-9][0-9]{0,15})$/.test(itemId.slice(owner.prefix.length)))) continue
    if (row.owner === null && !rootWorking) continue
    const since = at(row.at_ms)
    const kind = !isMcp && row.is_shell === 1 ? 'shell' : !isMcp && toolName && sessionEditTools.has(toolName.toLowerCase()) ? 'edit' : 'tool'
    const program = kind === 'shell' && typeof row.program === 'string' && programs.has(row.program) ? row.program :
      kind === 'shell' && toolName?.toLowerCase() === 'bash' ? 'bash' : undefined
    const key = owner?.node ?? null
    const group = result.calls.get(key) ?? []
    group.push({ id: workId(id, 'journal-' + kind, epoch, itemId), kind, state: 'running',
      ...(toolName ? { toolName } : {}), ...(program ? { name: program } : {}), ...(since ? { since } : {}), children: [] })
    result.calls.set(key, group)
  }
  result.turnTools = [...recent.values()]
  return result
}
