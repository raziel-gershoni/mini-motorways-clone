import { describe, it, expect } from 'vitest'
import {
  firstCity,
  TERRAIN,
  TICKS_PER_WEEK,
  DAYS_PER_WEEK,
  CARS_PER_HOUSE,
  REVEALED_X0,
  REVEALED_Y0,
  REVEALED_W,
  REVEALED_H,
  DENOM,
  OVERCROWD_FAIL_MILLITICKS,
  OVERCROWD_FULL_MILLITICKS,
  OVERCROWD_RAMP_FULL_TICKS,
  PIN_CAP_SQUARE_TIMER,
  type MapData,
} from '@laneways/shared'
import {
  createState,
  createWorld,
  createScratch,
  createFlowFields,
  createFieldInputRanges,
  isGameOver,
  offerPending,
  placeHouse,
  placeDestination,
  placeRoad,
  eraseRoad,
  packRouteStep,
  weekOfTick,
  dayOfWeek,
  tilesLeft,
  carparkCell,
  destMetaColour,
  destMetaKind,
  destMetaOrientation,
  CARD_COUNT,
  CARD_JUNCTION_UPGRADE,
  CARD_NONE,
  CARD_ROAD_TILES,
  CARD_TRAFFIC_LIGHTS,
  cardItemGrant,
  cardTileGrant,
  DEST_KIND_CIRCLE,
  DEST_KIND_SQUARE,
  ORIENTATION_E,
  ORIENTATION_N,
  ORIENTATION_S,
  ORIENTATION_W,
  PHASE_NONE,
  PHASE_IDLE,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
  H_DEST_COUNT,
  H_FAILED_DEST,
  H_GAME_OVER,
  H_HOUSE_COUNT,
  H_OFFER_A,
  H_OFFER_B,
  H_OFFER_WEEK,
  H_SCORE,
  H_TICK,
  H_TILES,
  H_WEEK,
  type FlowField,
  type GameState,
  type Scratch,
  type TickAction,
  type WorldData,
} from '@laneways/sim'
import {
  CARD_LABELS,
  CARD_LABEL_COUNT,
  fitCamera,
  TerrainClass,
  type Camera,
  type RenderFrame,
} from '@laneways/render'
import { seedStartingCity } from '../src/startingCity'
import {
  createFrameBuilder,
  buildFrame,
  createFrameDriver,
  destinationIsReachable,
  labelRoadComponents,
  terrainClassOf,
  type FrameBuilder,
} from '../src/frame'
import { initCarSnapshots, snapshotPrev, snapshotCurr, resolveCar, lerpCar } from '../src/resolve'
import { createInputQueue } from '../src/inputs'

/** An empty batch, for the `advance` calls that are about the driver rather than about input. */
const NO_ACTIONS = { actions: [] as const }
import { createLoop, type Loop } from '../src/loop'

/**
 * `frame.ts` — the terrain fold, the destination unpack, the dense car array,
 * the HUD scalars, and the interpolation the whole milestone's motion rests on.
 * Plan Decision 3, and the second half of Decision 2.
 *
 * ---------------------------------------------------------------------------
 * THE HUD OWNS NO CLOCK ARITHMETIC
 * ---------------------------------------------------------------------------
 *
 * `week` and `day` are `weekOfTick(H_TICK)` and `dayOfWeek(H_TICK)`, called
 * from `sim`. `clock.ts` derives the day from position within the week
 * precisely because 4500/7 = 642.857... is not an integer, and a second
 * float-permitted copy in `game` would disagree at boundaries. The boundary
 * case below is what makes that a test rather than a claim.
 *
 * ---------------------------------------------------------------------------
 * THE FOLD AND THE UNPACK RUN EVERY FRAME
 * ---------------------------------------------------------------------------
 *
 * 960 byte writes and at most 16 building unpacks, allocation-free, and they
 * cannot go stale. A dirty-flag scheme would be cheaper and would carry a
 * staleness bug waiting for the first mid-run building change; the cost is not
 * worth the class of defect.
 */

const GRID_W = 24

/** The M0 device, as Task 3's camera tests use it: 406x870 CSS, insets 46/34, DPR 3 -> capped to 2. */
function m0Camera(): Camera {
  return fitCamera(
    { cssW: 406, cssH: 870, topInset: 46, bottomInset: 34, rawDpr: 3, performanceClass: null },
    { x0: REVEALED_X0, y0: REVEALED_Y0, cols: REVEALED_W, rows: REVEALED_H },
  )
}

interface Rig {
  readonly map: MapData
  readonly world: WorldData
  readonly state: GameState
  readonly scratch: Scratch
  readonly fields: FlowField[]
  readonly camera: Camera
}

function rig(seed = false): Rig {
  const map = firstCity()
  const world = createWorld(map)
  const state = createState('m2-frame', map)
  if (seed) seedStartingCity(state, world)
  return {
    map,
    world,
    state,
    scratch: createScratch(world.cells, map.groupCount, map.maxDestinations, createFieldInputRanges(map)),
    fields: createFlowFields(map.groupCount, world.cells),
    camera: m0Camera(),
  }
}

function builderFor(r: Rig): FrameBuilder {
  const fb = createFrameBuilder(r.state, r.world, r.camera)
  initCarSnapshots(fb.snapshots, r.state, r.world)
  return fb
}

function build(r: Rig, fb: FrameBuilder, alpha = 0, paused = false, peeking = false): RenderFrame {
  return buildFrame(fb, r.state, r.world, r.camera, alpha, paused, peeking)
}

function cellOf(x: number, y: number): number {
  return y * GRID_W + x
}

function carXY(frame: RenderFrame, n: number): [number, number] {
  return [frame.carXY[n * 2] as number, frame.carXY[n * 2 + 1] as number]
}

/**
 * The EXACT interpolated position of car slot `i` — `lerpCar` over
 * `prevXY`/`currXY` — which is what `buildFrame` emitted until the car-launch
 * smoothing landed and is what the smoothing is measured against.
 *
 * `buildFrame` now emits `drawCar`'s output, which chases this one with a
 * bounded lag (`resolve.ts`). The three fixtures below pin the exact
 * interpolator's convexity and its refusal to overshoot a corner — the
 * properties Decision 2 exists for, still shipped, still the thing the drawn
 * position converges to. The same properties AT THE SCREEN, plus the bound
 * between the two, live in `test/carSmoothing.test.ts`, which drives a real
 * board rather than a hand-written state.
 */
function exactXY(fb: FrameBuilder, i: number, alpha: number): [number, number] {
  const out = new Float32Array(2)
  lerpCar(fb.snapshots, i, alpha, out, 0)
  return [out[0] as number, out[1] as number]
}

// ---------------------------------------------------------------------------
// 1. The terrain fold, and the copied-numbering watcher
// ---------------------------------------------------------------------------

describe('the terrain fold', () => {
  /**
   * `render` keeps its own `TerrainClass` because spec §4 forbids it importing
   * `shared`, so the numbering exists twice. `game` is the only package that
   * can see both copies, which is why the watcher lives here — the same
   * reasoning, and the same file placement, as `renderDirections.test.ts`.
   */
  it('agrees with shared’s TERRAIN code for code, so the two copies cannot drift', () => {
    expect(TerrainClass.LAND).toBe(TERRAIN.LAND)
    expect(TerrainClass.WATER).toBe(TERRAIN.WATER)
    expect(TerrainClass.MOUNTAIN).toBe(TERRAIN.MOUNTAIN)
    expect(TerrainClass.TREE).toBe(TERRAIN.TREE)
    expect(Object.keys(TerrainClass).length).toBe(Object.keys(TERRAIN).length)
  })

  it('maps every terrain code with nothing cleared', () => {
    expect(terrainClassOf(TERRAIN.LAND, 0)).toBe(TerrainClass.LAND)
    expect(terrainClassOf(TERRAIN.WATER, 0)).toBe(TerrainClass.WATER)
    expect(terrainClassOf(TERRAIN.MOUNTAIN, 0)).toBe(TerrainClass.MOUNTAIN)
    expect(terrainClassOf(TERRAIN.TREE, 0)).toBe(TerrainClass.TREE)
  })

  it('folds a CLEARED tree to land — the whole reason the fold exists', () => {
    // `world.terrain` is never mutated; a tree destroyed by a road sets
    // `state.cleared[cell] = 1`. A renderer reading `world.terrain` alone draws
    // a tree under every road the player lays through a forest, permanently.
    expect(terrainClassOf(TERRAIN.TREE, 1)).toBe(TerrainClass.LAND)
  })

  it('leaves a cleared WATER or MOUNTAIN cell alone', () => {
    // `placeRoad` only ever sets `cleared` on a TREE cell, so this is off the
    // reachable manifold today and is stated as such. It is guarded rather than
    // written as "cleared implies land" because the unguarded form turns any
    // future writer of `cleared` into a river that silently becomes a road.
    expect(terrainClassOf(TERRAIN.WATER, 1)).toBe(TerrainClass.WATER)
    expect(terrainClassOf(TERRAIN.MOUNTAIN, 1)).toBe(TerrainClass.MOUNTAIN)
  })

  it('writes the fold at index y * gridW + x for the whole board', () => {
    const r = rig()
    const fb = builderFor(r)
    const frame = build(r, fb)
    expect(frame.gridW).toBe(GRID_W)
    expect(frame.terrainClass.length).toBe(r.world.cells)

    // Three markers, each unique in its row AND its column, so a transposed or
    // mis-strided read lands on land and fails.
    const river = cellOf(12, 17) // the river column
    const tree = cellOf(16, 10) // a tree, per firstCity's row 10
    const mountain = cellOf(3, 5) // the mountain cluster, rows 5-7
    expect(r.world.terrain[river] as number).toBe(TERRAIN.WATER)
    expect(r.world.terrain[tree] as number).toBe(TERRAIN.TREE)
    expect(r.world.terrain[mountain] as number).toBe(TERRAIN.MOUNTAIN)

    expect(frame.terrainClass[river] as number).toBe(TerrainClass.WATER)
    expect(frame.terrainClass[tree] as number).toBe(TerrainClass.TREE)
    expect(frame.terrainClass[mountain] as number).toBe(TerrainClass.MOUNTAIN)
    // The transposed cells are land, so a swapped decomposition is visible.
    expect(frame.terrainClass[cellOf(17, 12)] as number).toBe(TerrainClass.LAND)
    expect(frame.terrainClass[cellOf(10, 16)] as number).toBe(TerrainClass.LAND)
  })

  it('folds cells OUTSIDE the revealed rect too, so board expansion needs no change here', () => {
    // The mountain cluster (rows 5-7, columns 3-4) is entirely outside the
    // revealed rect. Folding only the drawn rect would pass every visible
    // assertion and break the day the rect grows — M1f's, repointed from M1e,
    // which declined expansion exactly as M1d did.
    const r = rig()
    const frame = build(r, builderFor(r))
    expect(cellOf(3, 5) % GRID_W).toBeLessThan(REVEALED_X0)
    expect(frame.terrainClass[cellOf(3, 5)] as number).toBe(TerrainClass.MOUNTAIN)
  })

  it('is recomputed every frame, so a felled tree updates on the next frame', () => {
    const r = rig()
    const fb = builderFor(r)
    const tree = cellOf(16, 10)
    expect(build(r, fb).terrainClass[tree] as number).toBe(TerrainClass.TREE)
    r.state.cleared[tree] = 1
    expect(build(r, fb).terrainClass[tree] as number).toBe(TerrainClass.LAND)
  })

  /**
   * The UNDER-iteration half of the fold's bound, and it cannot be written the
   * obvious way.
   *
   * `firstCity`'s first and last cells are both LAND, and LAND is 0 — the value
   * an unwritten `Uint8Array` already holds. So "assert the last cell is LAND"
   * passes whether the loop reached it or not, which is the same shape as Task
   * 5's seven 0-detector markers. Poking a sentinel in first and reading it
   * back out makes the WRITE the observable rather than the value, and it works
   * at both ends regardless of what the terrain there happens to be.
   *
   * **A trap this sets for whoever makes the fold 2-D, recorded while the
   * reason is fresh, and still entirely open at the close of M1e.** The two
   * markers are cells (0, 0) and (23, 39) — **diagonal corners**, which is
   * exactly the placement that produced M2 Task 5's seven surviving mutants. It
   * is sufficient here only because the fold is a flat 1-D `for c < cells`
   * loop, where "past one bound" is not a distinct case: shrinking either end
   * of a single range reaches a corner immediately. **The moment this fold
   * becomes 2-D over a dynamic revealed rect, these two markers stop being
   * sufficient** — a corner sits past two bounds at once, so extending any
   * single bound by one cell reaches nothing — and each of the four half-plane
   * bounds will need its own marker, one cell past exactly one of them.
   * (Addressed to M1e when written; M1e declined board expansion and the rect
   * is still the four frozen constants, so the trap is unchanged and now
   * M1f's.)
   */
  it('rewrites the first and last cell every frame, whatever terrain they carry', () => {
    const r = rig()
    const fb = builderFor(r)
    const last = r.world.cells - 1
    expect(r.world.terrain[0] as number).toBe(TERRAIN.LAND)
    expect(r.world.terrain[last] as number).toBe(TERRAIN.LAND)
    const SENTINEL = 200
    fb.frame.terrainClass[0] = SENTINEL
    fb.frame.terrainClass[last] = SENTINEL
    const frame = build(r, fb)
    expect(frame.terrainClass[0] as number, 'the fold skipped cell 0').toBe(TerrainClass.LAND)
    expect(frame.terrainClass[last] as number, 'the fold skipped the last cell').toBe(TerrainClass.LAND)
  })
})

// ---------------------------------------------------------------------------
// 2. The destination unpack
// ---------------------------------------------------------------------------

describe('the destination unpack', () => {
  it('unpacks colour, kind and orientation and computes the carpark, per destination', () => {
    const r = rig(true)
    const frame = build(r, builderFor(r))
    expect(frame.destCount).toBe(3)

    // Hand-written from the seed table, not read back through destMeta:
    //   D0 (9, 10) colour 0, square, W  -> carpark (8, 10)
    //   D1 (9, 18) colour 0, square, W  -> carpark (8, 18)
    //   D2 (14, 14) colour 1, circle, E -> carpark (17, 14)
    expect(Array.from(frame.destColour.subarray(0, 3))).toEqual([0, 0, 1])
    expect(Array.from(frame.destKind.subarray(0, 3))).toEqual([
      DEST_KIND_SQUARE,
      DEST_KIND_SQUARE,
      DEST_KIND_CIRCLE,
    ])
    expect(Array.from(frame.destOrientation.subarray(0, 3))).toEqual([
      ORIENTATION_W,
      ORIENTATION_W,
      ORIENTATION_E,
    ])
    expect(Array.from(frame.destCarpark.subarray(0, 3))).toEqual([
      cellOf(8, 10),
      cellOf(8, 18),
      cellOf(17, 14),
    ])
    expect(Array.from(frame.destCell.subarray(0, 3))).toEqual([
      cellOf(9, 10),
      cellOf(9, 18),
      cellOf(14, 14),
    ])
    // Vacuity: colour, kind and orientation must not all be constant across the
    // three, or a unpack that returns the same byte for every field passes.
    expect(new Set(Array.from(frame.destKind.subarray(0, 3))).size).toBe(2)
    expect(new Set(Array.from(frame.destOrientation.subarray(0, 3))).size).toBe(2)
  })

  it('agrees with sim’s own unpackers rather than re-deriving the bit layout', () => {
    const r = rig(true)
    const frame = build(r, builderFor(r))
    for (let d = 0; d < frame.destCount; d++) {
      const meta = r.state.destMeta[d] as number
      expect(frame.destColour[d] as number).toBe(destMetaColour(meta))
      expect(frame.destKind[d] as number).toBe(destMetaKind(meta))
      expect(frame.destOrientation[d] as number).toBe(destMetaOrientation(meta))
      expect(frame.destCarpark[d] as number).toBe(
        carparkCell(r.state.destCell[d] as number, destMetaOrientation(meta), r.world.w, r.world.h),
      )
    }
  })

  /**
   * The board is 24x40 — non-square, exactly as the plan's vacuity rule
   * demands — and **that is not enough**, because it is the ORIENTATIONS that
   * collapse the distinction.
   *
   * `carparkCell` decomposes by `w`, offsets, and recomposes by `w`, so it
   * reduces to `cell + dy*w + dx`. For **E** that is `cell + 3` and for **W**
   * it is `cell - 1` — **independent of `w` entirely**. Only N (`cell - w`) and
   * S (`cell + 3w`) read it. Task 2's seed is oriented W, W, E, so before this
   * case existed *no fixture in the suite reached `w` at all* and swapping
   * `world.w` for `world.h` at the call site survived all 156 tests.
   *
   * The sibling test below cannot help either: it calls `carparkCell(...,
   * r.world.w, r.world.h)` itself, so it reimplements the thing it checks and
   * agrees with the mutant.
   *
   * N and S are both needed: N is `cell - w` and S is `cell + 3w`, so N alone
   * cannot separate a `w` / `3w` slip.
   */
  it('passes world.w and world.h in the right order — which only an N or S carpark can see', () => {
    const r = rig()
    const N_ORIGIN = cellOf(7, 15)
    const S_ORIGIN = cellOf(7, 21)
    expect(placeDestination(r.state, r.world, N_ORIGIN, ORIENTATION_N, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeDestination(r.state, r.world, S_ORIGIN, ORIENTATION_S, 1, DEST_KIND_CIRCLE)).toBe(true)

    const frame = build(r, builderFor(r))
    expect(frame.destCount).toBe(2)
    // Hand-computed: N puts the carpark one row above the origin, S three below.
    expect(frame.destCarpark[0] as number).toBe(cellOf(7, 14)) // 343; swapped gives 327
    expect(frame.destCarpark[1] as number).toBe(cellOf(7, 24)) // 583; swapped gives 631

    // The fixture's own reason for existing, asserted rather than described:
    // for E and W the two argument orders agree, so no number of E/W fixtures
    // could ever distinguish them.
    expect(carparkCell(N_ORIGIN, ORIENTATION_E, 24, 40)).toBe(carparkCell(N_ORIGIN, ORIENTATION_E, 40, 24))
    expect(carparkCell(N_ORIGIN, ORIENTATION_W, 24, 40)).toBe(carparkCell(N_ORIGIN, ORIENTATION_W, 40, 24))
    expect(carparkCell(N_ORIGIN, ORIENTATION_N, 24, 40)).not.toBe(carparkCell(N_ORIGIN, ORIENTATION_N, 40, 24))
    expect(carparkCell(S_ORIGIN, ORIENTATION_S, 24, 40)).not.toBe(carparkCell(S_ORIGIN, ORIENTATION_S, 40, 24))
  })

  it('tracks destPins as they change, and reports houseCount and destCount from the header', () => {
    const r = rig(true)
    const fb = builderFor(r)
    expect(build(r, fb).destPins[1] as number).toBe(0)
    r.state.destPins[1] = 4
    const frame = build(r, fb)
    expect(frame.destPins[1] as number).toBe(4)
    expect(frame.houseCount).toBe(r.state.header[H_HOUSE_COUNT] as number)
    expect(frame.destCount).toBe(r.state.header[H_DEST_COUNT] as number)
    expect(frame.houseCount).toBe(3)
  })

  /**
   * The seeded city has three houses AND three destinations, so every
   * assertion above passes with the two counts swapped. That is a lucky-value
   * accident of exactly the parity kind the catalogue names, and it was a live
   * 0-detector until this case existed: `frame.houseCount = destCount` survived
   * the whole suite.
   */
  it('keeps houseCount and destCount apart on a board where they differ', () => {
    const r = rig()
    expect(placeHouse(r.state, r.world, cellOf(8, 24), 0)).toBe(true)
    expect(placeHouse(r.state, r.world, cellOf(11, 20), 1)).toBe(true)
    const frame = build(r, builderFor(r))
    expect(frame.houseCount).toBe(2)
    expect(frame.destCount).toBe(0)
    expect(frame.houseCount).not.toBe(frame.destCount)
  })

  it('exposes the raw house views, whose live prefix is houseCount', () => {
    const r = rig(true)
    const frame = build(r, builderFor(r))
    expect(frame.houseCell).toBe(r.state.houseCell)
    expect(frame.houseColour).toBe(r.state.houseColour)
    expect(frame.roads).toBe(r.state.roads)
    expect(frame.ghosts).toBe(r.state.ghostMask)
    expect(Array.from(frame.houseCell.subarray(0, 3))).toEqual([
      cellOf(8, 24),
      cellOf(8, 13),
      cellOf(17, 18),
    ])
    expect(Array.from(frame.houseColour.subarray(0, 3))).toEqual([0, 0, 1])
  })
})

// ---------------------------------------------------------------------------
// 2b. The ghost layer (M1d Task 8)
// ---------------------------------------------------------------------------

describe('the ghost layer reaches the renderer', () => {
  /**
   * Spec §5.11's deferred refund, from `sim`'s bytes to `RenderFrame`. `game`'s
   * whole share of it is one raw view, and that is the design: `state.ghostMask`
   * is already the per-cell 8-bit mask `render` blits, so folding it would be
   * copying 960 bytes a frame to produce the bytes we already have.
   *
   * These are `frame.ts`'s tests. The DRAWING of the layer — which surface,
   * which tile, which rect, and the culling in both directions — is
   * `packages/render/test/canvas.test.ts`, and the thinner/fainter stroke is
   * `packages/render/test/atlas.test.ts`.
   */

  /** Two adjacent LAND cells inside the revealed rect: (10, 20) and (11, 20). */
  const GHOST_A = cellOf(10, 20)
  const GHOST_B = cellOf(11, 20)

  it('carries no ghost on a board where nothing has been erased', () => {
    // The negative control, and it is the common case: `ghostMask` is 960 zero
    // bytes for nearly every frame of a run, and the draw path must add nothing.
    const r = rig(true)
    const frame = build(r, builderFor(r))
    expect(frame.ghosts.length).toBe(r.world.cells)
    expect([...frame.ghosts].filter((m) => m !== 0)).toEqual([])
  })

  it('shows the bit a REAL erase-under-a-committed-car deferred, on that cell', () => {
    // End to end through `sim`'s own `placeRoad`/`eraseRoad`, not by poking the
    // region: what `render` has to be able to draw is whatever the erase writes,
    // and a fixture that wrote the byte itself would agree with a `frame.ts`
    // that read the wrong region as long as the test wrote to that one too.
    const r = rig(true)
    expect(placeRoad(r.state, r.world, GHOST_A, GHOST_B)).toBe(true)
    const beforeTiles = tilesLeft(r.state)

    // One car standing ON (11, 20) and in flight: `isCommittedTo` answers true
    // for a car already on the cell, which is the cheapest committed car there
    // is and needs no route walk to be one.
    r.state.carPhase[0] = PHASE_OUTBOUND
    r.state.carCell[0] = GHOST_B

    expect(eraseRoad(r.state, r.world, GHOST_A, GHOST_B)).toBe(true)

    const frame = build(r, builderFor(r))
    // (10, 20) had no committed car, so it refunded at once and is not a ghost.
    // (11, 20) deferred, and the bit it kept points back the way the segment
    // went: W = direction 6 = 0b0100_0000.
    expect(frame.ghosts[GHOST_B] as number).toBe(0b0100_0000)
    expect(frame.ghosts[GHOST_A] as number).toBe(0)
    // The live layer lost it in the same operation, so the two layers are
    // disjoint on this cell exactly as `render` documents they always are.
    expect(frame.roads[GHOST_B] as number).toBe(0)
    expect(frame.roads[GHOST_A] as number).toBe(0)
    // One of the two tiles came back and the other is still owed.
    expect(tilesLeft(r.state)).toBe(beforeTiles + 1)
  })

  it('follows the region without a rebuild, so a ghost cannot render stale', () => {
    // The staleness half. `ghosts` is assigned once, in `createFrameBuilder`, so
    // a frame built BEFORE the erase and a frame built after must disagree
    // through the same builder — which is what "a raw view" buys and what a
    // per-frame fold or a one-shot copy would both break.
    const r = rig(true)
    const fb = builderFor(r)
    expect(placeRoad(r.state, r.world, GHOST_A, GHOST_B)).toBe(true)
    expect((build(r, fb).ghosts[GHOST_B] as number)).toBe(0)

    r.state.carPhase[0] = PHASE_OUTBOUND
    r.state.carCell[0] = GHOST_B
    expect(eraseRoad(r.state, r.world, GHOST_A, GHOST_B)).toBe(true)
    expect((build(r, fb).ghosts[GHOST_B] as number)).toBe(0b0100_0000)

    // ...and back again when the refund is paid, through the same builder. A
    // road placed on a ghost cell pays the pending tile and clears the mask.
    expect(placeRoad(r.state, r.world, GHOST_A, GHOST_B)).toBe(true)
    expect((build(r, fb).ghosts[GHOST_B] as number)).toBe(0)
    expect((build(r, fb).roads[GHOST_B] as number)).toBe(0b0100_0000)
  })
})

// ---------------------------------------------------------------------------
// 3. The dense car array
// ---------------------------------------------------------------------------

describe('the dense car array', () => {
  /**
   * The sim has no index-based car count: an unused slot is `PHASE_NONE` with
   * `carCell = 0`, a real in-bounds cell. `game` densifies, so a phantom is
   * unrepresentable at the interface rather than merely undrawn.
   *
   * The fixture puts a DEAD slot between two live ones, which is off the
   * reachable manifold today (`placeHouse` only ever appends, and M1e's spawner
   * appends through the same function) and is exactly what **M1f's** building
   * removal produces. Without a gap in the middle, "copy slot i to dense i"
   * passes.
   */
  it('packs live cars at the front, skipping a dead slot in the middle', () => {
    const r = rig()
    // Two houses, four car slots: 0, 1 (house 0, colour 0) and 2, 3 (house 1,
    // colour 3). Colours differ so a constant-colour bug is visible; the dense
    // index differs from the slot index so an index confusion is too.
    expect(placeHouse(r.state, r.world, cellOf(8, 24), 0)).toBe(true)
    expect(placeHouse(r.state, r.world, cellOf(11, 20), 3)).toBe(true)
    r.state.carPhase[1] = PHASE_NONE // slot 1 dies

    const fb = builderFor(r)
    const frame = build(r, fb)
    expect(frame.carCount).toBe(3)
    expect(carXY(frame, 0)).toEqual([8, 24]) // slot 0
    expect(carXY(frame, 1)).toEqual([11, 20]) // slot 2, packed to dense 1
    expect(carXY(frame, 2)).toEqual([11, 20]) // slot 3, packed to dense 2
    expect(Array.from(frame.carColour.subarray(0, 3))).toEqual([0, 3, 3])
  })

  it('takes each car’s colour from ITS OWN house, not from the dense index', () => {
    // Reading `houseColour[denseIndex]` would give [0, 0, 3] above and [0, 0,
    // 3, 3] here — indistinguishable in the second case, which is why the gap
    // fixture exists. This one pins the same rule with no gap, so the two
    // together separate "houseColour[carHome[slot]]" from every neighbour.
    const r = rig()
    expect(placeHouse(r.state, r.world, cellOf(8, 24), 4)).toBe(true)
    expect(placeHouse(r.state, r.world, cellOf(11, 20), 1)).toBe(true)
    const frame = build(r, builderFor(r))
    expect(frame.carCount).toBe(2 * CARS_PER_HOUSE)
    expect(Array.from(frame.carColour.subarray(0, 4))).toEqual([4, 4, 1, 1])
  })

  it('reports carCount 0 on a board with no houses, and leaves the buffer alone', () => {
    const r = rig()
    const frame = build(r, builderFor(r))
    expect(frame.carCount).toBe(0)
    expect(frame.carXY.length).toBeGreaterThan(0)
  })

  /**
   * The UNDER-iteration half of the snapshot's bound. `firstCity` has 40
   * `maxHouses` and therefore 80 car slots, of which the seed uses six — so a
   * snapshot loop that stops one slot short reaches nothing, draws nothing, and
   * passes every other test in this file. A car parked in the LAST slot is the
   * only fixture that can see it.
   *
   * `carHome` is set to house 2 (colour 1) rather than 0, so the same case also
   * separates "the last slot is drawn" from "the last slot is drawn as some
   * other car".
   */
  it('resolves and draws a car in the LAST slot', () => {
    const r = rig(true)
    const last = r.state.carPhase.length - 1
    expect(last).toBe(79)
    r.state.carPhase[last] = PHASE_IDLE
    r.state.carHome[last] = 2
    r.state.carCell[last] = cellOf(6, 29)
    const frame = build(r, builderFor(r))
    expect(frame.carCount).toBe(7)
    expect(carXY(frame, 6)).toEqual([6, 29])
    expect(frame.carColour[6] as number).toBe(1)
  })

  it('sizes carXY for every slot, so carXY.length / 2 is NOT the car count', () => {
    const r = rig(true)
    const frame = build(r, builderFor(r))
    expect(frame.carCount).toBe(3 * CARS_PER_HOUSE)
    expect(frame.carXY.length).toBe(r.state.carPhase.length * 2)
    expect(frame.carXY.length / 2).toBeGreaterThan(frame.carCount)
  })
})

// ---------------------------------------------------------------------------
// 4. The HUD scalars
// ---------------------------------------------------------------------------

describe('the HUD scalars', () => {
  it('reads week and day from sim’s clock at a boundary a stored ticks-per-day would miss', () => {
    // 4500 / 7 = 642.857..., so day 1 starts at tick 643, not 642. A `game`-side
    // `floor(tick / 642)` reads day 1 at tick 642 and drifts six ticks a week
    // from there.
    const r = rig()
    const fb = builderFor(r)
    expect(TICKS_PER_WEEK).toBe(4500)
    expect(DAYS_PER_WEEK).toBe(7)

    r.state.header[H_TICK] = 642
    expect(build(r, fb).day).toBe(0)
    r.state.header[H_TICK] = 643
    expect(build(r, fb).day).toBe(1)
    // The last day of the week, and the first tick of the next week.
    r.state.header[H_TICK] = 4499
    let frame = build(r, fb)
    expect(frame.day).toBe(6)
    expect(frame.week).toBe(0)
    r.state.header[H_TICK] = 4500
    frame = build(r, fb)
    expect(frame.day).toBe(0)
    expect(frame.week).toBe(1)
  })

  it('agrees with weekOfTick/dayOfWeek across a whole week, tick for tick', () => {
    // The strongest available statement that the HUD owns no clock arithmetic
    // of its own: not one tick in a week may disagree.
    const r = rig()
    const fb = builderFor(r)
    for (let t = 0; t < TICKS_PER_WEEK + 3; t += 7) {
      r.state.header[H_TICK] = t
      const frame = build(r, fb)
      expect(frame.week, `week at tick ${t}`).toBe(weekOfTick(t))
      expect(frame.day, `day at tick ${t}`).toBe(dayOfWeek(t))
    }
  })

  it('carries score, tilesLeft and paused', () => {
    const r = rig(true)
    const fb = builderFor(r)
    let frame = build(r, fb, 0, false)
    expect(frame.score).toBe(0)
    expect(frame.tilesLeft).toBe(tilesLeft(r.state))
    expect(frame.tilesLeft).toBe(30)
    expect(frame.paused).toBe(false)

    r.state.header[H_SCORE] = 7
    r.state.header[H_TILES] = 12
    frame = build(r, fb, 0, true)
    expect(frame.score).toBe(7)
    expect(frame.tilesLeft).toBe(12)
    expect(frame.paused).toBe(true)
  })

  /**
   * §5.10's offer, folded onto the frame — M1f Task 7.
   *
   * **Through `sim`'s own `offerPending`/`offerSlot`, never off the header**, and
   * the third block below is the whole reason. `applyChooseCard` deliberately
   * does NOT clear `H_OFFER_A`/`H_OFFER_B` (see its comment: `offerSlot` already
   * folds `pending ? slot : CARD_NONE`, and clearing would be a second mechanism
   * for one fact), so a `buildFrame` that read the header directly would draw
   * last week's card on every frame for the rest of the run — including over a
   * running board, since the modal is up exactly while `offerPending` holds.
   *
   * **Every expected value here is a LITERAL read off `cards.ts`'s ids, not a
   * call to `offerSlot`.** Deriving the expectation from the function under test
   * is this repo's catalogue entry that cost M1f Task 6 two detectors.
   */
  it('carries the offer through offerSlot, and reads as NO CARD once the week is resolved', () => {
    const r = rig(true)
    const fb = builderFor(r)

    // Week 0 has no offer at all — `offerPending` excludes it, because the
    // first boundary is the START of week 1.
    let frame = build(r, fb)
    expect(frame.offerPending, 'week 0 cannot have an offer').toBe(false)
    expect(frame.offerA).toBe(CARD_NONE)
    expect(frame.offerB).toBe(CARD_NONE)

    // A raised offer. `1` is CARD_ROAD_TILES and `7` is CARD_JUNCTION_UPGRADE —
    // the two bits of `CARD_IMPLEMENTED_MASK`, written as the numbers the
    // renderer will receive.
    r.state.header[H_WEEK] = 1
    r.state.header[H_OFFER_A] = 1
    r.state.header[H_OFFER_B] = 7
    frame = build(r, fb)
    expect(frame.offerPending).toBe(true)
    expect(frame.offerA, 'CARD_ROAD_TILES, as a plain number — render imports nothing from sim').toBe(1)
    expect(frame.offerB, 'CARD_JUNCTION_UPGRADE').toBe(7)
    expect(CARD_NONE, 'and the "no card" value the two above are distinguishable from').toBe(0)

    // Resolved, exactly as `applyChooseCard` leaves it: `H_OFFER_WEEK` catches
    // up and the two slots are left holding the real cards.
    r.state.header[H_OFFER_WEEK] = 1
    frame = build(r, fb)
    expect(frame.offerPending).toBe(false)
    expect(frame.offerA, 'reads as no offer').toBe(CARD_NONE)
    expect(frame.offerB, 'and so does B').toBe(CARD_NONE)
    expect(r.state.header[H_OFFER_A], 'while the header still holds the raw card, deliberately').toBe(1)
    expect(r.state.header[H_OFFER_B]).toBe(7)
    expect(offerPending(r.state), 'and the frame agrees with sim rather than with a copy').toBe(false)
  })

  /**
   * §5.10's grants, folded as NUMBERS — M1f Task 8, plan Decision 17, review
   * finding I6.
   *
   * **This is the test that makes `CARD_GRANT_ROAD_TILES` reach the screen.**
   * The modal shows "30 TILES" and "x2"; both numbers are `shared` constants
   * `render` cannot import. Written as literals in `canvas.ts` they would keep
   * saying 30 and 2 after a retune, with every test in both packages green.
   */
  it('folds both grants and both item counts from sim’s own table', () => {
    const r = rig(true)
    const fb = builderFor(r)

    // Nothing pending: no card, so no grant. `cardTileGrant` THROWS on
    // `CARD_NONE` — it is total over the OFFERABLE set by design — so a fold
    // that did not guard would take the whole render path down on every frame
    // of week 0.
    let frame = build(r, fb)
    expect(frame.offerPending).toBe(false)
    expect([frame.offerGrantA, frame.offerGrantB]).toEqual([0, 0])
    expect([frame.offerItemsA, frame.offerItemsB]).toEqual([0, 0])
    expect(() => cardTileGrant(CARD_NONE), 'and the guard is load-bearing').toThrow()

    r.state.header[H_WEEK] = 1
    r.state.header[H_OFFER_A] = CARD_ROAD_TILES
    r.state.header[H_OFFER_B] = CARD_JUNCTION_UPGRADE
    frame = build(r, fb)
    expect(frame.offerGrantA).toBe(cardTileGrant(CARD_ROAD_TILES))
    expect(frame.offerGrantB).toBe(cardTileGrant(CARD_JUNCTION_UPGRADE))
    expect(frame.offerItemsA).toBe(cardItemGrant(CARD_ROAD_TILES))
    expect(frame.offerItemsB).toBe(cardItemGrant(CARD_JUNCTION_UPGRADE))

    // **The two slots must be separable**, or "folds slot B" is satisfied by a
    // fold that reads slot A twice. The two cards pay different numbers of
    // tiles AND different numbers of items on the shipped pair, so swapping the
    // slots moves both rows.
    expect(frame.offerGrantA).not.toBe(frame.offerGrantB)
    expect(frame.offerItemsA).not.toBe(frame.offerItemsB)

    // ...and swapping the header slots swaps the frame's, so neither field is a
    // constant that happens to match.
    r.state.header[H_OFFER_A] = CARD_JUNCTION_UPGRADE
    r.state.header[H_OFFER_B] = CARD_ROAD_TILES
    frame = build(r, fb)
    expect(frame.offerGrantA).toBe(cardTileGrant(CARD_JUNCTION_UPGRADE))
    expect(frame.offerItemsA).toBe(cardItemGrant(CARD_JUNCTION_UPGRADE))
    expect(frame.offerGrantB).toBe(cardTileGrant(CARD_ROAD_TILES))
    expect(frame.offerItemsB).toBe(cardItemGrant(CARD_ROAD_TILES))

    // Resolved: `offerSlot` folds to `CARD_NONE`, so the grants go with it and
    // the modal cannot draw last week's numbers over a running board.
    r.state.header[H_OFFER_WEEK] = 1
    frame = build(r, fb)
    expect([frame.offerGrantA, frame.offerGrantB]).toEqual([0, 0])
    expect([frame.offerItemsA, frame.offerItemsB]).toEqual([0, 0])
  })

  it('carries the peek flag through as it is handed, on both sides of it', () => {
    // `offerPeek` is not derived from anything in `sim` — peek is UI (plan
    // Decision 16) — so the only thing to pin is that the parameter reaches the
    // field rather than being dropped for a literal.
    const r = rig(true)
    const fb = builderFor(r)
    expect(build(r, fb, 0, true, false).offerPeek).toBe(false)
    expect(build(r, fb, 0, true, true).offerPeek).toBe(true)
    expect(build(r, fb, 0, true, false).offerPeek, 'and it follows back down').toBe(false)
  })

  it('carries the camera it was handed, so a viewport change reaches the renderer', () => {
    const r = rig()
    const fb = builderFor(r)
    const narrow = fitCamera(
      { cssW: 390, cssH: 844, topInset: 46, bottomInset: 34, rawDpr: 3, performanceClass: null },
      { x0: REVEALED_X0, y0: REVEALED_Y0, cols: REVEALED_W, rows: REVEALED_H },
    )
    expect(narrow.tileSize).not.toBe(r.camera.tileSize)
    expect(build(r, fb).camera).toBe(r.camera)
    expect(buildFrame(fb, r.state, r.world, narrow, 0, false, false).camera).toBe(narrow)
  })
})

// ---------------------------------------------------------------------------
// 4b. The overcrowd fold and the two shutdown scalars — M1e Task 9
// ---------------------------------------------------------------------------

describe('the overcrowd fold and the shutdown scalars', () => {
  it('folds the meter against the FULL 90 s, not the 88 s that kills you', () => {
    // §5.8's "hidden grace at the end": the ring is drawn against
    // OVERCROWD_FULL_MILLITICKS while failure fires at
    // OVERCROWD_FAIL_MILLITICKS, so it reads 97.8 % at the instant the city
    // dies. Folding against the fail value instead would show a full ring two
    // seconds early, every time, and delete the grace the spec asks for.
    //
    // TWO destinations, one at zero: a single-destination fixture cannot tell
    // "folds the meter" from "writes 249 into slot 0".
    const r = rig()
    const fb = builderFor(r)
    r.state.header[H_DEST_COUNT] = 2
    r.state.destOvercrowd[0] = 0
    r.state.destOvercrowd[1] = OVERCROWD_FAIL_MILLITICKS
    const f = build(r, fb)
    expect(f.destOvercrowd[0]).toBe(0)
    expect(f.destOvercrowd[1]).toBe(249) // floor(2_640_000 * 255 / 2_700_000)
    expect(f.destOvercrowd[1], 'the ring is not full when the run ends').toBeLessThan(255)
  })

  it('is not vacuous: the two constants really do differ, by §5.8’s 2 s grace', () => {
    // If the two were equal the assertion above would pass on the mutant it
    // exists to catch. Stated against the grace rather than against 249, so it
    // fails for the right reason if the grace is ever retuned.
    expect(OVERCROWD_FULL_MILLITICKS - OVERCROWD_FAIL_MILLITICKS).toBe(2 * 30 * DENOM)
    expect(OVERCROWD_FAIL_MILLITICKS).toBeLessThan(OVERCROWD_FULL_MILLITICKS)
  })

  it('clamps a meter past FULL to 255 instead of wrapping the byte', () => {
    // Unreachable through `sim` today — the meter's own bound is
    // `OVERCROWD_FAIL_MILLITICKS + DENOM - 1`, which folds to 249 — so this is
    // the guard on a value only a future retune (or a restore) can produce. A
    // `Uint8Array` truncates modulo 256, so without the clamp a meter at
    // 2 x FULL writes 254 and the ring reads *almost full* rather than full.
    const r = rig()
    const fb = builderFor(r)
    r.state.header[H_DEST_COUNT] = 2
    r.state.destOvercrowd[0] = OVERCROWD_FULL_MILLITICKS
    r.state.destOvercrowd[1] = OVERCROWD_FULL_MILLITICKS * 2
    const f = build(r, fb)
    expect(f.destOvercrowd[0], 'exactly FULL is exactly full').toBe(255)
    expect(f.destOvercrowd[1], 'twice FULL is still full, not 254').toBe(255)
  })

  it('reports game over and the destination that caused it, and -1 while live', () => {
    const r = rig()
    const fb = builderFor(r)
    expect(build(r, fb).gameOver).toBe(false)
    expect(build(r, fb).failedDest).toBe(-1)
    r.state.header[H_GAME_OVER] = 1
    r.state.header[H_FAILED_DEST] = 1
    const f = build(r, fb)
    expect(f.gameOver).toBe(true)
    expect(f.failedDest).toBe(1)
  })

  it('reads the pair through sim’s own guards, so a live H_FAILED_DEST cannot leak', () => {
    // `H_FAILED_DEST` is zero-initialised and `failedDestination` is the guard
    // that stops a live run reporting "destination 0 killed you". Poking the
    // slot without the flag must still read -1 — the mutation this kills is
    // `frame.failedDest = state.header[H_FAILED_DEST]`, which is the obvious
    // shorter spelling and is wrong on every live frame of every run.
    const r = rig()
    const fb = builderFor(r)
    r.state.header[H_FAILED_DEST] = 3
    const f = build(r, fb)
    expect(f.gameOver).toBe(false)
    expect(f.failedDest).toBe(-1)
  })

  it('keeps destOvercrowd preallocated and sized for every destination slot', () => {
    const r = rig()
    const fb = builderFor(r)
    const a = build(r, fb)
    const b = build(r, fb)
    expect(b.destOvercrowd).toBe(a.destOvercrowd)
    expect(a.destOvercrowd).toBeInstanceOf(Uint8Array)
    expect(a.destOvercrowd.length).toBe(r.state.destCell.length)
  })
})

// ---------------------------------------------------------------------------
// 5. The frame object is rewritten in place
// ---------------------------------------------------------------------------

describe('preallocation', () => {
  it('returns the same frame object and the same typed arrays every time', () => {
    const r = rig(true)
    const fb = builderFor(r)
    const a = build(r, fb)
    const b = build(r, fb)
    expect(b).toBe(a)
    expect(b.terrainClass).toBe(a.terrainClass)
    expect(b.carXY).toBe(a.carXY)
    expect(b.destCarpark).toBe(a.destCarpark)
  })
})

// ---------------------------------------------------------------------------
// 6. Interpolation
// ---------------------------------------------------------------------------

describe('interpolation', () => {
  /** A car mid-edge: slot 0 outbound, cell (11, 12), heading E, half a cell along. */
  function movingCar(r: Rig, progress: number): void {
    r.state.carPhase[0] = PHASE_OUTBOUND
    r.state.carCell[0] = cellOf(11, 12)
    r.state.carProgress[0] = progress
    r.state.carRouteCursor[0] = 0
    r.state.carRouteLen[0] = 4
    for (let k = 0; k < 4; k++) packRouteStep(r.state, 0, k, 2 /* E */)
  }

  /**
   * THE observable that separates interpolated rendering from tick-quantised
   * rendering, and the only one that kills "pass alpha = 0 always".
   *
   * With progress-resolved positions a car is strictly between two cells on
   * roughly seven ticks in eight regardless of alpha, so "drawn between two
   * cells" and ">= 10 distinct positions" both survive that mutation. It is
   * also the only observer of "snapshot prev AFTER step", which collapses
   * `prevXY` onto `currXY` and makes the lerp constant within a tick.
   */
  it('renders two different positions for two frames inside the same tick', () => {
    const r = rig()
    movingCar(r, 800)
    const fb = builderFor(r)

    snapshotPrev(fb.snapshots, r.state, r.world)
    r.state.carProgress[0] = 1130 // one tick of movement: +330
    snapshotCurr(fb.snapshots, r.state, r.world, 1)

    const early = carXY(build(r, fb, 0.1), 0)
    const late = carXY(build(r, fb, 0.9), 0)
    expect(early[0]).not.toBe(late[0])
    expect(late[0]).toBeGreaterThan(early[0])
    // ...and both are strictly inside the tick's own displacement.
    expect(early[0]).toBeGreaterThan(800 / 2500 + 11)
    expect(late[0]).toBeLessThan(1130 / 2500 + 11)
  })

  it('renders the exact midpoint at alpha 0.5 on a tick where carCell did NOT change', () => {
    // The 86.8% case. prev = 11 + 800/2500 = 11.32, curr = 11 + 1130/2500 =
    // 11.452, midpoint 11.386. Both are on cell (11, 12): no crossing, and the
    // interpolation still has to do real work.
    const r = rig()
    movingCar(r, 800)
    const fb = builderFor(r)
    snapshotPrev(fb.snapshots, r.state, r.world)
    r.state.carProgress[0] = 1130
    snapshotCurr(fb.snapshots, r.state, r.world, 1)
    expect(r.state.carCell[0] as number).toBe(cellOf(11, 12))

    const [x, y] = exactXY(fb, 0, 0.5)
    expect(x).toBeCloseTo(11.386, 6)
    expect(y).toBe(12)
  })

  it('crosses a cell boundary continuously: prev at alpha 0, curr at alpha ~1, no jump', () => {
    // The crossing tick: progress 2400 -> +330 = 2730 >= 2500, so carCell
    // advances to (12, 12) and the carry is 230.
    //   prev = 11 + 2400/2500 = 11.96
    //   curr = 12 + 230/2500  = 12.092
    // Displacement 0.132 cells — one ordinary tick, with no discontinuity at
    // the cell change at all.
    const r = rig()
    movingCar(r, 2400)
    const fb = builderFor(r)
    snapshotPrev(fb.snapshots, r.state, r.world)
    r.state.carCell[0] = cellOf(12, 12)
    r.state.carProgress[0] = 230
    r.state.carRouteCursor[0] = 1
    snapshotCurr(fb.snapshots, r.state, r.world, 1)

    expect(exactXY(fb, 0, 0)[0]).toBeCloseTo(11.96, 6)
    expect(exactXY(fb, 0, 0.999999)[0]).toBeCloseTo(12.092, 5)
    let last = exactXY(fb, 0, 0)[0]
    const first = last
    for (let a = 1 / 64; a < 1; a += 1 / 64) {
      const x = exactXY(fb, 0, a)[0]
      expect(x - last, `alpha ${a}`).toBeGreaterThan(0)
      expect(x - last, `alpha ${a}`).toBeLessThan(0.132)
      last = x
    }
    // The whole tick's displacement is one ordinary tick of motion. A cell
    // change is not a discontinuity here, which is the point.
    expect(last - first).toBeLessThan(0.132)
    expect(last - first).toBeGreaterThan(0.12)
  })

  /**
   * The one interpolated tick where the route TURNS, and the reason it is here
   * even though it cannot fail.
   *
   * A lerp of two resolved points is a convex combination, so overshoot is
   * unrepresentable in this shape — `lerpCar` never sees `carProgress`, a
   * direction or a speed. The single-expression form the catalogue warns about
   * (`progress + alpha * speed`) is at its worst exactly here, at a corner,
   * measured at up to 0.19 cells past the turn. Every other continuity fixture
   * in this file drives a straight route, so this is the case a future reader
   * tempted to re-introduce that form would look for. It is completeness, not
   * risk, and it is labelled as such.
   *
   * The car crosses from (11, 12) heading E onto (12, 12), where the route
   * turns N. prev = 11 + 2400/2500 = 11.96 on row 12; curr = (12, 12 - 230/2500)
   * = (12, 11.908). The chord cuts the corner: `hypot(0.04, 0.092)` = 0.10032,
   * BELOW the 0.132 the same tick would travel along the path, and an
   * extrapolation along E would instead put the car at x = 12.092 on row 12 —
   * outside the segment between the two resolved points, which is what "cannot
   * overshoot" means.
   */
  it('cuts the corner rather than overshooting it when the route turns mid-tick', () => {
    const r = rig()
    movingCar(r, 2400)
    // Step 0 is E, step 1 turns N.
    packRouteStep(r.state, 0, 1, 0 /* N */)
    const fb = builderFor(r)
    snapshotPrev(fb.snapshots, r.state, r.world)
    r.state.carCell[0] = cellOf(12, 12)
    r.state.carProgress[0] = 230
    r.state.carRouteCursor[0] = 1
    snapshotCurr(fb.snapshots, r.state, r.world, 1)

    const at0 = exactXY(fb, 0, 0)
    const at1 = exactXY(fb, 0, 0.999999)
    expect(at0[0]).toBeCloseTo(11.96, 6)
    expect(at0[1]).toBe(12)
    expect(at1[0]).toBeCloseTo(12, 5)
    expect(at1[1]).toBeCloseTo(11.908, 5)

    // The chord is shorter than one tick's travel along the path — the corner
    // is cut, not rounded and not overshot.
    const chord = Math.hypot(at1[0] - at0[0], at1[1] - at0[1])
    expect(chord).toBeLessThan(0.132)
    expect(chord).toBeCloseTo(Math.hypot(0.04, 0.092), 5)
    expect(chord).toBeCloseTo(0.10032, 4)

    // Every sample lies inside the axis-aligned box spanned by prev and curr,
    // which is what a convex combination guarantees and an extrapolation along
    // E (x = 12.092, y = 12) would violate on both axes.
    for (let a = 0; a <= 1; a += 1 / 32) {
      const [x, y] = exactXY(fb, 0, Math.min(a, 0.999999))
      expect(x, `alpha ${a} x`).toBeGreaterThanOrEqual(11.96 - 1e-5)
      expect(x, `alpha ${a} x`).toBeLessThanOrEqual(12 + 1e-5)
      expect(y, `alpha ${a} y`).toBeLessThanOrEqual(12 + 1e-5)
      expect(y, `alpha ${a} y`).toBeGreaterThanOrEqual(11.908 - 1e-5)
    }
  })

  it('crosses the mid-line between two cells exactly once across a whole edge traversal', () => {
    // The cell boundary in centre-units sits at x = 11.5 between cells (11, 12)
    // and (12, 12). Sampling every rendered position across the ~7.6 ticks of
    // the edge, the car must pass 11.5 once and never come back — which is what
    // rules out both a jittering cell-to-cell lerp and an extrapolation that
    // overshoots and snaps back.
    const r = rig()
    movingCar(r, 0)
    const fb = builderFor(r)
    const xs: number[] = []
    for (let t = 0; t < 12; t++) {
      snapshotPrev(fb.snapshots, r.state, r.world)
      // One tick of movement, applied by hand exactly as `advanceCar` does.
      let p = (r.state.carProgress[0] as number) + 330
      if (p >= 2500) {
        p -= 2500
        r.state.carCell[0] = (r.state.carCell[0] as number) + 1
        r.state.carRouteCursor[0] = (r.state.carRouteCursor[0] as number) + 1
      }
      r.state.carProgress[0] = p
      snapshotCurr(fb.snapshots, r.state, r.world, 1)
      for (let a = 0; a < 1; a += 0.25) xs.push(carXY(build(r, fb, a), 0)[0])
    }
    let crossings = 0
    for (let i = 1; i < xs.length; i++) {
      const before = xs[i - 1] as number
      const after = xs[i] as number
      expect(after, `sample ${i} went backwards`).toBeGreaterThan(before)
      if (before < 11.5 && after >= 11.5) crossings++
    }
    expect(crossings).toBe(1)
    // Vacuity: the traversal must actually reach past the mid-line.
    expect(xs[xs.length - 1] as number).toBeGreaterThan(11.5)
  })
})

// ---------------------------------------------------------------------------
// 7. Frame 1, and a car that appears mid-run
// ---------------------------------------------------------------------------

describe('the first frame, and cars that appear later', () => {
  it('draws every car at its house before a single tick has run', () => {
    const r = rig(true)
    const fb = builderFor(r) // includes initCarSnapshots
    const frame = build(r, fb, 0.5)
    expect(frame.carCount).toBe(6)
    // Hand-written from the seed: houses at (8, 24), (8, 13), (17, 18), two
    // cars each.
    const expected: [number, number][] = [
      [8, 24],
      [8, 24],
      [8, 13],
      [8, 13],
      [17, 18],
      [17, 18],
    ]
    for (let n = 0; n < 6; n++) expect(carXY(frame, n), `car ${n}`).toEqual(expected[n])
    // Vacuity: none of these houses is near grid cell (0, 0), so "lerped in
    // from the origin" and "at the house" are far apart. The revealed rect
    // starting at (5, 9) is what Task 2 already guarantees.
    for (let n = 0; n < 6; n++) {
      const [x, y] = carXY(frame, n)
      expect(Math.hypot(x, y)).toBeGreaterThan(10)
    }
  })

  /**
   * Without `initCarSnapshots` the failure is NOT a streak from (0, 0) — the
   * dense array is gated on `currLive`, so an unresolved snapshot means the
   * cars are simply absent. That matters more than a streak, not less: pause is
   * a tap away from tick 0, and a game paused before its first tick would show
   * a city with no cars in it, indefinitely, with nothing to point at.
   */
  it('draws no cars at all if the snapshots were never initialised — the reason init exists', () => {
    const r = rig(true)
    const fb = createFrameBuilder(r.state, r.world, r.camera) // deliberately NOT initialised
    expect(build(r, fb, 0.5).carCount).toBe(0)
    initCarSnapshots(fb.snapshots, r.state, r.world)
    expect(build(r, fb, 0.5).carCount).toBe(6)
  })

  it('draws a house placed mid-run at the house, not lerping in from a stale prev', () => {
    const r = rig(true)
    const fb = builderFor(r)
    const queue = createInputQueue()
    const loop = createLoop(driverFor(r, fb), queue)
    loop.frame(0)
    loop.frame(200) // several ticks

    // Out-of-band placement. M1e's spawner does the same thing in-band, on the
    // spawn phase inside `step`; the out-of-band call is kept here because it
    // reaches the case on a chosen tick with nothing else moving.
    expect(placeHouse(r.state, r.world, cellOf(15, 26), 2)).toBe(true)
    const newSlot = 3 * CARS_PER_HOUSE
    expect(r.state.carPhase[newSlot] as number).toBe(PHASE_IDLE)

    loop.frame(240) // one more tick: prev and curr both resolve the new slot
    const frame = build(r, fb, 0.5)
    expect(frame.carCount).toBe(8)
    expect(carXY(frame, 6)).toEqual([15, 26])
    expect(carXY(frame, 7)).toEqual([15, 26])
  })

  /**
   * The snap rule itself, driven through the sequence that produces it.
   *
   * **Its production trigger EXISTS as of M1e Task 5, and that is worth stating
   * plainly because this comment said the opposite.** `prevLive[i] === 0 &&
   * currLive[i] === 1` requires a slot to become live BETWEEN `snapshotPrev`
   * and `snapshotCurr` — i.e. inside a `step` — and `spawn.ts`'s spawn phase
   * does exactly that, measured at tick 360 on `firstCity`. Out-of-band
   * placement happens between frames, so `snapshotPrev` already sees the new
   * car (the test above); the in-band path is the one this covers.
   *
   * Testing it here, through the same two calls the loop makes in the same
   * order, is the `assertSingleCrossing` idiom: make the branch reachable from
   * a test rather than leave it as the one thing nothing executes.
   */
  it('snaps a car that becomes live BETWEEN the two snapshots straight to its curr position', () => {
    const r = rig(true)
    const fb = builderFor(r)
    const newSlot = 3 * CARS_PER_HOUSE

    snapshotPrev(fb.snapshots, r.state, r.world)
    expect(fb.snapshots.prevLive[newSlot] as number).toBe(0)
    // The stale prev is grid cell (0, 0) — an unwritten Float32Array.
    expect(fb.snapshots.prevXY[newSlot * 2] as number).toBe(0)
    expect(placeHouse(r.state, r.world, cellOf(15, 26), 2)).toBe(true)
    snapshotCurr(fb.snapshots, r.state, r.world, 1)
    expect(fb.snapshots.currLive[newSlot] as number).toBe(1)

    const frame = build(r, fb, 0.5)
    expect(frame.carCount).toBe(8)
    // Lerped, it would sit at (7.5, 13) — half way to the board's corner.
    expect(carXY(frame, 6)).toEqual([15, 26])
  })

  /**
   * **The residual aliasing class, demonstrated rather than asserted away.**
   *
   * Slot indexing removes the dense-SHIFT class (freeing slot k renumbering
   * every later car). It does not remove the slot-REUSE class: slot `i` owned
   * by car A in prev and car B in curr. `prevLive[i]` reads 1, the snap rule
   * does not fire, there is no distance guard, and the car is drawn on the
   * segment between two different houses.
   *
   * This test exists to PIN that, so the scoped claim in `resolve.ts` is
   * checkable rather than a comment someone must trust. It asserts the buggy
   * output on purpose. If a future change closes the class, this test fails and
   * the reader is sent to the comment — which is the intended outcome.
   *
   * **The launch smoothing narrowed the numbers and did NOT close the class,
   * which is why this test moved rather than went away.** `advanceDraw`'s
   * `MAX_DRAW_LAG_CELLS` clamp is not a teleport guard — it bounds where the
   * drawn position ENDS UP, not the segment the frame lerps across to get
   * there. So the drawn car still streaks between two different houses inside
   * the one drain, at (12.44, 18.08) instead of (12.5, 18): the clamp pulls the
   * far end 0.2 cells short of the new position and the mid-alpha sample moves
   * by half of that. Twelve and a half cells of streak either way.
   */
  it('does NOT catch a slot reused by a different car between the two snapshots', () => {
    const r = rig(true)
    const fb = builderFor(r)
    snapshotPrev(fb.snapshots, r.state, r.world) // slot 0 is house 0's car at (8, 24)
    expect(fb.snapshots.prevLive[0] as number).toBe(1)
    expect(fb.snapshots.drawLive[0] as number).toBe(1) // ...and it HAS drawn history
    // A spawner that frees and immediately reuses the slot within one step.
    r.state.carCell[0] = cellOf(17, 12)
    r.state.carHome[0] = 2
    snapshotCurr(fb.snapshots, r.state, r.world, 1)

    const frame = build(r, fb, 0.5)
    // Half way between two different houses, 12.6 cells from where it started.
    // Nothing in this file catches it. The exact interpolator, which the drawn
    // one chases, still puts it at the plain midpoint (12.5, 18).
    const [x, y] = carXY(frame, 0)
    expect(x).toBeCloseTo(12.44, 2)
    expect(y).toBeCloseTo(18.08, 2)
    expect(Math.hypot(x - 8, y - 24)).toBeGreaterThan(7)
    expect(exactXY(fb, 0, 0.5)).toEqual([12.5, 18])
  })

  /**
   * ...and this is what closes that class TODAY, pinned rather than asserted in
   * prose. `resolve.ts` cites reachability as the reason the slot-reuse class is
   * harmless; the catalogue's rule is that a structural defence used to justify
   * not testing something must itself be pinned.
   *
   * **RE-DERIVED, NOT DELETED, at M1e Task 5.** This test used to assert that
   * liveness never changes at all inside `step`, and M1e's spawn phase makes
   * that false on purpose: a house placed on tick 360 creates `CARS_PER_HOUSE`
   * cars inside `step`, which is exactly what the old assertion forbade. The
   * property it was really pinning survives and is stronger than the sentence
   * it was written as — **liveness only ever GROWS, it grows only where a house
   * was placed on that same tick, and a slot that becomes live is SNAPPED to
   * its sim position rather than sliding onto it from wherever the slot was
   * last used.** That last clause is `advanceDraw`'s rule 1 (`resolve.ts`), and
   * until Task 5 it had no production caller at all — `resolve.test.ts` reached
   * `prevLive === 0` by a direct call, in this codebase's
   * `assertSingleCrossing` idiom for a branch production cannot yet produce.
   * **It can now, and this is where that is observed.**
   *
   * What the old sentence protected against — a slot going live and then DEAD,
   * or a live slot being reassigned to another house — is what the two
   * assertions below still forbid, and either one turns the 12.6-cell slide of
   * the test above into a real defect.
   */
  it('grows car-slot liveness only where a house spawned, and snaps the new slot', () => {
    const r = rig(true)
    const fb = builderFor(r)
    const queue = createInputQueue()
    const loop = createLoop(driverFor(r, fb), queue)
    const path = [cellOf(8, 13), cellOf(7, 12), cellOf(7, 11), cellOf(8, 10)]
    for (let i = 0; i + 1 < path.length; i++) {
      queue.enqueue('place', path[i] as number, path[i + 1] as number)
    }
    const slots = r.state.carPhase.length
    const liveNow: number[] = []
    const homeNow: number[] = []
    for (let i = 0; i < slots; i++) {
      liveNow.push((r.state.carPhase[i] as number) === PHASE_NONE ? 0 : 1)
      homeNow.push(r.state.carHome[i] as number)
    }
    const liveAtStart = liveNow.slice()
    /** Ticks on which some slot went from dead to live, and how many did. */
    const births: { tick: number; slot: number; houses: number }[] = []
    /** Slots whose FIRST drawn frame was not their sim position. */
    const unsnapped: string[] = []

    let now = 0
    for (let f = 0; f < 1000; f++) {
      now += 16.7
      loop.frame(now)
      const tick = r.state.header[H_TICK] as number
      for (let i = 0; i < slots; i++) {
        const live = (r.state.carPhase[i] as number) === PHASE_NONE ? 0 : 1
        // 1. Liveness NEVER falls, and a live slot never changes house. Those
        //    two together are what makes the slot-reuse class above
        //    unreachable, and they are the whole of what `resolve.ts` relies on.
        if (liveNow[i] === 1) {
          expect(live, `slot ${i} went DEAD at tick ${tick}`).toBe(1)
          expect(r.state.carHome[i] as number, `slot ${i} changed house at tick ${tick}`).toBe(
            homeNow[i],
          )
        }
        if (liveNow[i] === 0 && live === 1) {
          births.push({ tick, slot: i, houses: r.state.header[H_HOUSE_COUNT] as number })
          // 3. The snap. A slot that became live inside this drain has its
          //    drawn position AT its sim position — `advanceDraw` rule 1's
          //    `prevLive === 0` arm — rather than lerping in from the stale
          //    coordinates the slot's `drawCurrXY` still held.
          const drawn = carXY(build(r, fb, 0.5), i)
          const exact = exactXY(fb, i, 0.5)
          if (drawn[0] !== exact[0] || drawn[1] !== exact[1]) {
            unsnapped.push(`slot ${i} at tick ${tick}: drawn ${drawn} vs sim ${exact}`)
          }
        }
        liveNow[i] = live
        homeNow[i] = r.state.carHome[i] as number
      }
      if ((r.state.header[H_SCORE] as number) > 0) break
    }
    // Vacuity: the run must have gone somewhere, or "nothing changed" is trivial.
    expect(r.state.header[H_SCORE] as number).toBe(1)
    expect(liveAtStart.filter((x) => x === 1).length).toBe(6)

    // 2. Every birth is a house spawn, named by tick and slot. Measured on
    //    THIS rig's seed (`m2-frame`, not `RUN_SEED`): a colour-0 house lands
    //    at tick 360 taking slots 6 and 7, and a colour-1 house at 420 taking
    //    8 and 9 — two colours, because each colour carries its own
    //    `houseSpawnTimer` and colour 1 is unlocked by the seeded clause rather
    //    than by the week. The exact figures are asserted because "some slot
    //    went live at some point" is satisfied by a slot-reuse bug just as well
    //    as by a spawn.
    expect(births.map((b) => `${b.tick}:${b.slot}`)).toEqual(['360:6', '360:7', '420:8', '420:9'])
    expect(new Set(births.map((b) => r.state.houseColour[b.houses - 1] as number)).size).toBe(2)
    for (const b of births) {
      expect(b.slot, `slot ${b.slot} is not house ${b.houses - 1}'s`).toBeGreaterThanOrEqual(
        (b.houses - 1) * CARS_PER_HOUSE,
      )
      expect(b.slot).toBeLessThan(b.houses * CARS_PER_HOUSE)
    }
    expect(unsnapped, 'a slot that became live slid onto its position instead of snapping').toEqual(
      [],
    )
  })
})

// ---------------------------------------------------------------------------
// 8. A full round trip through the real sim
// ---------------------------------------------------------------------------

/** The wiring Task 9's `main.ts` assembles. Kept in production code so its ORDER can be mutated. */
function driverFor(
  r: Rig,
  fb: FrameBuilder,
  draw?: (f: RenderFrame) => void,
  onGameOver?: () => void,
  onOfferRaised?: () => void,
  peeking?: () => boolean,
): ReturnType<typeof createFrameDriver> {
  return createFrameDriver({
    state: r.state,
    world: r.world,
    fields: r.fields,
    scratch: r.scratch,
    builder: fb,
    camera: () => r.camera,
    draw: draw ?? ((): void => {}),
    // Required in `FrameDriverDeps` and optional HERE: a default in the test
    // helper is not a default in the type, and the `@ts-expect-error` in
    // section 8b is what pins the difference. The same is true of
    // `onOfferRaised` (M1f Task 7) and section 8c pins that one.
    onGameOver: onGameOver ?? ((): void => {}),
    onOfferRaised: onOfferRaised ?? ((): void => {}),
    peeking: peeking ?? ((): boolean => false),
  })
}

describe('a full round trip on the seeded city', () => {
  /** (8,13) -> (7,12) -> (7,11) -> (8,10): the path Task 2's trip test draws. */
  const TRIP_PATH = [cellOf(8, 13), cellOf(7, 12), cellOf(7, 11), cellOf(8, 10)]
  const FIRST_PIN_TICK = 378
  const FIRST_SCORE_TICK = 435
  /** House 1's first car — the one Task 2's trip test follows. */
  const CAR = 2

  interface TripSample {
    readonly tick: number
    readonly phase: number
    readonly x: number
    readonly y: number
  }

  /**
   * Samples the car's resolved position ONCE PER TICK by hooking `beforeStep`,
   * which the loop calls exactly once before each `step`.
   *
   * Sampling per FRAME would be wrong twice over: a 60 Hz frame runs zero ticks
   * half the time (duplicate samples) and a catch-up burst runs several
   * (skipped ones), and the gap assertion below is defined between consecutive
   * TICKS. Hooking the driver also keeps the real `createFrameDriver` in the
   * path rather than replacing it.
   */
  function driveTrip(): { samples: TripSample[]; scoreTick: number; state: GameState } {
    const r = rig(true)
    const fb = builderFor(r)
    const queue = createInputQueue()
    const samples: TripSample[] = []
    const out = new Float32Array(2)

    const base = driverFor(r, fb)
    const sample = (): void => {
      resolveCar(r.state, r.world, CAR, out, 0)
      samples.push({
        tick: r.state.header[H_TICK] as number,
        phase: r.state.carPhase[CAR] as number,
        x: out[0] as number,
        y: out[1] as number,
      })
    }
    const loop = createLoop(
      {
        beforeStep(): void {
          sample()
          base.beforeStep()
        },
        advance: base.advance,
        afterDrain: base.afterDrain,
        render: base.render,
      },
      queue,
    )

    for (let i = 0; i + 1 < TRIP_PATH.length; i++) {
      queue.enqueue('place', TRIP_PATH[i] as number, TRIP_PATH[i + 1] as number)
    }

    let scoreTick = -1
    let now = 0
    loop.frame(now) // the clock reference
    // 16.7 ms frames: a real 60 Hz display, so every frame runs 0 or 1 ticks
    // and the tick a score lands on is unambiguous.
    for (let f = 0; f < 1200; f++) {
      now += 16.7
      loop.frame(now)
      if ((r.state.header[H_SCORE] as number) > 0 && scoreTick === -1) {
        expect(loop.ticksLastFrame).toBeLessThanOrEqual(1)
        scoreTick = r.state.header[H_TICK] as number
      }
      if (scoreTick !== -1 && (r.state.header[H_TICK] as number) > scoreTick + 3) break
    }
    sample() // the state after the last tick that ran
    return { samples, scoreTick, state: r.state }
  }

  /**
   * The three transition indices, each asserted to exist before it is used.
   *
   * Indexing a `findIndex` result straight into the array turns "the trip never
   * happened" into a `TypeError` on `samples[-1]`, and a crash reads exactly
   * like a kill in a mutation table. Every consumer goes through here so a
   * broken fixture fails with a sentence instead.
   */
  function transitions(samples: readonly TripSample[]): {
    dispatchAt: number
    flipAt: number
    endAt: number
  } {
    const dispatchAt = samples.findIndex((s) => s.phase === PHASE_OUTBOUND)
    expect(dispatchAt, 'the car was never dispatched').toBeGreaterThan(0)
    const flipAt = samples.findIndex((s) => s.phase === PHASE_RETURNING)
    expect(flipAt, 'the car never reached the destination').toBeGreaterThan(dispatchAt)
    const endAt = samples.findIndex((s, i) => i > flipAt && s.phase === PHASE_IDLE)
    expect(endAt, 'the car never got home').toBeGreaterThan(flipAt)
    return { dispatchAt, flipAt, endAt }
  }

  it('scores at tick 435, with the loop driving step exactly once per frame', () => {
    const { scoreTick, state } = driveTrip()
    expect(scoreTick).toBe(FIRST_SCORE_TICK)
    expect(state.header[H_SCORE] as number).toBe(1)
  })

  /**
   * The assertion that keeps Decision 2's table honest if a constant changes,
   * and the one that would have caught the first draft's imaginary teleports.
   *
   * The bound is 0.14 cells: the largest on-manifold per-tick displacement is
   * `330/3500 * sqrt(2)` = 0.1333 on a diagonal, and every arrival transition
   * is bounded by the same quantity.
   */
  it('never moves the car more than 0.14 cells between consecutive ticks', () => {
    const { samples } = driveTrip()
    let maxGap = 0
    let maxAt = -1
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1] as TripSample
      const b = samples[i] as TripSample
      const gap = Math.hypot(b.x - a.x, b.y - a.y)
      if (gap > maxGap) {
        maxGap = gap
        maxAt = b.tick
      }
    }
    expect(maxGap, `largest gap at tick ${maxAt}`).toBeLessThanOrEqual(0.14)
    // Vacuity: the car must actually have moved, or a frozen resolver passes.
    expect(maxGap).toBeGreaterThan(0.12)
  })

  it('covers dispatch, the flip and trip end inside the sampled window', () => {
    // Without this the gap assertion above could be measuring a window that
    // contains none of the three transitions it exists to check.
    const { samples } = driveTrip()
    const phases = samples.map((s) => s.phase)
    expect(phases).toContain(PHASE_IDLE)
    expect(phases).toContain(PHASE_OUTBOUND)
    expect(phases).toContain(PHASE_RETURNING)
    const { dispatchAt, flipAt, endAt } = transitions(samples)
    expect((samples[dispatchAt] as TripSample).tick).toBe(FIRST_PIN_TICK)
    expect(flipAt).toBeGreaterThan(dispatchAt)
    expect(endAt).toBeGreaterThan(flipAt)
    expect((samples[endAt] as TripSample).tick).toBe(FIRST_SCORE_TICK)
  })

  it('ends the trip on the house cell, with no discontinuity at the flip either', () => {
    const { samples } = driveTrip()
    const { flipAt, endAt } = transitions(samples)
    const beforeFlip = samples[flipAt - 1] as TripSample
    const atFlip = samples[flipAt] as TripSample
    const flipGap = Math.hypot(atFlip.x - beforeFlip.x, atFlip.y - beforeFlip.y)
    // Bounded by one tick of ordinary motion, and NOT zero — the reversed
    // direction consumes the carry from the other side of the carpark cell.
    expect(flipGap).toBeGreaterThan(0)
    expect(flipGap).toBeLessThanOrEqual(0.14)
    // Measured: 0.07677 cells, FORWARD, at tick 406 — `(330 - 2r) / threshold`
    // along the diagonal with a carry of r = 70. Plan Decision 2's table gives
    // "2 * carProgress / threshold <= 0.076 cells, BACKWARDS" for this row,
    // which is neither the magnitude nor the sign; see the task report.
    expect(flipGap).toBeCloseTo(0.07677, 4)

    const last = samples[endAt] as TripSample
    expect(last.x).toBe(8)
    expect(last.y).toBe(13)
  })

  it('renders the car strictly between two cells on most ticks, which is why cell-lerping strobes', () => {
    // Decision 2's premise, measured: `carCell` changes about once in 7.576
    // ticks, so a prev-cell -> curr-cell lerp is motionless most of the time.
    const { samples } = driveTrip()
    const driving = samples.filter((s) => s.phase === PHASE_OUTBOUND || s.phase === PHASE_RETURNING)
    const fractional = driving.filter((s) => !Number.isInteger(s.x) || !Number.isInteger(s.y))
    expect(driving.length).toBeGreaterThan(40)
    expect(fractional.length / driving.length).toBeGreaterThan(0.8)
  })
})

// ---------------------------------------------------------------------------
// 9. The driver: the snapshot ORDER, in production code
// ---------------------------------------------------------------------------

describe('createFrameDriver', () => {
  it('snapshots prev BEFORE the step and curr after, so a frame inside a tick moves', () => {
    const r = rig(true)
    const fb = builderFor(r)
    const drawn: RenderFrame[] = []
    const queue = createInputQueue()
    const loop: Loop = createLoop(
      driverFor(r, fb, (f) => {
        drawn.push(f)
      }),
      queue,
    )
    // Drive to a tick where house 1's first car is mid-edge.
    for (let i = 0; i + 1 < 4; i++) {
      queue.enqueue(
        'place',
        [cellOf(8, 13), cellOf(7, 12), cellOf(7, 11), cellOf(8, 10)][i] as number,
        [cellOf(8, 13), cellOf(7, 12), cellOf(7, 11), cellOf(8, 10)][i + 1] as number,
      )
    }
    let now = 0
    for (let t = 0; t < 390; t++) {
      now += 1000 / 30
      loop.frame(now)
    }
    expect(r.state.carPhase[2] as number).toBe(PHASE_OUTBOUND)

    // Two frames with no tick between them: 8 ms apart, well under TICK_MS.
    now += 8
    loop.frame(now)
    const a = carXY(drawn[drawn.length - 1] as RenderFrame, 2)
    now += 8
    loop.frame(now)
    const b = carXY(drawn[drawn.length - 1] as RenderFrame, 2)
    expect(loop.ticksLastFrame).toBe(0)
    expect(a).not.toEqual(b)
  })

  /**
   * The driver's two snapshot calls must write DIFFERENT buffers, and "two
   * frames inside a tick move" cannot see it.
   *
   * If `beforeStep` resolved `curr` instead of `prev`, `prevXY` would keep the
   * boot positions forever: every car would lerp from its own house toward
   * wherever it currently is, and the within-a-tick test would still pass —
   * alpha still varies, the two frames still differ. Only an ABSOLUTE
   * comparison against the previous tick's resolved position sees it. (Measured:
   * that mutation survived the whole suite until this case existed.)
   */
  it('anchors alpha 0 on the PREVIOUS tick’s position and alpha ~1 on this tick’s', () => {
    const r = rig(true)
    const fb = builderFor(r)
    const queue = createInputQueue()
    const base = driverFor(r, fb)
    const preStep = new Float32Array(2)
    const loop = createLoop(
      {
        beforeStep(): void {
          resolveCar(r.state, r.world, 2, preStep, 0)
          base.beforeStep()
        },
        advance: base.advance,
        afterDrain: base.afterDrain,
        render: base.render,
      },
      queue,
    )
    const path = [cellOf(8, 13), cellOf(7, 12), cellOf(7, 11), cellOf(8, 10)]
    for (let i = 0; i + 1 < path.length; i++) {
      queue.enqueue('place', path[i] as number, path[i + 1] as number)
    }
    let now = 0
    loop.frame(now)
    // Past dispatch (tick 378) and several cells along the route, so the car is
    // a long way from its house — which is what separates "prev" from "the boot
    // position".
    while ((r.state.header[H_TICK] as number) < 400) {
      now += 1000 / 30
      loop.frame(now)
    }
    expect(r.state.carPhase[2] as number).toBe(PHASE_OUTBOUND)
    const postStep = new Float32Array(2)
    resolveCar(r.state, r.world, 2, postStep, 0)
    // The car has genuinely left home, or prev and the boot position coincide.
    expect(Math.hypot((postStep[0] as number) - 8, (postStep[1] as number) - 13)).toBeGreaterThan(1)

    const atZero = carXY(build(r, fb, 0), 2)
    const atOne = carXY(build(r, fb, 0.999999), 2)
    expect(atZero[0]).toBeCloseTo(preStep[0] as number, 5)
    expect(atZero[1]).toBeCloseTo(preStep[1] as number, 5)
    expect(atOne[0]).toBeCloseTo(postStep[0] as number, 5)
    expect(atOne[1]).toBeCloseTo(postStep[1] as number, 5)
    // Vacuity: prev and curr must differ, or both assertions are the same one.
    expect(preStep[0]).not.toBe(postStep[0])
  })

  it('re-reads the camera every frame, so a viewport change reaches the next draw', () => {
    // `buildFrame` taking a camera is not enough: the DRIVER must ask for it
    // again. Reading `builder.frame.camera` instead returns the camera the last
    // frame was built with and freezes the view at boot.
    const r = rig(true)
    const fb = builderFor(r)
    const narrow = fitCamera(
      { cssW: 390, cssH: 844, topInset: 46, bottomInset: 34, rawDpr: 3, performanceClass: null },
      { x0: REVEALED_X0, y0: REVEALED_Y0, cols: REVEALED_W, rows: REVEALED_H },
    )
    expect(narrow.tileSize).not.toBe(r.camera.tileSize)
    let current: Camera = r.camera
    const drawn: Camera[] = []
    const loop = createLoop(
      createFrameDriver({
        state: r.state,
        world: r.world,
        fields: r.fields,
        scratch: r.scratch,
        builder: fb,
        onGameOver: (): void => {
          throw new Error('the camera re-fit rig reached game over — it must not')
        },
        // Two frames from a cold state: no week boundary is reachable, so a
        // call here means the rig is no longer the two-frame rig it claims.
        onOfferRaised: (): void => {
          throw new Error('the camera re-fit rig crossed a week boundary — it runs two frames')
        },
        camera: () => current,
        draw: (f): void => {
          drawn.push(f.camera)
        },
        peeking: (): boolean => false,
      }),
      createInputQueue(),
    )
    loop.frame(0)
    current = narrow
    loop.frame(50)
    expect(drawn[0]).toBe(r.camera)
    expect(drawn[1]).toBe(narrow)
  })

  it('draws exactly once per frame and steps the sim exactly once per tick', () => {
    const r = rig(true)
    const fb = builderFor(r)
    let draws = 0
    const queue = createInputQueue()
    const loop = createLoop(
      driverFor(r, fb, () => {
        draws++
      }),
      queue,
    )
    loop.frame(0)
    loop.frame(50) // 1 tick, accumulator 16.67
    loop.frame(60) // 0 ticks, accumulator 26.67
    expect(draws).toBe(3)
    expect(loop.ticksLastFrame).toBe(0)
    expect(r.state.header[H_TICK] as number).toBe(1)
  })

  it('passes the loop’s paused flag into the frame', () => {
    const r = rig(true)
    const fb = builderFor(r)
    const drawn: RenderFrame[] = []
    const loop = createLoop(
      driverFor(r, fb, (f) => {
        drawn.push({ ...f })
      }),
      createInputQueue(),
    )
    loop.frame(0)
    loop.setPaused(true)
    loop.frame(50)
    expect((drawn[0] as RenderFrame).paused).toBe(false)
    expect((drawn[1] as RenderFrame).paused).toBe(true)
  })

  it('applies queued actions through step', () => {
    const r = rig()
    const fb = builderFor(r)
    const queue = createInputQueue()
    const loop = createLoop(driverFor(r, fb), queue)
    loop.frame(0)
    queue.enqueue('place', cellOf(8, 20), cellOf(9, 20))
    loop.frame(40)
    expect(r.state.roads[cellOf(8, 20)] as number).not.toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 10. Vacuity guards on the fixtures themselves
// ---------------------------------------------------------------------------

describe('fixture preconditions', () => {
  it('has a non-square board and a revealed rect whose origin is not on the diagonal', () => {
    const r = rig()
    expect(r.world.w).not.toBe(r.world.h)
    expect(REVEALED_X0).not.toBe(REVEALED_Y0)
    expect(REVEALED_W).not.toBe(REVEALED_H)
  })

  it('places every seeded building well inside the revealed rect', () => {
    const r = rig(true)
    for (let h = 0; h < 3; h++) {
      const cell = r.state.houseCell[h] as number
      const x = cell % GRID_W
      const y = (cell / GRID_W) | 0
      expect(x).toBeGreaterThan(REVEALED_X0)
      expect(x).toBeLessThan(REVEALED_X0 + REVEALED_W - 1)
      expect(y).toBeGreaterThan(REVEALED_Y0)
      expect(y).toBeLessThan(REVEALED_Y0 + REVEALED_H - 1)
    }
  })

  it('has a step action type the queue and step agree on', () => {
    const a: TickAction = { kind: 'place', a: 1, b: 2 }
    expect(a.kind).toBe('place')
  })
})

// ---------------------------------------------------------------------------
// 8b. onGameOver: the loop FOLLOWS the sim — M1e Task 8
// ---------------------------------------------------------------------------

/**
 * One tick short of the shutdown, poked directly rather than driven.
 *
 * `jamFixture`'s `state.destPins[0] = 255` idiom: the meter's arithmetic is
 * `overcrowd.test.ts`'s subject and driving 3,390 real ticks here would test it
 * a second time while testing the callback once. What matters to THIS file is
 * only that the flag flips inside `advance` and that the callback fires on that
 * edge and no other, so the fixture is placed at the edge.
 */
function oneTickFromShutdown(): Rig {
  const r = rig()
  expect(placeDestination(r.state, r.world, cellOf(8, 10), ORIENTATION_S, 0, DEST_KIND_SQUARE)).toBe(
    true,
  )
  r.state.destPins[0] = PIN_CAP_SQUARE_TIMER
  r.state.destOverTicks[0] = OVERCROWD_RAMP_FULL_TICKS
  r.state.destOvercrowd[0] = OVERCROWD_FAIL_MILLITICKS - DENOM
  return r
}

describe('the frame driver follows the sim into game over', () => {
  it('calls onGameOver exactly once, on the tick the flag first becomes true', () => {
    const r = oneTickFromShutdown()
    const fb = builderFor(r)
    let calls = 0
    const driver = driverFor(r, fb, undefined, () => {
      calls++
    })

    driver.advance(NO_ACTIONS)
    expect(isGameOver(r.state), 'vacuity: the fixture really was one tick away').toBe(true)
    expect(calls, 'once, on the edge').toBe(1)

    // Thirty frozen ticks. `step` is a no-op on every one of them, so a
    // callback fired per tick — rather than per EDGE — would reach 31 and the
    // shell would re-run whatever it does 31 times.
    for (let i = 0; i < 30; i++) driver.advance(NO_ACTIONS)
    expect(calls, 'exactly once, not once per frozen tick').toBe(1)
  })

  it('does not call it on a live run', () => {
    // The negative, with the fixture one pin BELOW the trigger so the meter
    // unwinds instead of filling — "nothing fired" then means the flag never
    // flipped, not that the board happened to be quiet.
    const r = oneTickFromShutdown()
    r.state.destPins[0] = PIN_CAP_SQUARE_TIMER - 1
    const fb = builderFor(r)
    let calls = 0
    const driver = driverFor(r, fb, undefined, () => {
      calls++
    })
    for (let i = 0; i < 50; i++) driver.advance(NO_ACTIONS)
    expect(isGameOver(r.state)).toBe(false)
    expect(calls).toBe(0)
  })

  it('reads the flag BEFORE the step, so a state that was already over fires nothing', () => {
    // The `wasOver` half of the guard, isolated. A driver built over an
    // already-terminal state — which is exactly what M3's restore will hand it
    // — must not announce a game over that happened in a previous session.
    const r = oneTickFromShutdown()
    const fb = builderFor(r)
    driverFor(r, fb).advance(NO_ACTIONS)
    expect(isGameOver(r.state)).toBe(true)

    let calls = 0
    const second = driverFor(r, fb, undefined, () => {
      calls++
    })
    second.advance(NO_ACTIONS)
    expect(calls, 'a fresh driver over an already-dead state announces nothing').toBe(0)
  })

  it('requires onGameOver in the TYPE, so a caller that forgets it does not compile', () => {
    // **The mutation this pins has no runtime detector, deliberately.** M2's
    // erase control took an OPTIONAL `createFallback` factory, so
    // `createEraseControl({ host })` compiled, reported `NONE`, and shipped a
    // build with no way to erase — that milestone's Critical, reinstated by one
    // omitted property with no compile error and no test failure. Making
    // `onGameOver` optional here would compile a `main.ts` whose loop keeps
    // draining behind a shutdown screen, and nothing at runtime would say so.
    //
    // `@ts-expect-error` is itself the assertion: it FAILS the typecheck if the
    // error stops occurring, which is the only direction that matters.
    const r = rig()
    const fb = builderFor(r)
    const deps = {
      state: r.state,
      world: r.world,
      fields: r.fields,
      scratch: r.scratch,
      builder: fb,
      camera: () => r.camera,
      draw: (): void => {},
    }
    // @ts-expect-error onGameOver is REQUIRED — see the comment above.
    const driver = createFrameDriver(deps)
    // Vacuity for the `@ts-expect-error`: adding the property must make the
    // very same object legal, or the directive could be suppressing a
    // completely different error and still read as this guard.
    //
    // **BOTH required properties, and that is what keeps this arm honest.**
    // M1f Task 7 made `onOfferRaised` required too, and M1f Task 8 made
    // `peeking` required, so `{ ...deps, onGameOver }` alone is now ALSO a type
    // error — the directive above would still be "used" and this line would
    // silently stop being a vacuity check. Sections 8c and 8d pin the other two
    // separately.
    const ok = createFrameDriver({
      ...deps,
      onGameOver: (): void => {},
      onOfferRaised: (): void => {},
      peeking: (): boolean => false,
    })
    expect(typeof driver.advance).toBe('function')
    expect(typeof ok.advance).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// 8c. onOfferRaised: the CONDITION, not the edge — M1f Task 7
// ---------------------------------------------------------------------------

/**
 * The pause behind §5.10's modal, at the driver.
 *
 * **The contrast with 8b is the whole content of this section.** `onGameOver`
 * is terminal and must announce ONCE, so `advance` reads `wasOver` before the
 * step. An offer is recurring and self-healing, so `advance` fires whenever
 * `offerPending(state)` holds AFTER the step — which means any path that
 * unpauses with an offer still up (the HUD clock tap; a lost `choose-card`; a
 * future `setPaused` caller nobody has written yet) re-pauses on the next frame
 * that drains a tick. `setPaused(true)` is idempotent, so the repetition costs
 * one boolean read per tick and buys "a modal can never be left over a live
 * board".
 *
 * The fixture pokes `H_TICK` to one tick short of the boundary rather than
 * driving 4,499 real ticks, in `oneTickFromShutdown`'s idiom and for the same
 * reason: phase 1 recomputes `H_WEEK` from `H_TICK`, so the boundary is exact
 * and the 4,499 ticks would be testing `clock.ts` a second time.
 */
function oneTickFromTheBoundary(): Rig {
  const r = rig(true)
  r.state.header[H_TICK] = TICKS_PER_WEEK - 1
  return r
}

describe('the frame driver raises the offer pause on the CONDITION', () => {
  it('fires on EVERY tick an offer is pending, not once on the edge', () => {
    const r = oneTickFromTheBoundary()
    const fb = builderFor(r)
    let calls = 0
    const driver = driverFor(r, fb, undefined, undefined, () => {
      calls++
    })

    driver.advance(NO_ACTIONS)
    expect(r.state.header[H_TICK], 'the boundary tick itself').toBe(TICKS_PER_WEEK)
    expect(offerPending(r.state), 'the sim raised one').toBe(true)
    expect(calls, 'and the driver said so').toBe(1)

    driver.advance(NO_ACTIONS)
    driver.advance(NO_ACTIONS)
    // **An EDGE-fired callback scores 1 here.** That is mutant 1 in this task's
    // table, and this is its detector: the offer is still pending, so the shell
    // must still be being told.
    expect(calls, 'three ticks with an offer up, three notifications').toBe(3)
  })

  it('says nothing at all while no offer is pending', () => {
    const r = rig(true)
    const fb = builderFor(r)
    let calls = 0
    const driver = driverFor(r, fb, undefined, undefined, () => {
      calls++
    })
    for (let i = 0; i < 20; i++) driver.advance(NO_ACTIONS)
    expect(r.state.header[H_TICK]).toBe(20)
    expect(offerPending(r.state), 'week 0 — the first boundary is the START of week 1').toBe(false)
    expect(calls).toBe(0)
  })

  it('stops the moment the week is RESOLVED, through the real choose-card action', () => {
    // The production loop out of the pause: the player takes a card, `step`
    // applies it in phase 3, `H_OFFER_WEEK` catches up and the condition is
    // false on the next tick. Driven through `TickInputs` rather than by poking
    // `H_OFFER_WEEK`, so the path the shell actually uses is the path pinned.
    const r = oneTickFromTheBoundary()
    const fb = builderFor(r)
    let calls = 0
    const driver = driverFor(r, fb, undefined, undefined, () => {
      calls++
    })
    driver.advance(NO_ACTIONS)
    expect(calls).toBe(1)

    const card = r.state.header[H_OFFER_A] as number
    expect(card, 'the pool has two implemented cards, so a real one was raised').not.toBe(CARD_NONE)
    const tilesBefore = tilesLeft(r.state)
    driver.advance({ actions: [{ kind: 'choose-card', a: 0, b: card }] })

    expect(offerPending(r.state), 'the week is resolved').toBe(false)
    expect(calls, 'and the driver went quiet on the tick that resolved it').toBe(1)
    // The grant landed: 30 for CARD_ROAD_TILES (1), 20 for
    // CARD_JUNCTION_UPGRADE (7). Hand-carried off §5.10's table, NOT read back
    // through `cardTileGrant` — that is the formula under test.
    expect(tilesLeft(r.state) - tilesBefore, `card ${card}`).toBe(card === 1 ? 30 : 20)

    for (let i = 0; i < 10; i++) driver.advance(NO_ACTIONS)
    expect(calls, 'and stays quiet for the rest of the week').toBe(1)
  })

  it('requires onOfferRaised in the TYPE, so a caller that forgets it does not compile', () => {
    // **The same mutation, and the same absence of a runtime detector, as
    // `onGameOver` in 8b.** An OPTIONAL `onOfferRaised` compiles a `main.ts`
    // that draws §5.10's modal over a board that is still running: cars keep
    // moving behind it, the week keeps advancing under it, and the offer the
    // player is looking at is replaced while they read it. Nothing at runtime
    // would say so, which is exactly M2's optional `createFallback`.
    const r = rig()
    const fb = builderFor(r)
    const deps = {
      state: r.state,
      world: r.world,
      fields: r.fields,
      scratch: r.scratch,
      builder: fb,
      camera: () => r.camera,
      draw: (): void => {},
      onGameOver: (): void => {},
    }
    // @ts-expect-error onOfferRaised is REQUIRED — see the comment above.
    const driver = createFrameDriver(deps)
    // Vacuity, exactly as in 8b: the same object plus the one property must
    // compile, or the directive could be suppressing an unrelated error.
    const ok = createFrameDriver({
      ...deps,
      onOfferRaised: (): void => {},
      peeking: (): boolean => false,
    })
    expect(typeof driver.advance).toBe('function')
    expect(typeof ok.advance).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// 8d. peeking: the driver reads it every frame — M1f Task 8
// ---------------------------------------------------------------------------

describe('the driver reads the peek flag on every render, not once at construction', () => {
  it('folds whatever the dependency says NOW into RenderFrame.offerPeek', () => {
    // A function rather than a value, for `camera`'s reason: `main.ts` supplies
    // `() => pointer.peeking` and the pointer outlives no rebuild of the
    // driver, so a boolean captured at construction would freeze peek off for
    // the whole session and the control would do nothing visible.
    const r = rig(true)
    const fb = builderFor(r)
    let peeking = false
    const seen: boolean[] = []
    const driver = driverFor(
      r,
      fb,
      (f) => {
        seen.push(f.offerPeek)
      },
      undefined,
      undefined,
      () => peeking,
    )
    driver.render(0, true)
    peeking = true
    driver.render(0, true)
    peeking = false
    driver.render(0, true)
    expect(seen).toEqual([false, true, false])
  })

  it('requires peeking in the TYPE, so a caller that forgets it does not compile', () => {
    // **The same absence of a runtime detector as 8b and 8c.** An OPTIONAL
    // `peeking` compiles a `main.ts` in which the peek control is drawn, is
    // hit-tested, and refuses every other tap on its behalf — while showing the
    // player nothing at all, because the frame it feeds always reads `false`.
    // That is a control that does nothing, produced by omitting one property,
    // with no compile error and no test failure. M2's optional `createFallback`
    // is the precedent this project already paid for.
    const r = rig()
    const fb = builderFor(r)
    const deps = {
      state: r.state,
      world: r.world,
      fields: r.fields,
      scratch: r.scratch,
      builder: fb,
      camera: () => r.camera,
      draw: (): void => {},
      onGameOver: (): void => {},
      onOfferRaised: (): void => {},
    }
    // @ts-expect-error peeking is REQUIRED — see the comment above.
    const driver = createFrameDriver(deps)
    // Vacuity, exactly as in 8b and 8c: the same object plus the one property
    // must compile, or the directive could be suppressing an unrelated error.
    const ok = createFrameDriver({ ...deps, peeking: (): boolean => false })
    expect(typeof driver.advance).toBe('function')
    expect(typeof ok.advance).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// N. The reachability fold — M1f
// ---------------------------------------------------------------------------

/**
 * `destReachable`: whether a car can actually DRIVE to each destination.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS SECTION EXISTS FOR
 * ---------------------------------------------------------------------------
 *
 * M1e Task 9 painted a bay red when `roads[carpark] === 0`. The first person to
 * play the shipped build broke it inside a minute: *"the red dot turns black
 * when i start drawing a road from it and when i remove it turns red again."*
 * One tile on the bay, connected to nothing, and the game said the destination
 * was fine.
 *
 * The end-to-end reproduction — the recorded `fillRect` count, on the
 * production boot path — is in `integration.test.ts`. This section is the fold
 * itself, on hand-built boards, one case per branch.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIXTURE IS SHAPED THE WAY IT IS
 * ---------------------------------------------------------------------------
 *
 * Every case below uses **one colour-1 destination whose bay is at (17, 14)**
 * and **its own colour-1 house at (17, 18)**, the geometry the shipped city
 * actually has (`cityArms.ts`'s `D2_LINK` is this exact column). The interesting
 * failures all live in the four cells between them, which is what a player is
 * dragging through when the signal has to be right.
 *
 * **A wrong-colour house is planted on the same column** for the case that
 * separates "the bay is joined to a house" from "the bay is joined to a house
 * OF ITS OWN COLOUR" — without it, dropping the colour mask entirely is a
 * 0-detector edit.
 */
describe('the reachability fold', () => {
  /** The colour-1 destination's origin. Orientation E, so the bay is three cells east. */
  const D_ORIGIN = cellOf(14, 14)
  const BAY = cellOf(17, 14)
  /** The four cells between the bay and the house, in the order a finger crosses them. */
  const COL = [cellOf(17, 15), cellOf(17, 16), cellOf(17, 17)] as const
  const OWN_HOUSE = cellOf(17, 18)
  /** Same column, between bay and house: the colour-0 house that makes case C separable. */
  const WRONG_HOUSE = cellOf(17, 16)

  /** `1` iff a road of at least one cell joins `from` to `to` along the column. */
  function pave(r: Rig, cells: readonly number[]): void {
    for (let i = 0; i + 1 < cells.length; i++) {
      expect(
        placeRoad(r.state, r.world, cells[i] as number, cells[i + 1] as number),
        `road ${cells[i]} -> ${cells[i + 1]}`,
      ).toBe(true)
    }
  }

  /** The colour-1 destination alone, with no road and no house anywhere. */
  function destOnly(): Rig {
    const r = rig()
    expect(
      placeDestination(r.state, r.world, D_ORIGIN, ORIENTATION_E, 1, DEST_KIND_CIRCLE),
      'the fixture destination must actually be placeable',
    ).toBe(true)
    const frame = build(r, builderFor(r))
    expect(frame.destCarpark[0] as number, 'the bay is (17, 14)').toBe(BAY)
    return r
  }

  /** The destination plus its own colour-1 house at (17, 18), still with no road. */
  function destAndOwnHouse(): Rig {
    const r = destOnly()
    expect(placeHouse(r.state, r.world, OWN_HOUSE, 1), 'the own-colour house').toBe(true)
    return r
  }

  function reachableOf(r: Rig): readonly number[] {
    const frame = build(r, builderFor(r))
    return [...frame.destReachable].slice(0, frame.destCount)
  }

  it('A: a stub on the bay alone reaches nothing — the user’s report, at the fold', () => {
    // The whole bug in three lines. `roads[BAY] !== 0` is TRUE here and the
    // answer is still 0; the shipped predicate returned 1.
    const r = destAndOwnHouse()
    pave(r, [BAY, COL[0]])
    expect(r.state.roads[BAY] as number, 'the road bit really is on the bay').not.toBe(0)
    expect(reachableOf(r)).toEqual([0])
  })

  it('B: a dead-end corridor off the bay with no building on it reaches nothing', () => {
    // One cell short of the house. The stub case scaled up, and the case that
    // says the answer is not "is this bay on a road of length >= 2".
    const r = destAndOwnHouse()
    pave(r, [BAY, COL[0], COL[1], COL[2]])
    expect(reachableOf(r)).toEqual([0])
  })

  it('C: a corridor that reaches a house of the WRONG colour reaches nothing', () => {
    // The colour mask's only detector. Without it this board reads reachable,
    // and a colour-1 destination would go grey because a colour-0 house
    // happened to be on its road.
    const r = destAndOwnHouse()
    expect(placeHouse(r.state, r.world, WRONG_HOUSE, 0), 'the wrong-colour house').toBe(true)
    pave(r, [BAY, COL[0], WRONG_HOUSE])
    expect(r.state.roads[WRONG_HOUSE] as number, 'the road really does reach it').not.toBe(0)
    expect(reachableOf(r)).toEqual([0])
  })

  it('D: a corridor that stops one cell short of the house reaches nothing', () => {
    // **Verified against the sim, not only against this fold.** A house whose
    // own cell carries no road bit is unroutable: `neighbours` only follows road
    // bits, so `computeFlowField` never relaxes into it and `dist[houseCell]`
    // stays INF forever. Adjacency is not connection.
    const r = destAndOwnHouse()
    pave(r, [BAY, COL[0], COL[1], COL[2]])
    expect(r.state.roads[OWN_HOUSE] as number, 'the house cell itself is bare').toBe(0)
    expect(reachableOf(r)).toEqual([0])
  })

  it('E: a corridor that reaches the house cell INCLUSIVE is reachable', () => {
    // The control. Without it every case above is satisfied by "always 0".
    const r = destAndOwnHouse()
    pave(r, [BAY, COL[0], COL[1], COL[2], OWN_HOUSE])
    expect(reachableOf(r)).toEqual([1])
  })

  it('F: two disjoint components answer independently — one connected, one stubbed', () => {
    // The case the flow fields structurally cannot answer: `computeFlowField` is
    // multi-source over a whole colour's carparks, so two same-colour
    // destinations in different components read `dist < INF` in ONE field and
    // the merge erases which is which. Here the colours differ too, but the
    // shape is the point — the answer is per destination, from a per-component
    // label, not from a field.
    const r = destAndOwnHouse()
    const D0_ORIGIN = cellOf(14, 20)
    const D0_BAY = cellOf(17, 20)
    const D0_HOUSE = cellOf(17, 22)
    expect(
      placeDestination(r.state, r.world, D0_ORIGIN, ORIENTATION_E, 0, DEST_KIND_SQUARE),
      'the second destination',
    ).toBe(true)
    expect(placeHouse(r.state, r.world, D0_HOUSE, 0)).toBe(true)
    pave(r, [D0_BAY, cellOf(17, 21), D0_HOUSE])
    pave(r, [BAY, COL[0]])
    const frame = build(r, builderFor(r))
    expect(frame.destCarpark[1] as number).toBe(D0_BAY)
    // Order matters as much as the values: a fold that answered "some component
    // is connected" would give [1, 1], and one that answered "the last one
    // wins" would give [0, 0].
    expect([...frame.destReachable].slice(0, 2)).toEqual([0, 1])
  })

  it('G: erasing the stub leaves it unreachable, and erasing the LINK takes it back', () => {
    // The second half of the user's sentence — *"and when i remove it turns red
    // again"* — plus the direction that matters more: the signal is a predicate
    // recomputed every frame, not a latch. Both directions on one rig.
    const r = destAndOwnHouse()
    pave(r, [BAY, COL[0], COL[1], COL[2], OWN_HOUSE])
    expect(reachableOf(r)).toEqual([1])
    expect(eraseRoad(r.state, r.world, COL[1] as number, COL[2] as number)).toBe(true)
    expect(reachableOf(r), 'one segment out of the middle disconnects it').toEqual([0])
    pave(r, [COL[1], COL[2]])
    expect(reachableOf(r), 'and putting it back reconnects it').toEqual([1])
  })

  it('H: every bay the OLD predicate called red is still red — the fix only widens', () => {
    // `assembleSources` skips a destination whose carpark carries no road bit,
    // so a bare bay is never a field source and takes zero arrivals by
    // construction. The old predicate was therefore exact on its red arm and
    // wrong only on its grey one, and this asserts the implication rather than
    // describing it: over a board with every interesting shape on it, nothing
    // the old test called unreachable is called reachable now.
    const r = destAndOwnHouse()
    const D0_ORIGIN = cellOf(14, 20)
    expect(placeDestination(r.state, r.world, D0_ORIGIN, ORIENTATION_E, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeHouse(r.state, r.world, cellOf(17, 22), 0)).toBe(true)
    pave(r, [cellOf(17, 20), cellOf(17, 21), cellOf(17, 22)])
    pave(r, [BAY, COL[0]])
    const frame = build(r, builderFor(r))
    let bare = 0
    for (let d = 0; d < frame.destCount; d++) {
      const carpark = frame.destCarpark[d] as number
      const oldRed = carpark < 0 || (r.state.roads[carpark] as number) === 0
      if (oldRed) {
        bare++
        expect(frame.destReachable[d] as number, `destination ${d} was red and must stay red`).toBe(0)
      }
    }
    // Non-vacuous in BOTH directions, or "the implication holds" is a statement
    // about an empty set: this board has a bay the old test called red, and a
    // bay the old test called grey that the new one calls red.
    expect(bare, 'a bay the old predicate called red').toBe(0)
    expect(r.state.roads[BAY] as number, 'D0’s bay carries a road bit — old: grey').not.toBe(0)
    expect(frame.destReachable[0] as number, 'and the new predicate calls it red').toBe(0)
    expect(frame.destReachable[1] as number, 'while the genuinely connected one is grey').toBe(1)
  })

  it('answers 0 for a bay that is off the grid — a CHECKED 0-detector for the branch', () => {
    // `carparkCell` returns -1 for a footprint whose bay would fall off the
    // board. Placement never stores one — `canPlaceDestination` refuses it — so
    // this is the fail-closed arm, reached by asking the predicate directly.
    //
    // **Deleting `if (carpark < 0) return 0` leaves this green, measured, and
    // that is recorded here so nobody reads its survival as a coverage hole.**
    // Every read the function would then make at index -1 comes back
    // `undefined`: `roads[-1] === 0` is false, `label[-1] < 0` is false,
    // `compColour[undefined] & mask` is 0. The wrong answer and the right one
    // coincide *by an accident of typed-array indexing*, which is exactly why
    // the line stays — the agreement is not a property anyone decided. This
    // case pins the CONTRACT (the documented answer for a -1 bay), and no test
    // can pin the branch.
    const r = destAndOwnHouse()
    pave(r, [BAY, COL[0], COL[1], COL[2], OWN_HOUSE])
    const fb = builderFor(r)
    build(r, fb)
    expect(destinationIsReachable(r.state, fb.reach, -1, 1), 'no bay, nothing to drive to').toBe(0)
    // Non-vacuous: the same call with the real bay answers 1, so the -1 arm is
    // being taken rather than the whole function returning 0.
    expect(destinationIsReachable(r.state, fb.reach, BAY, 1)).toBe(1)
  })

  it('answers 0 for a bay with no road bit, exactly as assembleSources does', () => {
    // The arm the shipped predicate WAS, kept verbatim. A carpark with no road
    // bit is never a flow-field source, so the destination takes zero arrivals
    // however well connected the rest of the board is.
    const r = destAndOwnHouse()
    pave(r, [COL[0], COL[1], COL[2], OWN_HOUSE])
    expect(r.state.roads[BAY] as number, 'the bay is bare').toBe(0)
    expect(r.state.roads[COL[0]] as number, 'and the road it does not touch is not').not.toBe(0)
    expect(reachableOf(r)).toEqual([0])
  })

  it('still answers 0 for a bare bay a ONE-WAY bit has dragged into a component', () => {
    // **The case that gives the bare-bay arm its own detector.** On every board
    // `placeRoad` can produce, `roads[carpark] === 0` and `label[carpark] < 0`
    // say the same thing — bits are mirrored, so a cell reached across an edge
    // always carries one — and the case above therefore kills neither arm on
    // its own. Two independently sufficient guards, which is the shape where a
    // per-arm detector needs a board the production writer cannot make.
    //
    // Here the neighbour's N bit is written STRAIGHT into `state.roads` with no
    // mirror on the bay, exactly as `graph.test.ts`'s bounds cases do. The BFS
    // follows it and labels the bay; `roads[BAY]` is still 0.
    //
    // **The right answer is 0, and it is `assembleSources` that says so**:
    // `if (roadMask(state, carpark) === 0) continue` — the destination is never
    // a flow-field source, so it takes zero arrivals whatever the graph looks
    // like around it. The arm exists to agree with that line and this is the
    // board on which the agreement is visible.
    const r = destAndOwnHouse()
    pave(r, [COL[0], COL[1], COL[2], OWN_HOUSE])
    const fb = builderFor(r)
    expect([...build(r, fb).destReachable].slice(0, 1), 'vacuity: bare and unlabelled').toEqual([0])
    r.state.roads[COL[0] as number] = (r.state.roads[COL[0] as number] as number) | 1 // N, unmirrored
    expect(r.state.roads[BAY] as number, 'the bay still carries nothing').toBe(0)
    expect(labelRoadComponents(r.state, r.world, fb.reach), 'one component').toBe(1)
    expect(fb.reach.label[BAY] as number, 'and the one-way bit HAS labelled the bay').toBeGreaterThanOrEqual(0)
    expect([...build(r, fb).destReachable].slice(0, 1), 'a source assembleSources would skip').toEqual([0])
  })

  it('counts the components it labelled, so a bare cell is not one', () => {
    // The seed guard's only observable. `labelRoadComponents` starts a component
    // at a cell that carries a road bit and at no other, which is the same test
    // `assembleSources` applies to a carpark. Without it every one of the 960
    // cells on this board is its own single-cell component — the destination
    // answers happen to survive that, so the count is what pins the line.
    const r = destAndOwnHouse()
    pave(r, [BAY, COL[0], COL[1], COL[2], OWN_HOUSE])
    pave(r, [cellOf(5, 30), cellOf(5, 31)])
    const fb = builderFor(r)
    expect(labelRoadComponents(r.state, r.world, fb.reach), 'two roads, two components').toBe(2)
    expect(r.world.cells, 'and the board has far more cells than that').toBe(960)
  })

  it('clears each component’s colour mask, so last frame’s houses cannot answer this frame', () => {
    // `compColour` is scratch that survives between frames. Component 0 here is
    // the connected column on one frame and a lone stub on the next, and without
    // the per-component reset the stub inherits the colour bit the column left
    // behind — a stale grey bay that no road on the board justifies.
    const r = destAndOwnHouse()
    pave(r, [BAY, COL[0], COL[1], COL[2], OWN_HOUSE])
    const fb = builderFor(r)
    expect([...build(r, fb).destReachable].slice(0, 1)).toEqual([1])
    expect(eraseRoad(r.state, r.world, COL[0] as number, COL[1] as number)).toBe(true)
    expect(eraseRoad(r.state, r.world, COL[1] as number, COL[2] as number)).toBe(true)
    expect(eraseRoad(r.state, r.world, COL[2] as number, OWN_HOUSE)).toBe(true)
    // The SAME builder, so the same scratch: this is a staleness test and a
    // fresh builder would defeat it.
    expect([...build(r, fb).destReachable].slice(0, 1), 'the stub cannot inherit the column').toEqual([0])
  })

  it('drops a house colour too wide for the mask instead of aliasing it onto another', () => {
    // `houseColour` is a `Uint8Array`, so 32 is representable; `1 << 32` is `1`
    // in JavaScript, which is colour 0's bit. Without the width guard a
    // hand-written colour-32 house makes every colour-0 destination on its road
    // read reachable — the "an out-of-contract input must never brick the thing"
    // shape, pointed at a shift.
    const r = rig()
    expect(placeDestination(r.state, r.world, D_ORIGIN, ORIENTATION_E, 0, DEST_KIND_SQUARE)).toBe(true)
    expect(placeHouse(r.state, r.world, OWN_HOUSE, 0)).toBe(true)
    pave(r, [BAY, COL[0], COL[1], COL[2], OWN_HOUSE])
    const fb = builderFor(r)
    expect([...build(r, fb).destReachable].slice(0, 1), 'vacuity: colour 0 reaches it').toEqual([1])
    r.state.houseColour[0] = 32
    expect(
      [...build(r, fb).destReachable].slice(0, 1),
      'colour 32 is not colour 0 and must not answer for it',
    ).toEqual([0])
  })

  it('leaves the scratch a typed array under a house cell off the board', () => {
    // A hand-corrupted `houseCell` indexes `compColour[undefined]`, which is not
    // a canonical numeric index — so the write lands as an ORDINARY PROPERTY on
    // the typed array, changing its shape and deoptimising every later read.
    // The bounds guard is what stops that, and the property count is what sees
    // it: the reachability answers are unchanged either way, so an
    // outcome-keyed assertion would score zero here.
    const r = destAndOwnHouse()
    pave(r, [BAY, COL[0], COL[1], COL[2], OWN_HOUSE])
    const fb = builderFor(r)
    r.state.houseCell[0] = r.world.cells + 5
    build(r, fb)
    expect(
      Object.getOwnPropertyNames(fb.reach.compColour).length,
      'a stray property was added to compColour',
    ).toBe(r.world.cells)
  })

  it('is preallocated: every buffer is the same object frame after frame', () => {
    // The frame path allocates nothing, and a fold that re-allocated its label
    // array per frame would be ~4 kB a frame at 60 Hz. Identity is the cheap
    // structural check; `drawAllocation.test.ts` is the measured one.
    const r = destAndOwnHouse()
    const fb = builderFor(r)
    const a = build(r, fb)
    const b = build(r, fb)
    expect(b.destReachable).toBe(a.destReachable)
    expect(a.destReachable).toBeInstanceOf(Uint8Array)
    expect(a.destReachable.length, 'one slot per destination slot, like its seven siblings').toBe(
      r.state.destCell.length,
    )
    expect(fb.reach.label.length).toBe(r.world.cells)
    expect(fb.reach.queue.length).toBe(r.world.cells)
    expect(fb.reach.compColour.length).toBe(r.world.cells)
    expect(fb.reach.nbrCell.length, 'neighbours’ contract is 8').toBe(8)
    expect(fb.reach.nbrDir.length).toBe(8)
  })

  it('walks the same edges the router does, including the row seam', () => {
    // The traversal calls `sim`'s own `neighbours`, so it cannot disagree with
    // `computeFlowField` about what an edge is. The sharpest case is the row
    // seam: cell `y*w + (w-1)` and cell `(y+1)*w + 0` are adjacent in the
    // BUFFER and not on the BOARD, and a hand-rolled `ni = cur + DX[k]` walk
    // with no bounds test joins them.
    //
    // **The two bits are written straight into `state.roads`**, exactly as
    // `graph.test.ts`'s own bounds-guard cases do and for the same reason:
    // `placeRoad` validates adjacency through `dirBetween`, so it will never
    // create an east bit on the board's last column and the seam is
    // unreachable through the production writer. Without the direct write this
    // case exercises nothing and a hand-rolled walk passes it.
    const r = rig()
    const EAST_EDGE = cellOf(23, 32)
    const NEXT_ROW = cellOf(0, 33)
    expect(NEXT_ROW - EAST_EDGE, 'the two cells really are adjacent in the buffer').toBe(1)
    expect(
      placeDestination(r.state, r.world, cellOf(20, 32), ORIENTATION_E, 0, DEST_KIND_SQUARE),
      'a destination whose bay is the row’s last cell',
    ).toBe(true)
    const fb = builderFor(r)
    expect(build(r, fb).destCarpark[0] as number).toBe(EAST_EDGE)
    expect(placeHouse(r.state, r.world, NEXT_ROW, 0)).toBe(true)
    // E on the last column, W on the first column of the next row: a mirrored
    // pair that a bounds-blind walk reads as one component.
    r.state.roads[EAST_EDGE] = 1 << 2
    r.state.roads[NEXT_ROW] = 1 << 6
    expect([...build(r, fb).destReachable].slice(0, 1), 'the seam is not an edge').toEqual([0])
    // Non-vacuous: the same house one cell up — a REAL neighbour of the bay —
    // is reached, so the fold is walking bits at all rather than refusing this
    // board for some other reason.
    const REAL = cellOf(23, 31)
    r.state.houseCell[0] = REAL
    r.state.roads[EAST_EDGE] = (r.state.roads[EAST_EDGE] as number) | 1
    r.state.roads[REAL] = 1 << 4
    expect([...build(r, fb).destReachable].slice(0, 1), 'a real neighbour IS an edge').toEqual([1])
  })
})


// ---------------------------------------------------------------------------
// The card contract: `render` and `sim` agree, and `game` is the only package
// that can check — M1f Task 8
// ---------------------------------------------------------------------------

/**
 * `TerrainClass`'s idiom (section 1 of this file), applied to a second forced
 * duplication.
 *
 * `packages/render/package.json` declares **no dependencies at all**, so
 * `render/test` cannot import `CARD_ROAD_TILES` or `CARD_COUNT` — the import
 * would not resolve, and `render/test/boundary.test.ts` bans it anyway. And
 * `sim` cannot see `CARD_LABELS`, because nothing in `sim` may import `render`.
 * Neither side can assert this about itself; `game` imports both.
 */
describe('render and sim agree about cards, and game is the only package that can check', () => {
  it('has one label per card id', () => {
    expect(CARD_LABEL_COUNT).toBe(CARD_COUNT)
    // Non-vacuous: `CARD_COUNT` is one PAST the highest id, so the array is
    // id-indexed and index 0 is the never-drawn `CARD_NONE` row rather than the
    // first real card.
    expect(CARD_NONE).toBe(0)
    expect(CARD_LABELS[CARD_NONE], 'id 0 has a row and it is empty').toBe('')
    expect(CARD_LABELS[CARD_COUNT], 'and there is nothing past the end').toBeUndefined()
  })

  it('gives every card id a NON-EMPTY label except CARD_NONE', () => {
    // The failure this catches is an id added to `cards.ts` and not to
    // `CARD_LABELS`: the length check above would go red, but only if the array
    // were not padded. A padded array satisfies the length and draws a card
    // with no name.
    for (let id = 1; id < CARD_COUNT; id++) {
      expect(CARD_LABELS[id], `card ${id} has no label`).toBeTruthy()
    }
  })

  it('names the two offerable cards with the exact strings canvas.test.ts expects', () => {
    expect(CARD_LABELS[CARD_ROAD_TILES]).toBe('ROAD TILES')
    expect(CARD_LABELS[CARD_JUNCTION_UPGRADE]).toBe('JUNCTION UPGRADE')
    // The deferred light keeps its row, so the array stays id-indexed and the
    // deferral reads as an interlock rather than as a gap.
    expect(CARD_LABELS[CARD_TRAFFIC_LIGHTS]).toBe('TRAFFIC LIGHTS')
  })

  it('pins the bare integers render/test/canvas.test.ts hit-tests with', () => {
    // `canvas.test.ts` writes `const ROAD_TILES = 1` with a comment naming this
    // pin, because it cannot import the constant. If the ids are ever
    // renumbered, this is the line that says so — the render test would
    // otherwise keep passing against a card that no longer exists.
    expect(CARD_ROAD_TILES).toBe(1)
    expect(CARD_JUNCTION_UPGRADE).toBe(7)
    expect(CARD_COUNT, 'and the count canvas.test.ts asserts as a literal').toBe(8)
  })
})
