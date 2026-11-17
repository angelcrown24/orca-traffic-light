declare module 'node:child_process' {
  export function execFile(file: string, args: string[], options: { timeout: number; maxBuffer: number; encoding: 'utf8' }, callback: (error: Error | null, stdout: string) => void): unknown
}

declare const process: { platform: string; env: Record<string, string | undefined> }
