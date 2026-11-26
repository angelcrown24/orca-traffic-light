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

test('hidden panels skip terminal status requests and resume on the Activity tab', async () => {
  let reads = 0
  const host = mockHost({ settings: { nativeActivity: true }, requests: {
    'calls.get': () => ({workspace:true,calls:[]}),
    'activity.terminals': () => { reads++; return {status:'ready',rows:[],openTerminals:0} }
  } })
  const view = await mount(panel, { host, visible:false })
  try {
    await view.post('calls.changed', {})
    assert.equal(reads,0)
    await view.setVisible(true)
    await view.emit('workspace.changed',{context:null})
    assert.ok(reads>0)
    const previous = reads
    await view.setVisible(false)
    await view.emit('workspace.changed',{context:null})
    await view.post('calls.changed',{})
    assert.equal(reads,previous)
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
    assert.equal(Boolean(view.find({ text: 'Observed in tool calls, skill file paths and the shared runner. In use marks a running request in a terminal or the shared runner.' })), true)
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

test('shows Korean labels and privacy disclosure beside the switch', async () => {
  const host = mockHost({ settings: { nativeActivity: false }, requests: {
    'calls.get': () => ({ workspace: true, calls: [], resources: [{ category: 'skill', name: 'ui-ux-pro-max', evidence: 'inferred' }] })
  } })
  const view = await mount(panel, { host, locale: 'ko-KR' })
  try {
    assert.equal(Boolean(view.find({ text: '스킬 · 플러그인 · MCP' })), true)
    assert.equal(Boolean(view.find({ text: '스킬' })), true)
    await view.toggle({ label: '설정 및 개인정보' })
    await view.toggle({ label: '어떤 정보를 읽나요?' })
    assert.equal(Boolean(view.find({ text: '도구 호출, 스킬 파일 경로, 공용 실행기에서 감지한 항목입니다. 현재 사용 중은 도구 호출이나 공용 실행기 요청이 진행 중일 때 표시됩니다.' })), true)
    assert.equal(Boolean(view.find({ label: '터미널 에이전트 상태 표시' })), true)
    assert.equal(Boolean(view.find({ text: 'Orca 공식 API로 현재 작업공간의 터미널 에이전트 상태를 표시합니다.' })), true)
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

test('refreshes shared runner events when activity becomes visible again', async () => {
  let reads = 0
  const host = mockHost({requests:{
    'calls.get': () => ({workspace:true,calls:[]}),
    'toolbox.activity': () => { reads++; return {workspaceId:'ws',recommendations:[],events:[] } }
  }})
  const view = await mount(panel,{host,visible:false})
  try {
    await view.post('toolbox.changed',{})
    assert.equal(reads,0)
    await view.setVisible(true)
    await view.post('toolbox.changed',{})
    assert.equal(reads,1)
    assert.deepEqual(view.errors,[])
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

test('groups live public tool names underneath their terminal and explains unavailable native chat coverage', async () => {
  const host = mockHost({ settings:{nativeActivity:true}, requests:{
    'calls.get':() => ({workspace:true,calls:[]}),
    'activity.terminals':() => ({status:'ready',openTerminals:2,rows:[{terminal:1,agent:'codex',state:'working',tools:['exec_command','Read']}]})
  } })
  const view = await mount(panel,{host,locale:'en-US'})
  try {
    assert.ok(view.find({text:'Codex · Terminal 1'}))
    assert.ok(view.find({text:'Working'}))
    assert.ok(view.find({text:'exec_command · Read'}))
    assert.ok(view.find({text:/Native chat tool calls and subagent trees/}))
    await view.toggle({label:'Settings & privacy'})
    await view.toggle({label:'Show terminal agent status'})
    assert.equal(view.find({text:'exec_command · Read'}),null)
    assert.deepEqual(view.errors,[])
  } finally { await view.unmount() }
})
