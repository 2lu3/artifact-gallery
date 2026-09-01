import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DerivativePathPolicy } from '../../src/server/security/derivative-path-policy.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('DerivativePathPolicy', () => {
  it('writes, renames, and removes only direct canonical derivative files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-derivative-policy-'))
    temporaryDirectories.push(root)
    const policy = await DerivativePathPolicy.create(root)
    const temporary = join(root, '.thumbnail.tmp')
    const final = join(root, 'thumbnail.webp')

    await policy.writeFile(temporary, Buffer.from('thumbnail'))
    policy.rename(temporary, final)
    await expect(readFile(final, 'utf8')).resolves.toBe('thumbnail')
    await policy.remove(final)
    await expect(lstat(final)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects outside destinations and symlinks without touching source files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'artifact-gallery-derivative-policy-'))
    const outside = await mkdtemp(join(tmpdir(), 'artifact-gallery-source-policy-'))
    temporaryDirectories.push(root, outside)
    const policy = await DerivativePathPolicy.create(root)
    const source = join(outside, 'source.md')
    const link = join(root, 'linked.webp')
    await writeFile(source, '# Keep me')
    await symlink(source, link, 'file')

    await expect(
      policy.writeFile(join(outside, 'escape.tmp'), Buffer.from('x')),
    ).rejects.toMatchObject({ code: 'OUTSIDE_DERIVATIVE_ROOT' })
    expect(() => policy.rename(link, join(root, 'renamed.webp'))).toThrowError(
      expect.objectContaining({ code: 'DERIVATIVE_SYMLINK_REJECTED' }),
    )
    await expect(policy.remove(link)).rejects.toMatchObject({
      code: 'DERIVATIVE_SYMLINK_REJECTED',
    })
    await expect(policy.remove(source)).rejects.toMatchObject({
      code: 'OUTSIDE_DERIVATIVE_ROOT',
    })
    await expect(readFile(source, 'utf8')).resolves.toBe('# Keep me')
  })
})
