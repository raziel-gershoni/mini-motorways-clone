import { describe, it, expect } from 'vitest'
import { parseMap, MAX_PATH_LEN, CARS_PER_HOUSE, ORTHO_COST, type MapData } from '@laneways/shared'
import {
  createState,
  snapshot,
  restore,
  hashState,
  H_DEST_COUNT,
  H_HOUSE_COUNT,
  H_ROUTES_REFUSED,
  type GameState,
} from '../src/state'
import { createWorld, type WorldData } from '../src/world'
import { createFieldInputRanges } from '../src/regions'
import { createScratch, createFlowFields, INF, type FlowField, type Scratch } from '../src/scratch'
import { syncFields } from '../src/flowfield'
import { placeRoad, roadMask, DIR_COUNT } from '../src/roads'
import {
  placeHouse,
  placeDestination,
  carparkCell,
  destMetaOrientation,
  ORIENTATION_E,
  ORIENTATION_N,
  ORIENTATION_S,
  ORIENTATION_W,
  DEST_KIND_SQUARE,
  PHASE_IDLE,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
} from '../src/buildings'
import {
  assembleSources,
  runDispatch,
  packRouteStep,
  routeStep,
  ROUTE_BYTES,
  assertDispatchProgress,
  assertFreeCarFound,
} from '../src/dispatch'

/**
 * Every fixture here is an all-land 20 x 12 board (`W` x `H`), so cell
 * indices are `y * 20 + x` throughout and every literal below was computed
 * by hand from that. Non-square deliberately: a transposed index would land
 * off-grid or on the wrong row rather than coincidentally agreeing.
 *
 * The one exception is that every expected source cell, carpark cell and
 * route direction asserted below is a HAND-WRITTEN LITERAL, never a call to
 * `carparkCell`/`destMetaOrientation`. Asserting the assembly against the
 * same expression the assembly evaluates is the "assertion checked against
 * the formula that produced the thing under test" the carry-forward names:
 * it survives "seed with a fixed orientation" whole, because both sides move
 * together.
 */

const W = 20
const H = 12

function allLandRows(w: number, h: number): string[] {
  const row = '.'.repeat(w)
  return Array.from({ length: h }, () => row)
}

function cellFor(x: number, y: number): number {
  return y * W + x
}

function fixture(id: string, groupCount = 5): { map: MapData; world: WorldData } {
  const map = parseMap(id, allLandRows(W, H), 999, 40, 16, groupCount)
  return { map, world: createWorld(map) }
}

interface Rig {
  readonly state: GameState
  readonly world: WorldData
  readonly map: MapData
  readonly scratch: Scratch
  readonly fields: FlowField[]
}

function rig(id: string, groupCount = 5): Rig {
  const { map, world } = fixture(id, groupCount)
  const state = createState('dispatch', map)
  const scratch = createScratch(world.cells, map.groupCount, map.maxDestinations, createFieldInputRanges(map))
  const fields = createFlowFields(map.groupCount, world.cells)
  return { state, world, map, scratch, fields }
}

/** Places a road along a list of 8-adjacent cells, failing loudly rather than silently skipping. */
function placeChain(r: Rig, cells: readonly number[]): void {
  for (let i = 1; i < cells.length; i++) {
    const ok = placeRoad(r.state, r.world, cells[i - 1] as number, cells[i] as number)
    if (!ok) throw new Error(`placeChain: failed to place ${cells[i - 1]} -> ${cells[i]}`)
  }
}

/** The row-10 corridor every dispatch fixture below shares: cells 200..219 inclusive. */
function corridor(fromX: number, toX: number): number[] {
  const out: number[] = []
  for (let x = fromX; x <= toX; x++) out.push(cellFor(x, 10))
  return out
}

/** Phases 4 and 5 of the tick order, in order: assemble sources, sync once, dispatch. */
function assembleAndSync(r: Rig): void {
  assembleSources(r.state, r.world, r.scratch)
  syncFields(r.state, r.world, r.fields, r.scratch)
}

function dispatchTick(r: Rig): void {
  assembleAndSync(r)
  runDispatch(r.state, r.world, r.fields, r.scratch)
}

/** The colour-`c` source slice as a plain array, for comparison against hand-written literals. */
function sourcesOf(r: Rig, colour: number): number[] {
  const base = colour * r.map.maxDestinations
  const count = r.scratch.sourceCounts[colour] as number
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push(r.scratch.sourcesFlat[base + i] as number)
  return out
}

/** Car `k`'s committed route as a direction array of exactly `carRouteLen` steps. */
function routeOf(r: Rig, k: number): number[] {
  const len = r.state.carRouteLen[k] as number
  const out: number[] = []
  for (let i = 0; i < len; i++) out.push(routeStep(r.state, k, i))
  return out
}

/** Every byte of car `k`'s `ROUTE_BYTES` slice. */
function routeBytesOf(r: Rig, k: number): number[] {
  const out: number[] = []
  for (let i = 0; i < ROUTE_BYTES; i++) out.push(r.state.carRoute[k * ROUTE_BYTES + i] as number)
  return out
}

function carsInPhase(r: Rig, phase: number): number[] {
  const out: number[] = []
  const carCount = (r.state.header[H_HOUSE_COUNT] as number) * CARS_PER_HOUSE
  for (let k = 0; k < carCount; k++) if ((r.state.carPhase[k] as number) === phase) out.push(k)
  return out
}

function sumReserved(r: Rig): number {
  let sum = 0
  for (let d = 0; d < (r.state.header[H_DEST_COUNT] as number); d++) sum += r.state.destReserved[d] as number
  return sum
}

/**
 * The two invariants decision 4 proves and every dispatch fixture must
 * uphold. Asserted as a pair because each is blind to the other: the
 * conservation check cannot see over-reservation on a single destination
 * (2 === 2 either way), and the per-destination bound cannot see a leaked
 * reservation on a destination nobody dispatched to.
 */
function assertReservationInvariants(r: Rig): void {
  expect(sumReserved(r)).toBe(carsInPhase(r, PHASE_OUTBOUND).length)
  for (let d = 0; d < (r.state.header[H_DEST_COUNT] as number); d++) {
    expect(r.state.destReserved[d] as number).toBeLessThanOrEqual(r.state.destPins[d] as number)
  }
}

/** Follows `dir` downhill from `start`, returning the direction sequence — the walk dispatch is supposed to record. */
function walkDirDownhill(r: Rig, field: FlowField, start: number): number[] {
  const out: number[] = []
  let cell = start
  for (let guard = 0; guard <= MAX_PATH_LEN; guard++) {
    const k = field.dir[cell] as number
    if (k < 0) return out
    out.push(k)
    const x = (cell % W) + [0, 1, 1, 1, 0, -1, -1, -1][k]!
    const y = ((cell / W) | 0) + [-1, -1, 0, 1, 1, 1, 0, -1][k]!
    cell = y * W + x
  }
  throw new Error('walkDirDownhill: did not terminate')
}

// ---------------------------------------------------------------------------
// 4a. Source assembly
// ---------------------------------------------------------------------------

describe('4a: source assembly seeds from the carpark cell, not the building cell', () => {
  /**
   * Orientations E, S and W — three distinct, all non-N. N is excluded
   * deliberately: `carparkCell` accepts orientation 0, so on an all-N fixture
   * "seed with a fixed orientation" is semantically inert and the mutation
   * survives whole. The would-be-N carpark of each destination ALSO carries a
   * road here (cells 22, 30, 155), so the fixed-orientation mutant emits
   * `[22, 30, 155]` rather than an empty set — the assertion then discriminates
   * on cell identity, not merely on emptiness.
   *
   *   E: origin (2,2) = 42  -> footprint x2..4 y2..3, carpark (5,2)  = 45
   *   S: origin (10,2) = 50 -> footprint x10..11 y2..4, carpark (10,5) = 110
   *   W: origin (15,8) = 175 -> footprint x15..17 y8..9, carpark (14,8) = 174
   */
  function orientationRig(): Rig {
    const r = rig('orientations')
    expect(placeDestination(r.state, r.world, 42, ORIENTATION_E, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(r.state, r.world, 50, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(r.state, r.world, 175, ORIENTATION_W, 0, DEST_KIND_SQUARE)).toBe(true)
    // Roads touching each real carpark...
    placeChain(r, [45, 46])
    placeChain(r, [110, 111])
    placeChain(r, [174, 173])
    // ...and each destination's would-be-N carpark, so a fixed-orientation
    // mutant produces cells rather than nothing.
    placeChain(r, [22, 23])
    placeChain(r, [30, 31])
    placeChain(r, [155, 156])
    for (let d = 0; d < 3; d++) r.state.destPins[d] = 1
    return r
  }

  it('assembles hand-written literal carpark cells over three distinct non-N orientations', () => {
    const r = orientationRig()

    // Vacuity: the three orientations are genuinely different and genuinely non-N.
    const orientations = [0, 1, 2].map((d) => destMetaOrientation(r.state.destMeta[d] as number))
    expect(orientations).toEqual([ORIENTATION_E, ORIENTATION_S, ORIENTATION_W])
    expect(orientations).not.toContain(ORIENTATION_N)
    expect(new Set(orientations).size).toBe(3)

    assembleSources(r.state, r.world, r.scratch)

    expect(sourcesOf(r, 0)).toEqual([45, 110, 174])
  })

  it('seeds nothing from a destination whose carpark carries no road', () => {
    const r = rig('no-road')
    // origin (10,7) = 150, orientation S -> carpark (10,10) = 210. No roads at all.
    expect(placeDestination(r.state, r.world, 150, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    r.state.destPins[0] = 1
    expect(roadMask(r.state, 210)).toBe(0)

    assembleSources(r.state, r.world, r.scratch)
    expect(sourcesOf(r, 0)).toEqual([])
    expect(r.scratch.sourceCounts[0]).toBe(0)
  })

  it('seeds the destination the tick a road first reaches its carpark', () => {
    const r = rig('road-arrives')
    expect(placeDestination(r.state, r.world, 150, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    r.state.destPins[0] = 1

    assembleSources(r.state, r.world, r.scratch)
    expect(sourcesOf(r, 0)).toEqual([])

    placeChain(r, [210, 211])
    expect(roadMask(r.state, 210)).not.toBe(0)

    assembleSources(r.state, r.world, r.scratch)
    expect(sourcesOf(r, 0)).toEqual([210])
  })

  it('drops a destination from the source set the tick its pins reach zero', () => {
    const r = rig('pins-drop')
    expect(placeDestination(r.state, r.world, 150, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    placeChain(r, [210, 211])
    r.state.destPins[0] = 1

    assembleSources(r.state, r.world, r.scratch)
    expect(sourcesOf(r, 0)).toEqual([210])

    r.state.destPins[0] = 0
    assembleSources(r.state, r.world, r.scratch)
    expect(sourcesOf(r, 0)).toEqual([])
    expect(r.scratch.sourceCounts[0]).toBe(0)
  })

  it('keeps a fully reserved destination in the source set (decision 4)', () => {
    const r = rig('reserved-sourced')
    expect(placeDestination(r.state, r.world, 150, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    placeChain(r, [210, 211])
    r.state.destPins[0] = 1
    r.state.destReserved[0] = 1

    assembleSources(r.state, r.world, r.scratch)
    // The inverse of "a reserved pin leaves the source set" — the assertion
    // that makes the one-pin deadlock structurally impossible.
    expect(sourcesOf(r, 0)).toEqual([210])
  })
})

describe('4a: sources land in ascending cell order', () => {
  /**
   * The whole discriminator is a same-colour SLOT/CELL INVERSION: destination
   * slot 0 has the HIGHER carpark cell. A bare slot-order copy emits
   * `[125, 45]`, which `computeFlowField` throws on.
   *
   * "pins created in descending slot order" would prove nothing — `destPins`
   * is a `Uint8` array of counts, so the order they were written in leaves
   * zero trace in state.
   *
   *   slot 0: origin (2,6) = 122, E -> carpark (5,6) = 125
   *   slot 1: origin (2,2) = 42,  E -> carpark (5,2) = 45
   */
  function inversionRig(): Rig {
    const r = rig('inversion')
    expect(placeDestination(r.state, r.world, 122, ORIENTATION_E, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(r.state, r.world, 42, ORIENTATION_E, 0, DEST_KIND_SQUARE)).toBe(true)
    placeChain(r, [125, 126])
    placeChain(r, [45, 46])
    r.state.destPins[0] = 1
    r.state.destPins[1] = 1
    return r
  }

  it('emits ascending cells for a same-colour pair whose slot order is inverted', () => {
    const r = inversionRig()

    // Vacuity, against literals: slot 0 < slot 1, both the same colour, and
    // slot 0's carpark (125) is strictly GREATER than slot 1's (45).
    expect(r.state.header[H_DEST_COUNT]).toBe(2)
    expect((r.state.destMeta[0] as number) & 0x7).toBe(0)
    expect((r.state.destMeta[1] as number) & 0x7).toBe(0)
    expect(125).toBeGreaterThan(45)
    expect(carparkCell(r.state.destCell[0] as number, ORIENTATION_E, W, H)).toBe(125)
    expect(carparkCell(r.state.destCell[1] as number, ORIENTATION_E, W, H)).toBe(45)

    assembleSources(r.state, r.world, r.scratch)
    expect(sourcesOf(r, 0)).toEqual([45, 125])
  })

  it('feeds computeFlowField a source list it accepts (a slot-order copy would throw)', () => {
    const r = inversionRig()
    assembleSources(r.state, r.world, r.scratch)
    expect(() => syncFields(r.state, r.world, r.fields, r.scratch)).not.toThrow()
  })

  /**
   * The pair above meets the brief's stated discriminator exactly — and is
   * still too weak. With at most two same-colour destinations, `count - i` is
   * never above 1, so a **single-element** shift is byte-identical to the full
   * shift loop. Three destinations arriving in descending carpark order force
   * the last insertion to shift TWO elements:
   *
   *   slot 0: origin (2,8) = 162, E -> carpark (5,8) = 165
   *   slot 1: origin (2,5) = 102, E -> carpark (5,5) = 105
   *   slot 2: origin (2,2) = 42,  E -> carpark (5,2) = 45
   *
   * correct -> [45, 105, 165];  one-element shift -> [45, 165, 165], which is
   * non-strictly-ascending AND duplicated, i.e. `computeFlowField`'s hard
   * throw — on the reachable manifold, since three same-colour destinations
   * placed in descending cell order is ordinary play, and a throw out of
   * `step` poisons the run.
   */
  function spanTwoRig(): Rig {
    const r = rig('span-two')
    expect(placeDestination(r.state, r.world, 162, ORIENTATION_E, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(r.state, r.world, 102, ORIENTATION_E, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(r.state, r.world, 42, ORIENTATION_E, 0, DEST_KIND_SQUARE)).toBe(true)
    placeChain(r, [165, 166])
    placeChain(r, [105, 106])
    placeChain(r, [45, 46])
    for (let d = 0; d < 3; d++) r.state.destPins[d] = 1
    return r
  }

  it('emits ascending cells when the last insertion must shift two elements', () => {
    const r = spanTwoRig()

    // Vacuity, against literals: the carparks arrive strictly DESCENDING in
    // slot order, so inserting slot 2's cell displaces both earlier entries —
    // a shift span of 2, which a two-destination fixture cannot produce.
    expect(r.state.header[H_DEST_COUNT]).toBe(3)
    expect(carparkCell(r.state.destCell[0] as number, ORIENTATION_E, W, H)).toBe(165)
    expect(carparkCell(r.state.destCell[1] as number, ORIENTATION_E, W, H)).toBe(105)
    expect(carparkCell(r.state.destCell[2] as number, ORIENTATION_E, W, H)).toBe(45)
    expect(165).toBeGreaterThan(105)
    expect(105).toBeGreaterThan(45)

    assembleSources(r.state, r.world, r.scratch)
    expect(sourcesOf(r, 0)).toEqual([45, 105, 165])
  })

  it('feeds computeFlowField a three-source list it accepts', () => {
    const r = spanTwoRig()
    assembleSources(r.state, r.world, r.scratch)
    expect(() => syncFields(r.state, r.world, r.fields, r.scratch)).not.toThrow()
  })
})

describe('4a: slices, counts and idempotence', () => {
  /**
   * Colour 0 at carpark 210 (origin (10,7), S), colour 1 at carpark 90
   * (origin (10,1), S). Disjoint slices `[0, 16)` and `[16, 32)`.
   */
  function twoColourRig(): Rig {
    const r = rig('two-colours')
    expect(placeDestination(r.state, r.world, 150, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(r.state, r.world, 30, ORIENTATION_S, 1, DEST_KIND_SQUARE)).toBe(true)
    placeChain(r, [210, 211])
    placeChain(r, [90, 91])
    r.state.destPins[0] = 1
    r.state.destPins[1] = 1
    return r
  }

  it('fills each colour its own disjoint slice and leaves every other slice empty', () => {
    const r = twoColourRig()
    assembleSources(r.state, r.world, r.scratch)

    expect(r.scratch.sourceCounts[0]).toBe(1)
    expect(r.scratch.sourceCounts[1]).toBe(1)
    expect(r.scratch.sourcesFlat[0]).toBe(210)
    expect(r.scratch.sourcesFlat[r.map.maxDestinations]).toBe(90)
    for (let c = 2; c < r.map.groupCount; c++) expect(r.scratch.sourceCounts[c]).toBe(0)
  })

  it('overwrites sourceCounts rather than accumulating across calls', () => {
    const r = twoColourRig()
    assembleSources(r.state, r.world, r.scratch)
    const first = [sourcesOf(r, 0), sourcesOf(r, 1)]

    assembleSources(r.state, r.world, r.scratch)
    expect([sourcesOf(r, 0), sourcesOf(r, 1)]).toEqual(first)
    expect(r.scratch.sourceCounts[0]).toBe(1)
    expect(r.scratch.sourceCounts[1]).toBe(1)
  })

  it('shrinks the count when a destination stops qualifying', () => {
    const r = inversionFixtureForShrink()
    assembleSources(r.state, r.world, r.scratch)
    expect(r.scratch.sourceCounts[0]).toBe(2)

    r.state.destPins[1] = 0
    assembleSources(r.state, r.world, r.scratch)
    expect(r.scratch.sourceCounts[0]).toBe(1)
    expect(sourcesOf(r, 0)).toEqual([125])
  })

  function inversionFixtureForShrink(): Rig {
    const r = rig('shrink')
    expect(placeDestination(r.state, r.world, 122, ORIENTATION_E, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(r.state, r.world, 42, ORIENTATION_E, 0, DEST_KIND_SQUARE)).toBe(true)
    placeChain(r, [125, 126])
    placeChain(r, [45, 46])
    r.state.destPins[0] = 1
    r.state.destPins[1] = 1
    return r
  }

  it('drops a duplicate carpark rather than handing computeFlowField a list it throws on', () => {
    const r = rig('dedupe')
    // Off the reachable manifold, deliberately, and stated rather than hidden:
    // two destinations can only share a carpark as a spec §5.2 "double
    // destination", which M1c does not place, and the Chebyshev >= 2 spacing
    // rule forbids it otherwise. The dedupe is kept because `computeFlowField`
    // THROWS on a duplicate, so this is the only way to exercise the branch.
    expect(placeDestination(r.state, r.world, DEST_A_ORIGIN, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(r.state, r.world, DEST_B_ORIGIN, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    r.state.destCell[1] = DEST_A_ORIGIN // both now resolve to carpark 210
    placeChain(r, [DEST_A_CARPARK, DEST_A_CARPARK + 1])
    r.state.destPins[0] = 1
    r.state.destPins[1] = 1

    assembleSources(r.state, r.world, r.scratch)
    expect(sourcesOf(r, 0)).toEqual([DEST_A_CARPARK])
    expect(() => syncFields(r.state, r.world, r.fields, r.scratch)).not.toThrow()
  })

  it('skips a destination whose carpark falls off the grid', () => {
    const r = rig('off-grid-carpark')
    // Also off the manifold: `canPlaceDestination` rejects a footprint whose
    // carpark leaves the grid. Written directly because without the guard
    // `roadMask(state, -1)` reads `undefined`, passes the `!== 0` road test,
    // and reaches `computeFlowField` as an out-of-range source.
    expect(placeDestination(r.state, r.world, 0, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    r.state.destMeta[0] = (ORIENTATION_N << 4) | 0 // origin row 0 + N -> carpark off-grid
    expect(carparkCell(0, ORIENTATION_N, W, H)).toBe(-1)
    r.state.destPins[0] = 1

    assembleSources(r.state, r.world, r.scratch)
    expect(sourcesOf(r, 0)).toEqual([])
    expect(() => syncFields(r.state, r.world, r.fields, r.scratch)).not.toThrow()
  })

  it('throws a named error for a destination whose colour exceeds the map group count', () => {
    const r = rig('bad-colour')
    // `placeDestination` now rejects an out-of-range colour at the boundary
    // (buildings.ts), so this guard is reachable only from a hand-written
    // `destMeta` byte — which is exactly what it is defence-in-depth against.
    // Left unguarded it writes past the end of `sourcesFlat`/`sourceCounts`,
    // and an out-of-range typed-array write is a SILENT no-op.
    expect(placeDestination(r.state, r.world, 150, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    r.state.destMeta[0] = ((r.state.destMeta[0] as number) & ~0x7) | 5
    placeChain(r, [210, 211])
    r.state.destPins[0] = 1
    expect(() => assembleSources(r.state, r.world, r.scratch)).toThrow(/colour 5/)
  })
})

// ---------------------------------------------------------------------------
// The carRoute nibble codec — owned by dispatch.ts, imported by cars.ts
// ---------------------------------------------------------------------------

describe('packRouteStep / routeStep: the carRoute nibble codec', () => {
  function codecRig(): Rig {
    return rig('codec')
  }

  it('ROUTE_BYTES is the carRoute region stride', () => {
    const r = codecRig()
    expect(ROUTE_BYTES).toBe(MAX_PATH_LEN / 2)
    expect(r.state.carRoute.length).toBe(CARS_PER_HOUSE * r.map.maxHouses * ROUTE_BYTES)
  })

  it('pins the nibble convention against a literal byte: even step low, odd step high', () => {
    const r = codecRig()
    packRouteStep(r.state, 0, 0, 3)
    packRouteStep(r.state, 0, 1, 5)
    expect(r.state.carRoute[0]).toBe(0x53)
  })

  it('round-trips every direction 0..7 in the even (low) nibble position', () => {
    const r = codecRig()
    for (let dir = 0; dir < DIR_COUNT; dir++) {
      packRouteStep(r.state, 0, 4, dir)
      expect(routeStep(r.state, 0, 4)).toBe(dir)
    }
  })

  it('round-trips every direction 0..7 in the odd (high) nibble position', () => {
    const r = codecRig()
    for (let dir = 0; dir < DIR_COUNT; dir++) {
      packRouteStep(r.state, 0, 5, dir)
      expect(routeStep(r.state, 0, 5)).toBe(dir)
    }
  })

  it('leaves the sibling nibble of a shared byte untouched', () => {
    const r = codecRig()
    packRouteStep(r.state, 0, 6, 7)
    packRouteStep(r.state, 0, 7, 1)
    expect(routeStep(r.state, 0, 6)).toBe(7)
    packRouteStep(r.state, 0, 7, 4)
    expect(routeStep(r.state, 0, 6)).toBe(7)
    expect(routeStep(r.state, 0, 7)).toBe(4)
  })

  it('round-trips an even-length route', () => {
    const r = codecRig()
    const route = [0, 1, 2, 3, 4, 5, 6, 7]
    for (let i = 0; i < route.length; i++) packRouteStep(r.state, 3, i, route[i] as number)
    const read: number[] = []
    for (let i = 0; i < route.length; i++) read.push(routeStep(r.state, 3, i))
    expect(read).toEqual(route)
  })

  it('round-trips an odd-length route', () => {
    const r = codecRig()
    const route = [7, 6, 5, 4, 3, 2, 1]
    for (let i = 0; i < route.length; i++) packRouteStep(r.state, 5, i, route[i] as number)
    const read: number[] = []
    for (let i = 0; i < route.length; i++) read.push(routeStep(r.state, 5, i))
    expect(read).toEqual(route)
    // The unwritten step 7 shares byte 3 with step 6, and must still read 0.
    expect(routeStep(r.state, 5, 7)).toBe(0)
  })

  it('writes only inside the addressed car slice', () => {
    const r = codecRig()
    packRouteStep(r.state, 1, 0, 7)
    for (let i = 0; i < ROUTE_BYTES; i++) expect(r.state.carRoute[i]).toBe(0)
    expect(r.state.carRoute[ROUTE_BYTES]).toBe(7)
  })

  it('throws rather than writing past the slice for an out-of-range step index', () => {
    const r = codecRig()
    expect(() => packRouteStep(r.state, 0, MAX_PATH_LEN, 1)).toThrow(/step index/)
    expect(() => packRouteStep(r.state, 0, -1, 1)).toThrow(/step index/)
    expect(() => routeStep(r.state, 0, MAX_PATH_LEN)).toThrow(/step index/)
  })

  it('throws for a direction outside [0, DIR_COUNT)', () => {
    const r = codecRig()
    expect(() => packRouteStep(r.state, 0, 0, DIR_COUNT)).toThrow(/direction/)
    expect(() => packRouteStep(r.state, 0, 0, -1)).toThrow(/direction/)
  })
})

// ---------------------------------------------------------------------------
// 4b. Dispatch — house selection
// ---------------------------------------------------------------------------

/**
 * The shared dispatch geometry. Row 10 is a straight orthogonal corridor
 * (cells 200..219); destination A's carpark sits on it at 210 and B's at 218.
 *
 *   dest A: origin (10,7) = 150, S -> footprint x10..11 y7..9, carpark (10,10) = 210
 *   dest B: origin (18,7) = 158, S -> footprint x18..19 y7..9, carpark (18,10) = 218
 *
 * Every distance below is `steps * ORTHO_COST` along that corridor, hand
 * computed: dist[200] = 100 to A, dist[205] = 50 to A, dist[219] = 10 to B.
 */
const DEST_A_ORIGIN = 150
const DEST_A_CARPARK = 210
const DEST_B_ORIGIN = 158
const DEST_B_CARPARK = 218

function corridorRig(id: string, houses: readonly (readonly [number, number])[], withB = false): Rig {
  const r = rig(id)
  for (let i = 0; i < houses.length; i++) {
    const [cell, colour] = houses[i] as readonly [number, number]
    expect(placeHouse(r.state, r.world, cell, colour)).toBe(true)
  }
  expect(placeDestination(r.state, r.world, DEST_A_ORIGIN, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
  if (withB) {
    expect(placeDestination(r.state, r.world, DEST_B_ORIGIN, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
  }
  placeChain(r, corridor(0, 19))
  return r
}

describe('4b: house selection', () => {
  it('dispatches the nearest house, not the first, with the nearest at the higher index', () => {
    const r = corridorRig('nearest', [
      [cellFor(0, 10), 0],
      [cellFor(5, 10), 0],
    ])
    r.state.destPins[0] = 1

    assembleAndSync(r)
    // Vacuity: the two houses' distances genuinely differ, and the nearer one
    // is the HIGHER index — so "pick the first house" and "pick the lowest
    // index" both produce a different answer.
    expect(r.fields[0]!.dist[cellFor(0, 10)]).toBe(100)
    expect(r.fields[0]!.dist[cellFor(5, 10)]).toBe(50)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([2])
    expect(r.state.carTargetDest[2]).toBe(0)
    expect(r.state.carRouteLen[2]).toBe(5)
    expect(r.state.carRouteCursor[2]).toBe(0)
    expect(r.state.carProgress[2]).toBe(0)
    expect(routeOf(r, 2)).toEqual([2, 2, 2, 2, 2]) // five easts
    expect(r.state.destReserved[0]).toBe(1)
    assertReservationInvariants(r)
  })

  it('breaks a distance tie on the lowest house index', () => {
    const r = corridorRig('tie', [
      [cellFor(15, 10), 0],
      [cellFor(5, 10), 0],
    ])
    r.state.destPins[0] = 1

    assembleAndSync(r)
    // Vacuity: the two houses are at different cells and genuinely tie.
    expect(r.state.houseCell[0]).not.toBe(r.state.houseCell[1])
    expect(r.fields[0]!.dist[cellFor(15, 10)]).toBe(50)
    expect(r.fields[0]!.dist[cellFor(5, 10)]).toBe(50)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([0])
    assertReservationInvariants(r)
  })

  it('selects a second house TIED on distance, once the first runs out of cars', () => {
    // The tie test above has `destPins = 1`, so the second tied house is never
    // needed and the cursor's `d < lastDist` boundary is never crossed at
    // equality. Loosening it to `d <= lastDist` excludes every other house at
    // exactly that distance — a real on-manifold under-dispatch that no
    // one-pin fixture can see.
    const r = corridorRig('tie-boundary', [
      [cellFor(15, 10), 0],
      [cellFor(5, 10), 0],
    ])
    r.state.destPins[0] = 4

    assembleAndSync(r)
    // Vacuity: the two houses genuinely tie, and there are more pins than one
    // house has cars.
    expect(r.fields[0]!.dist[cellFor(15, 10)]).toBe(50)
    expect(r.fields[0]!.dist[cellFor(5, 10)]).toBe(50)
    expect(r.state.destPins[0]).toBeGreaterThan(CARS_PER_HOUSE)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([0, 1, 2, 3])
    expect(r.state.destReserved[0]).toBe(4)
    assertReservationInvariants(r)
  })

  it('stops cleanly when the only house exhausts its cars with pins still unserved', () => {
    // The "no free car left" half of `reselect`. Every other fixture either
    // runs out of pins before it runs out of cars, or has a second house to
    // fall through to. Hard-wiring `reselect = true` throws
    // "house ... was selected with no free car" here — in ordinary play.
    const r = corridorRig('cars-exhausted', [[cellFor(0, 10), 0]])
    r.state.destPins[0] = 3

    assembleAndSync(r)
    // Vacuity: strictly more unserved pins than the house has cars.
    expect(r.state.destPins[0]).toBeGreaterThan(CARS_PER_HOUSE)

    expect(() => runDispatch(r.state, r.world, r.fields, r.scratch)).not.toThrow()

    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([0, 1])
    expect(r.state.destReserved[0]).toBe(2)
    assertReservationInvariants(r)
  })

  it('refuses to commit against a destination already over-reserved', () => {
    // Off the reachable manifold — the plan proves `destReserved <= destPins`
    // — so this is hardening, not a bug fix. `=== 0` reads a difference of -2
    // as "eligible" and makes an already-broken invariant worse by committing
    // another car; `<= 0` refuses and leaves the corruption where it is.
    const r = corridorRig('over-reserved', [[cellFor(0, 10), 0]], true)
    r.state.destPins[0] = 1
    r.state.destReserved[0] = 3
    r.state.destPins[1] = 5

    assembleAndSync(r)
    // Vacuity: the colour has work to do overall, and the house's walk
    // genuinely terminates at the over-reserved destination A.
    expect(r.fields[0]!.dist[cellFor(0, 10)]).toBe(100)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([])
    expect(r.state.destReserved[0]).toBe(3)
    expect(r.state.destReserved[1]).toBe(0)
  })

  it('dispatches exactly one car when one pin faces two same-colour houses', () => {
    const r = corridorRig('one-pin', [
      [cellFor(0, 10), 0],
      [cellFor(5, 10), 0],
    ])
    r.state.destPins[0] = 1

    dispatchTick(r)

    expect(carsInPhase(r, PHASE_OUTBOUND).length).toBe(1)
    expect(sumReserved(r)).toBe(1)
    assertReservationInvariants(r)
  })

  it('skips a house whose cars are both out', () => {
    const r = corridorRig('both-out', [
      [cellFor(0, 10), 0],
      [cellFor(5, 10), 0],
    ])
    r.state.destPins[0] = 1
    r.state.carPhase[2] = PHASE_OUTBOUND
    r.state.carPhase[3] = PHASE_OUTBOUND

    dispatchTick(r)

    expect(r.state.carPhase[0]).toBe(PHASE_OUTBOUND)
    expect(r.state.carRouteLen[0]).toBe(10)
    expect(r.state.destReserved[0]).toBe(1)
  })

  it('treats only PHASE_IDLE as free — never a RETURNING car', () => {
    const r = corridorRig('idle-only', [
      [cellFor(0, 10), 0],
      [cellFor(5, 10), 0],
    ])
    r.state.destPins[0] = 1
    // The nearer house's cars: one driving home, one out. Neither is free.
    r.state.carPhase[2] = PHASE_RETURNING
    r.state.carPhase[3] = PHASE_OUTBOUND

    dispatchTick(r)

    // Under the looser `carPhase !== PHASE_OUTBOUND` test, car 2 (RETURNING)
    // would be dispatched from the nearer house instead.
    expect(r.state.carPhase[2]).toBe(PHASE_RETURNING)
    expect(r.state.carPhase[0]).toBe(PHASE_OUTBOUND)
    expect(r.state.carRouteLen[0]).toBe(10)
  })

  it('dispatches the lowest free car index of the winning house', () => {
    const r = corridorRig('lowest-car', [[cellFor(0, 10), 0]])
    r.state.destPins[0] = 1

    dispatchTick(r)

    expect(r.state.carPhase[0]).toBe(PHASE_OUTBOUND)
    expect(r.state.carPhase[1]).toBe(PHASE_IDLE)
  })

  it('initialises the whole car slot at commit, whatever it held before', () => {
    const r = corridorRig('slot-init', [[cellFor(0, 10), 0]])
    r.state.destPins[0] = 1
    // A commit must not inherit any of these. On the reachable manifold Task
    // 6 clears them at trip end, so asserting against an already-clean slot
    // would let "drop carRouteCursor = 0" and "drop carProgress = 0" survive
    // whole; these are written directly so the assertions have teeth.
    r.state.carRouteCursor[0] = 7
    r.state.carProgress[0] = 999
    r.state.carTargetDest[0] = 12

    dispatchTick(r)

    expect(r.state.carPhase[0]).toBe(PHASE_OUTBOUND)
    expect(r.state.carRouteLen[0]).toBe(10)
    expect(r.state.carRouteCursor[0]).toBe(0)
    expect(r.state.carProgress[0]).toBe(0)
    expect(r.state.carTargetDest[0]).toBe(0)
  })

  it('dispatches nobody from a house with no driveway', () => {
    const r = corridorRig('no-driveway', [[cellFor(0, 0), 0]])
    r.state.destPins[0] = 1

    assembleAndSync(r)
    expect(roadMask(r.state, cellFor(0, 0))).toBe(0)
    expect(r.fields[0]!.dist[cellFor(0, 0)]).toBe(INF)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([])
    expect(r.state.destReserved[0]).toBe(0)
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(0)
  })

  it('dispatches nobody from a house with a driveway on a disconnected component', () => {
    const r = corridorRig('unreachable', [[cellFor(0, 0), 0]])
    r.state.destPins[0] = 1
    placeChain(r, [cellFor(0, 0), cellFor(1, 0)])

    assembleAndSync(r)
    // Vacuity: this house DOES have road — it is unreachable, not undriveable.
    expect(roadMask(r.state, cellFor(0, 0))).not.toBe(0)
    expect(r.fields[0]!.dist[cellFor(0, 0)]).toBe(INF)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([])
    expect(r.state.destReserved[0]).toBe(0)
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(0)
  })
})

describe('4b: colours do not interfere', () => {
  /**
   * Two disconnected corridors, one per colour:
   *   colour 0: house (0,10) = 200, dest A carpark 210, corridor row 10
   *   colour 1: house (0,4)  = 80,  dest C carpark 90,  corridor row 4
   * Each house is INF in the other colour's field, so "read fields[0] for
   * every colour" leaves one of them undispatched.
   */
  function twoColourDispatchRig(): Rig {
    const r = rig('colour-isolation')
    expect(placeHouse(r.state, r.world, cellFor(0, 10), 0)).toBe(true)
    expect(placeHouse(r.state, r.world, cellFor(0, 4), 1)).toBe(true)
    expect(placeDestination(r.state, r.world, DEST_A_ORIGIN, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(r.state, r.world, cellFor(10, 1), ORIENTATION_S, 1, DEST_KIND_SQUARE)).toBe(true)
    placeChain(r, corridor(0, 10))
    const row4: number[] = []
    for (let x = 0; x <= 10; x++) row4.push(cellFor(x, 4))
    placeChain(r, row4)
    r.state.destPins[0] = 1
    r.state.destPins[1] = 1
    return r
  }

  it('dispatches each colour from its own field', () => {
    const r = twoColourDispatchRig()

    assembleAndSync(r)
    // Vacuity: each house is unreachable in the other colour's field.
    expect(r.fields[0]!.dist[cellFor(0, 4)]).toBe(INF)
    expect(r.fields[1]!.dist[cellFor(0, 10)]).toBe(INF)
    expect(r.fields[0]!.dist[cellFor(0, 10)]).toBe(100)
    expect(r.fields[1]!.dist[cellFor(0, 4)]).toBe(100)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([0, 2])
    expect(r.state.carTargetDest[0]).toBe(0)
    expect(r.state.carTargetDest[2]).toBe(1)
    expect(r.state.destReserved[0]).toBe(1)
    expect(r.state.destReserved[1]).toBe(1)
    assertReservationInvariants(r)
  })
})

// ---------------------------------------------------------------------------
// 4b. Route commitment
// ---------------------------------------------------------------------------

describe('4b: the committed route is the field walk, step for step', () => {
  /**
   *   dest: origin (2,2) = 42, E -> footprint x2..4 y2..3, carpark (5,2) = 45
   *   road: 45 -> 65 -> 85 -> 105 -> 125 -> 126 -> 127 -> 128
   *   house: (8,6) = 128
   *
   * Eight cells, seven steps: three W (6) then four N (0). Two straight runs
   * with a turn between them, so an adjacent pair of steps genuinely differs.
   */
  function lRig(): Rig {
    const r = rig('l-route')
    expect(placeHouse(r.state, r.world, 128, 0)).toBe(true)
    expect(placeDestination(r.state, r.world, 42, ORIENTATION_E, 0, DEST_KIND_SQUARE)).toBe(true)
    placeChain(r, [45, 65, 85, 105, 125, 126, 127, 128])
    r.state.destPins[0] = 1
    return r
  }

  it('commits the hand-computed direction sequence and its exact length', () => {
    const r = lRig()
    dispatchTick(r)

    expect(r.state.carRouteLen[0]).toBe(7) // 8 cells on the path, 7 steps
    expect(routeOf(r, 0)).toEqual([6, 6, 6, 0, 0, 0, 0])
    expect(r.state.carTargetDest[0]).toBe(0)
    expect(r.state.carRouteCursor[0]).toBe(0)
    expect(r.state.carProgress[0]).toBe(0)
  })

  it('matches the field’s own downhill walk from the house cell', () => {
    const r = lRig()
    dispatchTick(r)
    expect(routeOf(r, 0)).toEqual(walkDirDownhill(r, r.fields[0] as FlowField, 128))
  })

  it('records the route in the state buffer, so it survives a snapshot/restore', () => {
    const r = lRig()
    dispatchTick(r)

    const restored = restore(snapshot(r.state), r.world)
    const read: number[] = []
    for (let i = 0; i < (restored.carRouteLen[0] as number); i++) read.push(routeStep(restored, 0, i))
    expect(read).toEqual([6, 6, 6, 0, 0, 0, 0])
    expect(restored.destReserved[0]).toBe(1)
    expect(restored.carTargetDest[0]).toBe(0)
    expect(hashState(restored)).toBe(hashState(r.state))
  })
})

describe('4b: MAX_PATH_LEN is a defined refusal', () => {
  /**
   * A 100-cell serpentine whose FIRST cell is the destination's carpark, so
   * position `p` along it is exactly `p` orthogonal steps from the source.
   *
   *   dest: origin (0,0) = 0, S -> footprint x0..1 y0..2, carpark (0,3) = 60
   *   rows 3..7 snake east/west, 20 cells each.
   *
   * Position 96 is (16,7) = 156 and position 97 is (17,7) = 157 — the exact
   * boundary, so both arms of `steps >= MAX_PATH_LEN` are exercised.
   */
  function snakeCells(): number[] {
    const out: number[] = []
    for (let row = 3; row <= 7; row++) {
      const eastward = (row - 3) % 2 === 0
      for (let i = 0; i < W; i++) out.push(cellFor(eastward ? i : W - 1 - i, row))
    }
    return out
  }

  function snakeRig(id: string, houseCell: number): Rig {
    const r = rig(id)
    expect(placeHouse(r.state, r.world, houseCell, 0)).toBe(true)
    expect(placeDestination(r.state, r.world, 0, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    placeChain(r, snakeCells())
    r.state.destPins[0] = 1
    return r
  }

  it('the serpentine is the path this fixture claims it is', () => {
    const cells = snakeCells()
    expect(cells.length).toBe(100)
    expect(cells[0]).toBe(60)
    expect(cells[96]).toBe(156)
    expect(cells[97]).toBe(157)
  })

  it('accepts a route of exactly MAX_PATH_LEN steps', () => {
    const r = snakeRig('exactly-96', 156)
    assembleAndSync(r)
    // Vacuity: 96 orthogonal steps, hand-computed, at the bound and not over it.
    expect(r.fields[0]!.dist[156]).toBe(96 * ORTHO_COST)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    expect(r.state.carPhase[0]).toBe(PHASE_OUTBOUND)
    expect(r.state.carRouteLen[0]).toBe(MAX_PATH_LEN)
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(0)
    expect(r.state.destReserved[0]).toBe(1)
    // The walk genuinely wrote route bytes — which is what makes the refusal
    // fixture's all-zero assertion below non-vacuous.
    expect(routeBytesOf(r, 0).some((b) => b !== 0)).toBe(true)
    // Nothing was written past this car's slice.
    expect(routeBytesOf(r, 1).every((b) => b === 0)).toBe(true)
  })

  it('refuses a route one step over the bound, counts it, reserves nothing and does not spin', () => {
    const r = snakeRig('one-over', 157)
    assembleAndSync(r)
    // Vacuity: 97 steps — it genuinely exceeds MAX_PATH_LEN rather than
    // failing for some other reason.
    expect(r.fields[0]!.dist[157]).toBe(97 * ORTHO_COST)
    expect(97).toBeGreaterThan(MAX_PATH_LEN)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    expect(r.state.header[H_ROUTES_REFUSED]).toBe(1)
    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([])
    expect(r.state.destReserved[0]).toBe(0)
    assertReservationInvariants(r)
  })

  it('zeroes the refused car’s whole ROUTE_BYTES slice, length and cursor', () => {
    const r = snakeRig('refusal-zeroing', 157)
    dispatchTick(r)

    for (let k = 0; k < CARS_PER_HOUSE; k++) {
      expect(r.state.carPhase[k]).toBe(PHASE_IDLE)
      expect(r.state.carRouteLen[k]).toBe(0)
      expect(r.state.carRouteCursor[k]).toBe(0)
      expect(routeBytesOf(r, k)).toEqual(Array.from({ length: ROUTE_BYTES }, () => 0))
    }
  })

  it('does no walk at all, and records no refusal, for a colour with no unreserved pins', () => {
    // `remaining` is summed over THIS COLOUR's destinations only. Counting
    // every colour's instead is outcome-equivalent for dispatches — the
    // per-destination eligibility check is what stops a second car at one pin
    // — but it is NOT equivalent for `H_ROUTES_REFUSED`: a colour with
    // nothing to serve would walk anyway and bank a refusal that never
    // happened. That counter is §10.3 telemetry, so a spurious increment is a
    // lie about the run, not a harmless extra loop.
    const r = rig('idle-colour')
    expect(placeHouse(r.state, r.world, 157, 0)).toBe(true)
    expect(placeDestination(r.state, r.world, 0, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(r.state, r.world, cellFor(10, 9), ORIENTATION_N, 1, DEST_KIND_SQUARE)).toBe(true)
    placeChain(r, snakeCells())
    // Colour 0: one pin, already fully reserved -> nothing to serve.
    r.state.destPins[0] = 1
    r.state.destReserved[0] = 1
    // Colour 1: one unreserved pin, and no colour-1 house to serve it.
    r.state.destPins[1] = 1

    assembleAndSync(r)
    // Vacuity: the colour-0 house's route genuinely exceeds MAX_PATH_LEN, so
    // a walk that should not happen would be loudly counted if it did.
    expect(r.fields[0]!.dist[157]).toBe(97 * ORTHO_COST)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    expect(r.state.header[H_ROUTES_REFUSED]).toBe(0)
    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([])
  })

  it('stops at remaining = 0 rather than walking a farther house into a spurious refusal', () => {
    // The OTHER half of `remaining`: its decrement. The colour-filter half has
    // its own test above; this one is the decrement's, and it is the same
    // argument — `H_ROUTES_REFUSED` is §10.3 telemetry, so an increment for a
    // walk that should never have happened is a lie about the run.
    //
    // A near house serves the single pin; a far house at 97 steps would refuse
    // if the loop ever reached it. Deleting `remaining--` reaches it.
    const r = rig('remaining-decrement')
    expect(placeHouse(r.state, r.world, 61, 0)).toBe(true) // snake position 1 -> dist 10
    expect(placeHouse(r.state, r.world, 157, 0)).toBe(true) // snake position 97 -> dist 970
    expect(placeDestination(r.state, r.world, 0, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    placeChain(r, snakeCells())
    r.state.destPins[0] = 1

    assembleAndSync(r)
    // Vacuity: the far house's route genuinely exceeds MAX_PATH_LEN, so it
    // would be loudly counted if the loop reached it.
    expect(r.fields[0]!.dist[61]).toBe(10)
    expect(r.fields[0]!.dist[157]).toBe(97 * ORTHO_COST)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([0])
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(0)
    expect(r.state.destReserved[0]).toBe(1)
    assertReservationInvariants(r)
  })

  it('refuses a walk that leaves the grid FROM a carpark cell', () => {
    // The one on-manifold-adjacent fixture that can see `walkTerminated`'s
    // default. Every other off-grid walk stops on a cell that is not anybody's
    // carpark, so the `d < 0` arm refuses it whatever the default is. Here the
    // walk's last cell IS the carpark (cell is not advanced when `stepCell`
    // returns -1), so `d` resolves — and a `walkTerminated` that defaulted to
    // true would COMMIT a route whose final step walks off the board.
    //
    // Carpark 60 = (0,3) sits on the left edge, so a west `dir` there leaves
    // the grid; the house is one cell east of it.
    const r = rig('offgrid-from-carpark')
    expect(placeHouse(r.state, r.world, 61, 0)).toBe(true)
    expect(placeDestination(r.state, r.world, 0, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    placeChain(r, snakeCells())
    r.state.destPins[0] = 1

    assembleAndSync(r)
    // Vacuity: the walk genuinely reaches the carpark first (one step west),
    // and the corrupted direction genuinely leaves the board from there.
    expect(r.fields[0]!.dir[61]).toBe(6)
    expect(r.fields[0]!.dir[60]).toBe(-1)
    expect(60 % W).toBe(0)
    r.fields[0]!.dir[60] = 6 // west, off the left edge

    expect(() => runDispatch(r.state, r.world, r.fields, r.scratch)).not.toThrow()

    expect(r.state.header[H_ROUTES_REFUSED]).toBe(1)
    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([])
    expect(r.state.destReserved[0]).toBe(0)
    expect(routeBytesOf(r, 0)).toEqual(Array.from({ length: ROUTE_BYTES }, () => 0))
    assertReservationInvariants(r)
  })

  it('bounds a hand-corrupted dir cycle instead of hanging', () => {
    const r = corridorRig('dir-cycle', [[cellFor(0, 10), 0]])
    r.state.destPins[0] = 1
    assembleAndSync(r)

    // Vacuity: 200 and 201 both point east toward the carpark before the
    // corruption; afterwards they point at each other. `dir` is scratch, not
    // state, so this does not disturb fieldFor's staleness stamps.
    expect(r.fields[0]!.dir[cellFor(0, 10)]).toBe(2)
    expect(r.fields[0]!.dir[cellFor(1, 10)]).toBe(2)
    r.fields[0]!.dir[cellFor(1, 10)] = 6
    expect(r.fields[0]!.dir[cellFor(1, 10)]).toBe(6)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    expect(r.state.header[H_ROUTES_REFUSED]).toBe(1)
    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([])
    expect(routeBytesOf(r, 0)).toEqual(Array.from({ length: ROUTE_BYTES }, () => 0))
  })

  /**
   * The third refusal reason — the walk terminated on a cell that is not any
   * colour-matching carpark — and it is the only one the other fixtures cannot
   * reach. `bounds a hand-corrupted dir cycle` does NOT cover it: that walk
   * exits through `steps >= MAX_PATH_LEN`, so `d` is set to -1 by the ternary,
   * never by `destAtCarpark`.
   *
   * Without the `d < 0` arm: `state.destPins[-1]` is `undefined`,
   * `undefined - undefined` is `NaN`, `NaN <= 0` is false, so the eligibility
   * guard does not fire and the car COMMITS with `carTargetDest = -1` and
   * `destReserved[-1] = NaN` — a silent out-of-range no-op. The conservation
   * invariant then breaks on the NEXT tick with nothing pointing at the cause.
   */
  it('refuses a walk that terminates on a reachable cell that is not a carpark', () => {
    const r = corridorRig('not-a-carpark', [[cellFor(0, 10), 0]])
    r.state.destPins[0] = 1
    assembleAndSync(r)

    // One step north off the corridor lands on a roadless cell: `dir` there is
    // -1 (never relaxed), so the walk terminates normally — `walkFailed` is
    // false and `steps` is 1 — on a cell that is nobody's carpark.
    expect(r.fields[0]!.dir[cellFor(0, 10)]).toBe(2)
    r.fields[0]!.dir[cellFor(0, 10)] = 0 // north
    expect(roadMask(r.state, cellFor(0, 9))).toBe(0)
    expect(r.fields[0]!.dir[cellFor(0, 9)]).toBe(-1)
    expect(r.fields[0]!.dist[cellFor(0, 9)]).toBe(INF)

    expect(() => runDispatch(r.state, r.world, r.fields, r.scratch)).not.toThrow()

    expect(r.state.header[H_ROUTES_REFUSED]).toBe(1)
    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([])
    expect(r.state.destReserved[0]).toBe(0)
    expect(routeBytesOf(r, 0)).toEqual(Array.from({ length: ROUTE_BYTES }, () => 0))
    assertReservationInvariants(r)
  })

  /**
   * The refusal path's own zeroing, mutated separately from the eligibility
   * path's. Every other refusal fixture either walks the full 96 steps (where
   * the prefix IS the whole slice) or walks zero steps into an already-clean
   * slice, so none of them can see prefix-only zeroing on this path.
   *
   * Doubles as the only cover for the `next < 0` off-grid guard: without it
   * the walk sets `cell = -1`, reads `dirs[-1]` as `undefined`, and reaches
   * `packRouteStep` with `undefined` — a THROW, which poisons the run, in
   * place of the counted refusal.
   */
  it('zeroes the whole slice after a SHORT refused walk into a dirty slice', () => {
    const r = corridorRig('short-refusal-dirty', [[cellFor(0, 10), 0]])
    r.state.destPins[0] = 1
    assembleAndSync(r)

    // Car 0 carries a full-length route from an earlier trip...
    for (let i = 0; i < MAX_PATH_LEN; i++) packRouteStep(r.state, 0, i, 5)
    expect(routeBytesOf(r, 0).every((b) => b === 0x55)).toBe(true)
    // ...and this tick's walk leaves the grid after ONE step (west off the
    // left edge), so the prefix is 1 byte against a 48-byte slice.
    r.fields[0]!.dir[cellFor(0, 10)] = 6

    expect(() => runDispatch(r.state, r.world, r.fields, r.scratch)).not.toThrow()

    expect(r.state.header[H_ROUTES_REFUSED]).toBe(1)
    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([])
    expect(routeBytesOf(r, 0)).toEqual(Array.from({ length: ROUTE_BYTES }, () => 0))
  })

  it('refuses, rather than throwing, on a dir value outside [0, DIR_COUNT)', () => {
    const r = corridorRig('corrupt-dir-value', [[cellFor(0, 10), 0]])
    r.state.destPins[0] = 1
    assembleAndSync(r)
    r.fields[0]!.dir[cellFor(0, 10)] = DIR_COUNT + 1

    // Without the `kd >= DIR_COUNT` half of the guard this reaches
    // `packRouteStep` and throws, poisoning the run under the atomicity rule
    // instead of producing the counted refusal decision 2 asks for.
    expect(() => runDispatch(r.state, r.world, r.fields, r.scratch)).not.toThrow()

    expect(r.state.header[H_ROUTES_REFUSED]).toBe(1)
    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([])
  })

  it('resolves the terminating carpark within the dispatching colour', () => {
    // Off-manifold, same `destCell` trick as the dedupe test: two destinations
    // sharing carpark 210, the WRONG-colour one at the LOWER slot index — so
    // an unfiltered ascending scan returns it and the colour filter is the
    // only thing that can pick the right destination.
    const r = rig('carpark-colour')
    expect(placeHouse(r.state, r.world, cellFor(0, 10), 0)).toBe(true)
    expect(placeDestination(r.state, r.world, DEST_A_ORIGIN, ORIENTATION_S, 1, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(r.state, r.world, DEST_B_ORIGIN, ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    r.state.destCell[1] = DEST_A_ORIGIN
    placeChain(r, corridor(0, 19))
    r.state.destPins[1] = 1

    dispatchTick(r)

    // Without the filter, `destAtCarpark` returns slot 0 (colour 1), whose
    // pins are 0, so the eligibility check excludes it and nothing dispatches.
    expect(r.state.carTargetDest[0]).toBe(1)
    expect(r.state.destReserved[1]).toBe(1)
    expect(r.state.destReserved[0]).toBe(0)
    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([0])
  })

  it('refuses a zero-length route', () => {
    const r = corridorRig('zero-length', [[cellFor(0, 10), 0]])
    r.state.destPins[0] = 1
    // Off the reachable manifold: placement forbids a house on a carpark cell,
    // so this is written directly. A zero-length route would otherwise be a
    // car that completes a trip without moving.
    r.state.houseCell[0] = DEST_A_CARPARK

    assembleAndSync(r)
    expect(r.fields[0]!.dist[DEST_A_CARPARK]).toBe(0)
    expect(r.fields[0]!.dir[DEST_A_CARPARK]).toBe(-1)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    expect(r.state.header[H_ROUTES_REFUSED]).toBe(1)
    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([])
    expect(r.state.destReserved[0]).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 4b. The loop bound, reservation timing, and decision 4's artefact
// ---------------------------------------------------------------------------

describe('4b: reservation is written inside the loop, immediately', () => {
  /**
   * The deferred-reservation killer, and it is NOT the one-pin/two-house
   * shape: with one unreserved pin the loop body runs exactly once whether or
   * not `destReserved` is written inside it.
   *
   * One house with two free cars; two same-colour destinations each holding
   * exactly ONE unreserved pin, so `remaining = 2` and the house's downhill
   * walk terminates at A on BOTH iterations.
   *
   *   correct: iteration 2 reads destPins[A] - destReserved[A] = 0 and is
   *            excluded  -> one dispatch, destReserved[A] = 1
   *   mutant:  iteration 2 reads 1 - 0 = 1 > 0 and commits car 1 to A as well
   *            -> two dispatches, destReserved[A] = 2 > destPins[A] = 1
   */
  function twoPinsTwoDestsOneHouse(): Rig {
    const r = corridorRig('deferred-reservation', [[cellFor(0, 10), 0]], true)
    r.state.destPins[0] = 1
    r.state.destPins[1] = 1
    return r
  }

  it('lets a second walk to the same destination see the first walk’s reservation', () => {
    const r = twoPinsTwoDestsOneHouse()
    assembleAndSync(r)
    // Vacuity: remaining is genuinely 2, and the house genuinely routes to A
    // (100) rather than B (180) on both iterations.
    expect(r.state.destPins[0]).toBe(1)
    expect(r.state.destPins[1]).toBe(1)
    expect(r.fields[0]!.dist[cellFor(0, 10)]).toBe(100)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([0])
    expect(r.state.carTargetDest[0]).toBe(0)
    expect(r.state.destReserved[0]).toBe(1)
    expect(r.state.destReserved[1]).toBe(0)
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(0)
    assertReservationInvariants(r)
  })

  it('zeroes the WHOLE slice, not the prefix the walk reached', () => {
    const r = twoPinsTwoDestsOneHouse()
    // Car 1's slice holds a full-length route from an earlier trip. Its walk
    // this tick is only 10 steps, so "zero what I just wrote" leaves 43 bytes
    // of the old route live in an IDLE car — bytes that are hashed, that
    // persist in every snapshot forever, and that do not compress like the
    // run of zeros Task 1g's budget claim rests on.
    for (let i = 0; i < MAX_PATH_LEN; i++) packRouteStep(r.state, 1, i, 5)
    expect(routeBytesOf(r, 1).every((b) => b === 0x55)).toBe(true)

    dispatchTick(r)

    expect(r.state.carPhase[1]).toBe(PHASE_IDLE)
    expect(routeBytesOf(r, 1)).toEqual(Array.from({ length: ROUTE_BYTES }, () => 0))
  })

  it('zeroes the excluded car’s whole ROUTE_BYTES slice, length and cursor', () => {
    const r = twoPinsTwoDestsOneHouse()
    dispatchTick(r)

    // Car 1 was walked (its route bytes were written) and then excluded by the
    // eligibility check — a different refusal path from MAX_PATH_LEN, and it
    // gets its own fixture for exactly that reason.
    expect(r.state.carPhase[1]).toBe(PHASE_IDLE)
    expect(r.state.carRouteLen[1]).toBe(0)
    expect(r.state.carRouteCursor[1]).toBe(0)
    expect(routeBytesOf(r, 1)).toEqual(Array.from({ length: ROUTE_BYTES }, () => 0))
  })
})

describe('4b: a house may dispatch more than one car in a tick', () => {
  /**
   * TWO pins on the SAME destination — with two pins on two destinations the
   * eligibility exclusion fires on iteration 2 and the "exclude after a
   * successful commit" mutant produces the same pair of cars.
   *
   * H1 (index 1) is nearer at dist 50; H0 (index 0) is at 100. All four cars
   * idle. The nearer house must send BOTH its cars and the farther none.
   */
  it('sends both of the nearest house’s cars, and none of the farther house’s', () => {
    const r = corridorRig('multi-dispatch', [
      [cellFor(0, 10), 0],
      [cellFor(5, 10), 0],
    ])
    r.state.destPins[0] = 2

    assembleAndSync(r)
    // Vacuity: the two houses' distances genuinely differ.
    expect(r.fields[0]!.dist[cellFor(0, 10)]).toBe(100)
    expect(r.fields[0]!.dist[cellFor(5, 10)]).toBe(50)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    // Car 3 specifically — the winning house's SECOND car — not merely "two
    // cars moved".
    expect(r.state.carPhase[2]).toBe(PHASE_OUTBOUND)
    expect(r.state.carPhase[3]).toBe(PHASE_OUTBOUND)
    expect(r.state.carPhase[0]).toBe(PHASE_IDLE)
    expect(r.state.carPhase[1]).toBe(PHASE_IDLE)
    expect(r.state.destReserved[0]).toBe(2)
    expect(r.state.carRouteLen[2]).toBe(5)
    expect(r.state.carRouteLen[3]).toBe(5)
    assertReservationInvariants(r)
  })
})

describe('4b: the loop bound is the unreserved pin count, not one per colour', () => {
  /**
   * Two same-colour destinations each holding one unreserved pin, positioned
   * so the two houses' downhill walks terminate at DIFFERENT destinations:
   *
   *   H0 at (0,10) = 200  -> dist 100 to A (210), 180 to B (218) -> walks to A
   *   H1 at (19,10) = 219 -> dist 10 to B (218), 90 to A          -> walks to B
   *
   * A one-destination fixture cannot see the `while` -> `if` mutation.
   */
  it('dispatches twice on one tick, to two different destinations', () => {
    const r = corridorRig(
      'while-not-if',
      [
        [cellFor(0, 10), 0],
        [cellFor(19, 10), 0],
      ],
      true,
    )
    r.state.destPins[0] = 1
    r.state.destPins[1] = 1

    assembleAndSync(r)
    expect(r.fields[0]!.dist[cellFor(0, 10)]).toBe(100)
    expect(r.fields[0]!.dist[cellFor(19, 10)]).toBe(10)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    const out = carsInPhase(r, PHASE_OUTBOUND)
    expect(out).toEqual([0, 2])
    // The two committed routes end at DIFFERENT destination indices — the
    // assertion a one-destination fixture cannot make.
    expect(r.state.carTargetDest[2]).toBe(1)
    expect(r.state.carTargetDest[0]).toBe(0)
    expect(r.state.carTargetDest[0]).not.toBe(r.state.carTargetDest[2])
    expect(r.state.carRouteLen[2]).toBe(1)
    expect(r.state.carRouteLen[0]).toBe(10)
    assertReservationInvariants(r)
  })
})

describe('4b: decision 4’s stated artefact', () => {
  /**
   * A fully reserved NEAR destination blocks the house from reaching past it
   * to a farther, unreserved one — for one trip duration. This is the price
   * of one field per colour instead of one per destination, and it is pinned
   * so that changing it later is deliberate.
   */
  it('dispatches nobody while the nearest destination is fully reserved', () => {
    const r = corridorRig('artefact', [[cellFor(0, 10), 0]], true)
    r.state.destPins[0] = 1
    r.state.destReserved[0] = 1
    r.state.destPins[1] = 1

    assembleAndSync(r)
    // Vacuity: A is still a source (decision 4) and is genuinely the nearer.
    expect(sourcesOf(r, 0)).toEqual([DEST_A_CARPARK, DEST_B_CARPARK])
    expect(r.fields[0]!.dist[cellFor(0, 10)]).toBe(100)

    runDispatch(r.state, r.world, r.fields, r.scratch)

    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([])
    expect(r.state.destReserved[0]).toBe(1)
    expect(r.state.destReserved[1]).toBe(0)
    // An eligibility exclusion is NOT a refusal — the two paths are counted
    // differently on purpose.
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(0)
  })

  it('dispatches to the farther destination once the reserving car arrives', () => {
    const r = corridorRig('artefact-released', [[cellFor(0, 10), 0]], true)
    r.state.destPins[0] = 1
    r.state.destReserved[0] = 1
    r.state.destPins[1] = 1

    dispatchTick(r)
    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([])

    // The reserving car arrives: it consumes A's pin and releases its
    // reservation (Task 6's arrivals phase, written by hand here).
    r.state.destPins[0] = 0
    r.state.destReserved[0] = 0

    dispatchTick(r)

    expect(carsInPhase(r, PHASE_OUTBOUND)).toEqual([0])
    expect(r.state.carTargetDest[0]).toBe(1)
    expect(r.state.carRouteLen[0]).toBe(18)
    expect(r.state.destReserved[1]).toBe(1)
    assertReservationInvariants(r)
  })
})

describe('4b: the loop’s two proved invariants fail loudly rather than silently', () => {
  /**
   * Both take their bound as a parameter, on `scratch.ts`'s
   * `assertBucketCountExceedsEveryEdgeCost` precedent, precisely so the
   * failure path is exercisable without editing the caller. Neither branch is
   * reachable from a correct dispatch loop — that is what "proved" means —
   * and the project's rule is to make such a throw reachable from a test
   * rather than leave it as the one branch nothing ever executes.
   */
  it('assertDispatchProgress throws only once the proved bound is exceeded', () => {
    expect(() => assertDispatchProgress(4, 4, 2)).not.toThrow()
    expect(() => assertDispatchProgress(5, 4, 2)).toThrow(/colour 2 loop exceeded its proved bound of 4/)
  })

  it('assertFreeCarFound throws only for a negative car index', () => {
    expect(() => assertFreeCarFound(0, 3, 1)).not.toThrow()
    expect(() => assertFreeCarFound(-1, 3, 1)).toThrow(/house 3 was selected with no free car \(colour 1\)/)
  })

  it('leaves headroom under the proved bound on a fixture that fills it', () => {
    // Four commits over two houses plus the terminal break is 5 iterations
    // against a bound of remaining (4) + houseCount (2) + 1 = 7. If the bound
    // were ever tightened below the real worst case this fixture would throw.
    const r = corridorRig('bound-headroom', [
      [cellFor(15, 10), 0],
      [cellFor(5, 10), 0],
    ])
    r.state.destPins[0] = 4
    expect(() => dispatchTick(r)).not.toThrow()
    expect(carsInPhase(r, PHASE_OUTBOUND).length).toBe(4)
  })
})

describe('4b: reservation survives a snapshot/restore', () => {
  it('restores destReserved and every committed route byte-identically', () => {
    const r = corridorRig('rollback', [
      [cellFor(0, 10), 0],
      [cellFor(5, 10), 0],
    ])
    r.state.destPins[0] = 2

    dispatchTick(r)
    const before = hashState(r.state)
    const restored = restore(snapshot(r.state), r.world)

    expect(hashState(restored)).toBe(before)
    expect(restored.destReserved[0]).toBe(2)
    expect(restored.carPhase[2]).toBe(PHASE_OUTBOUND)
    expect(restored.carPhase[3]).toBe(PHASE_OUTBOUND)
    expect(restored.carTargetDest[2]).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The walk's off-grid refusal — stepCell's three caller-observable bounds
// ---------------------------------------------------------------------------

/**
 * **`stepCell` itself now lives in `roads.ts` and its four bounds are tested
 * DIRECTLY in `roads.test.ts`** (M1d Task 1a folded `cars.ts`'s private copy
 * and this file's exported one into a single shared function). The four direct
 * `it()`s that used to sit here moved with it.
 *
 * What stays here is the other obligation, and it is a different one: that
 * **`dispatchColour`'s own `if (next < 0) break` observes the bound** rather
 * than committing a route through the cell the missing bound would produce.
 * Direct tests and caller tests do not subsume each other in either direction —
 * the direct ones cannot see whether the caller consumes the -1, and the caller
 * ones cannot see `y < 0` at all (with `x` fenced into `[0, w - 1]`, any
 * `y <= -1` gives `y * w + x <= -1`, so both the shipped code and the mutant
 * deliver a negative and this branch cannot tell them apart — the equivalent
 * mutant `roads.ts` derives in full).
 *
 * So there are exactly **three** tests below, one per caller-observable bound,
 * and each is built the hard way for the reason 4b's comment gives: the obvious
 * version passes under its own mutation, because `dispatchColour` funnels three
 * refusal reasons into one branch.
 */

describe('4b: a walk that would leave the grid is refused, not committed — one test per caller-observable bound', () => {
  /**
   * The caller's `if (next < 0) break` — `dispatchColour`'s documented "walked
   * off the grid" refusal — had no test either.
   *
   * **The cell the wrap lands on is itself a live, pinned, colour-matching
   * carpark, and that is the whole construction.** The obvious version of this
   * test — corrupt `dir`, assert "refused" — passes under the mutation, because
   * `dispatchColour` funnels THREE refusal reasons into one branch
   * (`!walkTerminated || steps === 0 || d < 0`): the wrapped cell simply is not
   * a carpark, so `destAtCarpark` returns -1 and the walk refuses for a
   * different reason. The review that found this gap wrote that test first and
   * nearly recorded a fake detector.
   *
   * So this asserts the outcome the MUTATION produces rather than the outcome
   * the shipped code produces: with the bound gone, the walk terminates on a
   * source and COMMITS a one-step route to a destination the car cannot reach.
   */
  it('does not commit a route whose step wraps the right edge onto a carpark', () => {
    const r = rig('row-seam')
    // Destination origin (0,2) orientation S: footprint x0..1 y2..4, carpark
    // (0,5) = 100. House at (19,4) = 99, whose east step wraps onto exactly
    // that carpark. Hand-written literals; the wrap identity is asserted.
    expect(placeDestination(r.state, r.world, cellFor(0, 2), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeHouse(r.state, r.world, cellFor(19, 4), 0)).toBe(true)
    expect(cellFor(19, 4) + 1).toBe(cellFor(0, 5))

    // A legitimate road house -> carpark, around the footprint, so `dist` is
    // finite and the house is actually selected.
    const chain: number[] = []
    for (let x = 19; x >= 2; x--) chain.push(cellFor(x, 4))
    chain.push(cellFor(2, 5), cellFor(1, 5), cellFor(0, 5))
    placeChain(r, chain)

    r.state.destPins[0] = 1
    assembleAndSync(r)
    // Vacuity: the house genuinely reaches the carpark by the legal route, so
    // it is a real dispatch candidate rather than an unreachable one.
    expect(r.fields[0]!.dist[cellFor(19, 4)]).toBe(20 * ORTHO_COST)
    expect(sourcesOf(r, 0)).toEqual([cellFor(0, 5)])

    // Corrupt `dir` to point EAST, off the grid. Off-manifold by construction:
    // a real field never points a cell out of bounds.
    r.fields[0]!.dir[cellFor(19, 4)] = 2
    const before = r.state.header[H_ROUTES_REFUSED] as number

    runDispatch(r.state, r.world, r.fields, r.scratch)

    // Every one of these flips under the mutation: it commits a 1-step route.
    expect(r.state.carPhase[0]).toBe(PHASE_IDLE)
    expect(r.state.carRouteLen[0]).toBe(0)
    expect(r.state.carRouteCursor[0]).toBe(0)
    expect(r.state.destReserved[0]).toBe(0)
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(before + 1)
    expect(routeBytesOf(r, 0)).toEqual(new Array(ROUTE_BYTES).fill(0))
    assertReservationInvariants(r)
  })

  /**
   * **The mirror of the test above, and the one an eastern-only fixture leaves
   * untested** (M1d Task 1a). Same construction, other direction: the cell the
   * missing `x < 0` bound wraps onto must itself be a live, pinned,
   * colour-matching carpark, or `destAtCarpark` returns -1 and the walk refuses
   * for a reason that has nothing to do with the bound.
   *
   * Destination origin (16,5) orientation E: footprint x16..18 y5..6, carpark
   * (19,5) = 119. House at (0,6) = 120, whose WEST step is index 119 — the
   * previous row's last column, and exactly that carpark.
   */
  it('does not commit a route whose step wraps the left edge onto a carpark', () => {
    const r = rig('row-seam-west')
    expect(placeDestination(r.state, r.world, cellFor(16, 5), ORIENTATION_E, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeHouse(r.state, r.world, cellFor(0, 6), 0)).toBe(true)
    // The wrap identity, asserted rather than assumed.
    expect(cellFor(0, 6) - 1).toBe(cellFor(19, 5))
    expect(carparkCell(cellFor(16, 5), ORIENTATION_E, W, H)).toBe(cellFor(19, 5))

    // A legitimate road house -> carpark down column 0, along row 8 (below the
    // footprint's y5..6) and up column 19. 2 + 19 + 3 = 24 orthogonal steps.
    const chain: number[] = [cellFor(0, 6), cellFor(0, 7)]
    for (let x = 0; x <= 19; x++) chain.push(cellFor(x, 8))
    chain.push(cellFor(19, 7), cellFor(19, 6), cellFor(19, 5))
    placeChain(r, chain)

    r.state.destPins[0] = 1
    assembleAndSync(r)
    // Vacuity: the house genuinely reaches the carpark by the legal route.
    expect(r.fields[0]!.dist[cellFor(0, 6)]).toBe(24 * ORTHO_COST)
    expect(sourcesOf(r, 0)).toEqual([cellFor(19, 5)])

    // Corrupt `dir` to point WEST, off the grid.
    r.fields[0]!.dir[cellFor(0, 6)] = 6
    const before = r.state.header[H_ROUTES_REFUSED] as number

    runDispatch(r.state, r.world, r.fields, r.scratch)

    // Every one of these flips under the mutation: it commits a 1-step route to
    // a carpark on the row above, which the car cannot reach in one step.
    expect(r.state.carPhase[0]).toBe(PHASE_IDLE)
    expect(r.state.carRouteLen[0]).toBe(0)
    expect(r.state.carRouteCursor[0]).toBe(0)
    expect(r.state.destReserved[0]).toBe(0)
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(before + 1)
    expect(routeBytesOf(r, 0)).toEqual(new Array(ROUTE_BYTES).fill(0))
    assertReservationInvariants(r)
  })

  /**
   * **The third caller-observable bound, and its observable is a different kind
   * of thing — which is stated here rather than dressed up as the other two**
   * (M1d Task 1a).
   *
   * `y >= h` cannot wrap onto a real cell through this caller: `y = h` gives
   * `y * w + x >= w * h` for every in-range `x`, so the missing bound always
   * produces an index past the end of the grid, never a wrong-but-plausible
   * one. `dirs[thatIndex]` then reads back `undefined` (`dir` is an
   * `Int8Array(cells)`), which is neither `< 0` nor `>= DIR_COUNT`, so the walk
   * does not terminate and carries `undefined` straight into `packRouteStep`,
   * which throws by name.
   *
   * So the discriminator is **"refuses cleanly" versus "throws"**, and it is
   * written as `expect(...).not.toThrow()` deliberately: that makes the mutant's
   * detection an ASSERTION FAILURE rather than an uncaught error, which is the
   * difference between a kill and a crash the catalogue says to keep straight.
   */
  it('refuses, rather than throwing, when the walk would step off the last row', () => {
    const r = rig('row-seam-south')
    // Destination origin (0,0) orientation S: footprint x0..1 y0..2, carpark
    // (0,3) = 60. House at (5,11) = 235, on the last row.
    expect(placeDestination(r.state, r.world, cellFor(0, 0), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeHouse(r.state, r.world, cellFor(5, 11), 0)).toBe(true)
    expect(carparkCell(cellFor(0, 0), ORIENTATION_S, W, H)).toBe(cellFor(0, 3))
    // The index the missing bound would produce is off the END of the grid, not
    // a real cell — which is why this test's observable is a throw.
    expect(cellFor(5, 11) + W).toBeGreaterThanOrEqual(W * H)

    // Up column 5 to row 3, then west along row 3 to the carpark: 8 + 5 = 13.
    const chain: number[] = []
    for (let y = 11; y >= 3; y--) chain.push(cellFor(5, y))
    for (let x = 4; x >= 0; x--) chain.push(cellFor(x, 3))
    placeChain(r, chain)

    r.state.destPins[0] = 1
    assembleAndSync(r)
    expect(r.fields[0]!.dist[cellFor(5, 11)]).toBe(13 * ORTHO_COST)
    expect(sourcesOf(r, 0)).toEqual([cellFor(0, 3)])

    // Corrupt `dir` to point SOUTH, off the last row.
    r.fields[0]!.dir[cellFor(5, 11)] = 4
    const before = r.state.header[H_ROUTES_REFUSED] as number

    expect(
      () => {
        runDispatch(r.state, r.world, r.fields, r.scratch)
      },
      'the walk read past the end of `dir` and carried undefined into packRouteStep',
    ).not.toThrow()

    expect(r.state.carPhase[0]).toBe(PHASE_IDLE)
    expect(r.state.carRouteLen[0]).toBe(0)
    expect(r.state.carRouteCursor[0]).toBe(0)
    expect(r.state.destReserved[0]).toBe(0)
    expect(r.state.header[H_ROUTES_REFUSED]).toBe(before + 1)
    expect(routeBytesOf(r, 0)).toEqual(new Array(ROUTE_BYTES).fill(0))
    assertReservationInvariants(r)
  })
})
