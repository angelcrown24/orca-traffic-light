import { atom, Badge, Box, Button, Collapsible, env, Heading, on, plugin, read, Row, Separator, set, settings, Stack, Switch, Tab, Tabs, Text, type PanelContext } from 'orca'
import type { Call } from './protocol'
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
async function readNativeSetting(): Promise<void> {
  try { set(nativeEnabled, (await settings.get('nativeActivity')) === true) }
  catch { set(nativeEnabled, false); set(nativeActiveResources, []); set(nativeStatus, 'unavailable') }
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
    set(nativeResources, result.resources ?? [])
    set(nativeActiveResources, result.status === 'ready' ? result.activeResources ?? [] : [])
  } catch {
    if (id !== nativeRequestId) return
    set(nativeActivities, [])
    set(nativeResources, [])
    set(nativeActiveResources, [])
    set(journalStatus, undefined)
    set(nativeStatus, 'unavailable')
  }
}
async function changeNative(enabled: boolean): Promise<void> {
  try {
    await settings.set('nativeActivity', enabled)
    set(nativeEnabled, enabled)
    nativeRequestId++
    set(nativeActivities, [])
    set(nativeResources, [])
    set(nativeActiveResources, [])
    set(journalStatus, undefined)
    set(nativeStatus, 'disabled')
    if (enabled) await refreshNative()
  } catch { set(nativeEnabled, false); set(nativeActiveResources, []); set(nativeStatus, 'unavailable') }
}
export function setup(ctx: PanelContext): void {
  isPanelVisible = () => read(ctx.visible) && read(tab) === 'activity'
  setupToolbox(ctx, () => read(tab) === 'library')
  ctx.subscriptions.push({ dispose: () => { isPanelVisible = () => false } })
  ctx.subscriptions.push(plugin.on('calls.changed', () => { void refresh() }))
  ctx.subscriptions.push(on('workspace.changed', () => { set(calls, []); set(terminalResources, []); set(terminalActiveResources, []); nativeRequestId++; set(nativeActivities, []); set(nativeResources, []); set(nativeActiveResources, []); set(journalStatus, undefined); void refresh(); void refreshNative() }))
  ctx.subscriptions.push(settings.onDidChange(() => { void readNativeSetting().then(() => { if (!read(nativeEnabled)) { nativeRequestId++; set(nativeActivities, []); set(nativeResources, []); set(nativeActiveResources, []); set(journalStatus, undefined); set(nativeStatus, 'disabled') } }) }))
  const timer = setInterval(() => { if (isPanelVisible()) { void refresh(); void refreshNative() } }, 3000)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
  void readNativeSetting().then(() => { if (read(nativeEnabled)) void refreshNative() })
  void refresh()
}
const labels = {
  en: {
    summary: 'Activity in this workspace', chatOn: 'Chat monitoring on', chatOff: 'Chat monitoring off', chatError: 'Chat activity unavailable',
    detected: 'Detected items', detectedHelp: 'Names found in tool calls and skill file paths. In use marks activity detected during an ongoing agent turn.',
    skill: 'Skills', plugin: 'Plugins', mcp: 'MCP servers', none: 'No items detected yet',
    empty: 'An empty list does not mean an item was unused.', inUse: 'In use',
    agent: 'Agent activity', subagents: 'Subagents', subagent: 'Subagent', agentNone: 'No agent activity reported.', agentOff: 'Turn on chat activity in settings to see agent status.', unavailable: 'Could not load chat activity.',
    truncated: 'Only recent chat history is shown.', historyUnavailable: 'Recent chat history is unavailable.',
    toolCalls: 'Recent tool calls', toolHelp: 'Local terminal calls observed since the plugin started.',
    toolNone: 'No terminal calls observed yet.', noWorkspace: 'Open a workspace to see activity.',
    loading: 'Loading activity…', failed: 'Could not load tool calls.', retry: 'Retry',
    settings: 'Settings & privacy', setting: 'Show chat activity',
    privacy: 'When on, workspace status can include prompts, tool inputs and replies from all workspaces. On macOS, recent tool inputs in this workspace are also read.',
    privacyMore: 'How activity is read',
    privacyDetail: 'Only agent status, tool and detected names are displayed. Inputs and conversation data are not saved, logged or sent by this plugin. Reads run while this panel is visible. Activity may be incomplete and short calls can be missed.',
    toolDetail: 'Finished means the call ended, not that it succeeded. Calls without IDs are matched by inference; ambiguous calls are uncertain. Calls without a terminal ID are omitted.',
    working: 'Working', blocked: 'Blocked', waiting: 'Waiting', done: 'Done', unverifiable: 'Unverified',
    running: 'Awaiting finish', finished: 'Finished', uncertain: 'Uncertain'
  },
  ko: {
    summary: '현재 작업공간 활동', chatOn: '채팅 활동 켜짐', chatOff: '채팅 활동 꺼짐', chatError: '채팅 활동 오류',
    detected: '감지된 항목', detectedHelp: '도구 호출과 스킬 파일 경로에서 찾은 이름입니다. 현재 사용 중은 진행 중인 에이전트 작업에서 감지된 항목입니다.',
    skill: '스킬', plugin: '플러그인', mcp: 'MCP 서버', none: '감지된 항목 없음',
    empty: '목록에 없어도 설치했거나 사용했을 수 있습니다.', inUse: '현재 사용 중',
    agent: '에이전트 활동', subagents: '서브에이전트', subagent: '서브에이전트', agentNone: '보고된 에이전트 활동이 없습니다.', agentOff: '설정에서 채팅 활동을 켜면 상태를 볼 수 있습니다.', unavailable: '채팅 활동을 불러오지 못했습니다.',
    truncated: '최근 채팅 기록 일부만 표시합니다.', historyUnavailable: '최근 채팅 기록을 불러올 수 없습니다.',
    toolCalls: '최근 도구 호출', toolHelp: '플러그인 실행 중 관측한 로컬 터미널 호출입니다.',
    toolNone: '관측된 터미널 호출이 없습니다.', noWorkspace: '작업공간을 열어 활동을 확인하세요.',
    loading: '활동을 불러오는 중…', failed: '도구 호출을 불러오지 못했습니다.', retry: '다시 시도',
    settings: '설정 및 개인정보', setting: '채팅 활동 표시',
    privacy: '켜면 모든 작업공간의 상태에 포함된 프롬프트·도구 입력·응답을 읽습니다. macOS에서는 현재 작업공간의 최근 도구 입력도 읽습니다.',
    privacyMore: '어떤 정보를 읽나요?',
    privacyDetail: '화면에는 에이전트 상태, 도구 및 감지된 이름만 표시합니다. 입력과 대화 내용은 이 플러그인이 저장·기록·전송하지 않습니다. 패널이 보이는 동안 조회하며 짧은 활동은 놓칠 수 있습니다.',
    toolDetail: '완료는 호출 종료를 뜻하며 성공 여부는 알 수 없습니다. 호출 ID가 없으면 추정해 연결하고, 모호한 경우 불확실로 표시합니다. 터미널 ID가 없는 호출은 제외합니다.',
    working: '작업 중', blocked: '차단됨', waiting: '대기 중', done: '완료', unverifiable: '확인 불가',
    running: '종료 대기', finished: '종료됨', uncertain: '불확실'
  }
} as const

function ActivityPanel() {
  const t = env.locale.toLowerCase().startsWith('ko') ? labels.ko : labels.en
  const items = read(calls)
  const resources = new Map<string, ResourceObservation>()
  const activeResources = [...read(terminalActiveResources), ...read(nativeActiveResources)]
  const activeKeys = new Set(activeResources.map((item) => `${item.category}:${item.name}`))
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
    <Collapsible title={`${t.toolCalls} · ${items.length}`}>
      <Stack gap="sm">
        <Text muted size="xs">{t.toolHelp}</Text>
        {read(loading) ? <Text>{t.loading}</Text> : read(failed) ? null : !read(workspace) ? <Text>{t.noWorkspace}</Text> : items.length === 0 ? <Text muted size="sm">{t.toolNone}</Text> :
          items.map((call) => <Row key={call.id} justify="between" align="center" gap="sm" wrap>
            <Box direction="column" gap="xs" minWidth={0} grow><Text size="sm" truncate>{call.tool}</Text><Text muted size="xs">{call.agent}</Text></Box>
            <Badge tone={call.state === 'running' ? 'warning' : 'neutral'}>{callNames[call.state]}</Badge>
          </Row>)}
        <Text muted size="xs">{t.toolDetail}</Text>
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
      if (value === 'library') await openToolbox()
      if (value === 'activity') { await refresh(); await refreshNative() }
    }}>
      <Tab value="activity" label={ko ? '활동' : 'Activity'} icon="activity"><ActivityPanel /></Tab>
      <Tab value="library" label={ko ? '공용 도구' : 'Library'} icon="blocks"><ToolboxPanel /></Tab>
      <Tab value="structure" label={ko ? '구조' : 'How it works'} icon="branch"><ArchitecturePanel /></Tab>
    </Tabs>
  </Box>
}
