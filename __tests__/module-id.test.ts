import { describe, expect, it, vi } from 'vitest'
import { PrivateRegistryPublisher, syncUrl } from '../src/private-publisher'
import type { HttpResponse } from '../src/http'

/**
 * The class test for a RESPONSE-derived value reaching the path of an
 * authenticated request.
 *
 * `moduleId` is not an author input: it is read out of the registry's own JSON
 * and then spliced into the path of an admin POST that carries the same
 * `Authorization: Bearer <api-key>` as the call that produced it. So the rows
 * below are what a hostile, spoofed or compromised registry can put in `id` —
 * traversal in raw and percent-encoded spellings, each URL-structural
 * character, whitespace, and nothing at all — plus the ordinary UUID the real
 * registry mints, which must keep working.
 *
 * The expectation for every hostile row is a REJECTION, not a sanitized URL:
 * the registry issues UUIDs, so an id that needs escaping means the peer is
 * misbehaving, and encoding it would send the credentialed admin request
 * anyway at that peer's direction.
 */

interface IdRow {
  what: string
  id: string
  /**
   * The path, and the query string, that the unguarded construction actually
   * puts on the wire as resolved by Node's own URL parser — a fragment is never
   * sent. Present on the rows where the authenticated POST would land somewhere
   * other than the intended admin endpoint for that id.
   */
  wirePath?: string
  wireQuery?: string
  accept?: true
}

const ID_ROWS: IdRow[] = [
  // --- traversal: dot-segments are resolved by the WHATWG URL parser, so each
  //     '../' strips a real segment off the intended admin namespace ---
  {
    what: "raw traversal '../'",
    id: '../',
    wirePath: '/api/v1/admin//scm/sync',
  },
  {
    what: 'traversal climbing out of the admin namespace',
    id: 'abc/../../../users/1',
    wirePath: '/api/v1/users/1/scm/sync',
  },
  {
    what: 'bare dot-dot segment',
    id: '..',
    wirePath: '/api/v1/admin/scm/sync',
  },
  // --- URL-encoded traversal: not decoded by the parser, but it is not an id
  //     shape either, and a registry that percent-decodes its own paths would
  //     resolve it server-side ---
  { what: 'URL-encoded traversal (%2e%2e%2f)', id: '%2e%2e%2f' },
  { what: 'URL-encoded traversal, mixed case (%2E%2E/)', id: '%2E%2E/' },

  // --- structural characters: each one re-shapes the request ---
  {
    what: "a path separator '/'",
    id: 'mod-123/extra',
    wirePath: '/api/v1/admin/modules/mod-123/extra/scm/sync',
  },
  {
    what: "a query introducer '?' (the intended suffix slides into the query string)",
    id: '1?ownerId=2',
    wirePath: '/api/v1/admin/modules/1',
    wireQuery: '?ownerId=2/scm/sync',
  },
  {
    what: "a fragment introducer '#' (truncates the intended suffix off the wire)",
    id: '1#',
    wirePath: '/api/v1/admin/modules/1',
  },
  {
    what: "'?' and '#' together: a live query parameter, and '/scm/sync' never sent",
    id: '1?ownerId=2#',
    wirePath: '/api/v1/admin/modules/1',
    wireQuery: '?ownerId=2',
  },

  // --- whitespace and emptiness ---
  { what: 'an embedded space', id: 'mod 123' },
  { what: 'leading/trailing whitespace', id: '  mod-123  ' },
  { what: 'a newline (request-splitting shape)', id: 'mod-123\nX-Injected: 1' },
  { what: 'a tab', id: 'mod\t123' },
  { what: 'the empty string', id: '' },

  // --- the legitimate values, which must NOT be rejected ---
  {
    what: 'the UUID the registry actually mints',
    id: '3f2a1b4c-9d8e-4f01-a234-56789abcdef0',
    accept: true,
  },
  { what: 'a simple slug id', id: 'mod-123', accept: true },
  { what: 'a purely numeric id', id: '42', accept: true },
  { what: 'an id containing dots and underscores', id: 'mod.1_2-3', accept: true },
]

describe('registry-supplied module id in the admin sync path', () => {
  it.each(ID_ROWS)('$what', (row) => {
    if (row.accept) {
      expect(syncUrl('https://reg.example.com', row.id)).toBe(
        `https://reg.example.com/api/v1/admin/modules/${row.id}/scm/sync`,
      )
      return
    }
    expect(() => syncUrl('https://reg.example.com', row.id)).toThrow(
      'The module id in the registry response',
    )
  })

  /**
   * Proves the rows are not hypothetical: without the guard these ids really do
   * move the credentialed POST somewhere else, as Node's own URL parser
   * resolves them.
   */
  it.each(ID_ROWS.filter((r) => r.wirePath))(
    'without the guard, $what puts a different request on the wire',
    (row) => {
      const parsed = new URL(`https://reg.example.com/api/v1/admin/modules/${row.id}/scm/sync`)
      expect(parsed.pathname).toBe(row.wirePath)
      expect(parsed.search).toBe(row.wireQuery ?? '')
      // Whatever endpoint receives the authenticated POST, it is NOT the id
      // sitting as one segment under the intended admin namespace — the id has
      // either climbed out of it, split it, or truncated it.
      expect(parsed.pathname.split('/')).not.toEqual([
        '', 'api', 'v1', 'admin', 'modules', row.id, 'scm', 'sync',
      ])
    },
  )
})

/** Records every URL the publisher asked for, so a refused sync is provably not sent. */
function publisherWith(moduleBody: string): { publish: () => Promise<unknown>; calls: string[] } {
  const calls: string[] = []
  const http = vi.fn(async (method: string, url: string): Promise<HttpResponse> => {
    calls.push(`${method} ${url}`)
    return url.includes('/scm/sync') ? { status: 202, body: '' } : { status: 200, body: moduleBody }
  })
  const publisher = new PrivateRegistryPublisher(
    http,
    {
      namespace: 'myorg',
      name: 'vpc',
      provider: 'aws',
      version: '1.2.3',
      registryUrl: 'https://reg.example.com',
      apiKey: 'secret',
      waitForPublish: false,
      timeoutSeconds: 1,
    },
    () => {},
  )
  return { publish: () => publisher.publish(), calls }
}

describe('the publisher refuses a hostile id before issuing the authenticated POST', () => {
  it('does not send the credentialed admin request when the id is hostile', async () => {
    const { publish, calls } = publisherWith(JSON.stringify({ id: 'abc/../../../users/1' }))
    await expect(publish()).rejects.toThrow('The module id in the registry response')
    // Exactly the first GET: the Bearer credential never reached the redirected path.
    expect(calls).toEqual(['GET https://reg.example.com/api/v1/modules/myorg/vpc/aws'])
  })

  it('still publishes normally against a well-formed id', async () => {
    const { publish, calls } = publisherWith(
      JSON.stringify({ id: '3f2a1b4c-9d8e-4f01-a234-56789abcdef0' }),
    )
    await expect(publish()).resolves.toMatchObject({ published: true })
    expect(calls).toEqual([
      'GET https://reg.example.com/api/v1/modules/myorg/vpc/aws',
      'POST https://reg.example.com/api/v1/admin/modules/3f2a1b4c-9d8e-4f01-a234-56789abcdef0/scm/sync',
    ])
  })
})
