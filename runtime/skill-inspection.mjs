import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { readBounded } from './catalog.mjs'
import { safeName } from './skill-review.mjs'

const providerNames = new Set(['Shared', 'Claude Code', 'Codex', 'Gemini CLI', 'Antigravity'])
const compareKey = text => text.trim().toLowerCase()
const family = text => compareKey(text).replace(/-v\d+$/, '')

// Only short, human-readable source excerpts can reach the panel.
function displayText(input, max) {
  if (typeof input !== 'string') return ''
  if (/(?:github_pat_|gh[pousr]_|sk-(?:proj-|ant-)?[\w-]{14,}|AKIA[A-Z0-9]{16}|xox[baprs]-|eyJ[\w-]{12,}\.)/i.test(input)) return ''
  const value = input.replace(/[`*]/g, '').trim()
  if (!value || /[\x00-\x1f\x7f<>\\=@$]|\/(?:[\w.~%-]+\/)?[\w.~%-]+|\b(?:secret|token|password|api[ _-]?key)\s*[:=]|[\w-]{40,}/i.test(value)) return ''
  return value.length > max ? value.slice(0, max - 1).trimEnd() + '…' : value
}

async function readInstructions(item, record) {
  if (!record || record.kind !== 'skill' || !record.path) return null
  let text
  try {
    if (await realpath(record.path) !== record.path) throw new Error()
    text = await readBounded(record.path, 64 * 1024)
  } catch { throw new Error('Skill source changed or could not be read. Check again.') }
  if (createHash('sha256').update(text).digest('hex') !== record.fingerprint) throw new Error('Skill source changed. Check again.')
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const end = lines[0]?.trim() === '---' ? lines.findIndex((line, i) => i > 0 && /^(?:---|\.\.\.)\s*$/.test(line)) : -1
  const descriptionLine = lines.slice(1, Math.max(1, end)).findIndex(line => /^description:/.test(line)) + 2
  const headings = new Map(), steps = new Map()
  let fence
  for (let i = end + 1; i < lines.length; i++) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i])
    if (marker && !fence) { fence = marker[1]; continue }
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
      continue
    }
    const match = /^ {0,3}#{2,4}\s+(.+?)\s*#*\s*$/.exec(lines[i])
    const title = displayText(match?.[1], 96)
    if (title && !headings.has(compareKey(title))) headings.set(compareKey(title), { title, line: i + 1 })
    // Plain prose only. Ignore commands, example code and indented blocks.
    const step = /^ {0,3}(?:(?:[-*+]|\d+[.)]) )?((?:check|review|compare|collect|record|inspect|verify|identify|choose|describe|document|explain)\s+[^{}`()|&;]{8,160}[.!?])\s*$/i.exec(lines[i])
    const instruction = displayText(step?.[1], 160)
    if (instruction && !steps.has(compareKey(instruction))) steps.set(compareKey(instruction), { instruction, line: i + 1 })
  }
  return {
    lines, headings, steps, fingerprint: record.fingerprint,
    hasBody: lines.slice(end + 1).some(line => line.trim() && !/^\s*#/.test(line)),
    description: displayText(item.description, 180),
    descriptionLine: descriptionLine > 1 ? descriptionLine : undefined
  }
}

export function createSkillInspection(inspectPackages) {
  return async function inspectSkills(data, input) {
    const { ids, language } = input
    if (!['en', 'ko'].includes(language) || !Array.isArray(ids) || ids.length < 1 || ids.length > 2 ||
      new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id || id.length > 180)) throw new Error('Choose one or two skills.')
    const exclusions = data.skillExclusions ?? []
    const chosen = ids.map(id => {
      const item = data.items.find(item => item.kind === 'skill' && item.id === id) ?? exclusions.find(item => item.id === id)
      if (!item) throw new Error('The skill selection changed. Check again.')
      return item
    })
    // A single package needs related versions for successor/variant detection. A pair compares exactly the two chosen sources.
    const include = row => ids.includes(row.id) || (chosen.length === 1 && family(row.name) === family(chosen[0].name))
    const related = data.items.filter(row => row.kind === 'skill' && include(row))
    const report = await inspectPackages({ ...data, items: related, skillExclusions: exclusions.filter(include) })
    const findings = report.findings.filter(f => f.ids.some(id => ids.includes(id)))
    const sources = await Promise.all(chosen.map(async item => {
      const excluded = findings.find(f => f.kind === 'excluded' && f.ids.includes(item.id))
      // Unavailable or unsupported packages remain reportable even without a readable instruction file.
      const content = excluded ? null : await readInstructions(item, data.records.get(item.id))
      return { item, name: safeName(item.name), providers: item.providers.filter(p => providerNames.has(p)), content }
    }))
    return describe(sources, findings, language, related)
  }
}

function describe(sources, findings, language, related) {
  const say = (en, ko) => language === 'ko' ? ko : en
  const evidence = []
  const [first, second] = sources
  const display = source => second && first.name === second.name
    ? source.name + ' · ' + (source.providers[0] || say('Local', '로컬')) : source.name
  const location = (source, path = 'SKILL.md', line) =>
    (second ? display(source) + ' · ' : '') + path + (line ? ':' + line : '')
  const add = (label, detail, source) => { if (detail && evidence.length < 16) evidence.push({ label, detail, ...(source ? { source } : {}) }) }
  let summary = '', nextStep = ''
  function conclusion(text, action) { if (!summary) { summary = text; nextStep = action } }
  const order = ['excluded', 'missing', 'conflict', 'successor', 'provider', 'variants', 'update', 'redundant']
  for (const kind of order) for (const f of findings.filter(row => row.kind === kind)) {
    const source = sources.find(s => f.ids.includes(s.item.id) && s.name === f.name) ?? sources.find(s => f.ids.includes(s.item.id))
    const name = display(source), [firstEvidence] = f.evidence
    if (kind === 'excluded') {
      const reason = ({
        'too-large': say('SKILL.md exceeds the 64 KiB instruction limit.', 'SKILL.md가 지침 파일 크기 제한인 64 KiB를 넘습니다.'),
        'scan-limit': say('The package exceeded this check’s read limit.', '패키지가 이번 점검의 읽기 한도를 넘었습니다.'),
        'unverified-metadata': say('The skill metadata could not be verified.', '스킬의 설정 정보를 확인할 수 없습니다.'),
        'unsupported-package': say('The package could not be inspected within the supported file and link limits.', '파일이나 링크를 점검 범위 안에서 확인할 수 없습니다.')
      })[firstEvidence] ?? say('The package could not be read.', '패키지를 읽을 수 없습니다.')
      conclusion(say('Incomplete check for ', '점검 범위 제한 · ') + name, firstEvidence === 'too-large'
        ? say('Move long reference material into a separate file and check again.', '긴 참고 자료를 별도 파일로 옮긴 뒤 다시 점검하세요.')
        : say('Check the package files and access permissions, then check again.', '패키지 파일과 읽기 권한을 확인한 뒤 다시 점검하세요.'))
      add(say('Coverage', '점검 범위'), reason, location(source))
    } else if (kind === 'missing') {
      const n = f.evidenceCount ?? f.evidence.length
      conclusion(say(name + ' references ' + n + ' missing package file' + (n === 1 ? '.' : 's.'), (second ? name + '의 ' : '') + 'SKILL.md에서 참조한 파일 ' + n + '개가 패키지에 없습니다.'),
        say('Restore the referenced files or correct their paths in SKILL.md.', '파일을 복원하거나 SKILL.md에서 경로를 고치세요.'))
      f.evidence.forEach((path, i) => add(say('Missing file', '누락된 파일'), path, location(source, 'SKILL.md', f.lines?.[i] ?? (i === 0 ? f.line : undefined))))
    } else if (kind === 'conflict') {
      conclusion(say('The shared copy of ' + name + ' is in conflict with its source.', name + '의 공용본과 원본이 충돌합니다.'),
        say('Compare the shared copy and original in Library before choosing a source.', '공용 도구에서 공용본과 원본을 비교한 뒤 사용할 사본을 선택하세요.'))
      add(say('Shared copy', '공용본'), say('The registered source or destination has changed.', '등록한 원본이나 공용본이 변경되었습니다.'), name)
    } else if (kind === 'successor') {
      const original = sources.find(s => f.name === s.name && f.ids.includes(s.item.id))
      const target = firstEvidence
      if (!target) continue
      const reference = original ? location(original, 'SKILL.md', f.line) : f.name + ' · SKILL.md' + (f.line ? ':' + f.line : '')
      const quote = original?.content && f.line ? displayText(original.content.lines[f.line - 1], 320) : ''
      conclusion(say(f.name + ' documents ' + target + ' as its successor.', f.name + ' 원문이 후속 스킬로 ' + target + '을 안내합니다.'),
        quote ? say('Review the author’s guidance before choosing which version to use.', '아래 원문의 권장 조건을 보고 사용할 버전을 선택하세요.')
          : say('Check the author’s version guidance in ' + reference + ' before choosing a version.', reference + '에서 원문의 권장 조건을 확인하고 사용할 버전을 선택하세요.'))
      add(quote ? say('Author guidance', '원문 안내') : say('Documented successor', '원문에 명시된 후속 스킬'), quote || target, reference)
    } else if (kind === 'redundant') {
      const keep = related.find(item => item.id === f.removalCandidate?.retainedId)
      if (!keep) continue
      conclusion(say('The two copies have identical package files and permissions.', '두 사본의 패키지 파일과 권한이 같습니다.'),
        say('Remove the duplicate and link its location to the kept copy to preserve provider access.', '중복 사본을 삭제하고 그 위치를 남길 사본에 연결하면 기존 제공자에서도 계속 쓸 수 있습니다.'))
      add(say('Copy to remove', '삭제할 사본'), f.providers.join(' · '), f.name)
      add(say('Copy to keep', '남길 사본'), keep.providers.filter(p => providerNames.has(p)).join(' · '), safeName(keep.name))
    } else if (kind === 'provider') {
      const detail = ({
        'explicit-invocation': say('Requires explicit invocation by the user.', '사용자가 직접 호출하도록 설정되어 있습니다.'),
        'native-tool': say('Requires a provider-native tool.', '제공자 전용 내장 도구에 의존합니다.'),
        'skill-execution': say('Declares provider-specific execution settings.', '제공자 전용 실행 설정을 선언합니다.')
      })[firstEvidence]
      if (!detail) continue
      conclusion(name + ' · ' + detail, say('Keep this requirement when using the skill with another provider.', '다른 제공자에서 사용할 때 이 실행 조건을 보존하세요.'))
      add(say('Provider requirement', '제공자 조건'), f.requirement?.field || detail, location(source, f.requirement?.file, f.requirement?.line))
    } else if (kind === 'variants' || kind === 'update') {
      const sameBody = second && first.name === second.name && first.content?.fingerprint && first.content.fingerprint === second.content?.fingerprint
      conclusion(kind === 'update' ? say('The original package for ' + name + ' has changed.', name + '의 원본 패키지가 변경되었습니다.')
        : sameBody ? say('The instructions match. Other package files or permissions differ.', '두 사본의 지침은 같고 패키지 파일이나 권한이 다릅니다.')
          : say('The installed copies of ' + f.name + ' differ.', f.name + '의 설치 사본이 서로 다릅니다.'),
        say('Check the listed differences before synchronizing the shared copy.', '공용본을 동기화하기 전에 아래 파일 차이를 확인하세요.'))
      for (const e of f.evidenceDetails ?? []) {
        const providers = related.filter(item => e.ids?.includes(item.id)).flatMap(item => item.providers).filter(p => providerNames.has(p))
        const reason = e.state === 'only' && providers.length ? say('Present only in ', '이 사본에만 있음 · ') + [...new Set(providers)].join(' · ')
          : ({ added: say('Added', '추가됨'), removed: say('Removed', '제거됨'), changed: say('Changed', '변경됨'), only: say('Present in some copies', '일부 사본에만 있음') })[e.state]
        add(reason, e.path)
      }
    }
  }
  if (second && first.content && second.content) {
    const identical = first.content.fingerprint === second.content.fingerprint
    if (!summary && first.name === second.name && identical && !findings.some(f => f.kind === 'variants')) {
      conclusion(say('Both copies have identical package files and permissions.', '두 사본의 패키지 파일과 권한이 일치합니다.'),
        say('Either source supplies the same package for sharing.', '두 원본 중 어느 쪽을 선택해도 같은 패키지를 공용으로 사용할 수 있습니다.'))
    } else if (!summary) {
      conclusion(identical ? say('Both skills have identical instructions.', '두 스킬의 SKILL.md 지침이 일치합니다.')
        : say('The two instruction files differ.', '두 스킬의 SKILL.md 지침이 다릅니다.'),
        say('Compare the declared purposes and section titles for the task you want to run.', '아래 용도 설명과 문서 구성을 비교해 현재 작업에 맞는 스킬을 선택하세요.'))
    }
  }
  const showContext = !evidence.length || (second && first.content?.fingerprint !== second.content?.fingerprint)
  for (const source of sources) if (source.content) {
    if (!source.content.hasBody) {
      conclusion(say(display(source) + ' has no instruction steps.', display(source) + '에 실행 지침 본문이 없습니다.'),
        say('Add the workflow an agent should follow when this skill is selected.', '에이전트가 이 스킬을 선택했을 때 따를 절차를 작성하세요.'))
      add(say('Instruction body', '지침 본문'), say('No body text following the header.', '헤더 뒤에 지침 본문이 없습니다.'), location(source))
    }
    const { description, descriptionLine, headings } = source.content
    if (!source.item.description) {
      conclusion(say(display(source) + ' has no skill description.', display(source) + '에 스킬 설명이 없습니다.'),
        say('Add a description stating when to use this skill.', '스킬을 언제 사용해야 하는지 description에 적으세요.'))
      add(say('Skill description', '용도 설명'), say('Not declared.', '설명이 없습니다.'), location(source))
    } else if (showContext && description) add(say('Declared purpose', '용도 설명'), description, location(source, 'SKILL.md', descriptionLine))
    if (!showContext) continue
    const other = source === first ? second : first
    const sections = [...headings].filter(([key]) => !other?.content || !other.content.headings.has(key))
    for (const [, h] of sections.slice(0, 2)) {
      add(second && other?.content ? say('Section title unique to this skill', '이 스킬에서만 확인한 절 제목') : say('Instruction section', '지침의 절'),
        h.title, location(source, 'SKILL.md', h.line))
    }
    if (other?.content && !sections.length && source.content.fingerprint !== other.content.fingerprint) {
      const unique = [...source.content.steps].find(([key]) => !other.content.steps.has(key))?.[1]
      if (unique) add(say('Distinct instruction', '이 스킬의 고유 지침'), unique.instruction, location(source, 'SKILL.md', unique.line))
    }
  }
  if (!evidence.length && first.content) {
    add(say('Instructions inspected', '확인한 지침'), say('Read the current local version of SKILL.md.', '현재 설치된 SKILL.md를 확인했습니다.'), location(first))
  }
  conclusion(say('No actionable package issue was found for ' + first.name + '.', first.name + '의 패키지 점검을 통과했습니다.'),
    say('Use the skill for its declared purpose. Check again after its files change.', '안내된 용도에 맞게 사용하고, 파일이 바뀌면 다시 점검하세요.'))
  return { summary, nextStep, skills: sources.map(({ item, name, providers }) => ({ id: item.id, name, providers })), evidence }
}
