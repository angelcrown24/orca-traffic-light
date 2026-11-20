import { assert, mockHost, mount, test } from 'orca/testing'
import { openSkillComparison, ReviewAssistant, resetReviewAssistant } from './review-assistant'
import type { CatalogItem } from './toolbox-types'

const skill = (id: string, name: string, providers: string[] = ['Shared']): CatalogItem => ({
  id, name, providers, kind: 'skill', available: true, source: 'Shared', description: 'Review changes'
})
const items = [skill('one', 'review'), skill('two', 'validation', ['Claude']), skill('three', 'validation', ['Codex'])]
const panel = { setup: () => { resetReviewAssistant(); return resetReviewAssistant }, default: () => <ReviewAssistant items={items} selected={['one']} workspaceId="workspace" /> }

test('recommendation previews use an explicit task and an unsaved skill description', async () => {
  let calls = 0
  const host = mockHost({ requests: { 'toolbox.previewSkills': input => {
    assert.deepEqual(input, {workspaceId:'workspace',query:'validate permissions',edit:{id:'one',description:'Check permissions'}})
    calls++
    return { before:{method:'keywords',names:[]}, after:{method:'keywords',names:['review']} }
  } } })
  const view = await mount(panel, { host })
  try {
    await view.toggle({label:'Preview & review'})
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

test('only explicit local review and copy send exact skill IDs and language; closing clears results', async () => {
  const submitted: string[] = []
  const input = { workspaceId:'workspace',ids:['two','three'],language:'ko' }
  const host = mockHost({ requests: {
    'toolbox.reviewSkills': actual => { assert.deepEqual(actual,input); submitted.push('review'); return {status:'unavailable'} },
    'toolbox.copySkillReview': actual => { assert.deepEqual(actual,input); submitted.push('copy'); return {copied:false,prompt:'fixture handoff'} }
  } })
  const view = await mount(panel,{host,locale:'ko-KR'})
  try {
    await view.toggle({label:'추천 · 심층 검토'})
    await view.press({text:'스킬 심층 검토'})
    assert.ok(view.find({text:'로컬 모델로 검토'})?.disabled)
    await view.select({label:'검토할 스킬'},'two')
    await view.select({label:'함께 비교할 스킬'},'three')
    assert.deepEqual(submitted,[])
    await view.press({text:'로컬 모델로 검토'})
    assert.deepEqual(submitted,['review'])
    assert.ok(view.find({text:/로컬 생성 모델이 응답하지/}))
    await view.press({text:'에이전트용 요청 복사'})
    assert.ok(view.find({label:'직접 복사할 검토 요청'}))
    assert.deepEqual(submitted,['review','copy'])
    await view.toggle({label:'추천 · 심층 검토'})
    assert.equal(view.find({label:'직접 복사할 검토 요청'}),null)
    assert.deepEqual(view.errors,[])
  } finally { await view.unmount() }
})

test('selecting an existing finding preloads both exact sources and waits for an explicit review', async () => {
  const many = [...Array.from({ length: 25 }, (_, i) => skill('sample' + i, 'demo' + i)), ...items]
  let calls = 0
  const view = await mount({ setup: () => { openSkillComparison(['two','three']); return resetReviewAssistant },
    default: () => <ReviewAssistant workspaceId="workspace" items={many} selected={[]} /> }, { host: mockHost({ requests: {
    'toolbox.reviewSkills': input => {
      assert.deepEqual(input.ids, ['two','three'])
      calls++
      return { status: 'ready', text: 'Two distinct procedures.', model: 'test-local', truncated: true }
    }
  } }) })
  try {
    assert.equal(view.find({label:'Skill to review'})?.props.value, 'two')
    assert.equal(view.find({label:'Compare with'})?.props.value,'three')
    assert.equal(calls, 0)
    await view.press({text:'Run local review'})
    assert.ok(view.find({text:'Two distinct procedures.'}))
    assert.ok(view.find({text:'Model suggestion · test-local'}))
    assert.ok(view.find({text:'The input or response reached the review length limit.'}))
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})
