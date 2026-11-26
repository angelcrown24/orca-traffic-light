import { atom, Badge, Box, Button, Collapsible, env, Heading, on, plugin, read, Row, Separator, set, settings, Stack, Switch, Tab, Tabs, Text, type PanelContext } from 'orca'
import { panelLanguage } from './panel-language'
import { RecentCalls } from './recent-calls'
import type { Call } from './protocol'
import type { ToolboxActivity } from './toolbox-types'
import { SessionWork, resetSessionWork, refreshSessionWork } from './session-work'
import type { ResourceObservation } from './resource-classifier'
import { ArchitecturePanel, ToolboxPanel, ToolboxReviewPanel, leaveToolboxTab, openToolbox, setupToolbox } from './toolbox-panel'

const tab = atom('traffic-light.tab', 'activity', { persist: 'workspace' })
const calls = atom<Call[]>([])
const terminalResources = atom<ResourceObservation[]>([])
const terminalActiveResources = atom<ResourceObservation[]>([])
const workspace = atom(false)
const loading = atom(true)
const resourcePage = atom(0)
const resourcePageSize = 8
const failed = atom(false)
const statusEnabled = atom(false)
const sharedActivity = atom<ToolboxActivity | null>(null)
const sharedUnavailable = atom(false)
let sharedRequestId = 0
let sharedDirty = true
let settingsReadId = 0
let requestId = 0
let isPanelVisible = () => false
const canReadSession = () => isPanelVisible() && read(statusEnabled)
async function refresh(): Promise<void> {
  if (!isPanelVisible()) return
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
async function readActivitySettings(initial = false): Promise<void> {
  const id = ++settingsReadId
  let enabled = false
  try { enabled = (await settings.get('nativeActivity')) === true }
  catch { /* A host without the setting cannot enable the optional roster. */ }
  if (id !== settingsReadId || (!initial && enabled === read(statusEnabled))) return
  set(statusEnabled, enabled)
  resetSessionWork()
  if (enabled) await refreshSessionWork(canReadSession)
}
async function changeActivitySetting(enabled: boolean) {
  await settings.set('nativeActivity', enabled)
  await readActivitySettings()
}
export function setup(ctx: PanelContext): void {
  isPanelVisible = () => read(ctx.visible) && read(tab) === 'activity'
  setupToolbox(ctx, tab)
  ctx.subscriptions.push({ dispose: () => { requestId++; sharedRequestId++; settingsReadId++; resetSessionWork(); isPanelVisible = () => false } })
  ctx.subscriptions.push(plugin.on('toolbox.changed', () => { void refreshShared() }))
  ctx.subscriptions.push(plugin.on('calls.changed', () => { void refresh(); void refreshSessionWork(canReadSession) }))
  let currentWorkspace: string | undefined
  ctx.subscriptions.push(on('workspace.changed', ({ context }) => {
    const switched = !context?.workspaceId || currentWorkspace !== context.workspaceId
    if (switched) set(resourcePage, 0)
    requestId++
    resetSessionWork()
    currentWorkspace = context?.workspaceId
    void refreshSessionWork(canReadSession)
    sharedRequestId++
    set(sharedActivity, null)
    set(sharedUnavailable, false)
    set(calls, [])
    set(terminalResources, [])
    set(terminalActiveResources, [])
    void refreshShared()
    void refresh()
  }))
  ctx.subscriptions.push(settings.onDidChange(({ key }) => {
    if (key === 'nativeActivity') void readActivitySettings()
  }))
  let wasVisible = read(ctx.visible)
  const timer = setInterval(() => {
    const visible = read(ctx.visible)
    if (visible && !wasVisible && read(tab) !== 'activity') void openToolbox()
    wasVisible = visible
    if (isPanelVisible()) { void refresh(); void refreshSessionWork(canReadSession); if (sharedDirty) void refreshShared() }
  }, 3000)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
  void readActivitySettings(true)
  void refresh()
  void refreshShared()
}
const labels = {
  en: {
    workspace: 'This workspace',
    detected: 'Skills, plugins & MCP', detectedHelp: 'Observed in tool calls, skill file paths and the shared runner. In use marks a running request in a terminal or the shared runner.',
    skill: 'Skill', plugin: 'Plugin', mcp: 'MCP server', none: 'No skills, MCP servers or plugins detected yet.', inUse: 'In use',
    previous: 'Previous items', next: 'Next items',
    failed: 'Could not load tool calls.', sharedError: 'Could not load shared runner activity.', retry: 'Retry',
    settings: 'Settings & privacy', setting: 'Show terminal agent status',
    privacy: 'Shows agent states in the focused workspace using Orca’s public API.',
    privacyMore: 'How activity is read',
    privacyDetail: 'Terminal hooks report tool names and can identify resources from their inputs. The panel keeps names and status only. Terminal status polling pauses when you leave Activity.',
  },
  ko: {
    workspace: '현재 작업공간',
    detected: '스킬 · 플러그인 · MCP', detectedHelp: '도구 호출, 스킬 파일 경로, 공용 실행기에서 감지한 항목입니다. 현재 사용 중은 도구 호출이나 공용 실행기 요청이 진행 중일 때 표시됩니다.',
    skill: '스킬', plugin: '플러그인', mcp: 'MCP 서버', none: '아직 감지된 스킬, MCP 서버, 플러그인이 없습니다.', inUse: '현재 사용 중',
    previous: '이전 항목', next: '다음 항목',
    failed: '도구 호출을 불러오지 못했습니다.', sharedError: '공용 실행기 활동을 불러오지 못했습니다.', retry: '다시 시도',
    settings: '설정 및 개인정보', setting: '터미널 에이전트 상태 표시',
    privacy: 'Orca 공식 API로 현재 작업공간의 터미널 에이전트 상태를 표시합니다.',
    privacyMore: '어떤 정보를 읽나요?',
    privacyDetail: '터미널 훅으로 도구 이름을 받고 입력에서 사용한 리소스를 식별합니다. 패널에는 이름과 상태를 남깁니다. 활동 탭을 벗어나면 터미널 상태 조회를 멈춥니다.',
  }
} as const

function ActivityPanel() {
  const t = labels[panelLanguage(env.locale)]
  const snapshot = read(sharedActivity)
  const resources = new Map<string, ResourceObservation>()
  const activeResources = read(terminalActiveResources)
  const activeKeys = new Set(activeResources.map((item) => `${item.category}:${item.name}`))
  const jevKeys = new Set<string>()
  for (const event of snapshot?.events ?? []) {
    if (!event.capabilityName || (event.operation !== 'call' && event.operation !== 'skill')) continue
    const key = event.kind + ':' + event.capabilityName
    resources.set(key, { category: event.kind, name: event.capabilityName, evidence: 'observed' })
    if (event.recommendationId) jevKeys.add(key)
    if (event.state === 'running') activeKeys.add(key)
  }
  for (const item of [...read(terminalResources), ...activeResources]) {
    const key = `${item.category}:${item.name}`
    const previous = resources.get(key)
    if (!previous) resources.set(key, item)
    else if (item.evidence === 'observed') resources.set(key, item)
  }
  const items = [...resources.entries()].map(([key, resource]) => ({
    key, ...resource, active: activeKeys.has(key), jev: jevKeys.has(key)
  })).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name) || a.category.localeCompare(b.category))
  const lastPage = Math.max(0, Math.ceil(items.length / resourcePageSize) - 1)
  const page = Math.min(read(resourcePage), lastPage)
  const start = page * resourcePageSize
  return <Box direction="column" gap="lg">
    <SessionWork locale={panelLanguage(env.locale)} enabled={read(statusEnabled)} />
    <Separator />
    <Stack gap="sm">
      <Row justify="between" align="center" gap="sm" wrap>
        <Heading level={2}>{t.detected}</Heading>
        <Text muted size="xs">{t.workspace}</Text>
      </Row>
      {items.length ? <Box direction="column" gap="sm" padding="sm" border radius="md" background="card">
        {items.slice(start, start + resourcePageSize).map(item =>
          <Row key={item.key} align="center" justify="between" gap="sm" wrap>
            <Box direction="column" minWidth={0} grow>
              <Text size="sm" weight={item.active ? 'semibold' : 'medium'} truncate>{item.name}</Text>
              <Text muted size="xs">{t[item.category]}</Text>
            </Box>
            {item.jev || item.active ? <Row gap="xs" align="center">
              {item.jev ? <Badge tone="neutral">Jev</Badge> : null}
              {item.active ? <Badge tone="accent">{t.inUse}</Badge> : null}
            </Row> : null}
          </Row>)}
        {lastPage > 0 ? <Row align="center" justify="between" gap="sm">
          <Button variant="ghost" size="sm" disabled={page === 0} onPress={() => set(resourcePage, page - 1)}>{t.previous}</Button>
          <Text muted size="xs">{String(page + 1) + ' / ' + String(lastPage + 1)}</Text>
          <Button variant="ghost" size="sm" disabled={page === lastPage} onPress={() => set(resourcePage, page + 1)}>{t.next}</Button>
        </Row> : null}
      </Box> : <Text muted size="sm">{t.none}</Text>}
    </Stack>

    {read(failed) || read(sharedUnavailable) ? <Row gap="sm" align="center" wrap>
      <Text tone="danger">{read(failed) ? t.failed : t.sharedError}</Text>
      <Button size="sm" onPress={read(failed) ? refresh : refreshShared}>{t.retry}</Button>
    </Row> : null}
    <Separator />
    <RecentCalls terminal={read(calls)} shared={snapshot?.events ?? []} workspace={read(workspace)} loading={read(loading)} />
    <Collapsible title={t.settings}>
      <Stack gap="sm">
        <Switch label={t.setting} checked={read(statusEnabled)} onChange={value => changeActivitySetting(value)} />
        <Text size="xs">{t.privacy}</Text>
        <Collapsible title={t.privacyMore}><Stack gap="sm">
          <Text muted size="xs">{t.detectedHelp}</Text>
          <Text muted size="xs">{t.privacyDetail}</Text>
        </Stack></Collapsible>
      </Stack>
    </Collapsible>
  </Box>
}

function selectTab(value: string) {
  if (read(tab) === value) return
  leaveToolboxTab(read(tab))
  resetSessionWork()
  set(tab, value)
}

export default function Panel() {
  const ko = panelLanguage(env.locale) === 'ko'
  return <Box direction="column" gap="md" paddingY="md">
    <Heading>Traffic Light</Heading>
    <Tabs label={ko ? 'Traffic Light 보기' : 'Traffic Light views'} value={read(tab)} onChange={async value => {
      selectTab(value)
      if (value !== 'activity') await openToolbox()
      if (value === 'activity') await Promise.all([refresh(), refreshShared(), refreshSessionWork(canReadSession)])
    }}>
      <Tab value="activity" label={ko ? '활동' : 'Activity'}><ActivityPanel /></Tab>
      <Tab value="library" label={ko ? '공용 도구' : 'Library'}><ToolboxPanel /></Tab>
      <Tab value="review" label={ko ? '스킬 점검' : 'Review'}>{read(tab) === 'review' ? <ToolboxReviewPanel onOpenLibrary={() => selectTab('library')} /> : null}</Tab>
      <Tab value="structure" label={ko ? '구조' : 'Map'}><ArchitecturePanel /></Tab>
    </Tabs>
  </Box>
}
