import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { McpClient, ToolboxError } from './mcp-client.mjs'

const MAX_BODY = 64 * 1024
const MAX_RESPONSE = 4 * 1024 * 1024
const error = (code, message) => new ToolboxError(code, message)
const safeEqual = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

async function readBody(req) {
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw error('REQUEST_TOO_LARGE', 'Tool arguments exceed the request size limit.')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw error('INVALID_REQUEST', 'Send a JSON request object.') }
}
function write(res, status, data) {
  if (res.destroyed || res.writableEnded) return
  let body = JSON.stringify(data)
  if (Buffer.byteLength(body) > MAX_RESPONSE) { status = 413; body = JSON.stringify({ ok: false, error: { code: 'RESPONSE_TOO_LARGE', message: 'The tool response exceeded the size limit.' } }) }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(body)
}

/** Creates only a lightweight local gateway. MCP processes start on tools/call, never on prepare/list. */
export async function createToolboxService(options) {
  if (typeof options?.resolveRecord !== 'function') throw new TypeError('resolveRecord is required')
  const bundles = new Map()
  const idleMs = options.idleTimeoutMs ?? 15 * 60_000
  let endpoint = ''; let closed = false; let activeRequests = 0
  function emit(event) { try { options.onEvent?.({ ...event }) } catch {} }
  async function disposeClient(entry) {
    entry?.client?.close()
    if (entry?.pending) { try { (await entry.pending).close() } catch {} }
  }
  function getRecord(bundle, id, kind) {
    const record = bundle.records.get(id)
    if (!record || record.kind !== kind) throw error('NOT_SELECTED', 'This capability is not selected in this bundle.')
    return record
  }
  async function connection(bundle, record) {
    let entry = bundle.clients.get(record.id)
    if (entry?.expired || entry?.client?.closed) throw error('RECONNECT_REQUIRED', 'The server connection ended or expired. Use reconnect explicitly; server state may reset.')
    if (entry?.pending) return entry.pending
    if (entry?.client) { entry.lastUsed = Date.now(); return entry.client }
    if ([...bundles.values()].reduce((sum, b) => sum + b.clients.size, 0) >= 48) throw error('CLIENT_LIMIT', 'Too many tool connections are open. Revoke unused bundles first.')
    entry = { lastUsed: Date.now(), busy: 0 }; bundle.clients.set(record.id, entry)
    entry.pending = (async () => {
      const config = await options.resolveRecord(record)
      if (closed || bundle.revoked) throw error('BUNDLE_EXPIRED', 'The bundle has been revoked. Prepare a new bundle in Traffic Light.')
      const client = new McpClient({ ...config, cwd: config.cwd ?? bundle.workspacePath }, options)
      entry.client = client
      await client.connect()
      if (closed || bundle.revoked) { client.close(); throw error('BUNDLE_EXPIRED', 'The bundle has been revoked.') }
      entry.lastUsed = Date.now()
      return client
    })()
    try { return await entry.pending }
    catch (cause) { entry.expired = true; entry.client?.close(); throw cause }
    finally { entry.pending = undefined }
  }
  async function tools(client) {
    const deadline = Date.now() + Math.min(options.requestTimeoutMs ?? 15_000, 15_000)
    const all = []; let cursor
    for (let page = 0; page < 10; page++) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw error('TIMEOUT', 'Tool discovery timed out. No tool action was sent.')
      const result = await client.request('tools/list', cursor ? { cursor } : {}, remaining)
      if (!Array.isArray(result?.tools)) throw error('INVALID_PROTOCOL', 'The server returned an invalid tool list.')
      for (const tool of result.tools) {
        if (typeof tool?.name !== 'string' || !tool.name || tool.name.length > 200 || /[\x00-\x1f]/.test(tool.name)) throw error('INVALID_PROTOCOL', 'The server returned an invalid tool name.')
        all.push(tool)
      }
      if (all.length > 1000) throw error('TOOL_LIMIT', 'The server exposes too many tools for this bundle runner.')
      cursor = result.nextCursor
      if (!cursor) return { tools: all }
      if (typeof cursor !== 'string' || cursor.length > 4096) throw error('INVALID_PROTOCOL', 'The server returned an invalid pagination cursor.')
    }
    throw error('TOOL_LIMIT', 'The server tool list exceeded the page limit.')
  }
  async function operation(bundle, request) {
    if (!object(request) || typeof request.op !== 'string') throw error('INVALID_REQUEST', 'A valid operation is required.')
    if (request.op === 'list') return {
      bundleId: bundle.id, workspaceId: bundle.workspaceId,
      items: [...bundle.records.values()].map(({ id, name, kind }) => ({ id, name, kind })),
      note: 'Only selected metadata is listed. Skill content and MCP schemas are loaded on demand.'
    }
    if (!['skill', 'tools', 'call', 'reconnect'].includes(request.op)) throw error('INVALID_REQUEST', 'Unknown operation.')
    if (typeof request.id !== 'string') throw error('INVALID_REQUEST', 'A selected capability ID is required.')
    const record = getRecord(bundle, request.id, request.op === 'skill' ? 'skill' : 'mcp')
    if (request.op === 'call' && (typeof request.tool !== 'string' || !request.tool || request.tool.length > 200 || /[\x00-\x1f]/.test(request.tool) || !object(request.arguments))) throw error('INVALID_REQUEST', 'A tool name and JSON argument object are required.')
    const event = { id: randomUUID(), bundleId: bundle.id, name: record.name + (request.op === 'call' ? ' · ' + request.tool : ''), kind: record.kind, state: 'running', startedAt: Date.now() }
    emit(event)
    let entry
    try {
      let result
      if (request.op === 'skill') {
        const resolved = await options.resolveRecord(record)
        const info = await stat(resolved.path)
        if (!info.isFile() || info.size > 128 * 1024) throw error('SKILL_TOO_LARGE', 'The skill file is unavailable or too large.')
        const content = await readFile(resolved.path, 'utf8')
        if (Buffer.byteLength(content) > 128 * 1024) throw error('SKILL_TOO_LARGE', 'The skill file exceeded the size limit.')
        result = { id: record.id, name: record.name, path: resolved.path, content }
      } else {
        if (request.op === 'reconnect') {
          const previous = bundle.clients.get(record.id)
          if (previous?.busy || previous?.pending) throw error('SERVER_BUSY', 'Wait for this server\'s current operation before reconnecting.')
          await disposeClient(previous); bundle.clients.delete(record.id)
        }
        const client = await connection(bundle, record)
        entry = bundle.clients.get(record.id); entry.busy++; entry.lastUsed = Date.now()
        if (request.op === 'reconnect') result = { reconnected: true, note: 'A new server connection was created. Previous server session state may have reset.' }
        else if (request.op === 'tools') { result = await tools(client); entry.tools = result }
        else {
          // Check the live selected server's catalog, rather than silently invoking an arbitrary name.
          const catalog = entry.tools ?? await tools(client)
          entry.tools = catalog
          if (!catalog.tools.some(x => x.name === request.tool)) throw error('UNKNOWN_TOOL', 'The requested tool is not exposed by this selected server.')
          result = await client.request('tools/call', { name: request.tool, arguments: request.arguments })
        }
      }
      if (bundle.revoked || closed) throw error('BUNDLE_EXPIRED', 'The bundle was revoked before the operation completed.')
      emit({ ...event, state: result?.isError === true ? 'failed' : 'succeeded', finishedAt: Date.now() })
      return result
    } catch (cause) {
      emit({ ...event, state: 'failed', finishedAt: Date.now() })
      if (entry && ['TIMEOUT', 'SERVER_CLOSED', 'CONNECTION_FAILED', 'INVALID_PROTOCOL'].includes(cause?.code)) { entry.expired = true; entry.client?.close() }
      throw cause
    } finally { if (entry) { entry.busy--; entry.lastUsed = Date.now() } }
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.headers.origin || req.headers.host !== new URL(endpoint).host) { write(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'Only the local bundle runner can use this endpoint.' } }); return }
      const id = req.url?.match(/^\/v1\/bundles\/([0-9a-f-]+)$/)?.[1]
      const bundle = id && bundles.get(id)
      if (!bundle || bundle.revoked || !safeEqual(req.headers.authorization, 'Bearer ' + bundle.token)) { write(res, 401, { ok: false, error: { code: 'BUNDLE_EXPIRED', message: 'The bundle is unavailable or its token is invalid. Prepare it again in Traffic Light.' } }); return }
      if (activeRequests >= 8) throw error('BUSY', 'Too many tool requests are active. Try again after a running request ends.')
      activeRequests++
      try { const body = await readBody(req); const result = await operation(bundle, body); write(res, 200, { ok: true, result }) }
      finally { activeRequests-- }
    } catch (cause) {
      // Configuration errors can include local secrets. Only our own bounded messages leave the gateway.
      const known = cause instanceof ToolboxError
      write(res, 400, { ok: false, error: { code: known ? cause.code : 'CAPABILITY_UNAVAILABLE', message: known ? cause.message : 'The capability configuration changed or is unavailable. Refresh the library and prepare a new bundle.' } })
    }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 5_000
  server.keepAliveTimeout = 1_000
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  endpoint = 'http://127.0.0.1:' + server.address().port
  server.unref()
  const sweep = setInterval(() => {
    for (const bundle of bundles.values()) for (const entry of bundle.clients.values()) {
      if (!entry.busy && !entry.pending && !entry.expired && Date.now() - entry.lastUsed >= idleMs) { entry.expired = true; entry.client?.close() }
    }
  }, Math.min(30_000, Math.max(20, idleMs / 2)))
  sweep.unref()
  return {
    async prepare({ workspaceId, workspacePath, records }) {
      if (closed) throw error('SERVICE_CLOSED', 'The toolbox service has stopped.')
      if (typeof workspaceId !== 'string' || !workspaceId || !Array.isArray(records) || !records.length || records.length > 50) throw error('INVALID_BUNDLE', 'Choose between 1 and 50 capabilities in a workspace.')
      if (bundles.size >= 24) throw error('BUNDLE_LIMIT', 'Revoke unused bundles before preparing another one.')
      const selection = new Map()
      for (const record of records) {
        if (!record || typeof record.id !== 'string' || typeof record.name !== 'string' || !['skill', 'mcp'].includes(record.kind) || selection.has(record.id)) throw error('INVALID_BUNDLE', 'The capability selection is invalid.')
        selection.set(record.id, Object.freeze(structuredClone(record)))
      }
      const id = randomUUID(); const token = randomBytes(32).toString('base64url'); const createdAt = Date.now()
      bundles.set(id, { id, token, createdAt, workspaceId, workspacePath, records: selection, clients: new Map(), revoked: false })
      return { id, endpoint: endpoint + '/v1/bundles/' + id, token, createdAt }
    },
    async revoke(id) {
      const bundle = bundles.get(id)
      if (!bundle) return
      bundle.revoked = true; bundles.delete(id)
      await Promise.allSettled([...bundle.clients.values()].map(disposeClient))
    },
    async close() {
      if (closed) return
      closed = true; clearInterval(sweep)
      for (const bundle of bundles.values()) { bundle.revoked = true; for (const entry of bundle.clients.values()) entry.client?.close() }
      const pending = [...bundles.values()].flatMap(bundle => [...bundle.clients.values()].map(disposeClient))
      bundles.clear(); server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
      await Promise.allSettled(pending)
    }
  }
}
