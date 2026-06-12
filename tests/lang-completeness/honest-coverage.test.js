import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'

// ── insp-004: coverage must tell the TRUTH when a parser is disabled ──
// Before: symbolCoverage counted any supported extension as "covered" even when
// that language's tree-sitter grammar had failed to load — so a broken install
// reported coverage 100% over a dead Layer-2. Now a degraded language is
// excluded from covered and surfaced in degradedLangs + a WARNING note.

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const { symbolCoverage } = require(path.resolve(__dirname, '../../packages/core/lib/symbol-views.cjs'))

const mkFiles = (exts) => new Map(exts.map((e, i) => [String(i), { ext: e }]))
const supported = new Set(['js', 'py', 'cs', 'java'])

describe('honest coverage — degraded parser is not counted as covered', () => {
  it('healthy: all supported files covered, no warning', () => {
    const c = symbolCoverage(mkFiles(['js', 'py', 'cs']), supported, [])
    expect(c.coveragePct).toBe(100)
    expect(c.degradedLangs).toBeUndefined()
    expect(c.note).toBeUndefined()
  })

  it('degraded py: those files drop out of covered AND a warning names the language', () => {
    // 2 js (covered) + 2 py (degraded) => 50%, py listed, warning present.
    const c = symbolCoverage(mkFiles(['js', 'js', 'py', 'py']), supported, ['py'])
    expect(c.filesCovered).toBe(2)
    expect(c.filesTotal).toBe(4)
    expect(c.coveragePct).toBe(50)
    expect(c.degradedLangs).toEqual(['py'])
    expect(c.uncoveredLangs).toContain('py')
    expect(c.note).toMatch(/parser for py failed to load/i)
  })

  it('degraded language with no files of that ext present is not falsely warned', () => {
    // cs parser degraded but project has no .cs files => no warning, 100%.
    const c = symbolCoverage(mkFiles(['js', 'py']), supported, ['cs'])
    expect(c.coveragePct).toBe(100)
    expect(c.degradedLangs).toBeUndefined()
  })
})
