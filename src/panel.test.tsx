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

const options = [
  { id: 'chat:one', kind: 'chat' as const, provider: 'Codex', number: 1 },
  { id: 'terminal:two', kind: 'terminal' as const, number: 1 }
]
const session = {
  status: 'ready' as const, options, selected: 'chat:one',
  rows: [{ kind: 'shell' as const, state: 'running' as const, name: 'zsh' }],
  subagents: []
}

test('shows the selected session shells with its active subagents and removes completed and idle hosts', async () => {
  const host = mockHost({ settings: { nativeActivity: true, antigravityChildStatus: true }, requests: {
    'calls.get': () => ({ workspace: true, calls: [] }),
    'native.get': () => ({ status: 'ready', resources: [], activities: [
      { agentType: 'another-workspace-agent', state: 'working', toolName: null },
      { agentType: 'completed-parent', state: 'done', toolName: null }
    ] }),
    'session.shells': () => ({ ...session, subagents: [
      { role: 'subagent', label: 'review', agentType: 'antigravity', state: 'working', toolName: null, statusSource: 'antigravity', statusUpdatedAt: 1700000000000 },
      { role: 'subagent', label: 'watch', agentType: 'codex', state: 'monitoring', toolName: null },
      { role: 'subagent', label: 'finished', agentType: 'codex', state: 'done', toolName: null },
      { role: 'subagent', label: 'idle-job', agentType: 'codex', state: 'idle', toolName: null },
      { role: 'subagent', label: 'uncertain-job', agentType: 'codex', state: 'unverifiable', toolName: null }
    ] })
  } })
  const view = await mount(panel, { host })
  try {
    assert.ok(view.find({ text: 'Session activity' }))
    assert.ok(view.find({ text: 'zsh' }))
    assert.ok(view.find({ text: 'review' }))
    assert.ok(view.find({ text: 'watch' }))
    assert.ok(view.find({ text: 'Monitoring' }))
    assert.equal(view.find({ type: 'RelativeTime' })?.props.at, 1700000000000)
    for (const text of ['another-workspace-agent', 'completed-parent', 'finished', 'idle-job', 'uncertain-job', 'Agent activity', 'Done', 'Idle']) {
      assert.equal(view.find({ text }), null)
    }
    await view.toggle({ label: 'Settings & privacy' })
    await view.toggle({ label: 'Show Antigravity subagent status' })
    assert.equal(view.find({ text: 'review' }), null)
    assert.ok(view.find({ text: 'watch' }))
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('selects a session when Orca cannot resolve focus and clears the old session when a selection changes', async () => {
  let focused = false
  const inputs: (string | null)[] = []
  const host = mockHost({ settings: { nativeActivity: true }, requests: {
    'calls.get': () => ({ workspace: true, calls: [] }),
    'native.get': () => ({ status: 'ready', resources: [], activities: [] }),
    'session.shells': ({ selected }) => {
      inputs.push(selected)
      if (!selected && !focused) return { status: 'select', options, selected: null, rows: [], subagents: [] }
      if (selected === 'terminal:two') return { ...session, selected, rows: [{ kind: 'terminal', state: 'connected', name: 'fish' }] }
      return session
    }
  } })
  const view = await mount(panel, { host, locale: 'ko-KR' })
  try {
    assert.equal(view.find({ text: 'zsh' }), null)
    assert.equal(view.find({ text: 'fish' }), null)
    assert.ok(view.find({ label: '세션' }))
    await view.select({ label: '세션' }, 'terminal:two')
    assert.ok(view.find({ text: 'fish' }))
    assert.ok(view.find({ text: '연결됨' }))
    assert.equal(view.find({ text: 'zsh' }), null)
    focused = true
    await view.select({ label: '세션' }, 'follow-active')
    assert.ok(view.find({ text: 'zsh' }))
    assert.equal(view.find({ text: 'fish' }), null)
    await view.select({ label: '세션' }, 'terminal:two')
    focused = false
    await view.emit('workspace.changed', { context: null })
    assert.equal(view.find({ text: 'fish' }), null)
    assert.equal(inputs.at(-1), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('distinguishes a verified empty session, disabled monitoring and an unavailable source', async () => {
  let status: 'disabled' | 'ready' | 'unavailable' = 'disabled'
  const host = mockHost({ settings: { nativeActivity: false }, requests: {
    'calls.get': () => ({ workspace: true, calls: [] }),
    'native.get': () => ({ status: 'ready', resources: [], activities: [] }),
    'session.shells': () => ({ status, selected: status === 'ready' ? 'chat:one' : null, options: status === 'ready' ? options.slice(0, 1) : [], rows: [], subagents: [] })
  } })
  const view = await mount(panel, { host })
  try {
    assert.ok(view.find({ text: 'Turn on chat activity in Settings & privacy to monitor this session.' }))
    await view.toggle({ label: 'Settings & privacy' })
    assert.equal(view.find({ label: 'Show Antigravity subagent status' })?.disabled, true)
    status = 'ready'
    await view.toggle({ label: 'Show chat activity' })
    assert.ok(view.find({ text: 'No running shells or subagents reported.' }))
    assert.equal(view.find({ text: 'Agent activity' }), null)
    status = 'unavailable'
    await view.emit('workspace.changed', { context: null })
    assert.ok(view.find({ text: 'Session status is unavailable.' }))
    assert.equal(view.find({ text: 'No running shells or subagents reported.' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('does not read activity sources or refresh terminal calls on hook events while hidden', async () => {
  let requests = 0
  let shellRequests = 0
  let terminalReads = 0
  const host = mockHost({ settings: { nativeActivity: true }, requests: {
    'calls.get': () => { terminalReads++; return { workspace: true, calls: [] } },
    'session.shells': () => { shellRequests++; return { status: 'select', selected: null, options: [], rows: [], subagents: [] } },
    'native.get': () => { requests++; return { status: 'ready', activities: [], resources: [] } }
  } })
  const view = await mount(panel, { host, visible: false })
  try {
    await view.post('calls.changed', {})
    assert.equal(terminalReads, 0)
    assert.equal(requests, 0)
    assert.equal(shellRequests, 0)
    await view.emit('workspace.changed', { context: null })
    assert.equal(requests, 0)
    assert.equal(shellRequests, 0)
    await view.setVisible(true)
    await view.emit('workspace.changed', { context: null })
    assert.equal(requests, 1)
    assert.ok(shellRequests > 0)
    const visibleReads = shellRequests
    await view.setVisible(false)
    await view.emit('workspace.changed', { context: null })
    assert.equal(requests, 1)
    assert.equal(shellRequests, visibleReads)
  } finally { await view.unmount() }
})


test('shows detected resource names and explains the detection source in privacy details', async () => {
  const host = mockHost({ requests: { 'calls.get': () => ({ workspace: true, calls: [], resources: [
    { category: 'skill', name: 'ui-ux-pro-max', evidence: 'inferred' },
    { category: 'mcp', name: 'figma-local', evidence: 'observed' }
  ] }) } })
  const view = await mount(panel, { host })
  try {
    assert.equal(Boolean(view.find({ text: 'ui-ux-pro-max' })), true)
    assert.equal(Boolean(view.find({ text: 'figma-local' })), true)
    await view.toggle({ label: 'Settings & privacy' })
    await view.toggle({ label: 'How activity is read' })
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
    await view.toggle({ label: '설정 및 개인정보' })
    await view.toggle({ label: '어떤 정보를 읽나요?' })
    assert.equal(Boolean(view.find({ text: '도구 호출, 스킬 파일 경로, 공용 실행기에서 감지한 항목입니다. 현재 사용 중은 요청이나 에이전트 작업이 진행 중일 때 표시됩니다.' })), true)
    assert.equal(Boolean(view.find({ label: '채팅 활동 표시' })), true)
    assert.equal(Boolean(view.find({ text: '켜면 모든 작업공간의 상태에 포함된 프롬프트·도구 입력·응답을 읽습니다. macOS에서는 현재 작업공간의 최근 도구 입력도 읽습니다.' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('marks only Jev-linked uses in existing resource and call rows, and clears them on workspace change', async () => {
  let workspaceId = 'first'
  const host = mockHost({ settings: { nativeActivity: false }, requests: {
    'calls.get': () => ({ workspace: true, calls: [] }),
    'toolbox.activity': () => workspaceId === 'first' ? { workspaceId, recommendations: [
      { id: 'rec-skill', name: 'design', kind: 'skill', at: 1 },
      { id: 'rec-list', name: 'maps', kind: 'mcp', at: 2 },
      { id: 'rec-mcp', name: 'graphics', kind: 'mcp', at: 3 },
      { id: 'rec-unused', name: 'unused-skill', kind: 'skill', at: 4 }
    ], events: [
      { id: 'read', bundleId: 'a', recommendationId: 'rec-skill', capabilityName: 'design', name: 'design', kind: 'skill', operation: 'skill', state: 'running', startedAt: 5 },
      { id: 'list', bundleId: 'a', capabilityName: 'maps', name: 'maps', kind: 'mcp', operation: 'tools', state: 'succeeded', startedAt: 6 },
      { id: 'linked-call', bundleId: 'a', recommendationId: 'rec-mcp', capabilityName: 'graphics', name: 'graphics · draw', kind: 'mcp', operation: 'call', state: 'failed', startedAt: 7 },
      { id: 'direct-call', bundleId: 'b', capabilityName: 'graphics', name: 'graphics · draw', kind: 'mcp', operation: 'call', state: 'succeeded', startedAt: 8 },
      { id: 'direct-read', bundleId: 'b', capabilityName: 'review', name: 'review', kind: 'skill', operation: 'skill', state: 'succeeded', startedAt: 9 }
    ] } : { workspaceId, recommendations: [], events: [] }
  } })
  const view = await mount(panel, { host, locale: 'ko-KR' })
  try {
    assert.equal(view.find({ text: 'Jev 추천' }), null)
    assert.equal(view.find({ text: 'unused-skill' }), null)
    assert.equal(view.find({ text: 'maps' }), null)
    const skillRow = view.find({ type: 'Row', text: /^design/ })
    assert.ok(skillRow?.text.includes('Jev'))
    assert.ok(skillRow?.text.includes('현재 사용 중'))
    assert.ok(view.find({ type: 'Row', text: /^graphics/ })?.text.includes('Jev'))
    assert.ok(view.find({ text: 'review' }))
    assert.equal(view.find({ type: 'Row', text: /^review/ })?.text.includes('Jev'), false)
    const badges = view.findAll({ type: 'Badge', text: 'Jev' })
    assert.equal(badges.length, 2)
    assert.ok(badges.every(badge => badge.props.tone === 'neutral'))
    await view.toggle({ label: '최근 도구 호출 · 2' })
    const linkedCall = view.find({ type: 'Row', text: /^graphics · draw.*실패/ })
    assert.ok(linkedCall?.text.includes('Jev'))
    assert.ok(linkedCall?.text.includes('실패'))
    const directCall = view.find({ type: 'Row', text: /^graphics · draw.*완료/ })
    assert.ok(directCall?.text.includes('완료'))
    assert.equal(directCall?.text.includes('Jev'), false)
    assert.equal(view.findAll({ type: 'Badge', text: 'Jev' }).length, 3)
    workspaceId = 'second'
    await view.emit('workspace.changed', { context: null })
    assert.equal(view.find({ text: 'Jev' }), null)
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
    assert.equal(view.find({ label: /Jev/ }), null)
    assert.equal(view.find({ text: 'jev-code/rank' }), null)
    await view.toggle({ label: 'Recent tool calls · 2' })
    assert.ok(view.find({ text: 'jev-code/rank' }))
    assert.equal(view.find({ type: 'Badge', text: 'Jev' }), null)
    assert.ok(view.find({ text: 'view_file' }))
    assert.ok(view.find({ text: 'Antigravity' }))
    assert.ok(view.find({ text: 'Completed' }))
    await view.toggle({ label: 'Settings & privacy' })
    await view.toggle({ label: 'Show chat activity' })
    assert.equal(view.find({ text: 'view_file' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('live items precede earlier items across types and long lists can be paged', async () => {
  const skills = Array.from({ length: 10 }, (_, index) => ({ category: 'skill' as const, name: 'skill-' + index, evidence: 'observed' as const }))
  const active = { category: 'plugin' as const, name: 'z-last', evidence: 'observed' as const }
  const host = mockHost({ requests: { 'calls.get': () => ({ workspace: true, calls: [], resources: skills, activeResources: [active] }) } })
  const view = await mount(panel, { host })
  try {
    assert.ok(view.find({ text: 'z-last' }))
    assert.ok(view.find({ text: '1 / 2' }))
    assert.equal(view.find({ text: 'skill-9' }), null)
    await view.press({ text: 'Next items' })
    assert.ok(view.find({ text: 'skill-9' }))
    assert.equal(view.find({ text: 'z-last' }), null)
    await view.press({ text: 'Previous items' })
    assert.ok(view.find({ text: 'In use' }))
    assert.equal(view.find({ text: 'MCP server' }), null)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})

test('an unavailable pinned session stays selected until the user explicitly follows another', async () => {
  let attached = true
  const inputs: (string | null)[] = []
  const ctx = { workspaceId: 'workspace-1', branch: 'main', displayName: 'Workspace', terminals: [] }
  const host = mockHost({ settings: { nativeActivity: true }, requests: {
    'calls.get': () => ({ workspace: true, calls: [] }),
    'native.get': () => ({ status: 'ready', resources: [], activities: [] }),
    'session.shells': ({ selected }) => {
      inputs.push(selected)
      if (!selected) return { ...session, selected: 'terminal:two', rows: [{ kind: 'terminal', name: 'fish', state: 'connected' }] }
      return attached ? { ...session, selected } : { status: 'select', selected: null, rows: [], subagents: [], options: options.slice(1) }
    }
  } })
  const view = await mount(panel, { host })
  try {
    await view.emit('workspace.changed', { context: ctx })
    await view.select({ label: 'Session' }, 'chat:one')
    attached = false
    await view.emit('workspace.changed', { context: ctx })
    await view.emit('workspace.changed', { context: ctx })
    assert.equal(inputs.at(-1), 'chat:one')
    assert.equal(view.find({ text: 'fish' }), null)
    assert.ok(view.find({ text: 'The selected session is no longer available. Choose a session to continue.' }))
    await view.select({ label: 'Session' }, 'follow-active')
    assert.ok(view.find({ text: 'fish' }))
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})
