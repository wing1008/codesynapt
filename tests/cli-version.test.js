import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'
import { createRequire } from 'module'

// insp-004: `cs --version` / `-v` / `version` printed "unknown command" + full
// help. Now prints the package version.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const bin = path.resolve(__dirname, '../packages/core/bin/codesynapt.cjs')
const expected = require('../package.json').version

describe('cs --version', () => {
  for (const flag of ['--version', '-v', 'version']) {
    it(`cs ${flag} prints the package version`, () => {
      const out = execFileSync(process.execPath, [bin, flag], { encoding: 'utf8' }).trim()
      expect(out).toBe(expected)
    })
  }
})
