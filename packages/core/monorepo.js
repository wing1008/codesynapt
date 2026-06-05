// Monorepo detection — looks for workspace markers at scan root and
// returns a structured description of packages. Used by the scanner to
// tag each file with its owning package, and by the UI/API/MCP layers
// to expose package-level graphs.
//
// Returns: { kind, packages: [{ name, root, relRoot, manifest, kind, language }], rootIsPackage }
//   kind         : 'pnpm' | 'npm-workspaces' | 'yarn-workspaces' | 'lerna' |
//                  'turbo' | 'nx' | 'rush' | 'python-uv' | 'python-poetry' |
//                  'python-pdm' | 'python-hatch' | 'python-pep621' |
//                  'python-setuptools' | 'python-multi' | 'multi-package' |
//                  'single' | 'none'
//   packages     : [] when 'single' or 'none'; otherwise one entry per package
//                  (a 'single' result carries exactly one package entry — for
//                  both JS and Python single-package projects, symmetrically)
//   rootIsPackage: true when the scan root itself is also a publishable package
//                  (a JS package.json with a name, or a Python project manifest)

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
const PKG_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out',
  '.next', '.nuxt', '.turbo', '.vercel', 'venv', '.venv', '__pycache__',
  '.cache', '.parcel-cache', 'target', '.codesynapt', '.filegraph3d', 'coverage'])

function findManifests(root, manifestNames, maxDepth = MAX_DEPTH) {
  const found = []
  const skip = PKG_SKIP_DIRS
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

// ── Python build-tool classification ──────────────────────────────────
// The original code hardcoded every Python multi-package repo to
// 'python-uv', which is wrong for the overwhelming majority of Python
// projects (Poetry, PDM, Hatch, plain setuptools, bare PEP 621). We
// classify by reading the actual evidence: lockfiles at the repo root
// and the build-backend / tool tables declared inside each pyproject.toml.

// Specificity order: a more specific signal wins. uv/poetry/pdm/hatch
// are concrete tools; pep621 is the generic standardized metadata; a
// lone setup.py is legacy setuptools; otherwise 'python-multi' for a
// bespoke collection we can't pin to a tool.
const PY_TOOL_RANK = {
  'python-uv': 6,
  'python-poetry': 6,
  'python-pdm': 6,
  'python-hatch': 5,
  'python-setuptools': 4,
  'python-pep621': 3,
  'python-multi': 2,
}

function moreSpecificPyKind(a, b) {
  if (!a) return b
  if (!b) return a
  return (PY_TOOL_RANK[a] || 0) >= (PY_TOOL_RANK[b] || 0) ? a : b
}

// Inspect a single pyproject.toml's text for tool-specific tables and the
// build backend. Returns a kind string or null if nothing recognizable.
function classifyPyproject(text) {
  if (!text) return null
  // Tool-specific tables are the strongest signal.
  if (/^\s*\[tool\.uv(\.|\])/m.test(text)) return 'python-uv'
  if (/^\s*\[tool\.poetry(\.|\])/m.test(text)) return 'python-poetry'
  if (/^\s*\[tool\.pdm(\.|\])/m.test(text)) return 'python-pdm'
  if (/^\s*\[tool\.hatch(\.|\])/m.test(text)) return 'python-hatch'

  // Otherwise infer from the declared build backend.
  const bb = text.match(/^\s*build-backend\s*=\s*["']([^"']+)["']/m)
  if (bb) {
    const backend = bb[1].toLowerCase()
    if (backend.includes('hatchling')) return 'python-hatch'
    if (backend.includes('poetry')) return 'python-poetry'
    if (backend.includes('pdm')) return 'python-pdm'
    if (backend.includes('uv')) return 'python-uv'
    if (backend.includes('setuptools')) return 'python-setuptools'
    if (backend.includes('flit')) return 'python-pep621'
  }
  // A bare PEP 621 [project] table with no recognizable backend/tool.
  if (/^\s*\[project\]/m.test(text)) return 'python-pep621'
  return null
}

// Determine the Python ecosystem kind for a set of package dirs, using
// root-level lockfiles plus each package's manifest. `manifests` is the
// list from findManifests ({ dir, manifest }).
function classifyPythonKind(root, manifests, names) {
  // Root lockfiles are an unambiguous, repo-wide signal.
  let kind = null
  if (names) {
    if (names.has('uv.lock')) kind = moreSpecificPyKind(kind, 'python-uv')
    if (names.has('poetry.lock')) kind = moreSpecificPyKind(kind, 'python-poetry')
    if (names.has('pdm.lock')) kind = moreSpecificPyKind(kind, 'python-pdm')
    // A root-level pyproject.toml (the umbrella in an umbrella+members
    // layout) often carries the tool table that pins the whole repo.
    if (names.has('pyproject.toml')) {
      let rootText = ''
      try { rootText = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8') } catch {}
      const k = classifyPyproject(rootText)
      if (k) kind = moreSpecificPyKind(kind, k)
    }
  }
  let sawSetupPyOnly = false
  for (const m of manifests) {
    if (m.manifest === 'pyproject.toml') {
      let text = ''
      try { text = fs.readFileSync(path.join(m.dir, 'pyproject.toml'), 'utf8') } catch {}
      const k = classifyPyproject(text)
      if (k) kind = moreSpecificPyKind(kind, k)
    } else if (m.manifest === 'setup.py') {
      // Only counts as setuptools if there's no pyproject backing it.
      if (!fs.existsSync(path.join(m.dir, 'pyproject.toml'))) sawSetupPyOnly = true
    }
  }
  if (!kind && sawSetupPyOnly) kind = 'python-setuptools'
  // Could not pin a tool from any manifest — still a real Python repo.
  return kind || 'python-multi'
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

  // A Python project rooted at the scan dir (single-package, mirror of
  // the JS package.json-at-root case). pyproject.toml is preferred over a
  // bare setup.py. This makes rootIsPackage and the 'single' result
  // symmetric across languages instead of only firing for JS.
  const rootPyManifest = names.has('pyproject.toml') ? 'pyproject.toml'
    : names.has('setup.py') ? 'setup.py' : null
  if (rootPyManifest && !rootPkgJson?.name) result.rootIsPackage = true

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

  // ⑥ Python pyproject.toml / setup.py multi-package: detect if multiple
  // Python manifests exist at depth > 0. The ecosystem kind is derived
  // from the actual build tool (uv / poetry / pdm / hatch / setuptools /
  // bare PEP 621), not hardcoded.
  // findManifests stops descending as soon as it finds a manifest in a
  // directory (packages are leaves). That means a root-level pyproject.toml
  // would hide member packages in subdirectories. To find members we must
  // search each child subtree of root independently rather than root itself
  // (pass-2 fix), so a root pyproject.toml no longer hides nested members.
  let pyManifests
  if (rootPyManifest) {
    pyManifests = []
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name.startsWith('.') || PKG_SKIP_DIRS.has(e.name)) continue
      const sub = path.join(root, e.name)
      for (const m of findManifests(sub, ['pyproject.toml', 'setup.py'])) pyManifests.push(m)
    }
  } else {
    pyManifests = findManifests(root, ['pyproject.toml', 'setup.py'])
  }
  // Exclude root from the python list — it's the umbrella, not a package.
  // `pythonManifests` keeps the { dir, manifest } shape for classification;
  // `pythonDirs` is the flat dir-string list used by the merge/fallback
  // branches below.
  const pythonManifests = pyManifests.filter((m) => m.dir !== root)
  const pythonDirs = pythonManifests.map((m) => m.dir)
  const rootHasPython = names.has('pyproject.toml') || names.has('setup.py')

  if (kind === 'none' && pythonDirs.length >= 2) {
    // A pure-Python monorepo with no JS workspace marker. Report the
    // actual tooling (poetry/uv/pdm/hatch/setuptools/…) by reading the
    // real build-tool evidence rather than a hardcoded label.
    kind = classifyPythonKind(root, pythonManifests, names)
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

  // No multi-package signal — check for a single-package project. This
  // path is language-symmetric: a lone JS package (package.json at root)
  // and a lone Python package (pyproject.toml / setup.py at root, or a
  // single nested Python manifest) both yield kind:'single' with exactly
  // one package entry. Previously only JS produced a 'single' result;
  // Python fell through to 'none' with an empty packages list.
  if (kind === 'none') {
    // ⓐ JS package.json at root takes precedence (matches historical
    // behavior and the rootIsPackage signal).
    if (rootPkgJson?.name) {
      result.kind = 'single'
      result.packages = [{
        name: rootPkgJson.name || path.basename(root),
        root, relRoot: '.', manifest: 'package.json',
        kind: 'single', language: 'js',
      }]
      return result
    }
    // ⓑ Python project rooted at the scan dir. Symmetric with the
    // single-JS case: a lone Python project (root pyproject.toml /
    // setup.py) yields one package entry, not kind='none'/n=0.
    if (rootPyManifest || rootHasPython) {
      const manifestName = rootPyManifest
        || (names.has('pyproject.toml') ? 'pyproject.toml' : 'setup.py')
      const manifestPath = path.join(root, manifestName)
      result.kind = 'single'
      result.rootIsPackage = true
      result.packages = [{
        name: packageNameFromManifest(manifestPath, manifestName, path.basename(root)),
        root, relRoot: '.', manifest: manifestName,
        kind: 'single', language: 'python',
      }]
      return result
    }
    // ⓒ Exactly one nested Python manifest (no root manifest, only one
    // package) — still a single Python project, just not at the root.
    if (pythonManifests.length === 1) {
      const dir = pythonManifests[0].dir
      const manifestName = pythonManifests[0].manifest
      const manifestPath = path.join(dir, manifestName)
      result.kind = 'single'
      result.packages = [{
        name: packageNameFromManifest(manifestPath, manifestName, path.basename(dir)),
        root: dir, relRoot: relativePosix(root, dir),
        manifest: manifestName, kind: 'single', language: 'python',
      }]
      return result
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
  // workspaces with a root package, or a Python repo whose root carries
  // its own pyproject.toml / setup.py alongside member packages).
  if (result.rootIsPackage && !packages.some((p) => p.root === root)) {
    if (rootPkgJson?.name) {
      packages.unshift({
        name: rootPkgJson.name || path.basename(root),
        root, relRoot: '.', manifest: 'package.json',
        kind, language: 'js',
      })
    } else if (rootPyManifest) {
      const manifestPath = path.join(root, rootPyManifest)
      packages.unshift({
        name: packageNameFromManifest(manifestPath, rootPyManifest, path.basename(root)),
        root, relRoot: '.', manifest: rootPyManifest,
        kind, language: 'python',
      })
    }
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
