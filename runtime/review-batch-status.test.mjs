import assert from 'node:assert/strict'
import test from 'node:test'
import { createReviewBatchRequests } from './review-batch.mjs'

test('status observes a long confirmation without replaying, rescanning or extending its lifetime', async t => {
  const lifetime = 30 * 60 * 1000
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const id = 'skill:' + '1'.repeat(24), keeper = 'skill:' + '2'.repeat(24)
  const ref = { id, key: 'redundant:' + '3'.repeat(24), stamp: '4'.repeat(24) }
  const workspaceId = 'first'
  let focused = workspaceId, scans = 0, writes = 0
  let markStarted, finishWrite
  const started = new Promise(resolve => { markStarted = resolve })
  const writing = new Promise(resolve => { finishWrite = resolve })
  const api = createReviewBatchRequests({
    ensureLocal: async expected => { if (expected !== focused) throw Error('Workspace changed') },
    catalogFor: async () => {
      scans++
      return { items: [{ id, name: 'helper' }, { id: keeper, name: 'helper' }] }
    },
    inspect: async () => ({ findings: [{ ...ref, removalCandidate: { id, reason: 'duplicate', retainedId: keeper } }] }),
    selectionsFor: async () => new Map(),
    scopedPreview: async () => ({ result: { name: 'helper', status: 'ready', path: 'old', retainedPath: 'keep', revision: 'screen' }, sourceRevision: 'source' }),
    lock: async (_, run) => run(), changed: () => {},
    maintenance: { apply: async () => {
      writes++
      markStarted()
      await writing
      return { id: 'saved-receipt' }
    } }
  })
  const { planId } = await api.previewSkillBatch({ workspaceId, items: [ref] })
  const status = () => api.skillBatchStatus({ workspaceId, planId })
  assert.deepEqual(await status(), { status: 'ready' })
  assert.deepEqual(await api.skillBatchStatus({ workspaceId, planId: 'unknown' }), { status: 'missing' })
  assert.equal(scans, 1)
  assert.equal(writes, 0)
  const confirmation = api.applySkillBatch({ workspaceId, planId })
  await started
  now += lifetime
  try {
    assert.deepEqual(await status(), { status: 'running' })
    focused = 'second'
    await assert.rejects(status(), /Workspace changed/)
    assert.deepEqual(await api.skillBatchStatus({ workspaceId: focused, planId }), { status: 'missing' })
  } finally {
    focused = workspaceId
    finishWrite()
  }
  const result = await confirmation
  assert.equal(result.rows[0].status, 'applied')
  now += lifetime - 1
  assert.deepEqual(await status(), { status: 'done', result })
  now++
  assert.deepEqual(await status(), { status: 'missing' })
  const unopened = await api.previewSkillBatch({ workspaceId, items: [ref] })
  now += lifetime
  assert.deepEqual(await api.skillBatchStatus({ workspaceId, planId: unopened.planId }), { status: 'missing' })
  assert.equal(scans, 3)
  assert.equal(writes, 1)
})
