import {
  CARS_PER_HOUSE,
  DEST_SPAWN_PERIOD_TICKS,
  HOUSE_SPAWN_PERIOD_TICKS,
  type MapData,
} from '@laneways/shared'
import { seedFromString } from './rng'
import { hashBytes } from './hash'
import { computeLayout, type RegionCtor } from './layout'
import { assertWorldMatches, mapIdHash, type WorldData } from './world'

/**
 * The whole simulation lives in one ArrayBuffer.
 *
 * Layout, in declaration order: see `regionsFor` in `regions.ts` — this is
 * the complete M1c region list, frozen once there (design decision 5, M1b;
 * reasserted for M1c in "Why one re-bless is now true") so that every later
 * task in this milestone appends behaviour, never buffer shape.
 *
 * `regionsFor` moved to `regions.ts` in M1c and is now exported — the
 * FIELD_INPUT/FIELD_IRRELEVANT partition's union assertion needs to
 * enumerate every declared region name, which is impossible against a
 * module-private function (M1b's `regionsFor` had no export anywhere in
 * `packages/`). `state.ts` continues to own the named slot indices
 * (`H_TICK`, `MI_MAP`, ...) and `HEADER_LENGTH`/`MAP_IDENTITY_LENGTH`,
 * exactly as before; only the region-table builder itself moved.
 *
 * **`header` and `mapIdentity` are split, deliberately, as of M1c.** A
 * region can only be classified FIELD_INPUT or FIELD_IRRELEVANT as a whole.
 * `H_MAP`/`H_MAP_W`/`H_MAP_H` are written once in `createState` and never
 * again — a genuine field input, the closer of the 6x4-vs-4x6 collision
 * `fieldFor`'s cell-count guard cannot catch. `H_TICK` increments every
 * tick — hashing it as part of a field-input region would rebuild every
 * colour every tick forever, silently, with correct answers. No single
 * classification of one `header` region could be honest about both, so the
 * three map-identity slots move to their own fixed-size region,
 * `mapIdentity`, leaving `header` free to be classified FIELD_IRRELEVANT as
 * a whole.
 *
 * Fixed-size regions precede every variable-size region: `rng`,
 * `mapIdentity` and `header` have compile-time-constant lengths and come
 * first, so `mapIdentity` is always at a fixed offset and a mis-sized buffer
 * can never displace the identity slots `restore` checks before anything
 * else. `computeLayout` (layout.ts) derives offsets from the declared list,
 * padding each region to its own alignment and rounding the total up to the
 * widest region's alignment, and asserts rather than assumes.
 *
 * Header slots:
 *
 *   H_TICK           0  tick counter                                   M1a
 *   H_SCORE          1  score (tests only, retained per progress.md:21) M1a
 *   H_WEEK           2  week index                                     M1a
 *   H_TILES          3  road tile budget, seeded from map.startingTiles M1b
 *   H_HOUSE_COUNT    4  live house prefix length                       M1c
 *   H_DEST_COUNT     5  live destination prefix length                 M1c
 *   H_PINS_DROPPED   6  pins dropped: every same-colour dest capped     M1c
 *   H_ROUTES_REFUSED 7  dispatch route walks refused (too long/zero)   M1c
 *   H_EPOCH          8  tick-in-progress marker; see "Atomicity" below  M1c
 *   H_GAME_OVER      9  0 while live, 1 once a destination timer filled M1e
 *   H_FAILED_DEST   10  which destination that was; read via the guard    M1e
 *   H_DEST_SPAWN_TIMER   11  ticks to the next destination attempt        M1e
 *   H_SPAWN_COLOUR_CURSOR 12 round-robin colour cursor for spawning       M1e
 *
 * **The four M1e slots are declared in Task 1 and nothing reads them yet.**
 * Two of them are FUNCTIONALLY PAIRED and must not be read apart:
 * `H_FAILED_DEST` is only meaningful while `H_GAME_OVER` is 1, so
 * `failedDestination` below is the only correct reader — the slot is
 * zero-initialised and 0 is a real destination index.
 *
 * `H_TILES` stays in the mutable `header`, not `mapIdentity`: `placeRoad`/
 * `eraseRoad` write it, and it must not be a field input (M1e's upgrade
 * cards grant tiles with no road change, which would spuriously rebuild
 * every colour).
 *
 * mapIdentity slots:
 *
 *   MI_MAP    0  signed non-zero content hash of the map (id/w/h/terrain/
 *                startingTiles/maxHouses/maxDestinations/groupCount)
 *   MI_MAP_W  1  map width
 *   MI_MAP_H  2  map height
 *
 * There is deliberately no dirty-flag slot for the pathfinding fields —
 * design decision 3 (M1b) derives staleness from content instead, so
 * `restore` stays a pure read with nothing to invalidate.
 *
 * **Atomicity (M1c).** `step` bumps the tick, then runs phases that mutate
 * the buffer and that CAN throw (an unknown `TickAction.kind`, a rebuild that
 * overflows the entry pool, a non-ascending source list). A throw
 * mid-`step` can leave the buffer in a state no single engine would ever
 * produce from a clean tick boundary — replaying it further is how two
 * engines quietly diverge. `H_EPOCH` is the marker: `step` sets it to the
 * in-progress tick number at entry and clears it to 0 only on successful
 * exit. A non-zero `H_EPOCH` therefore means "a previous `step` on this
 * buffer threw before finishing," and both `step` and `restore` throw a
 * named error rather than proceed from it — the state is not resumable.
 *
 * `H_SCORE` is currently written only by tests, and is kept deliberately.
 * That is not inconsistent with dropping the `H_RNG_DRAWS` slot in the same
 * M1a review: a score is certain to exist and its slot costs four bytes,
 * whereas a draw counter was speculative — a guess at a debugging aid
 * nothing had asked for. Retain what the design already commits to; do not
 * retain what it merely might want.
 *
 * `hashState` reads the buffer as raw bytes, so the hash of a given logical
 * state is little-endian-dependent. Every realistic target — x86, ARM in its
 * normal configuration, and every WebAssembly and JavaScript engine — is
 * little-endian, so this is a statement of the assumption rather than a
 * limitation. If a big-endian replay host ever appeared, hashes would differ
 * while the simulation itself stayed identical.
 *
 * This module and `world.ts` import each other: `restore` here calls
 * `assertWorldMatches` (world.ts), and `assertWorldMatches`/`mapIdHash` read
 * `GameState`/`MI_MAP*` (here). THE INVARIANT THIS DEPENDS ON: neither module
 * may reference the other at module-evaluation time — only from inside a
 * function body, where the reference isn't resolved until the function is
 * actually called, by which point both modules have finished loading. Safe
 * today by construction, not by luck. The same invariant now also holds
 * between this module and `regions.ts` (below), for the same reason.
 */

export const H_TICK = 0
export const H_SCORE = 1
export const H_WEEK = 2
export const H_TILES = 3
export const H_HOUSE_COUNT = 4
export const H_DEST_COUNT = 5
export const H_PINS_DROPPED = 6
export const H_ROUTES_REFUSED = 7
export const H_EPOCH = 8
/** 0 while the run is live; 1 once a destination's overcrowd timer completed (spec §5.8). */
export const H_GAME_OVER = 9
/**
 * The destination whose timer completed. Meaningful ONLY when `H_GAME_OVER` is
 * 1, which is why every reader goes through `failedDestination` below rather
 * than reading the slot: zero-initialised, this names destination 0, and a
 * live run must not be able to answer "which destination killed you".
 */
export const H_FAILED_DEST = 10
/** Ticks until the next destination spawn attempt (spawn.ts). Initialised in `createState`. */
export const H_DEST_SPAWN_TIMER = 11
/** Round-robin cursor over colours for destination spawning (spawn.ts). */
export const H_SPAWN_COLOUR_CURSOR = 12
export const HEADER_LENGTH = 13

export const MI_MAP = 0
export const MI_MAP_W = 1
export const MI_MAP_H = 2
export const MAP_IDENTITY_LENGTH = 3

/**
 * Deferred import: `regions.ts` reads `HEADER_LENGTH`/`MAP_IDENTITY_LENGTH`
 * from this module. This import is used only inside function bodies below
 * (`stateBytesFor`, `viewsOver`), never at this module's own top level, so
 * the cross-module cycle documented above stays safe.
 */
import { regionsFor } from './regions'
/**
 * Deferred import, same rule: `blocking.ts` reads `GameState` from this module
 * (type-only) and this module reads `FREE`/`assertMaxCarsFitsOccupancy` from
 * there, used only inside `createState`'s body.
 */
import { FREE, assertMaxCarsFitsOccupancy } from './blocking'

/** Total buffer size for a given map. */
export function stateBytesFor(map: MapData): number {
  return computeLayout(regionsFor(map)).totalBytes
}

export interface GameState {
  readonly buffer: ArrayBuffer
  /**
   * One `Uint8Array` view over the WHOLE buffer, built once here alongside
   * every other region view — never per read. `hashFieldInputRegions`
   * (flowfield.ts) reads through this instead of constructing
   * `new Uint8Array(state.buffer, offset, length)` per FIELD_INPUT region
   * per call, which the review found allocating 5-30 objects/tick against
   * this milestone's "nothing allocates inside a tick" rule. Not one of
   * `regionsFor`'s declared regions — it is a raw whole-buffer alias, not a
   * region boundary — so it is deliberately absent from
   * `REGION_FIELD_NAMES` below.
   */
  readonly bytes: Uint8Array
  readonly rng: Uint32Array
  readonly mapIdentity: Int32Array
  readonly header: Int32Array
  readonly pinAccum: Int32Array
  readonly rotationCursor: Int32Array
  readonly houseCell: Int32Array
  readonly destCell: Int32Array
  readonly destSpawnTick: Int32Array
  readonly carHome: Int32Array
  readonly carCell: Int32Array
  readonly carProgress: Int32Array
  readonly carTargetDest: Int32Array
  /**
   * Ticks until the next house-spawn attempt for colour `c`, counting DOWN
   * from `HOUSE_SPAWN_PERIOD_TICKS` — M1e Task 1 declares the shape and the
   * initial value, Task 5 gives it its semantics. Per COLOUR, not per house:
   * §5.9's interval is "between same-group house spawns".
   */
  readonly houseSpawnTimer: Int32Array
  /**
   * The integrated overcrowd meter per destination, in MILLI-TICKS (spec
   * §5.8). Declared in M1e Task 1, written by Task 3. `Int32` because the
   * failure threshold is 2,640,000; `regions.ts` records why that is
   * arithmetic rather than taste.
   */
  readonly destOvercrowd: Int32Array
  /**
   * Consecutive ticks destination `d` has been at or over its timer capacity,
   * driving §5.8's ramp. Saturates, exactly as `carBlockedTicks` does.
   */
  readonly destOverTicks: Int32Array
  readonly carRouteLen: Int16Array
  readonly carRouteCursor: Int16Array
  /**
   * Per-(cell, lane) occupancy, `slot = cell * 2 + lane`, `FREE = -1` — M1d
   * Task 2. `blocking.ts` owns the slot arithmetic and the whole claim/release
   * protocol; this is only where the bytes live. **The one region `createState`
   * does not leave all-zero**, because a zero-filled occupancy region would
   * read as "car 0 occupies every lane of every cell".
   */
  readonly occupancy: Int16Array
  /**
   * Consecutive ticks car `i` has been refused entry — declared with the rest
   * of the blocking buffer shape in M1d Task 2, given its semantics by Task 4.
   * Buffer state and not `Scratch` state, and `Int16` and not `Uint8`; both
   * choices are load-bearing and `regions.ts` records why.
   */
  readonly carBlockedTicks: Int16Array
  readonly roads: Uint8Array
  readonly cleared: Uint8Array
  readonly houseColour: Uint8Array
  readonly destMeta: Uint8Array
  readonly destPins: Uint8Array
  readonly destReserved: Uint8Array
  readonly carPhase: Uint8Array
  readonly carRoute: Uint8Array
  /**
   * The road bit an erase removed from a cell whose live mask thereby reached
   * 0 while at least one car was still committed to it — spec §5.11's ghost
   * road, M1d Task 5. A BIT, not a boolean: the renderer blits one atlas tile
   * per 8-bit mask and never blits mask 0. `roads.ts` owns every write.
   */
  readonly ghostMask: Uint8Array
  /**
   * How many in-flight cars were committed to that ghost cell at erase time.
   * Only ever falls; reaching 0 clears both regions and pays the deferred
   * refund. The milestone's one new `Uint8Array` decrement path, guarded by
   * name (`assertGhostCommittedPositive`, roads.ts).
   */
  readonly ghostCommitted: Uint8Array
}

/** Every field of `GameState` besides `buffer`, in the exact order `regionsFor` declares them. */
const REGION_FIELD_NAMES = Object.freeze([
  'rng',
  'mapIdentity',
  'header',
  'pinAccum',
  'rotationCursor',
  'houseCell',
  'destCell',
  'destSpawnTick',
  'carHome',
  'carCell',
  'carProgress',
  'carTargetDest',
  'houseSpawnTimer',
  'destOvercrowd',
  'destOverTicks',
  'carRouteLen',
  'carRouteCursor',
  'occupancy',
  'carBlockedTicks',
  'roads',
  'cleared',
  'houseColour',
  'destMeta',
  'destPins',
  'destReserved',
  'carPhase',
  'carRoute',
  'ghostMask',
  'ghostCommitted',
] as const)

function viewsOver(buffer: ArrayBuffer, map: MapData): GameState {
  // Built by iterating the layout table, not by re-deriving offsets: every
  // view's byteOffset and length come from the entry `computeLayout` already
  // validated, so there is exactly one place that does the arithmetic.
  const views = new Map<string, InstanceType<RegionCtor>>()
  const { entries } = computeLayout(regionsFor(map))
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    views.set(e.name, new e.ctor(buffer, e.offset, e.len))
  }
  for (let i = 0; i < REGION_FIELD_NAMES.length; i++) {
    const name = REGION_FIELD_NAMES[i] as string
    if (!views.has(name)) {
      throw new Error(`state layout: no view constructed for region "${name}"`)
    }
  }
  const rng = views.get('rng')
  const mapIdentity = views.get('mapIdentity')
  const header = views.get('header')
  const pinAccum = views.get('pinAccum')
  const rotationCursor = views.get('rotationCursor')
  const houseCell = views.get('houseCell')
  const destCell = views.get('destCell')
  const destSpawnTick = views.get('destSpawnTick')
  const carHome = views.get('carHome')
  const carCell = views.get('carCell')
  const carProgress = views.get('carProgress')
  const carTargetDest = views.get('carTargetDest')
  const houseSpawnTimer = views.get('houseSpawnTimer')
  const destOvercrowd = views.get('destOvercrowd')
  const destOverTicks = views.get('destOverTicks')
  const carRouteLen = views.get('carRouteLen')
  const carRouteCursor = views.get('carRouteCursor')
  const occupancy = views.get('occupancy')
  const carBlockedTicks = views.get('carBlockedTicks')
  const roads = views.get('roads')
  const cleared = views.get('cleared')
  const houseColour = views.get('houseColour')
  const destMeta = views.get('destMeta')
  const destPins = views.get('destPins')
  const destReserved = views.get('destReserved')
  const carPhase = views.get('carPhase')
  const carRoute = views.get('carRoute')
  const ghostMask = views.get('ghostMask')
  const ghostCommitted = views.get('ghostCommitted')
  if (
    !(rng instanceof Uint32Array) ||
    !(mapIdentity instanceof Int32Array) ||
    !(header instanceof Int32Array) ||
    !(pinAccum instanceof Int32Array) ||
    !(rotationCursor instanceof Int32Array) ||
    !(houseCell instanceof Int32Array) ||
    !(destCell instanceof Int32Array) ||
    !(destSpawnTick instanceof Int32Array) ||
    !(carHome instanceof Int32Array) ||
    !(carCell instanceof Int32Array) ||
    !(carProgress instanceof Int32Array) ||
    !(carTargetDest instanceof Int32Array) ||
    !(houseSpawnTimer instanceof Int32Array) ||
    !(destOvercrowd instanceof Int32Array) ||
    !(destOverTicks instanceof Int32Array) ||
    !(carRouteLen instanceof Int16Array) ||
    !(carRouteCursor instanceof Int16Array) ||
    !(occupancy instanceof Int16Array) ||
    !(carBlockedTicks instanceof Int16Array) ||
    !(roads instanceof Uint8Array) ||
    !(cleared instanceof Uint8Array) ||
    !(houseColour instanceof Uint8Array) ||
    !(destMeta instanceof Uint8Array) ||
    !(destPins instanceof Uint8Array) ||
    !(destReserved instanceof Uint8Array) ||
    !(carPhase instanceof Uint8Array) ||
    !(carRoute instanceof Uint8Array) ||
    !(ghostMask instanceof Uint8Array) ||
    !(ghostCommitted instanceof Uint8Array)
  ) {
    throw new Error('state layout: view construction did not produce the expected region types')
  }
  return {
    buffer,
    bytes: new Uint8Array(buffer),
    rng,
    mapIdentity,
    header,
    pinAccum,
    rotationCursor,
    houseCell,
    destCell,
    destSpawnTick,
    carHome,
    carCell,
    carProgress,
    carTargetDest,
    houseSpawnTimer,
    destOvercrowd,
    destOverTicks,
    carRouteLen,
    carRouteCursor,
    occupancy,
    carBlockedTicks,
    roads,
    cleared,
    houseColour,
    destMeta,
    destPins,
    destReserved,
    carPhase,
    carRoute,
    ghostMask,
    ghostCommitted,
  }
}

/**
 * Forces a hashed word away from zero, keeping every other value unchanged.
 *
 * @internal Exported for testing only; call `createState` or `mapIdHash` instead.
 *
 * Exposed as its own function — not left inlined at each call site — so the
 * zero path can be exercised directly. Hunting for a seed *string* (or map
 * content) that happens to hash to 0 would mean an unbounded,
 * non-deterministic search over a 2^32 output space; testing this pure
 * integer function instead is honest and exact.
 */
export function nonZeroWord(v: number): number {
  return v === 0 ? 1 : v
}

/**
 * A fresh `GameState` is all-zero in every region except `rng`,
 * `mapIdentity`, `header[H_TILES]`, `occupancy` (M1d Task 2) — and, as of M1e
 * Task 1, `header[H_DEST_SPAWN_TIMER]` and `houseSpawnTimer`.
 *
 * **The two M1e timers do not weaken the "byte-identical from-scratch" property
 * below**: both are unconditional writes of a compile-time constant, so two
 * fresh states of the same shape still agree byte for byte. What they do change
 * is that "a building-free state is all-zero outside three named places" is now
 * "outside five", and `state.test.ts` enumerates all five rather than letting
 * the list rot.
 *
 * **`occupancy` is the ONE region that carries a `-1` sentinel at creation**,
 * and it is not an exception to the liveness convention below: every LIVENESS
 * marker in this buffer is still a prefix count or a phase byte, never a `-1`.
 * Unused house/destination slots are simply those at index >=
 * `H_HOUSE_COUNT`/`H_DEST_COUNT` (both 0 here); unused cars are `PHASE_NONE =
 * 0`. `occupancy` holds `FREE = -1` because 0 is a valid CAR INDEX there, so a
 * zero-filled occupancy region would read as "car 0 occupies every lane of
 * every cell" and nothing on the board could move (`blocking.ts`, lifecycle
 * event 1).
 *
 * Every other region stays all-zero, which is what keeps "a building-free
 * state is byte-identical to a from-scratch state of the same shape" true —
 * the property every task's unchanged-goldens assertion depends on. The `-1`
 * fill is deterministic and unconditional, so two fresh states of the same
 * shape are still byte-identical to each other.
 */
export function createState(seed: string, map: MapData): GameState {
  // Before any view is built: `parseMap` puts no ceiling on `maxCars`, and an
  // `Int16` occupancy slot cannot name a car index above 32,767. `Int16Array`
  // coerces rather than throwing, so without this the failure is a slot holding
  // a negative number no lookup can ever match. Named, in the
  // `assertSingleCrossing`/`assertDispatchProgress` idiom.
  assertMaxCarsFitsOccupancy(CARS_PER_HOUSE * map.maxHouses)
  const s = viewsOver(new ArrayBuffer(stateBytesFor(map)), map)
  // Seed can hash to 0; mulberry32 tolerates it, but a zero here is also the
  // value an uninitialised buffer would hold, so force it non-zero to keep
  // "seeded" and "blank" distinguishable in a dump.
  s.rng[0] = nonZeroWord(seedFromString(seed))
  s.mapIdentity[MI_MAP] = mapIdHash(map)
  s.mapIdentity[MI_MAP_W] = map.w
  s.mapIdentity[MI_MAP_H] = map.h
  s.header[H_TILES] = map.startingTiles
  // Lifecycle event 1 (blocking.ts): a whole-region fill, never a prefix.
  s.occupancy.fill(FREE)
  // M1e Decision 9. A zero timer means "fire now", so without these the very
  // first tick of every run attempts a destination spawn and one house spawn
  // per colour. Written here beside `H_TILES` for the same reason: these are
  // the initial values of the declared shape, not behaviour.
  //
  // **Both writes land INSIDE the bytes this task inserts** — `H_DEST_SPAWN_TIMER`
  // is one of the four new header slots and `houseSpawnTimer` is one of the
  // three new regions — which is what makes the re-bless proof
  // (`test/m1eSplice.ts`) an exact byte splice with no correction term. See
  // Decision 9.
  s.header[H_DEST_SPAWN_TIMER] = DEST_SPAWN_PERIOD_TICKS
  s.houseSpawnTimer.fill(HOUSE_SPAWN_PERIOD_TICKS)
  return s
}

/** A detached byte copy. Mutating the source afterwards cannot affect it. */
export function snapshot(s: GameState): ArrayBuffer {
  return s.buffer.slice(0)
}

/**
 * Rebuilds views over a copy of `buffer`, so the restored state is
 * independent, then validates it against `world` in three steps:
 *
 *   1. Byte length, against `stateBytesFor(world.map)` — this must run
 *      first, because a wrong `w`/`h`/`maxHouses`/`maxDestinations`/
 *      `groupCount` changes the region lengths themselves, and a mis-sized
 *      buffer would displace `mapIdentity` before any of its fields could be
 *      compared at all.
 *   2. `assertWorldMatches`, which compares `MI_MAP`, `MI_MAP_W` and
 *      `MI_MAP_H` against `world` and throws naming the mismatched slot and
 *      both values. This is the check that catches a same-cell-count board
 *      swap (24x40 vs 40x24 vs 20x48) that step 1 cannot.
 *   3. `H_EPOCH`, which must be 0 — see "Atomicity" above. A non-zero epoch
 *      means the buffer was captured (or handed to `restore`) mid-`step`,
 *      after a throw that left it there; the state is not resumable.
 */
export function restore(buffer: ArrayBuffer, world: WorldData): GameState {
  const expected = stateBytesFor(world.map)
  if (buffer.byteLength !== expected) {
    throw new Error(
      `restore: map "${world.map.id}" expects ${expected} bytes, got ${buffer.byteLength}`,
    )
  }
  const s = viewsOver(buffer.slice(0), world.map)
  assertWorldMatches(s, world)
  if ((s.header[H_EPOCH] as number) !== 0) {
    throw new Error(
      `restore: state is poisoned (H_EPOCH=${s.header[H_EPOCH]}) — a previous step threw before ` +
        'clearing it, and this buffer is not resumable',
    )
  }
  return s
}

export function hashState(s: GameState): number {
  return hashBytes(s.bytes)
}

/**
 * True once a destination's overcrowd timer completed. `step` returns
 * immediately while it holds — M1e Task 8 wires that; **Task 1 declares the
 * slot and this reader and nothing calls either yet.**
 */
export function isGameOver(s: GameState): boolean {
  return (s.header[H_GAME_OVER] as number) !== 0
}

/**
 * The destination that ended the run, or -1 while it is live. Guarded rather
 * than exposed raw: `H_FAILED_DEST` is zero-initialised, so an unguarded read
 * during a live run names destination 0 with total confidence.
 */
export function failedDestination(s: GameState): number {
  return isGameOver(s) ? (s.header[H_FAILED_DEST] as number) : -1
}

/**
 * The house at live index `h`: `houseCell[h]`, valid only for `h` in
 * `[0, H_HOUSE_COUNT)`. Throws otherwise — no region carrying a BUILDING or CAR
 * slot uses a `-1` unused marker (narrowed at M1d Task 2, which added
 * `occupancy`'s `FREE = -1`; that region indexes cells, not slots, and has no
 * liveness prefix), so the live-prefix length (`H_HOUSE_COUNT`) is the ONLY
 * signal that distinguishes a real house from an unused, all-zero slot.
 * Reading past the
 * prefix without this accessor would silently return house 0's own cell
 * (index 0 reinterpreted) rather than an error.
 *
 * Returns the bare cell index, not an object: it is the one field every
 * caller across this milestone actually needs (a caller that already holds
 * a validated `h` reads `s.houseColour[h]` directly), and a later task may
 * call this once per house per tick (M1c Task 4's dispatch, Task 6's
 * arrivals) — an object literal here would be a per-tick allocation this
 * milestone's "nothing allocates inside a tick" rule forbids.
 *
 * Note for M1e: destination *removal* will need an explicit hole marker for
 * a slot in the middle of a live prefix that becomes invalid without
 * shifting every later index. This accessor and `destAt` below are the one
 * place that check must land, so M1e does not invent a second liveness
 * convention at some other call site.
 */
export function houseAt(s: GameState, h: number): number {
  const count = s.header[H_HOUSE_COUNT] as number
  if (!Number.isInteger(h) || h < 0 || h >= count) {
    throw new Error(`houseAt: index ${h} is not live (H_HOUSE_COUNT=${count})`)
  }
  return s.houseCell[h] as number
}

/**
 * The destination at live index `d`: `destCell[d]`, valid only for `d` in
 * `[0, H_DEST_COUNT)`. See `houseAt` above for why this throws instead of
 * using a sentinel, and why it returns a bare cell rather than an object.
 */
export function destAt(s: GameState, d: number): number {
  const count = s.header[H_DEST_COUNT] as number
  if (!Number.isInteger(d) || d < 0 || d >= count) {
    throw new Error(`destAt: index ${d} is not live (H_DEST_COUNT=${count})`)
  }
  return s.destCell[d] as number
}
