import { TERRAIN } from '@laneways/shared'
import {
  carparkCell,
  dayOfWeek,
  destMetaColour,
  destMetaKind,
  destMetaOrientation,
  step,
  tilesLeft,
  weekOfTick,
  H_DEST_COUNT,
  H_HOUSE_COUNT,
  H_SCORE,
  H_TICK,
  type FlowField,
  type GameState,
  type Scratch,
  type TickInputs,
  type WorldData,
} from '@laneways/sim'
import { TerrainClass, type Camera, type RenderFrame, type TerrainClassCode } from '@laneways/render'
import {
  createCarSnapshots,
  lerpCar,
  snapshotCurr,
  snapshotPrev,
  type CarSnapshots,
} from './resolve'
import type { LoopDriver } from './loop'

/**
 * Builds the one `RenderFrame` the renderer draws — plan Decision 3.
 *
 * Spec §4 says `render` "depends on nothing but its own interface types" while
 * also reading sim state. Those two clauses are compatible only for *bytes*,
 * and they stop being compatible the moment anything needs a *function*.
 * Interpolation needs `routeStep`, `edgeCost` and `OPPOSITE`; destinations need
 * `destMetaColour`, `destMetaKind`, `destMetaOrientation` and `carparkCell`;
 * terrain needs `TERRAIN`; the clock needs `weekOfTick` and `dayOfWeek`.
 * **Every one of those calls happens here**, and `render` receives numbers it
 * can draw without asking anything.
 *
 * ---------------------------------------------------------------------------
 * THE HUD OWNS NO CLOCK ARITHMETIC OF ITS OWN
 * ---------------------------------------------------------------------------
 *
 * `week` and `day` come from `sim`'s own `weekOfTick`/`dayOfWeek`. `clock.ts`
 * derives the day from position within the week precisely because
 * 4500 / 7 = 642.857... is not an integer, and a second float-permitted copy in
 * `game` would disagree at every day boundary — day 1 would start at tick 642
 * instead of 643 and drift six ticks a week from there. `shared`'s
 * `TICKS_PER_DAY` is deliberately 0 for the same reason, so the "divide by
 * TICKS_PER_DAY" mutation is not constructible here and, applied literally,
 * divides by zero to produce a constant day 0 — a crash-shaped mutant, not an
 * off-by-one.
 *
 * ---------------------------------------------------------------------------
 * THE FOLD AND THE UNPACK RUN EVERY FRAME, DELIBERATELY
 * ---------------------------------------------------------------------------
 *
 * 960 byte writes for the terrain fold and at most `maxDestinations` (16)
 * building unpacks, all allocation-free, and they cannot go stale. A dirty-flag
 * scheme would be cheaper and would carry a staleness bug waiting for the first
 * mid-run building change; the cost is not worth the class of defect.
 *
 * ---------------------------------------------------------------------------
 * LIVENESS IS A PREFIX, AND CARS ARE DENSE
 * ---------------------------------------------------------------------------
 *
 * **No region `render` reads carries a `-1` sentinel** (narrowed at M1d Task 2,
 * which gave `sim` its first one — `occupancy`, filled with `FREE = -1`; it is
 * cell-indexed, has no liveness prefix, and is not folded into `RenderFrame`).
 * Unused house/destination slots are those at index >=
 * `H_HOUSE_COUNT`/`H_DEST_COUNT`, and an unused car is
 * `PHASE_NONE` with `carCell = 0` — a real, in-bounds cell. So `render` gets
 * counts, and cars get the strongest form of it: `carXY` holds two floats per
 * LIVE car with `carCount` of them packed at the front, so a phantom is
 * unrepresentable at the boundary rather than merely undrawn.
 *
 * **Liveness comes from `snapshots.currLive`, not from `state.carPhase`.** They
 * agree whenever the snapshot is fresh, and the difference matters when it is
 * not: a car that became live after the last `snapshotCurr` has no resolved
 * position yet, and reading `carPhase` directly would draw it at whatever
 * `currXY` last held — grid cell (0, 0) for a never-written slot. Gating on the
 * snapshot makes a stale car *absent for at most one frame* instead of *drawn
 * in the wrong place*. It is also why `initCarSnapshots` is not optional: with
 * no snapshot at all, `carCount` is 0, and a run paused before its first tick
 * would show a city with no cars in it.
 */

/** `RenderFrame` with its `readonly` modifiers removed. Assignable to `RenderFrame`; never widened back. */
export type MutableRenderFrame = { -readonly [K in keyof RenderFrame]: RenderFrame[K] }

/**
 * The per-run frame state: one `RenderFrame` and one set of car snapshots, both
 * allocated once and rewritten in place forever after.
 */
export interface FrameBuilder {
  readonly frame: MutableRenderFrame
  readonly snapshots: CarSnapshots
}

/**
 * `game`'s fold of `world.terrain` and `state.cleared` into the single byte
 * `render` understands.
 *
 * `world.terrain` is never mutated; a tree destroyed by a road sets
 * `state.cleared[cell] = 1` (`roads.ts`'s `hasTree`). A renderer reading
 * `world.terrain` alone draws a tree under every road the player lays through a
 * forest, permanently.
 *
 * The `cleared` term is **guarded by the terrain code** rather than written as
 * "cleared implies land". `placeRoad` only ever sets `cleared` on a `TREE`
 * cell, so the two forms agree today — and the unguarded form would turn any
 * future writer of `cleared` into a river that silently becomes land. Stated
 * rather than left as an accident, since the guard's extra arm is currently
 * unreachable through the sim.
 *
 * An unrecognised terrain code folds to `LAND`, which is what `canvas.ts`
 * paints by default anyway; the alternative is a board painted in no colour at
 * all.
 */
export function terrainClassOf(terrain: number, cleared: number): TerrainClassCode {
  if (terrain === TERRAIN.TREE) return cleared === 1 ? TerrainClass.LAND : TerrainClass.TREE
  if (terrain === TERRAIN.WATER) return TerrainClass.WATER
  if (terrain === TERRAIN.MOUNTAIN) return TerrainClass.MOUNTAIN
  return TerrainClass.LAND
}

/**
 * Allocates every buffer the frame path will ever use. Call once, at boot,
 * after `seedStartingCity` — then call `initCarSnapshots` on
 * `builder.snapshots` before the first frame.
 */
export function createFrameBuilder(state: GameState, world: WorldData, camera: Camera): FrameBuilder {
  const maxDest = state.destCell.length
  const slots = state.carPhase.length
  const frame: MutableRenderFrame = {
    camera,
    gridW: world.w,
    // Raw views. `render` never writes them (spec §4's import ban plus review
    // is the guarantee; `readonly` on a typed-array property does not stop
    // element writes, and this plan does not claim it does).
    roads: state.roads,
    // The ghost layer, M1d Task 8. A raw view exactly like `roads`, and NOT a
    // per-frame fold: `sim` already stores the removed road bit per cell in the
    // shape `render` blits, so folding would be copying 960 bytes a frame to
    // produce the bytes we already have. `buildFrame` therefore never touches
    // this field, which is why it is assigned once, here.
    ghosts: state.ghostMask,
    terrainClass: new Uint8Array(world.cells),
    houseCount: 0,
    houseCell: state.houseCell,
    houseColour: state.houseColour,
    destCount: 0,
    destCell: state.destCell,
    destColour: new Uint8Array(maxDest),
    destKind: new Uint8Array(maxDest),
    destOrientation: new Uint8Array(maxDest),
    destPins: new Uint8Array(maxDest),
    destCarpark: new Int32Array(maxDest),
    carCount: 0,
    carXY: new Float32Array(slots * 2),
    carColour: new Uint8Array(slots),
    week: 0,
    day: 0,
    score: 0,
    tilesLeft: 0,
    paused: false,
  }
  return { frame, snapshots: createCarSnapshots(slots) }
}

/**
 * Rewrites the frame in place and returns it. Allocation-free.
 *
 * `alpha` is the loop's interpolation fraction, always in `[0, 1)`; `paused` is
 * the loop's own flag, passed down rather than read back (see `LoopDriver`).
 */
export function buildFrame(
  builder: FrameBuilder,
  state: GameState,
  world: WorldData,
  camera: Camera,
  alpha: number,
  paused: boolean,
): RenderFrame {
  const frame = builder.frame
  frame.camera = camera

  // --- terrain, every cell, every frame ---
  const cells = world.cells
  const terrainClass = frame.terrainClass
  for (let c = 0; c < cells; c++) {
    terrainClass[c] = terrainClassOf(world.terrain[c] as number, state.cleared[c] as number)
  }

  // --- buildings ---
  frame.houseCount = state.header[H_HOUSE_COUNT] as number
  const destCount = state.header[H_DEST_COUNT] as number
  for (let d = 0; d < destCount; d++) {
    const meta = state.destMeta[d] as number
    const orientation = destMetaOrientation(meta)
    frame.destColour[d] = destMetaColour(meta)
    frame.destKind[d] = destMetaKind(meta)
    frame.destOrientation[d] = orientation
    frame.destPins[d] = state.destPins[d] as number
    frame.destCarpark[d] = carparkCell(state.destCell[d] as number, orientation, world.w, world.h)
  }
  frame.destCount = destCount

  // --- cars: slot-indexed snapshots in, dense array out ---
  const snapshots = builder.snapshots
  const slots = snapshots.slots
  let n = 0
  for (let i = 0; i < slots; i++) {
    if ((snapshots.currLive[i] as number) === 0) continue
    lerpCar(snapshots, i, alpha, frame.carXY, n * 2)
    frame.carColour[n] = state.houseColour[state.carHome[i] as number] as number
    n++
  }
  frame.carCount = n

  // --- HUD ---
  const tick = state.header[H_TICK] as number
  frame.week = weekOfTick(tick)
  frame.day = dayOfWeek(tick)
  frame.score = state.header[H_SCORE] as number
  frame.tilesLeft = tilesLeft(state)
  frame.paused = paused

  return frame
}

/** Everything `createFrameDriver` needs. Held by reference; nothing is copied per frame. */
export interface FrameDriverDeps {
  readonly state: GameState
  readonly world: WorldData
  readonly fields: readonly FlowField[]
  readonly scratch: Scratch
  readonly builder: FrameBuilder
  /**
   * The current camera. A function rather than a value because `fitCamera` is
   * re-run on a stable viewport change (Decision 5) and the frame must pick the
   * new one up without the driver being rebuilt.
   */
  readonly camera: () => Camera
  /** Draws the built frame. `main.ts` passes `(f) => drawFrame(ctx, f, atlases, palette)`. */
  readonly draw: (frame: RenderFrame) => void
}

/**
 * The standard `LoopDriver`: snapshot, step, snapshot, build, draw.
 *
 * **This lives in production code rather than in `main.ts` or a test rig for
 * one reason: the ORDER of the two snapshots is the whole of Decision 2's
 * correctness, and an order that only exists inside a test harness has no
 * mutation target.** Moving `snapshotPrev` after `advance` collapses `prevXY`
 * onto `currXY` and makes every car's rendered position constant within a tick
 * — the interpolation silently becomes tick-quantised, at 30 Hz, on a 120 Hz
 * display, with every position still "correct" at the tick boundaries.
 *
 * `snapshotCurr` runs once per frame in `afterDrain`, not once per tick: only
 * the last step's result is interpolated toward, and resolving the
 * intermediates would be work nothing reads. **Moving it into `advance` is a
 * CHECKED 0-detector no-op** — the last call of a burst wins and writes the
 * same bytes — recorded in `cars.ts`'s idiom for exactly this shape so that a
 * future reader neither treats its survival as a coverage hole nor moves it for
 * tidiness. It is kept in `afterDrain` because that is where the work is
 * `O(slots)` rather than `O(slots x ticks)`.
 *
 * `snapshotPrev` DOES run per tick, because the last one before the final step
 * is the one the frame needs and hoisting it out of the loop would be a second
 * thing to keep in sync.
 *
 * The three closures below are created once, when the driver is built. Nothing
 * inside them allocates.
 */
export function createFrameDriver(deps: FrameDriverDeps): LoopDriver {
  const { state, world, fields, scratch, builder } = deps
  return {
    beforeStep(): void {
      snapshotPrev(builder.snapshots, state, world)
    },
    advance(inputs: TickInputs): void {
      step(state, world, fields, scratch, inputs)
    },
    afterDrain(): void {
      snapshotCurr(builder.snapshots, state, world)
    },
    render(alpha: number, paused: boolean): void {
      deps.draw(buildFrame(builder, state, world, deps.camera(), alpha, paused))
    },
  }
}
