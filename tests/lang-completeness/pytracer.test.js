import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ── insp-004: Python runtime tracer survives real-world exit paths ──
// Three regressions, all on the 0.0.4 headline feature:
//  (c) sys.exit() (the std `sys.exit(main())` / argparse path) discarded ALL
//      observed edges before they were written.
//  (d) runpy did not put the script dir on sys.path, so `import sibling` raised
//      ModuleNotFoundError under tracing though the program runs fine standalone.
//  (e) `-m module` and bare interpreter flags were mishandled as a script path.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PYT = path.resolve(__dirname, '../../packages/core/lib/pytracer.py')

function pythonExe() {
  for (const exe of ['python', 'python3', 'py']) {
    try { execFileSync(exe, ['--version'], { stdio: 'ignore' }); return exe } catch {}
  }
  return null
}
const PY = pythonExe()

let dir, proj
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-pytrace-'))
  proj = path.join(dir, 'proj')
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, 'helper.py'), 'def greet(name):\n    return "hi " + name\n')
  // sibling import + sys.exit(0) — both the old failure modes in one program.
  fs.writeFileSync(path.join(proj, 'app.py'),
    'import sys\nimport helper\n\ndef run():\n    return helper.greet("world")\n\n' +
    'def main():\n    run()\n    sys.exit(0)\n\nif __name__ == "__main__":\n    main()\n')
})
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

function trace(args, outName) {
  const out = path.join(dir, outName)
  execFileSync(PY, [PYT, ...args], {
    cwd: proj,
    env: { ...process.env, CS_PYTRACE_OUT: out, CS_PYTRACE_ROOT: proj, PYTHONPATH: proj },
  })
  if (!fs.existsSync(out)) return []
  return fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

describe.skipIf(!PY)('pytracer — exit paths and module launch', () => {
  it('(c)+(d) sibling import works AND edges survive sys.exit(0)', () => {
    const edges = trace([path.join(proj, 'app.py')], 'a.jsonl')
    // No ModuleNotFoundError thrown => sibling import resolved (d).
    // Edges present => sys.exit(0) did not discard them (c).
    expect(edges.length).toBeGreaterThanOrEqual(3)
    const has = (cf, ef) => edges.some((e) => e.cf === cf && e.ef === ef)
    expect(has('app.py', 'helper.py')).toBe(true)   // run -> helper.greet
    expect(has('app.py', 'app.py')).toBe(true)       // main -> run
  })

  it('(e) -m module launches and traces', () => {
    const edges = trace(['-m', 'app'], 'b.jsonl')
    expect(edges.some((e) => e.ef === 'helper.py')).toBe(true)
  })

  it('(e) unsupported flag fails loudly, not as a missing-file', () => {
    let err = null
    try {
      execFileSync(PY, [PYT, '-c', 'print(1)'], {
        cwd: proj, env: { ...process.env, CS_PYTRACE_ROOT: proj },
      })
    } catch (e) { err = e }
    expect(err).not.toBeNull()
    expect(String(err.stderr || '')).toMatch(/unsupported python option/i)
  })
})
