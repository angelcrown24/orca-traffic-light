import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { ToolboxCatalog } from './toolbox-types'

test('library previews global sharing changes, allows cancellation, and sends the reviewed revision on confirmation', async () => {
  let changed = false
  const item = { id:'managed', kind:'skill' as const, name:'unit', description:'Test skill.', source:'Shared', available:true, providers:['Shared'], sharing:{state:'shared' as const,canSync:true,unshareKey:'unit'} }
  const catalog = (): ToolboxCatalog => ({items:changed?[]:[item],warnings:[]})
  const host = mockHost({requests:{
    'calls.get':()=>({calls:[],workspace:true}), 'toolbox.catalog':catalog,
    'toolbox.state':()=>({workspaceId:'workspace',selected:[],bundle:null,events:[]}),
    'toolbox.unshare':input=>{
      assert.equal(input.key,'unit'); assert.equal(input.workspaceId,'workspace')
      if (input.revision) { assert.equal(input.revision,'verified'); changed=true; return {status:'removed' as const,name:'unit'} }
      return {status:'ready' as const,revision:'verified',name:'unit',source:'.claude/skills/unit',sourceAvailable:true,
        links:['.codex/skills/unit'],snapshots:['.agents/traffic-light/shared-skills/unit/version'],preserved:[],legacy:false}
    }
  }})
  const v=await mount(panel,{host})
  try{
    await v.select({label:'Traffic Light views'},'library')
    await v.press({label:'Details: unit'})
    await v.press({text:'Stop sharing…'})
    assert.ok(v.find({label:'Links to remove'})); assert.equal(changed,false)
    await v.press({text:'Cancel'}); assert.equal(changed,false)
    await v.press({text:'Stop sharing…'}); await v.press({text:'Stop sharing'})
    assert.equal(changed,true); assert.equal(v.find({label:'unit'}),null); assert.deepEqual(v.errors,[])
  }finally{await v.unmount()}
})

test('Korean Library explains a missing original and offers no destructive confirmation', async () => {
  const item = { id:'managed',kind:'skill' as const,name:'unit',description:'',source:'Shared',providers:['Shared'],available:false,
    sharing:{state:'conflict' as const,canSync:false,unshareKey:'unit'} }
  const host=mockHost({requests:{
    'calls.get':()=>({calls:[],workspace:true}),'toolbox.catalog':()=>({items:[item],warnings:[]}),
    'toolbox.state':()=>({workspaceId:'w',selected:[],bundle:null,events:[]}),
    'toolbox.unshare':({revision})=>{assert.equal(revision,undefined);return {status:'blocked' as const,name:'unit',source:'.claude/skills/unit',
      sourceAvailable:false,links:[],snapshots:[],preserved:[],legacy:false,blockers:['.claude/skills/unit']}}
  }})
  const v=await mount(panel,{host,locale:'ko-KR'})
  try{
    await v.select({label:'Traffic Light 보기'},'library')
    await v.press({label:'상세 정보: unit'});await v.press({text:'공유 중지…'})
    assert.ok(v.find({label:'찾을 수 없는 원본'}));assert.ok(v.find({label:'확인할 경로'}))
    assert.equal(v.find({text:'공유 중지'}),null);assert.deepEqual(v.errors,[])
  }finally{await v.unmount()}
})
