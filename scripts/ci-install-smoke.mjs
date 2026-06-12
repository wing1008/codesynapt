// CI install smoke: prove Layer-2 actually WORKS from a real (hoisted) npm
// install of the packed tarball — the dev-repo test suite cannot catch a
// wasm/path/packaging regression that only surfaces once installed (insp-004:
// every tree-sitter language was silently dead in npm installs while the repo
// suite stayed green). Run AFTER `npm install <tgz>` into a throwaway project.
//
// Usage: node ci-install-smoke.mjs <path-to-installed-codesynapt-package>
import { existsSync } from 'fs'
import { createRequire } from 'module'
import path from 'path'

const require = createRequire(import.meta.url)
const pkg = process.argv[2]
if (!pkg) { console.error('usage: ci-install-smoke.mjs <node_modules/codesynapt>'); process.exit(2) }

const fail = []
const tspPath = path.join(pkg, 'packages/core/lib/symbol-parser-treesitter.cjs')
let tsp
try { tsp = require(tspPath) } catch (e) { console.error('cannot load parser from install: ' + e.message); process.exit(1) }

// 1) the grammar wasm files must resolve from the INSTALLED layout (hoisted).
for (const g of ['python', 'java', 'c_sharp']) {
  if (!existsSync(tsp.wasmPath(g))) fail.push(`grammar wasm not found in install: ${g} (${tsp.wasmPath(g)})`)
}

// 2) and the parser must actually parse — symbols extracted, not silently empty.
const cases = {
  py: 'def helper(x):\n    return x + 1\n',
  java: 'class B { int helper(int x){ return x + 1; } }\n',
  cs: 'class B { int Helper(int x){ return x + 1; } }\n',
}
for (const [ext, src] of Object.entries(cases)) {
  const p = tsp.makeParser(ext)
  if (!p) { fail.push(`no parser registered for .${ext}`); continue }
  try {
    const syms = await p.extractSymbolsAsync(src, 'f.' + ext)
    const real = (syms || []).filter((s) => s.kind !== 'module')
    if (real.length < 1) fail.push(`.${ext}: parser loaded but extracted 0 symbols (Layer-2 dead)`)
  } catch (e) { fail.push(`.${ext}: parse threw — ${e.message}`) }
}

// 3) the python runtime tracer must ship (it is spawned at runtime).
if (!existsSync(path.join(pkg, 'packages/core/lib/pytracer.py'))) fail.push('pytracer.py missing from install')

if (fail.length) {
  console.error('❌ INSTALL SMOKE FAILED:\n  - ' + fail.join('\n  - '))
  process.exit(1)
}
console.log('✅ install smoke OK — py/java/c# Layer-2 alive in the installed tarball, pytracer shipped')
