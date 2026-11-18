import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const digest = value => createHash('sha256').update(value).digest('hex')
const failure = message => Object.assign(new Error(message), { code: 'SYNC_CONFLICT' })
const missing = async path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
const roots = ['.codex/skills', '.claude/skills', '.gemini/skills', '.gemini/config/skills', '.gemini/antigravity/skills']
const registryPath = home => join(home, '.agents', 'traffic-light', 'shared-registry.json')
const within = (root, path) => { const part = relative(root, path); return part === '' || (!part.startsWith('..' + sep) && part !== '..' && !isAbsolute(part)) }
const emptyRegistry = () => ({ version: 1, skills: {}, mcp: {} })

async function bytes(path, limit) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit) throw failure('A source file is unsupported or too large.')
    const buffer = Buffer.alloc(info.size + 1)
    let length = 0
    while (length < buffer.length) { const next = await handle.read(buffer, length, buffer.length - length, length); if (!next.bytesRead) break; length += next.bytesRead }
    if (length !== info.size) throw failure('A source file changed while it was being read.')
    return buffer.subarray(0, length)
  } finally { await handle.close() }
}

// Metadata scans use stamps; explicit synchronization hashes and copies every package file.
export async function inspectSkillPackage(path, contents = false) {
  const root = await realpath(path), entries = []
  let total = 0
  async function visit(directory, depth) {
    if (depth > 20) throw failure('The skill package is nested too deeply.')
    const names = await readdir(directory)
    names.sort()
    for (const name of names) {
      if (entries.length >= 2000) throw failure('The skill package has too many files.')
      const file = join(directory, name), info = await lstat(file), part = relative(root, file)
      const base = { path: part, mode: info.mode & 0o777, size: info.size, modified: info.mtimeMs, changed: info.ctimeMs }
      if (info.isSymbolicLink()) {
        const target = await readlink(file)
        if (isAbsolute(target) || !within(root, resolve(dirname(file), target))) throw failure('The skill package has an external symbolic link; move it manually.')
        entries.push({ ...base, kind: 'link', target })
      } else if (info.isDirectory()) {
        entries.push({ ...base, kind: 'directory' }); await visit(file, depth + 1)
      } else if (info.isFile()) {
        total += info.size
        if (total > 32 * 1024 * 1024 || info.size > 16 * 1024 * 1024) throw failure('The skill package exceeds the 32 MiB import limit.')
        entries.push({ ...base, kind: 'file', ...(contents ? { content: await bytes(file, 16 * 1024 * 1024) } : {}) })
      } else throw failure('The skill package contains an unsupported special file.')
    }
  }
  await visit(root, 0)
  if (!entries.some(entry => entry.path === 'SKILL.md' && entry.kind === 'file')) throw failure('The package needs a regular SKILL.md file.')
  const stamp = digest(JSON.stringify(entries.map(({ content, ...entry }) => entry)))
  const fingerprint = contents ? digest(JSON.stringify(entries.map(entry => ({ path: entry.path, mode: entry.mode, kind: entry.kind, ...(entry.target ? { target: entry.target } : {}), ...(entry.content ? { hash: digest(entry.content) } : {}) })))) : undefined
  return { root, entries, stamp, fingerprint }
}

export async function readSharedRegistry(home = homedir()) {
  home = await realpath(home).catch(() => resolve(home))
  const path = registryPath(home)
  if (!(await missing(path))) return emptyRegistry()
  try {
    const data = JSON.parse((await bytes(path, 1024 * 1024)).toString('utf8'))
    if (data?.version !== 1 || !data.skills || !data.mcp || typeof data.skills !== 'object' || typeof data.mcp !== 'object' || Array.isArray(data.skills) || Array.isArray(data.mcp)) throw new Error()
    for (const [slug, entry] of Object.entries(data.skills)) {
      if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(slug) || typeof entry?.sourcePath !== 'string' || typeof entry.snapshot !== 'string' || typeof entry.packageFingerprint !== 'string' || typeof entry.sourceStamp !== 'string' || typeof entry.snapshotStamp !== 'string') throw new Error()
      if (!isAbsolute(entry.sourcePath) || !isAbsolute(entry.snapshot) || !within(join(home, '.agents', 'traffic-light', 'shared-skills'), entry.snapshot)) throw new Error()
    }
    for (const entry of Object.values(data.mcp)) if (entry?.kind !== 'mcp' || typeof entry.id !== 'string' || typeof entry.configPath !== 'string' || !isAbsolute(entry.configPath) || typeof entry.serverKey !== 'string' || typeof entry.fingerprint !== 'string') throw new Error()
    return data
  } catch { throw failure('The shared registry is unreadable or invalid. Existing registrations were preserved.') }
}

export async function decorateSharing(catalog, home = homedir()) {
  for (const item of catalog.items) item.sharing = {
    state: item.kind === 'skill' && item.providers.includes('Shared') ? 'shared' : 'provider',
    canSync: item.available,
    ...(!item.available ? { detail: 'This capability requires its native connector.' } : {})
  }
  let registry
  try { registry = await readSharedRegistry(home) } catch (error) { catalog.warnings.push(error.message); return catalog }
  const hidden = new Set()
  for (const [slug, entry] of Object.entries(registry.skills)) {
    const canonical = join(home, '.agents', 'skills', slug)
    const shared = catalog.items.find(item => catalog.records.get(item.id)?.path === join(entry.snapshot, 'SKILL.md'))
    const origin = catalog.items.find(item => catalog.records.get(item.id)?.path === join(entry.sourcePath, 'SKILL.md'))
    const item = shared ?? origin
    if (!item) { catalog.warnings.push('A registered shared skill is no longer available.'); continue }
    let state = 'shared', detail
    try {
      if (await realpath(canonical) !== entry.snapshot || (await inspectSkillPackage(entry.snapshot)).stamp !== entry.snapshotStamp) throw new Error()
      if ((await inspectSkillPackage(entry.sourcePath)).stamp !== entry.sourceStamp) { state = 'update'; detail = 'The original package changed. Synchronize explicitly to publish a new shared version.' }
    } catch { state = 'conflict'; detail = 'A shared package or its source changed location. Existing files were preserved.' }
    item.sharing = { state, canSync: item.available && state !== 'conflict', ...(detail ? { detail } : {}) }
    const record = catalog.records.get(item.id)
    record.syncKey = slug
    if (shared) {
      record.packageRoot = entry.snapshot; record.packageFingerprint = entry.packageFingerprint
      if (origin && origin !== shared) { hidden.add(origin.id); for (const provider of origin.providers) if (!shared.providers.includes(provider)) shared.providers.push(provider) }
    }
  }
  catalog.items = catalog.items.filter(item => !hidden.has(item.id))
  for (const pin of Object.values(registry.mcp)) {
    const item = catalog.items.find(item => item.id === pin.id)
    if (!item) { catalog.warnings.push('A registered shared MCP source is no longer available.'); continue }
    const current = catalog.records.get(item.id)
    item.sharing = !item.available ? { state: 'conflict', canSync: false, detail: item.reason }
      : current.fingerprint === pin.fingerprint ? { state: 'shared', canSync: true }
        : { state: 'update', canSync: true, detail: 'The source configuration changed. Synchronize explicitly before applying the new version.' }
  }
  return catalog
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure('A synchronization directory is not a private directory.')
}
async function saveRegistry(home, registry) {
  const path = registryPath(home), previous = await missing(path)
  if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw failure('The shared registry destination is not a regular file.')
  const temporary = path + '.' + randomUUID() + '.tmp'
  try { await writeFile(temporary, JSON.stringify(registry), { flag: 'wx', mode: 0o600 }); await rename(temporary, path) }
  finally { await unlink(temporary).catch(() => {}) }
}
async function linkMissing(destination, canonical, created) {
  await mkdir(dirname(destination), { recursive: true })
  try {
    await symlink(canonical, destination, process.platform === 'win32' ? 'junction' : 'dir')
    created.push(destination)
  } catch (error) {
    // Two provider roots may themselves be links to the same directory.
    if (error.code !== 'EEXIST' || !(await lstat(destination)).isSymbolicLink() || await realpath(destination) !== await realpath(canonical)) throw error
  }
}
const slugFor = record => {
  const name = record.name
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(name) || name === '.' || name === '..') throw failure('This skill name cannot be used as a shared folder name. Rename it manually first.')
  return name
}

async function syncSkill(record, registry, home, preserveProviderCopies) {
  const slug = record.syncKey ?? slugFor(record), previous = Object.hasOwn(registry.skills, slug) ? registry.skills[slug] : undefined
  if (previous && !record.syncKey) throw failure('A different source is already registered under this name. Compare it with the shared copy.')
  const sourcePath = previous?.sourcePath ?? dirname(record.path)
  const source = await inspectSkillPackage(sourcePath, true)
  const canonical = join(home, '.agents', 'skills', slug)
  const current = await missing(canonical)
  let existingCommon = false
  if (previous) {
    if (!current?.isSymbolicLink() || await realpath(canonical) !== previous.snapshot || (await inspectSkillPackage(previous.snapshot)).stamp !== previous.snapshotStamp) throw failure('The shared destination was changed outside Traffic Light. Nothing was overwritten.')
  } else if (current) {
    existingCommon = await realpath(canonical) === source.root
    if (!existingCommon) throw failure('A different skill already occupies this shared name. Nothing was overwritten.')
  }
  const destinations = []
  for (const root of roots) {
    const destination = join(home, root, slug), info = await missing(destination)
    if (info) {
      const resolved = await realpath(destination).catch(() => null)
      if (resolved === source.root || resolved === previous?.snapshot || (info.isSymbolicLink() && resolve(dirname(destination), await readlink(destination)) === canonical)) continue
      if (preserveProviderCopies && resolved && (await lstat(join(resolved, 'SKILL.md')).catch(() => null))?.isFile()) continue
      throw failure(`A different skill already exists in ${root}. Nothing was overwritten.`)
    }
    destinations.push(destination)
  }
  if (existingCommon) {
    const created = []
    try {
      for (const destination of destinations) await linkMissing(destination, canonical, created)
      return { status: created.length ? 'synced' : 'unchanged', message: 'Existing shared entry linked to missing provider locations. Original files were preserved.', newId: record.id }
    } catch (error) { for (const destination of created.reverse()) await unlink(destination).catch(() => {}); throw error }
  }
  await privateDirectory(join(home, '.agents', 'traffic-light', 'shared-skills'))
  const base = join(home, '.agents', 'traffic-light', 'shared-skills', slug)
  await privateDirectory(base)
  const snapshot = join(base, source.fingerprint)
  const exists = await missing(snapshot)
  if (exists) {
    if (exists.isSymbolicLink() || (await inspectSkillPackage(snapshot, true)).fingerprint !== source.fingerprint) throw failure('The stored shared version has changed. Nothing was overwritten.')
  } else {
    const stage = join(base, '.staging-' + randomUUID())
    await mkdir(stage, { mode: 0o700 })
    try {
      for (const entry of source.entries) {
        const path = join(stage, entry.path)
        if (entry.kind === 'directory') await mkdir(path, { mode: 0o700 })
        else if (entry.kind === 'link') await symlink(entry.target, path)
        else { await writeFile(path, entry.content, { flag: 'wx', mode: entry.mode }); await chmod(path, entry.mode) }
      }
      for (const entry of [...source.entries].reverse()) if (entry.kind === 'directory') await chmod(join(stage, entry.path), entry.mode)
      if ((await inspectSkillPackage(source.root)).stamp !== source.stamp) throw failure('The source changed during synchronization. Try again after editing finishes.')
      await rename(stage, snapshot)
    } catch (error) { await rm(stage, { recursive: true, force: true }); throw error }
  }
  const snapshotStamp = (await inspectSkillPackage(snapshot)).stamp
  const createdLinks = [], temporary = canonical + '.traffic-light-' + randomUUID()
  let changedCanonical = false
  try {
    await mkdir(dirname(canonical), { recursive: true })
    if (previous && previous.snapshot !== snapshot) { await symlink(snapshot, temporary); await rename(temporary, canonical); changedCanonical = true }
    else if (!current) { await symlink(snapshot, canonical); changedCanonical = true }
    for (const destination of destinations) await linkMissing(destination, canonical, createdLinks)
    const entry = { name: record.name, sourcePath: source.root, sourceStamp: source.stamp, snapshot, snapshotStamp, packageFingerprint: source.fingerprint }
    await saveRegistry(home, { ...registry, skills: { ...registry.skills, [slug]: entry } })
    registry.skills[slug] = entry
    return { status: previous?.packageFingerprint === source.fingerprint && !createdLinks.length ? 'unchanged' : 'synced', message: 'Shared package published; original files and earlier shared versions were preserved.', newId: `skill:${digest(join(snapshot, 'SKILL.md')).slice(0, 24)}` }
  } catch (error) {
    for (const link of createdLinks.reverse()) await unlink(link).catch(() => {})
    if (changedCanonical) {
      if (previous) { await unlink(temporary).catch(() => {}); await symlink(previous.snapshot, temporary); await rename(temporary, canonical) }
      else await unlink(canonical).catch(() => {})
    }
    throw error
  } finally { await unlink(temporary).catch(() => {}) }
}

export async function syncCapabilities({ ids, home = homedir(), preserveProviderCopies = false } = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 24 || ids.some(id => typeof id !== 'string')) throw new Error('Choose between 1 and 24 capabilities to synchronize.')
  home = await realpath(home)
  const directory = join(home, '.agents', 'traffic-light')
  await privateDirectory(directory)
  const lock = join(directory, 'shared-sync.lock')
  try { await mkdir(lock, { mode: 0o700 }) } catch { throw new Error('Synchronization is locked. If an earlier attempt crashed, remove the shared-sync.lock folder under ~/.agents/traffic-light after confirming no sync is running.') }
  try {
    const { scanCatalog } = await import('./catalog.mjs')
    const catalog = await scanCatalog({ home }), registry = await readSharedRegistry(home), results = []
    for (const id of [...new Set(ids)]) {
      const item = catalog.items.find(item => item.id === id), record = catalog.records.get(id)
      if (!item || !record) { results.push({ id, name: 'Unavailable capability', status: 'failed', message: 'The item changed. Refresh the library.' }); continue }
      try {
        if (!item.available) throw failure('This capability requires its native connector and cannot be synchronized.')
        if (record.kind === 'skill') results.push({ id, name: item.name, ...await syncSkill(record, registry, home, preserveProviderCopies === true) })
        else {
          if (preserveProviderCopies === true && !Object.hasOwn(registry.mcp, id)) {
            const taken = Object.values(registry.mcp).some(pin =>
              pin.name?.toLowerCase() === item.name.toLowerCase() && catalog.records.has(pin.id))
            if (taken) throw failure('Another source with this name is already shared. Refresh the library to compare them.')
          }
          const pin = { id, name: record.name, kind: 'mcp', configPath: record.configPath, format: record.format, serverKey: record.serverKey, fingerprint: record.fingerprint }
          const unchanged = registry.mcp[id]?.fingerprint === pin.fingerprint
          await saveRegistry(home, { ...registry, mcp: { ...registry.mcp, [id]: pin } }); registry.mcp[id] = pin
          results.push({ id, name: item.name, status: unchanged ? 'unchanged' : 'synced', message: 'Shared source reference synchronized. Credentials and provider configurations were not copied or changed.' })
        }
      } catch (error) { results.push({ id, name: item.name, status: error.code === 'SYNC_CONFLICT' ? 'conflict' : 'failed', message: error.code === 'SYNC_CONFLICT' ? error.message : 'Synchronization failed. Existing provider files were preserved.' }) }
    }
    return { results }
  } finally { await rm(lock, { recursive: true, force: true }) }
}
