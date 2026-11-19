import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
import { FAILSAFE_SCHEMA, load } from './vendor/js-yaml.mjs'

const blocked = (reason, providerOnly) => ({ available: false, reason, ...(providerOnly ? { providerOnly } : {}) })
const hostFields = ['hooks', 'context', 'agent', 'model', 'allowed-tools', 'disallowed-tools', 'tools', 'shell', 'paths', 'effort', 'permissionMode']
const map = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nativeTools = new Set(['node_repl', 'computer-use', 'codex_apps', 'codex-app-tools', 'unified-computer-use'])
export const isNativeTool = name => typeof name === 'string' && nativeTools.has(name.toLowerCase())
const host = '(?:Claude Code|Codex(?: CLI)?|Gemini CLI|Antigravity)'
const exclusiveHost = new RegExp('^(?:(?:requires?|(?:only (?:works|runs)|(?:works|runs) only) (?:in|on|with)) (?:the )?' + host + '|' + host + '(?:[- ]only|\\s*전용))[.!]?$', 'i')
// Additional prerequisite sentences are common. Limit matches to clear declarations
// so a quoted example, an optional integration or a list of hosts is never enough.
function declaresRequiredHost(text) {
  const [first, ...rest] = text.split(/[.!]\s+/)
  if (!exclusiveHost.test(first)) return false
  return rest.every(sentence => /^(?:requires?|needs?)\s+\S/i.test(sentence) &&
    !/\b(?:claude|codex|gemini|antigravity|or|optional|optionally|alternatively|instead|unless)\b/i.test(sentence))
}

function readMetadata(text) {
  const data = load(text, { schema: FAILSAFE_SCHEMA, maxAliases: 0, maxDepth: 32 }) ?? {}
  if (!map(data) || Object.hasOwn(data, '<<')) throw new Error('Unsupported metadata')
  return data
}

async function sidecar(skillPath) {
  const root = dirname(skillPath)
  let path
  try { path = await realpath(join(root, 'agents', 'openai.yaml')) }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return {}; throw error }
  const rel = relative(root, path)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('External metadata')
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try {
    const limit = 64 * 1024
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) throw new Error('Unsupported metadata file')
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) throw new Error('Metadata changed')
      offset += bytesRead
    }
    if ((await file.stat()).size !== info.size) throw new Error('Metadata changed')
    return readMetadata(buffer.toString('utf8'))
  } finally { await file.close() }
}

export async function skillPortability(content, skillPath) {
  const explicit = 'This skill requires explicit invocation in its original provider.'
  const native = 'This skill declares provider-specific execution or tool settings. Use its native connector.'
  try {
    const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/)
    let meta = {}
    if (lines[0]?.trim() === '---') {
      const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line))
      if (end < 0) throw new Error('Unclosed frontmatter')
      meta = readMetadata(lines.slice(1, end).join('\n'))
    }
    const manual = meta['disable-model-invocation']
    if (manual !== undefined && (typeof manual !== 'string' || !/^(true|yes|on|1|false|no|off|0)$/i.test(manual))) throw new Error('Invalid invocation policy')
    const config = await sidecar(skillPath)
    if ('policy' in config) {
      const policy = config.policy
      if (!map(policy) || Object.keys(policy).some(key => key !== 'allow_implicit_invocation')) throw new Error('Unknown policy')
      if ('allow_implicit_invocation' in policy && !['true', 'false'].includes(policy.allow_implicit_invocation)) throw new Error('Invalid policy')
    }
    if ('compatibility' in meta && typeof meta.compatibility !== 'string') throw new Error('Invalid compatibility')
    const requirements = (meta.compatibility ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim()
    const skillRequirements = requirements.slice(0, 500)
    if (config.dependencies !== undefined && !map(config.dependencies)) throw new Error('Invalid dependencies')
    const tools = config.dependencies?.tools ?? []
    if (!Array.isArray(tools) || !tools.every(tool => map(tool) && typeof tool.type === 'string' && typeof tool.value === 'string')) throw new Error('Invalid tool dependencies')
    if (/^(true|yes|on|1)$/i.test(manual) || config.policy?.allow_implicit_invocation === 'false') return blocked(explicit, 'explicit-invocation')
    if (declaresRequiredHost(requirements)) return { ...blocked('This skill declares a required provider in its compatibility field.', 'skill-execution'), skillRequirements }
    if (hostFields.some(key => Object.hasOwn(meta, key))) return blocked(native, 'skill-execution')
    if (tools.some(tool => tool.type === 'mcp' && (isNativeTool(tool.value) || isNativeTool(/^mcp__(.+?)__.+$/.exec(tool.value)?.[1])))) {
      return blocked('This skill declares a tool supplied by its native provider.', 'native-tool')
    }
    if (config.dependencies) return { available: true, skillRequirements: skillRequirements || 'This skill declares external dependencies in agents/openai.yaml. Check them before use.' }
    return skillRequirements ? { available: true, skillRequirements } : { available: true }
  } catch { return blocked('The skill’s provider metadata could not be verified. Use it in its original provider.') }
}
