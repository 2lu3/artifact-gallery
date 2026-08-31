import { DEFAULT_LISTEN_OPTIONS } from './app.js'
import { createServerRuntime, runtimeOptionsFromEnvironment } from './runtime.js'

const app = await createServerRuntime(runtimeOptionsFromEnvironment())
const configuredPort = Number(process.env.PORT)
const port =
  Number.isSafeInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
    ? configuredPort
    : DEFAULT_LISTEN_OPTIONS.port

await app.listen({ host: DEFAULT_LISTEN_OPTIONS.host, port })
