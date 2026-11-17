import type { NativeResult } from './native-reader'
import type { ResourceObservation } from './resource-classifier'
export type Call = { id: string; tool: string; agent: string; state: 'running' | 'finished' | 'uncertain' }
export {}
declare module 'orca' {
  interface PluginRequests {
    'native.get': { output: NativeResult }
    'calls.get': { output: { calls: Call[]; workspace: boolean; resources?: ResourceObservation[] } }
  }
  interface PluginPanelEvents {
    'calls.changed': Record<string, never>
  }
}
