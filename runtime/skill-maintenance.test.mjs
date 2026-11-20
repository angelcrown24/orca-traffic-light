import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { syncCapabilities } from './shared-sync.mjs'
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scanCatalog } from './catalog.mjs'
import { createSkillMaintenance } from './skill-maintenance.mjs'

const original = '---\nname: my-review\ndescription: Check a report.\n---\nRead `references/legacy.md`.\n'
const revised = original.replace('legacy.md', 'current.md')
async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'skill-actions-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  const fs = createSkillMaintenance({ home })
  return {
    home, fs,
    async put(path, contents = original) { await mkdir(dirname(join(home, path)), { recursive: true }); await writeFile(join(home, path), contents) },
    async alias(path, target) { await mkdir(dirname(join(home, path)), { recursive: true }); await symlink(target, join(home, path)) },
    async plan(kind, retained = false) {
      const data = await scanCatalog({ home }), rows = data.items.filter(i => i.kind === 'skill' && i.name === 'my-review')
      const selected = retained ? rows.find(i => !i.providers.includes('Shared')) : rows[0]
      const input = { workspaceId: 'folder-a', id: selected.id, kind,
        ...(retained ? { retainedId: rows.find(i => i.providers.includes('Shared')).id } : {}) }
      return { data, input, plan: await fs.preview(data, input) }
    }
  }
}

test('edits one selected skill across aliases, pins the reviewed body, and restores after restart without overwriting later changes', async t => {
  const f = await fixture(t), path = '.agents/skills/my-review/SKILL.md'
  await f.put(path); await f.alias('.codex/skills/my-review', join(f.home, dirname(path)))
  const { data, input, plan } = await f.plan('edit')
  assert.deepEqual(plan.paths, ['.agents/skills/my-review', '.codex/skills/my-review'])
  assert.equal(plan.body, original)
  assert.deepEqual(await f.fs.history('folder-a'), [])
  const receipt = await f.fs.apply(data, { ...input, revision: plan.revision, body: revised })
  assert.equal(await readFile(join(f.home, '.codex/skills/my-review/SKILL.md'), 'utf8'), revised)
  const restarted = createSkillMaintenance({ home: f.home })
  assert.deepEqual(await restarted.history('folder-a'), [receipt])
  assert.deepEqual(await restarted.history('folder-b'), [])
  await assert.rejects(restarted.undo({workspaceId:'folder-b',receiptId:receipt.id}), { code:'INVALID' })
  await assert.rejects(f.fs.apply(data, { ...input, revision: plan.revision, body: original }), {code:'STALE'})
  await f.put(path, 'someone else edited this')
  await assert.rejects(restarted.undo({workspaceId:'folder-a',receiptId:receipt.id}),{code:'CONFLICT'})
  assert.equal(await readFile(join(f.home, path), 'utf8'), 'someone else edited this')
  await f.put(path, revised)
  assert.deepEqual(await restarted.undo({workspaceId:'folder-a',receiptId:receipt.id}), {restored:true})
  assert.equal(await readFile(join(f.home, path),'utf8'), original)
  assert.deepEqual(await restarted.history('folder-a'), [])
})

test('removal archives the package and chained direct links; undo restores their original relative targets and package identity', async t => {
  const f = await fixture(t), root = join(f.home, '.agents/skills/my-review')
  await f.put('.agents/skills/my-review/SKILL.md')
  await f.put('.agents/skills/my-review/references/current.md','guide')
  await f.alias('.codex/skills/my-review', '../../.agents/skills/my-review')
  await f.alias('.claude/skills/my-review', '../../.codex/skills/my-review')
  const { data, input, plan } = await f.plan('remove'), inode = (await lstat(root)).ino
  const r = await f.fs.apply(data,{...input,revision:plan.revision})
  assert.equal((await scanCatalog({home:f.home})).items.filter(i=>i.kind==='skill').length,0)
  for (const path of plan.paths) await assert.rejects(lstat(join(f.home,path)), {code:'ENOENT'})
  await f.put('.agents/skills/my-review/keep.txt','another install')
  await assert.rejects(f.fs.undo({workspaceId:input.workspaceId,receiptId:r.id}),{code:'CONFLICT'})
  assert.equal(await readFile(join(root,'keep.txt'),'utf8'),'another install')
  await rename(root,join(f.home,'other-install'))
  await f.fs.undo({workspaceId:input.workspaceId,receiptId:r.id})
  assert.equal((await lstat(root)).ino,inode)
  assert.equal(await readlink(join(f.home,'.claude/skills/my-review')),'../../.codex/skills/my-review')
  assert.equal(await readlink(join(f.home,'.codex/skills/my-review')),'../../.agents/skills/my-review')
  assert.equal(await readFile(join(root,'references/current.md'),'utf8'),'guide')
  assert.equal((await scanCatalog({home:f.home})).items.find(i=>i.kind==='skill').id,input.id)
})

test('duplicate removal retains provider access and undo restores the exact independent directory; rejects changed retained files or permissions', async t => {
  const f = await fixture(t), local = '.claude/skills/my-review', retained = '.agents/skills/my-review'
  for (const root of [local,retained]) {
    await f.put(root+'/SKILL.md'); await f.put(root+'/references/guide.md','guide')
  }
  const { data,input,plan } = await f.plan('remove',true)
  assert.equal(plan.retainedPath,retained)
  await chmod(join(f.home,retained),0o700)
  await assert.rejects(f.fs.apply(data,{...input,revision:plan.revision}),{code:'STALE'})
  await chmod(join(f.home,retained),(await lstat(join(f.home,local))).mode & 0o777)
  await f.put(retained+'/references/guide.md','different guide')
  assert.equal((await f.plan('remove',true)).plan.status,'blocked')
  await f.put(retained+'/references/guide.md','guide')
  const next = await f.plan('remove',true)
  const r=await f.fs.apply(next.data,{...next.input,revision:next.plan.revision})
  assert.equal(await realpath(join(f.home,local)),join(f.home,retained))
  const rows=(await scanCatalog({home:f.home})).items.filter(i=>i.kind==='skill')
  assert.deepEqual(rows.map(i=>i.providers),[['Shared','Claude Code']])
  await f.fs.undo({workspaceId:input.workspaceId,receiptId:r.id})
  assert.notEqual(await realpath(join(f.home,local)),join(f.home,retained))
  assert.equal(await readFile(join(f.home,local,'references/guide.md'),'utf8'),'guide')
})

test('ancestor collection symlinks stay intact, and system, external and symlinked-document sources cannot be mutated', async t => {
  const f=await fixture(t)
  await f.put('.claude/skills/collection/my-review/SKILL.md')
  await f.put('.claude/skills/collection/other/SKILL.md',original.replace('my-review','other'))
  await f.alias('.agents/skills/collection','../../.claude/skills/collection')
  const {data,input,plan}=await f.plan('remove')
  const r=await f.fs.apply(data,{...input,revision:plan.revision})
  assert.equal(await readFile(join(f.home,'.agents/skills/collection/other/SKILL.md'),'utf8'),original.replace('my-review','other'))
  await f.fs.undo({workspaceId:input.workspaceId,receiptId:r.id})
  await f.put('project/outside/SKILL.md',original.replace('my-review','outside'))
  await f.alias('.codex/skills/outside',join(f.home,'project/outside'))
  await f.put('.codex/skills/.system/builtin/SKILL.md',original.replace('my-review','builtin'))
  await f.put('project/private.md',original.replace('my-review','document'))
  await f.alias('.codex/skills/document/SKILL.md',join(f.home,'project/private.md'))
  const catalog=await scanCatalog({home:f.home})
  for(const name of ['outside','builtin','document']) {
    const item=catalog.items.find(i=>i.name===name)
    assert.deepEqual(await f.fs.preview(catalog,{id:item.id,kind:'remove'}),{status:'blocked',reason:'protected-root'})
  }
})

test('checking workspace again inside the write gate, and concurrent mutations, cannot leave a partially edited package', async t => {
  const f=await fixture(t), path='.agents/skills/my-review/SKILL.md'
  await f.put(path)
  const {data,input,plan}=await f.plan('edit'), args={...input,revision:plan.revision,body:revised}
  let checks=0
  await assert.rejects(f.fs.apply(data,args,() => {if (++checks===3) throw new Error('workspace changed')}),/workspace changed/)
  assert.equal(await readFile(join(f.home,path),'utf8'), original)
  assert.deepEqual(await f.fs.history('folder-a'),[])
  const results=await Promise.allSettled([f.fs.apply(data,args),f.fs.apply(data,args)])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  assert.ok(['BUSY','STALE'].includes(results.find(r=>r.status==='rejected').reason.code))
  assert.equal((await f.fs.history('folder-a')).length,1)
})

test('managed installations repair the registered, discovered original while keeping published bytes intact', async t => {
  const f = await fixture(t), source = '.claude/skills/my-review'
  await f.put(source + '/SKILL.md')
  const first = await f.plan('edit')
  await syncCapabilities({ home: f.home, ids: [first.input.id] })
  const {data, input, plan} = await f.plan('edit')
  assert.equal(plan.status, 'ready'); assert.equal(plan.editsOriginal, true)
  assert.equal(plan.path, source); assert.deepEqual(plan.providers, ['Claude Code'])
  assert.deepEqual(await f.fs.preview(data, {...input, kind:'remove'}), {status:'blocked',reason:'managed-snapshot'})
  const r=await f.fs.apply(data, {...input,revision:plan.revision, body:revised})
  assert.equal(r.editsOriginal,true)
  assert.equal(await readFile(join(f.home,'.agents/skills/my-review/SKILL.md'),'utf8'),original)
  assert.equal(await readFile(join(f.home,source,'SKILL.md'),'utf8'),revised)
  assert.equal((await scanCatalog({home:f.home})).items[0].sharing.state,'update')
  await f.fs.undo({workspaceId:input.workspaceId,receiptId:r.id})
  assert.equal(await readFile(join(f.home,source,'SKILL.md'),'utf8'),original)
})

test('a dead maintenance owner can be recovered for undo, while live owners and foreign sync locks are preserved', async t => {
  const f=await fixture(t)
  await f.put('.agents/skills/my-review/SKILL.md')
  const {data,input,plan}=await f.plan('edit')
  const r=await f.fs.apply(data,{...input,revision:plan.revision,body:revised})
  const lock=join(f.home,'.agents/traffic-light/shared-sync.lock'), args={workspaceId:input.workspaceId,receiptId:r.id}
  await mkdir(lock)
  await assert.rejects(f.fs.undo(args),{code:'BUSY'})
  assert.ok((await lstat(lock)).isDirectory())
  await rm(lock,{recursive:true})
  const live='traffic-light-maintenance-'+process.pid+'-'+randomUUID()
  await symlink(live,lock)
  await assert.rejects(f.fs.undo(args),{code:'BUSY'})
  assert.equal(await readlink(lock),live)
  await rm(lock)
  const exited=spawnSync(process.execPath,['-e',''])
  assert.equal(exited.status,0)
  await symlink('traffic-light-maintenance-'+exited.pid+'-'+randomUUID(),lock)
  assert.deepEqual(await f.fs.undo(args),{restored:true})
  await assert.rejects(lstat(lock),{code:'ENOENT'})
})

test('a registered original that appears separately after a portability change retains its protection', async t => {
  const f = await fixture(t), file = '.claude/skills/my-review/SKILL.md'
  await f.put(file)
  const first = await f.plan('edit')
  await syncCapabilities({ home: f.home, ids: [first.input.id] })
  await f.put(file, original.replace('description:', 'disable-model-invocation: true\ndescription:'))
  const data = await scanCatalog({ home: f.home })
  assert.ok(data.items.some(item => item.id === first.input.id && item.providerOnly))
  assert.deepEqual(await f.fs.preview(data, { ...first.input, kind: 'remove' }), { status: 'blocked', reason: 'managed-snapshot' })
  const edit = await f.fs.preview(data, first.input)
  assert.equal(edit.status, 'ready')
  assert.equal(edit.editsOriginal, true)
})

test('removing an outer package cannot silently unregister a nested skill used by another provider', async t => {
  const f = await fixture(t)
  const outer = '.agents/skills/my-review'
  await f.put(outer + '/SKILL.md')
  await f.put(outer + '/included/inner/SKILL.md', original.replace('name: my-review','name: inner'))
  await f.alias('.claude/skills/inner', join(f.home, outer, 'included/inner'))
  const data = await scanCatalog({ home: f.home }), id = data.items.find(item => item.name === 'my-review').id
  assert.deepEqual(await f.fs.preview(data, { id, kind: 'remove' }), { status: 'blocked', reason: 'nested-installation' })
  assert.equal((await f.fs.preview(data, { id, kind: 'edit' })).status, 'ready')
})
