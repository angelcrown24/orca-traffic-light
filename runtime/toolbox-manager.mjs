import { scanCatalog, resolveRecord } from './catalog.mjs'
import { createToolboxService } from './service.mjs'
import { writeBundle } from './bundle-store.mjs'
import { copyText } from './clipboard.mjs'

const MAX_SELECTION = 24
export function createToolboxManager({ getContext, getWorkspaces, post, loadSelection = async () => [], saveSelection = async () => {}, scan = scanCatalog, serviceFactory = createToolboxService, bundleWriter = writeBundle, clipboard = copyText }) {
  const workspaces = new Map()
  const bundles = new Map()
  const locks = new Map()
  let catalogCache = null
  let scanPending = null
  let servicePromise = null
  let disposed = false
  let disposePromise = null
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
      if (!workspaces.has(id)) workspaces.set(id, { selected: Array.isArray(saved) ? saved.filter(x => typeof x === 'string').slice(0, MAX_SELECTION) : [], bundle: null, events: [] })
    }
    return workspaces.get(id)
  }
  function snapshot(id, state) {
    return { workspaceId: id, selected: [...state.selected], bundle: state.bundle, events: state.events.map(e => ({ ...e })) }
  }
  async function scanNow() {
    assertActive()
    if (!scanPending) scanPending = scan().then(result => { assertActive(); catalogCache = result; return result }).finally(() => { scanPending = null })
    return scanPending
  }
  async function catalog() {
    const result = await scanNow()
    return { items: result.items, warnings: result.warnings }
  }
  async function state() {
    const id = await context()
    if (!id) return { workspaceId: null, selected: [], bundle: null, events: [] }
    const current = await local(id)
    await context(id)
    return snapshot(id, current)
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
      const data = await scanNow()
      const records = current.selected.map(id => {
        const item = data.items.find(item => item.id === id && item.available)
        const record = data.records.get(id)
        if (!item || !record) error('A selected item changed. Refresh the library and select it again.')
        return { ...record, id, name: item.name, kind: item.kind }
      })
      const result = await getWorkspaces()
      const workspace = result.workspaces.find(entry => entry.id === workspaceId)
      if (!workspace || (workspace.hostId && workspace.hostId !== 'local')) error('Preparing a bundle requires a local Orca workspace.')
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
    const removing = [...bundles.values()].map(bundle => bundle.remove())
    bundles.clear()
    disposePromise = (async () => {
      await Promise.allSettled([closing, ...removing])
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
  return { catalog, state, select, prepare, revoke, copy, dispose }
}
