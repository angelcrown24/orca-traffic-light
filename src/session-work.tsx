import { atom, Badge, Box, Button, Heading, plugin, read, Row, set, Stack, Text } from 'orca'
import type { TerminalActivity } from './terminal-activity'

const activity = atom<TerminalActivity | null>(null)
const page = atom(0)
const pageSize = 6
let generation = 0, pending: Promise<void> | null = null

export function resetSessionWork() {
  generation++; pending = null
  set(activity, null); set(page, 0)
}

export function refreshSessionWork(visible: () => boolean): Promise<void> {
  if (!visible()) return Promise.resolve()
  if (pending) return pending
  const version = generation
  pending = (async () => {
    try {
      const result = await plugin.request('activity.terminals')
      if (version === generation && visible()) set(activity, result)
    } catch {
      if (version === generation && visible()) set(activity, { status:'unavailable', openTerminals:0, rows:[] })
    } finally { if (version === generation) pending = null }
  })()
  return pending
}

const copy = {
  en: {
    heading:'Terminal activity', terminal:'Terminal', open:'Open terminals', working:'Working', waiting:'Waiting', blocked:'Blocked', observed:'Tool running',
    previous:'Previous terminals', next:'Next terminals', disabled:'Turn on terminal agent status in Settings & privacy.', loading:'Checking terminal agents…',
    missing:'Terminal status is unavailable.', partial:'Agent status is unavailable. Observed terminal calls are shown.',
    empty:'No active terminal agents reported.', coverage:'Native chat tool calls and subagent trees are unavailable through Orca’s plugin API.'
  },
  ko: {
    heading:'터미널 활동', terminal:'터미널', open:'열린 터미널', working:'작업 중', waiting:'대기 중', blocked:'차단됨', observed:'도구 실행 중',
    previous:'이전 터미널', next:'다음 터미널', disabled:'설정 및 개인정보에서 터미널 에이전트 상태 표시를 켜세요.', loading:'터미널 에이전트 확인 중…',
    missing:'터미널 상태를 확인할 수 없습니다.', partial:'에이전트 상태를 확인할 수 없어 감지된 터미널 호출만 표시합니다.',
    empty:'활동 중으로 보고된 터미널 에이전트가 없습니다.', coverage:'Orca 플러그인 API는 네이티브 채팅의 도구 호출과 서브에이전트 관계를 제공하지 않습니다.'
  }
} as const
const providers: Record<string,string> = { codex:'Codex', claude:'Claude', antigravity:'Antigravity', gemini:'Gemini', opencode:'OpenCode', copilot:'Copilot' }

export function SessionWork({locale, enabled}: {locale: keyof typeof copy; enabled: boolean}) {
  const t = copy[locale], snapshot = read(activity)
  const rows = enabled && snapshot ? snapshot.rows : []
  const last = Math.max(0, Math.ceil(rows.length / pageSize) - 1), current = Math.min(last,read(page))
  const available = enabled && snapshot && (snapshot.status === 'ready' || snapshot.status === 'partial')
  const status = !enabled || snapshot?.status === 'disabled' ? t.disabled : !snapshot ? t.loading :
    snapshot.status === 'unavailable' ? t.missing : snapshot.status === 'partial' ? t.partial : !rows.length ? t.empty : null
  return <Stack gap="sm">
    <Row justify="between" align="center" wrap><Heading level={2}>{t.heading}</Heading>
      {available ? <Text muted size="xs">{t.open} · {snapshot.openTerminals}</Text> : null}</Row>
    {status ? <Text muted size="sm">{status}</Text> : null}
    {rows.slice(current * pageSize,(current + 1) * pageSize).map(row => <Box key={String(row.terminal)} direction="column" gap="xs" border padding="sm" radius="md">
      <Row justify="between" align="center" wrap><Text size="sm" weight="semibold">{[row.agent && (providers[row.agent.toLowerCase()] ?? row.agent),t.terminal + ' ' + row.terminal].filter(Boolean).join(' · ')}</Text>
        <Badge tone={row.state === 'blocked' ? 'warning' : row.state === 'waiting' ? 'neutral' : 'accent'}>{t[row.state]}</Badge></Row>
      {row.tools.length ? <Text size="xs">{row.tools.join(' · ')}</Text> : null}
    </Box>)}
    {last > 0 ? <Row align="center" justify="between"><Button size="sm" variant="ghost" disabled={!current} onPress={() => set(page,current-1)}>{t.previous}</Button>
      <Text size="xs" muted>{current+1} / {last+1}</Text><Button size="sm" variant="ghost" disabled={current===last} onPress={() => set(page,current+1)}>{t.next}</Button></Row> : null}
    {enabled ? <Text muted size="xs">{t.coverage}</Text> : null}
  </Stack>
}
