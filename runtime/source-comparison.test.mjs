import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { compareSources } from './source-comparison.mjs'
import { resolveRecord, scanCatalog } from './catalog.mjs'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'traffic-compare-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return { home, async put(relative, contents) {
    const file = join(home, relative)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, typeof contents === 'object' ? JSON.stringify(contents) : contents)
  } }
}

test('compares entire skill packages without exposing paths or contents', async t => {
  const f = await fixture(t)
  for (const provider of ['.agents', '.codex', '.claude']) {
    await f.put(provider + '/skills/demo/SKILL.md', '---\nname: demo\n---\nSame instructions')
    await f.put(provider + '/skills/demo/private-file', provider === '.claude' ? 'private-edit' : 'private-content')
  }
  const catalog = await scanCatalog(f)
  const id = provider => catalog.items.find(item => item.providers.includes(provider)).id
  const result = await compareSources(catalog, id('Shared'))
  const variant = provider => result.sources.find(source => source.id === id(provider)).variant
  assert.ok(variant('Shared'))
  assert.equal(variant('Shared'), variant('Codex'))
  assert.notEqual(variant('Shared'), variant('Claude Code'))
  assert.deepEqual(result.differences, ['contents'])
  assert.equal(result.sources[0].fileCount, 2)
  assert.ok(!JSON.stringify(result).includes('private-'))
})

test('compares provider MCP dialects without forwarding credentials, runtime arguments or private paths', async t => {
  const f = await fixture(t)
  await f.put('.codex/config.toml', '[mcp_servers.same]\ncommand = "/private-path/node"\nargs = ["private-value"]\nstartup_timeout_sec = 2\n')
  await f.put('.claude.json', { mcpServers: { same: { command: 'node', args: ['private-other'] } } })
  await f.put('.gemini/settings.json', { mcpServers: { same: { httpUrl: 'https://private-endpoint.invalid', headers: { Authorization: 'private-token' } } } })
  const catalog = await scanCatalog(f)
  const result = await compareSources(catalog, catalog.items[0].id)
  assert.equal(new Set(result.sources.map(source => source.variant)).size, 3)
  assert.deepEqual(result.sources.map(source => source.transport).sort(), ['http', 'stdio', 'stdio'])
  assert.equal(result.sources.filter(source => source.commandHint === 'node').length, 2)
  assert.ok(result.differences.includes('arguments'))
  assert.ok(result.differences.includes('timeouts'))
  assert.ok(!JSON.stringify(result).includes('private-'))
})

test('native policies, transport mismatches and unknown fields prevent both discovery grants and later execution', async t => {
  const f = await fixture(t)
  const path = '.gemini/settings.json'
  const mcpServers = { valid: { command: 'node' }, mismatch: { command: 'node', type: 'http' }, restricted: { command: 'node', requiresApproval: true }, disabled: { command: 'node' } }
  await f.put(path, { mcpServers, mcp: { excluded: ['disabled'] } })
  const catalog = await scanCatalog(f)
  assert.deepEqual(catalog.items.filter(item => item.available).map(item => item.name), ['valid'])
  const validId = catalog.items.find(item => item.available).id
  await f.put(path, { mcpServers, mcp: { allowed: [] } })
  await assert.rejects(resolveRecord(catalog.records.get(validId)), { code: 'CAPABILITY_CHANGED' })
  const blocked = await compareSources(catalog, validId)
  assert.deepEqual(blocked.sources, [{ id: validId, variant: null }])
})

test('Gemini and Claude substitution syntax requires native resolution, literal inherited values do not', async t => {
  const f = await fixture(t)
  await f.put('.gemini/settings.json', { mcpServers: { g: { command: 'node', env: { AUTH: '$MCP_TOKEN' } } } })
  await f.put('.claude.json', { mcpServers: { c: { url: 'https://mcp.invalid/', headers: { Authorization: 'Bearer ${MCP_TOKEN:-fallback}' } } } })
  await f.put('.codex/config.toml', '[mcp_servers.exact]\ncommand = "node"\nenv_vars = ["TL_LITERAL_VALUE_TEST"]')
  process.env.TL_LITERAL_VALUE_TEST = 'literal${text}'
  t.after(() => { delete process.env.TL_LITERAL_VALUE_TEST })
  const { items, records } = await scanCatalog(f)
  for (const item of items.filter(item => item.name !== 'exact')) {
    assert.equal(item.available, false)
    await assert.rejects(resolveRecord(records.get(item.id)), { code: 'CAPABILITY_UNAVAILABLE' })
  }
  const { env } = await resolveRecord(records.get(items.find(item => item.name === 'exact').id))
  assert.equal(env.TL_LITERAL_VALUE_TEST, 'literal${text}')
})
