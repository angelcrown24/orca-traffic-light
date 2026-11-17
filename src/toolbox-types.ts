export type CatalogItem = {
  id: string
  kind: 'skill' | 'mcp'
  name: string
  description: string
  providers: string[]
  source: string
  available: boolean
  reason?: string
}
export type ToolboxCatalog = { items: CatalogItem[]; warnings: string[] }
export type ToolboxBundle = { id: string; names: string[]; instructions: string; createdAt: number }
export type ToolboxEvent = { id: string; bundleId: string; name: string; kind: 'skill' | 'mcp'; state: 'running' | 'succeeded' | 'failed'; startedAt: number; finishedAt?: number }
export type ToolboxState = { workspaceId: string | null; selected: string[]; bundle: ToolboxBundle | null; events: ToolboxEvent[] }
