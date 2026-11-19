import { execFile } from 'node:child_process'
import { assert, test } from 'orca/testing'
import { focusQuery, matchFocusedSurface, readSessionFocus } from './session-focus'

const project = "repo::/projects/same project's folder"
const first = project + '::workspace:first'
const second = project + '::workspace:second'
const session = '10000000-abcd-4123-9123-123456789abc'
const chatTab = 'structured-agent-session-' + session
const handle = 'term_10000000-abcd-4123-9123-123456789abc'
const terminalTab = 'term-tab'
const table = 'profile_state_document_parts'
const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'"
const put = (keys: string[], payload: unknown) => `INSERT INTO ${table} VALUES ('workspaceSession',${quote(JSON.stringify(keys))},${quote(JSON.stringify(payload))});`

function schema() {
  let rows = put(['activeWorktreeId'], first) + put(['activeWorkspaceExecutionHostId'], 'local')
  for (const workspace of [first, second]) {
    const groupId = 'group', worktreeId = workspace
    const terminal = { id: terminalTab, entityId: terminalTab, groupId, worktreeId, contentType: 'terminal' }
    const chat = { id: chatTab, entityId: session, groupId, worktreeId, executionHostId: 'local', contentType: 'agent-session' }
    const focused = workspace === first ? chat : terminal
    rows += put(['activeTabTypeByWorktree', workspace], focused.contentType) + put(['activeGroupIdByWorktree', workspace], groupId)
    rows += put(['tabGroups', workspace], [{ id: 'other', worktreeId, activeTabId: terminalTab }, { id: groupId, worktreeId, activeTabId: focused.id }])
    rows += put(['unifiedTabs', workspace], [terminal, chat])
  }
  rows += put(['terminalLayoutsByTabId', terminalTab], { activeLeafId: 'leaf-b' })
  return `CREATE TABLE ${table} (domain TEXT,part_key TEXT,payload TEXT,PRIMARY KEY(domain,part_key));
    CREATE TABLE profile_state_document_parts_meta (domain TEXT PRIMARY KEY, domain_version INTEGER, legacy_revision INTEGER);
    CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY, revision INTEGER);
    INSERT INTO profile_state_document_parts_meta VALUES ('workspaceSession',1,7);
    INSERT INTO profile_state_documents VALUES ('workspaceSession',7);
    ` + rows
}

async function query(workspace: string, update = '') {
  return new Promise<unknown>((resolve, reject) => {
    execFile('/usr/bin/sqlite3', ['-json', ':memory:', schema() + update + focusQuery(workspace)], { encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024 },
      (e, stdout) => { if (e) return reject(e); try { resolve(JSON.parse(stdout || '[]')) } catch (error) { reject(error) } })
  })
}

test('profile SQL follows the unified active tab and exact workspace instance, even for a shared folder and tab IDs', async () => {
  if (process.platform !== 'darwin') return
  assert.equal(focusQuery('control\ncharacter'), null)
  const rows = await query(first)
  assert.deepEqual(rows, [{ kind: 'agent-session', tab: chatTab, entity: session, leaf: null }])
  assert.equal(matchFocusedSurface(rows, first, []), 'chat:' + session)
  assert.deepEqual(await query(second), [])
  const switchWorkspace = `UPDATE ${table} SET payload=${quote(JSON.stringify(second))} WHERE part_key='["activeWorktreeId"]';`
  assert.deepEqual(await query(second, switchWorkspace), [{ kind: 'terminal', tab: terminalTab, entity: terminalTab, leaf: 'leaf-b' }])
  assert.deepEqual(await query(first, switchWorkspace), [])
})

test('profile SQL fails closed for a stale parts mirror, unsupported version and non-local focus', async () => {
  if (process.platform !== 'darwin') return
  for (const update of [
    'UPDATE profile_state_documents SET revision=8;', 'UPDATE profile_state_document_parts_meta SET domain_version=2;',
    'DELETE FROM profile_state_document_parts_meta;',
    `UPDATE ${table} SET payload='"remote"' WHERE part_key='["activeWorkspaceExecutionHostId"]';`,
    `UPDATE ${table} SET payload='"terminal"' WHERE part_key=${quote(JSON.stringify(['activeTabTypeByWorktree', first]))};`
  ]) assert.deepEqual(await query(first, update), [])
})

test('requires a single exact chat or a registered connected leaf on the same local workspace', () => {
  const context = [{ id: handle }]
  const selected = { kind: 'terminal', tab: terminalTab, entity: terminalTab, leaf: 'leaf-b' }
  const chat = { kind: 'agent-session', tab: chatTab, entity: session }
  const term = { worktreeId: first, executionHostId: 'local', tabId: terminalTab, leafId: 'leaf-b', connected: true, orphaned: false, handle }
  const inventory = (terminals: unknown[]) => ({ ok: true, result: { terminals } })
  assert.equal(matchFocusedSurface([selected], first, context, inventory([{ ...term, leafId: 'leaf-a' }, term])), 'terminal:' + handle)
  for (const changes of [{ worktreeId: second }, { executionHostId: 'remote' }, { leafId: 'leaf-a' }, { tabId: 'other' }, { connected: false }, { orphaned: true }, { handle: 'foreign' }]) {
    assert.equal(matchFocusedSurface([selected], first, context, inventory([{ ...term, ...changes }])), null)
  }
  assert.equal(matchFocusedSurface([selected], first, context, inventory([term, term])), null)
  assert.equal(matchFocusedSurface([selected], first, context, { ok: true, result: { truncated: true, terminals: [term] } }), null)
  assert.equal(matchFocusedSurface([chat, chat], first, context), null)
  assert.equal(matchFocusedSurface([{ ...chat, entity: 'invalid' }], first, context), null)
  assert.equal(matchFocusedSurface([{ ...chat, tab: 'unrelated' }], first, context), null)
  assert.equal(matchFocusedSurface([{ ...selected, tab: 'unrelated' }], first, context, inventory([term])), null)
  assert.equal(matchFocusedSurface([{ ...selected, kind: 'editor' }], first, context, inventory([term])), null)
})

test('never chooses a surface from a remote, inactive or unmatched workspace', async () => {
  for (const row of [{ worktreeId: first, hostId: 'remote', isActive: true }, { worktreeId: first, hostId: 'local', isActive: false },
    { worktreeId: second, hostId: 'local', isActive: true }]) {
    assert.equal(await readSessionFocus(first, { result: { worktrees: [row] } }, []), null)
  }
})
