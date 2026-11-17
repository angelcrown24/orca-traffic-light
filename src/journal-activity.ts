import { execFile } from 'node:child_process'
import { classifyResources, type ResourceObservation } from './resource-classifier'

/** Internal Orca journal schema and privacy boundary: no raw inputs leave this module. */
export type JournalResult = { status: 'ready' | 'unavailable' | 'truncated'; resources: ResourceObservation[] }
type Query = (sql: string) => Promise<unknown>
const SESSION_ID = /^[a-z][a-z0-9-]{0,31}_[a-f0-9]{8}_[a-f0-9]{4}_[a-f0-9]{4}_[a-f0-9]{4}_[a-f0-9]{12}$/
const MAX_CALLS = 300

/** Do not accept a path, quote, or arbitrary SQL as an identifier. */
export function journalQuery(sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null
  // sessionId is strictly validated before interpolation. SQLite JSON extracts only the
  // tool name and a bounded input; messages and tool outputs never reach the worker.
  return `WITH current AS (
    SELECT epoch FROM journal_chat_state WHERE session_id='${sessionId}'
  ), calls AS (
    SELECT payload_json, sequence, sequence_index FROM journal_items
    WHERE session_id='${sessionId}' AND epoch=(SELECT epoch FROM current)
      AND kind='tool-call' AND hidden=0 AND (SELECT user_version FROM pragma_user_version)=2
    ORDER BY sequence DESC, sequence_index DESC LIMIT ${MAX_CALLS + 1}
  )
  SELECT 'meta' AS kind, (SELECT user_version FROM pragma_user_version) AS version,
    (SELECT count(*) FROM current) AS format, NULL AS name, NULL AS input
  UNION ALL
  SELECT 'call', NULL, NULL, substr(json_extract(payload_json,'$.body.name'),1,256),
    substr(json_extract(payload_json,'$.body.input'),1,8192) FROM calls;`
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
export async function readJournalActivity(sessionId: string, query: Query = queryLocalJournal): Promise<JournalResult> {
  const sql = journalQuery(sessionId)
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
    for (const item of calls.slice(0, MAX_CALLS)) {
      for (const resource of classifyResources(item.name, item.input)) {
        const key = `${resource.category}:${resource.name}`
        if (!seen.has(key)) { seen.add(key); resources.push(resource) }
      }
    }
    return { status: calls.length > MAX_CALLS ? 'truncated' : 'ready', resources }
  } catch { return { status: 'unavailable', resources: [] } }
}
