import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Scanner } from '../packages/core/scanner.js'
import fs from 'fs'
import path from 'path'
import os from 'os'

let tmpRoot

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'))
  // tiny mixed project
  fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true })
  fs.writeFileSync(path.join(tmpRoot, 'src/main.ts'), `import { foo } from './foo'\nimport './bar'`)
  fs.writeFileSync(path.join(tmpRoot, 'src/foo.ts'), `export const foo = 1`)
  fs.writeFileSync(path.join(tmpRoot, 'src/bar.ts'), `export const bar = 2`)
  fs.writeFileSync(path.join(tmpRoot, '.env'), `STRIPE_KEY=sk_test_xxx\nDATABASE_URL=postgres://x`)
  fs.writeFileSync(path.join(tmpRoot, 'src/db.ts'), `const k = process.env.STRIPE_KEY\nconst u = process.env.NEW_UNDECLARED`)
})

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
})

async function scanOnce(root) {
  const s = new Scanner(root)
  const snap = await new Promise((resolve) => { s.once('snapshot', resolve); s.start() })
  try { s.stop() } catch {}
  return { scanner: s, snap }
}

describe('Scanner — initial scan', () => {
  it('tracks .ts files', async () => {
    const { snap } = await scanOnce(tmpRoot)
    const ids = snap.files.map((f) => f.id).sort()
    expect(ids).toContain('src/main.ts')
    expect(ids).toContain('src/foo.ts')
  })

  it('builds import edges', async () => {
    const { snap } = await scanOnce(tmpRoot)
    const edge = snap.edges.find((e) => e.s === 'src/main.ts' && e.t === 'src/foo.ts')
    expect(edge).toBeDefined()
  })

  it('indexes .env files', async () => {
    const { scanner } = await scanOnce(tmpRoot)
    expect(scanner.envFiles).toBeDefined()
    expect(scanner.envFiles.length).toBeGreaterThan(0)
    const env = scanner.envFiles[0]
    expect(env.keys).toContain('STRIPE_KEY')
    expect(env.keys).toContain('DATABASE_URL')
  })

  it('records env usage in files', async () => {
    const { scanner } = await scanOnce(tmpRoot)
    const dbFile = scanner.files.get('src/db.ts')
    expect(dbFile.envUsage).toContain('STRIPE_KEY')
    expect(dbFile.envUsage).toContain('NEW_UNDECLARED')
  })
})

describe('Scanner — vendor detection (P1·2)', () => {
  let vendorRoot

  beforeAll(() => {
    vendorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-vendor-'))
    // Root manifest
    fs.writeFileSync(path.join(vendorRoot, 'package.json'), JSON.stringify({ name: 'myapp' }))
    // Vendored sub-project with its own manifest + LICENSE
    fs.mkdirSync(path.join(vendorRoot, 'vendor/libfoo'), { recursive: true })
    fs.writeFileSync(path.join(vendorRoot, 'vendor/libfoo/package.json'), JSON.stringify({ name: 'libfoo' }))
    fs.writeFileSync(path.join(vendorRoot, 'vendor/libfoo/LICENSE'), 'MIT')
    fs.writeFileSync(path.join(vendorRoot, 'vendor/libfoo/index.js'), 'module.exports = {}')
  })
  afterAll(() => { try { fs.rmSync(vendorRoot, { recursive: true, force: true }) } catch {} })

  it('flags vendor folder with high confidence', async () => {
    const { scanner } = await scanOnce(vendorRoot)
    expect(scanner.vendorCandidates).toBeDefined()
    const v = scanner.vendorCandidates.find((c) => c.path === 'vendor/libfoo' || c.path === 'vendor')
    expect(v).toBeDefined()
    expect(v.confidence).toBeGreaterThanOrEqual(0.3)
  })
})

describe('Scanner — IGNORE_DIRS + .fg3dignore', () => {
  let ignoreRoot

  beforeAll(() => {
    ignoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ignore-'))
    fs.mkdirSync(path.join(ignoreRoot, 'src'))
    fs.writeFileSync(path.join(ignoreRoot, 'src/a.ts'), 'export const a = 1')

    // venv must be auto-ignored
    fs.mkdirSync(path.join(ignoreRoot, '.venv-test/lib'), { recursive: true })
    fs.writeFileSync(path.join(ignoreRoot, '.venv-test/lib/pkg.py'), 'x = 1')

    // .obsidian must be auto-ignored
    fs.mkdirSync(path.join(ignoreRoot, '.obsidian'))
    fs.writeFileSync(path.join(ignoreRoot, '.obsidian/theme.css'), 'body{}')

    // .fg3dignore: hide tools/
    fs.mkdirSync(path.join(ignoreRoot, 'tools'))
    fs.writeFileSync(path.join(ignoreRoot, 'tools/helper.ts'), 'export const h = 1')
    fs.writeFileSync(path.join(ignoreRoot, '.fg3dignore'), 'tools/\n')
  })
  afterAll(() => { try { fs.rmSync(ignoreRoot, { recursive: true, force: true }) } catch {} })

  it('auto-ignores .venv-*', async () => {
    const { snap } = await scanOnce(ignoreRoot)
    expect(snap.files.some((f) => f.id.startsWith('.venv-test/'))).toBe(false)
  })

  it('auto-ignores .obsidian', async () => {
    const { snap } = await scanOnce(ignoreRoot)
    expect(snap.files.some((f) => f.id.startsWith('.obsidian/'))).toBe(false)
  })

  it('honours .fg3dignore', async () => {
    const { snap } = await scanOnce(ignoreRoot)
    expect(snap.files.some((f) => f.id.startsWith('tools/'))).toBe(false)
    // tracked file still present
    expect(snap.files.some((f) => f.id === 'src/a.ts')).toBe(true)
  })
})
