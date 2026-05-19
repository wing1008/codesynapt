// Headless smoke test: build a small project tree, run the scanner against it,
// and dump the graph. Verifies that imports across JS/TS/Python/CSS/HTML are
// correctly resolved to actual files in the tree.

import fs from 'fs'
import path from 'path'
import os from 'os'
import { Scanner } from './scanner.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fg3d-test-'))

// Build a tiny mixed-language project
fs.mkdirSync(path.join(tmp, 'src'))
fs.mkdirSync(path.join(tmp, 'src/lib'))
fs.mkdirSync(path.join(tmp, 'src/components'))
fs.mkdirSync(path.join(tmp, 'pipeline'))
fs.mkdirSync(path.join(tmp, 'styles'))

fs.writeFileSync(path.join(tmp, 'src/index.ts'), `
import { foo } from './lib/utils'
import App from './components/App'
import './styles/main'  // resolves to .css? -- this is a styles thing actually
import('./lib/lazy').then(m => m.run())
console.log(foo, App)
`)
fs.writeFileSync(path.join(tmp, 'src/lib/utils.ts'), `export const foo = 1`)
fs.writeFileSync(path.join(tmp, 'src/lib/lazy.ts'), `export const run = () => {}`)
fs.writeFileSync(path.join(tmp, 'src/components/App.tsx'), `
import React from 'react'
import { foo } from '../lib/utils'
export default function App() { return null }
`)
fs.writeFileSync(path.join(tmp, 'src/components/index.tsx'), `export {default} from './App'`)
fs.writeFileSync(path.join(tmp, 'styles/main.css'), `@import "./reset.css";`)
fs.writeFileSync(path.join(tmp, 'styles/reset.css'), `* { margin: 0; }`)

fs.writeFileSync(path.join(tmp, 'pipeline/main.py'), `
from .utils import helper
from .nested.sub import thing
import os
`)
fs.writeFileSync(path.join(tmp, 'pipeline/utils.py'), `def helper(): pass`)
fs.mkdirSync(path.join(tmp, 'pipeline/nested'))
fs.writeFileSync(path.join(tmp, 'pipeline/nested/__init__.py'), ``)
fs.writeFileSync(path.join(tmp, 'pipeline/nested/sub.py'), `def thing(): pass`)

fs.writeFileSync(path.join(tmp, 'index.html'), `
<html><head>
  <link rel="stylesheet" href="styles/main.css">
</head><body>
  <script src="src/index.ts"></script>
</body></html>
`)

// noise: should be ignored
fs.mkdirSync(path.join(tmp, 'node_modules'))
fs.writeFileSync(path.join(tmp, 'node_modules/junk.js'), 'lol')

console.log('test root:', tmp)

const scanner = new Scanner(tmp)
scanner.on('snapshot', (snap) => {
  console.log('\n── FILES ──')
  for (const f of snap.files) {
    console.log(`  ${f.id.padEnd(36)} .${f.ext.padEnd(4)} ${f.loc} LOC`)
  }
  console.log('\n── EDGES ──')
  for (const e of snap.edges) {
    console.log(`  ${e.s.padEnd(36)} ──${e.k.padEnd(8)}──▶ ${e.t}`)
  }
  console.log(`\n${snap.files.length} files, ${snap.edges.length} edges`)
  console.log('\n── EXPECTED EDGES ──')
  const expected = [
    'src/index.ts → src/lib/utils.ts',
    'src/index.ts → src/components/App.tsx',
    'src/index.ts → src/lib/lazy.ts (dynamic)',
    'src/components/App.tsx → src/lib/utils.ts',
    'src/components/index.tsx → src/components/App.tsx',
    'styles/main.css → styles/reset.css',
    'pipeline/main.py → pipeline/utils.py',
    'pipeline/main.py → pipeline/nested/sub.py',
    'index.html → styles/main.css',
    'index.html → src/index.ts',
  ]
  expected.forEach((e) => console.log('  ' + e))

  scanner.stop()
  // Cleanup
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
})

scanner.start()

setTimeout(() => {
  console.error('TIMEOUT: scanner did not emit snapshot within 5s')
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
}, 5000)
