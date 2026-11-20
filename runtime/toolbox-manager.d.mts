import type { ToolboxCatalog, ToolboxState, SyncResult, ToolboxComparison, ToolboxActivity, SkillReviewReport, RecommendationPreviewInput, RecommendationPreview, SkillAnalysisInput, SkillAnalysis, SkillInspection } from '../src/toolbox-types'
export function createToolboxManager(options: {
  getContext: () => Promise<{ workspaceId?: string } | null>
  getWorkspaces: () => Promise<{ workspaces: { id: string; path: string; hostId: string | null }[] }>
  post: () => unknown
  loadSelection?: (id: string) => Promise<unknown>
  saveSelection?: (id: string, ids: string[]) => Promise<unknown>
  loadAutomation?: () => Promise<unknown>
  saveAutomation?: (entries: { workspaceId: string; records: { id: string; fingerprint: string }[] }[]) => Promise<unknown>
}): {
  activity(): Promise<ToolboxActivity>
  catalog(): Promise<ToolboxCatalog>
  state(): Promise<ToolboxState>
  select(input: { workspaceId: string; ids: string[] }): Promise<ToolboxState>
  prepare(input: { workspaceId: string }): Promise<ToolboxState>
  revoke(input: { workspaceId: string; bundleId: string }): Promise<ToolboxState>
  copy(input: { workspaceId: string; bundleId: string }): Promise<{ copied: boolean }>
  copyAdaptation(input: { workspaceId: string; id: string; language: 'en' | 'ko' }): Promise<{ copied: boolean; prompt: string }>
  initialize(): Promise<void>
  setAutomation(input: { workspaceId: string; enabled: boolean }): Promise<ToolboxState>
  skillReview(input: { workspaceId: string }): Promise<SkillReviewReport>
  previewSkills(input: RecommendationPreviewInput): Promise<RecommendationPreview>
  inspectSkills(input: SkillAnalysisInput): Promise<SkillInspection>
  reviewSkills(input: SkillAnalysisInput): Promise<SkillAnalysis>
  copySkillReview(input: SkillAnalysisInput): Promise<{ copied: boolean; prompt: string }>
  compare(input: { id: string }): Promise<ToolboxComparison>
  sync(input: { workspaceId: string; ids: string[]; preserveProviderCopies?: boolean; reviewedSourceStamp?: string }): Promise<{ results: SyncResult[]; catalog: ToolboxCatalog }>
  dispose(): Promise<void>
}
