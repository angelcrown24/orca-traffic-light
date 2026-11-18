import { Badge, Box, Collapsible, env, Heading, RelativeTime, Row, Separator, Stack, Text } from 'orca'
import type { JevRecommendation, ToolboxActivity, ToolboxEvent } from './toolbox-types'

const copy = {
  ko: {
    heading: 'Jev 추천', lookup: 'Jev 직접 조회', directHelp: '에이전트가 Jev를 직접 호출했습니다. 이 경로에서는 어떤 후보가 반환됐는지 확인할 수 없습니다.', empty: '공용 실행기에서 받은 추천이 여기에 표시됩니다. Jev를 직접 호출한 기록은 최근 도구 호출에서 볼 수 있습니다.',
    failed: '추천 기록을 불러오지 못했습니다.', suggested: '추천됨', skill: '스킬', mcp: 'MCP 서버',
    reading: '읽는 중', read: '읽음', readFailed: '읽기 실패', calling: '호출 중', called: '호출 완료', callFailed: '호출 실패',
    older: '이전 추천', earlierCalls: '이전 요청'
  },
  en: {
    heading: 'Jev recommendations', lookup: 'Direct Jev lookup', directHelp: 'The agent called Jev directly. The returned candidates are unavailable for this call.', empty: 'Shared runner recommendations appear here. Direct Jev lookups appear under Recent tool calls.',
    failed: 'Recommendation history is unavailable.', suggested: 'Suggested', skill: 'Skill', mcp: 'MCP server',
    reading: 'Reading', read: 'Read', readFailed: 'Read failed', calling: 'Calling', called: 'Call completed', callFailed: 'Call failed',
    older: 'Earlier recommendations', earlierCalls: 'Earlier requests'
  }
}
const labels = () => env.locale.toLowerCase().startsWith('ko') ? copy.ko : copy.en
function resultLabel(event: ToolboxEvent) {
  const t = labels()
  if (event.operation === 'skill') return { running: t.reading, succeeded: t.read, failed: t.readFailed }[event.state]
  return { running: t.calling, succeeded: t.called, failed: t.callFailed }[event.state]
}
function Recommendation({ item, events }: { item: JevRecommendation; events: ToolboxEvent[] }) {
  const t = labels()
  const calls = events.filter(event => event.recommendationId === item.id && (event.operation === 'skill' || event.operation === 'call'))
    .sort((a, b) => b.startedAt - a.startedAt)
  const latest = calls[0]
  const type = item.kind === 'skill' ? t.skill : t.mcp
  return <Stack gap="xs">
    <Row gap="sm" align="center" justify="between" wrap>
      <Box grow minWidth={0}><Text size="sm" weight="semibold">{item.name}</Text></Box>
      <Badge tone={!latest ? 'neutral' : latest.state === 'failed' ? 'danger' : latest.state === 'running' ? 'accent' : 'success'}>{latest ? resultLabel(latest) : t.suggested}</Badge>
    </Row>
    <Row gap="xs" align="center" wrap><Text size="xs" muted>{type}</Text><RelativeTime at={item.at} muted /></Row>
    {latest?.operation === 'call' ? <Text size="sm">{latest.name}</Text> : null}
    {calls.length > 1 ? <Collapsible title={t.earlierCalls + ' · ' + (calls.length - 1)}><Stack gap="xs">{calls.slice(1).map(event =>
      <Row key={event.id} align="center" justify="between" gap="sm" wrap>
        <Text size="xs">{event.name}</Text><Text size="xs" muted>{resultLabel(event)}</Text>
      </Row>)}</Stack></Collapsible> : null}
  </Stack>
}
export function isJevLookup(name: string) {
  return /^(?:(?:jev\/|mcp__jev__|jev · )jev_(?:rank|classify|score|check|ask|search)|jev-code\/(?:rank|classify))$/i.test(name)
}
export type DirectLookup = { name: string; provider: string; at?: number }
function DirectRow({ lookup }: { lookup: DirectLookup }) {
  const t = labels()
  return <Stack gap="xs">
    <Collapsible title={t.lookup + ' · ' + lookup.name}><Text size="xs" muted>{t.directHelp}</Text></Collapsible>
    <Row gap="xs" align="center"><Text size="xs" muted>{lookup.provider}</Text>{lookup.at ? <RelativeTime at={lookup.at} muted /> : null}</Row>
  </Stack>
}
export function RecommendationActivity({ snapshot, unavailable, direct }: { snapshot: ToolboxActivity | null; unavailable: boolean; direct?: DirectLookup }) {
  const t = labels()
  const items = [...(snapshot?.recommendations ?? [])].sort((a, b) => b.at - a.at)
  if (!items.length && direct) return <DirectRow lookup={direct} />
  if (!items.length) return <Collapsible title={t.heading + (unavailable ? '' : ' · 0')}><Text size="xs" muted>{unavailable ? t.failed : t.empty}</Text></Collapsible>
  const rows = (list: JevRecommendation[]) => list.map((item, index) => <Stack key={item.id} gap="sm">
    {index ? <Separator /> : null}<Recommendation item={item} events={snapshot?.events ?? []} />
  </Stack>)
  return <Stack gap="sm">
    <Row align="center" justify="between" gap="sm"><Heading level={2}>{t.heading}</Heading><Text size="sm" muted>{String(items.length)}</Text></Row>
    <Box direction="column" gap="sm" padding="sm" border radius="sm">{rows(items.slice(0, 3))}</Box>
    {direct ? <DirectRow lookup={direct} /> : null}
    {items.length > 3 ? <Collapsible title={t.older + ' · ' + (items.length - 3)}><Stack gap="sm">{rows(items.slice(3))}</Stack></Collapsible> : null}
  </Stack>
}
