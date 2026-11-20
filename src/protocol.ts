import type { NativeResult } from './native-reader'
import type { SessionShells } from './session-shells'
import type { ResourceObservation } from './resource-classifier'
import type { ToolboxCatalog, ToolboxState, SyncResult, ToolboxComparison, ToolboxActivity, SkillReviewReport, RecommendationPreviewInput, RecommendationPreview, SkillAnalysisInput, SkillAnalysis, SkillInspection, SkillChangeInput, SkillChangeApplyInput, SkillChangePreview, SkillChangeReceipt } from './toolbox-types'
export type Call = { id: string; tool: string; agent: string; state: 'running' | 'finished' | 'uncertain'; startedAt?: number }
export {}
declare module 'orca' {
  interface PluginRequests {
    'toolbox.activity': { output: ToolboxActivity }
    'toolbox.catalog': { output: ToolboxCatalog }
    'toolbox.state': { output: ToolboxState }
    'toolbox.select': { input: { ids: string[]; workspaceId: string }; output: ToolboxState }
    'toolbox.prepare': { input: { workspaceId: string }; output: ToolboxState }
    'toolbox.revoke': { input: { workspaceId: string; bundleId: string }; output: ToolboxState }
    'toolbox.copy': { input: { workspaceId: string; bundleId: string }; output: { copied: boolean } }
    'toolbox.copyAdaptation': { input: { workspaceId: string; id: string; language: 'en' | 'ko' }; output: { copied: boolean; prompt: string } }
    'toolbox.automation': { input: { workspaceId: string; enabled: boolean }; output: ToolboxState }
    'toolbox.skillReview': { input: { workspaceId: string }; output: SkillReviewReport }
    'toolbox.previewSkillChange': { input: SkillChangeInput; output: SkillChangePreview }
    'toolbox.applySkillChange': { input: SkillChangeApplyInput; output: SkillChangeReceipt }
    'toolbox.skillChangeHistory': { input: { workspaceId: string }; output: SkillChangeReceipt[] }
    'toolbox.undoSkillChange': { input: { workspaceId: string; receiptId: string }; output: { restored: boolean } }
    'toolbox.previewSkills': { input: RecommendationPreviewInput; output: RecommendationPreview }
    'toolbox.inspectSkills': { input: SkillAnalysisInput; output: SkillInspection }
    'toolbox.reviewSkills': { input: SkillAnalysisInput; output: SkillAnalysis }
    'toolbox.copySkillReview': { input: SkillAnalysisInput; output: { copied: boolean; prompt: string } }
    'toolbox.compare': { input: { id: string }; output: ToolboxComparison }
    'toolbox.sync': { input: { workspaceId: string; ids: string[]; preserveProviderCopies?: boolean; reviewedSourceStamp?: string }; output: { results: SyncResult[]; catalog: ToolboxCatalog } }
    'native.get': { output: NativeResult }
    'session.shells': { input: { selected: string | null }; output: SessionShells }
    'calls.get': { output: { calls: Call[]; workspace: boolean; resources?: ResourceObservation[]; activeResources?: ResourceObservation[] } }
  }
  interface PluginPanelEvents {
    'toolbox.skillsChanged': Record<string, never>
    'toolbox.changed': Record<string, never>
    'calls.changed': Record<string, never>
  }
}
