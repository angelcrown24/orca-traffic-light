import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolboxManager } from './toolbox-manager.mjs'

const id = 'skill:000000000000000000000001'
const fixture = (options = {}) => {
  let focus = 'one', scans = 0
  const data = { items: [], records: new Map(), warnings: [], skillExclusions: [
    { id, name: 'example', reason: 'too-large', providers: ['Shared'], stamp: 'v1' }
  ] }
  const manager = createToolboxManager({
    getContext: async () => ({ workspaceId: focus }),
    getWorkspaces: async () => ({ workspaces: [
      { id: 'one', hostId: 'local' }, { id: 'two', hostId: null }, { id: 'remote', hostId: 'ssh:r' }
    ] }),
    loadSelection: async ws => ws === 'one' ? [id] : [],
    scan: async () => { scans++; return data }, post() {},
    ...options
  })
  return { manager, scans: () => scans, focus: target => { focus = target } }
}

test('on-demand skill review counts local workspace selections and keeps review-only records out of the Library', async t => {
  const f = fixture()
  t.after(() => f.manager.dispose())
  const lib = await f.manager.catalog()
  assert.deepEqual(lib, { items: [], warnings: [] })
  const report = await f.manager.skillReview({ workspaceId: 'one' })
  assert.equal(report.scanned, 1)
  assert.equal(report.skipped, 1)
  assert.equal(report.findings[0].workspaceCount, 1)
  f.focus('remote')
  await assert.rejects(f.manager.skillReview({ workspaceId: 'remote' }), /local Orca workspace/)
  assert.equal(f.scans(), 2)
})

test('a review cannot return results from a workspace that changed during an impact lookup', async t => {
  const f = fixture({ loadSelection: async () => { f.focus('two'); return [] } })
  t.after(() => f.manager.dispose())
  await assert.rejects(f.manager.skillReview({ workspaceId: 'one' }), /Workspace changed/)
})

test('selected inspection uses the local workspace and returns coverage without a generation model', async t => {
  const f = fixture()
  t.after(() => f.manager.dispose())
  const result = await f.manager.inspectSkills({ workspaceId: 'one', ids: [id], language: 'ko' })
  assert.deepEqual(result.skills, [{ id, name: 'example', providers: ['Shared'] }])
  assert.match(result.evidence[0].detail, /64 KiB/)
  f.focus('remote')
  await assert.rejects(f.manager.inspectSkills({ workspaceId: 'remote', ids: [id], language: 'ko' }), /local Orca workspace/)
  assert.equal(f.scans(), 1)
})

test('a truncated workspace list leaves the impact count unknown', async t => {
  const f = fixture({ getWorkspaces: async () => ({ truncated: true, workspaces: [{ id: 'one', hostId: 'local' }] }) })
  t.after(() => f.manager.dispose())
  const result = await f.manager.skillReview({ workspaceId: 'one' })
  assert.equal(Object.hasOwn(result.findings[0], 'workspaceCount'), false)
})
