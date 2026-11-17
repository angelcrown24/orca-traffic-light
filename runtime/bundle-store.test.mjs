import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shellQuote, writeBundle } from './bundle-store.mjs'

test('bundle secrets stay in a private file and never enter instructions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'traffic-light-bundle-'))
  try {
    const connection = { id: 'test-bundle', endpoint: 'http://127.0.0.1:1234', token: 'private-token' }
    const result = await writeBundle(connection, { directory: join(root, 'bundles') })
    assert.equal((await stat(result.path)).mode & 0o777, 0o600)
    assert.equal(JSON.parse(await readFile(result.path, 'utf8')).token, 'private-token')
    assert.equal(result.instructions.includes('private-token'), false)
    await assert.rejects(writeBundle(connection, { directory: join(root, 'bundles') }), /EEXIST/)
    await result.remove()
    await assert.rejects(stat(result.path), /ENOENT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('refuses a symlinked bundle directory and quotes shell metacharacters literally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'traffic-light-bundle-'))
  try {
    await symlink(root, join(root, 'link'))
    assert.equal(shellQuote("a'$(id)", "win32"), "'a''$(id)'")
    await assert.rejects(writeBundle({ id: 'test' }, { directory: join(root, 'link') }), /private directory/)
    assert.equal(shellQuote("a'$(id)`whoami`"), "'a'\\''$(id)`whoami`'")
  } finally { await rm(root, { recursive: true, force: true }) }
})
