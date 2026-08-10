import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createState, hashState, snapshot, restore, H_TICK, H_WEEK, H_TILES, H_EPOCH } from '../src/state'
import { createWorld } from '../src/world'
import { step, type TickInputs, type TickAction } from '../src/step'
import { createFlowFields, createScratch, CT_SYNCS, CT_REBUILDS, type FlowField, type Scratch } from '../src/scratch'
import { createFieldInputRanges } from '../src/regions'
import { fieldFor } from '../src/flowfield'
import { roadMask } from '../src/roads'
import {
  placeDestination,
  placeHouse,
  DEST_KIND_SQUARE,
  ORIENTATION_S,
  PHASE_OUTBOUND,
} from '../src/buildings'
import { TICKS_PER_WEEK, WEEKLY_TILE_GRANT, parseMap } from '@laneways/shared'

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

  it('the week grant runs after the clock advance — moving it earlier grants against last tick', () => {
    // The detector for transposing phases 1 and 2, AND the detector for
    // transposing 1 and 3, because both orderings put the grant in front of
    // the advance. `1 <-> 3` is the transposition M1c opened and M1d carried
    // as *undetectable*; this is the test that ends that, so do not weaken it
    // to "tiles went up at some point".
    const s = createState('phase-1-2', MAP)
    const fields = freshFields()
    const scratch = freshScratch()
    const before = s.header[H_TILES] as number
    s.header[H_TICK] = TICKS_PER_WEEK - 2
    step(s, WORLD, fields, scratch, NO_INPUT) // -> 4499, no grant
    expect(s.header[H_TICK]).toBe(TICKS_PER_WEEK - 1)
    expect(s.header[H_TILES], 'a non-boundary tick granted').toBe(before)
    step(s, WORLD, fields, scratch, NO_INPUT) // -> 4500, one grant
    expect(s.header[H_TICK]).toBe(TICKS_PER_WEEK)
    expect(s.header[H_TILES], 'the boundary tick did not grant').toBe(before + WEEKLY_TILE_GRANT)
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

  it('throws when fields.length !== world.map.groupCount, rather than silently serving colours 1..N-1 as "no field" later (1a, fix-list #26)', () => {
    // MAP.groupCount is 2 (see the module-level MAP above); a 1-element
    // fields array is a caller wiring bug that should fail loudly at the
    // one place that knows both numbers, not surface later as `fieldFor:
    // no field for colour c` once a dispatch phase exists to read it.
    expect(MAP.groupCount).toBe(2)
    const s = createState('groupcount-mismatch', MAP)
    const mismatchedFields = freshFields().slice(0, 1)
    expect(mismatchedFields.length).not.toBe(MAP.groupCount) // vacuity: genuinely mismatched
    const scratch = freshScratch()
    expect(() => step(s, WORLD, mismatchedFields, scratch, NO_INPUT)).toThrow(/groupCount/)
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
      // Rewritten in Task 6: `step` now owns source assembly (phase 4a), which
      // REWRITES `scratch.sourcesFlat`/`sourceCounts` in full from the live
      // destination prefix every tick, so the previous version's hand-poked
      // source no longer survives to the sync. The property under test is
      // unchanged and now travels the whole production path — placement,
      // assembly, sync — rather than half of it.
      const s = createState('place-then-sync', MAP)
      const fields = freshFields()
      const scratch = freshScratch()
      // Destination origin (0,0) orientation S: footprint x0..1 y0..2 (cells
      // 0,1,4,5,8,9), carpark (0,3) = 12. Hand-written literals on the 4-wide
      // board, not a call to `carparkCell`.
      const CARPARK = 12
      const NEIGHBOUR = 13 // (1,3): the only non-footprint cell adjacent to the carpark
      expect(placeDestination(s, WORLD, 0, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
      s.destPins[0] = 1
      // The carpark carries no road yet, so before this tick's place action
      // runs, assembly would reject it (`roadMask === 0`) and the colour-0
      // field would have no source at all. The action places a road reaching
      // it in the SAME tick.
      expect(roadMask(s, CARPARK)).toBe(0) // vacuity: genuinely no road before this tick

      step(s, WORLD, fields, scratch, { actions: [{ kind: 'place', a: NEIGHBOUR, b: CARPARK }] })

      // Checked BEFORE the field read, deliberately: assembly (phase 4a) runs
      // after input application, so "inputs moved after the sync" shows up
      // here as a plain 1-vs-0 rather than only as `fieldFor`'s staleness
      // throw, which names a different-looking problem.
      expect(scratch.sourceCounts[0]).toBe(1)
      const field = fieldFor(s, WORLD, fields, 0, scratch)
      expect(field.dist[CARPARK]).toBe(0) // an accepted source, this same tick
    })

    it('an unknown action kind throws, naming the offending kind', () => {
      const s = createState('unknown-kind', MAP)
      const fields = freshFields()
      const scratch = freshScratch()
      const badAction = { kind: 'teleport', a: 0, b: 1 } as unknown as TickAction
      expect(() => step(s, WORLD, fields, scratch, { actions: [badAction] })).toThrow(/unknown action kind/i)
    })

    /**
     * **A tripwire on the condition that keeps `1 <-> 2` and `2 <-> 3`
     * 0-detector — not a detector for the transpositions themselves** (M1d Task
     * 1c).
     *
     * `step.ts`'s comment records that both adjacent swaps are 0-detector
     * no-ops for exactly one reason: **no `TickAction` reads `H_TICK`.** That is
     * a property of today's action set, and the change that ends it is already
     * scheduled — `placeDestination` stamps `destSpawnTick[d]` from `H_TICK`,
     * and M1e makes building placement a `TickAction`. On that day both swaps
     * become real off-by-ones at once and nothing in the suite catches either.
     *
     * Until then **no test that could fail exists to be written for the swaps**,
     * and manufacturing one would be manufacturing a test that cannot exist. So
     * this pins the *condition* instead. It is the difference between a handoff
     * whose only carrier is a paragraph and one with a mechanism: whoever widens
     * the action set, or makes `roads.ts` read the clock, gets a red test whose
     * message points at the derivation they now own.
     *
     * A source read rather than a behavioural assertion, deliberately, on the
     * precedent of `loop.test.ts`'s cross-file golden scan and
     * `allocation.test.ts`'s `Float64Array` shape check: `TickActionKind` is a
     * type and is erased at run time, so there is nothing to observe otherwise.
     * And nothing else catches either half — the sibling test above still passes
     * with a third kind added, and `tsc` has no opinion about which header
     * fields a module imports.
     */
    it('pins the trigger that keeps the two tick-order transpositions inert', () => {
      const stepSrc = readFileSync(new URL('../src/step.ts', import.meta.url), 'utf8')
      const roadsSrc = readFileSync(new URL('../src/roads.ts', import.meta.url), 'utf8')
      // Vacuity: an empty or misresolved read satisfies both scans below.
      expect(stepSrc.length, 'step.ts read back empty').toBeGreaterThan(4000)
      expect(roadsSrc.length, 'roads.ts read back empty').toBeGreaterThan(4000)

      /**
       * Half 1: the action set is still exactly the two road edits.
       *
       * **Anchored to the whole line, and the first version of this assertion
       * was not — it used `toContain` and scored 0 detectors** against the
       * mutation it was written for. `'place' | 'erase' | 'build'` *contains*
       * `'place' | 'erase'`, so a widened union passed. Substring containment
       * cannot express "exactly these"; a line-anchored match can.
       */
      expect(
        stepSrc,
        'the TickAction set changed — re-derive tick phases 1..3 before widening it; see step.ts',
      ).toMatch(/^export type TickActionKind = 'place' \| 'erase'$/m)

      /**
       * Half 2: phase 2 still cannot observe the clock. `roads.ts` is the only
       * module it calls, and it must not import either header field.
       *
       * **One `RegExp` per field, shared by the guard and its own self-check —
       * and the first version of this had two copies of each pattern, which is
       * the catalogue's "a scan self-test re-typing its own regex" exactly.**
       * With separate copies the self-check validates only the copy it holds:
       * typoing the *guard's* `H_TICK` pattern scored **0** detectors and
       * typoing the guard's `H_WEEK` pattern scored **0**, so the clock half of
       * this mechanism was disabled and its own comment claimed otherwise.
       * Hoisted, a typo in either is a typo in both places at once and the
       * self-check below catches it.
       */
      const H_TICK_RE = /\bH_TICK\b/
      const H_WEEK_RE = /\bH_WEEK\b/

      expect(
        roadsSrc,
        'roads.ts now reads the clock — phase 2 can observe H_TICK, so the tick order needs re-deriving',
      ).not.toMatch(H_TICK_RE)
      expect(roadsSrc, 'roads.ts now reads H_WEEK — same re-derivation as above').not.toMatch(H_WEEK_RE)

      // Self-check on the scan: THE SAME two patterns must be able to match
      // something, or a typo in either is an assertion that cannot fail.
      // `step.ts` reads both fields, so it is the positive control for both.
      expect(stepSrc, 'the H_TICK pattern matches nothing — the guard above cannot fail').toMatch(H_TICK_RE)
      expect(stepSrc, 'the H_WEEK pattern matches nothing — the guard above cannot fail').toMatch(H_WEEK_RE)
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

    // The two tests below close a gap review found: state.ts's Atomicity
    // comment names THREE throw sites as the mechanism's reason for
    // existing — "an unknown TickAction.kind, a rebuild that overflows the
    // entry pool, a non-ascending source list" — and only the first was
    // covered above. Both remaining sites throw from deep inside
    // `syncFields`/`computeFlowField`, not from `step`'s own input-parsing
    // loop, which is exactly the "throws from the middle of the drain loop
    // with a partly relaxed field already written" case the plan's
    // Atomicity paragraph calls out as the dangerous one.

    // Rewritten in Task 6. The previous version of the first of these poked a
    // DESCENDING source list onto `scratch` and reached
    // `computeFlowField`'s "strictly ascending" guard. That guard is no
    // longer reachable through `step` at all, and that is a correct
    // consequence of wiring phase 4a rather than a lost test: `step` now calls
    // `assembleSources`, which rewrites the source slices in full every tick
    // by ascending insertion, so no caller can hand `syncFields` an unsorted
    // list any more. `dispatch.test.ts` and `flowfield.test.ts` still cover
    // the guard where it IS reachable — by calling `computeFlowField`
    // directly. What replaces it here is a throw from the LAST phase, which
    // is the atomicity case the wired tick newly creates: every earlier phase
    // has already mutated the buffer by then.

    it('a throw from the arrivals phase (the last phase, after every other has mutated the buffer) leaves H_EPOCH non-zero, and the next step and restore both throw named errors', () => {
      const s = createState('poison-arrivals', MAP)
      const fields = freshFields()
      const scratch = freshScratch()
      // OFF-MANIFOLD, deliberately: decision 4 proves `destReserved <=
      // destPins`, so an outbound car arriving at a pinless destination
      // cannot occur — which is exactly why arrivals ASSERT it. Hand-written
      // here because a throw out of phase 7 is otherwise unreachable.
      expect(placeHouse(s, WORLD, 15, 0)).toBe(true)
      s.carRouteLen[0] = 1
      s.carRouteCursor[0] = 1 // outbound route exhausted: this car has arrived
      s.carTargetDest[0] = 0
      s.carPhase[0] = PHASE_OUTBOUND
      s.destPins[0] = 0

      expect(s.header[H_EPOCH]).toBe(0)
      expect(() => step(s, WORLD, fields, scratch, NO_INPUT)).toThrow(/destPins/)
      expect(s.header[H_EPOCH]).not.toBe(0)

      expect(() => step(s, WORLD, fields, scratch, NO_INPUT)).toThrow(/H_EPOCH/)
      expect(() => restore(snapshot(s), WORLD)).toThrow(/H_EPOCH/)
    })

    it('an entry-pool exhaustion mid-drain (computeFlowField throwing via syncFields) leaves H_EPOCH non-zero, and the next step and restore both throw named errors', () => {
      const s = createState('poison-pool', MAP)
      const fields = freshFields()
      // A pool with room for exactly 1 entry: a source push (1) succeeds,
      // and the very next relaxation push overflows — from the middle of
      // the drain loop, with dist/dir already partly (wrongly) relaxed.
      const tinyPool: Scratch = {
        ...freshScratch(),
        entryCell: new Int32Array(1),
        entryNext: new Int32Array(1),
      }
      // The source now comes from a real placed destination, via phase 4a,
      // rather than being poked onto `scratch` — see the note above.
      const CARPARK = 12
      const NEIGHBOUR = 13
      expect(placeDestination(s, WORLD, 0, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
      s.destPins[0] = 1

      expect(s.header[H_EPOCH]).toBe(0)
      const actions: readonly TickAction[] = [{ kind: 'place', a: NEIGHBOUR, b: CARPARK }]
      expect(() => step(s, WORLD, fields, tinyPool, { actions })).toThrow(/entry pool exhausted/)
      expect(s.header[H_EPOCH]).not.toBe(0)

      expect(() => step(s, WORLD, fields, tinyPool, NO_INPUT)).toThrow(/H_EPOCH/)
      expect(() => restore(snapshot(s), WORLD)).toThrow(/H_EPOCH/)
    })
  })
})
