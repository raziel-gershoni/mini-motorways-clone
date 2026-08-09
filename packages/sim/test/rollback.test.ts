import { describe, it, expect } from 'vitest'
import { parseMap, type MapData } from '@laneways/shared'
import { createState, snapshot, restore, hashState, H_TICK, type GameState } from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { placeRoad, tilesLeft, DIR_COUNT, DX, DY } from '../src/roads'
import { seedFromString, randomBelow, nextRandom } from '../src/rng'
import { hashBytes } from '../src/hash'
import {
  createFlowField,
  createFlowFields,
  createScratch,
  INF,
  ST_EXPANSIONS,
  type FlowField,
  type Scratch,
} from '../src/scratch'
import { computeFlowField, hashFieldInputRegions, syncFields, fieldFor } from '../src/flowfield'
import { createFieldInputRanges } from '../src/regions'
import { step } from '../src/step'
import type { TickInputs } from '../src/step'

/**
 * Proves the one claim M1b cannot demonstrate by construction: that state
 * living OUTSIDE the snapshot — the per-colour `FlowField`s and the
 * transient `Scratch` — cannot make a restored run diverge from a fresh one.
 *
 * A same-input fresh-vs-used comparison is structurally blind to this: a
 * rerun of IDENTICAL inputs is idempotent, so residue created inside the
 * measured sequence is identical in both arms and invisible. This file uses
 * three independent techniques together (poison-fill, differing inputs, a
 * genuine snapshot/restore round trip), because each catches a survivor the
 * others do not — see each section's own comment for the specific bug it
 * exists to catch.
 *
 * No source file is added by this task. Every array named in `Scratch`/
 * `FlowField` (scratch.ts) is poisoned below.
 *
 * **What this file establishes, listed precisely.** An earlier version of
 * this header claimed that "every stamp-comparison branch in
 * `syncFields`/`fieldFor` is exercised by the snapshot-and-replay arm or the
 * invalidation test". That was true of the REJECT side only, and overstated:
 *
 *   - Step 1 — the fresh-vs-used invariant, in three arms.
 *   - Step 2 — `syncFields`' reject side across a genuine snapshot/restore:
 *     the abandoned timeline's field is rebuilt rather than reused.
 *   - Step 2b — `fieldFor`'s reject-on-read, with no invalidation call
 *     anywhere in the test.
 *   - Step 2c — `syncFields`' ACCEPT side across the same restore: a field
 *     built BEFORE a rollback is legitimately kept afterwards, unrebuilt,
 *     when the restored content matches what it was built from. This is the
 *     direction where a bug is silent — no throw, no rebuild, just a reused
 *     field — and it was the one arm this file did not have.
 *   - Step 3 — two blessed goldens, one over `s.buffer`, one over field
 *     bytes.
 *
 * It does NOT establish `fieldFor`'s never-built or cell-count branches.
 * Those live in `flowfield.test.ts`, pinned there by message rather than by
 * a bare `.toThrow()`.
 *
 * If this file needed a new production function to make an assertion
 * possible, that would itself be a finding — a behaviour this task is meant
 * to prove would have no reachable call site.
 *
 * **M1c widened `syncFields`/`fieldFor`/`computeFlowField` to read sources
 * from `scratch.sourcesFlat`/`scratch.sourceCounts` (or, for
 * `computeFlowField`, a preallocated `Int32Array` plus `(offset, count)`)
 * rather than a plain `readonly number[]`.** The adapter helpers below
 * preserve every existing call's SHAPE (an array of numbers) so this file's
 * proof structure and comments read exactly as before; only the plumbing
 * underneath changed. Also renamed: `hashRoadRegion` -> `hashFieldInputRegions`
 * (it now folds every FIELD_INPUT region, not just roads + the map hash),
 * and `FlowField.builtFromRoads` -> `builtFromFieldInputs`.
 */

// ---------------------------------------------------------------------------
// Fixtures and helpers. Duplicated from flowfield.test.ts rather than
// imported — this codebase's test files do not import from one another (each
// is a self-contained unit), and these are the same well-exercised shapes.
// ---------------------------------------------------------------------------

function cellAt(w: number, x: number, y: number): number {
  return y * w + x
}

function landFixture(id: string, w: number, h: number): { map: MapData; world: WorldData } {
  const rows = Array.from({ length: h }, () => '.'.repeat(w))
  const map = parseMap(id, rows, 999, 40, 16, 5)
  const world = createWorld(map)
  return { map, world }
}

/** A moderately dense, seeded-random road graph — same technique as flowfield.test.ts. */
function randomGraphFixture(
  id: string,
  w: number,
  h: number,
  attempts: number,
): { state: GameState; world: WorldData } {
  const { map, world } = landFixture(id, w, h)
  const state = createState(`${id}-seed`, map)
  const driver = new Uint32Array(1)
  driver[0] = seedFromString(`${id}-driver`)

  let placed = 0
  for (let i = 0; i < attempts; i++) {
    const a = randomBelow(driver, 0, world.cells)
    const dir = randomBelow(driver, 0, DIR_COUNT)
    const x = a % world.w
    const y = (a / world.w) | 0
    const nx = x + (DX[dir] as number)
    const ny = y + (DY[dir] as number)
    if (nx < 0 || nx >= world.w || ny < 0 || ny >= world.h) continue
    const b = ny * world.w + nx
    if (placeRoad(state, world, a, b)) placed++
  }
  if (placed < 50) {
    throw new Error(`randomGraphFixture("${id}"): only placed ${placed} segments, fixture is too sparse`)
  }
  return { state, world }
}

/** The first `count` cell indices (ascending) that carry a road bit. */
function firstRoadedCells(state: GameState, world: WorldData, count: number): number[] {
  const out: number[] = []
  for (let c = 0; c < world.cells && out.length < count; c++) {
    if ((state.roads[c] as number) !== 0) out.push(c)
  }
  if (out.length < count) {
    throw new Error(`firstRoadedCells: found only ${out.length} of ${count} requested roaded cells`)
  }
  return out
}

/**
 * `f.dist.buffer` alone is correct only while `f` owns its buffer — not a
 * property worth depending on silently (per the brief). Byte views are taken
 * from `buffer` + `byteOffset` + `byteLength` explicitly instead.
 */
function fieldByteViews(f: FlowField): readonly Uint8Array[] {
  return [
    new Uint8Array(f.dist.buffer, f.dist.byteOffset, f.dist.byteLength),
    new Uint8Array(f.dir.buffer, f.dir.byteOffset, f.dir.byteLength),
  ]
}

/**
 * `hashBytes` over every colour's dist-then-dir bytes, concatenated in
 * colour order — the "folded together" byte recipe both goldens in this
 * file share. Used both for a single field (the snapshot-and-replay trace,
 * one call per colour per tick) and for the whole `fields` array at once
 * (the field golden).
 */
function foldedFieldsHash(fields: readonly FlowField[]): number {
  const chunks = fields.flatMap(fieldByteViews)
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const combined = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    combined.set(c, offset)
    offset += c.length
  }
  return hashBytes(combined)
}

function hashField(f: FlowField): number {
  return foldedFieldsHash([f])
}

type Fill = (arr: Int32Array | Int8Array, seed: string) => void

/**
 * Four patterns, deliberately not one: a single pattern can coincide with a
 * correct reset value and prove nothing (`all -1` happens to BE the correct
 * post-reset value for `bucketHead` and for `dir`, so it alone could never
 * catch either fill being deleted — the other three patterns exist
 * specifically to not have that problem).
 */
const POISON_PATTERNS: ReadonlyArray<{ readonly name: string; readonly fill: Fill }> = [
  { name: 'all 0x7f', fill: (arr) => arr.fill(0x7f) },
  { name: 'all -1', fill: (arr) => arr.fill(-1) },
  { name: 'all 0', fill: (arr) => arr.fill(0) },
  {
    name: 'seeded garbage',
    fill: (arr, seed) => {
      const driver = new Uint32Array(1)
      driver[0] = seedFromString(seed)
      for (let i = 0; i < arr.length; i++) arr[i] = nextRandom(driver, 0)
    },
  },
]

/**
 * Poisons every array in BOTH `scratch` and `field` — not Scratch's own
 * arrays alone. This is load-bearing, not over-caution: `dist`/`dir` live on
 * the OUTPUT `FlowField`, not on `Scratch`, and `computeFlowField`'s
 * unconditional `dist.fill(INF)` / `dir.fill(-1)` is exactly what this arm
 * exists to prove (Step 5's named mutation deletes one of these two lines).
 * Poisoning `Scratch`'s arrays alone, while leaving a freshly allocated
 * (all-zero) `out` on the "used" side, cannot catch either fill being
 * deleted: a brand-new `Int32Array`/`Int8Array` already reads 0, so "the
 * reset ran" and "the reset didn't run, but the array started at 0 anyway"
 * are indistinguishable without poisoning `out` too. This reading of
 * "Scratch" as the whole reusable pair — not the `Scratch` type alone — is
 * the same one this codebase's own tests already use (flowfield.test.ts's
 * "fresh vs. used scratch/field" naming).
 */
function poisonAll(scratch: Scratch, field: FlowField, fill: Fill, seed: string): void {
  fill(scratch.bucketHead, `${seed}-bucketHead`)
  fill(scratch.entryCell, `${seed}-entryCell`)
  fill(scratch.entryNext, `${seed}-entryNext`)
  fill(scratch.nbrCell, `${seed}-nbrCell`)
  fill(scratch.nbrDir, `${seed}-nbrDir`)
  fill(scratch.stats, `${seed}-stats`)
  fill(field.dist, `${seed}-dist`)
  fill(field.dir, `${seed}-dir`)
}

const NO_INPUT: TickInputs = { actions: [] }

// --- M1c call-shape adapters (duplicated from flowfield.test.ts) ----------

function scratchOnly(world: WorldData): Scratch {
  return createScratch(world.cells, 1, world.map.maxDestinations, createFieldInputRanges(world.map))
}

function scratchFor(world: WorldData, groupCount: number): Scratch {
  return createScratch(world.cells, groupCount, world.map.maxDestinations, createFieldInputRanges(world.map))
}

function computeField(
  state: GameState,
  world: WorldData,
  sources: readonly number[],
  out: FlowField,
  scratch: Scratch,
): void {
  computeFlowField(state, world, Int32Array.from(sources), 0, sources.length, out, scratch)
}

function setSources(scratch: Scratch, world: WorldData, colour: number, list: readonly number[]): void {
  const maxDestinations = world.map.maxDestinations
  scratch.sourceCounts[colour] = list.length
  for (let i = 0; i < list.length; i++) {
    scratch.sourcesFlat[colour * maxDestinations + i] = list[i] as number
  }
}

function syncFieldsFromLists(
  state: GameState,
  world: WorldData,
  sourcesByColour: readonly (readonly number[])[],
  fields: readonly FlowField[],
  scratch: Scratch,
): void {
  for (let c = 0; c < sourcesByColour.length; c++) {
    setSources(scratch, world, c, sourcesByColour[c] as readonly number[])
  }
  syncFields(state, world, fields, scratch)
}

function fieldForColour(
  state: GameState,
  world: WorldData,
  fields: readonly FlowField[],
  colour: number,
  scratch: Scratch,
): FlowField {
  return fieldFor(state, world, fields, colour, scratch)
}

/** `hashFieldInputRegions`, deriving `ranges` from `world.map` — the M1b call shape took no `ranges` argument. */
function hashInputsFor(state: GameState, world: WorldData): number {
  return hashFieldInputRegions(state, createFieldInputRanges(world.map))
}

// ---------------------------------------------------------------------------
// Step 1: the fresh-vs-used invariant, in three arms.
// ---------------------------------------------------------------------------

describe('rollback proof: the fresh-vs-used invariant', () => {
  describe('(a) poison fill: every scratch+field array poisoned before the measured call', () => {
    for (const pattern of POISON_PATTERNS) {
      it(`matches a freshly allocated Scratch+FlowField byte-for-byte, poisoned with ${pattern.name}`, () => {
        const { state, world } = randomGraphFixture(`poison-${pattern.name}`, 9, 7, 250)
        const sources = firstRoadedCells(state, world, 2)

        const freshField = createFlowField(world.cells)
        const freshScratch = scratchOnly(world)
        computeField(state, world, sources, freshField, freshScratch)

        const usedField = createFlowField(world.cells)
        const usedScratch = scratchOnly(world)
        poisonAll(usedScratch, usedField, pattern.fill, `poison-seed-${pattern.name}`)
        computeField(state, world, sources, usedField, usedScratch)

        expect(Array.from(usedField.dist)).toEqual(Array.from(freshField.dist))
        expect(Array.from(usedField.dir)).toEqual(Array.from(freshField.dir))
      })
    }
  })

  /**
   * Same-input reruns are idempotent, so a naive fresh-vs-used test (same
   * sources on both sides) cannot see residue created INSIDE the measured
   * call. The survivor: an `if (sources.length === 0) return` guard leaves
   * the previous colour's field live for the next one. Structure: on a used
   * pair, run computation A (real sources, leaves genuine non-trivial
   * content) then computation B (EMPTY sources — the exact shape that would
   * trip such a guard); on a fresh pair, run B alone; compare B's result.
   */
  describe('(b) differing inputs: A then B on a used pair vs. B alone on a fresh pair', () => {
    it('computing A (real sources) then B (empty sources) on a used pair matches computing B alone, fresh', () => {
      const { state, world } = randomGraphFixture('differing-inputs', 9, 7, 250)
      const sourcesA = firstRoadedCells(state, world, 2)

      const usedField = createFlowField(world.cells)
      const usedScratch = scratchOnly(world)
      computeField(state, world, sourcesA, usedField, usedScratch)
      // Vacuity: A must leave real, non-degenerate residue for B to risk leaking.
      expect(Array.from(usedField.dist).some((d) => d !== INF && d !== 0)).toBe(true)

      const sourcesB: readonly number[] = [] // exactly `sources.length === 0`
      computeField(state, world, sourcesB, usedField, usedScratch)

      const freshField = createFlowField(world.cells)
      const freshScratch = scratchOnly(world)
      computeField(state, world, sourcesB, freshField, freshScratch)

      expect(Array.from(usedField.dist)).toEqual(Array.from(freshField.dist))
      expect(Array.from(usedField.dir)).toEqual(Array.from(freshField.dir))
      // With zero sources, the correct answer is entirely unreachable — not A's leftovers.
      expect(Array.from(freshField.dist).every((d) => d === INF)).toBe(true)
      expect(Array.from(freshField.dir).every((d) => d === -1)).toBe(true)
    })
  })

  /**
   * Per the `bucketHead.fill(-1)` asymmetry named in Task 5: both call
   * orders must agree. Under correct code neither ordering can matter (each
   * `Scratch`/`FlowField` pair is independent memory with no shared state to
   * race), so this doubles as a direct check that call order is genuinely
   * irrelevant to the result — not merely assumed to be.
   */
  describe('(c) both directions: fresh-then-used and used-then-fresh must agree', () => {
    function buildUsedPair(
      state: GameState,
      world: WorldData,
      dirtySources: readonly number[],
    ): { field: FlowField; scratch: Scratch } {
      const field = createFlowField(world.cells)
      const scratch = scratchOnly(world)
      computeField(state, world, dirtySources, field, scratch) // dirties it with a real, unrelated prior computation
      return { field, scratch }
    }

    it('fresh-then-used: the fresh computation runs first, the used one second', () => {
      const { state, world } = randomGraphFixture('order-fresh-first', 9, 7, 250)
      const roaded = firstRoadedCells(state, world, 3)
      const sources = [roaded[0] as number]
      const dirtySources = [roaded[1] as number, roaded[2] as number]

      const freshField = createFlowField(world.cells)
      const freshScratch = scratchOnly(world)
      computeField(state, world, sources, freshField, freshScratch)

      const used = buildUsedPair(state, world, dirtySources)
      computeField(state, world, sources, used.field, used.scratch)

      expect(Array.from(used.field.dist)).toEqual(Array.from(freshField.dist))
      expect(Array.from(used.field.dir)).toEqual(Array.from(freshField.dir))
    })

    it('used-then-fresh: the used computation runs first, the fresh one second', () => {
      const { state, world } = randomGraphFixture('order-used-first', 9, 7, 250)
      const roaded = firstRoadedCells(state, world, 3)
      const sources = [roaded[0] as number]
      const dirtySources = [roaded[1] as number, roaded[2] as number]

      const used = buildUsedPair(state, world, dirtySources)
      computeField(state, world, sources, used.field, used.scratch)

      const freshField = createFlowField(world.cells)
      const freshScratch = scratchOnly(world)
      computeField(state, world, sources, freshField, freshScratch)

      expect(Array.from(used.field.dist)).toEqual(Array.from(freshField.dist))
      expect(Array.from(used.field.dir)).toEqual(Array.from(freshField.dir))
    })
  })
})

// ---------------------------------------------------------------------------
// Step 2: the snapshot-and-replay arm — the rollback this design exists to
// serve, and the one arm above cannot substitute for.
// ---------------------------------------------------------------------------

interface TraceEntry {
  readonly tick: number
  readonly stateHash: number
  readonly field0Hash: number
  readonly field1Hash: number
}

/** One scripted tick: apply this tick's edits, advance the clock, sync, record. */
function runScriptedTick(
  state: GameState,
  world: WorldData,
  edits: ReadonlyArray<{ readonly a: number; readonly b: number }>,
  fields: readonly FlowField[],
  scratch: Scratch,
  sourcesByColour: readonly (readonly number[])[],
): TraceEntry {
  for (const e of edits) placeRoad(state, world, e.a, e.b) // not asserted: a repeat/failed attempt is a legitimate no-op
  step(state, world, fields, scratch, NO_INPUT)
  syncFieldsFromLists(state, world, sourcesByColour, fields, scratch)
  const f0 = fieldForColour(state, world, fields, 0, scratch)
  const f1 = fieldForColour(state, world, fields, 1, scratch)
  return {
    tick: state.header[H_TICK] as number,
    stateHash: hashState(state),
    field0Hash: hashField(f0),
    field1Hash: hashField(f1),
  }
}

describe('the snapshot-and-replay arm', () => {
  it('replaying from a snapshot on the SAME reused FlowField/Scratch objects reproduces the trace exactly', () => {
    const W = 8
    const H = 6
    // groupCount: 2 — matches this test's 2-colour fixture exactly, so
    // fields.length === map.groupCount (syncFields' guard).
    const map = parseMap('rollback-replay-fixture', Array.from({ length: H }, () => '.'.repeat(W)), 999, 40, 16, 2)
    const world = createWorld(map)
    const state = createState('rollback-replay-seed', map)
    const S0 = 0
    const S1 = world.cells - 1
    const sourcesByColour = [[S0], [S1]] as const

    // A fixed script of candidate edits, one entry per tick, generated ONCE
    // via a seeded driver — this is the input log a real replay would
    // record, consumed by index identically in both arms below, never
    // re-walked from a live rng stream a second time.
    const TICKS = 16
    const T = 10
    const driver = new Uint32Array(1)
    driver[0] = seedFromString('rollback-replay-edits')
    const editsPerTick: Array<ReadonlyArray<{ readonly a: number; readonly b: number }>> = []
    editsPerTick.push([
      { a: S0, b: S0 + 1 }, // seeds colour 0's network so S0 is an accepted source from tick 1
      { a: S1, b: S1 - 1 }, // seeds colour 1's network so S1 is an accepted source from tick 1
    ])
    for (let t = 2; t <= TICKS; t++) {
      const a = randomBelow(driver, 0, world.cells)
      const dir = randomBelow(driver, 0, DIR_COUNT)
      const x = a % W
      const y = (a / W) | 0
      const nx = x + (DX[dir] as number)
      const ny = y + (DY[dir] as number)
      const list: Array<{ readonly a: number; readonly b: number }> =
        nx >= 0 && nx < W && ny >= 0 && ny < H ? [{ a, b: ny * W + nx }] : []
      editsPerTick.push(list)
    }

    const fields = createFlowFields(2, world.cells)
    const scratch = scratchFor(world, 2)

    const originalTrace: TraceEntry[] = []
    for (let t = 1; t <= T; t++) {
      originalTrace.push(
        runScriptedTick(state, world, editsPerTick[t - 1] as ReadonlyArray<{ a: number; b: number }>, fields, scratch, sourcesByColour),
      )
    }

    const inputsHashAtSnapshot = hashInputsFor(state, world)
    const snap = snapshot(state)

    for (let t = T + 1; t <= TICKS; t++) {
      originalTrace.push(
        runScriptedTick(state, world, editsPerTick[t - 1] as ReadonlyArray<{ a: number; b: number }>, fields, scratch, sourcesByColour),
      )
    }
    // Length asserted BEFORE comparing — an empty trace compares equal to an empty trace.
    expect(originalTrace.length).toBe(TICKS)

    // Vacuity: the abandoned timeline's roads genuinely diverged from what
    // gets restored below (roads is a FIELD_INPUT region, so this moves the
    // whole field-input hash). If it hadn't, this whole arm would pass
    // trivially even under a broken staleness check, for the wrong reason.
    expect(hashInputsFor(state, world)).not.toBe(inputsHashAtSnapshot)

    const restored = restore(snap, world)

    // Reusing the SAME `fields`/`scratch` objects is the point, not an
    // optimisation: at this exact moment they hold the ABANDONED timeline's
    // tick-16 field, built from field-input bytes that do not match
    // `restored`'s tick-10 roads. Nothing below tells them so — no
    // invalidation call, no reset, just `syncFields`'s own content
    // comparison on the very next call.
    const replayTrace: TraceEntry[] = []
    for (let t = T + 1; t <= TICKS; t++) {
      replayTrace.push(
        runScriptedTick(restored, world, editsPerTick[t - 1] as ReadonlyArray<{ a: number; b: number }>, fields, scratch, sourcesByColour),
      )
    }
    expect(replayTrace.length).toBe(TICKS - T)

    expect(replayTrace).toEqual(originalTrace.slice(T))
  })
})

// ---------------------------------------------------------------------------
// Step 2b: the invalidation nobody triggered.
// ---------------------------------------------------------------------------

describe('the invalidation nobody triggered', () => {
  it('a road mutation after the field was built makes fieldFor throw on the restored state, with no syncFields call in between; syncFields then repairs it', () => {
    const { map, world } = landFixture('invalidation', 6, 4)
    const state = createState('invalidation-seed', map)
    const S = cellAt(6, 0, 0)
    const A = cellAt(6, 1, 0)
    const B = cellAt(6, 2, 0)
    expect(placeRoad(state, world, S, A)).toBe(true) // S now carries a road: an accepted source

    const fields = createFlowFields(world.map.groupCount, world.cells)
    const scratch = scratchFor(world, world.map.groupCount)
    syncFieldsFromLists(state, world, [[S]], fields, scratch) // "Build a field"
    expect(() => fieldForColour(state, world, fields, 0, scratch)).not.toThrow() // sanity: valid immediately after building

    expect(placeRoad(state, world, A, B)).toBe(true) // "mutate the roads" — a genuinely new bit; the road region's content moves
    const restored = restore(snapshot(state), world) // "snapshot" + "restore" — a fresh, independent GameState

    // "assert fieldFor throws" — with NO explicit invalidation call anywhere
    // above, and NO syncFields call between the mutation and this read.
    // Under a header-flag design, this would be the assertion that `restore`
    // remembered to set a bit — testing the test author's memory, not the
    // design. Here there is nothing to remember: `fields`' stamp still
    // names the field-input content from before the mutation, `restored`'s
    // actual roads have moved, and the two content hashes simply disagree.
    expect(() => fieldForColour(restored, world, fields, 0, scratch)).toThrow()

    // Then syncFields repairs it, and the repaired field matches a
    // from-scratch rebuild over a SEPARATE FlowField.
    syncFieldsFromLists(restored, world, [[S]], fields, scratch)
    const repaired = fieldForColour(restored, world, fields, 0, scratch)

    const freshFields = createFlowFields(world.map.groupCount, world.cells)
    const freshScratch = scratchFor(world, world.map.groupCount)
    syncFieldsFromLists(restored, world, [[S]], freshFields, freshScratch)
    const fresh = fieldForColour(restored, world, freshFields, 0, freshScratch)

    expect(Array.from(repaired.dist)).toEqual(Array.from(fresh.dist))
    expect(Array.from(repaired.dir)).toEqual(Array.from(fresh.dir))
  })
})

// ---------------------------------------------------------------------------
// Step 2c: the other direction — accept and reuse ACROSS a restore.
// ---------------------------------------------------------------------------

describe('accept-and-reuse across a restore', () => {
  /**
   * Every other restore in this file lands on roads that differ from what
   * the field was built from, so `syncFields` always rebuilds and only its
   * REJECT side is ever taken. The claim being defended here is the opposite
   * one, and it is the one the whole derived-state design rests on: a field
   * built before a rollback is still safe to KEEP afterwards when the
   * restored content matches. That direction is where a bug is silent —
   * there is no throw to catch and no rebuild to compare against, just a
   * field that is quietly reused.
   */
  it('a field built before a snapshot is reused, unrebuilt, on a state restored from it — and is still correct', () => {
    const { map, world } = landFixture('accept-across-restore', 6, 4)
    const state = createState('accept-across-restore-seed', map)
    const S = cellAt(6, 0, 0)
    const A = cellAt(6, 1, 0)
    const B = cellAt(6, 2, 0)
    const C = cellAt(6, 3, 0)
    expect(placeRoad(state, world, S, A)).toBe(true)
    expect(placeRoad(state, world, A, B)).toBe(true)

    const fields = createFlowFields(world.map.groupCount, world.cells)
    const scratch = scratchFor(world, world.map.groupCount)
    syncFieldsFromLists(state, world, [[S]], fields, scratch)
    const distBefore = Array.from(fieldForColour(state, world, fields, 0, scratch).dist)
    const hashBefore = hashField(fieldForColour(state, world, fields, 0, scratch))
    // Vacuity: the field must hold genuine reachable content, or "reused
    // correctly" and "reused as an empty wipe" would be the same assertion.
    expect(distBefore.some((d) => d !== 0 && d !== INF)).toBe(true)

    const snap = snapshot(state)

    // The live timeline diverges with a genuinely new road bit, so the field
    // and the live state genuinely disagree at the moment of the restore.
    expect(placeRoad(state, world, B, C)).toBe(true)
    expect(() => fieldForColour(state, world, fields, 0, scratch)).toThrow()

    const restored = restore(snap, world)
    expect(hashInputsFor(restored, world)).not.toBe(hashInputsFor(state, world)) // vacuity: the two timelines really differ

    // The field was built before the snapshot; `restored`'s roads are what
    // it was built from. `syncFields` must ACCEPT it and not rebuild.
    // Sentinel first: `computeFlowField` zeroes `stats` unconditionally at
    // entry, so -1 surviving is proof it was never called — leaving the
    // previous nonzero count in place would pass even for a rebuild that
    // happened to visit zero cells.
    scratch.stats[ST_EXPANSIONS] = -1
    syncFieldsFromLists(restored, world, [[S]], fields, scratch)
    expect(scratch.stats[ST_EXPANSIONS]).toBe(-1)

    // Accepted — and still the right answer, byte for byte, both against
    // what it held before the rollback and against an independent rebuild
    // over the restored state. Reuse alone is not the property; reuse of
    // something still correct is.
    const reused = fieldForColour(restored, world, fields, 0, scratch)
    expect(hashField(reused)).toBe(hashBefore)
    expect(Array.from(reused.dist)).toEqual(distBefore)

    const freshFields = createFlowFields(world.map.groupCount, world.cells)
    const freshScratch = scratchFor(world, world.map.groupCount)
    syncFieldsFromLists(restored, world, [[S]], freshFields, freshScratch)
    expect(hashField(fieldForColour(restored, world, freshFields, 0, freshScratch))).toBe(hashBefore)
  })
})

// ---------------------------------------------------------------------------
// Step 3: two blessed goldens, labelled for what each actually pins.
// ---------------------------------------------------------------------------

describe('blessed goldens', () => {
  // Mixed terrain — land, tree, water, mountain — so this ONE fixed network
  // exercises everything the road-network golden claims to cover: the
  // `cleared` region (at least one road endpoint sits on a TREE, destroying
  // it) and the tile budget (every placement spends real tiles against a
  // finite `startingTiles`), not just `roads`.
  const GOLDEN_STARTING_TILES = 40
  const GOLDEN_MAP = parseMap(
    'rollback-golden-v1',
    ['......', '.T..T.', '..~^..', '......', '.T....'],
    GOLDEN_STARTING_TILES,
    8,
    4,
    2,
  )

  function buildGoldenNetwork(): { state: GameState; world: WorldData } {
    const world = createWorld(GOLDEN_MAP)
    const state = createState('rollback-golden-seed', GOLDEN_MAP)
    const driver = new Uint32Array(1)
    driver[0] = seedFromString('rollback-golden-driver')
    let placed = 0
    for (let i = 0; i < 60; i++) {
      const a = randomBelow(driver, 0, world.cells)
      const dir = randomBelow(driver, 0, DIR_COUNT)
      const x = a % world.w
      const y = (a / world.w) | 0
      const nx = x + (DX[dir] as number)
      const ny = y + (DY[dir] as number)
      if (nx < 0 || nx >= world.w || ny < 0 || ny >= world.h) continue
      const b = ny * world.w + nx
      if (placeRoad(state, world, a, b)) placed++
    }
    if (placed < 10) {
      throw new Error(`buildGoldenNetwork: only placed ${placed} segments, fixture is too sparse`)
    }
    return { state, world }
  }

  it('road-network golden: pins hashState over a fixed, seeded road network', () => {
    // What this pins: the buffer layout and byte order (the full M1c region
    // list), the `roads` AND `cleared` regions (a tree is genuinely
    // destroyed by this exact network), the tile budget (`H_TILES` after
    // real spending), and the map identity slots (`mapIdentity`). What it
    // does NOT pin: any field data of any kind — nothing here ever calls
    // `computeFlowField`/`syncFields`, and `hashState` only ever reads
    // `s.buffer`, which holds no derived pathfinding state at all.
    //
    // When a rule change makes this fail intentionally, re-bless it in the
    // same commit as the change, never separately.
    const { state, world } = buildGoldenNetwork()

    // The two claims above about WHAT the fixture covers — a destroyed tree,
    // real tiles spent — were prose only. Both are true today (3 of the 3
    // trees cleared, 24 of 40 tiles spent), but nothing enforced them, and
    // the golden cannot: a future re-bless that landed on an all-LAND,
    // budget-intact network would simply pin a new number and keep the same
    // confident comment. These are the assertions that fail in that
    // situation, so they must be checked BEFORE the hash, not after.
    let clearedCount = 0
    for (let c = 0; c < world.cells; c++) if (state.cleared[c] === 1) clearedCount++
    expect(clearedCount, 'the fixture must genuinely destroy a tree').toBeGreaterThan(0)
    expect(tilesLeft(state), 'the fixture must genuinely spend tiles').toBeLessThan(
      GOLDEN_STARTING_TILES,
    )
    expect(tilesLeft(state), 'and must not have overspent the budget').toBeGreaterThanOrEqual(0)

    // **Re-blessed in M1d Task 5 (was 3949962277 at Task 2; 2790151213 at M1c;
    // 3183850973 at M1b) — the second and last re-bless of this number in
    // M1d.** Task 5 appended `ghostMask` and `ghostCommitted`, one `Uint8` per
    // cell each. See "Why exactly two re-blesses are true" in the M1d plan.
    // **Layout only, derived**: splicing the inserted bytes back out
    // reproduces 3949962277 exactly. The splice is **60 bytes at offset 1,468**
    // for THIS fixture (GOLDEN_MAP is 6x5: 30 cells x 2 regions x 1 B),
    // against a whole buffer of 1,468 -> 1,528 bytes — not `firstCity`'s
    // 1,920, which is a different map. This fixture never calls `step`, so it
    // cannot move for a behavioural reason in this milestone, and it has no
    // car to be committed to anything: both ghost regions are all-zero.
    expect(state.ghostMask.every((b) => b === 0), 'no fixture cell is a ghost').toBe(true)
    expect(state.ghostCommitted.every((b) => b === 0)).toBe(true)
    expect(hashState(state)).toBe(2076760277)
  })

  it("field golden: pins hashBytes over each colour's dist/dir bytes, folded together, computed over the SAME fixed network above", () => {
    // Deliberately the exact opposite coverage of the golden above: this one
    // pins ONLY field content (bytes that live entirely outside `s.buffer`)
    // and is blind to everything else — a change to the road network's
    // PLACEMENT SEQUENCE moves both goldens, but a change to, say,
    // `H_SCORE` or the rng stream would move neither.
    //
    // **This golden must NOT move as a result of M1c Task 1's signature
    // widening** (`computeFlowField`/`hashSources`/`syncFields`/`fieldFor`
    // now take a preallocated `Int32Array`/`Scratch` instead of a
    // `readonly number[]`) — the container the sources travel in changed,
    // not the source VALUES or the algorithm that consumes them. If this
    // number moves, Task 1's plumbing changed pathfinding behaviour, which
    // is a defect, not a re-bless.
    //
    // When a rule change makes this fail intentionally, re-bless it in the
    // same commit as the change, never separately.
    const { state, world } = buildGoldenNetwork()
    const roaded = firstRoadedCells(state, world, 2)
    const sourcesByColour = [[roaded[0] as number], [roaded[1] as number]]
    const fields = createFlowFields(2, world.cells)
    const scratch = scratchFor(world, 2)
    syncFieldsFromLists(state, world, sourcesByColour, fields, scratch)

    // Same reasoning as the guards on the golden above, applied to the thing
    // THIS golden pins. A hash over an all-INF field, or over one where
    // every reachable cell sits at the same distance, is just as stable and
    // just as re-blessable as this one — and would say nothing about
    // pathfinding. Each colour's field currently holds 19 distinct `dist`
    // values over 30 cells; the floor below is well under that and well over
    // anything degenerate (an all-INF field has 1, a field with only its
    // source reachable has 2).
    for (let c = 0; c < fields.length; c++) {
      const distinct = new Set(Array.from((fields[c] as FlowField).dist))
      expect(distinct.size, `colour ${c} must have a real distance spread`).toBeGreaterThanOrEqual(
        10,
      )
      expect(distinct.has(0), `colour ${c} must have an accepted source`).toBe(true)
      expect(distinct.has(INF), `colour ${c} must have somewhere unreachable`).toBe(true)
    }

    expect(foldedFieldsHash(fields)).toBe(252514232)
  })
})
