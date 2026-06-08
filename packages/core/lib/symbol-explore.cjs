'use strict'
// Shared semantic/keyword symbol EXPLORE (the "classify" view). Faithfully
// ported from electron/main.cjs buildClassifyResponse + its helper functions so
// the HEADLESS control server can serve /symbol/explore with the identical
// response shape — an AI using MCP without the desktop app gets a real answer
// instead of a 404.
//
// Offline rule: embeddings are OPT-IN and the model must NEVER be downloaded.
// We only attempt semantic enrichment when the symbol graph ALREADY carries
// embeddings (`g._embedded === true`), which only happens if the host
// explicitly ran an embedding pass with a cached/available model. Otherwise we
// fall back to keyword matching — no model load, no network. The headless
// scanner.getSymbolGraph() does not embed, so in practice this is the keyword
// path unless a future host opts in.
//
// Pure module: no http, no Electron. `readSource(file, startLine, endLine)` is
// injected so the caller controls disk access (root-scoping, error handling).

function isAuxExplorePath(filePath, auxSegments) {
  if (!filePath) return false
  const parts = filePath.toLowerCase().replace(/\\/g, '/').split('/')
  return parts.some((p) => auxSegments.has(p))
}

function isTestPath(filePath) {
  if (!filePath) return false
  const p = filePath.toLowerCase().replace(/\\/g, '/')
  if (/\/(tests?|__tests__|spec|specs|e2e|integration|integration[_-]tests?|fixtures?|bench(es|marks?)?)\//.test('/' + p + '/')) return true
  if (/(?:_test|\.test|\.spec|\.bench|_bench|\.e2e)\.[a-z]+$/.test(p)) return true
  if (/tests?\.(swift|kt|java)$/.test(p)) return true
  return false
}

const EXPLORE_AUX_SEGMENTS = new Set([
  'compiled', 'vendored', 'vendor', '_compiled',
  'examples', 'example', 'samples', 'sample', 'demo', 'demos',
  'scripts', 'script', 'tools', 'tool',
  'build', 'dist', 'out', 'bin',
  'fixtures', 'fixture',
  'mocks', 'mock', '__mocks__',
  'stubs', 'stub',
  'storybook', '.storybook', 'stories',
  'docs-src', 'documentation',
])

const EXPLORE_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from', 'how', 'in',
  'into', 'is', 'it', 'its', 'of', 'on', 'or', 'the', 'their', 'this', 'to', 'using', 'what',
  'when', 'where', 'which', 'who', 'why', 'will', 'with',
])

function splitCamelCase(w) {
  const parts = w.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+/g) || []
  return parts.map((s) => s.toLowerCase())
}

const STEM_STEP2 = [
  ['ization', 'ize'], ['ational', 'ate'], ['fulness', 'ful'],
  ['ousness', 'ous'], ['iveness', 'ive'], ['tional', 'tion'],
  ['ation', 'ate'], ['ator', 'ate'], ['ative', 'ate'],
  ['izer', 'ize'], ['icate', 'ic'], ['alize', 'al'],
  ['ical', 'ic'],
]
const STEM_STEP4 = [
  'ement', 'ements', 'ance', 'ances', 'ence', 'ences',
  'ment', 'ments', 'tion', 'tions', 'sion', 'sions',
  'able', 'ables', 'ible', 'ibles', 'ism', 'isms',
  'ness', 'nesses', 'ful', 'fully', 'ous', 'ously',
  'ive', 'ives', 'ize', 'izes', 'ized', 'izing',
  'ing', 'ed', 'ly', 'er', 'or',
]
function stem(w) {
  if (w.length < 5) return w
  for (const [from, to] of STEM_STEP2) {
    if (w.endsWith(from) && w.length - from.length >= 3) return w.slice(0, -from.length) + to
  }
  for (const suf of STEM_STEP4) {
    if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length)
  }
  return w
}

function isDeprecatedSymbol(node) {
  if (node.deprecated === true) return true
  const d = ((node.doc || '') + ' ' + (node.signature || '')).toLowerCase()
  if (!d) return false
  return /(\s|^)@?deprecated\b|todo\s*[:_-]?\s*remove|fixme\s*[:_-]?\s*remove/.test(d)
}

const ENTRY_NAMES = new Set([
  'main', 'run', 'start', 'init', 'handler', 'bootstrap',
  'setup', 'listen', 'serve', 'cli', 'app', 'default',
])
const ENTRY_FILE_RE = /(?:^|\/)(?:main|index|entry|server|app|cli|bin|run)(?:\.[a-z]+)?$/i
function isPublicEntry(node) {
  if (!node.exported) return false
  const name = (node.name || '').toLowerCase()
  if (ENTRY_NAMES.has(name)) return true
  if (ENTRY_FILE_RE.test(node.file || '')) return true
  return false
}

function rawHasSubstring(node, keywords) {
  const name = (node.name || '').toLowerCase()
  const qn = (node.qualifiedName || '').toLowerCase()
  const file = (node.file || '').toLowerCase()
  for (const k of keywords) {
    if (name.includes(k) || qn.includes(k) || file.includes(k)) return true
  }
  return false
}

// Faithful port of electron/main.cjs buildClassifyResponse.
//   g          : SymbolGraph
//   query      : raw query string
//   budget     : snippet token budget (default 8000)
//   readSource : (file, startLine, endLine) => string | null  — root-scoped disk read
//   embedding  : optional embedding module (only used if g._embedded). Pass null
//                to force keyword-only (the offline-safe default).
async function buildClassifyResponse(g, query, budget = 8000, readSource = () => null, embedding = null) {
  const q = (query || '').toLowerCase()
  const rawTokens = q.split(/[^\p{L}\p{N}_]+/u).filter(Boolean)
  const expanded = new Set(rawTokens)
  for (const t of rawTokens) {
    for (const p of splitCamelCase(t)) if (p.length > 1) expanded.add(p)
    const s = stem(t)
    if (s !== t && s.length > 2) expanded.add(s)
  }
  const keywords = [...expanded].filter((t) => t.length > 1 && !EXPLORE_STOPWORDS.has(t))
  if (!keywords.length) {
    return { query, mode: 'classify', keywords: [], groups: {}, counts: {}, snippets: [], note: 'no usable keywords' }
  }

  const candidates = new Set()
  for (const k of keywords) {
    for (const [n, ids] of g.byName) {
      if (n.includes(k)) for (const id of ids) candidates.add(id)
    }
    for (const [f, ids] of g.byFile) {
      if (f.toLowerCase().includes(k)) for (const id of ids) candidates.add(id)
    }
  }

  // Optional semantic enrichment — ONLY when the graph already has embeddings
  // (g._embedded). Honours the offline rule: never triggers a model download.
  const semHits = new Map()
  if (g._embedded && query && embedding) {
    try {
      const qVec = await embedding.embed(query)
      if (qVec) {
        const sims = []
        for (const node of g.nodes.values()) {
          if (!node._embedding) continue
          const sim = embedding.cosineSim(qVec, node._embedding)
          if (sim > 0.3) sims.push({ id: node.id, sim })
        }
        sims.sort((a, b) => b.sim - a.sim)
        for (const { id, sim } of sims.slice(0, 30)) {
          candidates.add(id)
          semHits.set(id, sim)
        }
      }
    } catch (e) { if (process.env.CS_DBG) console.error('[cs] symbol-explore semantic:', e && e.message) }
  }

  const groups = {
    exact_match: [], semantic: [],
    active: [], entry: [], deprecated: [], legacy: [],
    test: [], aux: [], orphan: [], normal: [],
  }
  const keywordSet = new Set(keywords)
  for (const id of candidates) {
    const node = g.nodes.get(id)
    if (!node) continue
    const inD = g.inAdj.get(id)?.size || 0
    const ouD = g.outAdj.get(id)?.size || 0
    const mtime = node.mtimeMs || 0
    const ageMs = mtime ? (Date.now() - mtime) : 0
    const ONE_YEAR = 365 * 86400_000

    let cls
    if (isDeprecatedSymbol(node)) cls = 'deprecated'
    else if (isTestPath(node.file)
     || /^test[A-Z_]/.test(node.name || '')
     || /(_test$|spec$|Spec$)/.test(node.name || '')) cls = 'test'
    else if (isAuxExplorePath(node.file, EXPLORE_AUX_SEGMENTS)) cls = 'aux'
    else if (isPublicEntry(node)) cls = 'entry'
    else if (inD === 0 && ouD === 0) cls = 'orphan'
    else if (ageMs > ONE_YEAR && inD < 2) cls = 'legacy'
    else if (inD >= 3) cls = 'active'
    else cls = 'normal'

    const reachable = g._reachable ? g._reachable.has(id) : null
    const semOnly = !rawHasSubstring(node, keywords)
    const nameLower = (node.name || '').toLowerCase()
    const isExactName = keywordSet.has(nameLower)

    const entry = {
      qualifiedName: node.qualifiedName || node.name,
      name: node.name, kind: node.kind,
      file: node.file, startLine: node.startLine, endLine: node.endLine,
      inDegree: inD, outDegree: ouD,
      ageDays: mtime ? Math.floor(ageMs / 86400_000) : null,
      reachable,
      semSim: semHits.get(id) ?? null,
      classification: cls,
      semanticOnly: semOnly,
    }
    if (isExactName) groups.exact_match.push(entry)
    else if (semOnly) groups.semantic.push(entry)
    else groups[cls].push(entry)
  }

  const PER_GROUP_CAP = 8
  for (const g_name of Object.keys(groups)) {
    groups[g_name].sort((a, b) => (b.inDegree - a.inDegree) || ((b.semSim || 0) - (a.semSim || 0)))
    groups[g_name] = groups[g_name].slice(0, PER_GROUP_CAP)
  }

  const snippets = []
  const MAX_LINES_PER_SNIPPET = 40
  let used = 0
  const SNIPPET_ORDER = ['exact_match', 'active', 'entry', 'normal', 'semantic', 'legacy', 'deprecated', 'test', 'orphan', 'aux']
  outer: for (const groupName of SNIPPET_ORDER) {
    const members = groups[groupName]
    if (!members.length) continue
    const perGroupBudget = groupName === 'exact_match' ? 5
                         : (groupName === 'active' || groupName === 'entry') ? 3
                         : 1
    for (const m of members.slice(0, perGroupBudget)) {
      if (used >= budget) break outer
      try {
        const end = Math.min(m.endLine, m.startLine + MAX_LINES_PER_SNIPPET - 1)
        const source = readSource(m.file, m.startLine, end)
        if (source == null) continue
        const cost = Math.ceil(source.length / 4)
        if (used + cost > budget && snippets.length > 0) break outer
        snippets.push({
          group: groupName, file: m.file, line: m.startLine,
          name: m.name, kind: m.kind, source,
        })
        used += cost
      } catch {}
    }
  }

  const counts = {}
  for (const [k, v] of Object.entries(groups)) if (v.length) counts[k] = v.length

  return {
    query, mode: 'classify', keywords,
    groups, counts, snippets,
    embeddingReady: !!g._embedded,
  }
}

module.exports = {
  buildClassifyResponse,
  // exported for potential reuse / testing
  splitCamelCase, stem, isDeprecatedSymbol, isPublicEntry, isTestPath,
  isAuxExplorePath, rawHasSubstring, EXPLORE_STOPWORDS, EXPLORE_AUX_SEGMENTS,
}
