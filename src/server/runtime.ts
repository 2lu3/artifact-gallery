import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'

import { buildApp, DEFAULT_LISTEN_OPTIONS, type LocalApiApp } from './app.js'
import { openDatabase } from './db/database.js'
import { ArtifactProcessor } from './processing/artifact-processor.js'
import { WebpThumbnailOptimizer } from './processing/thumbnail-optimizer.js'
import { reconcileStartup, type StartupReconciliationReport } from './processing/recovery.js'
import { ImportWorker } from './processing/worker.js'
import { HtmlRenderer } from './rendering/html-renderer.js'
import { PathPolicy } from './security/path-policy.js'

export interface ServerRuntimeOptions {
  readonly databaseFilename: string
  readonly thumbnailDirectory: string
  readonly allowedRoots: readonly string[]
  readonly clientDirectory?: string
  readonly port?: number
  readonly reportRecovery?: (report: StartupReconciliationReport) => void | Promise<void>
}

export async function createServerRuntime(options: ServerRuntimeOptions): Promise<LocalApiApp> {
  await mkdir(dirname(options.databaseFilename), { recursive: true })
  await mkdir(options.thumbnailDirectory, { recursive: true })
  const database = openDatabase({ filename: options.databaseFilename })
  try {
    const recovery = await reconcileStartup(database, {
      temporaryDerivativeDirectory: options.thumbnailDirectory,
      interruptedAt: new Date().toISOString(),
    })
    await reportRecovery(options, recovery)
    const pathPolicy = await PathPolicy.create(options.allowedRoots)
    const derivativePathPolicy = await PathPolicy.create([options.thumbnailDirectory])
    const htmlRenderer = new HtmlRenderer(pathPolicy)
    const processor = new ArtifactProcessor({
      database,
      pathPolicy,
      htmlRenderer,
      thumbnailDirectory: options.thumbnailDirectory,
      thumbnailOptimizer: new WebpThumbnailOptimizer({
        encode: (request) => htmlRenderer.encodeWebp(request),
      }),
    })
    const importWorker = new ImportWorker({ processor, concurrency: 2, capacity: 64 })
    const app = buildApp({
      database,
      pathPolicy,
      derivativePathPolicy,
      importWorker,
      thumbnailDirectory: options.thumbnailDirectory,
      clientDirectory: options.clientDirectory,
      trustedPort: options.port ?? DEFAULT_LISTEN_OPTIONS.port,
    })
    app.addHook('onClose', async () => {
      await importWorker.close()
      await htmlRenderer.close()
      database.close()
    })
    return app
  } catch (error) {
    database.close()
    throw error
  }
}

async function reportRecovery(
  options: ServerRuntimeOptions,
  report: StartupReconciliationReport,
): Promise<void> {
  if (
    report.interruptedRunIds.length === 0 &&
    report.unstartedItems.length === 0 &&
    report.errors.length === 0
  ) {
    return
  }
  try {
    if (options.reportRecovery) {
      await options.reportRecovery(report)
      return
    }
    process.stderr.write(`[artifact-gallery] startup-recovery ${JSON.stringify(report)}\n`)
  } catch {
    // Recovery reporting must not make a reconciled local catalog unavailable.
  }
}

export function runtimeOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ServerRuntimeOptions {
  const stateDirectory = resolve(
    environment.ARTIFACT_GALLERY_STATE_DIRECTORY ?? defaultStateDirectory(environment),
  )
  const configuredRoots = environment.ARTIFACT_GALLERY_ALLOWED_ROOTS
  const configuredPort = Number(environment.PORT)
  return {
    databaseFilename: resolve(
      environment.ARTIFACT_GALLERY_DATABASE ?? resolve(stateDirectory, 'catalog.sqlite'),
    ),
    thumbnailDirectory: resolve(
      environment.ARTIFACT_GALLERY_THUMBNAILS ?? resolve(stateDirectory, 'thumbnails'),
    ),
    allowedRoots:
      configuredRoots === undefined
        ? [process.cwd()]
        : configuredRoots
            .split(delimiter)
            .map((root) => root.trim())
            .filter(Boolean),
    clientDirectory:
      environment.ARTIFACT_GALLERY_DEVELOPMENT === '1'
        ? undefined
        : resolve(environment.ARTIFACT_GALLERY_CLIENT_DIRECTORY ?? 'dist'),
    port:
      Number.isSafeInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
        ? configuredPort
        : DEFAULT_LISTEN_OPTIONS.port,
  }
}

function defaultStateDirectory(environment: NodeJS.ProcessEnv): string {
  const homeDirectory = environment.HOME ?? homedir()
  if (process.platform === 'darwin') {
    return join(homeDirectory, 'Library', 'Application Support', 'Artifact Gallery')
  }
  if (process.platform === 'win32') {
    return join(
      environment.LOCALAPPDATA ?? environment.APPDATA ?? join(homeDirectory, 'AppData', 'Local'),
      'Artifact Gallery',
    )
  }
  return join(
    environment.XDG_STATE_HOME ?? join(homeDirectory, '.local', 'state'),
    'artifact-gallery',
  )
}
