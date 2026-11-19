import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { queryLocalJournal } from './journal-activity'
import { workId } from './work-id'
import type { ProviderChildStatus } from './native-activity'

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const literal = (s: string) => "'" + s.replace(/'/g, "''") + "'"
const limit = 12
const activeLifetimeMs = 120_000
const historyMs = 24 * 60 * 60_000
const mib = 1024 * 1024
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
type Query = (sql: string) => Promise<unknown>

// Only local Orca workspace IDs which also bind an exact provider workspace URI.
function projectPath(workspaceId: string): string | null {
  if (workspaceId.length > 4096 || /[\x00-\x1f\x7f]/.test(workspaceId)) return null
  const [repo, path, scope, ...rest] = workspaceId.split('::')
  if (!uuid.test(repo) || !path?.startsWith('/') || rest.length || (scope !== undefined && (!scope.startsWith('workspace:') || !uuid.test(scope.slice(10))))) return null
  return path
}

async function fileStamp(path: string, maxBytes: number, optional: boolean) {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > maxBytes) throw Error('Unavailable index')
    return { size: info.size, signature: [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join('/') }
  } catch (error) {
    if (optional && record(error) && error.code === 'ENOENT') return { size: 0, signature: 'missing' }
    throw error
  }
}

async function summaryQuery(path: string, sql: string): Promise<unknown> {
  if (await realpath(path) !== path) throw Error('Unavailable index')
  const stamps = () => Promise.all([fileStamp(path, 64 * mib, false), fileStamp(path + '-wal', 64 * mib, true),
    fileStamp(path + '-shm', 8 * mib, true), fileStamp(path + '-journal', 64 * mib, true)])
  const before = await stamps()
  // A checkpointed WAL database may have no shared-memory sidecar for a read-only SQLite
  // connection. Read a stable checkpoint only when there is no pending journal to replay.
  const checkpoint = before[1].size === 0 && before[2].signature === 'missing' && before[3].signature === 'missing'
  if (!checkpoint && (before[1].signature === 'missing' || before[2].signature === 'missing' || before[3].signature !== 'missing')) throw Error('Index is changing')
  const db = checkpoint ? pathToFileURL(path).href + '?mode=ro&immutable=1' : path
  const rows = await new Promise<unknown>((resolve, reject) => {
    execFile('/usr/bin/sqlite3', ['-readonly', '-json', db, sql], { encoding: 'utf8', timeout: 1500, maxBuffer: 96 * 1024 }, (err, stdout) => {
      if (err) return reject(Error('Unavailable index'))
      try { resolve(JSON.parse(stdout || '[]')) } catch { reject(Error('Unreadable index')) }
    })
  })
  if (checkpoint) {
    const after = await stamps()
    if (before.some((file, index) => file.signature !== after[index].signature)) throw Error('Index changed')
  }
  return rows
}

type Inputs = { home: string; journal: Query; summaries: Query; now: () => number }

/** Exact parent-child edges from the opted-in local metadata index. No message, role name or tool payload is selected. */
export async function readAntigravityChildren(workspaceId: string, sessionIds: string[], inputs?: Inputs): Promise<Map<string, ProviderChildStatus[]>> {
  const result = new Map<string, ProviderChildStatus[]>()
  const home = inputs?.home ?? process.env.HOME
  if ((!inputs && process.platform !== 'darwin') || !home?.startsWith('/')) return result
  const workspace = workspaceId.startsWith('id:') ? workspaceId.slice(3) : workspaceId
  const project = projectPath(workspace)
  const ids = [...new Set(sessionIds.filter(id => uuid.test(id)))].slice(0, 4)
  if (!project || !ids.length) return result
  const account = home + '/.gemini'
  const uri = literal(pathToFileURL(project).href)
  try {
    const rows = await (inputs?.journal ?? queryLocalJournal)(`SELECT r.session_id AS session,
      json_extract(h.value,'$.handle.nativeId') AS native FROM agent_session_records r
      JOIN journal_chat_state j ON j.session_id=r.session_id, json_each(r.record_json,'$.providerHandleChain') h
      WHERE r.session_id IN (${ids.map(literal).join(',')}) AND j.workspace_id=${literal(workspace)}
        AND json_extract(r.record_json,'$.sessionId')=r.session_id AND json_extract(r.record_json,'$.location.workspaceId')=j.workspace_id
        AND json_extract(r.record_json,'$.location.executionHostId')='local' AND json_extract(r.record_json,'$.location.wslDistro') IS NULL
        AND json_extract(r.record_json,'$.provider')='antigravity' AND json_extract(r.record_json,'$.accountHome.variable')='GEMINI_HOME'
        AND json_extract(r.record_json,'$.accountHome.path')=${literal(account)} AND json_extract(h.value,'$.handle.agent')='antigravity'
        AND json_extract(h.value,'$.handle.transport')='acp' AND json_extract(h.value,'$.linkId')=json_extract(r.record_json,'$.lease.provenHandleLinkId')
      GROUP BY r.session_id HAVING count(*)=1 LIMIT 4;`)
    if (!Array.isArray(rows) || rows.length > ids.length) return result
    const owners = new Map<string, string>()
    for (const r of rows) {
      if (!record(r) || typeof r.session !== 'string' || !ids.includes(r.session) || typeof r.native !== 'string' || !uuid.test(r.native) || owners.has(r.native) || [...owners.values()].includes(r.session)) return result
      owners.set(r.native, r.session)
    }
    if (!owners.size) return result
    const now = (inputs?.now ?? Date.now)()
    const queries = [...owners.keys()].map(parent => `SELECT * FROM (SELECT c.conversation_id AS child, c.parent_conversation_id AS parent, c.status AS status,
        CAST(round((julianday(c.last_modified_time)-2440587.5)*86400000) AS INTEGER) AS at_ms
      FROM conversation_summaries c JOIN conversation_summaries p ON p.conversation_id=c.parent_conversation_id
      WHERE p.conversation_id=${literal(parent)} AND c.conversation_id!=p.conversation_id AND c.killed=0
        AND c.nesting_depth=p.nesting_depth+1 AND EXISTS (SELECT 1 FROM json_each(p.workspace_uris) WHERE value=${uri})
        AND EXISTS (SELECT 1 FROM json_each(c.workspace_uris) WHERE value=${uri}) AND at_ms>=${now - historyMs}
      ORDER BY (at_ms BETWEEN ${now - activeLifetimeMs} AND ${now + 30_000}
        AND c.status IN ('CASCADE_RUN_STATUS_RUNNING','CASCADE_RUN_STATUS_BUSY')) DESC, at_ms DESC, c.conversation_id LIMIT ${limit})`)
    const query = inputs?.summaries ?? (sql => summaryQuery(account + '/antigravity-cli/conversation_summaries.db', sql))
    const children = await query(queries.join(' UNION ALL ') + ';')
    if (!Array.isArray(children) || children.length > owners.size * limit) return result
    const seen = new Set<string>()
    for (const row of children) {
      if (!record(row) || typeof row.parent !== 'string' || typeof row.child !== 'string' || !uuid.test(row.child) || owners.has(row.child) || !owners.has(row.parent)) continue
      if (seen.has(row.child)) return new Map()
      seen.add(row.child)
      const at = row.at_ms, session = owners.get(row.parent)!
      if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0 || at < now - historyMs) continue
      const fresh = at >= now - activeLifetimeMs && at <= now + 30_000
      const state = at > now + 30_000 ? 'unverifiable' : row.status === 'CASCADE_RUN_STATUS_IDLE' ? 'idle'
        : fresh && (row.status === 'CASCADE_RUN_STATUS_RUNNING' || row.status === 'CASCADE_RUN_STATUS_BUSY') ? 'working' : 'unverifiable'
      const group = result.get(session) ?? []
      if (group.length < limit) group.push({ key: workId(session, 'antigravity', row.child), state, updatedAt: at })
      result.set(session, group)
    }
    return result
  } catch { return new Map() }
}
