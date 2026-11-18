import { assert, test } from 'orca/testing'
import { classifyResources, directJevCommand, nativeToolName } from './resource-classifier'

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
  assert.deepEqual(classifyResources('hindsight/hindsight_search_pages', null, { server: 'hindsight', tool: 'hindsight_search_pages' }), [
    { category: 'mcp', name: 'hindsight', evidence: 'observed' }
  ])
  assert.deepEqual(classifyResources('cua_repl/js', null, { server: 'cua_repl', tool: 'js' }), [
    { category: 'mcp', name: 'cua_repl', evidence: 'observed' }
  ])
  assert.deepEqual(classifyResources('collaboration/spawn_agent', null), [])
  assert.deepEqual(classifyResources('functions/exec', null, { server: 'functions', tool: '' }), [])
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

test('uses explicit Gemini skill activation and ignores skill paths in unrelated structured input fields', () => {
  assert.deepEqual(classifyResources('activate_skill', { name: 'design' }), [{ category: 'skill', name: 'design', evidence: 'observed' }])
  assert.deepEqual(classifyResources('read_file', '{"Path":"/tmp/other","contents":"/agent/skills/ignored/SKILL.md"}'), [])
  assert.deepEqual(classifyResources('execute', { Command: 'run', ToolName: 'SomeFunction' }), [])
})

test('attributes only literal top-level Jev shell invocations without forwarding arguments', () => {
  assert.equal(nativeToolName('execute', { command: 'jev-code rank --task sensitive-words' }), 'jev-code/rank')
  assert.equal(nativeToolName('Bash', { command: '"/some directory/bin/jev-code" classify --value private' }), 'jev-code/classify')
  assert.equal(directJevCommand('functions.exec_command', '{"cmd":"   /usr/local/bin/jev-code rank data"}'), 'jev-code/rank')
  assert.equal(directJevCommand('run_command', { CommandLine: 'jev-code classify' }), 'jev-code/classify')
  assert.equal(directJevCommand('shell', { command: ['/bin/jev-code', 'rank', 'private'] }), 'jev-code/rank')
  for (const command of ['echo "jev-code rank data"', '# jev-code rank', 'cat notes && jev-code rank', "bash -c 'jev-code rank'", 'tool-jev-code rank', 'jev-code ranker', 'jev-code rank --help', 'jev-code classify -h', 'jev-code rank --version', 'cat <<EOF\njev-code rank\nEOF']) {
    assert.equal(nativeToolName('shell', { command }), 'shell')
  }
  assert.equal(nativeToolName('shell', { path: 'jev-code rank' }), 'shell')
  assert.equal(nativeToolName('read_file', 'jev-code rank'), 'read_file')
  assert.equal(nativeToolName('execute', { ServerName: 'trusted', ToolName: 'query', command: 'jev-code rank' }), 'trusted/query')
})

test('unwraps a single literal Jev call in a Codex host login shell', () => {
  const command = '/bin/zsh -lc "jev-code rank --json \'{\\"task\\":\\"what time is it?\\"}\'"'
  assert.equal(nativeToolName('shell', { command, cwd: '/workspace' }), 'jev-code/rank')
  assert.equal(directJevCommand('exec_command', { cmd: "/bin/bash -lc '/usr/bin/jev-code classify input'" }), 'jev-code/classify')
  for (const command of [
    "/bin/zsh -lc 'echo jev-code rank'",
    "/bin/zsh -lc 'echo x && jev-code rank'",
    "/bin/zsh -lc 'jev-code rank x && other'",
    "/bin/zsh -lc 'jev-code rank x | cat'",
    "/bin/zsh -lc 'jev-code rank x' extra",
    "/bin/zsh -lc 'jev-code rank --help'",
    "/bin/zsh -lc '$exe rank'",
    "/bin/zsh -lc 'jev-code rank \"$(program)\"'",
    '/bin/bash -lc "jev-code rank $task"',
    "/bin/zsh -c 'jev-code rank'",
    "/other/zsh -lc 'jev-code rank'",
  ]) assert.equal(directJevCommand('shell', { command }), null)
})
