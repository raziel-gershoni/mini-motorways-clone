import { MAX_BLOCKED_TICKS, TICKS_PER_WEEK } from '@laneways/shared'
import {
  claimCell,
  createFieldInputRanges,
  createFlowFields,
  createScratch,
  createState,
  createWorld,
  dirBetween,
  isGameOver,
  junctionAdmitsOne,
  occupantOf,
  otherLane,
  releaseCell,
  restore,
  snapshot,
  step,
  stepCell,
  FREE,
  H_ROUTES_REFUSED,
  H_SCORE,
  H_TICK,
  LANE_OF_DIR,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
  type GameState,
  type TickAction,
  type WorldData,
} from '@laneways/sim'
import { DEFAULT_LAYOUT_ID, DEMO_LAYOUT_ID, layoutFor } from '../src/layouts'
import { longestQueue, travelDir, NO_CROSSING } from '../src/queueProbe'
import { armGreedyActions, armPathActions, CITY_OPENING, GREEDY_PERIOD_TICKS } from './cityArms'
import {
  censusPrev,
  countJunctionConflicts,
  CENSUS_CO_PRESENCE,
  CENSUS_RULE_VISIBLE,
} from './junctionCensus'

/**
 * **The M1f Task 3 triage rig: one instrument, two boards, and a per-cell
 * refusal table that later tasks read their jam cells from.**
 *
 * ---------------------------------------------------------------------------
 * WHAT AN "ARM" IS HERE, BECAUSE THE BRIEF USES THE WORD FOR TWO THINGS
 * ---------------------------------------------------------------------------
 *
 * Task 3's brief names three **arms** — A (the wide rule plus a demo layout
 * change), B (crossing conflicts only) and C (a relief-driven harness). Those
 * are three candidate **rules**, and a rule is compiled into `canEnter`
 * (`blocking.ts`): `advanceCar` calls it directly, `runMovement` is the only
 * caller of `advanceCar` inside `step`, and `step` is monolithic. **There is no
 * seam a test rig can reach**, and Decision 3 already declined a runtime switch.
 * So a rule variant is measured the way Step 2 and Step 3b both specify — a
 * committed-then-reverted edit, one sitting per rule, driven by THIS rig.
 *
 * `JunctionArm` therefore names the **board and input arm**, which is what the
 * rig can actually select: the shipped city under the greedy connector, and the
 * demo board with no input. One rig, three rules, so a difference between two
 * rules cannot be a difference between two rigs — which is the catalogue's
 * *"measure both variants in the same run"* applied to the only axis a rig can
 * own.
 *
 * ---------------------------------------------------------------------------
 * THE REFUSAL ATTRIBUTION IS EXACT, AND IT IS NOT A RECONSTRUCTION
 * ---------------------------------------------------------------------------
 *
 * `refusalsByCell` and `junctionRefusalsByCell` have to answer *"which cell was
 * this refusal at, and would a junction upgrade have removed it?"* — and the
 * second question is `canEnter`'s junction clause, which nothing outside
 * `blocking.ts` can observe. The obvious instruments are all wrong in the way
 * the queue probe was wrong (5.7-15.2 % disagreement from rebuilding a key the
 * system already stores):
 *
 *   - reading occupancy BEFORE the tick misses every refusal caused by a
 *     LOWER-indexed car that moved into the cell earlier in the same
 *     `runMovement` pass;
 *   - reading it AFTER the tick misses every refusal whose blocker was a
 *     HIGHER-indexed car that left later in the same pass.
 *
 * **The exact answer needs neither.** `runMovement` iterates ascending, so the
 * occupancy car `i` saw is: the pre-tick array, with the moves of cars `j < i`
 * applied. Every one of those moves is exactly two occupancy events —
 * `releaseCell(j, preCell)` then `claimCell(j, postCell, dir)`, which is
 * `advanceCar`'s own body — and both cells are observable from the pre- and
 * post-tick `carCell` arrays with `dirBetween` supplying the direction. So this
 * rig replays the pre-tick occupancy array forward using the PRODUCTION event
 * functions, driven by observed cell pairs, and asks its question at exactly
 * the point car `i` asked it. Nothing here re-derives a lane, a queue or a
 * blocking rule.
 *
 * **And it is checked against the production oracle every tick, as a property
 * rather than against hand-built numbers** — which is the prescription the
 * queue-probe entry in the catalogue ends with. Two invariants, both asserted
 * for every car on every tick of every arm:
 *
 *   - a car that was REFUSED must find at least one of the two slots occupied;
 *   - a car that was granted an ORDINARY (non-valve) crossing must find its OWN
 *     lane free.
 *
 * `refusalMisses` and `grantMisses` count violations of those two and are
 * asserted zero by every caller. If the replay were wrong they could not be.
 *
 * **Both invariants are deliberately RULE-INDEPENDENT**, because the rig has to
 * validate itself under three different junction clauses and a validator keyed
 * to one of them would report the other two as broken. "The other lane was free"
 * is Task 2's rule, not a property of the instrument, so it is reported as
 * `grantsWithOtherLaneTaken` — a count of the crossings the candidate rule
 * admits and the wide rule would not.
 *
 * **A refusal is a rise in `carBlockedTicks`, and that is a structural oracle
 * rather than a second implementation.** `blocking.ts` owns that region and has
 * exactly two writers: `noteEntryRefused` (+1, saturating) and
 * `noteEntryGranted` (0), both called from `advanceCar` on opposite sides of one
 * branch. `demoLayout.test.ts` and `jamFixture.ts` already read refusals this
 * way. The one hole a saturating counter leaves — a refusal at
 * `MAX_BLOCKED_TICKS`, which writes nothing — cannot arise on either board here:
 * a saturated car is answered `ENTER_VALVE` and crosses, and the only refusal
 * the valve may not release is `REFUSED_GHOST`, which needs an erase. Both arms
 * erase nothing, and `saturatedStalls` counts the exception so the argument is
 * measured rather than asserted.
 *
 * ---------------------------------------------------------------------------
 * WHY `junctionRefusalsByCell` AND NOT `refusalsByCell`
 * ---------------------------------------------------------------------------
 *
 * **Every later task ranks jam cells by the junction-caused tally, never by the
 * total.** Spillback lands one hop downstream of a junction, on cells of degree
 * <= 2 that no upgrade can ever be placed on — measured on the shipped arm,
 * `(13,18)` carries a fifth of all refusals and is never a junction on any
 * tick. Ranking by the total would nominate it as a jam cell and the site
 * survey would then halt the milestone on a cell that was never a candidate.
 *
 * A junction-caused refusal is the entrant's **own lane free and the other lane
 * occupied**, which is the only refusal `junctionAdmitsOne` returning false
 * could ever remove. By construction it can only be tallied on a cell where
 * `junctionAdmitsOne` is true, so the ranking cannot smuggle in a non-junction
 * cell — and the survey asserts that rather than trusting it.
 */

/** The board-and-input arm. See the module comment on why this is not A/B/C. */
export type JunctionArm = 'city-greedy' | 'demo-no-input'

/**
 * The arm every criterion about "the board that ships" is measured on: the
 * starting city under the greedy connector, which is `startingCity.test.ts`'s
 * and `integration.test.ts`'s `greedy`.
 */
export const SHIPPED_ARM: JunctionArm = 'city-greedy'

/** Twelve weeks, the horizon `startingCity.test.ts`'s gate uses. */
const CITY_HORIZON_WEEKS = 12

/**
 * A hard ceiling on the demo arm, which has no week gate. Well past every
 * measured demo death tick (6,703 pre-M1f, 5,757 wide, ~6,660 crossing-only);
 * a run that reaches it did not die and `deathTick` reports -1.
 */
const DEMO_HORIZON_TICKS = 40000

/** How often `longestQueue` is sampled on each arm. See `JunctionArmRun`. */
const CITY_QUEUE_SAMPLE = 10
const DEMO_QUEUE_SAMPLE = 1

export interface JunctionArmRun {
  /** The tick `isGameOver` first read true, or -1 if the horizon came first. */
  readonly deathTick: number
  /** `H_SCORE` at the end of the run. */
  readonly trips: number
  /**
   * Total entry refusals **from the first frame**, warm start excluded — the
   * "blocked car-ticks" of `blocking.ts`'s and `integration.test.ts`'s tables,
   * which are all measured over that window. Add `warmStartRefusals` for
   * `constants.ts`'s boot-inclusive convention.
   */
  readonly blockedCarTicks: number
  /** The peak of the repaired `longestQueue` probe, sampled (see the constants). */
  readonly longestQueue: number
  /** Refusals per cell, all causes. */
  readonly refusalsByCell: Int32Array
  /** Refusals a junction upgrade could remove: own lane free, other lane taken. */
  readonly junctionRefusalsByCell: Int32Array
  /** `CENSUS_CO_PRESENCE` events over the run. */
  readonly conflicts: number
  /** `CENSUS_RULE_VISIBLE` events over the run. */
  readonly ruleEvents: number

  // ---- diagnostics, so the report is a measurement rather than a summary ----
  /** `H_TICK` at the end of the run. */
  readonly endTick: number
  /** Ticks on which at least one car was refused. */
  readonly ticksWithBlockedCar: number
  /**
   * Refusals on the LAST tick driven — the death tick, when the arm dies there.
   *
   * **The reconciliation constant between two conventions that both ship.** This
   * rig samples the tick the run ends on; `integration.test.ts`'s per-week
   * `blockedTicks` row does not, because its driver breaks on `isGameOver`
   * before it counts. So the two disagree by exactly this many car-ticks and by
   * one tick, and the difference is the cars still standing when §5.8 fires. It
   * is measured rather than described, because the paragraph that reconciles
   * them is prose and prose about a number is how this milestone has already
   * lost two figures.
   */
  readonly finalTickRefusals: number
  /** Ticks driven after the warm start. */
  readonly ticksDriven: number
  /**
   * Crossings taken by a car saturated on the previous tick — **from BOOT,
   * warm start included**, which is `constants.ts`'s convention for this
   * quantity and the one the pre-M1f record was taken in.
   */
  readonly valveFirings: number
  /** The largest `carBlockedTicks` any car ever reached — from BOOT. */
  readonly worstWait: number
  /** `H_ROUTES_REFUSED` at the end of the run. */
  readonly routesRefused: number
  /** Sum of `refusalsByCell`; equals `blockedCarTicks` by construction. */
  readonly refusals: number
  /** Sum of `junctionRefusalsByCell`. */
  readonly junctionRefusals: number
  /** Refusals landing on a cell that is a junction at that moment, any cause. */
  readonly refusalsOnJunctionCells: number
  /** First tick a `CENSUS_CO_PRESENCE` event fired, or -1. */
  readonly firstConflictTick: number
  /** First tick a `CENSUS_RULE_VISIBLE` event fired, or -1. */
  readonly firstRuleEventTick: number
  /** Per-cell `CENSUS_CO_PRESENCE` tally. */
  readonly conflictsByCell: Int32Array
  /** Per-cell `CENSUS_RULE_VISIBLE` tally. */
  readonly ruleEventsByCell: Int32Array
  /** Refusals whose replayed slots were BOTH free. Must be 0 under every rule. */
  readonly refusalMisses: number
  /** Ordinary grants whose replayed OWN lane was taken. Must be 0 under every rule. */
  readonly grantMisses: number
  /**
   * Ordinary grants into a junction whose OTHER lane was taken — i.e. crossings
   * the wide rule would have refused and this rule admitted.
   *
   * **Rule-specific by design, and that is why it is a count rather than a
   * miss.** Under Task 2's wide rule it is 0 by construction. Under the
   * rule-disabled control and under any narrowing of the clause it is the size
   * of the relaxation, measured directly, and it is the cheapest single number
   * that says whether a candidate rule is the wide one wearing a new name.
   */
  readonly grantsWithOtherLaneTaken: number
  /** Ticks a saturated car failed to cross — the `REFUSED_GHOST` hole. Must be 0. */
  readonly saturatedStalls: number
  /**
   * Entry refusals inside the layout's own warm start, which every other figure
   * here excludes.
   *
   * **`constants.ts`'s evidence table counts the demo board from BOOT and this
   * rig counts from the first frame**, and on that board the two differ by this
   * number. On the city they coincide, because the warm start lays no road.
   * Reported rather than folded in: two quantities under one column heading is
   * how that table was wrong once already.
   */
  readonly warmStartRefusals: number
  /** The board's width, so a caller can name a cell without re-deriving it. */
  readonly w: number
  /** The board's cell count. */
  readonly cells: number
}

interface Boot {
  readonly state: GameState
  readonly world: WorldData
  readonly drive: (actions: readonly TickAction[] | undefined) => void
  /** `H_TICK` at boot, before the warm start. Always 0 today; read, not assumed. */
  readonly bootTick: number
  /** The layout's own warm start, driven by the caller so it can be accounted for. */
  readonly warmStartTicks: number
}

const NO_ACTIONS: readonly TickAction[] = Object.freeze([])

function boot(layoutId: string): Boot {
  const layout = layoutFor(layoutId)
  const map = layout.map()
  const world = createWorld(map)
  const state = createState(layout.runSeed, map)
  const scratch = createScratch(
    world.cells,
    map.groupCount,
    map.maxDestinations,
    createFieldInputRanges(map),
  )
  const fields = createFlowFields(map.groupCount, world.cells)
  layout.seed(state, world)
  // Reassigned, never mutated in place. **The warm start is driven by the
  // CALLER rather than here**, so the ticks inside it can be accounted for
  // separately: `constants.ts`'s evidence table counts the demo board's
  // refusals from BOOT and this rig's headline figures count them from the
  // first frame, and the two differ by exactly the warm start. Omitting the
  // warm start altogether is how the closing sweep's rig came back with 23,935
  // ticks against a recorded 31,456.
  const oneTick: { actions: readonly TickAction[] } = { actions: NO_ACTIONS }
  return {
    state,
    world,
    bootTick: state.header[H_TICK] as number,
    warmStartTicks: layout.warmStartTicks,
    drive(actions) {
      oneTick.actions = actions ?? NO_ACTIONS
      step(state, world, fields, scratch, oneTick)
      oneTick.actions = NO_ACTIONS
    },
  }
}

/**
 * The occupancy replay's view of the world: the two regions `releaseCell`,
 * `claimCell` and `junctionAdmitsOne` read, and nothing else.
 *
 * A structural shim rather than a second `GameState`: those three functions are
 * the production owners of the two occupancy lifecycle events and of the
 * junction predicate, and handing them a rig-owned `occupancy` view is what
 * makes the replay use production code instead of a copy of it. `roads` is the
 * REAL post-tick region — road bits change only at the top of a tick, so their
 * value during `runMovement` is the post-tick one.
 */
function occupancyShim(occupancy: Int16Array, roads: GameState['roads']): GameState {
  return { occupancy, roads } as unknown as GameState
}

function driveArm(arm: JunctionArm): JunctionArmRun {
  const city = arm === 'city-greedy'
  const { state, world, drive, bootTick, warmStartTicks } = boot(
    city ? DEFAULT_LAYOUT_ID : DEMO_LAYOUT_ID,
  )
  const startTick = bootTick + warmStartTicks
  const endHorizon = city
    ? startTick + CITY_HORIZON_WEEKS * TICKS_PER_WEEK
    : startTick + DEMO_HORIZON_TICKS
  const queueSample = city ? CITY_QUEUE_SAMPLE : DEMO_QUEUE_SAMPLE

  const carCount = state.carPhase.length
  const cells = world.cells
  const preCell = new Int32Array(carCount)
  const preBlocked = new Int32Array(carCount)
  const preInFlight = new Uint8Array(carCount)
  const occPre = new Int16Array(state.occupancy.length)
  const occWork = new Int16Array(state.occupancy.length)
  const shim = occupancyShim(occWork, state.roads)

  const refusalsByCell = new Int32Array(cells)
  const junctionRefusalsByCell = new Int32Array(cells)
  const conflictsByCell = new Int32Array(cells)
  const ruleEventsByCell = new Int32Array(cells)
  const coPrev = censusPrev(world)
  const rulePrev = censusPrev(world)

  const openingActions: TickAction[] = []
  for (const stroke of CITY_OPENING) openingActions.push(...armPathActions(stroke))
  const tally = { unaffordable: 0 }

  let deathTick = -1
  let refusals = 0
  let junctionRefusals = 0
  let refusalsOnJunctionCells = 0
  let ticksWithBlockedCar = 0
  let valveFirings = 0
  let worstWait = 0
  let peakQueue = 0
  let conflicts = 0
  let ruleEvents = 0
  let firstConflictTick = -1
  let firstRuleEventTick = -1
  let refusalMisses = 0
  let finalTickRefusals = 0
  let grantMisses = 0
  let grantsWithOtherLaneTaken = 0
  let saturatedStalls = 0
  let ticksDriven = 0
  let warmStartRefusals = 0

  for (let tick = bootTick + 1; tick <= endHorizon; tick++) {
    const warming = tick <= startTick
    for (let c = 0; c < carCount; c++) {
      preCell[c] = state.carCell[c] as number
      preBlocked[c] = state.carBlockedTicks[c] as number
      const phase = state.carPhase[c] as number
      // **The in-flight gate is not defensive tidying — without it the spawner
      // fabricates crossings.** `placeHouse` (buildings.ts) writes `carCell` for
      // a brand-new car slot, which reads as a jump from cell 0 to the house
      // cell in the pre/post comparison below. Movement is the only thing that
      // can move a car that was already OUTBOUND or RETURNING, and a car
      // dispatched THIS tick cannot cross on it: `runDispatch` writes
      // `carProgress = 0` and one tick of speed is far below the smallest edge
      // threshold, so no crossing is lost by the gate.
      preInFlight[c] = phase === PHASE_OUTBOUND || phase === PHASE_RETURNING ? 1 : 0
    }
    occPre.set(state.occupancy)

    let actions: readonly TickAction[] | undefined
    if (city && !warming) {
      if (tick === startTick + 1) actions = openingActions
      else if (tick % GREEDY_PERIOD_TICKS === 0) actions = armGreedyActions(state, world, tally)
    }
    drive(actions)
    if (!warming) ticksDriven++

    // ---------------------------------------------------------------------
    // The occupancy replay. See the module comment: this is `runMovement`'s
    // ascending order, with the two production lifecycle events applied for
    // every car that crossed, so the two slot reads below are the ones
    // `canEnter` made.
    // ---------------------------------------------------------------------
    occWork.set(occPre)
    let blockedThisTick = false
    let refusalsThisTick = 0
    for (let c = 0; c < carCount; c++) {
      const post = state.carCell[c] as number
      const blocked = state.carBlockedTicks[c] as number
      if (blocked > worstWait) worstWait = blocked
      if (preInFlight[c] === 0) continue
      const moved = post !== (preCell[c] as number)
      const refused = !moved && blocked === (preBlocked[c] as number) + 1
      if (refused && warming) {
        // **The warm start is accounted for SEPARATELY rather than folded in,
        // and the reason is a defect this repo already had.** `constants.ts`'s
        // evidence table counts the demo board's entry refusals from BOOT —
        // 7,544 pre-M1f over 6,703 ticks — while every figure this rig reports
        // as a headline counts from the first frame, because that is the window
        // `demoLayout.test.ts`, `startingCity.test.ts` and `integration.test.ts`
        // all measure. On the city the two coincide (the warm start lays no road,
        // so nothing moves and nothing is refused); on the demo board they differ
        // by the whole 1,200-tick warm start, which is already busy. Two
        // quantities under one column heading is the catalogue's own entry, so
        // both are reported and each says which window it is over.
        warmStartRefusals++
        blockedThisTick = true
      } else if (refused) {
        // A refused car did not move and movement is the only phase that can
        // change its cursor, so its post-tick travel direction is the one it
        // was refused in. `travelDir` is `queueProbe.ts`'s, the function whose
        // agreement with `canEnter` is property-tested on every in-flight car
        // on every tick.
        const dir = travelDir(state, c)
        if (dir === NO_CROSSING) {
          throw new Error(
            `junctionArms: car ${c} was refused on tick ${tick} but has no travel direction — ` +
              'the refusal oracle and the probe disagree, which they cannot',
          )
        }
        const cell = stepCell(post, dir, world.w, world.h)
        if (cell < 0) {
          throw new Error(`junctionArms: car ${c} was refused into an off-board cell on tick ${tick}`)
        }
        const lane = LANE_OF_DIR[dir] as number
        const own = occupantOf(shim, cell, lane)
        const admitsOne = junctionAdmitsOne(shim, cell)
        const other = admitsOne ? occupantOf(shim, cell, otherLane(lane)) : FREE
        refusals++
        refusalsThisTick++
        refusalsByCell[cell] = (refusalsByCell[cell] as number) + 1
        if (admitsOne) refusalsOnJunctionCells++
        if (own === FREE && other !== FREE) {
          junctionRefusals++
          junctionRefusalsByCell[cell] = (junctionRefusalsByCell[cell] as number) + 1
        }
        if (own === FREE && other === FREE) refusalMisses++
        blockedThisTick = true
      } else if (moved) {
        const dir = dirBetween(preCell[c] as number, post, world.w, world.h)
        if (dir < 0) {
          throw new Error(
            `junctionArms: car ${c} moved from ${preCell[c]} to ${post} on tick ${tick}, which is ` +
              'not one step — the single-crossing invariant is what this rig rests on',
          )
        }
        if ((preBlocked[c] as number) >= MAX_BLOCKED_TICKS) {
          valveFirings++
        } else {
          const lane = LANE_OF_DIR[dir] as number
          const own = occupantOf(shim, post, lane)
          const other = junctionAdmitsOne(shim, post)
            ? occupantOf(shim, post, otherLane(lane))
            : FREE
          // The OWN lane must be free for every grant under every rule this
          // task considers — that clause predates M1f and no arm touches it. The
          // other lane is the rule under test, so it is counted, not asserted.
          if (own !== FREE) grantMisses++
          if (other !== FREE) grantsWithOtherLaneTaken++
        }
        releaseCell(shim, c, preCell[c] as number)
        claimCell(shim, c, post, dir)
      } else if ((preBlocked[c] as number) >= MAX_BLOCKED_TICKS) {
        // A saturated car is answered `ENTER_VALVE` and crosses. The one thing
        // that stops it is `REFUSED_GHOST`, which needs an erase; neither arm
        // erases. Counted rather than argued — a non-zero here means the
        // "a refusal is a rise in carBlockedTicks" oracle has a blind spot.
        const dir = travelDir(state, c)
        if (dir !== NO_CROSSING) saturatedStalls++
      }
    }
    if (blockedThisTick && !warming) ticksWithBlockedCar++
    if (!warming) finalTickRefusals = refusalsThisTick

    if (warming) {
      // The census and the queue probe are deliberately NOT run over the warm
      // start: both are compared against figures the other two drivers measure
      // from the first frame, and a rig that quietly widened their window would
      // disagree with them for a reason nothing in the output would name.
      if (isGameOver(state)) {
        deathTick = state.header[H_TICK] as number
        break
      }
      continue
    }
    const co = countJunctionConflicts(state, world, coPrev, CENSUS_CO_PRESENCE, conflictsByCell)
    if (co > 0 && firstConflictTick < 0) firstConflictTick = tick
    conflicts += co
    const rule = countJunctionConflicts(state, world, rulePrev, CENSUS_RULE_VISIBLE, ruleEventsByCell)
    if (rule > 0 && firstRuleEventTick < 0) firstRuleEventTick = tick
    ruleEvents += rule

    // `longestQueue` allocates, so it is sampled rather than run every tick on
    // the long arm. The rates are the ones each board's existing figures were
    // measured at: `startingCity.test.ts` samples the city every 10 ticks and
    // `demoLayout.test.ts` samples the demo board every tick.
    if (tick % queueSample === 0) {
      const q = longestQueue(state, world)
      if (q > peakQueue) peakQueue = q
    }

    if (isGameOver(state)) {
      deathTick = state.header[H_TICK] as number
      break
    }
  }

  return {
    deathTick,
    trips: state.header[H_SCORE] as number,
    blockedCarTicks: refusals,
    longestQueue: peakQueue,
    refusalsByCell,
    junctionRefusalsByCell,
    conflicts,
    ruleEvents,
    endTick: state.header[H_TICK] as number,
    ticksWithBlockedCar,
    finalTickRefusals,
    ticksDriven,
    valveFirings,
    worstWait,
    routesRefused: state.header[H_ROUTES_REFUSED] as number,
    refusals,
    junctionRefusals,
    refusalsOnJunctionCells,
    firstConflictTick,
    firstRuleEventTick,
    conflictsByCell,
    ruleEventsByCell,
    refusalMisses,
    grantMisses,
    grantsWithOtherLaneTaken,
    saturatedStalls,
    warmStartRefusals,
    w: world.w,
    cells,
  }
}

/**
 * Memoised at module scope. The sim is deterministic, so this is memoisation
 * and not sampling — and every caller must warm it in a `beforeAll`, or the
 * first case to ask pays for a whole arm against vitest's per-case budget.
 */
const runs = new Map<JunctionArm, JunctionArmRun>()

export function runJunctionArm(arm: JunctionArm): JunctionArmRun {
  const cached = runs.get(arm)
  if (cached !== undefined) return cached
  const fresh = driveArm(arm)
  runs.set(arm, fresh)
  return fresh
}

/** A state and world pair, detached from the run that produced them. */
export interface Snapshot {
  readonly state: GameState
  readonly world: WorldData
}

/**
 * **ONE replay pass, many snapshots.** The site survey asks the same predicate
 * about several cells at each of several ticks; the previous draft put
 * `replayTo(tick)` inside the cell loop, where it does not depend on the cell,
 * and 12-24 full replays of a ~21,700-tick arm at 3.5-4.8 s each would have
 * timed out against vitest's 5,000 ms default. The cheapest exit from that
 * timeout is to cut the boundary list or the hot-cell set, which is the
 * criterion quietly weakening itself.
 *
 * Each snapshot is a detached copy of the state buffer (`snapshot` + `restore`),
 * so a caller may hold all of them at once and they cannot alias the run.
 */
export function replayCapturing(
  arm: JunctionArm,
  ticks: readonly number[],
): Map<number, Snapshot> {
  const city = arm === 'city-greedy'
  const { state, world, drive, bootTick, warmStartTicks } = boot(
    city ? DEFAULT_LAYOUT_ID : DEMO_LAYOUT_ID,
  )
  const startTick = bootTick + warmStartTicks
  const wanted = new Set<number>(ticks)
  let last = startTick
  for (const t of ticks) if (t > last) last = t
  const openingActions: TickAction[] = []
  for (const stroke of CITY_OPENING) openingActions.push(...armPathActions(stroke))
  const tally = { unaffordable: 0 }

  const out = new Map<number, Snapshot>()
  for (let tick = bootTick + 1; tick <= last; tick++) {
    let actions: readonly TickAction[] | undefined
    if (city && tick > startTick) {
      if (tick === startTick + 1) actions = openingActions
      else if (tick % GREEDY_PERIOD_TICKS === 0) actions = armGreedyActions(state, world, tally)
    }
    drive(actions)
    if (wanted.has(tick)) out.set(tick, { state: restore(snapshot(state), world), world })
    if (isGameOver(state)) break
  }
  return out
}

/**
 * Every cell carrying at least `percent` % of `tally`'s total, ordered by count
 * descending and cell ascending within a tie.
 *
 * **A cell with a zero tally is never included, whatever `percent` is**, so
 * `percent = 0` means "every cell that carried anything at all" rather than
 * "every cell on the board". Both readings are wanted — the criterion uses 5,
 * the distribution cross-check uses 0 — and the zero guard is what keeps the
 * second one from returning 960 cells of nothing.
 *
 * The tie-break is explicit for `censusCellTable`'s reason: `Array.sort` is only
 * stable within equal keys, so leaving ties to input order would make the table
 * a property of the cell loop rather than of the run.
 */
export function cellsCarryingAtLeast(tally: Int32Array, percent: number): number[] {
  let total = 0
  for (let cell = 0; cell < tally.length; cell++) total += tally[cell] as number
  if (total === 0) return []
  const rows: [number, number][] = []
  for (let cell = 0; cell < tally.length; cell++) {
    const n = tally[cell] as number
    if (n > 0 && n * 100 >= total * percent) rows.push([cell, n])
  }
  rows.sort((a, b) => b[1] - a[1] || a[0] - b[0])
  return rows.map(([cell]) => cell)
}

/** `(x,y)` for a cell, the notation every table in this milestone uses. */
export function cellName(cell: number, w: number): string {
  return `(${cell % w},${Math.floor(cell / w)})`
}

/** The whole distribution, descending, with each cell's share — for the report. */
export function distributionTable(tally: Int32Array, w: number, top = 20): string[] {
  let total = 0
  for (let cell = 0; cell < tally.length; cell++) total += tally[cell] as number
  const rows: [number, number][] = []
  for (let cell = 0; cell < tally.length; cell++) {
    const n = tally[cell] as number
    if (n > 0) rows.push([cell, n])
  }
  rows.sort((a, b) => b[1] - a[1] || a[0] - b[0])
  return rows
    .slice(0, top)
    .map(
      ([cell, n]) =>
        `${cellName(cell, w)} cell=${cell} n=${n} ${((100 * n) / (total || 1)).toFixed(1)}%`,
    )
}

/** In-flight cars, for a vacuity check on either board. */
export function inFlightCars(state: GameState): number {
  let n = 0
  for (let c = 0; c < state.carPhase.length; c++) {
    const phase = state.carPhase[c] as number
    if (phase === PHASE_OUTBOUND || phase === PHASE_RETURNING) n++
  }
  return n
}
