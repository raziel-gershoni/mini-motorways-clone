import { CARS_PER_HOUSE, MAX_PATH_LEN, type MapData } from '@laneways/shared'
import { computeLayout, type Region, type LayoutEntry } from './layout'
import { HEADER_LENGTH, MAP_IDENTITY_LENGTH } from './state'
import { LANE_COUNT } from './roads'

/**
 * The whole M1c buffer shape, declared once, and the FIELD_INPUT /
 * FIELD_IRRELEVANT partition over it — see the M1c plan's "The complete M1c
 * region list" and "Why one re-bless is now true".
 *
 * `regionsFor` moved here from `state.ts` (M1b) and is now exported: the
 * partition's union assertion needs to enumerate every declared region name,
 * which is impossible against a module-private function.
 *
 * `state.ts` and this module import each other (`regionsFor` here reads
 * `HEADER_LENGTH`/`MAP_IDENTITY_LENGTH` from `state.ts`; `state.ts` reads
 * `regionsFor` from here). Safe by the same invariant `state.ts`'s own module
 * comment documents for its cycle with `world.ts`: every cross-reference is
 * read inside a function body, never at module-evaluation time, so neither
 * module's top level ever observes the other mid-initialisation.
 *
 * **Descending-alignment declaration order buys zero padding** (asserted in
 * regions.test.ts): every `Int32`/`Uint32` region first, then every `Int16`
 * region, then every `Uint8` region. Since each tier's cumulative byte
 * length is already a multiple of that tier's own alignment, it is
 * automatically a multiple of every smaller alignment that follows — no pad
 * byte is ever inserted between regions, only (possibly) at the very tail.
 */
export function regionsFor(map: MapData): readonly Region[] {
  const cells = map.w * map.h
  const groupCount = map.groupCount
  const maxHouses = map.maxHouses
  const maxDestinations = map.maxDestinations
  const maxCars = CARS_PER_HOUSE * maxHouses
  const routeBytes = MAX_PATH_LEN / 2 // two 4-bit directions per byte

  return [
    // --- 4-byte-aligned tier: Uint32 / Int32, descending by declared concern ---
    { name: 'rng', ctor: Uint32Array, len: 1 },
    { name: 'mapIdentity', ctor: Int32Array, len: MAP_IDENTITY_LENGTH },
    { name: 'header', ctor: Int32Array, len: HEADER_LENGTH },
    { name: 'pinAccum', ctor: Int32Array, len: groupCount },
    { name: 'rotationCursor', ctor: Int32Array, len: groupCount },
    { name: 'houseCell', ctor: Int32Array, len: maxHouses },
    { name: 'destCell', ctor: Int32Array, len: maxDestinations },
    { name: 'destSpawnTick', ctor: Int32Array, len: maxDestinations },
    { name: 'carHome', ctor: Int32Array, len: maxCars },
    { name: 'carCell', ctor: Int32Array, len: maxCars },
    { name: 'carProgress', ctor: Int32Array, len: maxCars },
    { name: 'carTargetDest', ctor: Int32Array, len: maxCars },
    // --- 2-byte-aligned tier: Int16 ---
    { name: 'carRouteLen', ctor: Int16Array, len: maxCars },
    { name: 'carRouteCursor', ctor: Int16Array, len: maxCars },
    // M1d Task 2, appended to the END of the Int16 tier so the tier's
    // cumulative length stays a multiple of 2 and `computeLayout` inserts no
    // pad byte. `occupancy` is `LANE_COUNT` slots per cell, addressed
    // `cell * 2 + lane` — the SECOND index arithmetic this codebase carries,
    // beside `index = y * w + x`, and the two must not be confused.
    { name: 'occupancy', ctor: Int16Array, len: cells * LANE_COUNT },
    // Declared here with the rest of the blocking buffer shape; given its
    // semantics (increment on refusal, saturate, reset on entry) by M1d Task 4.
    // It is Int16 and NOT Uint8 deliberately: `MAX_BLOCKED_TICKS` is 1,350 and
    // 1,350 > 255, so a Uint8 counter could never reach the threshold and the
    // valve would simply never fire. It is buffer state and NOT `Scratch`
    // state, equally deliberately: `Scratch` is rebuilt every tick, so a
    // Scratch-resident counter would reset, the valve would fire in a browser
    // and never in a Worker replay — the exact divergence this product exists
    // to prevent.
    { name: 'carBlockedTicks', ctor: Int16Array, len: maxCars },
    // --- 1-byte-aligned tier: Uint8 ---
    { name: 'roads', ctor: Uint8Array, len: cells },
    { name: 'cleared', ctor: Uint8Array, len: cells },
    { name: 'houseColour', ctor: Uint8Array, len: maxHouses },
    { name: 'destMeta', ctor: Uint8Array, len: maxDestinations },
    { name: 'destPins', ctor: Uint8Array, len: maxDestinations },
    { name: 'destReserved', ctor: Uint8Array, len: maxDestinations },
    { name: 'carPhase', ctor: Uint8Array, len: maxCars },
    { name: 'carRoute', ctor: Uint8Array, len: maxCars * routeBytes },
  ]
}

/**
 * FIELD_INPUT: a region whose bytes can change what the next field build
 * produces, whether directly or by changing the assembled source set (see
 * the plan's exact partition semantics — a strict reading of
 * `computeFlowField`'s own inputs would give just `{roads, mapIdentity}`;
 * the destination regions are added as defence-in-depth, stated as such
 * rather than implied to be load-bearing on their own).
 *
 * One-line dated reason per region (M1c, 2026):
 *   - mapIdentity: folds w/h/terrain; closes the 6x4-vs-4x6 collision fieldFor's
 *     cell-COUNT guard cannot catch. Immutable after createState.
 *   - destCell:    determines the carpark cell, i.e. where the source is.
 *   - roads:       the graph itself.
 *   - destMeta:    orientation determines the carpark cell.
 *   - destPins:    decides which destinations seed sources.
 */
export const FIELD_INPUT_REGIONS = Object.freeze(['mapIdentity', 'destCell', 'roads', 'destMeta', 'destPins'] as const)

/**
 * FIELD_IRRELEVANT: everything else. One-line dated reason per region (M1c, 2026):
 *   - rng:            the pathfinder makes no random draws.
 *   - header:         H_TICK increments every tick; hashing it would rebuild
 *                      every colour every tick forever, silently, with
 *                      correct answers.
 *   - pinAccum:       reaches the field only by causing a destPins write,
 *                      which is itself classified.
 *   - rotationCursor: as above.
 *   - houseCell:      a house never seeds a source; it constrains where road
 *                      MAY be placed, and `roads` (hashed) records the outcome.
 *   - destSpawnTick:  rotation eligibility only.
 *   - carHome, carCell, carProgress, carTargetDest, carRouteLen,
 *     carRouteCursor, carPhase, carRoute: irrelevant while no edge cost
 *                      depends on occupancy (dated: M1e's demand-actuated
 *                      lights make car positions a field input).
 *   - cleared:        records destroyed trees; `neighbours` reads `roads`,
 *                      terrain lives in immutable `world`.
 *   - houseColour:    see houseCell.
 *   - destReserved:   never enters `sources` (decision 4) — the
 *                      classification the whole reservation design buys.
 *
 * M1d (2026) adds two, and BOTH are FIELD_IRRELEVANT. **This reads as a
 * contradiction with "occupancy is in `hashState`" until you know what the
 * partition is for, so:** the FIELD_INPUT / FIELD_IRRELEVANT partition is the
 * flow-field staleness key and NOTHING ELSE. It is not a statement about which
 * bytes matter for determinism — `hashState` is FNV over the WHOLE buffer
 * (`state.ts`) and `snapshot`/`restore` copy the whole buffer, so occupancy is
 * covered for determinism, replay and rollback whatever partition it is in. It
 * needs no help from the partition to survive a Worker cold start.
 *
 *   - occupancy:       irrelevant for the same dated reason every car region
 *                      carries, and it is literally the cell->car inverse of
 *                      `carCell`: no edge cost, source set or `dir` read
 *                      depends on it (`edgeCost` is pure length; routes are
 *                      committed once at dispatch and never re-pathed). Dated:
 *                      M1e's demand-actuated lights make car positions a field
 *                      input. **What classifying it FIELD_INPUT would cost,
 *                      measured:** occupancy changes on any tick any car
 *                      crosses a cell, so `syncFields` would run a full
 *                      960-cell Dijkstra for all five colours on nearly every
 *                      tick, forever, with BYTE-IDENTICAL output — 1.14 ms
 *                      (mid-density) to 1.91 ms (full grid) per rebuild x 5
 *                      colours = 5.7-9.6 ms/tick on a desktop core, multiples
 *                      worse on the phone M2 shipped to, and landing equally in
 *                      the Cloudflare Worker that verifies leaderboard scores.
 *                      Classifying the projection FIELD_INPUT while its source
 *                      (`carCell`) stays FIELD_IRRELEVANT would also be an
 *                      internal contradiction with the shipped layout.
 *   - carBlockedTicks: a per-car counter that gates M1d Task 4's valve. Nothing
 *                      in routing reads it, and it moves on any tick any car is
 *                      refused an entry — the same "rebuild every colour every
 *                      tick forever, silently, with correct answers" failure
 *                      `H_TICK` was split out of a hashed region to avoid.
 *                      Dated: M1e, with occupancy, if lights ever make waiting
 *                      cars a routing input.
 */
export const FIELD_IRRELEVANT_REGIONS = Object.freeze([
  'rng',
  'header',
  'pinAccum',
  'rotationCursor',
  'houseCell',
  'destSpawnTick',
  'carHome',
  'carCell',
  'carProgress',
  'carTargetDest',
  'carRouteLen',
  'carRouteCursor',
  'occupancy',
  'carBlockedTicks',
  'cleared',
  'houseColour',
  'destReserved',
  'carPhase',
  'carRoute',
] as const)

/**
 * Indexed linear scan over a frozen array, never a module-scope `Set`
 * (`determinism/no-module-mutable-state` would reject a `new Set(...)`
 * binding at module scope, and the array is short enough — 5 entries — that
 * a scan costs nothing next to the O(cells) hash it gates).
 */
export function isFieldInputRegion(name: string): boolean {
  for (let i = 0; i < FIELD_INPUT_REGIONS.length; i++) {
    if (FIELD_INPUT_REGIONS[i] === name) return true
  }
  return false
}

/** The mirror check, exposed so a test can assert non-overlap without re-deriving membership. */
export function isFieldIrrelevantRegion(name: string): boolean {
  for (let i = 0; i < FIELD_IRRELEVANT_REGIONS.length; i++) {
    if (FIELD_IRRELEVANT_REGIONS[i] === name) return true
  }
  return false
}

/**
 * `(byteOffset, byteLength)` pairs, one per FIELD_INPUT region, in layout
 * (declaration) order. Built ONCE, at boot, and stored on `Scratch`
 * (`createScratch`) — never inside a tick: `computeLayout(regionsFor(map))`
 * allocates roughly one object per region, and `hashFieldInputRegions` runs
 * once per `step`, so calling this there would allocate on every tick
 * against this milestone's "nothing allocates inside a tick" rule.
 *
 * Driven from the layout table with an indexed loop (`determinism/no-
 * collection-iteration` bans `for...of` over a `.entries()`/`.keys()`/
 * `.values()` call — an indexed loop over `entries` sidesteps the question
 * entirely and is what the plan asks for), so classification
 * (`FIELD_INPUT_REGIONS`) and the actual hashed byte ranges cannot diverge:
 * the alternative — a hand-written sequence of `hashBytes(s.roads)`,
 * `hashBytes(s.destPins)`, ... — lets a region be classified FIELD_INPUT and
 * then silently not hashed, which is exactly the failure this table-driven
 * form exists to make impossible.
 *
 * **The rationale above once had a sharp edge, closed on review:** the
 * function that CONSUMES this cache every tick, `hashFieldInputRegions`
 * (flowfield.ts), used to allocate a fresh `Uint8Array` per range per call
 * regardless of how cheaply this table itself was produced — undercutting
 * the very rule this comment cites. It now reads through `state.bytes`, one
 * persistent whole-buffer view built alongside every other region view, so
 * the boot-time cache and its one consumer are both allocation-free.
 */
export function createFieldInputRanges(map: MapData): Int32Array {
  const { entries } = computeLayout(regionsFor(map))
  const out: number[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as LayoutEntry
    if (isFieldInputRegion(e.name)) {
      out.push(e.offset, e.len * e.ctor.BYTES_PER_ELEMENT)
    }
  }
  return Int32Array.from(out)
}
