import { describe, expect, it } from 'vitest'

import { BackgroundQueue } from './background-queue.js'

describe('BackgroundQueue', () => {
  it('defers work, bounds accepted jobs, and limits concurrency', async () => {
    const queue = new BackgroundQueue({ concurrency: 2, capacity: 4 })
    const releases: Array<() => void> = []
    let active = 0
    let peak = 0
    const task = async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
    }

    expect(Array.from({ length: 4 }, () => queue.enqueue(task))).toEqual([
      true,
      true,
      true,
      true,
    ])
    expect(queue.enqueue(task)).toBe(false)
    expect(active).toBe(0)

    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(active).toBe(2)
    releases.splice(0).forEach((release) => release())
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(active).toBe(2)
    releases.splice(0).forEach((release) => release())
    await queue.onIdle()
    expect(peak).toBe(2)
  })
})
