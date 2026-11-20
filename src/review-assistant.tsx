import { atom, Button, CodeView, Collapsible, env, Input, plugin, read, Row, Select, set, Stack, Text, Textarea } from 'orca'
import { panelLanguage } from './panel-language'
import type { CatalogItem, PreviewRanking, RecommendationPreview, SkillAnalysis } from './toolbox-types'
import './protocol'

type Receipt = { copied: boolean; prompt: string }
type Draft = { query: string; editId: string; description: string; filter: string; first: string; second: string }
const none = 'tl-no-selection'
const empty: Draft = { query: '', editId: '', description: '', filter: '', first: '', second: '' }
const draft = atom<Draft>(empty)
const mode = atom<'preview' | 'review'>('preview')
const open = atom(false)
const busy = atom<'preview' | 'review' | 'copy' | null>(null)
const failed = atom(false)
const preview = atom<RecommendationPreview | null>(null)
const outcome = atom<SkillAnalysis | null>(null)
const receipt = atom<Receipt | null>(null)
let sequence = 0

function clearResults() {
  sequence++
  set(busy, null); set(failed, false); set(preview, null); set(outcome, null); set(receipt, null)
}

export function resetReviewAssistant() {
  clearResults(); set(draft, empty); set(mode, 'preview'); set(open, false)
}

export function openSkillComparison(ids: string[]) {
  const [first = '', second = ''] = [...new Set(ids)].slice(0, 2)
  resetReviewAssistant()
  set(draft, { ...empty, first, second }); set(mode, 'review'); set(open, true)
}

function change(values: Partial<Draft>) {
  set(draft, { ...read(draft), ...values }); clearResults()
}

async function request(action: 'preview' | 'review' | 'copy', workspaceId: string) {
  if (read(busy)) return
  const current = read(draft), key = ++sequence, language = panelLanguage(env.locale)
  set(busy, action); set(failed, false); set(receipt, null)
  try {
    if (action === 'preview') {
      set(preview, null)
      const edit = current.editId ? { id: current.editId, description: current.description } : undefined
      const result = await plugin.request('toolbox.previewSkills', { workspaceId, query: current.query, ...(edit ? { edit } : {}) }, { timeoutMs: 60000 })
      if (key === sequence) set(preview, result)
    } else {
      const ids = [current.first, current.second].filter(Boolean)
      if (action === 'review') {
        set(outcome, null)
        const result = await plugin.request('toolbox.reviewSkills', { workspaceId, ids, language }, { timeoutMs: 115000 })
        if (key === sequence) set(outcome, result)
      } else {
        const result = await plugin.request('toolbox.copySkillReview', { workspaceId, ids, language })
        if (key === sequence) set(receipt, result)
      }
    }
  } catch { if (key === sequence) set(failed, true) }
  finally { if (key === sequence) set(busy, null) }
}

function rankText(rank: PreviewRanking, ko: boolean) {
  const names = rank.names.join(' → ') || (ko ? '일치 항목 없음' : 'No matches')
  return names + ' · ' + (rank.method === 'kev' ? 'Jev' : ko ? '키워드' : 'Keywords')
}

const optionsFor = (items: CatalogItem[], duplicateNames?: Set<string>) => items.map(item => ({
  value: item.id, label: duplicateNames?.has(item.name) ? item.name + ' · ' + item.providers.join(', ') : item.name
}))

export function ReviewAssistant({ items, selected, workspaceId }: { items: CatalogItem[]; selected: string[]; workspaceId: string | null }) {
  const ko = panelLanguage(env.locale) === 'ko'
  const title = ko ? '추천 · 심층 검토' : 'Preview & review'
  if (!read(open) || !workspaceId) return <Collapsible title={title} open={false} disabled={!workspaceId} onChange={value => set(open, value)} />
  const current = read(draft), active = read(mode), waiting = read(busy)
  const skills = items.filter(i => i.kind === 'skill')
  const eligible = items.filter(i => selected.includes(i.id) && i.available && !i.providerOnly && !['update', 'conflict'].includes(i.sharing?.state ?? ''))
  const names = new Set<string>(), duplicateNames = new Set<string>()
  for (const skill of skills) { if (names.has(skill.name)) duplicateNames.add(skill.name); names.add(skill.name) }
  const matching = skills.filter(i => (i.name + ' ' + i.providers.join(' ')).toLowerCase().includes(current.filter.trim().toLowerCase()))
  const shown = matching.slice(0, 20)
  const selectedOption = (id: string) => {
    const skill = skills.find(i => i.id === id)
    return skill && !shown.includes(skill) ? [skill, ...shown] : shown
  }
  const firstValid = skills.some(i => i.id === current.first)
  const secondValid = !current.second || skills.some(i => i.id === current.second && i.id !== current.first)
  const result = read(preview), review = read(outcome), copied = read(receipt)
  const blank = (label: string) => ({ value: none, label })
  function switchMode(next: 'preview' | 'review') { if (active !== next) { clearResults(); set(mode, next) } }
  return <Collapsible title={title} open onChange={value => { if (!value) resetReviewAssistant() }}>
    <Stack gap="sm">
      <Row gap="xs" wrap>
        <Button size="sm" variant={active === 'preview' ? 'outline' : 'ghost'} onPress={() => switchMode('preview')}>{ko ? '추천 미리보기' : 'Preview recommendations'}</Button>
        <Button size="sm" variant={active === 'review' ? 'outline' : 'ghost'} onPress={() => switchMode('review')}>{ko ? '스킬 심층 검토' : 'Review skill content'}</Button>
      </Row>
      {active === 'preview' ? eligible.length ? <Stack gap="xs">
        <Input label={ko ? '예시 요청' : 'Example task'} placeholder={ko ? '이 PR의 권한 누락을 찾아줘' : 'Check this PR for missing permissions'} maxLength={256}
          value={current.query} onChange={query => change({ query })} disabled={!!waiting} />
        <Select label={ko ? '설명 변경 시뮬레이션' : 'Try a different description'} options={[blank(ko ? '현재 설명 사용' : 'Use current descriptions'), ...optionsFor(eligible.filter(i => i.kind === 'skill'), duplicateNames)]}
          value={current.editId || none} disabled={!!waiting} onChange={editId => change({ editId: editId === none ? '' : editId, description: items.find(i => i.id === editId)?.description.slice(0, 240) ?? '' })} />
        {current.editId ? <Textarea label={ko ? '임시 설명' : 'Draft description'} value={current.description} maxLength={240} rows={2}
          onChange={description => change({ description })} disabled={!!waiting} /> : null}
        <Button size="sm" variant="outline" disabled={!!waiting || !current.query.trim() || !!current.editId && !current.description.trim()} onPress={() => request('preview', workspaceId)}>
          {waiting ? ko ? '추천 확인 중…' : 'Checking matches…' : ko ? '추천 확인' : 'Find matches'}</Button>
        {result ? <Stack gap="xs">
          <Text size="sm">{(ko ? '현재 설명 · ' : 'Current · ') + rankText(result.before, ko)}</Text>
          {result.after ? <Text size="sm">{(ko ? '임시 설명 · ' : 'Draft · ') + rankText(result.after, ko)}</Text> : null}
        </Stack> : null}
      </Stack> : <Text size="sm" muted>{ko ? '공용 도구 목록에서 이 작업공간에 사용할 스킬이나 MCP를 먼저 선택하세요.' : 'Select a skill or MCP server in the shared library for this workspace first.'}</Text>
      : <Stack gap="xs">
        <Input label={ko ? '검토할 스킬 검색' : 'Find skills to review'} type="search" maxLength={100} value={current.filter}
          disabled={!!waiting} onChange={filter => change({ filter })} />
        {matching.length > shown.length ? <Text size="xs" muted>{ko ? `검색 결과 ${matching.length}개 중 첫 20개` : `First 20 of ${matching.length} matches`}</Text> : null}
        <Select label={ko ? '검토할 스킬' : 'Skill to review'} value={current.first || none}
          options={[blank(ko ? '스킬 선택' : 'Choose a skill'), ...optionsFor(selectedOption(current.first).filter(i => i.id !== current.second), duplicateNames)]}
          disabled={!!waiting} onChange={first => change({ first: first === none ? '' : first, second: first === none ? '' : current.second })} />
        {firstValid ? <Select label={ko ? '함께 비교할 스킬' : 'Compare with'} value={current.second || none}
          options={[blank(ko ? '이 스킬만 검토' : 'Review one skill'), ...optionsFor(selectedOption(current.second).filter(i => i.id !== current.first), duplicateNames)]}
          disabled={!!waiting} onChange={second => change({ second: second === none ? '' : second })} /> : null}
        <Text size="xs" muted>{ko ? '로컬 모델은 선택한 SKILL.md의 앞 6,000자씩 읽습니다. 에이전트용 요청에는 선택한 파일 위치가 들어갑니다.' : 'The local model reads the first 6,000 characters of each selected SKILL.md. The agent request includes their file locations.'}</Text>
        <Row gap="xs" wrap>
          <Button size="sm" variant="outline" disabled={!!waiting || !firstValid || !secondValid} onPress={() => request('review', workspaceId)}>
            {waiting === 'review' ? ko ? '검토 중…' : 'Reviewing…' : ko ? '로컬 모델로 검토' : 'Run local review'}</Button>
          <Button size="sm" variant="ghost" disabled={!!waiting || !firstValid || !secondValid} onPress={() => request('copy', workspaceId)}>
            {copied?.copied ? ko ? '요청 복사됨' : 'Request copied' : ko ? '에이전트용 요청 복사' : 'Copy agent request'}</Button>
        </Row>
        {review?.status === 'ready' ? <Stack gap="xs"><Text size="xs" muted>{(ko ? '모델 제안 · ' : 'Model suggestion · ') + review.model}</Text><Text size="sm">{review.text}</Text>
          {review.truncated ? <Text size="xs" muted>{ko ? '본문 또는 응답이 길이 한도에 도달했습니다.' : 'The input or response reached the review length limit.'}</Text> : null}</Stack> : null}
        {review?.status === 'unavailable' ? <Text size="sm" muted>{ko ? '로컬 생성 모델이 응답하지 않았습니다. 에이전트용 요청을 복사해 원하는 대화에서 검토하세요.' : 'No local text model responded. Copy the request into your preferred agent to review these skills.'}</Text> : null}
        {copied && !copied.copied ? <CodeView label={ko ? '직접 복사할 검토 요청' : 'Review request to copy'} code={copied.prompt} wrap maxHeight="md" /> : null}
      </Stack>}
      {read(failed) ? <Text size="sm" tone="warning">{ko ? '요청을 마치지 못했습니다. 선택 항목을 확인하고 다시 시도하세요.' : 'The request could not finish. Check the selection and try again.'}</Text> : null}
    </Stack>
  </Collapsible>
}
