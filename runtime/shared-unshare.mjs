import { createHash } from 'node:crypto'
import { lstat, readdir, readlink, realpath, rename, rm, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const slugPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/i
const fingerprint = /^[a-f0-9]{64}$/
const absent = error => { if (error.code !== 'ENOENT') throw error; return null }
const prop = (object, key) => object && Object.hasOwn(object, key) ? object[key] : undefined

export function validLinkedSkills(links) {
  return links === undefined || (links && typeof links === 'object' && !Array.isArray(links) &&
    Object.entries(links).every(([key, entry]) => slugPattern.test(key) && typeof entry?.sourcePath === 'string' &&
      isAbsolute(entry.sourcePath) && entry.links && typeof entry.links === 'object' && !Array.isArray(entry.links)))
}

export async function linkIdentity(path) {
  const info = await lstat(path)
  if (!info.isSymbolicLink()) throw new Error('The shared link changed.')
  return { parent: await realpath(dirname(path)), target: await readlink(path), dev: info.dev, ino: info.ino, birth: info.birthtimeMs }
}
const sameLink = (a, b) => a && b && ['parent','target','dev','ino','birth'].every(key => a[key] === b[key])

export async function cleanupSharedSkill({ home, key, revision, workspaceId, registry, roots, inspectSkillPackage, saveRegistry, checkContext }) {
  const published = prop(registry.skills, key), linked = prop(registry.linkedSkills, key)
  const entry = published ?? linked
  if (!entry || (published && linked)) throw Error('The sharing registration changed. Refresh the library.')
  const base = join(home, '.agents/traffic-light/shared-skills', key), common = join(home, '.agents/skills', key)
  const legacy = !!published && (!entry.links || entry.legacyLinks === true)
  const paths = [], copies = [], preserved = [], blockers = []
  const previousCleanup = entry.retiring ?? {}
  const display = path => path.startsWith(home + sep) ? relative(home,path) : path
  const dirty = () => Error('The sharing registration or its files changed. Preview again.')
  if (published && (!fingerprint.test(entry.packageFingerprint) || entry.snapshot !== join(base, entry.packageFingerprint))) throw dirty()
  const source = await realpath(entry.sourcePath).catch(absent) ?? entry.sourcePath

  // Only inspect known installation locations. Registry strings never supply unlink/rm destinations.
  const seen = new Set()
  for (const path of [...(published ? [common] : []), ...roots.map(root => join(home,root,key))]) {
    const info = await lstat(path).catch(absent)
    if (!info) continue
    const identity = info.isSymbolicLink() ? await linkIdentity(path) : null
    const physical = join(identity?.parent ?? await realpath(dirname(path)), basename(path))
    if (seen.has(physical)) continue
    seen.add(physical)
    const ref = display(path), saved = prop(entry.links,ref)
    const target = path === common ? entry.snapshot : common
    const expected = identity && resolve(dirname(physical),identity.target) === target
    const oldSignature = legacy && !saved && identity?.target === target && physical.startsWith(home + sep)
    if (physical !== source && expected && (sameLink(saved,identity) || oldSignature)) {
      paths.push({ ref, path, identity })
    } else if (saved || path === common || identity) {
      preserved.push(ref)
      // A user-owned link still needs its destination. The user can redirect it before unsharing.
      const resolved = await realpath(path).catch(absent)
      if (published && identity && (expected || (resolved && (resolved === base || resolved.startsWith(base + sep))))) blockers.push(ref)
    }
  }
  if (published) {
    const baseInfo = await lstat(base).catch(absent)
    if (baseInfo) {
      if (!baseInfo.isDirectory() || await realpath(base) !== base) blockers.push(display(base))
      else for (const name of (await readdir(base)).sort()) {
        // Published version folders are content-addressed. Leave unrelated entries in place.
        const detached = name.startsWith('.removing-')
        const version = detached ? name.slice('.removing-'.length) : name
        if (!fingerprint.test(version) || (detached && !prop(previousCleanup,version)) ||
            (entry.versions && !entry.legacyVersions && !entry.versions.includes(version))) continue
        const directory = join(base,name), info = await lstat(directory)
        const protectsSource = Object.values({...registry.skills,...registry.linkedSkills}).some(other =>
          other.sourcePath === directory || other.sourcePath.startsWith(directory + sep)) ||
          source === directory || source.startsWith(directory + sep)
        if (protectsSource || !info.isDirectory() || await realpath(directory) !== directory) { blockers.push(display(directory)); continue }
        const pkg = await inspectSkillPackage(directory,true).catch(() => null)
        if (pkg?.fingerprint !== version || (detached && (previousCleanup[version].dev !== info.dev || previousCleanup[version].ino !== info.ino)) || copies.some(x => x.version === version)) { blockers.push(display(directory)); continue }
        copies.push({ version,detached,ref:display(directory), path:directory, stamp:pkg.stamp, dev:info.dev, ino:info.ino })
      }
    }
  }
  const sourceAvailable = !!(await lstat(join(source, 'SKILL.md')).catch(absent))?.isFile()
  if (!sourceAvailable && copies.length) blockers.push(display(source))
  paths.sort((a,b) => Number(a.path===common) - Number(b.path===common))
  const scope = { name:key, source:display(source), sourceAvailable, links:paths.map(x=>x.ref), snapshots:copies.map(x=>x.ref), preserved, legacy }
  const token = hash([workspaceId ?? null,key,entry,scope,paths,copies,blockers])
  if (revision !== undefined && revision !== token) throw dirty()
  if (blockers.length) {
    if (revision !== undefined) throw dirty()
    return { ...scope,status:'blocked',blockers }
  }
  if (revision === undefined) return { ...scope,status:'ready',revision:token }
  await checkContext()

  if (copies.length) {
    const retiring = Object.fromEntries(copies.map(copy => [copy.version,{dev:copy.dev,ino:copy.ino}]))
    registry = { ...registry,skills:{ ...registry.skills,[key]:{ ...entry,retiring } } }
    await saveRegistry(home,registry)
  }

  // Keep the registration until all confirmed paths have been removed so an interrupted action can be previewed again.
  for (const item of paths) {
    await checkContext()
    if (!sameLink(await linkIdentity(item.path),item.identity)) throw dirty()
    await unlink(item.path)
  }
  for (const item of copies) {
    await checkContext()
    // Never remove the last copy if the original disappeared since confirmation.
    if (!(await lstat(join(source,'SKILL.md')).catch(absent))?.isFile()) throw dirty()
    const info = await lstat(item.path)
    if (info.dev !== item.dev || info.ino !== item.ino || await realpath(item.path) !== item.path ||
        (await inspectSkillPackage(item.path)).stamp !== item.stamp) throw dirty()
    // Detach the verified directory before recursively removing it, so a recreated public path stays untouched.
    const retired = join(base,'.removing-' + item.version)
    if (!item.detached) {
      if (await lstat(retired).catch(absent)) throw dirty()
      await rename(item.path,retired)
    }
    await checkContext()
    const detached = await lstat(retired)
    if (detached.ino !== item.ino || detached.dev !== item.dev || await realpath(retired) !== retired ||
        (await inspectSkillPackage(retired)).stamp !== item.stamp ||
        !(await lstat(join(source,'SKILL.md')).catch(absent))?.isFile()) throw dirty()
    await rm(retired,{recursive:true})
  }
  const section = published ? 'skills' : 'linkedSkills'
  const next = {...registry,[section]:Object.fromEntries(Object.entries(registry[section]).filter(([slug]) => slug !== key))}
  await checkContext()
  await saveRegistry(home,next)
  if (published) await rmdir(base).catch(err => { if (!['ENOENT','ENOTEMPTY','EEXIST'].includes(err.code)) throw err })
  return { status:'removed',name:key }
}
