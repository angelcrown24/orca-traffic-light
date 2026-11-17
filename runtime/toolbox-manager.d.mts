import type { ToolboxCatalog, ToolboxState } from '../src/toolbox-types'
export function createToolboxManager(options: {
  getContext: () => Promise<{ workspaceId?: string } | null>
  getWorkspaces: () => Promise<{ workspaces: { id: string; path: string; hostId: string | null }[] }>
  post: () => unknown
  loadSelection?: (id: string) => Promise<unknown>
  saveSelection?: (id: string, ids: string[]) => Promise<unknown>
}): {
  catalog(): Promise<ToolboxCatalog>
  state(): Promise<ToolboxState>
  select(input: { workspaceId: string; ids: string[] }): Promise<ToolboxState>
  prepare(input: { workspaceId: string }): Promise<ToolboxState>
  revoke(input: { workspaceId: string; bundleId: string }): Promise<ToolboxState>
  copy(input: { workspaceId: string; bundleId: string }): Promise<{ copied: boolean }>
  dispose(): Promise<void>
}
