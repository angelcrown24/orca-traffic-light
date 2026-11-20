import { randomUUID } from 'node:crypto'
import { safeName } from './skill-review.mjs'
import { instructionLines, targetsForLines } from './skill-reference-targets.mjs'

const actions = { missing: 'fix', redundant: 'duplicate', successor: 'successor' }
const expiresAfter = 30 * 60 * 1000
const maxPlans = 12
const expired = plan => !plan.running && Date.now() - plan.at >= expiresAfter

function checkItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 4096) throw Error('Invalid batch selection.')
  const seen = new Set()
  for (const item of items) {
    if (!item || typeof item.key !== 'string' || typeof item.stamp !== 'string' || typeof item.id !== 'string' ||
        !/^(missing|redundant|successor):[0-9a-f]{24}$/.test(item.key) ||
        !/^[0-9a-f]{24}$/.test(item.stamp) || !/^skill:[0-9a-f]{24}$/.test(item.id))
      throw Error('Invalid batch selection.')
    const ref = item.key + '/' + item.id
    if (seen.has(ref)) throw Error('Duplicate batch selection.')
    seen.add(ref)
  }
}

// Apply only verified link/command path spans on the reviewed line. Preserve other prose and line endings.
function repair(body, reported, verified) {
  const lines = body.split(/(\r?\n)/)
  const targets = targetsForLines(instructionLines(body))
  const reportedPaths = new Map()
  for (const fix of reported) {
    if (!reportedPaths.has(fix.line)) reportedPaths.set(fix.line, new Map())
    reportedPaths.get(fix.line).set(fix.from, fix.to)
  }
  const fixes = [], replacements = new Map()
  for (const fix of verified) {
    if (reportedPaths.get(fix.line)?.get(fix.from) !== fix.to) continue
    const matches = targets.get(fix.line)?.filter(target => target.path === fix.from)
    if (!matches?.length) continue
    if (!replacements.has(fix.line)) replacements.set(fix.line, [])
    replacements.get(fix.line).push(...matches.map(target => ({ ...target, to: fix.to })))
    fixes.push(fix)
  }
  for (const [line, spans] of replacements) {
    const index = (line - 1) * 2
    for (const { start, path, to } of spans.sort((a, b) => b.start - a.start)) {
      lines[index] = lines[index].slice(0, start) + to + lines[index].slice(start + path.length)
    }
  }
  return { body: lines.join(''), fixes }
}

function identity(row) {
  return { key: row.key, id: row.id, name: row.name, action: row.action }
}

async function prepareRow(state, ref) {
  const { data, findings, items, selections, workspaceId, scopedPreview } = state
  const item = items.get(ref.id)
  const finding = findings.get(ref.key)
  const base = { key: ref.key, id: ref.id, action: actions[ref.key.split(':')[0]], name: safeName(item?.name ?? finding?.name) }
  const blocked = reason => ({ ref, row: { ...base, status: 'blocked', reason } })
  if (!item || finding?.stamp !== ref.stamp) return blocked('stale')
  const fix = base.action === 'fix'
  const candidate = finding.removalCandidate
  if (fix ? (!finding.ids.includes(ref.id) || !finding.referenceFixes?.length)
          : (candidate?.id !== ref.id || candidate.reason !== base.action || !candidate.retainedId)) return blocked('stale')
  const input = { workspaceId, id: ref.id, kind: fix ? 'edit' : 'remove' }
  if (base.action === 'duplicate') input.retainedId = candidate.retainedId
  const successorId = base.action === 'successor' ? candidate.retainedId : undefined
  const { result, sourceRevision } = await scopedPreview(data, input, { batch: true, selections, successorId })
  if (result.status !== 'ready') return blocked(result.reason || 'unavailable')
  const { name, path, paths, providers, selectedWorkspaces, editsOriginal } = result
  const retainedId = candidate?.retainedId
  const retainedPath = result.retainedPath ?? result.successorPath
  const row = { ...base, name, path, paths, providers, status: 'ready',
    ...(selectedWorkspaces !== undefined ? { selectedWorkspaces } : {}), ...(editsOriginal ? { editsOriginal } : {}) }
  if (retainedId) {
    if (!retainedPath || !items.has(retainedId)) return blocked('stale')
    row.retainedName = safeName(items.get(retainedId).name)
    row.retainedPath = retainedPath
  }
  if (fix) {
    const draft = repair(result.body, finding.referenceFixes, result.referenceFixes ?? [])
    if (!draft.fixes.length) return blocked('no-fix')
    input.body = draft.body
    row.fixes = draft.fixes
  }
  return { ref, row, revision: result.revision, input: { ...input, revision: sourceRevision }, retainedId, successorId }
}

function protectOverlaps(plans) {
  const sources = new Map(), protectedKeys = new Map()
  function add(map, key, index) {
    if (!key) return
    if (!map.has(key)) map.set(key, new Set())
    map.get(key).add(index)
  }
  for (const [i, plan] of plans.entries()) {
    if (plan.row.status !== 'ready') continue
    add(sources, plan.ref.id, i)
    add(sources, plan.row.path, i)
    add(protectedKeys, plan.retainedId, i)
    add(protectedKeys, plan.row.retainedPath, i)
  }
  const conflicts = new Set()
  for (const [key, targets] of sources) {
    const keepers = protectedKeys.get(key)
    if (targets.size < 2 && !keepers) continue
    for (const i of targets) conflicts.add(i)
    if (keepers) for (const i of keepers) conflicts.add(i)
  }
  for (const i of conflicts) plans[i].row = { ...plans[i].row, status: 'blocked', reason: 'overlap' }
}

export function createReviewBatchRequests({ catalogFor, ensureLocal, maintenance, selectionsFor, lock, changed, inspect, scopedPreview, postBatchProgress }) {
  const plans = new Map()
  async function inventory(workspaceId) {
    const data = await catalogFor(workspaceId, true)
    const [report, selections] = await Promise.all([inspect(data), selectionsFor()])
    await ensureLocal(workspaceId)
    return { data, selections, workspaceId, scopedPreview, items: new Map(data.items.map(item => [item.id, item])),
      findings: new Map(report.findings.map(finding => [finding.key, finding])) }
  }
  function prune() {
    for (const [id, plan] of plans) if (expired(plan)) plans.delete(id)
  }
  async function previewSkillBatch({ workspaceId, items }) {
    checkItems(items)
    const state = await inventory(workspaceId)
    const entries = []
    for (const { key, id, stamp } of items) {
      const { input, ...plan } = await prepareRow(state, { key, id, stamp })
      // Keep metadata only. The exact replacement is calculated again against the confirmed revision.
      entries.push(plan)
    }
    await ensureLocal(workspaceId)
    protectOverlaps(entries)
    prune()
    if (plans.size >= maxPlans) {
      const oldest = [...plans].find(([, plan]) => !plan.running)
      if (!oldest) throw Error('BUSY: Another batch is running.')
      plans.delete(oldest[0])
    }
    const planId = randomUUID()
    plans.set(planId, { workspaceId, entries, at: Date.now() })
    return { planId, rows: entries.map(plan => plan.row) }
  }

  async function run(plan, batchId) {
    const { workspaceId, entries } = plan
    const rows = []
    let interrupted = false, applied = false
    async function check() {
      try { await ensureLocal(workspaceId) }
      catch (error) { interrupted = true; throw error }
    }
    function progress() {
      try {
        const event = { workspaceId, batchId, completed: rows.length, total: entries.length }
        Promise.resolve(postBatchProgress?.(event)).catch(() => {})
      } catch { /* Closing the panel does not cancel a confirmed batch. */ }
    }
    const state = await inventory(workspaceId)
    progress()
    for (const [batchIndex, entry] of entries.entries()) {
      const base = identity(entry.row)
      let result
      if (entry.row.status === 'blocked') result = { status: 'skipped', reason: entry.row.reason }
      else if (interrupted) result = { status: 'skipped', reason: 'workspace-changed' }
      else try {
        await check()
        const current = await prepareRow(state, entry.ref)
        if (current.row.status !== 'ready' || current.revision !== entry.revision ||
            JSON.stringify(current.row.fixes) !== JSON.stringify(entry.row.fixes)) {
          result = { status: 'skipped', reason: 'stale' }
        } else {
          const receipt = await maintenance.apply(state.data, current.input, check, { batchId, batchIndex, successorId: current.successorId })
          applied = true
          result = { status: 'applied', receipt }
        }
      } catch (error) {
        const reason = interrupted ? 'workspace-changed' : ({ STALE: 'stale', PROTECTED: 'stale', CONFLICT: 'conflict', BUSY: 'busy' }[error?.code] ?? 'unavailable')
        result = { status: interrupted || reason === 'stale' ? 'skipped' : 'failed', reason }
      }
      rows.push({ ...base, ...result })
      progress()
    }
    if (applied) changed()
    return { batchId, rows }
  }

  async function applySkillBatch({ workspaceId, planId }) {
    await ensureLocal(workspaceId)
    prune()
    const plan = plans.get(planId)
    if (!plan || plan.workspaceId !== workspaceId) throw Error('STALE: Preview the batch again.')
    if (plan.result) return plan.result
    if (plan.running) return plan.running
    // Install the shared promise before acquiring the workspace lock, including simultaneous confirmations.
    plan.running = Promise.resolve().then(() => lock(workspaceId, () => run(plan, planId)))
    try {
      plan.result = await plan.running
      plan.at = Date.now()
      return plan.result
    } finally { delete plan.running }
  }
  async function skillBatchStatus({ workspaceId, planId }) {
    await ensureLocal(workspaceId)
    const plan = plans.get(planId)
    if (!plan || plan.workspaceId !== workspaceId || expired(plan)) return { status: 'missing' }
    if (plan.result) return { status: 'done', result: plan.result }
    return { status: plan.running ? 'running' : 'ready' }
  }
  async function undoSkillBatch(input) {
    return lock(input.workspaceId, async () => {
      const check = () => ensureLocal(input.workspaceId)
      await check()
      const result = await maintenance.undoBatch(input, check)
      if (result.rows.some(row => row.status === 'restored')) changed()
      return result
    })
  }
  return { previewSkillBatch, applySkillBatch, skillBatchStatus, undoSkillBatch }
}
