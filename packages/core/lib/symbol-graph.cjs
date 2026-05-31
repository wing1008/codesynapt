// CodeSynapt symbol mode — in-memory symbol graph that lives alongside
// the file-graph Scanner. Built lazily; first /symbol/* request triggers
// the scan against the currently-loaded file set.
//
// Data model and design notes live in docs/SYMBOL-MODE-PLAN.md.

'use strict'

const fs = require('fs')
const path = require('path')

// Parser registry — extended per-language in Stage 1 / Stage 2.
// Each entry: { extractSymbols(content, fileId) → SymbolNode[],
//               extractReferences(content, fileId, index) → SymbolEdge[] }
const PARSERS = Object.create(null)

function registerParser(extOrExts, parser) {
  const exts = Array.isArray(extOrExts) ? extOrExts : [extOrExts]
  for (const e of exts) PARSERS[e] = parser
}

function extFor(filePath) {
  const e = path.extname(filePath).slice(1).toLowerCase()
  return e
}

class SymbolGraph {
  constructor() {
    this.nodes = new Map()      // id → SymbolNode
    this.edges = []             // SymbolEdge[]
    this.byFile = new Map()     // fileId → Set<symbolId>
    this.byName = new Map()     // lowercased name → Set<symbolId>
    // Adjacency for fast callers/callees lookup.
    this.outAdj = new Map()     // symbolId → Set<targetId>
    this.inAdj  = new Map()     // symbolId → Set<sourceId>
    // File-mode imports — fed in from the host (scanner.edges). Lets
    // call resolution disambiguate same-name symbols across files
    // by preferring targets in files the caller actually imports.
    this.fileImports = new Map() // fileId → Set<importedFileId>
    this.builtAt  = 0
    this.fileCount = 0
    this.scanMs = 0
  }

  clear() {
    this.nodes.clear()
    this.edges.length = 0
    this.byFile.clear()
    this.byName.clear()
    this.outAdj.clear()
    this.inAdj.clear()
    this.fileImports.clear()
    this.builtAt = 0
    this.fileCount = 0
    this.scanMs = 0
  }

  // Best symbol match for `name` called from `fromFileId`. Preference:
  //   1) same file
  //   2) a file directly imported by `fromFileId`
  // We deliberately *do not* fall back to "any file with that name"
  // — that would link a local `request` variable in utils.ts to an
  // unrelated `request()` function in some other file just because
  // they share a name. AI agents downstream would get noise edges
  // and follow false trails. Conservative beats clever here.
  // If the host wants the loose match, set `allowAny: true`.
  resolveCall(fromFileId, name, { allowAny = false } = {}) {
    if (!name) return null
    // Type-aware lookup: `User.method` matches a symbol whose
    // qualifiedName === 'User.method' exactly. Higher priority than
    // name-only matches because it narrows from "any method named X"
    // to "X defined on this class".
    if (name.includes('.')) {
      const tail = name.split('.').pop()
      const set = this.byName.get(tail.toLowerCase())
      if (set) {
        for (const id of set) {
          const node = this.nodes.get(id)
          if (node?.qualifiedName === name) return node
        }
      }
      // No qualifiedName match — fall back to the bare method name
      // through the regular path below.
      name = tail
    }
    const set = this.byName.get(name.toLowerCase())
    if (!set || !set.size) return null
    let sameFile = null, imported = null, any = null
    const importsOf = this.fileImports.get(fromFileId)
    for (const id of set) {
      const node = this.nodes.get(id)
      if (!node) continue
      if (node.file === fromFileId) { sameFile = node; break }
      if (!imported && importsOf && importsOf.has(node.file)) imported = node
      if (!any) any = node
    }
    return sameFile || imported || (allowAny ? any : null)
  }

  addNode(node) {
    this.nodes.set(node.id, node)
    if (!this.byFile.has(node.file)) this.byFile.set(node.file, new Set())
    this.byFile.get(node.file).add(node.id)
    const key = (node.name || '').toLowerCase()
    if (key) {
      if (!this.byName.has(key)) this.byName.set(key, new Set())
      this.byName.get(key).add(node.id)
    }
  }

  addEdge(edge) {
    this.edges.push(edge)
    if (!this.outAdj.has(edge.source)) this.outAdj.set(edge.source, new Set())
    this.outAdj.get(edge.source).add(edge.target)
    if (!this.inAdj.has(edge.target)) this.inAdj.set(edge.target, new Set())
    this.inAdj.get(edge.target).add(edge.source)
  }

  callersOf(id) {
    const set = this.inAdj.get(id)
    if (!set) return []
    return [...set].map((sid) => this.nodes.get(sid)).filter(Boolean)
  }
  calleesOf(id) {
    const set = this.outAdj.get(id)
    if (!set) return []
    return [...set].map((tid) => this.nodes.get(tid)).filter(Boolean)
  }
  findByName(query, limit = 50) {
    const q = (query || '').toLowerCase()
    if (!q) return []
    const matches = []
    for (const [name, ids] of this.byName) {
      if (name.includes(q)) {
        for (const id of ids) {
          const n = this.nodes.get(id)
          if (n) matches.push(n)
          if (matches.length >= limit) return matches
        }
      }
    }
    return matches
  }

  // ─── Scanning ──────────────────────────────────────────────────
  // `fileEntries` is an iterable of { id, absPath, ext } — typically
  // derived from the file-mode Scanner's `files` map.
  // `fileImports` (optional) is a Map<fileId, Set<importedFileId>>
  // built from the file-mode edge list; lets resolveCall prefer
  // imported targets.
  async build(fileEntries, fileImports = null) {
    const start = Date.now()
    this.clear()
    // Set imports *after* clear so the host-provided map survives.
    if (fileImports) this.fileImports = fileImports
    // Pass 1 — symbols. We need every symbol indexed before we can
    // resolve references in pass 2.
    let fileCount = 0
    const fileContents = new Map()    // fileId → content (kept for pass 2)
    for (const entry of fileEntries) {
      const parser = PARSERS[entry.ext]
      if (!parser) continue
      let content
      try { content = fs.readFileSync(entry.absPath, 'utf8') }
      catch { continue }
      fileContents.set(entry.id, content)
      let symbols
      try {
        const ret = parser.extractSymbols(content, entry.id)
        // Parsers may be sync or async — await is a no-op on a plain
        // array, so handling both shapes is one line.
        symbols = (await ret) || []
      } catch (e) { symbols = [] }
      for (const s of symbols) this.addNode(s)
      fileCount++
    }
    // Pass 2 — references. Per-file, ask the language parser to find
    // call/extends/implements edges. Parsers consult `this` (the
    // symbol index) to resolve names.
    for (const [fileId, content] of fileContents) {
      const ext = extFor(fileId)
      const parser = PARSERS[ext]
      if (!parser || !parser.extractReferences) continue
      let refs
      try {
        const ret = parser.extractReferences(content, fileId, this)
        refs = (await ret) || []
      } catch (e) { refs = [] }
      for (const r of refs) {
        if (this.nodes.has(r.source) && this.nodes.has(r.target)) {
          this.addEdge(r)
        }
      }
    }
    this.fileCount = fileCount
    this.builtAt = Date.now()
    this.scanMs = this.builtAt - start
    return this.stats()
  }

  stats() {
    const byKind = {}
    for (const n of this.nodes.values()) {
      byKind[n.kind] = (byKind[n.kind] || 0) + 1
    }
    const byEdgeKind = {}
    for (const e of this.edges) {
      byEdgeKind[e.kind] = (byEdgeKind[e.kind] || 0) + 1
    }
    return {
      fileCount: this.fileCount,
      symbolCount: this.nodes.size,
      edgeCount: this.edges.length,
      byKind,
      byEdgeKind,
      scanMs: this.scanMs,
      builtAt: this.builtAt,
    }
  }
}

module.exports = { SymbolGraph, registerParser, extFor, PARSERS }
