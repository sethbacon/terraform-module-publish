import { beforeEach, describe, expect, it, vi } from 'vitest'

// src/index.ts had no test of any kind: not the masking order, not the
// registry-type validation, not the timeout coercion, not the input messages.
// It calls `void run()` at import, so each case re-imports it against fresh
// mocks.

const calls: string[] = []
const inputs = new Map<string, string>()
const outputs = new Map<string, string>()
const warnings: string[] = []
const failures: string[] = []

vi.mock('@actions/core', () => ({
  getInput: (name: string) => inputs.get(name) ?? '',
  getBooleanInput: (name: string) => (inputs.get(name) ?? 'false').toLowerCase() === 'true',
  setSecret: (value: string) => calls.push(`setSecret:${value}`),
  setOutput: (name: string, value: string) => outputs.set(name, value),
  info: () => calls.push('info'),
  debug: () => calls.push('debug'),
  warning: (message: string) => {
    warnings.push(message)
    calls.push('warning')
  },
  setFailed: (message: string) => {
    failures.push(message)
    calls.push('setFailed')
  },
}))

// The publishers are stubbed: what is under test here is everything BEFORE the
// first request, which is where the masking order and the input handling live.
const publish = vi.fn(async () => ({ published: true, message: 'done' }))
vi.mock('../src/private-publisher', () => ({
  PrivateRegistryPublisher: class {
    constructor(..._args: unknown[]) {
      calls.push('constructPrivate')
    }
    publish = publish
  },
}))
vi.mock('../src/hcp-publisher', () => ({
  HcpPublisher: class {
    constructor(..._args: unknown[]) {
      calls.push('constructHcp')
    }
    publish = publish
  },
}))

async function runAction(): Promise<void> {
  vi.resetModules()
  await import('../src/index')
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  calls.length = 0
  warnings.length = 0
  failures.length = 0
  inputs.clear()
  outputs.clear()
  publish.mockClear()
  publish.mockResolvedValue({ published: true, message: 'done' })
  inputs.set('registry-type', 'private')
  inputs.set('namespace', 'myorg')
  inputs.set('name', 'vpc')
  inputs.set('provider', 'aws')
  inputs.set('version', '1.2.3')
  inputs.set('registry-url', 'https://reg.example.com')
  inputs.set('api-key', 'k-SECRET')
})

describe('credential masking order', () => {
  it('both credentials are masked before anything else is read', async () => {
    inputs.set('hcp-token', 't-SECRET')
    await runAction()
    expect(calls[0]).toBe('setSecret:k-SECRET')
    expect(calls[1]).toBe('setSecret:t-SECRET')
    expect(calls.indexOf('constructPrivate')).toBeGreaterThan(1)
  })

  // A reusable workflow that passes every input through supplies the credential
  // for the branch it is not using too; leaving that one unmasked is the same
  // exposure for a value the runner does not mask on its own.
  it('the credential for the OTHER registry-type is masked too', async () => {
    inputs.set('hcp-token', 't-SECRET')
    await runAction()
    expect(calls).toContain('setSecret:t-SECRET')
  })

  it('masking still happens when a later input is invalid', async () => {
    inputs.set('registry-type', 'Private') // wrong case
    await runAction()
    expect(calls).toContain('setSecret:k-SECRET')
    expect(calls.indexOf('setSecret:k-SECRET')).toBeLessThan(calls.indexOf('setFailed'))
  })
})

describe('registry-type is checked before it is trusted', () => {
  // The exact message matters, not just "it failed": buildPublisher still has
  // an unreachable fallthrough throw for compiler totality, so an assertion on
  // failure alone passes with the validation deleted — it was checked, and it
  // did. This message is the one only the up-front check can produce.
  it.each(['Private', 'HCP', 'gitlab'])('refuses %o before the value is narrowed', async (value) => {
    inputs.set('registry-type', value)
    await runAction()
    expect(failures[0]).toBe(`Unsupported registry-type '${value}'. Expected 'hcp' or 'private'.`)
    expect(publish).not.toHaveBeenCalled()
  })

  it('an empty registry-type is reported as a missing input', async () => {
    inputs.set('registry-type', '')
    await runAction()
    expect(failures[0]).toMatch(/Input 'registry-type' is required/)
    expect(publish).not.toHaveBeenCalled()
  })

  it.each([
    ['private', 'constructPrivate'],
    ['hcp', 'constructHcp'],
  ])('accepts %s', async (value, marker) => {
    inputs.set('registry-type', value)
    inputs.set('hcp-token', 't')
    await runAction()
    expect(failures).toEqual([])
    expect(calls).toContain(marker)
  })
})

describe('missing conditionally-required inputs name the registry-type', () => {
  it('a missing api-key says which registry-type needed it', async () => {
    inputs.delete('api-key')
    await runAction()
    // The custom message used to be dead code: core.getInput({required:true})
    // threw its own generic text one line earlier, at all eight call sites.
    expect(failures[0]).toBe("Input 'api-key' is required for registry-type 'private'.")
  })

  it('a missing hcp-token says which registry-type needed it', async () => {
    inputs.set('registry-type', 'hcp')
    inputs.delete('hcp-token')
    await runAction()
    expect(failures[0]).toBe("Input 'hcp-token' is required for registry-type 'hcp'.")
  })
})

describe('timeout-seconds', () => {
  it.each(['0', '-5', 'abc', '1.5.2'])('warns instead of silently substituting the default for %o', async (value) => {
    inputs.set('timeout-seconds', value)
    await runAction()
    expect(warnings.join(' ')).toMatch(/timeout-seconds: '.*' is not a positive whole number/)
    expect(failures).toEqual([])
  })

  it.each(['30', '600'])('accepts %o without a warning', async (value) => {
    inputs.set('timeout-seconds', value)
    await runAction()
    expect(warnings).toEqual([])
  })

  it('an unset value is the documented default, not a warning', async () => {
    await runAction()
    expect(warnings).toEqual([])
  })
})

describe('outputs', () => {
  it('are set on success', async () => {
    await runAction()
    expect(outputs.get('published')).toBe('true')
    expect(outputs.get('message')).toBe('done')
  })

  // Documented in the README rather than changed: a consumer must read the
  // step's own outcome, not these, to detect failure.
  it('are NOT set on failure', async () => {
    publish.mockRejectedValue(new Error('registry down'))
    await runAction()
    expect(failures[0]).toMatch(/registry down/)
    expect(outputs.has('published')).toBe(false)
    expect(outputs.has('message')).toBe(false)
  })
})
