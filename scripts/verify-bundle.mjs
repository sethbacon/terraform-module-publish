/**
 * Refuses to certify a dist/ that will not load on a runner.
 *
 * WHY THIS EXISTS. dist/ is committed, minified and never read by a human, and
 * nothing else in this repo looks at it in a way that could notice it is dead:
 *
 *  - `npm run lint` and `npm test` read src/, never the bundle;
 *  - both dist gates compare dist/ to a fresh build OF ITSELF, so a broken
 *    bundle that has been committed matches its own rebuild byte-for-byte and
 *    passes;
 *  - the behaviour harness does execute dist/index.js, but only after someone
 *    has already committed the broken bundle, and only down the paths it drives.
 *
 * WHAT CHANGED WITH THE BUNDLER. Under `@vercel/ncc` the failure mode was a
 * quiet one: webpack planted a `webpackMissingModule` stub where a require it
 * could not resolve should have been, and ncc 0.44.1 exited 0 around it. That
 * marker is webpack's, and esbuild never emits it — a guard still keyed on the
 * string would go green forever while checking nothing.
 *
 * esbuild fails loudly on a top-level import it cannot resolve — `error: Could
 * not resolve "x"`, exit 1, nothing written. It does NOT fail on the three
 * shapes below. Every one was reproduced against esbuild 0.28.2 in this
 * repository before this guard was written, and every one exits 0 with no error
 * and no warning:
 *
 *  1. `--external:undici` on the build line. Exit 0, `require("undici")` in the
 *     output. Loaded away from a node_modules, it dies MODULE_NOT_FOUND on the
 *     first line. `--packages=external` is the same defect wholesale.
 *  2. `require("not-installed")` inside a try/catch — the optional-dependency
 *     idiom. esbuild does not resolve it, does not error, and does not even
 *     WARN; the literal is copied straight through. This one is the worst of
 *     the three and the reason the guard cannot be "just load the bundle and
 *     see": measured here, that bundle LOADS CLEANLY and exits 0, because the
 *     catch swallows the MODULE_NOT_FOUND and the dependency is simply absent.
 *     It fails later, wherever the missing thing is first used — or never, and
 *     silently does less than it claims.
 *  3. `require(someExpression)`. For a CJS/node build esbuild leaves the call
 *     alone, silently, because `require` is a real global there. Dies
 *     MODULE_NOT_FOUND when the call is reached.
 *
 * The invariant this enforces, therefore: NOTHING in an emitted bundle resolves
 * a module at run time except a Node builtin. A literal specifier that is not a
 * builtin gets looked up in a node_modules that is not shipped beside dist/; a
 * computed one is a resolution esbuild could not perform either. Both land
 * exactly where the old webpack stub landed — MODULE_NOT_FOUND, before the
 * action's first line.
 *
 * WHY THIS READS THE BUNDLE AS CODE RATHER THAN AS TEXT. A plain text scan for
 * `require(` / `import(` cannot tell a call site from the same characters
 * inside a string, and this bundle contains a message that reads "Not waiting
 * for the import (wait-for-publish: false)" — English prose that a text scan
 * reports as a computed `import()`. The wrong fix is to reword the message: it
 * is user-visible, and it would leave the next maintainer whose sentence
 * happens to contain "import (" staring at a red build with every incentive to
 * delete this file. So the scan below first classifies every offset as code or
 * as string/template/comment/regex, and only call sites in CODE are judged.
 *
 * That classifier is a lexer, and a lexer that loses sync would hide a real
 * `require` inside what it wrongly believes is a string — failing OPEN, which
 * for a guard is worse than useless. So it is not trusted on its own word: it
 * carries integrity invariants that a desynced scan cannot satisfy (it must end
 * outside every literal, with balanced braces and no unterminated template
 * substitution), and if any of them fails, this script says so and judges every
 * call site as if it were code rather than believing the mask.
 *
 * The two structural checks are bundler-independent and stay as they were: a
 * build that emitted nothing, and an entrypoint action.yml declares that this
 * build did not produce.
 *
 * NOT COVERED HERE, deliberately: esbuild does not type-check, where ncc's
 * ts-loader did and failed the build on a type error. That gap is closed in the
 * build script itself (`npm run build` runs `npm run lint`, i.e. `tsc
 * --noEmit`, first), because it is a property of the SOURCE and cannot be
 * recovered by reading the minified output.
 *
 * Run: node scripts/verify-bundle.mjs [dist-dir] [action.yml]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
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

let failures = 0
const fail = (message) => {
  console.error(`::error::${message}`)
  failures++
}

// --- classifying bundle text as code or as literal ---------------------------

const CODE = 0, LINE_COMMENT = 1, BLOCK_COMMENT = 2, SQUOTE = 3, DQUOTE = 4, TEMPLATE = 5, REGEX = 6
const STATE_NAMES = ['code', 'a line comment', 'a block comment', "a '' string", 'a "" string', 'a template literal', 'a regex literal']

// Whether a `/` here opens a regex literal or is a division sign — the one
// genuinely ambiguous character in JavaScript, decided as every hand-written
// scanner decides it: by what the preceding token was. After a value (an
// identifier, a number, `)`, `]`, a string) it divides; after an operator,
// a separator, or one of these keywords, it opens a regex.
const REGEX_OK_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', ''])
const REGEX_OK_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'do', 'else', 'case', 'yield', 'await'])
const isIdentChar = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c)

/**
 * A byte mask over `text` — 1 where the offset is code, 0 where it is inside a
 * string, template, comment or regex literal — plus the integrity readings that
 * say whether the scan stayed in sync. See the header: the mask is only
 * believed when `intact` is true.
 */
function classifyCode(text) {
  const mask = new Uint8Array(text.length)
  let state = CODE
  let braces = 0
  const templates = [] // brace depth each open `${` returns to
  let lastChar = ''
  let word = ''
  let i = 0

  while (i < text.length) {
    const c = text[i]

    if (state === CODE) {
      mask[i] = 1
      if (c === '/' && text[i + 1] === '/') { state = LINE_COMMENT; i += 2; continue }
      if (c === '/' && text[i + 1] === '*') { state = BLOCK_COMMENT; i += 2; continue }
      if (c === '"') { state = DQUOTE; i++; continue }
      if (c === "'") { state = SQUOTE; i++; continue }
      if (c === '`') { state = TEMPLATE; i++; continue }
      if (c === '/' && (isIdentChar(lastChar) ? REGEX_OK_AFTER_WORD.has(word) : REGEX_OK_AFTER.has(lastChar))) {
        state = REGEX
        i++
        continue
      }
      if (c === '{') braces++
      else if (c === '}') {
        braces--
        if (templates.length > 0 && templates[templates.length - 1] === braces) {
          templates.pop()
          state = TEMPLATE
          i++
          continue
        }
      }
      if (!/\s/.test(c)) {
        word = isIdentChar(c) ? (isIdentChar(lastChar) ? word + c : c) : ''
        lastChar = c
      }
      i++
      continue
    }

    // Leaving any literal, the next `/` must read as division: a literal is a
    // value, exactly like the identifier `x` would be.
    const backToCode = () => { state = CODE; lastChar = 'x'; word = '' }

    if (state === LINE_COMMENT) {
      if (c === '\n') { state = CODE; lastChar = ';'; word = '' }
      i++
      continue
    }
    if (state === BLOCK_COMMENT) {
      if (c === '*' && text[i + 1] === '/') { state = CODE; lastChar = ';'; word = ''; i += 2; continue }
      i++
      continue
    }
    if (state === SQUOTE || state === DQUOTE) {
      if (c === '\\') { i += 2; continue }
      if (c === (state === SQUOTE ? "'" : '"')) { backToCode(); i++; continue }
      i++
      continue
    }
    if (state === REGEX) {
      if (c === '\\') { i += 2; continue }
      // A character class may contain an unescaped `/`, which does not close.
      if (c === '[') { i++; while (i < text.length && text[i] !== ']') { if (text[i] === '\\') i++; i++ } ; i++; continue }
      if (c === '/') { backToCode(); i++; continue }
      // A regex literal cannot span a line: reaching one means this `/` was
      // division after all. Resync rather than swallowing the rest of the file.
      if (c === '\n') { backToCode(); continue }
      i++
      continue
    }
    if (state === TEMPLATE) {
      if (c === '\\') { i += 2; continue }
      if (c === '`') { backToCode(); i++; continue }
      if (c === '$' && text[i + 1] === '{') { templates.push(braces); braces++; state = CODE; lastChar = '{'; word = ''; i += 2; continue }
      i++
      continue
    }
  }

  return {
    mask,
    // A scan that stayed in sync ends outside every literal, with every brace it
    // opened closed and no template substitution left hanging. A scan that lost
    // sync — swallowing code as a string, or code's braces as text — essentially
    // cannot land on all three.
    intact: state === CODE && braces === 0 && templates.length === 0,
    endedIn: STATE_NAMES[state],
    braces,
    openTemplates: templates.length,
  }
}

/**
 * The specifier of every `require(...)` and dynamic `import(...)` call site in
 * the CODE of a bundle — `null` where the call carries an expression rather
 * than a literal.
 *
 * The lookbehind rejects `foo.require(` and identifiers merely ending in
 * `require`, which is what minified output is full of. Each hit is then
 * classified by the character following the paren: a quote means esbuild
 * resolved the specifier and wrote it out, anything else (including a template
 * literal) means the call survived with a run-time resolution in it.
 */
function moduleResolutions(text, mask) {
  const found = []
  let ignored = 0
  for (const re of [/(?<![.\w$])require\s*\(\s*/g, /(?<![.\w$])import\s*\(\s*/g]) {
    let m
    while ((m = re.exec(text)) !== null) {
      if (!mask[m.index]) { ignored++; continue } // inside a string/comment: prose, not a call
      const quote = text[re.lastIndex]
      if (quote !== '"' && quote !== "'") {
        found.push(null)
        continue
      }
      const end = text.indexOf(quote, re.lastIndex + 1)
      if (end === -1) continue // unterminated: not a call site we can read
      found.push(text.slice(re.lastIndex + 1, end))
    }
  }
  return { found, ignored }
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

// Bidirectional: the resolution scan below proves the bundles that EXIST are
// sound, which says nothing about one that was never emitted. action.yml is the
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

let resolved = 0
let inLiterals = 0
for (const file of bundles) {
  const text = readFileSync(file, 'utf8')
  const classified = classifyCode(text)

  if (!classified.intact) {
    // Fail closed. Everything below is judged against a mask this scan has just
    // said it does not trust, so it is discarded and every call site counts.
    fail(
      `Could not read ${relative(root, file)} as JavaScript: the scan ended inside ` +
        `${classified.endedIn}, with ${classified.braces} unbalanced brace(s) and ` +
        `${classified.openTemplates} unclosed template substitution(s). A scan that has lost sync ` +
        `would hide a run-time require() inside what it mistook for a string, so its judgement is ` +
        `discarded here and every call site below is treated as code. Fix this script rather than ` +
        `the bundle if the checks that follow are false alarms.`,
    )
    classified.mask.fill(1)
  }

  const { found: resolutions, ignored } = moduleResolutions(text, classified.mask)
  resolved += resolutions.length
  inLiterals += ignored

  const external = [...new Set(resolutions.filter((s) => s !== null && !isBuiltin(s)))]
  if (external.length > 0) {
    fail(
      `${relative(root, file)} resolves ${external.map((s) => `'${s}'`).join(', ')} at run time. ` +
        `Those are not Node builtins, so the runner looks for them in a node_modules beside ` +
        `dist/ — which does not exist — and the action dies with MODULE_NOT_FOUND before its ` +
        `first line. Either the build line excluded them (--external / --packages=external), or ` +
        `they are required inside a try/catch, which esbuild copies through without resolving ` +
        `and without warning. Bundle them or vendor them; do NOT commit this bundle.`,
    )
  }

  const dynamic = resolutions.filter((s) => s === null).length
  if (dynamic > 0) {
    fail(
      `${relative(root, file)} contains ${dynamic} ${dynamic === 1 ? 'call' : 'calls'} ` +
        `to require()/import() with a computed specifier. esbuild resolved nothing there and said ` +
        `nothing about it — for a CJS/node build it leaves such a call exactly as written — so ` +
        `whatever it names is looked up at run time in a node_modules that is not shipped. ` +
        `Do NOT commit this bundle.`,
    )
  }
}

if (failures > 0) {
  console.error(`\n${failures} bundle check(s) failed — refusing to certify dist/.`)
  process.exit(1)
}

console.log(
  `Bundle verification passed: ${bundles.length} emitted bundle(s), ` +
    `${entrypoints.length} declared entrypoint(s), ${resolved} run-time module resolution(s) in ` +
    `code, all of them Node builtins` +
    `${inLiterals > 0 ? ` (${inLiterals} further match(es) were inside string or comment text, not call sites)` : ''}.`,
)
