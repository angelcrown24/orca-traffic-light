import assert from 'node:assert/strict'
import test from 'node:test'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scanCatalog } from './catalog.mjs'
import * as sharing from './shared-sync.mjs'

async function fixture(t, root = '.claude/skills') {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'traffic-unshare-')))
  t.after(() => rm(home, { recursive:true, force:true }))
  const source = join(home,root,'unit'), common = join(home,'.agents/skills/unit')
  const file = join(source,'SKILL.md'), registryFile = join(home,'.agents/traffic-light/shared-registry.json')
  await mkdir(source,{recursive:true}); await writeFile(file,'---\nname: unit\ndescription: Test skill\n---\nKeep me.\n')
  const catalog = () => scanCatalog({home})
  async function sync(id) {
    const {results} = await sharing.syncCapabilities({home,ids:[id],preserveProviderCopies:true})
    assert.match(results[0].status,/^(synced|unchanged)$/); return results[0].newId
  }
  const unshare = revision => sharing.unshareSkill({home,key:'unit',revision})
  const gone = p => assert.rejects(lstat(p), {code:'ENOENT'})
  return {home,source,common,file,registryFile,catalog,sync,unshare,gone}
}

test('stops sharing a published and updated skill while keeping the source and an independent provider copy', async t => {
  const f = await fixture(t), alternate = join(f.home,'.gemini/skills/unit/SKILL.md')
  await mkdir(dirname(alternate),{recursive:true}); await writeFile(alternate,'Keep other bytes.')
  let id = (await f.catalog()).items.find(x=>x.providers.includes('Claude Code')).id
  id = await f.sync(id); const old = await realpath(f.common)
  await writeFile(f.file,'Updated instructions.'); await f.sync(id); const current = await realpath(f.common)
  const item = (await f.catalog()).items.find(x=>x.sharing.state==='shared')
  assert.equal(item.sharing.unshareKey,'unit')
  const preview = await f.unshare(); assert.equal(preview.status,'ready')
  assert.equal(preview.links.includes('.codex/skills/unit'),true)
  assert.equal(preview.snapshots.length,2)
  assert.equal(await realpath(f.common),current)
  assert.equal((await f.unshare(preview.revision)).status,'removed')
  for (const path of [old,current,f.common,join(f.home,'.codex/skills/unit')]) await f.gone(path)
  assert.equal(await readFile(f.file,'utf8'),'Updated instructions.')
  assert.equal(await readFile(alternate,'utf8'),'Keep other bytes.')
  assert.deepEqual((await sharing.readSharedRegistry(f.home)).skills,{})
})

test('only removes newly created links when sharing an existing common skill; leaves a pre-existing link intact', async t => {
  const f = await fixture(t,'.agents/skills'), existing = join(f.home,'.codex/skills/unit')
  await mkdir(dirname(existing),{recursive:true}); await symlink(f.common,existing)
  await f.sync((await f.catalog()).items[0].id)
  const preview = await f.unshare()
  assert.equal(preview.links.includes('.codex/skills/unit'),false)
  assert.deepEqual(preview.snapshots,[])
  await f.unshare(preview.revision); assert.equal(await realpath(existing),f.common)
  assert.equal((await lstat(f.common)).isDirectory(),true)
  await f.gone(join(f.home,'.claude/skills/unit'))
})

test('changed snapshot bytes prevent destructive cleanup, replaced provider entries survive, and stale preview is rejected', async t => {
  const f = await fixture(t); await f.sync((await f.catalog()).items[0].id)
  const preview = await f.unshare(), path = join(f.home,'.codex/skills/unit')
  await unlink(path); await mkdir(path); await writeFile(join(path,'my.txt'),'My files')
  await assert.rejects(f.unshare(preview.revision),/changed/i)
  const snapshot = await realpath(f.common)
  await writeFile(join(snapshot,'modified.txt'),'Keep this too')
  const blocked = await f.unshare(); assert.equal(blocked.status,'blocked')
  await assert.rejects(f.unshare(preview.revision))
  assert.equal(await realpath(f.common),snapshot)
  assert.equal(await readFile(join(path,'my.txt'),'utf8'),'My files')
})

test('legacy snapshot registrations offer an explicit preview of inferred links and preserve the original', async t => {
  const f = await fixture(t); await f.sync((await f.catalog()).items[0].id)
  const r=await sharing.readSharedRegistry(f.home)
  const s=r.skills.unit
  r.skills.unit=Object.fromEntries(['name','sourcePath','sourceStamp','snapshot','snapshotStamp','packageFingerprint'].map(key=>[key,s[key]]))
  await writeFile(f.registryFile,JSON.stringify(r))
  const plan=await f.unshare(); assert.equal(plan.legacy,true)
  await f.unshare(plan.revision); await f.gone(s.snapshot); await f.gone(f.common)
  assert.match(await readFile(f.file,'utf8'),/Keep me/)
})

test('workspace worker checks local focus before preview or cleanup and clears the removed selection', async t => {
  const {createToolboxManager} = await import('./toolbox-manager.mjs')
  const f=await fixture(t),shared=await f.sync((await f.catalog()).items[0].id)
  let workspaceId='w', hostId='local', selected=[shared]
  const manager=createToolboxManager({home:f.home,getContext:async()=>({workspaceId}),post:()=>{},
    getWorkspaces:async()=>({workspaces:[{id:'w',hostId,path:f.home}]}),
    loadSelection:async()=>selected,saveSelection:async(_id,value)=>{selected=value}})
  t.after(()=>manager.dispose())
  const request={workspaceId:'w',key:'unit'}
  const plan=await manager.unshare(request)
  workspaceId='x'; await assert.rejects(manager.unshare({...request,revision:plan.revision}),/workspace/i)
  workspaceId='w'; hostId='remote'; await assert.rejects(manager.unshare({...request,revision:plan.revision}),/local/i)
  hostId='local'; assert.equal((await manager.unshare({...request,revision:plan.revision})).status,'removed')
  assert.deepEqual(selected,[])
})

test('shows the registered skill name when a legacy snapshot instruction has no frontmatter', async t => {
  const f=await fixture(t); await writeFile(f.file,'Keep these instructions.')
  const skill=(await f.catalog()).items[0]; assert.equal(skill.name,'unit')
  const id=await f.sync(skill.id)
  const item=(await f.catalog()).items.find(x=>x.id===id)
  assert.equal(item.name,'unit'); assert.equal(item.sharing.unshareKey,'unit')
})

test('a missing source leaves the last shared copy recoverable and explains the blocked action', async t => {
  const f=await fixture(t); await f.sync((await f.catalog()).items[0].id)
  const snapshot=await realpath(f.common)
  const plan=await f.unshare()
  await rm(f.source,{recursive:true})
  const blocked=await f.unshare()
  assert.equal(blocked.status,'blocked'); assert.equal(blocked.sourceAvailable,false)
  await assert.rejects(f.unshare(plan.revision))
  assert.ok(await readFile(join(snapshot,'SKILL.md'),'utf8'))
})

test('an interrupted cleanup can resume after a snapshot was detached, without removing other stored folders', async t => {
  const f=await fixture(t); await f.sync((await f.catalog()).items[0].id)
  const snap=await realpath(f.common), attempted=await f.unshare()
  const unrelated=join(dirname(snap),'other'); await mkdir(unrelated)
  let interrupted=false
  await assert.rejects(sharing.unshareSkill({home:f.home,key:'unit',revision:attempted.revision,checkContext:async()=>{
    const exists=await lstat(snap).then(()=>true,e=>e.code==='ENOENT'?false:Promise.reject(e))
    if(!exists){interrupted=true;throw Error('workspace changed')}
  }}),/workspace changed/)
  assert.equal(interrupted,true)
  const retry=await f.unshare(); assert.equal(retry.status,'ready')
  assert.equal(retry.snapshots.length,1)
  await f.unshare(retry.revision)
  const {readdir}=await import('node:fs/promises')
  assert.deepEqual(await readdir(dirname(snap)),['other'])
})

test('stopping a shared skill recovers its dead worker lock and deduplicates provider directory aliases', async t => {
  const f=await fixture(t)
  const first=join(f.home,'.gemini/config/skills'),alias=join(f.home,'.gemini/antigravity/skills')
  await mkdir(first,{recursive:true}); await mkdir(dirname(alias),{recursive:true}); await symlink(first,alias)
  await f.sync((await f.catalog()).items[0].id)
  const lock=join(f.home,'.agents/traffic-light/shared-sync.lock')
  await symlink('traffic-light-maintenance-2147483647-9917c4b3-c428-482a-9b3e-df0c4e423b6d',lock)
  const plan=await f.unshare()
  assert.equal(plan.links.filter(path=>path.includes('/config/')||path.includes('/antigravity/')).length,1)
  await f.unshare(plan.revision)
  await f.gone(join(alias,'unit')); assert.ok((await lstat(alias)).isSymbolicLink())
})

test('preserves an externally edited detached snapshot even during a confirmed cleanup', async t => {
  const f=await fixture(t); await f.sync((await f.catalog()).items[0].id)
  const snapshot=await realpath(f.common), plan=await f.unshare()
  const retired=join(dirname(snapshot),'.removing-'+snapshot.split('/').at(-1))
  let touched=false
  await assert.rejects(sharing.unshareSkill({home:f.home,key:'unit',revision:plan.revision,checkContext:async()=>{
    if (!touched && await lstat(retired).then(()=>true,e=>e.code==='ENOENT'?false:Promise.reject(e))) {
      await writeFile(join(retired,'external.txt'),'User edit'); touched=true
    }
  }}),/changed/)
  assert.equal(await readFile(join(retired,'external.txt'),'utf8'),'User edit')
  assert.equal((await f.unshare()).status,'blocked')
})
