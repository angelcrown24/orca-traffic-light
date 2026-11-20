import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { CatalogItem, SkillChangeReceipt, SkillReviewFinding, SkillReviewReport } from './toolbox-types'

const sample = (id: string, name: string, provider = 'Shared'): CatalogItem => ({ id, name, kind: 'skill', description: name,
  providers: [provider], source: 'skills', available: true, sharing: { state: provider === 'Shared' ? 'shared' : 'provider', canSync: false } })
const keeper = sample('stable', 'report')
const copy = sample('copy', 'report', 'Claude Code')
const workspaceId = 'test-workspace'
const base = {
  'calls.get': () => ({ calls: [], workspace: true }), 'toolbox.catalog': () => ({ items: [copy, keeper], warnings: [] }),
  'toolbox.state': () => ({ workspaceId, selected: [], bundle: null, events: [] }),
  'toolbox.inspectSkills': (input: {ids: string[]}) => ({ skills: input.ids.map(id => id === copy.id ? copy : keeper), summary: 'Inspection', nextStep: 'Check the source', evidence: [] })
}
const finding = (extra: Partial<SkillReviewFinding>): SkillReviewFinding => ({key:'source',name:'report',ids:[copy.id],providers:copy.providers,kind:'missing',stamp:'a1',evidence:[], ...extra})
const report = (...findings: SkillReviewFinding[]): SkillReviewReport => ({findings,scanned:2,checked:2,skipped:0,partial:false,identicalGroups:0})
const duplicate = finding({ kind:'redundant', removalCandidate:{reason:'duplicate',id:copy.id,retainedId:keeper.id},comparisonIds:[copy.id,keeper.id] })

test('select a recommended path, review the draft, save the exact pinned revision, and refresh findings', async () => {
  const original = '# Report\r\nRead [notes](docs/report.md) or use docs/report.md.old.\r\n'
  const updated = '# Report\r\nRead [notes](references/report.md) or use docs/report.md.old.\r\n'
  let saved = false
  const writes: unknown[] = []
  const host = mockHost({ requests:{ ...base,
    'toolbox.skillReview': () => saved ? report() : report(finding({evidence:['docs/report.md'],lines:[2],referenceFixes:[{from:'docs/report.md',to:'references/report.md',line:2}]})),
    'toolbox.previewSkillChange': input => {
      assert.deepEqual(input,{workspaceId,id:copy.id,kind:'edit'})
      return {status:'ready', name:'report',revision:'pinned',path:'Claude/report/SKILL.md',paths:[],providers:copy.providers,body:original}
    },
    'toolbox.applySkillChange': input => {
      writes.push(input); saved = true
      return {id:'fixed',at:123,kind:'edit',name:'report'}
    }
  }})
  const v=await mount(panel,{host,locale:'ko-KR'})
  try {
    await v.select({label:'Traffic Light 보기'},'review')
    await v.press({type:'ListItem',label:'report'})
    await v.press({text:'지침 수정'})
    assert.ok(v.find({text:'변경 저장'})?.disabled)
    await v.press({text:'제안 경로 사용'})
    assert.equal(v.valueOf({label:'수정할 줄 · 2'}),'Read [notes](references/report.md) or use docs/report.md.old.')
    assert.equal(writes.length,0)
    await v.press({text:'변경 저장'})
    assert.deepEqual(writes,[{workspaceId,kind:'edit',id:copy.id,revision:'pinned',body:updated}])
    assert.ok(v.find({text:'점검한 패키지에서 문제를 찾지 못했습니다'}))
    assert.ok(v.find({text:'report · 수정됨'}));assert.deepEqual(v.errors,[])
  } finally {await v.unmount()}
})

test('duplicate removal keeps the shared copy, requires confirmation and can be restored after reopening Review', async () => {
  const saved: SkillChangeReceipt = {id:'archive',name:'report',at:321,kind:'remove'}
  let deleted = false
  const writes: unknown[] = [], restores: unknown[] = []
  const host=mockHost({requests:{ ...base,
    'toolbox.skillReview':()=>deleted ? report() : report(duplicate),
    'toolbox.catalog':()=>({items:deleted ? [keeper] : [copy,keeper], warnings:[]}),
    'toolbox.previewSkillChange':input=>{
      assert.deepEqual(input,{workspaceId,kind:'remove',id:copy.id,retainedId:keeper.id})
      return {status:'ready',name:'report',revision:'pair',path:'Claude/report',retainedPath:'Shared/report',paths:['Claude/report'],providers:copy.providers,selectedWorkspaces:2}
    },
    'toolbox.applySkillChange':input=>{writes.push(input);deleted=true;return saved},
    'toolbox.skillChangeHistory':()=>deleted ? [saved] : [],
    'toolbox.undoSkillChange':input=>{restores.push(input);deleted=false;return {restored:true}}
  }})
  const v=await mount(panel,{host})
  try {
    await v.select({label:'Traffic Light views'},'review')
    assert.ok(v.find({text:'1 removal candidate'}))
    await v.press({type:'ListItem',label:'report'})
    await v.press({text:'Remove duplicate…'})
    assert.equal(v.find({label:'Shared copy to keep'})?.props.code,'~/Shared/report')
    assert.ok(v.find({text:'2 workspaces selected this installation.'}))
    await v.press({text:'Cancel'})
    assert.equal(writes.length,0)
    await v.press({text:'Remove duplicate…'})
    await v.press({text:'Remove and link'})
    assert.deepEqual(writes,[{workspaceId,kind:'remove',id:copy.id,revision:'pair',retainedId:keeper.id}])
    assert.equal(v.find({text:'1 removal candidate'}),null)
    await v.select({label:'Traffic Light views'},'library')
    await v.select({label:'Traffic Light views'},'review')
    await v.toggle({label:'Recent changes'})
    await v.press({text:'Undo'})
    assert.deepEqual(restores,[{workspaceId,receiptId:'archive'}])
    assert.ok(v.find({text:'1 removal candidate'}))
    assert.ok(v.find({text:'report restored.'}));assert.deepEqual(v.errors,[])
  } finally {await v.unmount()}
})

test('protected installations explain the block and those without a selection never send a mutation',async()=>{
  let writes=0
  const item=sample('big','large')
  const host=mockHost({requests:{...base,
    'toolbox.catalog':()=>({items:[item],warnings:[]}),
    'toolbox.skillReview':()=>report(finding({name:item.name,ids:[item.id],kind:'provider'})),
    'toolbox.inspectSkills':()=>({summary:'Inspection',nextStep:'Check source',skills:[item],evidence:[]}),
    'toolbox.previewSkillChange':()=>({status:'blocked',reason:'managed-snapshot'}),
    'toolbox.applySkillChange':()=>{writes++;return {id:'bad',name:'large',at:0,kind:'remove'}}
  }})
  const v=await mount(panel,{host})
  try {
    await v.select({label:'Traffic Light views'},'review')
    await v.press({type:'ListItem',label:item.name})
    await v.press({text:'Delete skill…'})
    assert.ok(v.find({text:'The shared registry references this installation. Removing it here would break its published copy.'}))
    assert.equal(v.find({text:'Delete installation'}),null);assert.equal(writes,0);assert.deepEqual(v.errors,[])
  } finally {await v.unmount()}
})

test('removing unavailable selections preserves installed entries after deletion',async()=>{
  let selected=['gone',keeper.id]
  const updates:unknown[]=[]
  const host=mockHost({requests:{...base,
    'toolbox.catalog':()=>({items:[keeper],warnings:[]}),
    'toolbox.state':()=>({workspaceId,selected,bundle:null,events:[]}),
    'toolbox.select':input=>{updates.push(input);selected=input.ids;return {workspaceId,selected,bundle:null,events:[]}}
  }})
  const v=await mount(panel,{host})
  try {
    await v.select({label:'Traffic Light views'},'library')
    await v.press({text:'Remove unavailable selections'})
    assert.deepEqual(updates,[{workspaceId,ids:[keeper.id]}]);assert.equal(v.find({text:'Remove unavailable selections'}),null)
    assert.deepEqual(v.errors,[])
  } finally {await v.unmount()}
})

test('a stale edit result can be checked in history without replaying the failed write',async()=>{
  let writes=0, checks=0
  const host=mockHost({requests:{...base,'toolbox.skillReview':()=>report(finding({})),
    'toolbox.previewSkillChange':()=>({status:'ready',name:'report',path:'.claude/skills/report',paths:[],providers:copy.providers,revision:'old',body:'# Old\n'}),
    'toolbox.applySkillChange':()=>{writes++;throw new Error('stale revision')},
    'toolbox.skillChangeHistory':()=>{checks++;return []}
  }})
  const v=await mount(panel,{host})
  try {
    await v.select({label:'Traffic Light views'},'review')
    await v.press({type:'ListItem',label:'report'})
    await v.press({text:'Edit instructions'})
    assert.equal(v.find({label:'File to edit'})?.props.code,'~/.claude/skills/report/SKILL.md')
    await v.type({label:'SKILL.md'},'# Revised\n',{replace:true})
    await v.press({text:'Save changes'})
    assert.ok(v.find({text:'Save changes'})?.disabled)
    await v.press({text:'Check recent changes'})
    assert.equal(writes,1);assert.equal(checks,1)
    assert.ok(v.find({text:'No changes to undo in this workspace.'}));assert.deepEqual(v.errors,[])
  }finally {await v.unmount()}
})
