import { atom, Badge, Box, Button, Callout, Checkbox, CodeView, Collapsible, EmptyState, env, Heading, Input, on, plugin, read, RelativeTime, Row, Select, Separator, set, Stack, Text, type PanelContext } from 'orca'
import type { CatalogItem, ToolboxCatalog, ToolboxState } from './toolbox-types'
import './protocol'

const catalog = atom<ToolboxCatalog>({ items: [], warnings: [] })
const state = atom<ToolboxState>({ workspaceId: null, selected: [], bundle: null, events: [] })
const loaded = atom(false)
const loading = atom(false)
const busy = atom(false)
const failure = atom<'load' | 'save' | ''>('')
const query = atom('')
const kind = atom('all')
const selectedOnly = atom(false)
const page = atom(0)
const copyStatus = atom<'idle' | 'copying' | 'copied' | 'failed'>('idle')
let epoch = 0
let canRead = () => false

const copy = {
  en: {
    title: 'Choose what this task needs', intro: 'Browse once. Give your agent only the capabilities you choose.',
    idle: 'On demand', skills: 'Skills', mcp: 'MCP servers', selected: 'Selected', search: 'Search capabilities', searchPlaceholder: 'Name, purpose or provider…',
    filter: 'Show', all: 'All types', selectedOnly: 'Selected only', refresh: 'Refresh library', clear: 'Clear selection',
    loading: 'Reading local capability metadata…', empty: 'No capabilities found', emptyHelp: 'Install skills or MCP tools locally, then refresh this library.', noMatch: 'No matching capabilities', noMatchHelp: 'Try another search or show all types.',
    unavailable: 'Unavailable', details: 'Details', foundIn: 'Found in', source: 'Source', noDescription: 'No description supplied.',
    noWorkspace: 'Open a workspace to prepare a selection for your task.', choose: 'Choose at least one capability to continue.',
    prepare: 'Prepare use instructions', preparing: 'Preparing…', loadError: 'Could not read the library. Your existing setup is unchanged.', saveError: 'Could not update this selection. Refresh and try again.', retry: 'Try again',
    selectionHelp: 'Nothing starts when you select it. Server tools and skill instructions are loaded only when requested.',
    ready: 'Instructions ready', readyHelp: 'Copy this guide into one agent conversation. Reusing it shares server state. The agent calls the runner through its shell tool.',
    instructionLabel: 'Guide to paste into your agent', revoke: 'Revoke these instructions', revokeHelp: 'Revoking stops running tool requests and further calls through this bundle. Clearing your selection does not revoke it.',
    bundleItems: 'Prepared capabilities', newSelection: 'Revoke the existing instructions before preparing a new selection.', limit: 'Up to 24 capabilities per selection.', connection: 'Connection lifetime', connectionHelp: 'After 15 minutes without use, tool connections close. The next call reconnects, but server-side working state may not be restored.',
    logs: 'Shared runner activity', logEmpty: 'No calls through these instructions yet.', running: 'Running', succeeded: 'Completed', failed: 'Failed', readSkill: 'Read skill', toolCall: 'MCP call',
    metadata: 'The library displays names and descriptions, without sending it to your model or starting MCP servers. Provider labels identify where settings were found; MCP connections are checked only when requested.',
    warnings: 'Discovery notes', more: 'Next', previous: 'Previous', count: 'results', copyGuide: 'Copy instructions', copying: 'Copying…', copied: 'Copied', copyFailed: 'Could not copy automatically. Select the guide text below and copy it manually.',
    structureTitle: 'One library. Only what you need.', structureHelp: 'The same selected capabilities can be used by agents that can run local shell commands.',
    installedTitle: '1 · Discover', installedText: 'Read metadata from shared and provider skill folders and MCP settings.',
    selectTitle: '2 · Select for the task', selectText: 'Choose a small set in this workspace. No automatic “enable everything”.',
    guideTitle: '3 · Give the agent a short guide', guideText: 'Paste the prepared instructions into Codex, Claude or Gemini. No provider configuration is rewritten.',
    runTitle: '4 · Load only on request', runText: 'The shared runner reads a chosen skill or starts a chosen MCP server when the agent asks for it.',
    observeTitle: '5 · Observe the call', observeText: 'The runner reports start, completion and failure. A skill read is a content load, not proof of continued use.',
    boundaryTitle: 'Your conversation stays yours', boundaryText: 'This plugin does not restart agent sessions or inject native MCP connections. A tool failure is returned to its caller.',
    installed: 'Installed', chosen: 'Chosen', called: 'Requested', tokenHelp: 'Names, instructions and tool results still use tokens when sent to a model. Unselected capability contents are not included in this guide.',
    nativeHelp: 'Provider-only built-in tools and private plugins are not converted into shared tools.',
  },
  ko: {
    title: '이번 작업에 필요한 것만', intro: '설치된 기능을 모아 보고, 선택한 기능만 에이전트에 전달하세요.',
    idle: '필요할 때만', skills: '스킬', mcp: 'MCP 서버', selected: '선택됨', search: '기능 검색', searchPlaceholder: '이름, 용도, 제공자 검색…',
    filter: '표시 종류', all: '모든 종류', selectedOnly: '선택한 항목만', refresh: '목록 새로고침', clear: '선택 비우기',
    loading: '설치된 기능의 정보를 읽는 중…', empty: '찾은 기능이 없습니다', emptyHelp: '로컬에 스킬이나 MCP 도구를 설치한 뒤 목록을 새로고침하세요.', noMatch: '검색 결과가 없습니다', noMatchHelp: '검색어를 바꾸거나 모든 종류를 표시해 보세요.',
    unavailable: '사용 불가', details: '자세히', foundIn: '발견 위치', source: '출처', noDescription: '등록된 설명이 없습니다.',
    noWorkspace: '작업공간을 열면 이 작업에 사용할 기능을 선택할 수 있습니다.', choose: '사용할 기능을 하나 이상 선택하세요.',
    prepare: '사용 안내 만들기', preparing: '준비 중…', loadError: '목록을 읽지 못했습니다. 기존 설정은 변경되지 않았습니다.', saveError: '선택을 반영하지 못했습니다. 새로고침 후 다시 시도하세요.', retry: '다시 시도',
    selectionHelp: '선택만으로 실행되지 않습니다. 도구 목록과 스킬 본문은 에이전트가 요청할 때 불러옵니다.',
    ready: '사용 안내 준비됨', readyHelp: '아래 안내를 사용할 대화 하나에 복사해 주세요. 같은 안내를 여러 대화에 쓰면 서버 상태도 공유됩니다. 에이전트는 셸 도구로 호출합니다.',
    instructionLabel: '에이전트 대화에 붙여 넣을 안내', revoke: '이 안내의 사용 해제', revokeHelp: '해제하면 진행 중인 도구 요청과 이후 호출이 중단됩니다. 선택 비우기는 사용 해제와 별개입니다.',
    bundleItems: '준비된 기능', newSelection: '새 구성을 만들려면 기존 안내의 사용을 먼저 해제하세요.', limit: '한 구성에는 최대 24개 기능을 선택할 수 있습니다.', connection: '연결 유지 방식', connectionHelp: '15분 동안 사용하지 않으면 도구 연결이 닫힙니다. 다음 호출에서 다시 연결하지만 서버 내부 작업 상태는 복원되지 않을 수 있습니다.',
    logs: '공통 실행기 활동', logEmpty: '이 안내로 호출한 기록이 없습니다.', running: '실행 중', succeeded: '완료', failed: '실패', readSkill: '스킬 읽기', toolCall: 'MCP 호출',
    metadata: '목록에는 이름과 설명만 표시합니다. 전체 기능을 모델에 전달하거나 MCP 서버를 시작하지 않습니다. 제공자 표시는 설정을 찾은 위치이며, MCP 연결은 실제 요청할 때 확인합니다.',
    warnings: '목록 확인 사항', more: '다음', previous: '이전', count: '개', copyGuide: '안내 복사', copying: '복사 중…', copied: '복사됨', copyFailed: '자동 복사를 하지 못했습니다. 아래 안내를 직접 선택해 복사해 주세요.',
    structureTitle: '한곳에 모으고, 필요한 만큼만', structureHelp: '로컬 셸 명령을 실행할 수 있는 에이전트라면 같은 구성을 사용할 수 있습니다.',
    installedTitle: '1 · 설치된 기능 찾기', installedText: '공용·제공자별 스킬 폴더와 MCP 설정에서 기능 정보를 읽습니다.',
    selectTitle: '2 · 이번 작업에 선택', selectText: '이 작업공간에서 필요한 기능만 고릅니다. 처음부터 모두 켜지 않습니다.',
    guideTitle: '3 · 짧은 안내 전달', guideText: '준비된 안내를 Codex·Claude·Gemini 대화에 붙여 넣습니다. 제공자 설정은 바꾸지 않습니다.',
    runTitle: '4 · 요청할 때만 불러오기', runText: '에이전트가 요청하면 선택한 스킬을 읽거나 선택한 MCP 서버를 시작합니다.',
    observeTitle: '5 · 실제 호출 확인', observeText: '실행기가 시작·완료·실패를 알립니다. 스킬 읽기는 본문을 불러온 기록이며 계속 적용 중이라는 뜻은 아닙니다.',
    boundaryTitle: '대화는 그대로 유지', boundaryText: '세션을 재시작하거나 네이티브 MCP 연결을 주입하지 않습니다. 도구 오류는 해당 호출에 반환합니다.',
    installed: '설치됨', chosen: '선택됨', called: '요청됨', tokenHelp: '모델에 전달하는 이름·안내·도구 결과는 토큰을 사용합니다. 선택하지 않은 기능의 본문은 이 안내에 포함되지 않습니다.',
    nativeHelp: '제공자 전용 내장 도구와 비공개 플러그인을 공용 도구로 변환하지는 않습니다.',
  }
} as const
const text = () => env.locale.toLowerCase().startsWith('ko') ? copy.ko : copy.en

export async function openToolbox(force = false): Promise<void> {
  if (!force && read(loaded)) { await refreshState(); return }
  const request = ++epoch
  set(loading, true); set(failure, ''); set(page, 0)
  try {
    const [library, selection] = await Promise.all([plugin.request('toolbox.catalog'), plugin.request('toolbox.state')])
    if (request !== epoch) return
    set(catalog, library); set(state, selection); set(loaded, true)
  } catch { if (request === epoch) set(failure, 'load') }
  finally { if (request === epoch) set(loading, false) }
}
async function refreshState(): Promise<void> {
  if (read(busy)) return
  const request = epoch
  try {
    const selection = await plugin.request('toolbox.state')
    if (request === epoch && !read(busy)) set(state, selection)
  } catch { if (request === epoch) set(failure, 'load') }
}
export function setupToolbox(ctx: PanelContext, isActive: () => boolean): void {
  canRead = () => isActive() && read(ctx.visible)
  ctx.subscriptions.push(plugin.on('toolbox.changed', () => { if (canRead()) void refreshState() }))
  ctx.subscriptions.push(on('workspace.changed', () => {
    epoch++
    set(state, { workspaceId: null, selected: [], bundle: null, events: [] })
    set(busy, false); set(loading, false); set(failure, ''); set(copyStatus, 'idle'); set(query, ''); set(selectedOnly, false); set(page, 0)
    if (canRead()) void openToolbox()
  }))
  ctx.subscriptions.push({ dispose: () => { epoch++; canRead = () => false } })
  if (canRead()) void openToolbox()
}
async function changeSelection(ids: string[]): Promise<void> {
  const workspaceId = read(state).workspaceId
  if (!workspaceId || read(busy)) return
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
  if (!workspaceId || read(busy)) return
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
function Item({ item }: { item: CatalogItem }) {
  const t = text(), current = read(state)
  return <Box direction="column" gap="xs" padding="sm" border radius="md" background={current.selected.includes(item.id) ? 'muted' : 'none'}>
    <Checkbox label={item.name} description={item.kind === 'mcp' ? (env.locale.toLowerCase().startsWith('ko') ? '요청할 때 이 서버의 도구를 불러옵니다.' : 'Discover this server’s tools only when requested.') : item.description ? item.description.slice(0, 180) : t.noDescription} checked={current.selected.includes(item.id)} disabled={!item.available || !current.workspaceId || read(busy) || (!current.selected.includes(item.id) && current.selected.length >= 24)} onChange={checked => changeSelection(checked ? [...current.selected, item.id] : current.selected.filter(id => id !== item.id))} />
    <Row justify="between" align="center" wrap gap="xs">
      <Badge>{item.kind === 'skill' ? t.skills : t.mcp}</Badge>
      {!item.available ? <Badge tone="warning">{t.unavailable}</Badge> : null}
      <Text muted size="xs">{`${t.foundIn}: ${item.providers.join(' · ')}`}</Text>
    </Row>
    <Collapsible title={t.details}>
      <Stack gap="xs">
        <Text muted size="xs">{`${t.source}: ${item.source}`}</Text>
        {item.reason ? <Text size="sm" tone="warning">{item.reason}</Text> : null}
      </Stack>
    </Collapsible>
  </Box>
}
export function ToolboxPanel() {
  const t = text(), current = read(state), items = read(catalog).items
  const search = read(query).trim().toLocaleLowerCase()
  const filtered = items.filter(item => (read(kind) === 'all' || item.kind === read(kind)) && (!read(selectedOnly) || current.selected.includes(item.id)) && (!search || [item.name, item.description, item.source, ...item.providers].join(' ').toLocaleLowerCase().includes(search)))
  return <Stack gap="md">
    <Stack gap="xs">
      <Row justify="between" align="center" gap="xs" wrap><Heading level={2}>{t.title}</Heading><Badge tone="accent">{t.idle}</Badge></Row>
      <Text muted size="sm">{t.intro}</Text>
    </Stack>
    <Row gap="sm" wrap>
      <Badge>{`${t.skills} · ${items.filter(item => item.kind === 'skill').length}`}</Badge>
      <Badge>{`${t.mcp} · ${items.filter(item => item.kind === 'mcp').length}`}</Badge>
      <Badge tone={current.selected.length ? 'accent' : 'neutral'}>{`${t.selected} · ${current.selected.length}`}</Badge>
    </Row>
    {read(failure) ? <Callout tone="danger"><Stack gap="sm"><Text>{read(failure) === 'load' ? t.loadError : t.saveError}</Text><Button size="sm" onPress={() => openToolbox(true)} disabled={read(busy) || read(loading)}>{t.retry}</Button></Stack></Callout> : null}
    {!read(loading) && read(loaded) && !current.workspaceId ? <Callout tone="warning"><Text size="sm">{t.noWorkspace}</Text></Callout> : null}
    <Box direction="column" gap="sm" padding="md" border="accent" radius="md" background="card">
      <Row justify="between" align="center" gap="sm" wrap><Text weight="semibold">{`${t.selected} · ${current.selected.length}`}</Text><Button size="sm" variant="ghost" disabled={!current.selected.length || read(busy)} onPress={() => changeSelection([])}>{t.clear}</Button></Row>
      <Text size="sm" muted>{current.bundle ? t.newSelection : current.selected.length ? t.selectionHelp : t.choose}</Text>
      {current.selected.length >= 24 ? <Text tone="warning" size="xs">{t.limit}</Text> : null}
      <Button icon="play" tone="accent" disabled={!current.workspaceId || !current.selected.length || Boolean(current.bundle) || read(busy) || read(loading)} onPress={() => bundleAction('prepare')}>{read(busy) ? t.preparing : t.prepare}</Button>
    </Box>
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
    <Input label={t.search} value={read(query)} type="search" placeholder={t.searchPlaceholder} onChange={value => { set(query, value); set(page, 0) }} />
    <Row align="center" justify="between" gap="sm" wrap>
      <Select label={t.filter} value={read(kind)} options={[{ value: 'all', label: t.all }, { value: 'skill', label: t.skills }, { value: 'mcp', label: t.mcp }]} onChange={value => { set(kind, value); set(page, 0) }} />
      <Checkbox label={t.selectedOnly} checked={read(selectedOnly)} onChange={value => { set(selectedOnly, value); set(page, 0) }} />
    </Row>
    <Row justify="between" align="center" gap="sm" wrap><Text muted size="xs">{`${filtered.length} ${t.count}`}</Text><Button icon="refresh" size="sm" variant="ghost" disabled={read(loading) || read(busy)} onPress={() => openToolbox(true)}>{t.refresh}</Button></Row>
    {read(loading) ? <Text muted size="sm">{t.loading}</Text> : !items.length ? <EmptyState icon="blocks" title={t.empty} description={t.emptyHelp} /> : !filtered.length ? <EmptyState icon="search" title={t.noMatch} description={t.noMatchHelp} /> : <Stack gap="sm">{filtered.slice(read(page) * 30, (read(page) + 1) * 30).map(item => <Item key={item.id} item={item} />)}</Stack>}
    {filtered.length > 30 ? <Row justify="between" gap="sm" align="center"><Button variant="outline" disabled={read(page) === 0} onPress={() => set(page, read(page) - 1)}>{t.previous}</Button><Text muted size="xs">{`${read(page) + 1} / ${Math.ceil(filtered.length / 30)}`}</Text><Button variant="outline" disabled={(read(page) + 1) * 30 >= filtered.length} onPress={() => set(page, read(page) + 1)}>{t.more}</Button></Row> : null}
    <Text muted size="xs">{t.metadata}</Text>
    {read(catalog).warnings.length ? <Collapsible title={`${t.warnings} · ${read(catalog).warnings.length}`}><Stack gap="xs">{read(catalog).warnings.map((note, i) => <Text key={i} size="sm">{note}</Text>)}</Stack></Collapsible> : null}
    <Separator />
    <Collapsible title={`${t.logs} · ${current.events.length}`}>
      <Stack gap="sm">
        {!current.events.length ? <Text muted size="sm">{t.logEmpty}</Text> : current.events.slice(-30).reverse().map(event => <Row key={event.id} justify="between" align="center" gap="sm" wrap>
          <Box direction="column" gap="xs" minWidth={0} grow><Text size="sm" truncate>{event.name}</Text><Text muted size="xs">{event.kind === 'skill' ? t.readSkill : t.toolCall}</Text></Box>
          <Badge tone={event.state === 'running' ? 'accent' : event.state === 'failed' ? 'danger' : 'success'}>{event.state === 'running' ? t.running : event.state === 'failed' ? t.failed : t.succeeded}</Badge>
        </Row>)}
      </Stack>
    </Collapsible>
  </Stack>
}
export function ArchitecturePanel() {
  const t = text()
  const stages = [
    { title: t.installedTitle, detail: t.installedText },
    { title: t.selectTitle, detail: t.selectText },
    { title: t.guideTitle, detail: t.guideText },
    { title: t.runTitle, detail: t.runText },
    { title: t.observeTitle, detail: t.observeText },
  ]
  return <Stack gap="md">
    <Heading level={2}>{t.structureTitle}</Heading>
    <Text muted size="sm">{t.structureHelp}</Text>
    <Stack gap="xs">
      {stages.map((stage, index) => <Stack key={index} gap="xs">
        {index > 0 ? <Box align="center"><Text muted>↓</Text></Box> : null}
        <Box direction="column" gap="xs" padding="md" border={index === 3 ? 'accent' : true} radius="md" background="card">
          <Text weight="semibold" tone={index === 3 ? 'accent' : 'neutral'}>{stage.title}</Text>
          <Text muted size="sm">{stage.detail}</Text>
        </Box>
      </Stack>)}
    </Stack>
    <Callout icon="info" title={t.boundaryTitle}><Text size="sm">{t.boundaryText}</Text></Callout>
    <Text muted size="sm">{t.tokenHelp}</Text>
    <Text muted size="xs">{t.nativeHelp}</Text>
  </Stack>
}
