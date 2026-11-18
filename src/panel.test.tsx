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
    assert.equal(view.find({ type: 'Row', text: 'review' })?.text, 'review')
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
