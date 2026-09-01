import { constants } from 'node:fs'
import { access, lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const SUPPORTED_EXTENSIONS = new Set(['.html', '.htm', '.md'])
const ASSET_MIME_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export type PathPolicyErrorCode =
  | 'SOURCE_MISSING'
  | 'OUTSIDE_ALLOWED_ROOT'
  | 'SYMLINK_REJECTED'
  | 'UNSUPPORTED_FORMAT'
  | 'UNREADABLE_SOURCE'

export class PathPolicyError extends Error {
  constructor(
    readonly code: PathPolicyErrorCode,
    readonly sourcePath: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${sourcePath}`, options)
    this.name = 'PathPolicyError'
  }
}

export interface AuthorizedFile {
  readonly canonicalPath: string
  read(encoding: 'utf8', maxBytes?: number): Promise<string>
}

export interface AuthorizedDirectory {
  readonly canonicalPath: string
}

export interface AuthorizedAsset {
  readonly canonicalPath: string
  readonly mimeType: string
  read(maxBytes?: number): Promise<Buffer>
}

export class AssetReadLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super('Asset read limit exceeded')
    this.name = 'AssetReadLimitError'
  }
}

export interface MissingPath {
  readonly normalizedPath: string
}

export interface PathPolicyItemError {
  readonly path: string
  readonly code: PathPolicyErrorCode
}

export interface FolderEnumeration {
  readonly files: AuthorizedFile[]
  readonly errors: PathPolicyItemError[]
}

export type PathCapabilityKind = 'file' | 'folder'

export interface PathCapability {
  readonly path: string
  readonly kind: PathCapabilityKind
}

export interface CanonicalPathCapability {
  readonly canonicalPath: string
  readonly kind: PathCapabilityKind
}

export interface FolderEnumerationOptions {
  readonly maxItems?: number
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
  readonly isCancelled?: () => boolean
}

export class FolderEnumerationLimitError extends Error {
  constructor(readonly maxItems: number) {
    super('Folder enumeration limit exceeded.')
    this.name = 'FolderEnumerationLimitError'
  }
}

export class FolderEnumerationCancelledError extends Error {
  constructor() {
    super('Folder enumeration was cancelled.')
    this.name = 'FolderEnumerationCancelledError'
  }
}

export class FolderEnumerationDeadlineError extends Error {
  constructor() {
    super('Folder enumeration deadline exceeded.')
    this.name = 'FolderEnumerationDeadlineError'
  }
}

interface AllowedRoot {
  readonly requestedPath: string
  readonly canonicalPath: string
  readonly kind: PathCapabilityKind
}

interface DirectorySnapshot {
  readonly canonicalPath: string
  readonly deviceId: number
  readonly inode: number
}

interface FileSnapshot {
  readonly canonicalPath: string
  readonly deviceId: number
  readonly inode: number
}

export class PathPolicy {
  private constructor(private readonly allowedRoots: AllowedRoot[]) {}

  static async create(allowedRoots: readonly string[]): Promise<PathPolicy> {
    return PathPolicy.createCapabilities(allowedRoots.map((path) => ({ path, kind: 'folder' })))
  }

  static async createCapabilities(capabilities: readonly PathCapability[]): Promise<PathPolicy> {
    const policy = new PathPolicy([])
    for (const capability of capabilities) {
      await policy.addSelectedCapability(capability.path, capability.kind)
    }
    return policy
  }

  static restoreCapabilities(capabilities: readonly CanonicalPathCapability[]): PathPolicy {
    return new PathPolicy(
      capabilities
        .map((capability) => ({
          requestedPath: resolve(capability.canonicalPath),
          canonicalPath: resolve(capability.canonicalPath),
          kind: capability.kind,
        }))
        .toSorted((left, right) => right.requestedPath.length - left.requestedPath.length),
    )
  }

  async addSelectedCapability(
    requestedPath: string,
    kind: PathCapabilityKind,
  ): Promise<CanonicalPathCapability> {
    const capability = await canonicalizeCapability(requestedPath, kind)
    const existing = this.allowedRoots.find(
      (root) => root.canonicalPath === capability.canonicalPath,
    )
    if (existing) {
      if (existing.kind === 'file' && kind === 'folder') {
        this.allowedRoots.splice(this.allowedRoots.indexOf(existing), 1)
      } else {
        return { canonicalPath: existing.canonicalPath, kind: existing.kind }
      }
    }
    this.allowedRoots.push({
      requestedPath: resolve(requestedPath),
      canonicalPath: capability.canonicalPath,
      kind,
    })
    this.allowedRoots.sort((left, right) => right.requestedPath.length - left.requestedPath.length)
    return capability
  }

  async authorizeFile(requestedPath: string): Promise<AuthorizedFile> {
    const authorizedSnapshot = await this.validateFileSnapshot(requestedPath)

    return {
      canonicalPath: authorizedSnapshot.canonicalPath,
      read: (encoding, maxBytes) =>
        normalizeFilesystemOperation(requestedPath, async () => {
          const bytes = await readAuthorizedFile(
            authorizedSnapshot,
            requestedPath,
            () => this.validateFileSnapshot(requestedPath),
            maxBytes,
          )
          return bytes.toString(encoding)
        }),
    }
  }

  async authorizeDirectory(requestedPath: string): Promise<AuthorizedDirectory> {
    const directory = await this.validateDirectory(requestedPath)
    return { canonicalPath: directory.canonicalPath }
  }

  async authorizeAsset(requestedPath: string): Promise<AuthorizedAsset> {
    const authorizedSnapshot = await this.validateReadableFileSnapshot(requestedPath)
    return {
      canonicalPath: authorizedSnapshot.canonicalPath,
      mimeType: mimeTypeFor(authorizedSnapshot.canonicalPath),
      read: (maxBytes) =>
        normalizeFilesystemOperation(requestedPath, async () =>
          readAuthorizedFile(
            authorizedSnapshot,
            requestedPath,
            () => this.validateReadableFileSnapshot(requestedPath),
            maxBytes,
          ),
        ),
    }
  }

  async validateMissingPath(requestedPath: string): Promise<MissingPath> {
    assertNoTraversal(requestedPath)
    const absolutePath = resolve(requestedPath)
    const lexicalRoot = this.findLexicalRoot(absolutePath)
    if (!lexicalRoot) {
      throw new PathPolicyError('OUTSIDE_ALLOWED_ROOT', requestedPath)
    }
    const rootPath = isContained(lexicalRoot.requestedPath, absolutePath)
      ? lexicalRoot.requestedPath
      : lexicalRoot.canonicalPath
    const components = relative(rootPath, absolutePath).split(sep).filter(Boolean)
    if (components.some((component) => component.startsWith('.'))) {
      throw new PathPolicyError('UNREADABLE_SOURCE', requestedPath)
    }
    if (!SUPPORTED_EXTENSIONS.has(extname(absolutePath).toLowerCase())) {
      throw new PathPolicyError('UNSUPPORTED_FORMAT', requestedPath)
    }
    let currentPath = rootPath
    for (const [index, component] of components.entries()) {
      const nextPath = join(currentPath, component)
      try {
        if ((await lstat(nextPath)).isSymbolicLink()) {
          throw new PathPolicyError('SYMLINK_REJECTED', requestedPath)
        }
        currentPath = nextPath
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) {
          try {
            const canonicalParent = await realpath(currentPath)
            return {
              normalizedPath: join(canonicalParent, ...components.slice(index)),
            }
          } catch (parentError) {
            throw classifyFilesystemError(parentError, requestedPath)
          }
        }
        throw classifyFilesystemError(error, requestedPath)
      }
    }
    throw new PathPolicyError('UNREADABLE_SOURCE', requestedPath)
  }

  async enumerateFolder(
    requestedPath: string,
    options: FolderEnumerationOptions = {},
  ): Promise<FolderEnumeration> {
    assertEnumerationActive(options)
    const directory = await this.authorizeDirectory(requestedPath)
    const files: AuthorizedFile[] = []
    const errors: PathPolicyItemError[] = []
    try {
      await this.walkFolder(directory.canonicalPath, files, errors, options)
    } catch (error) {
      if (isEnumerationControlError(error)) throw error
      throw classifyFilesystemError(error, requestedPath)
    }
    return { files, errors }
  }

  private async validateExistingPath(requestedPath: string): Promise<string> {
    assertNoTraversal(requestedPath)
    const absolutePath = resolve(requestedPath)
    try {
      if ((await lstat(absolutePath)).isSymbolicLink()) {
        throw new PathPolicyError('SYMLINK_REJECTED', requestedPath)
      }
    } catch (error) {
      throw classifyFilesystemError(error, requestedPath)
    }
    const lexicalRoot = this.findLexicalRoot(absolutePath)
    if (lexicalRoot) {
      const rootPath = isContained(lexicalRoot.requestedPath, absolutePath)
        ? lexicalRoot.requestedPath
        : lexicalRoot.canonicalPath
      try {
        await assertNoSymlinks(rootPath, absolutePath, requestedPath)
      } catch (error) {
        throw classifyFilesystemError(error, requestedPath)
      }
    }
    let canonicalPath: string
    try {
      canonicalPath = await realpath(requestedPath)
    } catch (error) {
      throw classifyFilesystemError(error, requestedPath)
    }
    if (!this.allowedRoots.some((root) => capabilityContains(root, canonicalPath))) {
      throw new PathPolicyError('OUTSIDE_ALLOWED_ROOT', requestedPath)
    }
    if (!lexicalRoot) {
      throw new PathPolicyError('SYMLINK_REJECTED', requestedPath)
    }
    return canonicalPath
  }

  private async validateFileSnapshot(requestedPath: string): Promise<FileSnapshot> {
    const snapshot = await this.validateReadableFileSnapshot(requestedPath)
    if (!SUPPORTED_EXTENSIONS.has(extname(snapshot.canonicalPath).toLowerCase())) {
      throw new PathPolicyError('UNSUPPORTED_FORMAT', requestedPath)
    }
    return snapshot
  }

  private async validateReadableFileSnapshot(requestedPath: string): Promise<FileSnapshot> {
    const canonicalPath = await this.validateExistingPath(requestedPath)
    try {
      const status = await stat(canonicalPath)
      if (!status.isFile()) {
        throw new PathPolicyError('UNREADABLE_SOURCE', requestedPath)
      }
      await access(canonicalPath, constants.R_OK)
      return {
        canonicalPath,
        deviceId: status.dev,
        inode: status.ino,
      }
    } catch (error) {
      throw classifyFilesystemError(error, requestedPath)
    }
  }

  private async validateDirectory(requestedPath: string): Promise<DirectorySnapshot> {
    const canonicalPath = await this.validateExistingPath(requestedPath)
    try {
      const status = await stat(canonicalPath)
      if (!status.isDirectory()) {
        throw new PathPolicyError('UNREADABLE_SOURCE', requestedPath)
      }
      await access(canonicalPath, constants.R_OK | constants.X_OK)
      return {
        canonicalPath,
        deviceId: status.dev,
        inode: status.ino,
      }
    } catch (error) {
      throw classifyFilesystemError(error, requestedPath)
    }
  }

  private findLexicalRoot(absolutePath: string): AllowedRoot | undefined {
    return this.allowedRoots.find(
      (root) =>
        capabilityContainsRequested(root, absolutePath) || capabilityContains(root, absolutePath),
    )
  }

  private async walkFolder(
    directory: string,
    files: AuthorizedFile[],
    errors: PathPolicyItemError[],
    options: FolderEnumerationOptions,
  ): Promise<void> {
    assertEnumerationActive(options)
    const beforeRead = await this.validateDirectory(directory)
    const entries = (await readdir(beforeRead.canonicalPath, { withFileTypes: true })).toSorted(
      (left, right) => left.name.localeCompare(right.name),
    )
    const afterRead = await this.validateDirectory(beforeRead.canonicalPath)
    if (beforeRead.deviceId !== afterRead.deviceId || beforeRead.inode !== afterRead.inode) {
      throw new PathPolicyError('UNREADABLE_SOURCE', directory)
    }
    for (const entry of entries) {
      assertEnumerationActive(options)
      const entryPath = join(afterRead.canonicalPath, entry.name)
      if (entry.name.startsWith('.')) continue
      if (entry.isFile() && !SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      try {
        if (entry.isSymbolicLink()) {
          throw new PathPolicyError('SYMLINK_REJECTED', entryPath)
        }
        if (entry.isDirectory()) {
          await this.walkFolder(entryPath, files, errors, options)
        } else {
          assertEnumerationCapacity(files, errors, options)
          files.push(await this.authorizeFile(entryPath))
        }
      } catch (error) {
        if (isEnumerationControlError(error)) throw error
        assertEnumerationCapacity(files, errors, options)
        const policyError = classifyFilesystemError(error, entryPath)
        errors.push({ path: entryPath, code: policyError.code })
      }
    }
  }
}

async function canonicalizeCapability(
  requestedPath: string,
  kind: PathCapabilityKind,
): Promise<CanonicalPathCapability> {
  assertNoTraversal(requestedPath)
  try {
    const requestedStatus = await lstat(requestedPath)
    if (requestedStatus.isSymbolicLink()) {
      throw new PathPolicyError('SYMLINK_REJECTED', requestedPath)
    }
    const canonicalPath = await realpath(requestedPath)
    const status = await stat(canonicalPath)
    if (kind === 'file') {
      if (!status.isFile()) throw new PathPolicyError('UNREADABLE_SOURCE', requestedPath)
      if (!SUPPORTED_EXTENSIONS.has(extname(canonicalPath).toLowerCase())) {
        throw new PathPolicyError('UNSUPPORTED_FORMAT', requestedPath)
      }
      await access(canonicalPath, constants.R_OK)
    } else {
      if (!status.isDirectory()) throw new PathPolicyError('UNREADABLE_SOURCE', requestedPath)
      await access(canonicalPath, constants.R_OK | constants.X_OK)
    }
    return { canonicalPath, kind }
  } catch (error) {
    throw classifyFilesystemError(error, requestedPath)
  }
}

function capabilityContains(root: AllowedRoot, candidate: string): boolean {
  return root.kind === 'folder'
    ? isContained(root.canonicalPath, candidate)
    : root.canonicalPath === candidate
}

function capabilityContainsRequested(root: AllowedRoot, candidate: string): boolean {
  return root.kind === 'folder'
    ? isContained(root.requestedPath, candidate)
    : root.requestedPath === candidate
}

function assertEnumerationActive(options: FolderEnumerationOptions): void {
  if (options.signal?.aborted || options.isCancelled?.()) {
    throw new FolderEnumerationCancelledError()
  }
  if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
    throw new FolderEnumerationDeadlineError()
  }
}

function assertEnumerationCapacity(
  files: readonly AuthorizedFile[],
  errors: readonly PathPolicyItemError[],
  options: FolderEnumerationOptions,
): void {
  if (options.maxItems === undefined) return
  if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1) {
    throw new FolderEnumerationLimitError(options.maxItems)
  }
  if (files.length + errors.length >= options.maxItems) {
    throw new FolderEnumerationLimitError(options.maxItems)
  }
}

function isEnumerationControlError(error: unknown): boolean {
  return (
    error instanceof FolderEnumerationLimitError ||
    error instanceof FolderEnumerationCancelledError ||
    error instanceof FolderEnumerationDeadlineError
  )
}

function assertNoTraversal(requestedPath: string): void {
  if (requestedPath.split(/[\\/]+/u).includes('..')) {
    throw new PathPolicyError('OUTSIDE_ALLOWED_ROOT', requestedPath)
  }
}

function isContained(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
  )
}

async function assertNoSymlinks(
  root: string,
  candidate: string,
  requestedPath: string,
): Promise<void> {
  const components = relative(root, candidate).split(sep).filter(Boolean)
  let currentPath = root
  for (const component of components) {
    if (component.startsWith('.')) {
      throw new PathPolicyError('UNREADABLE_SOURCE', requestedPath)
    }
    currentPath = join(currentPath, component)
    if ((await lstat(currentPath)).isSymbolicLink()) {
      throw new PathPolicyError('SYMLINK_REJECTED', requestedPath)
    }
  }
}

function classifyFilesystemError(error: unknown, requestedPath: string): PathPolicyError {
  if (error instanceof PathPolicyError) {
    return error
  }
  return new PathPolicyError(
    isNodeError(error, 'ENOENT') ? 'SOURCE_MISSING' : 'UNREADABLE_SOURCE',
    requestedPath,
    { cause: error },
  )
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}

function mimeTypeFor(sourcePath: string): string {
  return ASSET_MIME_TYPES[extname(sourcePath).toLowerCase()] ?? 'application/octet-stream'
}

async function normalizeFilesystemOperation<T>(
  requestedPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof AssetReadLimitError) {
      throw error
    }
    throw classifyFilesystemError(error, requestedPath)
  }
}

async function readAuthorizedFile(
  authorizedSnapshot: FileSnapshot,
  requestedPath: string,
  revalidate: () => Promise<FileSnapshot>,
  maxBytes?: number,
): Promise<Buffer> {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new AssetReadLimitError(maxBytes)
  }
  assertSameFileIdentity(authorizedSnapshot, await revalidate(), requestedPath)
  const noFollowFlag = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
  const handle = await open(authorizedSnapshot.canonicalPath, constants.O_RDONLY | noFollowFlag)
  try {
    const status = await handle.stat()
    if (
      !status.isFile() ||
      status.dev !== authorizedSnapshot.deviceId ||
      status.ino !== authorizedSnapshot.inode
    ) {
      throw new PathPolicyError('UNREADABLE_SOURCE', requestedPath)
    }
    assertSameFileIdentity(authorizedSnapshot, await revalidate(), requestedPath)
    if (maxBytes === undefined) {
      return await handle.readFile()
    }
    if (status.size > maxBytes) {
      throw new AssetReadLimitError(maxBytes)
    }
    const chunks: Buffer[] = []
    let totalBytes = 0
    while (totalBytes <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - totalBytes))
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null)
      if (bytesRead === 0) break
      chunks.push(chunk.subarray(0, bytesRead))
      totalBytes += bytesRead
    }
    if (totalBytes > maxBytes) {
      throw new AssetReadLimitError(maxBytes)
    }
    return Buffer.concat(chunks, totalBytes)
  } finally {
    await handle.close()
  }
}

function assertSameFileIdentity(
  authorizedSnapshot: FileSnapshot,
  candidateSnapshot: FileSnapshot,
  requestedPath: string,
): void {
  if (
    candidateSnapshot.canonicalPath !== authorizedSnapshot.canonicalPath ||
    candidateSnapshot.deviceId !== authorizedSnapshot.deviceId ||
    candidateSnapshot.inode !== authorizedSnapshot.inode
  ) {
    throw new PathPolicyError('UNREADABLE_SOURCE', requestedPath)
  }
}
