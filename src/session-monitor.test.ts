import { assert, test } from 'orca/testing'
import { createSessionMonitor } from './session-monitor'
import { emptyShells, type SessionShells } from './session-shells'

const workspace = 'repo::/shared-folder::first'
const sibling = 'repo::/shared-folder::second'
const chat = 'chat:10000000-abcd-4123-9123-123456789abc'
const handle = 'term_20000000-abcd-4123-9123-123456789abc'
const terminal = 'terminal:' + handle
const source = { result: { worktrees: [] } }
const auto = { selected: null }
const ready = (selected: string): SessionShells => ({
  ...emptyShells('ready'), selected, rows: [{ kind: 'shell', state: 'running', name: 'git' }]
})
const defaults = {
  context: async () => ({ workspaceId: workspace, terminals: [{ id: handle }] }),
  snapshot: async () => source,
  enabled: async () => true,
  providerEnabled: async () => false,
  focus: async () => chat
}
const discarded = (result: SessionShells) => {
  assert.ok(result.status === 'unavailable' || result.status === 'disabled')
  assert.deepEqual(result, emptyShells(result.status))
}

test('no session or provider data is read with monitoring off, missing workspace or invalid selection', async () => {
  let reads = 0
  const deps = { ...defaults,
    snapshot: async () => { reads++; return source },
    focus: async () => { reads++; return chat },
    inspect: async () => { reads++; return ready(chat) }
  }
  assert.deepEqual(await createSessionMonitor({ ...deps, enabled: async () => false })(auto), emptyShells('disabled'))
  discarded(await createSessionMonitor({ ...deps, context: async () => null })(auto))
  discarded(await createSessionMonitor(deps)({ selected: 'x'.repeat(161) }))
  assert.equal(reads, 0)
})

test('explicit session bypasses focus lookup and optional provider index', async () => {
  let focusReads = 0, inspections = 0
  const read = createSessionMonitor({ ...defaults,
    focus: async () => { focusReads++; return terminal },
    inspect: async (context, snapshot, selected, sources) => {
      inspections++
      assert.equal(context?.workspaceId, workspace)
      assert.deepEqual(context?.terminals, [{ id: handle }])
      assert.equal(snapshot, source)
      assert.equal(selected, chat)
      assert.equal(sources?.focus, null)
      assert.equal(sources?.providerChildren, undefined)
      return ready(chat)
    }
  })
  assert.deepEqual(await read({ selected: chat }), ready(chat))
  assert.equal(inspections, 1)
  assert.equal(focusReads, 0)
})

test('automatic selection is checked against focus again before returning live work', async () => {
  for (const switched of [false, true]) {
    let focusReads = 0
    const read = createSessionMonitor({ ...defaults,
      focus: async (id, snapshot, terminals) => {
        assert.equal(id, workspace)
        assert.equal(snapshot, source)
        assert.deepEqual(terminals, [{ id: handle }])
        return ++focusReads === 1 || !switched ? chat : terminal
      },
      inspect: async (_context, _snapshot, selected, sources) => {
        assert.equal(selected, null)
        assert.equal(sources?.focus, chat)
        return ready(chat)
      }
    })
    const result = await read(auto)
    if (switched) discarded(result)
    else assert.deepEqual(result, ready(chat))
    assert.equal(focusReads, 2)
  }
})

test('workspace switch or revoked permission during snapshot prevents subsequent focus and shell reads', async () => {
  for (const event of ['switch', 'revoke']) {
    let current = workspace, allowed = true, focusReads = 0, inspections = 0
    const read = createSessionMonitor({ ...defaults,
      context: async () => ({ workspaceId: current, terminals: [] }),
      enabled: async () => allowed,
      snapshot: async () => {
        if (event === 'switch') current = sibling
        else allowed = false
        return source
      },
      focus: async () => { focusReads++; return chat },
      inspect: async () => { inspections++; return ready(chat) }
    })
    discarded(await read(auto))
    assert.equal(focusReads, 0)
    assert.equal(inspections, 0)
  }
})

test('in-flight results are dropped when workspace, observation settings, generation, or terminal attachment changes', async () => {
  for (const event of ['switch', 'revoke', 'clear', 'detach', 'provider']) {
    let current = workspace, allowed = true, provider = true, attached = true, inspections = 0
    const read = createSessionMonitor({ ...defaults,
      context: async () => ({ workspaceId: current, terminals: attached ? [{ id: handle }] : [] }),
      enabled: async () => allowed,
      providerEnabled: async () => provider,
      inspect: async () => {
        inspections++
        if (event === 'switch') current = sibling
        if (event === 'revoke') allowed = false
        if (event === 'clear') read.clear()
        if (event === 'detach') attached = false
        if (event === 'provider') provider = false
        return ready(terminal)
      }
    })
    discarded(await read({ selected: terminal }))
    assert.equal(inspections, 1)
  }
})

test('provider child lookup checks permission again when its optional callback is invoked', async () => {
  let provider = true, checks = 0, checkedDuringCallback = false
  const read = createSessionMonitor({ ...defaults,
    providerEnabled: async () => { checks++; return provider },
    inspect: async (_context, _snapshot, _selected, sources) => {
      provider = false
      const checksBefore = checks
      const children = await sources?.providerChildren?.(workspace, [])
      checkedDuringCallback = checks > checksBefore && children?.size === 0
      return ready(chat)
    }
  })
  discarded(await read({ selected: chat }))
  assert.ok(checkedDuringCallback)
})
