import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import toml from './vendor/smol-toml.cjs'
import { decorateSharing, inspectSkillPackage } from './shared-sync.mjs'

const CONFIG_LIMIT = 2 * 1024 * 1024
const SKILL_LIMIT = 64 * 1024
const ENTRY_LIMIT = 6000
const ITEM_LIMIT = 1200
const hash = (text) => createHash('sha256').update(text).digest('hex')
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const stable = (value) => JSON.stringify(value, (_, part) => plain(part)
  ? Object.fromEntries(Object.keys(part).sort().map((key) => [key, part[key]])) : part)
const clean = (value, limit) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
const fail = (code, message) => Object.assign(new Error(message), { code })

async function readBounded(path, limit) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > limit) throw fail('INVALID_CONFIG', 'File is not a regular file within the supported size limit.')
    const bytes = Buffer.alloc(limit + 1)
    let count = 0
    while (count <= limit) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count)
      if (!bytesRead) break
      count += bytesRead
    }
    if (count > limit) throw fail('INVALID_CONFIG', 'File exceeds the supported size limit.')
    return bytes.subarray(0, count).toString('utf8')
  } finally { await handle.close() }
}

// Only two inert frontmatter strings are needed; YAML tags/objects are never evaluated.
function metadata(content, fallback) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { name: fallback, description: '' }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (end < 0) return { name: fallback, description: '' }
  const fields = {}
  for (let i = 1; i < end; i++) {
    const match = /^(name|description):\s*(.*)$/.exec(lines[i])
    if (!match) continue
    const key = match[1]
    let value = match[2].trim()
    if (/^[|>][-+]?\d?$/.test(value)) {
      const parts = []
      while (i + 1 < end && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) parts.push(lines[++i].trim())
      value = parts.join(' ')
    } else {
      while (i + 1 < end && /^\s+\S/.test(lines[i + 1])) value += ' ' + lines[++i].trim()
      if (value.startsWith('"')) {
        try { value = JSON.parse(value) } catch { value = '' }
      } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'")
      else value = value.replace(/\s+#.*$/, '')
    }
    if (typeof value === 'string' && !/^[!&*[{]/.test(value)) fields[key] = value
  }
  return { name: clean(fields.name, 100) || fallback, description: clean(fields.description, 320) }
}

const stringMap = (value) => plain(value) && Object.values(value).every((item) => typeof item === 'string')
const restrictions = ['enabled_tools', 'disabled_tools', 'includeTools', 'excludeTools', 'allowedTools', 'blockedTools']
const nativeNames = new Set(['node_repl', 'computer-use', 'codex_apps', 'codex-app-tools', 'unified-computer-use'])

function normalize(server, format, resolveEnv = false) {
  if (!plain(server)) throw fail('INVALID_CONFIG', 'Server definition must be an object.')
  if (server.enabled === false || server.disabled === true) throw fail('CAPABILITY_UNAVAILABLE', 'Disabled in the source configuration.')
  if (restrictions.some((key) => key in server)) throw fail('CAPABILITY_UNAVAILABLE', 'Per-tool restrictions require this provider’s native connector.')
  if (['oauth', 'auth', 'authorization', 'authProvider', 'authProviderType', 'oauth_client_id', 'http_headers_helper', 'bearerToken', 'accessToken', 'clientSecret'].some((key) => key in server)) {
    throw fail('CAPABILITY_UNAVAILABLE', 'Provider-managed authentication requires a native connector.')
  }
  if (server.type === 'sse' || server.transport === 'sse' || (format === 'gemini' && server.url && !server.httpUrl)) {
    throw fail('CAPABILITY_UNAVAILABLE', 'Legacy SSE transport requires a native connector.')
  }
  const url = format === 'gemini' ? server.httpUrl : server.url ?? server.serverUrl
  if (server.command && url) throw fail('INVALID_CONFIG', 'Ambiguous server transport.')
  const normalized = {}
  if (server.command) {
    if (typeof server.command !== 'string' || server.command.includes('\0')) throw fail('INVALID_CONFIG', 'Invalid server command.')
    if (['node_repl', 'SkyComputerUseClient'].includes(basename(server.command))) throw fail('CAPABILITY_UNAVAILABLE', 'Provider-internal tools require their native connector.')
    if (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === 'string' && !arg.includes('\0')))) {
      throw fail('INVALID_CONFIG', 'Invalid server arguments.')
    }
    if (server.env !== undefined && !stringMap(server.env)) throw fail('INVALID_CONFIG', 'Invalid server environment.')
    if (server.cwd !== undefined && (typeof server.cwd !== 'string' || !server.cwd || server.cwd.includes('\0'))) throw fail('INVALID_CONFIG', 'Invalid working directory.')
    if (server.env_vars !== undefined && (!Array.isArray(server.env_vars) || !server.env_vars.every((key) => typeof key === 'string' && /^[A-Za-z_][A-Za-z_0-9]*$/.test(key)))) {
      throw fail('INVALID_CONFIG', 'Invalid inherited environment declaration.')
    }
    normalized.command = server.command
    normalized.args = server.args ?? []
    normalized.env = { ...server.env }
    if (resolveEnv) for (const key of server.env_vars ?? []) {
      if (key in normalized.env) continue
      if (process.env[key] === undefined) throw fail('CAPABILITY_UNAVAILABLE', 'A required environment variable is not available.')
      normalized.env[key] = process.env[key]
    }
    if (server.cwd) normalized.cwd = server.cwd
  } else if (url) {
    if (typeof url !== 'string') throw fail('INVALID_CONFIG', 'Invalid server URL.')
    let parsed
    try { parsed = new URL(url) } catch { throw fail('INVALID_CONFIG', 'Invalid server URL.') }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw fail('CAPABILITY_UNAVAILABLE', 'This URL needs a native connector.')
    const headers = server.http_headers ?? server.headers ?? {}
    if (!stringMap(headers) || Object.entries(headers).some(([key, value]) => /[\r\n]/.test(key + value))) throw fail('INVALID_CONFIG', 'Invalid HTTP headers.')
    if (server.bearer_token_env_var !== undefined && (typeof server.bearer_token_env_var !== 'string' || !server.bearer_token_env_var)) throw fail('INVALID_CONFIG', 'Invalid bearer environment declaration.')
    if (server.env_http_headers !== undefined && !stringMap(server.env_http_headers)) throw fail('INVALID_CONFIG', 'Invalid environment header declaration.')
    normalized.url = url
    normalized.headers = { ...headers }
    if (resolveEnv) {
      for (const [header, variable] of Object.entries(server.env_http_headers ?? {})) {
        if (process.env[variable] === undefined) throw fail('CAPABILITY_UNAVAILABLE', 'A required authentication environment variable is not available.')
        normalized.headers[header] = process.env[variable]
      }
      if (server.bearer_token_env_var) {
        const token = process.env[server.bearer_token_env_var]
        if (!token) throw fail('CAPABILITY_UNAVAILABLE', 'A required authentication environment variable is not available.')
        normalized.headers.Authorization = `Bearer ${token}`
      }
      if (Object.entries(normalized.headers).some(([key, value]) => /[\r\n]/.test(key + value))) throw fail('INVALID_CONFIG', 'Invalid resolved HTTP headers.')
    }
  } else throw fail('CAPABILITY_UNAVAILABLE', 'No supported stdio or HTTP transport is configured.')
  if (JSON.stringify(normalized).includes('${')) throw fail('CAPABILITY_UNAVAILABLE', 'Environment placeholders require this provider’s native connector.')
  return normalized
}

async function configServers(path, format) {
  const content = await readBounded(path, CONFIG_LIMIT)
  let data
  try { data = format === 'codex' ? toml.parse(content) : JSON.parse(content) }
  catch { throw fail('INVALID_CONFIG', 'Could not parse the configuration.') }
  const servers = data?.[format === 'codex' ? 'mcp_servers' : 'mcpServers'] ?? {}
  if (!plain(servers)) throw fail('INVALID_CONFIG', 'The MCP server section must be an object.')
  return servers
}

export async function scanCatalog({ home = homedir() } = {}) {
  home = await realpath(home).catch(() => resolve(home))
  const items = [], warnings = [], records = new Map(), skillItems = new Map(), mcpItems = new Map()
  let inspected = 0
  const skillRoots = [
    ['.agents/skills', 'Shared'], ['.codex/skills', 'Codex'], ['.claude/skills', 'Claude Code'],
    ['.gemini/skills', 'Gemini CLI'], ['.gemini/config/skills', 'Antigravity'], ['.gemini/antigravity/skills', 'Antigravity']
  ]
  for (const [root, provider] of skillRoots) {
    const visited = new Set()
    async function walk(path, depth) {
      if (++inspected > ENTRY_LIMIT || items.length >= ITEM_LIMIT || depth > 7) return
      let canonical
      try { canonical = await realpath(path) } catch { return }
      if (visited.has(canonical)) return
      visited.add(canonical)
      const skillPath = join(canonical, 'SKILL.md')
      try {
        const resolved = await realpath(skillPath)
        const content = await readBounded(resolved, SKILL_LIMIT)
        const existing = skillItems.get(resolved)
        if (existing) {
          if (!existing.providers.includes(provider)) existing.providers.push(provider)
        } else {
          const meta = metadata(content, clean(basename(canonical), 100))
          const id = `skill:${hash(resolved).slice(0, 24)}`
          const item = { id, kind: 'skill', ...meta, providers: [provider], source: root, available: true }
          items.push(item); skillItems.set(resolved, item)
          records.set(id, { id, name: item.name, kind: 'skill', path: resolved, fingerprint: hash(content) })
        }
        return
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') { warnings.push(`Skipped an unreadable or oversized skill in ${root}.`); return }
      }
      let directory
      try {
        directory = await opendir(canonical)
        for await (const entry of directory) {
          if (inspected >= ENTRY_LIMIT || items.length >= ITEM_LIMIT) break
          if (entry.name === 'node_modules' || (entry.name.startsWith('.') && entry.name !== '.system')) continue
          if (entry.isDirectory() || entry.isSymbolicLink()) await walk(join(canonical, entry.name), depth + 1)
        }
      } catch { /* Unavailable provider folders are normal. */ }
    }
    await walk(join(home, root), 0)
  }
  if (inspected >= ENTRY_LIMIT || items.length >= ITEM_LIMIT) warnings.push('Skill inventory reached its scan limit; some entries are omitted.')
  const configs = [
    ['.codex/config.toml', 'codex', 'Codex'], ['.claude.json', 'claude', 'Claude Code'],
    ['.gemini/settings.json', 'gemini', 'Gemini CLI'], ['.gemini/config/mcp_config.json', 'antigravity', 'Antigravity'],
    ['.gemini/antigravity/mcp_config.json', 'antigravity', 'Antigravity']
  ]
  const seenConfigs = new Set()
  for (const [relative, format, provider] of configs) {
    let configPath, servers
    try {
      configPath = await realpath(join(home, relative))
      if (seenConfigs.has(configPath)) continue
      seenConfigs.add(configPath)
      servers = await configServers(configPath, format)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') warnings.push(`Could not read MCP metadata from ${relative}.`)
      continue
    }
    for (const [serverKey, server] of Object.entries(servers).slice(0, 300)) {
      if (nativeNames.has(serverKey.toLowerCase())) continue
      const name = clean(serverKey, 100)
      if (!name) continue
      let normalized, reason
      try { normalized = normalize(server, format) } catch (error) { reason = error.code ? error.message : 'Unsupported server configuration.' }
      const fingerprint = hash(stable(server))
      const signature = normalized ? stable({ normalized, env_vars: server.env_vars, bearer_token_env_var: server.bearer_token_env_var, env_http_headers: server.env_http_headers }) : `${configPath}:${serverKey}`
      const duplicate = mcpItems.get(signature)
      if (duplicate) { if (!duplicate.providers.includes(provider)) duplicate.providers.push(provider); continue }
      const id = `mcp:${hash(`${configPath}\0${serverKey}`).slice(0, 24)}`
      const item = { id, kind: 'mcp', name, description: 'Tools are discovered only when you request this server.', providers: [provider], source: relative, available: !reason, ...(reason ? { reason } : {}) }
      items.push(item); mcpItems.set(signature, item)
      records.set(id, { id, name, kind: 'mcp', configPath, format, serverKey, fingerprint })
    }
    if (Object.keys(servers).length > 300) warnings.push(`MCP inventory from ${relative} was limited to 300 entries.`)
  }
  items.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
  return decorateSharing({ items, warnings: [...new Set(warnings)], records }, home)
}

export async function resolveRecord(record) {
  if (record?.kind === 'skill') {
    try {
      const path = await realpath(record.path)
      const content = await readBounded(path, SKILL_LIMIT)
      if (path !== record.path || hash(content) !== record.fingerprint) throw fail('CAPABILITY_CHANGED', 'This skill changed. Prepare the selection again.')
      if (record.packageRoot && (await inspectSkillPackage(record.packageRoot, true)).fingerprint !== record.packageFingerprint) throw fail('CAPABILITY_CHANGED', 'This skill package changed. Prepare the selection again.')
      return { path }
    } catch (error) { if (error.code === 'CAPABILITY_CHANGED') throw error; throw fail('CAPABILITY_UNAVAILABLE', 'This skill is no longer readable.') }
  }
  if (record?.kind !== 'mcp') throw fail('INVALID_CONFIG', 'Unknown capability record.')
  let servers
  try { servers = await configServers(record.configPath, record.format) }
  catch { throw fail('CAPABILITY_UNAVAILABLE', 'The source configuration is no longer readable.') }
  const server = servers[record.serverKey]
  if (!server || hash(stable(server)) !== record.fingerprint) throw fail('CAPABILITY_CHANGED', 'This server changed. Prepare the selection again.')
  return normalize(server, record.format, true)
}
