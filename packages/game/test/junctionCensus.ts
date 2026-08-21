import { INTERSECTION_DEGREE } from '@laneways/shared'
import {
  FREE,
  LANE_COUNT,
  occupancySlot,
  roadDegree,
  type GameState,
  type WorldData,
} from '@laneways/sim'

/**
 * **The census this milestone is dated from, as ONE module with TWO named
 * policies, shared by every driver that measures it**, on `cityArms.ts`'s
 * precedent: two drivers agreeing is evidence, one driver run twice is not.
 *
 * **WHY TWO.** The two policies answer two different questions and the previous
 * draft conflated them, dated the milestone off the wrong one, and then wrote a
 * correction that was itself out, in the wrong direction and by the wrong
 * amount.
 *
 * ---------------------------------------------------------------------------
 * **EVERY RULE-VISIBLE FIGURE THAT USED TO STAND IN THIS HEADER WAS WRONG, AND
 * THE CO-PRESENCE ROW BESIDE IT IS RIGHT — WHICH IS WHAT HID THEM.**
 * ---------------------------------------------------------------------------
 *
 * This block quoted the plan's **271 events / first at tick 12,780 / five
 * cells**, and concluded the board diverges **74.0 s earlier** than co-presence
 * says. M1f Task 1 measured all four with the definition below, unaltered, on
 * two independent drivers, and none of them survived:
 *
 * ```
 *                        plan / this header      measured on 2d76653
 *   rule-visible events              271                        538
 *   first at tick                 12,780                     10,207  (5:31.6)
 *   distinct cells                     5                          6
 *   gap against co-presence       74.0 s                    159.8 s
 * ```
 *
 * **Five cells is not merely wrong, it is unreachable by this definition.** The
 * rule-visible branch below contains the co-presence predicate verbatim as one
 * of its disjuncts, so every co-presence event is a rule-visible event at the
 * same cell on the same tick and the rule-visible cell set is a strict SUPERSET
 * of co-presence's six. No re-measurement can move that, and both drivers assert
 * it rather than arguing it.
 *
 * **What 12,780 actually is, since the number is real and only its label was
 * wrong.** M1f Task 2 measured it directly, by hashing the whole state buffer
 * every tick against the previous commit: **12,780 is the first tick on which
 * the board DIVERGES** once mutual exclusion lands — the first byte that differs
 * anywhere. It is not when this census fires. The two differ by 2,573 ticks
 * because the event at 10,207 is a swap whose LEAVER has the lower car index,
 * and `runMovement` ascends, so the leaver releases the cell before the entrant
 * asks for it and the rule PERMITS it. Confirmed at the cell: 468 = (12,19),
 * lane 1, occupant 9 -> 24. **So this census over-approximates divergence, and
 * 10,207 is the safe bound while 12,780 is the truth about the board.** An
 * artefact quoting 12,780 as "the tick the census fires" is wrong; one quoting
 * 10,207 as "the tick the board diverges" is also wrong.
 *
 * **Why this header was the last place carrying the old figures.** The
 * co-presence row — 232 / 15,001 / six — is correct and reproduces to the digit,
 * so a reader who spot-checks one row finds it right and stops. That is the
 * milestone's dominant defect family (*a durable artefact stating the opposite
 * of the measurement*) in its most durable form: nothing asserts 271, so nothing
 * ever goes red to question it, while `startingCity.test.ts` corrects the same
 * figure fifteen lines of prose away.
 *
 * **These are all PRE-M1f-Task-2 figures, and that qualifier is load-bearing
 * now that the rule ships.** A census is measured ON A RUN, and Task 2 changed
 * the run: on the same greedy arm after mutual exclusion the same two policies
 * read **11 / first at 17,658 / three cells** and **44 / first at 10,207 / five
 * cells**. Co-presence very nearly vanishes because it counts exactly the state
 * the rule forbids, and what survives it is the anti-deadlock valve, which
 * crosses regardless of the occupant. Both drivers assert the post-rule figures;
 * the pre-rule ones above are what the milestone is DATED from and are not
 * re-measurable on any tree after `f63c40e`.
 *
 * - `CENSUS_CO_PRESENCE` asks *"were two different cars ever standing on one
 *   junction cell at the end of a tick?"* Answer on the greedy arm: **232
 *   events, first at tick 15,001, six cells.** It is a true statement about the
 *   board, it reproduces to the digit, and it is **STRUCTURALLY BLIND TO A
 *   SAME-TICK SWAP**: when two cars
 *   exchange cells across an edge, the junction holds one car at the start of the
 *   tick and a different car at the end, never two at once. A swap across an edge
 *   with a junction at its end is exactly the case Decision 2 names as producing
 *   the genuine 2-cycles M1f Task 2 creates, so this policy cannot see the first
 *   thing the rule changes.
 * - `CENSUS_RULE_VISIBLE` asks *"did anything happen on a junction cell that
 *   Task 2's mutual exclusion is about?"* — which additionally counts an
 *   OCCUPANT CHANGE WITHIN A TICK: a junction cell holding car `a` at the end of
 *   tick `t - 1` and a different car `b` at the end of tick `t`, with the cell
 *   never observed empty between them. Answer on the greedy arm, MEASURED:
 *   **538 events, first at tick 10,207, six cells.** `(14,17)` does take an
 *   event at exactly tick 12,780, which is the swap the plan named — it is
 *   simply not the first one, and (12,19) takes one 2,573 ticks earlier.
 *
 * `15,001 - 10,207 = 4,794` ticks = **159.8 s**, and the board therefore
 * diverges 159.8 s EARLIER than the co-presence reading says, not later. **The
 * DIRECTION the previous draft had backwards survives; only the size of the gap
 * changed.**
 *
 * **Both counts were values to REPRODUCE, and the protocol that got them here is
 * worth keeping now that it has fired.** The plan's instruction was: if the
 * extended policy reproduces 232 and not 271, that IS the finding — record the
 * measured number, mark 271 superseded, and DO NOT adjust the definition until
 * it reaches 271. **Task 1 followed it exactly.** Co-presence reproduced all
 * eight of its inherited quantities, which is what licensed treating the
 * rule-visible disagreement as a finding about the inherited number rather than
 * as a broken rig, and nothing in the definition was touched. Tuning an
 * instrument toward a number is the defect that section existed to prevent, and
 * the instruction is left here in the past tense rather than deleted, because
 * the next person to disagree with a figure in this file should follow the same
 * order: reproduce something you are NOT trying to correct, first.
 *
 * `CENSUS_RULE_VISIBLE`'s count is specified by its EVENT rather than derived
 * from first principles, because whether a given swap would actually have been
 * refused depends on car index order inside `runMovement`, which a between-ticks
 * sampler cannot observe. **M1f Task 2 confirmed that caveat is real and not
 * theoretical** — the 10,207 event is precisely a swap the rule permits.
 *
 * **Read off `state.occupancy` and `state.roads`, never reconstructed.** The
 * queue probe's 5.7-15.2 % disagreement rate came from rebuilding a key the
 * system already stores.
 *
 * `prev` is caller-owned, `CENSUS_SLOTS_PER_CELL` entries per cell, and carries
 * the previous tick's occupancy across calls so the edges are detected with no
 * allocation.
 *
 * **EACH POLICY NEEDS ITS OWN `prev`. A sentence here used to say the opposite**
 * — *"both policies share one `prev`, so a driver may run both in one pass over
 * one buffer"* — and it is false: the loop writes `prev[i]` and `prev[i + 1]`
 * **unconditionally** at the end of every cell iteration, so a second policy's
 * pass over the same buffer reads the first pass's writes and measures nothing
 * at all. M1f Task 1 found this and both drivers correctly allocate two buffers
 * (`coPrev` and `rulePrev`); the correction was reported as applied to this
 * comment and was not, which is why it is being applied now. The guarantee the
 * old sentence was reaching for is real and comes from somewhere else: the two
 * counts are about the same run because they are taken on the same tick of the
 * same drive, not because they share a buffer.
 *
 * **`LANE_COUNT` comes from `@laneways/sim`, not `@laneways/shared`.** The plan's
 * snippet imported it from `shared`; `shared` has never exported it — it is
 * `roads.ts`'s, beside `LANE_OF_DIR`, which is the table that makes it total.
 *
 * **`tally` is a fifth, OPTIONAL out-parameter and the plan's snippet had no
 * way to produce the per-cell tables it also asks for.** The plan pins the
 * signature at four parameters and separately requires each driver to report
 * `conflictCells` / `ruleEventCells` "built from a local `Int32Array` tally" —
 * but a scalar return carries no attribution, and the only ways to recover it
 * from outside are to re-run the loop per cell (960x per event) or to write a
 * second copy of both policies in each driver. A second copy is the defect this
 * module exists to prevent, so the attribution is taken from the ONE loop that
 * decides it. Optional, so `countJunctionConflicts.length` is still 4 and every
 * four-argument call in the plan is unchanged; `tally[cell]` is INCREMENTED, not
 * reset, so a driver accumulates across a run.
 *
 * **`prev` must be pre-filled with `FREE` and not left zeroed.** 0 is a valid
 * car index, so a fresh `Int32Array` claims every cell was occupied by car 0 on
 * the tick before the first call — which fabricates a `swapped` edge on the
 * first tick any junction holds a car with a non-zero index. `censusPrev` below
 * is the only correct way to make one.
 */
export const CENSUS_CO_PRESENCE = 0
export const CENSUS_RULE_VISIBLE = 1

/** Two lanes' occupants, per cell. Both policies read the same two slots. */
export const CENSUS_SLOTS_PER_CELL = 2

/** A correctly-initialised `prev` for `world`: `FREE`, never zero. See above. */
export function censusPrev(world: WorldData): Int32Array {
  const prev = new Int32Array(world.cells * CENSUS_SLOTS_PER_CELL)
  prev.fill(FREE)
  return prev
}

/**
 * `[cell, count]` pairs for every cell that ever carried an event, ordered by
 * count descending and by cell ascending within a tie.
 *
 * One function, two drivers, on `cityArms.ts`'s precedent: the ordering is
 * asserted in both files and a second copy could agree with one and not the
 * other. The tiebreak is explicit because `Array.prototype.sort` is only stable
 * within equal keys — leaving ties to input order would make the table a
 * property of the cell loop rather than of the run.
 */
export function censusCellTable(tally: Int32Array): readonly (readonly [number, number])[] {
  const rows: [number, number][] = []
  for (let cell = 0; cell < tally.length; cell++) {
    const n = tally[cell] as number
    if (n > 0) rows.push([cell, n])
  }
  rows.sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
  return rows
}

export function countJunctionConflicts(
  state: GameState,
  world: WorldData,
  prev: Int32Array,
  policy: number,
  tally?: Int32Array,
): number {
  // Hoisted out of the loop, and not for tidiness: `state` carries ~30 typed
  // array views, so `state.roads[cell]` inside the loop is a property load per
  // cell per tick — 88 M of them across the three arms. Hoisting them costs
  // nothing semantically and is most of this census's runtime.
  const { roads, occupancy } = state
  const cells = world.cells
  let rising = 0
  for (let cell = 0; cell < cells; cell++) {
    let lane0 = FREE
    let lane1 = FREE
    // **The bare-ground short-circuit is a SPEED fix and provably not a
    // semantic one, and it is here because without it this census costs ~12 s
    // per driver.** `roadDegree` walks eight bits per call, and this loop runs
    // twice per tick over every cell of the board for the whole of a 31,456-tick
    // arm — 60 M popcounts, which blew vitest's 5 s case timeout. A cell with a
    // zero road mask has degree 0, so `isJunction` is false, so both lanes stay
    // `FREE`; with both lanes `FREE` every disjunct of `swapped` is false (all
    // four require a non-`FREE` lane THIS tick) and `both` is false, so neither
    // policy can fire. The only remaining effect of the iteration is writing
    // `FREE` into both `prev` slots, which the tail below still does. Mutation
    // 10 of the plan's table (`>= INTERSECTION_DEGREE` -> `>= 2`) is unaffected:
    // degree 1 and 2 cells still reach the comparison.
    const isJunction =
      (roads[cell] as number) !== 0 && roadDegree(state, cell) >= INTERSECTION_DEGREE
    if (isJunction) {
      lane0 = occupancy[occupancySlot(cell, 0)] as number
      lane1 = occupancy[occupancySlot(cell, LANE_COUNT - 1)] as number
    }
    const i = cell * CENSUS_SLOTS_PER_CELL
    const was0 = prev[i] as number
    const was1 = prev[i + 1] as number

    if (policy === CENSUS_CO_PRESENCE) {
      // The ORIGINAL definition, unchanged: one rising edge per
      // (cell, lane-0 car, lane-1 car) ORDERED TRIPLE. A pair sitting together
      // for k ticks is one conflict that lasted; a cell whose lane-0 occupant
      // changes while lane 1 stands still is a NEW conflict, because it is a new
      // pair of cars that would have crossed.
      const both = lane0 !== FREE && lane1 !== FREE && lane0 !== lane1
      if (both && (was0 !== lane0 || was1 !== lane1)) {
        rising++
        if (tally !== undefined) tally[cell] = (tally[cell] as number) + 1
      }
    } else {
      // RULE-VISIBLE. Co-presence, PLUS the swap the other policy cannot see: a
      // junction cell that held a car last tick and holds a DIFFERENT car this
      // tick, on either lane, having never been observed empty in between. That
      // is one tick in which two distinct cars both had business inside one
      // junction cell, which is what mutual exclusion is about.
      const both = lane0 !== FREE && lane1 !== FREE && lane0 !== lane1
      const swapped =
        (was0 !== FREE && lane0 !== FREE && was0 !== lane0) ||
        (was1 !== FREE && lane1 !== FREE && was1 !== lane1) ||
        (was0 !== FREE && lane1 !== FREE && was0 !== lane1 && lane0 === FREE) ||
        (was1 !== FREE && lane0 !== FREE && was1 !== lane0 && lane1 === FREE)
      if (isJunction && (swapped || (both && (was0 !== lane0 || was1 !== lane1)))) {
        rising++
        if (tally !== undefined) tally[cell] = (tally[cell] as number) + 1
      }
    }

    prev[i] = lane0
    prev[i + 1] = lane1
  }
  return rising
}
