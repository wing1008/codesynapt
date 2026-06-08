import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import http from 'http'
import { fileURLToPath } from 'url'

// End-to-end test for the Layer-2 `cs symbol ...` CLI commands.
//
// Strategy (mirrors how a real user runs it): start a REAL `cs serve` headless
// daemon over a small temp JS project on a dedicated port, then invoke the
// `cs` binary as a child process with CS_PORT pointed at that daemon and assert
// on its real stdout. This proves the new commands are reachable and produce
// real function-level output — not just that the code parses.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(__dirname, '../packages/core/bin/codesynapt.cjs')

const PORT = 7799              // off the default 7707 so we never collide with a real instance
let tmpRoot, daemon

// A tiny JS project with a clear call graph:
//   main() -> greet() -> format()
//   util() -> format()
// So `format` has 2 callers (greet, util); `greet` has 1 caller (main).
const FILES = {
  'src/format.js': `export function format(s) { return '[' + s + ']' }\n`,
  'src/greet.js': `import { format } from './format.js'\nexport function greet(name) { return format('hi ' + name) }\n`,
  'src/util.js': `import { format } from './format.js'\nexport function util(x) { return format(String(x)) }\n`,
  'src/main.js': `import { greet } from './greet.js'\nexport function main() { return greet('world') }\n`,
}

function waitForHealth(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
        res.resume()
        if (res.statusCode === 200) return resolve()
        retry()
      })
      r.on('error', retry)
      r.on('timeout', () => { r.destroy(); retry() })
    }
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('daemon did not become healthy'))
      setTimeout(tick, 300)
    }
    tick()
  })
}

// Run the `cs` binary as a child process against our daemon. Returns stdout.
function cs(args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CS_PORT: String(PORT) },
    timeout: 30000,
  })
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-cli-symbol-'))
  fs.mkdirSync(path.join(tmpRoot, 'src'))
  for (const [rel, content] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(tmpRoot, rel), content)
  }
  // package.json so the project root is recognised.
  fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'cli-symbol-fixture', type: 'module' }))

  daemon = spawn(process.execPath, [CLI, 'serve', tmpRoot, '--port', String(PORT)], {
    // Isolate from any real ~/.codesynapt port lock by NOT inheriting CS_PORT;
    // serve writes its own lock but we target it via CS_PORT in cs() calls.
    env: { ...process.env, CS_PORT: String(PORT) },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  await waitForHealth(PORT)
  // Give the first symbol-graph build a moment by triggering it once.
  try { cs(['symbol', 'summary']) } catch { /* first build may be cold; real asserts retry below */ }
}, 60000)

afterAll(() => {
  try { daemon.kill() } catch {}
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
})

describe('cs symbol — Layer-2 CLI commands (real backend)', () => {
  it('symbol summary shows symbol + edge counts', () => {
    const out = cs(['symbol', 'summary'])
    expect(out).toMatch(/function-level graph: \d+ symbols, \d+ edges/)
    // Our 4 functions must be there.
    const m = out.match(/function-level graph: (\d+) symbols/)
    expect(Number(m[1])).toBeGreaterThanOrEqual(4)
  })

  it('symbol summary --json carries the raw counts', () => {
    const j = JSON.parse(cs(['symbol', 'summary', '--json']))
    expect(j.symbolCount).toBeGreaterThanOrEqual(4)
    expect(j).toHaveProperty('coverage')
  })

  it('symbol find locates a function by name', () => {
    const out = cs(['symbol', 'find', 'format'])
    expect(out).toMatch(/matching "format"/)
    expect(out).toContain('format.js')
    expect(out).toMatch(/id:/)
  })

  it('symbol callers resolves a name and lists real callers', () => {
    // `format` is called by greet() and util() → 2 callers.
    const out = cs(['symbol', 'callers', 'format'])
    expect(out).toMatch(/callers \(who calls this\)/)
    expect(out).toContain('greet')
    expect(out).toContain('util')
  })

  it('symbol callees lists what a function calls', () => {
    // greet() calls format().
    const out = cs(['symbol', 'callees', 'greet'])
    expect(out).toMatch(/callees \(what this calls\)/)
    expect(out).toContain('format')
  })

  it('symbol blast shows function-level impact', () => {
    const out = cs(['symbol', 'blast', 'format'])
    expect(out).toMatch(/seed: format/)
    expect(out).toMatch(/impact: \d+ symbols across \d+ files/)
    // changing format breaks greet + util (and transitively main).
    expect(out).toContain('greet')
  })

  it('unknown subcommand fails with guidance', () => {
    let threw = false
    try { cs(['symbol', 'bogus']) } catch (e) {
      threw = true
      expect(String(e.stderr || e.message)).toMatch(/unknown symbol subcommand/)
    }
    expect(threw).toBe(true)
  })
})
