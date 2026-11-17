export type Call = { id: string; tool: string; agent: string; state: 'running' | 'finished' }
export {}
declare module 'orca' {
  interface PluginRequests {
    'calls.get': { output: { calls: Call[]; workspace: boolean } }
  }
  interface PluginPanelEvents {
    'calls.changed': Record<string, never>
  }
}
