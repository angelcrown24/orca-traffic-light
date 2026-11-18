export type CatalogItem = {
  id: string
  kind: 'skill' | 'mcp'
  name: string
  description: string
  providers: string[]
  source: string
  available: boolean
  reason?: string
  skillRequirements?: string
  sharing?: { state: 'provider' | 'shared' | 'update' | 'conflict'; canSync: boolean; detail?: string }
}
export type CompareField = 'transport' | 'command' | 'arguments' | 'environment' | 'workingDirectory' | 'endpoint' | 'authentication' | 'timeouts' | 'files' | 'contents' | 'permissions'
export type SourceComparison = { id: string; variant: number | null; transport?: 'stdio' | 'http'; commandHint?: string; argumentCount?: number; envCount?: number; headerCount?: number; fileCount?: number }
export type ToolboxComparison = { sources: SourceComparison[]; differences: CompareField[] }
export type ToolboxCatalog = { items: CatalogItem[]; warnings: string[] }
export type ToolboxBundle = { id: string; names: string[]; instructions: string; createdAt: number }
export type ToolboxEvent = { id: string; bundleId: string; name: string; kind: 'skill' | 'mcp'; state: 'running' | 'succeeded' | 'failed'; capabilityName?: string; operation?: 'skill' | 'tools' | 'call' | 'reconnect'; recommendationId?: string; startedAt: number; finishedAt?: number }
export type AutomationState = { enabled: boolean; setup: boolean; providers: { name: string; state: string; detail?: string }[]; sessions: number; appliedIds?: string[]; error?: string }
export type SyncResult = { id: string; newId?: string; name: string; status: 'synced' | 'unchanged' | 'conflict' | 'failed'; message: string }
export type ToolboxState = { workspaceId: string | null; selected: string[]; bundle: ToolboxBundle | null; events: ToolboxEvent[]; automation?: AutomationState }

export type JevRecommendation = { id: string; name: string; kind: 'skill' | 'mcp'; at: number }
export type ToolboxActivity = { workspaceId: string | null; recommendations: JevRecommendation[]; events: ToolboxEvent[] }
