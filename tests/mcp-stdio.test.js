import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

// insp-004 #54 / #53 — MCP stdio behaviour.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MCP = path.resolve(__dirname, '../packages/core/bin/codesynapt-mcp.cjs')

// Spawn the MCP server on a dead control port so a tool call fails (exercises the
// error path) without needing a live backend.
function runMcp(lines, { keepOpen = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [MCP], {
      env: { ...process.env, CS_PORT: '19998' },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    let out = ''
    p.stdout.on('data', (c) => (out += c))
    p.on('exit', (code) => resolve({ out, code }))
    for (const l of lines) p.stdin.write(JSON.stringify(l) + '\n')
    if (!keepOpen) p.stdin.end()    // EOF — server should exit
    return p
  })
}

describe('MCP stdio', () => {
  it('#54 a failing tool call returns isError, not a JSON-RPC protocol error', async () => {
    const { out } = await runMcp([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cs_query', arguments: {} } },
    ])
    const msgs = out.trim().split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const r = msgs.find((m) => m.id === 2)
    expect(r).toBeTruthy()
    expect(r.error).toBeUndefined()            // NOT a protocol error (-32000)
    expect(r.result?.isError).toBe(true)       // a tool result flagged as an error
  }, 20000)

  it('#54 an unknown tool is still a protocol error (-32601)', async () => {
    const { out } = await runMcp([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cs_nope', arguments: {} } },
    ])
    const msgs = out.trim().split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const r = msgs.find((m) => m.id === 2)
    expect(r?.error?.code).toBe(-32601)
  }, 20000)

  it('#53 closing stdin makes the server exit (no zombie)', async () => {
    const { code } = await runMcp([{ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }])
    expect(code).toBe(0)   // resolved via the 'exit' event within the test timeout
  }, 20000)
})
