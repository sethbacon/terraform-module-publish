import { defineConfig } from 'vitest/config'

// Nothing here measured coverage. src/index.ts — the masking order, the input
// validation, the registry-type branch — had no test at all, and src/http.ts,
// the transport where the bearer credential is attached, was the single file
// with none either. `include` covers all of src/ rather than only the files a
// test happens to import, so a new module nothing exercises lowers the number
// instead of being invisible.
//
// Thresholds sit just under the current figures: they catch a regression rather
// than describing today, and they only ever move up.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { statements: 94, branches: 88, functions: 94, lines: 94 },
    },
  },
})
