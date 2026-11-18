import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanCatalog, resolveRecord } from './catalog.mjs'

test('skill discovery honors native invocation and execution settings, and existing grants recheck Codex policy at read time', async t => {
  const home = await mkdtemp(join(tmpdir(), 'orca-portability-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  async function add(name, metadata) {
    const path = join(home, '.agents', 'skills', name)
    await mkdir(join(path, 'agents'), { recursive: true })
    await writeFile(join(path, 'SKILL.md'), '---\nname: ' + name + '\n' + metadata + '\n---\nTasks for this skill.')
    return path
  }
  const guide = await add('guide', 'compatibility: Requires Node.js')
  await add('native', 'context: fork\nhooks: {}')
  await add('manual', '"disable-model-invocation": yes')
  const codex = await add('codex-manual', 'description: A guide')
  await writeFile(join(codex, 'agents/openai.yaml'), 'policy: {allow_implicit_invocation: false}')
  const { items, records } = await scanCatalog({ home })
  assert.deepEqual(items.filter(x => x.available).map(x => x.name), ['guide'])
  assert.equal(items.find(x => x.name === 'guide').skillRequirements, 'Requires Node.js')
  const record = [...records.values()].find(x => x.name === 'guide')
  assert.equal((await resolveRecord(record)).path, record.path)
  await writeFile(join(guide, 'agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: false')
  await assert.rejects(resolveRecord(record), { code: 'CAPABILITY_UNAVAILABLE' })
})
