import { DEFAULT_LISTEN_OPTIONS } from './app.js'
import { installGracefulShutdown } from './graceful-shutdown.js'
import { createServerRuntime, runtimeOptionsFromEnvironment } from './runtime.js'

const runtimeOptions = runtimeOptionsFromEnvironment()
const app = await createServerRuntime(runtimeOptions)
const port = runtimeOptions.port ?? DEFAULT_LISTEN_OPTIONS.port
const removeSignalListeners = installGracefulShutdown({ app })

try {
  await app.listen({ host: DEFAULT_LISTEN_OPTIONS.host, port })
} catch (error) {
  removeSignalListeners()
  await app.close()
  throw error
}
