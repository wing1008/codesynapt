import { describe, it, expect, afterAll } from 'vitest'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import fs from 'fs'
import os from 'os'
import path from 'path'

// ── insp-004 KNOWN-ANSWER: tree-sitter wasm survives a HOISTED npm install ──
// The dev repo layout is a TRAP: there, '../../../node_modules/tree-sitter-wasms'
// (the old hard-coded path) and the require.resolve path point at the SAME dir,
// so no in-repo unit test can catch the regression — and that is exactly why
// "Layer-2 silently dead in every npm install, coverage still 100%" shipped
// green. This test reproduces a DIFFERENT install tree: the module copied deep
// under one package while tree-sitter-wasms lives at a higher node_modules
// (what npm hoisting does). Old path -> wasm absent; require.resolve -> found.

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const realParser = path.resolve(__dirname, '../../packages/core/lib/symbol-parser-treesitter.cjs')
const realWasms = path.dirname(require.resolve('tree-sitter-wasms/package.json'))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-installsim-'))
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

describe('install layout — tree-sitter wasm resolves under a hoisted install', () => {
  it('grammar wasm dir is found when tree-sitter-wasms is hoisted above the package', () => {
    // tmp/app/node_modules/tree-sitter-wasms  (hoisted — link to the real one)
    // tmp/app/codesynapt/packages/core/lib/<module copy>  (deep, like a real install)
    const appNm = path.join(tmp, 'app', 'node_modules')
    const libDir = path.join(tmp, 'app', 'codesynapt', 'packages', 'core', 'lib')
    fs.mkdirSync(appNm, { recursive: true })
    fs.mkdirSync(libDir, { recursive: true })
    fs.symlinkSync(realWasms, path.join(appNm, 'tree-sitter-wasms'),
      process.platform === 'win32' ? 'junction' : 'dir')
    const modCopy = path.join(libDir, 'symbol-parser-treesitter.cjs')
    fs.copyFileSync(realParser, modCopy)

    // Crucially: NO tmp/app/codesynapt/node_modules — the OLD hard-coded
    // '../../../node_modules' path would land there and find nothing.
    delete require.cache[modCopy]
    const mod = require(modCopy)

    expect(fs.existsSync(mod.WASM_DIR)).toBe(true)
    // The grammars that were silently dead in npm installs: py / java / c#.
    for (const g of ['python', 'java', 'c_sharp']) {
      expect(fs.existsSync(mod.wasmPath(g))).toBe(true)
    }
    // Resolved via the HOISTED tree-sitter-wasms (the junction), not a
    // package-local '../../../node_modules' guess. (junctions realpath back to
    // the linked target, so compare the resolved package dir, not the literal
    // tmp path.) Old code would land at tmp/app/codesynapt/node_modules — absent,
    // and never equal to the real package dir.
    expect(path.dirname(mod.WASM_DIR)).toBe(realWasms)
    expect(fs.existsSync(path.join(tmp, 'app', 'codesynapt', 'node_modules'))).toBe(false)
  })
})
