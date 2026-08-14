import * as core from '@actions/core'
import { createHostAuthorizer } from './egress'
import { createHttpsClient, describeError, resolveTlsTrust } from './http'
import { RegistryPublisher, RegistryType } from './types'
import { PrivateRegistryPublisher } from './private-publisher'
import { HcpPublisher } from './hcp-publisher'

function required(name: string): string {
  const value = core.getInput(name, { required: true })
  if (!value) throw new Error(`Input '${name}' is required.`)
  return value
}

function parseTimeout(): number {
  const parsed = parseInt(core.getInput('timeout-seconds') || '180', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180
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
  const registryType = required('registry-type') as RegistryType
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

  if (registryType === 'private') {
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

  if (registryType === 'hcp') {
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
        waitForPublish,
        timeoutSeconds,
      },
      core.info,
      core.debug,
    )
  }

  throw new Error(`Unsupported registry-type '${registryType}'. Expected 'hcp' or 'private'.`)
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
