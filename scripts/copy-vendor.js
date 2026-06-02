// Copy three.module.js from node_modules into public/vendor/
// so it can be loaded via a relative path in both browser and Electron modes.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const src = path.join(ROOT, 'node_modules/three/build/three.module.js')
const dst = path.join(ROOT, 'public/vendor/three.module.js')

if (!fs.existsSync(src)) {
  console.warn('[copy-vendor] three not installed yet — skipping')
  process.exit(0)
}

fs.mkdirSync(path.dirname(dst), { recursive: true })
fs.copyFileSync(src, dst)
const size = (fs.statSync(dst).size / 1024).toFixed(0)
console.log(`[copy-vendor] three.module.js → public/vendor/ (${size} KB)`)
