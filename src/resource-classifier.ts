/** Names observed in a tool invocation. Inferred names are path references, not proof of use. */
export type ResourceObservation = {
  category: 'skill' | 'plugin' | 'mcp'
  name: string
  evidence: 'observed' | 'inferred'
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PATH_TO_SKILL = /(?:^|\/)skills\/(?:[A-Za-z0-9._-]+\/)*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(?:SKILL\.md(?=$|[\s"'`\\),;:#?])|scripts\/[A-Za-z0-9._/-]+)/g
const PATH_TO_PLUGIN_SKILL = /(?:^|\/)plugins\/cache\/[A-Za-z0-9._-]+\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/[A-Za-z0-9._-]+\/skills\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(?:SKILL\.md(?=$|[\s"'`\\),;:#?])|scripts\/[A-Za-z0-9._/-]+)/g
const PATH_TOOLS = /(?:^|[._-])(?:shell|bash|execute|exec|exec_command|read|read_file|readfile|terminal|command|run)(?:$|[._-])/i
const SAFE_FIELDS = new Set(['cmd', 'command', 'code', 'script', 'path', 'file', 'filepath', 'file_path', 'args', 'input'])

/** Extract bounded inputs without retaining them beyond this synchronous call. */
function inputStrings(input: unknown, depth = 0): string[] {
  if (depth > 3) return []
  if (typeof input === 'string') return [input.slice(0, 16384)]
  if (Array.isArray(input)) return input.slice(0, 32).flatMap((item) => inputStrings(item, depth + 1))
  if (!input || typeof input !== 'object') return []
  return Object.entries(input as Record<string, unknown>).slice(0, 32)
    .filter(([key]) => SAFE_FIELDS.has(key.toLowerCase()))
    .flatMap(([, value]) => inputStrings(value, depth + 1))
}

function skillArgument(input: unknown): string | undefined {
  if (typeof input === 'string') {
    const text = input.trim()
    // Snapshot summaries may be JSON, but arbitrary prose is not a skill invocation.
    if (text.startsWith('{') && text.length <= 16384) {
      try { return skillArgument(JSON.parse(text)) } catch { return undefined }
    }
    return text
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = (input as Record<string, unknown>).skill ?? (input as Record<string, unknown>).name
  return typeof value === 'string' ? value.trim() : undefined
}

/** Return only resource labels; never include a command, file contents, or tool payload. */
export function classifyResources(tool: string, input: unknown): ResourceObservation[] {
  const results: ResourceObservation[] = []
  const seen = new Set<string>()
  const add = (category: ResourceObservation['category'], name: string, evidence: ResourceObservation['evidence']) => {
    if (!IDENTIFIER.test(name)) return
    const key = `${category}:${name}`
    if (seen.has(key)) return
    seen.add(key)
    results.push({ category, name, evidence })
  }

  const mcp = /^mcp__([A-Za-z0-9][A-Za-z0-9._-]{0,127})__[^\s]+$/.exec(tool)
  if (mcp) add('mcp', mcp[1], 'observed')

  if (/^(?:skill|skill\.prompt)$/i.test(tool)) {
    const argument = skillArgument(input)
    if (argument) {
      const parts = argument.split(':')
      if (parts.length === 1) add('skill', parts[0], 'observed')
      else if (parts.length === 2 && parts.every((part) => IDENTIFIER.test(part))) {
        add('plugin', parts[0], 'inferred')
        add('skill', parts[1], 'observed')
      }
    }
  }

  if (!mcp && PATH_TOOLS.test(tool)) {
    for (const text of inputStrings(input)) {
      PATH_TO_SKILL.lastIndex = 0
      for (const match of text.matchAll(PATH_TO_SKILL)) add('skill', match[1], 'inferred')
      PATH_TO_PLUGIN_SKILL.lastIndex = 0
      for (const match of text.matchAll(PATH_TO_PLUGIN_SKILL)) add('plugin', match[1], 'inferred')
    }
  }
  return results
}
