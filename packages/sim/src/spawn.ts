import {
  DEST_SPAWN_PERIOD_TICKS,
  DEST_SPAWN_RETRY_TICKS,
  HOUSES_PER_DESTINATION,
  HOUSE_NEIGHBOURHOOD_RADIUS,
  HOUSE_SPAWN_PERIOD_TICKS,
  HOUSE_SPAWN_RETRY_TICKS,
  REVEALED_H,
  REVEALED_W,
  REVEALED_X0,
  REVEALED_Y0,
  SPAWN_CANDIDATE_LIMIT,
} from '@laneways/shared'
import type { GameState } from './state'
import {
  H_DEST_COUNT,
  H_HOUSE_COUNT,
  H_SPAWN_COLOUR_CURSOR,
  H_TICK,
  H_WEEK,
  H_DEST_SPAWN_TIMER,
} from './state'
import type { WorldData } from './world'
import type { Scratch } from './scratch'
import {
  DEST_KIND_SQUARE,
  ORIENTATION_COUNT,
  carparkCell,
  destMetaColour,
  footprintHeight,
  footprintWidth,
  placeDestination,
  placeHouse,
} from './buildings'
import { pushBlockedSpawnDemand } from './demand'

/**
 * The spawn phase — phase 4 of the tick order. Houses and destinations appear
 * over time, inside the revealed rect, on an authored schedule (spec §5.9).
 *
 * **This module carries the codebase's THIRD index arithmetic and it must not
 * be confused with the other two.** `index = y * w + x` is the cell index;
 * `slot = cell * 2 + lane` is the occupancy slot; and `zoneIndex = zy *
 * spawnZoneW + zx` is a position inside the clipped revealed rect. This file
 * is the only place that converts between the first and the third, through
 * `spawnZoneCellAt`, and no other module may index the zone.
 *
 * ---------------------------------------------------------------------------
 * THIS SPAWNER IS NOT CONNECTIVITY-AWARE, AND THAT IS THE MILESTONE'S DOMINANT
 * FAILURE SHAPE — carried to M1f, recorded here because this is the code that
 * causes it
 * ---------------------------------------------------------------------------
 *
 * A building is placed on spacing and terrain alone. Nothing here asks whether
 * a road reaches it, and **a spawned destination's carpark is road-free by
 * construction** on any board the player has not just drawn to — so it is never
 * a flow-field source, takes zero arrivals, and its §5.8 meter only ever fills.
 * It killed three test fixtures during M1e and took two commits to find the
 * third.
 *
 * **What makes it a product problem rather than a fixture problem: a player
 * hits it the first time they do not connect a spawned building, and nothing in
 * the UI can explain it** — what they see is a building they never asked for
 * killing a city that looks fine. Task 9's shutdown copy is keyed to exactly
 * this (`NOTHING CAN REACH DESTINATION n`, chosen over `OVERCROWDED` precisely
 * because it is computable from the board rather than from run history — as of
 * M1f, from whether a house of the destination's colour is in the same road
 * component as its bay), which makes the ending legible but does not make the
 * danger visible while there is still time to act.
 *
 * **Design the ring and any future gate around UNREACHABILITY, not congestion.**
 * And note what the obvious fix costs: M1e's plan proposed tiering the spawn
 * scan by proximity to the spawning colour's own houses, and Task 10 measured
 * it across five seeds — it survives all twelve weeks **by making the board
 * inert** (peak `destPins` 1 in 65 of 65 week-observations, zero blocked ticks
 * in 63 of 65, four cars ever in motion) and was refused. Connectivity
 * awareness is not free; it is a difficulty change wearing a survivability
 * change's clothes. See `docs/superpowers/m1f-carry-forward.md` §9.
 *
 * **Why `sim` reads `REVEALED_*` at all.** Nothing may spawn where the player
 * cannot see it, and the rect is the only description of what is visible. The
 * import is legal (`sim` depends on `shared`) and it makes `constants.ts`'s
 * claim that "nothing in `sim` reads these" false — that comment moves in the
 * same commit. When board expansion lands (M1f) the rect becomes state and the
 * zone must move with it; this file is the one place that changes.
 *
 * **The rect is CLIPPED to the world, and the clipped zone may be empty.**
 * `determinism.test.ts` runs on a 4x4 map, which the rect misses entirely, and
 * Task 6's demand golden runs on a 20x9 one, which misses it on Y alone. Every
 * entry point therefore tests the cell count before any modulo: `% 0` is NaN,
 * and a NaN index into a typed array is a silent no-op.
 *
 * **`state.pinAccum.length` and `state.houseSpawnTimer.length` are two
 * spellings of ONE number.** `regions.ts` declares both with length
 * `map.groupCount`, so they are equal by declaration, not by coincidence.
 * `attemptDestinationSpawn` reads the first (it is walking colours to pick one)
 * and `runSpawn` reads the second (it is walking the timers it is about to
 * write); neither needs to justify itself at its own call site because of this
 * paragraph.
 *
 * **A destination spawn costs `groupCount` flow-field rebuilds, not one.** See
 * plan Decision 6: `destCell` and `destMeta` are both FIELD_INPUT and the
 * staleness stamp is one global byte hash, so placing any destination
 * invalidates every colour. Priced and accepted; counted in Task 12 Step 4.
 *
 * **Nothing here decrements `destPins` or `destReserved`** (plan Decision 12).
 * Both are `Uint8Array`, so an unguarded decrement at 0 wraps to 255 and
 * excludes that destination from dispatch forever. The only write this module
 * can reach on either region is `fireColour`'s `destPins[recipient] + 1`, via
 * `pushBlockedSpawnDemand`, and it is guarded by `hasRoom` — verified by
 * reading every path out of this file rather than assumed from the plan.
 */

export function spawnZoneW(w: number): number {
  const x1 = REVEALED_X0 + REVEALED_W < w ? REVEALED_X0 + REVEALED_W : w
  return x1 > REVEALED_X0 ? x1 - REVEALED_X0 : 0
}

export function spawnZoneH(h: number): number {
  const y1 = REVEALED_Y0 + REVEALED_H < h ? REVEALED_Y0 + REVEALED_H : h
  return y1 > REVEALED_Y0 ? y1 - REVEALED_Y0 : 0
}

export function spawnZoneCells(world: WorldData): number {
  return spawnZoneW(world.w) * spawnZoneH(world.h)
}

/**
 * The zone index -> cell conversion, and **the guard is in the signature rather
 * than in every caller.**
 *
 * `zoneIndex % 0` is `NaN`, and a `NaN` index into a typed array is a SILENT
 * no-op — the quietest failure available, and the reason every entry point in
 * this file tests the cell count first. Every in-repo caller does; this
 * function is EXPORTED, so the one that does not has not been written yet, and
 * "validate where the caller's mistake is made" (buildings.ts's
 * `assertColourInRange`) says the check belongs here. A throw costs one integer
 * compare on a path that runs at most `SPAWN_CANDIDATE_LIMIT` times per attempt.
 */
export function spawnZoneCellAt(zoneIndex: number, world: WorldData): number {
  const zw = spawnZoneW(world.w)
  if (zw <= 0) {
    throw new Error(
      `spawnZoneCellAt: the clipped spawn zone is empty on a ${world.w}x${world.h} board, so zone ` +
        `index ${zoneIndex} names no cell — callers must test spawnZoneCells(world) first`,
    )
  }
  const zx = zoneIndex % zw
  const zy = (zoneIndex / zw) | 0
  return (REVEALED_Y0 + zy) * world.w + (REVEALED_X0 + zx)
}

/**
 * The zone test in COORDINATES, which is the form the footprint check needs —
 * see `destinationFitsSpawnZone`. Private because a caller holding a cell index
 * should go through `inSpawnZone` and a caller holding coordinates should not
 * have to pack them into one first.
 */
function xyInSpawnZone(x: number, y: number, world: WorldData): boolean {
  return (
    x >= REVEALED_X0 &&
    x < REVEALED_X0 + spawnZoneW(world.w) &&
    y >= REVEALED_Y0 &&
    y < REVEALED_Y0 + spawnZoneH(world.h)
  )
}

export function inSpawnZone(cell: number, world: WorldData): boolean {
  return xyInSpawnZone(cell % world.w, (cell / world.w) | 0, world)
}

/**
 * Where this attempt starts scanning the zone.
 *
 * Reads the RNG word WITHOUT advancing it, deliberately. It must vary by seed
 * (or `RUN_SEED` means nothing and every run spawns identically) and by tick
 * (or the board fills from the top-left corner) — but a spawner that consumed
 * a draw on every failed attempt would couple every downstream draw to how
 * many times a spawn failed. That is still deterministic and it makes every
 * hand-computed fixture in the suite hostage to the spawner's failure count.
 *
 * The caller has already established `zoneCells > 0`.
 */
export function spawnScanStart(state: GameState, zoneCells: number): number {
  return (((state.rng[0] as number) >>> 0) + (state.header[H_TICK] as number)) % zoneCells
}

/**
 * Why a destination-spawn attempt did not place one. **The reason is in the
 * return value and not in a boolean**, because §5.3.5's redistribution fires on
 * exactly one of these and the first draft fired it on all of them.
 *
 * `SCAN_EXHAUSTED` and `BOARD_FULL` are the pair that matters. §5.3.5 says the
 * push happens "when no new destination can be placed ANYWHERE"; a
 * `SPAWN_CANDIDATE_LIMIT`-bounded window over a 308-cell zone missing is not
 * that, and treating it as that fires the redistribution at the 600-tick retry
 * cadence — 7.5 pushes a week against a schedule of `DESTINATIONS_PER_WEEK` = 2.
 */
export const SpawnOutcome = Object.freeze({
  /** A destination was placed. */
  PLACED: 1,
  /** No colour is both unlocked and already holding a house. */
  NO_ELIGIBLE_COLOUR: 2,
  /** The clipped revealed rect has no cells on this map. */
  ZONE_EMPTY: 3,
  /** The bounded scan window found nothing. The board may still have room elsewhere. */
  SCAN_EXHAUSTED: 4,
  /** Nothing will fit ANYWHERE: `H_DEST_COUNT` is at `maxDestinations`, or the scan covered the whole zone. */
  BOARD_FULL: 5,
} as const)
export type SpawnOutcomeCode = (typeof SpawnOutcome)[keyof typeof SpawnOutcome]

/** How many live houses carry `colour`. An indexed scan over the live prefix; allocation-free. */
export function houseCountOfColour(state: GameState, colour: number): number {
  const houseCount = state.header[H_HOUSE_COUNT] as number
  let n = 0
  for (let h = 0; h < houseCount; h++) if ((state.houseColour[h] as number) === colour) n++
  return n
}

/** How many live destinations carry `colour`. Reads the packed `destMeta` byte; allocation-free. */
export function destCountOfColour(state: GameState, colour: number): number {
  const destCount = state.header[H_DEST_COUNT] as number
  let n = 0
  for (let d = 0; d < destCount; d++) {
    if (destMetaColour(state.destMeta[d] as number) === colour) n++
  }
  return n
}

/**
 * A colour may receive buildings once the map has already seeded one for it, OR
 * once `H_WEEK` reaches its index [OURS].
 *
 * **The seeded clause is not a convenience.** `firstCity` seeds a colour-1
 * house and a colour-1 destination at tick 0 (`startingCity.ts`), so a pure
 * `week >= colour` rule says colour 1 does not exist for the first two and a
 * half minutes of a run in which the player can already see it and drive cars
 * to it. Making the rule read the board instead of only the clock is also what
 * makes it correct for any future map, rather than for this one.
 */
export function colourUnlocked(state: GameState, colour: number, week: number): boolean {
  if (week >= colour) return true
  return houseCountOfColour(state, colour) > 0 || destCountOfColour(state, colour) > 0
}

/**
 * True iff `cell` is within `HOUSE_NEIGHBOURHOOD_RADIUS` (Chebyshev) of an
 * existing house of the same colour — §5.9's neighbourhood rule. Allocation-free.
 */
function nearSameColourHouse(
  state: GameState,
  world: WorldData,
  cell: number,
  colour: number,
): boolean {
  const houseCount = state.header[H_HOUSE_COUNT] as number
  const cx = cell % world.w
  const cy = (cell / world.w) | 0
  for (let h = 0; h < houseCount; h++) {
    if ((state.houseColour[h] as number) !== colour) continue
    const other = state.houseCell[h] as number
    const dx = (other % world.w) - cx
    const dy = ((other / world.w) | 0) - cy
    const ax = dx < 0 ? -dx : dx
    const ay = dy < 0 ? -dy : dy
    const cheb = ax > ay ? ax : ay
    if (cheb <= HOUSE_NEIGHBOURHOOD_RADIUS) return true
  }
  return false
}

/**
 * One house-spawn attempt for `colour`. Returns whether a house was placed.
 *
 * **The founding exemption is load-bearing, not a convenience.** §5.9's "within
 * ~2 tiles of an existing same-colour house" cannot place the first one, and
 * the `HOUSES_PER_DESTINATION` cap refuses a colour with no destination —
 * while `attemptDestinationSpawn` refuses a colour with no house. Those three
 * rules together deadlock every colour that starts empty, which on `firstCity`
 * is colours 2, 3 and 4 out of 5. So a colour's FIRST house is exempt from both
 * the radius rule and the cap, and may go anywhere legal in the zone.
 *
 * **The `maxHouses` short-circuit is explicit, and it is a PURE OPTIMISATION
 * WITH NO DETECTOR — labelled as one so nobody deletes it on the strength of
 * its own survival.** On `demoCity` a colour holds 4 houses against 6
 * destinations, so `houses >= dests * HOUSES_PER_DESTINATION` is `4 >= 12` —
 * FALSE — and without this line every colour runs a full 24-cell scan every
 * retry period forever on a board that has been at `maxHouses` since tick 0,
 * failing only at `placeHouse`'s own capacity check 24 calls later. That is
 * 72 wasted `canPlaceHouse` calls per 60 ticks on the demo board — which held
 * the default until M1e Task 10 and is still one token away.
 *
 * **Deleting it scores 0 detectors, and the detector Task 5's brief predicted
 * CANNOT EXIST ANY MORE.** Measured twice: 0 over the 1,693-test suite when
 * Task 5 first ran it, and 0 again in M1e's closing sweep over the canonical
 * invocation at **1,843** — five packages green, the collection count unchanged
 * so the mutant ran, and no crash-screen match. The brief
 * named `demoAllocation.test.ts` as the only observer, via the bytes those
 * wasted calls would allocate — but M1e Task 4 made `canPlaceHouse`
 * allocation-free (every outcome is a frozen module-scope singleton), so the
 * wasted work now costs zero bytes and no allocation instrument, per-frame or
 * per-call, can see it. `placeHouse` refuses at capacity either way, so there
 * is no behavioural observable either. **This is the catalogue's "a mutation
 * that does not change behaviour reads like a survivor" — the line is real work
 * saved and the mutant is genuinely equivalent in every dimension a test can
 * read.** Do not add a production counter to give it one; do not delete it
 * because it survived.
 */
export function attemptHouseSpawn(state: GameState, world: WorldData, colour: number): boolean {
  const week = state.header[H_WEEK] as number
  if (!colourUnlocked(state, colour, week)) return false
  if ((state.header[H_HOUSE_COUNT] as number) >= world.map.maxHouses) return false
  const zoneCells = spawnZoneCells(world)
  if (zoneCells <= 0) return false
  const houses = houseCountOfColour(state, colour)
  if (houses > 0 && houses >= destCountOfColour(state, colour) * HOUSES_PER_DESTINATION) return false

  const start = spawnScanStart(state, zoneCells)
  const limit = SPAWN_CANDIDATE_LIMIT < zoneCells ? SPAWN_CANDIDATE_LIMIT : zoneCells
  for (let k = 0; k < limit; k++) {
    const cell = spawnZoneCellAt((start + k) % zoneCells, world)
    if (houses > 0 && !nearSameColourHouse(state, world, cell, colour)) continue
    if (placeHouse(state, world, cell, colour)) return true
  }
  return false
}

/**
 * All seven cells of a candidate destination lie inside the clipped zone.
 *
 * `canPlaceDestination` checks the GRID, which is not the same thing: a 3-wide
 * footprint whose origin is one cell inside the rect's right edge is legal
 * board state and half-invisible, and `canvas.ts` culls a building by its
 * ANCHOR cell, so the visible half would not be drawn either.
 *
 * **The far corner is tested in COORDINATES, and that is a deviation from the
 * task brief with a measurement behind it.** The brief wrote the far-corner
 * clause as `inSpawnZone(y1 * world.w + x1, world)` and put a
 * `x1 >= world.w || y1 >= world.h` guard in front of it, on the reasoning that
 * a right-edge origin's `x1` wraps into the next row and may land on a
 * perfectly legal in-zone cell. **That guard is a no-op and the wrap cannot
 * reach the zone**: `x1 <= x0 + 2`, and `x0 < world.w`, so a wrapped `x1 - w`
 * is 0 or 1 — always below `REVEALED_X0` = 5, so `inSpawnZone` refuses it
 * anyway. Checked exhaustively rather than argued, and **the sweep that says
 * so is the one that ships**: `spawn.test.ts` runs `w` in [6, 40] x `h` in
 * [10, 44] x every zone cell x both footprint shapes — **430,122 distinct
 * cases, reached twice each through the four orientations, so 860,244 checks
 * and 0 disagreements.** The test asserts that count exactly, so narrowing a
 * range fails rather than quietly shrinking the claim this comment makes.
 *
 * **Until M1e's closing sweep the two did not match**, and this is the
 * catalogue's *durable artefact that states more than the measurement* in its
 * cheapest form: the comment quoted 430,122 while the shipped tripwire swept
 * `w` in [6, 26] and `h` in [10, 34] step 3 — 46,284 distinct cases, a ninth of
 * it — and asserted only `checked > 20000`, which cannot notice a range
 * narrowing by any amount short of 78 %.
 *
 * **The wrap regime is `w <= 20` and nothing above it, which is the fact the
 * argument above actually turns on.** `x1 <= x0 + 2` and `x0 < w`, so `x1 >= w`
 * needs `w <= 20`; measured over the full sweep, the composed index wraps on
 * exactly the fifteen widths 6-20 and on no wider board. The old sweep did
 * cover all fifteen — the widths it missed, 27-40, are the ones where no wrap
 * can be constructed at all — so the tripwire was never blind to the regime,
 * only to the size of its own claim. The sweep counts the wraps it builds and
 * asserts there is at least one, because *"the two forms agree"* over a range
 * that constructs no wrap is a statement about nothing.
 *
 * So rather than keep a guard no test can distinguish from its own deletion,
 * this composes no index at all. The row-seam class is then *unconstructible*
 * here instead of *guarded*, which is the stronger of the two — and it stays
 * correct if `REVEALED_X0` ever drops to 1 or 0, which is exactly the change
 * that would make the brief's guard load-bearing and is exactly the change
 * nobody would think to re-check it against. `spawn.test.ts` pins the
 * equivalence and the board-subset property the argument rests on.
 *
 * @internal Exported for testing only — this is not part of the module's
 * public surface, on the precedent of `spacingViolated` (buildings.ts) and
 * `assertPlaceCost` (roads.ts). **Note what that convention does NOT buy**: the
 * brief had this function module-private, and a module-private function cannot
 * be imported by `spawn.test.ts`, which reaches into `../src/spawn` directly.
 * `index.ts` re-exports this module with `export *`, so exporting it for a test
 * also puts it on the PACKAGE surface — true of both siblings above as well.
 * The tag is a statement of intent to readers, not a boundary the build
 * enforces.
 */
export function destinationFitsSpawnZone(
  destCell: number,
  orientation: number,
  world: WorldData,
): boolean {
  const x0 = destCell % world.w
  const y0 = (destCell / world.w) | 0
  const carpark = carparkCell(destCell, orientation, world.w, world.h)
  if (carpark === -1) return false
  return (
    xyInSpawnZone(x0, y0, world) &&
    xyInSpawnZone(x0 + footprintWidth(orientation) - 1, y0 + footprintHeight(orientation) - 1, world) &&
    inSpawnZone(carpark, world)
  )
}

/**
 * One destination-spawn attempt.
 *
 * The colour is round-robin over eligible colours from `H_SPAWN_COLOUR_CURSOR`
 * — deterministic, balanced across colours, and no RNG draw. Eligible means
 * unlocked AND already holding at least one house: a destination whose colour
 * has no house accumulates pins no car can ever serve, which under Task 7 is a
 * guaranteed loss the player could not have prevented.
 *
 * **The cursor advances on FAILURE as well as on success**, which the first
 * draft did not do — it wrote the cursor inside `if (placeDestination(...))`.
 * Once a board saturates there is never another success, so the selection loop
 * returns the same colour forever and 100 % of §5.3.5's redistribution lands on
 * one frozen neighbourhood. Measured on the demo board: every pushed pin went
 * to colour 0. A failed attempt still consumed a turn.
 *
 * Every spawned destination is a `DEST_KIND_SQUARE`. The circle is §5.2's
 * in-place upgrade and M1f owns it — which matters more than it looks, because
 * a circle carries TWO rotation slots and a trigger cap of 8, so it is the only
 * mechanism in the spec that raises one destination's demand without adding a
 * destination (plan Decision 2).
 */
export function attemptDestinationSpawn(
  state: GameState,
  world: WorldData,
  scratch: Scratch,
): SpawnOutcomeCode {
  const groupCount = state.pinAccum.length
  const week = state.header[H_WEEK] as number
  const cursor = state.header[H_SPAWN_COLOUR_CURSOR] as number
  let colour = -1
  for (let k = 0; k < groupCount; k++) {
    const c = (cursor + k) % groupCount
    if (colourUnlocked(state, c, week) && houseCountOfColour(state, c) > 0) {
      colour = c
      break
    }
  }
  if (colour === -1) return SpawnOutcome.NO_ELIGIBLE_COLOUR

  // Advanced here, once, on EVERY attempt that chose a colour — before any
  // early return below can skip it.
  state.header[H_SPAWN_COLOUR_CURSOR] = (colour + 1) % groupCount

  const zoneCells = spawnZoneCells(world)
  if (zoneCells <= 0) return SpawnOutcome.ZONE_EMPTY
  if ((state.header[H_DEST_COUNT] as number) >= world.map.maxDestinations) {
    pushBlockedSpawnDemand(state, colour, scratch)
    return SpawnOutcome.BOARD_FULL
  }

  const start = spawnScanStart(state, zoneCells)
  const limit = SPAWN_CANDIDATE_LIMIT < zoneCells ? SPAWN_CANDIDATE_LIMIT : zoneCells
  for (let k = 0; k < limit; k++) {
    const zoneIndex = (start + k) % zoneCells
    const cell = spawnZoneCellAt(zoneIndex, world)
    for (let o = 0; o < ORIENTATION_COUNT; o++) {
      // Rotated by the zone index so the board does not fill with
      // north-facing carparks: the orientation decides which side the driveway
      // is on, which is most of whether a destination is servable at all.
      const orientation = (zoneIndex + o) % ORIENTATION_COUNT
      if (!destinationFitsSpawnZone(cell, orientation, world)) continue
      if (placeDestination(state, world, cell, orientation, colour, DEST_KIND_SQUARE)) {
        return SpawnOutcome.PLACED
      }
    }
  }
  // A full-zone scan that found nothing IS "nowhere on the board", so it counts
  // as full. A bounded one is not, and does not.
  if (limit >= zoneCells) {
    pushBlockedSpawnDemand(state, colour, scratch)
    return SpawnOutcome.BOARD_FULL
  }
  return SpawnOutcome.SCAN_EXHAUSTED
}

/**
 * Phase 4 of the tick order. Countdown timers, not last-spawn stamps: a
 * countdown resets to a different value on success and on failure, which is
 * exactly what §5.9's separate interval and retry constants describe.
 *
 * **A full board resets to the SCHEDULE, not to the retry.** §5.9's 20 s retry
 * is for "this attempt missed, try again soon"; a board at `maxDestinations` is
 * not going to become un-full in 20 seconds, and resetting to the retry there
 * makes §5.3.5's redistribution fire every 600 ticks — 7.5 pushes a week
 * against a schedule of two. One line, and the push rate then matches
 * `DESTINATIONS_PER_WEEK` by construction rather than by a second accumulator.
 *
 * **Position.** AFTER phase 3, because "nothing ever spawns on an existing road
 * tile" must see the road the player laid this tick — that is the entire basis
 * of spawn-blocking, which §5.9 calls a major skill expression that must not be
 * accidentally optimised away. BEFORE phase 5, so a destination placed on tick
 * T is inside `H_DEST_COUNT` for tick T's rotation. It reads `H_TICK`
 * (through `placeDestination`'s `destSpawnTick` stamp) and `H_WEEK` (colour
 * unlocks), so its position against phase 1 is an off-by-one with a detector.
 */
export function runSpawn(state: GameState, world: WorldData, scratch: Scratch): void {
  const dt = (state.header[H_DEST_SPAWN_TIMER] as number) - 1
  if (dt > 0) {
    state.header[H_DEST_SPAWN_TIMER] = dt
  } else {
    const outcome = attemptDestinationSpawn(state, world, scratch)
    state.header[H_DEST_SPAWN_TIMER] =
      outcome === SpawnOutcome.PLACED || outcome === SpawnOutcome.BOARD_FULL
        ? DEST_SPAWN_PERIOD_TICKS
        : DEST_SPAWN_RETRY_TICKS
  }
  const groupCount = state.houseSpawnTimer.length
  for (let c = 0; c < groupCount; c++) {
    const ht = (state.houseSpawnTimer[c] as number) - 1
    if (ht > 0) {
      state.houseSpawnTimer[c] = ht
      continue
    }
    state.houseSpawnTimer[c] = attemptHouseSpawn(state, world, c)
      ? HOUSE_SPAWN_PERIOD_TICKS
      : HOUSE_SPAWN_RETRY_TICKS
  }
}
