// Legacy / migration audit — surfaces candidates for cleanup with a
// confidence score and a human-readable reason for each. The goal is
// to answer "what can I safely delete?" — a question every long-lived
// codebase needs answered eventually but no static tool gives a
// trustworthy answer to.
//
// Output shape:
//   {
//     orphans:           [{ id, confidence, reason, mass, loc }]   no in + no out
//     pathPatterns:      [{ id, pattern, confidence, reason, mass, loc }]
//     filenamePatterns:  [{ id, marker, confidence, reason, mass, loc }]
//     duplicates:        [{ basename, files: [{ id, mass, loc, isNewer? }] }]
//     summary:           { totalFiles, candidateCount, totalLoc, byCategory }
//   }
//
// Confidence is a number 0..1. Above 0.85 means "safe to delete in
// most cases"; 0.5-0.85 means "review"; below 0.5 means "noise but
// flagged for completeness." We deliberately do NOT call anything
// "definitely dead" — dynamic imports, plugins, build-tool entry
// points all evade static analysis.

// Path components that strongly imply abandonment. Order matters only
// for reason text — all patterns are checked.
const PATH_MARKERS = [
  { rx: /(^|\/)_legacy(\/|$|_)/i,      label: '_legacy',     conf: 0.92 },
  { rx: /(^|\/)_archive(\/|$|_)/i,     label: '_archive',    conf: 0.92 },
  { rx: /(^|\/)_old(\/|$|_)/i,         label: '_old',        conf: 0.88 },
  { rx: /(^|\/)legacy(\/|$)/i,         label: 'legacy',      conf: 0.80 },
  { rx: /(^|\/)archive(\/|$)/i,        label: 'archive',     conf: 0.80 },
  { rx: /(^|\/)deprecated(\/|$)/i,     label: 'deprecated',  conf: 0.90 },
  { rx: /(^|\/)old(\/|$)/i,            label: 'old',         conf: 0.75 },
  { rx: /(^|\/)backup(s)?(\/|$)/i,     label: 'backup',      conf: 0.85 },
  { rx: /(^|\/)v[0-9]+_old(\/|$)/i,    label: 'vN_old',      conf: 0.92 },
  { rx: /(^|\/)trash(\/|$)/i,          label: 'trash',       conf: 0.95 },
  { rx: /(^|\/)unused(\/|$)/i,         label: 'unused',      conf: 0.88 },
  // Common version-bumped folders that often outlive their use
  { rx: /(^|\/)v[0-9]+(\/|$)/i,        label: 'vN folder',   conf: 0.45 },
]

// Filename suffix/prefix patterns. `confidence` here is the per-file
// signal; ultimate confidence factors in graph mass too.
const FILENAME_MARKERS = [
  { rx: /[._-]old[._]/i,         label: '_old marker',        conf: 0.80 },
  { rx: /[._-]old\.[a-z]+$/i,    label: 'name_old.ext',       conf: 0.85 },
  { rx: /[._-]legacy[._]/i,      label: '_legacy marker',     conf: 0.85 },
  { rx: /[._-]legacy\.[a-z]+$/i, label: 'name_legacy.ext',    conf: 0.88 },
  { rx: /[._-]deprecated[._]/i,  label: '_deprecated marker', conf: 0.90 },
  { rx: /[._-]backup[._]/i,      label: '_backup marker',     conf: 0.85 },
  { rx: /[._-]bak\.[a-z]+$/i,    label: '.bak.ext',           conf: 0.90 },
  { rx: /\.bak$/i,               label: '.bak suffix',        conf: 0.92 },
  { rx: /\.orig$/i,              label: '.orig suffix',       conf: 0.90 },
  { rx: /\.tmp\./i,              label: '.tmp marker',        conf: 0.70 },
  { rx: /[._-]copy(\d+)?\.[a-z]+$/i,  label: 'copy variant',  conf: 0.85 },
  // Common version markers — flagged at lower confidence because v2/v3
  // sometimes IS the current code. The duplicate-name check decides
  // whether to elevate.
  { rx: /[._-]v[0-9]+\.[a-z]+$/i,     label: 'vN variant',    conf: 0.40 },
]

// Files that are typically entry points and shouldn't be flagged as
// orphans even if nothing imports them statically (the host imports
// them externally — Electron main, CLI bin, server entry, etc.).
const ENTRY_PATTERNS = [
  // Universal entry-point filenames (anywhere in the tree)
  /(^|\/)index\.[cm]?[jt]sx?$/,
  /(^|\/)main\.[cm]?[jt]sx?$/,
  /(^|\/)server\.[cm]?[jt]sx?$/,
  /(^|\/)app\.[cm]?[jt]sx?$/,
  /(^|\/)cli\.[cm]?[jt]sx?$/,
  /(^|\/)preload\.[cm]?[jt]sx?$/,
  // Standard build/runtime entry directories
  /(^|\/)bin\/[^/]+$/,
  /(^|\/)scripts\/[^/]+$/,
  /(^|\/)examples?\//,             // example files are entry points for users
  /(^|\/)demos?\//,
  /(^|\/)playground\//,
  /(^|\/)fixtures?\//,              // test fixtures, loaded by runner
  // Plugin / manifest entry points
  /(^|\/)manifest\.json$/,
  /(^|\/)theme\.css$/,
  // Config & docs
  /(^|\/)vite\.config\./,
  /(^|\/)webpack\.config\./,
  /(^|\/)next\.config\./,
  /(^|\/)rollup\.config\./,
  /(^|\/)esbuild\.config\./,
  /(^|\/)tsconfig(\.[a-z]+)?\.json$/,
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)README\.md$/i,
  /(^|\/)CHANGELOG\.md$/i,
  /(^|\/)LICENSE/i,
  /(^|\/)CONTRIBUTING\.md$/i,
  /(^|\/)CODE_OF_CONDUCT\.md$/i,
  /(^|\/)\.[a-z]+rc(\.[a-z]+)?$/,   // .eslintrc, .prettierrc, etc.
  /\.config\.[cm]?[jt]s$/,
  /\.d\.ts$/,                       // type declaration files
  // GitHub project files
  /(^|\/)\.github\//,
]

// Files that are often the test sibling of a real file — distinct
// from production orphans.
const TEST_PATTERNS = [
  /\.test\.[a-z]+$/i,
  /\.spec\.[a-z]+$/i,
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
]

function looksLikeEntry(id) {
  for (const rx of ENTRY_PATTERNS) if (rx.test(id)) return true
  return false
}
function looksLikeTest(id) {
  for (const rx of TEST_PATTERNS) if (rx.test(id)) return true
  return false
}
function basenameOf(id) {
  const i = id.lastIndexOf('/')
  return i >= 0 ? id.slice(i + 1) : id
}
function stripExt(name) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}
// Strip common version/legacy markers from a basename so we can find
// the "logical name" — `foo_old.js` and `foo.js` both → `foo`.
function logicalName(name) {
  let n = stripExt(name)
  n = n.replace(/[._-](?:old|legacy|deprecated|backup|bak|orig|copy\d*|v\d+)$/i, '')
  return n.toLowerCase()
}

export function auditLegacy(scanner) {
  if (!scanner) return null
  const files = [...scanner.files.values()]
  const incoming = new Map()
  const outgoing = new Map()
  for (const e of scanner.edges) {
    incoming.set(e.t, (incoming.get(e.t) || 0) + 1)
    outgoing.set(e.s, (outgoing.get(e.s) || 0) + 1)
  }

  const orphans = []
  const pathPatterns = []
  const filenamePatterns = []
  const flagged = new Set()  // dedup across categories

  // ── Orphans: no in, no out, not an entry point ──
  for (const f of files) {
    const inc = incoming.get(f.id) || 0
    const out = outgoing.get(f.id) || 0
    if (inc !== 0 || out !== 0) continue
    if (looksLikeEntry(f.id)) continue
    // Honest disclaimer: dynamic patterns reduce confidence sharply.
    const hasDynamic = (f.dynamicPatterns || []).length > 0
    const isTest = looksLikeTest(f.id)
    let conf = 0.85
    let reason = 'no incoming or outgoing edges'
    if (hasDynamic) { conf -= 0.35; reason += '; has dynamic import patterns' }
    if (isTest)     { conf -= 0.20; reason += '; appears to be a test file (loaded by runner)' }
    if (f.ext === 'md' || f.ext === 'json' || f.ext === 'yaml' || f.ext === 'yml') {
      conf -= 0.25; reason += '; data/doc file (may be referenced outside the graph)'
    }
    orphans.push({
      id: f.id, confidence: Math.max(0.1, Math.min(0.99, conf)),
      reason, mass: 0, loc: f.loc, size: f.size,
    })
    flagged.add(f.id)
  }

  // ── Path-based markers ──
  for (const f of files) {
    for (const m of PATH_MARKERS) {
      if (!m.rx.test(f.id)) continue
      const inc = incoming.get(f.id) || 0
      const out = outgoing.get(f.id) || 0
      // If something still imports it, lower confidence — it's not
      // truly abandoned even if it lives in a legacy folder.
      let conf = m.conf
      let reason = `lives under \`${m.label}\` directory`
      if (inc > 0) { conf -= Math.min(0.4, 0.1 * inc); reason += ` (${inc} dependents — verify before removing)` }
      else         { reason += ' and nothing imports it' }
      pathPatterns.push({
        id: f.id, pattern: m.label,
        confidence: Math.max(0.1, Math.min(0.99, conf)),
        reason, mass: inc, loc: f.loc, size: f.size,
      })
      flagged.add(f.id)
      break  // one match per file is enough
    }
  }

  // ── Filename markers ──
  for (const f of files) {
    const base = basenameOf(f.id)
    for (const m of FILENAME_MARKERS) {
      if (!m.rx.test(base)) continue
      const inc = incoming.get(f.id) || 0
      let conf = m.conf
      let reason = `filename has ${m.label}`
      if (inc > 0) { conf -= Math.min(0.35, 0.08 * inc); reason += ` (${inc} dependents)` }
      filenamePatterns.push({
        id: f.id, marker: m.label,
        confidence: Math.max(0.1, Math.min(0.99, conf)),
        reason, mass: inc, loc: f.loc, size: f.size,
      })
      flagged.add(f.id)
      break
    }
  }

  // ── Duplicate-basename detection ──
  //
  // Group files by their *logical* basename (after stripping legacy/version
  // markers). When a logical name has multiple files AND at least one
  // looks legacy (path or filename pattern), report the cluster — the
  // legacy ones are likely the supersedees.
  const byLogical = new Map()
  for (const f of files) {
    const base = basenameOf(f.id)
    const key = logicalName(base) + '.' + (f.ext || '')
    const arr = byLogical.get(key) || []
    arr.push(f)
    byLogical.set(key, arr)
  }
  const duplicates = []
  for (const [key, group] of byLogical) {
    if (group.length < 2) continue
    if (group.length > 6) continue  // probably a real pattern (e.g., many "index.js"), skip
    const entries = group.map((f) => ({
      id: f.id,
      mass: incoming.get(f.id) || 0,
      loc: f.loc,
      size: f.size,
      hasLegacyMarker: PATH_MARKERS.some((m) => m.rx.test(f.id))
                    || FILENAME_MARKERS.some((m) => m.rx.test(basenameOf(f.id))),
    }))
    // Skip if NONE has a legacy marker — almost certainly a true duplicate
    // by coincidence (e.g. apps/A/index.js vs apps/B/index.js) rather than a
    // migration leftover.
    if (!entries.some((e) => e.hasLegacyMarker)) continue
    // Mark the one with highest mass as "current"
    entries.sort((a, b) => b.mass - a.mass)
    entries[0].isCurrent = true
    duplicates.push({ basename: key, files: entries })
  }

  // ── Sort everything by confidence (descending) ──
  orphans.sort((a, b) => b.confidence - a.confidence)
  pathPatterns.sort((a, b) => b.confidence - a.confidence)
  filenamePatterns.sort((a, b) => b.confidence - a.confidence)
  duplicates.sort((a, b) => a.basename.localeCompare(b.basename))

  // ── Summary ──
  const candidateIds = new Set([
    ...orphans.map((x) => x.id),
    ...pathPatterns.map((x) => x.id),
    ...filenamePatterns.map((x) => x.id),
    ...duplicates.flatMap((d) => d.files.filter((f) => f.hasLegacyMarker).map((f) => f.id)),
  ])
  const totalLoc = [...candidateIds].reduce((s, id) => s + (scanner.files.get(id)?.loc || 0), 0)
  return {
    orphans,
    pathPatterns,
    filenamePatterns,
    duplicates,
    summary: {
      totalFiles: files.length,
      candidateCount: candidateIds.size,
      totalLoc,
      byCategory: {
        orphan: orphans.length,
        path: pathPatterns.length,
        filename: filenamePatterns.length,
        duplicate: duplicates.length,
      },
      // Highest-confidence cleanup candidates — flat list, dedup'd,
      // capped at 100, sorted by confidence desc. Useful for "show me
      // the top N things to delete" without paging through categories.
      topCandidates: (() => {
        const all = [
          ...orphans.map((o) => ({ ...o, category: 'orphan' })),
          ...pathPatterns.map((o) => ({ ...o, category: 'path' })),
          ...filenamePatterns.map((o) => ({ ...o, category: 'filename' })),
        ]
        const dedup = new Map()
        for (const c of all) {
          const prev = dedup.get(c.id)
          if (!prev || prev.confidence < c.confidence) dedup.set(c.id, c)
        }
        return [...dedup.values()]
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 100)
      })(),
    },
  }
}
