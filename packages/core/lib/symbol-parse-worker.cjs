'use strict'
// Child process for parsing HEAVY tree-sitter grammars (Swift) in isolation.
// web-tree-sitter's wasm heap only grows — it never returns memory — so parsing
// many Swift files in one process OOMs (~50+ files). The parent (SymbolGraph
// .build) feeds this worker small batches and RESPAWNS it per batch; each fresh
// process starts with a clean wasm heap, so total memory stays bounded.
//
// Protocol: one JSON request on stdin, one JSON response on stdout.
//   request  = { phase: 'symbols', files: [{ id, ext, content }] }
//            | { phase: 'refs', files: [...], nodes: [SymbolNode], extends: [Edge] }
//   response = { symbols: [...] }  |  { edges: [...] }  |  { error }
// In 'refs' the parent ships the FULL symbol set (all batches) + structural
// edges so the worker can rebuild a resolver index and reuse the normal
// extractReferences path unchanged.

const parsers = require('./symbol-parsers.cjs')
const { SymbolGraph } = parsers

function readStdin() {
  return new Promise((resolve) => {
    let buf = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { buf += c })
    process.stdin.on('end', () => resolve(buf))
  })
}

async function main() {
  parsers.registerAll()
  const sg = require('./symbol-graph.cjs')
  const PARSERS = sg.PARSERS
  const req = JSON.parse(await readStdin())
  const out = {}
  if (req.phase === 'symbols') {
    const symbols = []
    for (const f of req.files) {
      const parser = PARSERS[f.ext]
      if (!parser || !parser.extractSymbols) continue
      try {
        const ret = parser.extractSymbols(f.content, f.id)
        const syms = (await ret) || []
        for (const s of syms) symbols.push(s)
      } catch (e) { /* parse fail — skip file */ }
    }
    out.symbols = symbols
  } else if (req.phase === 'refs') {
    // Rebuild a resolver index from the shipped symbols + structural edges.
    const g = new SymbolGraph()
    for (const n of req.nodes) g.addNode(n)
    for (const e of (req.extends || [])) g.addEdge(e)
    const edges = []
    for (const f of req.files) {
      const parser = PARSERS[f.ext]
      if (!parser || !parser.extractReferences) continue
      try {
        const ret = parser.extractReferences(f.content, f.id, g)
        const es = (await ret) || []
        for (const e of es) edges.push(e)
      } catch (e) { /* parse fail — skip file */ }
    }
    out.edges = edges
  } else {
    out.error = 'unknown phase'
  }
  // Flush the result, then exit(0) WITHOUT running teardown — web-tree-sitter's
  // wasm heap OOMs during GC/teardown for heavy grammars, so a normal return
  // would crash AFTER producing valid output. Forced exit avoids the noise.
  process.stdout.write(JSON.stringify(out), () => process.exit(0))
}

main().catch((e) => { process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }), () => process.exit(0)) })
