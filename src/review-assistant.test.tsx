import { atom, read, set } from 'orca'
import { assert, mockHost, mount, test } from 'orca/testing'
import { checkSkills, resetSkillReview, SkillReview } from './skill-review'
import { InspectionResult, inspectSelection } from './review-assistant'
import type { CatalogItem, SkillInspection, SkillReviewReport } from './toolbox-types'

const skill = (id: string, name: string, providers = ['Shared']): CatalogItem => ({
  id, name, providers, kind: 'skill', available: true, source: 'Shared', description: 'Review changes'
})
const items = [skill('one', 'review'), skill('two', 'validation', ['Claude']), skill('three', 'validation', ['Codex'])]
const workspace = atom('workspace')
const panel = { setup: () => { set(workspace, 'workspace'); resetSkillReview(); return resetSkillReview },
  default: () => <SkillReview items={items} selected={['one']} workspaceId={read(workspace)} canOpen={() => false}
    openSource={async () => {}} onCheck={() => checkSkills(read(workspace), true)} refreshing={false} loadFailed={false} /> }
const report: SkillReviewReport = { scanned: 3, checked: 3, skipped: 0, partial: false, identicalGroups: 0,
  findings: [{ kind: 'variants', key: 'different-variants', stamp: 'stamped', ids: ['two', 'three'],
    name: 'validation', providers: ['Claude', 'Codex'], evidence: ['LICENSE'] }] }
const inspection = (ids: string[], summary = 'The installed copies differ.'): SkillInspection => ({
  skills: ids.map(id => items.find(item => item.id === id)!).map(({id,name,providers}) => ({id,name,providers})),
  summary, nextStep: 'Check the license before sharing.', evidence: [{ label: 'File only in the Codex copy', detail: 'LICENSE', source: 'SKILL.md:18' }]
})

test('finding opens a local review immediately and extra AI actions keep the same source pair', async () => {
  const submitted: string[] = []
  const expected = {workspaceId:'workspace',ids:['two','three'],language:'ko'}
  const host = mockHost({ requests: {
    'toolbox.skillReview': () => report,
    'toolbox.inspectSkills': actual => { assert.deepEqual(actual, expected); submitted.push('files'); return inspection(actual.ids) },
    'toolbox.reviewSkills': actual => { assert.deepEqual(actual, expected); submitted.push('ai'); return {status:'unavailable'} },
    'toolbox.copySkillReview': actual => { assert.deepEqual(actual, expected); submitted.push('copy'); return {copied:false,prompt:'fixture handoff'} }
  } })
  const view = await mount(panel, { host, locale:'ko-KR' })
  try {
    await view.press({text:'로컬 스킬 점검'})
    await view.press({type:'ListItem',label:'validation'})
    assert.deepEqual(submitted,['files'])
    assert.ok(view.find({text:'The installed copies differ.'}))
    assert.ok(view.find({text:'Check the license before sharing.'}))
    assert.ok(view.find({text:'SKILL.md:18'}))
    assert.equal(view.find({text:'로컬 AI로 분석'}),null)
    await view.toggle({label:'AI 추가 분석'})
    await view.press({text:'로컬 AI로 분석'})
    assert.ok(view.find({text:/로컬 AI를 사용할 수 없습니다/}))
    assert.ok(view.find({text:'The installed copies differ.'}))
    await view.press({text:'에이전트용 요청 복사'})
    assert.ok(view.find({label:'직접 복사할 요청'}))
    assert.deepEqual(submitted,['files','ai','copy'])
    await view.press({text:'점검 목록으로'})
    assert.ok(view.find({type:'ListItem',label:'validation'}))
    assert.equal(view.find({text:'The installed copies differ.'}),null)
    assert.deepEqual(view.errors,[])
  } finally { await view.unmount() }
})

test('a group of three opens copies with verified different contents and safely handles older reports', async () => {
  const selections: string[][] = []
  const data: SkillReviewReport = { ...report, findings: [{ ...report.findings[0], ids: ['one','two','three'], comparisonIds: ['one','three'] }] }
  const view = await mount(panel, { host: mockHost({ requests: {
    'toolbox.skillReview': () => data,
    'toolbox.inspectSkills': input => { selections.push(input.ids); return inspection(input.ids) }
  } }) })
  try {
    await view.press({text:'Check local skills'})
    await view.press({type:'ListItem',label:'validation'})
    assert.deepEqual(selections,[['one','three']])
    await view.press({text:'Back to findings'})
    delete data.findings[0].comparisonIds
    await view.press({text:'Check again'})
    await view.press({type:'ListItem',label:'validation'})
    assert.deepEqual(selections,[['one','three'],['one']])
    assert.deepEqual(view.errors,[])
  } finally { await view.unmount() }
})

test('other issues on an uninspected provider copy remain reachable and can be deferred independently', async () => {
  const data: SkillReviewReport = { ...report, findings: [
    {...report.findings[0], kind:'missing', ids:['two'], providers:['Claude']},
    {...report.findings[0], key:'codex-requirement', kind:'provider', ids:['three'], providers:['Codex']}
  ] }
  const selections: string[][] = []
  const view = await mount(panel,{host:mockHost({requests:{
    'toolbox.skillReview':() => data,
    'toolbox.inspectSkills':input => { selections.push(input.ids); return inspection(input.ids) }
  }})})
  try {
    await view.press({text:'Check local skills'})
    await view.press({type:'ListItem',label:'validation'})
    await view.press({type:'ListItem',label:'Provider requirement'})
    assert.deepEqual(selections,[['two'],['three']])
    await view.press({text:'Set aside this version'})
    const remaining = view.find({type:'ListItem',label:'validation'})
    assert.equal(remaining?.props.description,'Missing package file')
    assert.ok(view.find({text:'Set aside · 1'}))
    assert.deepEqual(view.errors,[])
  } finally { await view.unmount() }
})

test('manual review filters provider copies and retries a failed request using the exact selection', async () => {
  const selections: string[][] = []
  const host = mockHost({ requests: { 'toolbox.inspectSkills': input => {
    selections.push(input.ids)
    if (selections.length === 1) throw new Error('Source changed')
    return inspection(input.ids)
  }, 'toolbox.reviewSkills': () => ({ status:'ready', method:'decision', model:'local-ranker', text:'Review the license at L19–30.', truncated:false })
  } })
  const view = await mount(panel,{host})
  try {
    await view.press({text:'Choose a skill'})
    await view.type({label:'Search skills'},'Codex')
    assert.equal(view.findAll({type:'ListItem'}).length,1)
    await view.press({type:'ListItem',label:'validation'})
    await view.press({text:'Retry review'})
    assert.deepEqual(selections,[['three'],['three']])
    await view.toggle({label:'Additional AI analysis'})
    await view.press({text:'Analyze with local AI'})
    assert.ok(view.find({text:'AI-selected passages · local-ranker'}))
    assert.ok(view.find({text:'Review the license at L19–30.'}))
    await view.press({text:'Compare another skill'})
    assert.ok(view.find({text:'Compare with · validation · Codex'}))
    await view.press({type:'ListItem',label:'validation'})
    assert.deepEqual(selections,[['three'],['three'],['three','two']])
    assert.ok(view.find({text:'Skill comparison'}))
    assert.equal(view.find({text:'Review the license at L19–30.'}),null)
    assert.deepEqual(view.errors,[])
  } finally { await view.unmount() }
})

test('a delayed inspection cannot replace a newer result after a workspace switch', async () => {
  let start!: () => void
  let release!: (result: SkillInspection) => void
  const started = new Promise<void>(resolve => { start = resolve })
  const pending = new Promise<SkillInspection>(resolve => { release = resolve })
  const view = await mount({setup:panel.setup, default:() => <InspectionResult items={items} workspaceId={read(workspace)} onCompare={() => {}} />},
    {host:mockHost({requests:{
      'toolbox.inspectSkills': input => {
        if (input.workspaceId === 'workspace') { start(); return pending }
        return inspection(input.ids,'Second workspace result.')
      }
    }})})
  try {
    const first = inspectSelection('workspace',['one'])
    await started
    resetSkillReview(); set(workspace,'other-workspace')
    await inspectSelection('other-workspace',['one'])
    release(inspection(['one'],'Stale result.'))
    await first
    await view.rerender()
    assert.ok(view.find({text:'Second workspace result.'}))
    assert.equal(view.find({text:'Stale result.'}),null)
    assert.deepEqual(view.errors,[])
  } finally { release(inspection(['one'])); await view.unmount() }
})

test('recommendation previews use an explicit task and an unsaved skill description', async () => {
  let calls = 0
  const host = mockHost({ requests: { 'toolbox.previewSkills': input => {
    assert.deepEqual(input, {workspaceId:'workspace',query:'validate permissions',edit:{id:'one',description:'Check permissions'}})
    calls++
    return { before:{method:'keywords',names:[]}, after:{method:'keywords',names:['review']} }
  } } })
  const view = await mount(panel, { host })
  try {
    await view.toggle({label:'Preview recommendations'})
    await view.type({label:'Example task'}, 'validate permissions')
    await view.select({label:'Try a different description'}, 'one')
    await view.type({label:'Draft description'},'Check permissions',{replace:true})
    assert.equal(calls,0)
    await view.press({text:'Find matches'})
    assert.equal(calls,1)
    assert.ok(view.find({text:'Draft · review · Keywords'}))
    await view.type({label:'Example task'}, 'else',{replace:true})
    assert.equal(view.find({text:'Draft · review · Keywords'}),null)
    assert.equal(items[0].description,'Review changes')
    assert.deepEqual(view.errors,[])
  } finally { await view.unmount() }
})
