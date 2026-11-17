import { atom, Badge, Button, Heading, on, plugin, read, Row, set, settings, Stack, Switch, Text, type PanelContext } from 'orca'
import type { Call } from './protocol'
import type { NativeActivity } from './native-activity'

const calls = atom<Call[]>([])
const workspace = atom(false)
const loading = atom(true)
const failed = atom(false)
const nativeEnabled = atom(false)
const nativeStatus = atom<'disabled' | 'ready' | 'unavailable'>('disabled')
const nativeActivities = atom<NativeActivity[]>([])
let nativeRequestId = 0
let requestId = 0
let isPanelVisible = () => false
async function refresh(): Promise<void> {
  const id = ++requestId
  try {
    const result = await plugin.request('calls.get')
    if (id !== requestId) return
    set(calls, result.calls)
    set(workspace, result.workspace)
    set(failed, false)
  } catch {
    if (id !== requestId) return
    set(calls, [])
    set(workspace, false)
    set(failed, true)
  } finally { if (id === requestId) set(loading, false) }
}
async function readNativeSetting(): Promise<void> {
  try { set(nativeEnabled, (await settings.get('nativeActivity')) === true) }
  catch { set(nativeEnabled, false); set(nativeStatus, 'unavailable') }
}
async function refreshNative(): Promise<void> {
  if (!read(nativeEnabled) || !isPanelVisible()) return
  const id = ++nativeRequestId
  try {
    const result = await plugin.request('native.get')
    if (id !== nativeRequestId || !read(nativeEnabled)) return
    set(nativeStatus, result.status)
    set(nativeActivities, result.activities)
  } catch {
    if (id !== nativeRequestId) return
    set(nativeActivities, [])
    set(nativeStatus, 'unavailable')
  }
}
async function changeNative(enabled: boolean): Promise<void> {
  try {
    await settings.set('nativeActivity', enabled)
    set(nativeEnabled, enabled)
    nativeRequestId++
    set(nativeActivities, [])
    set(nativeStatus, 'disabled')
    if (enabled) await refreshNative()
  } catch { set(nativeEnabled, false); set(nativeStatus, 'unavailable') }
}
export function setup(ctx: PanelContext): void {
  isPanelVisible = () => read(ctx.visible)
  ctx.subscriptions.push({ dispose: () => { isPanelVisible = () => false } })
  ctx.subscriptions.push(plugin.on('calls.changed', () => { void refresh() }))
  ctx.subscriptions.push(on('workspace.changed', () => { set(calls, []); nativeRequestId++; set(nativeActivities, []); void refresh(); void refreshNative() }))
  ctx.subscriptions.push(settings.onDidChange(() => { void readNativeSetting().then(() => { if (!read(nativeEnabled)) { nativeRequestId++; set(nativeActivities, []); set(nativeStatus, 'disabled') } }) }))
  const timer = setInterval(() => { if (read(ctx.visible)) void refreshNative() }, 3000)
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) })
  void readNativeSetting().then(() => { if (read(nativeEnabled)) void refreshNative() })
  void refresh()
}
export default function Panel() {
  const items = read(calls)
  return <Stack gap="md">
    <Heading>Traffic Light</Heading>
    <Text muted size="xs">Local terminal agent tool calls observed since this plugin started.</Text>
    {read(loading) ? <Text>Loading…</Text> : read(failed) ? <Stack gap="sm"><Text tone="danger">Could not load tool calls.</Text><Button onPress={refresh}>Retry</Button></Stack> : !read(workspace) ? <Text>Open a workspace to see its calls.</Text> : items.length === 0 ? <Text>No calls observed in this workspace yet.</Text> :
      items.map((call) => <Row key={call.id} justify="between" gap="sm">
        <Stack gap="xs"><Text>{call.tool}</Text><Text muted size="xs">{call.agent}</Text></Stack>
        <Badge tone={call.state === 'running' ? 'warning' : call.state === 'finished' ? 'success' : 'neutral'}>{call.state === 'running' ? 'Awaiting finish' : call.state === 'finished' ? 'Finished' : 'Uncertain'}</Badge>
      </Row>)}
    <Heading level={2}>Native chat activity</Heading>
    <Text size="xs">Optional: Orca CLI returns prompts, tool inputs and assistant messages from all workspaces to this plugin. Only current workspace agent states and tool names are displayed; conversation data is not saved, logged or sent by this plugin.</Text>
    <Switch label="Show current native chat activity" checked={read(nativeEnabled)} onChange={changeNative} />
    {read(nativeEnabled) ? <Stack gap="sm">
      <Text muted size="xs">Current snapshot, not complete history. Brief tool calls can be missed and availability varies by agent; model choice is not restricted.</Text>
      {read(nativeStatus) === 'unavailable' ? <Text tone="danger">Native activity unavailable. Check the Orca CLI and try again.</Text> : read(nativeActivities).length === 0 ? <Text>No native activity reported for this workspace.</Text> : read(nativeActivities).map((activity, i) => <Row key={String(i)} justify="between" gap="sm"><Text>{(activity.agentType ?? 'Agent') + (activity.toolName ? ': ' + activity.toolName : '')}</Text><Badge>{activity.state}</Badge></Row>)}
    </Stack> : null}
    <Text muted size="xs">Finished means the call ended; success is not known. When a call ID is missing, matching is inferred only if one call fits; ambiguous calls are uncertain. Events without a terminal ID are omitted.</Text>
  </Stack>
}
