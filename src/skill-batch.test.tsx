import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { CatalogItem, SkillBatchItem, SkillBatchPreviewRow, SkillChangeReceipt, SkillReviewFinding, SkillReviewReport } from './toolbox-types'

const workspaceId = 'test-workspace'
const items: CatalogItem[] = Array.from({ length: 8 }, (_, index) => ({ id: 'skill-' + index, kind: 'skill', name: 'Skill ' + index,
  description: '', providers: ['Claude Code'], source: 'skills', available: true }))
const fix = { from: 'notes.md', to: 'docs/notes.md', line: 4 }
const findings: SkillReviewFinding[] = items.map((item, i) => ({
  key: 'finding-' + i, stamp: 'stamp-' + i, name: item.name, providers: item.providers, ids: [item.id], evidence: [],
  ...(i === 7 ? { kind: 'successor' as const, removalCandidate: { id: item.id, reason: 'successor' as const, retainedId: items[0].id } } :
    i === 6 ? { kind: 'redundant' as const, removalCandidate: { id: item.id, reason: 'duplicate' as const, retainedId: 'unaffected-keeper' } } : { kind: 'missing' as const, referenceFixes: [fix] })
}))
const report = (findings: SkillReviewFinding[]): SkillReviewReport => ({ scanned: items.length, checked: items.length, skipped: 0, identicalGroups: 0, partial: false, findings })
const requests = {
  'calls.get': () => ({ calls: [], workspace: true }),
  'toolbox.state': () => ({ workspaceId, selected: [], bundle: null, events: [] }),
  'toolbox.catalog': () => ({ items, warnings: [] }),
  'toolbox.skillReview': () => report(findings),
}
function previewRow(ref: SkillBatchItem): SkillBatchPreviewRow {
  const f = findings.find(f => f.key === ref.key)!
  return { ...ref, name: f.name, action: f.removalCandidate?.reason ?? 'fix', status: 'ready', providers: f.providers,
    path: '.claude/skills/' + ref.id, ...(f.referenceFixes ? { fixes: f.referenceFixes } : {}), selectedWorkspaces: 0 }
}

test('bulk selection spans pages, excludes unselected installations, pins the preview, and reports mixed outcomes', async () => {
  const calls: SkillBatchItem[][] = []
  let writes = 0, undos = 0
  const host = mockHost({requests: { ...requests,
    'toolbox.previewSkillBatch': input => {
      assert.equal(input.workspaceId, workspaceId)
      calls.push(input.items)
      return { planId: 'preview', rows: input.items.map(ref => ({ ...previewRow(ref),
        ...(ref.id === 'skill-1' ? { status: 'blocked' as const, reason: 'stale' } : {}) })) }
    },
    'toolbox.applySkillBatch': input => {
      writes++
      assert.deepEqual(input, { workspaceId, planId: 'preview' })
      return { batchId: 'preview', rows: calls[0].map(ref => ({ ...previewRow(ref), status: ref.id === 'skill-1' ? 'skipped' as const :
        ref.id === 'skill-2' ? 'failed' as const : 'applied' as const, reason: 'stale' })) }
    },
    'toolbox.undoSkillBatch': input => {
      undos++
      assert.deepEqual(input, { workspaceId, batchId: 'preview' })
      return { batchId: 'preview', rows: [{ receiptId: 'receipt-7', name: 'Skill 7', status: 'restored' }] }
    }
  }})
  const v = await mount(panel, { host })
  try {
    await v.select({ label: 'Traffic Light views' }, 'review')
    await v.press({ text: 'Batch actions · 8' })
    assert.ok(v.find({ text: '7 of 8 selected' }))
    await v.press({ text: 'Select all' })
    await v.press({ text: 'Clear selection' })
    assert.ok(v.find({ text: 'Preview · 0' })?.disabled)
    await v.press({ text: 'Select all' })
    await v.toggle({ label: 'Skill 0' })
    await v.press({ text: 'Next' })
    assert.equal(v.valueOf({ label: 'Skill 7' }), true)
    await v.toggle({ label: 'Skill 6' })
    await v.press({ text: 'Preview · 6' })
    assert.deepEqual(calls[0], findings.filter((_, i) => i !== 0 && i !== 6).map(f => ({ key: f.key, stamp: f.stamp, id: f.ids[0] })))
    assert.ok(v.find({ text: 'Ready 5 · Skipped 1' }))
    await v.toggle({ label: 'Skill 2' })
    assert.equal(v.find({ label: 'File to edit' })?.props.code, '~/.claude/skills/skill-2/SKILL.md')
    assert.ok(String(v.find({ label: 'Path changes' })?.props.code).includes('notes.md → docs/notes.md'))
    await v.press({ text: 'Edit selection' })
    assert.equal(writes, 0)
    await v.press({ text: 'Preview · 6' })
    await v.press({ text: 'Apply 5 changes' })
    assert.equal(writes, 1, JSON.stringify({refusals:v.refusals, errors:v.errors, summary:v.summary()}))
    assert.ok(v.find({ text: 'Applied 4 · Skipped 1 · Failed 1' }))
    await v.press({ text: 'Undo batch' })
    assert.equal(undos, 1)
    assert.ok(v.find({ text: 'Restored 1 · Skipped 0 · Failed 0' }))
    assert.deepEqual(v.errors, [])
  } finally { await v.unmount() }
})

test('Korean preview skips blocked choices and never changes deferred or manual-only issues', async () => {
  const {referenceFixes, ...manual} = findings[2]
  const extra = { ...manual, key: 'manual' }
  const host = mockHost({ requests: { ...requests,
    'toolbox.skillReview': () => report([findings[0], findings[1], extra]),
    'toolbox.inspectSkills': () => ({skills:[items[0]], summary:'Read the finding', nextStep:'Review it', evidence:[]}),
    'toolbox.previewSkillBatch': ({ items }) => {
      assert.equal(items.length, 1); assert.equal(items[0].id, 'skill-1')
      return {planId:'blocked', rows:[{ ...previewRow(items[0]), status:'blocked', reason:'overlap' }]}
    }
  }})
  const v = await mount(panel, { host, locale: 'ko-KR' })
  try {
    await v.select({ label: 'Traffic Light 보기' }, 'review')
    await v.press({ type:'ListItem', label: 'Skill 0' })
    await v.press({ text: '이 버전 보류' })
    await v.press({ text: '일괄 처리 · 1' })
    await v.press({ text: '미리보기 · 1' })
    assert.ok(v.find({text: '같은 설치본에 변경이 겹칩니다. 하나만 선택하고 다시 미리 보세요.'}))
    assert.ok(v.find({text:'0개 적용'})?.disabled)
    await v.press({ text:'선택 변경' })
    await v.press({ text:'취소' })
    assert.ok(v.find({text:'보류함 · 1'}))
    assert.deepEqual(v.errors, [])
  } finally { await v.unmount() }
})

test('unknown response opens saved history with grouped undo scoped to the applied batch', async () => {
  let writes = 0, restores = 0
  const receipts: SkillChangeReceipt[] = items.slice(0, 2).map(item => ({id: item.id, name: item.name, at: 123, kind:'edit', batchId:'saved-batch'}))
  const host = mockHost({requests: { ...requests,
    'toolbox.previewSkillBatch': ({ items }) => ({planId:'saved-batch',rows:items.map(previewRow)}),
    'toolbox.applySkillBatch': () => { writes++; throw new Error('Lost worker response') },
    'toolbox.skillBatchStatus': () => ({ status:'missing' }),
    'toolbox.skillChangeHistory': () => restores ? [] : receipts,
    'toolbox.undoSkillBatch': input => {
      assert.deepEqual(input,{workspaceId, batchId:'saved-batch'}); restores++
      return {batchId:input.batchId, rows:receipts.map(r => ({receiptId:r.id, name:r.name, status:'restored'}))}
    }
  }})
  const v = await mount(panel, { host })
  try {
    await v.select({ label:'Traffic Light views' }, 'review')
    await v.press({ text:'Batch actions · 8' })
    await v.press({ text:'Preview · 7' })
    await v.press({ text:'Apply 7 changes' })
    await v.press({ text:'Check recent changes' })
    assert.ok(v.find({text:'Batch changes · 2'}))
    await v.select({label:'Traffic Light views'},'library')
    await v.select({label:'Traffic Light views'},'review')
    await v.toggle({label:'Recent changes'})
    await v.press({text:'Undo batch'})
    assert.ok(v.find({text:'Restored 2 · Skipped 0 · Failed 0'}), JSON.stringify({refusals:v.refusals, errors:v.errors, summary:v.summary()}))
    assert.equal(writes,1); assert.equal(restores,1)
    await v.press({text:'Back to findings'})
    assert.ok(v.find({text:'No changes to undo in this workspace.'}))
    assert.deepEqual(v.errors, [])
  } finally { await v.unmount() }
})

test('progress follows the confirmed plan and switching workspaces discards late batch replies', async () => {
  let active = workspaceId
  let start!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { start = resolve })
  const pending = new Promise<void>(resolve => { finish = resolve })
  const host = mockHost({ requests: { ...requests,
    'toolbox.state': () => ({ workspaceId: active, selected: [], bundle: null, events: [] }),
    'toolbox.previewSkillBatch': ({ items }) => ({ planId:'run', rows:items.map(previewRow) }),
    'toolbox.applySkillBatch': async () => { start(); await pending; return { batchId:'run', rows:[] } }
  }})
  const v = await mount(panel, { host })
  try {
    await v.select({label:'Traffic Light views'},'review')
    await v.press({text:'Batch actions · 8'})
    await v.press({text:'Preview · 7'})
    const applying = v.press({text:'Apply 7 changes'})
    await started
    const unrelated = v.post('toolbox.skillBatchProgress', { workspaceId, batchId:'other', completed:3, total:3 })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(v.find({text:'3 / 3'}), null)
    const progress = v.post('toolbox.skillBatchProgress', { workspaceId, batchId:'run', completed:2, total:7 })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.ok(v.find({text:'2 / 7'}))
    active = 'other-workspace'
    const switched = v.emit('workspace.changed', { context:{ workspaceId:active, displayName:'Other', branch:'main', terminals:[] } })
    finish()
    await Promise.all([applying, switched, progress, unrelated])
    assert.ok(v.find({text:'Batch actions · 8'}))
    assert.equal(v.find({text:'Batch results'}), null)
    assert.deepEqual(v.refusals, []); assert.deepEqual(v.errors, [])
  } finally { finish(); await v.unmount() }
})

for (const korean of [false, true]) test('expired preview preserves choices for a fresh confirmation in ' + (korean ? 'Korean' : 'English'), async () => {
  let attempts = 0, previews = 0
  const host = mockHost({ requests: { ...requests,
    'toolbox.previewSkillBatch': ({ items }) => ({ planId:'plan-' + ++previews, rows:items.map(previewRow) }),
    'toolbox.applySkillBatch': input => {
      attempts++
      if (input.planId === 'plan-1') throw new Error('STALE: Preview the batch again.')
      return {batchId:input.planId, rows:[{...previewRow({key:findings[1].key, stamp:findings[1].stamp, id:items[1].id}), status:'applied'}]}
    }
  }})
  const label = (en: string, ko: string) => korean ? ko : en
  const v = await mount(panel, {host, locale:korean ? 'ko-KR' : 'en-US'})
  try {
    await v.select({label:label('Traffic Light views','Traffic Light 보기')}, 'review')
    await v.press({text:label('Batch actions · 8','일괄 처리 · 8')})
    await v.toggle({label:'Skill 0'})
    await v.press({text:label('Preview · 6','미리보기 · 6')})
    await v.press({text:label('Apply 6 changes','6개 적용')})
    assert.ok(v.find({text:label('Your preview expired. Preview this selection again to continue.', '미리보기가 만료되었습니다. 선택한 항목을 다시 미리 보세요.')}))
    assert.equal(v.valueOf({label:'Skill 0'}), false)
    assert.equal(v.find({text:label('Apply 6 changes','6개 적용')}), null)
    await v.press({text:label('Preview · 6','미리보기 · 6')})
    assert.equal(attempts,1)
    await v.press({text:label('Apply 6 changes','6개 적용')})
    assert.ok(v.find({text:label('Batch results','일괄 처리 결과')}))
    assert.equal(attempts,2); assert.equal(previews,2); assert.deepEqual(v.errors,[])
  } finally { await v.unmount() }
})

for (const korean of [false, true]) test('individual undo inside a batch and the remaining group undo in ' + (korean ? 'Korean' : 'English'), async () => {
  const all: SkillChangeReceipt[] = items.slice(0,2).map(i => ({id:'receipt-' + i.id, name:i.name, kind:'edit', at:124, batchId:'saved'}))
  let remaining = all
  const single: string[] = [], grouped: string[] = []
  const host = mockHost({ requests: { ...requests,
    'toolbox.skillChangeHistory': () => remaining,
    'toolbox.undoSkillChange': input => {
      single.push(input.receiptId); remaining = remaining.filter(r => r.id !== input.receiptId)
      return { restored:true }
    },
    'toolbox.undoSkillBatch': input => {
      grouped.push(input.batchId)
      const rows = all.map(item => remaining.includes(item) ? { receiptId:item.id, name:item.name, status:'restored' as const }
        : { receiptId:item.id, name:item.name, status:'skipped' as const, reason:'already-restored' })
      remaining = []
      return { batchId:input.batchId, rows }
    }
  }})
  const label = (en: string, ko: string) => korean ? ko : en
  const v = await mount(panel, { host, locale:korean ? 'ko-KR' : 'en-US' })
  try {
    await v.select({ label:label('Traffic Light views','Traffic Light 보기') }, 'review')
    await v.toggle({ label:label('Recent changes','최근 변경') })
    await v.toggle({ label:label('View changes','변경 내역 보기') })
    const buttons = v.findAll({type:'Button',text:label('Undo','되돌리기')})
    assert.equal(buttons.length,2)
    await v.press(buttons[1])
    assert.deepEqual(single,['receipt-skill-1'])
    assert.ok(v.find({text:label('Batch changes · 1','일괄 변경 · 1')}))
    await v.press({text:label('Undo batch','일괄 되돌리기')})
    assert.deepEqual(grouped,['saved'])
    assert.ok(v.find({text:label('This change was already restored.', '이미 복구한 변경입니다.')}))
    assert.ok(v.find({text:label('Restored 1 · Skipped 1 · Failed 0','복구됨 1 · 건너뜀 1 · 실패 0')}))
    assert.deepEqual(v.errors,[])
  } finally { await v.unmount() }
})

test('a duplicate and its matching keeper with the same broken link default to the two independent repairs', async () => {
  const copy = { ...findings[6], name:findings[0].name, removalCandidate:{id:items[1].id, retainedId:items[0].id, reason:'duplicate' as const} }
  const repaired = { ...findings[0], ids:[items[0].id,items[1].id] }
  const host = mockHost({ requests:{ ...requests, 'toolbox.skillReview':() => report([copy,repaired]),
    'toolbox.previewSkillBatch': ({items:refs}) => {
      assert.deepEqual(refs.map(r => r.id),[items[0].id,items[1].id])
      assert.ok(refs.every(r => r.key === repaired.key))
      return {planId:'repairs', rows:refs.map(previewRow)}
    }
  }})
  const v = await mount(panel, { host })
  try {
    await v.select({label:'Traffic Light views'},'review')
    await v.press({text:'Batch actions · 3'})
    assert.ok(v.find({text:'2 of 3 selected'}))
    await v.press({text:'Preview · 2'})
    assert.ok(v.find({text:'Apply 2 changes'}))
    await v.press({text:'Edit selection'})
    await v.press({text:'Select all'})
    assert.ok(v.find({text:'Preview · 3'}))
    assert.deepEqual(v.errors,[])
  } finally { await v.unmount() }
})

test('lost confirmation response observes the running batch until its actual outcome without a second apply', async () => {
  let writes = 0, reads = 0, finished!: () => void
  const observed = new Promise<void>(resolve => { finished = resolve })
  const host = mockHost({ requests: { ...requests,
    'toolbox.previewSkillBatch': ({ items }) => ({ planId:'running', rows:items.map(previewRow) }),
    'toolbox.applySkillBatch': () => { writes++; throw new Error('Timed out') },
    'toolbox.skillBatchStatus': input => {
      assert.deepEqual(input, {workspaceId,planId:'running'})
      if (++reads === 1) return {status:'running'}
      finished()
      return { status:'done', result:{batchId:input.planId, rows:[{key:findings[0].key,id:items[0].id,name:items[0].name,action:'fix',status:'applied'}]} }
    }
  }})
  const v = await mount(panel, { host })
  try {
    await v.select({label:'Traffic Light views'},'review')
    await v.press({text:'Batch actions · 8'})
    await v.press({text:'Preview · 7'})
    await v.press({text:'Apply 7 changes'})
    await observed; await v.settled()
    assert.ok(v.find({text:'Applied 1 · Skipped 0 · Failed 0'}))
    assert.equal(writes,1); assert.equal(reads,2)
    assert.deepEqual(v.errors,[])
  } finally { await v.unmount() }
})
