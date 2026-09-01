import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assertPerformanceGate,
  buildSearchRunSequence,
  createPerformanceCorpus,
  performanceProfile,
  summarizeDurations,
} from './harness.js'
import * as performanceHarness from './harness.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

describe('performance harness', () => {
  it('creates the same bounded 50 HTML and 50 Markdown corpus every time', async () => {
    const first = await mkdtemp(join(tmpdir(), 'artifact-gallery-perf-first-'))
    const second = await mkdtemp(join(tmpdir(), 'artifact-gallery-perf-second-'))
    temporaryDirectories.push(first, second)

    const firstCorpus = await createPerformanceCorpus(first)
    const secondCorpus = await createPerformanceCorpus(second)

    expect(firstCorpus.files.filter(({ format }) => format === 'html')).toHaveLength(50)
    expect(firstCorpus.files.filter(({ format }) => format === 'markdown')).toHaveLength(50)
    expect(firstCorpus.totalBytes).toBeLessThanOrEqual(50 * 1024 * 1024)
    expect(firstCorpus.files.map(({ relativePath, query }) => ({ relativePath, query }))).toEqual(
      secondCorpus.files.map(({ relativePath, query }) => ({ relativePath, query })),
    )
    await expect(readFile(firstCorpus.files[73]!.absolutePath, 'utf8')).resolves.toBe(
      await readFile(secondCorpus.files[73]!.absolutePath, 'utf8'),
    )
  })

  it('reports a hand-checked median, maximum, and only flags maxima above twice target', () => {
    expect(summarizeDurations([9, 1, 5, 3, 7], 4)).toEqual({
      medianMs: 5,
      maxMs: 9,
      targetMs: 4,
      medianPassed: false,
      maximumExceededDoubleTarget: true,
    })
    expect(summarizeDurations([8, 2, 6, 4], 4)).toEqual({
      medianMs: 5,
      maxMs: 8,
      targetMs: 4,
      medianPassed: false,
      maximumExceededDoubleTarget: false,
    })
  })

  it('keeps acceptance targets distinct from generous CI smoke ceilings', () => {
    expect(performanceProfile('acceptance')).toMatchObject({
      firstPageTargetMs: 1_000,
      searchTargetMs: 200,
      requiresAppleSilicon: true,
    })
    expect(performanceProfile('smoke')).toMatchObject({
      firstPageTargetMs: 5_000,
      searchTargetMs: 1_000,
      requiresAppleSilicon: false,
    })
  })

  it('rejects acceptance on the wrong machine and rejects missed medians or doubled maxima', () => {
    const passing = summarizeDurations([100, 110, 120, 130, 140], 1_000)
    const missedMedian = summarizeDurations([900, 1_100, 1_200, 1_300, 1_400], 1_000)
    const outlier = summarizeDurations([100, 110, 120, 130, 2_001], 1_000)

    expect(() =>
      assertPerformanceGate({
        profile: performanceProfile('acceptance'),
        hardware: {
          platform: 'linux',
          architecture: 'x64',
          cpuCount: 8,
          totalMemoryBytes: 16 * 1024 ** 3,
        },
        firstPage: passing,
        searches: [passing],
        userObservedSearches: [passing],
      }),
    ).toThrow(/Apple Silicon/u)
    expect(() =>
      assertPerformanceGate({
        profile: performanceProfile('smoke'),
        hardware: {
          platform: 'linux',
          architecture: 'x64',
          cpuCount: 2,
          totalMemoryBytes: 2 * 1024 ** 3,
        },
        firstPage: missedMedian,
        searches: [passing],
        userObservedSearches: [passing],
      }),
    ).toThrow(/median/u)
    expect(() =>
      assertPerformanceGate({
        profile: performanceProfile('smoke'),
        hardware: {
          platform: 'linux',
          architecture: 'x64',
          cpuCount: 2,
          totalMemoryBytes: 2 * 1024 ** 3,
        },
        firstPage: outlier,
        searches: [passing],
        userObservedSearches: [passing],
      }),
    ).toThrow(/twice/u)
  })

  it('rejects a slow fill-to-render search even when the debounced app measure passes', () => {
    const acceptedToRender = summarizeDurations([20, 22, 24, 26, 28], 200)
    const fillToRender = summarizeDurations([190, 205, 210, 215, 220], 200)

    expect(() =>
      assertPerformanceGate({
        profile: performanceProfile('smoke'),
        hardware: {
          platform: 'linux',
          architecture: 'x64',
          cpuCount: 2,
          totalMemoryBytes: 2 * 1024 ** 3,
        },
        firstPage: summarizeDurations([100, 110, 120, 130, 140], 5_000),
        searches: [acceptedToRender],
        userObservedSearches: [fillToRender],
      }),
    ).toThrow(/user-observed search median/u)
  })

  it('creates and closes an independent cold resource for every measurement', async () => {
    const runIndependentColdMeasurements = (
      performanceHarness as unknown as {
        runIndependentColdMeasurements?: (
          runs: number,
          createMeasurement: (run: number) => Promise<{
            measure: () => Promise<number>
            close: () => Promise<void>
          }>,
        ) => Promise<number[]>
      }
    ).runIndependentColdMeasurements
    expect(typeof runIndependentColdMeasurements).toBe('function')
    if (!runIndependentColdMeasurements) return
    const created: number[] = []
    const closed: number[] = []

    const durations = await runIndependentColdMeasurements(5, async (run) => {
      created.push(run)
      return {
        measure: async () => run + 10,
        close: async () => {
          closed.push(run)
        },
      }
    })

    expect(durations).toEqual([10, 11, 12, 13, 14])
    expect(created).toEqual([0, 1, 2, 3, 4])
    expect(closed).toEqual([0, 1, 2, 3, 4])
  })

  it('runs every fixed search the requested number of times without repeating one in place', () => {
    const sequence = buildSearchRunSequence(['aurora', 'botanical', 'ceramics'], 3)

    expect(sequence).toEqual([
      'aurora',
      'botanical',
      'ceramics',
      'aurora',
      'botanical',
      'ceramics',
      'aurora',
      'botanical',
      'ceramics',
    ])
    expect(sequence.filter((query) => query === 'aurora')).toHaveLength(3)
    expect(sequence.every((query, index) => index === 0 || query !== sequence[index - 1])).toBe(
      true,
    )
  })
})
