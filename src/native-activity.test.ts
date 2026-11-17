import { assert, test } from 'orca/testing'
import { parseNativeActivity } from './native-activity'

test('extracts only activity for the exact workspace and drops private data', () => {
  const response = { result: { worktrees: [
    { address: { worktree: 'identity:one' }, agents: [
      { agentType: 'codex', state: 'working', toolName: 'Read', prompt: 'private', toolInput: 'secret', lastAssistantMessage: 'private' },
      { agentType: 'claude', state: 'waiting', toolName: null }
    ] },
    { address: { worktree: 'identity:other' }, agents: [{ agentType: 'gemini', state: 'working', toolName: 'Other' }] }
  ] } }
  const result = parseNativeActivity(response, 'identity:one')
  assert.deepEqual(result, [
    { agentType: 'codex', state: 'working', toolName: 'Read' },
    { agentType: 'claude', state: 'waiting', toolName: null }
  ])
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('returns no rows for missing, malformed or ambiguous workspace data', () => {
  assert.deepEqual(parseNativeActivity(null, 'identity:one'), [])
  assert.deepEqual(parseNativeActivity({ result: { worktrees: [] } }, 'identity:one'), [])
  const row = { address: { worktree: 'identity:one' }, agents: [] }
  assert.deepEqual(parseNativeActivity({ result: { worktrees: [row, row] } }, 'identity:one'), [])
  assert.deepEqual(parseNativeActivity({ result: { worktrees: [row] } }, ''), [])
  assert.deepEqual(parseNativeActivity({ result: { worktrees: [{ ...row, agents: [null, { state: 'bad' }] }] } }, 'identity:one'), [])
})
