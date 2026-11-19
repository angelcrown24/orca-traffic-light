const reasons = {
  'skill-execution': ['The skill declares execution settings that the shared runner cannot apply.', '공용 실행기가 적용할 수 없는 스킬 실행 설정이 있습니다.'],
  'explicit-invocation': ['The source requires explicit invocation by the user.', '원본은 사용자가 명시적으로 호출해야 합니다.'],
  'native-tool': ['This capability depends on a provider-native tool.', '이 항목은 제공자 전용 도구에 의존합니다.'],
  'provider-auth': ['Authentication is managed by the source provider.', '원본 제공자가 인증을 관리합니다.'],
  'tool-policy': ['The provider enforces a policy on which tools can be called.', '원본 제공자가 호출할 수 있는 도구를 제한합니다.'],
  transport: ['The shared runner cannot use the declared transport.', '공용 실행기가 원본의 통신 방식을 지원하지 않습니다.'],
  'provider-options': ['The shared runner cannot apply the provider’s configuration options.', '공용 실행기가 적용할 수 없는 제공자 설정이 있습니다.'],
  environment: ['The source uses provider-specific environment expansion.', '원본은 제공자 고유의 환경 변수 해석 방식을 사용합니다.']
}

const providers = new Set(['Codex', 'Claude Code', 'Gemini CLI', 'Antigravity'])
const locations = new Set(['.codex/skills', '.claude/skills', '.gemini/skills', '.gemini/config/skills', '.gemini/antigravity/skills', '.agents/skills',
  '.codex/config.toml', '.claude.json', '.gemini/settings.json', '.gemini/config/mcp_config.json', '.gemini/antigravity/mcp_config.json'])
const catalogName = /^(?:[\p{L}\p{N}][\p{L}\p{N} ._():-]*|@[\p{L}\p{N}][\p{L}\p{N}._-]*\/[\p{L}\p{N}][\p{L}\p{N}._-]*)$/u

// A request can leave this machine when pasted. Include only catalog identifiers
// and known installation locations, never raw provider settings or instructions.
export function adaptationPrompt(item, language) {
  if (!item || item.available !== false || typeof item.providerOnly !== 'string' || !Object.hasOwn(reasons, item.providerOnly) ||
      (item.kind !== 'mcp' && item.kind !== 'skill')) throw new Error('The provider-specific source changed. Refresh the library.')
  const ko = language === 'ko'
  const isSkill = item.kind === 'skill'
  const kind = isSkill ? (ko ? '스킬' : 'skill') : (ko ? 'MCP 서버' : 'MCP server')
  const hasSafeName = typeof item.name === 'string' && item.name.length <= 100 && catalogName.test(item.name)
  if (!hasSafeName && !/^(?:mcp|skill):[a-f0-9]{24}$/.test(item.id)) throw new Error('The source identifier could not be verified.')
  const name = hasSafeName ? JSON.stringify(item.name) : item.id
  const origins = item.providers.filter(provider => providers.has(provider))
  if (locations.has(item.source)) origins.push('~/' + item.source)
  const source = [kind, name, ...origins].join(' · ')
  const reason = reasons[item.providerOnly][ko ? 1 : 0]

  if (ko) return [
    'Orca Traffic Light에서 아래 원본과 같은 기능을 공용으로 쓸 수 있게 별도 구현본을 만들어 주세요.',
    '카탈로그에서 찾을 원본 · ' + source, reason,
    '원본의 실행 조건과 현재 제공자에서 지원하는 도구 및 공식 API를 먼저 확인해 주세요.',
    isSkill ? '가능하면 SKILL.md와 필요한 파일을 갖춘 별도 스킬을 작성해 주세요.' :
      '가능하면 stdio 또는 Streamable HTTP를 쓰는 별도 MCP 서버를 작성해 주세요.',
    '원본과 인증 설정은 보존하고 명시적 호출, 권한, 도구 제한과 라이선스를 지켜 주세요. 동작은 아직 미검증입니다. 공유하기 전에 테스트한 제공자와 결과를 알려 주고, 재현할 수 없는 기능은 구체적으로 표시해 주세요.'
  ].join('\n')
  return [
    'Please build a separate equivalent of this Orca Traffic Light source for the shared library.',
    'Source catalog entry · ' + source, reason,
    'First inspect the source declarations and the tools and documented APIs available to your current provider.',
    isSkill ? 'If feasible, package a separate skill with a SKILL.md and its supporting files.' :
      'If feasible, implement a separate MCP server using stdio or Streamable HTTP.',
    'Preserve the original, its authentication settings, explicit-invocation requirements, permissions, tool restrictions and licensing terms. Compatibility is unverified. Before sharing, test it and report which providers and operations you verified, along with any unsupported behavior.'
  ].join('\n')
}
