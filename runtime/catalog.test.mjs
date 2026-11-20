import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { scanCatalog, resolveRecord } from './catalog.mjs'

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'traffic-catalog-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return {
    home,
    async put(path, content) {
      const file = join(home, path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
      return file
    },
    async link(path, target) {
      await mkdir(dirname(join(home, path)), { recursive: true })
      await symlink(join(home, target), join(home, path))
    }
  }
}

test('deduplicates shared skills by real path, reads folded descriptions and stops symlink cycles', async (t) => {
  const f = await fixture(t)
  await f.put('.agents/skills/design/SKILL.md', '---\nname: design\ndescription: >-\n  Design clear\n  interfaces.\n---\nPRIVATE BODY MUST NOT ENTER CATALOG')
  await f.link('.codex/skills/design', '.agents/skills/design')
  await f.link('.agents/skills/cycle', '.agents/skills')
  await f.put('.codex/skills/.system/system-skill/SKILL.md', '---\nname: system-skill\ndescription: "System utility"\n---\nInstructions')
  const { items, records, warnings } = await scanCatalog({ home: f.home })
  const design = items.find((item) => item.name === 'design')
  assert.equal(items.length, 2)
  assert.equal(design.description, 'Design clear interfaces.')
  assert.deepEqual(design.providers, ['Shared', 'Codex'])
  assert.equal(JSON.stringify(items).includes('PRIVATE BODY'), false)
  assert.equal(warnings.length, 0)
  assert.equal((await resolveRecord(records.get(design.id))).path, await realpath(join(f.home, '.agents/skills/design/SKILL.md')))
})

test('uses full TOML parsing and never publishes arguments, URLs, headers or environment secrets', async (t) => {
  const f = await fixture(t)
  await f.put('.codex/config.toml', `model = "sample"\n[mcp_servers."quoted.server"]\ncommand = "node"\nargs = [\n  "--token", # comment\n  "SECRET_ARGUMENT"\n]\n[mcp_servers."quoted.server".env]\nAPI_KEY = "SECRET_ENVIRONMENT"\n[mcp_servers.remote]\nurl = "https://example.invalid/mcp?secret=SECRET_URL"\nhttp_headers = { Authorization = "Bearer SECRET_HEADER" }\n`)
  const { items, records } = await scanCatalog({ home: f.home })
  assert.equal(items.length, 2)
  assert.equal(JSON.stringify(items).includes('SECRET_'), false)
  const local = items.find((item) => item.name === 'quoted.server')
  assert.equal(local.available, true)
  assert.deepEqual(await resolveRecord(records.get(local.id)), { command: 'node', args: ['--token', 'SECRET_ARGUMENT'], env: { API_KEY: 'SECRET_ENVIRONMENT' } })
  const remote = await resolveRecord(records.get(items.find((item) => item.name === 'remote').id))
  assert.equal(remote.headers.Authorization, 'Bearer SECRET_HEADER')
})

test('deduplicates equivalent servers while preserving disabled, restricted and unsupported variants', async (t) => {
  const f = await fixture(t)
  await f.put('.claude.json', { mcpServers: { shared: { type: 'stdio', command: 'node', args: ['same.mjs'] } } })
  await f.put('.gemini/settings.json', { mcpServers: {
    shared: { command: 'node', args: ['same.mjs'] },
    disabled: { command: 'node', disabled: true, includeTools: ['read'] },
    restricted: { command: 'node', includeTools: ['read'] },
    oauth: { httpUrl: 'https://example.invalid/mcp', oauth: {} },
    legacy: { url: 'https://example.invalid/sse' },
    node_repl: { command: 'node' },
    internalAlias: { command: '/provider/SkyComputerUseClient' },
    approval: { command: 'node', requiresApproval: true },
    unknown: { command: 'node', undocumentedSetting: true }
  } })
  const { items, records } = await scanCatalog({ home: f.home })
  assert.equal(items.filter((item) => item.name === 'shared').length, 1)
  assert.deepEqual(items.find((item) => item.name === 'shared').providers, ['Claude Code', 'Gemini CLI'])
  for (const [name, classification] of Object.entries({
    disabled: undefined, restricted: 'tool-policy', oauth: 'provider-auth', legacy: 'transport', node_repl: 'native-tool',
    internalAlias: 'native-tool', approval: 'provider-options', unknown: undefined
  })) {
    const item = items.find((item) => item.name === name)
    assert.equal(item.available, false)
    assert.equal(item.providerOnly, classification, name)
    assert.equal(item.sharing.canSync, false)
    await assert.rejects(resolveRecord(records.get(item.id)), { code: 'CAPABILITY_UNAVAILABLE' })
  }
})

test('normalizes supported HTTP variants and resolves inherited credentials only at use', async (t) => {
  const f = await fixture(t)
  await f.put('.gemini/settings.json', { mcpServers: { remote: { httpUrl: 'https://example.invalid/mcp' } } })
  await f.put('.gemini/config/mcp_config.json', { mcpServers: { other: { serverUrl: 'https://another.invalid/mcp', type: 'http' } } })
  await f.link('.gemini/antigravity/mcp_config.json', '.gemini/config/mcp_config.json')
  await f.put('.codex/config.toml', '[mcp_servers.env]\ncommand = "node"\nenv_vars = ["TRAFFIC_CATALOG_TEST_ENV"]\n[mcp_servers.auth]\nurl = "https://auth.invalid/mcp"\nbearer_token_env_var = "TRAFFIC_CATALOG_TEST_TOKEN"\n')
  const { items, records } = await scanCatalog({ home: f.home })
  assert.equal(items.length, 4)
  assert.equal((await resolveRecord(records.get(items.find((i) => i.name === 'remote').id))).url, 'https://example.invalid/mcp')
  const envRecord = records.get(items.find((i) => i.name === 'env').id)
  const authRecord = records.get(items.find((i) => i.name === 'auth').id)
  delete process.env.TRAFFIC_CATALOG_TEST_ENV
  delete process.env.TRAFFIC_CATALOG_TEST_TOKEN
  t.after(() => { delete process.env.TRAFFIC_CATALOG_TEST_ENV; delete process.env.TRAFFIC_CATALOG_TEST_TOKEN })
  await assert.rejects(resolveRecord(envRecord), { code: 'CAPABILITY_UNAVAILABLE' })
  process.env.TRAFFIC_CATALOG_TEST_ENV = 'private-value'
  process.env.TRAFFIC_CATALOG_TEST_TOKEN = 'private-token'
  assert.equal((await resolveRecord(envRecord)).env.TRAFFIC_CATALOG_TEST_ENV, 'private-value')
  assert.equal((await resolveRecord(authRecord)).headers.Authorization, 'Bearer private-token')
  assert.equal(JSON.stringify(items).includes('private-'), false)
})

test('refuses changed skills and changed server configuration instead of silently using new code', async (t) => {
  const f = await fixture(t)
  const skill = await f.put('.agents/skills/example/SKILL.md', '---\nname: example\n---\nOriginal')
  const config = await f.put('.claude.json', { mcpServers: { test: { command: 'node', args: ['original.mjs'] } } })
  const { items, records } = await scanCatalog({ home: f.home })
  await writeFile(skill, 'Changed instructions')
  await writeFile(config, JSON.stringify({ mcpServers: { test: { command: 'node', args: ['different.mjs'] } } }))
  for (const item of items) await assert.rejects(resolveRecord(records.get(item.id)), { code: 'CAPABILITY_CHANGED' })
})

test('bounds files, treats malformed definitions as unavailable and keeps parser details private', async (t) => {
  const f = await fixture(t)
  await f.put('.agents/skills/large/SKILL.md', 'x'.repeat(65537))
  await f.put('.codex/config.toml', '[invalid SECRET_IN_ERROR')
  await f.put('.claude.json', { mcpServers: {
    invalid: { command: 'node', args: { malicious: true } },
    placeholder: { command: 'node', env: { API: '${SOME_SECRET}' } },
    url: { type: 'http', url: 'file:///etc/passwd' },
    header: { url: 'https://example.invalid/mcp', headers: { Authorization: 'secret\r\ninjection' } }
  } })
  const { items, warnings } = await scanCatalog({ home: f.home })
  assert.equal(items.length, 4)
  assert.equal(items.every((item) => !item.available), true)
  assert.deepEqual(items.filter(item => item.providerOnly).map(item => [item.name, item.providerOnly]), [['placeholder', 'environment']])
  assert.equal(warnings.length, 2)
  assert.equal(JSON.stringify({ items, warnings }).includes('SECRET_IN_ERROR'), false)
  assert.equal(JSON.stringify({ items, warnings }).includes('SOME_SECRET'), false)
})

test('retains one review-only oversized-package record for aliases without reading it into the catalog', async t => {
  const f = await fixture(t)
  await f.put('.agents/skills/large/SKILL.md', 'x'.repeat(65537))
  await f.link('.claude/skills/also-large', '.agents/skills/large')
  const { items, records, skillExclusions } = await scanCatalog({ home: f.home })
  assert.equal(items.length, 0)
  assert.equal(records.size, 0)
  assert.equal(skillExclusions.length, 1)
  const [excluded] = skillExclusions
  assert.deepEqual([excluded.name, excluded.reason, excluded.providers], ['large', 'too-large', ['Shared', 'Claude Code']])
  assert.ok(!JSON.stringify(excluded).includes(f.home))
  await f.put('.agents/skills/large/SKILL.md', '---\nname: readable\n---')
  assert.equal((await scanCatalog({ home: f.home })).skillExclusions.length, 0)
})
