import type { NativeResult } from './native-reader'
import type { ResourceObservation } from './resource-classifier'
import type { ToolboxCatalog, ToolboxState, SyncResult, ToolboxComparison, ToolboxActivity } from './toolbox-types'
export type Call = { id: string; tool: string; agent: string; state: 'running' | 'finished' | 'uncertain' }
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
    'toolbox.compare': { input: { id: string }; output: ToolboxComparison }
    'toolbox.sync': { input: { workspaceId: string; ids: string[]; preserveProviderCopies?: boolean }; output: { results: SyncResult[]; catalog: ToolboxCatalog } }
    'native.get': { output: NativeResult }
    'calls.get': { output: { calls: Call[]; workspace: boolean; resources?: ResourceObservation[]; activeResources?: ResourceObservation[] } }
  }
  interface PluginPanelEvents {
    'toolbox.changed': Record<string, never>
    'calls.changed': Record<string, never>
  }
}
