import { atom, Badge, Box, Button, Collapsible, env, Heading, on, plugin, read, Row, Separator, set, settings, Stack, Switch, Tab, Tabs, Text, type PanelContext } from 'orca'
import { panelLanguage } from './panel-language'
import { RecentCalls } from './recent-calls'
import type { Call } from './protocol'
import type { ToolboxActivity } from './toolbox-types'
import type { NativeToolCall } from './native-reader'
import { SessionWork, resetSessionWork, refreshSessionWork } from './session-work'
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
const antigravityChildEnabled = atom(false)
const nativeStatus = atom<'disabled' | 'ready' | 'unavailable'>('disabled')
const journalStatus = atom<'ready' | 'truncated' | 'unavailable' | undefined>(undefined)
const nativeTools = atom<NativeToolCall[]>([])
const sharedActivity = atom<ToolboxActivity | null>(null)
const sharedUnavailable = atom(false)
let sharedRequestId = 0
let sharedDirty = true
let nativeRequestId = 0
let settingsReadId = 0
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
  set(nativeTools, [])
  set(nativeResources, [])
  set(nativeActiveResources, [])
  set(journalStatus, undefined)
  set(nativeStatus, status)
}
async function readActivitySettings(initial = false): Promise<void> {
  const id = ++settingsReadId
  try {
    const [native, child] = await Promise.all([settings.get('nativeActivity'), settings.get('antigravityChildStatus')])
    if (id !== settingsReadId) return
    const enabled = native === true, showChild = child === true
    if (!initial && enabled === read(nativeEnabled) && showChild === read(antigravityChildEnabled)) return
    set(nativeEnabled, enabled)
    set(antigravityChildEnabled, showChild)
    resetSessionWork(false)
    if (enabled) await Promise.all([refreshNative(), refreshSessionWork(isPanelVisible)])
    else { clearNative('disabled'); await refreshSessionWork(isPanelVisible) }
  } catch {
    if (id !== settingsReadId) return
    set(nativeEnabled, false); set(antigravityChildEnabled, false); clearNative('unavailable')
  }
}
async function refreshNative(): Promise<void> {
  if (!read(nativeEnabled) || !isPanelVisible()) return
  const id = ++nativeRequestId
  try {
    const result = await plugin.request('native.get')
    if (id !== nativeRequestId || !read(nativeEnabled)) return
    set(nativeStatus, result.status)
    set(journalStatus, result.journalStatus)
    set(nativeTools, result.status === 'ready' ? result.recentTools ?? [] : [])
    set(nativeResources, result.resources ?? [])
    set(nativeActiveResources, result.status === 'ready' ? result.activeResources ?? [] : [])
  } catch {
    if (id !== nativeRequestId) return
    clearNative('unavailable')
  }
}
async function changeActivitySetting(key: 'nativeActivity' | 'antigravityChildStatus', enabled: boolean): Promise<void> {
  if (key === 'antigravityChildStatus' && !read(nativeEnabled)) return
  try {
    await settings.set(key, enabled)
    await readActivitySettings()
  } catch { clearNative('unavailable') }
}
export function setup(ctx: PanelContext): void {
  isPanelVisible = () => read(ctx.visible) && read(tab) === 'activity'
  setupToolbox(ctx, () => read(tab) === 'library' || read(tab) === 'structure')
  ctx.subscriptions.push({ dispose: () => { sharedRequestId++; settingsReadId++; nativeRequestId++; resetSessionWork(); isPanelVisible = () => false } })
  ctx.subscriptions.push(plugin.on('toolbox.changed', () => { void refreshShared() }))
  ctx.subscriptions.push(plugin.on('calls.changed', () => { void refresh() }))
  let currentWorkspace: string | undefined
  ctx.subscriptions.push(on('workspace.changed', ({ context }) => {
    resetSessionWork(!context?.workspaceId || currentWorkspace !== context.workspaceId)
    currentWorkspace = context?.workspaceId
    void refreshSessionWork(isPanelVisible)
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
  ctx.subscriptions.push(settings.onDidChange(({ key }) => {
    if (key === 'nativeActivity' || key === 'antigravityChildStatus') void readActivitySettings()
  }))
  const timer = setInterval(() => { if (isPanelVisible()) { void refresh(); void refreshNative(); void refreshSessionWork(isPanelVisible); if (sharedDirty) void refreshShared() } }, 3000)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
  void readActivitySettings(true)
  void refresh()
  void refreshShared()
}
const labels = {
  en: {
    summary: 'Activity in this workspace', chatOn: 'Chat monitoring on', chatOff: 'Chat monitoring off', chatError: 'Chat activity unavailable',
    detected: 'Detected items', detectedHelp: 'Observed in tool calls, skill file paths and the shared runner. In use marks a running request or an ongoing agent turn.',
    skill: 'Skills', plugin: 'Plugins', mcp: 'MCP servers', none: 'No items detected yet',
    empty: 'An empty list does not mean an item was unused.', inUse: 'In use',
    antigravityChildren: 'Show Antigravity subagent status',
    antigravityPrivacy: 'With chat activity enabled on macOS, matches the conversation ID to child agents, their status and update times in Antigravity’s local index. Excludes transcripts.',
    truncated: 'Only recent chat history is shown.', historyUnavailable: 'Recent chat history is unavailable.',
    failed: 'Could not load tool calls.', sharedError: 'Could not load shared runner activity.', retry: 'Retry',
    settings: 'Settings & privacy', setting: 'Show chat activity',
    privacy: 'When on, workspace status can include prompts, tool inputs and replies from all workspaces. On macOS, recent tool inputs in this workspace are also read.',
    privacyMore: 'How activity is read',
    privacyDetail: 'The session monitor follows the active tab from Orca’s local layout or a session you select. It shows tool and program names, connection status and running subagents. Command arguments and terminal output stay out of the panel. Monitoring pauses when you leave the Activity tab. Short calls can be missed.',
  },
  ko: {
    summary: '현재 작업공간 활동', chatOn: '채팅 활동 켜짐', chatOff: '채팅 활동 꺼짐', chatError: '채팅 활동 오류',
    detected: '감지된 항목', detectedHelp: '도구 호출, 스킬 파일 경로, 공용 실행기에서 감지한 항목입니다. 현재 사용 중은 요청이나 에이전트 작업이 진행 중일 때 표시됩니다.',
    skill: '스킬', plugin: '플러그인', mcp: 'MCP 서버', none: '감지된 항목 없음',
    empty: '목록에 없어도 설치했거나 사용했을 수 있습니다.', inUse: '현재 사용 중',
    antigravityChildren: 'Antigravity 서브에이전트 상태 표시',
    antigravityPrivacy: 'macOS에서 채팅 활동을 켜면 현재 대화 ID로 Antigravity의 로컬 색인에서 자식 에이전트 관계, 상태, 갱신 시각을 확인합니다. 대화 본문은 조회하지 않습니다.',
    truncated: '최근 채팅 기록 일부만 표시합니다.', historyUnavailable: '최근 채팅 기록을 불러올 수 없습니다.',
    failed: '도구 호출을 불러오지 못했습니다.', sharedError: '공용 실행기 활동을 불러오지 못했습니다.', retry: '다시 시도',
    settings: '설정 및 개인정보', setting: '채팅 활동 표시',
    privacy: '켜면 모든 작업공간의 상태에 포함된 프롬프트·도구 입력·응답을 읽습니다. macOS에서는 현재 작업공간의 최근 도구 입력도 읽습니다.',
    privacyMore: '어떤 정보를 읽나요?',
    privacyDetail: '세션 모니터는 Orca의 로컬 창 배치에서 현재 탭을 확인하거나 직접 선택한 세션을 조회합니다. 도구와 프로그램 이름, 연결 상태, 실행 중인 서브에이전트를 표시합니다. 명령 인수와 터미널 출력은 표시하지 않습니다. 활동 탭을 벗어나면 조회를 멈추며, 짧은 호출은 놓칠 수 있습니다.',
  }
} as const

function ActivityPanel() {
  const t = labels[panelLanguage(env.locale)]
  const snapshot = read(sharedActivity)
  const resources = new Map<string, ResourceObservation>()
  const activeResources = [...read(terminalActiveResources), ...read(nativeActiveResources)]
  const activeKeys = new Set(activeResources.map((item) => `${item.category}:${item.name}`))
  const jevKeys = new Set<string>()
  for (const event of snapshot?.events ?? []) {
    if (!event.capabilityName || (event.operation !== 'call' && event.operation !== 'skill')) continue
    const key = event.kind + ':' + event.capabilityName
    resources.set(key, { category: event.kind, name: event.capabilityName, evidence: 'observed' })
    if (event.recommendationId) jevKeys.add(key)
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
  const showAntigravityChildren = read(nativeEnabled) && read(antigravityChildEnabled)
  return <Box direction="column" gap="lg">
    <Stack gap="xs">
      <Row justify="between" align="center" gap="sm" wrap>
        <Heading level={2}>{t.summary}</Heading>
        <Badge tone={read(nativeStatus) === 'unavailable' ? 'danger' : read(nativeEnabled) ? 'accent' : 'neutral'}>{read(nativeStatus) === 'unavailable' ? t.chatError : read(nativeEnabled) ? t.chatOn : t.chatOff}</Badge>
      </Row>
    </Stack>

    <SessionWork locale={panelLanguage(env.locale)} visible={isPanelVisible} nativeEnabled={read(nativeEnabled)} providerEnabled={showAntigravityChildren} />
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
                {jevKeys.has(`${resource.category}:${resource.name}`) ? <Badge tone="neutral">Jev</Badge> : null}
                {activeKeys.has(`${resource.category}:${resource.name}`) ? <Badge tone="accent">{t.inUse}</Badge> : null}
              </Row>)}
          </Stack>
        })}
      </Box>
      <Text muted size="xs">{t.empty}</Text>
    </Stack>

    {read(failed) || read(sharedUnavailable) ? <Row gap="sm" align="center" wrap>
      <Text tone="danger">{read(failed) ? t.failed : t.sharedError}</Text>
      <Button size="sm" onPress={read(failed) ? refresh : refreshShared}>{t.retry}</Button>
    </Row> : null}
    <Separator />
    <RecentCalls terminal={read(calls)} native={read(nativeTools)} shared={snapshot?.events ?? []} workspace={read(workspace)} loading={read(loading)} />
    {read(journalStatus) === 'truncated' ? <Text muted size="xs">{t.truncated}</Text> : read(journalStatus) === 'unavailable' ? <Text muted size="xs">{t.historyUnavailable}</Text> : null}
    <Collapsible title={t.settings}>
      <Stack gap="sm">
        <Switch label={t.setting} checked={read(nativeEnabled)} onChange={value => changeActivitySetting('nativeActivity', value)} />
        <Text size="xs">{t.privacy}</Text>
        <Switch label={t.antigravityChildren} checked={showAntigravityChildren} disabled={!read(nativeEnabled)} onChange={value => changeActivitySetting('antigravityChildStatus', value)} />
        <Text size="xs">{t.antigravityPrivacy}</Text>
        <Collapsible title={t.privacyMore}><Text muted size="xs">{t.privacyDetail}</Text></Collapsible>
      </Stack>
    </Collapsible>
  </Box>
}

export default function Panel() {
  const ko = panelLanguage(env.locale) === 'ko'
  return <Box direction="column" gap="md" padding="md">
    <Heading>Traffic Light</Heading>
    <Tabs label={ko ? 'Traffic Light 보기' : 'Traffic Light views'} value={read(tab)} onChange={async value => {
      if (value !== read(tab)) resetSessionWork(false)
      set(tab, value)
      if (value === 'library' || value === 'structure') await openToolbox()
      if (value === 'activity') await Promise.all([refresh(), refreshNative(), refreshShared(), refreshSessionWork(isPanelVisible)])
    }}>
      <Tab value="activity" label={ko ? '활동' : 'Activity'} icon="activity"><ActivityPanel /></Tab>
      <Tab value="library" label={ko ? '공용 도구' : 'Library'} icon="blocks"><ToolboxPanel /></Tab>
      <Tab value="structure" label={ko ? '구조' : 'How it works'} icon="branch"><ArchitecturePanel /></Tab>
    </Tabs>
  </Box>
}
