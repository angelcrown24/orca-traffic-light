export type ProviderOnlyReason = 'skill-execution' | 'explicit-invocation' | 'native-tool' | 'provider-auth' | 'tool-policy' | 'transport' | 'provider-options' | 'environment'
export type CatalogItem = {
  id: string
  kind: 'skill' | 'mcp'
  name: string
  description: string
  providers: string[]
  source: string
  available: boolean
  providerOnly?: ProviderOnlyReason
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

export type SkillReviewFinding = {
  key: string
  name: string
  kind: 'update' | 'variants' | 'missing' | 'provider' | 'conflict' | 'excluded' | 'successor'
  providers: string[]
  ids: string[]
  stamp: string
  evidence: string[]
  line?: number
  lines?: number[]
  evidenceCount?: number
  evidenceDetails?: { path: string; state: 'added' | 'removed' | 'changed' | 'only'; ids?: string[] }[]
  comparisonIds?: [string, string]
  successorId?: string
  reviewedSourceStamp?: string
  requirement?: { file: string; field: string; line?: number }
  workspaceCount?: number
}
export type SkillReviewReport = {
  scanned: number
  checked: number
  skipped: number
  partial: boolean
  identicalGroups: number
  findings: SkillReviewFinding[]
}
export type RecommendationPreviewInput = { workspaceId: string; query: string; edit?: { id: string; description: string } }
export type PreviewRanking = { method: 'kev' | 'keywords'; names: string[] }
export type RecommendationPreview = { before: PreviewRanking; after?: PreviewRanking }
export type SkillAnalysisInput = { workspaceId: string; ids: string[]; language: 'en' | 'ko' }
export type SkillAnalysis = { status: 'ready'; model: string; method?: 'decision' | 'generation'; text: string; truncated: boolean } | { status: 'unavailable' }

export type SkillInspection = {
  summary: string
  nextStep: string
  skills: { id: string; name: string; providers: string[] }[]
  evidence: { label: string; detail: string; source?: string }[]
}
