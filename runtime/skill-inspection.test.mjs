import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { scanCatalog } from './catalog.mjs'
import { createSkillReviewer } from './skill-review.mjs'
import { createSkillInspection } from './skill-inspection.mjs'

const skill = (name, content, description = 'Review a build') =>
  '---\nname: ' + name + '\ndescription: ' + description + '\n---\n' + content

async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'tl-inspection-')))
  t.after(() => rm(home, { recursive: true, force: true }))
  const inspect = createSkillInspection(createSkillReviewer({ home }))
  return {
    home, inspect, scan: () => scanCatalog({ home }),
    async put(path, content) {
      const dest = join(home, path)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, content)
    }
  }
}
const pick = (data, name) => data.items.find(i => i.name === name).id
const args = (...ids) => ({ ids, language: 'en' })

test('missing file evidence, guidance and citations can be reviewed without a model or reading unrelated skills', async t => {
  const f = await fixture(t)
  await f.put('.agents/skills/report/SKILL.md', skill('report', 'Run `node scripts/report.js`\n## Prepare reports\nBuild the report.'))
  const data = await f.scan()
  let scoped
  const run = createSkillInspection(async inv => { scoped = inv; return createSkillReviewer({ home: f.home })(inv) })
  const selected = pick(data, 'report')
  data.items.push({ id: 'mcp-1', kind: 'mcp', name: 'report' }, { id: 'misc', kind: 'skill', name: 'misc' })
  const r = await run(data, args(selected))
  assert.deepEqual(scoped.items.map(i => i.id), [selected])
  assert.match(r.summary, /1 missing package file/)
  assert.match(r.nextStep, /Restore/)
  assert.deepEqual(r.evidence, [{ label: 'Missing file', detail: 'scripts/report.js', source: 'SKILL.md:5' }])
  assert.doesNotMatch(JSON.stringify(r), new RegExp(f.home))
})

test('two versions use the cited author guidance and real unique headings; unrelated choices get only their own sections', async t => {
  const f = await fixture(t)
  await f.put('.agents/skills/learn/SKILL.md', skill('learn', 'This v1 skill is supported, but `learn-v2` is preferred for new installs.\n`learn-v2` is the preferred path for new installs.\n## Task audit\nRead instructions.\n## Shared steps\nDo a review.'))
  await f.put('.claude/skills/learn-v2/SKILL.md', skill('learn-v2', '## Context review\nRead steps.\n## Shared steps\nDo another review.'))
  await f.put('.claude/skills/support/SKILL.md', skill('support', '## Hand off\nOpen a ticket.'))
  const data = await f.scan(), a = pick(data, 'learn'), b = pick(data, 'learn-v2')
  const r = await f.inspect(data, { ids: [b, a], language: 'ko' })
  assert.match(r.summary, /후속 스킬/)
  assert.match(r.evidence[0].source, /learn · SKILL.md:6/)
  assert.match(r.evidence[0].detail, /preferred/)
  const successorAlone = await f.inspect(data, args(b))
  assert.match(successorAlone.nextStep, /learn · SKILL\.md:6/)
  assert.deepEqual(successorAlone.evidence[0], {
    label: 'Documented successor', detail: 'learn-v2', source: 'learn · SKILL.md:6'
  })
  assert.deepEqual(r.evidence.filter(e => e.label.includes('절 제목')).map(e => e.detail), ['Context review', 'Task audit'])
  const unrelated = await f.inspect(data, args(b, pick(data, 'support')))
  assert.doesNotMatch(unrelated.summary, /successor/)
  assert.ok(unrelated.evidence.some(e => e.detail === 'Hand off'))
})

test('same-name copies report identical instructions and identify the specific copy containing a unique file', async t => {
  const f = await fixture(t)
  for (const root of ['.agents', '.claude', '.codex']) await f.put(root + '/skills/copies/SKILL.md', skill('copies', 'Use the package.'))
  await f.put('.claude/skills/copies/LICENSE', 'License text')
  const data = await f.scan(), shared = data.items.find(i => i.providers.includes('Shared')), claude = data.items.find(i => i.providers.includes('Claude Code'))
  const r = await f.inspect(data, args(claude.id, shared.id))
  assert.match(r.summary, /instructions match/i)
  assert.ok(r.evidence.some(e => e.detail === 'LICENSE' && e.label.includes('Claude Code')))
  const other = data.items.find(i => i.providers.includes('Codex'))
  assert.match((await f.inspect(data, args(shared.id, other.id))).summary, /identical package files/)
  const single = await f.inspect(data, args(shared.id))
  assert.ok(single.evidence.some(e => e.detail === 'LICENSE' && e.label.includes('Claude Code')))
})

test('similarly structured skills with different workflows cite a distinct step from each file', async t => {
  const f = await fixture(t)
  await f.put('.agents/skills/first/SKILL.md', skill('first', '## Review\nCheck incoming reports for missing reviewers.\n'))
  await f.put('.agents/skills/second/SKILL.md', skill('second', '## Review\nInspect pending requests before approval.\n'))
  const data = await f.scan()
  const result = await f.inspect(data, args(pick(data, 'first'), pick(data, 'second')))
  assert.deepEqual(result.evidence.filter(e => e.label === 'Distinct instruction'), [
    { label: 'Distinct instruction', detail: 'Check incoming reports for missing reviewers.', source: 'first · SKILL.md:6' },
    { label: 'Distinct instruction', detail: 'Inspect pending requests before approval.', source: 'second · SKILL.md:6' }
  ])
})

test('reports deliberate exclusions and safe text only, and rejects stale IDs or language', async t => {
  const f = await fixture(t)
  const secret = 'ghp_' + 'a'.repeat(30)
  await f.put('.agents/skills/safe/SKILL.md', skill('safe', '## ' + secret + '\n## /private/client/location\n## Normal heading\nOpen the file.', secret))
  await f.put('.agents/skills/large/SKILL.md', 'x'.repeat(66000))
  const data = await f.scan(), id = pick(data, 'safe')
  const r = await f.inspect(data, args(id))
  assert.match(r.summary, /No actionable package issue/)
  assert.ok(r.evidence.some(e => e.detail === 'Normal heading'))
  assert.doesNotMatch(JSON.stringify(r), /ghp_|private\/client/)
  const skipped = await f.inspect(data, args(data.skillExclusions[0].id))
  assert.match(skipped.evidence[0].detail, /64 KiB/)
  await assert.rejects(f.inspect(data, args(id, id)), /one or two/)
  await assert.rejects(f.inspect(data, args('disappeared')), /selection changed/)
  await assert.rejects(f.inspect(data, { ids: [id], language: 'invalid' }), /one or two/)
  await f.put('.agents/skills/safe/SKILL.md', skill('safe', 'Changed after catalog scan.'))
  assert.match((await f.inspect(data, args(id))).summary, /Incomplete check/)
})
