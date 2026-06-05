// Downloads Node 22 LTS Windows x64 binary into build/bundled-node/
// so electron-builder can bundle it into the NSIS installer.
//
// Run before `npm run dist:win` if you want the offline installer
// option to include a bundled Node. Skipped otherwise — the installer
// just relies on the user's system Node.
//
// Usage: node scripts/download-bundled-node.cjs
//
// OFFLINE BY DEFAULT (hard rule — see CLAUDE.md "No network calls").
// This is a BUILD-TIME-ONLY helper: it must only ever fetch from
// nodejs.org when invoked DIRECTLY as a script (i.e. as part of
// `npm run dist:win`). It must never perform a network call merely
// because some other module `require()`d it. Previously the download
// ran at top level on import, so requiring this file from anywhere
// (a test, a tool, an accidental import) would immediately hit the
// network and even call process.exit() on failure. The work is now
// wrapped in main() and gated on `require.main === module`.
const fs = require('fs')
const path = require('path')
const https = require('https')
const crypto = require('crypto')

const NODE_VERSION = 'v22.11.0'
const URL = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`
// Pinned SHA-256 from the official https://nodejs.org/dist/<ver>/SHASUMS256.txt
// (line `win-x64/node.exe`). This binary is bundled into the NSIS installer
// and copied onto the user's machine, so we MUST verify integrity — never
// trust a network download unchecked. Update this whenever NODE_VERSION bumps.
const EXPECTED_SHA256 = '7447c4ece014aa41fb2ff866c993c708e5a8213a00913cc2ac5049ea3ffc230d'
const OUT_DIR = path.resolve(__dirname, '..', 'build', 'bundled-node')
const OUT_FILE = path.join(OUT_DIR, 'node.exe')

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function verifyOrDie(file) {
  const actual = sha256(file)
  if (actual !== EXPECTED_SHA256) {
    console.error(`[bundled-node] CHECKSUM MISMATCH for ${file}`)
    console.error(`[bundled-node]   expected ${EXPECTED_SHA256}`)
    console.error(`[bundled-node]   actual   ${actual}`)
    try { fs.unlinkSync(file) } catch {}
    process.exit(1)
  }
  console.log(`[bundled-node] sha256 verified: ${actual}`)
}

function download(url, file) {
  https.get(url, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      file.close()
      fs.unlinkSync(OUT_FILE)
      const next = fs.createWriteStream(OUT_FILE)
      return download(res.headers.location, next)
    }
    if (res.statusCode !== 200) {
      console.error(`[bundled-node] HTTP ${res.statusCode}`)
      process.exit(1)
    }
    res.pipe(file)
    file.on('finish', () => {
      file.close(() => {
        const size = fs.statSync(OUT_FILE).size
        console.log(`[bundled-node] downloaded ${(size/1024/1024).toFixed(1)} MB → ${OUT_FILE}`)
        // Integrity gate: reject any tampered/corrupted download before it
        // can be bundled into the installer.
        verifyOrDie(OUT_FILE)
      })
    })
  }).on('error', (e) => {
    console.error(`[bundled-node] error: ${e.message}`)
    try { fs.unlinkSync(OUT_FILE) } catch {}
    process.exit(1)
  })
}

function main() {
  if (fs.existsSync(OUT_FILE)) {
    const size = fs.statSync(OUT_FILE).size
    if (size > 50 * 1024 * 1024) {
      // Already downloaded — still verify integrity before trusting/skipping.
      verifyOrDie(OUT_FILE)
      console.log(`[bundled-node] already present (${(size/1024/1024).toFixed(1)} MB) — skipping`)
      process.exit(0)
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })

  console.log(`[bundled-node] downloading ${URL}`)
  const file = fs.createWriteStream(OUT_FILE)
  download(URL, file)
}

// Only fetch when run directly (`node scripts/download-bundled-node.cjs`,
// i.e. the dist:win build step). Importing this module is a no-op.
if (require.main === module) {
  main()
}

module.exports = { main, NODE_VERSION, URL, OUT_FILE }
