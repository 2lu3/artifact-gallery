import { describe, expect, it } from 'vitest'

import {
  PlatformActionError,
  createPlatformAdapter,
  type PlatformCommandRunner,
} from './platform-adapter.js'

describe('platform adapter', () => {
  it('uses fixed macOS commands and a bounded shell-free runner', async () => {
    const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = []
    const runner: PlatformCommandRunner = {
      run: async (command, args, options) => {
        calls.push({ command, args, timeoutMs: options.timeoutMs })
      },
    }
    const adapter = createPlatformAdapter('darwin', runner)
    if (!adapter) throw new Error('macOS adapter was not created.')

    await expect(adapter.openSource('/tmp/example.md')).resolves.toEqual({ supported: true })
    await expect(adapter.revealSource('/tmp/example.md')).resolves.toEqual({ supported: true })
    expect(calls).toEqual([
      { command: '/usr/bin/open', args: ['/tmp/example.md'], timeoutMs: 3_000 },
      { command: '/usr/bin/open', args: ['-R', '/tmp/example.md'], timeoutMs: 3_000 },
    ])
  })

  it('uses xdg-open for Linux and reveals the containing folder', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const adapter = createPlatformAdapter('linux', {
      run: async (command, args) => {
        calls.push({ command, args })
      },
    })
    if (!adapter) throw new Error('Linux adapter was not created.')

    await adapter.openSource('/home/user/example.md')
    await adapter.revealSource('/home/user/example.md')
    expect(calls).toEqual([
      { command: '/usr/bin/xdg-open', args: ['/home/user/example.md'] },
      { command: '/usr/bin/xdg-open', args: ['/home/user'] },
    ])
  })

  it('rejects invalid paths and redacts command failures', async () => {
    const runner: PlatformCommandRunner = {
      run: async () => {
        throw new Error('private terminal output and username')
      },
    }
    const adapter = createPlatformAdapter('darwin', runner)
    if (!adapter) throw new Error('macOS adapter was not created.')

    await expect(adapter.openSource('relative.md')).rejects.toBeInstanceOf(PlatformActionError)
    await expect(adapter.openSource('/tmp/example.md')).rejects.toMatchObject({
      message: 'The local source action could not be completed.',
    })
    await expect(adapter.openSource('/tmp/example.md')).rejects.not.toThrow(/private|username/u)
    expect(createPlatformAdapter('win32', runner)).toBeUndefined()
  })
})
