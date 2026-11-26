import { createSkillMaintenance } from './skill-maintenance.mjs'
import { createReviewRequests } from './review-manager.mjs'
import { compareSources } from './source-comparison.mjs'
import { scanCatalog, resolveRecord } from './catalog.mjs'
import { createToolboxService } from './service.mjs'
import { writeBundle } from './bundle-store.mjs'
import { copyText } from './clipboard.mjs'
import { adaptationPrompt } from './provider-adaptation.mjs'
import { createAutomation } from './automation.mjs'
import { syncCapabilities, unshareSkill } from './shared-sync.mjs'

const MAX_SELECTION = 24
export function createToolboxManager({ getContext, getWorkspaces, post, postSkillsChanged = () => {}, postBatchProgress = () => {}, home, maintenance = createSkillMaintenance({ home }), loadSelection = async () => [], saveSelection = async () => {}, loadAutomation = async () => [], saveAutomation = async () => {}, scan = () => scanCatalog({ home }), serviceFactory = createToolboxService, bundleWriter = writeBundle, clipboard = copyText, automationFactory = createAutomation, synchronizer = input => syncCapabilities({ ...input, home }) }) {
  const workspaces = new Map()
  const bundles = new Map()
  const locks = new Map()
  let catalogCache = null
  let scanPending = null
  let servicePromise = null
  let disposed = false
  let disposePromise = null
  let automationPromise = null
  let initializePromise = null
  let connectionStatus = { setup: false, providers: [], workspaces: [] }
  const automatic = new Map(), activeAutomatic = new Set(), automaticErrors = new Map()
  const error = (message) => { throw new Error(message) }
  const assertActive = () => { if (disposed) error('The plugin has stopped.') }
  const assertWorkspace = id => { if (typeof id !== 'string' || !id || id.length > 2048) error('A workspace is required.') }
  async function context(expected) {
    assertActive()
    const ctx = await getContext()
    assertActive()
    const id = ctx?.workspaceId ?? null
    if (expected !== undefined && (!id || id !== expected)) error('Workspace changed. Select the current workspace and try again.')
    return id
  }
  async function local(id) {
    assertActive()
    if (!workspaces.has(id)) {
      const saved = await loadSelection(id)
      assertActive()
      if (!workspaces.has(id)) workspaces.set(id, { selected: Array.isArray(saved) ? saved.filter(x => typeof x === 'string').slice(0, MAX_SELECTION) : [], bundle: null, events: [], recommendations: [], recommendationUses: new Map() })
    }
    return workspaces.get(id)
  }
  function snapshot(id, state) {
    return { workspaceId: id, selected: [...state.selected], bundle: state.bundle, events: state.events.map(e => ({ ...e })), automation: {
      enabled: activeAutomatic.has(id), setup: connectionStatus.setup, managed: Boolean(connectionStatus.managed),
      needsUpdate: Boolean(connectionStatus.needsUpdate), providers: connectionStatus.providers,
      sessions: connectionStatus.workspaces?.find(entry => entry.workspaceId === id)?.sessions ?? 0,
      appliedIds: automatic.get(id)?.records.map(record => record.id) ?? [],
      ...(automaticErrors.has(id) || automaticErrors.has('*') ? { error: automaticErrors.get(id) ?? automaticErrors.get('*') } : {})
    } }
  }
  async function scanNow(fresh = false) {
    assertActive()
    // A mutation must not return a scan that began before its filesystem changes.
    if (fresh && scanPending) await scanPending.catch(() => {})
    assertActive()
    if (!scanPending) {
      const pending = scan().then(result => {
        assertActive()
        if (scanPending === pending) catalogCache = result
        return result
      }).finally(() => { if (scanPending === pending) scanPending = null })
      scanPending = pending
    }
    return scanPending
  }
  async function catalog() {
    const result = await scanNow()
    return { items: result.items, warnings: result.warnings }
  }
  async function activity() {
    const workspaceId = await context()
    const current = workspaces.get(workspaceId)
    if (!current) return { workspaceId, recommendations: [], events: [] }
    const events = new Map()
    for (const uses of current.recommendationUses.values()) for (const row of uses) events.set(row.id, row)
    for (const row of current.events) events.set(row.id, row)
    return { workspaceId, recommendations: current.recommendations.map(row => ({ ...row })),
      events: [...events.values()].sort((a, b) => a.startedAt - b.startedAt).map(row => ({ ...row })) }
  }
  async function state() {
    await initialize()
    const id = await context()
    if (!id) return { workspaceId: null, selected: [], bundle: null, events: [] }
    const current = await local(id)
    connectionStatus = await (await automation()).status()
    await context(id)
    return snapshot(id, current)
  }
  async function automation() {
    assertActive()
    if (!automationPromise) automationPromise = Promise.resolve().then(() => automationFactory({ home, onRecommendations: (workspaceId, rows) => {
      if (disposed) return
      const current = workspaces.get(workspaceId)
      if (!current) return
      const ids = new Set(rows.map(row => row.id))
      current.recommendations = [...current.recommendations.filter(row => !ids.has(row.id)), ...rows].slice(-100)
      const retained = new Set(current.recommendations.map(row => row.id))
      for (const id of current.recommendationUses.keys()) if (!retained.has(id)) current.recommendationUses.delete(id)
      post()
    }, onEvent: ({ workspaceId, sessionId, ...event }) => {
      if (disposed) return
      const current = workspaces.get(workspaceId)
      if (!current) return
      current.events = [...current.events.filter(e => e.id !== event.id), event].slice(-100)
      if (event.recommendationId && current.recommendations.some(row => row.id === event.recommendationId)) {
        const uses = current.recommendationUses.get(event.recommendationId) ?? []
        const recent = [...uses.filter(row => row.id !== event.id), event]
        current.recommendationUses.set(event.recommendationId, recent.slice(-8))
      }
      post()
    } })).then(async runner => {
      if (disposed) { await runner.close(); error('The plugin has stopped.') }
      return runner
    }).catch(err => { automationPromise = null; throw err })
    return automationPromise
  }
  function selectedRecords(data, ids) {
    return ids.map(id => {
      const item = data.items.find(item => item.id === id && item.available)
      const record = data.records.get(id)
      if (!item || !record) error('A selected item changed. Refresh the library and select it again.')
      if (item.sharing?.state === 'update' || item.sharing?.state === 'conflict') error('A shared capability needs synchronization or conflict resolution before applying it.')
      return { ...record, id, name: item.name, kind: item.kind }
    })
  }
  async function workspaceFor(id) {
    const result = await getWorkspaces()
    const workspace = result.workspaces.find(entry => entry.id === id)
    if (!workspace || (workspace.hostId && workspace.hostId !== 'local')) error('Preparing a bundle requires a local Orca workspace.')
    return workspace
  }
  function initialize() {
    if (!initializePromise) initializePromise = (async () => {
      const saved = await loadAutomation()
      assertActive()
      if (!Array.isArray(saved) || !saved.length) return
      const data = await scanNow()
      for (const entry of saved.slice(0, 24)) {
        if (!entry || typeof entry.workspaceId !== 'string' || !Array.isArray(entry.records) || !entry.records.length || entry.records.length > MAX_SELECTION || entry.records.some(record => typeof record?.id !== 'string' || typeof record?.fingerprint !== 'string')) continue
        automatic.set(entry.workspaceId, entry)
        try {
          const records = selectedRecords(data, entry.records.map(record => record.id))
          if (records.some((record, i) => record.fingerprint !== entry.records[i].fingerprint)) error('A capability changed. Review the selection and apply it again to resume automatic access.')
          const workspace = await workspaceFor(entry.workspaceId)
          await local(entry.workspaceId)
          const runner = await automation()
          assertActive()
          if (!(await runner.status()).setup) error('Review the agent instructions before restoring automatic access.')
          await runner.grant({ workspaceId: entry.workspaceId, workspacePath: workspace.path, records, items: data.items.filter(item => records.some(record => record.id === item.id)) })
          assertActive()
          activeAutomatic.add(entry.workspaceId)
        } catch (cause) {
          if (disposed) throw cause
          automaticErrors.set(entry.workspaceId, cause.message ?? 'Automatic access could not be restored. Apply the selection again.')
        }
      }
      if (automationPromise) connectionStatus = await (await automationPromise).status()
    })().catch(cause => {
      if (!disposed) automaticErrors.set('*', 'Automatic settings could not be loaded. Apply the selection again.')
    })
    return initializePromise
  }
  async function previewAgentInstructions({ workspaceId }) {
    await context(workspaceId)
    await workspaceFor(workspaceId)
    const result = await (await automation()).previewBootstrap()
    await context(workspaceId)
    return result
  }
  async function setAutomation({ workspaceId, enabled, instructionRevision }) {
    await initialize()
    return locked('$automation', () => locked(workspaceId, async () => {
      await context(workspaceId)
      if (typeof enabled !== 'boolean') error('Choose whether automatic access is enabled.')
      const current = await local(workspaceId)
      const runner = await automation()
      if (enabled) {
        if (!current.selected.length) error('Select a skill or tool first.')
        if (!automatic.has(workspaceId) && automatic.size >= 24) error('Automatic access is limited to 24 workspaces.')
        const selected = [...current.selected]
        const data = await scanNow(true)
        const records = selectedRecords(data, selected)
        const items = data.items.filter(item => selected.includes(item.id))
        const workspace = await workspaceFor(workspaceId)
        await context(workspaceId)
        const installed = await runner.status()
        if (!installed.setup || installed.needsUpdate) {
          if (typeof instructionRevision !== 'string' || !instructionRevision) error('Review the instruction files and confirm installation first.')
          const preview = await runner.previewBootstrap()
          if (preview.revision !== instructionRevision) error('The instruction files changed. Review their locations again.')
          await context(workspaceId)
          await runner.prepare?.()
          await context(workspaceId)
          const configured = await runner.enableBootstrap(instructionRevision)
          if (configured?.setup === false) error('Shared instruction setup is incomplete. Check the provider connection status.')
        }
        await context(workspaceId)
        const entry = { workspaceId, records: records.map(({ id, fingerprint }) => ({ id, fingerprint })) }
        const previous = [...automatic.values()]
        const next = new Map(automatic); next.set(workspaceId, entry)
        await saveAutomation([...next.values()])
        try {
          assertActive()
          await runner.grant({ workspaceId, workspacePath: workspace.path, records, items })
        } catch (cause) {
          await saveAutomation(previous).catch(() => {})
          throw cause
        }
        assertActive()
        automatic.set(workspaceId, entry)
        activeAutomatic.add(workspaceId)
      } else {
        const next = new Map(automatic); next.delete(workspaceId)
        await saveAutomation([...next.values()])
        automatic.delete(workspaceId)
        await runner.revoke(workspaceId)
        activeAutomatic.delete(workspaceId)
      }
      assertActive()
      automaticErrors.delete(workspaceId)
      automaticErrors.delete('*')
      connectionStatus = await runner.status()
      post()
      return snapshot(workspaceId, current)
    })).catch(cause => {
      if (!disposed) { automaticErrors.set(workspaceId, cause.message ?? 'Automatic access could not be updated.'); post() }
      throw cause
    })
  }
  async function removeAgentInstructions({ workspaceId }) {
    await initialize()
    return locked('$automation', () => locked(workspaceId, async () => {
      await context(workspaceId)
      await workspaceFor(workspaceId)
      const current = await local(workspaceId)
      const runner = await automation()
      const status = await runner.status()
      if (status.managed || status.setup || automatic.size) {
        // Claim runtime ownership before changing any other workspace's authorizations.
        await runner.prepare?.()
        await context(workspaceId)
        await saveAutomation([])
        const grants = [...automatic.keys()]
        automatic.clear()
        activeAutomatic.clear()
        automaticErrors.clear()
        try {
          for (const id of grants) await runner.revoke(id)
          await runner.disableBootstrap()
        } finally {
          await runner.close()
          automationPromise = null
          post()
        }
      }
      connectionStatus = await (await automation()).status()
      return snapshot(workspaceId, current)
    })).catch(cause => {
      if (!disposed) { automaticErrors.set(workspaceId, cause.message ?? 'Agent instructions could not be removed.'); post() }
      throw cause
    })
  }
  async function compare({ id }) {
    return compareSources(await scanNow(), id)
  }
  async function unshare({ workspaceId, key, revision }) {
    return locked('$sync', () => locked(workspaceId, async () => {
      const checkContext = async () => { await context(workspaceId); await workspaceFor(workspaceId); await context(workspaceId) }
      await checkContext()
      const data = await scanNow(true)
      const target = data.items.find(item => item.kind === 'skill' && item.sharing?.unshareKey === key)
      if (!target) error('The sharing registration changed. Refresh the library.')
      const result = await unshareSkill({ home, key, revision, workspaceId, checkContext })
      if (result.status === 'removed') {
        const next = await scanNow(true), owner = await local(workspaceId)
        if (!next.items.some(item => item.id === target.id) && owner.selected.includes(target.id)) {
          const ids = owner.selected.filter(id => id !== target.id)
          await saveSelection(workspaceId, ids); owner.selected = ids
        }
        post()
      } else await checkContext()
      return result
    }))
  }
  async function sync({ workspaceId, ids, preserveProviderCopies, reviewedSourceStamp }) {
    return locked('$sync', () => locked(workspaceId, async () => {
      await context(workspaceId)
      if (!Array.isArray(ids) || !ids.length || ids.length > MAX_SELECTION || ids.some(id => typeof id !== 'string')) error('Choose up to 24 capabilities to share.')
      const current = await local(workspaceId)
      await context(workspaceId)
      const { results } = await synchronizer({ ids: [...new Set(ids)], ...(preserveProviderCopies === true ? { preserveProviderCopies: true } : {}),
        ...(reviewedSourceStamp !== undefined ? { reviewedSourceStamp } : {}) })
      assertActive()
      const replacements = new Map(results.filter(result => result.newId && ['synced', 'unchanged'].includes(result.status)).map(result => [result.id, result.newId]))
      const selected = [...new Set(current.selected.map(id => replacements.get(id) ?? id))]
      await saveSelection(workspaceId, selected)
      current.selected = selected
      const data = await scanNow(true)
      post()
      return { results, catalog: { items: data.items, warnings: data.warnings } }
    }))
  }
  function locked(id, operation) {
    assertActive()
    assertWorkspace(id)
    const before = locks.get(id) ?? Promise.resolve()
    const result = before.catch(() => {}).then(() => { assertActive(); return operation() })
    locks.set(id, result)
    result.finally(() => { if (locks.get(id) === result) locks.delete(id) }).catch(() => {})
    return result
  }
  async function select({ workspaceId, ids }) {
    return locked(workspaceId, async () => {
      await context(workspaceId)
      if (!Array.isArray(ids) || ids.length > MAX_SELECTION || ids.some(id => typeof id !== 'string')) error('Select up to 24 items.')
      const data = catalogCache ?? await scanNow()
      const unique = [...new Set(ids)]
      if (unique.some(id => !data.items.some(item => item.id === id && item.available))) error('An item is unavailable. Refresh the library.')
      const current = await local(workspaceId)
      await context(workspaceId)
      await saveSelection(workspaceId, unique)
      assertActive()
      current.selected = unique
      post()
      return snapshot(workspaceId, current)
    })
  }
  async function service() {
    assertActive()
    if (!servicePromise) servicePromise = Promise.resolve().then(() => {
      assertActive()
      return serviceFactory({ resolveRecord, onEvent: event => {
        if (disposed) return
        const owner = bundles.get(event.bundleId)
        if (!owner) return
        const current = workspaces.get(owner.workspaceId)
        if (!current) return
        current.events = [...current.events.filter(e => e.id !== event.id), event].slice(-100)
        post()
      } })
    }).then(async runner => {
      if (disposed) { await runner.close(); error('The plugin has stopped.') }
      return runner
    }).catch(err => { servicePromise = null; throw err })
    return servicePromise
  }
  async function prepare({ workspaceId }) {
    return locked(workspaceId, async () => {
      await context(workspaceId)
      const current = await local(workspaceId)
      if (!current.selected.length) error('Select a skill or tool first.')
      // Reuse an existing immutable bundle; preparing again must not destroy an active one.
      if (current.bundle) error('A bundle is already prepared. Revoke it explicitly before preparing another.')
      const data = await scanNow(true)
      const records = selectedRecords(data, current.selected)
      const workspace = await workspaceFor(workspaceId)
      await context(workspaceId)
      const runner = await service()
      if (disposed) error('The plugin has stopped.')
      const connection = await runner.prepare({ workspaceId, workspacePath: workspace.path, records })
      let file
      try {
        file = await bundleWriter(connection)
        await context(workspaceId)
        if (disposed) error('The plugin has stopped.')
        current.bundle = { id: connection.id, names: records.map(record => record.name), instructions: file.instructions, createdAt: connection.createdAt }
        bundles.set(connection.id, { workspaceId, remove: file.remove })
        post()
        return snapshot(workspaceId, current)
      } catch (err) {
        await runner.revoke(connection.id)
        await file?.remove()
        throw err
      }
    })
  }
  async function revoke({ workspaceId, bundleId }) {
    return locked(workspaceId, async () => {
      await context(workspaceId)
      const current = await local(workspaceId)
      if (current.bundle && current.bundle.id !== bundleId) error('The prepared bundle changed. Refresh before revoking.')
      if (current.bundle) {
        const id = current.bundle.id
        if (servicePromise) await (await servicePromise).revoke(id)
        await bundles.get(id)?.remove()
        bundles.delete(id)
        current.bundle = null
        post()
      }
      return snapshot(workspaceId, current)
    })
  }
  function dispose() {
    if (disposePromise) return disposePromise
    disposed = true
    // Orca grants only a short shutdown window. Close running clients immediately,
    // even if an unrelated metadata scan or storage operation is still pending.
    const closing = servicePromise?.then(runner => runner.close(), () => {})
    const closingAutomation = automationPromise?.then(runner => runner.close(), () => {})
    const removing = [...bundles.values()].map(bundle => bundle.remove())
    bundles.clear()
    disposePromise = (async () => {
      await Promise.allSettled([closing, closingAutomation, ...removing])
      await Promise.allSettled([...locks.values()])
    })()
    return disposePromise
  }
  async function copy({ workspaceId, bundleId }) {
    assertWorkspace(workspaceId)
    await context(workspaceId)
    const current = await local(workspaceId)
    if (!current.bundle || current.bundle.id !== bundleId) error('The prepared bundle changed. Refresh before copying.')
    return { copied: await clipboard(current.bundle.instructions) }
  }
  async function copyAdaptation({ workspaceId, id, language }) {
    assertWorkspace(workspaceId)
    if (typeof id !== 'string' || !id || id.length > 180 || (language !== 'ko' && language !== 'en')) error('Invalid adaptation request.')
    await context(workspaceId)
    const data = await scanNow(true)
    const prompt = adaptationPrompt(data.items.find(item => item.id === id), language)
    await context(workspaceId)
    let copied = false
    try { copied = await clipboard(prompt) === true } catch { /* The panel can still show the prompt for manual copying. */ }
    return { copied, prompt }
  }
  const reviews = createReviewRequests({ context, workspaceFor, getWorkspaces, loadSelection,
    selectedFor: async id => (await local(id)).selected, scanNow, clipboard, maintenance, home, postBatchProgress,
    lock: (workspaceId, run) => locked('$sync', () => locked(workspaceId, run)),
    changed: () => {
      catalogCache = null
      scanPending = null
      // The write is already committed. A closing panel recovers the result from history.
      if (!disposed) Promise.resolve().then(postSkillsChanged).catch(() => {})
    } })
  return { ...reviews, catalog, activity, state, select, prepare, revoke, copy, copyAdaptation, initialize, previewAgentInstructions, setAutomation, removeAgentInstructions, sync, unshare, compare, dispose }
}
