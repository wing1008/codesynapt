import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'

// Phantom-language coverage audit (2026-06-08).
//
// Five extensions (kts, elm, ex, exs, hh) were present in the tree-sitter
// LANG_CONFIG yet NOT in the scanner's TRACKED_EXT nor in symbol-parsers'
// SUPPORTED_EXTS — advertised but never scanned/registered ("phantom"
// coverage). We probed each by ACTUALLY parsing a snippet:
//
//   • kts (Kotlin script) → kotlin grammar: clean symbols → KEPT + registered.
//   • elm  → elm grammar: wasm ABI mismatch (lang version 12, needs 13–14),
//            throws, 0 symbols → REMOVED from LANG_CONFIG.
//   • ex/exs (elixir) → def/call share one `call` node: the macro keywords
//            `defmodule`/`def` become bogus symbols → REMOVED.
//   • hh (Hack) → no tree-sitter-hack grammar; C++ grammar misparses → REMOVED.
//
// This test re-verifies the kept language really parses and that the removed
// languages are gone from all three coverage lists.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const ts = require(path.resolve(__dirname, '../packages/core/lib/symbol-parser-treesitter.cjs'))
const { LANG_CONFIG, makeParser } = ts
const { SUPPORTED_EXTS } = require(path.resolve(__dirname, '../packages/core/lib/symbol-parsers.cjs'))

// Pull TRACKED_EXT out of scanner.js without booting the full Scanner (it's an
// ESM module that imports fs/electron-free utils — a dynamic import is cleanest).
import { Scanner } from '../packages/core/scanner.js'

const REMOVED = ['elm', 'ex', 'exs', 'hh']
const KEPT = { kts: 'kotlin' }

const SNIPPETS = {
  kts: `import foo.Bar

val config = Bar()

fun setup(name: String): String {
  return greet(name)
}

fun greet(n: String) = "hi " + n

class Task(val id: Int) {
  fun run() { setup("x") }
}
`,
}

describe('phantom-language coverage audit', () => {
  describe('KEPT languages parse real symbols', () => {
    for (const [ext, grammar] of Object.entries(KEPT)) {
      it(`${ext} (${grammar}) is in LANG_CONFIG and extracts >=1 symbol`, async () => {
        expect(LANG_CONFIG[ext]).toBeTruthy()
        expect(LANG_CONFIG[ext].grammar).toBe(grammar)
        const parser = makeParser(ext)
        expect(parser).toBeTruthy()
        const syms = await parser.extractSymbolsAsync(SNIPPETS[ext], `fixture.${ext}`)
        // Drop the synthetic <module> pseudo-symbol the parser always appends.
        const real = syms.filter((s) => s.kind !== 'module')
        expect(real.length).toBeGreaterThanOrEqual(1)
        // Specifically: the kts snippet defines setup/greet/Task/run.
        const names = real.map((s) => s.name)
        expect(names).toContain('setup')
        expect(names).toContain('Task')
      })

      it(`${ext} is registered consistently (TRACKED_EXT + SUPPORTED_EXTS)`, () => {
        expect(SUPPORTED_EXTS.has(ext)).toBe(true)
      })
    }
  })

  describe('REMOVED languages are gone from every coverage list', () => {
    for (const ext of REMOVED) {
      it(`${ext} is absent from LANG_CONFIG`, () => {
        expect(LANG_CONFIG[ext]).toBeUndefined()
      })
      it(`${ext} is absent from SUPPORTED_EXTS`, () => {
        expect(SUPPORTED_EXTS.has(ext)).toBe(false)
      })
      it(`${ext} has no registered parser`, () => {
        // makeParser returns null for unknown exts (no LANG_CONFIG entry).
        expect(makeParser(ext)).toBeNull()
      })
    }
  })

  it('scanner TRACKED_EXT matches the audit (kts in, removed langs out)', () => {
    // TRACKED_EXT is module-private; Scanner.shouldTrack(path) is the real probe.
    const s = new Scanner(process.cwd())
    expect(s.shouldTrack('/proj/build.kts')).toBe(true)
    for (const ext of REMOVED) {
      expect(s.shouldTrack(`/proj/file.${ext}`)).toBe(false)
    }
  })
})
