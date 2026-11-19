import { execFile } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { validSessionId, workspaceRow } from './native-activity'
import { resolveOrcaCli } from './native-reader'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const paneId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)

async function runJson(command: string, args: string[], maxBuffer: number): Promise<unknown> {
  return new Promise((resolve, reject) => execFile(command, args,
    { encoding: 'utf8', timeout: 2500, maxBuffer }, (error, stdout) => {
      if (error) return reject(new Error('Focus lookup unavailable'))
      try { resolve(JSON.parse(stdout || '[]')) } catch { reject(new Error('Invalid focus response')) }
    }))
}

// The group can have both chat and terminal tabs. The CLI's terminal layout can
// select the first terminal even while an editor/chat is focused, so use the unified tab.
export function focusQuery(worktreeId: string): string | null {
  if (!worktreeId || worktreeId.length > 4096 || /[\x00-\x1f\x7f]/.test(worktreeId)) return null
  const w = "'" + worktreeId.replace(/'/g, "''") + "'"
  const value = (key: string, sub?: string) => `(SELECT payload FROM profile_state_document_parts WHERE domain='workspaceSession' AND part_key=json_array('${key}'${sub ? ', ' + sub : ''}))`
  const scalar = (key: string, sub?: string) => `json_extract(${value(key, sub)}, '$')`
  return `WITH active AS (
    SELECT json_extract(g.value,'$.activeTabId') AS tab, json_extract(g.value,'$.id') AS gid
    FROM json_each(${value('tabGroups',w)}) g
    WHERE json_extract(g.value,'$.id')=${scalar('activeGroupIdByWorktree',w)}
      AND json_extract(g.value,'$.worktreeId')=${w}
      AND ${scalar('activeWorktreeId')}=${w} AND ${scalar('activeWorkspaceExecutionHostId')}='local'
      AND EXISTS (SELECT 1 FROM profile_state_document_parts_meta m
        WHERE m.domain='workspaceSession' AND m.domain_version=1 AND m.legacy_revision IS
        (SELECT revision FROM profile_state_documents WHERE domain='workspaceSession'))
  ), surface AS (
    SELECT json_extract(t.value,'$.contentType') AS kind, json_extract(t.value,'$.id') AS tab,
      json_extract(t.value,'$.entityId') AS entity
    FROM active, json_each(${value('unifiedTabs',w)}) t
    WHERE json_extract(t.value,'$.id')=active.tab AND json_extract(t.value,'$.groupId')=active.gid
      AND json_extract(t.value,'$.worktreeId')=${w}
      AND coalesce(json_extract(t.value,'$.executionHostId'),'local')='local'
      AND json_extract(t.value,'$.contentType')=${scalar('activeTabTypeByWorktree',w)}
  ) SELECT kind, tab, entity, CASE WHEN kind='terminal' THEN json_extract(
    ${value('terminalLayoutsByTabId','surface.entity')}, '$.activeLeafId') END AS leaf
    FROM surface LIMIT 2;`
}

async function smallJson(file: string): Promise<Record<string, unknown> | null> {
  const info = await lstat(file)
  if (!info.isFile() || info.size > 64 * 1024 || await realpath(file) !== file) return null
  const data: unknown = JSON.parse(await readFile(file,'utf8'))
  return record(data) ? data : null
}

export function matchFocusedSurface(rows: unknown, worktreeId: string, terminals: readonly {id: string}[], inventory?: unknown): string | null {
  if (!Array.isArray(rows) || rows.length !== 1 || !record(rows[0])) return null
  const { kind, tab, entity, leaf } = rows[0]
  if (kind === 'agent-session' && typeof entity === 'string' && validSessionId(entity) && tab === 'structured-agent-session-' + entity) return 'chat:' + entity
  if (kind !== 'terminal' || tab !== entity || !paneId(entity) || !paneId(leaf)) return null
  if (!record(inventory) || inventory.ok !== true || !record(inventory.result) || inventory.result.truncated === true || !Array.isArray(inventory.result.terminals)) return null
  const matches = inventory.result.terminals.filter(row => record(row) && row.worktreeId === worktreeId && row.executionHostId === 'local' &&
    row.tabId === tab && row.leafId === leaf && row.connected === true && row.orphaned === false && terminals.some(t => t.id === row.handle))
  return matches.length === 1 ? 'terminal:' + matches[0].handle : null
}

export async function readSessionFocus(workspaceId: string, snapshot: unknown, terminals: readonly {id: string}[]): Promise<string | null> {
  const row = workspaceRow(snapshot, workspaceId)
  if (process.platform !== 'darwin' || !process.env.HOME || row?.hostId !== 'local' || row.isActive !== true || typeof row.worktreeId !== 'string') return null
  const sql = focusQuery(row.worktreeId)
  if (!sql) return null
  try {
    const base = process.env.HOME + '/Library/Application Support/orca'
    const profile = await smallJson(base + '/orca-profile-index.json')
    const id = profile?.activeProfileId
    if (profile?.schemaVersion !== 1 || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) ||
        !Array.isArray(profile.profiles) || profile.profiles.filter(value => record(value) && value.id === id).length !== 1) return null
    const directory = base + '/profiles/' + id
    if ((await smallJson(directory + '/active-view.json'))?.activeView !== 'terminal') return null
    const file = directory + '/profile-state.db'
    if (await realpath(file) !== file) return null
    const surface = await runJson('/usr/bin/sqlite3', ['-readonly','-json',file,sql], 16 * 1024)
    let inventory: unknown
    if (Array.isArray(surface) && surface.length === 1 && surface[0]?.kind === 'terminal' && terminals.length) {
      const cli = resolveOrcaCli(process.platform, process.env.ORCA_CLI_COMMAND)
      if (!cli) return null
      inventory = await runJson(cli, ['terminal','list','--environment','local','--worktree','id:' + row.worktreeId,'--json'], 2 * 1024 * 1024)
    }
    return matchFocusedSurface(surface, row.worktreeId, terminals, inventory)
  } catch { return null }
}
