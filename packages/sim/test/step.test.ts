import { describe, it, expect } from 'vitest'
import { createState, hashState, snapshot, restore, H_TICK, H_WEEK } from '../src/state'
import { createWorld } from '../src/world'
import { step, type TickInputs } from '../src/step'
import { TICKS_PER_WEEK, parseMap } from '@laneways/shared'

const NO_INPUT: TickInputs = { actions: [] }
const MAP = parseMap('step-test-map', ['....', '....', '....', '....'], 20)
const WORLD = createWorld(MAP)

function run(s: ReturnType<typeof createState>, n: number): void {
  for (let i = 0; i < n; i++) step(s, NO_INPUT)
}

describe('step', () => {
  it('advances the tick by exactly one', () => {
    const s = createState('tick', MAP)
    step(s, NO_INPUT)
    expect(s.header[H_TICK]).toBe(1)
    step(s, NO_INPUT)
    expect(s.header[H_TICK]).toBe(2)
  })

  it('keeps the week counter in sync with the tick', () => {
    const s = createState('week', MAP)
    run(s, TICKS_PER_WEEK - 1)
    expect(s.header[H_WEEK]).toBe(0)
    step(s, NO_INPUT)
    expect(s.header[H_WEEK]).toBe(1)
  })

  it('is deterministic — two states from one seed stay identical', () => {
    const a = createState('determinism', MAP)
    const b = createState('determinism', MAP)
    for (let i = 0; i < 500; i++) {
      step(a, NO_INPUT)
      step(b, NO_INPUT)
      expect(hashState(a)).toBe(hashState(b))
    }
  })

  it('diverges for different seeds', () => {
    const a = createState('seed-a', MAP)
    const b = createState('seed-b', MAP)
    run(a, 100)
    run(b, 100)
    expect(hashState(a)).not.toBe(hashState(b))
  })

  it('resumes identically from a snapshot taken mid-run', () => {
    const a = createState('resume', MAP)
    run(a, 250)
    const mid = snapshot(a)
    run(a, 250)
    const expected = hashState(a)

    const b = restore(mid, WORLD)
    run(b, 250)
    expect(hashState(b)).toBe(expected)
  })

  it('does not allocate a new state object', () => {
    const s = createState('no-alloc', MAP)
    const buf = s.buffer
    run(s, 10)
    expect(s.buffer).toBe(buf)
  })
})
