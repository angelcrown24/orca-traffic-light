import { assert, mount, test } from 'orca/testing'
import { RecentCalls } from './recent-calls'
import type { Call } from './protocol'
import type { NativeToolCall } from './native-reader'
import type { ToolboxEvent } from './toolbox-types'

const terminal = (id: string, at: number): Call => ({ id, startedAt: at, tool: 'shell-' + id, agent: 'Codex', state: 'finished' })
const native = (id: string, at: number): NativeToolCall => ({ id, observedAt: at, name: 'chat-' + id, agentType: 'Antigravity', state: 'completed' })
const shared = (id: string, at: number): ToolboxEvent => ({ id, bundleId: 'one', startedAt: at, name: 'runner-' + id,
  kind: 'mcp', operation: 'call', state: 'running' })

test('shows the latest 30 calls in time order across all three sources and clears hidden older rows', async () => {
  const make = <T,>(fn: (id: string, at: number) => T, offset: number) =>
    Array.from({ length: 20 }, (_, i) => fn(String(i), 1000 + i * 3 + offset))
  const render = () => <RecentCalls workspace loading={false} terminal={make(terminal, 0)} native={make(native, 1)} shared={make(shared, 2)} />
  const view = await mount(render, { locale: 'en-US' })
  try {
    await view.toggle({ label: 'Recent tool calls · 30' })
    assert.deepEqual(view.findAll({ type: 'RelativeTime' }).map(x => x.props.at), Array.from({ length: 30 }, (_, i) => 1059 - i))
    assert.ok(view.find({ text: 'runner-19' }))
    assert.ok(view.find({ text: 'chat-19' }))
    assert.ok(view.find({ text: 'shell-19' }))
    assert.equal(view.find({ text: 'runner-9' }), null)
    await view.press({ text: 'Clear list' })
    assert.ok(view.find({ label: 'Recent tool calls · 0' }))
    assert.equal(view.find({ type: 'RelativeTime' }), null)
    await view.rerender()
    assert.equal(view.find({ type: 'RelativeTime' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('clearing survives remount, a later completion and a late old response; new same-ms calls and other workspaces still appear', async () => {
  const now = Date.now
  const tick = 1700000000000
  let calls = [{ ...terminal('one', tick), state: 'running' as Call['state'] }]
  const render = () => <RecentCalls workspace loading={false} terminal={calls} native={[]} shared={[]} />
  Date.now = () => tick
  try {
    const view = await mount(render, { locale: 'ko-KR' })
    let persisted
    try {
      await view.toggle({ label: '최근 도구 호출 · 1' })
      await view.press({ text: '목록 비우기' })
      assert.ok(view.find({ label: '최근 도구 호출 · 0' }))
      persisted = view.persisted
    } finally { await view.unmount() }
    calls = [terminal('one', tick), terminal('late-old', tick - 1), terminal('new', tick)]
    const reopened = await mount(render, { locale: 'ko-KR', persisted })
    try {
      await reopened.toggle({ label: '최근 도구 호출 · 1' })
      assert.ok(reopened.find({ text: 'shell-new' }))
      assert.equal(reopened.find({ text: 'shell-one' }), null)
      assert.equal(reopened.find({ text: 'shell-late-old' }), null)
    } finally { await reopened.unmount() }
    const otherWorkspace = await mount(render, { locale: 'ko-KR', persisted: { plugin: persisted.plugin, workspace: {} } })
    try { assert.ok(otherWorkspace.find({ label: '최근 도구 호출 · 3' })) }
    finally { await otherWorkspace.unmount() }
  } finally { Date.now = now }
})
