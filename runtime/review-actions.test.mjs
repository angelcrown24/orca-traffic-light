import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolboxManager } from './toolbox-manager.mjs'

async function installed(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'orca-review-actions-')))
  const root = join(home, '.agents/skills/check-docs')
  const body = '---\nname: check-docs\ndescription: Check reports\n---\nRead `references/guide.md`\n'
  const file = join(root, 'SKILL.md')
  await mkdir(join(root, 'references/new'), { recursive: true })
  await writeFile(join(root, 'references/new/guide.md'), 'Report checklist.')
  await writeFile(file, body)
  await mkdir(join(home, '.codex/skills'), { recursive: true })
  await symlink(root, join(home, '.codex/skills/check-docs'))
  let workspace = 'local-a', notifications = 0
  const selected = new Map()
  function manager() {
    const m = createToolboxManager({ home, getContext: async () => ({ workspaceId: workspace }), getWorkspaces: async () => ({
      workspaces: ['local-a', 'local-b', 'remote'].map(id => ({ id, hostId: id === 'remote' ? 'ssh:other' : 'local' }))
    }), loadSelection: async id => selected.get(id) ?? [], saveSelection: async (id, ids) => selected.set(id, ids),
    post: () => {}, postSkillsChanged: () => notifications++ })
    t.after(() => m.dispose())
    return m
  }
  t.after(() => rm(home, { recursive: true, force: true }))
  const m = manager()
  const { items } = await m.catalog()
  const id = items.find(row => row.name === 'check-docs').id
  return { home, manager, m, file, id, body, selected, focus: id => { workspace = id }, notifications: () => notifications }
}

test('repair, rescan, undo, archive and restore through the workspace manager', async t => {
  const f = await installed(t), workspaceId = 'local-a'
  const base = { workspaceId, id: f.id, kind: 'edit' }
  f.selected.set(workspaceId, [f.id])
  const start = await f.m.skillReview({ workspaceId })
  assert.deepEqual(start.findings.find(f => f.kind === 'missing').referenceFixes, [
    { from: 'references/guide.md', to: 'references/new/guide.md', line: 5 }
  ])
  const proposal = await f.m.previewSkillChange(base)
  assert.deepEqual(proposal.referenceFixes, start.findings[0].referenceFixes)
  assert.equal(proposal.body, f.body)
  assert.deepEqual(proposal.providers.sort(), ['Codex', 'Shared'])
  assert.equal(proposal.selectedWorkspaces, 1)
  const fixed = f.body.replace('references/guide.md', 'references/new/guide.md')
  const receipt = await f.m.applySkillChange({ ...base, revision: proposal.revision, body: fixed })
  assert.equal(await readFile(f.file, 'utf8'), fixed)
  assert.deepEqual((await f.m.skillReview({ workspaceId })).findings, [])
  const reopened = f.manager()
  assert.deepEqual(await reopened.skillChangeHistory({ workspaceId }), [receipt])
  await reopened.undoSkillChange({ workspaceId, receiptId: receipt.id })
  assert.equal(await readFile(f.file, 'utf8'), f.body)
  const remove = { ...base, kind: 'remove' }
  const plan = await reopened.previewSkillChange(remove)
  assert.equal('body' in plan, false)
  const deletion = await reopened.applySkillChange({ ...remove, revision: plan.revision })
  assert.equal((await reopened.catalog()).items.some(row => row.id === f.id), false)
  assert.deepEqual(f.selected.get(workspaceId), [f.id])
  await reopened.undoSkillChange({ workspaceId, receiptId: deletion.id })
  assert.equal((await reopened.catalog()).items.some(row => row.id === f.id), true)
  assert.deepEqual(await reopened.skillChangeHistory({ workspaceId }), [])
  assert.equal(f.notifications(), 4)
})

test('previews are tied to the local workspace, copy and selection impact; stale confirmations cannot write', async t => {
  const f = await installed(t)
  const action = { workspaceId: 'local-a', kind: 'remove', id: f.id }
  const { revision } = await f.m.previewSkillChange(action)
  f.selected.set('local-b', [f.id])
  await assert.rejects(f.m.applySkillChange({ ...action, revision }), /STALE/)
  f.focus('local-b')
  await assert.rejects(f.m.applySkillChange({ ...action, revision }), /Workspace changed/)
  await assert.rejects(f.m.applySkillChange({ ...action, workspaceId: 'local-b', revision }), /STALE/)
  f.focus('remote')
  await assert.rejects(f.m.previewSkillChange({ ...action, workspaceId: 'remote' }), /local Orca workspace/)
  assert.equal(await readFile(f.file, 'utf8'), f.body)
  assert.equal(f.notifications(), 0)
})

test('a moved-file suggestion is checked again when the editor opens', async t => {
  const f = await installed(t), workspaceId = 'local-a'
  const result = await f.m.skillReview({ workspaceId })
  assert.equal(result.findings[0].referenceFixes.length, 1)
  await rm(join(f.home, '.agents/skills/check-docs/references/new/guide.md'))
  const edit = await f.m.previewSkillChange({ workspaceId, id: f.id, kind: 'edit' })
  assert.equal(edit.status, 'ready')
  assert.deepEqual(edit.referenceFixes, [])
})
