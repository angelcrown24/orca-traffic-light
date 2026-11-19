import { atom, Badge, Box, Button, Collapsible, env, read, RelativeTime, Row, set, Stack, Text } from 'orca'
import type { NativeToolCall } from './native-reader'
import { panelLanguage } from './panel-language'
import type { Call } from './protocol'
import type { ToolboxEvent } from './toolbox-types'

type Sources = { terminal: Call[]; native: NativeToolCall[]; shared: ToolboxEvent[] }
type Source = keyof Sources
type CallState = Call['state'] | NativeToolCall['state'] | 'awaiting'
type Entry = { key: string; source: Source; at: number; name: string; agent?: string | null; state: CallState; jev?: boolean }
type ClearPoint = { at: number; seen: Record<string, number> }
const cleared = atom<ClearPoint | null>('traffic-light.recent-cleared', null, { persist: 'workspace' })
const limit = 30

function entries({ terminal, native, shared }: Sources): Entry[] {
  return [
    ...terminal.map((c): Entry => ({ key: 'terminal/' + c.id, source: 'terminal', at: c.startedAt ?? 0,
      name: c.tool, agent: c.agent, state: c.state === 'running' ? 'awaiting' : c.state })),
    ...native.map((c): Entry => ({ key: 'native/' + c.id, source: 'native', at: c.observedAt,
      name: c.name, agent: c.agentType, state: c.state })),
    ...shared.filter(c => c.operation === 'call').map((c): Entry => ({
      key: 'shared/' + c.bundleId + '/' + c.id, source: 'shared', at: c.startedAt,
      name: c.name, state: c.state === 'succeeded' ? 'completed' : c.state, jev: Boolean(c.recommendationId) }))
  ]
}

// Clear the full time window, including calls omitted by the display cap or received
// in a later poll. At equal times, hide only calls already seen when the user pressed.
function markCleared(all: Entry[]) {
  const previous = read(cleared)
  const at = Math.max(Date.now(), previous?.at ?? 0)
  const seen: Record<string, number> = {}
  for (const [key, time] of Object.entries(previous?.seen ?? {})) if (time >= at) seen[key] = time
  for (const entry of all) if (entry.at >= at) seen[entry.key] = entry.at
  set(cleared, { at, seen })
}

const labels = {
  en: {
    title: 'Recent tool calls', clear: 'Clear list', clearHint: 'Clear the displayed history for this workspace', empty: 'No recent tool calls.', loading: 'Loading activity…',
    workspace: 'Open a workspace to see activity.', terminal: 'Terminal', native: 'Native chat', shared: 'Shared runner',
    running: 'Running', awaiting: 'Awaiting finish', finished: 'Finished', uncertain: 'Uncertain', completed: 'Completed', failed: 'Failed', unknown: 'Unverified'
  },
  ko: {
    title: '최근 도구 호출', clear: '목록 비우기', clearHint: '이 작업공간의 표시 기록 비우기', empty: '최근 도구 호출이 없습니다.', loading: '활동 불러오는 중…',
    workspace: '작업공간을 열면 활동이 표시됩니다.', terminal: '터미널', native: '네이티브 채팅', shared: '공용 실행기',
    running: '실행 중', awaiting: '종료 대기', finished: '종료됨', uncertain: '불확실', completed: '완료', failed: '실패', unknown: '확인 불가'
  }
} as const

export function RecentCalls(props: Sources & { workspace: boolean; loading: boolean }) {
  const t = labels[panelLanguage(env.locale)]
  const all = entries(props)
  const cutoff = read(cleared)
  const list = all.filter(row => !cutoff || (row.at >= cutoff.at && cutoff.seen[row.key] !== row.at))
    .sort((a, b) => b.at - a.at).slice(0, limit)
  return <Collapsible title={t.title + ' · ' + list.length}>
    <Stack gap="sm">
      {list.length ? <Row justify="end"><Button variant="ghost" size="sm" tooltip={t.clearHint} onPress={() => markCleared(all)}>{t.clear}</Button></Row> :
        <Text muted size="sm">{props.loading ? t.loading : props.workspace ? t.empty : t.workspace}</Text>}
      {list.map(row => <Stack key={row.key} gap="xs">
        <Row justify="between" align="center" gap="sm" wrap>
          <Box minWidth={0} grow><Text size="sm" weight="medium" truncate>{row.name}</Text></Box>
          <Row gap="xs" align="center">
            {row.jev ? <Badge tone="neutral">Jev</Badge> : null}
            <Badge tone={row.state === 'running' ? 'accent' : row.state === 'failed' ? 'danger' : row.state === 'awaiting' ? 'warning' : 'neutral'}>{t[row.state]}</Badge>
          </Row>
        </Row>
        <Row gap="xs" align="center" wrap>
          {row.agent ? <Text size="xs" muted>{row.agent}</Text> : null}
          <Text size="xs" muted>{(row.agent ? '· ' : '') + t[row.source]}</Text>
          {row.at > 0 ? <RelativeTime at={row.at} muted /> : null}
        </Row>
      </Stack>)}
    </Stack>
  </Collapsible>
}
