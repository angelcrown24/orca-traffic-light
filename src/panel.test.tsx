import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

test('shows observed calls and does not label finished as successful', async () => {
  const host = mockHost({ requests: { 'calls.get': () => ({ workspace: true, calls: [{ id: '1', tool: 'Read', agent: 'claude', state: 'finished' }] }) } })
  const view = await mount(panel, { host })
  await view.toggle({ label: 'Recent tool calls · 1' })
  assert.equal(Boolean(view.find({ text: 'Read' })), true)
  assert.equal(Boolean(view.find({ text: 'Finished' })), true)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('clears stale calls on refresh failure and recovers on retry', async () => {
  let failing = false
  const host = mockHost({ requests: { 'calls.get': () => {
    if (failing) throw new Error('unavailable')
    return { workspace: true, calls: [{ id: '1', tool: 'Read', agent: 'claude', state: 'finished' }] }
  } } })
  const view = await mount(panel, { host })
  await view.toggle({ label: 'Recent tool calls · 1' })
  assert.equal(Boolean(view.find({ text: 'Read' })), true)
  failing = true
  await view.post('calls.changed', {})
  assert.equal(view.find({ text: 'Read' }), null)
  assert.equal(Boolean(view.find({ text: 'Could not load tool calls.' })), true)
  failing = false
  await view.press({ text: 'Retry' })
  assert.equal(Boolean(view.find({ text: 'Read' })), true)
  assert.equal(view.find({ text: 'Could not load tool calls.' }), null)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('native activity is off by default and only requested after explicit opt-in', async () => {
  let requests = 0
  const host = mockHost({ settings: { nativeActivity: false }, requests: {
    'calls.get': () => ({ workspace: true, calls: [] }),
    'native.get': () => { requests++; return { status: 'ready', activities: [{ agentType: 'codex', state: 'working', toolName: 'Read' }], resources: [] } }
  } })
  const view = await mount(panel, { host })
  try {
  assert.equal(requests, 0)
  await view.toggle({ label: 'Settings & privacy' })
  assert.equal(Boolean(view.find({ text: 'When on, workspace status can include prompts, tool inputs and replies from all workspaces. On macOS, recent tool inputs in this workspace are also read.' })), true)
  await view.toggle({ label: 'Show chat activity' })
  assert.equal(requests > 0, true)
  assert.equal(Boolean(view.find({ text: 'codex · Read' })), true)
  await view.toggle({ label: 'Show chat activity' })
  assert.equal(view.find({ text: 'codex · Read' }), null)
  } finally { await view.unmount() }
})

test('shows live subagents separately and removes them when they are no longer reported', async () => {
  let hasSubagents = true
  const host = mockHost({ settings: { nativeActivity: true }, requests: {
    'calls.get': () => ({ workspace: true, calls: [] }),
    'native.get': () => ({ status: 'ready', resources: [], activities: [
      { agentType: 'codex', state: 'working', toolName: null },
      ...(hasSubagents ? [
        { role: 'subagent' as const, label: 'review', agentType: 'codex', state: 'working' as const, toolName: null },
        { role: 'subagent' as const, label: 'audit', agentType: 'codex', state: 'unverifiable' as const, toolName: null }
      ] : [])
    ] })
  } })
  const view = await mount(panel, { host, locale: 'ko-KR' })
  try {
    assert.equal(Boolean(view.find({ text: 'codex' })), true)
    assert.equal(Boolean(view.find({ text: '서브에이전트' })), true)
    assert.equal(Boolean(view.find({ text: 'review' })), true)
    assert.equal(Boolean(view.find({ text: 'audit' })), true)
    assert.equal(Boolean(view.find({ text: '확인 불가' })), true)
    hasSubagents = false
    await view.emit('workspace.changed', { context: null })
    assert.equal(view.find({ text: '서브에이전트' }), null)
    assert.equal(view.find({ text: 'review' }), null)
    assert.equal(Boolean(view.find({ text: 'codex' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})


test('does not request native activity while the panel is hidden', async () => {
  let requests = 0
  const host = mockHost({ settings: { nativeActivity: true }, requests: {
    'calls.get': () => ({ workspace: true, calls: [] }),
    'native.get': () => { requests++; return { status: 'ready', activities: [], resources: [] } }
  } })
  const view = await mount(panel, { host, visible: false })
  try {
    assert.equal(requests, 0)
    await view.emit('workspace.changed', { context: null })
    assert.equal(requests, 0)
    await view.setVisible(true)
    await view.emit('workspace.changed', { context: null })
    assert.equal(requests, 1)
    await view.setVisible(false)
    await view.emit('workspace.changed', { context: null })
    assert.equal(requests, 1)
  } finally { await view.unmount() }
})


test('shows detected resource names and explains the detection source', async () => {
  const host = mockHost({ requests: { 'calls.get': () => ({ workspace: true, calls: [], resources: [
    { category: 'skill', name: 'ui-ux-pro-max', evidence: 'inferred' },
    { category: 'mcp', name: 'figma-local', evidence: 'observed' }
  ] }) } })
  const view = await mount(panel, { host })
  try {
    assert.equal(Boolean(view.find({ text: 'ui-ux-pro-max' })), true)
    assert.equal(Boolean(view.find({ text: 'figma-local' })), true)
    assert.equal(Boolean(view.find({ text: 'Observed in tool calls, skill file paths and the shared runner. In use marks a running request or an ongoing agent turn.' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('shows both native and terminal resource names', async () => {
  const host = mockHost({ settings: { nativeActivity: true }, requests: {
    'calls.get': () => ({ workspace: true, calls: [], resources: [{ category: 'skill', name: 'ux', evidence: 'inferred' }] }),
    'native.get': () => ({ status: 'ready', activities: [], resources: [{ category: 'plugin', name: 'example', evidence: 'observed' }] })
  } })
  const view = await mount(panel, { host })
  try {
    assert.equal(Boolean(view.find({ text: 'ux' })), true)
    assert.equal(Boolean(view.find({ text: 'example' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('marks only active resources and clears the badge when a call ends', async () => {
  let active = true
  const current = { category: 'skill', name: 'ui-ux-pro-max', evidence: 'inferred' } as const
  const host = mockHost({ requests: {
    'calls.get': () => ({
      workspace: true, calls: [],
      resources: [current, { category: 'skill' as const, name: 'earlier-skill', evidence: 'observed' as const }],
      activeResources: active ? [current] : []
    })
  } })
  const view = await mount(panel, { host })
  try {
    assert.equal(Boolean(view.find({ text: 'ui-ux-pro-max' })), true)
    assert.equal(Boolean(view.find({ text: 'earlier-skill' })), true)
    assert.equal(Boolean(view.find({ text: 'In use' })), true)
    active = false
    await view.post('calls.changed', {})
    assert.equal(view.find({ text: 'In use' }), null)
    assert.equal(Boolean(view.find({ text: 'ui-ux-pro-max' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('merges native activity across sources and clears it on opt-out', async () => {
  const host = mockHost({ settings: { nativeActivity: true }, requests: {
    'calls.get': () => ({ workspace: true, calls: [], resources: [{ category: 'skill', name: 'ui-ux-pro-max', evidence: 'observed' }], activeResources: [] }),
    'native.get': () => ({ status: 'ready', activities: [], resources: [], activeResources: [{ category: 'skill', name: 'ui-ux-pro-max', evidence: 'inferred' }] })
  } })
  const view = await mount(panel, { host, locale: 'ko-KR' })
  try {
    assert.equal(Boolean(view.find({ text: 'ui-ux-pro-max' })), true)
    assert.equal(Boolean(view.find({ text: '현재 사용 중' })), true)
    await view.toggle({ label: '설정 및 개인정보' })
    await view.toggle({ label: '채팅 활동 표시' })
    assert.equal(view.find({ text: '현재 사용 중' }), null)
    assert.equal(Boolean(view.find({ text: 'ui-ux-pro-max' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})


test('shows Korean labels and privacy disclosure beside the switch', async () => {
  const host = mockHost({ settings: { nativeActivity: false }, requests: {
    'calls.get': () => ({ workspace: true, calls: [], resources: [{ category: 'skill', name: 'ui-ux-pro-max', evidence: 'inferred' }] })
  } })
  const view = await mount(panel, { host, locale: 'ko-KR' })
  try {
    assert.equal(Boolean(view.find({ text: '감지된 항목' })), true)
    assert.equal(Boolean(view.find({ text: '스킬' })), true)
    assert.equal(Boolean(view.find({ text: '도구 호출, 스킬 파일 경로, 공용 실행기에서 감지한 항목입니다. 현재 사용 중은 요청이나 에이전트 작업이 진행 중일 때 표시됩니다.' })), true)
    await view.toggle({ label: '설정 및 개인정보' })
    assert.equal(Boolean(view.find({ label: '채팅 활동 표시' })), true)
    assert.equal(Boolean(view.find({ text: '켜면 모든 작업공간의 상태에 포함된 프롬프트·도구 입력·응답을 읽습니다. macOS에서는 현재 작업공간의 최근 도구 입력도 읽습니다.' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('Jev shows ranked candidates separately from confirmed reads and calls with chat monitoring disabled', async () => {
  let workspaceId = 'first'
  const host = mockHost({ settings: { nativeActivity: false }, requests: {
    'calls.get': () => ({ workspace: true, calls: [] }),
    'toolbox.activity': () => workspaceId === 'first' ? { workspaceId, recommendations: [
      { id: 'read', name: 'design', kind: 'skill', at: 1700000000000 },
      { id: 'list', name: 'maps', kind: 'mcp', at: 1700000000010 },
      { id: 'use', name: 'graphics', kind: 'mcp', at: 1700000000020 }
    ], events: [
      { id: 'e1', bundleId: 'a', recommendationId: 'read', name: 'design', kind: 'skill', operation: 'skill', state: 'succeeded', startedAt: 1700000000030 },
      { id: 'e2', bundleId: 'a', recommendationId: 'list', name: 'maps', kind: 'mcp', operation: 'tools', state: 'succeeded', startedAt: 1700000000040 },
      { id: 'e3', bundleId: 'a', recommendationId: 'use', name: 'graphics · draw', kind: 'mcp', operation: 'call', state: 'failed', startedAt: 1700000000050 },
      { id: 'other', bundleId: 'b', capabilityName: 'other-server', name: 'other-server · unrelated', kind: 'mcp', operation: 'call', state: 'succeeded', startedAt: 1700000000060 }
    ] } : { workspaceId, recommendations: [], events: [] }
  } })
  const view = await mount(panel, { host, locale: 'ko-KR' })
  try {
    for (const text of ['Jev 추천', 'other-server', 'design', '읽음', 'maps', '추천됨', 'graphics · draw', '호출 실패']) {
      assert.ok(view.find({ text }), text)
    }
    assert.equal(view.find({ text: 'other-server · unrelated' }), null)
    assert.equal(view.find({ text: '현재 사용 중' }), null)
    await view.toggle({ label: '최근 도구 호출 · 2' })
    assert.ok(view.find({ text: 'other-server · unrelated' }))
    workspaceId = 'second'
    await view.emit('workspace.changed', { context: null })
    assert.equal(view.find({ text: 'graphics · draw' }), null)
    assert.equal(view.find({ text: 'design' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('hidden activity refreshes its workspace history on return and shows provider-native ordinary tools', async () => {
  let reads = 0
  const host = mockHost({ settings: { nativeActivity: true }, requests: {
    'calls.get': () => ({ workspace: true, calls: [] }),
    'toolbox.activity': () => { reads++; return { workspaceId: 'ws', recommendations: [], events: [] } },
    'native.get': () => ({ status: 'ready', resources: [], activities: [], recentTools: [
      { id: 'ag1', name: 'view_file', agentType: 'Antigravity', observedAt: 1700000000000, state: 'completed' },
      { id: 'ag2', name: 'jev-code/rank', agentType: 'Antigravity', observedAt: 1700000000020, state: 'completed' }
    ] })
  } })
  const view = await mount(panel, { host, visible: false })
  try {
    await view.post('toolbox.changed', {})
    assert.equal(reads, 0)
    await view.setVisible(true)
    await view.post('toolbox.changed', {})
    assert.equal(reads, 1)
    await view.emit('workspace.changed', { context: null })
    assert.ok(view.find({ label: 'Direct Jev lookup · jev-code/rank' }))
    await view.toggle({ label: 'Direct Jev lookup · jev-code/rank' })
    assert.ok(view.find({ text: 'The agent called Jev directly. The returned candidates are unavailable for this call.' }))
    assert.equal(view.find({ text: 'Suggested' }), null)
    await view.toggle({ label: 'Recent tool calls · 2' })
    assert.ok(view.find({ text: 'Antigravity · Jev lookup' }))
    assert.ok(view.find({ text: 'view_file' }))
    assert.ok(view.find({ text: 'Antigravity' }))
    assert.ok(view.find({ text: 'Completed' }))
    await view.toggle({ label: 'Settings & privacy' })
    await view.toggle({ label: 'Show chat activity' })
    assert.equal(view.find({ text: 'view_file' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})
