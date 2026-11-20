import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scanCatalog } from './catalog.mjs'
import { syncCapabilities } from './shared-sync.mjs'
import { createSkillReviewer } from './skill-review.mjs'

const skill = (name, body = '', meta = '') => `---\nname: ${name}\ndescription: fixture\n${meta}---\n${body}`
async function setup(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'tl-skill-review-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  const reader = createSkillReviewer({ home })
  return { home, scan: () => scanCatalog({ home }), review: async () => reader(await scanCatalog({ home })),
    async put(path, content) {
      const file = join(home, path)
      await mkdir(dirname(file), { recursive: true }); await writeFile(file, content)
      return file
    } }
}

test('canonical aliases stay together and only an independent identical copy can be cleaned up; files and modes invalidate changed reviews', async t => {
  const f = await setup(t)
  for (const source of ['.agents', '.claude']) {
    await f.put(source + '/skills/build/SKILL.md', skill('build'))
    await f.put(source + '/skills/build/scripts/task.sh', 'unchanged contents')
  }
  await mkdir(join(f.home, '.codex/skills'), { recursive: true })
  await symlink(join(f.home, '.agents/skills/build'), join(f.home, '.codex/skills/build'))
  const first = await f.review()
  assert.deepEqual([first.scanned, first.checked, first.skipped, first.identicalGroups], [2, 2, 0, 1])
  const catalog = await f.scan(), duplicate = first.findings[0]
  const retained = catalog.items.find(item => item.providers.includes('Shared'))
  const target = catalog.items.find(item => item.providers.includes('Claude Code'))
  assert.equal(first.findings.length, 1)
  assert.equal(duplicate.kind, 'redundant')
  assert.deepEqual(duplicate.providers, ['Claude Code'])
  assert.deepEqual(duplicate.removalCandidate, { id: target.id, reason: 'duplicate', retainedId: retained.id })
  assert.deepEqual(duplicate.comparisonIds, [target.id, retained.id])
  assert.equal((await f.review()).checked, 0)
  await chmod(join(f.home, '.claude/skills/build/scripts/task.sh'), 0o700)
  const changed = await f.review(), row = changed.findings[0]
  assert.equal(changed.checked,1); assert.equal(changed.identicalGroups,0)
  assert.deepEqual([row.kind,row.evidence], ['variants',['scripts/task.sh']])
  assert.deepEqual(row.evidenceDetails,[{path:'scripts/task.sh',state:'changed'}])
  assert.deepEqual(row.providers, ['Claude Code','Codex','Shared'])
  const stamp = row.stamp
  await f.put('.claude/skills/build/scripts/task.sh','different content')
  assert.notEqual((await f.review()).findings[0].stamp, stamp)
  await f.put('.agents/skills/build/LICENSE','Only this copy includes the license')
  const shared = (await f.scan()).items.find(item => item.providers.includes('Shared'))
  assert.deepEqual((await f.review()).findings[0].evidenceDetails[0],{path:'LICENSE',state:'only',ids:[shared.id]})
  await rm(join(f.home,'.claude/skills/build'),{recursive:true})
  assert.deepEqual((await f.review()).findings,[])
})

test('suggested comparison picks different package versions when all three copies contain the same paths', async t => {
  const f = await setup(t)
  for (const root of ['.agents', '.claude', '.codex']) {
    await f.put(root + '/skills/build/SKILL.md', skill('build'))
    await f.put(root + '/skills/build/guide.md', 'Original')
  }
  const catalog = await f.scan()
  const sorted = catalog.items.map(item => item.id).sort()
  // Make only the last id differ, so the first two ids cannot exhibit the finding.
  const distinct = sorted.at(-1)
  await writeFile(join(dirname(catalog.records.get(distinct).path), 'guide.md'), 'Revised')
  const row = (await f.review()).findings.find(finding => finding.kind === 'variants')
  assert.deepEqual(row.evidenceDetails, [{ path: 'guide.md', state: 'changed' }])
  assert.equal(row.comparisonIds.length, 2)
  assert.ok(row.comparisonIds.includes(distinct))
  assert.ok(row.comparisonIds.some(id => sorted.slice(0, 2).includes(id)))
})

test('reports only actual package references, omitting examples, generated outputs, private paths and old findings', async t => {
  const f = await setup(t), dir = '.agents/skills/ref'
  const lines = ['---','name: ref','---','Read [schema](references/schema.md#section).','Run `python3 scripts/build.py`.',
    'For example, [sample](references/example.md).','```markdown','Read [imaginary](references/imaginary.md)','```',
    'Create `references/output.png` from the generated output.','See [outside](/private/client/SECRET.txt) or [outside](../SECRET.txt).',
    'See [app](https://example.org/SECRET.txt).','Read [guide](references/guide.md).','See [link](references/linked.md).',
    'When the example user chooses AWS, read `references/aws.md`; only then proceed.']
  await f.put(dir + '/SKILL.md', lines.join('\n'))
  await f.put(dir + '/references/guide.md','A private instruction that must never appear')
  await symlink('guide.md', join(f.home,dir,'references/linked.md'))
  const row = (await f.review()).findings[0]
  assert.deepEqual([row.name,row.kind,row.evidence,row.line,row.lines], ['ref','missing',['references/schema.md','scripts/build.py'],4,[4,5]])
  assert.doesNotMatch(JSON.stringify(row),/SECRET|private instruction|private\/|aws\.md/)
  await f.put(dir + '/scripts/build.py','')
  await f.put(dir + '/references/schema.md','')
  assert.deepEqual((await f.review()).findings, [])
})

test('a shared update compares the registered snapshot to its actual origin and retains provider originals', async t => {
  const f = await setup(t)
  await f.put('.claude/skills/publish/SKILL.md', skill('publish'))
  await f.put('.claude/skills/publish/scripts/publish.sh', 'asset one')
  await f.put('.claude/skills/publish/OLD.md', 'original')
  await syncCapabilities({ home:f.home, ids:[(await f.scan()).items[0].id] })
  assert.deepEqual((await f.review()).findings, [])
  await f.put('.claude/skills/publish/scripts/publish.sh', 'private asset two')
  await f.put('.claude/skills/publish/NEW.md', 'new')
  await rm(join(f.home,'.claude/skills/publish/OLD.md'))
  const changed = await f.review(), update = changed.findings.find(row => row.kind === 'update')
  assert.deepEqual(update.evidence,['NEW.md','OLD.md','scripts/publish.sh'])
  assert.deepEqual(update.evidenceDetails.map(entry=>entry.state),['added','removed','changed'])
  assert.match(update.reviewedSourceStamp, /^[a-f0-9]{64}$/)
  assert.equal(changed.checked,1); assert.equal(changed.skipped,0)
  assert.equal((await f.review()).checked,0)
  assert.doesNotMatch(JSON.stringify(changed),/private asset|\.claude|\.agents|~\//)
  await f.put('.agents/skills/publish/SKILL.md', skill('publish','Changed externally'))
  assert.equal((await f.review()).findings.some(row => row.kind === 'conflict'), true)
})

test('coverage identifies exclusions and concrete native requirements without executing or following external scripts', async t => {
  const f = await setup(t)
  await f.put('.codex/skills/invoke/SKILL.md',skill('invoke','','disable-model-invocation: true\n'))
  await f.put('.claude/skills/broken/SKILL.md',skill('broken'))
  await symlink('/private', join(f.home,'.claude/skills/broken/private'))
  const c = await f.scan()
  c.skillExclusions = ['one','two'].map(id=>({name:'large',providers:['Codex'],id,reason:'too-large',stamp:'stamp'}))
  const report = await createSkillReviewer({home:f.home})(c)
  assert.deepEqual([report.scanned,report.checked,report.skipped,report.partial],[4,1,3,true])
  const provider = report.findings.find(row => row.kind==='provider')
  assert.deepEqual(provider.requirement, {file:'SKILL.md',field:'disable-model-invocation',line:4})
  assert.deepEqual(report.findings.find(row => row.name==='large').ids,['one','two'])
  assert.deepEqual(report.findings.find(row => row.name==='broken').evidence,['unsupported-package'])
  assert.doesNotMatch(JSON.stringify(report),/private|home\/|\.codex/)
})

test('reports an author-endorsed installed successor, not age, similar names, a code sample, or an unavailable target', async t => {
  const f = await setup(t)
  const source = 'This v1 skill is still supported, but `learn-v2` is the preferred path for new installs.'
  await f.put('.agents/skills/learn/SKILL.md', skill('learn', source))
  await f.put('.claude/skills/quiet/SKILL.md', skill('quiet','## Example\nThis skill is superseded by `quiet-v2`.'))
  await f.put('.claude/skills/quiet-v2/SKILL.md', skill('quiet-v2'))
  assert.equal((await f.review()).findings.some(row => row.kind==='successor'), false)
  await f.put('.codex/skills/learn-v2/SKILL.md', skill('learn-v2','Other instructions'))
  const catalog = await f.scan(), [older, newer] = ['learn','learn-v2'].map(name=>catalog.items.find(item=>item.name===name))
  const successor = (await f.review()).findings.find(row => row.kind==='successor')
  assert.deepEqual([successor.name,successor.line,successor.evidence,successor.ids,successor.successorId],
    ['learn',5,['learn-v2'],[older.id,newer.id],newer.id])
  assert.equal(successor.removalCandidate, undefined)
  assert.equal((await f.review()).findings.length, 1)
  await f.put('.codex/skills/learn-v2/SKILL.md', skill('learn-v2','Updated instructions'))
  assert.notEqual((await f.review()).findings[0].stamp, successor.stamp)
  await f.put('.agents/skills/learn/SKILL.md', skill('learn', 'You may also use `learn-v2`.\nDo not assume `learn-v2` is the preferred path for new installs.'))
  assert.deepEqual((await f.review()).findings, [])
})


test('a removal candidate needs explicit replacement, a usable survivor and matching provider reach', async t => {
  const f = await setup(t)
  const old = '.codex/skills/lint/SKILL.md', next = '.codex/skills/lint-v2/SKILL.md'
  const retired = skill('lint', 'This skill is superseded by `lint-v2`.')
  await f.put(old, retired)
  await f.put('.claude/skills/lint-v2/SKILL.md', skill('lint-v2'))
  const initial = await f.review()
  assert.equal(initial.findings.find(row => row.kind === 'successor').removalCandidate, undefined)
  await f.put(next, skill('lint-v2'))
  const data = await f.scan()
  const original = data.items.find(item => item.name === 'lint')
  const keep = data.items.find(item => item.name === 'lint-v2' && item.providers.includes('Codex'))
  const row = (await f.review()).findings.find(f => f.kind === 'successor')
  assert.deepEqual(row.removalCandidate, { id: original.id, reason: 'successor', retainedId: keep.id })
  assert.equal(row.line, 5)
  await f.put(next, skill('lint-v2', '', 'disable-model-invocation: true\n'))
  assert.equal((await f.review()).findings.find(f => f.kind === 'successor').removalCandidate, undefined)
})

test('root permissions, restricted copies, same-canonical aliases and truncated inventories do not qualify for deduplication', async t => {
  const f = await setup(t)
  const common = await f.put('.agents/skills/tool/SKILL.md', skill('tool'))
  await mkdir(join(f.home, '.claude/skills'), { recursive: true })
  await symlink(dirname(common), join(f.home, '.claude/skills/tool'))
  assert.equal((await f.review()).findings.length, 0)
  const other = await f.put('.codex/skills/tool/SKILL.md', skill('tool'))
  await chmod(dirname(common), 0o700)
  await chmod(dirname(other), 0o755)
  assert.equal((await f.review()).findings.some(f => f.removalCandidate), false)
  await chmod(dirname(other), 0o700)
  const data = await f.scan(), reader = createSkillReviewer({ home: f.home })
  data.warnings.push('Skill inventory reached its scan limit; some entries are omitted.')
  assert.equal((await reader(data)).findings.some(f => f.removalCandidate), false)
  await f.put('.agents/skills/tool/SKILL.md', skill('tool', '', 'disable-model-invocation: true\n'))
  await f.put('.codex/skills/tool/SKILL.md', skill('tool', '', 'disable-model-invocation: true\n'))
  assert.equal((await f.review()).findings.some(f => f.removalCandidate), false)
})

test('suggests a moved reference only when exactly one same-basename regular package file exists', async t => {
  const f = await setup(t), root = '.agents/skills/moved/'
  await f.put(root + 'SKILL.md', skill('moved', [
    'Read [guide](references/guide.md).',
    'Read [notes](references/notes.md).',
    'Read [design](references/design.md).',
    'Read [empty](references/empty.md).',
    'Read [private](references/private.md).'
  ].join('\n')))
  for (const file of ['docs/guide.md', 'docs/notes.md', 'archive/notes.md', 'docs/private.md', 'odd folder/private.md']) {
    await f.put(root + file, 'fixture')
  }
  await symlink('guide.md', join(f.home, root, 'docs/design.md'))
  const row = (await f.review()).findings.find(finding => finding.kind === 'missing')
  assert.deepEqual(row.referenceFixes, [{ from: 'references/guide.md', to: 'docs/guide.md', line: 5 }])
  assert.doesNotMatch(JSON.stringify(row), /odd folder/)
  await f.put(root + 'manual/guide.md', 'second candidate')
  assert.equal((await f.review()).findings.find(finding => finding.kind === 'missing').referenceFixes, undefined)
})

test('retirement requires a real skill-name span outside multiline literals and fenced examples', async t => {
  const f = await setup(t)
  const file = '.codex/skills/guide/SKILL.md'
  const marker = 'Replaced by \x60guide-v2\x60.'
  const sample = [
    'A Markdown illustration uses \x60\x60this sentence:', marker, 'End of literal.\x60\x60', '',
    'For example, use \x60\x60this text:', marker, 'End of literal.\x60\x60', '',
    '\x60\x60\x60md', marker, '\x60\x60\x60', '',
    'Use \x60\x60these instructions:', '\x60guide-v2\x60 is the preferred path for new installs.', 'End of literal.\x60\x60'
  ].join('\n')
  await f.put('.codex/skills/guide-v2/SKILL.md', skill('guide-v2','Independent instructions.'))
  await f.put(file, skill('guide', sample))
  assert.deepEqual((await f.review()).findings, [])
  await f.put(file, skill('guide', sample + '\n\n  - ' + marker))
  const result = await f.review()
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].removalCandidate.reason,'successor')
})
