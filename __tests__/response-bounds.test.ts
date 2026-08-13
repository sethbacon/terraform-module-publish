import { describe, expect, it, vi } from 'vitest'
import { createHostAuthorizer } from '../src/egress'
import { bodyExcerpt, createHttpsClient, parseJson } from '../src/http'
import { HcpPublisher, versionStatus } from '../src/hcp-publisher'
import type { HcpOptions } from '../src/hcp-publisher'
import { PrivateRegistryPublisher, hasVersion } from '../src/private-publisher'
import type { PrivateRegistryOptions } from '../src/private-publisher'
import type { HttpResponse } from '../src/http'

/**
 * The class tests for what a REGISTRY gets to decide.
 *
 * Everything below is driven by a response body the peer chose. Three distinct
 * defects shared that root: the body was buffered without a cap, it was pasted
 * unescaped into the annotation the runner renders, and it was fed to a bare
 * JSON.parse whose result was indexed without checking its shape. The rows are
 * table-driven over every call site of each, because a test that pins only the
 * site the report named passes forever while its siblings stay broken.
 */

const publicDns = async () => [{ address: '93.184.216.34' }]
const authorizer = createHostAuthorizer('', publicDns)

/** A fetch that streams `bytes` of body, so `readBounded` sees a real stream. */
function streamingFetch(bytes: number, chunk = 64 * 1024): { fetch: typeof fetch; sent: () => number } {
  let sent = 0
  const impl = (async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          if (sent >= bytes) {
            controller.close()
            return
          }
          const size = Math.min(chunk, bytes - sent)
          sent += size
          controller.enqueue(new Uint8Array(size))
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch
  return { fetch: impl, sent: () => sent }
}

describe('a response body is bounded, not absorbed', () => {
  // The cap is the shared client's MAX_RESPONSE_BYTES (10 MB). The old
  // hand-rolled `consume` — `async (r) => ({ status: r.status, body: await
  // r.text() })` — owned the body itself and never reached readBounded, so no
  // cap applied to it at all and the stream below would have run to completion.
  it('rejects an oversized body and stops reading it', async () => {
    const { fetch: impl, sent } = streamingFetch(24 * 1024 * 1024)
    const client = createHttpsClient(authorizer, { fetchImpl: impl })
    await expect(client('GET', 'https://registry.example.com/api/v1/modules', {})).rejects.toThrow(
      /exceeded \d+ bytes/,
    )
    // Cancelled at the cap rather than buffered whole: what was pulled must be
    // within a chunk of the limit, not the 24 MB the peer offered.
    expect(sent()).toBeLessThan(11 * 1024 * 1024)
  })

  it('still returns a body that fits', async () => {
    const { fetch: impl } = streamingFetch(1024)
    const client = createHttpsClient(authorizer, { fetchImpl: impl })
    await expect(
      client('GET', 'https://registry.example.com/api/v1/modules', {}),
    ).resolves.toMatchObject({ status: 200 })
  })
})

describe('an egress refusal on a redirect hop is fatal, not retried', () => {
  // fetchStatusText retries, and the shared client treats any non-HttpError as
  // a transient transport failure. A plain throw from the redirect policy was
  // therefore REPEATED — three chances inside one run for a host that resolves
  // differently per lookup to flip from refused to allowed.
  it('issues the refused request exactly once', async () => {
    const urls: string[] = []
    const impl = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/steal' } })
    }) as typeof fetch
    const client = createHttpsClient(authorizer, { fetchImpl: impl })
    await expect(client('GET', 'https://registry.example.com/api/v1/modules', {})).rejects.toThrow(
      'private',
    )
    expect(urls).toEqual(['https://registry.example.com/api/v1/modules'])
  })
})

describe('a remote body reaching the annotation is bounded and stripped', () => {
  it('truncates past the excerpt limit and says how much was dropped', () => {
    const excerpt = bodyExcerpt('x'.repeat(5000))
    expect(excerpt.length).toBeLessThan(600)
    expect(excerpt).toMatch(/4488 more characters truncated/)
  })

  it('removes control characters, which core.setFailed does not escape', () => {
    // setFailed percent-encodes only %, CR and LF. Everything else in C0 —
    //  here — survives into the rendered annotation.
    expect(bodyExcerpt('before[2Jafter')).toBe('before[2Jafter')
  })

  it('leaves an ordinary short body alone', () => {
    expect(bodyExcerpt('{"error":"not found"}')).toBe('{"error":"not found"}')
  })

  /**
   * Every site that puts a response body into a thrown Error. The publishers
   * are driven to each failure and the message is asserted to be bounded, so a
   * new site added without `bodyExcerpt` fails here rather than in production.
   */
  const HOSTILE = `[31m${'A'.repeat(40_000)}`

  const privateOptions: PrivateRegistryOptions = {
    namespace: 'acme',
    name: 'vpc',
    provider: 'aws',
    version: '1.2.3',
    registryUrl: 'https://registry.example.com',
    apiKey: 'key',
    waitForPublish: false,
    timeoutSeconds: 1,
  }

  const hcpOptions: HcpOptions = {
    namespace: 'myorg',
    name: 'vpc',
    provider: 'aws',
    version: '1.2.3',
    address: 'https://app.terraform.io',
    token: 'token',
    vcsRepoIdentifier: 'myorg/vpc',
    vcsBranch: '',
    vcsOauthTokenId: 'ot-1',
    commitSha: 'abc123',
    waitForPublish: false,
    timeoutSeconds: 1,
  }

  const cases: Array<{ site: string; run: (debug: (m: string) => void) => Promise<unknown> }> = [
    {
      site: 'private: resolve module',
      run: (debug) =>
        new PrivateRegistryPublisher(
          async () => ({ status: 500, body: HOSTILE }),
          privateOptions,
          () => {},
          debug,
        ).publish(),
    },
    {
      site: 'private: trigger sync',
      run: (debug) => {
        let call = 0
        return new PrivateRegistryPublisher(
          async (): Promise<HttpResponse> =>
            ++call === 1 ? { status: 200, body: '{"id":"mod-1"}' } : { status: 500, body: HOSTILE },
          privateOptions,
          () => {},
          debug,
        ).publish()
      },
    },
    {
      site: 'hcp: create module',
      run: (debug) => {
        let call = 0
        return new HcpPublisher(
          async (): Promise<HttpResponse> =>
            ++call === 1 ? { status: 404, body: '{}' } : { status: 500, body: HOSTILE },
          hcpOptions,
          () => {},
          debug,
        ).publish()
      },
    },
    {
      site: 'hcp: create version',
      run: (debug) => {
        let call = 0
        return new HcpPublisher(
          async (): Promise<HttpResponse> =>
            ++call === 1
              ? { status: 200, body: '{"data":{"attributes":{"vcs-repo":{"branch":"main"}}}}' }
              : { status: 500, body: HOSTILE },
          { ...hcpOptions, vcsBranch: 'main' },
          () => {},
          debug,
        ).publish()
      },
    },
  ]

  it.each(cases)('$site bounds the body it puts in the failure', async ({ run }) => {
    const debug = vi.fn()
    const error = await run(debug).then(
      () => undefined,
      (e: unknown) => e as Error,
    )
    expect(error).toBeInstanceOf(Error)
    // Bounded and stripped in the message the runner renders...
    expect(error!.message.length).toBeLessThan(800)
    expect(error!.message).not.toContain('')
    expect(error!.message).toMatch(/more characters truncated/)
    // ...and the whole body kept on the debug channel, which core.debug
    // suppresses unless ACTIONS_STEP_DEBUG is set.
    expect(debug).toHaveBeenCalledWith(expect.stringContaining(HOSTILE))
  })
})

describe('remote JSON is parsed defensively', () => {
  it('names the response and shows a bounded excerpt instead of a bare SyntaxError', () => {
    // What a WAF, a captive portal or a proxy interstitial answers 2xx with.
    expect(() => parseJson('<html><body>Access denied</body></html>', 'The registry module response'))
      .toThrow('The registry module response was not valid JSON: <html><body>Access denied</body></html>')
  })

  it('does not let a hostile non-JSON body choose the size of the message', () => {
    const error = (() => {
      try {
        parseJson('<'.repeat(50_000), 'The registry module response')
        return undefined
      } catch (e) {
        return e as Error
      }
    })()
    expect(error!.message.length).toBeLessThan(800)
  })

  it('parses a well-formed body unchanged', () => {
    expect(parseJson<{ id: string }>('{"id":"mod-1"}', 'The registry module response')).toEqual({
      id: 'mod-1',
    })
  })

  /**
   * `?? []` substitutes only for null/undefined. A TRUTHY non-array reached
   * `.find`/`.some` and threw `TypeError: ... is not a function` from inside
   * the wait loop — a low-level error unrelated to what the operator did.
   * Both structural twins are driven over the same rows.
   */
  const shapes: Array<[string, string]> = [
    ['a string', '"notarray"'],
    ['an object', '{"1.2.3":"ok"}'],
    ['a number', '7'],
    ['true', 'true'],
  ]

  it.each(shapes)('versionStatus treats %s as no known status', (_label, value) => {
    const body = `{"data":{"attributes":{"version-statuses":${value}}}}`
    expect(() => versionStatus(body, '1.2.3')).not.toThrow()
    expect(versionStatus(body, '1.2.3')).toBeUndefined()
  })

  it.each(shapes)('hasVersion treats %s as no version', (_label, value) => {
    const body = `{"versions":${value}}`
    expect(() => hasVersion(body, '1.2.3')).not.toThrow()
    expect(hasVersion(body, '1.2.3')).toBe(false)
  })

  it('still reads a status out of a well-formed array', () => {
    expect(
      versionStatus('{"data":{"attributes":{"version-statuses":[{"version":"1.2.3","status":"ok"}]}}}', '1.2.3'),
    ).toBe('ok')
  })

  it('still finds a version in a well-formed array', () => {
    expect(hasVersion('{"versions":[{"version":"1.2.3"}]}', '1.2.3')).toBe(true)
  })

  it('tolerates null entries inside an otherwise well-formed array', () => {
    expect(versionStatus('{"data":{"attributes":{"version-statuses":[null]}}}', '1.2.3')).toBeUndefined()
    expect(hasVersion('{"versions":[null]}', '1.2.3')).toBe(false)
  })
})
