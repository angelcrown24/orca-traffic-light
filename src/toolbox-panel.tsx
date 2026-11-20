import { atom, Badge, Box, Button, Callout, Checkbox, CodeView, Collapsible, EmptyState, env, Heading, IconButton, Input, on, plugin, read, RelativeTime, Row, Separator, set, Stack, Switch, Text, type Atom, type PanelContext } from 'orca'
import { englishCount, panelLanguage } from './panel-language'
import { clearAdaptation, limitationLabel, ProviderAdaptation } from './provider-adaptation'
import type { CatalogItem, SyncResult, ToolboxCatalog, ToolboxState } from './toolbox-types'
import './protocol'
import { applyingSkillChange } from './skill-maintenance'
import { SkillReview, checkSkills, resetSkillReview } from './skill-review'
import type { SkillReviewFinding } from './toolbox-types'
import { ArchitectureDiagram } from './toolbox-architecture'
import { alreadyShared, closeImportDetails, resetImportReviews, openImportDetails, ImportRow, isShared, needsImport, sectionTitle, sortImports, sourceGroups, type SourceGroup } from './toolbox-import'

const catalog = atom<ToolboxCatalog>({ items: [], warnings: [] })
const state = atom<ToolboxState>({ workspaceId: null, selected: [], bundle: null, events: [] })
const loaded = atom(false)
const loading = atom(false)
const busy = atom(false)
const failure = atom<'load' | 'state' | 'save' | 'automation' | 'sync' | ''>('')
const syncResults = atom<SyncResult[]>([])
const query = atom('')
const reviewedGroup = atom<string | null>(null)
const kind = atom('all')
const selectedOnly = atom(false)
const libraryMode = atom<'store' | 'import' | 'review'>('traffic-light.library-view', 'store', { persist: 'workspace' })
const receipts = atom<SourceGroup[]>([])
const page = atom(0)
const expandedItem = atom<string | null>(null)
const settingsOpen = atom<boolean | null>(null)
const manualOpen = atom('traffic-light.manual-open', false, { persist: 'workspace' })
const copyStatus = atom<'idle' | 'copying' | 'copied' | 'failed'>('idle')
let epoch = 0
let stateRead = 0
let reviewVisit = 0
let reviewedUpdate: { workspaceId: string; itemId: string; stamp: string } | null = null
let canRead = () => false
let canReview = () => false

const copy = {
  en: {
    autoTitle: 'New sessions', autoToggle: 'Connect automatically in new sessions', autoHelp: 'Apply this selection to new supported agent sessions. Existing conversations keep their previous configuration.', autoStop: 'Turning this off closes shared tool connections in this workspace. Conversations remain open.', autoOn: 'Enabled', autoOff: 'Off', apply: 'Apply selection', pending: 'Selection has unapplied changes.', autoError: 'Could not apply automatic connection settings.', providerStatus: 'Connection setup', bridgeReady: 'Bridge installed', bridgeMissing: 'Not set up', sessionCount: 'Connected sessions', manual: 'Manual connection', manualHelp: 'For an agent without the automatic bridge, prepare a guide and paste it into one conversation.', shared: 'Shared', providerOnly: 'Provider source', update: 'Update available', conflict: 'Conflict', sync: 'Add to shared store', syncUpdate: 'Update shared copy', syncSelected: 'Sync selected', syncHelp: 'Only the selected supported items are copied into the shared store. Existing conflicts are not overwritten.', syncError: 'Could not sync this selection.', syncResults: 'Sync results', synced: 'Synced', unchanged: 'Up to date', syncFailed: 'Failed', legend: 'MCP counts servers. The same item can appear under more than one provider.', totals: 'Counts group sources with the same name and type. One capability can appear under several providers.', structureRefresh: 'Refresh counts',
    connect: 'Connect', applied: 'Applied', settings: 'Connection settings', allShort: 'All', selectedShort: 'Selected', sharingShort: 'To share', detailsFor: 'Details',
    idle: 'On demand', skill: 'Skill', skills: 'Skills', mcp: 'MCP servers', selected: 'Selected', search: 'Search capabilities', searchPlaceholder: 'Name, purpose or provider…',
    filter: 'Show', all: 'All types', selectedOnly: 'Selected only', needsSharing: 'Needs sharing or update', refresh: 'Refresh library', clear: 'Clear selection',
    loading: 'Reading local capability metadata…', empty: 'No capabilities found', emptyHelp: 'Install skills or MCP tools locally, then refresh this library.', noMatch: 'No matching capabilities', noMatchHelp: 'Try another search or show all types.',
    unavailable: 'Unavailable', details: 'Details', foundIn: 'Found in', source: 'Source', noDescription: 'No description supplied.',
    noWorkspace: 'Open a workspace to prepare a selection for your task.', choose: 'Choose at least one capability to continue.',
    prepare: 'Prepare use instructions', preparing: 'Preparing…', loadError: 'Could not read the library. Your existing setup is unchanged.', saveError: 'Could not update this selection. Refresh and try again.', retry: 'Try again',
    selectionHelp: 'Nothing starts when you select it. Server tools and skill instructions are loaded only when requested.',
    ready: 'Instructions ready', readyHelp: 'Copy this guide into one agent conversation. Reusing it shares server state. The agent calls the runner through its shell tool.',
    instructionLabel: 'Guide to paste into your agent', revoke: 'Revoke these instructions', revokeHelp: 'Revoking stops running tool requests and further calls through this bundle. Clearing your selection does not revoke it.',
    bundleItems: 'Prepared capabilities', newSelection: 'Revoke the existing instructions before preparing a new selection.', limit: 'Up to 24 capabilities per selection.', connection: 'Connection lifetime', connectionHelp: 'After 15 minutes without use, tool connections close. Explicitly reconnect before calling again; server-side working state may not be restored.',
    logs: 'Shared runner activity', logEmpty: 'No calls through these instructions yet.', running: 'Running', succeeded: 'Completed', failed: 'Failed', readSkill: 'Read skill', toolCall: 'MCP call',
    metadata: 'The library displays names and descriptions, without sending it to your model or starting MCP servers. Provider labels identify where settings were found; MCP connections are checked only when requested.',
    warnings: 'Discovery notes', more: 'Next', previous: 'Previous', count: 'results', copyGuide: 'Copy instructions', copying: 'Copying…', copied: 'Copied', copyFailed: 'Could not copy automatically. Select the guide text below and copy it manually.',
    structureTitle: 'Capability flow', structureHelp: 'The same selected capabilities can be used by agents that can run local shell commands.',
    connectionDetails: 'How connection works',
    tokenHelp: 'Names, instructions and tool results still use tokens when sent to a model. The shared runner loads capability contents only when requested.',
    nativeHelp: 'Provider-only built-in tools and private plugins are not converted into shared tools.',
  },
  ko: {
    autoTitle: '새 대화 연결', autoToggle: '새 세션에 자동 연결', autoHelp: '선택한 구성을 지원되는 새 에이전트 세션에 적용합니다. 기존 대화는 이전 구성을 유지합니다.', autoStop: '끄면 이 작업공간의 공용 도구 연결이 종료됩니다. 대화는 유지됩니다.', autoOn: '켜짐', autoOff: '꺼짐', apply: '선택 적용', pending: '아직 적용하지 않은 선택이 있습니다.', autoError: '자동 연결 설정을 적용하지 못했습니다.', providerStatus: '연결 준비 상태', bridgeReady: '연결 지침 설치됨', bridgeMissing: '설정되지 않음', sessionCount: '연결된 세션', manual: '수동 연결', manualHelp: '자동 연결을 지원하지 않는 에이전트에는 사용 안내를 만들어 대화 하나에 전달할 수 있습니다.', shared: '공용', providerOnly: '제공자 원본', update: '업데이트 있음', conflict: '충돌', sync: '공용으로 모으기', syncUpdate: '공용본 업데이트', syncSelected: '선택 항목 동기화', syncHelp: '선택한 지원 항목만 공용 저장소에 복사합니다. 충돌한 기존 항목은 덮어쓰지 않습니다.', syncError: '선택한 항목을 동기화하지 못했습니다.', syncResults: '동기화 결과', synced: '동기화됨', unchanged: '최신 상태', syncFailed: '실패', legend: 'MCP는 서버 수입니다. 같은 항목이 여러 제공자에 중복 표시될 수 있습니다.', totals: '이름과 종류가 같은 원본은 하나로 셉니다. 한 항목이 여러 제공자에 표시될 수 있습니다.', structureRefresh: '개수 새로고침',
    connect: '연결', applied: '적용됨', settings: '연결 설정', allShort: '전체', selectedShort: '선택', sharingShort: '공용화 필요', detailsFor: '상세 정보',
    idle: '필요할 때만', skill: '스킬', skills: '스킬', mcp: 'MCP 서버', selected: '선택됨', search: '기능 검색', searchPlaceholder: '이름, 용도, 제공자 검색…',
    filter: '표시 종류', all: '모든 종류', selectedOnly: '선택만', needsSharing: '공용화 필요한 항목만', refresh: '목록 새로고침', clear: '선택 비우기',
    loading: '설치된 기능의 정보를 읽는 중…', empty: '찾은 기능이 없습니다', emptyHelp: '로컬에 스킬이나 MCP 도구를 설치한 뒤 목록을 새로고침하세요.', noMatch: '검색 결과가 없습니다', noMatchHelp: '검색어를 바꾸거나 모든 종류를 표시해 보세요.',
    unavailable: '사용 불가', details: '자세히', foundIn: '발견 위치', source: '출처', noDescription: '등록된 설명이 없습니다.',
    noWorkspace: '작업공간을 열면 이 작업에 사용할 기능을 선택할 수 있습니다.', choose: '사용할 기능을 하나 이상 선택하세요.',
    prepare: '사용 안내 만들기', preparing: '준비 중…', loadError: '목록을 읽지 못했습니다. 기존 설정은 변경되지 않았습니다.', saveError: '선택을 반영하지 못했습니다. 새로고침 후 다시 시도하세요.', retry: '다시 시도',
    selectionHelp: '선택만으로 실행되지 않습니다. 도구 목록과 스킬 본문은 에이전트가 요청할 때 불러옵니다.',
    ready: '사용 안내 준비됨', readyHelp: '아래 안내를 사용할 대화 하나에 복사해 주세요. 같은 안내를 여러 대화에 쓰면 서버 상태도 공유됩니다. 에이전트는 셸 도구로 호출합니다.',
    instructionLabel: '에이전트 대화에 붙여 넣을 안내', revoke: '이 안내의 사용 해제', revokeHelp: '해제하면 진행 중인 도구 요청과 이후 호출이 중단됩니다. 선택 비우기는 사용 해제와 별개입니다.',
    bundleItems: '준비된 기능', newSelection: '새 구성을 만들려면 기존 안내의 사용을 먼저 해제하세요.', limit: '한 구성에는 최대 24개 기능을 선택할 수 있습니다.', connection: '연결 유지 방식', connectionHelp: '15분 동안 사용하지 않으면 도구 연결이 닫힙니다. 다시 호출하기 전에 명시적으로 재연결해야 하며, 서버 내부 작업 상태는 복원되지 않을 수 있습니다.',
    logs: '공통 실행기 활동', logEmpty: '이 안내로 호출한 기록이 없습니다.', running: '실행 중', succeeded: '완료', failed: '실패', readSkill: '스킬 읽기', toolCall: 'MCP 호출',
    metadata: '목록에는 이름과 설명만 표시합니다. 전체 기능을 모델에 전달하거나 MCP 서버를 시작하지 않습니다. 제공자 표시는 설정을 찾은 위치이며, MCP 연결은 실제 요청할 때 확인합니다.',
    warnings: '목록 확인 사항', more: '다음', previous: '이전', count: '개', copyGuide: '안내 복사', copying: '복사 중…', copied: '복사됨', copyFailed: '자동 복사를 하지 못했습니다. 아래 안내를 직접 선택해 복사해 주세요.',
    structureTitle: '도구·스킬 연결 구조', structureHelp: '로컬 셸 명령을 실행할 수 있는 에이전트라면 같은 구성을 사용할 수 있습니다.',
    connectionDetails: '연결 방식',
    tokenHelp: '모델에 전달하는 이름·안내·도구 결과는 토큰을 사용합니다. 공용 실행기는 요청한 기능의 본문만 불러옵니다.',
    nativeHelp: '제공자 전용 내장 도구와 비공개 플러그인을 공용 도구로 변환하지는 않습니다.',
  }
} as const
const text = () => copy[panelLanguage(env.locale)]

export async function openToolbox(force = false): Promise<void> {
  if (!canRead() || (force && read(busy))) return
  if (!force && read(loaded)) {
    await refreshState()
    if (canReview()) await checkSkills(read(state).workspaceId)
    return
  }
  const request = ++epoch
  reviewedUpdate = null
  set(loading, true); set(failure, ''); set(page, 0); set(copyStatus, 'idle'); set(receipts, []); set(syncResults, []); resetImportReviews()
  try {
    const [library, selection] = await Promise.all([plugin.request('toolbox.catalog'), plugin.request('toolbox.state')])
    if (request !== epoch) return
    set(catalog, library); set(state, selection); set(loaded, true)
  } catch { if (request === epoch) set(failure, 'load') }
  finally { if (request === epoch) set(loading, false) }
  if (request === epoch && !read(failure) && canReview()) await checkSkills(read(state).workspaceId, force)
}
async function refreshState(): Promise<void> {
  if (read(busy) || read(loading)) return
  const request = ++stateRead, generation = epoch
  try {
    const selection = await plugin.request('toolbox.state')
    if (request === stateRead && generation === epoch) {
      set(state, selection)
      if (read(failure) === 'state') set(failure, '')
    }
  } catch { if (request === stateRead && generation === epoch) set(failure, 'state') }
}
export function leaveToolboxTab(tab: string) {
  if (tab === 'library') reviewedUpdate = null
  if (tab === 'review') { reviewVisit++; resetSkillReview() }
}
export function setupToolbox(ctx: PanelContext, tab: Atom<string>): void {
  function migrateReviewTab() {
    if (read(libraryMode) !== 'review') return
    if (read(tab) === 'library') set(tab, 'review')
    set(libraryMode, 'store')
  }
  migrateReviewTab()
  canRead = () => read(ctx.visible) && ['library', 'review', 'structure'].includes(read(tab))
  canReview = () => read(ctx.visible) && read(tab) === 'review'
  ctx.subscriptions.push(plugin.on('toolbox.skillsChanged', () => {
    set(loaded, false)
    if (canRead() && !applyingSkillChange() && !read(loading)) void openToolbox(true)
  }))
  ctx.subscriptions.push(plugin.on('toolbox.changed', () => { if (canRead()) void refreshState() }))
  ctx.subscriptions.push(on('workspace.changed', ({ context }) => {
    migrateReviewTab()
    if (context?.workspaceId && context.workspaceId === read(state).workspaceId) return
    epoch++
    reviewedUpdate = null
    resetSkillReview()
    set(loaded, false); set(catalog, { items: [], warnings: [] }); set(reviewedGroup, null)
    set(state, { workspaceId: null, selected: [], bundle: null, events: [] })
    set(busy, false); set(loading, false); set(failure, ''); set(copyStatus, 'idle'); set(syncResults, []); set(query, ''); set(selectedOnly, false); set(kind, 'all'); set(receipts, []); resetImportReviews(); set(page, 0); set(expandedItem, null); set(settingsOpen, null)
    if (canRead()) void openToolbox()
  }))
  ctx.subscriptions.push({ dispose: () => { epoch++; reviewedUpdate = null; canRead = () => false; canReview = () => false; resetSkillReview() } })
  if (canRead()) void openToolbox()
}
function LoadFailure() {
  const t = text()
  const message = read(failure) === 'state'
    ? (t === copy.ko ? '이 작업공간의 연결 상태를 읽지 못했습니다.' : 'Could not read this workspace’s connection status.')
    : t.loadError
  return <Callout tone="danger"><Stack gap="xs"><Text size="sm">{message}</Text><Button size="sm" variant="ghost" onPress={() => openToolbox(true)} disabled={read(busy) || read(loading)}>{t.retry}</Button></Stack></Callout>
}
async function changeSelection(ids: string[]): Promise<void> {
  const workspaceId = read(state).workspaceId
  if (!workspaceId || read(busy) || read(loading)) return
  const request = ++epoch
  set(busy, true); set(failure, ''); set(copyStatus, 'idle')
  try {
    const next = await plugin.request('toolbox.select', { ids, workspaceId })
    if (request === epoch) set(state, next)
  } catch { if (request === epoch) set(failure, 'save') }
  finally { if (request === epoch) set(busy, false) }
}
async function bundleAction(action: 'prepare' | 'revoke'): Promise<void> {
  const workspaceId = read(state).workspaceId
  if (!workspaceId || read(busy) || read(loading)) return
  const request = ++epoch
  set(busy, true); set(failure, ''); set(copyStatus, 'idle')
  try {
    const next = action === 'prepare'
      ? await plugin.request('toolbox.prepare', { workspaceId })
      : await plugin.request('toolbox.revoke', { workspaceId, bundleId: read(state).bundle?.id ?? '' })
    if (request === epoch) set(state, next)
  } catch { if (request === epoch) set(failure, 'save') }
  finally { if (request === epoch) set(busy, false) }
}
async function copyInstructions(): Promise<void> {
  const current = read(state)
  if (!current.workspaceId || !current.bundle || read(copyStatus) === 'copying') return
  const request = epoch
  set(copyStatus, 'copying')
  try {
    const result = await plugin.request('toolbox.copy', { workspaceId: current.workspaceId, bundleId: current.bundle.id })
    if (request === epoch) set(copyStatus, result.copied ? 'copied' : 'failed')
  } catch { if (request === epoch) set(copyStatus, 'failed') }
}
async function changeAutomation(enabled: boolean): Promise<void> {
  const current = read(state)
  if (!current.workspaceId || read(busy) || read(loading)) return
  const request = ++epoch
  set(busy, true); set(failure, ''); set(copyStatus, 'idle')
  try {
    const next = await plugin.request('toolbox.automation', { workspaceId: current.workspaceId, enabled })
    if (request === epoch) set(state, next)
  } catch {
    if (request === epoch) {
      set(failure, 'automation')
      try { const next = await plugin.request('toolbox.state'); if (request === epoch) set(state, next) } catch { /* Keep the last known setup state. */ }
    }
  }
  finally { if (request === epoch) set(busy, false) }
}
async function importSource(group: SourceGroup, id: string): Promise<void> {
  const current = read(state)
  if (!current.workspaceId || read(busy) || read(loading) || !group.items.some(item => item.id === id && item.available && !item.providerOnly && item.sharing?.canSync)) return
  const request = ++epoch
  set(busy, true); set(failure, ''); set(syncResults, []); set(copyStatus, 'idle')
  try {
    const stamp = reviewedUpdate?.workspaceId === current.workspaceId && reviewedUpdate.itemId === id ? reviewedUpdate.stamp : undefined
    const result = await plugin.request('toolbox.sync', { workspaceId: current.workspaceId, ids: [id], preserveProviderCopies: true,
      ...(stamp ? { reviewedSourceStamp: stamp } : {}) })
    if (request !== epoch) return
    set(catalog, result.catalog); set(syncResults, result.results); resetImportReviews()
    if (result.results.some(row => row.id === id && (row.status === 'synced' || row.status === 'unchanged'))) {
      const receipt = { ...group, items: group.items.filter(item => item.id === id) }
      set(receipts, [...read(receipts).filter(row => row.key !== group.key), receipt])
    }
    try {
      const next = await plugin.request('toolbox.state')
      if (request === epoch) set(state, next)
    } catch { if (request === epoch) set(failure, 'load') }
  } catch { if (request === epoch) set(failure, 'sync') }
  finally { if (request === epoch) set(busy, false) }
}
function pendingSelection(current: ToolboxState): boolean {
  return Boolean(current.automation?.enabled) && [...(current.automation?.appliedIds ?? [])].sort().join('|') !== [...current.selected].sort().join('|')
}
function SelectionActions() {
  const t = text(), current = read(state)
  const enabled = current.automation?.enabled === true, pending = pendingSelection(current)
  if (!current.selected.length) {
    if (!pending) return null
    const applied = current.automation?.appliedIds?.length ?? 0
    return <Row gap="sm" align="center" wrap>
      <Text size="sm" tone="warning">{t === copy.ko ? `새 세션에는 이전에 적용한 항목 ${applied}개가 제공됩니다.` : `New sessions still use ${englishCount(applied, 'previously applied item')}.`}</Text>
      <Button size="sm" variant="outline" onPress={() => set(settingsOpen, true)}>{t.settings}</Button>
    </Row>
  }
  return <Box direction="column" gap="xs" padding="sm" radius="sm" background="muted">
    <Row justify="between" align="center" gap="xs" wrap>
      <Text size="sm" weight="semibold">{`${t.selectedShort} ${current.selected.length} / 24`}</Text>
      <Row gap="xs" align="center">
        {enabled && !pending ? <Badge tone="success">{t.applied}</Badge> :
          <Button icon={enabled ? 'check' : 'plug'} tone="accent" size="sm" disabled={!current.workspaceId || read(busy) || read(loading)} onPress={() => changeAutomation(true)}>{enabled ? t.apply : t.connect}</Button>}
        <IconButton icon="close" label={t.clear} tooltip={t.clear} size="sm" variant="ghost" disabled={read(busy) || read(loading)} onPress={() => changeSelection([])} />
      </Row>
    </Row>
    {current.selected.length >= 24 ? <Text tone="warning" size="xs">{t.limit}</Text> : null}
  </Box>
}
function Item({ item }: { item: CatalogItem }) {
  const t = text(), current = read(state), expanded = read(expandedItem) === item.id
  const providers = item.providers.filter(name => name !== 'Shared').map(name => name.replace(/\s+(Code|CLI)$/, ''))
  const source = providers.length ? `${providers[0]}${providers.length > 1 ? ` +${providers.length - 1}` : ''}` : t.shared
  return <Box direction="column" gap="xs" padding="sm" background={current.selected.includes(item.id) ? 'muted' : 'none'}>
    <Row align="center" justify="between" gap="xs">
      <Box grow minWidth={0}><Checkbox label={item.name} checked={current.selected.includes(item.id)} disabled={!current.workspaceId || read(busy) || (!current.selected.includes(item.id) && (!item.available || !!item.providerOnly || current.selected.length >= 24))} onChange={checked => changeSelection(checked ? [...current.selected, item.id] : current.selected.filter(id => id !== item.id))} /></Box>
      <IconButton icon={expanded ? 'collapse' : 'expand'} label={`${t.detailsFor}: ${item.name}`} tooltip={t.details} variant="ghost" size="sm" onPress={() => { clearAdaptation(); set(expandedItem, expanded ? null : item.id) }} />
    </Row>
    <Row justify="between" align="center" gap="xs">
      <Box grow minWidth={0}><Text muted size="xs" truncate>{`${item.kind === 'skill' ? t.skill : 'MCP'} · ${source}`}</Text></Box>
      {item.providerOnly || !item.available ? <Badge tone="warning">{limitationLabel([item]) ?? t.unavailable}</Badge> : item.sharing?.state === 'conflict' || item.sharing?.state === 'update' ? <Badge tone="warning">{item.sharing.state === 'conflict' ? t.conflict : t.update}</Badge> : item.sharing?.state === 'provider' ? <Text muted size="xs">{t.providerOnly}</Text> : null}
    </Row>
    {expanded ? <Stack gap="sm">
      <Text size="sm" muted>{item.description || t.noDescription}</Text>
      <Text muted size="xs">{`${t.foundIn}: ${item.providers.join(' · ')}`}</Text>
      <Text muted size="xs">{`${t.source}: ${item.source}`}</Text>
      {item.skillRequirements && !item.providerOnly ? <Text size="xs" muted>{(t === copy.ko ? '필요 환경 · ' : 'Requires · ') + item.skillRequirements}</Text> : null}
      {item.providerOnly ? <ProviderAdaptation item={item} workspaceId={current.workspaceId} disabled={read(busy)} /> : <Stack gap="xs">
        {item.reason ? <Text size="sm" tone="warning">{item.reason}</Text> : null}
        {item.sharing?.detail ? <Text size="sm" muted>{item.sharing.detail}</Text> : null}
      </Stack>}
    </Stack> : null}
  </Box>
}
function ManualSetup() {
  const t = text(), current = read(state)
  return <Collapsible title={t.manual} open={read(manualOpen)} onChange={value => { set(manualOpen, value); set(settingsOpen, true) }}><Stack gap="sm">
    <Text muted size="sm">{t.manualHelp}</Text>
    {current.bundle ? <Text size="sm" tone="warning">{t.newSelection}</Text> : null}
    <Button icon="play" variant="outline" disabled={!current.workspaceId || !current.selected.length || Boolean(current.bundle) || read(busy) || read(loading)} onPress={() => bundleAction('prepare')}>{read(busy) ? t.preparing : t.prepare}</Button>
    {current.bundle ? <Box direction="column" gap="sm" padding="md" border radius="md" background="card">
      <Row justify="between" gap="sm" wrap><Heading level={3}>{t.ready}</Heading><RelativeTime at={current.bundle.createdAt} muted /></Row>
      <Text size="sm">{t.readyHelp}</Text>
      <Collapsible title={`${t.bundleItems} · ${current.bundle.names.length}`}><Stack gap="xs">{current.bundle.names.map((name, i) => <Text key={i} size="sm">{name}</Text>)}</Stack></Collapsible>
      <Button icon="copy" tone="accent" disabled={read(copyStatus) === 'copying' || read(busy)} onPress={copyInstructions}>{read(copyStatus) === 'copied' ? t.copied : read(copyStatus) === 'copying' ? t.copying : t.copyGuide}</Button>
      {read(copyStatus) === 'failed' ? <Text tone="warning" size="sm">{t.copyFailed}</Text> : null}
      <CodeView label={t.instructionLabel} code={current.bundle.instructions} wrap maxHeight="md" />
      <Collapsible title={t.connection}><Text muted size="xs">{t.connectionHelp}</Text></Collapsible>
      <Button size="sm" variant="outline" disabled={read(busy)} onPress={() => bundleAction('revoke')}>{t.revoke}</Button>
      <Text muted size="xs">{t.revokeHelp}</Text>
    </Box> : null}
  </Stack></Collapsible>
}
function ConnectionSettings() {
  const t = text(), current = read(state), automation = current.automation
  return <Stack gap="sm">
    <Switch label={t.autoToggle} checked={automation?.enabled === true} disabled={!current.workspaceId || read(busy) || (!automation?.enabled && !current.selected.length)} onChange={changeAutomation} />
    <Text muted size="xs">{t.autoHelp}</Text>
    {automation?.enabled ? <Text muted size="xs">{t.autoStop}</Text> : null}
    {automation ? <Collapsible title={t.providerStatus}><Stack gap="sm">
      {automation.providers.map(provider => <Stack key={provider.name} gap="xs"><Row justify="between" gap="sm" wrap><Text size="sm">{provider.name}</Text><Badge tone={provider.state === 'ready' ? 'success' : 'neutral'}>{provider.state === 'ready' ? t.bridgeReady : t.bridgeMissing}</Badge></Row>{provider.detail ? <Text muted size="xs">{provider.detail}</Text> : null}</Stack>)}
      <Text muted size="xs">{`${t.sessionCount}: ${automation.sessions}`}</Text>
    </Stack></Collapsible> : null}
    <ManualSetup />
    <Collapsible title={t.connectionDetails}><Stack gap="sm"><Text size="xs" muted>{t.selectionHelp}</Text><Text size="xs" muted>{t.syncHelp}</Text><Text size="xs" muted>{t.metadata}</Text><Text size="xs" muted>{t.tokenHelp}</Text></Stack></Collapsible>
    {read(catalog).warnings.length ? <Collapsible title={`${t.warnings} · ${read(catalog).warnings.length}`}><Stack gap="xs">{read(catalog).warnings.map((note, i) => <Text key={i} size="sm">{note}</Text>)}</Stack></Collapsible> : null}
    <Collapsible title={`${t.logs} · ${current.events.length}`}><Stack gap="sm">
      {!current.events.length ? <Text muted size="sm">{t.logEmpty}</Text> : current.events.slice(-30).reverse().map(event => <Row key={event.id} justify="between" align="center" gap="sm" wrap>
        <Box direction="column" gap="xs" minWidth={0} grow><Text size="sm" truncate>{event.name}</Text><Text muted size="xs">{event.kind === 'skill' ? t.readSkill : t.toolCall}</Text></Box>
        <Badge tone={event.state === 'running' ? 'accent' : event.state === 'failed' ? 'danger' : 'success'}>{event.state === 'running' ? t.running : event.state === 'failed' ? t.failed : t.succeeded}</Badge>
      </Row>)}
    </Stack></Collapsible>
  </Stack>
}
function changeView(value: 'store' | 'import') {
  reviewedUpdate = null
  set(reviewedGroup, null); set(libraryMode, value); set(page, 0); set(kind, 'all'); set(query, ''); set(selectedOnly, false)
  set(expandedItem, null); set(receipts, []); set(syncResults, []); closeImportDetails()
}

function StoreRow({ group }: { group: SourceGroup }) {
  if (group.items.length === 1) return <Item item={group.items[0]} />
  const ko = panelLanguage(env.locale) === 'ko'
  const title = ko ? group.name + ' · 원본 ' + group.items.length + '개' : group.name + ' · ' + group.items.length + ' sources'
  return <Box padding="sm"><Collapsible title={title}><Stack gap="xs">{group.items.map(item => <Item key={item.id} item={item} />)}</Stack></Collapsible></Box>
}

export function ToolboxReviewPanel({ onOpenLibrary }: { onOpenLibrary: () => void }) {
  const current = read(state), items = read(catalog).items
  if (!read(loaded)) return read(failure) === 'load' ? <LoadFailure /> : <Text muted size="sm">{text().loading}</Text>
  const allGroups = sourceGroups(items)
  function reviewGroup(finding: SkillReviewFinding) {
    if (finding.kind === 'excluded' || finding.kind === 'missing') return
    return allGroups.find(group => group.items.some(item => finding.ids.includes(item.id)))
  }
  async function showSource(finding: SkillReviewFinding) {
    if (!current.workspaceId) return
    const workspaceId = current.workspaceId, request = epoch, visit = reviewVisit
    const library = await plugin.request('toolbox.catalog')
    if (request !== epoch || visit !== reviewVisit || read(state).workspaceId !== workspaceId || !canReview()) return
    const group = sourceGroups(library.items).find(group => group.items.some(item => finding.ids.includes(item.id)))
    if (!group) throw new Error('review-source-changed')
    set(catalog, library)
    onOpenLibrary()
    const importing = needsImport(group)
    changeView(importing ? 'import' : 'store')
    set(kind, 'skill'); set(query, group.name); set(reviewedGroup, group.key)
    if (importing) {
      if (finding.kind === 'update' && finding.ids.length === 1 && finding.reviewedSourceStamp) {
        reviewedUpdate = { workspaceId, itemId: finding.ids[0], stamp: finding.reviewedSourceStamp }
      }
      await openImportDetails(group)
    } else {
      set(expandedItem, group.items.find(item => finding.ids.includes(item.id))?.id ?? null)
    }
  }
  return <SkillReview onCheck={() => openToolbox(true)} refreshing={read(loading) || read(busy)} loadFailed={read(failure) === 'load'}
    workspaceId={current.workspaceId} items={items} selected={current.selected} openSource={showSource} canOpen={finding => !!reviewGroup(finding)} />
}

export function ToolboxPanel() {
  const ko = panelLanguage(env.locale) === 'ko', t = text(), current = read(state), items = read(catalog).items
  if (!read(loaded)) return read(failure) === 'load' ? <LoadFailure /> : <Text muted size="sm">{t.loading}</Text>
  const automation = current.automation, importing = read(libraryMode) === 'import'
  const appliedCount = automation?.appliedIds?.length ?? 0
  const enabledLabel = importing || appliedCount !== current.selected.length ? `${t.autoOn} · ${appliedCount}` : t.autoOn
  const showSettings = read(settingsOpen) ?? read(manualOpen)
  const store = sourceGroups(items.filter(isShared))
  const allGroups = sourceGroups(items)
  const imports = allGroups.filter(needsImport)
  const completed = new Map(read(receipts).map(group => [group.key, group]))
  const outstanding = new Set(imports.map(group => group.key))
  const pendingImports = sortImports(imports.filter(group => !alreadyShared(group)))
  const browse = [...pendingImports, ...imports.filter(alreadyShared), ...read(receipts).filter(group => !outstanding.has(group.key))]
  const section = (group: SourceGroup) => !outstanding.has(group.key) || alreadyShared(group)
    ? (ko ? '공용 보관함에 추가됨' : 'In your shared library') : sectionTitle(group)
  const presentIds = new Set(items.map(i => i.id))
  const missingSelections = current.selected.filter(id => !presentIds.has(id))
  const onlySelected = read(selectedOnly) && current.selected.length > 0
  const selection = onlySelected ? sourceGroups(items.filter(item => current.selected.includes(item.id))) : store
  const groups = importing ? browse : selection
  const search = read(query).trim().toLocaleLowerCase(), exactGroup = read(reviewedGroup)
  const filtered = groups.filter(group => (!exactGroup || group.key === exactGroup) && (read(kind) === 'all' || group.kind === read(kind)) &&
    (!search || group.items.some(item => [item.name, item.description, item.source, ...item.providers].join(' ').toLocaleLowerCase().includes(search))))
  const currentPage = Math.min(read(page), Math.max(0, Math.ceil(filtered.length / 30) - 1))
  const visible = filtered.slice(currentPage * 30, (currentPage + 1) * 30)
  const typeFilters = [{ value: 'all', label: t.allShort }, { value: 'skill', label: t.skills }, { value: 'mcp', label: 'MCP' }]
  const unsuccessful = read(syncResults).filter(row => row.status === 'conflict' || row.status === 'failed')
  const importCount = pendingImports.length
  return <Stack gap="sm">
    <Row justify="between" align="center" gap="xs" wrap>
      <Row gap="xs" align="center"><Text muted size="sm">{t.autoTitle}</Text><Badge tone={automation?.enabled ? 'success' : 'neutral'}>{automation?.enabled ? enabledLabel : t.autoOff}</Badge></Row>
      <Row gap="xs" align="center">
        <IconButton icon="refresh" label={t.refresh} tooltip={t.refresh} size="sm" variant="ghost" disabled={read(loading) || read(busy)} onPress={() => openToolbox(true)} />
        <IconButton icon="settings" label={t.settings} tooltip={t.settings} size="sm" variant="ghost" tone={showSettings ? 'accent' : 'neutral'} onPress={() => set(settingsOpen, !showSettings)} />
      </Row>
    </Row>
    {!importing && read(loaded) && !read(loading) && missingSelections.length ? <Callout tone="warning"><Stack gap="xs">
      <Text size="sm">{ko ? '선택한 항목 중 설치본을 찾을 수 없는 항목 ' + missingSelections.length + '개' : englishCount(missingSelections.length, 'selected item') + ' missing from the library'}</Text>
      <Row><Button size="sm" variant="outline" disabled={read(busy)} onPress={() => changeSelection(current.selected.filter(id => presentIds.has(id)))}>{ko ? '누락된 선택 해제' : 'Remove unavailable selections'}</Button></Row>
    </Stack></Callout> : null}
    {showSettings ? <Box direction="column" gap="sm" padding="sm" border radius="sm"><Text weight="semibold" size="sm">{t.settings}</Text><ConnectionSettings /></Box> : null}
    <Row gap="xs" wrap>
      <Button size="sm" icon={importing ? 'blocks' : 'check'} variant={importing ? 'ghost' : 'solid'} tone={importing ? 'neutral' : 'accent'} onPress={() => { if (importing) changeView('store') }}>{(ko ? '공용 보관함 ' : 'Shared library ') + store.length}</Button>
      <Button size="sm" icon={importing ? 'check' : 'download'} variant={importing ? 'solid' : 'ghost'} tone={importing ? 'accent' : 'neutral'} onPress={() => { if (!importing) changeView('import') }}>{(ko ? '가져오기 ' : 'Import ') + importCount}</Button>
    </Row>
    <Input label={t.search} labelHidden value={read(query)} type="search" placeholder={t.searchPlaceholder} onChange={value => { set(reviewedGroup, null); set(query, value); set(page, 0) }} />
    <Row gap="xs" wrap>
      {typeFilters.map(filter => <Button key={filter.value} size="sm" variant={read(kind) === filter.value ? 'outline' : 'ghost'} icon={read(kind) === filter.value ? 'check' : undefined} tooltip={t.filter + ' · ' + filter.label} onPress={() => { set(kind, filter.value); set(page, 0) }}>{filter.label}</Button>)}
      {!importing && current.selected.length ? <Button size="sm" variant={read(selectedOnly) ? 'outline' : 'ghost'} icon={read(selectedOnly) ? 'check' : undefined} tooltip={t.selectedOnly} onPress={() => { set(selectedOnly, !read(selectedOnly)); set(page, 0) }}>{t.selectedOnly}</Button> : null}
    </Row>
    {!importing ? <SelectionActions /> : null}
    {!importing && current.selected.length > 0 && pendingSelection(current) ? <Text size="xs" tone="warning">{t.pending}</Text> : null}
    {read(failure) === 'load' || read(failure) === 'state' ? <LoadFailure /> : read(failure) || automation?.error ? <Callout tone="danger"><Stack gap="xs"><Text size="sm">{automation?.error ?? (read(failure) === 'automation' ? t.autoError : read(failure) === 'sync' ? t.syncError : t.saveError)}</Text><Button size="sm" variant="ghost" onPress={() => openToolbox(true)} disabled={read(busy) || read(loading)}>{t.retry}</Button></Stack></Callout> : null}
    {!read(loading) && read(loaded) && !current.workspaceId ? <Callout tone="warning"><Text size="sm">{t.noWorkspace}</Text></Callout> : null}
    {importing && unsuccessful.map(row => <Callout key={row.id} tone="warning"><Text size="sm">{row.name + ' · ' + (row.status === 'conflict' ? t.conflict : t.syncFailed)}</Text><Text size="sm">{row.message}</Text></Callout>)}
    {read(loading) ? <Text muted size="sm">{t.loading}</Text>
      : !items.length ? <EmptyState icon="blocks" title={t.empty} description={t.emptyHelp} />
      : visible.length ? <Box direction="column" gap="none" border radius="sm">{visible.map((group, index) => <Stack key={group.key} gap="none">
        {index ? <Separator /> : null}
        {importing && (!index || section(visible[index - 1]) !== section(group)) ? <Box padding="sm" background="muted"><Text size="xs" weight="semibold">{section(group)}</Text></Box> : null}
        {importing ? <ImportRow group={group} workspaceId={current.workspaceId} added={!outstanding.has(group.key)} receipt={completed.get(group.key)} disabled={!current.workspaceId || read(busy)} add={id => importSource(group, id)} /> : <StoreRow group={group} />}
      </Stack>)}</Box>
      : search || read(kind) !== 'all' || (!importing && onlySelected) ? <EmptyState icon="search" title={t.noMatch}><Button size="sm" variant="outline" onPress={() => { set(reviewedGroup, null); set(query, ''); set(kind, 'all'); set(selectedOnly, false); set(page, 0) }}>{ko ? '필터 초기화' : 'Reset filters'}</Button></EmptyState>
      : importing ? <EmptyState icon="check" title={ko ? '가져올 항목이 없습니다' : 'Nothing to import'} />
      : <EmptyState icon="blocks" title={ko ? '공용 보관함이 비어 있습니다' : 'Your shared library is empty'}><Button icon="download" size="sm" variant="outline" onPress={() => changeView('import')}>{ko ? '가져올 항목 보기' : 'Browse imports'}</Button></EmptyState>}
    {filtered.length > 30 ? <Row justify="between" gap="sm" align="center"><Button size="sm" variant="ghost" disabled={currentPage === 0} onPress={() => set(page, currentPage - 1)}>{t.previous}</Button><Text muted size="xs">{`${currentPage + 1} / ${Math.ceil(filtered.length / 30)}`}</Text><Button size="sm" variant="ghost" disabled={(currentPage + 1) * 30 >= filtered.length} onPress={() => set(page, currentPage + 1)}>{t.more}</Button></Row> : null}
  </Stack>
}
export function ArchitecturePanel() {
  const t = text(), ko = panelLanguage(env.locale) === 'ko'
  return <Stack gap="md">
    <Row justify="between" align="center" gap="sm" wrap><Heading level={2}>{t.structureTitle}</Heading><Button icon="refresh" size="sm" variant="ghost" disabled={read(loading) || read(busy)} onPress={() => openToolbox(true)}>{t.structureRefresh}</Button></Row>
    {read(loading) ? <Text muted size="sm">{t.loading}</Text> : read(failure) === 'load' || read(failure) === 'state' ? <LoadFailure /> : read(loaded) ? <ArchitectureDiagram items={read(catalog).items} state={read(state)} ko={ko} /> : null}
    <Collapsible title={t.connectionDetails}><Stack gap="sm">
      <Text muted size="sm">{t.totals}</Text>
      <Text muted size="sm">{t.autoHelp}</Text>
      <Text muted size="xs">{t.tokenHelp}</Text>
      <Text muted size="xs">{t.nativeHelp}</Text>
    </Stack></Collapsible>
  </Stack>
}
