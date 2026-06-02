import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8')

// The CSP pins a sha256 of the inline <script type="importmap">. If the
// importmap is edited (e.g. a vendor entry added) without recomputing the hash,
// the browser silently blocks the importmap → `import 'three'` fails → blank
// app. This guard fails the build instead of letting that regression ship.
describe('CSP importmap hash integrity', () => {
  it('the inline importmap matches the sha256 pinned in the CSP', () => {
    const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)
    expect(m, 'inline importmap <script> not found').toBeTruthy()
    const hash = createHash('sha256').update(m[1], 'utf8').digest('base64')
    const cspHashes = [...html.matchAll(/sha256-([A-Za-z0-9+/=]+)/g)].map((x) => x[1])
    expect(cspHashes, 'no sha256- hash in the CSP').not.toHaveLength(0)
    expect(
      cspHashes,
      `importmap sha256 is ${hash} but the CSP pins ${cspHashes.join(', ')} — recompute the CSP hash after editing the importmap`,
    ).toContain(hash)
  })
})
