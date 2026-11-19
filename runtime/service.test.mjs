import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createToolboxService } from './service.mjs'

const fake = `
const rl = require('node:readline').createInterface({input:process.stdin});
let count=0;
rl.on('line',line=>{
 const req=JSON.parse(line); if(req.id===undefined)return;
 const send=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
 if(req.method==='initialize')return send({protocolVersion:'2025-03-26',capabilities:{tools:{}}});
 if(req.method==='tools/list')return send({tools:[{name:'counter',inputSchema:{type:'object'}},{name:'slow',inputSchema:{type:'object'}},{name:'fail',inputSchema:{type:'object'}}]});
 if(req.method==='tools/call'){
  if(req.params.name==='slow') return;
  if(req.params.name==='fail')return send({isError:true,content:[{type:'text',text:'request failed'}]});
  send({content:[{type:'text',text:JSON.stringify({count:++count,args:req.params.arguments})}]});
 }
});`
const record = { id: 'mcp-one', name: 'Fixture', kind: 'mcp' }
const resolve = async () => ({ command: process.execPath, args: ['-e', fake] })
async function rig(t, options = {}) {
  const events = []
  const service = await createToolboxService({ resolveRecord: resolve, onEvent: x => events.push(x), startupTimeoutMs: 2000, requestTimeoutMs: 2000, ...options })
  t.after(() => service.close())
  const bundle = await service.prepare({ workspaceId: 'workspace-1', records: [record] })
  return { service, bundle, events }
}
async function request(bundle, body, extra = {}) {
  const response = await fetch(bundle.endpoint, { method: 'POST', headers: { Authorization: 'Bearer ' + bundle.token, 'Content-Type': 'application/json', ...(extra.headers ?? {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) })
  return { status: response.status, ...await response.json() }
}
const call = (bundle, name = 'counter', args = {}) => request(bundle, { op: 'call', id: record.id, tool: name, arguments: args })
const counter = data => JSON.parse(data.result.content[0].text).count

test('prepare and list never resolve or launch servers; only selected server starts lazily', async t => {
  let resolved = 0
  const { bundle, events } = await rig(t, { resolveRecord: async r => { resolved++; return resolve(r) } })
  assert.equal(resolved, 0)
  const list = await request(bundle, { op: 'list' }); assert.equal(list.result.items.length, 1); assert.equal(resolved, 0); assert.equal(events.length, 0)
  const denied = await request(bundle, { op: 'tools', id: 'not-selected' }); assert.equal(denied.error.code, 'NOT_SELECTED'); assert.equal(resolved, 0)
  const result = await request(bundle, { op: 'tools', id: record.id }); assert.equal(result.result.tools.length, 3); assert.equal(resolved, 1)
})

test('server state persists inside a bundle and is isolated between bundles', async t => {
  const { service, bundle } = await rig(t)
  assert.equal(counter(await call(bundle)), 1)
  assert.equal(counter(await call(bundle)), 2)
  const other = await service.prepare({ workspaceId: 'workspace-2', records: [record] })
  assert.equal(counter(await call(other)), 1)
  assert.equal(counter(await call(bundle)), 3)
})

test('token, browser Origin, and bundle identity cannot cross authorization boundaries', async t => {
  const { service, bundle } = await rig(t)
  const other = await service.prepare({ workspaceId: 'workspace-2', records: [record] })
  assert.equal((await request({ ...bundle, token: other.token }, { op: 'list' })).status, 401)
  assert.equal((await request(bundle, { op: 'list' }, { headers: { Origin: 'https://attacker.example' } })).status, 403)
  const hostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(bundle.endpoint, { method: 'POST', headers: { Host: 'attacker.example', Authorization: 'Bearer ' + bundle.token } }, res => { res.resume(); resolve(res.statusCode) }); req.on('error', reject); req.end(JSON.stringify({ op: 'list' }))
  })
  assert.equal(hostStatus, 403)
  assert.equal((await request({ ...bundle, token: 'wrong' }, { op: 'list' })).status, 401)
})

test('revoking one bundle leaves the other working', async t => {
  const { service, bundle } = await rig(t)
  const other = await service.prepare({ workspaceId: 'workspace-2', records: [record] })
  await call(bundle); await service.revoke(bundle.id)
  assert.equal((await call(bundle)).error.code, 'BUNDLE_EXPIRED')
  assert.equal(counter(await call(other)), 1)
})

test('tool errors generate failure events, with no arguments or outputs retained', async t => {
  const { bundle, events } = await rig(t)
  await call(bundle, 'counter', { secret: 'private-input' })
  const result = await call(bundle, 'fail')
  assert.equal(result.result.isError, true)
  assert.equal(events.at(-1).state, 'failed')
  assert.equal(events.filter(x => x.state === 'running').length, 2)
  assert.ok(events.every(x => Object.keys(x).every(k => ['id','bundleId','name','kind','state','startedAt','finishedAt','operation','capabilityName'].includes(k))))
  assert.ok(!JSON.stringify(events).includes('private-input'))
})

test('startup failure is contained and requires explicit reconnect; list still works', async t => {
  const { bundle } = await rig(t, { resolveRecord: async () => ({ command: '/does-not-exist/toolbox-fixture' }) })
  const failed = await request(bundle, { op: 'tools', id: record.id })
  assert.equal(failed.error.code, 'SERVER_START_FAILED')
  assert.equal((await request(bundle, { op: 'tools', id: record.id })).error.code, 'RECONNECT_REQUIRED')
  assert.equal((await request(bundle, { op: 'list' })).ok, true)
})

test('call timeout does not retry and reconnect resets server state explicitly', async t => {
  const { bundle } = await rig(t, { requestTimeoutMs: 100 })
  assert.equal(counter(await call(bundle)), 1)
  assert.equal((await call(bundle, 'slow')).error.code, 'TIMEOUT')
  assert.equal((await call(bundle)).error.code, 'RECONNECT_REQUIRED')
  assert.equal((await request(bundle, { op: 'reconnect', id: record.id })).result.reconnected, true)
  assert.equal(counter(await call(bundle)), 1)
})

test('idle expiration does not silently recreate a stateful server', async t => {
  const { bundle } = await rig(t, { idleTimeoutMs: 50 })
  assert.equal(counter(await call(bundle)), 1)
  await new Promise(resolve => setTimeout(resolve, 130))
  assert.equal((await call(bundle)).error.code, 'RECONNECT_REQUIRED')
})

test('skills are resolved and read only on explicit selected skill requests', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'toolbox-skills-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'SKILL.md'); await writeFile(path, '# A private skill\nUse only when requested.')
  let reads = 0
  const service = await createToolboxService({ resolveRecord: async () => {
    reads++
    const content = await readFile(path, 'utf8')
    await writeFile(path, '# A later revision')
    return { path, content }
  } }); t.after(() => service.close())
  const bundle = await service.prepare({ workspaceId: 'one', records: [{ id: 'skill-one', kind: 'skill', name: 'Skill' }] })
  await request(bundle, { op: 'list' }); assert.equal(reads, 0)
  assert.equal((await request(bundle, { op: 'skill', id: 'other' })).error.code, 'NOT_SELECTED'); assert.equal(reads, 0)
  const result = await request(bundle, { op: 'skill', id: 'skill-one' }); assert.match(result.result.content, /private skill/); assert.equal(reads, 1)
})

test('changed configuration cannot leak credentials through resolver errors', async t => {
  const { bundle } = await rig(t, { resolveRecord: async () => { throw new Error('secret=do-not-print') } })
  const result = await request(bundle, { op: 'tools', id: record.id })
  assert.equal(result.error.code, 'CAPABILITY_UNAVAILABLE'); assert.ok(!JSON.stringify(result).includes('do-not-print'))
})

test('argument size and unknown tool checks prevent invalid execution', async t => {
  const { bundle } = await rig(t)
  assert.equal((await request(bundle, { op: 'call', id: record.id, tool: 'counter', arguments: [] })).error.code, 'INVALID_REQUEST')
  assert.equal((await call(bundle, 'not-a-tool')).error.code, 'UNKNOWN_TOOL')
  const result = await call(bundle, 'counter', { oversized: 'x'.repeat(70 * 1024) })
  assert.equal(result.error.code, 'REQUEST_TOO_LARGE')
  assert.equal(counter(await call(bundle)), 1)
})

test('Streamable HTTP JSON and SSE responses preserve session headers without redirecting credentials', async t => {
  const seen = []; let calls = 0
  const remote = createServer(async (req, res) => {
    let raw = ''; for await (const x of req) raw += x
    const body = JSON.parse(raw); seen.push({ method: body.method, session: req.headers['mcp-session-id'], protocol: req.headers['mcp-protocol-version'] })
    if (body.id === undefined) { res.writeHead(202); res.end(); return }
    let result
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} } }
    else if (body.method === 'tools/list') result = { tools: [{ name: 'counter', inputSchema: { type: 'object' } }] }
    else result = { content: [{ type: 'text', text: JSON.stringify({ count: ++calls }) }] }
    const sse = body.method === 'tools/call'
    res.writeHead(200, { 'Content-Type': sse ? 'text/event-stream' : 'application/json', 'Mcp-Session-Id': 'fixture-session' })
    const json = JSON.stringify({ jsonrpc: '2.0', id: body.id, result })
    res.end(sse ? 'event: message\ndata: ' + json + '\n\n' : json)
  })
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => remote.close(resolve)))
  const { bundle } = await rig(t, { resolveRecord: async () => ({ url: 'http://127.0.0.1:' + remote.address().port + '/mcp' }) })
  assert.equal(counter(await call(bundle)), 1)
  assert.ok(seen.slice(1).every(x => x.session === 'fixture-session'))
  assert.ok(seen.every(x => x.protocol === '2025-03-26'))
})

test('CLI end-to-end returns selected inventory, reads skills, lists tools, and calls with stdin JSON', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'toolbox-cli-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const skillPath = join(dir, 'SKILL.md'); await writeFile(skillPath, '# Fixture skill')
  const { service } = await rig(t, { resolveRecord: async r => r.kind === 'skill' ? { path: skillPath, content: await readFile(skillPath, 'utf8') } : resolve(r) })
  const bundle = await service.prepare({ workspaceId: 'cli', records: [record, {id:'skill-cli',kind:'skill',name:'Fixture skill'}] })
  const path = join(dir, 'bundle.json'); await writeFile(path, JSON.stringify({ version: 1, ...bundle }), { mode: 0o600 })
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url))
  async function run(args, input = '') {
    const p = spawn(process.execPath, [cli, '--bundle', path, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''; p.stdout.on('data', x => { stdout += x }); p.stderr.on('data', x => { stderr += x }); p.stdin.end(input)
    const code = await new Promise(resolve => p.on('close', resolve)); return { code, stdout, stderr }
  }
  const list = await run(['list']); assert.equal(list.code, 0); assert.equal(JSON.parse(list.stdout).items[0].id, record.id)
  const skill = await run(['skill', 'skill-cli']); assert.equal(skill.code, 0); assert.match(JSON.parse(skill.stdout).content, /Fixture skill/)
  const catalog = await run(['tools', record.id]); assert.equal(catalog.code, 0); assert.equal(JSON.parse(catalog.stdout).tools.length, 3)
  const malformed = await run(['call', record.id, 'counter'], '{private-secret:'); assert.equal(malformed.code, 1); assert.ok(!malformed.stderr.includes('private-secret'))
  const result = await run(['call', record.id, 'counter'], JSON.stringify({ from: 'cli' })); assert.equal(result.code, 0); assert.match(result.stdout, /cli/)
  const failure = await run(['tools', 'not-selected']); assert.equal(failure.code, 1); assert.match(failure.stderr, /NOT_SELECTED/)
  assert.ok(!(list.stdout + result.stdout + failure.stderr).includes(bundle.token))
})

test('a real stdio server receives declared and baseline environment but not other worker variables', async t => {
  const { resolveRecord, scanCatalog } = await import('./catalog.mjs')
  const home = await mkdtemp(join(tmpdir(), 'toolbox-child-env-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(home, '.codex'))
  process.env.TL_CHILD_DECLARED_TEST = 'allow'
  process.env.TL_CHILD_UNLISTED_TEST = 'private'
  t.after(() => { delete process.env.TL_CHILD_DECLARED_TEST; delete process.env.TL_CHILD_UNLISTED_TEST })
  const program = fake.replace('count:++count,args:req.params.arguments', "path:!!process.env.PATH, inherited:process.env.TL_CHILD_DECLARED_TEST, explicit:process.env.TL_CHILD_EXPLICIT_TEST, unrelated:'TL_CHILD_UNLISTED_TEST' in process.env")
  await writeFile(join(home, 'server.cjs'), program)
  await writeFile(join(home, '.codex/config.toml'), [
    '[mcp_servers.sample]', 'command = ' + JSON.stringify(process.execPath), 'args = [' + JSON.stringify(join(home, 'server.cjs')) + ']',
    'env_vars = ["TL_CHILD_DECLARED_TEST"]', 'env = { TL_CHILD_EXPLICIT_TEST = "explicit" }',
  ].join('\n'))
  const { items, records } = await scanCatalog({ home })
  const selected = records.get(items[0].id)
  const service = await createToolboxService({ resolveRecord })
  t.after(() => service.close())
  const bundle = await service.prepare({ workspaceId: 'local', records: [selected] })
  const result = await request(bundle, { op: 'call', id: selected.id, tool: 'counter', arguments: {} })
  assert.deepEqual(JSON.parse(result.result.content[0].text), { path: true, inherited: 'allow', explicit: 'explicit', unrelated: false })
})

test('stdio accepts a server ping and updates changed tools on demand in the same connection', async t => {
  const dynamic = `
    let changed = false, lists = 0, calls = 0, ready;
    const send = msg => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...msg}) + '\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        ready = msg.id;
        send({method:'ping', id:ready});
      } else if (!msg.method && msg.id === ready) {
        if (JSON.stringify(msg.result) === '{}') send({id:ready, result:{protocolVersion:'2025-03-26', capabilities:{tools:{listChanged:true}}}});
        else send({id:ready, error:{code:-32000,message:'ping failed'}});
      } else if (msg.method === 'tools/list') {
        lists++;
        send({id:msg.id,result:{tools:[{name:changed ? 'updated' : 'rotate', inputSchema:{type:'object'}}]}});
      } else if (msg.method === 'tools/call') {
        calls++;
        if (msg.params.name === 'rotate') {
          changed = true;
          send({method:'notifications/tools/list_changed'});
        }
        send({id:msg.id, result:{content:[{type:'text',text:JSON.stringify({lists,calls})}]}});
      }
    });`;
  const { bundle } = await rig(t, { resolveRecord: async () => ({ command: process.execPath, args: ['-e', dynamic] }) });
  const first = await call(bundle, 'rotate');
  assert.equal(first.ok, true);
  assert.equal((await call(bundle, 'rotate')).error.code, 'UNKNOWN_TOOL');
  const fresh = await call(bundle, 'updated');
  assert.deepEqual(JSON.parse(fresh.result.content[0].text), { lists: 2, calls: 2 });
});

test('HTTP stream handles a server ping sharing the client request ID without consuming its response', async t => {
  let stream, pingId, attempts = 0;
  const remote = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks));
    const send = result => { res.writeHead(200, { 'Content-Type':'application/json' }); res.end(JSON.stringify({jsonrpc:'2.0', id:msg.id, result})) };
    if (msg.method === 'initialize') return send({protocolVersion:'2025-06-18',capabilities:{tools:{}}});
    if (msg.method === 'tools/list') return send({tools:[{name:'clock',inputSchema:{type:'object'}}]});
    if (msg.method === 'tools/call') {
      stream = res; pingId = msg.id; attempts++;
      res.writeHead(200, {'Content-Type':'text/event-stream'});
      res.write('data: ' + JSON.stringify({jsonrpc:'2.0',id:pingId,method:'ping'}) + '\n\n');
      return;
    }
    res.writeHead(202); res.end();
    if (msg.id === pingId && msg.result && !Object.keys(msg.result).length && stream) {
      stream.end('data: ' + JSON.stringify({jsonrpc:'2.0',id:pingId,result:{content:[{type:'text', text:'tick'}]}}) + '\n\n');
    }
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => { remote.closeAllConnections(); return new Promise(resolve => remote.close(resolve)) });
  const { bundle } = await rig(t, { resolveRecord: async () => ({ url:'http://127.0.0.1:' + remote.address().port }) });
  const result = await call(bundle, 'clock');
  assert.equal(result.ok, true);
  assert.equal(result.result.content[0].text, 'tick');
  assert.equal(attempts, 1);
});

test('simultaneous tool calls share one catalog read without merging the tool actions', async t => {
  const server = `
    const rl = require('node:readline').createInterface({input:process.stdin});
    let catalogs = 0, calls = 0;
    rl.on('line', line => {
      const msg = JSON.parse(line);
      const reply = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result}) + '\\n');
      if (msg.method === 'initialize') reply({protocolVersion:'2025-03-26',capabilities:{tools:{}}});
      if (msg.method === 'tools/list') {
        catalogs++;
        setTimeout(() => reply({tools:[{name:'counter',inputSchema:{type:'object'}}]}), 60);
      }
      if (msg.method === 'tools/call') reply({content:[{type:'text',text:JSON.stringify([catalogs, ++calls])}]});
    });`
  const { bundle } = await rig(t, { resolveRecord: async () => ({ command: process.execPath, args: ['-e', server] }) })
  const replies = await Promise.all(Array.from({ length: 6 }, () => call(bundle)))
  const counts = replies.map(reply => JSON.parse(reply.result.content[0].text))
  assert.deepEqual(counts.map(([catalogs]) => catalogs), Array(6).fill(1))
  assert.deepEqual(counts.map(([, calls]) => calls).sort(), [1, 2, 3, 4, 5, 6])
})
