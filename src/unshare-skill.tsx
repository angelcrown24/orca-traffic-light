import { atom, Button, CodeView, env, plugin, read, Row, set, Stack, Text } from 'orca'
import { panelLanguage } from './panel-language'
import type { UnshareResult } from './toolbox-types'
import './protocol'

type Preview = Exclude<UnshareResult, {status: 'removed'}>
const preview = atom<Preview | null>(null), pending = atom(false), failed = atom(false)
const owner = atom<string | null>(null)
let visit = 0

export function resetUnshare() {
  visit++; set(owner,null)
  set(preview,null); set(pending,false); set(failed,false)
}

export function UnshareSkill({ workspaceId, skillKey, disabled, onRemoved }: {
  workspaceId: string; skillKey: string; disabled: boolean; onRemoved: () => Promise<void>
}) {
  const ko = panelLanguage(env.locale) === 'ko'
  const who = JSON.stringify([workspaceId,skillKey])
  const own = read(owner) === who, plan = own ? read(preview) : null
  const loading = own && read(pending)
  async function request(revision?: string) {
    if (disabled || (read(owner) === who && read(pending))) return
    const current = ++visit
    set(owner,who); set(pending,true); set(failed,false)
    try {
      const result = await plugin.request('toolbox.unshare',{ workspaceId, key:skillKey, ...(revision ? { revision } : {}) }, {timeoutMs:120000})
      if (visit !== current) return
      if (result.status === 'removed') { resetUnshare(); await onRemoved() }
      else set(preview,result)
    } catch {
      if (visit === current) { set(preview,null); set(failed,true) }
    } finally { if (visit === current) set(pending,false) }
  }
  const formatted = (path: string) => /^(?:[/\\]|[a-z]:[/\\])/i.test(path) ? path : '~/' + path
  function paths(label: string, list: string[]) {
    return list.length ? <CodeView label={label} code={list.map(formatted).join('\n')} wrap maxHeight="sm" /> : null
  }
  return <Stack gap="xs">
    {plan ? <Stack gap="xs">
      <Text size="sm" weight="semibold">{ko ? '이 컴퓨터에서 공유 중지' : 'Stop sharing on this machine'}</Text>
      {paths(plan.sourceAvailable ? (ko ? '유지할 원본' : 'Original to keep') : (ko ? '찾을 수 없는 원본' : 'Missing original'),[plan.source])}
      {!plan.sourceAvailable ? <Text size="sm" tone="warning">{ko ? '현재 원본을 읽을 수 없습니다. 공용 사본을 유지하려면 위 원본 위치에 복원한 뒤 다시 시도하세요.' : 'The original is unavailable. Restore it at the indicated location before removing its shared snapshots.'}</Text> : null}
      {paths(ko ? '제거할 링크' : 'Links to remove',plan.links)}
      {paths(ko ? '삭제할 공용 사본' : 'Shared snapshots to delete',plan.snapshots)}
      {paths(ko ? '유지할 기존 항목' : 'Existing entries to keep',plan.preserved)}
      {plan.legacy ? <Text size="sm" muted>{ko ? '이전 버전은 링크 소유 기록이 없습니다. 기존 공용 경로를 정확히 가리키는 링크를 확인하세요.' : 'This older registration predates link tracking. Review the listed links that point directly to its shared location.'}</Text> : null}
      {plan.status === 'blocked' ? <Stack gap="xs"><Text size="sm" tone="warning">{ko ? '외부에서 변경한 사본이나 사용자가 만든 링크가 있습니다. 해당 경로를 확인하고 다시 시도하세요.' : 'A shared copy changed or a user-managed link depends on it. Check these paths before trying again.'}</Text>
        {paths(ko ? '확인할 경로' : 'Paths requiring attention',plan.blockers)}</Stack> : null}
      <Row gap="sm" wrap>{plan.status === 'ready' ? <Button size="sm" tone="danger" disabled={disabled || loading} onPress={() => request(plan.revision)}>{ko ? '공유 중지' : 'Stop sharing'}</Button> : null}
        <Button size="sm" variant="ghost" disabled={loading} onPress={resetUnshare}>{ko ? '취소' : 'Cancel'}</Button></Row>
    </Stack> : <Row><Button size="sm" variant="outline" disabled={disabled || loading} onPress={() => request()}>{ko ? '공유 중지…' : 'Stop sharing…'}</Button></Row>}
    {loading ? <Text size="xs" muted>{ko ? '공유 상태 확인 중…' : 'Checking sharing status…'}</Text> : null}
    {own && read(failed) ? <Text size="sm" tone="warning">{ko ? '공유 상태를 확인하지 못했습니다. 보관함을 새로고침한 뒤 경로를 다시 확인하세요.' : 'Could not confirm the sharing status. Refresh the library and review the paths again.'}</Text> : null}
  </Stack>
}
