import { atom, Box, Button, Callout, Collapsible, EmptyState, env, Heading, plugin, read, Row, Separator, set, Stack, Text } from 'orca'
import { englishCount, panelLanguage } from './panel-language'
import { ReviewAssistant, openSkillComparison, resetReviewAssistant } from './review-assistant'
import type { CatalogItem, SkillReviewFinding, SkillReviewReport } from './toolbox-types'
import './protocol'

const findingsOrder: SkillReviewFinding['kind'][] = ['conflict', 'missing', 'update', 'variants', 'successor', 'provider', 'excluded']
const labels = {
  en: {
    conflict: 'Shared copy conflict', missing: 'Missing package file', update: 'Shared update available',
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
    conflict: '공용본 충돌', missing: '참조 파일 누락', update: '공용본 업데이트', variants: '원본 파일 차이', successor: '후속 스킬 안내',
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
const comparing = atom(false)
const sourceStatus = atom<'idle' | 'loading' | 'changed'>('idle')
const expanded = atom<string | null>(null)
const page = atom(0)
const pageSize = 6
let epoch = 0
let owner: string | null = null

export function resetSkillReview() {
  epoch++
  owner = null
  set(comparing, false); set(sourceStatus, 'idle')
  set(review, null); set(status, 'idle'); set(showDeferred, false); set(expanded, null); set(page, 0)
  resetReviewAssistant()
}

export async function checkSkills(workspaceId: string | null, force = false): Promise<void> {
  if (!workspaceId || (owner === workspaceId && (read(status) === 'loading' || (!force && read(status) !== 'idle')))) return
  if (owner !== workspaceId) resetSkillReview()
  const request = ++epoch
  owner = workspaceId
  set(sourceStatus, 'idle')
  set(status, 'loading')
  try {
    const result = await plugin.request('toolbox.skillReview', { workspaceId })
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

type OpenSource = (issue: SkillReviewFinding) => Promise<void>
function Evidence({ issue, isDeferred, openSource, canOpen, items }: {
  issue: SkillReviewFinding; isDeferred: boolean; openSource: OpenSource; canOpen: boolean; items: CatalogItem[]
}) {
  const ko = panelLanguage(env.locale) === 'ko', t = ko ? labels.ko : labels.en
  const providers = issue.providers.map(p => p === 'Shared' ? (ko ? '공용' : 'Shared') : p).join(' · ')
  const reasonLabels: Record<string, string> = t
  const remainingEvidence = Math.max(0, (issue.evidenceCount ?? issue.evidence.length) - issue.evidence.length)
  const paths = issue.kind === 'variants' || issue.kind === 'update' || issue.kind === 'missing'
  return <Stack gap="xs">
    {providers ? <Text size="xs" muted>{providers}</Text> : null}
    {issue.requirement ? <Stack gap="none"><Text size="xs" muted>{issue.requirement.file + (issue.requirement.line ? ' · ' + (ko ? issue.requirement.line + '행' : 'line ' + issue.requirement.line) : '')}</Text><Text size="sm">{issue.requirement.field}</Text></Stack> : null}
    {issue.kind === 'successor' && issue.line ? <Text muted size="xs">{ko ? 'SKILL.md ' + issue.line + '행의 권장 스킬' : 'Recommended in SKILL.md line ' + issue.line}</Text> : null}
    {paths && issue.evidence.length && issue.kind !== 'missing' ? <Text size="xs" weight="semibold">{t.changes}</Text> : null}
    {issue.evidence.map((evidence, i) => {
      const line = issue.kind === 'missing' ? issue.lines?.[i] ?? (i === 0 ? issue.line : undefined) : undefined
      const detail = issue.evidenceDetails?.find(entry => entry.path === evidence)
      const sourceIds = detail?.ids ?? []
      const copies = [...new Set(items.filter(item => sourceIds.includes(item.id)).flatMap(item => item.providers))]
        .map(p => p === 'Shared' && ko ? '공용' : p)
      const change = detail?.state === 'only' ? (copies.length ? (ko ? copies.join(' · ') + ' 원본에만 있음' : 'Only in ' + copies.join(' · ')) : ko ? '일부 원본에만 있음' : 'Present in some copies') :
        detail ? (ko ? { added: '추가', removed: '제거', changed: '변경' } : { added: 'Added', removed: 'Removed', changed: 'Changed' })[detail.state] : undefined
      return <Stack key={i} gap="none">
        {line ? <Text muted size="xs">{ko ? 'SKILL.md ' + line + '행에서 참조' : 'Referenced at SKILL.md line ' + line}</Text> : null}
        <Text size="sm">{paths ? evidence : reasonLabels[evidence] ?? evidence}</Text>
        {change ? <Text size="xs" muted>{change}</Text> : null}
      </Stack>
    })}
    {remainingEvidence ? <Text size="xs" muted>{ko ? '추가 파일 ' + remainingEvidence + '개' : englishCount(remainingEvidence, 'additional file')}</Text> : null}
    {issue.workspaceCount !== undefined && ['update', 'conflict', 'variants'].includes(issue.kind)
      ? <Text size="xs" muted>{ko ? t.locations + ' ' + issue.workspaceCount + '곳' : t.locations + ' ' + englishCount(issue.workspaceCount, 'workspace')}</Text> : null}
    <Row gap="xs" wrap>
      {canOpen && !isDeferred ? <Button size="sm" variant="outline" onPress={() => openSource(issue)}>{issue.kind === 'successor' ? (ko ? '두 스킬 비교' : 'Compare these skills') : issue.kind === 'missing' ? (ko ? '이 스킬 검토' : 'Review this skill') : issue.kind === 'update' ? t.updateAction : issue.kind === 'provider' ? t.providerAction : t.sources}</Button> : null}
      <Button size="sm" variant="ghost" onPress={() => setAside(issue, isDeferred)}>{isDeferred ? t.restore : t.defer}</Button>
    </Row>
  </Stack>
}

function Findings({ report, openSource, canOpen, items }: {
  report: SkillReviewReport; openSource: OpenSource; canOpen: (issue: SkillReviewFinding) => boolean; items: CatalogItem[]
}) {
  const ko = panelLanguage(env.locale) === 'ko', t = ko ? labels.ko : labels.en
  const stamps = new Map(read(deferred))
  const pending = report.findings.filter(f => stamps.get(f.key) !== f.stamp)
  const deferredCount = report.findings.length - pending.length
  const isDeferred = read(showDeferred) && deferredCount > 0
  const groups = groupsFor(isDeferred ? report.findings.filter(f => stamps.get(f.key) === f.stamp) : pending)
  const maxPage = Math.max(0, Math.ceil(groups.length / pageSize) - 1)
  const currentPage = Math.min(read(page), maxPage)
  const rows = groups.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  function changeList() { set(showDeferred, !isDeferred); set(expanded, null); set(page, 0) }
  const title = isDeferred ? t.deferred : groups.length ? (ko ? '확인할 스킬 ' + groups.length + '개' : englishCount(groups.length, 'skill') + ' to review')
    : !report.scanned ? t.empty : deferredCount || report.partial || report.skipped ? t.none : t.clean
  return <Stack gap="sm">
    <Stack gap="xs">
      <Heading level={2}>{title}</Heading>
      <Text size="xs" muted>{ko ? '발견 ' + report.scanned + '개 · 이번 점검 ' + report.checked + '개' : englishCount(report.scanned, 'package') + ' found · ' + report.checked + ' checked this time'}</Text>
      {report.skipped || report.partial ? <Text size="xs" tone="warning">{report.skipped ? (ko ? '점검 제외 ' + report.skipped + '개' : englishCount(report.skipped, 'package') + ' skipped') : t.partial}</Text> : null}
    </Stack>
    {rows.length ? <Box direction="column" border radius="sm">{rows.map((group, index) => {
      const key = group.name.toLowerCase(), kinds = [...new Set(group.findings.map(f => f.kind))]
      return <Stack key={key} gap="none">
        {index ? <Separator /> : null}
        <Box direction="column" padding="xs"><Collapsible title={group.name} description={kinds.map(kind => t[kind]).join(' · ')}
          open={read(expanded) === key} onChange={open => set(expanded, open ? key : null)}>
          <Box direction="column" padding="sm" gap="sm" radius="sm" background="muted">{group.findings.map((issue, i) => <Stack key={issue.key} gap="xs">
            {i ? <Separator /> : null}
            {group.findings.length > 1 ? <Text size="sm" weight="semibold">{t[issue.kind]}</Text> : null}
            <Evidence issue={issue} isDeferred={isDeferred} openSource={openSource} items={items} canOpen={canOpen(issue)} />
          </Stack>)}</Box>
        </Collapsible></Box>
      </Stack>
    })}</Box> : null}
    {maxPage ? <Row justify="between" align="center" gap="xs"><Button size="sm" variant="ghost" disabled={!currentPage} onPress={() => set(page, currentPage - 1)}>{t.prev}</Button>
      <Text muted size="xs">{currentPage + 1} / {maxPage + 1}</Text><Button size="sm" variant="ghost" disabled={currentPage === maxPage} onPress={() => set(page, currentPage + 1)}>{t.next}</Button></Row> : null}
    {deferredCount ? <Row><Button size="sm" variant="ghost" onPress={changeList}>{isDeferred ? t.back : t.deferred + ' · ' + deferredCount}</Button></Row> : null}
    {report.identicalGroups ? <Text muted size="xs">{ko ? '내용이 일치하는 원본 묶음 ' + report.identicalGroups + '개' : englishCount(report.identicalGroups, 'source group') + ' with matching copies'}</Text> : null}
  </Stack>
}

export function SkillReview({ workspaceId, items, selected, openSource, canOpen, onBack, onCheck, refreshing, loadFailed }: {
  workspaceId: string | null; items: CatalogItem[]; selected: string[]; onBack: () => void; onCheck: () => Promise<void>; refreshing: boolean; loadFailed: boolean; openSource: OpenSource; canOpen: (issue: SkillReviewFinding) => boolean
}) {
  const ko = panelLanguage(env.locale) === 'ko', t = ko ? labels.ko : labels.en
  const data = read(review), current = read(status)
  async function compareOrOpen(issue: SkillReviewFinding) {
    if (issue.kind !== 'missing' && issue.kind !== 'successor') {
      if (read(sourceStatus) === 'loading') return
      const request = epoch
      set(sourceStatus, 'loading')
      try { await openSource(issue); if (request === epoch) set(sourceStatus, 'idle') }
      catch { if (request === epoch) set(sourceStatus, 'changed') }
      return
    }
    const original = issue.ids.find(id => id !== issue.successorId && items.some(item => item.kind === 'skill' && item.id === id))
    if (!original) return
    openSkillComparison(issue.successorId ? [original, issue.successorId] : [original])
    set(comparing, true)
  }
  if (read(comparing) && workspaceId) return <Stack gap="sm">
    <Row><Button size="sm" variant="ghost" onPress={() => { set(comparing, false); resetReviewAssistant() }}>{ko ? '점검 결과로' : 'Back to findings'}</Button></Row>
    <ReviewAssistant workspaceId={workspaceId} items={items} selected={selected} />
  </Stack>
  return <Stack gap="sm">
    <Row justify="between" align="center" gap="xs" wrap>
      <Button size="sm" variant="ghost" icon="blocks" onPress={onBack}>{ko ? '공용 도구로' : 'Back to library'}</Button>
      {data && current === 'ready' && !refreshing && !loadFailed ? <Button size="sm" variant="ghost" icon="refresh" onPress={onCheck}>{t.rescan}</Button> : null}
    </Row>
    {read(sourceStatus) === 'changed' ? <Text tone="warning" size="sm">{ko ? '원본을 열 수 없습니다. 다시 점검해 주세요.' : 'This source could not be opened. Check again to refresh it.'}</Text> : null}
    {read(sourceStatus) === 'loading' ? <Text muted size="xs">{ko ? '원본 확인 중…' : 'Opening sources…'}</Text> : null}
    {!workspaceId ? <EmptyState icon="folder" title={t.choose} /> : current === 'loading' || refreshing ? <Text size="sm" muted>{t.loading}</Text>
      : current === 'error' || loadFailed ? <Callout tone="warning"><Text size="sm">{t.error}</Text><Button size="sm" onPress={onCheck}>{t.rescan}</Button></Callout>
      : data ? <Findings report={data} items={items} openSource={compareOrOpen} canOpen={issue => {
        if (issue.kind === 'missing' || issue.kind === 'successor') {
          const isSkill = (id: string) => items.some(item => item.kind === 'skill' && item.id === id)
          return issue.ids.some(id => id !== issue.successorId && isSkill(id)) && (issue.kind === 'missing' || !!issue.successorId && isSkill(issue.successorId))
        }
        return canOpen(issue)
      }} />
      : <Button size="sm" variant="outline" onPress={onCheck}>{t.start}</Button>}
    {workspaceId ? <ReviewAssistant workspaceId={workspaceId} items={items} selected={selected} /> : null}
  </Stack>
}
