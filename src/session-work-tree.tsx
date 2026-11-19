import { atom, Badge, Box, read, RelativeTime, Row, set, Text, Tree, type IconName, type TreeItem } from 'orca'
import type { SessionShells, SessionWorkNode } from './session-shells'

const copy = {
  en: {
    recent: 'Recently used tools', completed: 'Finished', failed: 'Failed', cancelled: 'Cancelled', tool: 'Tool',
    tree: 'Execution tree', subagent: 'Subagent', shell: 'Shell', edit: 'File edit', background: 'Background command', terminal: 'Terminal',
    workflow: 'Workflow', monitor: 'Monitor', working: 'Working', monitoring: 'Monitoring', running: 'Running',
    connected: 'Connected', context: 'Parent', since: 'Started', reported: 'Antigravity · Last reported',
  },
  ko: {
    recent: '최근 사용 도구', completed: '완료', failed: '실패', cancelled: '취소', tool: '도구',
    tree: '실행 트리', subagent: '서브에이전트', shell: '셸', edit: '파일 편집', background: '백그라운드 명령', terminal: '터미널',
    workflow: '워크플로', monitor: '모니터', working: '작업 중', monitoring: '모니터링 중', running: '실행 중',
    connected: '연결됨', context: '상위 작업', since: '시작', reported: 'Antigravity · 마지막 보고',
  },
}
const icons: Record<SessionWorkNode['kind'], IconName> = {
  tool: 'wrench', subagent: 'bot', shell: 'terminal', edit: 'edit', background: 'terminal', terminal: 'terminal', workflow: 'layers', monitor: 'activity',
}
// Orca counts the session itself in both native Tree limits.
const maxTreeDepth = 16
const maxTreeItems = 2000
const rootKey = 'session-root'
const recentKey = 'turn-tools'
const moreKey = 'turn-tools-more'
const previewSize = 3
const toolKey = (name: string) => 'turn-tool:' + name
type TurnTools = NonNullable<SessionShells['turnTools']>
const collapsed = atom<string[]>([moreKey])
const selected = atom<string | null>(null)

// Keep unnamed workers distinguishable while siblings appear or finish between polls.
let owner: string | null = null
let nextNumber = 1
let numbers = new Map<string, number>()

export function resetWorkTree() {
  owner = null
  nextNumber = 1
  numbers.clear()
  set(collapsed, [moreKey])
  set(selected, null)
}

// A provider may report several parallel reads with the same name. Group within one owner only.
function liveCallKey(node: SessionWorkNode, parent: string): string | undefined {
  if ((node.kind === 'tool' || node.kind === 'edit') && node.toolName && node.state === 'running' && !node.children.length) {
    return 'live-tool:' + parent + ':' + node.kind + ':' + node.toolName
  }
}

export function updateWorkTree(session: string, nodes: SessionWorkNode[], recent: TurnTools = []) {
  if (owner !== session) { resetWorkTree(); owner = session }
  const live = new Set<string>(), unnamed = new Set<string>()
  function visit(items: SessionWorkNode[], parent: string) {
    for (const item of items) {
      live.add(liveCallKey(item, parent) ?? item.id)
      if (item.kind === 'subagent' && !item.name) unnamed.add(item.id)
      visit(item.children, item.id)
    }
  }
  visit(nodes, rootKey)
  numbers = new Map([...unnamed].map(id => [id, numbers.get(id) ?? nextNumber++]))
  if (recent.length) live.add(recentKey)
  if (recent.length > previewSize) live.add(moreKey)
  for (const tool of recent) live.add(toolKey(tool.name))
  const folds = read(collapsed), kept = folds.filter(id => id === rootKey || id === moreKey || live.has(id))
  if (!recent.length && !kept.includes(moreKey)) kept.push(moreKey)
  if (kept.length !== folds.length || kept.some((key, i) => key !== folds[i])) set(collapsed, kept)
  const choice = read(selected)
  if (choice && choice !== rootKey && (!live.has(choice) ||
      (kept.includes(moreKey) && recent.findIndex(tool => toolKey(tool.name) === choice) >= previewSize))) set(selected, null)
}

export function sessionTree(nodes: SessionWorkNode[], locale: keyof typeof copy, providerEnabled: boolean, recent: TurnTools = [], limited = false) {
  const t = copy[locale], details = new Map<string, { node: SessionWorkNode; label: string; count: number }>()
  const recentDetails = new Map<string, TurnTools[number]>()
  const branches: string[] = []
  let remaining = maxTreeItems - 1, omitted = 0, activeAgents = 0
  function visible(node: SessionWorkNode): boolean {
    if (node.statusSource === 'antigravity' && !providerEnabled) return false
    return node.state !== 'context' || node.children.some(visible)
  }
  function items(list: SessionWorkNode[], depth: number, parent: string): TreeItem[] {
    const rows: TreeItem[] = []
    const counts = new Map<string, number>()
    for (const node of list) {
      const key = liveCallKey(node, parent)
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    for (const node of list) {
      if (!visible(node)) continue
      if (node.kind === 'subagent' && node.state !== 'context') activeAgents++
      const grouped = liveCallKey(node, parent)
      const count = grouped ? counts.get(grouped) : 1
      if (!count) continue
      if (grouped) counts.delete(grouped)
      const key = grouped ?? node.id
      const fits = remaining > 0 && depth <= maxTreeDepth
      if (fits) remaining--
      const children = node.children.length ? items(node.children, depth + 1, key) : []
      if (!fits) { omitted++; continue }
      if (children.length) branches.push(key)
      const ordinal = node.kind === 'subagent' ? numbers.get(node.id) : undefined
      const label = node.toolName || node.name || (ordinal ? t.subagent + ' ' + ordinal : t[node.kind])
      details.set(key, { node, label, count })
      const program = node.kind === 'shell' && node.name && node.name !== label ? node.name : undefined
      const number = count > 1 ? (locale === 'ko' ? count + '건' : '×' + count) : undefined
      rows.push({ key, label, icon: icons[node.kind], description: [t[node.state], number, program].filter(Boolean).join(' · '),
        ...(children.length ? { children } : {}) })
    }
    return rows
  }
  const children = items(nodes, 2, rootKey)
  // Live work gets the full renderer budget before the bounded, most-recent-first history.
  if (recent.length && remaining >= 2) {
    const useMore = recent.length > previewSize && remaining >= previewSize + 3
    const available = Math.min(recent.length, remaining - (useMore ? 2 : 1), useMore ? Infinity : previewSize)
    const rows = recent.slice(0, available).map((tool): TreeItem => {
      const key = toolKey(tool.name)
      recentDetails.set(key, tool)
      let description: string = t[tool.state]
      if (tool.count > 1) {
        const times = locale === 'ko' ? tool.count + '회' : '×' + tool.count
        const outcome = locale === 'ko' ? '최근 ' + t[tool.state] : 'last ' + t[tool.state].toLowerCase()
        description = tool.state === 'completed' ? (locale === 'ko' ? times + ' 종료' : tool.count + ' finished') : times + ' · ' + outcome
      }
      return { key, label: tool.name, icon: tool.state === 'failed' ? 'error' : tool.state === 'cancelled' ? 'stop' : 'wrench', description }
    })
    if (useMore) {
      const rest = rows.splice(previewSize)
      rows.push({ key: moreKey, label: locale === 'ko' ? '도구 ' + rest.length + '개 더 보기' : rest.length + ' more tool' + (rest.length === 1 ? '' : 's'),
        children: rest })
      branches.push(moreKey)
    }
    children.push({ key: recentKey, label: t.recent, icon: 'layers', children: rows,
      ...(limited ? { description: locale === 'ko' ? '최근 종료 30회 기준' : 'Last 30 finished calls' } : {}) })
    branches.push(recentKey)
    omitted += recent.length - available
  } else omitted += recent.length
  if (children.length) branches.push(rootKey)
  return { children, branches, details, recentDetails, activeAgents, omitted }
}

function turnSummary(activity: SessionShells['turnActivity'], locale: keyof typeof copy): string {
  if (!activity) return ''
  const { tools, commands, edits } = activity
  const ko = locale === 'ko'
  const counts: string[] = []
  if (tools > 0) counts.push(ko ? `도구 호출 ${tools}회` : `${tools} tool call${tools === 1 ? '' : 's'}`)
  if (commands > 0) counts.push(ko ? `명령 ${commands}회` : `${commands} command${commands === 1 ? '' : 's'}`)
  if (edits > 0) counts.push(ko ? `변경 기록 ${edits}건` : `${edits} diff${edits === 1 ? '' : 's'}`)
  return counts.length ? [ko ? '이번 턴' : 'This turn', ...counts].join(' · ') : ''
}

export function SessionWorkTree({ model, locale, name, terminal, mainWorking, turnActivity }: {
  model: ReturnType<typeof sessionTree>; locale: keyof typeof copy; name: string; terminal: boolean; mainWorking: boolean
  turnActivity?: SessionShells['turnActivity']
}) {
  const t = copy[locale], folds = read(collapsed), choice = read(selected)
  const root: TreeItem = { key: rootKey, label: name, icon: terminal ? 'terminal' : 'branch',
    ...(mainWorking ? { description: t.working } : {}), ...(model.children.length ? { children: model.children } : {}) }
  const detail = choice ? model.details.get(choice) : undefined
  const recent = choice ? model.recentDetails.get(choice) : undefined
  const summary = turnSummary(turnActivity, locale)
  function select({ key }: { key: string }) {
    set(selected, key)
    if (key === moreKey && read(collapsed).includes(key)) set(collapsed, read(collapsed).filter(id => id !== key))
  }
  function toggle({ key, expanded }: { key: string; expanded: boolean }) {
    const previous = read(collapsed)
    set(collapsed, expanded ? previous.filter(id => id !== key) : [...new Set([...previous, key])])
    if (expanded || !choice || choice === key) return
    function containsSelection(items: readonly TreeItem[], inside = false): boolean {
      return items.some(item => (inside && item.key === choice) ||
        (item.children && containsSelection(item.children, inside || item.key === key)))
    }
    if (containsSelection([root])) set(selected, key)
  }
  return <Box direction="column" border radius="md">
    <Tree label={t.tree} items={[root]} maxHeight="md" expanded={model.branches.filter(id => !folds.includes(id))}
      selected={choice ?? undefined}
      onSelect={select} onAction={select} onToggle={toggle} />
    {summary ? <Box padding="xs"><Text size="xs" muted>{summary}</Text></Box> : null}
    {model.omitted ? <Text size="xs" muted>{locale === 'ko' ? `Orca 표시 한도로 항목 ${model.omitted}개가 생략되었습니다.`
      : `${model.omitted} more ${model.omitted === 1 ? 'item exceeds' : 'items exceed'} Orca’s tree display limit.`}</Text> : null}
    {detail ? <Box direction="column" gap="xs" padding="sm" background="muted" radius="sm">
      <Text size="sm" weight="semibold">{detail.label}</Text>
      <Row align="center" gap="xs" wrap>
        {detail.node.toolName || detail.node.name ? <Text size="xs" muted>{t[detail.node.kind]}{detail.node.kind === 'shell' && detail.node.name && detail.node.name !== detail.label ? ' · ' + detail.node.name : ''}</Text> : null}
        <Badge tone={detail.node.state === 'context' || detail.node.state === 'connected' ? 'neutral' : 'accent'}>{t[detail.node.state]}</Badge>
      </Row>
      {detail.count > 1 ? <Text size="xs" muted>{locale === 'ko' ? `실행 중인 호출 ${detail.count}건` : `${detail.count} running calls`}</Text> : detail.node.statusUpdatedAt || detail.node.since ? <Row align="center" gap="xs" wrap>
        <Text size="xs" muted>{detail.node.statusSource === 'antigravity' ? t.reported : t.since}</Text>
        <RelativeTime at={detail.node.statusUpdatedAt ?? detail.node.since!} muted />
      </Row> : null}
    </Box> : recent ? <Box direction="column" gap="xs" padding="sm" background="muted" radius="sm">
      <Text size="sm" weight="semibold">{recent.name}</Text>
      <Text size="xs" muted>{locale === 'ko' ? `종료된 호출 ${recent.count}회 · 최근 결과 ${t[recent.state]}`
        : `${recent.count} finished call${recent.count === 1 ? '' : 's'} · Last outcome ${t[recent.state].toLowerCase()}`}</Text>
    </Box> : null}
  </Box>
}
