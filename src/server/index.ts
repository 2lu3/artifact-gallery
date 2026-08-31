import { buildApp } from './app.js'

const app = buildApp()

await app.listen({ host: '127.0.0.1', port: 3000 })
