import { describe, expect, it, vi } from 'vitest'
import { HcpPublisher } from '../src/hcp-publisher'
import type { HcpOptions } from '../src/hcp-publisher'
import { PrivateRegistryPublisher } from '../src/private-publisher'
import type { PrivateRegistryOptions } from '../src/private-publisher'
import { pollUntil } from '../src/http'
import type { HttpResponse } from '../src/http'

/**
 * The `published` output means what action.yml and the README say it means, and
 * an unexpected registry status is not absorbed.
 *
 * Neither property had a test. `published` was documented as `"false" if it
 * already existed` while the private path had two return points, both
 * `published: true` — it could not produce false for ANY input — and the HCP
 * module check logged a 401/403/429/5xx and carried on, so the consumer's error
 * named the follow-up request instead of the cause.
 */

const MODULE_URL = 'https://reg.example.com/api/v1/modules/myorg/vpc/aws'

function privateOptions(overrides: Partial<PrivateRegistryOptions> = {}): PrivateRegistryOptions {
  return {
    namespace: 'myorg',
    name: 'vpc',
    provider: 'aws',
    version: '1.2.3',
    registryUrl: 'https://reg.example.com',
    apiKey: 'k',
    waitForPublish: false,
    timeoutSeconds: 30,
    ...overrides,
  }
}

/** A fake client answering from a queue and recording what was asked of it. */
function client(responses: HttpResponse[]): {
  http: (method: string, url: string) => Promise<HttpResponse>
  requests: string[]
} {
  const requests: string[] = []
  let i = 0
  return {
    requests,
    http: async (method: string, url: string) => {
      requests.push(`${method} ${url}`)
      return responses[Math.min(i++, responses.length - 1)]
    },
  }
}

const moduleBody = (versions: string[]) =>
  JSON.stringify({ id: '2f4a2c6e-0000-4000-8000-000000000001', versions: versions.map((version) => ({ version })) })

describe('private registry: published reports what actually happened', () => {
  it('a version the registry already had reports published=false', async () => {
    const { http, requests } = client([
      { status: 200, body: moduleBody(['1.2.3']) },
      { status: 202, body: '' },
    ])
    const result = await new PrivateRegistryPublisher(http, privateOptions(), () => {}).publish()

    expect(result.published).toBe(false)
    expect(result.message).toMatch(/already existed/)
    // The sync is idempotent and is still triggered: what changed is the
    // report, not what the action does to the registry.
    expect(requests.some((r) => r.includes('/scm/sync'))).toBe(true)
  })

  it('a version the registry did not have reports published=true', async () => {
    const { http } = client([
      { status: 200, body: moduleBody(['1.2.2']) },
      { status: 202, body: '' },
    ])
    const result = await new PrivateRegistryPublisher(http, privateOptions(), () => {}).publish()
    expect(result.published).toBe(true)
  })

  it('with wait-for-publish the already-existing case still reports false', async () => {
    const { http } = client([
      { status: 200, body: moduleBody(['1.2.3']) },
      { status: 202, body: '' },
      { status: 200, body: moduleBody(['1.2.3']) },
    ])
    const result = await new PrivateRegistryPublisher(
      http,
      privateOptions({ waitForPublish: true }),
      () => {},
    ).publish()
    expect(result.published).toBe(false)
  })

  it('names the failing stage once, from the shared formatter', async () => {
    const { http } = client([{ status: 500, body: 'registry exploded' }])
    await expect(new PrivateRegistryPublisher(http, privateOptions(), () => {}).publish()).rejects.toThrow(
      /Failed to resolve module \(HTTP 500\): registry exploded/,
    )
  })
})

describe('HCP: an unexpected module-check status fails at the cause', () => {
  function hcpOptions(): HcpOptions {
    return {
      namespace: 'myorg',
      name: 'vpc',
      provider: 'aws',
      version: '1.2.3',
      address: 'https://app.terraform.io',
      token: 't',
      vcsRepoIdentifier: 'myorg/terraform-aws-vpc',
      vcsBranch: '',
      vcsOauthTokenId: 'ot-1',
      commitSha: 'abc',
      waitForPublish: false,
      timeoutSeconds: 30,
    }
  }

  it.each([401, 403, 429, 500, 503])('HTTP %i stops the publish naming the check', async (status) => {
    const { http, requests } = client([{ status, body: 'nope' }])
    await expect(new HcpPublisher(http, hcpOptions(), () => {}).publish()).rejects.toThrow(
      new RegExp(`Failed to check the existing HCP module \\(HTTP ${status}\\)`),
    )
    // and it did not go on to issue the follow-up request whose failure used to
    // be the only thing the consumer saw.
    expect(requests).toHaveLength(1)
  })
})

describe('pollUntil: a transient failure does not abort a publish that already succeeded', () => {
  it('retries a rejected attempt until the predicate passes', async () => {
    let attempt = 0
    const seen: string[] = []
    const ok = await pollUntil(
      async () => {
        attempt++
        if (attempt < 3) throw new Error('ECONNRESET')
        return true
      },
      30,
      (m) => seen.push(m),
      1,
    )
    expect(ok).toBe(true)
    expect(attempt).toBe(3)
    expect(seen.join(' ')).toMatch(/retrying until the deadline/)
  })

  it('gives up at the deadline rather than looping forever', async () => {
    const ok = await pollUntil(async () => false, 0, () => {}, 1)
    expect(ok).toBe(false)
  })

  it('a failure past the deadline is not retried', async () => {
    let attempt = 0
    const ok = await pollUntil(
      async () => {
        attempt++
        throw new Error('ENOTFOUND')
      },
      0,
      () => {},
      1,
    )
    expect(ok).toBe(false)
    expect(attempt).toBe(1)
  })
})
