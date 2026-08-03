import { describe, it, expect } from 'vitest'
import { createState, hashState, snapshot, restore, H_TICK, H_WEEK, H_EPOCH } from '../src/state'
import { createWorld } from '../src/world'
import { step, type TickInputs, type TickAction } from '../src/step'
import { createFlowFields, createScratch, CT_SYNCS, CT_REBUILDS, type FlowField, type Scratch } from '../src/scratch'
import { createFieldInputRanges } from '../src/regions'
import { fieldFor } from '../src/flowfield'
import { roadMask } from '../src/roads'
import { TICKS_PER_WEEK, parseMap } from '@laneways/shared'

const NO_INPUT: TickInputs = { actions: [] }
const MAP = parseMap('step-test-map', ['....', '....', '....', '....'], 20, 8, 4, 2)
const WORLD = createWorld(MAP)

function freshFields(): FlowField[] {
  return createFlowFields(MAP.groupCount, WORLD.cells)
}

function freshScratch(): Scratch {
  return createScratch(WORLD.cells, MAP.groupCount, MAP.maxDestinations, createFieldInputRanges(MAP))
}

function run(s: ReturnType<typeof createState>, n: number, fields: readonly FlowField[], scratch: Scratch): void {
  for (let i = 0; i < n; i++) step(s, WORLD, fields, scratch, NO_INPUT)
}

describe('step', () => {
  it('advances the tick by exactly one', () => {
    const s = createState('tick', MAP)
    const fields = freshFields()
    const scratch = freshScratch()
    step(s, WORLD, fields, scratch, NO_INPUT)
    expect(s.header[H_TICK]).toBe(1)
    step(s, WORLD, fields, scratch, NO_INPUT)
    expect(s.header[H_TICK]).toBe(2)
  })

  it('keeps the week counter in sync with the tick', () => {
    const s = createState('week', MAP)
    const fields = freshFields()
    const scratch = freshScratch()
    run(s, TICKS_PER_WEEK - 1, fields, scratch)
    expect(s.header[H_WEEK]).toBe(0)
    step(s, WORLD, fields, scratch, NO_INPUT)
    expect(s.header[H_WEEK]).toBe(1)
  })

  it('is deterministic — two states from one seed stay identical', () => {
    const a = createState('determinism', MAP)
    const b = createState('determinism', MAP)
    const fieldsA = freshFields()
    const scratchA = freshScratch()
    const fieldsB = freshFields()
    const scratchB = freshScratch()
    for (let i = 0; i < 500; i++) {
      step(a, WORLD, fieldsA, scratchA, NO_INPUT)
      step(b, WORLD, fieldsB, scratchB, NO_INPUT)
      expect(hashState(a)).toBe(hashState(b))
    }
  })

  it('diverges for different seeds', () => {
    const a = createState('seed-a', MAP)
    const b = createState('seed-b', MAP)
    run(a, 100, freshFields(), freshScratch())
    run(b, 100, freshFields(), freshScratch())
    expect(hashState(a)).not.toBe(hashState(b))
  })

  it('resumes identically from a snapshot taken mid-run', () => {
    const a = createState('resume', MAP)
    const fieldsA = freshFields()
    const scratchA = freshScratch()
    run(a, 250, fieldsA, scratchA)
    const mid = snapshot(a)
    run(a, 250, fieldsA, scratchA)
    const expected = hashState(a)

    const b = restore(mid, WORLD)
    run(b, 250, freshFields(), freshScratch())
    expect(hashState(b)).toBe(expected)
  })

  it('does not allocate a new state object', () => {
    const s = createState('no-alloc', MAP)
    const buf = s.buffer
    run(s, 10, freshFields(), freshScratch())
    expect(s.buffer).toBe(buf)
  })

  it('has a signature arity of exactly 5 — s, world, fields, scratch, inputs; fast-forward is N calls, never a dt parameter', () => {
    expect(step.length).toBe(5)
  })

  describe('TickAction application', () => {
    it('a place action places a road, visible via roadMask after step returns', () => {
      const s = createState('place-action', MAP)
      const fields = freshFields()
      const scratch = freshScratch()
      expect(roadMask(s, 0)).toBe(0)
      const actions: readonly TickAction[] = [{ kind: 'place', a: 0, b: 1 }]
      step(s, WORLD, fields, scratch, { actions })
      expect(roadMask(s, 0)).not.toBe(0)
      expect(roadMask(s, 1)).not.toBe(0)
    })

    it('an erase action removes a road placed on an earlier tick', () => {
      const s = createState('erase-action', MAP)
      const fields = freshFields()
      const scratch = freshScratch()
      step(s, WORLD, fields, scratch, { actions: [{ kind: 'place', a: 0, b: 1 }] })
      expect(roadMask(s, 0)).not.toBe(0)
      step(s, WORLD, fields, scratch, { actions: [{ kind: 'erase', a: 0, b: 1 }] })
      expect(roadMask(s, 0)).toBe(0)
      expect(roadMask(s, 1)).toBe(0)
    })

    it('a road placed through step on tick T is visible in the field read on tick T (input application precedes the sync)', () => {
      const s = createState('place-then-sync', MAP)
      const fields = freshFields()
      const scratch = freshScratch()
      const A = 0
      const B = 1
      // Colour 0's source is B — B carries no road yet, so before this tick's
      // place action runs, a sync would leave B at dist=INF (rejected: no
      // road bit). The action places a road ending at B in the SAME tick.
      scratch.sourceCounts[0] = 1
      scratch.sourcesFlat[0] = B
      expect(roadMask(s, B)).toBe(0) // vacuity: B genuinely has no road before this tick

      step(s, WORLD, fields, scratch, { actions: [{ kind: 'place', a: A, b: B }] })

      const field = fieldFor(s, WORLD, fields, 0, scratch)
      expect(field.dist[B]).toBe(0) // B is now an accepted source, this same tick
    })

    it('an unknown action kind throws, naming the offending kind', () => {
      const s = createState('unknown-kind', MAP)
      const fields = freshFields()
      const scratch = freshScratch()
      const badAction = { kind: 'teleport', a: 0, b: 1 } as unknown as TickAction
      expect(() => step(s, WORLD, fields, scratch, { actions: [badAction] })).toThrow(/unknown action kind/i)
    })
  })

  describe('the field sync runs exactly once per step, and only rebuilds when something changed', () => {
    it('CT_SYNCS increments by exactly 1 per step call', () => {
      const s = createState('ct-syncs', MAP)
      const fields = freshFields()
      const scratch = freshScratch()
      expect(scratch.counters[CT_SYNCS]).toBe(0)
      step(s, WORLD, fields, scratch, NO_INPUT)
      expect(scratch.counters[CT_SYNCS]).toBe(1)
      step(s, WORLD, fields, scratch, NO_INPUT)
      expect(scratch.counters[CT_SYNCS]).toBe(2)
      step(s, WORLD, fields, scratch, NO_INPUT)
      expect(scratch.counters[CT_SYNCS]).toBe(3)
    })

    it('one tick with no destinations and no inputs does not increase CT_REBUILDS', () => {
      // Nothing in the previous version's test suite caught "the sync runs
      // but rebuilds every colour every tick regardless of whether anything
      // changed" — CT_REBUILDS is the direct positive assertion that closes
      // that gap.
      const s = createState('ct-rebuilds-idle', MAP)
      const fields = freshFields()
      const scratch = freshScratch()
      step(s, WORLD, fields, scratch, NO_INPUT) // first sync always rebuilds (stamps start at 0)
      const afterFirst = scratch.counters[CT_REBUILDS] as number
      expect(afterFirst).toBeGreaterThan(0) // vacuity: the first tick genuinely rebuilt something
      step(s, WORLD, fields, scratch, NO_INPUT)
      expect(scratch.counters[CT_REBUILDS]).toBe(afterFirst)
    })

    it('placing a road increases CT_REBUILDS on that tick, not on the next idle one', () => {
      const s = createState('ct-rebuilds-road', MAP)
      const fields = freshFields()
      const scratch = freshScratch()
      step(s, WORLD, fields, scratch, NO_INPUT)
      const afterFirst = scratch.counters[CT_REBUILDS] as number
      step(s, WORLD, fields, scratch, { actions: [{ kind: 'place', a: 0, b: 1 }] })
      expect(scratch.counters[CT_REBUILDS]).toBeGreaterThan(afterFirst)
      const afterRoad = scratch.counters[CT_REBUILDS] as number
      step(s, WORLD, fields, scratch, NO_INPUT) // idle tick again
      expect(scratch.counters[CT_REBUILDS]).toBe(afterRoad)
    })
  })

  describe('atomicity: a throw poisons the state', () => {
    it('step throwing leaves H_EPOCH non-zero, and the next step and restore both throw named errors', () => {
      const s = createState('poison', MAP)
      const fields = freshFields()
      const scratch = freshScratch()
      const badAction = { kind: 'bogus', a: 0, b: 1 } as unknown as TickAction

      expect(s.header[H_EPOCH]).toBe(0)
      expect(() => step(s, WORLD, fields, scratch, { actions: [badAction] })).toThrow()
      expect(s.header[H_EPOCH]).not.toBe(0)

      expect(() => step(s, WORLD, fields, scratch, NO_INPUT)).toThrow(/H_EPOCH/)
      expect(() => restore(snapshot(s), WORLD)).toThrow(/H_EPOCH/)
    })

    it('a clean step clears H_EPOCH back to 0 on successful exit', () => {
      const s = createState('clean-epoch', MAP)
      const fields = freshFields()
      const scratch = freshScratch()
      step(s, WORLD, fields, scratch, NO_INPUT)
      expect(s.header[H_EPOCH]).toBe(0)
    })
  })
})
