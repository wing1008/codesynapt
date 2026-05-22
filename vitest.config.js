import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{js,mjs,cjs,ts}'],
    exclude: ['node_modules', 'public/vendor', 'tests/fixtures/**'],
    testTimeout: 10_000,
    // ESM + CJS interop: scanner.js is ESM, lib/control-server.cjs is CJS.
    // vitest handles both via dynamic import.
  },
})
