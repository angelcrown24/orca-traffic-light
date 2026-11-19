import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanCatalog, resolveRecord } from './catalog.mjs'
import { skillPortability } from './skill-portability.mjs'

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
  assert.deepEqual(Object.fromEntries(items.map(item => [item.name, item.providerOnly])), {
    guide: undefined, native: 'skill-execution', manual: 'explicit-invocation', 'codex-manual': 'explicit-invocation'
  })
  assert.equal(items.find(x => x.name === 'guide').skillRequirements, 'Requires Node.js')
  const record = [...records.values()].find(x => x.name === 'guide')
  assert.equal((await resolveRecord(record)).path, record.path)
  await writeFile(join(guide, 'agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: false')
  await assert.rejects(resolveRecord(record), { code: 'CAPABILITY_UNAVAILABLE' })
})

test('only explicit provider requirements qualify for adaptation', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-skill-host-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'SKILL.md')
  for (const requirement of ['Requires Claude Code', 'Codex only', 'Claude Code 전용', 'Only runs in Gemini CLI.',
    'Runs only in Claude Code', 'Claude Code only. Requires Node.js 20.', 'Only works with Claude Code', 'Works only with Codex CLI']) {
    const result = await skillPortability('---\ncompatibility: ' + requirement + '\n---', file)
    assert.equal(result.available, false, requirement)
    assert.equal(result.providerOnly, 'skill-execution')
    assert.equal(result.skillRequirements, requirement)
  }
  for (const requirement of ['Requires Node.js', 'Codex', 'Works with Gemini CLI', 'Requires Claude Code or Codex', 'Does not require Claude Code',
    'Codex only if available', 'No Claude Code required', 'For example: Claude Code only.', 'Claude Code only. Alternatively, Gemini CLI works.']) {
    const result = await skillPortability('---\ncompatibility: ' + JSON.stringify(requirement) + '\n---\nRequires Claude Code', file)
    assert.equal(result.available, true, requirement)
    assert.equal(result.providerOnly, undefined)
  }
  const dir = join(root, 'agents')
  await mkdir(dir)
  const check = async yaml => {
    await writeFile(join(dir, 'openai.yaml'), yaml)
    return skillPortability('---\ndescription: Uses codex_apps optionally\n---\nGuide', file)
  }
  for (const value of ['codex_apps', 'mcp__codex_apps__search']) {
    const native = await check('dependencies: {tools: [{type: mcp, value: ' + value + '}]}')
    assert.equal(native.available, false)
    assert.equal(native.providerOnly, 'native-tool')
  }
  const external = await check('dependencies: {tools: [{type: mcp, value: figma, description: Alternative to codex_apps}]}')
  assert.equal(external.available, true)
  assert.match(external.skillRequirements, /external dependencies/)
  for (const invalid of ['dependencies: {tools: nope}', 'policy: {allow_implicit_invocation: uncertain}', 'policy: {unknown: true}', '[']) {
    const result = await check(invalid)
    assert.equal(result.available, false, invalid)
    assert.equal(result.providerOnly, undefined)
  }
})
