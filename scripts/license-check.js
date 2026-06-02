#!/usr/bin/env node
// License compliance check.
// Walks node_modules, reads each package's license field, and fails
// if any dependency uses a license outside the allowed list.
//
// Run via `npm run license-check`.
//
// Allowed licenses are the standard permissive set. GPL, AGPL, LGPL,
// CC-BY-NC, and other copyleft / restrictive licenses are blocked
// to avoid surprises in a project intended for MIT distribution.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const MODULES = path.join(ROOT, 'node_modules')

const ALLOWED = new Set([
  'MIT',
  'Apache-2.0',
  'BSD',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-3-Clause-Clear',
  'ISC',
  'CC0-1.0',
  '0BSD',
  'Unlicense',
  'WTFPL',
  'Python-2.0',           // some Python-related tools
  'BlueOak-1.0.0',
  'Zlib',
])

// Some packages bundle both — we accept if any constituent is allowed.
function isAllowedLicense(raw) {
  if (!raw) return false
  if (typeof raw === 'object') raw = raw.type || raw.license || ''
  if (Array.isArray(raw)) return raw.some(isAllowedLicense)
  const norm = String(raw).trim()
  if (ALLOWED.has(norm)) return true
  // Handle SPDX expressions like "(MIT OR Apache-2.0)"
  const stripped = norm.replace(/^\(|\)$/g, '')
  if (stripped.includes(' OR ')) {
    return stripped.split(' OR ').some((p) => ALLOWED.has(p.trim()))
  }
  if (stripped.includes(' AND ')) {
    return stripped.split(' AND ').every((p) => ALLOWED.has(p.trim()))
  }
  return false
}

function walkModules(dir, results = []) {
  if (!fs.existsSync(dir)) return results
  for (const name of fs.readdirSync(dir)) {
    if (name === '.bin' || name === '.cache') continue
    const full = path.join(dir, name)
    let stat
    try { stat = fs.statSync(full) } catch { continue }
    if (!stat.isDirectory()) continue
    if (name.startsWith('@')) {
      // scoped: descend one level
      walkModules(full, results)
    } else {
      const pkgPath = path.join(full, 'package.json')
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
          results.push({
            name: pkg.name,
            version: pkg.version,
            license: pkg.license || pkg.licenses || null,
            path: full,
          })
        } catch { /* skip malformed */ }
      }
      // Recurse into nested node_modules
      const nested = path.join(full, 'node_modules')
      if (fs.existsSync(nested)) walkModules(nested, results)
    }
  }
  return results
}

const all = walkModules(MODULES)
if (all.length === 0) {
  console.log('No node_modules found. Run `npm install` first.')
  process.exit(0)
}

const seen = new Set()
const violations = []
const unknown = []
for (const m of all) {
  const key = `${m.name}@${m.version}`
  if (seen.has(key)) continue
  seen.add(key)
  if (!m.license) { unknown.push(m); continue }
  if (!isAllowedLicense(m.license)) {
    violations.push(m)
  }
}

console.log(`Checked ${seen.size} unique packages.`)
if (unknown.length > 0) {
  console.log(`\n⚠️  ${unknown.length} packages have no license declared:`)
  for (const m of unknown) console.log(`   ${m.name}@${m.version}`)
}
if (violations.length > 0) {
  console.log(`\n❌ ${violations.length} packages with disallowed licenses:`)
  for (const m of violations) {
    const lic = typeof m.license === 'string' ? m.license : JSON.stringify(m.license)
    console.log(`   ${m.name}@${m.version}  →  ${lic}`)
  }
  process.exit(1)
}
console.log('\n✅ All dependencies use permissive licenses.')
