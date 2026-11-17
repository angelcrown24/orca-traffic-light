import { atom, Badge, Button, Heading, on, plugin, read, Row, set, Stack, Text, type PanelContext } from 'orca'
import type { Call } from './protocol'

const calls = atom<Call[]>([])
const workspace = atom(false)
const loading = atom(true)
const failed = atom(false)
let requestId = 0
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
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('calls.changed', () => { void refresh() }))
  ctx.subscriptions.push(on('workspace.changed', () => { set(calls, []); void refresh() }))
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
        <Badge tone={call.state === 'running' ? 'warning' : 'success'}>{call.state === 'running' ? 'Awaiting finish' : 'Finished'}</Badge>
      </Row>)}
    <Text muted size="xs">Finished means the call ended; success is not known. A missing finish event can leave a call pending. Calls without pairing identifiers are omitted.</Text>
  </Stack>
}
