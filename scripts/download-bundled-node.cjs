// Downloads Node 22 LTS Windows x64 binary into build/bundled-node/
// so electron-builder can bundle it into the NSIS installer.
//
// Run before `npm run dist:win` if you want the offline installer
// option to include a bundled Node. Skipped otherwise — the installer
// just relies on the user's system Node.
//
// Usage: node scripts/download-bundled-node.cjs
const fs = require('fs')
const path = require('path')
const https = require('https')

const NODE_VERSION = 'v22.11.0'
const URL = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`
const OUT_DIR = path.resolve(__dirname, '..', 'build', 'bundled-node')
const OUT_FILE = path.join(OUT_DIR, 'node.exe')

if (fs.existsSync(OUT_FILE)) {
  const size = fs.statSync(OUT_FILE).size
  if (size > 50 * 1024 * 1024) {
    console.log(`[bundled-node] already present (${(size/1024/1024).toFixed(1)} MB) — skipping`)
    process.exit(0)
  }
}

fs.mkdirSync(OUT_DIR, { recursive: true })

console.log(`[bundled-node] downloading ${URL}`)
const file = fs.createWriteStream(OUT_FILE)
function fetch(url) {
  https.get(url, (res) => {
    if (res.statusCode === 301 || res.statusCode === 302) {
      file.close()
      fs.unlinkSync(OUT_FILE)
      return fetch(res.headers.location)
    }
    if (res.statusCode !== 200) {
      console.error(`[bundled-node] HTTP ${res.statusCode}`)
      process.exit(1)
    }
    res.pipe(file)
    file.on('finish', () => {
      file.close()
      const size = fs.statSync(OUT_FILE).size
      console.log(`[bundled-node] downloaded ${(size/1024/1024).toFixed(1)} MB → ${OUT_FILE}`)
    })
  }).on('error', (e) => {
    console.error(`[bundled-node] error: ${e.message}`)
    fs.unlinkSync(OUT_FILE)
    process.exit(1)
  })
}
fetch(URL)
