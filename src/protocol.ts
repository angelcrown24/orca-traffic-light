import type { NativeResult } from './native-reader'
export type Call = { id: string; tool: string; agent: string; state: 'running' | 'finished' | 'uncertain' }
export {}
declare module 'orca' {
  interface PluginRequests {
    'native.get': { output: NativeResult }
    'calls.get': { output: { calls: Call[]; workspace: boolean } }
  }
  interface PluginPanelEvents {
    'calls.changed': Record<string, never>
  }
}
