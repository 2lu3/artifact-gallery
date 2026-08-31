import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type PerformanceProfileName = 'acceptance' | 'smoke'

export interface PerformanceCorpusFile {
  readonly absolutePath: string
  readonly relativePath: string
  readonly format: 'html' | 'markdown'
  readonly query: string
}

export interface PerformanceCorpus {
  readonly files: readonly PerformanceCorpusFile[]
  readonly totalBytes: number
}

export interface DurationSummary {
  readonly medianMs: number
  readonly maxMs: number
  readonly targetMs: number
  readonly medianPassed: boolean
  readonly maximumExceededDoubleTarget: boolean
}

export interface PerformanceProfile {
  readonly name: PerformanceProfileName
  readonly firstPageTargetMs: number
  readonly searchTargetMs: number
  readonly requiresAppleSilicon: boolean
}

export interface PerformanceHardware {
  readonly platform: NodeJS.Platform
  readonly architecture: string
  readonly cpuCount: number
  readonly totalMemoryBytes: number
}

export interface PerformanceGateInput {
  readonly profile: PerformanceProfile
  readonly hardware: PerformanceHardware
  readonly firstPage: DurationSummary
  readonly searches: readonly DurationSummary[]
}

const THEMES = [
  'aurora',
  'botanical',
  'ceramics',
  'dashboard',
  'espresso',
  'fjord',
  'geometry',
  'harbor',
  'indigo',
  'jupiter',
] as const

export async function createPerformanceCorpus(directory: string): Promise<PerformanceCorpus> {
  await mkdir(directory, { recursive: true })
  const files: PerformanceCorpusFile[] = []
  let totalBytes = 0
  for (const format of ['html', 'markdown'] as const) {
    for (let index = 0; index < 50; index += 1) {
      const theme = THEMES[index % THEMES.length] as string
      const serial = String(index + 1).padStart(2, '0')
      const relativePath = `${format}-${serial}.${format === 'html' ? 'html' : 'md'}`
      const absolutePath = join(directory, relativePath)
      const body = deterministicDocument(format, serial, theme)
      await writeFile(absolutePath, body)
      totalBytes += Buffer.byteLength(body)
      files.push({ absolutePath, relativePath, format, query: theme })
    }
  }
  return { files, totalBytes }
}

export function summarizeDurations(
  durationsMs: readonly number[],
  targetMs: number,
): DurationSummary {
  if (durationsMs.length === 0 || durationsMs.some((value) => !Number.isFinite(value))) {
    throw new TypeError('At least one finite duration is required.')
  }
  if (!Number.isFinite(targetMs) || targetMs <= 0) {
    throw new TypeError('The performance target must be positive.')
  }
  const sorted = durationsMs.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const medianMs =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
  const maxMs = sorted.at(-1) as number
  return {
    medianMs,
    maxMs,
    targetMs,
    medianPassed: medianMs <= targetMs,
    maximumExceededDoubleTarget: maxMs > targetMs * 2,
  }
}

export function performanceProfile(name: PerformanceProfileName): PerformanceProfile {
  return name === 'acceptance'
    ? {
        name,
        firstPageTargetMs: 1_000,
        searchTargetMs: 200,
        requiresAppleSilicon: true,
      }
    : {
        name,
        firstPageTargetMs: 5_000,
        searchTargetMs: 1_000,
        requiresAppleSilicon: false,
      }
}

export function assertPerformanceGate(input: PerformanceGateInput): void {
  if (
    input.profile.requiresAppleSilicon &&
    (input.hardware.platform !== 'darwin' ||
      input.hardware.architecture !== 'arm64' ||
      input.hardware.cpuCount < 8 ||
      input.hardware.totalMemoryBytes < 16 * 1024 ** 3)
  ) {
    throw new Error(
      'Acceptance performance requires Apple Silicon with at least 8 CPU cores and 16 GiB memory.',
    )
  }
  const measurements = [input.firstPage, ...input.searches]
  if (measurements.some(({ medianPassed }) => !medianPassed)) {
    throw new Error('A performance median exceeded its profile target.')
  }
  if (measurements.some(({ maximumExceededDoubleTarget }) => maximumExceededDoubleTarget)) {
    throw new Error('A performance maximum exceeded twice its profile target.')
  }
}

export function buildSearchRunSequence(queries: readonly string[], runsPerQuery: number): string[] {
  if (queries.length < 2) throw new TypeError('At least two fixed searches are required.')
  if (!Number.isSafeInteger(runsPerQuery) || runsPerQuery < 1) {
    throw new TypeError('Search repetitions must be a positive integer.')
  }
  return Array.from({ length: runsPerQuery }, () => queries).flat()
}

function deterministicDocument(
  format: PerformanceCorpusFile['format'],
  serial: string,
  theme: string,
): string {
  const paragraph = `${theme} artifact ${serial} deterministic gallery benchmark content. `
  const content = paragraph.repeat(40)
  if (format === 'html') {
    return `<!doctype html><html><head><title>${theme} HTML ${serial}</title></head><body><main><h1>${theme} HTML ${serial}</h1><p>${content}</p></main></body></html>`
  }
  return `# ${theme} Markdown ${serial}\n\n${content}\n`
}
