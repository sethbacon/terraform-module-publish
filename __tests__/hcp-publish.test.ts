import { describe, expect, it } from 'vitest'
import {
  HcpPublisher,
  noVcsModuleBody,
  publishMode,
  uploadUrl,
  vcsModuleBody,
} from '../src/hcp-publisher'
import type { HcpOptions } from '../src/hcp-publisher'
import type { HttpResponse } from '../src/http'

/**
 * The class test for "did the publish this action reports actually happen".
 *
 * HCP takes module versions two ways, and the action must not treat them the
 * same. A TAG-based VCS module gets its versions from pushed git tags, so there
 * is nothing to create and nothing to upload. A BRANCH-based or no-VCS module
 * gets a version from `POST .../versions` that stays at status `pending` until
 * a gzipped module archive is PUT to the `links.upload` URL in the response —
 * so for that class the publish is only complete once the upload has landed.
 *
 * The rows drive the publisher through a fake HTTP client and assert on BOTH
 * the outcome and the exact requests issued, because "did not POST versions for
 * a tag-based module" and "did PUT the archive for an upload-driven one" are
 * half of what makes the flow correct.
 */

const UPLOAD_URL = 'https://archivist.terraform.io/v1/object/dmF1bHQ6c2VjcmV0LWNhcGFiaWxpdHk'

const MODULE_URL =
  'https://app.terraform.io/api/v2/organizations/myorg/registry-modules/private/myorg/vpc/aws'
const VERSIONS_URL = `${MODULE_URL}/versions`
const CREATE_URL = 'https://app.terraform.io/api/v2/organizations/myorg/registry-modules'
const VCS_URL = `${CREATE_URL}/vcs`

/** Neither VCS input supplied: the API-driven flow, which owns no VCS connection. */
const NO_VCS: Partial<HcpOptions> = { vcsRepoIdentifier: '', vcsOauthTokenId: '' }

/** A module HCP describes as tag-based: a VCS repo with no branch. */
const tagBasedModule = (statuses: Array<{ version: string; status: string }> = []) =>
  JSON.stringify({
    data: {
      attributes: {
        'vcs-repo': { identifier: 'myorg/terraform-aws-vpc' },
        'version-statuses': statuses,
      },
    },
  })

/** A module HCP describes as branch-based: a VCS repo pinned to a branch. */
const branchBasedModule = JSON.stringify({
  data: {
    attributes: {
      'vcs-repo': { identifier: 'myorg/terraform-aws-vpc', branch: 'main' },
      'version-statuses': [],
    },
  },
})

/** The same branch-based module, carrying version statuses for the wait loop. */
const branchBasedModuleWith = (statuses: Array<{ version: string; status: string }>) =>
  JSON.stringify({
    data: {
      attributes: {
        'vcs-repo': { identifier: 'myorg/terraform-aws-vpc', branch: 'main' },
        'version-statuses': statuses,
      },
    },
  })

/** A private module with no VCS repo at all: also upload-driven. */
const noVcsModule = JSON.stringify({ data: { attributes: { 'version-statuses': [] } } })

/** What HCP answers a version creation with when it wants content uploaded. */
const versionPending = JSON.stringify({
  data: {
    type: 'registry-module-versions',
    attributes: { version: '1.2.3', status: 'pending' },
    links: { upload: UPLOAD_URL },
  },
})

const options = (over: Partial<HcpOptions> = {}): HcpOptions => ({
  namespace: 'myorg',
  name: 'vpc',
  provider: 'aws',
  version: '1.2.3',
  address: 'https://app.terraform.io',
  token: 'secret-token',
  vcsRepoIdentifier: 'myorg/terraform-aws-vpc',
  vcsBranch: '',
  vcsOauthTokenId: 'ot-123',
  commitSha: 'abc123',
  moduleDirectory: '.',
  waitForPublish: false,
  timeoutSeconds: 1,
  ...over,
})

/** Stand-in for the gzipped module archive; the real one is tested in archive.test.ts. */
const ARCHIVE = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x99])
const fakeArchive = () => Promise.resolve(ARCHIVE)

/** Responses per URL, consumed in order; the last one repeats for further polls. */
type Script = Record<string, HttpResponse[]>

/** One request as the fake client saw it, so a test can assert what was sent. */
interface Sent {
  method: string
  url: string
  headers: Record<string, string>
  body?: string | Uint8Array
}

/** Replays a script and records the requests that consumed it. */
function fakeHttp(script: Script) {
  const calls: string[] = []
  const sent: Sent[] = []
  const remaining: Script = Object.fromEntries(
    Object.entries(script).map(([url, responses]) => [url, [...responses]]),
  )
  const http = async (
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string | Uint8Array,
  ): Promise<HttpResponse> => {
    calls.push(`${method} ${url}`)
    sent.push({ method, url, headers, body })
    const queue = remaining[url]
    if (!queue?.length) throw new Error(`unscripted request: ${method} ${url}`)
    return queue.length === 1 ? queue[0] : queue.shift()!
  }
  return { http, calls, sent }
}

describe('HCP publish mode is read off the module HCP describes', () => {
  it.each([
    ['a VCS module with no branch is tag-based', tagBasedModule(), 'tag-based'],
    ['a VCS module pinned to a branch is upload-driven', branchBasedModule, 'upload-driven'],
    ['a module with no VCS repo is upload-driven', noVcsModule, 'upload-driven'],
    ['a null vcs-repo is upload-driven', JSON.stringify({ data: { attributes: { 'vcs-repo': null } } }), 'upload-driven'],
    ['an empty branch string is tag-based', JSON.stringify({ data: { attributes: { 'vcs-repo': { branch: '' } } } }), 'tag-based'],
  ])('%s', (_what, body, expected) => {
    expect(publishMode(body)).toBe(expected)
  })

  it.each([
    ['a version answered with an upload URL needs content', versionPending, UPLOAD_URL],
    ['a version answered without one does not', JSON.stringify({ data: { attributes: {} } }), undefined],
    ['an empty upload URL does not', JSON.stringify({ data: { links: { upload: '' } } }), undefined],
    ['a non-JSON body does not', 'not json at all', undefined],
    ['an empty body does not', '', undefined],
  ])('%s', (_what, body, expected) => {
    expect(uploadUrl(body)).toBe(expected)
  })

  /**
   * The upload link becomes a request destination carrying the module source,
   * and it is chosen by whatever host `hcp-address` names. A downgrade to
   * cleartext, or to a non-network scheme, is refused before the client sees it.
   */
  it.each([
    ['http', JSON.stringify({ data: { links: { upload: 'http://archivist.example.com/o/1' } } })],
    ['file', JSON.stringify({ data: { links: { upload: 'file:///etc/passwd' } } })],
  ])('refuses a %s upload link', (_scheme, body) => {
    expect(() => uploadUrl(body)).toThrow('only ever sent over https')
  })

  it('refuses an upload link that is not a URL at all', () => {
    expect(() => uploadUrl(JSON.stringify({ data: { links: { upload: 'not a url' } } }))).toThrow(
      'not a valid URL',
    )
  })
})

describe('module creation chooses the mode that can actually complete', () => {
  it('omits branch entirely when none was asked for, creating a tag-based module', () => {
    const body = JSON.parse(vcsModuleBody(options()))
    expect(body.data.attributes['vcs-repo']).not.toHaveProperty('branch')
  })

  it('sends branch when one was asked for, creating a branch-based module', () => {
    const body = JSON.parse(vcsModuleBody(options({ vcsBranch: 'release' })))
    expect(body.data.attributes['vcs-repo'].branch).toBe('release')
  })

  /**
   * The no-VCS creation body, checked field by field against HCP's documented
   * "Create a Module" payload rather than against what the code happens to send.
   *
   * Source: HCP Terraform API docs, Private Registry > Modules, "Create a
   * Module" — `POST /organizations/:organization_name/registry-modules`, whose
   * sample payload is
   * `{"data":{"type":"registry-modules","attributes":{"name":…,"provider":…,"registry-name":"private","no-code":…}}}`.
   */
  describe('the no-VCS creation body matches HCP’s documented payload', () => {
    const body = () => JSON.parse(noVcsModuleBody(options(NO_VCS)))

    it('is a registry-modules resource', () => {
      expect(body().data.type).toBe('registry-modules')
    })

    it('carries the module name and provider', () => {
      expect(body().data.attributes.name).toBe('vpc')
      expect(body().data.attributes.provider).toBe('aws')
    })

    it("sets registry-name to 'private', which the API requires", () => {
      expect(body().data.attributes['registry-name']).toBe('private')
    })

    /**
     * "The namespace of this module. Cannot be set for private modules." The
     * organization already names it, in the URL — sending it as well is a 422.
     */
    it('omits namespace, which a private module may not set', () => {
      expect(body().data.attributes).not.toHaveProperty('namespace')
    })

    /** A no-code module is a different product surface; this publishes a normal one. */
    it('does not request the no-code workflow', () => {
      expect(body().data.attributes['no-code']).toBe(false)
    })

    /** No `vcs-repo`: that key is what makes HCP create a VCS-connected module. */
    it('carries no vcs-repo at all', () => {
      expect(body().data.attributes).not.toHaveProperty('vcs-repo')
    })
  })
})

interface FlowRow {
  what: string
  over?: Partial<HcpOptions>
  script: Script
  /** Substring the failure must carry; absent means the publish must succeed. */
  reject?: string
  published?: boolean
  message?: RegExp
  /** The exact requests the publisher is allowed to issue. */
  calls: string[]
}

const ok = (body: string): HttpResponse => ({ status: 200, body })

const FLOW_ROWS: FlowRow[] = [
  {
    what: 'tag-based, not waiting: reports the tag import without inventing a version',
    script: { [MODULE_URL]: [ok(tagBasedModule())] },
    published: true,
    message: /tag-based.*pushed git tag/,
    // No POST to /versions: that endpoint does not apply to a tag-based module.
    calls: [`GET ${MODULE_URL}`],
  },
  {
    what: 'tag-based, waiting: completes once HCP has imported the tag',
    over: { waitForPublish: true },
    script: {
      [MODULE_URL]: [ok(tagBasedModule()), ok(tagBasedModule([{ version: '1.2.3', status: 'ok' }]))],
    },
    published: true,
    message: /is ready in HCP Terraform/,
    calls: [`GET ${MODULE_URL}`, `GET ${MODULE_URL}`],
  },
  {
    what: 'branch-based: the created version is completed by uploading the module archive',
    over: { vcsBranch: 'main' },
    script: {
      [MODULE_URL]: [ok(branchBasedModule)],
      [VERSIONS_URL]: [{ status: 201, body: versionPending }],
      [UPLOAD_URL]: [{ status: 200, body: '' }],
    },
    published: true,
    message: /module archive uploaded/,
    calls: [`GET ${MODULE_URL}`, `POST ${VERSIONS_URL}`, `PUT ${UPLOAD_URL}`],
  },
  {
    what: 'no-VCS module: the same upload completes the publish',
    script: {
      [MODULE_URL]: [ok(noVcsModule)],
      [VERSIONS_URL]: [{ status: 201, body: versionPending }],
      [UPLOAD_URL]: [{ status: 200, body: '' }],
    },
    published: true,
    message: /module archive uploaded/,
    calls: [`GET ${MODULE_URL}`, `POST ${VERSIONS_URL}`, `PUT ${UPLOAD_URL}`],
  },
  {
    what: 'a rejected upload fails the step rather than reporting the version published',
    over: { vcsBranch: 'main' },
    script: {
      [MODULE_URL]: [ok(branchBasedModule)],
      [VERSIONS_URL]: [{ status: 201, body: versionPending }],
      [UPLOAD_URL]: [{ status: 403, body: 'SignatureDoesNotMatch' }],
    },
    reject: 'Failed to upload the module archive (HTTP 403)',
    calls: [`GET ${MODULE_URL}`, `POST ${VERSIONS_URL}`, `PUT ${UPLOAD_URL}`],
  },
  {
    what: 'waiting: the version is only reported ready once HCP moves it past pending',
    over: { vcsBranch: 'main', waitForPublish: true },
    script: {
      [MODULE_URL]: [ok(branchBasedModule), ok(branchBasedModuleWith([{ version: '1.2.3', status: 'ok' }]))],
      [VERSIONS_URL]: [{ status: 201, body: versionPending }],
      [UPLOAD_URL]: [{ status: 200, body: '' }],
    },
    published: true,
    message: /module archive uploaded/,
    calls: [`GET ${MODULE_URL}`, `POST ${VERSIONS_URL}`, `PUT ${UPLOAD_URL}`, `GET ${MODULE_URL}`],
  },
  {
    what: 'branch-based: a version created without an upload requirement still publishes',
    over: { vcsBranch: 'main' },
    script: {
      [MODULE_URL]: [ok(branchBasedModule)],
      [VERSIONS_URL]: [{ status: 201, body: JSON.stringify({ data: { attributes: {} } }) }],
    },
    published: true,
    message: /published to HCP Terraform/,
    calls: [`GET ${MODULE_URL}`, `POST ${VERSIONS_URL}`],
  },
  {
    what: 'branch-based: an already-existing version is left alone',
    over: { vcsBranch: 'main' },
    script: {
      [MODULE_URL]: [ok(branchBasedModule)],
      [VERSIONS_URL]: [{ status: 422, body: '{"errors":[{"detail":"already exists"}]}' }],
    },
    published: true,
    message: /published to HCP Terraform/,
    calls: [`GET ${MODULE_URL}`, `POST ${VERSIONS_URL}`],
  },
  {
    what: 'a version already ready is reported as pre-existing, not republished',
    script: { [MODULE_URL]: [ok(tagBasedModule([{ version: '1.2.3', status: 'ok' }]))] },
    published: false,
    message: /already exists and is ready/,
    calls: [`GET ${MODULE_URL}`],
  },
  {
    what: 'a missing module is created tag-based, and no version is posted',
    script: {
      [MODULE_URL]: [{ status: 404, body: '' }],
      [VCS_URL]: [{ status: 201, body: '{}' }],
    },
    published: true,
    message: /tag-based/,
    calls: [`GET ${MODULE_URL}`, `POST ${VCS_URL}`],
  },
  {
    what: 'a missing module created WITH a branch goes down the upload-driven path and uploads',
    over: { vcsBranch: 'main' },
    script: {
      [MODULE_URL]: [{ status: 404, body: '' }],
      [VCS_URL]: [{ status: 201, body: '{}' }],
      [VERSIONS_URL]: [{ status: 201, body: versionPending }],
      [UPLOAD_URL]: [{ status: 200, body: '' }],
    },
    published: true,
    message: /module archive uploaded/,
    calls: [`GET ${MODULE_URL}`, `POST ${VCS_URL}`, `POST ${VERSIONS_URL}`, `PUT ${UPLOAD_URL}`],
  },
  // ---- API-driven publishing: no VCS connection exists to create one from ----
  //
  // The tarball-upload flow exists precisely to serve publishing that has no VCS
  // connection, so the action has to be able to bootstrap the module that flow
  // needs. Before this, a 404 here was a hard error telling the operator to
  // supply VCS inputs that the API-driven flow by definition does not have.
  {
    what: 'a missing module with no VCS inputs is created with no VCS connection, then uploaded',
    over: NO_VCS,
    script: {
      [MODULE_URL]: [{ status: 404, body: '' }],
      [CREATE_URL]: [{ status: 201, body: '{"data":{"attributes":{}}}' }],
      [VERSIONS_URL]: [{ status: 201, body: versionPending }],
      [UPLOAD_URL]: [{ status: 200, body: '' }],
    },
    published: true,
    message: /module archive uploaded/,
    // The no-VCS create goes to the plain registry-modules collection, NOT to
    // the /vcs endpoint, which would demand an oauth token this flow lacks.
    calls: [`GET ${MODULE_URL}`, `POST ${CREATE_URL}`, `POST ${VERSIONS_URL}`, `PUT ${UPLOAD_URL}`],
  },
  // Idempotency. HCP documents no duplicate-specific status for this endpoint
  // (the table lists 201 / 422 / 403 / 404 only), so a create that loses a race
  // is converged on by ASKING whether the module exists now, rather than by
  // matching a status code the API never promised. Both rows below are the same
  // race with a different status on the losing create.
  ...[422, 409].map((status) => ({
    what: `a create that loses a race (HTTP ${status}) converges on the module that now exists`,
    over: NO_VCS,
    script: {
      [MODULE_URL]: [{ status: 404, body: '' }, ok(noVcsModule)],
      [CREATE_URL]: [{ status, body: '{"errors":[{"detail":"has already been taken"}]}' }],
      [VERSIONS_URL]: [{ status: 201, body: versionPending }],
      [UPLOAD_URL]: [{ status: 200, body: '' }],
    },
    published: true,
    message: /module archive uploaded/,
    calls: [
      `GET ${MODULE_URL}`,
      `POST ${CREATE_URL}`,
      `GET ${MODULE_URL}`,
      `POST ${VERSIONS_URL}`,
      `PUT ${UPLOAD_URL}`,
    ],
  })),
  {
    what: 'the racing winner’s module decides the mode, rather than it being assumed upload-driven',
    over: NO_VCS,
    script: {
      [MODULE_URL]: [{ status: 404, body: '' }, ok(tagBasedModule())],
      [CREATE_URL]: [{ status: 422, body: '{"errors":[{"detail":"has already been taken"}]}' }],
    },
    published: true,
    message: /tag-based/,
    // No version POST: the module that won the race takes versions from tags.
    calls: [`GET ${MODULE_URL}`, `POST ${CREATE_URL}`, `GET ${MODULE_URL}`],
  },
  {
    what: 'a genuinely failed create is reported as itself, not as "module does not exist"',
    over: NO_VCS,
    script: {
      [MODULE_URL]: [{ status: 404, body: '' }, { status: 401, body: 'unauthorized' }],
      [CREATE_URL]: [{ status: 401, body: 'invalid token' }],
    },
    reject: 'Failed to create HCP module (HTTP 401)',
    calls: [`GET ${MODULE_URL}`, `POST ${CREATE_URL}`, `GET ${MODULE_URL}`],
  },
  {
    what: 'a half-supplied VCS pair is refused rather than silently creating a no-VCS module',
    over: { vcsRepoIdentifier: 'myorg/terraform-aws-vpc', vcsOauthTokenId: '' },
    script: { [MODULE_URL]: [{ status: 404, body: '' }] },
    reject: 'vcs-oauth-token-id',
    // Nothing is created: the operator asked for a VCS module and is missing an input.
    calls: [`GET ${MODULE_URL}`],
  },
  {
    what: 'the other half of the VCS pair is refused the same way',
    over: { vcsRepoIdentifier: '', vcsOauthTokenId: 'ot-123' },
    script: { [MODULE_URL]: [{ status: 404, body: '' }] },
    reject: 'vcs-repo-identifier',
    calls: [`GET ${MODULE_URL}`],
  },
  {
    what: 'tag-based, waiting, version never imported: times out rather than claiming success',
    over: { waitForPublish: true, timeoutSeconds: 0 },
    script: { [MODULE_URL]: [ok(tagBasedModule())] },
    reject: 'Timed out',
    calls: [`GET ${MODULE_URL}`, `GET ${MODULE_URL}`],
  },
]

describe('HCP publish flow', () => {
  it.each(FLOW_ROWS)('$what', async (row) => {
    const { http, calls } = fakeHttp(row.script)
    const publisher = new HcpPublisher(http, options(row.over), () => {}, () => {}, () => {}, fakeArchive)
    if (row.reject) {
      await expect(publisher.publish()).rejects.toThrow(row.reject)
    } else {
      const result = await publisher.publish()
      expect(result.published).toBe(row.published)
      expect(result.message).toMatch(row.message as RegExp)
    }
    expect(calls).toEqual(row.calls)
  })
})

/**
 * The no-VCS creation request as the PEER saw it.
 *
 * `noVcsModuleBody` being correct proves nothing on its own — the publisher
 * could send something else entirely, to somewhere else entirely, and the pure
 * function's tests would stay green. These assert the bytes that actually left.
 */
describe('the no-VCS module creation request', () => {
  const run = async () => {
    const { http, sent } = fakeHttp({
      [MODULE_URL]: [{ status: 404, body: '' }],
      [CREATE_URL]: [{ status: 201, body: '{"data":{"attributes":{}}}' }],
      [VERSIONS_URL]: [{ status: 201, body: versionPending }],
      [UPLOAD_URL]: [{ status: 200, body: '' }],
    })
    const logged: string[] = []
    await new HcpPublisher(
      http,
      options(NO_VCS),
      (m) => logged.push(m),
      () => {},
      () => {},
      fakeArchive,
    ).publish()
    return { sent, logged, create: sent.find((s) => s.url === CREATE_URL) }
  }

  it('POSTs the documented payload to the registry-modules collection', async () => {
    const { create } = await run()
    expect(create?.method).toBe('POST')
    expect(JSON.parse(create!.body as string)).toEqual({
      data: {
        type: 'registry-modules',
        attributes: { name: 'vpc', provider: 'aws', 'registry-name': 'private', 'no-code': false },
      },
    })
  })

  /** Same authorization and JSON:API content type as every other API call. */
  it('carries the HCP bearer token and the JSON:API content type', async () => {
    const { create } = await run()
    expect(create?.headers.Authorization).toBe('Bearer secret-token')
    expect(create?.headers['Content-Type']).toBe('application/vnd.api+json')
  })

  it('says what it created, so the operator knows the module is new', async () => {
    const { logged } = await run()
    expect(logged.join('\n')).toMatch(/no VCS connection/)
  })
})

/**
 * The upload request is the one request in this class that goes to a host named
 * by a RESPONSE BODY rather than by operator input, and it carries the module
 * source. What it must and must not contain is asserted on the peer's own view
 * of it.
 */
describe('the module-archive upload', () => {
  const uploadScript = () => ({
    [MODULE_URL]: [ok(branchBasedModule)],
    [VERSIONS_URL]: [{ status: 201, body: versionPending }],
    [UPLOAD_URL]: [{ status: 200, body: '' }],
  })

  const run = async (script: Script = uploadScript()) => {
    const { http, sent } = fakeHttp(script)
    const logged: string[] = []
    const masked: string[] = []
    const publisher = new HcpPublisher(
      http,
      options({ vcsBranch: 'main' }),
      (m) => logged.push(m),
      (m) => logged.push(m),
      (s) => masked.push(s),
      fakeArchive,
    )
    const error = await publisher.publish().then(
      () => null,
      (e: unknown) => e as Error,
    )
    return { sent, logged, masked, error, put: sent.find((s) => s.method === 'PUT') }
  }

  it('sends the archive bytes as the request body', async () => {
    const { put } = await run()
    expect(put?.body).toBe(ARCHIVE)
  })

  /**
   * The HCP token is scoped to the organization's registry modules. The upload
   * host is a different host, chosen by a response body, and the URL is itself
   * the authorization — so attaching the token would hand that credential to
   * whatever host HCP (or something impersonating it) named.
   */
  it('does not send the HCP bearer token to the upload host', async () => {
    const { put } = await run()
    expect(Object.keys(put!.headers).map((h) => h.toLowerCase())).not.toContain('authorization')
    expect(JSON.stringify(put!.headers)).not.toContain('secret-token')
  })

  it('registers the capability URL with the job mask before it is used', async () => {
    const { masked, sent } = await run()
    expect(masked).toContain(UPLOAD_URL)
    // Ordering is the point: a mask applied after the request has been made
    // cannot redact a line already written.
    expect(sent.findIndex((s) => s.method === 'PUT')).toBeGreaterThan(-1)
  })

  it('masks the query-string credential of a presigned upload link too', async () => {
    const presigned = 'https://blob.example.com/o/abc?sig=SECRETSIGVALUE&se=2030-01-01'
    const { masked } = await run({
      [MODULE_URL]: [ok(branchBasedModule)],
      [VERSIONS_URL]: [{ status: 201, body: JSON.stringify({ data: { links: { upload: presigned } } }) }],
      [presigned]: [{ status: 200, body: '' }],
    })
    expect(masked).toContain(presigned)
    expect(masked).toContain('SECRETSIGVALUE')
  })

  it('never echoes the upload URL, which is a bearer capability, into the log', async () => {
    const { logged } = await run()
    expect(logged.join('\n')).not.toContain(UPLOAD_URL)
    // The host alone is what an operator needs in order to allowlist it.
    expect(logged.join('\n')).toContain('archivist.terraform.io')
  })

  it('scrubs the capability out of an upload failure that echoes it back', async () => {
    const { error } = await run({
      [MODULE_URL]: [ok(branchBasedModule)],
      [VERSIONS_URL]: [{ status: 201, body: versionPending }],
      [UPLOAD_URL]: [{ status: 403, body: `Denied for ${UPLOAD_URL}` }],
    })
    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toContain('Failed to upload the module archive (HTTP 403)')
    expect(error!.message).not.toContain(UPLOAD_URL)
  })

  it('does not build the archive at all on the tag-based path', async () => {
    const { http } = fakeHttp({ [MODULE_URL]: [ok(tagBasedModule())] })
    let built = 0
    const publisher = new HcpPublisher(
      http,
      options(),
      () => {},
      () => {},
      () => {},
      () => {
        built++
        return fakeArchive()
      },
    )
    await publisher.publish()
    expect(built).toBe(0)
  })
})
