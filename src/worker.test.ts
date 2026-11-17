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
  assert.equal(result.calls.length, 2)
  assert.equal(result.calls.some((entry) => entry.tool === 'Private' && entry.state === 'running'), true)
  assert.equal(result.calls.some((entry) => entry.tool === 'Read' && entry.state === 'uncertain'), true)
  host.respond('workspace.readContext', { ...context, terminals: [] })
  assert.equal((await worker.request('calls.get')).calls.length, 0)
  await worker.deactivate()
})

test('observes tool events without call IDs and pairs only a unique matching pending call', async () => {
  const context = { branch: '', displayName: '', terminals: [{ id: 't1' }] }
  const worker = await mountWorker(main, { host: mockHost({ results: { 'workspace.readContext': context } }) })
  const base = { agent: 'codex', workspaceId: null, terminalId: 't1', tool: 'Read', input: null }
  await worker.hooks.fire('agent.tool.before', base)
  assert.equal((await worker.request('calls.get')).calls[0].state, 'running')
  await worker.hooks.fire('agent.tool.after', base)
  assert.equal((await worker.request('calls.get')).calls[0].state, 'finished')
  await worker.hooks.fire('agent.tool.before', { ...base, tool: 'Search' })
  await worker.hooks.fire('agent.tool.before', { ...base, tool: 'Search' })
  await worker.hooks.fire('agent.tool.after', { ...base, tool: 'Search' })
  const result = await worker.request('calls.get')
  assert.equal(result.calls.filter((call) => call.tool === 'Search' && call.state === 'uncertain').length, 2)
  await worker.deactivate()
})

test('keeps unpaired endings visible without mixing terminals or retaining payloads', async () => {
  const context = { branch: '', displayName: '', terminals: [{ id: 't1' }] }
  const worker = await mountWorker(main, { host: mockHost({ results: { 'workspace.readContext': context } }) })
  const base = { agent: 'gemini', workspaceId: null, terminalId: 't1', tool: 'Shell', input: { secret: 'hidden' } }
  await worker.hooks.fire('agent.tool.after', { ...base, output: { secret: 'hidden' } })
  await worker.hooks.fire('agent.tool.before', { ...base, terminalId: 'other' })
  await worker.hooks.fire('agent.tool.before', { ...base, terminalId: undefined })
  const result = await worker.request('calls.get')
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].state, 'uncertain')
  assert.equal(JSON.stringify(result).includes('secret'), false)
  await worker.deactivate()
})


test('classifies observed terminal resources without retaining inputs or mixing workspaces', async () => {
  const context = { branch: '', displayName: '', terminals: [{ id: 't1' }] }
  const host = mockHost({ results: { 'workspace.readContext': context } })
  const worker = await mountWorker(main, { host })
  const base = { agent: 'codex', workspaceId: null, terminalId: 't1', input: { cmd: 'cat /tmp/skills/ui-ux-pro-max/SKILL.md confidential' }, tool: 'shell' }
  await worker.hooks.fire('agent.tool.before', base)
  await worker.hooks.fire('agent.tool.before', { ...base, terminalId: 'other', tool: 'mcp__secret_server__run' })
  const result = await worker.request('calls.get')
  assert.deepEqual(result.resources, [{ category: 'skill', name: 'ui-ux-pro-max', evidence: 'inferred' }])
  assert.equal(JSON.stringify(result).includes('confidential'), false)
  host.respond('workspace.readContext', { ...context, terminals: [{ id: 'other' }] })
  assert.deepEqual((await worker.request('calls.get')).resources, [{ category: 'mcp', name: 'secret_server', evidence: 'observed' }])
  await worker.deactivate()
})
