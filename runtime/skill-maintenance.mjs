import { withSharedSkillLock } from './shared-change-lock.mjs'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { currentReferenceFixes } from './skill-review.mjs'
import { scanCatalog } from './catalog.mjs'
import { inspectSkillPackage } from './shared-sync.mjs'
import { checkLocation, fail, hash, isUserSkillDirectory, prepare, readCurrentFile, statOrNull } from './maintenance-paths.mjs'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const isBatchId = id => typeof id === 'string' && uuid.test(id)
const validBatchIndex = index => Number.isSafeInteger(index) && index >= 0 && index < 10000
const isReceiptId = value => typeof value === 'string' && (uuid.test(value) ||
  (uuid.test(value.slice(0, 36)) && /^\.(?:0|[1-9]\d{0,3})$/.test(value.slice(36))))
const stale = () => fail('STALE', 'changed')
const conflict = () => fail('CONFLICT', 'A destination or backup changed. The existing files were preserved.')
const receipt = ({ id, kind, name, at, editsOriginal, batchId, batchIndex }) => ({
  id, kind, name, at, ...(editsOriginal ? { editsOriginal: true } : {}), ...(batchId ? { batchId, batchIndex } : {})
})

async function directory(path, create) {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) throw fail('PROTECTED', 'protected-root')
}

async function saveRecord(folder, row) {
  const path = join(folder, randomUUID() + '.tmp'), serialized = JSON.stringify(row)
  if (Buffer.byteLength(serialized) > 256 * 1024) throw fail('PROTECTED', 'unsupported-package')
  try {
    await writeFile(path, serialized, { flag: 'wx', mode: 0o600 })
    await rename(path, join(folder, 'record.json'))
  } finally { await unlink(path).catch(() => {}) }
}

async function loadRecord(home, folder) {
  await directory(folder, false)
  const path = join(folder, 'record.json'), info = await lstat(path)
  if (!info.isFile() || info.size > 256 * 1024) throw conflict()
  const row = JSON.parse(await readFile(path, 'utf8'))
  const validPath = part => typeof part === 'string' && resolve(home, part) === join(home, part) &&
    !part.split(/[\\/]/).some(segment => !segment || segment === '.' || segment === '..') && isUserSkillDirectory(home, resolve(home, part))
  if (row.id !== basename(folder) || !isReceiptId(row.id) ||
      (row.batchId === undefined ? !uuid.test(row.id) :
        !isBatchId(row.batchId) || !validBatchIndex(row.batchIndex) || row.id !== row.batchId + '.' + row.batchIndex) || !['edit', 'remove'].includes(row.kind) || !['prepared', 'applied', 'restored'].includes(row.state) ||
      !validPath(row.root) || (row.retainedRoot && !validPath(row.retainedRoot)) || !Array.isArray(row.aliases) ||
      row.aliases.some(a => !validPath(a.rel) || typeof a.link !== 'string')) throw conflict()
  return row
}

async function replaceFile(path, bytes, mode, expected, row, checkContext) {
  const root = dirname(path)
  async function verifyRoot() {
    const info = await lstat(root)
    if (!info.isDirectory() || info.ino !== row.ino || info.dev !== row.dev || await realpath(root) !== root) throw conflict()
  }
  await verifyRoot()
  const temp = join(dirname(path), '.traffic-light-edit-' + randomUUID())
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
    await chmod(temp, mode)
    await checkContext()
    await verifyRoot()
    if (hash(await readCurrentFile(path)) !== expected || ((await lstat(path)).mode & 0o777) !== mode) throw conflict()
    await rename(temp, path)
  } finally { await unlink(temp).catch(() => {}) }
}

async function verifyPackage(path, row) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.dev !== row.dev || info.ino !== row.ino || (info.mode & 0o777) !== row.mode ||
      (await inspectSkillPackage(path, true)).fingerprint !== row.fingerprint) throw conflict()
}

async function checkAlias(home, alias) {
  const path = resolve(home, alias.rel)
  await checkLocation(home, path)
  const info = await statOrNull(path)
  return info?.isSymbolicLink() && info.ino === alias.ino && info.dev === alias.dev && await readlink(path) === alias.link
}

async function restorePackage(home, folder, row, checkContext) {
  const root = resolve(home, row.root), stored = join(folder, 'package')
  await checkLocation(home, root)
  const archived = await statOrNull(stored)
  if (archived) await verifyPackage(stored, row)
  else await verifyPackage(root, row) // A previous recovery already returned the original inode.
  let ownedLink = false
  if (archived && await statOrNull(root)) {
    const info = await lstat(root)
    ownedLink = !!row.retainedRoot && info.isSymbolicLink() && await readlink(root) === resolve(home, row.retainedRoot) &&
      (row.linkIno === undefined || (info.ino === row.linkIno && info.dev === row.linkDev))
    if (!ownedLink) throw conflict()
  }
  if (!row.retainedRoot) for (const [i, alias] of row.aliases.entries()) {
    await checkLocation(home, resolve(home, alias.rel))
    const backup = await statOrNull(join(folder, 'alias-' + i)), current = await statOrNull(resolve(home, alias.rel))
    if (backup && (!backup.isSymbolicLink() || backup.dev !== alias.dev || backup.ino !== alias.ino)) throw conflict()
    if (current && !await checkAlias(home, alias) &&
        !(backup && current.isSymbolicLink() && await readlink(resolve(home, alias.rel)) === join(folder, 'restore-alias-' + i))) throw conflict()
    if (!backup && !current) throw conflict()
  }
  await checkContext()
  if (archived) {
    if (ownedLink) await unlink(root)
    // Claim the empty destination exclusively. rename() may only replace our own empty directory.
    try { await mkdir(root, { mode: 0o700 }) } catch { throw conflict() }
    try { await rename(stored, root) }
    catch (error) {
      await rmdir(root).catch(() => {})
      if (ownedLink) await symlink(resolve(home, row.retainedRoot), root).catch(() => {})
      throw error
    }
  }
  if (!row.retainedRoot) for (const [i, alias] of row.aliases.entries()) {
    const backup = join(folder, 'alias-' + i), dest = resolve(home, alias.rel)
    if (await statOrNull(backup)) {
      const placeholder = join(folder, 'restore-alias-' + i)
      if (!(await statOrNull(dest))) await symlink(placeholder, dest)
      if (await readlink(dest) !== placeholder) throw conflict()
      await rename(backup, dest)
    }
  }
}

async function restore(home, folder, row, checkContext) {
  if (row.kind === 'remove') await restorePackage(home, folder, row, checkContext)
  else {
    const root = resolve(home, row.root)
    await checkLocation(home, root)
    const info = await lstat(root)
    if (!info.isDirectory() || info.ino !== row.ino || info.dev !== row.dev) throw conflict()
    const path = join(root, 'SKILL.md'), original = await readCurrentFile(join(folder, 'original.md'))
    if (hash(original) !== row.before) throw conflict()
    if (hash(await readCurrentFile(path)) !== row.before) {
      if (((await lstat(path)).mode & 0o777) !== row.fileMode) throw conflict()
      await replaceFile(path, original, row.fileMode, row.after, row, checkContext)
    }
  }
  await saveRecord(folder, { ...row, state: 'restored' })
  if (row.kind === 'edit') await unlink(join(folder, 'original.md')).catch(() => {})
}

export function createSkillMaintenance({ home = homedir() } = {}) {
  async function locations(create = false) {
    const root = await realpath(home)
    const agents = join(root, '.agents'), base = join(agents, 'traffic-light'), archive = join(base, 'review-changes')
    for (const path of [agents, base, archive]) await directory(path, create)
    return { root, base, archive }
  }

  async function preview(data, input, options) {
    try {
      const { source, retained, successor, revision } = await prepare(data, await realpath(home), input, options)
      let referenceFixes
      if (input.kind === 'edit') {
        const pkg = await inspectSkillPackage(join(await realpath(home), source.root))
        if (pkg.stamp !== source.stamp) throw stale()
        referenceFixes = await currentReferenceFixes(pkg.root, pkg.entries, source.body)
      }
      return { status: 'ready', revision, name: source.name, path: source.root, paths: source.paths, providers: source.providers,
        ...(source.editsOriginal ? { editsOriginal: true } : {}), ...(input.kind === 'edit' ? { body: source.body, referenceFixes } : {}), ...(retained ? { retainedPath: retained.root } : {}),
        ...(successor ? { successorPath: successor.root } : {}) }
    } catch (error) {
      if (error.code === 'INVALID') throw error
      return { status: 'blocked', reason: ['PROTECTED', 'STALE'].includes(error.code) ? error.message : 'unreadable' }
    }
  }

  async function apply(_data, input, checkContext = async () => {}, group) {
    if (group && (!isBatchId(group.batchId) || !validBatchIndex(group.batchIndex))) throw fail('INVALID', 'invalid')
    if (typeof input.workspaceId !== 'string' || !input.workspaceId || typeof input.revision !== 'string') throw fail('INVALID', 'invalid')
    if (input.kind === 'edit' && (typeof input.body !== 'string' || !input.body.trim() || input.body.includes('\0') || Buffer.byteLength(input.body) > 65536)) throw fail('INVALID', 'invalid')
    await checkContext()
    const { root: home, base, archive } = await locations(true)
    return withSharedSkillLock(base, async () => {
      const id = group ? group.batchId + '.' + group.batchIndex : randomUUID()
      const folder = join(archive, id)
      const intent = group && hash(JSON.stringify([input.kind, input.id, input.retainedId, group.successorId, input.revision, input.body]))
      if (group && await statOrNull(folder)) {
        const existing = await loadRecord(home, folder)
        if (existing.workspaceId !== input.workspaceId || existing.intent !== intent) throw stale()
        if (existing.state !== 'applied') throw fail('STALE', existing.state === 'prepared' ? 'batch-item-needs-recovery' : 'batch-item-restored')
        return receipt(existing)
      }
      if (group) {
        const member = (await readdir(archive)).find(id => id.startsWith(group.batchId + '.') && isReceiptId(id))
        if (member && (await loadRecord(home, join(archive, member))).workspaceId !== input.workspaceId) throw fail('INVALID', 'invalid')
      }
      const { source, retained, successor, revision } = await prepare(await scanCatalog({ home }), home, input,
        group ? { batch: true, successorId: group.successorId } : undefined)
      if (input.revision !== revision) throw stale()
      if (input.kind === 'edit' && source.body === input.body) throw fail('INVALID', 'unchanged')
      await checkContext()
      const root = resolve(home, source.root)
      await mkdir(folder, { mode: 0o700 })
      const row = { id, workspaceId: input.workspaceId, kind: input.kind, name: source.name, at: Date.now(), state: 'prepared',
        ...(group ? { batchId: group.batchId, batchIndex: group.batchIndex, intent } : {}),
        root: source.root, ...(source.editsOriginal ? { editsOriginal: true } : {}), ino: source.ino, dev: source.dev, mode: source.mode, aliases: source.aliases, fingerprint: source.fingerprint,
        ...(retained ? { retainedRoot: retained.root } : {}),
        ...(input.kind === 'edit' ? { before: hash(source.body), after: hash(input.body), fileMode: source.fileMode } : {}) }
      if (input.kind === 'edit') await writeFile(join(folder, 'original.md'), source.body, { flag: 'wx', mode: 0o600 })
      await saveRecord(folder, row)
      let changed = false
      try {
        if (input.kind === 'edit') {
          await replaceFile(join(root, 'SKILL.md'), input.body, source.fileMode, row.before, row, checkContext)
          changed = true
        } else {
          await checkContext()
          await verifyPackage(root, row)
          if (retained) await verifyPackage(resolve(home, retained.root), retained)
          if (successor) await verifyPackage(resolve(home, successor.root), successor)
          for (const alias of source.aliases) if (!await checkAlias(home, alias)) throw stale()
          await rename(root, join(folder, 'package'))
          changed = true
          if (retained) {
            await symlink(resolve(home, retained.root), root)
            const info = await lstat(root)
            row.linkIno = info.ino; row.linkDev = info.dev
          } else for (const [i, alias] of source.aliases.entries()) {
            if (!await checkAlias(home, alias)) throw stale()
            await rename(resolve(home, alias.rel), join(folder, 'alias-' + i))
          }
        }
        await saveRecord(folder, { ...row, state: 'applied' })
        return receipt(row)
      } catch (error) {
        // With an externally occupied destination the journal remains available for a later retry.
        if (changed) await restore(home, folder, row, async () => {}).catch(() => {})
        else {
          await saveRecord(folder, { ...row, state: 'restored' })
          if (row.kind === 'edit') await unlink(join(folder, 'original.md')).catch(() => {})
        }
        throw error
      }
    })
  }

  async function history(workspaceId) {
    let paths
    try { paths = await locations() } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    const result = []
    for (const id of await readdir(paths.archive)) if (isReceiptId(id)) {
      const row = await loadRecord(paths.root, join(paths.archive, id)).catch(() => null)
      if (row && row.workspaceId === workspaceId && row.state !== 'restored') result.push(receipt(row))
    }
    return result.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
  }

  async function undo({workspaceId, receiptId}, checkContext = async () => {}) {
    if (!isReceiptId(receiptId)) throw fail('INVALID', 'invalid')
    await checkContext()
    const { root: home, base, archive } = await locations()
    return withSharedSkillLock(base, async () => {
      const folder = join(archive, receiptId), row = await loadRecord(home, folder)
      if (row.workspaceId !== workspaceId) throw fail('INVALID', 'invalid')
      if (row.state !== 'restored') await restore(home, folder, row, checkContext)
      return { restored: true }
    })
  }
  async function undoBatch({ workspaceId, batchId }, checkContext = async () => {}) {
    if (!isBatchId(batchId)) throw fail('INVALID', 'invalid')
    await checkContext()
    const { root: home, base, archive } = await locations()
    return withSharedSkillLock(base, async () => {
      const entries = (await readdir(archive)).filter(id => id.startsWith(batchId + '.') && isReceiptId(id))
        .sort((a, b) => Number(b.slice(37)) - Number(a.slice(37)))
      if (!entries.length) throw fail('INVALID', 'invalid')
      const records = new Map()
      for (const id of entries) {
        const row = await loadRecord(home, join(archive, id)).catch(() => null)
        if (!row) continue
        if (row.workspaceId !== workspaceId || row.batchId !== batchId) throw fail('INVALID', 'invalid')
        records.set(id, row)
      }
      if (!records.size) throw fail('INVALID', 'invalid')
      let lostFocus = false
      const check = async () => {
        try { await checkContext() }
        catch (error) { lostFocus = true; throw error }
      }
      const rows = []
      for (const id of entries) {
        const record = records.get(id)
        if (!record) {
          rows.push({ receiptId: id, name: id, status: 'failed', reason: 'unavailable' })
          continue
        }
        const result = { receiptId: record.id, name: record.name, status: 'skipped' }
        if (record.state !== 'restored') {
          if (lostFocus) result.reason = 'workspace-changed'
          else try {
            await check()
            await restore(home, join(archive, record.id), record, check)
            result.status = 'restored'
          } catch (error) {
            result.status = lostFocus ? 'skipped' : 'failed'
            result.reason = lostFocus ? 'workspace-changed' : error.code === 'CONFLICT' ? 'conflict' : 'unavailable'
          }
        } else result.reason = 'already-restored'
        rows.push(result)
      }
      return { batchId, rows }
    })
  }
  return { preview, apply, history, undo, undoBatch }
}
