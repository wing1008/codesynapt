// Monorepo detection — looks for workspace markers at scan root and
// returns a structured description of packages. Used by the scanner to
// tag each file with its owning package, and by the UI/API/MCP layers
// to expose package-level graphs.
//
// Returns: { kind, packages: [{ name, root, relRoot, manifest, kind, language }], rootIsPackage }
//   kind         : 'pnpm' | 'npm-workspaces' | 'yarn-workspaces' | 'lerna' |
//                  'turbo' | 'nx' | 'rush' | 'python-uv' | 'multi-package' | 'single' | 'none'
//   packages     : [] when 'single' or 'none'; otherwise one entry per package
//   rootIsPackage: true when the scan root itself is also a publishable package

import fs from 'fs'
import path from 'path'

const MAX_DEPTH = 6  // how deep we search for package.json / pyproject.toml

// Tiny YAML mini-parser — enough for pnpm-workspace.yaml which is just
// `packages:` followed by a `-` list of glob strings. Not a real YAML
// parser, just covers the canonical shape.
function parsePnpmWorkspace(text) {
  const out = []
  let inPackages = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (!line.trim()) continue
    const head = line.match(/^packages\s*:(.*)$/i)
    if (head) {
      inPackages = true
      // Flow-style inline array on the same line, e.g.
      //   packages: ["packages/*", "apps/*"]
      const rest = head[1].trim()
      if (rest.startsWith('[')) {
        for (const item of parseFlowArray(rest)) out.push(item)
        inPackages = false  // a flow array is self-contained
      }
      continue
    }
    if (inPackages) {
      const m = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/)
      if (m) out.push(m[1])
      else if (/^\S/.test(line)) inPackages = false  // new top-level key
    }
  }
  return out
}

// Extract quoted string items from a flow-style YAML/JSON array such as
// `["packages/*", 'apps/*']`. Tolerates single or double quotes and
// surrounding whitespace. Unquoted scalars are accepted too.
function parseFlowArray(text) {
  const inner = text.replace(/^\s*\[/, '').replace(/\]\s*$/, '')
  const out = []
  for (const piece of inner.split(',')) {
    const t = piece.trim()
    if (!t) continue
    const q = t.match(/^['"]([^'"]*)['"]$/)
    out.push(q ? q[1] : t)
  }
  return out
}

// Expand a workspace glob pattern like "packages/*" or "apps/**" into
// concrete package directories that contain package.json or pyproject.toml.
// Only handles the patterns actually used in practice — single `*` or
// `**` segments. Negation patterns (`!foo`) are honored.
function expandWorkspaceGlob(root, pattern, manifestFile = 'package.json') {
  const negate = pattern.startsWith('!')
  const pat = negate ? pattern.slice(1) : pattern
  // Strip leading "./"
  const clean = pat.replace(/^\.\//, '')
  const parts = clean.split('/').filter(Boolean)
  const out = []
  const walk = (dir, idx) => {
    if (idx >= parts.length) {
      const m = path.join(dir, manifestFile)
      if (fs.existsSync(m)) out.push(dir)
      return
    }
    const seg = parts[idx]
    if (seg === '**') {
      // Match zero or more dirs. Try matching the rest at current dir,
      // and recurse into all subdirs.
      walk(dir, idx + 1)
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (!e.isDirectory()) continue
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        walk(path.join(dir, e.name), idx)  // stay at same idx (greedy)
      }
    } else if (seg.includes('*')) {
      const re = new RegExp('^' + seg.split('*').map(s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (!e.isDirectory()) continue
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        if (re.test(e.name)) walk(path.join(dir, e.name), idx + 1)
      }
    } else {
      walk(path.join(dir, seg), idx + 1)
    }
  }
  walk(root, 0)
  return { dirs: out, negate }
}

function expandWorkspacePatterns(root, patterns, manifestFile = 'package.json') {
  const found = new Set()
  for (const p of patterns) {
    const { dirs, negate } = expandWorkspaceGlob(root, p, manifestFile)
    if (negate) for (const d of dirs) found.delete(d)
    else        for (const d of dirs) found.add(d)
  }
  return [...found]
}

// Read a JSON file safely.
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

// Find package.json / pyproject.toml files via a bounded BFS. Stops at
// node_modules, .git, etc. Used as a fallback when no workspace marker
// is present.
function findManifests(root, manifestNames, maxDepth = MAX_DEPTH) {
  const found = []
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'out',
    '.next', '.nuxt', '.turbo', '.vercel', 'venv', '.venv', '__pycache__',
    '.cache', '.parcel-cache', 'target', '.codesynapt', '.filegraph3d', 'coverage'])
  const walk = (dir, depth) => {
    if (depth > maxDepth) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    // Record a manifest at this level (caller decides separately whether
    // to include the root itself).
    let hasManifest = false
    for (const name of manifestNames) {
      if (entries.some((e) => e.isFile() && e.name === name)) {
        found.push({ dir, manifest: name })
        hasManifest = true
        break
      }
    }
    // A manifest in a NON-root directory marks a package — packages are
    // leaves in the workspace tree, so don't descend further. But the
    // scan root almost always has a package.json/pyproject.toml of its
    // own (the umbrella), and stopping there would hide every nested
    // sub-package. So at the root we always keep recursing.
    if (hasManifest && depth > 0) return
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (skip.has(e.name) || e.name.startsWith('.')) continue
      walk(path.join(dir, e.name), depth + 1)
    }
  }
  walk(root, 0)
  return found
}

function packageNameFromManifest(absPath, manifestFile, fallbackDir) {
  if (manifestFile === 'package.json') {
    const j = readJsonSafe(absPath)
    if (j?.name) return j.name
  } else if (manifestFile === 'pyproject.toml') {
    try {
      const text = fs.readFileSync(absPath, 'utf8')
      // [project] name = "x" or [tool.poetry] name = "x"
      const m = text.match(/^\s*name\s*=\s*["']([^"']+)["']/m)
      if (m) return m[1]
    } catch {}
  } else if (manifestFile === 'setup.py') {
    try {
      const text = fs.readFileSync(absPath, 'utf8')
      const m = text.match(/name\s*=\s*["']([^"']+)["']/)
      if (m) return m[1]
    } catch {}
  }
  return fallbackDir
}

function relativePosix(root, abs) {
  const r = path.relative(root, abs).split(path.sep).join('/')
  return r === '' ? '.' : r
}

// Classify a Python project's tooling from its root manifest so the
// reported `kind` isn't a hardcoded 'python-uv' lie. Recognizes uv,
// poetry, pdm, hatch, setuptools (PEP 621 / setup.py). Falls back to a
// generic 'python' label when nothing specific is declared.
function detectPythonKind(root) {
  const pp = path.join(root, 'pyproject.toml')
  let text = ''
  try { text = fs.readFileSync(pp, 'utf8') } catch {}
  if (text) {
    if (/^\s*\[tool\.uv\b/m.test(text) || /^\s*\[tool\.uv\.workspace\]/m.test(text)) return 'python-uv'
    if (/^\s*\[tool\.poetry\b/m.test(text)) return 'python-poetry'
    if (/^\s*\[tool\.pdm\b/m.test(text)) return 'python-pdm'
    if (/^\s*\[tool\.hatch\b/m.test(text)) return 'python-hatch'
    // PEP 621 [project] table without a specific tool → setuptools/generic
    if (/^\s*\[project\]/m.test(text)) return 'python'
    return 'python'
  }
  // No pyproject.toml → setup.py-based project
  if (fs.existsSync(path.join(root, 'setup.py'))) return 'python'
  return 'python'
}

export function detectMonorepo(root) {
  const result = { kind: 'none', packages: [], rootIsPackage: false }
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return result }
  const names = new Set(entries.map((e) => e.name))

  // ── Detect the kind by marker files ──
  // Layered detection: if multiple markers, prefer the most specific.
  // pnpm > yarn/npm workspaces > lerna > turbo > nx > rush
  const rootPkgJson = names.has('package.json') ? readJsonSafe(path.join(root, 'package.json')) : null
  if (rootPkgJson?.name) result.rootIsPackage = true

  let kind = 'none'
  let patterns = []
  let manifestFile = 'package.json'

  // ① pnpm-workspace.yaml
  if (names.has('pnpm-workspace.yaml') || names.has('pnpm-workspace.yml')) {
    try {
      const file = names.has('pnpm-workspace.yaml') ? 'pnpm-workspace.yaml' : 'pnpm-workspace.yml'
      const text = fs.readFileSync(path.join(root, file), 'utf8')
      patterns = parsePnpmWorkspace(text)
      kind = 'pnpm'
    } catch {}
  }
  // ② package.json workspaces field (npm 7+ / yarn)
  if (kind === 'none' && rootPkgJson) {
    const ws = rootPkgJson.workspaces
    if (Array.isArray(ws)) { patterns = ws; kind = 'npm-workspaces' }
    else if (ws && Array.isArray(ws.packages)) { patterns = ws.packages; kind = 'yarn-workspaces' }
  }
  // ③ lerna.json
  if (kind === 'none' && names.has('lerna.json')) {
    const j = readJsonSafe(path.join(root, 'lerna.json'))
    if (j?.packages && Array.isArray(j.packages)) { patterns = j.packages; kind = 'lerna' }
    else { patterns = ['packages/*']; kind = 'lerna' }
  }
  // ④ rush.json (less common but valid)
  if (kind === 'none' && names.has('rush.json')) {
    const j = readJsonSafe(path.join(root, 'rush.json'))
    if (j?.projects) {
      patterns = j.projects.map((p) => p.projectFolder).filter(Boolean)
      kind = 'rush'
    }
  }
  // ⑤ turbo.json / nx.json — these don't themselves define packages,
  // they augment npm/yarn/pnpm workspaces. If we already found patterns,
  // mark the kind as 'turbo'/'nx' (more informative); else treat as a
  // signal to do heuristic search.
  if (names.has('turbo.json') && kind !== 'none') kind = 'turbo'
  else if (names.has('nx.json') && kind !== 'none') kind = 'nx'

  // ── Expand patterns or fall back to manifest search ──
  let packageDirs = []
  if (kind !== 'none' && patterns.length > 0) {
    packageDirs = expandWorkspacePatterns(root, patterns, 'package.json')
  }

  // ⑥ Python pyproject.toml / setup.py packages anywhere below root.
  // (findManifests now keeps recursing past the root umbrella, so a
  // root pyproject.toml no longer hides nested Python packages.)
  const pyManifests = findManifests(root, ['pyproject.toml', 'setup.py'])
  // Exclude root from the python list — it's the umbrella, not a package.
  const pythonDirs = pyManifests.filter((m) => m.dir !== root).map((m) => m.dir)
  const rootHasPython = names.has('pyproject.toml') || names.has('setup.py')

  if (kind === 'none' && pythonDirs.length >= 2) {
    // A pure-Python monorepo with no JS workspace marker. Report the
    // actual tooling (poetry/uv/pdm/…) rather than a hardcoded label.
    kind = detectPythonKind(root)
    packageDirs = pythonDirs.slice()
  } else if (kind !== 'none' && pythonDirs.length > 0) {
    // Mixed-language monorepo: a JS workspace was detected first, but
    // there are also real Python sub-packages. Merge them in so they
    // get their own package node / grouping instead of being dropped or
    // mis-attributed to the root umbrella.
    for (const d of pythonDirs) if (!packageDirs.includes(d)) packageDirs.push(d)
  }

  // ⑦ Generic multi-package fallback: multiple package.json files at
  // depth > 0 with no explicit workspace declaration. This catches
  // bespoke monorepos that don't use any standard tool — including the
  // common case where the scan root itself is a package.json but has no
  // `workspaces` field, yet contains real sub-packages.
  let jsSubManifests = []
  if (kind === 'none' || (kind !== 'none' && patterns.length === 0)) {
    jsSubManifests = findManifests(root, ['package.json']).filter((m) => m.dir !== root)
  }
  if (kind === 'none') {
    // A named root with even a single nested package, OR ≥2 bespoke
    // sub-packages, is a multi-package repo. We still want the root to
    // appear as its own package (handled below via rootIsPackage).
    if (jsSubManifests.length >= 2 ||
        (result.rootIsPackage && jsSubManifests.length >= 1)) {
      kind = 'multi-package'
      packageDirs = jsSubManifests.map((m) => m.dir)
      // Fold in any Python sub-packages discovered above.
      for (const d of pythonDirs) if (!packageDirs.includes(d)) packageDirs.push(d)
    }
  }

  // No JS/Python workspace signal at all
  if (kind === 'none') {
    if (result.rootIsPackage) {
      result.kind = 'single'
      result.packages = [{
        name: rootPkgJson?.name || path.basename(root),
        root, relRoot: '.', manifest: 'package.json',
        kind: 'single', language: 'js',
      }]
    } else if (rootHasPython) {
      // Symmetric with the single-JS case: a lone Python project (root
      // pyproject.toml / setup.py with a name) should also yield one
      // package entry, not kind='none'/n=0.
      const manifestName = names.has('pyproject.toml') ? 'pyproject.toml' : 'setup.py'
      const manifestPath = path.join(root, manifestName)
      result.kind = 'single'
      result.rootIsPackage = true
      result.packages = [{
        name: packageNameFromManifest(manifestPath, manifestName, path.basename(root)),
        root, relRoot: '.', manifest: manifestName,
        kind: 'single', language: 'python',
      }]
    }
    return result
  }

  // ── Build package list ──
  const packages = []
  for (const dir of packageDirs) {
    const isPython = fs.existsSync(path.join(dir, 'pyproject.toml')) ||
                     fs.existsSync(path.join(dir, 'setup.py'))
    const manifestName = isPython
      ? (fs.existsSync(path.join(dir, 'pyproject.toml')) ? 'pyproject.toml' : 'setup.py')
      : 'package.json'
    const manifestPath = path.join(dir, manifestName)
    const name = packageNameFromManifest(manifestPath, manifestName, path.basename(dir))
    packages.push({
      name, root: dir, relRoot: relativePosix(root, dir),
      manifest: manifestName, kind, language: isPython ? 'python' : 'js',
    })
  }
  // Optionally include root if it's also a publishable package (npm
  // workspaces with a root package).
  if (result.rootIsPackage && !packages.some((p) => p.root === root)) {
    packages.unshift({
      name: rootPkgJson?.name || path.basename(root),
      root, relRoot: '.', manifest: 'package.json',
      kind, language: 'js',
    })
  }

  // Disambiguate duplicate package names. Two distinct directories can
  // legitimately declare the same `name` (copy-paste, scaffolding, a
  // private + public variant). Downstream grouping keys files by the
  // string returned from packageForFile (the name), so collapsing them
  // would merge two packages into one group and silently drop their
  // cross-package edges. Suffix the relRoot to keep them distinct while
  // preserving the original declared name in `declaredName`.
  const nameCounts = new Map()
  for (const p of packages) nameCounts.set(p.name, (nameCounts.get(p.name) || 0) + 1)
  for (const p of packages) {
    if (nameCounts.get(p.name) > 1 && p.relRoot !== '.') {
      p.declaredName = p.name
      p.name = `${p.name} (${p.relRoot})`
    }
  }

  result.kind = kind
  result.packages = packages.sort((a, b) => a.relRoot.localeCompare(b.relRoot))
  return result
}

// Given a file id (root-relative, posix slashes) and a packages array,
// return the owning package's name (longest-matching relRoot prefix),
// or null if the file lives outside every package boundary.
export function packageForFile(fileId, packages) {
  let best = null
  let bestLen = -1
  for (const p of packages) {
    const prefix = p.relRoot === '.' ? '' : p.relRoot + '/'
    if (p.relRoot === '.' || fileId === p.relRoot || fileId.startsWith(prefix)) {
      const len = p.relRoot === '.' ? 0 : prefix.length
      if (len > bestLen) { best = p.name; bestLen = len }
    }
  }
  return best
}

// Read declared internal dependencies of a package (cross-package edges
// via workspace protocol or explicit deps). Used to validate the
// graph-derived edges against the manifest-declared truth.
export function declaredPackageDeps(pkg) {
  if (pkg.manifest !== 'package.json') return []
  const j = readJsonSafe(path.join(pkg.root, 'package.json'))
  if (!j) return []
  const out = []
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const obj = j[field]
    if (!obj) continue
    for (const [name, spec] of Object.entries(obj)) {
      out.push({ name, spec, kind: field })
    }
  }
  return out
}
