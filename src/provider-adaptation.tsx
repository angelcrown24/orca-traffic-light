import { atom, Button, CodeView, env, plugin, read, set, Stack, Text } from 'orca'
import { panelLanguage } from './panel-language'
import type { CatalogItem, ProviderOnlyReason } from './toolbox-types'
import './protocol'

const copy = {
  en: {
    native: 'Provider-specific', runner: 'Compatibility review', mixed: 'Source restrictions vary',
    'skill-execution': 'This skill declares provider-specific execution requirements.',
    'explicit-invocation': 'This skill requires explicit invocation in its original provider.',
    'native-tool': 'This capability depends on a tool built into the provider.',
    'provider-auth': 'The provider manages authentication for this server.',
    'tool-policy': 'The provider enforces which server tools can be called.',
    transport: 'The shared runner does not support this connection method.',
    'provider-options': 'The shared runner cannot apply all settings in this configuration.',
    environment: 'The provider resolves environment values in this configuration.',
    hint: 'Paste the request into the agent you want to use. Test the adapted version to verify compatibility.',
    button: 'Copy adaptation request', copying: 'Copying…', copied: 'Request copied', manual: 'Select and copy the request below.',
    failure: 'Could not prepare this request. Refresh the library and try again.', request: 'Adaptation request'
  },
  ko: {
    native: '제공자 전용', runner: '호환 검토', mixed: '원본별 제약',
    'skill-execution': '이 스킬에는 특정 제공자에서 실행해야 하는 조건이 있습니다.',
    'explicit-invocation': '원본 제공자에서 사용자가 직접 호출해야 하는 스킬입니다.',
    'native-tool': '이 항목은 제공자의 내장 도구가 필요합니다.',
    'provider-auth': '원본 제공자가 이 서버의 인증을 관리합니다.',
    'tool-policy': '원본 제공자가 호출할 수 있는 서버 도구를 제한합니다.',
    transport: '공용 실행기가 이 연결 방식을 지원하지 않습니다.',
    'provider-options': '공용 실행기가 원본 설정의 일부를 적용할 수 없습니다.',
    environment: '원본 제공자가 이 설정의 환경 변수 값을 해석합니다.',
    hint: '사용할 에이전트에 요청을 붙여넣으세요. 변환본의 작동 여부는 테스트해야 확인할 수 있습니다.',
    button: '변환 요청 복사', copying: '복사 중…', copied: '요청 복사됨', manual: '아래 요청을 선택해 복사하세요.',
    failure: '요청을 준비하지 못했습니다. 목록을 새로고침한 뒤 다시 시도하세요.', request: '변환 요청'
  }
}
function scope(reason: ProviderOnlyReason) {
  return ['transport', 'provider-options', 'environment'].includes(reason) ? 'runner' : 'native'
}
export function limitationLabel(items: CatalogItem[]) {
  if (!items.some(item => item.providerOnly)) return null
  const t = copy[panelLanguage(env.locale)]
  const reason = items[0].providerOnly
  if (reason && items.every(item => item.providerOnly && scope(item.providerOnly) === scope(reason))) return t[scope(reason)]
  return t.mixed
}

type Feedback = { id: string; workspaceId: string; state: 'copying' | 'copied' | 'manual' | 'failed'; prompt?: string }
const feedback = atom<Feedback | null>(null)
let requestNumber = 0
export function clearAdaptation() { requestNumber++; set(feedback, null) }

async function copyRequest(id: string, workspaceId: string) {
  const number = ++requestNumber
  set(feedback, { id, workspaceId, state: 'copying' })
  try {
    const result = await plugin.request('toolbox.copyAdaptation', { id, workspaceId, language: panelLanguage(env.locale) })
    if (number === requestNumber) set(feedback, result.copied ? { id, workspaceId, state: 'copied' } : { id, workspaceId, state: 'manual', prompt: result.prompt })
  } catch {
    if (number === requestNumber) set(feedback, { id, workspaceId, state: 'failed' })
  }
}
export function ProviderAdaptation({ item, workspaceId, disabled }: { item: CatalogItem; workspaceId: string | null; disabled: boolean }) {
  if (!item.providerOnly) return null
  const t = copy[panelLanguage(env.locale)], response = read(feedback)
  const result = response?.id === item.id && response.workspaceId === workspaceId ? response : null
  return <Stack gap="xs">
    <Text size="sm">{t[item.providerOnly]}</Text>
    {item.skillRequirements ? <Text size="xs" muted>{item.skillRequirements}</Text> : null}
    <Text size="xs" muted>{t.hint}</Text>
    <Button icon="copy" size="sm" variant="outline" disabled={disabled || !workspaceId || response?.state === 'copying'} onPress={() => workspaceId ? copyRequest(item.id, workspaceId) : undefined}>
      {result?.state === 'copied' ? t.copied : result?.state === 'copying' ? t.copying : t.button}
    </Button>
    {result?.state === 'manual' && result.prompt ? <Stack gap="xs"><Text size="xs">{t.manual}</Text><CodeView label={t.request} code={result.prompt} wrap maxHeight="md" /></Stack> : null}
    {result?.state === 'failed' ? <Text size="xs" tone="warning">{t.failure}</Text> : null}
  </Stack>
}
