import { describe, it, expect } from 'vitest'
import { parseMap, type MapData } from '@laneways/shared'
import { createState, snapshot, restore, hashState, H_TICK, type GameState } from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { placeRoad, DIR_COUNT, DX, DY } from '../src/roads'
import { seedFromString, randomBelow, nextRandom } from '../src/rng'
import { hashBytes } from '../src/hash'
import {
  createFlowField,
  createFlowFields,
  createScratch,
  INF,
  type FlowField,
  type Scratch,
} from '../src/scratch'
import { computeFlowField, hashRoadRegion, syncFields, fieldFor } from '../src/flowfield'
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
 * `FlowField` (scratch.ts) is poisoned below; every stamp-comparison branch
 * in `syncFields`/`fieldFor` (flowfield.ts) is exercised by the
 * snapshot-and-replay arm or the invalidation test. If this file needed a
 * new production function to make an assertion possible, that would itself
 * be a finding — a behaviour this task is meant to prove would have no
 * reachable call site.
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
  const map = parseMap(id, rows, 999)
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
        const freshScratch = createScratch(world.cells)
        computeFlowField(state, world, sources, freshField, freshScratch)

        const usedField = createFlowField(world.cells)
        const usedScratch = createScratch(world.cells)
        poisonAll(usedScratch, usedField, pattern.fill, `poison-seed-${pattern.name}`)
        computeFlowField(state, world, sources, usedField, usedScratch)

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
      const usedScratch = createScratch(world.cells)
      computeFlowField(state, world, sourcesA, usedField, usedScratch)
      // Vacuity: A must leave real, non-degenerate residue for B to risk leaking.
      expect(Array.from(usedField.dist).some((d) => d !== INF && d !== 0)).toBe(true)

      const sourcesB: readonly number[] = [] // exactly `sources.length === 0`
      computeFlowField(state, world, sourcesB, usedField, usedScratch)

      const freshField = createFlowField(world.cells)
      const freshScratch = createScratch(world.cells)
      computeFlowField(state, world, sourcesB, freshField, freshScratch)

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
      const scratch = createScratch(world.cells)
      computeFlowField(state, world, dirtySources, field, scratch) // dirties it with a real, unrelated prior computation
      return { field, scratch }
    }

    it('fresh-then-used: the fresh computation runs first, the used one second', () => {
      const { state, world } = randomGraphFixture('order-fresh-first', 9, 7, 250)
      const roaded = firstRoadedCells(state, world, 3)
      const sources = [roaded[0] as number]
      const dirtySources = [roaded[1] as number, roaded[2] as number]

      const freshField = createFlowField(world.cells)
      const freshScratch = createScratch(world.cells)
      computeFlowField(state, world, sources, freshField, freshScratch)

      const used = buildUsedPair(state, world, dirtySources)
      computeFlowField(state, world, sources, used.field, used.scratch)

      expect(Array.from(used.field.dist)).toEqual(Array.from(freshField.dist))
      expect(Array.from(used.field.dir)).toEqual(Array.from(freshField.dir))
    })

    it('used-then-fresh: the used computation runs first, the fresh one second', () => {
      const { state, world } = randomGraphFixture('order-used-first', 9, 7, 250)
      const roaded = firstRoadedCells(state, world, 3)
      const sources = [roaded[0] as number]
      const dirtySources = [roaded[1] as number, roaded[2] as number]

      const used = buildUsedPair(state, world, dirtySources)
      computeFlowField(state, world, sources, used.field, used.scratch)

      const freshField = createFlowField(world.cells)
      const freshScratch = createScratch(world.cells)
      computeFlowField(state, world, sources, freshField, freshScratch)

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
  step(state, NO_INPUT)
  syncFields(state, world, sourcesByColour, fields, scratch)
  const f0 = fieldFor(state, world, fields, 0, sourcesByColour[0] as readonly number[])
  const f1 = fieldFor(state, world, fields, 1, sourcesByColour[1] as readonly number[])
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
    const map = parseMap('rollback-replay-fixture', Array.from({ length: H }, () => '.'.repeat(W)), 999)
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
    const scratch = createScratch(world.cells)

    const originalTrace: TraceEntry[] = []
    for (let t = 1; t <= T; t++) {
      originalTrace.push(
        runScriptedTick(state, world, editsPerTick[t - 1] as ReadonlyArray<{ a: number; b: number }>, fields, scratch, sourcesByColour),
      )
    }

    const roadsHashAtSnapshot = hashRoadRegion(state)
    const snap = snapshot(state)

    for (let t = T + 1; t <= TICKS; t++) {
      originalTrace.push(
        runScriptedTick(state, world, editsPerTick[t - 1] as ReadonlyArray<{ a: number; b: number }>, fields, scratch, sourcesByColour),
      )
    }
    // Length asserted BEFORE comparing — an empty trace compares equal to an empty trace.
    expect(originalTrace.length).toBe(TICKS)

    // Vacuity: the abandoned timeline's road region genuinely diverged from
    // what gets restored below. If it hadn't, this whole arm would pass
    // trivially even under a broken staleness check, for the wrong reason.
    expect(hashRoadRegion(state)).not.toBe(roadsHashAtSnapshot)

    const restored = restore(snap, world)

    // Reusing the SAME `fields`/`scratch` objects is the point, not an
    // optimisation: at this exact moment they hold the ABANDONED timeline's
    // tick-16 field, built from a road hash that does not match `restored`'s
    // tick-10 roads. Nothing below tells them so — no invalidation call, no
    // reset, just `syncFields`'s own content comparison on the very next call.
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

    const fields = createFlowFields(1, world.cells)
    const scratch = createScratch(world.cells)
    syncFields(state, world, [[S]], fields, scratch) // "Build a field"
    expect(() => fieldFor(state, world, fields, 0, [S])).not.toThrow() // sanity: valid immediately after building

    expect(placeRoad(state, world, A, B)).toBe(true) // "mutate the roads" — a genuinely new bit; the road region's content moves
    const restored = restore(snapshot(state), world) // "snapshot" + "restore" — a fresh, independent GameState

    // "assert fieldFor throws" — with NO explicit invalidation call anywhere
    // above, and NO syncFields call between the mutation and this read.
    // Under a header-flag design, this would be the assertion that `restore`
    // remembered to set a bit — testing the test author's memory, not the
    // design. Here there is nothing to remember: `fields`' stamp still
    // names the road content from before the mutation, `restored`'s actual
    // roads have moved, and the two content hashes simply disagree.
    expect(() => fieldFor(restored, world, fields, 0, [S])).toThrow()

    // Then syncFields repairs it, and the repaired field matches a
    // from-scratch rebuild over a SEPARATE FlowField.
    syncFields(restored, world, [[S]], fields, scratch)
    const repaired = fieldFor(restored, world, fields, 0, [S])

    const freshFields = createFlowFields(1, world.cells)
    const freshScratch = createScratch(world.cells)
    syncFields(restored, world, [[S]], freshFields, freshScratch)
    const fresh = fieldFor(restored, world, freshFields, 0, [S])

    expect(Array.from(repaired.dist)).toEqual(Array.from(fresh.dist))
    expect(Array.from(repaired.dir)).toEqual(Array.from(fresh.dir))
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
  const GOLDEN_MAP = parseMap(
    'rollback-golden-v1',
    ['......', '.T..T.', '..~^..', '......', '.T....'],
    40,
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
    // What this pins: the buffer layout and byte order, the `roads` AND
    // `cleared` regions (a tree is genuinely destroyed by this exact
    // network), the tile budget (`H_TILES` after real spending), and the
    // map identity slots (`H_MAP`/`H_MAP_W`/`H_MAP_H`). What it does NOT
    // pin: any field data of any kind — nothing here ever calls
    // `computeFlowField`/`syncFields`, and `hashState` only ever reads
    // `s.buffer`, which holds no derived pathfinding state at all.
    //
    // When a rule change makes this fail intentionally, re-bless it in the
    // same commit as the change, never separately.
    const { state } = buildGoldenNetwork()
    expect(hashState(state)).toBe(3183850973)
  })

  it("field golden: pins hashBytes over each colour's dist/dir bytes, folded together, computed over the SAME fixed network above", () => {
    // Deliberately the exact opposite coverage of the golden above: this one
    // pins ONLY field content (bytes that live entirely outside `s.buffer`)
    // and is blind to everything else — a change to the road network's
    // PLACEMENT SEQUENCE moves both goldens, but a change to, say,
    // `H_SCORE` or the rng stream would move neither.
    //
    // When a rule change makes this fail intentionally, re-bless it in the
    // same commit as the change, never separately.
    const { state, world } = buildGoldenNetwork()
    const roaded = firstRoadedCells(state, world, 2)
    const sourcesByColour = [[roaded[0] as number], [roaded[1] as number]]
    const fields = createFlowFields(2, world.cells)
    const scratch = createScratch(world.cells)
    syncFields(state, world, sourcesByColour, fields, scratch)
    expect(foldedFieldsHash(fields)).toBe(252514232)
  })
})
