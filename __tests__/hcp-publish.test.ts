import { describe, expect, it } from 'vitest'
import { HcpPublisher, publishMode, requiresContentUpload, vcsModuleBody } from '../src/hcp-publisher'
import type { HcpOptions } from '../src/hcp-publisher'
import type { HttpResponse } from '../src/http'

/**
 * The class test for "did the publish this action reports actually happen".
 *
 * HCP takes module versions two ways, and the action must not treat them the
 * same. A TAG-based VCS module gets its versions from pushed git tags; a
 * BRANCH-based or no-VCS module gets a version from `POST .../versions` that
 * stays at status `pending` until a gzipped module archive is PUT to the
 * `links.upload` URL in the response. This action does not upload module
 * content, so the only two honest outcomes are: complete the tag-based publish,
 * or fail the upload-driven one — never announce a version that HCP is holding
 * at `pending`.
 *
 * The rows drive the publisher through a fake HTTP client and assert on BOTH
 * the outcome and the exact requests issued, because "did not POST versions for
 * a tag-based module" is half of what makes the flow correct.
 */

const UPLOAD_URL = 'https://archivist.terraform.io/v1/object/dmF1bHQ6c2VjcmV0LWNhcGFiaWxpdHk'

const MODULE_URL =
  'https://app.terraform.io/api/v2/organizations/myorg/registry-modules/private/myorg/vpc/aws'
const VERSIONS_URL = `${MODULE_URL}/versions`
const VCS_URL = 'https://app.terraform.io/api/v2/organizations/myorg/registry-modules/vcs'

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
  waitForPublish: false,
  timeoutSeconds: 1,
  ...over,
})

/** Responses per URL, consumed in order; the last one repeats for further polls. */
type Script = Record<string, HttpResponse[]>

/** Replays a script and records the requests that consumed it. */
function fakeHttp(script: Script) {
  const calls: string[] = []
  const remaining: Script = Object.fromEntries(
    Object.entries(script).map(([url, responses]) => [url, [...responses]]),
  )
  const http = async (method: string, url: string): Promise<HttpResponse> => {
    calls.push(`${method} ${url}`)
    const queue = remaining[url]
    if (!queue?.length) throw new Error(`unscripted request: ${method} ${url}`)
    return queue.length === 1 ? queue[0] : queue.shift()!
  }
  return { http, calls }
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
    ['a version answered with an upload URL needs content', versionPending, true],
    ['a version answered without one does not', JSON.stringify({ data: { attributes: {} } }), false],
    ['an empty upload URL does not', JSON.stringify({ data: { links: { upload: '' } } }), false],
    ['a non-JSON body does not', 'not json at all', false],
    ['an empty body does not', '', false],
  ])('%s', (_what, body, expected) => {
    expect(requiresContentUpload(body)).toBe(expected)
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
    what: 'branch-based: a version held at pending fails the step instead of reporting a publish',
    over: { vcsBranch: 'main' },
    script: {
      [MODULE_URL]: [ok(branchBasedModule)],
      [VERSIONS_URL]: [{ status: 201, body: versionPending }],
    },
    reject: "status 'pending'",
    calls: [`GET ${MODULE_URL}`, `POST ${VERSIONS_URL}`],
  },
  {
    what: 'no-VCS module: the same upload requirement fails the step',
    script: {
      [MODULE_URL]: [ok(noVcsModule)],
      [VERSIONS_URL]: [{ status: 201, body: versionPending }],
    },
    reject: "status 'pending'",
    calls: [`GET ${MODULE_URL}`, `POST ${VERSIONS_URL}`],
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
    what: 'a missing module created WITH a branch goes down the upload-driven path and fails closed',
    over: { vcsBranch: 'main' },
    script: {
      [MODULE_URL]: [{ status: 404, body: '' }],
      [VCS_URL]: [{ status: 201, body: '{}' }],
      [VERSIONS_URL]: [{ status: 201, body: versionPending }],
    },
    reject: "status 'pending'",
    calls: [`GET ${MODULE_URL}`, `POST ${VCS_URL}`, `POST ${VERSIONS_URL}`],
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
    const publisher = new HcpPublisher(http, options(row.over), () => {})
    if (row.reject) {
      await expect(publisher.publish()).rejects.toThrow(row.reject)
    } else {
      const result = await publisher.publish()
      expect(result.published).toBe(row.published)
      expect(result.message).toMatch(row.message as RegExp)
    }
    expect(calls).toEqual(row.calls)
  })

  it('never echoes the archivist upload URL, which is a bearer capability', async () => {
    const { http } = fakeHttp({
      [MODULE_URL]: [ok(branchBasedModule)],
      [VERSIONS_URL]: [{ status: 201, body: versionPending }],
    })
    const logged: string[] = []
    const publisher = new HcpPublisher(http, options({ vcsBranch: 'main' }), (m) => logged.push(m))
    const error = await publisher.publish().then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toContain("status 'pending'")
    expect(error!.message).not.toContain(UPLOAD_URL)
    expect(logged.join('\n')).not.toContain(UPLOAD_URL)
  })
})
