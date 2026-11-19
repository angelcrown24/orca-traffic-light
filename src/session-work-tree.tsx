import { atom, Badge, Box, read, RelativeTime, Row, set, Text, Tree, type IconName, type TreeItem } from 'orca'
import type { SessionShells, SessionWorkNode } from './session-shells'

const copy = {
  en: {
    tree: 'Execution tree', subagent: 'Subagent', shell: 'Shell', edit: 'File edit', background: 'Background command', terminal: 'Terminal',
    workflow: 'Workflow', monitor: 'Monitor', working: 'Working', monitoring: 'Monitoring', running: 'Running',
    connected: 'Connected', context: 'Parent', since: 'Started', reported: 'Antigravity · Last reported',
  },
  ko: {
    tree: '실행 트리', subagent: '서브에이전트', shell: '셸', edit: '파일 편집', background: '백그라운드 명령', terminal: '터미널',
    workflow: '워크플로', monitor: '모니터', working: '작업 중', monitoring: '모니터링 중', running: '실행 중',
    connected: '연결됨', context: '상위 작업', since: '시작', reported: 'Antigravity · 마지막 보고',
  },
}
const icons: Record<SessionWorkNode['kind'], IconName> = {
  subagent: 'bot', shell: 'terminal', edit: 'edit', background: 'terminal', terminal: 'terminal', workflow: 'layers', monitor: 'activity',
}
// Orca counts the session itself in both native Tree limits.
const maxTreeDepth = 16
const maxTreeItems = 2000
const rootKey = 'session-root'
const collapsed = atom<string[]>([])
const selected = atom<string | null>(null)

// Keep unnamed workers distinguishable while siblings appear or finish between polls.
let owner: string | null = null
let nextNumber = 1
let numbers = new Map<string, number>()

export function resetWorkTree() {
  owner = null
  nextNumber = 1
  numbers.clear()
  set(collapsed, [])
  set(selected, null)
}

export function updateWorkTree(session: string, nodes: SessionWorkNode[]) {
  if (owner !== session) { resetWorkTree(); owner = session }
  const live = new Set<string>(), unnamed = new Set<string>()
  function visit(items: SessionWorkNode[]) {
    for (const item of items) {
      live.add(item.id)
      if (item.kind === 'subagent' && !item.name) unnamed.add(item.id)
      visit(item.children)
    }
  }
  visit(nodes)
  numbers = new Map([...unnamed].map(id => [id, numbers.get(id) ?? nextNumber++]))
  const folds = read(collapsed), kept = folds.filter(id => id === rootKey || live.has(id))
  if (kept.length !== folds.length) set(collapsed, kept)
  const choice = read(selected)
  if (choice && !live.has(choice) && choice !== rootKey) set(selected, null)
}

export function sessionTree(nodes: SessionWorkNode[], locale: keyof typeof copy, providerEnabled: boolean) {
  const t = copy[locale], details = new Map<string, { node: SessionWorkNode; label: string }>()
  const branches: string[] = []
  let remaining = maxTreeItems - 1, omitted = 0, activeAgents = 0
  function visible(node: SessionWorkNode): boolean {
    if (node.statusSource === 'antigravity' && !providerEnabled) return false
    return node.state !== 'context' || node.children.some(visible)
  }
  function items(list: SessionWorkNode[], depth: number): TreeItem[] {
    const rows: TreeItem[] = []
    for (const node of list) {
      if (!visible(node)) continue
      if (node.kind === 'subagent' && node.state !== 'context') activeAgents++
      const fits = remaining > 0 && depth <= maxTreeDepth
      if (fits) remaining--
      const children = items(node.children, depth + 1)
      if (!fits) { omitted++; continue }
      if (children.length) branches.push(node.id)
      const ordinal = node.kind === 'subagent' ? numbers.get(node.id) : undefined
      const label = node.name || (ordinal ? t.subagent + ' ' + ordinal : t[node.kind])
      details.set(node.id, { node, label })
      rows.push({ key: node.id, label, icon: icons[node.kind], description: t[node.state], ...(children.length ? { children } : {}) })
    }
    return rows
  }
  const children = items(nodes, 2)
  if (children.length) branches.push(rootKey)
  return { children, branches, details, activeAgents, omitted }
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
  const summary = turnSummary(turnActivity, locale)
  const select = ({ key }: { key: string }) => set(selected, key)
  function toggle({ key, expanded }: { key: string; expanded: boolean }) {
    const previous = read(collapsed)
    set(collapsed, expanded ? previous.filter(id => id !== key) : [...new Set([...previous, key])])
    if (expanded || !choice || choice === key) return
    const containsSelection = (node: SessionWorkNode): boolean => node.id === choice || node.children.some(containsSelection)
    if (key === rootKey || model.details.get(key)?.node.children.some(containsSelection)) set(selected, key)
  }
  return <Box direction="column" border radius="md" padding="sm" gap="xs">
    <Tree label={t.tree} items={[root]} maxHeight="md" expanded={model.branches.filter(id => !folds.includes(id))}
      selected={detail ? choice! : choice === rootKey ? rootKey : undefined}
      onSelect={select} onAction={select} onToggle={toggle} />
    {summary ? <Text size="xs" muted>{summary}</Text> : null}
    {model.omitted ? <Text size="xs" muted>{locale === 'ko' ? `Orca 표시 한도로 항목 ${model.omitted}개가 생략되었습니다.`
      : `${model.omitted} more ${model.omitted === 1 ? 'item exceeds' : 'items exceed'} Orca’s tree display limit.`}</Text> : null}
    {detail ? <Box direction="column" gap="xs" padding="sm" background="muted" radius="sm">
      <Text size="sm" weight="semibold">{detail.label}</Text>
      <Row align="center" gap="xs" wrap>
        {detail.node.name ? <Text size="xs" muted>{t[detail.node.kind]}</Text> : null}
        <Badge tone={detail.node.state === 'context' || detail.node.state === 'connected' ? 'neutral' : 'accent'}>{t[detail.node.state]}</Badge>
      </Row>
      {detail.node.statusUpdatedAt || detail.node.since ? <Row align="center" gap="xs" wrap>
        <Text size="xs" muted>{detail.node.statusSource === 'antigravity' ? t.reported : t.since}</Text>
        <RelativeTime at={detail.node.statusUpdatedAt ?? detail.node.since!} muted />
      </Row> : null}
    </Box> : null}
  </Box>
}
