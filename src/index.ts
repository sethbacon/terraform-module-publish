import * as core from '@actions/core'
import { createHostAuthorizer } from './egress'
import { createHttpsClient, describeError, resolveTlsTrust } from './http'
import { RegistryPublisher, RegistryType } from './types'
import { PrivateRegistryPublisher } from './private-publisher'
import { HcpPublisher } from './hcp-publisher'

/**
 * Reads a conditionally-required input, failing with a message that names it.
 *
 * No `{ required: true }`: `core.getInput` throws its own generic "Input
 * required and not supplied: x" one line EARLIER on the same condition, so the
 * specific message below was unreachable at all eight call sites and no
 * consumer ever saw it. Since half these inputs are required only for one
 * `registry-type`, the message worth showing is the one that can say so.
 */
function required(name: string): string {
  const value = core.getInput(name)
  if (!value) {
    throw new Error(`Input '${name}' is required for registry-type '${core.getInput('registry-type')}'.`)
  }
  return value
}

const DEFAULT_TIMEOUT_SECONDS = 180

/**
 * `timeout-seconds`, with an invalid value reported rather than absorbed.
 *
 * `"0"`, `"-5"` and `"abc"` all silently became 180 — so an author who set
 * `timeout-seconds: "0"` expecting a no-wait check waited the full three
 * minutes with nothing in the log saying their value had been discarded.
 */
function parseTimeout(): number {
  const raw = core.getInput('timeout-seconds').trim()
  if (!raw) return DEFAULT_TIMEOUT_SECONDS
  // Shape-checked, not just parseInt'd: parseInt stops at the first
  // non-digit, so '1.5.2' became 1 and '30s' became 30 — a silently different
  // timeout rather than a rejected value, which is the same defect one step
  // quieter.
  const parsed = /^[0-9]+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isFinite(parsed) || parsed <= 0) {
    core.warning(
      `timeout-seconds: '${raw}' is not a positive whole number; using the ` +
        `${DEFAULT_TIMEOUT_SECONDS}s default. Set wait-for-publish: false to not wait at all.`,
    )
    return DEFAULT_TIMEOUT_SECONDS
  }
  return parsed
}

const REGISTRY_TYPES: readonly RegistryType[] = ['hcp', 'private']

/**
 * Narrows `registry-type` only after checking it.
 *
 * The value was `as RegistryType`-cast at the top of buildPublisher and not
 * actually validated until an else-throw forty lines later, so between those
 * points the type asserted something nothing had established — and any code
 * inserted in between would have been type-checked against a lie.
 */
function registryType(): RegistryType {
  const value = required('registry-type')
  if (!REGISTRY_TYPES.includes(value as RegistryType)) {
    throw new Error(`Unsupported registry-type '${value}'. Expected 'hcp' or 'private'.`)
  }
  return value as RegistryType
}

/**
 * Registers BOTH registry credentials with the job's mask, before any other
 * input is read or validated.
 *
 * The mask is job-scoped and cannot be applied retroactively, so where this
 * call sits decides how much of the run is covered. It used to sit inside the
 * `registry-type` branch that consumes the credential, after five other inputs
 * had been read: a typo'd registry-type (`Private`), a missing coordinate, a
 * non-boolean `wait-for-publish` or a `skip-tls-verify` refusal all threw
 * BEFORE any `::add-mask::` was issued, leaving the supplied key unmasked for
 * the remainder of the job. Symmetrically, a reusable workflow that passes
 * every input through left the unused credential unmasked on the branch that
 * did not consume it.
 *
 * This matters for credentials the runner does not mask on its own — a
 * vault-action output, a `vars.` value, a value read from a file — which is
 * precisely the case this call exists to cover, since a `secrets.` value is
 * already masked without it.
 */
function maskCredentials(): void {
  for (const name of ['api-key', 'hcp-token']) {
    const value = core.getInput(name)
    if (value) core.setSecret(value)
  }
}

function buildPublisher(): RegistryPublisher {
  const type = registryType()
  const coordinates = {
    namespace: required('namespace'),
    name: required('name'),
    provider: required('provider'),
    version: required('version'),
  }
  const waitForPublish = core.getBooleanInput('wait-for-publish')
  const timeoutSeconds = parseTimeout()
  // One egress decision for the run, applied by the client to the initial URL
  // and to every redirect hop of every request it makes.
  const authorizeHost = createHostAuthorizer(core.getInput('registry-allowed-hosts'))
  // Resolved for every registry type, not just the one that used to read it, so
  // that `skip-tls-verify` is refused wherever it is set rather than silently
  // ignored on the HCP path.
  const tlsTrust = resolveTlsTrust(core.getInput('skip-tls-verify'), core.getInput('ca-cert'))

  if (type === 'private') {
    return new PrivateRegistryPublisher(
      createHttpsClient(authorizeHost, tlsTrust),
      {
        ...coordinates,
        registryUrl: required('registry-url'),
        apiKey: required('api-key'),
        waitForPublish,
        timeoutSeconds,
      },
      core.info,
      core.debug,
    )
  }

  if (type === 'hcp') {
    return new HcpPublisher(
      createHttpsClient(authorizeHost, tlsTrust),
      {
        ...coordinates,
        address: core.getInput('hcp-address') || 'https://app.terraform.io',
        token: required('hcp-token'),
        vcsRepoIdentifier: core.getInput('vcs-repo-identifier') || '',
        // Empty by design: a module created without a branch is tag-based, and
        // HCP imports its versions from pushed tags. The former 'main' default
        // made every module branch-based, whose versions need a module-archive
        // upload this action does not perform.
        vcsBranch: core.getInput('vcs-branch') || '',
        vcsOauthTokenId: core.getInput('vcs-oauth-token-id') || '',
        // Falls back to the commit the workflow is running on rather than
        // staying empty. `commit-sha` is what ties the registry's version
        // record back to a commit, and the input is optional — so a workflow
        // that never sets it (both README examples did not) created versions
        // with no provenance at all. GITHUB_SHA is set by the runner for every
        // event, so the binding is present by default and an operator who
        // needs a different commit still overrides it.
        commitSha: core.getInput('commit-sha') || process.env.GITHUB_SHA || '',
        // The module root uploaded when HCP holds the created version at
        // 'pending' pending content. Defaults to the workspace, which for the
        // one-module-per-repo layout the registry convention assumes IS the
        // module.
        moduleDirectory: core.getInput('module-directory') || '.',
        waitForPublish,
        timeoutSeconds,
      },
      core.info,
      core.debug,
      core.setSecret,
    )
  }

  // Unreachable: registryType() already refused anything outside the union.
  // Kept so the function is total for the compiler rather than relying on
  // control-flow analysis of a runtime check in another function.
  throw new Error(`Unsupported registry-type '${type as string}'.`)
}

async function run(): Promise<void> {
  try {
    maskCredentials()
    const result = await buildPublisher().publish()
    core.info(result.message)
    core.setOutput('published', String(result.published))
    core.setOutput('message', result.message)
  } catch (error) {
    core.setFailed(describeError(error))
  }
}

void run()
