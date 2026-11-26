import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolboxManager } from './toolbox-manager.mjs'

function fixture(initial = [], options = {}) {
  let focused = 'a', persisted = initial, setup = options.installed ?? initial.length > 0, closed = false, fingerprint = 'first', events, recommendations, failSave = false
  const grants = new Map(), saved = new Map(), revoked = [], shared = []
  const items = ['one', 'two'].map(id => ({ id, kind: 'skill', name: id, providers: ['Codex'], available: true }))
  const manager = createToolboxManager({
    getContext: async () => ({ workspaceId: focused }),
    getWorkspaces: async () => ({ workspaces: ['a', 'b'].map(id => ({ id, path: '/projects/' + id, hostId: 'local' })) }),
    post() {}, loadSelection: async id => saved.get(id) ?? [], saveSelection: async (id, ids) => saved.set(id, ids),
    loadAutomation: async () => persisted, saveAutomation: async value => { if (failSave) throw new Error('Storage unavailable'); persisted = value },
    scan: async () => ({ items, warnings: [], records: new Map(items.map(item => [item.id, { ...item, fingerprint, path: '/skills/' + item.id }])) }),
    automationFactory: async ({ onEvent, onRecommendations }) => {
      events = onEvent
      recommendations = onRecommendations
      return {
        previewBootstrap: async () => ({files:[], revision:'reviewed'}),
        disableBootstrap: async () => { setup = false; return {setup, providers:[],workspaces:[]} },
        enableBootstrap: async revision => { assert.equal(revision,'reviewed'); await options.bootstrap?.(); setup = true },
        grant: async value => { grants.set(value.workspaceId, value) },
        revoke: async id => { grants.delete(id); revoked.push(id) },
        status: async () => ({ setup, managed: setup, providers: [{ name: 'Codex', state: 'ready' }], workspaces: [...grants.keys()].map(workspaceId => ({ workspaceId, sessions: 1 })) }),
        close: async () => { closed = true; grants.clear() }
      }
    },
    synchronizer: async ({ ids }) => { shared.push(ids); return { results: ids.map(id => ({ id, newId: 'two', name: id, status: 'synced', message: 'Shared' })) } }
  })
  return { manager, grants, revoked, shared, persisted: () => persisted, closed: () => closed,
    focus: id => { focused = id }, recommend: (id, rows) => recommendations(id, rows), change: () => { fingerprint = 'changed' }, event: e => events(e), failSave: () => { failSave = true } }
}

test('automation requires a selection and pins explicit applied scope independently of draft edits', async () => {
  const f = fixture()
  await assert.rejects(f.manager.setAutomation({ workspaceId: 'a', enabled: true, instructionRevision: 'reviewed' }), /Select/)
  await f.manager.select({ workspaceId: 'a', ids: ['one'] })
  const state = await f.manager.setAutomation({ workspaceId: 'a', enabled: true, instructionRevision: 'reviewed' })
  assert.equal(state.automation.enabled, true)
  assert.equal(state.automation.setup, true)
  assert.deepEqual(state.automation.appliedIds, ['one'])
  assert.equal(f.grants.get('a').workspacePath, '/projects/a')
  assert.deepEqual(f.persisted(), [{ workspaceId: 'a', records: [{ id: 'one', fingerprint: 'first' }] }])
  await f.manager.select({ workspaceId: 'a', ids: ['two'] })
  assert.deepEqual((await f.manager.state()).automation.appliedIds, ['one'])
  assert.equal(f.grants.get('a').records[0].id, 'one')
  await f.manager.setAutomation({ workspaceId: 'a', enabled: true, instructionRevision: 'reviewed' })
  assert.equal(f.grants.get('a').records[0].id, 'two')
  await f.manager.setAutomation({ workspaceId: 'a', enabled: false })
  assert.equal((await f.manager.state()).automation.enabled, false)
  assert.deepEqual(f.revoked, ['a'])
  assert.deepEqual(f.persisted(), [])
  await f.manager.dispose()
  assert.equal(f.closed(), true)
})

test('restoration checks pinned source fingerprints and never grants changed sources automatically', async () => {
  const f = fixture([{ workspaceId: 'a', records: [{ id: 'one', fingerprint: 'first' }] }])
  f.change()
  await f.manager.initialize()
  const state = await f.manager.state()
  assert.equal(state.automation.enabled, false)
  assert.match(state.automation.error, /changed/)
  assert.equal(f.grants.size, 0)
  await f.manager.select({ workspaceId: 'a', ids: ['one'] })
  await f.manager.setAutomation({ workspaceId: 'a', enabled: true, instructionRevision: 'reviewed' })
  assert.equal(f.grants.size, 1)
  assert.equal((await f.manager.state()).automation.error, undefined)
  await f.manager.dispose()
})

test('restored automatic grants use their workspace path even when another workspace is focused', async () => {
  const f = fixture([{ workspaceId: 'a', records: [{ id: 'one', fingerprint: 'first' }] }])
  f.focus('b')
  await f.manager.initialize()
  assert.equal(f.grants.get('a').workspacePath, '/projects/a')
  assert.equal((await f.manager.state()).automation.enabled, false)
  f.event({ workspaceId: 'a', id: 'call', bundleId: 'session', name: 'one', kind: 'skill', state: 'running', startedAt: 1 })
  assert.equal((await f.manager.state()).events.length, 0)
  f.focus('a')
  assert.equal((await f.manager.state()).events.length, 1)
  assert.equal((await f.manager.state()).automation.sessions, 1)
  await f.manager.dispose()
})

test('Activity deduplicates recent Jev results and preserves linked use across unrelated traffic only in the originating workspace', async () => {
  const f = fixture([{ workspaceId: 'a', records: [{ id: 'one', fingerprint: 'first' }] }])
  await f.manager.initialize()
  const suggested = { id: 'suggestion', name: 'one', kind: 'skill', at: 1 }
  f.recommend('a', [suggested])
  f.recommend('a', [{ ...suggested, at: 2 }])
  const used = { id: 'read', bundleId: 'fixture', operation: 'skill', kind: 'skill', name: 'one', state: 'succeeded', startedAt: 2, recommendationId: suggested.id }
  f.event({ workspaceId: 'a', sessionId: 'private handle', ...used })
  for (let i = 0; i < 101; i++) f.event({ workspaceId: 'a', id: 'direct' + i, name: 'direct call', startedAt: i + 3 })
  const a = await f.manager.activity()
  assert.equal(a.recommendations.length, 1)
  assert.equal(a.recommendations[0].at, 2)
  assert.equal(a.events.length, 101)
  assert.deepEqual(a.events[0], used)
  f.focus('b')
  assert.deepEqual(await f.manager.activity(), { workspaceId: 'b', recommendations: [], events: [] })
  await f.manager.dispose()
})

test('sync remaps only draft selections and refuses stale workspace requests', async () => {
  const f = fixture()
  await f.manager.select({ workspaceId: 'a', ids: ['one'] })
  await f.manager.setAutomation({ workspaceId: 'a', enabled: true, instructionRevision: 'reviewed' })
  await f.manager.sync({ workspaceId: 'a', ids: ['one'] })
  const state = await f.manager.state()
  assert.deepEqual(state.selected, ['two'])
  assert.deepEqual(state.automation.appliedIds, ['one'])
  assert.deepEqual(f.shared, [['one']])
  f.focus('b')
  await assert.rejects(f.manager.sync({ workspaceId: 'a', ids: ['two'] }), /Workspace changed/)
  await assert.rejects(f.manager.setAutomation({ workspaceId: 'a', enabled: false }), /Workspace changed/)
  await f.manager.dispose()
})

test('a failed settings save leaves the previous grant and its running sessions intact', async () => {
  const f = fixture()
  await f.manager.select({ workspaceId: 'a', ids: ['one'] })
  await f.manager.setAutomation({ workspaceId: 'a', enabled: true, instructionRevision: 'reviewed' })
  await f.manager.select({ workspaceId: 'a', ids: ['two'] })
  f.failSave()
  await assert.rejects(f.manager.setAutomation({ workspaceId: 'a', enabled: true, instructionRevision: 'reviewed' }), /Storage unavailable/)
  assert.deepEqual(f.revoked, [])
  assert.equal(f.grants.get('a').records[0].id, 'one')
  const state = await f.manager.state()
  assert.equal(state.automation.enabled, true)
  assert.deepEqual(state.automation.appliedIds, ['one'])
  assert.match(state.automation.error, /Storage unavailable/)
  await f.manager.dispose()
})

test('selection changes wait for an in-flight apply, keeping its records and search metadata consistent', async () => {
  let enter, release
  const entered = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const f = fixture([], { bootstrap: async () => { enter(); await gate } })
  await f.manager.select({ workspaceId: 'a', ids: ['one'] })
  const applying = f.manager.setAutomation({ workspaceId: 'a', enabled: true, instructionRevision: 'reviewed' })
  await entered
  const selecting = f.manager.select({ workspaceId: 'a', ids: ['two'] })
  release()
  await applying
  await selecting
  assert.deepEqual(f.grants.get('a').items.map(item => item.id), ['one'])
  assert.deepEqual(f.grants.get('a').records.map(item => item.id), ['one'])
  const state = await f.manager.state()
  assert.deepEqual(state.selected, ['two'])
  assert.deepEqual(state.automation.appliedIds, ['one'])
  await f.manager.dispose()
})

test('sync waits out an older inventory scan and returns the newly published catalog', async () => {
  let scans = 0, id = 'one', release, entered, synchronized
  const scanGate = new Promise(resolve => { release = resolve })
  const scanning = new Promise(resolve => { entered = resolve })
  const changed = new Promise(resolve => { synchronized = resolve })
  const manager = createToolboxManager({
    getContext: async () => ({ workspaceId: 'a' }), getWorkspaces: async () => ({ workspaces: [] }), post() {},
    scan: async () => {
      const item = { id, kind: 'skill', name: id, available: true }
      if (++scans === 2) { entered(); await scanGate }
      return { items: [item], warnings: [], records: new Map([[item.id, item]]) }
    },
    synchronizer: async () => { id = 'two'; synchronized(); return { results: [{ id: 'one', newId: 'two', status: 'synced' }] } }
  })
  await manager.select({ workspaceId: 'a', ids: ['one'] })
  const browsing = manager.catalog()
  await scanning
  const syncing = manager.sync({ workspaceId: 'a', ids: ['one'] })
  await changed
  release()
  await browsing
  const result = await syncing
  assert.deepEqual(result.catalog.items.map(item => item.id), ['two'])
  assert.deepEqual((await manager.state()).selected, ['two'])
  await manager.dispose()
})

test('first connect cannot install or grant before confirmation, and removal revokes every workspace', async () => {
  const f = fixture()
  await f.manager.select({workspaceId:'a', ids:['one']})
  await assert.rejects(f.manager.setAutomation({workspaceId:'a',enabled:true}), /confirm/i)
  assert.deepEqual(f.persisted(), [])
  assert.equal(f.grants.size, 0)
  const plan = await f.manager.previewAgentInstructions({workspaceId:'a'})
  await f.manager.setAutomation({workspaceId:'a',enabled:true,instructionRevision:plan.revision})
  f.focus('b')
  await f.manager.select({workspaceId:'b',ids:['two']})
  await f.manager.setAutomation({workspaceId:'b',enabled:true})
  assert.equal(f.grants.size, 2)
  await assert.rejects(f.manager.removeAgentInstructions({workspaceId:'a'}), /Workspace changed/)
  assert.equal(f.grants.size, 2)
  await f.manager.removeAgentInstructions({workspaceId:'b'})
  assert.deepEqual(f.persisted(), [])
  assert.equal(f.grants.size,0)
  assert.equal((await f.manager.state()).automation.setup,false)
  await f.manager.dispose()
})

test('global instructions remain discoverable after restart with all workspaces off', async () => {
  const f=fixture([], {installed:true})
  assert.equal((await f.manager.state()).automation.managed, true)
  await f.manager.removeAgentInstructions({workspaceId:'a'})
  assert.equal((await f.manager.state()).automation.managed,false)
  await f.manager.dispose()
})
