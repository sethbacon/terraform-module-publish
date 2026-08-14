/**
 * Fails the build when the bundler could not resolve a module and quietly
 * planted a throwing stub where the `require` should have been.
 *
 * WHY THIS EXISTS. `@vercel/ncc` 0.38.4 failed loudly when it could not bundle
 * a dependency. 0.44.1 exits 0, emits a `webpackMissingModule` stub in its
 * place, and writes a bundle that throws MODULE_NOT_FOUND before the first line
 * of the action runs. Nothing else in this repo notices:
 *
 *  - `npm run lint` and `npm test` read src/, never the bundle;
 *  - both dist gates compare dist/ to a fresh build OF ITSELF, so a stub that
 *    has been committed matches its own rebuild byte-for-byte and passes;
 *  - the behaviour harness does execute dist/index.js — but only after someone
 *    has already committed the stub, and only for the entrypoints it drives.
 *
 * Observed, not hypothetical. `@actions/core` 3.x is ESM-only (`"type":
 * "module"` with an import-only `exports` map), so the CJS build cannot resolve
 * it. On that bump `npm run build` exits 0 and the bundle it writes throws
 * MODULE_NOT_FOUND on require — the whole 67-check behaviour harness reddens
 * against it, which is the point: nothing before this ran the bundle at build
 * time, so the stub only surfaced after it had been committed.
 *
 * This runs as the last step of `npm run build`, so a stub bundle cannot be
 * produced at all — not in CI, not on a maintainer's machine, and not by any
 * future automation that rebuilds dist/ on a dependency bump. That last case is
 * the point: the mechanical fix for a stale bundle is "rebuild and commit", and
 * without this guard that fix cheerfully ships a dead action.
 *
 * Run: node scripts/verify-bundle.mjs [dist-dir] [action.yml]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const distDir = process.argv[2] ?? join(root, 'dist')
const actionYml = process.argv[3] ?? join(root, 'action.yml')
// action.yml's `main:`/`post:` paths are relative to the action.yml that
// declares them, not to this script. Resolving them against the script's own
// parent instead works only while both sit in the same checkout, and makes the
// entrypoint check silently unsatisfiable — every path "missing" — the moment
// this is pointed at a tree somewhere else.
const actionRoot = dirname(actionYml)

/**
 * The marker webpack (and therefore ncc) emits for a require it could not
 * resolve. Keyed on the function name rather than on the "Cannot find module"
 * text, because that sentence also appears in legitimately bundled code —
 * Node's own loader messages get inlined by more than one dependency.
 */
const STUB_MARKER = 'webpackMissingModule'

let failures = 0
const fail = (message) => {
  console.error(`::error::${message}`)
  failures++
}

/** Every .js the build emitted, recursively. */
function emittedBundles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...emittedBundles(p))
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(p)
  }
  return out
}

/**
 * The entrypoints action.yml declares, read with a block-YAML subset reader
 * rather than a YAML dependency. This runs inside `npm run build`, and a guard
 * that needs its own dependency tree to answer is one more thing that can be
 * missing on the machine the bundle is built on.
 */
function declaredEntrypoints(file) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex((l) => /^runs:\s*$/.test(l))
  if (start === -1) return []
  const found = []
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break // dedented back out of the runs: block
    const m = /^\s+(main|pre|post):\s*(\S+)\s*$/.exec(line)
    if (m) found.push(m[2])
  }
  return found
}

const bundles = existsSync(distDir) ? emittedBundles(distDir) : []

// An empty universe has to fail rather than pass vacuously. "No bundles found"
// is exactly what a build that emitted nothing looks like, and every check
// below is trivially satisfied by it.
if (bundles.length === 0) {
  fail(`No bundles found under ${relative(root, distDir) || distDir}. The build emitted nothing to verify.`)
}

// Bidirectional: the stub scan below proves the bundles that EXIST are sound,
// which says nothing about one that was never emitted. action.yml is the
// contract for what has to be there, so it is what the build is measured
// against — a `post:` script that silently stopped being produced would
// otherwise surface only as a consumer's job failing at the end of every run.
const entrypoints = declaredEntrypoints(actionYml)
if (entrypoints.length === 0) {
  fail(
    `${relative(root, actionYml)} declares no runs.main, so nothing pins what this build has to ` +
      `produce. Refusing to certify a bundle against an empty contract.`,
  )
}
for (const entrypoint of entrypoints) {
  if (!existsSync(join(actionRoot, entrypoint))) {
    fail(`action.yml runs '${entrypoint}', which this build did not produce.`)
  }
}

for (const file of bundles) {
  const text = readFileSync(file, 'utf8')
  if (!text.includes(STUB_MARKER)) continue
  const missing = [
    ...new Set(Array.from(text.matchAll(/Cannot find module '([^']+)'/g), (m) => m[1])),
  ]
  fail(
    `${relative(root, file)} contains a ${STUB_MARKER} stub` +
      `${missing.length ? ` for ${missing.map((m) => `'${m}'`).join(', ')}` : ''}. ` +
      `The bundler could not resolve that import and emitted a throwing placeholder instead of ` +
      `failing, so this bundle raises MODULE_NOT_FOUND before the action runs. A dependency that ` +
      `has gone ESM-only is the usual cause. Do NOT commit this bundle.`,
  )
}

if (failures > 0) {
  console.error(`\n${failures} bundle check(s) failed — refusing to certify dist/.`)
  process.exit(1)
}

console.log(
  `Bundle verification passed: ${bundles.length} emitted bundle(s), ` +
    `${entrypoints.length} declared entrypoint(s), no unresolved-module stubs.`,
)
