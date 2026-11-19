import { assert, test } from 'orca/testing'
import { execFile } from 'node:child_process'
import { readSessionJournal } from './session-work-journal'

const session = '01234567-abcd-4000-abcd-123456789abc'
const sqlString = (s: string) => "'" + s.replace(/'/g, "''") + "'"
const schema = `PRAGMA user_version=2;
 CREATE TABLE journal_chat_state(session_id,epoch,workspace_id);
 CREATE TABLE journal_items(session_id,epoch,hidden,root,kind,turn_marker,sequence,sequence_index,ordinal,item_id,lifecycle_state,turn_item_id,payload_json);
 INSERT INTO journal_chat_state VALUES ('${session}',1,'test-workspace');
 INSERT INTO journal_items VALUES ('${session}',1,0,1,'turn',1,1,0,0,'current','running',NULL,'{}');`

function tool(index: number, name: string, state: string, input: unknown = {}, fields: Record<string, unknown> = {}) {
  const body = { name, input, ...fields }
  return `INSERT INTO journal_items VALUES ('${session}',1,0,1,'tool-call',0,${index},0,${index},'call-${index}',${sqlString(state)},'current',
     ${sqlString(JSON.stringify({ observedAt: 1000 + index, body }))});`
}

function read(records: string[]) {
  return readSessionJournal(session, 'test-workspace', true, new Map(), new Set(['git']), sql => new Promise((resolve, reject) =>
    execFile('/usr/bin/sqlite3', ['-json', ':memory:', schema + records.join('\n') + sql],
      { timeout: 3000, encoding: 'utf8', maxBuffer: 512 * 1024 }, (error, stdout) => {
        if (error) reject(error)
        else resolve(JSON.parse(stdout || '[]'))
      })))
}

test('current tool identities handle provider wrappers, incomplete metadata and separate simultaneous calls', async () => {
  if (process.platform !== 'darwin') return
  const records = [
    tool(1, 'view_file', 'completed'), tool(2, 'view_file', 'failed'),
    tool(3, 'Running edit_file /PRIVATE/file.txt', 'running'), tool(4, 'view_file', 'running'), tool(5, 'view_file', 'running'),
    tool(6, 'execute', 'running', JSON.stringify({ ServerName:'search', ToolName:'lookup', command:'git PRIVATE' })),
    tool(7, 'execute', 'completed', JSON.stringify({ cmd: 'git PRIVATE' })),
    tool(8, 'mcp__search__lookup', 'interrupted'),
    tool(9, 'open PRIVATE title?', 'running', {}, { mcpIdentity: {server:'docs', tool:'find'} }),
    tool(10, 'execute', 'failed', {ServerName:'PRIVATE/path',ToolName:'private query',command:'git PRIVATE'}),
    tool(11, 'Running PRIVATE /private/file', 'running'),
    tool(12, 'lookup', 'failed', {}, {endedAs:'interrupted'}),
    tool(13, 'mcp__search__lookup', 'completed'),
    tool(14, 'lookup', 'unverifiable'),
    tool(15, 'foreign', 'completed'),
    tool(16, 'old_turn', 'completed'),
    tool(17, 'child', 'completed'),
    tool(18, 'hidden', 'completed'),
    tool(19, 'mcp__ignored__fallback', 'completed', {}, { mcpIdentity: {server:'invalid title', tool:'lookup'} }),
    tool(20, 'view_file', 'completed', {ToolName:'an ordinary tool argument'}),
    "UPDATE journal_items SET session_id='foreign' WHERE item_id='call-15';",
    "UPDATE journal_items SET turn_item_id='previous' WHERE item_id='call-16';",
    "UPDATE journal_items SET root=0 WHERE item_id='call-17';",
    "UPDATE journal_items SET hidden=1 WHERE item_id='call-18';"
  ]
  const result = await read(records)
  const active = result.calls.get(null) ?? []
  assert.deepEqual(active.map(n=>[n.kind,n.toolName]), [
    ['tool',undefined], ['tool','docs/find'], ['tool','search/lookup'],
    ['tool','view_file'], ['tool','view_file'], ['edit','edit_file']
  ])
  assert.equal(new Set(active.map(n=>n.id)).size, active.length)
  assert.deepEqual(result.turnTools, [
    {name:'view_file',count:3,state:'completed'}, {name:'search/lookup',count:2,state:'completed'},
    {name:'lookup',count:1,state:'cancelled'}, {name:'execute',count:1,state:'completed'}
  ])
  assert.deepEqual(result.activity, {tools:16,commands:1,edits:0})
  assert.equal(JSON.stringify([active,result.turnTools]).includes('PRIVATE'), false)
})

test('recent groups remain available on an oversized turn and count only its last thirty settled calls', async () => {
  if (process.platform !== 'darwin') return
  const records = [
    tool(1, 'oldest', 'failed'), tool(2, 'unsampled', 'cancelled'),
    ...Array.from({length:30}, (_,i)=>tool(3+i, 'read_file', i===29 ? 'interrupted' : 'completed')),
    tool(33,'read_file','running'),
    `WITH RECURSIVE x(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM x WHERE i<1001)
     INSERT INTO journal_items SELECT '${session}',1,0,1,'diff',0,100+i,0,0,'diff'||i,NULL,'current','{}' FROM x;`
  ]
  const result = await read(records)
  assert.equal(result.activity, undefined)
  assert.equal(result.turnToolsLimited, true)
  assert.deepEqual(result.turnTools, [{name:'read_file',count:30,state:'cancelled'}])
  assert.equal(result.calls.get(null)?.[0].toolName,'read_file')
})
