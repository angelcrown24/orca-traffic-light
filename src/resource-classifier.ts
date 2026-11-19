/** Names observed in a tool invocation. Inferred names are path references, not proof of use. */
export type ResourceObservation = {
  category: 'skill' | 'plugin' | 'mcp'
  name: string
  evidence: 'observed' | 'inferred'
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const PATH_TO_SKILL = /(?:^|\/)skills\/(?:[A-Za-z0-9._-]+\/)*([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(?:SKILL\.md(?=$|[\s"'`\\),;:#?])|scripts\/[A-Za-z0-9._/-]+)/g
const PATH_TO_PLUGIN_SKILL = /(?:^|\/)plugins\/cache\/[A-Za-z0-9._-]+\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/[A-Za-z0-9._-]+\/skills\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/(?:SKILL\.md(?=$|[\s"'`\\),;:#?])|scripts\/[A-Za-z0-9._/-]+)/g
const PATH_TOOLS = /(?:^|[._-])(?:shell|bash|execute|exec|exec_command|read|read_file|readfile|view_file|terminal|command|run)(?:$|[._-])/i
const SAFE_FIELDS = new Set(['cmd', 'command', 'code', 'script', 'path', 'file', 'filepath', 'file_path', 'absolutepath', 'absolute_path', 'commandline', 'args', 'input'])

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

type McpIdentity = { server: unknown; tool: unknown }

/** Native tools can arrive as structured JSON or the CLI's bounded JSON preview. */
export function structuredInput(input: unknown): unknown {
  if (typeof input === 'string' && input.trimStart().startsWith('{')) {
    if (input.length > 16384) return null
    try { return JSON.parse(input) } catch { return null }
  }
  return input
}

export function mcpIdentity(tool: string, input: unknown, native?: McpIdentity): { server: string; tool: string } | null {
  let server = native?.server, operation = native?.tool
  if (!server && tool === 'execute' && input && typeof input === 'object' && !Array.isArray(input)) {
    const args = input as Record<string, unknown>
    server = args.ServerName
    operation = args.ToolName
  }
  if (typeof server === 'string' && IDENTIFIER.test(server) && typeof operation === 'string' && IDENTIFIER.test(operation)) return { server, tool: operation }
  const match = /^mcp__([A-Za-z0-9][A-Za-z0-9._-]{0,127}?)__([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(tool)
  return match ? { server: match[1], tool: match[2] } : null
}

/** Codex journals render a shell argv as /bin/zsh -lc "…". Accept one literal command only. */
function unwrapHostShell(command: string): string | null {
  const wrapper = /^[ \t]*\/bin\/(?:bash|zsh)[ \t]+-lc[ \t]+(?:"((?:[^"\\$\x60\r\n]|\\["\\])*)"|'([^'\r\n]*)')[ \t]*$/.exec(command)
  if (!wrapper) return null
  const inner = wrapper[2] ?? wrapper[1].replace(/\\(["\\])/g, '$1')
  // Outside quotes permit simple argument characters. Inside single quotes JSON is literal.
  const simpleCommand = /^(?:[ \t\p{L}\p{N}._/@%+=,:-]|'[^'\r\n]*'|"(?:[^"\\$\x60\r\n]|\\["\\])*")*$/u
  return simpleCommand.test(inner) ? inner : null
}

/** Only a literal executable in command position counts; never scan code, arguments or prose. */
export function directJevCommand(tool: string, input: unknown): string | null {
  if (!/^(?:bash|shell|execute|terminal|run_command|run_shell_command|(?:functions[./])?exec_command)$/i.test(tool)) return null
  const decoded = structuredInput(input)
  const fields = decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded as Record<string, unknown> : null
  if (fields && (fields.ServerName || fields.ToolName)) return null
  const command = fields ? fields.command ?? fields.cmd ?? fields.CommandLine ?? fields.command_line : decoded
  let executable: unknown, operation: unknown
  if (Array.isArray(command)) {
    if (command.some(arg => ['--help', '-h', '--version', '-V'].includes(arg))) return null
    executable = command[0]
    operation = command[1]
  } else if (typeof command === 'string') {
    if (command.length > 16384) return null
    const literal = unwrapHostShell(command) ?? command
    const match = /^[ \t]*(?:'([^'\r\n]+)'|"([^"\r\n]+)"|([^\s'"]+))[ \t]+(rank|classify)(?=[ \t\r\n]|$)/.exec(literal)
    if (!match || /(?:^|[ \t])['"]?(?:--help|-h|--version|-V)['"]?(?=[ \t;&|\r\n]|$)/.test(literal)) return null
    executable = match[1] ?? match[2] ?? match[3]
    operation = match[4]
  }
  if (typeof executable !== 'string' || !/^(?:\/(?:[ A-Za-z0-9._+@-]+\/)*)?jev-code$/.test(executable)) return null
  return operation === 'rank' || operation === 'classify' ? 'jev-code/' + operation : null
}

/** A tool's free-form display title can be a question containing private prompt text. */
export function nativeToolName(tool: string, input: unknown, native?: McpIdentity): string | null {
  const name = tool.replace(/^Running /, '')
  const mcp = mcpIdentity(name, structuredInput(input), native)
  if (mcp) return mcp.server + '/' + mcp.tool
  const jev = directJevCommand(name, input)
  if (jev) return jev
  return name.length <= 256 && name.split('/').length <= 2 && name.split('/').every(part => IDENTIFIER.test(part)) ? name : null
}

/** Return only resource labels; never include a command, file contents, or tool payload. */
export function classifyResources(tool: string, input: unknown, native?: McpIdentity): ResourceObservation[] {
  const results: ResourceObservation[] = []
  const seen = new Set<string>()
  const add = (category: ResourceObservation['category'], name: string, evidence: ResourceObservation['evidence']) => {
    if (!IDENTIFIER.test(name)) return
    const key = `${category}:${name}`
    if (seen.has(key)) return
    seen.add(key)
    results.push({ category, name, evidence })
  }

  tool = tool.replace(/^Running /, '')
  input = structuredInput(input)
  const identity = mcpIdentity(tool, input, native)
  if (identity) add('mcp', identity.server, 'observed')

  if (/^(?:skill|skill\.prompt|activate_skill)$/i.test(tool)) {
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

  if (!identity && PATH_TOOLS.test(tool)) {
    for (const text of inputStrings(input)) {
      PATH_TO_SKILL.lastIndex = 0
      for (const match of text.matchAll(PATH_TO_SKILL)) add('skill', match[1], 'inferred')
      PATH_TO_PLUGIN_SKILL.lastIndex = 0
      for (const match of text.matchAll(PATH_TO_PLUGIN_SKILL)) add('plugin', match[1], 'inferred')
    }
  }
  return results
}
