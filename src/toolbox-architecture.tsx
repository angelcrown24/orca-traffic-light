import { Badge, Box, Heading, Row, Stack, Text } from 'orca'
import { englishCount } from './panel-language'
import type { CatalogItem, ToolboxState } from './toolbox-types'

const providers = ['Codex', 'Claude', 'Gemini', 'Antigravity']
const providerKey = (name: string) => name.toLowerCase().replace(/\s+(code|cli)$/, '')
export function topology(items: CatalogItem[], state: ToolboxState) {
  const counts = (subset: CatalogItem[]) => ({ skills: subset.filter(item => item.kind === 'skill').length, mcp: subset.filter(item => item.kind === 'mcp').length })
  const applied = state.automation?.enabled ? new Set(state.automation.appliedIds ?? []) : new Set<string>()
  return {
    providers: providers.map(name => ({ name, ...counts(items.filter(item => item.providers.some(provider => providerKey(provider) === providerKey(name)))) })),
    catalog: counts(items), shared: counts(items.filter(item => item.sharing?.state === 'shared')),
    selected: state.selected.length, applied: applied.size,
    sessions: state.automation?.sessions ?? 0,
    running: state.events.filter(event => event.state === 'running').length,
    succeeded: state.events.filter(event => event.state === 'succeeded').length,
    failed: state.events.filter(event => event.state === 'failed').length,
  }
}
function Stem() {
  return <Box align="center" gap="none"><Box width={1} height={14} border="accent" /><Text size="xs" tone="accent">▼</Text></Box>
}
export function ArchitectureDiagram({ items, state, ko }: { items: CatalogItem[]; state: ToolboxState; ko: boolean }) {
  const data = topology(items, state)
  return <Stack gap="none">
    <Box columns={4} gap="xs">
      {data.providers.map(provider => <Box key={provider.name} direction="column" gap="xs" align="center" justify="center" paddingX="xs" paddingY="sm" border radius="md" background="card">
        <Text size="xs" weight="semibold">{provider.name}</Text>
        <Text size="xs">{`${ko ? '스킬' : 'Skills'} ${provider.skills}`}</Text>
        <Text size="xs">{`MCP ${provider.mcp}`}</Text>
      </Box>)}
    </Box>
    <Box columns={4} gap="xs">{data.providers.map(provider => <Box key={provider.name} align="center"><Box width={1} height={16} border="accent" /></Box>)}</Box>
    <Box align="center"><Box width="76%" height={1} border="accent" /></Box>
    <Stem />
    <Box direction="column" gap="sm" align="center" padding="md" border="accent" radius="md" background="accent">
      <Heading level={3}>{ko ? '공용 저장소' : 'Shared store'}</Heading>
      <Row gap="sm" wrap justify="center"><Badge tone="accent">{`${ko ? '스킬' : 'Skills'} ${data.shared.skills}`}</Badge><Badge tone="accent">{`${ko ? 'MCP 서버' : 'MCP servers'} ${data.shared.mcp}`}</Badge></Row>
      <Text size="xs" muted>{ko ? `전체 발견: 스킬 ${data.catalog.skills} · MCP 서버 ${data.catalog.mcp}` : `Discovered: ${englishCount(data.catalog.skills, 'skill')} · ${englishCount(data.catalog.mcp, 'MCP server')}`}</Text>
    </Box>
    <Stem />
    <Box direction="column" gap="sm" align="center" padding="md" border radius="md" background="card">
      <Text weight="semibold">{ko ? '이 작업공간의 허용 목록' : 'This workspace’s allowlist'}</Text>
      <Row gap="md" justify="center" wrap><Text size="sm">{`${ko ? '선택' : 'Selected'} ${data.selected}`}</Text><Badge tone={data.applied ? 'success' : 'neutral'}>{`${ko ? '새 세션에 적용' : 'Applied to new sessions'} ${data.applied}`}</Badge></Row>
    </Box>
    <Stem />
    <Box direction="column" gap="sm" align="center" padding="md" border="accent" radius="md" background="card">
      <Text weight="semibold">{ko ? '필요할 때 실행' : 'Run on demand'}</Text>
      <Row justify="center" gap="sm" wrap><Badge>{`${ko ? '연결 세션' : 'Sessions'} ${data.sessions}`}</Badge><Badge tone={data.running ? 'accent' : 'neutral'}>{`${ko ? '실행 중' : 'Running'} ${data.running}`}</Badge></Row>
      <Text muted size="xs">{ko ? '요청한 스킬·도구만 불러오기' : 'Load only the skill or tool requested'}</Text>
    </Box>
    <Stem />
    <Box direction="column" gap="sm" align="center" padding="sm" border radius="md" background="muted">
      <Text size="sm" weight="semibold">{ko ? 'Traffic Light · 최근 실행 기록' : 'Traffic Light · recent calls'}</Text>
      <Row gap="md" justify="center"><Text size="sm" tone="success">{`${ko ? '완료' : 'Completed'} ${data.succeeded}`}</Text><Text size="sm" tone={data.failed ? 'danger' : 'neutral'}>{`${ko ? '실패' : 'Failed'} ${data.failed}`}</Text></Row>
    </Box>
  </Stack>
}
