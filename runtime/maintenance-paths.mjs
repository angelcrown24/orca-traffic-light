import { createHash } from 'node:crypto'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { skillRoots } from './catalog.mjs'
import { inspectSkillPackage, readSharedRegistry } from './shared-sync.mjs'

export const hash = value => createHash('sha256').update(value).digest('hex')
export const fail = (code, message) => Object.assign(new Error(message), { code })
export const statOrNull = path => lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
export const below = (root, path) => {
  const rel = relative(root, path)
  return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
}

export function isUserSkillDirectory(home, directory) {
  return typeof directory === 'string' && isAbsolute(directory) && skillRoots.some(([part]) => {
    const root = join(home, part)
    return below(root, directory) && relative(root, directory).split(sep).every(segment => segment && !segment.startsWith('.'))
  })
}

export async function checkLocation(home, path) {
  if (!isUserSkillDirectory(home, path) || await realpath(dirname(path)).catch(() => null) !== dirname(path)) {
    throw fail('PROTECTED', 'protected-root')
  }
}

// Moving this directory would also move a separately installed skill or its registered original.
export function containsInstallation(data, path, registrations) {
  const root = dirname(path)
  for (const [file, locations] of data.skillInstallations ?? []) {
    if (file !== path && (below(root, dirname(file)) || locations.some(site => below(root, site.path)))) return true
  }
  return registrations.some(([, entry]) => below(root, entry.sourcePath) || below(root, entry.snapshot))
}

async function target(data, home, id, registrations, allowOriginal = false) {
  const item = data.items.find(row => row.id === id && row.kind === 'skill')
  let record = data.records.get(id)
  if (!item || !record?.path) throw fail('STALE', 'changed')
  let editsOriginal = false, registration
  const listedRoot = dirname(record.path)
  const registered = registrations.find(([slug, entry]) => slug === record.syncKey ||
    listedRoot === entry.sourcePath || listedRoot === entry.snapshot)
  if (record.syncKey || registered) {
    if (!allowOriginal || !registered) throw fail('PROTECTED', 'managed-snapshot')
    const [slug, entry] = registered
    if ((record.syncKey && record.syncKey !== slug) ||
        ![entry.sourcePath, entry.snapshot].includes(listedRoot) ||
        await realpath(join(home, '.agents/skills', slug)).catch(() => null) !== entry.snapshot ||
        (await inspectSkillPackage(entry.snapshot)).stamp !== entry.snapshotStamp) throw fail('PROTECTED', 'managed-snapshot')
    const original = [...data.records.values()].find(row => row.kind === 'skill' && row.path === join(entry.sourcePath, 'SKILL.md'))
    if (!original || original.packageRoot) throw fail('PROTECTED', 'managed-snapshot')
    record = original; editsOriginal = true
    registration = [entry.snapshot, entry.packageFingerprint]
  }
  const root = dirname(record.path)
  if (record.syncKey || record.packageRoot || root.startsWith(join(home, '.agents/traffic-light/shared-skills') + sep)) throw fail('PROTECTED', 'managed-snapshot')
  await checkLocation(home, root)
  const seen = data.skillInstallations?.get(record.path)
  if (!seen?.length || data.warnings.some(w => w.includes('inventory reached its scan limit') || w.includes('shared registry is unreadable'))) {
    throw fail('PROTECTED', 'inventory-incomplete')
  }
  if (!allowOriginal && containsInstallation(data, record.path, registrations)) throw fail('PROTECTED', 'nested-installation')
  if (basename(record.path) !== 'SKILL.md' || seen.some(entry => entry.packageRoot !== root)) throw fail('PROTECTED', 'protected-root')
  const paths = new Set([relative(home, root)]), aliases = []
  for (const entry of seen) {
    if (!isUserSkillDirectory(home, entry.logicalPath)) throw fail('PROTECTED', 'protected-root')
    paths.add(relative(home, entry.logicalPath))
  }
  for (const alias of [...new Set(seen.map(e => e.path))].sort()) {
    await checkLocation(home, alias)
    if (await realpath(alias).catch(() => null) !== root) throw fail('STALE', 'changed')
    if (alias === root) continue
    const info = await lstat(alias)
    if (!info.isSymbolicLink()) throw fail('PROTECTED', 'protected-root')
    aliases.push({ rel: relative(home, alias), link: await readlink(alias), ino: info.ino, dev: info.dev })
  }
  const info = await lstat(root)
  if (!info.isDirectory() || await realpath(root) !== root) throw fail('PROTECTED', 'protected-root')
  const pkg = await inspectSkillPackage(root, true).catch(() => { throw fail('PROTECTED', 'unsupported-package') })
  const instructions = pkg.entries.find(entry => entry.path === 'SKILL.md')
  if (instructions.size > 65536 || hash(instructions.content) !== record.fingerprint) throw fail('STALE', 'changed')
  const body = instructions.content.toString('utf8')
  if (body.includes('\0') || !Buffer.from(body).equals(instructions.content)) throw fail('PROTECTED', 'unreadable')
  return { id, name: item.name, root: relative(home, root), mode: info.mode & 0o777, ino: info.ino, dev: info.dev, stamp: pkg.stamp,
    fingerprint: pkg.fingerprint, body, fileMode: instructions.mode, providers: [...new Set(seen.map(entry => entry.provider))].sort(),
    editsOriginal, registration, aliases, paths: [...paths].sort() }
}

export async function prepare(data, home, { id, kind, retainedId }) {
  if (!['edit', 'remove'].includes(kind) || typeof id !== 'string' || (retainedId !== undefined && (kind !== 'remove' || typeof retainedId !== 'string' || id === retainedId))) throw fail('INVALID', 'invalid')
  const registry = await readSharedRegistry(home).catch(() => { throw fail('PROTECTED', 'inventory-incomplete') })
  const registrations = Object.entries(registry.skills)
  const source = await target(data, home, id, registrations, kind === 'edit')
  const retained = retainedId === undefined ? undefined : await target(data, home, retainedId, registrations)
  if (retained && (retained.name.toLowerCase() !== source.name.toLowerCase() || retained.fingerprint !== source.fingerprint || retained.mode !== source.mode ||
      retained.root === source.root || below(source.root, retained.root) || below(retained.root, source.root))) throw fail('STALE', 'changed')
  const revision = hash(JSON.stringify([kind, source, retained]))
  return { source, retained, revision }
}

export async function readCurrentFile(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.size > 65536 || await realpath(path) !== path) throw fail('CONFLICT', 'changed')
  return readFile(path)
}
