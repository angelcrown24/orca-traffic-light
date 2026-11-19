import { createHmac, randomUUID } from 'node:crypto'

const key = randomUUID()

// Stable for this worker's lifetime. The panel receives neither provider handles nor reversible IDs.
export function workId(session: string, source: string, ...parts: (string | number)[]): string {
  return createHmac('sha256', key).update(JSON.stringify([session, source, ...parts])).digest('hex').slice(0, 32)
}
