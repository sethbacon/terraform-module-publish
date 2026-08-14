import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import { MAX_ARCHIVE_BYTES, createModuleArchive } from '../src/archive'

/**
 * The archive is the payload of the HCP upload, so what matters is that a real
 * tar reader accepts it and sees exactly the module — not that our own writer
 * can read back its own output, which would pass just as happily on a format we
 * invented. Every structural claim below is therefore checked by piping the
 * bytes through the system `tar`.
 */

const roots: string[] = []

function moduleDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'modarchive-'))
  roots.push(root)
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
  }
  return root
}

afterAll(() => {
  for (const root of roots) execFileSync('rm', ['-rf', root])
})

/** Entry paths as a real tar reader sees them. */
function listWithSystemTar(archive: Uint8Array): string[] {
  const file = join(mkdtempSync(join(tmpdir(), 'modtar-')), 'module.tar.gz')
  writeFileSync(file, archive)
  return execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort()
}

/** One entry's content, extracted by a real tar reader. */
function readWithSystemTar(archive: Uint8Array, path: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'modtar-'))
  const file = join(dir, 'module.tar.gz')
  writeFileSync(file, archive)
  return execFileSync('tar', ['-xzOf', file, path], { encoding: 'utf8' })
}

describe('the module archive is a tar a real reader accepts', () => {
  it('lists the module files at the archive root, not under the directory name', async () => {
    const archive = await createModuleArchive(
      moduleDir({ 'main.tf': 'resource "null_resource" "a" {}', 'variables.tf': 'variable "x" {}' }),
    )
    expect(listWithSystemTar(archive)).toEqual(['main.tf', 'variables.tf'])
  })

  it('round-trips file content byte for byte', async () => {
    const body = 'resource "null_resource" "a" {\n  # ünïcödé and a tab\there\n}\n'
    const archive = await createModuleArchive(moduleDir({ 'main.tf': body }))
    expect(readWithSystemTar(archive, 'main.tf')).toBe(body)
  })

  it('carries nested module files at their relative paths', async () => {
    const archive = await createModuleArchive(
      moduleDir({ 'main.tf': 'x', 'modules/net/main.tf': 'nested', 'examples/basic/main.tf': 'ex' }),
    )
    expect(listWithSystemTar(archive)).toEqual(['examples/basic/main.tf', 'main.tf', 'modules/net/main.tf'])
    expect(readWithSystemTar(archive, 'modules/net/main.tf')).toBe('nested')
  })

  it('excludes .git and .terraform, which are not module source', async () => {
    const archive = await createModuleArchive(
      moduleDir({
        'main.tf': 'x',
        '.git/config': 'secret-ish',
        '.terraform/providers/registry/plugin': 'binary',
        '.terraform.lock.hcl': 'keep me',
      }),
    )
    // The lock file is module source and stays; the two caches do not.
    expect(listWithSystemTar(archive)).toEqual(['.terraform.lock.hcl', 'main.tf'])
  })

  it('is byte-identical for identical content, so a publish is reproducible', async () => {
    const files = { 'main.tf': 'resource "null_resource" "a" {}', 'sub/b.tf': 'b' }
    const first = await createModuleArchive(moduleDir(files))
    const second = await createModuleArchive(moduleDir(files))
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
  })

  it('pins ownership and timestamps rather than leaking the runner’s', async () => {
    const archive = await createModuleArchive(moduleDir({ 'main.tf': 'x' }))
    // Read out of the header itself rather than out of `tar -tv`, whose
    // rendering of epoch 0 is the runner's LOCAL time and so differs by zone.
    const header = gunzipSync(Buffer.from(archive)).subarray(0, 512)
    const field = (start: number, length: number) =>
      header.subarray(start, start + length).toString('ascii').replace(/\0.*$/, '').trim()
    expect(field(100, 8)).toBe('0000644') // mode
    expect(field(108, 8)).toBe('0000000') // uid
    expect(field(116, 8)).toBe('0000000') // gid
    expect(field(136, 12)).toBe('00000000000') // mtime
    expect(field(257, 6)).toBe('ustar')
  })

  it('writes a header checksum a reader will accept', async () => {
    const archive = await createModuleArchive(moduleDir({ 'main.tf': 'x' }))
    const header = gunzipSync(Buffer.from(archive)).subarray(0, 512)
    const stored = parseInt(header.subarray(148, 154).toString('ascii'), 8)
    // Recompute exactly as a reader does: the checksum field reads as spaces.
    const blanked = Buffer.from(header)
    blanked.fill(0x20, 148, 156)
    let sum = 0
    for (const byte of blanked) sum += byte
    expect(stored).toBe(sum)
  })

  it('terminates the archive with the two zero blocks tar expects', async () => {
    const archive = await createModuleArchive(moduleDir({ 'main.tf': 'x' }))
    const raw = gunzipSync(Buffer.from(archive))
    expect(raw.byteLength % 512).toBe(0)
    expect(raw.subarray(raw.byteLength - 1024).every((b) => b === 0)).toBe(true)
  })

  it('carries a path too long for the tar name field via the ustar prefix', async () => {
    const deep = `${'d'.repeat(60)}/${'e'.repeat(60)}/main.tf`
    const archive = await createModuleArchive(moduleDir({ 'main.tf': 'root', [deep]: 'deep' }))
    expect(listWithSystemTar(archive)).toContain(deep)
    expect(readWithSystemTar(archive, deep)).toBe('deep')
  })
})

describe('the archive refuses what would publish something other than the module', () => {
  it('refuses a directory that does not exist', async () => {
    await expect(createModuleArchive(join(tmpdir(), 'definitely-not-here-9f1c'))).rejects.toThrow(
      'is not a directory that exists',
    )
  })

  it('refuses a directory with no root-level Terraform configuration', async () => {
    const root = moduleDir({ 'README.md': 'not a module', 'sub/main.tf': 'nested only' })
    await expect(createModuleArchive(root)).rejects.toThrow('contains no .tf or .tf.json files at its root')
  })

  it('accepts .tf.json as root configuration', async () => {
    const archive = await createModuleArchive(moduleDir({ 'main.tf.json': '{}' }))
    expect(listWithSystemTar(archive)).toEqual(['main.tf.json'])
  })

  /**
   * The exfiltration shape: this archive is uploaded and, for a public module,
   * published. A link out of the module directory in a checkout the workflow
   * did not write turns the publish step into a way to read the runner's disk.
   */
  it('refuses a symlink pointing outside the module directory', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'outside-'))
    roots.push(outside)
    writeFileSync(join(outside, 'credentials'), 'aws-secret-access-key')
    const root = moduleDir({ 'main.tf': 'x' })
    symlinkSync(join(outside, 'credentials'), join(root, 'stolen.txt'))
    await expect(createModuleArchive(root)).rejects.toThrow('symbolic link pointing outside')
  })

  it('refuses a symlink that escapes via a parent traversal', async () => {
    const root = moduleDir({ 'main.tf': 'x' })
    symlinkSync('../../etc/hostname', join(root, 'escape.txt'))
    await expect(createModuleArchive(root)).rejects.toThrow(/symbolic link pointing outside|broken symbolic link/)
  })

  it('archives a symlink that stays inside the module as its target content', async () => {
    const root = moduleDir({ 'main.tf': 'x', 'real.tf': 'real content' })
    symlinkSync(join(root, 'real.tf'), join(root, 'alias.tf'))
    const archive = await createModuleArchive(root)
    expect(readWithSystemTar(archive, 'alias.tf')).toBe('real content')
  })

  it('refuses a symlink to a directory rather than silently dropping it', async () => {
    const root = moduleDir({ 'main.tf': 'x', 'real/inner.tf': 'inner' })
    symlinkSync(join(root, 'real'), join(root, 'alias'))
    await expect(createModuleArchive(root)).rejects.toThrow('symbolic link to a directory')
  })

  it('refuses a broken symlink instead of failing later on the read', async () => {
    const root = moduleDir({ 'main.tf': 'x' })
    symlinkSync(join(root, 'nothing-here'), join(root, 'dangling.tf'))
    await expect(createModuleArchive(root)).rejects.toThrow('broken symbolic link')
  })

  it('refuses a tree past the size cap rather than assembling it in memory', async () => {
    const root = moduleDir({ 'main.tf': 'x' })
    // Two files that together exceed the cap, written sparsely-ish but real.
    const chunk = Buffer.alloc(8 * 1024 * 1024, 0x61)
    for (let i = 0; i < Math.ceil(MAX_ARCHIVE_BYTES / chunk.byteLength) + 1; i++) {
      writeFileSync(join(root, `blob${i}.bin`), chunk)
    }
    await expect(createModuleArchive(root)).rejects.toThrow('exceeds')
  })
})
