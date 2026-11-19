import { atom, Badge, Box, Heading, plugin, read, RelativeTime, Row, Select, set, Stack, Text } from 'orca'
import type { SessionShells } from './session-shells'

const report = atom<SessionShells | null>(null)
const selected = atom<string | null>(null)
const fetching = atom(false)
let generation = 0
let pending: Promise<void> | null = null

export function resetSessionWork(resetSelection = true) {
  generation++
  pending = null
  set(report, null)
  set(fetching, false)
  if (resetSelection) set(selected, null)
}

export function refreshSessionWork(visible: () => boolean): Promise<void> {
  if (!visible()) return Promise.resolve()
  if (pending) return pending
  const current = generation
  const choice = read(selected)
  pending = (async () => {
    try {
      const next = await plugin.request('session.shells', { selected: choice })
      if (current !== generation || !visible()) return
      if (!next || !Array.isArray(next.options) || !Array.isArray(next.rows)) throw new Error('Shell status unavailable')
      set(report, next)
    } catch {
      if (current === generation && visible()) set(report, { status: 'unavailable', selected: null, options: [], rows: [], subagents: [] })
    } finally {
      if (current === generation) { pending = null; set(fetching, false) }
    }
  })()
  return pending
}

const copy = {
  en: {
    title: 'Session activity', session: 'Session', chat: 'Chat', terminal: 'Terminal', shell: 'Shell', background: 'Background command',
    choose: 'Choose a session', auto: 'Follow selection', ready: 'No running shells or subagents reported.',
    missing: 'The selected session is no longer available. Choose a session to continue.',
    noSession: 'No local chat or terminal is available in this workspace.', unavailable: 'Session status is unavailable.', disabled: 'Turn on chat activity in Settings & privacy to monitor this session.',
    loading: 'Checking session…', subagent: 'Subagent', working: 'Working', monitoring: 'Monitoring',
    running: 'Running', connected: 'Connected', waiting: 'Waiting', unknown: 'Unverified', lastReported: 'Last reported'
  },
  ko: {
    title: '세션 활동', session: '세션', chat: '대화', terminal: '터미널', shell: '셸', background: '백그라운드 명령',
    choose: '세션 선택', auto: '선택한 세션 따라가기', ready: '실행 중으로 보고된 셸이나 서브에이전트가 없습니다.',
    missing: '선택한 세션을 확인할 수 없습니다. 다른 세션을 선택하세요.',
    noSession: '이 작업공간에 선택할 로컬 대화나 터미널이 없습니다.', unavailable: '세션 상태를 확인할 수 없습니다.', disabled: '이 세션을 보려면 설정 및 개인정보에서 채팅 활동 표시를 켜세요.',
    loading: '세션 확인 중…', subagent: '서브에이전트', working: '작업 중', monitoring: '모니터링 중',
    running: '실행 중', connected: '연결됨', waiting: '대기 중', unknown: '확인 불가', lastReported: '마지막 보고'
  }
} as const

const providers: Record<string, string> = {
  codex: 'Codex', claude: 'Claude', gemini: 'Gemini', antigravity: 'Antigravity', cursor: 'Cursor',
  copilot: 'Copilot', droid: 'Droid', grok: 'Grok', omp: 'OMP', opencode: 'OpenCode', pi: 'Pi'
}

export function SessionWork({ locale, visible, nativeEnabled, providerEnabled }: {
  locale: keyof typeof copy; visible: () => boolean; nativeEnabled: boolean; providerEnabled: boolean
}) {
  const t = copy[locale], result = read(report)
  const choice = read(selected), loading = read(fetching) || !result
  const options = (nativeEnabled ? result?.options ?? [] : []).map(option => ({
    value: option.id, label: [option.provider && (providers[option.provider.toLowerCase()] || option.provider), t[option.kind], option.number].filter(Boolean).join(' ')
  }))
  const currentOption = options.find(option => option.value === result?.selected)
  const pinned = options.some(option => option.value === choice)
  const automatic = 'follow-active'
  const choose = (value: string) => {
    generation++
    pending = null
    set(selected, value === automatic ? null : value)
    set(fetching, true)
    return refreshSessionWork(visible)
  }
  const ready = nativeEnabled && !loading && result?.status === 'ready'
  const rows = ready ? result.rows.filter(row => row.state === 'running' || (row.kind === 'terminal' && row.state === 'connected')) : []
  const agents = ready ? (result.subagents ?? []).filter(a =>
    a.role === 'subagent' && (a.state === 'working' || a.state === 'monitoring') && (a.statusSource !== 'antigravity' || providerEnabled)) : []
  let status: string | null = t.ready
  if (!nativeEnabled || result?.status === 'disabled') status = t.disabled
  else if (loading) status = t.loading
  else if (result?.status === 'unavailable') status = t.unavailable
  else if (result?.status === 'select') {
    status = !options.length ? t.noSession : choice && !pinned ? t.missing : null
  }
  return <Stack gap="sm">
    <Row justify="between" align="center" gap="sm" wrap>
      <Heading level={2}>{t.title}</Heading>
      {ready && currentOption && options.length === 1 && !choice ? <Text size="xs" muted>{currentOption.label}</Text> : null}
    </Row>
    {options.length && (options.length > 1 || choice || !ready) ? <Select label={t.session} labelHidden
      value={choice ? (pinned ? choice : '') : (currentOption ? automatic : '')} placeholder={t.choose}
      options={[{ value: automatic, label: !choice && currentOption ? t.auto + ' · ' + currentOption.label : t.auto }, ...options]}
      onChange={choose} /> : null}
    {rows.length || agents.length ? <Box direction="column" gap="sm" padding="sm" border radius="md">
      {rows.map((item, index) => <Row key={'shell:' + index} align="center" justify="between" gap="sm" wrap>
        <Box direction="column" gap="xs" grow minWidth={0}>
          <Text size="sm" weight="semibold" truncate>{item.name || t[item.kind]}</Text>
          {item.name && item.name !== t[item.kind] ? <Text size="xs" muted>{t[item.kind]}</Text> : null}
          {item.since ? <RelativeTime at={item.since} muted /> : null}
        </Box>
        <Badge tone={item.state === 'running' ? 'accent' : 'neutral'}>{t[item.state]}</Badge>
      </Row>)}
      {agents.map((agent, index) => <Stack key={'agent:' + index} gap="xs">
        <Row align="center" justify="between" gap="sm" wrap>
          <Box direction="column" gap="xs" grow minWidth={0}>
            <Text size="sm" weight="semibold" truncate>{agent.label || t.subagent}</Text>
            {agent.label ? <Text muted size="xs">{t.subagent}</Text> : null}
          </Box>
          <Badge tone={agent.statusSource === 'antigravity' ? 'neutral' : 'accent'}>{agent.state === 'monitoring' ? t.monitoring : t.working}</Badge>
        </Row>
        {agent.statusSource === 'antigravity' && agent.statusUpdatedAt ? <Row gap="xs" wrap>
          <Text muted size="xs">{'Antigravity · ' + t.lastReported}</Text><RelativeTime at={agent.statusUpdatedAt} muted />
        </Row> : null}
      </Stack>)}
    </Box> : status ? <Text size="sm" muted>{status}</Text> : null}
  </Stack>
}
