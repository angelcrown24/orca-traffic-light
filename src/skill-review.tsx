import { atom, Button, Callout, EmptyState, env, Heading, List, ListItem, plugin, read, Row, set, Stack, Text } from 'orca'
import { ChangeButtons, ChangeForm, ChangeHistory, closeSkillChange, hasSkillChange, resetSkillMaintenance } from './skill-maintenance'
import { englishCount, panelLanguage } from './panel-language'
import { InspectionResult, inspectSelection, RecommendationPreviewPanel, resetReviewAssistant, SkillPicker } from './review-assistant'
import type { CatalogItem, SkillReviewFinding, SkillReviewReport } from './toolbox-types'
import './protocol'

const findingsOrder: SkillReviewFinding['kind'][] = ['conflict', 'missing', 'update', 'variants', 'successor', 'redundant', 'provider', 'excluded']
const labels = {
  en: {
    redundant: 'Identical provider copy', conflict: 'Shared copy conflict', missing: 'Missing package file', update: 'Shared update available',
    variants: 'Source files differ', successor: 'Documented successor', provider: 'Provider requirement', excluded: 'Could not check',
    'scan-limit': 'This package exceeds the review scan limit.', 'too-large': 'SKILL.md exceeds the 64 KiB discovery limit.', unreadable: 'The skill instructions could not be read.',
    'unsupported-package': 'The package exceeds the supported scan limits or contains an unsupported file.',
    'unverified-metadata': 'The package metadata could not be verified.',
    'skill-execution': 'Uses provider-specific execution settings.', 'explicit-invocation': 'Requires explicit invocation.',
    'native-tool': 'Requires a tool built into its provider.',
    deferred: 'Set aside', defer: 'Set aside this version', restore: 'Restore', back: 'Back to findings',
    sources: 'Compare sources', updateAction: 'Review update', providerAction: 'View requirement',
    rescan: 'Check again', loading: 'Checking local skill packages…', error: 'Could not check local skills.',
    start: 'Check local skills', choose: 'Open a local workspace to check skills.', partial: 'Coverage is incomplete.',
    none: 'No open findings', empty: 'No local skill packages found', clean: 'No issues found in checked packages',
    prev: 'Previous', next: 'Next', locations: 'Selected in', changes: 'Changed files',
  },
  ko: {
    redundant: '내용이 같은 제공자 사본', conflict: '공용본 충돌', missing: '참조 파일 누락', update: '공용본 업데이트', variants: '원본 파일 차이', successor: '후속 스킬 안내',
    provider: '제공자 전용 조건', excluded: '점검 제외',
    'scan-limit': '패키지가 점검 한도를 넘습니다.', 'too-large': 'SKILL.md가 탐색 한도인 64 KiB를 넘습니다.', unreadable: '스킬 지침을 읽을 수 없습니다.',
    'unsupported-package': '점검 한도를 넘거나 지원하지 않는 파일이 들어 있습니다.', 'unverified-metadata': '패키지 정보를 확인할 수 없습니다.',
    'skill-execution': '특정 제공자의 실행 설정을 사용합니다.', 'explicit-invocation': '사용자가 직접 호출해야 합니다.',
    'native-tool': '특정 제공자의 내장 도구가 필요합니다.',
    deferred: '보류함', defer: '이 버전 보류', restore: '다시 표시', back: '점검 결과로',
    sources: '원본 비교', updateAction: '변경 검토', providerAction: '실행 조건 보기',
    rescan: '다시 점검', loading: '로컬 스킬 패키지 점검 중…', error: '로컬 스킬을 점검하지 못했습니다.',
    start: '로컬 스킬 점검', choose: '로컬 작업공간을 열면 스킬을 점검할 수 있습니다.', partial: '일부 설치 위치의 점검이 제한되었습니다.',
    none: '남은 확인 사항이 없습니다', empty: '설치된 로컬 스킬이 없습니다', clean: '점검한 패키지에서 문제를 찾지 못했습니다',
    prev: '이전', next: '다음', locations: '선택한 작업공간', changes: '변경된 파일',
  }
} as const

const review = atom<SkillReviewReport | null>(null)
const status = atom<'idle' | 'loading' | 'error' | 'ready'>('idle')
const deferred = atom<[string, string][]>('traffic-light.review-deferred', [], { persist: 'workspace' })
const showDeferred = atom(false)
const screen = atom<'findings' | 'picker' | 'result'>('findings')
const focused = atom<Group | null>(null)
const focusedIds = atom<string[]>([])
const baseline = atom<string | undefined>(undefined)
const sourceStatus = atom<'idle' | 'loading' | 'changed'>('idle')
const page = atom(0)
const candidatePage = atom(0)
const pageSize = 6
let epoch = 0
let owner: string | null = null

export function resetSkillReview() {
  epoch++
  owner = null
  set(screen, 'findings'); set(focused, null); set(focusedIds, []); set(baseline, undefined); set(sourceStatus, 'idle')
  set(review, null); set(status, 'idle'); set(showDeferred, false); set(page, 0); set(candidatePage, 0)
  resetReviewAssistant(); resetSkillMaintenance()
}

export async function checkSkills(workspaceId: string | null, force = false): Promise<void> {
  if (!workspaceId || (owner === workspaceId && (read(status) === 'loading' || (!force && read(status) !== 'idle')))) return
  if (owner !== workspaceId) resetSkillReview()
  const request = ++epoch
  owner = workspaceId
  set(sourceStatus, 'idle')
  set(status, 'loading')
  try {
    const result = await plugin.request('toolbox.skillReview', { workspaceId }, { timeoutMs: 60000 })
    if (request !== epoch) return
    set(review, result); set(status, 'ready')
  } catch {
    if (request === epoch) { set(review, null); set(status, 'error') }
  }
}

function setAside(issue: SkillReviewFinding, undo: boolean) {
  const remaining = read(deferred).filter(([key]) => key !== issue.key)
  set(showDeferred, undo && remaining.some(([key, stamp]) => read(review)?.findings.some(f => f.key === key && f.stamp === stamp)))
  set(deferred, undo ? remaining : [...remaining, [issue.key, issue.stamp] as [string, string]].slice(-1024))
}

type Group = { name: string; findings: SkillReviewFinding[] }
function groupsFor(issues: SkillReviewFinding[]): Group[] {
  const groups = new Map<string, Group>()
  const sorted = [...issues].sort((a, b) => findingsOrder.indexOf(a.kind) - findingsOrder.indexOf(b.kind) ||
    a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
  for (const issue of sorted) {
    const key = issue.name.toLowerCase()
    const group = groups.get(key)
    if (group) group.findings.push(issue)
    else groups.set(key, { name: issue.name, findings: [issue] })
  }
  return [...groups.values()]
}

function sourceIds(issue: SkillReviewFinding): string[] {
  if (issue.removalCandidate) return [issue.removalCandidate.id, issue.removalCandidate.retainedId]
  if (issue.kind === 'variants' && issue.comparisonIds?.length === 2) return issue.comparisonIds
  const source = issue.ids.find(id => id !== issue.successorId)
  if (!source) return []
  if (issue.successorId) return [source, issue.successorId]
  if (issue.kind === 'variants' && issue.ids.length === 2) return issue.ids
  return [source]
}

type OpenSource = (issue: SkillReviewFinding) => Promise<void>

function Findings({ report, open }: { report: SkillReviewReport; open: (group: Group, issue?: SkillReviewFinding) => Promise<void> }) {
  const ko = panelLanguage(env.locale) === 'ko', t = ko ? labels.ko : labels.en
  const stamps = new Map(read(deferred))
  const pending = report.findings.filter(f => stamps.get(f.key) !== f.stamp)
  const deferredCount = report.findings.length - pending.length
  const isDeferred = read(showDeferred) && deferredCount > 0
  const shown = isDeferred ? report.findings.filter(f => stamps.get(f.key) === f.stamp) : pending
  const candidates = isDeferred ? [] : shown.filter(f => f.removalCandidate)
  const groups = groupsFor(shown.filter(f => isDeferred || !f.removalCandidate))
  const candidatePages = Math.ceil(candidates.length / pageSize)
  const currentCandidatePage = Math.max(0, Math.min(read(candidatePage), candidatePages - 1))
  const maxPage = Math.max(0, Math.ceil(groups.length / pageSize) - 1)
  const currentPage = Math.min(read(page), maxPage)
  const title = isDeferred ? t.deferred : groups.length ? (ko ? '확인할 스킬 ' + groups.length + '개' : englishCount(groups.length, 'skill') + ' to review')
    : !report.scanned ? t.empty : deferredCount || report.partial || report.skipped ? t.none : t.clean
  return <Stack gap="sm">
    {candidates.length ? <Stack gap="xs"><Heading level={2}>{ko ? '삭제 후보 ' + candidates.length + '개' : englishCount(candidates.length, 'removal candidate')}</Heading>
      <List label={ko ? '삭제 후보' : 'Removal candidates'}>{candidates.slice(currentCandidatePage * pageSize, (currentCandidatePage + 1) * pageSize).map(f =>
        <ListItem key={f.key} title={f.name} icon="file" description={(f.removalCandidate?.reason === 'duplicate' ? t.redundant : t.successor) + ' · ' + f.providers.map(p => ko && p === 'Shared' ? '공용' : p).join(' · ')}
          onPress={() => open({ name: f.name, findings: shown.filter(i => i.name.toLowerCase() === f.name.toLowerCase()) }, f)} />)}</List>
      {candidatePages > 1 ? <Row justify="between" align="center" gap="xs">
        <Button size="sm" variant="ghost" disabled={!currentCandidatePage} onPress={() => set(candidatePage, currentCandidatePage - 1)}>{t.prev}</Button>
        <Text size="xs" muted>{currentCandidatePage + 1} / {candidatePages}</Text>
        <Button size="sm" variant="ghost" disabled={currentCandidatePage + 1 === candidatePages} onPress={() => set(candidatePage, currentCandidatePage + 1)}>{t.next}</Button>
      </Row> : null}</Stack> : null}
    {groups.length || !candidates.length ? <Heading level={2}>{title}</Heading> : null}
    <Text size="xs" muted>{ko ? '설치본 ' + report.scanned + '개 검색 · 이번 점검 ' + report.checked + '개' :
      englishCount(report.scanned, 'package') + ' found · ' + report.checked + ' checked this time'}</Text>
    {report.skipped || report.partial ? <Text size="xs" tone="warning">{report.skipped ? (ko ? '점검 제외 ' + report.skipped + '개' : englishCount(report.skipped, 'package') + ' skipped') : t.partial}</Text> : null}
    {groups.length ? <List label={title}>{groups.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(group =>
      <ListItem key={group.name} icon="file" title={group.name} description={[...new Set(group.findings.map(f => t[f.kind]))].join(' · ')}
        onPress={() => open(group)} />)}</List> : null}
    {maxPage ? <Row justify="between" align="center" gap="xs"><Button size="sm" variant="ghost" disabled={!currentPage} onPress={() => set(page, currentPage - 1)}>{t.prev}</Button>
      <Text muted size="xs">{currentPage + 1} / {maxPage + 1}</Text><Button size="sm" variant="ghost" disabled={currentPage === maxPage} onPress={() => set(page, currentPage + 1)}>{t.next}</Button></Row> : null}
    {deferredCount ? <Row><Button size="sm" variant="ghost" onPress={() => { set(showDeferred, !isDeferred); set(page, 0) }}>
      {isDeferred ? t.back : t.deferred + ' · ' + deferredCount}</Button></Row> : null}
    {report.identicalGroups ? <Text muted size="xs">{ko ? '내용이 일치하는 원본 묶음 ' + report.identicalGroups + '개' : englishCount(report.identicalGroups, 'source group') + ' with matching copies'}</Text> : null}
  </Stack>
}

export function SkillReview({ workspaceId, items, selected, openSource, canOpen, onCheck, refreshing, loadFailed }: {
  workspaceId: string | null; items: CatalogItem[]; selected: string[]; onCheck: () => Promise<void>; refreshing: boolean; loadFailed: boolean; openSource: OpenSource; canOpen: (issue: SkillReviewFinding) => boolean
}) {
  const ko = panelLanguage(env.locale) === 'ko', t = ko ? labels.ko : labels.en
  const data = read(review), current = read(status), group = read(focused)
  function back() {
    closeSkillChange(); resetReviewAssistant(); set(sourceStatus, 'idle'); set(focused, null); set(screen, 'findings')
  }
  function pick(compareWith?: string) {
    resetReviewAssistant(); set(baseline, compareWith); set(focused, null); set(screen, 'picker')
  }
  async function inspect(ids: string[], group?: Group) {
    if (!workspaceId) return
    set(focused, group ?? null); set(focusedIds, ids); set(sourceStatus, 'idle'); set(screen, 'result')
    if (ids.length) await inspectSelection(workspaceId, ids)
    else resetReviewAssistant()
  }
  function openGroup(group: Group, chosen?: SkillReviewFinding) {
    const issue = chosen ?? group.findings.find(f => f.kind === 'successor') ?? group.findings.find(f => f.kind === 'variants') ?? group.findings[0]
    return inspect(sourceIds(issue), group)
  }
  async function showSource(issue: SkillReviewFinding) {
    if (read(sourceStatus) === 'loading') return
    const request = epoch
    set(sourceStatus, 'loading')
    try { await openSource(issue); if (request === epoch) set(sourceStatus, 'idle') }
    catch { if (request === epoch) set(sourceStatus, 'changed') }
  }
  function actions() {
    if (!workspaceId) return null
    const stamps = new Map(read(deferred))
    const activeIds = read(focusedIds)
    const findings = group?.findings ?? data?.findings.filter(f => f.ids.some(id => activeIds.includes(id))) ?? []
    const presented = findings.filter(f => activeIds.length ? f.ids.some(id => activeIds.includes(id)) : !f.ids.length)
    const otherCopies = findings.filter(f => !presented.includes(f))
    const isDeferred = presented.every(f => stamps.get(f.key) === f.stamp)
    return <Stack gap="xs">
      <ChangeButtons workspaceId={workspaceId} items={items} targets={activeIds.flatMap(id => items.filter(i => i.kind === 'skill' && i.id === id))}
        findings={presented} candidate={presented.find(f => f.removalCandidate?.id === activeIds[0])} />
      {otherCopies.length ? <List label={ko ? '같은 이름의 다른 설치본' : 'Other installations with this name'}>{otherCopies.map(f =>
        <ListItem key={f.key} title={t[f.kind]} description={f.providers.join(' · ')} onPress={() => inspect(sourceIds(f), group ?? undefined)} />
      )}</List> : null}
      {presented.filter(f => !['excluded', 'successor', 'missing', 'redundant'].includes(f.kind)).map(f => <Stack gap="xs" key={f.key}>
        {f.workspaceCount !== undefined && ['update', 'conflict', 'variants'].includes(f.kind) ?
          <Text muted size="xs">{ko ? t.locations + ' ' + f.workspaceCount + '곳' : t.locations + ' ' + englishCount(f.workspaceCount, 'workspace')}</Text> : null}
        {canOpen(f) && !isDeferred ? <Row><Button size="sm" variant="outline" disabled={read(sourceStatus) === 'loading'} onPress={() => showSource(f)}>
          {f.kind === 'update' ? t.updateAction : f.kind === 'provider' ? t.providerAction : t.sources}</Button></Row> : null}
      </Stack>)}
      {read(sourceStatus) === 'changed' ? <Text tone="warning" size="sm">{ko ? '원본이 바뀌었을 수 있습니다. 목록에서 다시 점검해 주세요.' : 'The source may have changed. Check again from the list.'}</Text> : null}
      {presented.length ? <Row><Button size="sm" variant="ghost" onPress={() => { for (const issue of presented) setAside(issue, isDeferred); back() }}>
        {isDeferred ? t.restore : t.defer}</Button></Row> : null}
    </Stack>
  }
  async function afterChange() {
    resetReviewAssistant(); set(focused, null); set(focusedIds, []); set(screen, 'findings'); set(page, 0)
    await onCheck()
  }
  if (workspaceId && hasSkillChange()) return <ChangeForm onDone={afterChange} />
  if (workspaceId && read(screen) !== 'findings') return <Stack gap="sm">
    <Row><Button size="sm" variant="ghost" onPress={back}>{ko ? '점검 목록으로' : 'Back to findings'}</Button></Row>
    {read(screen) === 'picker' ? <SkillPicker items={items} compareWith={read(baseline)} onPick={ids => inspect(ids)} /> :
      group && !read(focusedIds).length ? <Stack gap="sm"><Heading level={2}>{group.name}</Heading>
        {group.findings.filter(f => !f.ids.length).map(f => <Text size="sm" key={f.key}>{f.evidence.map(reason => (t as Record<string, string>)[reason] ?? reason).join(' · ')}</Text>)}
        {actions()}</Stack> : <InspectionResult workspaceId={workspaceId} items={items} onCompare={pick} actions={actions()} />}
  </Stack>
  return <Stack gap="sm">
    {workspaceId ? <Row justify="between" align="center" wrap gap="xs">
      <Button size="sm" variant="outline" icon="search" disabled={refreshing || loadFailed || !items.some(item => item.kind === 'skill')} onPress={() => pick()}>{ko ? '스킬 직접 선택' : 'Choose a skill'}</Button>
      {data && current === 'ready' && !refreshing && !loadFailed ? <Button size="sm" variant="ghost" icon="refresh" onPress={onCheck}>{t.rescan}</Button> : null}</Row> : null}
    {!workspaceId ? <EmptyState icon="folder" title={t.choose} /> : current === 'loading' || refreshing ? <Text size="sm" muted>{t.loading}</Text>
      : current === 'error' || loadFailed ? <Callout tone="warning"><Text size="sm">{t.error}</Text><Button size="sm" onPress={onCheck}>{t.rescan}</Button></Callout>
      : data ? <Findings report={data} open={openGroup} /> : <Button size="sm" variant="outline" onPress={onCheck}>{t.start}</Button>}
    {workspaceId ? <ChangeHistory workspaceId={workspaceId} onDone={afterChange} /> : null}
    {workspaceId ? <RecommendationPreviewPanel items={items} selected={selected} workspaceId={workspaceId} /> : null}
  </Stack>
}
