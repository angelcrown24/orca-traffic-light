import { mcpIdentity, structuredInput } from './resource-classifier'

export const sessionEditTools = new Set(['edit_file', 'write_file', 'replace_file_content', 'multi_replace_file_content',
  'write_to_file', 'edit', 'write', 'multiedit', 'apply_patch', 'functions.apply_patch', 'functions/apply_patch'])
export const sessionShellTools = new Set(['bash', 'shell', 'terminal', 'run_command', 'run_shell_command', 'exec_command',
  'functions.exec_command', 'functions/exec_command', 'shell_command', 'functions.shell_command', 'functions/shell_command'])

// Only these known operations may be followed by free-form arguments in a provider display title.
export const sessionTitleTools = new Set([...sessionEditTools, ...sessionShellTools, 'execute', 'view_file', 'read_file',
  'list_dir', 'list_files', 'list_directory', 'view_file_outline', 'search_file_content', 'grep_search', 'find_by_name',
  'search', 'read', 'grep', 'glob'])
const identifier = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/
const credential = /^(?:sk-(?:proj-|ant-|live_|test_)?[A-Za-z0-9_-]{16,}|gh[pousr]_|github_pat_|AKIA[A-Z0-9]{16}|xox[baprs]-|eyJ[A-Za-z0-9_-]{12,}\.)/i

/** Display the tool identity only. Raw titles, paths, arguments and malformed identities stay in the worker. */
export function sessionToolName(raw: unknown, input?: unknown, native?: { server: unknown; tool: unknown }): string | undefined {
  let name = typeof raw === 'string' && raw.length <= 4096 ? raw : ''
  if (!native && /^running /i.test(name)) {
    name = name.slice(8)
    const split = name.search(/\s/)
    if (split >= 0) {
      const token = name.slice(0, split)
      if (!sessionTitleTools.has(token.toLowerCase())) return undefined
      name = token
    }
  }
  const wrapped = !native && name.toLowerCase() === 'execute' ? structuredInput(input) : undefined
  const fields = wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped) ? wrapped as Record<string, unknown> : undefined
  const declared = native ?? (fields && ('ServerName' in fields || 'ToolName' in fields)
    ? { server: fields.ServerName, tool: fields.ToolName } : undefined)
  if (declared || name.startsWith('mcp__')) {
    const mcp = declared ? mcpIdentity('', undefined, declared) : mcpIdentity(name, undefined)
    return mcp && !credential.test(mcp.server) && !credential.test(mcp.tool) ? mcp.server + '/' + mcp.tool : undefined
  }
  // The slash spelling occurs in Orca's Codex records. Other paths have no verified namespace here.
  const part = name.startsWith('functions/') ? name.slice('functions/'.length) : name
  return identifier.test(part) && !credential.test(part) ? name : undefined
}
