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
    // M1e Task 1. All three are Int32 and all three append to the END of the
    // 4-byte tier, so the tier's cumulative length stays a multiple of 4 and
    // `computeLayout` inserts no pad byte. These are the LAST regions this
    // milestone adds: "Which goldens move, exactly" fixes the shape at 29
    // regions and 13,992 B for `firstCity`, and every task after this one
    // appends behaviour, never shape.
    //
    // **This is an insertion, not an append**, and the re-bless proof depends
    // on knowing it: `computeLayout` emits the 4-byte tier, then the 2-byte
    // tier, then the 1-byte tier, so these 148 B (on `firstCity`) sit in FRONT
    // of `carRouteLen` and shift every region after them. See
    // `m1eSplice.ts` in `test/`.
    //
    // Ticks until the next house-spawn attempt for each colour, counting DOWN
    // from `HOUSE_SPAWN_PERIOD_TICKS` (written by `createState`). Per COLOUR
    // and not per house: §5.9's interval is "between same-group house spawns".
    { name: 'houseSpawnTimer', ctor: Int32Array, len: groupCount },
    // The integrated overcrowd meter, in MILLI-TICKS (ticks x DENOM) — spec
    // §5.8. Int32 and not Uint8/Int16 by arithmetic, not by taste: the failure
    // threshold `OVERCROWD_FAIL_MILLITICKS` is 2,640,000 (M1e Task 3 declares
    // it; the derivation is the plan's §5.8 block), which no 8- or 16-bit slot
    // can hold, so a narrower meter could never reach the threshold and the
    // city could never die.
    { name: 'destOvercrowd', ctor: Int32Array, len: maxDestinations },
    // Consecutive ticks at or over the timer capacity, driving §5.8's
    // `s(t) = min(1, 0.02t)` ramp. SATURATES at `OVERCROWD_RAMP_FULL_TICKS`
    // (1,500, also M1e Task 3), so no width question can arise at any run
    // length — the same construction `carBlockedTicks` uses against
    // `MAX_BLOCKED_TICKS`.
    { name: 'destOverTicks', ctor: Int32Array, len: maxDestinations },
    // --- 2-byte-aligned tier: Int16 ---
    { name: 'carRouteLen', ctor: Int16Array, len: maxCars },
    { name: 'carRouteCursor', ctor: Int16Array, len: maxCars },
    // M1d Task 2, appended to the END of the Int16 tier so the tier's
    // cumulative length stays a multiple of 2 and `computeLayout` inserts no
    // pad byte. `occupancy` is `LANE_COUNT` slots per cell, addressed
    // `cell * 2 + lane` — the SECOND index arithmetic this codebase carries,
    // beside `index = y * w + x`, and the two must not be confused.
    { name: 'occupancy', ctor: Int16Array, len: cells * LANE_COUNT },
    // Declared here with the rest of the blocking buffer shape in M1d Task 2;
    // **Task 4 gave it its semantics and is its only writer** — increment on a
    // refused entry, saturate at `MAX_BLOCKED_TICKS`, reset to 0 on any grant
    // including the valve's own (`noteEntryRefused`/`noteEntryGranted`,
    // blocking.ts). The region's LENGTH and TYPE were fixed in Task 2, so
    // Task 4 added no region and moved no golden.
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
    // M1d Task 5, appended to the END of the Uint8 tier so no pad byte can be
    // inserted anywhere (a 1-byte tier is a multiple of every alignment below
    // it, and 13,828 is still a multiple of 4). These are the LAST two regions
    // this milestone adds: "Why exactly two re-blesses are true" fixes the
    // buffer shape at 26 regions and 13,828 B for `firstCity`, and every task
    // after this one appends behaviour, never shape.
    //
    // `ghostMask` is the road bit the erase REMOVED, not a boolean, and the
    // difference is load-bearing for the renderer: `canvas.ts` blits one atlas
    // tile per cell keyed by that cell's 8-bit mask and never blits mask 0 —
    // and a ghost cell is BY DEFINITION one whose live mask reached 0, so a
    // boolean could not be drawn at all (M1d Task 8 consumes this).
    { name: 'ghostMask', ctor: Uint8Array, len: cells },
    // The number of in-flight cars committed to this ghost cell, counted once
    // at erase time and only ever falling. It is the milestone's one genuine
    // new `Uint8Array` decrement path — Task 1d's standing obligation, by name
    // — so `roads.ts` guards the decrement with `assertGhostCommittedPositive`
    // rather than letting a `--` at 0 wrap to 255.
    { name: 'ghostCommitted', ctor: Uint8Array, len: cells },
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
 *
 * M1d Task 5 adds the last two, and BOTH are FIELD_IRRELEVANT for one shared
 * reason that is stronger than the occupancy argument above: **the ghost's
 * entire effect on routing is already carried by `roads`, which is already
 * FIELD_INPUT.** `eraseRoad` clears the live bit from `roads` exactly as it did
 * before — the bit MOVES to `ghostMask`, it is not duplicated — so the field's
 * view of the world is byte-for-byte what it would have been without either
 * region, `dist[ghostCell]` is INF from the erase tick onward, and no route
 * committed after the erase can contain the cell. Hashing `ghostMask` would
 * therefore rebuild every colour a second time for a change the `roads` hash
 * has already seen.
 *
 *   - ghostMask:      see above. It changes only on an erase or a place, both
 *                     of which move `roads` in the same call, so it carries no
 *                     information the hashed region does not. Dated: M1e, if
 *                     ghosts ever become traversable-but-costly rather than
 *                     un-routable — at which point they are an edge weight and
 *                     `edgeCost` would have to see them.
 *   - ghostCommitted: the same, and MORE so — it changes on car CROSSINGS, so
 *                     classifying it FIELD_INPUT would rebuild every colour on
 *                     nearly every tick a ghost exists, with byte-identical
 *                     output. That is the `H_TICK` failure and the occupancy
 *                     failure a third time. Dated: M1e, with occupancy.
 *
 * M1e Task 1 adds the last three, and all three are FIELD_IRRELEVANT:
 *
 *   - houseSpawnTimer: a per-colour countdown nothing in routing reads. It
 *                      moves every tick, so classifying it FIELD_INPUT is the
 *                      `H_TICK` failure a fourth time: rebuild every colour
 *                      every tick forever, silently, with correct answers.
 *                      Dated: never — a spawn cadence cannot become an edge
 *                      cost. (What the spawner eventually PLACES does reach
 *                      the field, through `destCell`/`destMeta`/`roads`, all
 *                      three already FIELD_INPUT — the cadence is not the
 *                      placement.)
 *   - destOvercrowd:   the failure meter. It moves on nearly every tick any
 *                      destination is over capacity, and no edge cost, source
 *                      set or `dir` read depends on it. Dated: never.
 *   - destOverTicks:   as above, and MORE so — it moves on every tick a
 *                      destination is over capacity. Dated: never.
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
  'houseSpawnTimer',
  'destOvercrowd',
  'destOverTicks',
  'carRouteLen',
  'carRouteCursor',
  'occupancy',
  'carBlockedTicks',
  'cleared',
  'houseColour',
  'destReserved',
  'carPhase',
  'carRoute',
  'ghostMask',
  'ghostCommitted',
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
