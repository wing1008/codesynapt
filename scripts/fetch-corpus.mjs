// Fetch the multi-language measurement corpus (scripts/corpus-manifest.json),
// pinned to the recorded SHAs, so anyone can reproduce the Layer-2 precision/
// recall numbers in docs/measurements/2026-06-14-layer-measurement.md.
//
// Usage:
//   node scripts/fetch-corpus.mjs [targetDir]      # default: <os tmp>/corpus
// Then, e.g.:
//   node scripts/_precision_pos.mjs <targetDir>/cpp-json --lang=cpp
//
// Notes: external repos are NOT vendored (size/license) — only their URL+SHA are
// recorded here and cloned on demand. A shallow clone may not contain the exact
// pinned SHA; in that case it falls back to HEAD and warns (numbers may drift
// slightly). For an exact reproduction, deepen the clone or check out the SHA.
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'corpus-manifest.json'), 'utf8'))
const dir = process.argv[2] || path.join(os.tmpdir(), 'corpus')
fs.mkdirSync(dir, { recursive: true })
console.log(`corpus → ${dir} (${manifest.repos.length} repos, measured ${manifest.measuredAt})\n`)

let ok = 0, skipped = 0, failed = 0
for (const r of manifest.repos) {
  const dest = path.join(dir, r.name)
  if (fs.existsSync(dest)) { console.log(`skip  ${r.name} (exists)`); skipped++; continue }
  console.log(`clone ${r.name.padEnd(16)} ← ${r.url}`)
  try {
    execFileSync('git', ['clone', '--depth', '50', '--quiet', r.url, dest], { stdio: 'inherit' })
    if (r.sha) {
      try { execFileSync('git', ['-C', dest, 'checkout', '--quiet', r.sha], { stdio: 'ignore' }) }
      catch { console.log(`  ⚠ pinned ${r.sha} not in shallow clone — using HEAD (numbers may drift)`) }
    }
    ok++
  } catch (e) { console.log(`  ✗ clone failed: ${e.message}`); failed++ }
}
console.log(`\ndone: ${ok} cloned, ${skipped} skipped, ${failed} failed → ${dir}`)
console.log(`reproduce: node scripts/_precision_pos.mjs ${path.join(dir, '<name>')} --lang=<lang>`)
