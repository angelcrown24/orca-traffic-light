import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSkillReviewRequest, previewRecommendations, reviewSkills } from './review-assistant.mjs'

const skill = (id, description = id, extra = {}) => ({ kind: 'skill', name: id, description, providers: ['Codex'], available: true, id, ...extra })
const keywords = async (query, items) => ({ method: 'keywords', items: items.filter(item => item.description.includes(query)) })

test('preview compares descriptions only against eligible selected metadata and never mutates or records activity', async () => {
  const items = [skill('allowed'), skill('second','lint',{kind:'mcp'}), skill('out','lint'),
    skill('restricted','lint',{providerOnly:'native-tool'}), skill('stale','lint',{sharing:{state:'update'}})]
  const data = {items}, selected = ['allowed','second','restricted','stale']
  let checks = 0
  const result = await previewRecommendations(data, selected, {query:'lint',edit:{id:'allowed',description:'lint'}}, {
    checkContext() { checks++ }, rank(q, passed) {
      assert.deepEqual(passed.map(i=>i.id),['allowed','second'])
      assert.deepEqual(Object.keys(passed[0]).sort(),['description','id','kind','name']); return keywords(q,passed)
    }
  })
  assert.deepEqual(result, { before:{method:'keywords',names:['second']},after:{method:'keywords',names:['allowed','second']} })
  assert.equal(items[0].description,'allowed'); assert.equal(checks,4)
  for (const id of ['out','stale','second','restricted']) {
    await assert.rejects(previewRecommendations(data,selected,{query:'a',edit:{id,description:'a'}}))
  }
  await assert.rejects(previewRecommendations(data,selected,{query:'a'.repeat(257)}))
  let runs = 0
  await assert.rejects(previewRecommendations(data,selected,{query:'lint'}, {checkContext(){throw Error('changed')}, rank(){runs++}}))
  assert.equal(runs,0)
})

test('review reads only selected versioned sources on explicit local generation; clipboard contains references only', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(),'traffic-light-review-')))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const body='Local synthetic review sample. '.repeat(220)
  const path=join(root,'SKILL.md')
  await writeFile(path,body)
  const data={items:[skill('sample'),skill('other')],records:new Map([['sample',{kind:'skill',path,fingerprint:createHash('sha256').update(body).digest('hex')}],['other',{kind:'skill',path:join(root,'never-read'),fingerprint:'x'}]])}
  const input={ids:['sample'],language:'ko'}, calls=[]
  const json=async (url,payload)=>{
    const route=new URL(url); assert.equal(route.origin,'http://127.0.0.1:11434');calls.push(route.pathname)
    if(route.pathname==='/api/tags')return {models:[{name:'kev:9b',capabilities:['decision']},{name:'remote',remote_host:'remote'},{name:'llama:local'}]}
    if(route.pathname==='/api/show'){assert.deepEqual(payload,{model:'llama:local'});return {capabilities:['completion']}}
    assert.equal(route.pathname,'/api/chat')
    assert.equal(payload.model,'llama:local')
    const selected=JSON.parse(payload.messages[1].content)
    assert.deepEqual(selected,[{name:'sample',instructions:body.slice(0,6000)}])
    assert.ok(!JSON.stringify(payload).includes(root))
    return {done:true,message:{content:'검토 결과'}}
  }
  assert.deepEqual(await reviewSkills(data,input,{json}),{status:'ready',model:'llama:local',text:'검토 결과',truncated:true})
  assert.deepEqual(calls,['/api/tags','/api/show','/api/chat'])
  const request=buildSkillReviewRequest(data,input)
  assert.match(request,/SKILL\.md/);assert.ok(request.includes(path));assert.ok(!request.includes(body.slice(0,30)));assert.ok(!request.includes('never-read'))
  for(const ids of [[],['unknown'],['sample','sample'],['a','b','c']])assert.throws(()=>buildSkillReviewRequest(data,{ids,language:'en'}))
  await writeFile(path,'changed in the meantime')
  await assert.rejects(reviewSkills(data,input,{json}),/changed/)
  assert.equal(calls.filter(c=>c==='/api/chat').length,1)
})

test('cloud aliases and models with no supported local capability are skipped before reading files or submitting any instructions', async () => {
  const data={items:[skill('a')],records:new Map([['a',{kind:'skill',fingerprint:'x',path:'/missing/only-read-if-local'}]])}
  const counts=[]
  const response=await reviewSkills(data,{ids:['a'],language:'en'},{json:async (url,payload)=>{
    counts.push([url,payload])
    return url.endsWith('/api/tags') ? {models:[{name:'cloud:latest'},{name:'kev'},{name:'remote'},{name:'embed'}]}
      : payload.model==='remote' ? {capabilities:['completion'],remote_model:'remote'} : {capabilities:['embedding']}
  }})
  assert.deepEqual(response,{status:'unavailable'})
  assert.deepEqual(counts.map(([,payload])=>payload?.model),[undefined,'remote','embed'])
  await assert.rejects(reviewSkills(data,{ids:['a'],language:'en'},{json:async url=>url.endsWith('tags')?{models:[{name:'local'}]}:{capabilities:['completion']},checkContext(){throw Error('workspace changed')}}),/workspace changed/)
})

test('decision-only install reviews selected evidence locally, validates citations and discards stale results', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'decision-review-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const body = '# When to use\nChoose this skill for markdown.\n# Verification\nThe formatter exits with code zero.'
  const path = join(root, 'SKILL.md')
  await writeFile(path, body)
  const record = { kind: 'skill', path, fingerprint: createHash('sha256').update(body).digest('hex') }
  const data = { items: [skill('selected'), skill('private-other')], records: new Map([['selected', record]]) }
  const input = { ids: ['selected'], language: 'en' }
  let choice = 'p1', changed = false, runs = 0
  const json = async (url, payload) => {
    assert.equal(new URL(url).origin, 'http://127.0.0.1:11434')
    if (url.endsWith('/api/tags')) return { models: [
      { name: 'kev:cloud', capabilities: ['decision'] }, { name: 'kev:remote', capabilities: ['decision'], remote_host: 'elsewhere' },
      { name: 'kev:local', capabilities: ['decision'] }
    ] }
    assert.ok(url.endsWith('/v1/systemone'))
    assert.equal(payload.model, 'kev:local')
    assert.ok(!JSON.stringify(payload).includes(root))
    assert.ok(!JSON.stringify(payload).includes('private-other'))
    assert.equal(payload.state.skill1.p1, body)
    assert.deepEqual(Object.keys(payload.questions).sort(), ['skill1_scope', 'skill1_verify'])
    runs++
    return { answers: {
      skill1_scope: { type: 'choice', choice, probabilities: { p1: 0.9 } },
      skill1_verify: { type: 'choice', choice: 'none', probabilities: { none: 0.96 } }
    } }
  }
  const success = await reviewSkills(data, input, { json })
  assert.equal(success.method, 'decision')
  assert.match(success.text, /When to use it · SKILL.md L1–4/)
  assert.match(success.text, /How to verify success · No clear passage/)
  choice = '__proto__'
  assert.deepEqual(await reviewSkills(data, input, { json }), { status: 'unavailable' })
  await assert.rejects(reviewSkills(data, input, { json: async (...args) => {
    const result = await json(...args)
    if (result.answers) changed = true
    return result
  }, checkContext() { if (changed) throw Error('workspace changed') } }), /workspace changed/)
  assert.equal(runs, 3)
})
