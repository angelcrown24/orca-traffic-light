import { assert, test } from 'orca/testing'
import { journalQuery, readJournalActivity } from './journal-activity'

const id = 'codex_12345678_abcd_1234_abcd_123456789abc'
const meta = { kind: 'meta', version: 2, format: 1 }

test('journal query validates session ID and requests no message or output fields', () => {
  assert.equal(journalQuery("x';DROP TABLE journal_sessions;--"), null)
  assert.equal(journalQuery('another/session'), null)
  const sql = journalQuery(id)!
  assert.equal(sql.includes("'$.body.output'"), false)
  assert.equal(sql.includes("'$.body.input'"), true)
  assert.equal(sql.includes('epoch=(SELECT epoch FROM current)'), true)
})

test('returns resource names only and deduplicates them', async () => {
  const result = await readJournalActivity(id, async () => [meta,
    { kind: 'call', name: 'shell', input: 'cat /Users/me/.codex/skills/ui-ux-pro-max/SKILL.md secret-token' },
    { kind: 'call', name: 'shell', input: 'cat /Users/me/.codex/skills/ui-ux-pro-max/SKILL.md' },
    { kind: 'call', name: 'mcp__figma__read', input: 'sensitive' },
  ])
  assert.deepEqual(result, { status: 'ready', resources: [
    { category: 'skill', name: 'ui-ux-pro-max', evidence: 'inferred' },
    { category: 'mcp', name: 'figma', evidence: 'observed' },
  ] })
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(JSON.stringify(result).includes('sensitive'), false)
})

test('fails closed for old or malformed schemas and runtime errors', async () => {
  assert.equal((await readJournalActivity(id, async () => [{ ...meta, version: 4 }])).status, 'unavailable')
  assert.equal((await readJournalActivity(id, async () => [{ ...meta, format: 0 }])).status, 'unavailable')
  assert.equal((await readJournalActivity(id, async () => [meta, { kind: 'message', name: 'shell' }])).status, 'unavailable')
  assert.equal((await readJournalActivity(id, async () => { throw new Error('private input') })).status, 'unavailable')
})

test('reports truncated results rather than claiming full history', async () => {
  const rows = Array.from({ length: 301 }, () => ({ kind: 'call', name: 'shell', input: '' }))
  assert.equal((await readJournalActivity(id, async () => [meta, ...rows])).status, 'truncated')
})
