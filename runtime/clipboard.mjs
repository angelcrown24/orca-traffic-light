import { spawn } from 'node:child_process'

// Called only by an explicit copy button. Text is piped to stdin, never interpolated into shell code.
export async function copyText(text) {
  const commands = process.platform === 'darwin' ? [['/usr/bin/pbcopy', []]]
    : process.platform === 'win32' ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value ([Console]::In.ReadToEnd())']]]
    : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]]
  for (const [command, args] of commands) {
    const copied = await new Promise(resolve => {
      let done = false
      const finish = ok => { if (!done) { done = true; clearTimeout(timer); resolve(ok) } }
      const child = spawn(command, args, { shell: false, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      const timer = setTimeout(() => { child.kill(); finish(false) }, 3000)
      child.once('error', () => finish(false))
      child.once('exit', code => finish(code === 0))
      child.stdin.on('error', () => finish(false))
      child.stdin.end(text, 'utf8')
    })
    if (copied) return true
  }
  return false
}
