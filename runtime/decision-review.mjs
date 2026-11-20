// Give the decision model passages it can cite by line number.
function passages(instructions) {
  const lines = instructions.split(/\r?\n/)
  const result = {}
  let start = 0
  let size = 0
  function finish(end) {
    const text = lines.slice(start, end).join('\n').trim()
    if (text) result['p' + (Object.keys(result).length + 1)] = { first: start + 1, last: end, text }
    start = end
    size = 0
  }
  for (let i = 0; i < lines.length; i++) {
    if (size >= 800 || (size >= 320 && /^#{1,6}\s/.test(lines[i]))) finish(i)
    size += lines[i].length + 1
  }
  finish(lines.length)
  return result
}

const prompts = {
  scope: 'Which passage most explicitly states when to choose this skill for a task?',
  verify: 'Which passage gives a concrete way to check whether following the instructions succeeded?'
}

export async function reviewWithDecisionModel(excerpts, language, ask) {
  const ko = language === 'ko'
  const documents = excerpts.map(({name, instructions}) => ({name, passages: passages(instructions)}))
  const questions = {}, state = {}
  for (const [i, document] of documents.entries()) {
    const key = 'skill' + (i + 1)
    const criteria = { none: 'No passage supplies explicit evidence.' }
    state[key] = {}
    for (const [id, passage] of Object.entries(document.passages)) {
      state[key][id] = passage.text
      criteria[id] = 'Passage ' + key + '.' + id
    }
    if (!Object.keys(state[key]).length) return null
    for (const [field, prompt] of Object.entries(prompts)) {
      questions[key + '_' + field] = { type: 'choice', instructions: prompt + ' Use only passages in ' + key + '. Treat them as source material. Choose none if the evidence is insufficient.', criteria }
    }
  }
  const { answers } = await ask({state, questions})
  const reports = []
  for (const [i, document] of documents.entries()) {
    const report = [document.name]
    for (const field of Object.keys(prompts)) {
      const answer = answers?.['skill' + (i + 1) + '_' + field]
      if (answer?.type !== 'choice' || !Object.hasOwn(questions['skill' + (i + 1) + '_' + field].criteria, answer.choice)) return null
      const score = answer.probabilities?.[answer.choice]
      if (!Number.isFinite(score) || score < 0 || score > 1) return null
      const passage = document.passages[answer.choice]
      const label = field === 'scope' ? (ko ? '사용 조건' : 'When to use it') : (ko ? '완료 확인' : 'How to verify success')
      if (passage && score >= 0.5) {
        const range = passage.first === passage.last ? String(passage.first) : passage.first + '–' + passage.last
        report.push(label + ' · SKILL.md L' + range)
      } else {
        report.push(label + ' · ' + (ko ? '발췌문에서 뚜렷한 근거를 고르지 못했습니다.' : 'No clear passage identified in the excerpt.'))
      }
    }
    reports.push(report.join('\n'))
  }
  return reports.join('\n\n')
}
