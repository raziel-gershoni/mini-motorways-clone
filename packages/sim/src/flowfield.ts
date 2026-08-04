import { hashInt32 } from './hash'
import { nonZeroWord, type GameState } from './state'
import type { WorldData } from './world'
import { neighbours, edgeCost } from './graph'
import { OPPOSITE } from './roads'
import { CT_REBUILDS, CT_SYNCS, INF, NB, ST_EXPANSIONS, ST_PUSHES, type FlowField, type Scratch } from './scratch'

/**
 * Multi-source Dijkstra over the *road graph* (never raw passable terrain —
 * see graph.ts's module comment for why that substitution is the one most
 * likely to be lost in a literal port of the M0 spike), using Dial's cyclic
 * bucket queue and an entry pool rather than a per-cell `next` pointer.
 *
 * **Why the entry pool, restated because it looks like needless
 * indirection:** a cell's distance can improve while it is still linked into
 * a higher bucket. A per-cell `next` pointer would be overwritten by the new
 * link, corrupting the old bucket's chain — some other node still points at
 * this cell, and draining that bucket walks into the wrong list. Allocating a
 * fresh entry per insertion and skipping stale entries on drain avoids it.
 *
 * `computeFlowField` allocates no arrays — every typed array it touches is
 * either `out` or `scratch`, both caller-provided; `createFlowField`/
 * `createScratch` (scratch.ts) are the only typed-array allocation points.
 * It does allocate one closure (the `push` arrow function) per call, which
 * the brief anticipates and which is harmless at the up-to-once-per-colour-
 * per-tick rate this runs at (design decision 3) — the claim here is about
 * the data buffers a hot pathfinding loop would actually churn through, not
 * about zero JS object creation of any kind.
 *
 * **The staleness check inside the drain loop (`dist[cur] !== d`) is a
 * performance guard, not a correctness one.** Pushes happen only on strict
 * improvement, so a stale entry always drains after the cell's final `dist`
 * was already applied, and every relaxation attempted from a stale entry
 * would fail `nd < dist[ni]` anyway — a reviewer verified bit-identical
 * `dist`/`dir` output across 400/400 random graphs with the check removed.
 * Bucket aliasing does not rescue a removal either, but the reason is
 * tighter than it looks and is worth stating exactly, because it is what
 * sizes `NB`. While bucket `d` is draining, every pending entry has a
 * distance in `[d, d + DIAG_COST]`: anything below `d` was drained already,
 * and every push made from distance `d` lands at `d + edgeCost <= d +
 * DIAG_COST`. That interval holds exactly `DIAG_COST + 1 = NB` distinct
 * values, so the `NB` cyclic buckets are exactly enough to give each of them
 * its own index and no two genuinely different pending distances can ever
 * collide.
 *
 * **`NB = DIAG_COST + 1` is therefore the exact minimum, with zero slack —
 * not a comfortable margin.** (An earlier version of this comment claimed
 * pending entries "differ by at most `DIAG_COST - ORTHO_COST` (4), never by
 * `NB` (15)". The 4 is the spread *before* the current bucket's own pushes
 * are made; instrumenting the queue over 200 seeded random graphs measures a
 * true maximum spread of 14, i.e. the full interval. Reading 4 as headroom
 * would be a 3.5x overestimate of room that does not exist.) See
 * `scratch.ts`'s penalty-routing note for what a future edge-cost change
 * must re-derive alongside `NB`.
 *
 * The check stays because it saves work (skipping a stale cell's whole
 * neighbour scan), and because `scratch.stats[ST_EXPANSIONS]` — which counts
 * only non-stale drains — makes its removal visible even though `dist`/`dir`
 * would not.
 */

/**
 * Fills `out` and `scratch` for the source slice `sourcesFlat[offset,
 * offset + count)`, replacing whatever either held before.
 *
 * **Widened for M1c (fix-list #6): sources are a preallocated `Int32Array`
 * slice, not a fresh `readonly number[]` per call.** Assembling a JS array
 * of sources every tick (once per colour, ~6/tick at 30 Hz) would be an
 * allocation this milestone's "nothing allocates inside a tick" rule
 * forbids; a caller-owned flat buffer plus `(offset, count)` costs nothing
 * to slice.
 *
 * **The reset is unconditional — dist/dir/bucketHead/pushesPerCell are fully
 * overwritten and stats zeroed before anything else runs, with no early
 * return for an empty source slice.** A natural `if (count === 0) return`
 * guard would leave `out` holding whatever the previous colour (or the
 * previous build of this same colour) last wrote, and design decision 3's
 * staleness detection depends on every rebuild actually producing this
 * colour's own, current answer — not silently reusing a stale one because
 * this particular call happened to have nothing to relax.
 *
 * **Source validity: a source is accepted iff it is in range AND carries at
 * least one road bit.** A pin sitting on a cell with no road is not a source
 * and gets no field entry — with all sources rejected, the field is
 * entirely `INF`/`-1`, which is the correct answer. (In M1c, pins sit on
 * destinations, which are exactly the cells that may have no road yet, so
 * M1c must seed sources from a destination's road-adjacent access cell, not
 * from the building cell itself.)
 *
 * **The source slice must be strictly ascending cell indices — throws
 * otherwise, including on a duplicate.** Source order silently decides
 * `dir` at ties while `dist` stays identical, so an unsorted (or
 * differently-ordered) source list would make browser and Worker agree on
 * `dist` but potentially disagree on `dir` — a divergence a `dist`-only
 * check would never catch. Canonicalising by throwing (rather than sorting
 * internally) keeps the decision of "what counts as the same source set"
 * out of this function and in whatever assembles `sourcesFlat` every tick.
 */
export function computeFlowField(
  state: GameState,
  world: WorldData,
  sourcesFlat: Int32Array,
  sourcesOffset: number,
  sourcesCount: number,
  out: FlowField,
  scratch: Scratch,
): void {
  const { cells } = world
  const { dist, dir } = out
  const { bucketHead, entryCell, entryNext, nbrCell, nbrDir, stats, pushesPerCell } = scratch

  dist.fill(INF)
  dir.fill(-1)
  bucketHead.fill(-1)
  pushesPerCell.fill(0)
  stats[ST_EXPANSIONS] = 0
  stats[ST_PUSHES] = 0

  for (let i = 1; i < sourcesCount; i++) {
    const prev = sourcesFlat[sourcesOffset + i - 1] as number
    const cur = sourcesFlat[sourcesOffset + i] as number
    if (cur <= prev) {
      throw new Error(
        `computeFlowField: sources must be strictly ascending cell indices; ` +
          `got ${prev} at index ${i - 1} followed by ${cur} at index ${i}`,
      )
    }
  }

  const cap = entryCell.length
  let top = 0
  let pending = 0

  // Pushes a (cell, d) entry into bucket `d % NB`. `push` throws on overflow
  // rather than writing out of range: an out-of-range typed-array write is a
  // silent no-op that would corrupt the pool's bucket chains (`entryCell[e]`
  // reads `undefined`, `entryNext[e]` reads 0), turning a capacity bug into a
  // silent wrong answer or an infinite drain loop instead of a stack trace.
  const push = (cell: number, d: number): void => {
    if (top >= cap) {
      throw new Error(`computeFlowField: entry pool exhausted (capacity ${cap})`)
    }
    const b = d % NB
    entryCell[top] = cell
    entryNext[top] = bucketHead[b] as number
    bucketHead[b] = top
    top++
    pending++
    stats[ST_PUSHES] = (stats[ST_PUSHES] as number) + 1
    pushesPerCell[cell] = (pushesPerCell[cell] as number) + 1
  }

  for (let i = 0; i < sourcesCount; i++) {
    const s = sourcesFlat[sourcesOffset + i] as number
    // `Number.isInteger(s)` is unreachable through this signature and kept
    // anyway — the same "cheap, independently correct, currently subsumed"
    // reasoning `hashSources`' length fold documents. `sourcesFlat` is
    // `Int32Array`, so ANY write into it — `arr[i] = 2.5` exactly as much as
    // `Int32Array.from([2.5])` — truncates to an integer via ToInt32 before
    // this line ever runs; M1b's `readonly number[]` signature could carry a
    // genuine fractional value this far, M1c's typed-array signature cannot.
    // The bounds half of this check (`s < 0 || s >= cells`) is very much
    // still reachable: a valid Int32 can be negative or exceed `cells`.
    if (!Number.isInteger(s) || s < 0 || s >= cells) {
      throw new Error(`computeFlowField: source ${s} is out of range for ${cells} cells`)
    }
    if ((state.roads[s] as number) === 0) continue // no road bit: not accepted, per source validity above
    dist[s] = 0
    push(s, 0)
  }

  for (let d = 0; pending > 0; d++) {
    const b = d % NB
    let e = bucketHead[b] as number
    bucketHead[b] = -1
    // `>= 0` rather than `!== -1`: if `e` ever became `undefined` (an
    // out-of-range read some future edit introduced), `!== -1` would be
    // true forever and spin; `>= 0` terminates on it for free instead of
    // turning a bug into a hang.
    while (e >= 0) {
      const cur = entryCell[e] as number
      e = entryNext[e] as number
      pending--
      if ((dist[cur] as number) !== d) continue // stale entry; see module comment — a performance guard, not a correctness one

      stats[ST_EXPANSIONS] = (stats[ST_EXPANSIONS] as number) + 1

      const n = neighbours(state, world, cur, nbrCell, nbrDir)
      for (let i = 0; i < n; i++) {
        const ni = nbrCell[i] as number
        const k = nbrDir[i] as number
        const nd = d + edgeCost(k)
        if (nd < (dist[ni] as number)) {
          dist[ni] = nd
          // Points back the way we came: `neighbours` returns the direction
          // FROM `cur` TO `ni`, so `ni`'s field must name the opposite
          // direction to walk back toward `cur` (and, transitively, the
          // source). `roads.ts`'s placement invariant guarantees the bit
          // this implies (`ni` carries a road toward `cur` in direction
          // OPPOSITE[k]) actually exists, since every road segment is
          // written mirrored on both endpoints.
          dir[ni] = OPPOSITE[k] as number
          push(ni, nd)
        }
      }
    }
  }
}

/**
 * `nonZeroWord` of an FNV chain over every FIELD_INPUT region's bytes, in
 * layout order — replaces M1b's `hashRoadRegion`.
 *
 * **Driven from the layout table (`ranges`, built once by
 * `createFieldInputRanges` and stored on `Scratch`), not a hand-written
 * sequence of `hashBytes(s.roads)`, `hashBytes(s.destPins)`, ...** — the
 * hand-written form lets a region be classified FIELD_INPUT
 * (`regions.ts`'s `FIELD_INPUT_REGIONS`) and then silently not hashed here:
 * the union test stays green, the layout test stays green, and the field
 * reports fresh while its inputs changed. Walking `ranges` instead makes
 * that divergence structurally impossible — classification IS what gets
 * hashed, because the ranges are derived from the same partition.
 *
 * **Allocation-free, per review (Important 5 / the plan-defect ruling on
 * it): reads `state.bytes` — the one `Uint8Array` view over the WHOLE
 * buffer, built once in `viewsOver` alongside every other region view —
 * instead of constructing `new Uint8Array(state.buffer, offset, length)`
 * per range per call.** That constructor call was the brief's own
 * prescription in 1c ("hashes `new Uint8Array(state.buffer, offset,
 * length)` for each") and it directly contradicts this milestone's "nothing
 * allocates inside a tick" rule: 5 views/tick today, 30/tick once Task 4's
 * `fieldFor` calls join `syncFields`'s. `hashBytes`'s own per-byte FNV-1a
 * step is inlined here (XOR then `Math.imul` by the same prime) so no
 * intermediate `Uint8Array` is ever constructed; per-region hashes are
 * still chained with `hashInt32`, in `ranges` order — the same "hash of
 * hashes, order-sensitive" shape `hashSources` already uses below.
 * `mapIdentity` being a FIELD_INPUT region means the old `hashRoadRegion`'s
 * separate `H_MAP` fold (M1b) is subsumed here: `mapIdentity` is simply one
 * more region in `ranges`, hashed whole.
 */
export function hashFieldInputRegions(state: GameState, ranges: Int32Array): number {
  const bytes = state.bytes
  let h = 0x811c9dc5 // FNV-1a offset basis
  for (let i = 0; i < ranges.length; i += 2) {
    const offset = ranges[i] as number
    const length = ranges[i + 1] as number
    let regionHash = 0x811c9dc5 // hashBytes' own per-region seed, inlined
    for (let j = 0; j < length; j++) {
      regionHash ^= bytes[offset + j] as number
      regionHash = Math.imul(regionHash, 0x01000193)
    }
    h = hashInt32(h, regionHash)
  }
  return nonZeroWord(h | 0)
}

/**
 * nonZeroWord over the length and each element of `sourcesFlat[offset,
 * offset + count)`, via hashInt32. Order-sensitive by design: an
 * order-insensitive fold (a sum, an XOR) is the tempting implementation, and
 * it collides on permutations of the same elements — which matters because
 * `computeFlowField` throws on an unsorted list, so an order-sensitive hash
 * is the only kind that can actually detect "the caller passed a different
 * (even if same-length, same-set) source list" as a staleness trigger.
 *
 * **Disclosed, so it does not read as an oversight: the length fold has no
 * constructible mutation.** Deleting `h = hashInt32(h, count)` leaves every
 * test green, because FNV chaining is already prefix-sensitive — `[1, 2]`
 * and `[1, 2, 3]` diverge at the third element regardless of whether the
 * length was folded in first. It is kept as genuine defence-in-depth on the
 * staleness key rather than removed, on the same reasoning as the terrain
 * whitelist in roads.ts: a check that is currently subsumed but
 * independently correct is cheap, and the thing subsuming it is a property
 * of the hash function rather than of this function's contract.
 */
export function hashSources(sourcesFlat: Int32Array, offset: number, count: number): number {
  // FNV-1a's offset basis — the same seed hashBytes starts from, hardcoded
  // here (not imported) rather than shared: hashBytes' seed is a
  // never-exported implementation detail of a function under the golden
  // hash, and pinning it wall-to-wall to hashInt32's usage elsewhere is
  // covered directly in hash.test.ts instead.
  let h = 0x811c9dc5
  h = hashInt32(h, count)
  for (let i = 0; i < count; i++) {
    h = hashInt32(h, sourcesFlat[offset + i] as number)
  }
  return nonZeroWord(h | 0)
}

/**
 * Every colour's source slice in `scratch.sourcesFlat` starts
 * `world.map.maxDestinations` apart: colour `c` occupies `[c *
 * maxDestinations, c * maxDestinations + scratch.sourceCounts[c])`. A tiny
 * shared helper rather than repeating the multiplication in both
 * `syncFields` and `fieldFor` — those two independently re-implementing
 * "field inputs AND sources" staleness is exactly the kind of duplication
 * M1b's carry-forward flagged once already; the offset arithmetic gets the
 * same treatment here.
 *
 * **Returns a plain `number`, not `{ offset, count }` (review Important 5):
 * an object literal here was one allocation per colour per tick** — 5/tick
 * today from `syncFields`' loop alone, 10/tick once `fieldFor` joins it in
 * Task 4. Every caller already holds `scratch.sourceCounts[c]` directly, so
 * the count never needed to travel through this helper at all.
 */
function colourSourceOffset(colour: number, world: WorldData): number {
  return colour * world.map.maxDestinations
}

/**
 * The once-per-tick rebuild point, and the only writer of the stamps.
 * Computes the field-input hash once (these regions rarely change relative
 * to how often this runs — once per tick, for every colour), rebuilds every
 * colour whose stamps disagree with its current inputs, and leaves the rest
 * untouched — that is §5.4's "coalesce dirty rebuilds to at most one per
 * tick".
 *
 * **Both stamps are zeroed BEFORE the rebuild and re-written only after it
 * returns. This is the single line of defence for design decision 3's whole
 * premise** — that derived state may live outside the snapshot because it is
 * a pure function of what is inside — and that premise holds only while the
 * stamps never describe content the field does not actually hold.
 *
 * `computeFlowField` wipes `dist`/`dir` at entry and validates afterwards:
 * ascending order, source range, and entry-pool capacity all throw AFTER the
 * wipe, the last of them from the middle of the drain loop with a partly
 * relaxed field already written. Writing the stamps only on success would
 * therefore leave a destroyed field still advertising the previous, correct
 * content: the next tick's comparison matches, this loop skips the rebuild,
 * and `fieldFor` returns an all-INF (or worse, plausible-looking, partly
 * relaxed) field with no error anywhere. Two engines holding byte-identical
 * `state` buffers and given identical sources would then serve different
 * fields, decided purely by whether that engine's `FlowField` objects passed
 * through the throwing tick — the exact browser-vs-Worker divergence this
 * design exists to make impossible.
 *
 * Zeroing first converts that silent wrong answer back into the throw the
 * design already has: a field left marked never-built is rejected by
 * `fieldFor` (which is what makes its never-built branch load-bearing rather
 * than redundant) and unconditionally rebuilt by the next `syncFields`,
 * because 0 can never equal a real stamp (`nonZeroWord`). A throw before the
 * wipe costs one extra rebuild next tick and nothing else; both engines still
 * converge on identical field content, since a rebuild from identical inputs
 * is byte-identical.
 *
 * **Sources and the field-input hash both live on `scratch` (M1c), not as
 * separate parameters** — `scratch.sourcesFlat`/`scratch.sourceCounts` are
 * whatever the tick's source-assembly phase last wrote (Task 4's dispatch in
 * production; a test poking them directly here in Task 1), and
 * `scratch.fieldInputRanges` is the boot-time layout-derived table. This
 * keeps `syncFields`' signature stable regardless of how many FIELD_INPUT
 * regions the partition ever grows to.
 *
 * **`fields.length` must equal `world.map.groupCount` (1a, fix-list #26,
 * review Important 3).** Every region sizes from `map.groupCount`; a
 * `fields` array of any other length is a caller wiring bug — a 1-colour
 * `fields` array on a 5-colour map would silently serve colours 1-4 as
 * "no field for colour c" from `fieldFor` instead of failing here, at the
 * one place that actually knows both numbers.
 */
export function syncFields(
  state: GameState,
  world: WorldData,
  fields: readonly FlowField[],
  scratch: Scratch,
): void {
  if (fields.length !== world.map.groupCount) {
    throw new Error(
      `syncFields: fields.length (${fields.length}) !== world.map.groupCount (${world.map.groupCount})`,
    )
  }
  // Checked explicitly rather than left to fall through: an out-of-range
  // `scratch.sourceCounts[c]` reads `undefined`, and treating it as a count
  // would throw a raw, unnamed error from deep inside `hashSources`.
  if (scratch.sourceCounts.length !== fields.length) {
    throw new Error(
      `syncFields: scratch.sourceCounts.length (${scratch.sourceCounts.length}) !== fields.length (${fields.length})`,
    )
  }
  // The OTHER half of the same scratch/world sizing agreement, and it was
  // missing: `colourSourceOffset` strides by `world.map.maxDestinations` while
  // `sourcesFlat` was sized from `createScratch`'s own parameter. Only
  // UNDER-sizing is dangerous (over-sizing just spreads the slices further
  // apart and is provably harmless — `hashSources` folds the same values), and
  // it currently fails as `computeFlowField: source undefined is out of range
  // for N cells`: a message naming neither the cause nor a function the caller
  // can act on, from three frames deep, after `H_EPOCH` has been poisoned and
  // the run made unresumable. Checked AFTER the guard above so a scratch that
  // is wrong in both dimensions still reports the `groupCount` half first.
  const expectedFlat = world.map.groupCount * world.map.maxDestinations
  if (scratch.sourcesFlat.length !== expectedFlat) {
    throw new Error(
      `syncFields: scratch.sourcesFlat.length (${scratch.sourcesFlat.length}) !== ` +
        `groupCount * maxDestinations (${world.map.groupCount} * ${world.map.maxDestinations} = ${expectedFlat}) — ` +
        'the scratch was built for a different map than the world it is being used with',
    )
  }
  scratch.counters[CT_SYNCS] = (scratch.counters[CT_SYNCS] as number) + 1
  const fieldInputHash = hashFieldInputRegions(state, scratch.fieldInputRanges)
  for (let c = 0; c < fields.length; c++) {
    const field = fields[c] as FlowField
    const offset = colourSourceOffset(c, world)
    const count = scratch.sourceCounts[c] as number
    const sourcesHash = hashSources(scratch.sourcesFlat, offset, count)
    if (field.builtFromFieldInputs === fieldInputHash && field.builtFromSources === sourcesHash) continue
    field.builtFromFieldInputs = 0
    field.builtFromSources = 0
    computeFlowField(state, world, scratch.sourcesFlat, offset, count, field, scratch)
    scratch.counters[CT_REBUILDS] = (scratch.counters[CT_REBUILDS] as number) + 1
    field.builtFromFieldInputs = fieldInputHash
    field.builtFromSources = sourcesHash
  }
}

/**
 * The read accessor, and the only one. Throws if `fields` is sized for a
 * different cell count than `world`, if the field was never built, or if
 * either stamp disagrees with the inputs as they are now. Never rebuilds: a
 * throw here means the caller read a field without syncing this tick first,
 * which is a bug worth surfacing rather than papering over with an implicit
 * rebuild.
 *
 * **`step` calls this once per colour per tick and holds the reference for
 * the tick** (fix-list #21) — never `fields[c].dist[cell]` directly, which
 * passes every test today and makes this whole staleness guard dead code in
 * the exact place it exists to protect.
 */
export function fieldFor(
  state: GameState,
  world: WorldData,
  fields: readonly FlowField[],
  colour: number,
  scratch: Scratch,
): FlowField {
  const field = fields[colour]
  if (field === undefined) {
    throw new Error(`fieldFor: no field for colour ${colour} (fields.length ${fields.length})`)
  }
  if (field.dist.length !== world.cells) {
    throw new Error(
      `fieldFor: field.dist.length (${field.dist.length}) !== world.cells (${world.cells})`,
    )
  }
  // Checked before the hash comparison below: a fresh FlowField's stamps are
  // both 0, and 0 could otherwise coincidentally equal a real hash's `| 0`
  // reinterpretation in some future arithmetic slip — checking "never built"
  // explicitly, rather than folding it into the hash comparison, keeps the
  // two failure reasons distinguishable and keeps this guard correct even if
  // that were ever true.
  //
  // This branch reports two different situations now, not one: a genuinely
  // fresh field, and a field whose last rebuild THREW (`syncFields` zeroes
  // both stamps before calling `computeFlowField` — see its comment). The
  // second is the one that matters, and it is why the message is pinned by a
  // regex in the tests rather than by a bare `.toThrow()`: replacing this
  // condition with `false` still throws, from the stamp comparison below,
  // with a message that says "stale — call syncFields" and sends the reader
  // looking for a missing sync that already happened and failed.
  if (field.builtFromFieldInputs === 0 || field.builtFromSources === 0) {
    throw new Error(`fieldFor: colour ${colour} field was never built`)
  }
  const fieldInputHash = hashFieldInputRegions(state, scratch.fieldInputRanges)
  const offset = colourSourceOffset(colour, world)
  const count = scratch.sourceCounts[colour] as number
  const sourcesHash = hashSources(scratch.sourcesFlat, offset, count)
  if (field.builtFromFieldInputs !== fieldInputHash || field.builtFromSources !== sourcesHash) {
    throw new Error(
      `fieldFor: colour ${colour} field is stale — call syncFields before reading it this tick`,
    )
  }
  return field
}
