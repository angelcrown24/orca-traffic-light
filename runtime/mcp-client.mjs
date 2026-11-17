import { spawn } from 'node:child_process'

export class ToolboxError extends Error {
  constructor(code, message) { super(message); this.name = 'ToolboxError'; this.code = code }
}
const fail = (code, message) => new ToolboxError(code, message)
const MAX_MESSAGE = 4 * 1024 * 1024
const PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])

// A connection belongs to exactly one bundle. No model, workspace, or account state is shared.
export class McpClient {
  constructor(config, options = {}) {
    this.config = config
    this.startupTimeout = Math.max(1, Math.min(options.startupTimeoutMs ?? 20_000, 30_000))
    this.requestTimeout = Math.max(1, Math.min(options.requestTimeoutMs ?? 60_000, 60_000))
    this.pending = new Map()
    this.sequence = 0
    this.closed = false
    this.controllers = new Set()
    this.protocol = '2025-03-26'
  }
  async connect() {
    if (this.config.command) this.startStdio()
    else {
      let url
      try { url = new URL(this.config.url) } catch { throw fail('UNSUPPORTED_TRANSPORT', 'The server has no supported transport.') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('UNSUPPORTED_TRANSPORT', 'Only HTTP(S) MCP endpoints without URL credentials are supported.')
    }
    try {
      const result = await this.request('initialize', {
        protocolVersion: this.protocol, capabilities: {}, clientInfo: { name: 'traffic-light-toolbox', version: '0.4.0' }
      }, this.startupTimeout)
      if (!result || !PROTOCOLS.has(result.protocolVersion)) throw fail('PROTOCOL_UNSUPPORTED', 'This server uses an unsupported MCP protocol version.')
      this.protocol = result.protocolVersion
      await this.notify('notifications/initialized', {})
      return this
    } catch (error) { this.close(); throw error }
  }
  startStdio() {
    const c = this.config
    if (typeof c.command !== 'string' || !c.command || (c.args && (!Array.isArray(c.args) || c.args.some(x => typeof x !== 'string')))) throw fail('INVALID_SERVER', 'The selected server command is invalid.')
    this.process = spawn(c.command, c.args ?? [], {
      cwd: c.cwd, env: { ...process.env, ...(c.env ?? {}) }, shell: false,
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true
    })
    this.process.stderr.resume() // Never retain or forward server diagnostics: they may contain credentials.
    this.process.stdin.on('error', () => this.breakConnection(fail('SERVER_CLOSED', 'The server input connection closed.')))
    let buffer = ''
    this.process.stdout.setEncoding('utf8')
    this.process.stdout.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > MAX_MESSAGE) { this.breakConnection(fail('RESPONSE_TOO_LARGE', 'The server response exceeded the size limit.')); return }
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        let message
        try { message = JSON.parse(line) } catch { this.breakConnection(fail('INVALID_PROTOCOL', 'The server wrote non-MCP data to stdout.')); return }
        this.receive(message)
      }
    })
    this.process.once('error', () => this.breakConnection(fail('SERVER_START_FAILED', 'The selected server could not start. Check its installation.')))
    this.process.once('exit', () => this.breakConnection(fail('SERVER_CLOSED', 'The selected server exited. Reconnect explicitly before using it again.')))
  }
  receive(message) {
    if (!message || message.jsonrpc !== '2.0') { this.breakConnection(fail('INVALID_PROTOCOL', 'The server returned an invalid MCP message.')); return }
    if (message.method && message.id !== undefined) {
      // Sampling and other client-side capabilities are intentionally not advertised.
      this.process?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Client capability not supported' } }) + '\n')
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id); clearTimeout(pending.timer)
    if (message.error) pending.reject(fail('MCP_ERROR', 'The MCP server rejected the request.'))
    else if ('result' in message) pending.resolve(message.result)
    else pending.reject(fail('INVALID_PROTOCOL', 'The server returned an invalid response.'))
  }
  async request(method, params, timeout = this.requestTimeout) {
    if (this.closed) throw fail('SERVER_CLOSED', 'The server connection is closed. Reconnect explicitly.')
    const message = { jsonrpc: '2.0', id: ++this.sequence, method, params }
    if (!this.process) return this.http(message, timeout)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id)
        reject(fail('TIMEOUT', 'The tool request timed out. Its side effects may have occurred; it was not retried.'))
        this.close()
      }, timeout)
      this.pending.set(message.id, { resolve, reject, timer })
      this.process.stdin.write(JSON.stringify(message) + '\n', error => {
        if (error) this.breakConnection(fail('SERVER_CLOSED', 'The server input connection closed.'))
      })
    })
  }
  async notify(method, params) {
    const message = { jsonrpc: '2.0', method, params }
    if (this.closed) throw fail('SERVER_CLOSED', 'The server connection is closed.')
    if (this.process) this.process.stdin.write(JSON.stringify(message) + '\n')
    else await this.http(message, Math.min(this.startupTimeout, 5_000))
  }
  async http(message, timeout) {
    const controller = new AbortController(); this.controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), timeout)
    let reader
    try {
      const headers = { ...(this.config.headers ?? {}), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': this.protocol }
      if (this.session) headers['Mcp-Session-Id'] = this.session
      const response = await fetch(this.config.url, { method: 'POST', headers, body: JSON.stringify(message), signal: controller.signal, redirect: 'error' })
      if (!response.ok) throw fail(response.status === 401 || response.status === 403 ? 'AUTH_REQUIRED' : 'SERVER_HTTP_ERROR', 'The MCP endpoint rejected the request. Check its connection and authentication.')
      const session = response.headers.get('mcp-session-id')
      if (session) this.session = session
      if (message.id === undefined) { await response.body?.cancel(); return undefined }
      if (!response.body) throw fail('INVALID_PROTOCOL', 'The server returned an empty response.')
      const sse = (response.headers.get('content-type') ?? '').includes('text/event-stream')
      reader = response.body.getReader()
      const decoder = new TextDecoder(); let text = ''; let size = 0
      while (true) {
        const { done, value } = await reader.read()
        if (value) { size += value.byteLength; if (size > MAX_MESSAGE) throw fail('RESPONSE_TOO_LARGE', 'The server response exceeded the size limit.'); text += decoder.decode(value, { stream: true }) }
        if (sse) {
          let match
          while ((match = /\r?\n\r?\n/.exec(text))) {
            const frame = text.slice(0, match.index); text = text.slice(match.index + match[0].length)
            const data = frame.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n')
            if (!data) continue
            let parsed
            try { parsed = JSON.parse(data) } catch { throw fail('INVALID_PROTOCOL', 'The server returned invalid event data.') }
            if (parsed.id === message.id) return this.result(parsed)
          }
        }
        if (done) break
      }
      if (sse) throw fail('INVALID_PROTOCOL', 'The server stream ended without a result.')
      let parsed
      try { parsed = JSON.parse(text) } catch { throw fail('INVALID_PROTOCOL', 'The server returned invalid JSON.') }
      if (parsed.id !== message.id) throw fail('INVALID_PROTOCOL', 'The server returned a mismatched response.')
      return this.result(parsed)
    } catch (error) {
      if (error instanceof ToolboxError) throw error
      if (controller.signal.aborted) throw fail('TIMEOUT', 'The tool request timed out or was cancelled. Its side effects may have occurred; it was not retried.')
      throw fail('CONNECTION_FAILED', 'Could not connect to the selected MCP server.')
    } finally {
      clearTimeout(timer); this.controllers.delete(controller)
      try { await reader?.cancel() } catch {}
    }
  }
  result(message) {
    if (message.jsonrpc !== '2.0' || (!('result' in message) && !message.error)) throw fail('INVALID_PROTOCOL', 'The server returned an invalid MCP response.')
    if (message.error) throw fail('MCP_ERROR', 'The MCP server rejected the request.')
    return message.result
  }
  breakConnection(error) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error) }
    this.pending.clear(); this.close()
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(fail('SERVER_CLOSED', 'The server connection was closed.')) }
    this.pending.clear()
    for (const c of this.controllers) c.abort()
    if (this.process) {
      const child = this.process
      child.stdin.destroy()
      const kill = signal => { try { process.platform !== 'win32' ? process.kill(-child.pid, signal) : child.kill(signal) } catch {} }
      kill('SIGTERM')
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) kill('SIGKILL') }, 750); timer.unref()
      child.once('exit', () => clearTimeout(timer))
    }
  }
}
