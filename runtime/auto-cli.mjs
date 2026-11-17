#!/usr/bin/env node
import { readFile, lstat, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

class SafeError extends Error {}
const usage =
  'Usage: node auto-cli.mjs search "keywords" | start | --session HANDLE search "keywords"|skill ID|tools ID|call ID TOOL|reconnect ID|end. Send call arguments as JSON on stdin.'
async function input() {
  if (process.stdin.isTTY) return {}
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > 64 * 1024) throw new SafeError('Arguments exceed 64 KiB. No request was sent.')
    chunks.push(chunk)
  }
  let value
  try {
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    value = raw ? JSON.parse(raw) : {}
  } catch {
    throw new SafeError('Arguments must be valid JSON. No request was sent.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SafeError('Arguments must be a JSON object.')
  return value
}
async function main() {
  const args = process.argv.slice(2)
  let session
  if (args[0] === '--session') {
    session = args[1]
    args.splice(0, 2)
    if (typeof session !== 'string' || !/^[0-9a-f-]{36}$/.test(session))
      throw new SafeError('The conversation session handle is invalid.')
  }
  const [op, id, tool] = args
  const count = { start: 1, end: 1, search: 2, skill: 2, tools: 2, reconnect: 2, call: 3 }[op]
  if (!count || args.length !== count || (op === 'start' && session)) throw new SafeError(usage)
  if (!session && !['start', 'search'].includes(op))
    throw new SafeError(
      'Run start once in this conversation and use its returned --session handle.'
    )
  const path = join(dirname(fileURLToPath(import.meta.url)), 'automation.json')
  let record
  try {
    const info = await lstat(path)
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 16 * 1024 ||
      (process.platform !== 'win32' && info.mode & 0o077)
    )
      throw 0
    record = JSON.parse(await readFile(path, 'utf8'))
    const url = new URL(record.endpoint)
    if (
      record.version !== 1 ||
      typeof record.token !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(record.token) ||
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== '/v1/automation' ||
      url.search ||
      url.hash
    )
      throw 0
  } catch {
    throw new SafeError(
      'Traffic Light automatic connection is unavailable. Continue ordinary work without shared tools; do not restart the agent.'
    )
  }
  const cwd = await realpath(process.cwd())
  const body = {
    op,
    cwd,
    ...(session ? { session } : {}),
    ...(op === 'search' ? { query: id } : id ? { id } : {}),
    ...(tool ? { tool, arguments: await input() } : {})
  }
  let response
  try {
    response = await fetch(record.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + record.token },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(120_000)
    })
  } catch {
    throw new SafeError(
      'The Traffic Light connection is unavailable or timed out. A pending action may have occurred; it was not retried. Continue ordinary work without restarting the agent.'
    )
  }
  if (!response.body) throw new SafeError('The shared-tool runtime returned no response.')
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 4 * 1024 * 1024) throw new SafeError('The response exceeded the size limit.')
    chunks.push(chunk)
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!payload.ok) {
    process.stderr.write(JSON.stringify({ error: payload.error }) + '\n')
    process.exitCode = 1
    return
  }
  process.stdout.write(JSON.stringify(payload.result, null, 2) + '\n')
  if (payload.result?.isError === true) process.exitCode = 1
}
main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      error: {
        code: 'AUTOMATION_UNAVAILABLE',
        message:
          error instanceof SafeError
            ? error.message
            : 'The local shared-tool request could not be completed. No automatic retry was made.'
      }
    }) + '\n'
  )
  process.exitCode = 1
})
