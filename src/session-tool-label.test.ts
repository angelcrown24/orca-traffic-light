import { assert, test } from 'orca/testing'
import { sessionToolName } from './session-tool-label'
import { readSessionShells } from './session-shells'

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

test('places the verified open host tool directly under the owning agent across providers', async () => {
  const session = '01234567-abcd-4000-abcd-123456789abc'
  const op = { basis: 'open', observedAt: 1700000000000, toolName: 'Running view_file /private/path', input: 'PRIVATE' }
  const child = { id: 'child', name: 'reviewer', kind: 'agent', state: 'working', membership: 'live', operation: op }
  async function inspect(agentType: string, children: unknown[]) {
    const agent = { paneKey: 'structured-agent-session-' + session + ':pane', orcaSessionId: session,
      structuredHostOwned: true, agentType, state: 'done', subagentObservation: 'live', children }
    const snapshot = { result: { worktrees: [{ worktreeId: 'workspace', hostId: 'local', agents: [agent] }] } }
    return readSessionShells({ workspaceId: 'workspace', terminals: [] }, snapshot, 'chat:' + session, { journal: async () => [] })
  }
  for (const provider of ['claude', 'antigravity', 'codex']) {
    const report = await inspect(provider, [child, { ...child, id: 'second', operation: { ...op, basis: 'closed' } }])
    const branches = report.tree?.map(n => n.children.map(c => [c.kind, c.toolName, c.state]))
    assert.deepEqual(branches, [[['tool', 'view_file', 'running']], []])
    assert.equal(JSON.stringify(report).includes('/private/'), false)
    assert.equal(JSON.stringify(report).includes('PRIVATE'), false)
  }
  const wrapped = { ...op, toolName: 'execute', input: '{"ServerName":"docs","ToolName":"lookup","command":"PRIVATE"}' }
  const report = await inspect('antigravity', [{ ...child, operation: wrapped }])
  assert.deepEqual(report.tree?.[0].children.map(c => [c.kind, c.toolName]), [['tool', 'docs/lookup']])
})
