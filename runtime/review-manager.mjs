import { createSkillReviewer } from './skill-review.mjs'
import { buildSkillReviewRequest, previewRecommendations, reviewSkills as analyzeSkills } from './review-assistant.mjs'

// Review is a Library action. It never creates a bundle or claims an activity event.
export function createReviewRequests({ context, workspaceFor, getWorkspaces, loadSelection, selectedFor, scanNow, clipboard }) {
  const inspect = createSkillReviewer()

  async function catalogFor(workspaceId) {
    if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 2048) throw new Error('Choose a local workspace.')
    await context(workspaceId)
    await workspaceFor(workspaceId)
    const data = await scanNow()
    await context(workspaceId)
    return data
  }

  async function withImpact(report) {
    if (!report.findings.length) return report
    // Only a complete local workspace list can support an exact count.
    try {
      const { workspaces, truncated } = await getWorkspaces()
      if (truncated || !Array.isArray(workspaces) || workspaces.length > 256) return report
      const identifiers = [...new Set(workspaces.filter(w => !w.hostId || w.hostId === 'local').map(w => w.id))]
      const selections = []
      for (let i = 0; i < identifiers.length; i += 12) {
        const batch = await Promise.all(identifiers.slice(i, i + 12).map(id => loadSelection(id)))
        selections.push(...batch.map(ids => new Set(Array.isArray(ids) ? ids : [])))
      }
      const findings = report.findings.map(finding => ({ ...finding,
        workspaceCount: selections.filter(selection => finding.ids.some(id => selection.has(id))).length }))
      return { ...report, findings }
    } catch { return report }
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
  return { skillReview, previewSkills, reviewSkills, copySkillReview }
}
