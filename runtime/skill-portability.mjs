import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
import { FAILSAFE_SCHEMA, load } from './vendor/js-yaml.mjs'

const blocked = reason => ({ available: false, reason })
const hostFields = ['hooks', 'context', 'agent', 'model', 'allowed-tools', 'disallowed-tools', 'tools', 'shell', 'paths', 'effort', 'permissionMode']
const map = value => value !== null && typeof value === 'object' && !Array.isArray(value)

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
    if (Object.hasOwn(meta, 'disable-model-invocation') && !/^(false|no|off|0)$/i.test(meta['disable-model-invocation'])) return blocked(explicit)
    if (hostFields.some(key => Object.hasOwn(meta, key))) return blocked(native)
    const config = await sidecar(skillPath)
    if ('policy' in config) {
      const policy = config.policy
      if (!map(policy) || Object.keys(policy).some(key => key !== 'allow_implicit_invocation')) return blocked(native)
      if ('allow_implicit_invocation' in policy && policy.allow_implicit_invocation !== 'true') return blocked(explicit)
    }
    const skillRequirements = typeof meta.compatibility === 'string' ? meta.compatibility.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 500) : ''
    if (config.dependencies) return { available: true, skillRequirements: skillRequirements || 'This skill declares external dependencies in agents/openai.yaml. Check them before use.' }
    return skillRequirements ? { available: true, skillRequirements } : { available: true }
  } catch { return blocked('The skill’s provider metadata could not be verified. Use it in its original provider.') }
}
