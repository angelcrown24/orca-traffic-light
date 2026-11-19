import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolboxManager } from './toolbox-manager.mjs'

function fixture({ scanGate, serviceGate, selectionGate } = {}) {
  let focused = 'a', scans = 0, starts = 0, removed = 0, closed = 0
  const saved = new Map(), revoked = [], prepared = []
  let onEvent
  const item = { id: 'skill-one', kind: 'skill', name: 'One', description: '', providers: ['shared'], source: 'Shared', available: true }
  const manager = createToolboxManager({
    getContext: async () => focused ? { workspaceId: focused } : null,
    getWorkspaces: async () => ({ workspaces: [{ id: 'a', path: '/project/a', hostId: 'local' }, { id: 'b', path: '/project/b', hostId: 'local' }, { id: 'remote', path: '/remote', hostId: 'ssh:remote' }] }),
    post() {}, loadSelection: async id => { await selectionGate?.(id); return saved.get(id) ?? [] }, saveSelection: async (id, ids) => { saved.set(id, ids) },
    scan: async () => { scans++; await scanGate?.(scans); return { items: [item], warnings: [], records: new Map([[item.id, { path: '/skill.md', kind: 'skill' }]]) } },
    serviceFactory: async options => { starts++; onEvent = options.onEvent; await serviceGate?.(); return {
      prepare: async input => { prepared.push(input); return { id: 'bundle-' + input.workspaceId, endpoint: 'http://127.0.0.1:1', token: 'not-in-ui', createdAt: 1 } },
      revoke: async id => { revoked.push(id) }, close: async () => { closed++ }
    } },
    bundleWriter: async () => ({ instructions: 'safe instructions', remove: async () => { removed++ } })
  })
  return { manager, saved, revoked, prepared, focus: id => { focused = id }, event: e => onEvent(e), counts: () => ({ scans, starts, removed, closed }) }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('adaptation copies only verified source metadata and returns the localized prompt if copying fails', async t => {
  const original = { id: 'mcp:' + 'a'.repeat(24), kind: 'mcp', name: 'maps', providers: ['Claude Code'],
    available: false, source: '.claude.json', providerOnly: 'provider-auth',
    description: 'private instructions', reason: 'private token', skillRequirements: 'private requirements' }
  const sibling = { ...original, id: 'mcp:' + 'b'.repeat(24), source: '/private/provider.json',
    providers: ['Codex'], providerOnly: 'tool-policy' }
  let items = [original, sibling], copied = []
  const command = { workspaceId: 'ws', id: original.id, language: 'en' }
  const manager = createToolboxManager({
    getContext: async () => ({ workspaceId: 'ws' }),
    scan: async () => ({ items, warnings: [], records: new Map([[original.id, { command: 'private command' }]]) }),
    clipboard: async text => { copied.push(text); if (copied.length === 2) throw Error('no clipboard'); return true }
  })
  t.after(() => manager.dispose())
  const en = await manager.copyAdaptation(command)
  assert.deepEqual(en, { copied: true, prompt: copied[0] })
  for (const fact of ['maps', 'Claude Code', '.claude.json', 'Authentication', 'MCP server', 'unverified']) assert.ok(en.prompt.includes(fact))
  assert.doesNotMatch(en.prompt, /private|Codex/)
  const ko = await manager.copyAdaptation({ ...command, id: sibling.id, language: 'ko' })
  assert.deepEqual(ko, { copied: false, prompt: copied[1] })
  for (const fact of ['maps', 'Codex', '도구를 제한', '미검증', '테스트']) assert.ok(ko.prompt.includes(fact))
  assert.doesNotMatch(ko.prompt, /private|Claude Code|\.claude\.json/)

  items = [{ ...original, name: '@org/tool-name' }]
  assert.match((await manager.copyAdaptation(command)).prompt, /"@org\/tool-name"/)
  items = [{ ...original, name: 'https://private.invalid/token' }]
  const redacted = (await manager.copyAdaptation(command)).prompt
  assert.ok(redacted.includes(original.id))
  assert.doesNotMatch(redacted, /private|https:/)

  // A previous catalog view or a same-name source cannot authorize an obsolete copy request.
  for (const replacement of [{ ...original, available: true }, { ...original, providerOnly: undefined },
    { ...original, providerOnly: 'toString' }, sibling]) {
    items = [replacement]
    await assert.rejects(manager.copyAdaptation(command), /source changed/)
  }
  await assert.rejects(manager.copyAdaptation({ ...command, workspaceId: 'elsewhere' }), /Workspace changed/)
  await assert.rejects(manager.copyAdaptation({ ...command, language: 'unsupported' }), /Invalid adaptation/)
  assert.equal(copied.length, 4)
})

test('a changed workspace during adaptation discovery prevents copying', async t => {
  let focused = 'first', copies = 0
  const entered = deferred(), release = deferred()
  const manager = createToolboxManager({
    getContext: async () => ({ workspaceId: focused }),
    scan: async () => {
      entered.resolve(); await release.promise
      return { items: [{ id: 'skill-one', kind: 'skill', name: 'review', available: false, providerOnly: 'explicit-invocation', providers: ['Codex'] }] }
    },
    clipboard: async () => { copies++; return true }
  })
  t.after(() => manager.dispose())
  const copying = manager.copyAdaptation({ workspaceId: 'first', id: 'skill-one', language: 'en' })
  await entered.promise
  focused = 'second'
  release.resolve()
  await assert.rejects(copying, /Workspace changed/)
  assert.equal(copies, 0)
})

test('opening state and browsing metadata never starts an MCP service', async () => {
  const f = fixture()
  assert.deepEqual((await f.manager.state()).selected, [])
  assert.equal(f.counts().scans, 0)
  await f.manager.catalog()
  assert.equal(f.counts().starts, 0)
  await f.manager.dispose()
})

test('selection is per workspace, validated, bounded, and rejects stale UI mutations', async () => {
  const f = fixture()
  await f.manager.select({ workspaceId: 'a', ids: ['skill-one'] })
  f.focus('b')
  assert.deepEqual((await f.manager.state()).selected, [])
  await assert.rejects(f.manager.select({ workspaceId: 'a', ids: [] }), /Workspace changed/)
  await assert.rejects(f.manager.select({ workspaceId: 'b', ids: ['uninstalled'] }), /unavailable/)
  await assert.rejects(f.manager.select({ workspaceId: 'b', ids: Array(25).fill('skill-one') }), /24/)
  f.focus('a')
  assert.deepEqual((await f.manager.state()).selected, ['skill-one'])
  await f.manager.dispose()
})

test('preparation pins selected records and never replaces a live bundle implicitly', async () => {
  const f = fixture()
  await f.manager.select({ workspaceId: 'a', ids: ['skill-one'] })
  const state = await f.manager.prepare({ workspaceId: 'a' })
  assert.equal(state.bundle.id, 'bundle-a')
  assert.equal(JSON.stringify(state).includes('not-in-ui'), false)
  assert.equal(f.prepared[0].workspacePath, '/project/a')
  assert.equal(f.prepared[0].records.length, 1)
  await f.manager.select({ workspaceId: 'a', ids: [] })
  assert.equal((await f.manager.state()).bundle.id, 'bundle-a')
  await f.manager.select({ workspaceId: 'a', ids: ['skill-one'] })
  await assert.rejects(f.manager.prepare({ workspaceId: 'a' }), /already prepared/)
  assert.deepEqual(f.revoked, [])
  await assert.rejects(f.manager.revoke({ workspaceId: 'a', bundleId: 'old-bundle' }), /changed/)
  await f.manager.revoke({ workspaceId: 'a', bundleId: 'bundle-a' })
  assert.deepEqual(f.revoked, ['bundle-a'])
  assert.equal(f.counts().removed, 1)
  await f.manager.dispose()
})

test('event streams stay in their workspace and remote preparation is rejected', async () => {
  const f = fixture()
  await f.manager.select({ workspaceId: 'a', ids: ['skill-one'] })
  await f.manager.prepare({ workspaceId: 'a' })
  f.event({ id: 'c1', bundleId: 'bundle-a', name: 'One', kind: 'skill', state: 'running', startedAt: 1 })
  f.focus('b')
  assert.equal((await f.manager.state()).events.length, 0)
  f.focus('a')
  assert.equal((await f.manager.state()).events.length, 1)
  f.focus('remote')
  await f.manager.select({ workspaceId: 'remote', ids: ['skill-one'] })
  await assert.rejects(f.manager.prepare({ workspaceId: 'remote' }), /local Orca workspace/)
  await f.manager.dispose()
})

test('shutdown closes the live service before a blocked metadata scan can finish', async () => {
  const entered = deferred(), release = deferred()
  const f = fixture({ scanGate: async count => { if (count === 3) { entered.resolve(); await release.promise } } })
  await f.manager.select({ workspaceId: 'a', ids: ['skill-one'] })
  await f.manager.prepare({ workspaceId: 'a' })
  f.focus('b')
  await f.manager.select({ workspaceId: 'b', ids: ['skill-one'] })
  const preparing = f.manager.prepare({ workspaceId: 'b' })
  const rejected = assert.rejects(preparing, /stopped/)
  await entered.promise
  const stopping = f.manager.dispose()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.counts().closed, 1, 'service must close while the scan remains blocked')
  assert.equal(f.counts().removed, 1)
  await assert.rejects(f.manager.catalog(), /stopped/)
  await assert.rejects(f.manager.state(), /stopped/)
  await assert.rejects(f.manager.select({ workspaceId: 'b', ids: [] }), /stopped/)
  await assert.rejects(f.manager.prepare({ workspaceId: 'b' }), /stopped/)
  release.resolve()
  await rejected
  await stopping
  await f.manager.dispose()
  assert.equal(f.counts().closed, 1)
  assert.equal(f.prepared.length, 1)
})

test('a service factory pending during shutdown closes as soon as it resolves', async () => {
  const entered = deferred(), release = deferred()
  const f = fixture({ serviceGate: async () => { entered.resolve(); await release.promise } })
  await f.manager.select({ workspaceId: 'a', ids: ['skill-one'] })
  const preparing = f.manager.prepare({ workspaceId: 'a' })
  const rejected = assert.rejects(preparing, /stopped/)
  await entered.promise
  const stopping = f.manager.dispose()
  release.resolve()
  await rejected
  await stopping
  assert.equal(f.counts().closed, 1)
  assert.equal(f.prepared.length, 0)
})

test('state refuses an old workspace snapshot when focus changes during storage loading', async () => {
  const entered = deferred(), release = deferred()
  const f = fixture({ selectionGate: async () => { entered.resolve(); await release.promise } })
  const reading = f.manager.state()
  const rejected = assert.rejects(reading, /Workspace changed/)
  await entered.promise
  f.focus('b')
  release.resolve()
  await rejected
  await f.manager.dispose()
})
