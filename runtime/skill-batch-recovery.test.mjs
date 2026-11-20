import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanCatalog } from './catalog.mjs'
import { createSkillMaintenance } from './skill-maintenance.mjs'

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'tl-batch-recovery-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  const fs = createSkillMaintenance({ home })
  const data = () => scanCatalog({ home })
  const workspaceId = 'test-workspace', batchId = randomUUID()
  async function skill(name, provider = '.agents', text = 'Original instructions.') {
    const dir = join(home, provider, 'skills', name)
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'SKILL.md')
    await writeFile(file, text)
    const catalog = await data()
    const item = catalog.items.find(i => catalog.records.get(i.id)?.path === file)
    return { id: item.id, file, dir }
  }
  async function preview(id, kind, body, extra = {}, successorId) {
    const catalog = await data(), input = { id, workspaceId, kind, ...extra }
    const plan = await fs.preview(catalog, input, { batch: true, successorId })
    assert.equal(plan.status, 'ready', plan.reason)
    return { catalog, input: { ...input, revision: plan.revision, body } }
  }
  const apply = (plan, batchIndex, successorId) => fs.apply(plan.catalog, plan.input, undefined, { batchId, batchIndex, successorId })
  return { fs, home, batchId, workspaceId, skill, preview, apply, data }
}

test('bulk receipts survive restart, reject replay after undo, and restore in reverse execution order', async t => {
  const f = await fixture(t), skill = await f.skill('writer')
  const a = await f.preview(skill.id, 'edit', 'Revision one.')
  const first = await f.apply(a, 0)
  const b = await f.preview(skill.id, 'edit', 'Revision two.')
  const second = await f.apply(b, 1)
  assert.equal(second.batchId, f.batchId)
  assert.equal(second.batchIndex, 1)
  const restarted = createSkillMaintenance({ home: f.home })
  await assert.rejects(restarted.apply(b.catalog, { ...b.input, workspaceId: 'other' }, undefined,
    { batchId: f.batchId, batchIndex: 2 }), { code: 'INVALID' })
  assert.deepEqual(await restarted.apply(a.catalog, a.input, undefined, { batchId: f.batchId, batchIndex: 0 }), first)
  assert.equal(await readFile(skill.file, 'utf8'), 'Revision two.')
  assert.equal((await restarted.history(f.workspaceId)).length, 2)
  await assert.rejects(restarted.undoBatch({ workspaceId:'other', batchId:f.batchId }), { code:'INVALID' })
  assert.equal(await readFile(skill.file, 'utf8'), 'Revision two.')
  const restored = await restarted.undoBatch(f)
  assert.deepEqual(restored.rows.map(r => [r.receiptId, r.status]), [[second.id, 'restored'], [first.id, 'restored']])
  assert.equal(await readFile(skill.file, 'utf8'), 'Original instructions.')
  assert.deepEqual(await restarted.history(f.workspaceId), [])
  assert.deepEqual((await restarted.undoBatch(f)).rows.map(r => r.reason), ['already-restored', 'already-restored'])
  await assert.rejects(f.apply(a, 0), { code:'STALE' })
})

test('a damaged recovery record is isolated while other changes in its workspace stay recoverable', async t => {
  const f = await fixture(t), a = await f.skill('alpha'), b = await f.skill('beta')
  const first = await f.apply(await f.preview(a.id, 'edit', 'New A.'), 0)
  const second = await f.apply(await f.preview(b.id, 'edit', 'New B.'), 1)
  const record = join(f.home, '.agents', 'traffic-light', 'review-changes', second.id, 'record.json')
  const original = await readFile(record)
  await writeFile(record, 'damaged')
  await assert.rejects(f.fs.undoBatch({ workspaceId: 'other', batchId: f.batchId }), { code: 'INVALID' })
  const result = await f.fs.undoBatch(f)
  assert.deepEqual(result.rows.map(r => [r.receiptId, r.status, r.reason]), [
    [second.id, 'failed', 'unavailable'], [first.id, 'restored', undefined]
  ])
  assert.equal(await readFile(b.file, 'utf8'), 'New B.')
  assert.equal(await readFile(a.file, 'utf8'), 'Original instructions.')
  await writeFile(record, original)
  assert.deepEqual((await f.fs.undoBatch(f)).rows.map(r => r.status), ['restored', 'skipped'])
})

test('group undo preserves changed files, skips individual undos, retries only remaining recovery work', async t => {
  const f = await fixture(t), a = await f.skill('alpha'), b = await f.skill('beta'), c = await f.skill('gamma')
  const one = await f.apply(await f.preview(a.id, 'edit', 'Changed A.'), 0)
  const two = await f.apply(await f.preview(b.id, 'edit', 'Changed B.'), 1)
  const three = await f.apply(await f.preview(c.id, 'remove'), 2)
  await f.fs.undo({ workspaceId: f.workspaceId, receiptId: three.id })
  await writeFile(b.file, 'External change.')
  const result = await f.fs.undoBatch(f)
  assert.deepEqual(result.rows.map(r => [r.receiptId, r.status, r.reason]), [
    [three.id,'skipped','already-restored'], [two.id,'failed','conflict'], [one.id,'restored',undefined]
  ])
  assert.equal(await readFile(b.file, 'utf8'), 'External change.')
  assert.equal(await readFile(a.file, 'utf8'), 'Original instructions.')
  assert.deepEqual(await f.fs.history(f.workspaceId), [two])
  await writeFile(b.file, 'Changed B.')
  assert.deepEqual((await f.fs.undoBatch(f)).rows.map(r => r.status), ['skipped','restored','skipped'])
})

test('losing workspace focus stops group recovery and leaves remaining receipts available', async t => {
  const f = await fixture(t), a = await f.skill('task-a'), b = await f.skill('task-b')
  await f.apply(await f.preview(a.id, 'edit', 'New A.'), 0)
  await f.apply(await f.preview(b.id, 'edit', 'New B.'), 1)
  const result = await f.fs.undoBatch(f, async () => {
    if (await readFile(b.file, 'utf8') === 'Original instructions.') throw Error('Workspace changed')
  })
  assert.deepEqual(result.rows.map(r => [r.name,r.status,r.reason]), [
    ['task-b','restored',undefined], ['task-a','skipped','workspace-changed']
  ])
  assert.equal(await readFile(a.file, 'utf8'), 'New A.')
  assert.equal((await f.fs.history(f.workspaceId)).length, 1)
})

test('duplicate previews can share a keeper while pinning the keeper contents', async t => {
  const f = await fixture(t), shared = await f.skill('guide')
  const claude = await f.skill('guide','.claude'), codex = await f.skill('guide','.codex')
  const a = await f.preview(claude.id, 'remove', undefined, { retainedId: shared.id })
  const b = await f.preview(codex.id, 'remove', undefined, { retainedId: shared.id })
  await f.apply(a, 0)
  await f.apply(b, 1)
  assert.equal(await realpath(claude.dir), shared.dir)
  assert.equal(await realpath(codex.dir), shared.dir)
  assert.deepEqual((await f.fs.undoBatch(f)).rows.map(r => r.status), ['restored','restored'])
  const retry = await f.preview(codex.id, 'remove', undefined, { retainedId: shared.id })
  await writeFile(join(shared.dir, 'new-file.txt'), 'Changes identity.')
  await assert.rejects(f.apply(retry, 2), {code:'STALE'})
})

test('retirement must still have its reviewed, available successor with unchanged package data', async t => {
  const f = await fixture(t), old = await f.skill('guide'), successor = await f.skill('guide-v2')
  const p = await f.preview(old.id, 'remove', undefined, {}, successor.id)
  await writeFile(join(successor.dir,'extra.md'), 'Changed successor.')
  await assert.rejects(f.apply(p,0,successor.id), {code:'STALE'})
  const next = await f.preview(old.id, 'remove', undefined, {}, successor.id)
  await rm(successor.dir, {recursive:true})
  await assert.rejects(f.apply(next,0,successor.id), {code:'STALE'})
  assert.equal(await readFile(old.file,'utf8'), 'Original instructions.')
  assert.deepEqual(await f.fs.history(f.workspaceId), [])
})
