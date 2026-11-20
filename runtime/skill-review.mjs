import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { inspectSkillPackage, readSharedRegistry } from './shared-sync.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const token = value => digest(JSON.stringify(value)).slice(0, 24)
const evidenceLimit = 6
const rulesVersion = 1
const reasons = new Set(['skill-execution', 'explicit-invocation', 'native-tool'])
const providerNames = new Set(['Shared', 'Claude Code', 'Codex', 'Antigravity', 'Gemini CLI'])
const sensitive = /(?:github_pat_|gh[pousr]_|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|xox[baprs]-|eyJ[A-Za-z0-9_-]{12,}\.)/i
export const safeName = value => typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}_. -]{0,99}$/u.test(value) && !sensitive.test(value) ? value : 'Skill'

function safeRelative(value) {
  return value.length <= 160 && !sensitive.test(value) && value.split('/').every(part =>
    /^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,79}$/u.test(part))
}

// Fenced documentation examples and output paths are common in skills that teach authors how to build a skill.
function readInstructions(content) {
  const references = new Map(), successors = []
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  let frontmatter = lines[0]?.trim() === '---', fence, exampleDepth = 0
  for (const [index, line] of lines.entries()) {
    if (frontmatter) {
      if (index && /^(?:---|\.\.\.)\s*$/.test(line)) frontmatter = false
      continue
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
      continue
    }
    if (marker) { fence = marker[1]; continue }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading) {
      if (exampleDepth && heading[1].length <= exampleDepth) exampleDepth = 0
      if (!exampleDepth && /\bexamples?\b/i.test(heading[2])) exampleDepth = heading[1].length
    }
    if (exampleDepth || /^(?: {4}|\t|\s*>)|\b(?:e\.g\.|examples?\b|for instance\b|for illustration\b)/i.test(line)) continue
    const paths = [...line.matchAll(/\]\((?:\.\/)?([\p{L}\p{N}_.\/-]+\.[\w-]+)(?:#[\w-]+)?\)/gu)].map(match => match[1])
    // Only explicit instructions to read/run a bundled file qualify. Bare mentions can describe future output.
    const instruction = /^\s*(?:(?:[-*+] |\d+[.)] ))?(?:read|consult|see|run|execute|invoke)\s+`(?:(?:python3?|bash|sh|node)\s+)?(?:\.\/)?((?:scripts|references|assets|templates)\/[\w./-]+\.[\w-]+)`/gi
    for (const match of line.matchAll(instruction)) paths.push(match[1])
    for (const path of paths) if (safeRelative(path) && !references.has(path)) references.set(path, index + 1)
    const preferred = /(?:^\s*(?:[-*] )?|\bbut\s+|[.;!]\s+)`([A-Za-z][A-Za-z0-9_.-]{0,95}-v\d{1,3})` is (?:the )?(?:preferred|recommended) (?:path|option|choice|version|skill) for new (?:installs|installations|projects)\b/i.exec(line)
    const replacement = /^(?:[-*] )?(?:(?:This (?:skill|version) (?:is|was|has been) )?(?:superseded|replaced) by|(?:This skill is )?deprecated[.,:; —-]+use) `([A-Za-z][A-Za-z0-9_.-]{0,95}-v\d{1,3})`(?: instead)?[.!\s]*$/i.exec(line.trim())
    const target = preferred?.[1] ?? replacement?.[1]
    if (target && !successors.some(row => row.name === target)) successors.push({name:target.toLowerCase(), line:index + 1})
  }
  return { references, successors }
}

async function missingReferences(root, entries, references) {
  const byPath = new Map(entries.map(entry => [entry.path.split(sep).join('/'), entry.kind]))
  const links = entries.filter(entry => entry.kind === 'link').map(entry => entry.path.split(sep).join('/'))
  const missing = []
  for (const [path, line] of references) {
    if (byPath.get(path) === 'file') continue
    if (links.some(link => path === link || path.startsWith(link + '/'))) {
      try {
        const resolved = await realpath(join(root, path))
        const rel = relative(root, resolved)
        if (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel) && (await stat(resolved)).isFile()) continue
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error
      }
    }
    missing.push({ path, line })
  }
  return missing
}

function differenceDetails(packages, sourceIds) {
  const paths = new Set(packages.flatMap(pkg => [...pkg.files.keys()]))
  const details = []
  for (const path of [...paths].sort()) {
    const values = packages.map(pkg => pkg.files.get(path))
    if (new Set(values).size === 1) continue
    if (sourceIds && values.includes(undefined)) {
      details.push({ path, state: 'only', ids: sourceIds.filter((_, index) => values[index] !== undefined) })
    } else {
      const state = !sourceIds && !values[0] ? 'added' : !sourceIds && !values[1] ? 'removed' : 'changed'
      details.push({ path, state })
    }
  }
  return details
}

function requirementField(entries, text, item) {
  let field, file = 'SKILL.md', lines = text.split(/\r?\n/)
  const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line))
  const keys = lines.slice(1, Math.max(1, end)).map(line => /^([\w-]+):/.exec(line)?.[1])
  if (item.providerOnly === 'explicit-invocation') {
    if (lines.slice(1, end).some(line => /^disable-model-invocation:\s*["']?(true|yes|1|on)["']?\s*(?:#.*)?$/i.test(line))) field = 'disable-model-invocation'
    else { field = 'allow_implicit_invocation'; file = 'agents/openai.yaml' }
  } else if (item.providerOnly === 'native-tool') {
    field = 'dependencies'; file = 'agents/openai.yaml'
  } else if (item.providerOnly === 'skill-execution') {
    field = item.reason?.includes('compatibility field') ? 'compatibility'
      : keys.find(key => ['hooks', 'context', 'agent', 'model', 'allowed-tools', 'disallowed-tools', 'tools', 'shell', 'paths', 'effort', 'permissionMode'].includes(key))
  }
  if (!field) return undefined
  if (file !== 'SKILL.md') {
    const content = entries.find(entry => entry.path.split(sep).join('/') === file)?.content
    if (!content) return undefined
    lines = content.toString('utf8').split(/\r?\n/)
  } else lines = lines.slice(0, end)
  const index = lines.findIndex(line => new RegExp('^\\s*' + field + ':').test(line))
  return { file, field, ...(index >= 0 ? { line: index + 1 } : {}) }
}

function finding(kind, items, files, version, extra = {}) {
  const ids = items.map(item => item.id).sort()
  const providers = [...new Set(items.flatMap(item => item.providers).filter(name => providerNames.has(name)))].sort()
  const key = kind + ':' + token([ids, extra.reason])
  const kept = []
  for (let i = 0; i < files.length && kept.length < evidenceLimit; i++) if (safeRelative(files[i])) kept.push(i)
  const evidence = kept.map(i => files[i])
  return { key, name: safeName(items[0].name), kind, providers, ids, stamp: token([rulesVersion, key, providers, version]),
    evidence, ...(files.length > evidence.length ? { evidenceCount: files.length } : {}),
    ...(extra.lines && kept.length ? { line: extra.lines[kept[0]], lines: kept.map(i => extra.lines[i]) } : {}),
    ...(extra.details && kept.length ? { evidenceDetails: kept.map(i => extra.details[i]) } : {}) }
}

// The catalog supplies canonical package roots. Cache only bounded metadata and findings, never file contents.
export function createSkillReviewer({ home } = {}) {
  let cache = new Map()
  return async function review(catalog) {
    const nextCache = new Map(), findings = [], excluded = new Map(), incompleteNames = new Set()
    const items = catalog.items.filter(item => item.kind === 'skill')
    const groups = new Map()
    let checked = 0, skipped = 0, identicalGroups = 0
    let bytesRemaining = 192 * 1024 * 1024
    function exclude(item, reason, version) {
      const key = JSON.stringify([item.name.toLowerCase(), reason])
      incompleteNames.add(item.name.trim().toLowerCase())
      if (!excluded.has(key)) excluded.set(key, { items: [], reason, versions: [] })
      const group = excluded.get(key)
      group.items.push(item); group.versions.push([item.id, version]); skipped++
    }
    async function inspect(root, item, expected) {
      if (await realpath(root) !== root) throw new Error('Changed package location')
      const meta = await inspectSkillPackage(root)
      if (meta.root !== root) throw new Error('Changed package location')
      const previous = nextCache.get(meta.root) ?? cache.get(meta.root)
      if (previous && previous.stamp === meta.stamp) {
        if (expected && previous.sourceFingerprint !== expected) throw new Error('Refresh the library')
        nextCache.set(meta.root, previous)
        return { data: previous, fresh: false }
      }
      const bytes = meta.entries.reduce((n, entry) => n + (entry.kind === 'file' ? entry.size : 0), 0)
      if (bytes > bytesRemaining) throw Object.assign(new Error('Review limit'), { code: 'REVIEW_LIMIT' })
      bytesRemaining -= bytes
      const full = await inspectSkillPackage(meta.root, true)
      if (full.stamp !== meta.stamp) throw new Error('Package changed during review')
      const skill = full.entries.find(entry => entry.path === 'SKILL.md')
      if (skill.size > 64 * 1024) throw new Error('Instruction file exceeds limit')
      const sourceFingerprint = digest(skill.content)
      if (expected && sourceFingerprint !== expected) throw new Error('Refresh the library')
      const files = new Map(full.entries.map(entry => [entry.path.split(sep).join('/'),
        token([entry.kind, entry.mode, entry.target ?? (entry.content && digest(entry.content))])]))
      const text = skill.content.toString('utf8')
      const { references, successors } = readInstructions(text)
      const data = { stamp: meta.stamp, fingerprint: full.fingerprint, sourceFingerprint, files, successors,
        ...(item?.providerOnly ? { requirement: requirementField(full.entries, text, item) } : {}),
        missing: await missingReferences(meta.root, meta.entries, references) }
      nextCache.set(meta.root, data)
      return { data, fresh: true }
    }

    const registered = items.some(item => item.sharing?.state === 'update') ? await readSharedRegistry(home).catch(() => null) : null
    const catalogPaths = new Map([...catalog.records.values()].filter(record => record.kind === 'skill').map(record => [record.path, record.fingerprint]))
    const exclusions = catalog.skillExclusions ?? []
    for (const item of exclusions) exclude(item, item.reason, item.stamp)
    for (const item of items) {
      const record = catalog.records.get(item.id)
      if (!record?.path || (!item.available && !item.providerOnly)) {
        exclude(item, record?.path ? 'unverified-metadata' : 'unreadable', record?.fingerprint)
        continue
      }
      let pkg, original, fresh = false, incomplete = false
      const sharing = item.sharing?.state
      try {
        const current = await inspect(dirname(record.path), item, record.fingerprint)
        pkg = current.data; fresh = current.fresh
        if (sharing === 'update') {
          const origin = registered?.skills[record.syncKey]
          const expected = origin && catalogPaths.get(join(origin.sourcePath, 'SKILL.md'))
          if (!expected) throw new Error('Registered source unavailable')
          const inspected = await inspect(origin.sourcePath, undefined, expected)
          original = inspected.data; fresh ||= inspected.fresh
        }
      } catch (error) {
        incomplete = true
        exclude(item, error.code === 'REVIEW_LIMIT' ? 'scan-limit' : 'unsupported-package', [pkg?.stamp, record.fingerprint])
      }
      if (sharing === 'conflict' || sharing === 'update') {
        const details = original && pkg ? differenceDetails([pkg, original]) : []
        const row = finding(sharing, [item], details.map(detail => detail.path),
          [pkg?.fingerprint, original?.fingerprint, item.sharing.detail], { details })
        findings.push(sharing === 'update' && original ? { ...row, reviewedSourceStamp: original.stamp } : row)
      }
      if (!pkg) continue
      if (!item.available && !reasons.has(item.providerOnly)) {
        exclude(item, 'unverified-metadata', pkg.stamp)
        continue
      }
      // A registered update can be listed for review even when its changed source cannot be inspected.
      if (fresh && !incomplete) checked++
      if (item.providerOnly) findings.push({ ...finding('provider', [item], [item.providerOnly], [pkg.fingerprint, item.providerOnly]),
        ...(pkg.requirement ? { requirement: pkg.requirement } : {}) })
      const name = item.name.trim().toLowerCase()
      if (!groups.has(name)) groups.set(name, [])
      groups.get(name).push({ item, pkg })
    }

    for (const group of groups.values()) {
      const versions = new Map()
      for (const row of group) {
        const key = row.pkg.fingerprint
        if (!versions.has(key)) versions.set(key, [])
        versions.get(key).push(row)
      }
      if (versions.size > 1) {
        const [first, second] = versions.values()
        const details = differenceDetails(group.map(row => row.pkg), group.map(row => row.item.id))
        const row = finding('variants', group.map(row => row.item), details.map(detail => detail.path),
          group.map(row => [row.item.id, row.pkg.fingerprint]).sort(), { details })
        findings.push({ ...row, comparisonIds: [first[0].item.id, second[0].item.id] })
      } else if (group.length > 1 && !incompleteNames.has(group[0].item.name.trim().toLowerCase())) identicalGroups++
      for (const copies of versions.values()) {
        const { missing, fingerprint, successors } = copies[0].pkg
        if (missing.length) findings.push(finding('missing', copies.map(row => row.item), missing.map(hit => hit.path), fingerprint, { lines: missing.map(hit => hit.line) }))
        const source = copies[0].item.name.toLowerCase()
        const family = source.replace(/-v\d+$/, ''), currentVersion = Number(source.slice(family.length + 2)) || 1
        for (const { name, line } of successors) {
          if (name.replace(/-v\d+$/, '') !== family || Number(name.slice(family.length + 2)) <= currentVersion) continue
          const targets = groups.get(name)
          if (!targets) continue
          const ordered = [...targets].sort((a, b) => Number(b.item.providers.includes('Shared')) - Number(a.item.providers.includes('Shared')) || a.item.id.localeCompare(b.item.id))
          const row = finding('successor', copies.map(copy => copy.item), [name],
            [fingerprint, ordered.map(target => [target.item.id, target.pkg.fingerprint])], { reason: name, lines: [line] })
          findings.push({ ...row, ids: [...row.ids, ...ordered.map(target => target.item.id)], successorId: ordered[0].item.id })
        }
      }
    }
    for (const group of excluded.values()) findings.push(finding('excluded', group.items, [group.reason], group.versions.sort(), { reason: group.reason }))
    cache = nextCache
    const partial = skipped > 0 || (catalog.warnings ?? []).some(warning => /skill|shared registry/i.test(warning))
    return { scanned: items.length + exclusions.length, checked, skipped, partial, identicalGroups, findings }
  }
}
