declare module 'node:child_process' {
  export function execFile(file: string, args: string[], options: { timeout: number; maxBuffer: number; encoding: 'utf8' }, callback: (error: Error | null, stdout: string) => void): unknown
}

declare const process: { platform: string; env: Record<string, string | undefined> }

declare module 'node:fs/promises' {
  export function readFile(path: string, encoding: 'utf8'): Promise<string>
  export function realpath(path: string): Promise<string>
  export function lstat(path: string): Promise<{ dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; isFile(): boolean }>
}
declare module 'node:url' {
  export function pathToFileURL(path: string): URL
}
