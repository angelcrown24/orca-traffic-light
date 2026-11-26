import { randomUUID } from 'node:crypto'
import { readlink, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// An atomic symlink claim interoperates with syncCapabilities' mkdir lock. Only a
// marker belonging to a known-dead process of this module can be reclaimed.
async function claim(path, token, depth = 0) {
  const busy = () => Object.assign(new Error('Another shared skill change is in progress.'), { code: 'BUSY' })
  try { await symlink(token, path); return }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  const previous = await readlink(path).catch(() => '')
  const owner = /^traffic-light-maintenance-(\d+)-([0-9a-f-]{36})$/.exec(previous)
  if (!owner || !uuid.test(owner[2]) || depth >= 3) throw busy()
  try { process.kill(Number(owner[1]), 0); throw busy() }
  catch (error) { if (error.code !== 'ESRCH') throw busy() }
  // Multiple workers may notice the same dead PID. Elect one to retire this
  // specific incarnation, and recheck after election before removing anything.
  const reclaim = path + '.recover-' + owner[2]
  await claim(reclaim, token, depth + 1)
  try {
    if (await readlink(path).catch(() => '') === previous) await unlink(path)
    try { await symlink(token, path) } catch (error) { if (error.code === 'EEXIST') throw busy(); throw error }
  } finally { if (await readlink(reclaim).catch(() => '') === token) await unlink(reclaim) }
}

export async function withSharedSkillLock(base, run) {
  const path = join(base, 'shared-sync.lock'), token = 'traffic-light-maintenance-' + process.pid + '-' + randomUUID()
  await claim(path, token)
  try { return await run() } finally { if (await readlink(path).catch(() => '') === token) await unlink(path) }
}
