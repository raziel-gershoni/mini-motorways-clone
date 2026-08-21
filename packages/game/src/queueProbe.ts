import {
  crossesAt,
  crossesDirections,
  FREE,
  LANE_OF_DIR,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
  junctionAdmitsOne,
  occupantOf,
  otherLane,
  routeStep,
  stepCell,
  type GameState,
  type WorldData,
} from '@laneways/sim'

/**
 * **A queue length read off production state, with no queue structure
 * anywhere in `sim`** — there is none; queueing emerges from per-(cell, lane)
 * occupancy alone.
 *
 * This is `packages/game/test/jamFixture.ts`'s `jamQueueLength`, moved into
 * `src` so that the demo layout's tests and any future debug HUD can share one
 * implementation. It lives here rather than being imported from `test/`
 * because a `src` module may not import a test fixture — the dependency would
 * point the wrong way and would not survive a build.
 *
 * ---------------------------------------------------------------------------
 * THE OCCUPANCY ARRAY IS READ, NOT RECONSTRUCTED — AND THE FIRST VERSION
 * RECONSTRUCTED IT WRONG
 * ---------------------------------------------------------------------------
 *
 * "The car in front of me" is not a geometric question. It is exactly the
 * question `canEnter` (`blocking.ts`) answers: car `i` is held up by whoever
 * occupies **`(next, LANE_OF_DIR[dir])`**, the slot `claimCell` writes and
 * `canEnter` reads. So that slot is what `carAheadOf` reads, through
 * `occupantOf`, and nothing here rebuilds it.
 *
 * **The version this replaced built its own `Map<cell, car>` keyed by the cell
 * ALONE, and was wrong on 5.7-15.2 % of the questions it asked.** M1d's whole
 * premise is that one cell carries two lanes: two in-flight cars legitimately
 * share a `carCell` in opposite directions, and the demo layout advertises that
 * as a visible feature. A one-car-per-cell map silently discarded the second and
 * linked the follower to whichever was written last — sometimes a car travelling
 * the *opposite* way, which is not in front of it and is not blocking it.
 * Measured on the demo board after its warm start: some cell held 2+ in-flight
 * cars on **85 %** of ticks, and the cell-keyed probe both over-reported (by up
 * to 5) and under-reported (by up to 4) against this one.
 *
 * **Deriving the lane from the car's own direction of TRAVEL is also wrong, and
 * that is the subtler half.** A car occupies the lane of the direction it
 * ENTERED by, not the one it is about to leave by, and those differ at every
 * turn and at every outbound->return flip — a car that has just turned around on
 * a carpark stands in the northbound lane while facing south. Keying the
 * occupant by its next step disagrees with `canEnter` on **5.9-10.0 %** of
 * questions, and worst exactly where it matters most: on a starved corridor,
 * where the queue stands *behind the car that has just flipped*, it disagreed on
 * 96.8 % of ticks and read a longest queue of 11 against a true 16. Reading the
 * array sidesteps the derivation entirely — it already accounts for turns, for
 * the flip, for a car that has not crossed on its current leg and therefore
 * holds no slot at all, and for a car displaced by the anti-deadlock valve.
 *
 * Measured over 90,533 car-questions on three fixtures — the demo board, the jam
 * corridor and the starved corridor — this agrees with `canEnter` on **every
 * one**. `queueProbe.test.ts` and `demoLayout.test.ts` assert that as a property
 * rather than quoting the number.
 *
 * ---------------------------------------------------------------------------
 * THREE FUNCTIONS RATHER THAN ONE, SO EACH CLAIM HAS ITS OWN OBSERVER
 * ---------------------------------------------------------------------------
 *
 * `longestQueue` returns a single integer, which is a poor thing to test a
 * relation with — the whole reason this module's first version shipped two
 * 0-detector mutations. `travelDir` (which way is this car going) and
 * `carAheadOf` (who is in the slot it is asking for) are the two claims inside
 * it, and both are exported and asserted directly.
 */

/** `travelDir`'s answer for a car that is not about to cross anything. */
export const NO_CROSSING = -1

/**
 * The direction car `i` is travelling, or `NO_CROSSING`.
 *
 * **The return leg is the committed route read BACKWARDS**, so a returning car
 * retraces step `cursor - 1` in the opposite direction; `+ 4 % 8` is `OPPOSITE`,
 * spelled out rather than imported so this module depends on nothing that could
 * change meaning under it.
 *
 * Three cars answer `NO_CROSSING`, and each is a real state rather than a
 * defensive default: a parked car (any phase but the two), an outbound car whose
 * cursor has reached its route length (arrived, waiting for `runArrivals`), and
 * a returning car at cursor 0 (home, same). None of the three has a next cell,
 * so none of them can be queueing behind anything — though all three can still
 * be queued *behind*, which is why this says nothing about their occupancy slot.
 */
export function travelDir(state: GameState, i: number): number {
  const phase = state.carPhase[i] as number
  const cursor = state.carRouteCursor[i] as number
  if (phase === PHASE_OUTBOUND) {
    if (cursor >= (state.carRouteLen[i] as number)) return NO_CROSSING
    return routeStep(state, i, cursor)
  }
  if (phase === PHASE_RETURNING) {
    if (cursor <= 0) return NO_CROSSING
    return (routeStep(state, i, cursor - 1) + 4) % 8
  }
  return NO_CROSSING
}

/**
 * The car standing in the slot car `i` is trying to cross into, or `FREE`.
 *
 * **The one line this module is about**, and it is deliberately the same three
 * terms `advanceCar` uses: `stepCell` for the next cell (which is where the
 * board-edge check lives — a car on column 0 heading west would otherwise wrap
 * into the last cell of the previous row, a real cell with a real car on it),
 * and `occupantOf(next, LANE_OF_DIR[dir])` for the slot.
 *
 * No `!== i` guard, deliberately: `canEnter` has none either, and occupancy
 * SOUNDNESS (`assertOccupancySound`) says a slot names a car standing on that
 * cell, which `i` is not.
 *
 * **M1f Task 2: at a JUNCTION the entrant can be held by either lane, and this
 * function answers with the OWN lane first. M1f Task 3 narrowed WHEN the other
 * lane holds anybody up at all** — only when the two entry axes cross, which is
 * `crossesDirections(dir, crossesAt(state, other))`, the same pair of functions
 * `canEnter` calls. Without that clause this probe over-reports the moment the
 * rule narrows, and the iff property below fails by name on the demo board at
 * tick 421 — which is how the omission was found rather than reasoned about.
 *
 * Junction exclusion means a car entering a cell of degree >=
 * `INTERSECTION_DEGREE` can be held by a slot that is not its own, so "the car
 * ahead" is no longer a single well-defined slot. The relation must stay
 * FUNCTIONAL — `longestQueue` walks it and would otherwise need a graph — so the
 * tie-break is: the own lane's occupant if there is one, otherwise the other
 * lane's occupant when its axis crosses. That is the car whose departure the
 * entrant is actually waiting on in the common case, and the fallback is what
 * makes the chain reflect a crossing refusal instead of reporting an empty road
 * in front of a stopped car.
 *
 * **`junctionAdmitsOne` and not `isJunctionCell`**, and reading the sim's own
 * predicate rather than re-deriving the degree here is the whole point: this
 * function and `canEnter` must not be able to disagree about which cells the
 * rule governs, and at Task 9 an upgraded junction stops being one of them in
 * exactly one place. This is the second reader that predicate's doc names.
 *
 * The probe's property test — *"for every in-flight car on every tick, the probe's
 * answer equals `canEnter`'s"* — is re-pointed accordingly: the probe reports a
 * car ahead **iff** `canEnter` refuses for occupancy. That is the assertion that
 * catches this whole class, and hand-built cases could not: every reader is an
 * inequality loose enough to survive a wrong answer. It is asserted on the jam
 * corridor (`queueProbe.test.ts`, no junction) AND on the demo board
 * (`demoLayout.test.ts`, junctions everywhere) — the corridor alone cannot see
 * this repair at all, which is why it stayed green through the break.
 */
export function carAheadOf(state: GameState, world: WorldData, i: number): number {
  const dir = travelDir(state, i)
  if (dir === NO_CROSSING) return FREE
  const next = stepCell(state.carCell[i] as number, dir, world.w, world.h)
  if (next < 0) return FREE
  const lane = LANE_OF_DIR[dir] as number
  const own = occupantOf(state, next, lane)
  if (own !== FREE) return own
  if (!junctionAdmitsOne(state, next)) return FREE
  const other = occupantOf(state, next, otherLane(lane))
  if (other === FREE) return FREE
  // M1f Task 3: the other lane only holds this car up if the two entry axes
  // CROSS. Both terms are the sim's own — `crossesDirections` and `crossesAt`
  // are the functions `canEnter` calls, not a copy of the rule — for exactly the
  // reason `junctionAdmitsOne` is read rather than re-derived above.
  return crossesDirections(dir, crossesAt(state, other)) ? other : FREE
}

/**
 * The longest chain of cars each waiting on the next.
 *
 * **The relation is FUNCTIONAL, and as of M1f Task 2 that is a DECISION rather
 * than a fact about the board.** A car has exactly one next cell — the next step
 * of its own committed route — but at a junction that one cell has two lanes and
 * either can hold it up. `carAheadOf` breaks the tie (own lane, then the other),
 * which is what keeps this a forward walk rather than a tree search. The cost of
 * the decision is that a car held by BOTH lanes is charged to one of them; the
 * benefit is that this function stays O(cars) and its answer stays a number.
 *
 * **The visited set is not decoration, and its justification has now CHANGED
 * TWICE.** A cycle of length >= 3 is precisely the deadlock `MAX_BLOCKED_TICKS`
 * exists for, and without the set this walk would not terminate on one. The
 * cell-keyed version also argued that a 2-cycle was impossible, because opposite
 * directions land in different lanes. **That argument did not survive reading
 * the real slots**: two cars that have each just turned around on adjacent cells
 * both stand in the lane opposite to the way they now face, so each really is
 * the occupant of the slot the other is asking about. **And M1f Task 2 made the
 * 2-cycle ordinary rather than exotic**: under junction mutual exclusion two cars
 * swapping across an edge with a junction at each end each need the other's cell
 * empty and each is standing in it, with no turn-around required. The set was
 * always load-bearing; it is now load-bearing on the board that ships.
 *
 * **The phase filter here is the one that changes the answer.** A parked car is
 * not a queue of one — three idle cars on consecutive corridor cells are houses.
 * Deleting it is killed by two tests.
 *
 * **`travelDir`'s phase filter is a different thing and is LABELLED INERT**, so
 * that nobody reads its survival as a coverage hole and nobody writes a test
 * that cannot fail to close it. Deleting it (letting every phase fall through
 * to the returning branch) scores **0 detectors**, and that is a derivation
 * rather than a gap: a parked car can only ever become a KEY in `ahead`, never
 * a value, because occupancy soundness says a slot names an in-flight car — and
 * the walk above never starts from a parked car, so no key belonging to one is
 * ever read. It is kept because reading route bytes off a car that has no route
 * is meaningless work, not because a test can tell.
 *
 * **It allocates** — one `Map` and one `Set` per call — so it must never be
 * called from inside a tick or a frame. Both callers today are test rigs, and
 * both call it outside a profiled window. A debug HUD wanting this figure has
 * to either amortise it or accept the allocation with the profiler gated off;
 * `packages/game/test/allocation.test.ts` is what will say so.
 */
export function longestQueue(state: GameState, world: WorldData): number {
  const ahead = new Map<number, number>()
  const carCount = state.carPhase.length
  for (let c = 0; c < carCount; c++) {
    const front = carAheadOf(state, world, c)
    if (front !== FREE) ahead.set(c, front)
  }

  let longest = 0
  for (let c = 0; c < carCount; c++) {
    const phase = state.carPhase[c] as number
    if (phase !== PHASE_OUTBOUND && phase !== PHASE_RETURNING) continue
    const seen = new Set<number>([c])
    let cur = c
    let len = 1
    for (;;) {
      const next = ahead.get(cur)
      if (next === undefined || seen.has(next)) break
      seen.add(next)
      cur = next
      len++
    }
    if (len > longest) longest = len
  }
  return longest
}
