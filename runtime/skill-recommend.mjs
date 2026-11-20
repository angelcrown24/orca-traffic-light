// Talk directly to the loopback host. http.request neither follows redirects nor uses an agent proxy.
import { request } from 'node:http'

const MAX_RESULTS = 3
const MAX_BYTES = 128 * 1024

function loopbackOrigin(value) {
  try {
    const url = new URL(value || 'http://127.0.0.1:11434')
    if (url.protocol !== 'http:' || url.pathname !== '/' || url.username || url.password ||
        url.search || url.hash || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
    return url.origin
  } catch { return null }
}

export function localJson(url, payload, timeout) {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      agent: false, method: payload ? 'POST' : 'GET', signal: AbortSignal.timeout(timeout),
      headers: payload ? { 'Content-Type': 'application/json' } : {}
    }, async res => {
      try {
        if (res.statusCode !== 200) throw Error('Local model unavailable')
        const chunks = []
        let size = 0
        for await (const chunk of res) {
          size += chunk.length
          if (size > MAX_BYTES) throw Error('Local response too large')
          chunks.push(chunk)
        }
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) { res.destroy(); reject(err) }
    })
    req.on('error', reject)
    req.end(payload ? JSON.stringify(payload) : undefined)
  })
}

async function rankWithKev(task, items, origin, preferredModel) {
  // Verify the local installation before sending query text. Ollama cloud-model aliases are excluded.
  const { models } = await localJson(origin + '/api/tags', null, 1000)
  const model = models.find(m => /^kev(:|$)/i.test(m.name) && !/cloud/i.test(m.name) &&
    !m.remote_model && !m.remote_host && m.capabilities?.includes('decision') &&
    (!preferredModel || m.name === preferredModel))
  if (!model) throw Error('No local Kev model')
  const capabilities = {}, questions = {}
  items.forEach((item, index) => {
    const key = 's' + index
    capabilities[key] = (item.kind === 'skill' ? 'Skill: ' : 'MCP server: ') + item.name + '. ' + item.description
    questions[key] = { type: 'noul', instructions: 'Would using `capabilities.' + key + '` directly help complete `task`? Judge only this capability.' }
  })
  questions.any = { type: 'noul', instructions: 'Does at least one approved capability in `capabilities` directly help complete `task`?' }
  const { answers } = await localJson(origin + '/v1/systemone', {
    model: model.name, state: { task, capabilities }, questions
  }, 20000)
  function probability(key) {
    const answer = answers[key]
    if (answer?.type !== 'noul' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
      throw Error('Invalid local ranking')
    return answer.noul
  }
  if (probability('any') < 0.5) return []
  return items.map((item, index) => ({ item, score: probability('s' + index) }))
    .filter(match => match.score >= 0.65)
}

export async function recommendCapabilities(task, items, env = process.env) {
  const origin = loopbackOrigin(env.TYPESAFE_BASE_URL)
  let ranked = [], method = 'keywords'
  if (items.length && origin) {
    try {
      ranked = await rankWithKev(task, items, origin, env.TYPESAFE_DEFAULT_MODEL)
      method = 'kev'
    } catch { /* Local model unavailable. Keep the same approved metadata and use local keywords. */ }
  }
  if (method === 'keywords') {
    const words = new Set(task.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    ranked = items.map(item => {
      const fields = new Set((item.name + ' ' + item.description).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      return { item, score: [...words].filter(word => fields.has(word)).length }
    }).filter(match => match.score > 0)
  }
  return {
    method, items: ranked.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS).map(match => match.item)
  }
}
