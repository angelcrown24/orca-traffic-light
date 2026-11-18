import { atom, Badge, Box, Button, Collapsible, env, Heading, on, plugin, read, Row, Separator, set, settings, Stack, Switch, Tab, Tabs, Text, type PanelContext } from 'orca'
import type { Call } from './protocol'
import { isJevLookup, RecommendationActivity } from './recommendation-activity'
import type { ToolboxActivity } from './toolbox-types'
import type { NativeToolCall } from './native-reader'
import type { NativeActivity } from './native-activity'
import type { ResourceObservation } from './resource-classifier'
import { ArchitecturePanel, ToolboxPanel, openToolbox, setupToolbox } from './toolbox-panel'

const tab = atom('traffic-light.tab', 'activity', { persist: 'workspace' })
const calls = atom<Call[]>([])
const terminalResources = atom<ResourceObservation[]>([])
const nativeResources = atom<ResourceObservation[]>([])
const terminalActiveResources = atom<ResourceObservation[]>([])
const nativeActiveResources = atom<ResourceObservation[]>([])
const workspace = atom(false)
const loading = atom(true)
const failed = atom(false)
const nativeEnabled = atom(false)
const nativeStatus = atom<'disabled' | 'ready' | 'unavailable'>('disabled')
const journalStatus = atom<'ready' | 'truncated' | 'unavailable' | undefined>(undefined)
const nativeActivities = atom<NativeActivity[]>([])
const nativeTools = atom<NativeToolCall[]>([])
const sharedActivity = atom<ToolboxActivity | null>(null)
const sharedUnavailable = atom(false)
let sharedRequestId = 0
let sharedDirty = true
let nativeRequestId = 0
let requestId = 0
let isPanelVisible = () => false
async function refresh(): Promise<void> {
  const id = ++requestId
  try {
    const result = await plugin.request('calls.get')
    if (id !== requestId) return
    set(calls, result.calls)
    set(terminalResources, result.resources ?? [])
    set(terminalActiveResources, result.activeResources ?? [])
    set(workspace, result.workspace)
    set(failed, false)
  } catch {
    if (id !== requestId) return
    set(calls, [])
    set(terminalResources, [])
    set(terminalActiveResources, [])
    set(workspace, false)
    set(failed, true)
  } finally { if (id === requestId) set(loading, false) }
}
async function refreshShared(): Promise<void> {
  sharedDirty = true
  if (!isPanelVisible()) return
  const id = ++sharedRequestId
  sharedDirty = false
  try {
    const result = await plugin.request('toolbox.activity')
    if (id !== sharedRequestId) return
    set(sharedActivity, result?.workspaceId ? result : null)
    set(sharedUnavailable, false)
  } catch {
    if (id !== sharedRequestId) return
    set(sharedActivity, null)
    set(sharedUnavailable, true)
    sharedDirty = true
  }
}
function clearNative(status: 'disabled' | 'unavailable') {
  nativeRequestId++
  set(nativeActivities, [])
  set(nativeTools, [])
  set(nativeResources, [])
  set(nativeActiveResources, [])
  set(journalStatus, undefined)
  set(nativeStatus, status)
}
async function readNativeSetting(): Promise<void> {
  try { set(nativeEnabled, (await settings.get('nativeActivity')) === true) }
  catch { set(nativeEnabled, false); clearNative('unavailable') }
}
async function refreshNative(): Promise<void> {
  if (!read(nativeEnabled) || !isPanelVisible()) return
  const id = ++nativeRequestId
  try {
    const result = await plugin.request('native.get')
    if (id !== nativeRequestId || !read(nativeEnabled)) return
    set(nativeStatus, result.status)
    set(journalStatus, result.journalStatus)
    set(nativeActivities, result.activities)
    set(nativeTools, result.status === 'ready' ? result.recentTools ?? [] : [])
    set(nativeResources, result.resources ?? [])
    set(nativeActiveResources, result.status === 'ready' ? result.activeResources ?? [] : [])
  } catch {
    if (id !== nativeRequestId) return
    clearNative('unavailable')
  }
}
async function changeNative(enabled: boolean): Promise<void> {
  try {
    await settings.set('nativeActivity', enabled)
    set(nativeEnabled, enabled)
    clearNative('disabled')
    if (enabled) await refreshNative()
  } catch { set(nativeEnabled, false); clearNative('unavailable') }
}
export function setup(ctx: PanelContext): void {
  isPanelVisible = () => read(ctx.visible) && read(tab) === 'activity'
  setupToolbox(ctx, () => read(tab) === 'library' || read(tab) === 'structure')
  ctx.subscriptions.push({ dispose: () => { sharedRequestId++; isPanelVisible = () => false } })
  ctx.subscriptions.push(plugin.on('toolbox.changed', () => { void refreshShared() }))
  ctx.subscriptions.push(plugin.on('calls.changed', () => { void refresh() }))
  ctx.subscriptions.push(on('workspace.changed', () => {
    sharedRequestId++
    set(sharedActivity, null)
    set(sharedUnavailable, false)
    set(calls, [])
    set(terminalResources, [])
    set(terminalActiveResources, [])
    clearNative('disabled')
    void refreshShared()
    void refresh()
    void refreshNative()
  }))
  ctx.subscriptions.push(settings.onDidChange(() => {
    void readNativeSetting().then(() => { if (!read(nativeEnabled)) clearNative('disabled') })
  }))
  const timer = setInterval(() => { if (isPanelVisible()) { void refresh(); void refreshNative(); if (sharedDirty) void refreshShared() } }, 3000)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
  void readNativeSetting().then(() => { if (read(nativeEnabled)) void refreshNative() })
  void refresh()
  void refreshShared()
}
const labels = {
  en: {
    summary: 'Activity in this workspace', chatOn: 'Chat monitoring on', chatOff: 'Chat monitoring off', chatError: 'Chat activity unavailable',
    detected: 'Detected items', detectedHelp: 'Observed in tool calls, skill file paths and the shared runner. In use marks a running request or an ongoing agent turn.',
    skill: 'Skills', plugin: 'Plugins', mcp: 'MCP servers', none: 'No items detected yet',
    empty: 'An empty list does not mean an item was unused.', inUse: 'In use',
    agent: 'Agent activity', subagents: 'Subagents', subagent: 'Subagent', agentNone: 'No agent activity reported.', agentOff: 'Turn on chat activity in settings to see agent status.', unavailable: 'Could not load chat activity.',
    truncated: 'Only recent chat history is shown.', historyUnavailable: 'Recent chat history is unavailable.',
    toolCalls: 'Recent tool calls', nativeCalls: 'Native chats', sharedCalls: 'Shared runner', terminalCalls: 'Terminals', callInProgress: 'Running', callDone: 'Completed', callFailed: 'Failed', nativeChat: 'Chat', jevLookup: 'Jev lookup',
    toolNone: 'No tool calls observed yet.', noWorkspace: 'Open a workspace to see activity.',
    loading: 'Loading activity…', failed: 'Could not load tool calls.', retry: 'Retry',
    settings: 'Settings & privacy', setting: 'Show chat activity',
    privacy: 'When on, workspace status can include prompts, tool inputs and replies from all workspaces. On macOS, recent tool inputs in this workspace are also read.',
    privacyMore: 'How activity is read',
    privacyDetail: 'This chat monitor displays agent status and tool names. It does not store, log or send the chat inputs it inspects. Reads run while this panel is visible. Activity may be incomplete and short calls can be missed.',
    toolDetail: 'Finished marks the end of a terminal call. Ambiguous matches appear as uncertain.',
    working: 'Working', blocked: 'Blocked', waiting: 'Waiting', done: 'Done', unverifiable: 'Unverified',
    running: 'Awaiting finish', finished: 'Finished', uncertain: 'Uncertain'
  },
  ko: {
    summary: '현재 작업공간 활동', chatOn: '채팅 활동 켜짐', chatOff: '채팅 활동 꺼짐', chatError: '채팅 활동 오류',
    detected: '감지된 항목', detectedHelp: '도구 호출, 스킬 파일 경로, 공용 실행기에서 감지한 항목입니다. 현재 사용 중은 요청이나 에이전트 작업이 진행 중일 때 표시됩니다.',
    skill: '스킬', plugin: '플러그인', mcp: 'MCP 서버', none: '감지된 항목 없음',
    empty: '목록에 없어도 설치했거나 사용했을 수 있습니다.', inUse: '현재 사용 중',
    agent: '에이전트 활동', subagents: '서브에이전트', subagent: '서브에이전트', agentNone: '보고된 에이전트 활동이 없습니다.', agentOff: '설정에서 채팅 활동을 켜면 상태를 볼 수 있습니다.', unavailable: '채팅 활동을 불러오지 못했습니다.',
    truncated: '최근 채팅 기록 일부만 표시합니다.', historyUnavailable: '최근 채팅 기록을 불러올 수 없습니다.',
    toolCalls: '최근 도구 호출', nativeCalls: '네이티브 채팅', sharedCalls: '공용 실행기', terminalCalls: '터미널', callInProgress: '실행 중', callDone: '완료', callFailed: '실패', nativeChat: '채팅', jevLookup: 'Jev 조회',
    toolNone: '관측된 도구 호출이 없습니다.', noWorkspace: '작업공간을 열어 활동을 확인하세요.',
    loading: '활동을 불러오는 중…', failed: '도구 호출을 불러오지 못했습니다.', retry: '다시 시도',
    settings: '설정 및 개인정보', setting: '채팅 활동 표시',
    privacy: '켜면 모든 작업공간의 상태에 포함된 프롬프트·도구 입력·응답을 읽습니다. macOS에서는 현재 작업공간의 최근 도구 입력도 읽습니다.',
    privacyMore: '어떤 정보를 읽나요?',
    privacyDetail: '채팅 모니터는 에이전트 상태와 도구 이름을 표시합니다. 조회한 채팅 입력은 저장하거나 전송하지 않습니다. 패널이 보이는 동안 조회하며 짧은 활동은 놓칠 수 있습니다.',
    toolDetail: '터미널의 종료됨은 호출이 끝났다는 뜻입니다. 대응하는 호출이 모호하면 불확실로 표시합니다.',
    working: '작업 중', blocked: '차단됨', waiting: '대기 중', done: '완료', unverifiable: '확인 불가',
    running: '종료 대기', finished: '종료됨', uncertain: '불확실'
  }
} as const

// A direct lookup proves Jev was asked. Only the shared runner can attribute returned candidates.
function sourceLabel(provider: string, name: string, lookup: string) {
  return isJevLookup(name)
    ? provider + ' · ' + lookup : provider
}

function ActivityPanel() {
  const t = env.locale.toLowerCase().startsWith('ko') ? labels.ko : labels.en
  const items = read(calls)
  const snapshot = read(sharedActivity)
  const journalCalls = read(nativeTools)
  const nativeLookup = journalCalls.find(call => isJevLookup(call.name))
  const terminalLookup = items.find(call => isJevLookup(call.tool))
  const direct = nativeLookup ? { name: nativeLookup.name, provider: nativeLookup.agentType ?? t.nativeChat, at: nativeLookup.observedAt }
    : terminalLookup ? { name: terminalLookup.tool, provider: terminalLookup.agent } : undefined
  const runnerCalls = (snapshot?.events ?? []).filter(event => event.operation === 'call')
    .sort((a, b) => b.startedAt - a.startedAt).slice(0, 30)
  const recentCount = items.length + journalCalls.length + runnerCalls.length
  const resources = new Map<string, ResourceObservation>()
  const activeResources = [...read(terminalActiveResources), ...read(nativeActiveResources)]
  const activeKeys = new Set(activeResources.map((item) => `${item.category}:${item.name}`))
  for (const event of snapshot?.events ?? []) {
    if (!event.capabilityName || (event.operation !== 'call' && event.operation !== 'skill')) continue
    const key = event.kind + ':' + event.capabilityName
    resources.set(key, { category: event.kind, name: event.capabilityName, evidence: 'observed' })
    if (event.state === 'running') activeKeys.add(key)
  }
  for (const item of [...read(terminalResources), ...read(nativeResources), ...activeResources]) {
    const key = `${item.category}:${item.name}`
    const previous = resources.get(key)
    if (!previous) resources.set(key, item)
    else if (item.evidence === 'observed') resources.set(key, item)
  }
  const grouped = [
    { category: 'skill', title: t.skill },
    { category: 'mcp', title: t.mcp },
    { category: 'plugin', title: t.plugin }
  ] as const
  const stateNames = { working: t.working, blocked: t.blocked, waiting: t.waiting, done: t.done, unverifiable: t.unverifiable }
  const callNames = { running: t.running, finished: t.finished, uncertain: t.uncertain }
  const activities = read(nativeActivities)
  const mainAgents = activities.filter((activity) => activity.role !== 'subagent')
  const subagents = activities.filter((activity) => activity.role === 'subagent')
  const activityRow = (activity: typeof activities[number], index: number, isSubagent: boolean) => <Row key={`${isSubagent ? 'sub' : 'main'}:${index}`} justify="between" align="center" gap="sm" wrap>
    <Box minWidth={0} grow><Text size="sm" truncate>{(activity.label || activity.agentType || (isSubagent ? t.subagent : 'Agent')) + (activity.toolName ? ' · ' + activity.toolName : '')}</Text></Box>
    <Badge tone={activity.state === 'working' ? 'accent' : activity.state === 'blocked' ? 'warning' : 'neutral'}>{stateNames[activity.state]}</Badge>
  </Row>
  return <Box direction="column" gap="lg">
    <Stack gap="xs">
      <Row justify="between" align="center" gap="sm" wrap>
        <Heading level={2}>{t.summary}</Heading>
        <Badge tone={read(nativeStatus) === 'unavailable' ? 'danger' : read(nativeEnabled) ? 'accent' : 'neutral'}>{read(nativeStatus) === 'unavailable' ? t.chatError : read(nativeEnabled) ? t.chatOn : t.chatOff}</Badge>
      </Row>
    </Stack>

    <RecommendationActivity direct={direct} snapshot={snapshot} unavailable={read(sharedUnavailable)} />

    <Stack gap="sm">
      <Heading level={2}>{t.detected}</Heading>
      <Text muted size="xs">{t.detectedHelp}</Text>
      <Box direction="column" gap="md" padding="md" border radius="md" background="card">
        {grouped.map(({ category, title }) => {
          const found = [...resources.values()].filter((item) => item.category === category)
          return <Stack key={category} gap="xs">
            <Row justify="between" align="center" gap="sm">
              <Text size="sm" weight="semibold">{title}</Text>
              <Text size="xs" muted>{String(found.length)}</Text>
            </Row>
            {found.length === 0 ? <Text muted size="xs">{t.none}</Text> : found.map((resource) =>
              <Row key={`${resource.category}:${resource.name}`} align="center" justify="between" gap="sm" wrap>
                <Box minWidth={0} grow><Text size="sm" truncate>{resource.name}</Text></Box>
                {activeKeys.has(`${resource.category}:${resource.name}`) ? <Badge tone="accent">{t.inUse}</Badge> : null}
              </Row>)}
          </Stack>
        })}
      </Box>
      <Text muted size="xs">{t.empty}</Text>
    </Stack>

    <Stack gap="sm">
      <Heading level={2}>{t.agent}</Heading>
      {read(nativeStatus) === 'unavailable' ? <Text tone="danger">{t.unavailable}</Text> :
        !read(nativeEnabled) ? <Text muted size="sm">{t.agentOff}</Text> : activities.length === 0 ? <Text muted size="sm">{t.agentNone}</Text> :
        <Box direction="column" gap="sm" padding="md" border radius="md" background="card">
          {mainAgents.map((activity, i) => activityRow(activity, i, false))}
          {subagents.length > 0 ? <Stack gap="sm">
            {mainAgents.length > 0 ? <Separator /> : null}
            <Row justify="between" align="center" gap="sm"><Text size="sm" weight="semibold">{t.subagents}</Text><Text size="xs" muted>{String(subagents.length)}</Text></Row>
            {subagents.map((activity, i) => activityRow(activity, i, true))}
          </Stack> : null}
        </Box>}
      {read(journalStatus) === 'truncated' ? <Text muted size="xs">{t.truncated}</Text> : read(journalStatus) === 'unavailable' ? <Text muted size="xs">{t.historyUnavailable}</Text> : null}
    </Stack>

    {read(failed) ? <Row gap="sm" align="center" wrap><Text tone="danger">{t.failed}</Text><Button size="sm" onPress={refresh}>{t.retry}</Button></Row> : null}
    <Separator />
    <Collapsible title={`${t.toolCalls} · ${recentCount}`}>
      <Stack gap="sm">
        {recentCount === 0 ? <Text muted size="sm">{read(loading) ? t.loading : !read(workspace) ? t.noWorkspace : t.toolNone}</Text> : null}
        {journalCalls.length ? <Stack gap="xs">
          <Text size="sm" weight="semibold">{t.nativeCalls}</Text>
          {journalCalls.map(call => <Row key={call.id} justify="between" align="center" gap="sm" wrap>
            <Box direction="column" gap="xs" minWidth={0} grow><Text size="sm" truncate>{call.name}</Text><Text muted size="xs">{sourceLabel(call.agentType ?? t.nativeChat, call.name, t.jevLookup)}</Text></Box>
            <Badge tone={call.state === 'running' ? 'accent' : call.state === 'failed' ? 'danger' : 'neutral'}>{({ running: t.callInProgress, completed: t.callDone, failed: t.callFailed, unknown: t.unverifiable })[call.state]}</Badge>
          </Row>)}
        </Stack> : null}
        {runnerCalls.length ? <Stack gap="xs">
          <Text size="sm" weight="semibold">{t.sharedCalls}</Text>
          {runnerCalls.map(call => <Row key={call.id} justify="between" align="center" gap="sm" wrap>
            <Box minWidth={0} grow><Text size="sm" truncate>{call.name}</Text></Box>
            <Badge tone={call.state === 'running' ? 'accent' : call.state === 'failed' ? 'danger' : 'neutral'}>{({ running: t.callInProgress, succeeded: t.callDone, failed: t.callFailed })[call.state]}</Badge>
          </Row>)}
        </Stack> : null}
        {items.length ? <Stack gap="xs">
          <Text size="sm" weight="semibold">{t.terminalCalls}</Text>
          {items.map(call => <Row key={call.id} justify="between" align="center" gap="sm" wrap>
            <Box direction="column" gap="xs" minWidth={0} grow><Text size="sm" truncate>{call.tool}</Text><Text muted size="xs">{sourceLabel(call.agent, call.tool, t.jevLookup)}</Text></Box>
            <Badge tone={call.state === 'running' ? 'warning' : 'neutral'}>{callNames[call.state]}</Badge>
          </Row>)}
          <Text muted size="xs">{t.toolDetail}</Text>
        </Stack> : null}
      </Stack>
    </Collapsible>
    <Collapsible title={t.settings}>
      <Stack gap="sm">
        <Switch label={t.setting} checked={read(nativeEnabled)} onChange={changeNative} />
        <Text size="xs">{t.privacy}</Text>
        <Collapsible title={t.privacyMore}><Text muted size="xs">{t.privacyDetail}</Text></Collapsible>
      </Stack>
    </Collapsible>
  </Box>
}

export default function Panel() {
  const ko = env.locale.toLowerCase().startsWith('ko')
  return <Box direction="column" gap="md" padding="md">
    <Heading>Traffic Light</Heading>
    <Tabs label={ko ? 'Traffic Light 보기' : 'Traffic Light views'} value={read(tab)} onChange={async value => {
      set(tab, value)
      if (value === 'library' || value === 'structure') await openToolbox()
      if (value === 'activity') await Promise.all([refresh(), refreshNative(), refreshShared()])
    }}>
      <Tab value="activity" label={ko ? '활동' : 'Activity'} icon="activity"><ActivityPanel /></Tab>
      <Tab value="library" label={ko ? '공용 도구' : 'Library'} icon="blocks"><ToolboxPanel /></Tab>
      <Tab value="structure" label={ko ? '구조' : 'How it works'} icon="branch"><ArchitecturePanel /></Tab>
    </Tabs>
  </Box>
}
