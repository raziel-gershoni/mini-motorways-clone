import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  createState,
  failedDestination,
  hashState,
  isGameOver,
  restore,
  snapshot,
  H_EPOCH,
  H_INV_UPGRADES,
  H_TICK,
  H_TILES,
  H_UPGRADE_COUNT,
  H_WEEK,
} from '../src/state'
import { createWorld } from '../src/world'
import { step, type TickInputs, type TickAction } from '../src/step'
import { createFlowFields, createScratch, CT_SYNCS, CT_REBUILDS, type FlowField, type Scratch } from '../src/scratch'
import { createFieldInputRanges } from '../src/regions'
import { fieldFor } from '../src/flowfield'
import { roadMask } from '../src/roads'
import { isUpgraded } from '../src/upgrades'
import {
  placeDestination,
  placeHouse,
  DEST_KIND_SQUARE,
  ORIENTATION_S,
  PHASE_OUTBOUND,
} from '../src/buildings'
import { PIN_CAP_SQUARE_TIMER, TICKS_PER_WEEK, WEEKLY_TILE_GRANT, parseMap } from '@laneways/shared'

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
      // Rewritten in M1c Task 6: `step` now owns source assembly (phase 7a), which
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

      // Checked BEFORE the field read, deliberately: assembly (phase 7a) runs
      // after input application, so "inputs moved after the sync" shows up
      // here as a plain 1-vs-0 rather than only as `fieldFor`'s staleness
      // throw, which names a different-looking problem.
      expect(scratch.sourceCounts[0]).toBe(1)
      const field = fieldFor(s, WORLD, fields, 0, scratch)
      expect(field.dist[CARPARK]).toBe(0) // an accepted source, this same tick
    })

    it("dispatches 'upgrade' to applyPlaceUpgrade, not to a road edit (M1f Task 9)", () => {
      // A 4x4 board, a T at (1,1), the upgrade action queued for that cell.
      // **The roads and the tile budget are asserted UNCHANGED**, which is what
      // separates this dispatch from the `'place'` one: `applyPlaceUpgrade` costs
      // 0 tiles and lays nothing, so a branch wired to `placeRoad(a, b)` would
      // spend a tile and set a bit and this case names both.
      const s = createState('upgrade-action', MAP)
      const fields = freshFields()
      const scratch = freshScratch()
      const centre = 1 * 4 + 1
      const arms: readonly TickAction[] = [
        { kind: 'place', a: centre, b: centre - 1 },
        { kind: 'place', a: centre, b: centre + 1 },
        { kind: 'place', a: centre, b: centre - 4 },
      ]
      step(s, WORLD, fields, scratch, { actions: arms })
      s.header[H_INV_UPGRADES] = 1
      const tiles = s.header[H_TILES] as number
      const roadsBefore = [...s.roads]

      step(s, WORLD, fields, scratch, { actions: [{ kind: 'upgrade', a: centre, b: 0 }] })

      expect(isUpgraded(s, centre), 'the flag is set').toBe(true)
      expect(s.header[H_UPGRADE_COUNT]).toBe(1)
      expect(s.header[H_INV_UPGRADES], 'and one item was spent').toBe(0)
      expect(s.header[H_TILES], 'no tile was charged').toBe(tiles)
      expect([...s.roads], 'and no road bit moved').toEqual(roadsBefore)
    })

    it("ignores action.b for 'upgrade', because the pooled queue does not clear it", () => {
      // `game/src/inputs.ts` reuses one object shape, so `b` carries whatever the
      // previous action left there. A kind that validated or read it would make a
      // replay depend on the pool's history — the same hazard `choose-card`'s
      // ECHO is a deliberate exception to, and the reason this one is not.
      const s = createState('upgrade-b', MAP)
      const fields = freshFields()
      const scratch = freshScratch()
      const centre = 1 * 4 + 1
      step(s, WORLD, fields, scratch, {
        actions: [
          { kind: 'place', a: centre, b: centre - 1 },
          { kind: 'place', a: centre, b: centre + 1 },
          { kind: 'place', a: centre, b: centre - 4 },
        ],
      })
      s.header[H_INV_UPGRADES] = 2
      step(s, WORLD, fields, scratch, { actions: [{ kind: 'upgrade', a: centre, b: -12345 }] })
      expect(isUpgraded(s, centre)).toBe(true)
    })

    it("a REFUSED 'upgrade' is a byte-identical no-op tick, and does not throw", () => {
      // Unlike `choose-card`, this kind has no echo and no divergence detector:
      // a cell that stopped being a junction between the tap and the tick is an
      // ordinary refusal. The whole-buffer comparison is against the SAME tick
      // driven with no action at all, so it covers the tick's own writes too.
      const withAction = createState('upgrade-refused', MAP)
      const control = createState('upgrade-refused', MAP)
      const f1 = freshFields()
      const f2 = freshFields()
      const sc1 = freshScratch()
      const sc2 = freshScratch()
      expect(() =>
        step(withAction, WORLD, f1, sc1, { actions: [{ kind: 'upgrade', a: 5, b: 0 }] }),
      ).not.toThrow()
      step(control, WORLD, f2, sc2, NO_INPUT)
      expect(hashState(withAction), 'a refused upgrade wrote nothing at all').toBe(hashState(control))
    })

    it('an unknown action kind throws, naming the offending kind', () => {
      const s = createState('unknown-kind', MAP)
      const fields = freshFields()
      const scratch = freshScratch()
      const badAction = { kind: 'teleport', a: 0, b: 1 } as unknown as TickAction
      expect(() => step(s, WORLD, fields, scratch, { actions: [badAction] })).toThrow(/unknown action kind/i)
    })

    /**
     * **A tripwire on the condition that makes the input loop and demand
     * commute — not a detector for transposing them** (M1d Task 1c; rewritten in
     * M1e Task 2's fix round, and the rewrite is most of the point;
     * re-labelled at M1f Task 5's insertion).
     *
     * **Read the numbering first: these are TODAY'S ELEVEN-phase labels.**
     * Phase 1 is the clock advance, 2 the week grant (`week.ts`), 3 the input
     * loop, 4 the card offer (`cards.ts`), 5 spawn, **6 demand**. The pair this
     * tripwire is about is therefore `3 <-> 6`; it was `2 <-> 3` in M1c's seven
     * phases, `3 <-> 4` in M1e Task 2's eight and `3 <-> 5` in M1e Task 5's ten,
     * and this comment has now been re-labelled three times for insertions that
     * changed no code. Re-label, do not re-interpret.
     *
     * The version of this comment that stood until M1e Task 2's fix round still
     * used M1c's seven-phase labels and had become actively misleading in four
     * ways at once: it named `1 <-> 2` and `2 <-> 3` as the inert pairs, which
     * in that numbering were two of the three pairs M1e Task 2 gave detectors
     * to (3 and 1); it predicted M1e would make building placement a
     * `TickAction`, which M1e explicitly does not do — spawning is a PHASE; it
     * said no test that could fail exists for the swaps, when three now do; and
     * it said "phase 2 still cannot observe the clock" of a phase whose entire
     * job is now reading `H_TICK`. A tripwire exists to make the person who
     * trips it read the comment, so a comment that hands them the wrong pairs is
     * worse than no tripwire.
     *
     * **What is actually still inert, and why.** The input loop and demand
     * COMMUTE WITH EACH OTHER; `step.ts` records the reason in full, and it is
     * NOT the clock — the review measured the pair at 0 detectors even with
     * `roads.ts` reading `H_TICK` in a live branch, because the two phases touch
     * **disjoint state**. (The positional transposition `3 <-> 6` is not itself
     * 0-detector today, and has not been since M1e Task 5 put the spawn phase
     * between them: it also reverses inputs against spawn, which `spawn.test.ts`
     * catches. That is a fact about DISTANCE, not about these two phases, and
     * `step.ts` sets it out at length.) So this test pins three things, and only
     * the third is load-bearing for the commutation:
     *
     *   1. The action set is still exactly the four kinds phase 3 dispatches.
     *   2. `roads.ts` still cannot observe the clock. **Kept, but demoted**: it
     *      is the condition M1c and M1d recorded, it is cheap, and a
     *      clock-reading `roads.ts` is still something whoever writes it should
     *      re-derive the order for. It is no longer claimed to be what makes
     *      the two phases commute.
     *   3. **`roads.ts` writes nothing `runDemand` reads.** This is the one that
     *      would have caught the scheduled failure: M1f's §5.9 connectivity rule
     *      makes `eraseRoad` drop a disconnected destination's pending pins,
     *      which gains `roads.ts` no `H_TICK` — so guard 2 stays green — while
     *      making the pair a real one-tick pin error at 0 detectors.
     *   4. **`cards.ts` writes nothing `runDemand` reads either**, which is new
     *      at M1f Task 6 and is guard 3's subject widening rather than a second
     *      guard. Phase 3 is no longer only `roads.ts`: `applyChooseCard` is
     *      dispatched from the same loop, and it lives in `cards.ts`. Guard 3
     *      scanned one of phase 3's two modules the moment the second one
     *      landed, and a disjointness scan that covers half a phase is the
     *      catalogue's *"a check whose coverage is a strict subset"* with the
     *      subset on the wrong axis. Same five names, same hoisted patterns,
     *      same positive control.
     *
     * **What guards 3 and 4 cannot see, said here rather than left to be
     * found:** an INDIRECT write, where phase 3 calls a helper exported from
     * `demand.ts` (or anywhere else) that mutates those regions on its behalf.
     * The scan is a mechanism for the direct case and a prompt for the rest. It
     * is not a proof that the phases commute.
     *
     * **AND PHASE 3 IS NO LONGER CLOCK-BLIND, which is the condition M1c and
     * M1d recorded as keeping two transpositions inert.** `applyChooseCard`
     * reads `H_WEEK` (through `offerPending`, and again to stamp
     * `H_OFFER_WEEK`) and writes `H_TILES`. Guard 2 is *still meaningful and
     * still passes*, and the reason is deliberate design rather than luck: the
     * new kind was given its own module, so the guard keeps its subject —
     * `roads.ts`, the road-edit half of phase 3 — and says exactly what it
     * always said about it. What it can no longer be read as is a statement
     * about the whole of phase 3. The clock-freedom of phase 3 as a whole is
     * **over**, recorded here rather than left for a reader to infer from a
     * green guard, and `3 <-> 4` acquires its first detector in the same task
     * (`cards.test.ts`, *"THROWS on the boundary tick itself"*).
     *
     * A source read rather than a behavioural assertion, deliberately, on the
     * precedent of `loop.test.ts`'s cross-file golden scan and
     * `allocation.test.ts`'s `Float64Array` shape check: `TickActionKind` is a
     * type and is erased at run time, so there is nothing to observe otherwise.
     * And nothing else catches any of the three — the sibling test above still
     * passes with a third kind added, and `tsc` has no opinion about which
     * header fields or state regions a module touches.
     */
    it('pins the condition that keeps the inputs/demand tick-order pair commuting (3 <-> 6 today)', () => {
      const stepSrc = readFileSync(new URL('../src/step.ts', import.meta.url), 'utf8')
      const roadsSrc = readFileSync(new URL('../src/roads.ts', import.meta.url), 'utf8')
      const cardsSrc = readFileSync(new URL('../src/cards.ts', import.meta.url), 'utf8')
      // Vacuity: an empty or misresolved read satisfies every scan below.
      expect(stepSrc.length, 'step.ts read back empty').toBeGreaterThan(4000)
      expect(roadsSrc.length, 'roads.ts read back empty').toBeGreaterThan(4000)
      expect(cardsSrc.length, 'cards.ts read back empty').toBeGreaterThan(4000)

      /**
       * Half 1: the action set is still exactly the FOUR kinds phase 3
       * dispatches.
       *
       * **Anchored to the whole line, and the first version of this assertion
       * was not — it used `toContain` and scored 0 detectors** against the
       * mutation it was written for. `'place' | 'erase' | 'build'` *contains*
       * `'place' | 'erase'`, so a widened union passed. Substring containment
       * cannot express "exactly these"; a line-anchored match can.
       *
       * **It went red at M1f Task 6, which is the tripwire WORKING, and it went
       * red AGAIN at Task 9**, which added `'upgrade'`. Both re-derivations were
       * scheduled rather than alarming, and each cost what the pin exists to
       * charge — a reading of the paragraph above. Task 6's reading is what
       * added half 4 and ended phase 3's clock-blindness; **Task 9's is half 5,
       * and its answer is that phase 3's third module is clock-BLIND**, so
       * guards 2 and 3 keep their subjects and only the scan set widens.
       * `applyPlaceUpgrade` reads `H_INV_UPGRADES`, `H_UPGRADE_COUNT` and
       * `roads` and writes `upgradeAt` plus those two slots — none of which
       * `runDemand` touches and none of which is the clock. Retype the whole
       * line each time — do not loosen the anchor, and do not switch it back to
       * `toContain`.
       *
       * **THE COUNT IN THE HALF-1 HEADING IS NOW FOUR, and the union is total
       * over what phase 3 dispatches**: a fifth kind added without a fifth
       * branch would be a silent no-op in `step`, which the sibling case above
       * catches as an *unknown action kind* throw.
       */
      expect(
        stepSrc,
        'the TickAction set changed — re-derive tick phases 1..6 before widening it; see step.ts',
      ).toMatch(/^export type TickActionKind = 'place' \| 'erase' \| 'choose-card' \| 'upgrade'$/m)

      /**
       * Half 2: phase 3 still cannot observe the clock. `roads.ts` is the
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
        'roads.ts now reads the clock — phase 3 can observe H_TICK, so the tick order needs re-deriving',
      ).not.toMatch(H_TICK_RE)
      expect(roadsSrc, 'roads.ts now reads H_WEEK — same re-derivation as above').not.toMatch(H_WEEK_RE)

      /**
       * Half 3, and the one that actually makes the pair commute: **phase 3
       * writes nothing phase 6 reads.**
       *
       * The four names `runDemand` WRITES (`destPins`, `pinAccum`,
       * `rotationCursor`, `H_PINS_DROPPED`) plus `destSpawnTick`, which it reads
       * and which a road edit has no business stamping. `destMeta` and
       * `H_DEST_COUNT` are deliberately NOT here: both phases already read them
       * and neither writes them, and a shared read is not a conflict — banning
       * them would make this guard unsatisfiable against `roads.ts` as it
       * stands, which is how a guard gets weakened back out again.
       *
       * Banned outright rather than "must not assign", because a `roads.ts` that
       * so much as READS `destPins` is one edit away from writing it, and
       * "assignment" is not expressible in a source scan without re-typing the
       * language's grammar. All five score 0 occurrences in `roads.ts` today.
       *
       * Same hoisted-pattern discipline as Half 2: ONE array, used by the guard
       * and by its own self-check, so a typo disarms both at once and is caught.
       * **Both halves were proved rather than assumed** — adding
       * `state.destPins[d] = 0` to `roads.ts` turns this red with the message
       * below, and typoing `pinAccum` in the list turns the self-check red.
       */
      const DEMAND_STATE = ['destPins', 'pinAccum', 'rotationCursor', 'H_PINS_DROPPED', 'destSpawnTick']
      const demandRe = (name: string): RegExp => new RegExp(`\\b${name}\\b`)

      for (const name of DEMAND_STATE) {
        expect(
          roadsSrc,
          `roads.ts now touches ${name}, which runDemand reads — phases 3 and 6 no longer commute, ` +
            'and transposing them is a one-tick pin error nothing else catches; see step.ts',
        ).not.toMatch(demandRe(name))
      }

      /**
       * Half 4: the OTHER module phase 3 dispatches into, on the same five
       * names and the same patterns.
       *
       * `applyChooseCard` (M1f Task 6) is the second thing the input loop calls,
       * so from Task 6 on "phase 3 writes nothing phase 6 reads" is a claim
       * about two files. It reads `H_WEEK` and writes `H_TILES`,
       * `H_INV_UPGRADES` and `H_OFFER_WEEK` — none of which `runDemand` touches
       * — and this scan is what keeps it that way. All five score 0 occurrences
       * in `cards.ts` today, in code and in prose alike.
       */
      for (const name of DEMAND_STATE) {
        expect(
          cardsSrc,
          `cards.ts now touches ${name}, which runDemand reads — phase 3 dispatches into this ` +
            'module too (applyChooseCard), so phases 3 and 6 no longer commute; see step.ts',
        ).not.toMatch(demandRe(name))
      }

      /**
       * Half 5: the THIRD module phase 3 dispatches into, on the same five names
       * and the same patterns.
       *
       * `applyPlaceUpgrade` (M1f Task 9) is dispatched from the same loop, so
       * "phase 3 writes nothing phase 6 reads" is now a claim about three files.
       * It reads `H_INV_UPGRADES`, `H_UPGRADE_COUNT` and `roads` (through
       * `isJunctionCell`) and writes `upgradeAt` and the same two slots — none of
       * which `runDemand` touches — and this scan is what keeps it that way. The
       * subject widening is the same shape half 4 was: a disjointness scan that
       * covers two thirds of a phase is the catalogue's *"a check whose coverage
       * is a strict subset"* with the subset on the wrong axis.
       *
       * **And `upgrades.ts` is CLOCK-BLIND, which is why guard 2 is not widened
       * to it and this is stated instead of asserted.** Guard 2's subject is
       * `roads.ts`, the road-edit half of phase 3, and it says exactly what it
       * has always said about that file; the clock-freedom of phase 3 *as a
       * whole* ended at Task 6 and no later task can end it twice.
       */
      const upgradesSrc = readFileSync(new URL('../src/upgrades.ts', import.meta.url), 'utf8')
      expect(upgradesSrc.length, 'upgrades.ts read back empty').toBeGreaterThan(2000)
      for (const name of DEMAND_STATE) {
        expect(
          upgradesSrc,
          `upgrades.ts now touches ${name}, which runDemand reads — phase 3 dispatches into this ` +
            'module too (applyPlaceUpgrade), so phases 3 and 6 no longer commute; see step.ts',
        ).not.toMatch(demandRe(name))
      }

      // Self-check on Half 3: THE SAME patterns must be able to match
      // something. `demand.ts` is the positive control — it owns all five — so a
      // typo in any pattern turns this red instead of silently disarming the
      // guard above. Without it, misspelling `rotationCursor` is an assertion
      // that cannot fail, which is exactly how the H_TICK pattern was found
      // disarmed in M1d.
      const demandSrc = readFileSync(new URL('../src/demand.ts', import.meta.url), 'utf8')
      expect(demandSrc.length, 'demand.ts read back empty').toBeGreaterThan(4000)
      for (const name of DEMAND_STATE) {
        expect(
          demandSrc,
          `the ${name} pattern matches nothing in demand.ts — the guard above cannot fail`,
        ).toMatch(demandRe(name))
      }

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
    // consequence of wiring phase 7a rather than a lost test: `step` now calls
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
      // here because a throw out of the arrivals phase is otherwise unreachable.
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
      // The source now comes from a real placed destination, via phase 7a,
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

// ---------------------------------------------------------------------------
// §5.8's shutdown: `step` freezes from its FIRST LINE — M1e Task 8
// ---------------------------------------------------------------------------

/**
 * One square destination held over its trigger cap on a board with no house at
 * all, so nothing ever arrives, the meter is monotone and the run ends on the
 * 3,390th tick.
 *
 * `destPins` is written by hand rather than driven through `runDemand`, for
 * `overcrowd.test.ts`'s reason: the meter's whole input is the pin count, and a
 * fixture that had to accumulate one would take a different number of ticks to
 * reach the cap on every map. What is NOT hand-written is anything about the
 * shutdown itself — the flag, the tick and the frozen bytes all come out of
 * `step`.
 */
function shutdownRig(id: string): {
  s: ReturnType<typeof createState>
  fields: FlowField[]
  scratch: Scratch
} {
  const s = createState(id, MAP)
  const fields = freshFields()
  const scratch = freshScratch()
  expect(placeDestination(s, WORLD, 0, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
  s.destPins[0] = PIN_CAP_SQUARE_TIMER
  return { s, fields, scratch }
}

/** Steps until the run ends, returning the tick it ended on. Throws rather than looping forever. */
function driveToShutdown(rig: ReturnType<typeof shutdownRig>): number {
  for (let i = 0; i < 6000; i++) {
    step(rig.s, WORLD, rig.fields, rig.scratch, NO_INPUT)
    if (isGameOver(rig.s)) return rig.s.header[H_TICK] as number
  }
  throw new Error('shutdownRig never reached game over in 6,000 ticks')
}

/** Two adjacent free cells on the 4x4, clear of the destination's footprint and its carpark. */
const FREE_A = 14
const FREE_B = 15

describe('§5.8: the city shuts down and `step` freezes', () => {
  it('ends the run on the 3,390th consecutive over-capacity tick, naming the destination', () => {
    const rig = shutdownRig('shutdown-tick')
    for (let i = 0; i < 3389; i++) step(rig.s, WORLD, rig.fields, rig.scratch, NO_INPUT)
    expect(isGameOver(rig.s), 'one tick short').toBe(false)
    expect(rig.s.header[H_TICK]).toBe(3389)

    step(rig.s, WORLD, rig.fields, rig.scratch, NO_INPUT)
    expect(isGameOver(rig.s)).toBe(true)
    expect(failedDestination(rig.s)).toBe(0)
    expect(rig.s.header[H_TICK], 'the failing tick itself still counted').toBe(3390)
  })

  it('freezes the whole buffer: every later step is a byte-identical no-op', () => {
    // **What the leaderboard needs, and why the freeze lives in `sim` rather
    // than in the caller.** A Worker replaying an input log that runs past the
    // failure must compute the same score as the browser that produced it,
    // whatever the log's length — so a post-failure tick has to be a
    // byte-identical no-op in `step` itself, not merely a tick the game loop
    // chose not to run.
    const rig = shutdownRig('shutdown-freeze')
    const endedAt = driveToShutdown(rig)
    const frozen = new Uint8Array(snapshot(rig.s))
    const digest = hashState(rig.s)

    // Actions on every frozen tick, not an empty batch: the early return is
    // above the input loop, so a road the log still carries must not be laid.
    // With an empty batch this test would pass on a `step` whose freeze sat
    // anywhere below phase 3.
    const actions: readonly TickAction[] = [{ kind: 'place', a: FREE_A, b: FREE_B }]
    for (let i = 0; i < 500; i++) step(rig.s, WORLD, rig.fields, rig.scratch, { actions })

    expect(new Uint8Array(snapshot(rig.s))).toEqual(frozen)
    expect(hashState(rig.s)).toBe(digest)
    expect(rig.s.header[H_TICK], 'even the clock stops').toBe(endedAt)
    expect(rig.s.roads[FREE_A], 'and the queued road was never laid').toBe(0)
    // Vacuity: that action IS one the same board would have applied while
    // live, so "no road appeared" is the freeze and not a refused placement.
    const live = shutdownRig('shutdown-freeze-control')
    step(live.s, WORLD, live.fields, live.scratch, { actions })
    expect(live.s.roads[FREE_A], 'the control laid it, so the action is a real one').not.toBe(0)
  })

  it('does not poison the buffer on the frozen ticks — a terminal state stays restorable', () => {
    // The early return is BEFORE the `H_EPOCH` write, deliberately. If it were
    // after, every post-failure tick would leave the atomicity marker set and
    // `restore` would refuse the save M3 is about to write — so the run would
    // end in a state that cannot be saved, which is the one state a leaderboard
    // cannot tolerate.
    const rig = shutdownRig('shutdown-epoch')
    driveToShutdown(rig)
    expect(rig.s.header[H_EPOCH], 'the failing tick itself exited cleanly').toBe(0)

    step(rig.s, WORLD, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_EPOCH], 'and a frozen tick writes no epoch at all').toBe(0)

    const restored = restore(snapshot(rig.s), WORLD)
    expect(isGameOver(restored), 'the restored run is still over').toBe(true)
    expect(failedDestination(restored)).toBe(0)
    expect(hashState(restored)).toBe(hashState(rig.s))
    // And it stays frozen after the round trip, on fresh fields and scratch —
    // the freeze is a property of the buffer, not of the objects beside it.
    step(restored, WORLD, freshFields(), freshScratch(), NO_INPUT)
    expect(hashState(restored)).toBe(hashState(rig.s))
  })

  it('scores identically whether the log stops at the failure or runs 2,000 ticks past it', () => {
    // The replay property stated as the thing it protects rather than as a
    // byte comparison: two runs of the SAME board over logs of different
    // lengths must agree on the digest, which is what makes a Worker's verdict
    // trustworthy without the Worker knowing where the run ended.
    // The SAME seed on both, obviously — the property is about log length, and
    // two different seeds would make this pass or fail for a reason that has
    // nothing to do with the freeze.
    const short = shutdownRig('shutdown-replay')
    driveToShutdown(short)

    const long = shutdownRig('shutdown-replay')
    driveToShutdown(long)
    for (let i = 0; i < 2000; i++) step(long.s, WORLD, long.fields, long.scratch, NO_INPUT)

    expect(hashState(long.s)).toBe(hashState(short.s))
    expect(long.s.header[H_TICK]).toBe(short.s.header[H_TICK])
  })
})
