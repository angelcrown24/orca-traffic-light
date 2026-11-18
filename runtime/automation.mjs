import { createServer } from 'node:http'
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  readFile,
  lstat,
  realpath,
  stat,
  writeFile,
  unlink,
  rename,
  mkdir,
  rm
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, isAbsolute, sep } from 'node:path'
import { recommendCapabilities } from './skill-recommend.mjs'
import { createToolboxService } from './service.mjs'
import { resolveRecord as defaultResolve } from './catalog.mjs'
import {
  automationDirectory,
  privateDirectory,
  bootstrapStatus,
  installBootstrap,
  refreshOwnedBootstrap,
  removeBootstrap
} from './bootstrap.mjs'

class AutoError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
const reject = (code, message) => new AutoError(code, message)
const within = (root, path) => {
  const value = relative(root, path)
  return !value || (value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value))
}
const equal = (a, b) =>
  typeof a === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b))
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
async function canonical(path) {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw reject('WORKSPACE_REQUIRED', 'Run this command from the task workspace.')
  const actual = await realpath(path)
  if (!(await stat(actual)).isDirectory())
    throw reject('WORKSPACE_REQUIRED', 'The caller working directory is unavailable.')
  return actual
}
async function body(req) {
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 70 * 1024) throw reject('REQUEST_TOO_LARGE', 'The request exceeds 70 KiB.')
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!object(value)) throw 0
    return value
  } catch {
    throw reject('INVALID_REQUEST', 'A JSON request object is required.')
  }
}
function answer(res, status, value) {
  if (res.destroyed || res.writableEnded) return
  let data = JSON.stringify(value)
  if (Buffer.byteLength(data) > 4 * 1024 * 1024) {
    status = 413
    data = JSON.stringify({
      ok: false,
      error: { code: 'RESPONSE_TOO_LARGE', message: 'The response exceeded the size limit.' }
    })
  }
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(data)
}
async function jsonResponse(response) {
  const chunks = []
  let size = 0
  if (!response.body)
    throw reject('RUNNER_UNAVAILABLE', 'The selected tool runner returned no response.')
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 4 * 1024 * 1024)
      throw reject('RESPONSE_TOO_LARGE', 'The response exceeded the size limit.')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw reject('RUNNER_UNAVAILABLE', 'The selected tool runner returned an invalid response.')
  }
}
function validLease(value) {
  try {
    const url = new URL(value.endpoint)
    return (
      value.version === 1 &&
      typeof value.instance === 'string' &&
      typeof value.token === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(value.token) &&
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/v1/automation'
    )
  } catch {
    return false
  }
}
async function leaseAt(path) {
  try {
    const info = await lstat(path)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 16 * 1024 ||
      (process.platform !== 'win32' && info.mode & 0o077)
    )
      throw reject(
        'AUTOMATION_CONFLICT',
        'The automatic connection file is not a private managed file.'
      )
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (!validLease(value)) throw 0
    return value
  } catch (e) {
    if (e.code === 'ENOENT') return null
    if (e instanceof AutoError) throw e
    throw reject('AUTOMATION_CONFLICT', 'The automatic connection file is invalid.')
  }
}
async function existingAlive(lease) {
  // Refuse to displace any endpoint that still answers, even with an unexpected response.
  try {
    await fetch(lease.endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + lease.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'health' }),
      signal: AbortSignal.timeout(1000),
      redirect: 'error'
    })
    return true
  } catch (e) {
    const refused = (cause) =>
      cause?.code === 'ECONNREFUSED' ||
      (Array.isArray(cause?.errors) && cause.errors.length > 0 && cause.errors.every(refused))
    if (refused(e.cause)) return false
    throw reject(
      'AUTOMATION_IN_USE',
      'The existing connection owner could not be safely verified. Leave its sessions unchanged.'
    )
  }
}

/** No filesystem mutations, listeners, or MCP processes until explicit grant/enable. */
export async function createAutomation(options = {}) {
  const home = options.home ?? homedir()
  const base = automationDirectory(home)
  const leasePath = join(base, 'automation.json')
  const grants = new Map(),
    sessions = new Map(),
    bundleOwners = new Map()
  const instance = randomUUID(),
    token = randomBytes(32).toString('base64url')
  let service = null,
    server = null,
    endpoint = '',
    starting = null,
    closed = false,
    activeRequests = 0,
    startingSessions = 0
  function event(value, itemId, dispatched) {
    const session = bundleOwners.get(value.bundleId)
    if (!session) return
    // Capture attribution at the start: another recommendation may finish during a call.
    if (value.state === 'running' && value.operation === 'skill') {
      const match = session.recommended.get(itemId)
      if (match) session.inFlight.set(value.id, match)
    }
    const match = session.inFlight.get(value.id)
    // Only a tool advertised by the server can reach dispatch.
    if (dispatched && match) match.used = true
    if (value.state !== 'running') session.inFlight.delete(value.id)
    const recommendationId = dispatched && match?.id
    try {
      options.onEvent?.({ ...value, workspaceId: session.workspaceId, sessionId: session.id,
        ...(recommendationId ? { recommendationId } : {}) })
    } catch {}
  }
  function recordRecommendations(result, session, workspaceId) {
    const current = new Map()
    if (result.method === 'kev' && result.items.length) {
      const at = Date.now()
      const rows = result.items.map(item => {
        const previous = session?.recommended.get(item.id)
        const id = previous && !previous.used ? previous.id : randomUUID()
        current.set(item.id, { id, used: false })
        return { id, name: item.name, kind: item.kind, at }
      })
      // Legacy handle-free suggestions are visible, but cannot identify a conversation.
      try { options.onRecommendations?.(workspaceId, rows) } catch {}
    }
    if (session) session.recommended = current
  }
  async function choose(cwd) {
    const path = await canonical(cwd)
    const matches = [...grants.values()]
      .filter((x) => within(x.workspacePath, path))
      .sort((a, b) => b.workspacePath.length - a.workspacePath.length)
    if (!matches.length)
      throw reject(
        'WORKSPACE_DISABLED',
        'Shared tools are not enabled for this working directory. Continue ordinary work without them.'
      )
    return { grant: matches[0], path }
  }
  function approvedMetadata(records, items) {
    const selected = new Set(records.map(record => record.id))
    return items.filter(item => selected.has(item.id)).map(item => ({
      id: item.id, name: item.name, kind: item.kind, description: String(item.description ?? '').slice(0, 240)
    }))
  }
  function metadata(records, items, query) {
    if (typeof query !== 'string' || query.length > 256)
      throw reject('INVALID_QUERY', 'Use a search query of at most 256 characters.')
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    const found = approvedMetadata(records, items)
      .filter((x) =>
        terms.every((word) => (x.name + ' ' + x.description).toLowerCase().includes(word))
      )
    return {
      items: found.slice(0, 10),
      total: found.length,
      limited: found.length > 10,
      note: 'Metadata only. Read a skill or discover one server only when needed.'
    }
  }
  async function route(request) {
    if (request.op === 'health') return { instance }
    const { grant, path } = await choose(request.cwd)
    if (request.op === 'start') {
      if (sessions.size + startingSessions >= 20)
        throw reject('SESSION_LIMIT', 'End unused Traffic Light sessions before starting another.')
      startingSessions++
      try {
        const connection = await service.prepare({
          workspaceId: grant.workspaceId,
          workspacePath: grant.workspacePath,
          records: grant.records
        })
        if (!grants.has(grant.workspaceId)) {
          await service.revoke(connection.id)
          throw reject(
            'WORKSPACE_DISABLED',
            'Shared tools were disabled while starting the session.'
          )
        }
        const id = randomUUID()
        const session = {
          id,
          workspaceId: grant.workspaceId,
          workspacePath: grant.workspacePath,
          connection,
          recommended: new Map(),
          inFlight: new Map(),
          records: grant.records,
          items: grant.items
        }
        sessions.set(id, session)
        bundleOwners.set(connection.id, session)
        return {
          session: id,
          workspace: grant.workspacePath,
          selected: grant.records.length,
          note: 'This handle belongs only to this conversation. Keep it for subsequent commands; do not share it.'
        }
      } finally {
        startingSessions--
      }
    }
    const session = request.session && sessions.get(request.session)
    if (
      request.session &&
      (!session ||
        session.workspaceId !== grant.workspaceId ||
        session.workspacePath !== grant.workspacePath ||
        !within(session.workspacePath, path))
    )
      throw reject(
        'SESSION_UNAVAILABLE',
        'This session handle is expired or belongs to another workspace.'
      )
    if (request.op === 'recommend') {
      if (typeof request.query !== 'string' || !request.query.trim() || request.query.length > 256)
        throw reject('INVALID_QUERY', 'Describe the task in 1 to 256 characters.')
      const scope = session ?? grant
      const candidates = approvedMetadata(scope.records, scope.items)
      const result = await recommendCapabilities(request.query.trim(), candidates, options.rankEnv)
      if (closed || (session ? !sessions.has(session.id) : grants.get(grant.workspaceId) !== grant))
        throw reject('WORKSPACE_CHANGED', 'The connection changed. Search again with the current selection.')
      recordRecommendations(result, session, grant.workspaceId)
      return result
    }
    if (request.op === 'search')
      return metadata(
        session?.records ?? grant.records,
        session?.items ?? grant.items,
        request.query ?? ''
      )
    if (!session)
      throw reject(
        'SESSION_REQUIRED',
        'Run start once in this conversation and use the returned session handle.'
      )
    if (request.op === 'end') {
      await service.revoke(session.connection.id)
      sessions.delete(session.id)
      bundleOwners.delete(session.connection.id)
      return { ended: true }
    }
    if (!['skill', 'tools', 'call', 'reconnect'].includes(request.op))
      throw reject('INVALID_REQUEST', 'Unknown shared-tool operation.')
    const forwarded = {
      op: request.op,
      id: request.id,
      ...(request.op === 'call' ? { tool: request.tool, arguments: request.arguments } : {})
    }
    let response
    try {
      response = await fetch(session.connection.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + session.connection.token
        },
        body: JSON.stringify(forwarded),
        signal: AbortSignal.timeout(115_000),
        redirect: 'error'
      })
    } catch {
      throw reject(
        'RUNNER_UNAVAILABLE',
        'The tool response is unavailable. An action may have occurred; do not retry automatically.'
      )
    }
    const result = await jsonResponse(response)
    if (!result.ok)
      throw reject(
        result.error?.code ?? 'TOOL_FAILED',
        result.error?.message ?? 'The selected capability failed.'
      )
    return result.result
  }
  async function ensure() {
    if (closed) throw reject('AUTOMATION_CLOSED', 'The shared-tool runtime has stopped.')
    if (server) return
    if (starting) return starting
    starting = (async () => {
      await privateDirectory(base)
      const lock = join(base, 'automation-start.lock')
      try {
        await mkdir(lock, { mode: 0o700 })
      } catch {
        throw reject(
          'AUTOMATION_IN_USE',
          'Another automatic connection is starting. Leave its files and sessions unchanged.'
        )
      }
      try {
        const previous = await leaseAt(leasePath)
        if (previous && (await existingAlive(previous)))
          throw reject(
            'AUTOMATION_IN_USE',
            'Another Traffic Light instance owns automatic connections. Keep that instance running; do not replace its active sessions.'
          )
        if (previous) {
          const current = await leaseAt(leasePath)
          if (current?.instance !== previous.instance || current?.token !== previous.token)
            throw reject('AUTOMATION_CONFLICT', 'The connection owner changed while preparing.')
          await rename(leasePath, join(base, 'automation-stale-' + randomUUID() + '.json'))
        }
        await refreshOwnedBootstrap(home)
        service = await createToolboxService({
          resolveRecord: options.resolveRecord ?? defaultResolve,
          onEvent: event,
          onCallAttempt(bundleId, eventId, itemId) {
            const session = bundleOwners.get(bundleId)
            const match = session?.recommended.get(itemId)
            if (match) session.inFlight.set(eventId, match)
          }
        })
        const next = createServer(async (req, res) => {
          try {
            if (
              req.method !== 'POST' ||
              req.url !== '/v1/automation' ||
              req.headers.origin ||
              req.headers.host !== new URL(endpoint).host ||
              !equal(req.headers.authorization, 'Bearer ' + token)
            ) {
              answer(res, 403, {
                ok: false,
                error: { code: 'FORBIDDEN', message: 'A private local connection is required.' }
              })
              return
            }
            if (activeRequests >= 8)
              throw reject(
                'BUSY',
                'Too many shared-tool requests are active. Wait for an existing request to finish.'
              )
            activeRequests++
            try {
              const result = await route(await body(req))
              answer(res, 200, { ok: true, result })
            } finally {
              activeRequests--
            }
          } catch (e) {
            answer(res, 400, {
              ok: false,
              error: {
                code: e instanceof AutoError ? e.code : 'AUTOMATION_ERROR',
                message:
                  e instanceof AutoError
                    ? e.message
                    : 'Shared tools are unavailable. Continue ordinary work; do not restart the conversation.'
              }
            })
          }
        })
        next.requestTimeout = 10_000
        next.headersTimeout = 5_000
        next.keepAliveTimeout = 1000
        await new Promise((resolve, reject) => {
          next.once('error', reject)
          next.listen(0, '127.0.0.1', resolve)
        })
        endpoint = 'http://127.0.0.1:' + next.address().port + '/v1/automation'
        try {
          await writeFile(leasePath, JSON.stringify({ version: 1, instance, endpoint, token }), {
            flag: 'wx',
            mode: 0o600
          })
        } catch (e) {
          next.closeAllConnections()
          await new Promise((r) => next.close(r))
          await service.close()
          service = null
          throw reject(
            'AUTOMATION_CONFLICT',
            'Another connection appeared while preparing. Existing sessions were left unchanged.'
          )
        }
        server = next
        server.unref()
      } finally {
        await rm(lock, { recursive: true, force: true })
      }
    })()
    try {
      await starting
    } finally {
      starting = null
    }
  }
  return {
    async prepare() {
      await ensure()
      return this.status()
    },
    async grant({ workspaceId, workspacePath, records, items }) {
      if (
        typeof workspaceId !== 'string' ||
        !workspaceId ||
        !Array.isArray(records) ||
        !records.length ||
        records.length > 50 ||
        !Array.isArray(items)
      )
        throw reject('INVALID_GRANT', 'Choose 1 to 50 capabilities for a workspace.')
      if (!grants.has(workspaceId) && grants.size >= 24)
        throw reject('WORKSPACE_LIMIT', 'At most 24 workspaces can have automatic connections.')
      const path = await canonical(workspacePath)
      const old = grants.get(workspaceId)
      if (old && old.workspacePath !== path)
        throw reject(
          'WORKSPACE_CHANGED',
          'Revoke the old workspace connection before changing its path.'
        )
      if (
        [...grants.values()].some((x) => x.workspaceId !== workspaceId && x.workspacePath === path)
      )
        throw reject(
          'WORKSPACE_CONFLICT',
          'This folder is already assigned to another workspace connection.'
        )
      await ensure()
      if (closed) throw reject('AUTOMATION_CLOSED', 'The shared-tool runtime has stopped.')
      if (!grants.has(workspaceId) && grants.size >= 24)
        throw reject('WORKSPACE_LIMIT', 'At most 24 workspaces can have automatic connections.')
      if (
        [...grants.values()].some((x) => x.workspaceId !== workspaceId && x.workspacePath === path)
      )
        throw reject(
          'WORKSPACE_CONFLICT',
          'This folder is already assigned to another workspace connection.'
        )
      grants.set(workspaceId, {
        workspaceId,
        workspacePath: path,
        records: structuredClone(records),
        items: structuredClone(items)
      })
      return this.status()
    },
    async revoke(workspaceId) {
      grants.delete(workspaceId)
      const found = [...sessions.values()].filter((x) => x.workspaceId === workspaceId)
      for (const session of found) {
        await service?.revoke(session.connection.id)
        sessions.delete(session.id)
        bundleOwners.delete(session.connection.id)
      }
      return this.status()
    },
    async status() {
      return {
        ...(await bootstrapStatus({ home })),
        workspaces: [...grants.keys()].map((workspaceId) => ({
          workspaceId,
          sessions: [...sessions.values()].filter((x) => x.workspaceId === workspaceId).length
        }))
      }
    },
    async enableBootstrap() {
      await installBootstrap({ home })
      return this.status()
    },
    async disableBootstrap() {
      await removeBootstrap({ home })
      return this.status()
    },
    async close() {
      if (closed) return
      closed = true
      if (starting) {
        try {
          await starting
        } catch {}
      }
      grants.clear()
      sessions.clear()
      bundleOwners.clear()
      if (service) await service.close()
      if (server) {
        server.closeAllConnections()
        await new Promise((r) => server.close(r))
      }
      const current = await leaseAt(leasePath).catch(() => null)
      if (current?.instance === instance && current?.token === token)
        await unlink(leasePath).catch(() => {})
    }
  }
}
