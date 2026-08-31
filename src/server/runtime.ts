import { mkdir } from 'node:fs/promises'
import { delimiter, dirname, resolve } from 'node:path'

import { buildApp, type LocalApiApp } from './app.js'
import { openDatabase } from './db/database.js'
import { ArtifactProcessor } from './processing/artifact-processor.js'
import { HtmlRenderer } from './rendering/html-renderer.js'
import { PathPolicy } from './security/path-policy.js'

export interface ServerRuntimeOptions {
  readonly databaseFilename: string
  readonly thumbnailDirectory: string
  readonly allowedRoots: readonly string[]
}

export async function createServerRuntime(options: ServerRuntimeOptions): Promise<LocalApiApp> {
  await mkdir(dirname(options.databaseFilename), { recursive: true })
  await mkdir(options.thumbnailDirectory, { recursive: true })
  const database = openDatabase({ filename: options.databaseFilename })
  try {
    const pathPolicy = await PathPolicy.create(options.allowedRoots)
    const htmlRenderer = new HtmlRenderer(pathPolicy)
    const processor = new ArtifactProcessor({
      database,
      pathPolicy,
      htmlRenderer,
      thumbnailDirectory: options.thumbnailDirectory,
    })
    const app = buildApp({
      database,
      pathPolicy,
      processor,
      thumbnailDirectory: options.thumbnailDirectory,
    })
    app.addHook('onClose', async () => {
      await htmlRenderer.close()
      database.close()
    })
    return app
  } catch (error) {
    database.close()
    throw error
  }
}

export function runtimeOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ServerRuntimeOptions {
  const stateDirectory = resolve(environment.ARTIFACT_GALLERY_STATE_DIRECTORY ?? '.artifact-gallery')
  const configuredRoots = environment.ARTIFACT_GALLERY_ALLOWED_ROOTS
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
  }
}
