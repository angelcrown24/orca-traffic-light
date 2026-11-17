import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scanCatalog, resolveRecord } from './catalog.mjs'
import { readSharedRegistry, syncCapabilities } from './shared-sync.mjs'

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'traffic-shared-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  return { home, async put(relative, content) {
    const path = join(home, relative)
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, typeof content === 'object' && !Buffer.isBuffer(content) ? JSON.stringify(content) : content)
    return path
  }, scan: () => scanCatalog({ home }), sync: ids => syncCapabilities({ ids, home }) }
}
const skill = name => `---\nname: ${name}\ndescription: Test capability\n---\nRead scripts/helper.sh when needed.\n`

test('imports the complete nested package, preserves source bytes and merges its catalog origins', async t => {
  const f = await fixture(t)
  const source = await f.put('.claude/skills/group/sample/SKILL.md', skill('sample'))
  const script = await f.put('.claude/skills/group/sample/scripts/helper.sh', '#!/bin/sh\nprintf test')
  await chmod(script, 0o755)
  await f.put('.claude/skills/group/sample/assets/data.bin', Buffer.from([0, 10, 255]))
  const initial = await f.scan(), item = initial.items[0]
  assert.equal(item.sharing.state, 'provider')
  const result = (await f.sync([item.id])).results[0]
  assert.equal(result.status, 'synced')
  assert.notEqual(result.newId, item.id)
  assert.equal(await readFile(source, 'utf8'), skill('sample'))
  const common = join(f.home, '.agents/skills/sample'), snapshot = await realpath(common)
  assert.equal((await lstat(common)).isSymbolicLink(), true)
  assert.equal((await lstat(join(snapshot, 'scripts/helper.sh'))).mode & 0o777, 0o755)
  assert.deepEqual(await readFile(join(snapshot, 'assets/data.bin')), Buffer.from([0, 10, 255]))
  for (const root of ['.codex/skills', '.claude/skills', '.gemini/skills', '.gemini/config/skills', '.gemini/antigravity/skills']) assert.equal(await realpath(join(f.home, root, 'sample')), snapshot)
  const shared = await f.scan()
  assert.equal(shared.items.length, 1)
  assert.equal(shared.items[0].id, result.newId)
  assert.equal(shared.items[0].sharing.state, 'shared')
  assert.equal(shared.items[0].providers.includes('Claude Code'), true)
})

test('publishes changed source assets only on explicit sync and preserves earlier bundle versions', async t => {
  const f = await fixture(t)
  await f.put('.codex/skills/sample/SKILL.md', skill('sample'))
  const script = await f.put('.codex/skills/sample/scripts/helper.sh', 'old asset')
  await f.sync([(await f.scan()).items[0].id])
  const old = await f.scan(), oldItem = old.items[0], oldRecord = old.records.get(oldItem.id)
  const oldPath = (await resolveRecord(oldRecord)).path
  await writeFile(script, 'new asset, without modifying SKILL.md')
  const pending = await f.scan()
  assert.equal(pending.items[0].sharing.state, 'update')
  assert.equal((await resolveRecord(oldRecord)).path, oldPath)
  const result = (await f.sync([pending.items[0].id])).results[0]
  assert.equal(result.status, 'synced')
  assert.notEqual(result.newId, oldItem.id)
  const current = await f.scan()
  assert.equal(current.items.length, 1)
  assert.equal(current.items[0].sharing.state, 'shared')
  assert.equal(await readFile(join(dirname(oldPath), 'scripts/helper.sh'), 'utf8'), 'old asset')
  assert.equal((await resolveRecord(oldRecord)).path, oldPath)
  assert.equal(await readFile(join(dirname(current.records.get(result.newId).path), 'scripts/helper.sh'), 'utf8'), 'new asset, without modifying SKILL.md')
})

test('refuses a different provider destination before publishing any common package', async t => {
  const f = await fixture(t)
  await f.put('.codex/skills/sample/SKILL.md', skill('sample'))
  const occupied = await f.put('.gemini/skills/sample/SKILL.md', skill('sample') + 'User changes')
  const catalog = await f.scan(), origin = catalog.items.find(item => item.providers.includes('Codex'))
  const result = (await f.sync([origin.id])).results[0]
  assert.equal(result.status, 'conflict')
  assert.equal(await readFile(occupied, 'utf8'), skill('sample') + 'User changes')
  await assert.rejects(lstat(join(f.home, '.agents/skills/sample')), { code: 'ENOENT' })
})

test('keeps user modifications to a shared snapshot and refuses external package symlinks', async t => {
  const f = await fixture(t)
  await f.put('.claude/skills/sample/SKILL.md', skill('sample'))
  await f.put('.claude/skills/sample/data.txt', 'original')
  await f.sync([(await f.scan()).items[0].id])
  const common = await realpath(join(f.home, '.agents/skills/sample'))
  await writeFile(join(common, 'data.txt'), 'manual common edit')
  const changed = await f.scan(), item = changed.items[0]
  assert.equal(item.sharing.state, 'conflict')
  assert.equal((await f.sync([item.id])).results[0].status, 'conflict')
  await assert.rejects(resolveRecord(changed.records.get(item.id)), { code: 'CAPABILITY_CHANGED' })
  assert.equal(await readFile(join(common, 'data.txt'), 'utf8'), 'manual common edit')
  await f.put('.codex/skills/external/SKILL.md', skill('external'))
  await symlink('../../../../outside', join(f.home, '.codex/skills/external/link'))
  const external = (await f.scan()).items.find(value => value.name === 'external')
  assert.equal((await f.sync([external.id])).results[0].status, 'conflict')
})

test('registers MCP source references without copying secrets or editing provider settings', async t => {
  const f = await fixture(t)
  const definition = { mcpServers: { example: { command: 'node', args: ['PRIVATE_ARGUMENT'], env: { API_KEY: 'PRIVATE_SECRET' } }, disabled: { command: 'node', disabled: true } } }
  const source = await f.put('.claude.json', definition), before = await readFile(source)
  const initial = await f.scan(), item = initial.items.find(value => value.name === 'example'), originalRecord = initial.records.get(item.id)
  assert.equal((await f.sync([item.id])).results[0].status, 'synced')
  assert.deepEqual(await readFile(source), before)
  const registryText = await readFile(join(f.home, '.agents/traffic-light/shared-registry.json'), 'utf8')
  assert.equal(registryText.includes('PRIVATE_'), false)
  assert.equal((await f.scan()).items.find(value => value.id === item.id).sharing.state, 'shared')
  definition.mcpServers.example.env.API_KEY = 'CHANGED_SECRET'
  await writeFile(source, JSON.stringify(definition))
  assert.equal((await f.scan()).items.find(value => value.id === item.id).sharing.state, 'update')
  await assert.rejects(resolveRecord(originalRecord), { code: 'CAPABILITY_CHANGED' })
  assert.equal((await f.sync([item.id])).results[0].status, 'synced')
  assert.equal(JSON.stringify(await readSharedRegistry(f.home)).includes('CHANGED_SECRET'), false)
  const disabled = initial.items.find(value => value.name === 'disabled')
  assert.equal(disabled.sharing.canSync, false)
  assert.equal((await f.sync([disabled.id])).results[0].status, 'conflict')
})

test('links an already-common skill without replacing it and refuses a corrupt registry', async t => {
  const f = await fixture(t)
  const file = await f.put('.agents/skills/common/SKILL.md', skill('common'))
  const item = (await f.scan()).items[0]
  assert.equal((await f.sync([item.id])).results[0].status, 'synced')
  assert.equal((await lstat(dirname(file))).isDirectory(), true)
  assert.equal((await f.sync([item.id])).results[0].status, 'unchanged')
  const registry = await f.put('.agents/traffic-light/shared-registry.json', 'invalid PRIVATE_DATA')
  await assert.rejects(f.sync([item.id]), /registry is unreadable/)
  assert.equal(await readFile(registry, 'utf8'), 'invalid PRIVATE_DATA')
  assert.equal((await f.scan()).warnings.some(warning => warning.includes('PRIVATE_DATA')), false)
})

test('rejects a redirected snapshot directory without writing outside owned storage', async t => {
  const f = await fixture(t)
  await f.put('.claude/skills/sample/SKILL.md', skill('sample'))
  await mkdir(join(f.home, '.agents/traffic-light'), { recursive: true })
  await mkdir(join(f.home, 'outside'))
  await symlink(join(f.home, 'outside'), join(f.home, '.agents/traffic-light/shared-skills'))
  const result = (await f.sync([(await f.scan()).items[0].id])).results[0]
  assert.equal(result.status, 'conflict')
  await assert.rejects(lstat(join(f.home, 'outside/sample')), { code: 'ENOENT' })
})

test('supports a symlinked home and provider skill roots that resolve to the same directory', async t => {
  const f = await fixture(t)
  await f.put('.claude/skills/sample/SKILL.md', skill('sample'))
  await mkdir(join(f.home, '.gemini/config/skills'), { recursive: true })
  await mkdir(join(f.home, '.gemini/antigravity'), { recursive: true })
  await symlink(join(f.home, '.gemini/config/skills'), join(f.home, '.gemini/antigravity/skills'))
  const alias = join(f.home, 'home-alias')
  await symlink(f.home, alias)
  const initial = await scanCatalog({ home: alias })
  assert.equal((await syncCapabilities({ ids: [initial.items[0].id], home: alias })).results[0].status, 'synced')
  const current = await scanCatalog({ home: alias })
  assert.equal(current.items.length, 1)
  assert.equal(current.items[0].sharing.state, 'shared')
  assert.equal((await syncCapabilities({ ids: [current.items[0].id], home: alias })).results[0].status, 'unchanged')
})
