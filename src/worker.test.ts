import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

test('filters by focused workspace terminals and pairs matching calls without retaining input or output', async () => {
  const context = { workspaceId: 'context-a', branch: '', displayName: '', terminals: [{ id: 't1' }] }
  const host = mockHost({ results: { 'workspace.readContext': context } })
  const worker = await mountWorker(main, { host })
  const call = { agent: 'claude', workspaceId: 'hook-id-not-context-id', terminalId: 't1', tool: 'Read', callId: '1', input: { secret: 'do not retain' } }
  await worker.hooks.fire('agent.tool.before', call)
  await worker.hooks.fire('agent.tool.before', { ...call, terminalId: 't2', tool: 'Private' })
  await worker.hooks.fire('agent.tool.after', { ...call, terminalId: 't2', output: { secret: 'private' } })
  let result = await worker.request('calls.get')
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].state, 'running')
  await worker.hooks.fire('agent.tool.after', { ...call, output: { secret: 'private' } })
  result = await worker.request('calls.get')
  assert.equal(result.calls[0].state, 'finished')
  assert.equal(JSON.stringify(result).includes('secret'), false)
  host.respond('workspace.readContext', { ...context, terminals: [{ id: 't2' }] })
  result = await worker.request('calls.get')
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].tool, 'Private')
  host.respond('workspace.readContext', { ...context, terminals: [] })
  assert.equal((await worker.request('calls.get')).calls.length, 0)
  await worker.deactivate()
})
