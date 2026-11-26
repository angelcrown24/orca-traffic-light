import { assert, test } from 'orca/testing'
import { sessionToolName } from './session-tool-label'

test('extracts literal tool identities without displaying provider title arguments or private fields', () => {
  assert.equal(sessionToolName('Running view_file /private/file.md'), 'view_file')
  assert.equal(sessionToolName('Running Edit'), 'Edit')
  assert.equal(sessionToolName('functions/exec_command'), 'functions/exec_command')
  assert.equal(sessionToolName('mcp__docs__search'), 'docs/search')
  assert.equal(sessionToolName('Running execute', '{"ServerName":"docs","ToolName":"lookup","extra":"PRIVATE"}'), 'docs/lookup')
  assert.equal(sessionToolName('execute', undefined, { server: 'docs', tool: 'lookup' }), 'docs/lookup')
  assert.equal(sessionToolName(null, undefined, { server: 'docs', tool: 'lookup' }), 'docs/lookup')
  for (const raw of ['Running private message here', 'Diff /private/file', 'dir/name', 'file/name/path',
    'ghp_' + 'x'.repeat(30), 'functions/sk-proj-' + 'x'.repeat(30)]) {
    assert.equal(sessionToolName(raw), undefined)
  }
  assert.equal(sessionToolName('execute', { ServerName: 'docs', ToolName: '/private/file' }), undefined)
  assert.equal(sessionToolName('mcp__docs__lookup', undefined, { server: 'bad title', tool: 'lookup' }), undefined)
})
