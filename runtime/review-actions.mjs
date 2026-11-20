import { createHash } from 'node:crypto'

// Workspace selections are private. Only the affected count leaves the worker.
export async function localSelections(getWorkspaces, loadSelection) {
  try {
    const { workspaces, truncated } = await getWorkspaces()
    if (truncated || !Array.isArray(workspaces) || workspaces.length > 500) return
    const ids = [...new Set(workspaces.filter(w => !w.hostId || w.hostId === 'local').map(w => w.id))]
    const selections = new Map()
    for (let i = 0; i < ids.length; i += 12) {
      await Promise.all(ids.slice(i, i + 12).map(async id => {
        const selected = await loadSelection(id)
        selections.set(id, new Set(Array.isArray(selected) ? selected : []))
      }))
    }
    return selections
  } catch { /* A partial listing cannot establish the number of affected workspaces. */ }
}

export function createSkillChangeRequests({ catalogFor, ensureLocal, maintenance, selectionsFor, lock, changed }) {
  async function scopedPreview(data, input) {
    const result = await maintenance.preview(data, input)
    if (result.status !== 'ready') return { result }
    const selections = await selectionsFor()
    const affected = selections && [...selections].filter(([, ids]) => ids.has(input.id)).map(([id]) => id).sort()
    // Bind the confirmed operation to its workspace, physical copy, retained copy and impact.
    const revision = createHash('sha256').update(JSON.stringify([
      input.workspaceId, input.kind, input.id, input.retainedId ?? null, result.revision, affected ?? null
    ])).digest('hex')
    return { result: { ...result, revision, ...(affected ? { selectedWorkspaces: affected.length } : {}) }, sourceRevision: result.revision }
  }
  async function previewSkillChange(input) {
    const data = await catalogFor(input.workspaceId, true)
    const { result } = await scopedPreview(data, input)
    await ensureLocal(input.workspaceId)
    return result
  }
  async function applySkillChange(input) {
    return lock(input.workspaceId, async () => {
      const data = await catalogFor(input.workspaceId, true)
      const { result, sourceRevision } = await scopedPreview(data, input)
      if (result.status !== 'ready' || result.revision !== input.revision) throw Error('STALE: Refresh the preview before applying this change.')
      const check = () => ensureLocal(input.workspaceId)
      await check()
      const receipt = await maintenance.apply(data, { ...input, revision: sourceRevision }, check)
      changed()
      return receipt
    })
  }
  async function skillChangeHistory({ workspaceId }) {
    await ensureLocal(workspaceId)
    const receipts = await maintenance.history(workspaceId)
    await ensureLocal(workspaceId)
    return receipts
  }
  async function undoSkillChange(input) {
    return lock(input.workspaceId, async () => {
      const check = () => ensureLocal(input.workspaceId)
      await check()
      const result = await maintenance.undo(input, check)
      if (result.restored) changed()
      return result
    })
  }
  return { previewSkillChange, applySkillChange, skillChangeHistory, undoSkillChange }
}
