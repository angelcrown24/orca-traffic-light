import { createHash } from 'node:crypto'
import { basename, dirname } from 'node:path'
import { inspectMcpFields } from './catalog.mjs'
import { inspectSkillPackage } from './shared-sync.mjs'

const commandNames = new Set(['node', 'npx', 'bun', 'bunx', 'deno', 'python', 'python3', 'uv', 'uvx', 'docker', 'java'])
const hash = value => createHash('sha256').update(value).digest('hex')
const serialize = value => JSON.stringify(value, (_, part) => part && typeof part === 'object' && !Array.isArray(part)
  ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : part)

async function inspect(record) {
  if (record.kind === 'mcp') {
    const fields = await inspectMcpFields(record)
    const command = fields.command ? basename(fields.command) : ''
    if (fields.transport === 'http') {
      const [headers, envHeaders, bearer] = fields.authentication
      const headerNames = [...Object.keys(headers), ...Object.keys(envHeaders), ...(bearer ? ['Authorization'] : [])]
      return { fields, summary: { transport: 'http', headerCount: new Set(headerNames.map(name => name.toLowerCase())).size } }
    }
    const [env, inherited] = fields.environment
    return { fields, summary: {
      transport: 'stdio', argumentCount: fields.arguments.length, envCount: new Set([...Object.keys(env), ...inherited]).size,
      ...(commandNames.has(command) ? { commandHint: command } : {}),
    } }
  }
  const { entries } = await inspectSkillPackage(dirname(record.path), true)
  const fields = {
    files: entries.map(entry => [entry.path, entry.kind]),
    contents: entries.map(entry => entry.kind === 'file' ? hash(entry.content) : entry.target ?? null),
    permissions: entries.map(entry => entry.mode),
  }
  return { fields, summary: { fileCount: entries.filter(entry => entry.kind === 'file').length } }
}

// Compare one chosen group. Never put paths, endpoints, credentials, commands,
// package text, or guessable hashes in the UI payload.
export async function compareSources(catalog, id) {
  const chosen = catalog.items.find(item => item.id === id)
  if (!chosen) throw new Error('This item changed. Refresh the library.')
  const group = catalog.items.filter(item => item.kind === chosen.kind && item.name.trim().toLowerCase() === chosen.name.trim().toLowerCase())
  const versions = new Map(), values = [], sources = []
  for (const item of group) {
    const record = catalog.records.get(item.id)
    if (!record || !item.available) { sources.push({ id: item.id, variant: null }); continue }
    try {
      const { fields, summary } = await inspect(record)
      const digests = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, hash(serialize(value))]))
      const version = serialize(digests)
      if (!versions.has(version)) versions.set(version, versions.size + 1)
      values.push(digests)
      sources.push({ id: item.id, variant: versions.get(version), ...summary })
    } catch { sources.push({ id: item.id, variant: null }) }
  }
  const keys = new Set(values.flatMap(Object.keys))
  const differences = [...keys].filter(key => new Set(values.map(fields => fields[key])).size > 1)
  return { sources, differences }
}
