import { constants } from 'node:fs';
import { access, lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const SUPPORTED_EXTENSIONS = new Set(['.html', '.htm', '.md']);

export type PathPolicyErrorCode =
  | 'SOURCE_MISSING'
  | 'OUTSIDE_ALLOWED_ROOT'
  | 'SYMLINK_REJECTED'
  | 'UNSUPPORTED_FORMAT'
  | 'UNREADABLE_SOURCE';

export class PathPolicyError extends Error {
  constructor(
    readonly code: PathPolicyErrorCode,
    readonly sourcePath: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${sourcePath}`, options);
    this.name = 'PathPolicyError';
  }
}

export interface AuthorizedFile {
  readonly canonicalPath: string;
  read(encoding: 'utf8'): Promise<string>;
}

export interface AuthorizedDirectory {
  readonly canonicalPath: string;
}

export interface MissingPath {
  readonly normalizedPath: string;
}

export interface PathPolicyItemError {
  readonly path: string;
  readonly code: PathPolicyErrorCode;
}

export interface FolderEnumeration {
  readonly files: AuthorizedFile[];
  readonly errors: PathPolicyItemError[];
}

interface AllowedRoot {
  readonly requestedPath: string;
  readonly canonicalPath: string;
}

export class PathPolicy {
  private constructor(private readonly allowedRoots: readonly AllowedRoot[]) {}

  static async create(allowedRoots: readonly string[]): Promise<PathPolicy> {
    const roots = await Promise.all(
      allowedRoots.map(async (root) => ({
        requestedPath: resolve(root),
        canonicalPath: await realpath(root),
      })),
    );
    return new PathPolicy(
      roots.toSorted((left, right) => right.requestedPath.length - left.requestedPath.length),
    );
  }

  async authorizeFile(requestedPath: string): Promise<AuthorizedFile> {
    const canonicalPath = await this.validateFile(requestedPath);

    return {
      canonicalPath,
      read: async (encoding) =>
        readFile(await this.validateFile(requestedPath), encoding),
    };
  }

  async authorizeDirectory(requestedPath: string): Promise<AuthorizedDirectory> {
    const canonicalPath = await this.validateExistingPath(requestedPath);
    if (!(await stat(canonicalPath)).isDirectory()) {
      throw new PathPolicyError('UNREADABLE_SOURCE', requestedPath);
    }
    return { canonicalPath };
  }

  async validateMissingPath(requestedPath: string): Promise<MissingPath> {
    assertNoTraversal(requestedPath);
    const absolutePath = resolve(requestedPath);
    const lexicalRoot = this.findLexicalRoot(absolutePath);
    if (!lexicalRoot) {
      throw new PathPolicyError('OUTSIDE_ALLOWED_ROOT', requestedPath);
    }
    const rootPath = isContained(lexicalRoot.requestedPath, absolutePath)
      ? lexicalRoot.requestedPath
      : lexicalRoot.canonicalPath;
    const components = relative(rootPath, absolutePath).split(sep).filter(Boolean);
    if (components.some((component) => component.startsWith('.'))) {
      throw new PathPolicyError('UNREADABLE_SOURCE', requestedPath);
    }
    if (!SUPPORTED_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
      throw new PathPolicyError('UNSUPPORTED_FORMAT', requestedPath);
    }
    let currentPath = rootPath;
    for (const [index, component] of components.entries()) {
      const nextPath = join(currentPath, component);
      try {
        if ((await lstat(nextPath)).isSymbolicLink()) {
          throw new PathPolicyError('SYMLINK_REJECTED', requestedPath);
        }
        currentPath = nextPath;
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
          const canonicalParent = await realpath(currentPath);
          return {
            normalizedPath: join(canonicalParent, ...components.slice(index)),
          };
        }
        throw classifyFilesystemError(error, requestedPath);
      }
    }
    throw new PathPolicyError('UNREADABLE_SOURCE', requestedPath);
  }

  async enumerateFolder(requestedPath: string): Promise<FolderEnumeration> {
    const directory = await this.authorizeDirectory(requestedPath);
    const files: AuthorizedFile[] = [];
    const errors: PathPolicyItemError[] = [];
    await this.walkFolder(directory.canonicalPath, files, errors);
    return { files, errors };
  }

  private async validateExistingPath(requestedPath: string): Promise<string> {
    assertNoTraversal(requestedPath);
    const absolutePath = resolve(requestedPath);
    const lexicalRoot = this.findLexicalRoot(absolutePath);
    if (lexicalRoot) {
      const rootPath = isContained(lexicalRoot.requestedPath, absolutePath)
        ? lexicalRoot.requestedPath
        : lexicalRoot.canonicalPath;
      try {
        await assertNoSymlinks(rootPath, absolutePath, requestedPath);
      } catch (error) {
        throw classifyFilesystemError(error, requestedPath);
      }
    }
    let canonicalPath: string;
    try {
      canonicalPath = await realpath(requestedPath);
    } catch (error) {
      throw classifyFilesystemError(error, requestedPath);
    }
    if (!this.allowedRoots.some((root) => isContained(root.canonicalPath, canonicalPath))) {
      throw new PathPolicyError('OUTSIDE_ALLOWED_ROOT', requestedPath);
    }
    if (!lexicalRoot) {
      throw new PathPolicyError('SYMLINK_REJECTED', requestedPath);
    }
    return canonicalPath;
  }

  private async validateFile(requestedPath: string): Promise<string> {
    const canonicalPath = await this.validateExistingPath(requestedPath);
    try {
      if (!(await stat(canonicalPath)).isFile()) {
        throw new PathPolicyError('UNREADABLE_SOURCE', requestedPath);
      }
      await access(canonicalPath, constants.R_OK);
    } catch (error) {
      throw classifyFilesystemError(error, requestedPath);
    }
    if (!SUPPORTED_EXTENSIONS.has(extname(canonicalPath).toLowerCase())) {
      throw new PathPolicyError('UNSUPPORTED_FORMAT', requestedPath);
    }
    return canonicalPath;
  }

  private findLexicalRoot(absolutePath: string): AllowedRoot | undefined {
    return this.allowedRoots.find(
      (root) =>
        isContained(root.requestedPath, absolutePath) ||
        isContained(root.canonicalPath, absolutePath),
    );
  }

  private async walkFolder(
    directory: string,
    files: AuthorizedFile[],
    errors: PathPolicyItemError[],
  ): Promise<void> {
    const entries = (await readdir(directory, { withFileTypes: true })).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      try {
        if (entry.name.startsWith('.')) {
          throw new PathPolicyError('UNREADABLE_SOURCE', entryPath);
        }
        if (entry.isSymbolicLink()) {
          throw new PathPolicyError('SYMLINK_REJECTED', entryPath);
        }
        if (entry.isDirectory()) {
          await this.walkFolder(entryPath, files, errors);
        } else {
          files.push(await this.authorizeFile(entryPath));
        }
      } catch (error) {
        const policyError = classifyFilesystemError(error, entryPath);
        errors.push({ path: entryPath, code: policyError.code });
      }
    }
  }
}

function assertNoTraversal(requestedPath: string): void {
  if (requestedPath.split(/[\\/]+/u).includes('..')) {
    throw new PathPolicyError('OUTSIDE_ALLOWED_ROOT', requestedPath);
  }
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
  );
}

async function assertNoSymlinks(
  root: string,
  candidate: string,
  requestedPath: string,
): Promise<void> {
  const components = relative(root, candidate).split(sep).filter(Boolean);
  let currentPath = root;
  for (const component of components) {
    if (component.startsWith('.')) {
      throw new PathPolicyError('UNREADABLE_SOURCE', requestedPath);
    }
    currentPath = join(currentPath, component);
    if ((await lstat(currentPath)).isSymbolicLink()) {
      throw new PathPolicyError('SYMLINK_REJECTED', requestedPath);
    }
  }
}

function classifyFilesystemError(error: unknown, requestedPath: string): PathPolicyError {
  if (error instanceof PathPolicyError) {
    return error;
  }
  return new PathPolicyError(
    isNodeError(error, 'ENOENT') ? 'SOURCE_MISSING' : 'UNREADABLE_SOURCE',
    requestedPath,
    { cause: error },
  );
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
