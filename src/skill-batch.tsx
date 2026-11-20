import { atom, Button, Callout, Checkbox, CodeView, Collapsible, Heading, plugin, read, Row, set, Stack, Text } from 'orca'
import { englishCount } from './panel-language'
import { blockedReason, displayPath, instructionFile, ko, providers, say } from './skill-change-display'
import type { CatalogItem, SkillBatchAction, SkillBatchItem, SkillBatchPreview, SkillBatchPreviewRow, SkillBatchProgress, SkillBatchResult, SkillBatchUndoResult, SkillReviewFinding } from './toolbox-types'
import './protocol'

type Choice = SkillBatchItem & { name: string; action: SkillBatchAction; providers: string[]; retainedId?: string }
type Step = 'closed' | 'select' | 'checking' | 'preview' | 'applying' | 'result' | 'undoing' | 'restored' | 'uncertain'
const step = atom<Step>('closed'), choices = atom<Choice[]>([]), selection = atom<string[]>([])
const preview = atom<SkillBatchPreview | null>(null), result = atom<SkillBatchResult | null>(null), restored = atom<SkillBatchUndoResult | null>(null)
const page = atom(0), notice = atom<'expired' | 'preview-failed' | null>(null), progress = atom<SkillBatchProgress | null>(null)
const pageSize = 6
let visit = 0, owner: string | null = null, runningId: string | null = null
type Refresh = () => Promise<void>

function identity(row: { key: string; id: string }) { return JSON.stringify([row.key, row.id]) }
const actionLabel = (action: SkillBatchAction) => action === 'fix' ? say('Repair file reference', '파일 경로 수정')
  : action === 'duplicate' ? say('Link identical copy', '중복 사본 연결') : say('Delete old installation', '이전 설치본 삭제')

function candidates(findings: SkillReviewFinding[], items: CatalogItem[]): Choice[] {
  const catalog = new Map(items.map(item => [item.id, item]))
  const found = new Map<string, Choice>()
  for (const f of findings) {
    const removal = f.removalCandidate
    const ids = removal ? [removal.id] : f.kind === 'missing' && f.referenceFixes?.length ? f.ids : []
    for (const id of ids) {
      const item = catalog.get(id)
      const choice: Choice = { key: f.key, stamp: f.stamp, id, name: item?.name ?? f.name,
        action: removal?.reason ?? 'fix', providers: item?.providers ?? f.providers, retainedId: removal?.retainedId }
      found.set(identity(choice), choice)
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.action.localeCompare(b.action) || a.id.localeCompare(b.id))
}

function suggestedSelection(all: Choice[]) {
  const chosen: string[] = [], writes = new Set<string>(), keepers = new Set<string>()
  for (const action of ['fix', 'duplicate']) {
    for (const row of all) {
      if (row.action !== action || writes.has(row.id) || keepers.has(row.id)) continue
      if (row.retainedId && writes.has(row.retainedId)) continue
      chosen.push(identity(row)); writes.add(row.id)
      if (row.retainedId) keepers.add(row.retainedId)
    }
  }
  return chosen
}

export function resetSkillBatch() {
  visit++
  owner = null; runningId = null
  set(step, 'closed'); set(page, 0); set(choices, []); set(selection, [])
  set(preview, null); set(result, null); set(restored, null); set(progress, null); set(notice, null)
}
export const hasSkillBatch = () => read(step) !== 'closed'
export const applyingSkillBatch = () => read(step) === 'applying' || read(step) === 'undoing'
export function receiveBatchProgress(value: SkillBatchProgress) {
  if (applyingSkillBatch() && value.workspaceId === owner && value.batchId === runningId) set(progress, value)
}

export function BatchEntry({ workspaceId, findings, items }: { workspaceId: string; findings: SkillReviewFinding[]; items: CatalogItem[] }) {
  const all = candidates(findings, items)
  if (!all.length) return null
  return <Button size="sm" tone="accent" onPress={() => {
    resetSkillBatch(); owner = workspaceId
    set(choices, all); set(selection, suggestedSelection(all)); set(step, 'select')
  }}>{say('Batch actions', '일괄 처리')} · {all.length}</Button>
}

async function check(workspaceId: string) {
  if (read(step) !== 'select') return
  const selected = new Set(read(selection))
  const items = read(choices).filter(row => selected.has(identity(row))).map(({ key, stamp, id }) => ({ key, stamp, id }))
  if (!items.length) return
  const current = ++visit
  set(step, 'checking'); set(notice, null)
  try {
    const plan = await plugin.request('toolbox.previewSkillBatch', { workspaceId, items }, { timeoutMs: 120000 })
    if (current === visit) { set(preview, plan); set(page, 0); set(step, 'preview') }
  } catch {
    if (current === visit) { set(notice, 'preview-failed'); set(step, 'select') }
  }
}

async function recoverResult(workspaceId: string, planId: string, current: number) {
  while (current === visit) {
    try {
      const state = await plugin.request('toolbox.skillBatchStatus', { workspaceId, planId })
      if (state.status === 'done') return state.result
      if (state.status !== 'running' || current !== visit) break
    } catch { break }
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
  return null
}

async function apply(workspaceId: string, onDone: Refresh) {
  const plan = read(preview)
  if (read(step) !== 'preview' || !plan?.rows.some(row => row.status === 'ready')) return
  const current = ++visit
  runningId = plan.planId
  set(progress, null); set(step, 'applying')
  let outcome: SkillBatchResult | null
  try {
    outcome = await plugin.request('toolbox.applySkillBatch', { workspaceId, planId: plan.planId }, { timeoutMs: 120000 })
  } catch (error) {
    if (current !== visit) return
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('STALE: Preview the batch again.')) {
      set(preview, null); set(page, 0); set(notice, 'expired'); set(step, 'select')
      return
    }
    outcome = await recoverResult(workspaceId, plan.planId, current)
  }
  if (current !== visit) return
  if (!outcome) { set(step, 'uncertain'); return }
  set(result, outcome); set(page, 0); set(step, 'result')
  await onDone()
}

export async function undoSkillBatch(workspaceId: string, batchId: string, onDone: Refresh) {
  if (applyingSkillBatch()) return
  const current = ++visit
  owner = workspaceId; runningId = batchId
  set(progress, null); set(step, 'undoing')
  try {
    const outcome = await plugin.request('toolbox.undoSkillBatch', { workspaceId, batchId }, { timeoutMs: 120000 })
    if (current !== visit) return
    set(restored, outcome); set(page, 0); set(step, 'restored')
  } catch { if (current === visit) set(step, 'uncertain'); return }
  await onDone()
}

function reason(code: string | undefined, editing: boolean) {
  switch (code) {
    case 'overlap': return say('Two choices affect the same installation. Select one and preview again.', '같은 설치본에 변경이 겹칩니다. 하나만 선택하고 다시 미리 보세요.')
    case 'workspace-changed': return say('The active workspace changed.', '활성 작업공간이 바뀌었습니다.')
    case 'unavailable': return say('The installation is unavailable.', '설치본에 접근할 수 없습니다.')
    case 'already-restored': return say('This change was already restored.', '이미 복구한 변경입니다.')
    case 'busy': return say('Another change is in progress.', '다른 변경이 진행 중입니다.')
    case 'conflict': return say('The current files differ from the saved version.', '현재 파일이 저장된 버전과 다릅니다.')
    case 'no-fix': return say('The suggested path could not be verified.', '제안한 경로를 확인할 수 없습니다.')
    case undefined: return say('Check the installation again.', '설치본을 다시 점검하세요.')
    default: return blockedReason(code, editing)
  }
}

function Pager({ total }: { total: number }) {
  const pages = Math.ceil(total / pageSize), current = read(page)
  if (pages < 2) return null
  return <Row justify="between" align="center" gap="xs">
    <Button size="sm" variant="ghost" disabled={!current} onPress={() => set(page, current - 1)}>{say('Previous', '이전')}</Button>
    <Text size="xs" muted>{current + 1} / {pages}</Text>
    <Button size="sm" variant="ghost" disabled={current + 1 >= pages} onPress={() => set(page, current + 1)}>{say('Next', '다음')}</Button>
  </Row>
}
function visible<T>(rows: T[]) { return rows.slice(read(page) * pageSize, (read(page) + 1) * pageSize) }

function Scope({ row }: { row: SkillBatchPreviewRow }) {
  const editing = row.action === 'fix', linked = row.paths?.filter(p => p !== row.path) ?? []
  return <Stack gap="xs">
    {row.path ? <CodeView label={editing ? say('File to edit', '수정할 파일') : say('Location to remove', '삭제할 위치')}
      code={displayPath(editing ? instructionFile(row.path) : row.path)} wrap maxHeight="sm" /> : null}
    {row.fixes?.length ? <CodeView label={say('Path changes', '경로 변경')} code={row.fixes.map(f => say('Line ', '줄 ') + f.line + '   ' + f.from + ' → ' + f.to).join('\n')} wrap maxHeight="sm" /> : null}
    {row.retainedPath ? <CodeView label={say('Copy to keep', '유지할 사본')} code={displayPath(row.retainedPath)} wrap maxHeight="sm" />
      : row.retainedName ? <Text size="sm">{say('Keep · ', '유지 · ') + row.retainedName}</Text> : null}
    {linked.length ? <CodeView label={say('Linked locations', '연결된 위치')} code={linked.map(displayPath).join('\n')} wrap maxHeight="sm" /> : null}
    {row.selectedWorkspaces ? <Text size="xs" tone="warning">{ko() ? '이 설치본을 선택한 작업공간 ' + row.selectedWorkspaces + '곳'
      : englishCount(row.selectedWorkspaces, 'workspace') + ' selected this installation.'}</Text> : null}
    {!editing && row.selectedWorkspaces === undefined ? <Text size="xs" muted>{say('Workspace selection count unavailable.', '이 설치본을 선택한 작업공간 수를 확인하지 못했습니다.')}</Text> : null}
    {row.editsOriginal ? <Text size="xs">{say('Apply the shared update in Library after editing the original.', '원본 수정 후 공용 도구에서 공용본을 업데이트하세요.')}</Text> : null}
  </Stack>
}

function Preview({ workspaceId, onDone }: { workspaceId: string; onDone: Refresh }) {
  const plan = read(preview)
  if (!plan) return null
  const ready = plan.rows.filter(row => row.status === 'ready'), blocked = plan.rows.length - ready.length
  const deletes = ready.filter(row => row.action === 'successor').length, links = ready.filter(row => row.action === 'duplicate').length
  return <Stack gap="sm">
    <Heading level={2}>{say('Review changes', '적용 전 확인')}</Heading>
    <Text size="sm">{say('Ready', '적용 가능')} {ready.length} · {say('Skipped', '건너뜀')} {blocked}</Text>
    {(deletes || links) ? <Callout tone={deletes ? 'warning' : 'neutral'}><Stack gap="xs">
      {links ? <Text size="sm">{ko() ? '중복 사본 ' + links + '개를 동일한 사본에 연결합니다.' : links === 1 ? 'Replace one duplicate with a link to the matching copy.' : 'Replace ' + links + ' duplicates with links to their matching copies.'}</Text> : null}
      {deletes ? <Text size="sm">{ko() ? '이전 설치본 ' + deletes + '개와 연결된 항목을 삭제합니다.' : deletes === 1 ? 'Delete one old installation and its linked entries.' : 'Delete ' + deletes + ' old installations and their linked entries.'}</Text> : null}
    </Stack></Callout> : null}
    {visible(plan.rows).map(row => {
      const detail = [actionLabel(row.action), providers(row.providers ?? [])].filter(Boolean).join(' · ')
      return row.status === 'blocked' ? <Stack key={identity(row)} gap="none"><Text size="sm" weight="semibold">{row.name} · {say('Skipped', '건너뜀')}</Text>
        <Text size="xs" muted>{detail}</Text><Text size="xs" tone="warning">{reason(row.reason, row.action === 'fix')}</Text></Stack>
        : <Collapsible key={identity(row)} title={row.name} description={detail}><Scope row={row} /></Collapsible>
    })}
    <Pager total={plan.rows.length} />
    <Row wrap gap="xs"><Button size="sm" tone={deletes ? 'danger' : 'accent'} disabled={!ready.length} onPress={() => apply(workspaceId, onDone)}>
      {ko() ? ready.length + '개 적용' : 'Apply ' + englishCount(ready.length, 'change')}</Button>
      <Button size="sm" variant="ghost" onPress={() => { set(page, 0); set(step, 'select') }}>{say('Edit selection', '선택 변경')}</Button></Row>
  </Stack>
}

function Selection({ workspaceId }: { workspaceId: string }) {
  const all = read(choices), selected = new Set(read(selection))
  const complete = selected.size === all.length
  return <Stack gap="sm">
    <Heading level={2}>{say('Choose batch actions', '일괄 처리할 항목')}</Heading>
    <Row justify="between" align="center" wrap><Text size="sm">{ko() ? all.length + '개 중 ' + selected.size + '개 선택' : selected.size + ' of ' + all.length + ' selected'}</Text>
      <Button size="sm" variant="ghost" onPress={() => set(selection, complete ? [] : all.map(identity))}>{complete ? say('Clear selection', '전체 해제') : say('Select all', '전체 선택')}</Button></Row>
    {visible(all).map(row => <Checkbox key={identity(row)} label={row.name} description={[actionLabel(row.action), providers(row.providers)].filter(Boolean).join(' · ')}
      checked={selected.has(identity(row))} onChange={checked => {
        const next = new Set(read(selection))
        if (checked) next.add(identity(row))
        else next.delete(identity(row))
        set(selection, [...next])
      }} />)}
    <Pager total={all.length} />
    {read(notice) ? <Text size="sm" tone="warning">{read(notice) === 'expired'
      ? say('Your preview expired. Preview this selection again to continue.', '미리보기가 만료되었습니다. 선택한 항목을 다시 미리 보세요.')
      : say('Could not check the selected installations. Preview again.', '선택한 설치본을 확인하지 못했습니다. 미리보기를 다시 실행하세요.')}</Text> : null}
    <Row wrap gap="xs"><Button size="sm" tone="accent" disabled={!selected.size} onPress={() => check(workspaceId)}>{say('Preview', '미리보기')} · {selected.size}</Button>
      <Button size="sm" variant="ghost" onPress={resetSkillBatch}>{say('Cancel', '취소')}</Button></Row>
  </Stack>
}

export function SkillBatchPanel({ workspaceId, onDone, onHistory }: { workspaceId: string; onDone: Refresh; onHistory: Refresh }) {
  const current = read(step), applying = current === 'applying', undoing = current === 'undoing'
  if (current === 'select') return <Selection workspaceId={workspaceId} />
  if (current === 'preview') return <Preview workspaceId={workspaceId} onDone={onDone} />
  if (current === 'checking' || applying || undoing) {
    const amount = read(progress)
    return <Stack gap="sm"><Text size="sm">{applying ? say('Applying changes…', '일괄 적용 중…') : undoing ? say('Restoring changes…', '일괄 복구 중…') : say('Checking installations…', '설치본 확인 중…')}</Text>
      {amount ? <Text size="xs" muted>{amount.completed} / {amount.total}</Text> : null}
      {current === 'checking' ? <Row><Button size="sm" variant="ghost" onPress={resetSkillBatch}>{say('Cancel', '취소')}</Button></Row> : null}</Stack>
  }
  if (current === 'uncertain') return <Callout tone="warning"><Stack gap="sm">
    <Text size="sm">{say('The result could not be confirmed. Check which changes were saved.', '처리 결과를 확인하지 못했습니다. 최근 변경에서 저장된 항목을 확인하세요.')}</Text>
    <Row><Button size="sm" variant="outline" onPress={async () => { resetSkillBatch(); await onHistory() }}>{say('Check recent changes', '최근 변경 확인')}</Button></Row>
  </Stack></Callout>
  const undo = current === 'restored', applied = read(result), rows = (undo ? read(restored)?.rows : applied?.rows) ?? []
  const sourceProviders = new Map(read(choices).map(row => [identity(row), providers(row.providers)]))
  const success = undo ? say('Restored', '복구됨') : say('Applied', '적용됨')
  const ok = rows.filter(r => r.status === 'restored' || r.status === 'applied').length
  const failed = rows.filter(r => r.status === 'failed').length, skipped = rows.length - ok - failed
  return <Stack gap="sm"><Heading level={2}>{undo ? say('Restore results', '복구 결과') : say('Batch results', '일괄 처리 결과')}</Heading>
    <Text size="sm">{success} {ok} · {say('Skipped', '건너뜀')} {skipped} · {say('Failed', '실패')} {failed}</Text>
    {visible<(typeof rows)[number]>(rows).map(row => {
      const done = row.status === 'restored' || row.status === 'applied'
      const status = done ? success : row.status === 'skipped' ? say('Skipped', '건너뜀') : say('Failed', '실패')
      return <Stack key={'receiptId' in row ? row.receiptId : identity(row)} gap="none">
        <Text size="sm" weight="semibold">{row.name}</Text><Text size="xs" tone={done ? 'success' : 'warning'}>{['action' in row ? actionLabel(row.action) : '', 'action' in row ? sourceProviders.get(identity(row)) : '', status].filter(Boolean).join(' · ')}</Text>
        {done ? null : <Text size="xs" muted>{reason(row.reason, 'action' in row && row.action === 'fix')}</Text>}</Stack>
    })}
    <Pager total={rows.length} />
    <Row wrap gap="xs"><Button size="sm" variant="outline" onPress={resetSkillBatch}>{say('Back to findings', '점검 목록으로')}</Button>
      {!undo && ok && applied ? <Button size="sm" variant="ghost" onPress={() => undoSkillBatch(workspaceId, applied.batchId, onDone)}>{say('Undo batch', '일괄 되돌리기')}</Button> : null}</Row>
  </Stack>
}
