import { assert, test } from 'orca/testing'
import { classifyResources } from './resource-classifier'

test('recognizes explicit skill and namespaced plugin skill invocations', () => {
  assert.deepEqual(classifyResources('Skill', { skill: 'ui-ux-pro-max' }), [
    { category: 'skill', name: 'ui-ux-pro-max', evidence: 'observed' }
  ])
  assert.deepEqual(classifyResources('Skill', '{"skill":"documents:documents"}'), [
    { category: 'plugin', name: 'documents', evidence: 'inferred' },
    { category: 'skill', name: 'documents', evidence: 'observed' }
  ])
  assert.deepEqual(classifyResources('Skill', 'prose is not a valid skill'), [])
})

test('recognizes MCP namespace without guessing plugin ownership', () => {
  assert.deepEqual(classifyResources('mcp__cua_repl__js', { code: 'private' }), [
    { category: 'mcp', name: 'cua_repl', evidence: 'observed' }
  ])
  assert.deepEqual(classifyResources('mcp__server_name__operation', null), [
    { category: 'mcp', name: 'server_name', evidence: 'observed' }
  ])
  assert.deepEqual(classifyResources('mcp__server', null), [])
})

test('infers referenced skill from approved file and script paths without exposing input', () => {
  const raw = { cmd: 'cat /Users/mac/.codex/skills/ui-ux-pro-max/SKILL.md; python3 /Users/mac/.codex/skills/ui-ux-pro-max/scripts/search.py private' }
  const result = classifyResources('shell', raw)
  assert.deepEqual(result, [{ category: 'skill', name: 'ui-ux-pro-max', evidence: 'inferred' }])
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.deepEqual(classifyResources('functions.exec', { code: 'cat /Users/mac/.codex/skills/ecc/python-patterns/SKILL.md' }), [
    { category: 'skill', name: 'python-patterns', evidence: 'inferred' }
  ])
  assert.deepEqual(classifyResources('Read', '/Users/me/.codex/plugins/cache/openai-primary-runtime/documents/1.0/skills/documents/SKILL.md'), [
    { category: 'skill', name: 'documents', evidence: 'inferred' },
    { category: 'plugin', name: 'documents', evidence: 'inferred' }
  ])
  assert.deepEqual(classifyResources('Read', { file_path: '/Users/me/.agents/skills/foo/SKILL.md' }), [
    { category: 'skill', name: 'foo', evidence: 'inferred' }
  ])
})

test('ignores unrelated fields, namespaces, paths and invalid identifiers', () => {
  assert.deepEqual(classifyResources('mcp__server__run', { prompt: '/home/a/skills/foo/SKILL.md' }), [
    { category: 'mcp', name: 'server', evidence: 'observed' }
  ])
  assert.deepEqual(classifyResources('shell', { prompt: '/home/a/skills/foo/SKILL.md' }), [])
  assert.deepEqual(classifyResources('shell', 'cat /tmp/skills/foo/not-skill.txt'), [])
  assert.deepEqual(classifyResources('shell', 'cat /tmp/not-skills/foo/SKILL.md'), [])
  assert.deepEqual(classifyResources('Skill', { skill: 'plugin:bad name' }), [])
  assert.deepEqual(classifyResources('', null), [])
})
