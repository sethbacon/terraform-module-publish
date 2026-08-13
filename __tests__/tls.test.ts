import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { createHostAuthorizer } from '../src/egress'
import { createHttpsClient, describeError, resolveTlsTrust } from '../src/http'

/**
 * The class test for TLS peer verification on the requests that carry the
 * registry Bearer credential.
 *
 * Two tables. The first covers the withdrawn `skip-tls-verify` input: every
 * spelling of "on" must fail the step, and only absence or an explicit false
 * may pass. The second runs REAL handshakes against a locally-generated
 * private CA, because the property at stake — that turning off verification
 * turned off hostname checking too — is a property of Node's TLS stack, not of
 * our own branching, and asserting it anywhere else would assert nothing.
 */

interface TrustRow {
  what: string
  skipTlsVerify: string
  caCert?: string
  /** Absent means the inputs are accepted; present is the substring the refusal must carry. */
  reject?: string
  expectCaCert?: string
}

const TRUST_ROWS: TrustRow[] = [
  // --- the default: verification on, nothing to configure ---
  { what: 'unset (the default): verification on', skipTlsVerify: '' },
  { what: "explicit 'false'", skipTlsVerify: 'false' },
  { what: "explicit 'False'", skipTlsVerify: 'False' },
  { what: "explicit '0'", skipTlsVerify: '0' },
  { what: 'whitespace only', skipTlsVerify: '   ' },

  // --- the fail-closed refusal, in every spelling an operator might reach for ---
  { what: "'true' fails the step", skipTlsVerify: 'true', reject: "'ca-cert'" },
  { what: "'True' fails the step", skipTlsVerify: 'True', reject: "'ca-cert'" },
  { what: "'TRUE' fails the step", skipTlsVerify: 'TRUE', reject: "'ca-cert'" },
  { what: "'yes' fails the step (not a YAML boolean, still refused)", skipTlsVerify: 'yes', reject: "'ca-cert'" },
  { what: "'1' fails the step", skipTlsVerify: '1', reject: "'ca-cert'" },
  { what: 'a padded true fails the step', skipTlsVerify: '  true  ', reject: "'ca-cert'" },
  {
    what: 'setting it alongside a CA certificate still fails the step',
    skipTlsVerify: 'true',
    caCert: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
    reject: "'ca-cert'",
  },

  // --- the supported private-CA path ---
  {
    what: 'a CA certificate is carried through as a trust anchor',
    skipTlsVerify: '',
    caCert: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
    expectCaCert: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
  },
  { what: 'a blank CA certificate is not a trust anchor', skipTlsVerify: '', caCert: '   ' },
]

describe('TLS trust resolved from the action inputs', () => {
  it.each(TRUST_ROWS)('$what', (row) => {
    if (row.reject) {
      expect(() => resolveTlsTrust(row.skipTlsVerify, row.caCert ?? '')).toThrow(row.reject)
      return
    }
    expect(resolveTlsTrust(row.skipTlsVerify, row.caCert ?? '')).toEqual(
      row.expectCaCert ? { caCert: row.expectCaCert } : {},
    )
  })

  it('names the credential exposure, not just the input, when it refuses', () => {
    expect(() => resolveTlsTrust('true', '')).toThrow(/hostname/i)
  })
})

/**
 * A registry served over TLS by a certificate this machine's trust store does
 * not know — i.e. exactly the private-CA situation `skip-tls-verify` existed
 * for. The certificate names `localhost` only, so reaching the same socket via
 * `127.0.0.1` is a genuine hostname mismatch.
 */
let dir: string
let server: https.Server
let port: number
let caPem: string
let otherCaPem: string

function generateSelfSigned(prefix: string): { cert: string; key: string } {
  const certPath = join(dir, `${prefix}-cert.pem`)
  const keyPath = join(dir, `${prefix}-key.pem`)
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '2', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost',
    ],
    { stdio: 'ignore' },
  )
  return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tmp-tls-'))
  const registry = generateSelfSigned('registry')
  caPem = registry.cert
  otherCaPem = generateSelfSigned('unrelated').cert

  server = https.createServer({ cert: registry.cert, key: registry.key }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"id":"mod-123"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
}, 30_000)

afterAll(() => {
  server?.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

interface HandshakeRow {
  what: string
  /** Host in the request URL. `localhost` matches the certificate; `127.0.0.1` does not. */
  host: 'localhost' | '127.0.0.1'
  ca: 'registry' | 'unrelated' | 'none'
  /** Absent means the request must succeed. */
  reject?: RegExp
}

const HANDSHAKE_ROWS: HandshakeRow[] = [
  {
    what: 'default (no trust anchor): a privately-issued certificate is refused',
    host: 'localhost',
    ca: 'none',
    reject: /self.signed|unable to verify|DEPTH_ZERO/i,
  },
  {
    what: 'the supported private-CA path: the registry CA is trusted and the request succeeds',
    host: 'localhost',
    ca: 'registry',
  },
  {
    // The row that was the vulnerability: under skip-tls-verify this exact
    // request succeeded and handed over the Bearer credential. Trusting the CA
    // does NOT buy back hostname verification, so it is still refused.
    what: 'hostname mismatch is refused even with the CA trusted',
    host: '127.0.0.1',
    ca: 'registry',
    reject: /ALTNAME|does not match/i,
  },
  {
    what: 'hostname mismatch with no trust anchor is refused',
    host: '127.0.0.1',
    ca: 'none',
    reject: /self.signed|unable to verify|ALTNAME|DEPTH_ZERO/i,
  },
  {
    what: 'an unrelated CA does not vouch for this registry',
    host: 'localhost',
    ca: 'unrelated',
    reject: /self.signed|unable to verify|DEPTH_ZERO/i,
  },
]

describe('TLS failures are reported with the reason, not just "fetch failed"', () => {
  it('unwraps the cause chain that carries the TLS diagnosis', () => {
    const cause = Object.assign(new Error('self-signed certificate'), {
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    })
    expect(describeError(Object.assign(new Error('fetch failed'), { cause }))).toBe(
      'fetch failed: self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)',
    )
  })

  it('passes an ordinary error through unchanged', () => {
    expect(describeError(new Error('Input registry-url is required.'))).toBe(
      'Input registry-url is required.',
    )
  })

  it('handles a thrown non-error', () => {
    expect(describeError('boom')).toBe('boom')
  })
})

describe('TLS verification on the credentialed registry request (real handshakes)', () => {
  it.each(HANDSHAKE_ROWS)('$what', async (row) => {
    const caCert = row.ca === 'registry' ? caPem : row.ca === 'unrelated' ? otherCaPem : undefined
    // The registry is on loopback, so it is reachable only because the operator
    // pinned it — the egress control and the TLS control compose rather than
    // one standing in for the other.
    const client = createHttpsClient(createHostAuthorizer('localhost,127.0.0.1'), { caCert })
    const request = client('GET', `https://${row.host}:${port}/api/v1/modules/myorg/vpc/aws`, {
      Authorization: 'Bearer secret',
    })
    if (row.reject) {
      const error = await request.then(
        () => null,
        (e: unknown) => e,
      )
      expect(error, 'the handshake was accepted when it had to be refused').not.toBeNull()
      expect(describeError(error)).toMatch(row.reject)
    } else {
      await expect(request).resolves.toEqual({ status: 200, body: '{"id":"mod-123"}' })
    }
  }, 30_000)

  /**
   * A re-runnable signature rather than a list assembled by reading: any future
   * reintroduction of a verification-off switch anywhere in `src` reddens this,
   * including the env-var spelling that never touches our own client options.
   */
  it('leaves no way to disable peer verification anywhere in src', () => {
    // vitest runs from the project root.
    const srcDir = join(process.cwd(), 'src')
    const offending = readdirSync(srcDir)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => {
        const text = readFileSync(join(srcDir, f), 'utf8')
        return /rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|checkServerIdentity\s*:/.test(text)
          ? [f]
          : []
      })
    expect(offending).toEqual([])
  })
})
