/**
 * Executes the REBUILT, MINIFIED dist/index.js — the artifact consumers actually
 * run — and observes the guards this action promises.
 *
 * WHY THIS EXISTS. `npm test` proves things about src/. The dist staleness gate
 * proves dist/index.js matches a fresh build OF ITSELF, which is not the same
 * claim: a bundler that cannot resolve a dependency can emit a bundle that
 * throws at require time and still rebuild byte-identically, so lint, tests and
 * the staleness gate all stay green while every consumer of
 * `uses: sethbacon/terraform-module-publish@v1` fails before a line of the
 * action runs. `@vercel/ncc` 0.38.4 failed that build loudly; 0.44.1 exits 0 and
 * plants a `webpackMissingModule` stub where the require should be. Nothing in
 * this repo executed the bundle, so nothing would have noticed.
 *
 * HOW IT DRIVES IT. The bundle is a GitHub Action entrypoint, so it is driven
 * the way the runner drives it: INPUT_* env vars, a real $GITHUB_OUTPUT file,
 * and stdout carrying the ::add-mask:: / ::error:: workflow commands. The
 * registry it talks to is a real TLS endpoint that RECORDS what it was sent,
 * because the interesting guards are about requests that must not be issued.
 *
 * TWO RULES THIS FILE FOLLOWS, both learned the hard way:
 *
 *  1. Assertions read STDOUT ONLY, never stdout+stderr. `--minify` puts the
 *     whole program on one line, and on a load-time throw Node echoes that line
 *     to stderr — so a regex over the combined streams matches the SOURCE TEXT
 *     of messages the action never printed, and a dead bundle reports PASS.
 *
 *  2. Every refusal check pairs a POSITIVE observation (the action printed its
 *     refusal) with the negative one (the registry was not contacted). A check
 *     that only asserts "no request arrived" passes trivially on a bundle that
 *     never started, which is precisely the failure this harness exists to
 *     catch.
 *
 * Run: npm run test:dist  [-- path/to/index.js]
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:https'
import { createServer as createHttpServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { fileURLToPath } from 'node:url'

const DIST = process.argv[2] ?? fileURLToPath(new URL('../dist/index.js', import.meta.url))
const ACTION_YML = fileURLToPath(new URL('../action.yml', import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'distproof-'))

// A real TLS endpoint, because the action pins https and refuses an unverified
// peer by design. The throwaway CA is handed to the action through `ca-cert`,
// so trusting a private CA over a live handshake is exercised rather than
// asserted about a config object.
const keyFile = join(work, 'key.pem')
const certFile = join(work, 'cert.pem')
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', keyFile, '-out', certFile, '-days', '1',
  '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
], { stdio: 'ignore' })
const TLS = { key: readFileSync(keyFile), cert: readFileSync(certFile) }
const CA = readFileSync(certFile, 'utf8')

const API_KEY = 'registry-api-key-must-not-be-logged'
const HCP_TOKEN = 'hcp-token-must-not-be-logged'
const MODULE_ID = '11111111-2222-3333-4444-555555555555'

/** The inputs action.yml declares, at their defaults, for a private-registry publish. */
const BASE_INPUTS = {
  'INPUT_REGISTRY-TYPE': 'private',
  'INPUT_NAMESPACE': 'acme',
  'INPUT_NAME': 'vpc',
  'INPUT_PROVIDER': 'aws',
  'INPUT_VERSION': '1.2.3',
  'INPUT_API-KEY': API_KEY,
  'INPUT_CA-CERT': '',
  'INPUT_SKIP-TLS-VERIFY': 'false',
  'INPUT_REGISTRY-ALLOWED-HOSTS': '',
  'INPUT_WAIT-FOR-PUBLISH': 'false',
  'INPUT_TIMEOUT-SECONDS': '5',
}

/**
 * Runs the bundle once, as the runner would.
 *
 * Async `spawn`, never `spawnSync`: the HTTPS endpoints below live in THIS
 * process, and a synchronous spawn blocks the event loop so the server never
 * accepts the connection the action is making. That surfaces as a connect
 * timeout on every check and looks exactly like a refusal, which is a false
 * PASS on the guards and a false FAIL on the happy path.
 */
function runAction(extraEnv) {
  const runnerTemp = mkdtempSync(join(work, 'runner-'))
  const outFile = join(runnerTemp, 'gh_output')
  writeFileSync(outFile, '')
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const env = {
      ...process.env,
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: outFile,
      // The action now HONOURS these, so `...process.env` would otherwise let a
      // developer's own shell proxy decide where every check below sends its
      // requests — and the loopback registries these checks stand up are
      // exactly what such a proxy would refuse. Cleared to a known-empty
      // baseline; the proxy checks set them explicitly through extraEnv.
      HTTPS_PROXY: undefined,
      https_proxy: undefined,
      HTTP_PROXY: undefined,
      http_proxy: undefined,
      NO_PROXY: undefined,
      no_proxy: undefined,
      ...BASE_INPUTS,
      ...extraEnv,
    }
    // An explicit `undefined` UNSETS the variable rather than passing the
    // string "undefined".
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k]
    const child = spawn(process.execPath, [DIST], { env })
    child.stdout.on('data', (d) => (stdout += d))
    // Kept only for diagnostics. A load-time throw dumps the entire minified
    // program here; nothing asserts on it.
    child.stderr.on('data', (d) => (stderr += d.toString().slice(0, 2000)))
    child.on('close', (code) =>
      resolve({ code, stdout, stderr, output: readFileSync(outFile, 'utf8') }),
    )
  })
}

/**
 * A TLS registry that records every request before answering it.
 *
 * The BODY is recorded too, because "the version was created carrying the
 * commit the workflow ran on" is a claim about what was sent, and the only
 * honest place to check it is the peer's own view of the request.
 */
function startRegistry(respond) {
  const requests = []
  const server = createServer(TLS, (req, res) => {
    const record = {
      method: req.method,
      path: req.url,
      auth: req.headers.authorization ?? '',
      contentType: req.headers['content-type'] ?? '',
      body: '',
      // Raw chunks as well as the decoded string: the module-archive upload is
      // gzip, and `body += chunk` decodes as UTF-8, which mangles binary. The
      // only honest way to assert "a valid archive arrived" is over the bytes.
      chunks: [],
    }
    requests.push(record)
    req.on('data', (d) => {
      record.body += d
      record.chunks.push(d)
    })
    req.on('end', () => respond(req, res))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        requests,
        url: `https://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(done)
          }),
      }),
    )
  })
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** The `::error::` annotation the action printed, from STDOUT only. See rule 1. */
const errorLine = (r) => r.stdout.split('\n').find((l) => l.startsWith('::error::')) ?? ''

/** Reads one value out of a real $GITHUB_OUTPUT heredoc block. */
const outputValue = (text, name) =>
  text.match(new RegExp(`^${name}<<(\\S+)\\n([\\s\\S]*?)\\n\\1$`, 'm'))?.[2]

/** Output names action.yml declares, so a new one cannot go unasserted. */
function declaredOutputs() {
  const yml = readFileSync(ACTION_YML, 'utf8')
  const block = yml.split(/^outputs:\s*$/m)[1]?.split(/^\S/m)[0] ?? ''
  return [...block.matchAll(/^ {2}([a-z0-9-]+):/gm)].map((m) => m[1])
}

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) {
    failures++
    console.log(`        ${String(detail).replace(/\s+/g, ' ').slice(0, 400)}`)
  }
}

console.log(`driving ${DIST}`)

// --------------------------------------------------------------------------
// The publish itself: a credentialed round trip over a privately-signed TLS
// endpoint. This is the check a dead bundle cannot fake, and it is also the
// proof that `ca-cert` trusts a private CA and that `registry-allowed-hosts`
// permits a deliberately-private registry the default-deny would otherwise
// refuse.
// --------------------------------------------------------------------------
console.log('\n=== private registry: the credentialed publish, end to end ===')
{
  const reg = await startRegistry((req, res) =>
    req.method === 'GET' ? json(res, 200, { id: MODULE_ID, versions: [] }) : json(res, 202, {}),
  )
  const r = await runAction({
    'INPUT_REGISTRY-URL': reg.url,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
  })
  await reg.close()

  check(
    'the action completes and the registry answered over the private CA',
    r.code === 0 && reg.requests.length === 2,
    `exit ${r.code}, ${reg.requests.length} request(s); ${errorLine(r) || r.stderr.slice(0, 200)}`,
  )
  check(
    'GET resolves the module, then the admin sync POST is issued',
    reg.requests[0]?.method === 'GET' &&
      reg.requests[0]?.path === '/api/v1/modules/acme/vpc/aws' &&
      reg.requests[1]?.method === 'POST' &&
      reg.requests[1]?.path === `/api/v1/admin/modules/${MODULE_ID}/scm/sync`,
    JSON.stringify(reg.requests.map((q) => `${q.method} ${q.path}`)),
  )
  check(
    'every request carries the registry bearer credential',
    reg.requests.length > 0 && reg.requests.every((q) => q.auth === `Bearer ${API_KEY}`),
    JSON.stringify(reg.requests.map((q) => q.auth.slice(0, 12))),
  )
  check(
    "output 'published' is set to true",
    outputValue(r.output, 'published') === 'true',
    JSON.stringify(r.output),
  )
  const declared = declaredOutputs()
  check(
    `every output action.yml declares is set (${declared.join(', ')})`,
    declared.length > 0 && declared.every((name) => outputValue(r.output, name) !== undefined),
    JSON.stringify(r.output),
  )
  check(
    '::add-mask:: is emitted for the api key',
    r.stdout.includes(`::add-mask::${API_KEY}`),
    r.stdout.split('\n').filter((l) => l.includes('add-mask')).join(' | ') || '(no mask line)',
  )
  // Written as "exactly once, in the mask command" rather than "never leaks":
  // the latter is satisfied by a bundle that printed nothing at all.
  const keyLines = r.stdout.split('\n').filter((l) => l.includes(API_KEY))
  check(
    'the api key appears in the log exactly once, in the mask command',
    keyLines.length === 1 && keyLines[0] === `::add-mask::${API_KEY}`,
    keyLines.join(' | ') || '(the key appears nowhere, not even masked)',
  )
}

// An explicitly-false skip-tls-verify is the only other spelling that may pass;
// paired with the refusals below it shows the guard is not refusing everything.
console.log("\n=== skip-tls-verify: 'false' still publishes ===")
{
  const reg = await startRegistry((req, res) =>
    req.method === 'GET' ? json(res, 200, { id: MODULE_ID }) : json(res, 202, {}),
  )
  const r = await runAction({
    'INPUT_REGISTRY-URL': reg.url,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
    'INPUT_SKIP-TLS-VERIFY': 'false',
  })
  await reg.close()
  check(
    "'false' is accepted and the publish proceeds",
    r.code === 0 && outputValue(r.output, 'published') === 'true' && reg.requests.length === 2,
    `exit ${r.code}; ${errorLine(r)}`,
  )
}

// --------------------------------------------------------------------------
// TLS verification is genuinely on in the bundle: the same endpoint, minus the
// trust anchor, is refused at the handshake — before the Bearer credential is
// sent to it.
// --------------------------------------------------------------------------
console.log('\n=== ca-cert absent: the private CA is not trusted ===')
{
  const reg = await startRegistry((req, res) => json(res, 200, { id: MODULE_ID }))
  const r = await runAction({
    'INPUT_REGISTRY-URL': reg.url,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
  })
  await reg.close()
  check(
    'the handshake is refused and the credential never reaches the peer',
    /certificate/i.test(errorLine(r)) && reg.requests.length === 0 && r.code !== 0,
    `exit ${r.code}, ${reg.requests.length} request(s): ${errorLine(r) || '(no ::error:: on stdout)'}`,
  )
}

// --------------------------------------------------------------------------
// A registry-supplied `id` lands in the path of an authenticated admin POST.
// The guarantee is REJECTION, not sanitisation: the credentialed request must
// never be issued at a misbehaving peer's direction. So the assertion is the
// registry's own view — it saw the GET, and nothing after it.
// --------------------------------------------------------------------------
console.log('\n=== a hostile module id stops the admin POST being sent ===')
for (const [what, id] of [
  ['traversal out of the admin namespace', 'abc/../../../users/1'],
  ['a query introducer', '1?ownerId=2#'],
  ['percent-encoded traversal', '%2e%2e%2f'],
  ['an embedded space', 'mod 123'],
  ['no id at all', ''],
]) {
  const reg = await startRegistry((req, res) =>
    req.method === 'GET' ? json(res, 200, { id }) : json(res, 202, {}),
  )
  const r = await runAction({
    'INPUT_REGISTRY-URL': reg.url,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
  })
  await reg.close()
  check(
    `${what}: the step fails and the registry saw only the GET`,
    /module id/i.test(errorLine(r)) &&
      reg.requests.length === 1 &&
      reg.requests[0]?.method === 'GET' &&
      outputValue(r.output, 'published') === undefined,
    `${reg.requests.length} request(s) ${JSON.stringify(reg.requests.map((q) => `${q.method} ${q.path}`))}: ${
      errorLine(r) || '(no ::error:: on stdout)'
    }`,
  )
}

// --------------------------------------------------------------------------
// The withdrawn verification-off switch fails the step in every spelling an
// operator might reach for — read as raw text, so `yes` and `1` refuse too
// rather than throwing a schema error that explains nothing.
// --------------------------------------------------------------------------
console.log('\n=== skip-tls-verify fails closed in every truthy spelling ===')
for (const spelling of ['true', 'True', 'TRUE', 'yes', '1', '  true  ']) {
  const reg = await startRegistry((req, res) => json(res, 200, { id: MODULE_ID }))
  const r = await runAction({
    'INPUT_REGISTRY-URL': reg.url,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
    'INPUT_SKIP-TLS-VERIFY': spelling,
  })
  await reg.close()
  check(
    `${JSON.stringify(spelling)}: refused, naming ca-cert, with nothing contacted`,
    /removed/i.test(errorLine(r)) &&
      errorLine(r).includes("'ca-cert'") &&
      reg.requests.length === 0 &&
      r.code !== 0,
    `exit ${r.code}, ${reg.requests.length} request(s): ${errorLine(r) || '(no ::error:: on stdout)'}`,
  )
}

// --------------------------------------------------------------------------
// Default deny. Each spelling below is a destination the registry Bearer
// credential would otherwise be handed to. The loopback rows point at the LIVE
// endpoint, so "refused" is proved by the server's own silence and not merely
// by a message; the rows nothing is listening on are proved by the refusal
// naming the guard, which a connection attempt could not have produced.
// --------------------------------------------------------------------------
console.log('\n=== egress default-deny with registry-allowed-hosts empty ===')
{
  const reg = await startRegistry((req, res) => json(res, 200, { id: MODULE_ID }))
  // Spelled the way an operator would type them into `registry-url`. The WHATWG
  // parser normalises the numeric forms back to a dotted quad, and the guard's
  // numeric classification catches what survives; either way the credential must
  // not leave the runner.
  for (const [what, host] of [
    ['dotted-quad loopback', '127.0.0.1'],
    ['short-form loopback', '127.1'],
    ['decimal loopback', '2130706433'],
    ['hex loopback', '0x7f000001'],
    ['octal loopback', '017700000001'],
    ['IPv4-mapped IPv6 loopback', '[::ffff:127.0.0.1]'],
    ['the name localhost', 'localhost'],
  ]) {
    const before = reg.requests.length
    const r = await runAction({
      'INPUT_REGISTRY-URL': `https://${host}:${reg.port}`,
      'INPUT_CA-CERT': CA,
    })
    check(
      `${what} (${host}): refused before the live endpoint is contacted`,
      /Refusing to contact registry host/.test(errorLine(r)) &&
        /private, link-local/.test(errorLine(r)) &&
        reg.requests.length === before,
      `${reg.requests.length - before} request(s) arrived: ${errorLine(r) || '(no ::error:: on stdout)'}`,
    )
    // The credential is masked before the network is touched, so a later failure
    // cannot leave it unmasked in the log.
    check(
      `${what}: the api key was masked before the refusal`,
      r.stdout.includes(`::add-mask::${API_KEY}`),
      r.stdout.split('\n').slice(0, 3).join(' | '),
    )
  }
  await reg.close()
}

// Nothing listens on these; the refusal text is the observation, because a
// connection attempt would have produced ECONNREFUSED or a timeout instead.
for (const [what, host] of [
  ['the cloud instance-metadata address', '169.254.169.254'],
  ['an RFC1918 address', '10.0.0.5'],
  ['IPv6 link-local', '[fe80::1]'],
]) {
  const r = await runAction({ 'INPUT_REGISTRY-URL': `https://${host}/`, 'INPUT_CA-CERT': CA })
  check(
    `${what} (${host}): refused by the guard, not by the network`,
    errorLine(r).includes('Refusing to contact registry host') &&
      /private, link-local/.test(errorLine(r)),
    errorLine(r) || '(no ::error:: on stdout)',
  )
}

console.log('\n=== registry-allowed-hosts is enforced, not advisory ===')
{
  const reg = await startRegistry((req, res) => json(res, 200, { id: MODULE_ID }))
  const r = await runAction({
    'INPUT_REGISTRY-URL': reg.url,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': 'registry.example.com',
  })
  await reg.close()
  check(
    'a host outside the allowlist is refused and never contacted',
    errorLine(r).includes('not in registry-allowed-hosts') && reg.requests.length === 0,
    `${reg.requests.length} request(s): ${errorLine(r) || '(no ::error:: on stdout)'}`,
  )
}

// --------------------------------------------------------------------------
// HCP: a tag-based module takes its versions from pushed git tags, so the
// versions endpoint does not apply to it. The assertion is again the peer's
// view — one GET, and no POST that would create a version stuck at `pending`.
// --------------------------------------------------------------------------
console.log('\n=== hcp: a tag-based module gets no version POST ===')
{
  const reg = await startRegistry((req, res) =>
    json(res, 200, {
      data: { attributes: { 'vcs-repo': { identifier: 'acme/vpc' }, 'version-statuses': [] } },
    }),
  )
  const r = await runAction({
    'INPUT_REGISTRY-TYPE': 'hcp',
    'INPUT_HCP-ADDRESS': reg.url,
    'INPUT_HCP-TOKEN': HCP_TOKEN,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
  })
  await reg.close()
  check(
    'the module is read once and no version is created',
    r.code === 0 &&
      reg.requests.length === 1 &&
      reg.requests[0]?.method === 'GET' &&
      !reg.requests.some((q) => q.path.endsWith('/versions')),
    `exit ${r.code}: ${JSON.stringify(reg.requests.map((q) => `${q.method} ${q.path}`))} ${errorLine(r)}`,
  )
  check(
    'it reports the tag-based publish through its outputs',
    outputValue(r.output, 'published') === 'true' &&
      /tag-based/.test(outputValue(r.output, 'message') ?? ''),
    JSON.stringify(r.output),
  )
  check(
    '::add-mask:: is emitted for the hcp token',
    r.stdout.includes(`::add-mask::${HCP_TOKEN}`),
    r.stdout.split('\n').filter((l) => l.includes('add-mask')).join(' | ') || '(no mask line)',
  )
}

// --------------------------------------------------------------------------
// Masking is unconditional. The mask is job-scoped and cannot be applied
// retroactively, so what matters is that it is registered on paths that FAIL
// before the credential is ever consumed — which is where it used to be
// skipped entirely. Each row supplies a credential and then throws early.
// --------------------------------------------------------------------------
console.log('\n=== both credentials are masked before anything else can throw ===')
for (const [what, env, expect] of [
  [
    'the withdrawn skip-tls-verify refusal, which throws before the branch',
    { 'INPUT_SKIP-TLS-VERIFY': 'true', 'INPUT_REGISTRY-URL': 'https://registry.example.com' },
    [API_KEY],
  ],
  [
    'an unsupported registry-type, which matches no credential branch at all',
    {
      'INPUT_REGISTRY-TYPE': 'Private',
      'INPUT_HCP-TOKEN': HCP_TOKEN,
      'INPUT_REGISTRY-URL': 'https://registry.example.com',
    },
    [API_KEY, HCP_TOKEN],
  ],
  [
    'a missing required coordinate, which throws before the branch',
    { 'INPUT_VERSION': '', 'INPUT_HCP-TOKEN': HCP_TOKEN },
    [API_KEY, HCP_TOKEN],
  ],
  [
    'the credential the chosen branch does NOT consume',
    { 'INPUT_HCP-TOKEN': HCP_TOKEN, 'INPUT_REGISTRY-URL': 'https://169.254.169.254/' },
    [API_KEY, HCP_TOKEN],
  ],
]) {
  const r = await runAction(env)
  check(
    `${what}: masked anyway`,
    r.code !== 0 && expect.every((secret) => r.stdout.includes(`::add-mask::${secret}`)),
    `exit ${r.code}; masks: ${
      r.stdout.split('\n').filter((l) => l.startsWith('::add-mask::')).join(' | ') || '(none)'
    }; ${errorLine(r)}`,
  )
}

// --------------------------------------------------------------------------
// A failure body is the PEER's text, and core.setFailed's own escaping covers
// only %, CR and LF. Without a bound the registry picks the length of the
// consumer's annotation and every other control character in it.
// --------------------------------------------------------------------------
console.log('\n=== a hostile failure body cannot choose the size of the annotation ===')
{
  const hostile = `[31m${'A'.repeat(200_000)}`
  const reg = await startRegistry((req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(hostile)
  })
  const r = await runAction({
    'INPUT_REGISTRY-URL': reg.url,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
  })
  await reg.close()
  const line = errorLine(r)
  check(
    'the annotation is truncated, stripped, and still names the status',
    r.code !== 0 &&
      line.length < 900 &&
      line.includes('HTTP 500') &&
      /more characters truncated/.test(line) &&
      // eslint-disable-next-line no-control-regex
      !/[ --]/.test(line),
    `${line.length} chars: ${line.slice(0, 200)}`,
  )
}

// --------------------------------------------------------------------------
// The body is bounded on the way IN as well. The wait loops re-issue the same
// request every three seconds, so an unbounded read is pressure that repeats.
// --------------------------------------------------------------------------
console.log('\n=== an oversized response is cut off rather than absorbed ===')
{
  let written = 0
  const chunk = Buffer.alloc(256 * 1024, 0x41)
  const reg = await startRegistry((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    const pump = () => {
      // Stop well past the client's 10 MB cap; if the cap is gone this keeps
      // feeding the process instead.
      while (written < 40 * 1024 * 1024) {
        written += chunk.length
        if (!res.write(chunk)) return res.once('drain', pump)
      }
      res.end()
    }
    pump()
  })
  const r = await runAction({
    'INPUT_REGISTRY-URL': reg.url,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
  })
  await reg.close()
  check(
    'the action refuses the oversized body and names the limit',
    r.code !== 0 && /exceeded \d+ bytes/.test(errorLine(r)),
    `exit ${r.code}, ${(written / 1048576).toFixed(1)} MB offered: ${errorLine(r) || r.stderr.slice(0, 200)}`,
  )
  // Paired with the positive observation, per rule 2: the registry must have
  // been reached AND have streamed something before the count is allowed to
  // prove anything. `written < 24 MB` on its own is satisfied by a bundle that
  // never connected, which is the exact false PASS this harness exists to
  // catch.
  check(
    'the read started, then stopped near the cap instead of running to the end',
    reg.requests.length === 1 && written > 0 && written < 24 * 1024 * 1024,
    `${reg.requests.length} request(s), ${(written / 1048576).toFixed(1)} MB written before the client gave up`,
  )
}

// --------------------------------------------------------------------------
// A 2xx that is not JSON is what a WAF, a captive portal or a proxy
// interstitial answers with. It used to surface as a bare SyntaxError carrying
// none of the calling context.
// --------------------------------------------------------------------------
console.log('\n=== a non-JSON 2xx is reported as such, not as a raw SyntaxError ===')
{
  const reg = await startRegistry((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body>Access denied by policy</body></html>')
  })
  const r = await runAction({
    'INPUT_REGISTRY-URL': reg.url,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
  })
  await reg.close()
  check(
    'the failure names the response and shows the body, not "Unexpected token"',
    r.code !== 0 &&
      /was not valid JSON/.test(errorLine(r)) &&
      errorLine(r).includes('Access denied by policy') &&
      !/Unexpected token/.test(errorLine(r)),
    errorLine(r) || '(no ::error:: on stdout)',
  )
}

// --------------------------------------------------------------------------
// A registry response is not a trusted shape. `?? []` substituted only for
// null/undefined, so a truthy non-array reached `.find` and threw a TypeError
// from inside the wait loop.
// --------------------------------------------------------------------------
console.log('\n=== a non-array version-statuses does not crash the HCP path ===')
{
  const reg = await startRegistry((req, res) =>
    json(res, 200, {
      data: { attributes: { 'vcs-repo': { identifier: 'acme/vpc' }, 'version-statuses': 'notarray' } },
    }),
  )
  const r = await runAction({
    'INPUT_REGISTRY-TYPE': 'hcp',
    'INPUT_HCP-ADDRESS': reg.url,
    'INPUT_HCP-TOKEN': HCP_TOKEN,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
  })
  await reg.close()
  check(
    'it completes the tag-based publish instead of throwing a TypeError',
    r.code === 0 && outputValue(r.output, 'published') === 'true' && !/is not a function/.test(r.stdout),
    `exit ${r.code}: ${errorLine(r) || JSON.stringify(r.output)}`,
  )
}

// --------------------------------------------------------------------------
// Provenance: the version HCP records must be tied to the commit the workflow
// ran on. The input is optional and both README examples left it empty, so
// the default has to come from the runner's own GITHUB_SHA.
// --------------------------------------------------------------------------
console.log('\n=== the created HCP version carries the commit the workflow ran on ===')
{
  const SHA = '9f1c0de5b8a74e2d3c6b1a0f4e7d8c9b0a1b2c3d'
  const reg = await startRegistry((req, res) =>
    req.method === 'GET'
      ? json(res, 200, { data: { attributes: { 'vcs-repo': { branch: 'main' } } } })
      : json(res, 201, { data: {} }),
  )
  const r = await runAction({
    'INPUT_REGISTRY-TYPE': 'hcp',
    'INPUT_HCP-ADDRESS': reg.url,
    'INPUT_HCP-TOKEN': HCP_TOKEN,
    'INPUT_VCS-BRANCH': 'main',
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
    GITHUB_SHA: SHA,
  })
  await reg.close()
  const post = reg.requests.find((q) => q.method === 'POST')
  check(
    'commit-sha defaults to GITHUB_SHA in the version the registry is asked to create',
    post !== undefined &&
      JSON.parse(post.body || '{}').data?.attributes?.['commit-sha'] === SHA,
    post ? post.body.slice(0, 300) : '(no POST was issued)',
  )
}

console.log('\n=== an explicit commit-sha still wins over GITHUB_SHA ===')
{
  const EXPLICIT = '1111111111111111111111111111111111111111'
  const reg = await startRegistry((req, res) =>
    req.method === 'GET'
      ? json(res, 200, { data: { attributes: { 'vcs-repo': { branch: 'main' } } } })
      : json(res, 201, { data: {} }),
  )
  const r = await runAction({
    'INPUT_REGISTRY-TYPE': 'hcp',
    'INPUT_HCP-ADDRESS': reg.url,
    'INPUT_HCP-TOKEN': HCP_TOKEN,
    'INPUT_VCS-BRANCH': 'main',
    'INPUT_COMMIT-SHA': EXPLICIT,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
    GITHUB_SHA: '9f1c0de5b8a74e2d3c6b1a0f4e7d8c9b0a1b2c3d',
  })
  await reg.close()
  const post = reg.requests.find((q) => q.method === 'POST')
  check(
    'the operator-supplied sha is the one sent',
    post !== undefined &&
      JSON.parse(post.body || '{}').data?.attributes?.['commit-sha'] === EXPLICIT,
    post ? post.body.slice(0, 300) : '(no POST was issued)',
  )
}

// --------------------------------------------------------------------------
// The upload-driven publish, end to end through the bundle.
//
// This is the half of the HCP flow that `npm test` cannot reach: the archive is
// built from a REAL directory on disk by code wired up in src/index.ts, which
// the unit suite does not import at all. A branch-based module answers version
// creation with an upload link, and the action must then PUT a real gzipped tar
// of that directory — the version is otherwise left at 'pending' forever.
// --------------------------------------------------------------------------
console.log('\n=== HCP upload-driven: the module archive is built and uploaded ===')
{
  const moduleDir = mkdtempSync(join(work, 'module-'))
  writeFileSync(join(moduleDir, 'main.tf'), 'resource "null_resource" "a" {}\n')
  writeFileSync(join(moduleDir, 'variables.tf'), 'variable "name" {}\n')
  // Excluded from the archive: proof the exclusion survives the bundler.
  execFileSync('mkdir', ['-p', join(moduleDir, '.git')])
  writeFileSync(join(moduleDir, '.git', 'config'), 'not module source')

  const CAPABILITY = 'dmF1bHQ6c2VjcmV0LWNhcGFiaWxpdHktdG9rZW4'
  let uploadLink = ''
  const reg = await startRegistry((req, res) => {
    if (req.method === 'GET') {
      return json(res, 200, { data: { attributes: { 'vcs-repo': { branch: 'main' } } } })
    }
    if (req.method === 'POST') return json(res, 201, { data: { links: { upload: uploadLink } } })
    res.writeHead(200)
    res.end('')
  })
  uploadLink = `${reg.url}/v1/object/${CAPABILITY}`
  const r = await runAction({
    'INPUT_REGISTRY-TYPE': 'hcp',
    'INPUT_HCP-ADDRESS': reg.url,
    'INPUT_HCP-TOKEN': HCP_TOKEN,
    'INPUT_VCS-BRANCH': 'main',
    'INPUT_MODULE-DIRECTORY': moduleDir,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
  })
  await reg.close()

  const put = reg.requests.find((q) => q.method === 'PUT')
  check(
    'the action PUTs the archive to the upload link and reports success',
    r.code === 0 && put !== undefined && outputValue(r.output, 'published') === 'true',
    `exit ${r.code}, methods ${JSON.stringify(reg.requests.map((q) => q.method))}; ${errorLine(r)}`,
  )
  check(
    'the upload goes to the exact capability path HCP returned',
    put?.path === `/v1/object/${CAPABILITY}`,
    put ? put.path : '(no PUT was issued)',
  )

  // The bytes are unpacked with the system tar, so this asserts a real reader
  // accepts what a real consumer would download — not that our writer round
  // trips its own format.
  let listed = ''
  if (put) {
    const tgz = join(work, 'uploaded.tar.gz')
    writeFileSync(tgz, Buffer.concat(put.chunks))
    try {
      listed = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
    } catch (e) {
      listed = `tar refused the upload: ${e}`
    }
  }
  check(
    'the uploaded bytes are a gzipped tar the system tar can read',
    put !== undefined &&
      Buffer.concat(put.chunks)[0] === 0x1f &&
      Buffer.concat(put.chunks)[1] === 0x8b &&
      // The gzip magic alone would pass on an archive whose tar headers are
      // corrupt, so the reader's verdict is part of the claim.
      listed !== '' &&
      !listed.startsWith('tar refused'),
    put ? `magic ${Buffer.concat(put.chunks).subarray(0, 2).toString('hex')}; tar said: ${listed}` : '(no PUT)',
  )
  check(
    'the archive holds the module files at its root',
    /^main\.tf$/m.test(listed) && /^variables\.tf$/m.test(listed),
    listed || '(nothing listed)',
  )
  check(
    'the archive excludes .git, which is not module source',
    listed !== '' && !/\.git/.test(listed),
    listed || '(nothing listed)',
  )

  // The HCP token is org-scoped for registry-modules. The upload host is named
  // by a RESPONSE BODY, and the capability URL is itself the authorization, so
  // attaching the token would hand that credential to whatever host answered.
  check(
    'the upload does not carry the HCP bearer token',
    put !== undefined && put.auth === '',
    put ? `authorization: '${put.auth}'` : '(no PUT)',
  )
  check(
    'the version-creation call still DOES carry it',
    reg.requests.find((q) => q.method === 'POST')?.auth === `Bearer ${HCP_TOKEN}`,
    JSON.stringify(reg.requests.map((q) => `${q.method}:${q.auth.slice(0, 12)}`)),
  )

  // The capability lives in the URL PATH, so masking has to cover the whole URL
  // rather than the query string a presigned-link redactor would strip.
  check(
    '::add-mask:: is emitted for the upload capability URL',
    r.stdout.includes(`::add-mask::${uploadLink}`),
    r.stdout.split('\n').filter((l) => l.includes('add-mask')).join(' | ') || '(no mask line)',
  )
  const capabilityLines = r.stdout.split('\n').filter((l) => l.includes(CAPABILITY))
  check(
    'the capability appears in the log exactly once, in the mask command',
    capabilityLines.length === 1 && capabilityLines[0] === `::add-mask::${uploadLink}`,
    capabilityLines.join(' | ') || '(the capability appears nowhere, not even masked)',
  )
  check(
    'the step still names the upload host, so it can be allowlisted',
    r.stdout.includes('127.0.0.1'),
    '(the host is never mentioned)',
  )
}

// --------------------------------------------------------------------------
// The upload destination is chosen by a RESPONSE BODY, which is the SSRF shape
// this family has already been bitten by. It is authorized against
// registry-allowed-hosts exactly like the API host, before it is contacted.
// --------------------------------------------------------------------------
console.log('\n=== an upload link off the allowlist is refused, not followed ===')
{
  const reg = await startRegistry((req, res) => {
    if (req.method === 'GET') {
      return json(res, 200, { data: { attributes: { 'vcs-repo': { branch: 'main' } } } })
    }
    return json(res, 201, { data: { links: { upload: 'https://169.254.169.254/v1/object/steal' } } })
  })
  const moduleDir = mkdtempSync(join(work, 'module-ssrf-'))
  writeFileSync(join(moduleDir, 'main.tf'), 'resource "null_resource" "a" {}\n')
  const r = await runAction({
    'INPUT_REGISTRY-TYPE': 'hcp',
    'INPUT_HCP-ADDRESS': reg.url,
    'INPUT_HCP-TOKEN': HCP_TOKEN,
    'INPUT_VCS-BRANCH': 'main',
    'INPUT_MODULE-DIRECTORY': moduleDir,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
  })
  await reg.close()
  // Positive AND negative, per rule 2: the refusal was printed, and the upload
  // was not attempted against the registry either.
  check(
    'the action refuses the off-allowlist upload host by name',
    r.code !== 0 && /169\.254\.169\.254/.test(errorLine(r)) && /registry-allowed-hosts/.test(errorLine(r)),
    errorLine(r) || '(no ::error:: on stdout)',
  )
  check(
    'no PUT was issued anywhere',
    !reg.requests.some((q) => q.method === 'PUT'),
    JSON.stringify(reg.requests.map((q) => q.method)),
  )
  check(
    "the step is failed rather than reporting a publish",
    outputValue(r.output, 'published') === undefined,
    JSON.stringify(r.output),
  )
}

// --------------------------------------------------------------------------
// A mis-pointed module-directory publishes the wrong thing. It is refused
// before the version is created, not after the archive is uploaded.
// --------------------------------------------------------------------------
console.log('\n=== a module-directory holding no Terraform is refused ===')
{
  const notAModule = mkdtempSync(join(work, 'notmodule-'))
  writeFileSync(join(notAModule, 'README.md'), 'no terraform here')
  let uploadLink = ''
  const reg = await startRegistry((req, res) => {
    if (req.method === 'GET') {
      return json(res, 200, { data: { attributes: { 'vcs-repo': { branch: 'main' } } } })
    }
    if (req.method === 'POST') return json(res, 201, { data: { links: { upload: uploadLink } } })
    res.writeHead(200)
    res.end('')
  })
  uploadLink = `${reg.url}/v1/object/cap`
  const r = await runAction({
    'INPUT_REGISTRY-TYPE': 'hcp',
    'INPUT_HCP-ADDRESS': reg.url,
    'INPUT_HCP-TOKEN': HCP_TOKEN,
    'INPUT_VCS-BRANCH': 'main',
    'INPUT_MODULE-DIRECTORY': notAModule,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
  })
  await reg.close()
  check(
    'the failure says the directory holds no .tf files',
    r.code !== 0 && /no \.tf or \.tf\.json files/.test(errorLine(r)),
    errorLine(r) || '(no ::error:: on stdout)',
  )
  check(
    'nothing was uploaded',
    !reg.requests.some((q) => q.method === 'PUT'),
    JSON.stringify(reg.requests.map((q) => q.method)),
  )
}

// --------------------------------------------------------------------------
// #17 Egress proxy. The unit suite injects both the environment and the mask
// sink, so NEITHER of the two entrypoint wirings this depends on — that the
// resolver defaults to `process.env`, and that `core.setSecret` is the sink —
// is observable there. They are observable here, in the bundle consumers run.
// --------------------------------------------------------------------------

/**
 * A minimal forward proxy: it answers CONNECT by splicing a TCP socket to the
 * requested destination, which is the tunnel an enterprise egress proxy gives.
 */
function startProxy() {
  const connects = []
  const server = createHttpServer((_req, res) => {
    res.writeHead(405)
    res.end()
  })
  server.on('connect', (req, clientSocket, head) => {
    connects.push(req.url ?? '')
    const [host, port] = (req.url ?? '').split(':')
    const upstream = netConnect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        connects,
        url: `http://127.0.0.1:${server.address().port}`,
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections()
            server.close(done)
          }),
      }),
    )
  })
}

/**
 * A private-registry publish that succeeds, so the happy path is observable —
 * a refusal-only block would pass just as well on a bundle that never worked.
 * The module lookup answers 200 and the tag-sync answers 202, which is the
 * exact status `PrivateRegistryPublisher` requires.
 */
const publishOk = (req, res) => {
  if (req.method === 'POST') return json(res, 202, {})
  return json(res, 200, { id: MODULE_ID })
}

console.log('\n=== #17  registry calls honour the runner proxy from their own environment ===')
{
  const reg = await startRegistry(publishOk)
  const proxy = await startProxy()
  const r = await runAction({
    'INPUT_REGISTRY-URL': reg.url,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
    HTTPS_PROXY: proxy.url,
  })
  await reg.close()
  await proxy.close()
  // The load-bearing one. Both servers are on loopback, so a bundle that
  // ignored HTTPS_PROXY entirely would ALSO reach the registry and pass every
  // other assertion here — the tunnel record is the only thing that separates
  // "through the chokepoint" from "around it".
  check(
    'the proxy saw a CONNECT to the registry',
    proxy.connects.length > 0 && proxy.connects.every((c) => c === `127.0.0.1:${reg.port}`),
    JSON.stringify(proxy.connects),
  )
  check('the registry was reached through the tunnel', reg.requests.length > 0, JSON.stringify(reg.requests.map((q) => q.method)))
  check('the step succeeded', r.code === 0 && !errorLine(r), errorLine(r) || `exit ${r.code}`)
}

console.log('\n=== #17  NO_PROXY is honoured from the runner environment ===')
{
  const reg = await startRegistry(publishOk)
  const proxy = await startProxy()
  const r = await runAction({
    'INPUT_REGISTRY-URL': reg.url,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
    HTTPS_PROXY: proxy.url,
    NO_PROXY: '127.0.0.1',
  })
  await reg.close()
  await proxy.close()
  check('the proxy was never dialled', proxy.connects.length === 0, JSON.stringify(proxy.connects))
  check('the registry was reached directly', reg.requests.length > 0, JSON.stringify(reg.requests.map((q) => q.method)))
  check('the step succeeded', r.code === 0 && !errorLine(r), errorLine(r) || `exit ${r.code}`)
}

console.log('\n=== #17  a proxy credential reaches the job mask ===')
{
  // The proxy URL arrives from the ENVIRONMENT, not from an action input, so
  // maskCredentials() never saw it. This is the only layer that can observe
  // `core.setSecret` actually being the sink.
  const reg = await startRegistry(publishOk)
  const proxy = await startProxy()
  const r = await runAction({
    'INPUT_REGISTRY-URL': reg.url,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
    HTTPS_PROXY: `http://bob:hunter2@127.0.0.1:${proxy.port}`,
  })
  await reg.close()
  await proxy.close()
  check(
    '::add-mask:: emitted for the proxy password',
    r.stdout.includes('::add-mask::hunter2'),
    r.stdout.split('\n').filter((l) => l.includes('add-mask')).join(' | ') || '(no mask line)',
  )
  check('the credentialed proxy still carried the request', proxy.connects.length > 0, JSON.stringify(proxy.connects))
}

console.log('\n=== #17  a proxy is not a way around egress authorization ===')
{
  // The destination is refused by registry-allowed-hosts, and a configured
  // proxy must not change that: a CONNECT tunnel to an unauthorized host is
  // still unauthorized egress. The allowlist below permits the PROXY's own host
  // (127.0.0.1 names both here), which is the laundering attempt — and the
  // destination is refused all the same because the allowlist entry carries a
  // port that the registry's does not match.
  const reg = await startRegistry(publishOk)
  const proxy = await startProxy()
  const r = await runAction({
    'INPUT_REGISTRY-URL': reg.url,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': `127.0.0.1:${proxy.port}`,
    HTTPS_PROXY: proxy.url,
  })
  await reg.close()
  await proxy.close()
  check(
    'the refusal names the destination and the input',
    r.code !== 0 && /127\.0\.0\.1.*registry-allowed-hosts/.test(errorLine(r)),
    errorLine(r) || '(no ::error:: on stdout)',
  )
  check('nothing was tunnelled', proxy.connects.length === 0, JSON.stringify(proxy.connects))
  check('the registry credential never left the runner', reg.requests.length === 0, JSON.stringify(reg.requests.map((q) => q.method)))
}

console.log('\n=== #17  an unusable proxy variable fails closed rather than going direct ===')
{
  const reg = await startRegistry(publishOk)
  const proxy = await startProxy()
  const r = await runAction({
    'INPUT_REGISTRY-URL': reg.url,
    'INPUT_CA-CERT': CA,
    'INPUT_REGISTRY-ALLOWED-HOSTS': '127.0.0.1',
    HTTPS_PROXY: 'not a url',
  })
  await reg.close()
  await proxy.close()
  check(
    'the refusal names the variable',
    r.code !== 0 && /HTTPS_PROXY/.test(errorLine(r)),
    errorLine(r) || '(no ::error:: on stdout)',
  )
  check('the variable value is never echoed', !/not a url/.test(r.stdout), errorLine(r))
  check('the request did NOT quietly go direct', reg.requests.length === 0, JSON.stringify(reg.requests.map((q) => q.method)))
  check('and nothing was tunnelled either', proxy.connects.length === 0, JSON.stringify(proxy.connects))
}

console.log(`\n${failures === 0 ? 'ALL DIST CHECKS PASSED' : `${failures} DIST CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
