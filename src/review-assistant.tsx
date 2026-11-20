import { atom, Box, Button, Callout, CodeView, Collapsible, env, Heading, Input, List, ListItem, plugin, read, Row, Select, set, Stack, Text, Textarea, type OrcaNode } from 'orca'
import { panelLanguage } from './panel-language'
import type { CatalogItem, PreviewRanking, RecommendationPreview, SkillAnalysis, SkillInspection } from './toolbox-types'
import './protocol'

const lang = () => panelLanguage(env.locale)
const ko = () => lang() === 'ko'
const none = 'tl-no-selection'
const ids = atom<string[]>([])
const inspection = atom<SkillInspection | null>(null)
const status = atom<'idle' | 'loading' | 'ready' | 'error'>('idle')
const filter = atom('')
const offset = atom(0)
const busy = atom<'ai' | 'copy' | null>(null)
const ai = atom<SkillAnalysis | null>(null)
const aiOpen = atom(false)
const evidenceOpen = atom(false)
const extraError = atom(false)
const receipt = atom<{ copied: boolean; prompt: string } | null>(null)
let sequence = 0

const previewOpen = atom(false)
const draft = atom({ query: '', editId: '', description: '' })
const preview = atom<RecommendationPreview | null>(null)
const previewState = atom<'idle' | 'loading' | 'error'>('idle')
let previewSequence = 0

function resetPreview() {
  previewSequence++
  set(previewOpen, false); set(previewState, 'idle'); set(preview, null)
  set(draft, { query: '', editId: '', description: '' })
}
export function resetReviewAssistant() {
  sequence++
  set(ids, []); set(inspection, null); set(status, 'idle'); set(filter, ''); set(offset, 0)
  set(busy, null); set(ai, null); set(aiOpen, false); set(evidenceOpen, false); set(extraError, false); set(receipt, null)
  resetPreview()
}

export async function inspectSelection(workspaceId: string, selected: string[]) {
  resetReviewAssistant()
  set(ids, selected); set(status, 'loading')
  const key = sequence
  try {
    const result = await plugin.request('toolbox.inspectSkills', { workspaceId, ids: selected, language: lang() }, { timeoutMs: 30000 })
    if (key === sequence) { set(inspection, result); set(status, 'ready') }
  } catch {
    if (key === sequence) set(status, 'error')
  }
}

function providerNames(skill: { providers: string[] }) {
  return skill.providers.map(provider => provider === 'Shared' && ko() ? '공용' : provider).join(' · ')
}

export function SkillPicker({ items, compareWith, onPick }: {
  items: CatalogItem[]; compareWith?: string; onPick: (ids: string[]) => Promise<void>
}) {
  const term = read(filter).trim().toLocaleLowerCase()
  const original = items.find(item => item.id === compareWith)
  const matches = items.filter(item => item.kind === 'skill' && item.id !== compareWith &&
    (item.name + ' ' + providerNames(item)).toLocaleLowerCase().includes(term))
  const start = Math.min(read(offset), Math.max(0, Math.floor((matches.length - 1) / 6) * 6))
  const title = original ? (ko() ? '비교할 스킬 선택' : 'Choose a skill to compare') : (ko() ? '검토할 스킬 선택' : 'Choose a skill to review')
  return <Stack gap="sm">
    <Heading level={2}>{title}</Heading>
    {original ? <Text size="sm" muted>{(ko() ? '비교 기준 · ' : 'Compare with · ') + original.name + ' · ' + providerNames(original)}</Text> : null}
    <Input label={ko() ? '스킬 검색' : 'Search skills'} labelHidden type="search" maxLength={100}
      placeholder={ko() ? '스킬 이름 또는 제공자 검색' : 'Search by skill or provider'} value={read(filter)} onChange={value => { set(filter, value); set(offset, 0) }} />
    {matches.length ? <List label={title}>{matches.slice(start, start + 6).map(item => <ListItem key={item.id} title={item.name}
      description={providerNames(item)} icon="file" onPress={() => onPick(compareWith ? [compareWith, item.id] : [item.id])} />)}</List>
      : <Text size="sm" muted>{ko() ? '일치하는 스킬이 없습니다.' : 'No matching skills.'}</Text>}
    {matches.length > 6 ? <Row justify="between" align="center" wrap>
      <Button variant="ghost" size="sm" disabled={!start} onPress={() => set(offset, start - 6)}>{ko() ? '이전' : 'Previous'}</Button>
      <Text muted size="xs">{(start + 1) + '–' + Math.min(start + 6, matches.length) + ' / ' + matches.length}</Text>
      <Button variant="ghost" size="sm" disabled={start + 6 >= matches.length} onPress={() => set(offset, start + 6)}>{ko() ? '다음' : 'Next'}</Button>
    </Row> : null}
  </Stack>
}

async function extraAnalysis(workspaceId: string, action: 'ai' | 'copy') {
  if (read(busy)) return
  const key = sequence, input = { workspaceId, ids: read(ids), language: lang() }
  set(busy, action); set(extraError, false)
  try {
    if (action === 'ai') {
      const result = await plugin.request('toolbox.reviewSkills', input, { timeoutMs: 115000 })
      if (key === sequence) set(ai, result)
    } else {
      const result = await plugin.request('toolbox.copySkillReview', input)
      if (key === sequence) set(receipt, result)
    }
  } catch { if (key === sequence) set(extraError, true) }
  finally { if (key === sequence) set(busy, null) }
}

function AIOptions({ workspaceId }: { workspaceId: string }) {
  const result = read(ai), copied = read(receipt), waiting = read(busy)
  return <Collapsible title={ko() ? 'AI 추가 분석' : 'Additional AI analysis'} open={read(aiOpen)} onChange={open => set(aiOpen, open)}>
    <Stack gap="xs">
      <Row wrap gap="xs">
        <Button size="sm" variant="outline" disabled={!!waiting} onPress={() => extraAnalysis(workspaceId, 'ai')}>
          {waiting === 'ai' ? (ko() ? '분석 중…' : 'Analyzing…') : (ko() ? '로컬 AI로 분석' : 'Analyze with local AI')}</Button>
        <Button size="sm" variant="ghost" disabled={!!waiting} onPress={() => extraAnalysis(workspaceId, 'copy')}>
          {copied?.copied ? (ko() ? '요청 복사됨' : 'Request copied') : (ko() ? '에이전트용 요청 복사' : 'Copy agent request')}</Button>
      </Row>
      {result?.status === 'ready' ? <Stack gap="xs"><Text size="xs" muted>{(result.method === 'decision' ? (ko() ? 'AI가 고른 근거 구간 · ' : 'AI-selected passages · ') : (ko() ? 'AI 분석 · ' : 'AI assessment · ')) + result.model}</Text>
        <Text size="sm">{result.text}</Text>
        {result.truncated ? <Text size="xs" muted>{ko() ? '본문 또는 응답의 일부만 분석했습니다.' : 'The input or response was shortened.'}</Text> : null}</Stack> : null}
      {result?.status === 'unavailable' ? <Text size="sm" muted>{ko() ? '로컬 AI를 사용할 수 없습니다. 다른 대화에서 분석하려면 요청을 복사하세요.' : 'Local AI is unavailable. Copy the request to use it in another conversation.'}</Text> : null}
      {copied && !copied.copied ? <CodeView label={ko() ? '직접 복사할 요청' : 'Request to copy'} code={copied.prompt} wrap maxHeight="md" /> : null}
      {read(extraError) ? <Text tone="warning" size="sm">{ko() ? '추가 분석 요청을 마치지 못했습니다. 다시 시도해 주세요.' : 'The additional request failed. Try again.'}</Text> : null}
    </Stack>
  </Collapsible>
}

export function InspectionResult({ workspaceId, items, onCompare, actions }: {
  workspaceId: string; items: CatalogItem[]; onCompare: (id: string) => void; actions?: OrcaNode
}) {
  const result = read(inspection), selected = read(ids), state = read(status)
  if (state === 'loading') return <Text muted size="sm">{ko() ? '설치 파일을 확인하는 중…' : 'Checking installed files…'}</Text>
  if (!result) return <Stack gap="sm"><Callout tone="warning"><Stack gap="xs">
    <Text size="sm">{ko() ? '검토 결과를 읽을 수 없습니다. 설치본이 바뀌었을 수 있습니다.' : 'Could not read this review. The installation may have changed.'}</Text>
    <Button size="sm" variant="outline" onPress={() => inspectSelection(workspaceId, selected)}>{ko() ? '검토 다시 시도' : 'Retry review'}</Button>
  </Stack></Callout>{actions}</Stack>
  const pair = result.skills.length === 2
  const known = selected.every(id => items.some(item => item.id === id && item.kind === 'skill'))
  const evidenceRow = (row: SkillInspection['evidence'][number], index: number) => <Stack gap="none" key={index}>
    <Text weight="semibold" size="sm">{row.label}</Text><Text size="sm">{row.detail}</Text>
    {row.source ? <Text muted size="xs">{row.source}</Text> : null}
  </Stack>
  return <Stack gap="sm">
    <Heading level={2}>{pair ? (ko() ? '스킬 비교 결과' : 'Skill comparison') : result.skills[0]?.name || (ko() ? '스킬 검토 결과' : 'Skill review result')}</Heading>
    {result.skills.map(skill => <Text key={skill.id} size="xs" muted>{(pair ? skill.name + ' · ' : '') + providerNames(skill)}</Text>)}
    <Text size="sm" weight="semibold">{result.summary}</Text>
    <Box direction="column" background="muted" padding="sm" radius="sm" gap="xs">
      <Text size="xs" weight="semibold">{ko() ? '권장 조치' : 'Suggested action'}</Text><Text size="sm">{result.nextStep}</Text>
    </Box>
    {result.evidence.length ? <Stack gap="sm"><Text weight="semibold" size="sm">{ko() ? '확인 근거' : 'Evidence'}</Text>
      {result.evidence.slice(0, 3).map(evidenceRow)}
      {result.evidence.length > 3 ? <Collapsible title={ko() ? '근거 ' + (result.evidence.length - 3) + '개 더 보기' : 'More evidence · ' + (result.evidence.length - 3)}
        open={read(evidenceOpen)} onChange={open => set(evidenceOpen, open)}>
        <Stack gap="sm">{result.evidence.slice(3).map(evidenceRow)}</Stack>
      </Collapsible> : null}</Stack> : null}
    {actions}
    {!pair && known && items.some(item => item.kind === 'skill' && item.id !== selected[0]) ?
      <Row><Button size="sm" variant="outline" onPress={() => onCompare(selected[0])}>{ko() ? '다른 스킬과 비교' : 'Compare another skill'}</Button></Row> : null}
    {known ? <AIOptions workspaceId={workspaceId} /> : null}
  </Stack>
}

function rankText(rank: PreviewRanking) {
  return (rank.names.join(' → ') || (ko() ? '일치 항목 없음' : 'No matches')) + ' · ' +
    (rank.method === 'kev' ? 'Jev' : ko() ? '키워드' : 'Keywords')
}

export function RecommendationPreviewPanel({ items, selected, workspaceId }: {
  items: CatalogItem[]; selected: string[]; workspaceId: string
}) {
  const current = read(draft), waiting = read(previewState) === 'loading', result = read(preview)
  const eligible = items.filter(i => selected.includes(i.id) && i.available && !i.providerOnly && !['update', 'conflict'].includes(i.sharing?.state ?? ''))
  function change(values: Partial<typeof current>) {
    previewSequence++; set(preview, null); set(previewState, 'idle'); set(draft, { ...current, ...values })
  }
  async function find() {
    const key = ++previewSequence
    set(preview, null); set(previewState, 'loading')
    try {
      const edit = current.editId ? { edit: { id: current.editId, description: current.description } } : {}
      const found = await plugin.request('toolbox.previewSkills', { workspaceId, query: current.query, ...edit }, { timeoutMs: 60000 })
      if (key === previewSequence) set(preview, found)
    } catch { if (key === previewSequence) set(previewState, 'error') }
    finally { if (key === previewSequence && read(previewState) === 'loading') set(previewState, 'idle') }
  }
  const title = ko() ? '추천 미리보기' : 'Preview recommendations'
  return <Collapsible title={title} open={read(previewOpen)} onChange={open => { if (open) set(previewOpen, true); else resetPreview() }}>
    {eligible.length ? <Stack gap="xs">
      <Input label={ko() ? '예시 요청' : 'Example task'} placeholder={ko() ? '이 PR의 권한 누락을 찾아줘' : 'Check this PR for missing permissions'}
        maxLength={256} value={current.query} onChange={query => change({ query })} disabled={waiting} />
      <Select label={ko() ? '설명 변경 시뮬레이션' : 'Try a different description'} options={[{ value: none, label: ko() ? '현재 설명 사용' : 'Use current descriptions' },
        ...eligible.filter(i => i.kind === 'skill').map(i => ({ value: i.id, label: i.name }))]} value={current.editId || none} disabled={waiting}
        onChange={id => change({ editId: id === none ? '' : id, description: items.find(i => i.id === id)?.description.slice(0, 240) ?? '' })} />
      {current.editId ? <Textarea label={ko() ? '임시 설명' : 'Draft description'} rows={2} maxLength={240} value={current.description} disabled={waiting}
        onChange={description => change({ description })} /> : null}
      <Row><Button size="sm" variant="outline" disabled={waiting || !current.query.trim() || !!current.editId && !current.description.trim()} onPress={find}>
        {waiting ? (ko() ? '추천 확인 중…' : 'Checking matches…') : (ko() ? '추천 확인' : 'Find matches')}</Button></Row>
      {result ? <Stack gap="xs"><Text size="sm">{(ko() ? '현재 설명 · ' : 'Current · ') + rankText(result.before)}</Text>
        {result.after ? <Text size="sm">{(ko() ? '임시 설명 · ' : 'Draft · ') + rankText(result.after)}</Text> : null}</Stack> : null}
      {read(previewState) === 'error' ? <Text size="sm" tone="warning">{ko() ? '추천을 확인하지 못했습니다. 다시 시도해 주세요.' : 'Could not load recommendations. Try again.'}</Text> : null}
    </Stack> : <Text size="sm" muted>{ko() ? '공용 도구에서 이 작업공간에 사용할 스킬이나 MCP를 먼저 선택하세요.' : 'Choose a skill or MCP server in the Library for this workspace first.'}</Text>}
  </Collapsible>
}
