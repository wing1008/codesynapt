'use strict'
// Central registration for layer-2 (symbol-mode) parsers. Wires each
// language into the shared SymbolGraph PARSERS registry. Idempotent; called
// once before the first SymbolGraph.build().
//
// Language choices are the ones validated against an INDEPENDENT oracle
// (see docs/SYMBOL-MODE-PLAN.md):
//   • JS/TS family → babel parser (type-aware receiver inference).
//       Measured precision ~100% (phantom 0). Recall solid on small/medium;
//       weaker on large TS apps — tracked as an open accuracy item.
//   • Python       → tree-sitter AST. Measured precision 100% (phantom 0),
//       decidable-call recall 83–90% across DocsPro / Hmapp / mnt.
//
// Other tree-sitter grammars (go, rust, java, …) exist in the parser but are
// NOT yet oracle-validated, so they stay unregistered — we don't expose
// coverage we haven't measured. Add them here once each is measured.
const sg = require('./symbol-graph.cjs')
const jsParser = require('./symbol-parser-js.cjs')
const { makeParser } = require('./symbol-parser-treesitter.cjs')

let _done = false
function registerAll() {
  if (_done) return
  _done = true
  sg.registerParser(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'], jsParser)
  sg.registerParser(['py', 'pyw', 'pyi'], makeParser('py'))
  // Languages validated against independent ground truth (2026-06-05 audit):
  // intra-file call graph at 100% precision on fixtures, scanner-tracked, and
  // now registered for the HEADLESS path too so cs/MCP and the desktop produce
  // the SAME graph (they previously diverged — desktop parsed these, headless
  // didn't). Excluded: Ruby/Dart (web-tree-sitter ABI mismatch — wasm throws),
  // Lua (table-OOP, partial), Elixir (def/call share one node — needs special
  // casing). Those stay file-level (L1) only.
  // scala: validated working (symbols + calls + implicit-this) 2026-06-07.
  // lua: function-level symbols only (table-OOP — most member calls don't
  // resolve), still better than L1. Ruby/Dart stay out (web-tree-sitter 0.20
  // ↔ grammar-wasm ABI mismatch: dart needs ABI 15, ruby crashes mid-parse).
  // kts (Kotlin script) parses identically to kt via the kotlin grammar —
  // verified (2026-06-08): a build.gradle.kts-style snippet yields clean
  // function/class/method symbols, no phantoms.
  // rb (Ruby): now served by the NATIVE tree-sitter binding (optional dep) —
  // web-tree-sitter 0.20 crashed mid-parse on ruby, so it was L1-only before.
  // The native parser feeds the same walk()/ctx extraction; if the native dep is
  // absent it degrades back to L1 (parserFor falls through to wasm → fails →
  // L2 off for ruby only). Ruby uses implicit-self method calls (IMPLICIT_THIS).
  // (Dart still excluded — wasm needs ABI 15 / web-tree-sitter upgrade; the
  // native dart grammar is a stale nan addon incompatible with tree-sitter 0.21.)
  for (const ext of ['go', 'rs', 'java', 'kt', 'kts', 'swift', 'cs', 'php', 'c', 'cc', 'cpp', 'h', 'hpp', 'sh', 'bash', 'scala', 'lua', 'rb']) {
    const p = makeParser(ext)
    if (p) sg.registerParser([ext], p)
  }
}

// Languages we build a symbol graph for (honest coverage reporting in the API).
const SUPPORTED_EXTS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'pyw', 'pyi',
  'go', 'rs', 'java', 'kt', 'kts', 'swift', 'cs', 'php', 'c', 'cc', 'cpp', 'h', 'hpp', 'sh', 'bash',
  'scala', 'lua', 'rb',
])

module.exports = { registerAll, SUPPORTED_EXTS, SymbolGraph: sg.SymbolGraph }
