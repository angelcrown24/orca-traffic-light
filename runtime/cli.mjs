#!/usr/bin/env node
import { readFile, lstat } from 'node:fs/promises'

class RunnerError extends Error {}
const usage = 'Usage: node cli.mjs --bundle /absolute/bundle.json list | skill ID | tools ID | reconnect ID | call ID TOOL (JSON arguments on stdin)'
async function stdin() {
  if (process.stdin.isTTY) return {}
  const chunks = []; let size = 0
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 64 * 1024) throw new RunnerError('Arguments exceed 64 KiB.'); chunks.push(chunk) }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  let value
  try { value = raw ? JSON.parse(raw) : {} } catch { throw new RunnerError('Arguments must be valid JSON. No input was sent.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RunnerError('Arguments must be a JSON object.')
  return value
}
async function main() {
  const args = process.argv.slice(2)
  if (args.length < 3 || args[0] !== '--bundle') throw new RunnerError(usage)
  const [file, op, id, tool] = args.slice(1)
  if (!['list', 'skill', 'tools', 'call', 'reconnect'].includes(op) || args.length !== (op === 'list' ? 3 : op === 'call' ? 5 : 4)) throw new RunnerError(usage)
  const info = await lstat(file)
  if (!info.isFile() || info.size > 16 * 1024) throw new RunnerError('The bundle file is invalid.')
  if (process.platform !== 'win32' && (info.mode & 0o077)) throw new RunnerError('The bundle file must be private (chmod 600).')
  const bundle = JSON.parse(await readFile(file, 'utf8'))
  const url = new URL(bundle.endpoint)
  if (bundle.version !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/bundles/' + bundle.id || typeof bundle.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(bundle.token)) throw new RunnerError('The bundle connection is invalid.')
  const body = { op, ...(id ? { id } : {}), ...(tool ? { tool, arguments: await stdin() } : {}) }
  let response
  try { response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bundle.token }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(120_000) }) }
  catch { throw new RunnerError('The Traffic Light runner is unavailable. Open the plugin and prepare the bundle again. Do not restart the agent session.') }
  if (!response.body) throw new RunnerError('The runner returned no response.')
  const reader = response.body.getReader(); const chunks = []; let size = 0
  while (true) {
    const { done, value } = await reader.read(); if (done) break
    size += value.length
    if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new RunnerError('The runner response exceeded the size limit.') }
    chunks.push(Buffer.from(value))
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!payload.ok) {
    process.stderr.write(JSON.stringify({ error: payload.error }) + '\n'); process.exitCode = 1; return
  }
  process.stdout.write(JSON.stringify(payload.result, null, 2) + '\n')
  if (payload.result?.isError === true) process.exitCode = 1
}
main().catch(error => { process.stderr.write(JSON.stringify({ error: { code: 'RUNNER_ERROR', message: error instanceof RunnerError ? error.message : error.code === 'ENOENT' ? 'Bundle file not found. Prepare a bundle in Traffic Light.' : 'Invalid bundle file, arguments, or runner response.' } }) + '\n'); process.exitCode = 1 })
