import { atom, Button, Callout, CodeView, Collapsible, Heading, Input, List, ListItem, plugin, read, RelativeTime, Row, set, Stack, Text, Textarea } from 'orca'
import { blockedReason, displayPath, instructionFile, ko, providers, say } from './skill-change-display'
import { instructionLines, targetsForLines } from '../runtime/skill-reference-targets.mjs'
import { undoSkillBatch } from './skill-batch'
import type { CatalogItem, SkillChangeKind, SkillChangePreview, SkillChangeReceipt, SkillReviewFinding } from './toolbox-types'
import './protocol'

type Target = Pick<CatalogItem, 'id' | 'name' | 'providers'>
type Plan = { workspaceId: string; kind: SkillChangeKind; targets: Target[]; id?: string; retainedId?: string; retainedName?: string; retainedShared?: boolean; findings: SkillReviewFinding[] }
const plan = atom<Plan | null>(null)
const preview = atom<SkillChangePreview | null>(null)
const draft = atom('')
const fullEditor = atom(false)
const busy = atom<'preview' | 'apply' | 'undo' | null>(null)
const error = atom(false)
const receipt = atom<SkillChangeReceipt | null>(null)
const restored = atom('')
const history = atom<SkillChangeReceipt[]>([])
const historyOpen = atom(false)
const historyState = atom<'loading' | 'ready' | 'error'>('ready')
let visit = 0, historyRequest = 0

export function closeSkillChange() {
  visit++
  set(plan, null); set(preview, null); set(draft, ''); set(fullEditor, false); set(busy, null); set(error, false)
}
export function resetSkillMaintenance() {
  closeSkillChange(); historyRequest++
  set(historyOpen, false); set(history, []); set(historyState, 'ready'); set(receipt, null); set(restored, '')
}
export const hasSkillChange = () => !!read(plan)
export const applyingSkillChange = () => read(busy) === 'apply' || read(busy) === 'undo'

async function prepare(request: Plan, id: string) {
  const key = ++visit
  set(plan, { ...request, id }); set(preview, null); set(error, false); set(busy, 'preview'); set(fullEditor, false); set(draft, '')
  try {
    const result = await plugin.request('toolbox.previewSkillChange', { workspaceId: request.workspaceId, kind: request.kind, id,
      ...(request.retainedId ? { retainedId: request.retainedId } : {}) }, { timeoutMs: 60000 })
    if (key !== visit) return
    set(preview, result); set(draft, result.status === 'ready' ? result.body ?? '' : '')
  } catch { if (key === visit) set(error, true) }
  finally { if (key === visit) set(busy, null) }
}
function start(request: Plan) {
  if (!request.targets.length || applyingSkillChange()) return
  closeSkillChange()
  if (request.targets.length === 1) return prepare(request, request.targets[0].id)
  set(plan, request)
}
export function ChangeButtons({ workspaceId, targets, findings, candidate, items }: {
  workspaceId: string; targets: Target[]; findings: SkillReviewFinding[]; candidate?: SkillReviewFinding; items: CatalogItem[]
}) {
  if (!targets.length) return null
  const removal = candidate?.removalCandidate
  const target = removal && targets.find(item => item.id === removal.id)
  const retained = removal && items.find(item => item.id === removal.retainedId)
  const duplicate = target && removal?.reason === 'duplicate'
  const action = (kind: SkillChangeKind) => start({ workspaceId, kind, targets: kind === 'remove' && target ? [target] : targets,
    findings, ...(kind === 'remove' && target ? { retainedId: duplicate ? removal?.retainedId : undefined, retainedName: retained?.name, retainedShared: retained?.providers.includes('Shared') } : {}) })
  return <Row wrap gap="xs">
    <Button size="sm" variant="outline" onPress={() => action('edit')}>{say('Edit instructions', '지침 수정')}</Button>
    <Button size="sm" variant={target ? 'outline' : 'ghost'} tone={target ? 'danger' : 'neutral'} onPress={() => action('remove')}>
      {duplicate ? say('Remove duplicate…', '중복 사본 삭제…') : target ? say('Remove old version…', '이전 버전 삭제…') : say('Delete skill…', '스킬 삭제…')}</Button>
  </Row>
}

async function apply(onDone: () => Promise<void>) {
  const p = read(plan), ready = read(preview)
  if (read(busy) || !p?.id || ready?.status !== 'ready') return
  const key = visit
  set(busy, 'apply'); set(error, false)
  try {
    const result = await plugin.request('toolbox.applySkillChange', { workspaceId: p.workspaceId, kind: p.kind, id: p.id, revision: ready.revision,
      ...(p.kind === 'edit' ? { body: read(draft) } : {}), ...(p.retainedId ? { retainedId: p.retainedId } : {}) }, { timeoutMs: 60000 })
    if (key !== visit) return
    closeSkillChange(); set(receipt, result); set(restored, ''); set(historyOpen, false); historyRequest++
    await onDone()
  } catch { if (key === visit) set(error, true) }
  finally { if (key === visit) set(busy, null) }
}

function useReference(line: string, targets: { path: string; start: number }[], from: string, to: string) {
  for (const { start } of targets.filter(target => target.path === from).reverse()) {
    line = line.slice(0, start) + to + line.slice(start + from.length)
  }
  return line
}

function ReferenceEditor({ request, original, verified }: { request: Plan; original: string; verified?: SkillReviewFinding['referenceFixes'] }) {
  const body = read(draft), targets = targetsForLines(instructionLines(body))
  const lines = body.split(/(\r\n|\n|\r)/)
  const originals = original.split(/\r\n|\n|\r/)
  const refs = new Map<number, Set<string>>()
  const suggestions = verified ?? request.findings.filter(f => f.kind === 'missing' && f.ids.includes(request.id!)).flatMap(f => f.referenceFixes ?? [])
  function addMissing(line: number | undefined, path: string) {
    if (!line || !originals[line - 1]?.includes(path)) return
    const values = refs.get(line) ?? new Set<string>()
    values.add(path); refs.set(line, values)
  }
  function changeLine(number: number, value: string) {
    const changed = read(draft).split(/(\r\n|\n|\r)/)
    changed[(number - 1) * 2] = value; set(draft, changed.join(''))
  }
  for (const f of request.findings.filter(f => f.kind === 'missing' && f.ids.includes(request.id!))) {
    f.evidence.forEach((path, i) => {
      const line = f.lines?.[i] ?? (i === 0 ? f.line : undefined)
      addMissing(line, path)
    })
  }
  for (const fix of suggestions) addMissing(fix.line, fix.from)
  if (!refs.size || read(fullEditor)) return <Textarea label="SKILL.md" rows={14} value={read(draft)} disabled={!!read(busy)} onChange={body => set(draft, body)} />
  return <Stack gap="sm">{[...refs].sort(([left], [right]) => left - right).map(([line, paths]) => <Stack key={line} gap="xs">
    <Text size="xs" muted>{say('Missing · ', '누락 · ') + [...paths].join(' · ')}</Text>
    <Input label={say('Edit line ', '수정할 줄 · ') + line} value={lines[(line - 1) * 2]} disabled={!!read(busy)} onChange={value => changeLine(line, value)} />
    {suggestions.filter(fix => fix.line === line && paths.has(fix.from)).map(fix => {
      const source = lines[(line - 1) * 2], updated = useReference(source, targets.get(line) ?? [], fix.from, fix.to)
      if (source === updated) return null
      return <Stack key={fix.from} gap="xs"><Text size="xs">{say('Found in this package · ', '패키지에서 찾은 파일 · ') + fix.to}</Text>
        <Row><Button size="sm" variant="outline" disabled={!!read(busy)} onPress={() => changeLine(line, updated)}>{say('Use suggested path', '제안 경로 사용')}</Button></Row></Stack>
    })}
  </Stack>)}<Row><Button size="sm" variant="ghost" disabled={!!read(busy)} onPress={() => set(fullEditor, true)}>{say('Edit entire file', '전체 파일 편집')}</Button></Row></Stack>
}

export function ChangeForm({ onDone }: { onDone: () => Promise<void> }) {
  const p = read(plan), ready = read(preview), working = read(busy)
  if (!p) return null
  const editing = p.kind === 'edit', target = p.targets.find(t => p.id === t.id)
  const title = editing ? say('Edit instructions', '지침 수정') : say('Review deletion', '삭제 전 확인')
  return <Stack gap="sm">
    <Row><Button size="sm" variant="ghost" disabled={working === 'apply'} onPress={closeSkillChange}>{say('Back to review', '검토 결과로')}</Button></Row>
    <Heading level={2}>{title}</Heading>
    {!target ? <List label={say('Choose the installation', '변경할 설치본 선택')}>{p.targets.map(t =>
      <ListItem key={t.id} title={t.name} description={providers(t.providers)} onPress={() => prepare(p, t.id)} />)}</List> :
      <Text weight="semibold">{ready?.status === 'ready' ? target.name : target.name + ' · ' + providers(target.providers)}</Text>}
    {working === 'preview' ? <Text size="sm" muted>{say('Checking installation…', '설치 위치 확인 중…')}</Text> : null}
    {ready?.status === 'blocked' ? <Callout tone="warning"><Text size="sm">{blockedReason(ready.reason, editing)}</Text></Callout> : null}
    {ready?.status === 'ready' ? <Stack gap="sm">
      {!editing ? <Callout tone="warning"><Text size="sm">{p.retainedId ? say('The old location will link to the retained copy. You can undo this in Recent changes.', '기존 위치를 남길 사본에 연결합니다. 최근 변경에서 원래 사본으로 복구할 수 있습니다.') : say('This installation and its linked entries will be removed. You can restore them from Recent changes.', '이 설치본과 연결된 항목들을 삭제합니다. 최근 변경에서 복구할 수 있습니다.')}</Text></Callout> : null}
      {editing && ready.editsOriginal ? <Callout tone="warning"><Text size="sm">{say('Edit the original, then apply the shared update in Library.', '원본을 저장한 뒤 공용 도구에서 공용본 업데이트를 적용하세요.')}</Text></Callout> : null}
      <Text size="sm">{say('Affected providers · ', '영향받는 제공자 · ') + providers(ready.providers)}</Text>
      <CodeView label={editing ? say('File to edit', '수정할 파일') : say('Location to remove', '삭제할 위치')} code={displayPath(editing ? instructionFile(ready.path) : ready.path)} wrap maxHeight="sm" />
      {ready.retainedPath ? <CodeView label={p.retainedShared ? say('Shared copy to keep', '유지할 공용본') : say('Copy to keep', '유지할 사본')} code={displayPath(ready.retainedPath)} wrap maxHeight="sm" /> : !editing && p.retainedName ? <Text size="sm">{say('Keep · ', '유지 · ') + p.retainedName}</Text> : null}
      {ready.paths?.filter(path => path !== ready.path).length ? <Collapsible title={say('Linked locations', '연결된 위치')}><CodeView label={say('Affected locations', '영향받는 위치')} code={ready.paths.filter(path => path !== ready.path).map(displayPath).join('\n')} wrap maxHeight="sm" /></Collapsible> : null}
      {typeof ready.selectedWorkspaces === 'number' && ready.selectedWorkspaces > 0 ? <Text size="sm" tone="warning">{ko() ? '이 설치본을 선택한 작업공간 ' + ready.selectedWorkspaces + '곳' : ready.selectedWorkspaces + (ready.selectedWorkspaces === 1 ? ' workspace selected' : ' workspaces selected') + ' this installation.'}</Text> : null}
      {!editing && ready.selectedWorkspaces === undefined ? <Text size="xs" muted>{say('Workspace selection count unavailable.', '이 설치본을 선택한 작업공간 수를 확인하지 못했습니다.')}</Text> : null}
      {p.retainedId && ready.selectedWorkspaces !== 0 ? <Text size="sm">{say('Workspaces using this copy can select the retained one in Library.', '이 사본을 사용하던 작업공간은 공용 도구에서 남긴 사본을 다시 선택하세요.')}</Text> : null}
      {editing ? <ReferenceEditor request={p} original={ready.body ?? ''} verified={ready.referenceFixes} /> : null}
      <Row wrap gap="xs"><Button size="sm" disabled={!!working || read(error) || (editing && (!read(draft).trim() || read(draft) === ready.body))}
        tone={editing ? 'accent' : 'danger'} onPress={() => apply(onDone)}>{working === 'apply' ? say('Applying…', '적용 중…') : editing ? say('Save changes', '변경 저장') : p.retainedId ? say('Remove and link', '삭제하고 사본 연결') : say('Delete installation', '설치본 삭제')}</Button>
        <Button size="sm" variant="ghost" disabled={working === 'apply'} onPress={closeSkillChange}>{say('Cancel', '취소')}</Button></Row>
    </Stack> : null}
    {read(error) ? <Callout tone="warning"><Stack gap="xs"><Text size="sm">{ready ? say('Could not confirm the change. Check Recent changes before trying again.', '변경 결과를 확인하지 못했습니다. 최근 변경을 확인한 뒤 다시 시도하세요.') : say('Could not preview this installation. Recheck the skill and try again.', '이 설치본을 확인하지 못했습니다. 스킬을 다시 점검해 주세요.')}</Text>
      {ready ? <Row><Button size="sm" variant="outline" onPress={async () => {
        closeSkillChange(); set(historyOpen, true)
        await Promise.all([onDone(), loadHistory(p.workspaceId)])
      }}>{say('Check recent changes', '최근 변경 확인')}</Button></Row> : target ? <Row><Button size="sm" variant="outline" onPress={() => prepare(p, target.id)}>{say('Retry preview', '미리보기 다시 시도')}</Button></Row> : null}
    </Stack></Callout> : null}
  </Stack>
}

async function loadHistory(workspaceId: string) {
  const key = ++historyRequest
  set(historyState, 'loading')
  try {
    const result = await plugin.request('toolbox.skillChangeHistory', { workspaceId })
    if (key === historyRequest) { set(history, result); set(historyState, 'ready') }
  } catch { if (key === historyRequest) set(historyState, 'error') }
}
export async function refreshChangeHistory(workspaceId: string, open = false) {
  if (open) set(historyOpen, true)
  if (read(historyOpen)) await loadHistory(workspaceId)
}

async function undo(workspaceId: string, item: SkillChangeReceipt, onDone: () => Promise<void>) {
  if (read(busy)) return
  const key = visit
  set(busy, 'undo'); set(error, false)
  try {
    const result = await plugin.request('toolbox.undoSkillChange', { workspaceId, receiptId: item.id }, { timeoutMs: 60000 })
    if (key !== visit) return
    if (!result.restored) throw new Error('not-restored')
    set(receipt, null); set(restored, item.name)
    await onDone()
    if (key === visit && read(historyOpen)) await loadHistory(workspaceId)
  } catch { if (key === visit) set(error, true) }
  finally { if (key === visit) set(busy, null) }
}
export function ChangeHistory({ workspaceId, onDone }: { workspaceId: string; onDone: () => Promise<void> }) {
  const edited = read(receipt), entries = read(history), state = read(historyState)
  const action = (r: SkillChangeReceipt) => r.kind === 'edit' ? say('Edited', '수정됨') : say('Deleted', '삭제됨')
  const groups = new Map<string, SkillChangeReceipt[]>()
  for (const entry of entries) {
    const key = entry.batchId ?? entry.id
    const group = groups.get(key)
    if (group) group.push(entry)
    else groups.set(key, [entry])
  }
  return <Stack gap="xs">
    {edited ? <Callout tone="success"><Row justify="between" align="center" wrap><Text size="sm">{edited.name + ' · ' + action(edited)}</Text>
      <Button size="sm" variant="outline" disabled={!!read(busy)} onPress={() => undo(workspaceId, edited, onDone)}>{say('Undo', '되돌리기')}</Button></Row></Callout> : null}
    {edited?.editsOriginal ? <Text size="sm">{say('Apply the shared update in Library to use the new instructions.', '새 지침을 사용하려면 공용 도구에서 공용본 업데이트를 적용하세요.')}</Text> : null}
    {read(restored) ? <Text size="sm" tone="success">{read(restored) + say(' restored.', ' 복구됨')}</Text> : null}
    {read(error) ? <Text size="sm" tone="warning">{say('Could not undo the change. Refresh Recent changes and check for a newer installation.', '복구하지 못했습니다. 최근 변경을 다시 열고 같은 위치에 새 설치본이 있는지 확인하세요.')}</Text> : null}
    <Collapsible title={say('Recent changes', '최근 변경')} open={read(historyOpen)} onChange={open => {
      set(historyOpen, open)
      if (open) return loadHistory(workspaceId)
      historyRequest++
    }}>
      {state === 'loading' ? <Text size="sm" muted>{say('Loading changes…', '변경 기록을 읽는 중…')}</Text> : state === 'error' ? <Button size="sm" variant="outline" onPress={() => loadHistory(workspaceId)}>{say('Retry history', '변경 기록 다시 읽기')}</Button> : entries.length ?
        <Stack gap="sm">{[...groups.values()].map(group => {
          const item = group[0], batchId = item.batchId
          if (batchId) return <Stack key={batchId} gap="xs">
            <Row wrap align="center" justify="between"><Stack gap="none">
              <Text size="sm" weight="semibold">{say('Batch changes', '일괄 변경')} · {group.length}</Text>
              <RelativeTime at={item.at} muted /></Stack>
              <Button size="sm" variant="outline" disabled={!!read(busy)} onPress={() => {
                const current = visit
                return undoSkillBatch(workspaceId, batchId, async () => {
                  await onDone()
                  if (current === visit) await refreshChangeHistory(workspaceId)
                })
              }}>{say('Undo batch', '일괄 되돌리기')}</Button></Row>
            <Collapsible title={say('View changes', '변경 내역 보기')}><Stack gap="xs">{group.map(entry =>
              <Row key={entry.id} wrap align="center" justify="between"><Text size="sm">{entry.name + ' · ' + action(entry)}</Text>
                <Button size="sm" variant="ghost" disabled={!!read(busy)} onPress={() => undo(workspaceId, entry, onDone)}>{say('Undo', '되돌리기')}</Button></Row>)}</Stack></Collapsible>
          </Stack>
          return <Row key={item.id} wrap align="center" justify="between"><Stack gap="none"><Text size="sm" weight="semibold">{item.name}</Text>
          <Row gap="xs" wrap><Text size="xs" muted>{action(item)}</Text><RelativeTime at={item.at} muted /></Row></Stack>
          <Button size="sm" variant="outline" disabled={!!read(busy)} onPress={() => undo(workspaceId, item, onDone)}>{say('Undo', '되돌리기')}</Button></Row>})}</Stack>
        : <Text size="sm" muted>{say('No changes to undo in this workspace.', '이 작업공간에서 되돌릴 변경이 없습니다.')}</Text>}
    </Collapsible>
  </Stack>
}
