import { assert, test } from 'orca/testing'
import { createTerminalReader } from './terminal-activity'

test('a workspace change or permission revocation while roster data is in flight discards the entire report', async () => {
  for (const change of ['workspace', 'permission', 'generation']) {
    let workspace = 'first', enabled = true, toolReads = 0
    const reader = createTerminalReader({
      enabled: async () => enabled,
      context: async () => ({workspaceId:workspace, branch:'', displayName:'', terminals:[{id:'one'}]}),
      list: async () => {
        if (change === 'workspace') workspace = 'next'
        if (change === 'permission') enabled = false
        if (change === 'generation') reader.clear()
        return {agents:[{terminalId:'one', agent:'codex', state:'working', stateStartedAt:0, title:null}]}
      },
      tools: () => { toolReads++; return ['Read'] }
    })
    const report = await reader.read()
    assert.ok(report.status === 'disabled' || report.status === 'unavailable')
    assert.equal(report.openTerminals,0)
    assert.deepEqual(report.rows,[])
    assert.equal(toolReads,0)
  }
})
