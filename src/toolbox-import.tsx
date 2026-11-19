import { atom, Badge, Box, Button, Collapsible, env, plugin, read, Row, set, Stack, Text } from 'orca'
import { englishCount, panelLanguage } from './panel-language'
import { clearAdaptation, limitationLabel, ProviderAdaptation } from './provider-adaptation'
import type { CatalogItem, ToolboxComparison } from './toolbox-types'
import './protocol'

export type SourceGroup = { key: string; name: string; kind: CatalogItem['kind']; items: CatalogItem[] }
type Action = 'add' | 'choose' | 'compare' | 'update' | 'review'
const actionOrder: Action[] = ['add', 'choose', 'compare', 'update', 'review']
const words = {
  en: {
    viewDiff: 'View differences',
    add: 'Add', choose: 'Choose source', compare: 'Compare', update: 'Review update', review: 'Review',
    added: 'Added', same: 'Already shared', diff: 'Differences', identical: 'Matching sources',
    checking: 'Comparing sources…', failed: 'Could not compare sources.', retry: 'Retry',
    skill: 'Skill', shared: 'Shared copy', source: 'Source', updateAction: 'Update shared copy',
    unavailable: 'Unavailable', different: 'Different copy', files: 'files', close: 'Close',
    transport: 'Transport', command: 'Command', arguments: 'Arguments', environment: 'Environment',
    workingDirectory: 'Working directory', endpoint: 'Endpoint', authentication: 'Authentication',
    contents: 'Contents', permissions: 'Permissions', timeouts: 'Timeouts'
  },
  ko: {
    viewDiff: '차이 보기',
    add: '추가', choose: '원본 선택', compare: '공용본과 비교', update: '변경 검토', review: '확인',
    added: '추가됨', same: '이미 공용', diff: '차이', identical: '같은 내용의 원본',
    checking: '원본 비교 중…', failed: '원본을 비교하지 못했습니다.', retry: '다시 비교',
    skill: '스킬', shared: '공용본', source: '원본', updateAction: '공용본 업데이트',
    unavailable: '사용 불가', different: '다른 원본', files: '파일', close: '접기',
    transport: '연결 방식', command: '실행 명령', arguments: '실행 인자', environment: '환경 변수',
    workingDirectory: '작업 폴더', endpoint: '서버 주소', authentication: '인증',
    contents: '내용', permissions: '권한', timeouts: '시간 제한'
  }
}
const labels = () => words[panelLanguage(env.locale)]
const expanded = atom<string | null>(null)
const comparison = atom<ToolboxComparison | 'loading' | 'error' | null>(null)
const reviewed = atom<Record<string, 'same' | 'different'>>({})
let generation = 0

export function alreadyShared(group: SourceGroup): boolean {
  return read(reviewed)[group.key] === 'same'
}
export function resetImportReviews() {
  closeImportDetails()
  set(reviewed, {})
}

export function closeImportDetails() {
  generation++
  clearAdaptation()
  set(expanded, null)
  set(comparison, null)
}
export function sourceGroups(items: CatalogItem[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>()
  for (const item of items) {
    const key = item.kind + '/' + item.name.trim().toLowerCase()
    const group = groups.get(key)
    if (group) group.items.push(item)
    else groups.set(key, { key, name: item.name, kind: item.kind, items: [item] })
  }
  return [...groups.values()]
}
export function isShared(item: CatalogItem): boolean {
  return item.sharing ? item.sharing.state !== 'provider' : item.providers.includes('Shared')
}
export function needsImport(group: SourceGroup): boolean {
  return group.items.some(item => !isShared(item) || item.sharing?.state === 'update' || item.sharing?.state === 'conflict')
}
function canImport(item: CatalogItem): boolean {
  return !item.providerOnly && item.available && item.sharing?.canSync === true
}
function actionOf(group: SourceGroup): Action {
  if (group.items.every(item => item.providerOnly)) return 'review'
  if (group.items.length > 1 && group.items.some(isShared)) return 'compare'
  if (group.items.some(item => item.sharing?.state === 'update')) return 'update'
  if (!group.items.some(canImport)) return 'review'
  return group.items.length > 1 ? 'choose' : 'add'
}
export function sectionTitle(group: SourceGroup) {
  const ko = labels() === words.ko
  return (ko ? { add: '바로 추가', choose: '여러 원본', compare: '공용본 있음', update: '업데이트', review: '확인 필요' }
    : { add: 'Ready to add', choose: 'Multiple sources', compare: 'In shared library', update: 'Updates', review: 'Needs review' })[actionOf(group)]
}
export function sortImports(groups: SourceGroup[]): SourceGroup[] {
  const rank = (group: SourceGroup) => actionOrder.indexOf(actionOf(group))
  return [...groups].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}
function providers(items: CatalogItem[]): string {
  return [...new Set(items.flatMap(item => item.providers).filter(name => name !== 'Shared').map(name => name.replace(/\s+(Code|CLI)$/, '')))].join(' · ')
}
async function openDetails(group: SourceGroup) {
  const request = ++generation
  clearAdaptation()
  set(expanded, group.key)
  if (group.items.length < 2 || group.items.every(item => item.providerOnly)) { set(comparison, null); return }
  set(comparison, 'loading')
  try {
    const result = await plugin.request('toolbox.compare', { id: group.items[0].id })
    if (request !== generation) return
    set(comparison, result)
    if (actionOf(group) !== 'compare' || group.items.some(item => item.providerOnly || item.sharing?.state === 'conflict' || item.sharing?.state === 'update')) return
    const variant = (item: CatalogItem) => result.sources.find(source => source.id === item.id)?.variant
    const shared = new Set(group.items.filter(isShared).map(variant))
    if (group.items.some(item => variant(item) == null)) return
    const same = group.items.every(item => shared.has(variant(item)))
    set(reviewed, { ...read(reviewed), [group.key]: same ? 'same' : 'different' })
  } catch {
    if (request === generation) set(comparison, 'error')
  }
}
type Add = (id: string) => Promise<void>
type SourceProps = { group: SourceGroup; workspaceId: string | null; disabled: boolean; add: Add }
function Sources({ group, workspaceId, disabled, add }: SourceProps) {
  const t = labels(), check = read(comparison)
  const result = typeof check === 'string' ? null : check
  const sources = result?.sources ?? []
  const variant = (item: CatalogItem) => sources.find(source => source.id === item.id)?.variant
  const shared = group.items.filter(isShared)
  const sharedVariants = new Set(shared.filter(item => item.sharing?.state === 'shared').map(variant).filter(v => v != null))
  const verified = group.items.filter(item => variant(item) != null)
  const identical = group.items.length > 1 && verified.length === group.items.length && new Set(verified.map(variant)).size === 1
  return <Stack gap="sm">
    {check === 'loading' ? <Text muted size="sm">{t.checking}</Text> : null}
    {check === 'error' ? <Row gap="sm" align="center"><Text tone="warning" size="sm">{t.failed}</Text><Button size="sm" onPress={() => openDetails(group)}>{t.retry}</Button></Row> : null}
    {result?.differences.length ? <Text size="xs" muted>{t.diff + ' · ' + result.differences.map(field => t[field]).join(', ')}</Text> : identical ? <Text size="xs" muted>{t.identical}</Text> : null}
    {group.items.map(item => {
      if (item.providerOnly) return <Box key={item.id} direction="column" padding="sm" gap="xs" radius="sm" background="muted">
        {group.items.length > 1 ? <Stack gap="xs">
          <Row align="center" justify="between" gap="xs" wrap><Text size="sm" weight="semibold">{providers([item]) || t.shared}</Text><Badge tone="warning">{limitationLabel([item])}</Badge></Row>
          <Text size="xs" muted>{item.source}</Text>
        </Stack> : null}
        <ProviderAdaptation item={item} workspaceId={workspaceId} disabled={disabled} />
      </Box>
      if (check === 'loading' || check === 'error') return null
      const info = sources.find(source => source.id === item.id)
      const inLibrary = isShared(item)
      const same = info?.variant != null && sharedVariants.has(info.variant)
      const update = item.sharing?.state === 'update'
      const supported = canImport(item) && (!result || info?.variant != null)
      const mayAdd = supported && (update || (!inLibrary && !shared.length && (!identical || item === group.items.find(canImport))))
      const provider = providers([item])
      const addLabel = provider && group.items.length > 1
        ? (t === words.ko ? provider + ' 원본 추가' : 'Add from ' + provider)
        : t.add
      const matches = info?.variant != null ? group.items.filter(other => other.id !== item.id && variant(other) === info.variant) : []
      const matchingProviders = providers(matches)
      const facts = [item.source, info?.transport, info?.commandHint]
      const differences = result?.differences ?? []
      if (info?.fileCount != null) facts.push(t === words.ko ? '파일 ' + info.fileCount + '개' : englishCount(info.fileCount, 'file'))
      if (info?.envCount != null && differences.includes('environment')) facts.push(t.environment + ' ' + info.envCount)
      if (info?.argumentCount != null && differences.includes('arguments')) facts.push(t.arguments + ' ' + info.argumentCount)
      if (info?.headerCount != null && differences.includes('authentication')) facts.push((t === words.ko ? '헤더 ' : 'Headers ') + info.headerCount)
      const detail = facts.filter(Boolean).join(' · ')
      let status = ''
      if (inLibrary) status = t.shared
      else if (same) status = t.same
      else if (!supported) status = t.unavailable
      else if (shared.length) status = t.different
      return <Box key={item.id} direction="column" padding="sm" gap="xs" radius="sm" background="muted">
        <Row align="center" justify="between" gap="sm" wrap>
          <Text weight="semibold" size="sm">{provider || t.shared}</Text>
          {mayAdd ? <Button size="sm" variant="outline" disabled={disabled} onPress={() => add(item.id)}>{update ? t.updateAction : addLabel}</Button>
            : status ? <Text size="xs" muted>{status}</Text> : null}
        </Row>
        <Text size="xs" muted>{detail}</Text>
        {matches.length && matchingProviders && !identical ? <Text size="xs" muted>{(t === words.ko ? '같은 구성 · ' : 'Same configuration · ') + matchingProviders}</Text> : null}
        {item.skillRequirements ? <Text size="xs" muted>{(t === words.ko ? '필요 환경 · ' : 'Requires · ') + item.skillRequirements}</Text> : null}
        {item.reason || item.sharing?.detail ? <Text size="xs" muted>{item.reason || item.sharing?.detail}</Text> : null}
      </Box>
    })}
  </Stack>
}
export function ImportRow({ group, workspaceId, added, receipt, disabled, add }: SourceProps & { added: boolean; receipt?: SourceGroup }) {
  const t = labels(), action = actionOf(group), open = read(expanded) === group.key
  const source = providers(group.items)
  const type = group.kind === 'skill' ? t.skill : 'MCP'
  const review = read(reviewed)[group.key]
  const limitation = limitationLabel(group.items)
  return <Box direction="column" padding="sm" gap="sm">
    <Row align="center" justify="between" gap="sm">
      <Box direction="column" grow minWidth={0} gap="xs">
        <Text size="sm" weight="semibold">{group.name}</Text>
        <Row gap="xs" align="center" wrap><Text size="xs" muted>{source ? type + ' · ' + source : type}</Text>{limitation ? <Badge tone="warning">{limitation}</Badge> : null}</Row>
      </Box>
      {added || (!open && review === 'same') ? <Badge tone="success">{added ? t.added : t.same}</Badge> : <Button
        icon={action === 'add' ? 'add' : open ? 'collapse' : 'expand'} size="sm" variant={action === 'add' ? 'outline' : 'ghost'}
        disabled={action === 'add' && disabled} onPress={() => {
          if (action === 'add') return add(group.items[0].id)
          if (open) closeImportDetails()
          else return openDetails(group)
        }}>{open ? t.close : review === 'different' ? t.viewDiff : t[action]}</Button>}
    </Row>
    {!added && receipt ? <Text size="xs" tone="success">{[t.added, providers(receipt.items)].filter(Boolean).join(' · ')}</Text> : null}
    {action === 'add' && !added && group.items[0].skillRequirements ? <Collapsible title={t === words.ko ? '필요 환경' : 'Requirements'}><Text size="xs" muted>{group.items[0].skillRequirements}</Text></Collapsible> : null}
    {open && !added ? <Sources group={group} workspaceId={workspaceId} disabled={disabled} add={add} /> : null}
  </Box>
}
