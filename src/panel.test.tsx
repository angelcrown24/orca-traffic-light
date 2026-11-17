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
    assert.equal(Boolean(view.find({ text: 'Names found in tool calls and skill file paths. In use marks activity detected during an ongoing agent turn.' })), true)
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
    assert.equal(Boolean(view.find({ text: '도구 호출과 스킬 파일 경로에서 찾은 이름입니다. 현재 사용 중은 진행 중인 에이전트 작업에서 감지된 항목입니다.' })), true)
    await view.toggle({ label: '설정 및 개인정보' })
    assert.equal(Boolean(view.find({ label: '채팅 활동 표시' })), true)
    assert.equal(Boolean(view.find({ text: '켜면 모든 작업공간의 상태에 포함된 프롬프트·도구 입력·응답을 읽습니다. macOS에서는 현재 작업공간의 최근 도구 입력도 읽습니다.' })), true)
    assert.deepEqual(view.errors, [])
  } finally { await view.unmount() }
})
