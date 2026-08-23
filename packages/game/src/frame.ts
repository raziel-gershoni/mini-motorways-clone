import { OVERCROWD_FULL_MILLITICKS, TERRAIN } from '@laneways/shared'
import {
  carparkCell,
  dayOfWeek,
  destMetaColour,
  destMetaKind,
  destMetaOrientation,
  failedDestination,
  isGameOver,
  neighbours,
  offerPending,
  offerSlot,
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
  drawCar,
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
  /** The reachability pass's scratch. Allocated once; see `ReachScratch`. */
  readonly reach: ReachScratch
}

/**
 * Every buffer the reachability fold touches, allocated once at boot.
 *
 * `Int32Array(cells)` x 3 plus 16 bytes of neighbour scratch — 11,536 B on the
 * 24x40 board, for the whole life of the run. Nothing here is resized and
 * nothing here is read across frames: `label` is refilled and `compColour` is
 * written before it is read, so the pass carries no state between frames and
 * cannot go stale.
 */
export interface ReachScratch {
  /** Per cell: the index of its road component, or -1. */
  readonly label: Int32Array
  /** The BFS frontier. Each cell is pushed at most once, so `cells` is exact. */
  readonly queue: Int32Array
  /** Per component: a bitmask of the house colours it contains. */
  readonly compColour: Int32Array
  /** `neighbours`' two out-parameters, sized 8 as its contract requires. */
  readonly nbrCell: Int32Array
  readonly nbrDir: Int8Array
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
    destOvercrowd: new Uint8Array(maxDest),
    destReachable: new Uint8Array(maxDest),
    carCount: 0,
    carXY: new Float32Array(slots * 2),
    carColour: new Uint8Array(slots),
    week: 0,
    day: 0,
    score: 0,
    tilesLeft: 0,
    paused: false,
    gameOver: false,
    failedDest: -1,
    offerPending: false,
    offerA: 0,
    offerB: 0,
  }
  return {
    frame,
    snapshots: createCarSnapshots(slots),
    reach: {
      label: new Int32Array(world.cells),
      queue: new Int32Array(world.cells),
      compColour: new Int32Array(world.cells),
      nbrCell: new Int32Array(8),
      nbrDir: new Int8Array(8),
    },
  }
}

/**
 * The widest house colour `compColour` can record. A colour outside `[0, 31]`
 * cannot be represented in an `Int32Array` bitmask, so `labelRoadComponents`
 * drops it — which is the right answer rather than a lossy one, because
 * `destMetaColour` masks a destination's colour to three bits, so no
 * destination can ever ask about a colour above 7.
 */
const MAX_MASKABLE_COLOUR = 31

/**
 * Labels every road component and records which house colours each one
 * contains. Returns the number of components found.
 *
 * ---------------------------------------------------------------------------
 * WHY A FLOOD FILL, AND WHY HERE
 * ---------------------------------------------------------------------------
 *
 * The question the bay's colour asks is *"can a car drive to this
 * destination"*, and **the flow fields cannot answer it.** `computeFlowField`
 * is multi-source over a whole colour's carparks, so two colour-`c`
 * destinations in different road components produce ONE field in which both
 * components read `dist < INF` — the merge erases which destination a cell can
 * reach. Worse, `assembleSources` only seeds destinations with `destPins > 0`,
 * and `FIRST_PIN_DELAY_TICKS` is 120: for the first four seconds of a
 * destination's life, which is exactly the window the signal exists for, the
 * field knows nothing about it at all.
 *
 * So the pass is computed here, from `state.roads`, `state.houseCell` and
 * `state.houseColour` — bytes `buildFrame` already has. **`sim` gains nothing
 * and no golden can move**: `hashState` is taken over the whole state buffer,
 * so a per-destination flag stored in `sim` would move the state golden for a
 * cosmetic signal.
 *
 * ---------------------------------------------------------------------------
 * IT WALKS `neighbours`, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * The traversal calls `sim`'s own `neighbours` rather than re-reading the bits,
 * so this pass and `computeFlowField` follow the same edges by construction —
 * including the row-seam guard, which a hand-rolled bit walk gets wrong on the
 * grid's right edge. A second implementation of the road graph is exactly the
 * "instrument that rebuilds a key the system already stores" this repo has been
 * bitten by.
 *
 * **It does NOT re-check `roads[ni] !== 0` on the far side of an edge, and that
 * is deliberate.** `neighbours` does not, on the mirrored-bit invariant
 * `placeRoad` owns, and `computeFlowField` relaxes into whatever `neighbours`
 * returns. Matching that exactly is what makes this pass agree with the router
 * on every state the sim can reach. On a hand-corrupted mask — a bit written
 * straight into `state.roads` with no mirror — the two can differ, and the
 * divergence is bounded to a colour, never to a crash: the seed loop below only
 * starts a component at a cell that carries a bit, so a bare cell reached
 * across a one-way bit joins the first component that finds it.
 *
 * ---------------------------------------------------------------------------
 * COST
 * ---------------------------------------------------------------------------
 *
 * Every cell is labelled at most once and pushed at most once, so the pass is
 * O(cells + edges) and allocates nothing.
 *
 * **Measured, on the rig it was measured on**, because a ratio taken through
 * vite-transformed ESM is not a ratio in a production bundle: vitest 3.2.7 /
 * Node 26 on an M-series Mac, `buildFrame` and this function timed in the same
 * process over the same board.
 *
 * | board | road cells | ns/call | vs `buildFrame` | of a 16.67 ms frame |
 * |---|---|---|---|---|
 * | the city at boot, no input | 0 | 693 | 0.011x | 0.004 % |
 * | the whole revealed rect paved, every legal segment (887 of them) | 270 | 74,261 | 0.540x | 0.45 % |
 *
 * The second row is the worst board a player can draw: `placeRoad` is the only
 * writer, so 14x22 cells with all their legal diagonals is the ceiling.
 *
 * **The ratio is inflated here and the inflation is NOT shared with the
 * denominator, which is why the table says which rig it came from.** This
 * function makes one cross-package call — `neighbours` — *per cell*, and under
 * vite those are live-binding getter reads; `buildFrame`'s own cross-package
 * calls are per DESTINATION, at most 16. So the transform penalises the
 * numerator ~60x harder than the denominator and the true production ratio is
 * far smaller than 0.540. An earlier hand-rolled measurement of this pass, with
 * the bit walk inlined instead of calling `neighbours`, came out about 12x
 * faster on a comparable board — consistent with that being the whole
 * difference. Inlining is the available optimisation and it costs the one
 * property that makes this pass trustworthy (see above), so it is not taken.
 *
 * There is no cache and no dirty flag, which is the same trade this file
 * already makes for the terrain fold and for the same reason. A key on
 * `state.header[H_TICK]` would halve the work at 60 Hz and zero it while
 * paused; it is declined because `H_TICK` is not monotonic across a `restore`,
 * and 0.45 % of a frame on the worst board a finger can draw does not buy a
 * staleness class of bug.
 */
export function labelRoadComponents(state: GameState, world: WorldData, reach: ReachScratch): number {
  const cells = world.cells
  const { label, queue, compColour, nbrCell, nbrDir } = reach
  label.fill(-1)

  let comps = 0
  for (let c = 0; c < cells; c++) {
    // A cell with no road bit is not a component seed. This is the same test
    // `assembleSources` applies to a carpark before making it a field source,
    // and dropping it here would make every bare cell on the board its own
    // one-cell component.
    if ((state.roads[c] as number) === 0) continue
    if ((label[c] as number) !== -1) continue
    const comp = comps
    comps++
    compColour[comp] = 0
    label[c] = comp
    let head = 0
    let tail = 0
    queue[tail] = c
    tail++
    while (head < tail) {
      const cur = queue[head] as number
      head++
      const n = neighbours(state, world, cur, nbrCell, nbrDir)
      for (let k = 0; k < n; k++) {
        const ni = nbrCell[k] as number
        if ((label[ni] as number) !== -1) continue
        label[ni] = comp
        queue[tail] = ni
        tail++
      }
    }
  }

  // Every house ORs its colour into its component. A house whose own cell
  // carries no road bit is in NO component, and that is not an approximation:
  // `computeFlowField` relaxes over road edges, so `dist[houseCell]` is `INF`
  // for such a house forever and `dispatch` can never send a car from it. A
  // road that stops one cell short of a house serves nobody.
  const houseCount = state.header[H_HOUSE_COUNT] as number
  for (let h = 0; h < houseCount; h++) {
    const cell = state.houseCell[h] as number
    if (cell < 0 || cell >= cells) continue
    const comp = label[cell] as number
    // A CHECKED equivalent mutant, like the two in `destinationIsReachable`:
    // `compColour[-1] |= bit` is a silently discarded out-of-range write on a
    // typed array, so deleting this line changes no answer. It stays because
    // the discard is the engine's decision and not this function's, and it
    // would stop being one the day `compColour` became a plain array.
    if (comp < 0) continue
    const colour = state.houseColour[h] as number
    if (colour > MAX_MASKABLE_COLOUR) continue
    compColour[comp] = (compColour[comp] as number) | (1 << colour)
  }
  return comps
}

/**
 * `1` iff a car can drive to the destination whose bay is `carpark` and whose
 * colour is `colour`, given a labelled board. `0` otherwise.
 *
 * Three ways to be unreachable, and each is its own statement because each is
 * its own editable line:
 *
 *  1. **No bay.** `carparkCell` returns -1 for a footprint whose bay would fall
 *     off the grid. Nothing can drive to a cell that is not on the board.
 *  2. **A bare bay.** `assembleSources` skips a destination whose carpark
 *     carries no road bit, so it is never a field source and takes zero
 *     arrivals. This is the arm the shipped predicate was, and it stays
 *     verbatim — the fix WIDENS the red arm and never narrows it.
 *  3. **A bay in a component with no house of this colour.** The new arm, and
 *     the user's bug: a stub on the bay sets the road bit and reaches nothing.
 *     `dispatch` reads `dist[houseCell]` and refuses `INF`, so a destination
 *     whose own colour has no house in its component takes zero arrivals for
 *     as long as that holds.
 *
 * **Two of those three arms are CHECKED equivalent mutants, and that is
 * recorded here so nobody reads their survival as a coverage hole.**
 *
 * - Deleting arm 1 changes no answer: every read at index -1 comes back
 *   `undefined`, so `roads[-1] === 0` is false, `label[-1] < 0` is false, and
 *   `compColour[undefined] & mask` is 0 — the same 0, reached by accident of
 *   typed-array indexing rather than by decision.
 * - Deleting the `comp < 0` arm changes no answer either, for the same reason:
 *   `compColour[-1]` is `undefined` and `undefined & mask` is 0.
 *
 * Arm 2 is NOT equivalent, and the board that separates it from `comp < 0` is
 * one `placeRoad` cannot make: a bit written straight into `state.roads` with
 * no mirror drags a BARE bay into a labelled component, so `label[carpark] >= 0`
 * while `roads[carpark] === 0`. `assembleSources` skips exactly that
 * destination, and this arm is what agrees with it. `frame.test.ts` builds that
 * board.
 */
export function destinationIsReachable(
  state: GameState,
  reach: ReachScratch,
  carpark: number,
  colour: number,
): number {
  if (carpark < 0) return 0
  if ((state.roads[carpark] as number) === 0) return 0
  const comp = reach.label[carpark] as number
  if (comp < 0) return 0
  return ((reach.compColour[comp] as number) & (1 << colour)) !== 0 ? 1 : 0
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

  // --- road components, before the buildings that ask about them ---
  //
  // Runs unconditionally, exactly like the terrain fold above and for the same
  // reason: a dirty flag would be cheaper and would carry a staleness bug
  // waiting for the first road the player draws.
  labelRoadComponents(state, world, builder.reach)

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
    const carpark = carparkCell(state.destCell[d] as number, orientation, world.w, world.h)
    frame.destCarpark[d] = carpark
    // The bay's colour, and the shutdown screen's first line. Folded from the
    // SAME `carpark` the renderer draws at, rather than recomputed, so the byte
    // and the rectangle cannot describe different cells.
    frame.destReachable[d] = destinationIsReachable(state, builder.reach, carpark, destMetaColour(meta))
    // §5.8's meter, folded to a byte for the ring. Against
    // OVERCROWD_FULL_MILLITICKS (90 s) and not OVERCROWD_FAIL_MILLITICKS
    // (88 s), which is what makes the spec's last two seconds a *hidden* grace:
    // the ring reads 249/255 at the instant the city dies and a player never
    // sees it close.
    //
    // Integer arithmetic is not required here — `game` is not `sim` — but it is
    // used anyway so the fold cannot introduce a value `render` has to round
    // differently on two engines. The meter's own ceiling is
    // `OVERCROWD_FAIL_MILLITICKS + DENOM - 1` = 2,640,999, so the product is at
    // most 673,454,745 and fits an Int32 with room to spare; the clamp below is
    // for a value only a retune or a restore could produce, and without it a
    // `Uint8Array` truncates modulo 256 and a doubly-full meter reads *almost
    // empty*.
    const scaled = (((state.destOvercrowd[d] as number) * 255) / OVERCROWD_FULL_MILLITICKS) | 0
    frame.destOvercrowd[d] = scaled > 255 ? 255 : scaled
  }
  frame.destCount = destCount

  // --- cars: slot-indexed snapshots in, dense array out ---
  const snapshots = builder.snapshots
  const slots = snapshots.slots
  let n = 0
  for (let i = 0; i < slots; i++) {
    if ((snapshots.currLive[i] as number) === 0) continue
    // `drawCar`, not `lerpCar`: the SMOOTHED pair, not the exact one. The two
    // agree except during the ~7 ticks after a car launches from a standstill,
    // and `resolve.ts` owns why they are allowed to differ and by how much.
    drawCar(snapshots, i, alpha, frame.carXY, n * 2)
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
  // Through `sim`'s own guards, not off the header. `H_FAILED_DEST` is
  // zero-initialised, so an unguarded read blames destination 0 on every live
  // frame of every run; `failedDestination` is the function that exists to stop
  // that and it returns -1 while the flag is clear.
  frame.gameOver = isGameOver(state)
  frame.failedDest = failedDestination(state)
  // §5.10's offer, and **through `sim`'s own guards for the same reason as the
  // two lines above**. `applyChooseCard` never clears `H_OFFER_A`/`H_OFFER_B`
  // — deliberately, so that `offerSlot`'s `pending ? slot : CARD_NONE` is the
  // single mechanism — so a fold that read the header directly would report
  // last week's card on every frame for the rest of the run, and the modal
  // that Task 8 draws off these three fields would be up over a live board.
  frame.offerPending = offerPending(state)
  frame.offerA = offerSlot(state, 0)
  frame.offerB = offerSlot(state, 1)

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
  /**
   * Called ONCE, on the tick `isGameOver(state)` first becomes true. `main.ts`
   * ends the loop from it.
   *
   * **Required, not optional, and the type says so.** M2's erase control took
   * an OPTIONAL `createFallback` factory, so `createEraseControl({ host })`
   * compiled, reported `NONE`, and left the player with no way to erase — a
   * Critical reinstated by an omission with no compile error and no test
   * failure. The same shape here compiles a `main.ts` whose loop keeps draining
   * behind a shutdown screen.
   *
   * **It is a FOLLOWER, not the authority.** `sim` decides: `step` is already a
   * byte-identical no-op past the failure, so a caller that ignored this would
   * compute exactly the same state. What it buys is that the loop stops burning
   * 30 steps a second on nothing, and that the shell gets an edge to react to.
   *
   * Fired on the EDGE, from a `wasOver` read taken before the step — so a
   * driver built over an already-terminal state (which is what M3's restore
   * hands it) announces nothing, and a frozen tick does not re-announce.
   */
  readonly onGameOver: () => void
  /**
   * Called on **every** tick §5.10's weekly offer is waiting to be taken.
   * `main.ts` pauses the loop from it — M1f Task 7.
   *
   * **Required, not optional, and the type says so**, for the same reason as
   * `onGameOver` above: an optional dependency here compiles a `main.ts` whose
   * modal is drawn over a running sim, with cars moving behind it and the week
   * advancing under it, and nothing at runtime says so. M2's optional
   * `createFallback` is the precedent this project already paid for.
   *
   * **On the CONDITION, not the EDGE, and the contrast with `onGameOver` is the
   * point.** Game over is terminal and must announce once. An offer is
   * recurring and self-healing: firing whenever it holds means any path that
   * unpauses with an offer still pending — the HUD-clock tap, a lost
   * `choose-card`, a `setPaused` caller nobody has written yet — re-pauses on
   * the next frame that drains a tick, so a modal can never be left standing
   * over a live board. `setPaused(true)` is already idempotent, so the
   * repetition costs one boolean read per tick.
   *
   * **`sim` gains nothing from this and must not.** The pause is a property of
   * the shell; a replay reaches the same bytes whether or not anybody stopped
   * to read a modal, which is what lets M3's Worker verify a run it never
   * rendered.
   *
   * ---------------------------------------------------------------------------
   * **THIS PAUSE IS LOAD-BEARING FOR A `sim` CORRECTNESS PROPERTY, AND `sim`
   * KNOWS NOTHING ABOUT IT. OWNER: THIS LINE.**
   * ---------------------------------------------------------------------------
   *
   * M1f Task 6 measured and pinned it (`sim/test/cards.test.ts`, *"arrives WITH
   * a later boundary"*): a `choose-card` that reaches `step` on a tick which is
   * ITSELF a later week boundary resolves the OLD pair and **burns the new
   * week's offer** — `applyChooseCard` writes `H_OFFER_WEEK = H_WEEK`, and
   * `H_WEEK` has already advanced in phase 1, so week N+1 is marked resolved by
   * a choice made about week N. A card the player never saw, silently lost.
   *
   * **It is unreachable today for exactly one reason, and the reason is this
   * callback.** The shell cannot cross a boundary with an offer up, because the
   * first tick of the offer stops the drain and nothing resumes it until the
   * week is resolved. `sim` has no notion of pause, so it cannot defend itself:
   * the guard is entirely here.
   *
   * **What ends it.** Anything that lets ticks run while an offer is pending —
   * a "keep playing behind the modal" decision, a resume that does not re-pause
   * (which is why this fires on the condition rather than the edge), a headless
   * driver of `step` that enqueues a `choose-card` late, or M3's Worker
   * replaying a log without this shell. A replay is the sharp one: the Worker
   * runs `step` from a log and has no loop at all, so the property holds there
   * only because the LOG cannot contain a late `choose-card` — and the log is
   * produced by a client that had this pause. State that before removing it.
   */
  readonly onOfferRaised: () => void
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
      // Read BEFORE the step, so the callback fires on the EDGE rather than on
      // the condition: `step` is a no-op on every tick after the first, so a
      // post-step `if (isGameOver(state))` would re-announce 30 times a second
      // for the rest of the session.
      const wasOver = isGameOver(state)
      step(state, world, fields, scratch, inputs)
      if (!wasOver && isGameOver(state)) deps.onGameOver()
      // **On the CONDITION, not the edge, and the contrast with the line above
      // is deliberate** — see `onOfferRaised`. One boolean read per tick, and
      // it is what stops any resume from stranding a modal over a live board.
      //
      // **The pause it raises does not stop THIS drain**, because `loop.ts`
      // reads `paused` once, above its `while`. Measured: a clamped 250 ms
      // frame runs all 7 of its ticks with the pause live from the first, so
      // the modal opens up to 6 ticks past the boundary on a catch-up frame and
      // 0 past it on the frames a foreground tab runs. That is invisible (the
      // frame renders once, after the drain), replay-safe (`sim` has no pause)
      // and idempotent-safe (`runOffer` rewrites the same pair on every tick of
      // an unresolved week), so it is accounted for rather than fixed —
      // re-checking inside the `while` would only defer the same ticks.
      // `loop.test.ts`'s *"a pause raised from INSIDE advance"* pins it.
      if (offerPending(state)) deps.onOfferRaised()
    },
    afterDrain(ticks: number): void {
      // `ticks` stopped being ignorable at the smoothing change: it is the
      // drawn chase's entire clock, and passing 1 instead would make a car's
      // acceleration depend on the display's frame rate — slower on a 120 Hz
      // phone than on a 30 Hz one, since both run 30 ticks a second but one
      // drains them in twice as many calls.
      snapshotCurr(builder.snapshots, state, world, ticks)
    },
    render(alpha: number, paused: boolean): void {
      deps.draw(buildFrame(builder, state, world, deps.camera(), alpha, paused))
    },
  }
}
