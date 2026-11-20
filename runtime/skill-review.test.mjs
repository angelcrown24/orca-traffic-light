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

test('canonical aliases and equal provider copies are quiet; supporting files and modes invalidate only changed reviews', async t => {
  const f = await setup(t)
  for (const source of ['.agents', '.claude']) {
    await f.put(source + '/skills/build/SKILL.md', skill('build'))
    await f.put(source + '/skills/build/scripts/task.sh', 'unchanged contents')
  }
  await mkdir(join(f.home, '.codex/skills'), { recursive: true })
  await symlink(join(f.home, '.agents/skills/build'), join(f.home, '.codex/skills/build'))
  const first = await f.review()
  assert.deepEqual([first.scanned,first.checked,first.skipped,first.identicalGroups,first.findings], [2,2,0,1,[]])
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
  assert.equal((await f.review()).findings.length, 1)
  await f.put('.codex/skills/learn-v2/SKILL.md', skill('learn-v2','Updated instructions'))
  assert.notEqual((await f.review()).findings[0].stamp, successor.stamp)
  await f.put('.agents/skills/learn/SKILL.md', skill('learn', 'You may also use `learn-v2`.\nDo not assume `learn-v2` is the preferred path for new installs.'))
  assert.deepEqual((await f.review()).findings, [])
})
