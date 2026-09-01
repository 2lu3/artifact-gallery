import { execFile } from 'node:child_process'
import { dirname, isAbsolute, normalize } from 'node:path'

import type { PlatformActionResult } from '../../shared/contracts.js'

const PLATFORM_COMMAND_TIMEOUT_MS = 3_000

export interface PlatformCommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { readonly timeoutMs: number },
  ): Promise<void>
}

export interface SourcePlatformAdapter {
  openSource(sourcePath: string): Promise<PlatformActionResult>
  revealSource(sourcePath: string): Promise<PlatformActionResult>
}

export class PlatformActionError extends Error {
  constructor(options?: ErrorOptions) {
    super('The local source action could not be completed.', options)
    this.name = 'PlatformActionError'
  }
}

export function createPlatformAdapter(
  platform: NodeJS.Platform,
  runner: PlatformCommandRunner = nodePlatformCommandRunner,
): SourcePlatformAdapter | undefined {
  if (platform === 'darwin') {
    return {
      openSource: async (sourcePath) => runAction(runner, '/usr/bin/open', [validPath(sourcePath)]),
      revealSource: async (sourcePath) =>
        runAction(runner, '/usr/bin/open', ['-R', validPath(sourcePath)]),
    }
  }
  if (platform === 'linux') {
    return {
      openSource: async (sourcePath) =>
        runAction(runner, '/usr/bin/xdg-open', [validPath(sourcePath)]),
      revealSource: async (sourcePath) =>
        runAction(runner, '/usr/bin/xdg-open', [dirname(validPath(sourcePath))]),
    }
  }
  return undefined
}

const nodePlatformCommandRunner: PlatformCommandRunner = {
  run: (command, args, options) =>
    new Promise<void>((resolve, reject) => {
      execFile(
        command,
        [...args],
        {
          timeout: options.timeoutMs,
          maxBuffer: 64 * 1024,
          shell: false,
          windowsHide: true,
        },
        (error) => {
          if (error) reject(error)
          else resolve()
        },
      )
    }),
}

async function runAction(
  runner: PlatformCommandRunner,
  command: string,
  args: readonly string[],
): Promise<{ supported: true }> {
  try {
    await runner.run(command, args, { timeoutMs: PLATFORM_COMMAND_TIMEOUT_MS })
    return { supported: true }
  } catch (error) {
    if (error instanceof PlatformActionError) throw error
    throw new PlatformActionError({ cause: error })
  }
}

function validPath(sourcePath: string): string {
  if (
    !isAbsolute(sourcePath) ||
    sourcePath.includes('\0') ||
    sourcePath.length === 0 ||
    sourcePath.length > 4_096
  ) {
    throw new PlatformActionError()
  }
  return normalize(sourcePath)
}
