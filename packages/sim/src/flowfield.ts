import { hashBytes, hashInt32 } from './hash'
import { H_MAP, nonZeroWord, type GameState } from './state'
import type { WorldData } from './world'
import { neighbours, edgeCost } from './graph'
import { OPPOSITE } from './roads'
import { INF, NB, ST_EXPANSIONS, ST_PUSHES, type FlowField, type Scratch } from './scratch'

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
 * Bucket aliasing does not rescue a removal either: pending entries at any
 * moment differ by at most `DIAG_COST - ORTHO_COST` (4), never by `NB`
 * (15), so two genuinely different distances can never collide into the
 * same bucket index while both are still pending. The check stays because it
 * saves work (skipping a stale cell's whole neighbour scan), and because
 * `scratch.stats[ST_EXPANSIONS]` — which counts only non-stale drains — makes
 * its removal visible even though `dist`/`dir` would not.
 */

/**
 * Fills `out` and `scratch` for the given `sources`, replacing whatever
 * either held before.
 *
 * **The reset is unconditional — dist/dir/bucketHead are fully overwritten
 * and stats zeroed before anything else runs, with no early return for an
 * empty `sources`.** A natural `if (sources.length === 0) return` guard
 * would leave `out` holding whatever the previous colour (or the previous
 * build of this same colour) last wrote, and design decision 3's staleness
 * detection depends on every rebuild actually producing this colour's own,
 * current answer — not silently reusing a stale one because this
 * particular call happened to have nothing to relax.
 *
 * **Source validity: a source is accepted iff it is in range AND carries at
 * least one road bit.** A pin sitting on a cell with no road is not a source
 * and gets no field entry — with all sources rejected, the field is
 * entirely `INF`/`-1`, which is the correct answer. (In M1c, pins sit on
 * destinations, which are exactly the cells that may have no road yet, so
 * M1c must seed sources from a destination's road-adjacent access cell, not
 * from the building cell itself.)
 *
 * **`sources` must be strictly ascending cell indices — throws otherwise,
 * including on a duplicate.** Source order silently decides `dir` at ties
 * while `dist` stays identical, so an unsorted (or differently-ordered)
 * source list would make browser and Worker agree on `dist` but potentially
 * disagree on `dir` — a divergence a `dist`-only check would never catch.
 * Canonicalising by throwing (rather than sorting internally) keeps the
 * decision of "what counts as the same source set" out of this function and
 * in whatever assembles `sources` every tick.
 */
export function computeFlowField(
  state: GameState,
  world: WorldData,
  sources: readonly number[],
  out: FlowField,
  scratch: Scratch,
): void {
  const { cells } = world
  const { dist, dir } = out
  const { bucketHead, entryCell, entryNext, nbrCell, nbrDir, stats } = scratch

  dist.fill(INF)
  dir.fill(-1)
  bucketHead.fill(-1)
  stats[ST_EXPANSIONS] = 0
  stats[ST_PUSHES] = 0

  for (let i = 1; i < sources.length; i++) {
    if ((sources[i] as number) <= (sources[i - 1] as number)) {
      throw new Error(
        `computeFlowField: sources must be strictly ascending cell indices; ` +
          `got ${sources[i - 1]} at index ${i - 1} followed by ${sources[i]} at index ${i}`,
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
  }

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i] as number
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
 * `nonZeroWord` of a hash over BOTH `state.roads` and the map's identity
 * (`state.header[H_MAP]`, which already encodes `w`/`h` and every terrain
 * byte — see `mapIdHash` in world.ts). Folding in the map identity closes a
 * gap a roads-only hash would leave open: two boards with the same total
 * `cells` (e.g. 6x4 and 4x6) but different `w`/`h` would otherwise produce
 * byte-identical `roads` regions for byte-identical content and therefore
 * collide here, and `fieldFor`'s cell-count guard checks `dist.length ===
 * world.cells` — a count, not a shape — so it cannot catch that swap
 * either. Not reachable today (one map per running session; `createWorld`
 * and `createState` are always built from the same `MapData` together),
 * but the staleness key should not silently depend on that pairing holding
 * by convention rather than by construction.
 */
export function hashRoadRegion(state: GameState): number {
  return nonZeroWord(hashInt32(hashBytes(state.roads) | 0, state.header[H_MAP] as number) | 0)
}

/**
 * nonZeroWord over the length and each element, via hashInt32.
 * Order-sensitive by design: an order-insensitive fold (a sum, an XOR) is the
 * tempting implementation, and it collides on permutations of the same
 * elements — which matters because `computeFlowField` throws on an unsorted
 * list, so an order-sensitive hash is the only kind that can actually detect
 * "the caller passed a different (even if same-length, same-set) source
 * list" as a staleness trigger.
 */
export function hashSources(sources: readonly number[]): number {
  // FNV-1a's offset basis — the same seed hashBytes starts from, hardcoded
  // here (not imported) rather than shared: hashBytes' seed is a
  // never-exported implementation detail of a function under the golden
  // hash, and pinning it wall-to-wall to hashInt32's usage elsewhere is
  // covered directly in hash.test.ts instead.
  let h = 0x811c9dc5
  h = hashInt32(h, sources.length)
  for (let i = 0; i < sources.length; i++) {
    h = hashInt32(h, sources[i] as number)
  }
  return nonZeroWord(h | 0)
}

/**
 * The once-per-tick rebuild point, and the only writer of the stamps.
 * Computes the road hash once (roads rarely change relative to how often
 * this runs — once per tick, for every colour), rebuilds every colour whose
 * stamps disagree with its current inputs, and leaves the rest untouched —
 * that is §5.4's "coalesce dirty rebuilds to at most one per tick".
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
 * `state` buffers and given identical `sources` would then serve different
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
 */
export function syncFields(
  state: GameState,
  world: WorldData,
  sourcesByColour: readonly (readonly number[])[],
  fields: readonly FlowField[],
  scratch: Scratch,
): void {
  // Checked explicitly rather than left to fall through: an out-of-range
  // `sourcesByColour[c]` reads `undefined`, and `hashSources(undefined)`
  // would throw a raw `TypeError: Cannot read properties of undefined
  // (reading 'length')` naming neither `syncFields` nor which colour was
  // missing its source list.
  if (sourcesByColour.length !== fields.length) {
    throw new Error(
      `syncFields: sourcesByColour.length (${sourcesByColour.length}) !== fields.length (${fields.length})`,
    )
  }
  const roadsHash = hashRoadRegion(state)
  for (let c = 0; c < fields.length; c++) {
    const field = fields[c] as FlowField
    const sources = sourcesByColour[c] as readonly number[]
    const sourcesHash = hashSources(sources)
    if (field.builtFromRoads === roadsHash && field.builtFromSources === sourcesHash) continue
    field.builtFromRoads = 0
    field.builtFromSources = 0
    computeFlowField(state, world, sources, field, scratch)
    field.builtFromRoads = roadsHash
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
 */
export function fieldFor(
  state: GameState,
  world: WorldData,
  fields: readonly FlowField[],
  colour: number,
  sources: readonly number[],
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
  if (field.builtFromRoads === 0 || field.builtFromSources === 0) {
    throw new Error(`fieldFor: colour ${colour} field was never built`)
  }
  const roadsHash = hashRoadRegion(state)
  const sourcesHash = hashSources(sources)
  if (field.builtFromRoads !== roadsHash || field.builtFromSources !== sourcesHash) {
    throw new Error(
      `fieldFor: colour ${colour} field is stale — call syncFields before reading it this tick`,
    )
  }
  return field
}
