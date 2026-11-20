import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolboxManager } from './toolbox-manager.mjs'
import { createSkillMaintenance } from './skill-maintenance.mjs'

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'orca-review-batch-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  const workspaceId = 'one'
  const state = { focus: workspaceId, notifications: 0, progress: [], selectionReads: 0 }
  const fs = createSkillMaintenance({ home })
  const manager = createToolboxManager({ home, getContext: async () => ({workspaceId: state.focus}),
    getWorkspaces: async () => ({workspaces: [{id: workspaceId}, {id:'two'}]}), post: () => {},
    postSkillsChanged: () => { state.notifications++ }, postBatchProgress: progress => {
      state.progress.push(progress)
      state.onProgress?.(progress.completed)
    }, loadSelection: async () => { state.selectionReads++; return [] },
    maintenance: { ...fs, apply: async (...args) => { await state.beforeWrite?.(...args); return fs.apply(...args) } } })
  t.after(() => manager.dispose())
  async function skill(name, text, directory = '.agents') {
    const dir = join(home, directory, 'skills', name), file = join(dir, 'SKILL.md')
    await mkdir(dir, {recursive: true})
    await writeFile(file, text)
    return { dir, file }
  }
  async function missing(name, directory = '.agents') {
    const body = '---\r\nname: ' + name + '\r\ndescription: Check docs.\r\n---\r\n' +
      'Read [Guide](./references/guide.md#home) or [again](references/guide.md). Keep references/guide.md in prose.\r\n' +
      'Run \x60python3 ./scripts/check.py\x60; keep scripts/check.py in prose.\r\n'
    const files = await skill(name, body, directory)
    await mkdir(join(files.dir, 'current'))
    await writeFile(join(files.dir, 'current/guide.md'), 'Guide')
    await writeFile(join(files.dir, 'current/check.py'), '# test fixture')
    return { ...files, body }
  }
  const review = () => manager.skillReview({ workspaceId })
  const preview = items => manager.previewSkillBatch({ workspaceId, items })
  const apply = planId => manager.applySkillBatch({ workspaceId, planId })
  return { home, workspaceId, state, manager, skill, missing, review, preview, apply }
}
const refs = findings => findings.flatMap(f => {
  const ids = f.kind === 'missing' && f.referenceFixes?.length ? f.ids : f.removalCandidate ? [f.removalCandidate.id] : []
  return ids.map(id => ({ key: f.key, stamp: f.stamp, id }))
})

test('one confirmation repairs only verified path spans and consolidates multiple copies onto one keeper', async t => {
  const f = await fixture(t), repair = await f.missing('docs')
  const keep = await f.skill('pack', 'Same instructions.')
  const a = await f.skill('pack', 'Same instructions.', '.claude'), b = await f.skill('pack', 'Same instructions.', '.codex')
  const items = refs((await f.review()).findings)
  assert.equal(items.length, 3)
  const reads = f.state.selectionReads
  const preview = await f.preview(items)
  assert.deepEqual(preview.rows.map(row => row.status), ['ready', 'ready', 'ready'])
  assert.equal(f.state.selectionReads - reads, 2, 'read impact once for each workspace')
  assert.deepEqual(JSON.parse(JSON.stringify(preview)), preview)
  assert.equal(JSON.stringify(preview).includes('in prose'), false)
  assert.deepEqual(preview.rows.find(r => r.action === 'fix').fixes.map(fix => fix.line), [5, 6])
  assert.equal(await readFile(repair.file, 'utf8'), repair.body)
  assert.notEqual(await realpath(a.dir), keep.dir)
  const applyReads = f.state.selectionReads
  const [result, concurrent] = await Promise.all([f.apply(preview.planId), f.apply(preview.planId)])
  assert.deepEqual(result, concurrent)
  assert.equal(result.batchId, preview.planId)
  assert.deepEqual(result.rows.map(row => row.status), ['applied', 'applied', 'applied'])
  assert.equal(f.state.selectionReads - applyReads, 2)
  assert.equal(f.state.notifications, 1)
  assert.equal(await realpath(a.dir), keep.dir)
  assert.equal(await realpath(b.dir), keep.dir)
  assert.equal(await readFile(repair.file,'utf8'), repair.body
    .replace('./references/guide.md#home', './current/guide.md#home')
    .replace('](references/guide.md)', '](current/guide.md)')
    .replace('python3 ./scripts/check.py', 'python3 ./current/check.py'))
  assert.deepEqual(f.state.progress.map(p => [p.batchId,p.completed,p.total]), [0,1,2,3].map(i => [result.batchId,i,3]))
  const restored = await f.manager.undoSkillBatch({ workspaceId: f.workspaceId, batchId: result.batchId })
  assert.deepEqual(restored.rows.map(r => r.status), ['restored','restored','restored'])
  assert.deepEqual(await f.apply(preview.planId), result)
  assert.equal(await readFile(repair.file, 'utf8'), repair.body)
  assert.equal(await realpath(a.dir), a.dir)
})

test('overlapping writes and writes to a retained copy are blocked before any modification', async t => {
  const f = await fixture(t), a = await f.missing('docs')
  await f.missing('docs','.codex')
  const items = refs((await f.review()).findings)
  assert.equal(items.length, 3)
  const preview = await f.preview(items)
  assert.deepEqual(preview.rows.map(r => r.reason), ['overlap','overlap','overlap'])
  const result = await f.apply(preview.planId)
  assert.ok(result.rows.every(r => r.status === 'skipped' && r.reason === 'overlap'))
  assert.equal(f.state.notifications, 0)
  assert.equal(await readFile(a.file, 'utf8'), a.body)
  const selected = items.filter(ref => ref.key.startsWith('missing:'))
  assert.ok((await f.preview(selected)).rows.every(r => r.status === 'ready'))
})

test('stale, mismatched and non-actionable report selections cannot write; independent rows proceed', async t => {
  const f = await fixture(t), one = await f.missing('one'), two = await f.missing('two')
  const previous = await f.skill('legacy', 'Use this version. But \x60legacy-v2\x60 is the preferred path for new installs.')
  await f.skill('legacy-v2', 'Next version.')
  const report = await f.review(), items = refs(report.findings)
  const successor = report.findings.find(row => row.kind === 'successor')
  assert.ok(successor && !successor.removalCandidate)
  const extra = { key: successor.key, stamp: successor.stamp, id: successor.ids[0] }
  items.push(extra, { ...items[0], id: 'skill:000000000000000000000000' })
  const preview = await f.preview(items)
  assert.deepEqual(JSON.parse(JSON.stringify(preview)), preview)
  assert.deepEqual(preview.rows.map(row => row.status), ['ready','ready','blocked','blocked'])
  await writeFile(one.file, one.body + 'User edit.')
  const { rows } = await f.apply(preview.planId)
  assert.equal(rows.find(r => r.name === 'one').reason, 'stale')
  assert.equal(rows.find(r => r.name === 'two' && r.status === 'applied').action, 'fix')
  assert.equal(rows[2].status, 'skipped')
  assert.equal(rows[3].status, 'skipped')
  assert.match(await readFile(one.file, 'utf8'), /User edit\.$/)
  assert.notEqual(await readFile(two.file, 'utf8'), two.body)
  assert.match(await readFile(previous.file,'utf8'), /preferred/)
})

test('a successor that disappears between confirm scan and guarded write leaves its predecessor installed', async t => {
  const f = await fixture(t)
  await f.missing('docs')
  const old = await f.skill('legacy', 'Replaced by \x60legacy-v2\x60.')
  const successor = await f.skill('legacy-v2', 'New version.')
  const findings = (await f.review()).findings
  const items = refs(findings).sort((a, b) => Number(a.key.startsWith('successor:')) - Number(b.key.startsWith('successor:')))
  const preview = await f.preview(items)
  assert.deepEqual(preview.rows.map(r => r.action), ['fix', 'successor'])
  assert.ok(preview.rows[1].retainedPath.endsWith('/legacy-v2'))
  assert.ok(preview.rows.every(row => row.status === 'ready'))
  f.state.beforeWrite = async (_data, _input, _check, options) => {
    if (options.batchIndex === 1) await rm(successor.dir, {recursive: true})
  }
  const result = await f.apply(preview.planId)
  assert.deepEqual(result.rows.map(r => [r.status,r.reason]), [['applied',undefined],['skipped','stale']])
  assert.equal(await readFile(old.file,'utf8'), 'Replaced by \x60legacy-v2\x60.')
})

test('focus loss stops other ready operations; retry only returns the already-recorded result', async t => {
  const f = await fixture(t)
  const skills = await Promise.all(['a','b','c'].map(name => f.missing(name)))
  const preview = await f.preview(refs((await f.review()).findings))
  f.state.onProgress = completed => { if (completed === 1) f.state.focus = 'two' }
  const result = await f.apply(preview.planId)
  assert.deepEqual(result.rows.map(r => [r.status,r.reason]), [
    ['applied',undefined], ['skipped','workspace-changed'], ['skipped','workspace-changed']])
  await assert.rejects(f.manager.applySkillBatch({ workspaceId: 'two', planId: preview.planId }), /STALE/)
  f.state.focus = f.workspaceId
  assert.deepEqual(await f.apply(preview.planId), result)
  for (const row of result.rows.filter(row => row.status === 'skipped')) {
    const f = skills.find(skill => skill.dir.endsWith('/' + row.name))
    assert.equal(await readFile(f.file,'utf8'), f.body)
  }
  assert.equal((await f.manager.skillChangeHistory({ workspaceId: f.workspaceId })).length, 1)
})

test('repairs every reviewed occurrence while keeping inline code, escaped syntax, fences and near matches literal', async t => {
  const f = await fixture(t)
  const lines = [
    '\uFEFFRead [one](./refs/a.md#here) and keep \x60[sample](refs/a.md)\x60 literal.',
    'Read [two](refs/a.md) and \x60\x60[code](refs/a.md) with \x60 inside\x60\x60.',
    'Read \\[escaped](refs/a.md), [escaped\\](refs/a.md), and [real](refs/a.md).',
    'Use \x60\x60cross-line',
    '[literal](refs/a.md)\x60\x60 before [live](refs/a.md).',
    'Keep refs/a.md and [different](refs/a.md-extra) alone.',
    'Read \x60references/guide.md\x60. Keep references/guide.md literal.',
    'See [\x60a label\x60](refs/a.md) and \\[escaped](refs/a.md).',
    '\x60\x60\x60md', 'See [within fence](refs/a.md).', '\x60\x60\x60', '',
    '## Examples', '[example](refs/a.md).', ''
  ]
  const text = lines.join('\r\n'), skill = await f.skill('links', text)
  await mkdir(join(skill.dir,'moved'))
  await writeFile(join(skill.dir,'moved/a.md'),'A')
  await writeFile(join(skill.dir,'moved/guide.md'),'Guide')
  const { findings } = await f.review()
  const preview = await f.preview(refs(findings))
  assert.deepEqual(preview.rows[0].fixes.map(fix => fix.line).sort((a,b) => a-b), [1,2,3,5,7,8])
  assert.equal((await f.apply(preview.planId)).rows[0].status,'applied')
  const expected = [...lines]
  for (const [index, target] of [[0,'./refs/a.md#here'],[1,'[two](refs/a.md)'],[2,'[real](refs/a.md)'],
    [4,'[live](refs/a.md)'],[7,'[\x60a label\x60](refs/a.md)']]) {
    expected[index] = expected[index].replace(target, target.replace('refs/a.md','moved/a.md'))
  }
  expected[6] = expected[6].replace('\x60references/guide.md\x60','\x60moved/guide.md\x60')
  assert.equal(await readFile(skill.file,'utf8'),expected.join('\r\n'))
  assert.equal((await f.review()).findings.some(finding => finding.referenceFixes?.length), false)
})
