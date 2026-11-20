import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { CatalogItem, SkillReviewReport } from './toolbox-types'

const source: CatalogItem = { id: 'skill:same-name', kind: 'skill', name: 'release-check', description: '', providers: ['Shared', 'Codex'],
  source: 'Shared skills', available: true, sharing: { state: 'update', canSync: true } }
const report = (): SkillReviewReport => ({
  scanned: 12, checked: 12, skipped: 0, partial: false, identicalGroups: 1,
  findings: [{ key: 'update-a', stamp: 'snapshot-a', kind: 'update', name: source.name, ids: [source.id], evidence: ['scripts/check.sh'], providers: ['Codex'], workspaceCount: 2 }]
})
const base = {
  'calls.get': () => ({ calls: [], workspace: true }),
  'toolbox.catalog': () => ({ items: [source], warnings: [] }),
  'toolbox.state': () => ({ workspaceId: 'test-workspace', selected: [], bundle: null, events: [] })
}
test('skill review checks on demand, groups issues by skill and opens its original without syncing', async () => {
  let checks = 0
  const writes: unknown[] = []
  const data = report()
  data.findings[0].reviewedSourceStamp = 'verified-package-revision'
  data.findings.push({ key: 'missing', stamp: 'missing-a', kind: 'missing', name: source.name, ids: [source.id],
    providers: ['Shared', 'Codex'], evidence: ['scripts/absent.sh'], line: 18 })
  const host = mockHost({ requests: { ...base,
    'toolbox.skillReview': input => { assert.deepEqual(input, { workspaceId: 'test-workspace' }); checks++; return data },
    'toolbox.sync': input => { writes.push(input); return { results: [], catalog: { items: [], warnings: [] } } }
  } })
  const view = await mount(panel, { host })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    assert.equal(checks, 0)
    await view.press({ text: 'Skill review' })
    await view.post('toolbox.changed', {})
    assert.equal(checks, 1)
    assert.ok(view.find({ text: '1 skill to review' }))
    await view.toggle({ label: source.name })
    assert.ok(view.find({ text: 'Referenced at SKILL.md line 18' }))
    assert.ok(view.find({ text: 'scripts/absent.sh' }))
    assert.ok(view.find({ text: 'Selected in 2 workspaces' }))
    await view.press({ text: 'Review update' })
    assert.equal(view.valueOf({ label: 'Search capabilities' }), source.name)
    assert.ok(view.find({ text: 'Update shared copy' }))
    assert.deepEqual(writes, [])
    await view.press({ text: 'Update shared copy' })
    assert.deepEqual(writes, [{ workspaceId: 'test-workspace', ids: [source.id], preserveProviderCopies: true, reviewedSourceStamp: 'verified-package-revision' }])
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('Korean review can defer, restore and resurface findings when their source stamp changes', async () => {
  const data = report()
  const view = await mount(panel, { host: mockHost({ requests: { ...base, 'toolbox.skillReview': () => data } }), locale: 'ko-KR' })
  try {
    await view.select({ label: 'Traffic Light 보기' }, 'library')
    await view.press({ text: '스킬 점검' })
    await view.toggle({ label: source.name })
    await view.press({ text: '이 버전 보류' })
    assert.ok(view.find({ text: '남은 확인 사항이 없습니다' }))
    await view.press({ text: '보류함 · 1' })
    await view.toggle({ label: source.name })
    await view.press({ text: '다시 표시' })
    assert.ok(view.find({ text: '확인할 스킬 1개' }))
    await view.press({ text: '이 버전 보류' })
    data.findings[0].stamp = 'new-snapshot'
    await view.press({ text: '다시 점검' })
    assert.ok(view.find({ text: '확인할 스킬 1개' }))
    assert.equal(view.find({ text: '보류함 · 1' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('excluded packages are visible in the review even when absent from the shared library', async () => {
  const data: SkillReviewReport = { ...report(), partial: true, scanned: 2, checked: 0, skipped: 2,
    findings: [{ key: 'excluded-size', stamp: 'oversized', kind: 'excluded', name: 'large-skill', providers: ['Codex'],
      ids: [], evidence: ['too-large'] }] }
  const view = await mount(panel, { host: mockHost({ requests: { ...base, 'toolbox.skillReview': () => data } }) })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    await view.press({ text: 'Skill review' })
    assert.ok(view.find({ text: '2 packages skipped' }))
    await view.toggle({ label: 'large-skill' })
    assert.ok(view.find({ text: 'SKILL.md exceeds the 64 KiB discovery limit.' }))
    assert.equal(view.find({ text: 'Compare sources' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})


test('documented successors open an explicit two-skill review with the exact catalog identities', async () => {
  const newer = { ...source, name: 'release-check-v2', id: 'skill:newer' }
  const data: SkillReviewReport = { ...report(), findings: [{ key: 'successor', stamp: 'both-packages',
    kind: 'successor', name: source.name, ids: [source.id, newer.id], providers: ['Codex'], successorId: newer.id,
    evidence: [newer.name], line: 7 }] }
  const view = await mount(panel, { host: mockHost({ requests: { ...base, 'toolbox.skillReview': () => data,
    'toolbox.catalog': () => ({ items: [source, newer], warnings: [] }) } }) })
  try {
    await view.select({ label: 'Traffic Light views' }, 'library')
    await view.press({ text: 'Skill review' })
    await view.toggle({ label: source.name })
    assert.ok(view.find({ text: 'Recommended in SKILL.md line 7' }))
    await view.press({ text: 'Compare these skills' })
    assert.ok(view.find({ text: 'Run local review' }))
    const selects = view.findAll({ type: 'Select' }).map(s => view.valueOf(s))
    assert.ok(selects.includes(source.id))
    assert.ok(selects.includes(newer.id))
    assert.equal(view.find({ text: '1 skill to review' }), null)
    await view.press({ text: 'Back to findings' })
    assert.ok(view.find({ text: '1 skill to review' }))
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})
