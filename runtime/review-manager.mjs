import { createSkillChangeRequests, localSelections } from './review-actions.mjs'
import { createSkillInspection } from './skill-inspection.mjs'
import { createSkillReviewer } from './skill-review.mjs'
import { buildSkillReviewRequest, previewRecommendations, reviewSkills as analyzeSkills } from './review-assistant.mjs'

// Inventory, inspection and explicit maintenance share the same local-workspace boundary.
export function createReviewRequests({ context, workspaceFor, getWorkspaces, loadSelection, selectedFor, scanNow, clipboard, maintenance, home, lock, changed, postBatchProgress }) {
  const inspect = createSkillReviewer({ home })
  const inspectSelected = createSkillInspection(createSkillReviewer({ home }))

  async function ensureLocal(workspaceId) {
    if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 2048) throw new Error('Choose a local workspace.')
    await context(workspaceId)
    await workspaceFor(workspaceId)
    await context(workspaceId)
  }

  async function catalogFor(workspaceId, fresh = false) {
    await ensureLocal(workspaceId)
    const data = await scanNow(fresh)
    await context(workspaceId)
    return data
  }

  async function withImpact(report) {
    if (!report.findings.length) return report
    const selections = await localSelections(getWorkspaces, loadSelection)
    if (!selections) return report
    const findings = report.findings.map(finding => ({ ...finding,
      workspaceCount: [...selections.values()].filter(ids => finding.ids.some(id => ids.has(id))).length }))
    return { ...report, findings }
  }

  async function skillReview({ workspaceId }) {
    const report = await inspect(await catalogFor(workspaceId))
    await context(workspaceId)
    const result = await withImpact(report)
    await context(workspaceId)
    return result
  }

  async function previewSkills(input) {
    const { workspaceId } = input
    const data = await catalogFor(workspaceId)
    const selected = [...await selectedFor(workspaceId)]
    async function checkContext() {
      await context(workspaceId)
      const latest = await selectedFor(workspaceId)
      if (latest.length !== selected.length || latest.some((id, i) => id !== selected[i])) {
        throw new Error('The workspace selection changed. Run the preview again.')
      }
    }
    await checkContext()
    const result = await previewRecommendations(data, selected, input, { checkContext })
    await checkContext()
    return result
  }

  async function inspectSkills(input) {
    const data = await catalogFor(input.workspaceId)
    const result = await inspectSelected(data, input)
    await context(input.workspaceId)
    return result
  }

  async function reviewSkills(input) {
    const data = await catalogFor(input.workspaceId)
    const result = await analyzeSkills(data, input, { checkContext: () => context(input.workspaceId) })
    await context(input.workspaceId)
    return result
  }

  async function copySkillReview(input) {
    const data = await catalogFor(input.workspaceId)
    const prompt = await buildSkillReviewRequest(data, input)
    await context(input.workspaceId)
    let copied = false
    try { copied = await clipboard(prompt) === true } catch { /* The panel also supports manual copying. */ }
    return { copied, prompt }
  }
  const actions = createSkillChangeRequests({ catalogFor, ensureLocal, maintenance, lock, changed, inspect, postBatchProgress,
    selectionsFor: () => localSelections(getWorkspaces, loadSelection) })
  return { ...actions, skillReview, inspectSkills, previewSkills, reviewSkills, copySkillReview }
}
