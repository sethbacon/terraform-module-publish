import * as core from '@actions/core'
import { createHttpsClient } from './http'
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

  if (registryType === 'private') {
    const apiKey = required('api-key')
    core.setSecret(apiKey)
    const skipTlsVerify = core.getBooleanInput('skip-tls-verify')
    return new PrivateRegistryPublisher(createHttpsClient(!skipTlsVerify), {
      ...coordinates,
      registryUrl: required('registry-url'),
      apiKey,
      waitForPublish,
      timeoutSeconds,
    })
  }

  if (registryType === 'hcp') {
    const token = required('hcp-token')
    core.setSecret(token)
    return new HcpPublisher(createHttpsClient(true), {
      ...coordinates,
      address: core.getInput('hcp-address') || 'https://app.terraform.io',
      token,
      vcsRepoIdentifier: core.getInput('vcs-repo-identifier') || '',
      vcsBranch: core.getInput('vcs-branch') || 'main',
      vcsOauthTokenId: core.getInput('vcs-oauth-token-id') || '',
      commitSha: core.getInput('commit-sha') || '',
      waitForPublish,
      timeoutSeconds,
    })
  }

  throw new Error(`Unsupported registry-type '${registryType}'. Expected 'hcp' or 'private'.`)
}

async function run(): Promise<void> {
  try {
    const result = await buildPublisher().publish()
    core.info(result.message)
    core.setOutput('published', String(result.published))
    core.setOutput('message', result.message)
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

void run()
