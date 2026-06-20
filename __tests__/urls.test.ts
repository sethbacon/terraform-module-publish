import { describe, it, expect } from 'vitest'
import { moduleUrl, syncUrl, hasVersion, trimTrailingSlash } from '../src/private-publisher'
import {
  moduleUrl as hcpModuleUrl,
  versionsUrl,
  vcsUrl,
  versionStatus,
} from '../src/hcp-publisher'

const coords = { namespace: 'myorg', name: 'vpc', provider: 'aws', version: '1.2.3' }

describe('private registry URLs', () => {
  it('builds the module + sync URLs and trims slashes', () => {
    expect(trimTrailingSlash('https://reg.example.com///')).toBe('https://reg.example.com')
    expect(moduleUrl('https://reg.example.com/', coords)).toBe(
      'https://reg.example.com/api/v1/modules/myorg/vpc/aws',
    )
    expect(syncUrl('https://reg.example.com', 'mod-123')).toBe(
      'https://reg.example.com/api/v1/admin/modules/mod-123/scm/sync',
    )
  })

  it('detects a published version in a registry response', () => {
    expect(hasVersion(JSON.stringify({ versions: [{ version: '1.2.3' }] }), '1.2.3')).toBe(true)
    expect(hasVersion(JSON.stringify({ versions: [{ version: '0.0.1' }] }), '1.2.3')).toBe(false)
    expect(hasVersion(JSON.stringify({}), '1.2.3')).toBe(false)
  })
})

describe('HCP / TFE URLs', () => {
  const ref = { ...coords, address: 'https://app.terraform.io/' }
  it('builds module, versions, and vcs URLs', () => {
    expect(hcpModuleUrl(ref)).toBe(
      'https://app.terraform.io/api/v2/organizations/myorg/registry-modules/private/myorg/vpc/aws',
    )
    expect(versionsUrl(ref)).toBe(
      'https://app.terraform.io/api/v2/organizations/myorg/registry-modules/private/myorg/vpc/aws/versions',
    )
    expect(vcsUrl('https://app.terraform.io', 'myorg')).toBe(
      'https://app.terraform.io/api/v2/organizations/myorg/registry-modules/vcs',
    )
  })

  it('reads a version status from an HCP response', () => {
    const body = JSON.stringify({ data: { attributes: { 'version-statuses': [{ version: '1.2.3', status: 'ok' }] } } })
    expect(versionStatus(body, '1.2.3')).toBe('ok')
    expect(versionStatus(body, '9.9.9')).toBeUndefined()
  })
})
