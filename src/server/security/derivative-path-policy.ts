import { constants, lstatSync, realpathSync, renameSync, statSync } from 'node:fs'
import { lstat, open, realpath, stat, unlink } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

export type DerivativePathErrorCode =
  | 'OUTSIDE_DERIVATIVE_ROOT'
  | 'DERIVATIVE_SYMLINK_REJECTED'
  | 'DERIVATIVE_PATH_INVALID'

export class DerivativePathError extends Error {
  constructor(
    readonly code: DerivativePathErrorCode,
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${path}`, options)
    this.name = 'DerivativePathError'
  }
}

export class DerivativePathPolicy {
  private constructor(private readonly canonicalRoot: string) {}

  static async create(root: string): Promise<DerivativePathPolicy> {
    try {
      const lexical = await lstat(root)
      if (lexical.isSymbolicLink())
        throw new DerivativePathError('DERIVATIVE_SYMLINK_REJECTED', root)
      const canonical = await realpath(root)
      if (!(await stat(canonical)).isDirectory()) {
        throw new DerivativePathError('DERIVATIVE_PATH_INVALID', root)
      }
      return new DerivativePathPolicy(canonical)
    } catch (error) {
      if (error instanceof DerivativePathError) throw error
      throw new DerivativePathError('DERIVATIVE_PATH_INVALID', root, { cause: error })
    }
  }

  async writeFile(path: string, bytes: Buffer): Promise<void> {
    const target = await this.validateTarget(path, false)
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    )
    try {
      await handle.writeFile(bytes)
      const descriptor = await handle.stat()
      const current = await lstat(target)
      if (!current.isFile() || current.dev !== descriptor.dev || current.ino !== descriptor.ino) {
        throw new DerivativePathError('DERIVATIVE_PATH_INVALID', path)
      }
      await this.validateTarget(path, true)
    } finally {
      await handle.close()
    }
  }

  async mkdir(path: string, options: { recursive: true }): Promise<void> {
    void options
    let canonical: string
    try {
      canonical = await realpath(path)
    } catch (error) {
      throw new DerivativePathError('DERIVATIVE_PATH_INVALID', path, { cause: error })
    }
    if (canonical !== this.canonicalRoot) {
      throw new DerivativePathError('OUTSIDE_DERIVATIVE_ROOT', path)
    }
  }

  rename(from: string, to: string): void {
    const source = this.validateExistingTargetSync(from)
    const destination = this.validateMissingTargetSync(to)
    renameSync(source, destination)
  }

  async remove(path: string): Promise<void> {
    let target: string
    try {
      target = await this.validateTarget(path, true)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return
      throw error
    }
    await unlink(target)
  }

  private async validateTarget(path: string, mustExist: boolean): Promise<string> {
    const requestedTarget = this.validateLexicalTarget(path)
    const parent = await realpath(dirname(requestedTarget))
    if (parent !== this.canonicalRoot)
      throw new DerivativePathError('OUTSIDE_DERIVATIVE_ROOT', path)
    const target = resolve(parent, basename(requestedTarget))
    try {
      const status = await lstat(target)
      if (status.isSymbolicLink())
        throw new DerivativePathError('DERIVATIVE_SYMLINK_REJECTED', path)
      if (!status.isFile()) throw new DerivativePathError('DERIVATIVE_PATH_INVALID', path)
      const canonical = await realpath(target)
      if (dirname(canonical) !== this.canonicalRoot) {
        throw new DerivativePathError('OUTSIDE_DERIVATIVE_ROOT', path)
      }
    } catch (error) {
      if (!mustExist && isNodeError(error, 'ENOENT')) return target
      throw error
    }
    return target
  }

  private validateExistingTargetSync(path: string): string {
    const requestedTarget = this.validateLexicalTarget(path)
    const parent = realpathSync(dirname(requestedTarget))
    if (parent !== this.canonicalRoot) {
      throw new DerivativePathError('OUTSIDE_DERIVATIVE_ROOT', path)
    }
    const target = resolve(parent, basename(requestedTarget))
    const status = lstatSync(target)
    if (status.isSymbolicLink()) throw new DerivativePathError('DERIVATIVE_SYMLINK_REJECTED', path)
    if (!status.isFile() || dirname(realpathSync(target)) !== this.canonicalRoot) {
      throw new DerivativePathError('DERIVATIVE_PATH_INVALID', path)
    }
    return target
  }

  private validateMissingTargetSync(path: string): string {
    const requestedTarget = this.validateLexicalTarget(path)
    const parent = realpathSync(dirname(requestedTarget))
    if (parent !== this.canonicalRoot) {
      throw new DerivativePathError('OUTSIDE_DERIVATIVE_ROOT', path)
    }
    const target = resolve(parent, basename(requestedTarget))
    try {
      statSync(target)
      throw new DerivativePathError('DERIVATIVE_PATH_INVALID', path)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return target
      throw error
    }
  }

  private validateLexicalTarget(path: string): string {
    if (path.split(/[\\/]+/u).includes('..')) {
      throw new DerivativePathError('OUTSIDE_DERIVATIVE_ROOT', path)
    }
    return resolve(path)
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
