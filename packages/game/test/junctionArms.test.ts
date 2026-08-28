import { describe, it, expect, beforeAll } from 'vitest'
import {
  isJunctionCell,
  canPlaceUpgrade,
  applyPlaceUpgrade,
  H_INV_UPGRADES,
  H_UPGRADE_COUNT,
} from '@laneways/sim'
import { MAX_UPGRADES } from '@laneways/shared'
import { CITY_DEATH_TICK, DEMO_DEATH_TICK } from './deathTicks'
import {
  cellName,
  cellsCarryingAtLeast,
  distributionTable,
  replayCapturing,
  runJunctionArm,
  SHIPPED_ARM,
} from './junctionArms'
import { GREEDY_PERIOD_TICKS } from './cityArms'
import { formatUpgradeRows, runUpgradeArm } from './junctionArms'

/**
 * **M1f Task 3's triage, as tests: the criterion, the site survey and the
 * efficacy gate.**
 *
 * ---------------------------------------------------------------------------
 * THE THREE ARMS, AND WHY ONLY ONE OF THEM CAN BE A TEST
 * ---------------------------------------------------------------------------
 *
 * Task 3 chose between three candidate junction rules: **A** the wide rule Task
 * 2 shipped plus a demo layout change, **B** crossing conflicts only, and **C** a
 * relief-driven harness repair, which the brief disqualifies because the only
 * relief that exists is Task 9's junction upgrade and a Task 3 that depends on
 * Task 9 is the fork being discovered inside Task 9.
 *
 * A rule is compiled into `canEnter`, so only one of them exists in any tree.
 * The other two were measured the way Step 2 and Step 3b both specify — a
 * committed-then-reverted edit driven by `junctionArms.ts`, one sitting per
 * rule, so the difference between two rules cannot be a difference between two
 * rigs. **What can live in the suite is the criterion applied to the arm that
 * ships**; the other two columns are recorded here and in the task report.
 *
 * ```
 *   shipped city, greedy arm      rule disabled   A/C (wide)   B (crossing, ships)
 *   death tick                           31,456       21,704               21,783
 *   completed trips                         747          344                  368
 *   blocked car-ticks                     2,120       45,986               29,267
 *   ticks with a blocked car              6.2 %       26.2 %               22.3 %
 *   valve firings                             0           15                    5
 *   worst carBlockedTicks                    32        1,350                1,350
 *   longest queue                             4            7                    8
 *   H_ROUTES_REFUSED                          0            0                    0
 *   junction-caused refusals                  0       18,458                6,536
 *   ...as a share of blocking              0.0 %       40.1 %               22.3 %
 *   refusals landing on a junction         42.1 %      76.6 %               60.6 %
 *   co-presence census / first tick     232/15,001    11/17,658           42/15,001
 *   rule-visible census / first tick    538/10,207    44/10,207          133/10,207
 *
 *   demo board, no input
 *   death tick                            6,703        5,757                6,660
 *   completed trips                         420          105                  410
 *   blocked car-ticks                     6,676       97,138               12,364
 *   longest queue                             7           17                   10
 *   valve firings                             0           22                    0
 * ```
 *
 * **The rule-disabled column reproduces the record exactly** — 31,456 / 747 /
 * 2,120 / 0, and both censuses at 232 / 15,001 / six cells and 538 / 10,207 /
 * six cells. That is Step 2's reproduce-before-you-contradict step, and it is
 * the reason anything else this rig says is worth reading.
 *
 * ---------------------------------------------------------------------------
 * THE SEVEN CRITERIA, WRITTEN BEFORE THE MEASUREMENT, AND WHERE EACH LIVES
 * ---------------------------------------------------------------------------
 *
 *   1. the demo rig has 10 % of margin — `demoAllocation.test.ts`, asserted at
 *      the knobs (10.5 %);
 *   2. the city board still has the problem, >= 10x pre-M1f's 2,120 — here
 *      (13.8x);
 *   3. the demo board still has load, queue >= 4 and >= 200 trips — here
 *      (10 and 410);
 *   4. at least three junction-ELIGIBLE cells each carry >= 5 % of the
 *      junction-caused refusals — here (three, at 39.5 / 36.4 / 21.7 %);
 *   5. no golden moves — the nine golden assertions, all green;
 *   6. the site survey — here;
 *   7. the efficacy check — measured by a committed-then-reverted exemption,
 *      recorded below.
 */

/**
 * **STEP 3b, THE EFFICACY CHECK: measured, not asserted, and here is why.**
 *
 * The gate is *"exempting the junction rule at the junction-eligible hot cells
 * beats the same arm with no exemption, on trips, by at least 25 %"* — a margin
 * stated before the run. Exempting a cell means `junctionAdmitsOne` returning
 * false there, which is compiled code, so this is a committed-then-reverted
 * probe in exactly the shape Step 2 uses and not a runtime switch (Decision 3
 * declined that and the reason still holds). One sitting, one rig, one tree,
 * three exemption sets selected by an environment variable read inside the
 * probe:
 *
 * ```
 *   exemption                                  trips   blocked   death    valves
 *   none (the control)                           368    29,267  21,783         5
 *   the two highest-ranked hot cells             679    25,802  30,709         6
 *   all three junction-eligible hot cells        759     2,298  31,761         0
 *   all five cells the rule ever fires on        747     2,120  31,456         0
 * ```
 *
 * **The all-cells row beats the control by 106.3 %, against a margin of 25 %
 * stated before the run.** The gate passes, and the answer is not close.
 *
 * Three things worth reading rather than absorbing:
 *
 *   - **The last row reproduces the pre-M1f board to the digit** — 747 trips,
 *     2,120 blocked car-ticks, tick 31,456 — which is the plan's claim that a
 *     junction upgrade on the cells the rule fires on gives the whole board
 *     back, confirmed on this tree rather than quoted from the spike.
 *   - **The two-cell row does NOT reproduce the spike's +7.1 %**; it measures
 *     +84.5 %. The spike ranked its cells by TOTAL refusals and this ranks by
 *     junction-caused ones, so "the two highest-ranked" is a different pair.
 *   - **The all-cells row is 759, slightly ABOVE the spike's 750 ceiling**, and
 *     the spike's 750 was measured by exempting six cells of which two can
 *     never be seated. So the reachable ceiling was never bracketed by
 *     `[394, 750]`; it is 759 with three seatable cells, and Task 9 Step 11
 *     refines it per cell.
 *
 * It is recorded here rather than in the report alone because the report is not
 * an artefact the next task greps. The rig that produced it is
 * `runJunctionArm(SHIPPED_ARM)` on a tree with `junctionAdmitsOne` reading
 * `isJunctionCell(state, cell) && !HOT_CELLS.has(cell)`; restoring it was
 * `git checkout -- packages/sim/src/graph.ts` chained with the `git status`
 * check, from the repo root.
 */

/**
 * The four week boundaries a relief card could arrive on, and a WINDOW around
 * each rather than the tick itself.
 *
 * The greedy connector fires every `GREEDY_PERIOD_TICKS`, so whether a junction
 * exists exactly ON a boundary is a metronome artefact rather than a board
 * property — the previous draft of this survey sampled the boundary tick alone
 * and would have reported "no legal site at boundary 1" for a reason that is an
 * accident of the connector's clock.
 */
const BOUNDARIES = [4500, 9000, 13500, 18000] as const
const WINDOW = [0, GREEDY_PERIOD_TICKS, 2 * GREEDY_PERIOD_TICKS, 3 * GREEDY_PERIOD_TICKS] as const
const SAMPLES = BOUNDARIES.flatMap((b) => WINDOW.map((w) => b + w))

/**
 * **Derived, and the derivation is here because the previous draft's version of
 * this step would have timed out.** It put `replayTo(tick)` inside the cell
 * loop, where it does not depend on the cell: 3-6 hot cells x 4 boundaries is
 * 12-24 full replays of a ~21,700-tick arm at 3.5-4.8 s each, against vitest's
 * 5,000 ms default — and the cheapest exit from that timeout is to cut the
 * boundary list or the hot-cell set, which is the criterion quietly weakening
 * itself.
 *
 * What this case actually costs, measured on this tree: the shipped arm is
 * **3.8-4.5 s** and the single snapshotting replay pass to tick 18,090 is
 * **0.16-0.20 s**. The `beforeAll` below warms the arm, so the case normally
 * pays only the replay — but a `-t` run of this case alone pays both, which is
 * the case the budget has to cover. Two arms plus headroom: 2 x 4.5 s x 3.3.
 */
const SURVEY_TIMEOUT_MS = 30_000

/**
 * **Derived.** Each `runUpgradeArm` row measures 0.36-0.60 s on this tree (the
 * occupancy replay is absent, which is where `runJunctionArm`'s 3.8-4.5 s goes);
 * the heaviest case below drives 14 of them, and the `beforeAll` warms the
 * memoised arm so no case pays for it. 14 x 0.6 s is 8.4 s; 60 s is that plus
 * headroom for the `-t` run of one case on a machine under a mutation battery,
 * which is the busiest this tree ever is.
 */
const UPGRADE_TIMEOUT_MS = 60_000

/** Pre-M1f blocked car-ticks on the shipped seed's greedy arm — criterion 2's base. */
const PRE_M1F_BLOCKED_CAR_TICKS = 2120

describe('M1f Task 3: the junction triage, applied to the arm that ships', () => {
  /**
   * **Warms both memoised arms, so no CASE pays for a drive.** `runJunctionArm`
   * memoises at module scope; without this the first case to ask would pay
   * ~4 s of it against vitest's per-case budget, and which case that is depends
   * on file order.
   */
  beforeAll(() => {
    runJunctionArm('city-greedy')
    runJunctionArm('demo-no-input')
  }, 120_000)

  it('is an instrument before it is a measurement: the replay agrees with canEnter', () => {
    // **The rig attributes every refusal to a cell and a cause by replaying the
    // pre-tick occupancy array forward with the production lifecycle events, in
    // `runMovement`'s ascending order. These three counters are what say the
    // replay is right**, and they are checked against `canEnter`'s own decision
    // for every car on every tick of both arms rather than against hand-built
    // numbers — which is the prescription the queue-probe entry in the
    // catalogue ends with, after that probe shipped a 5.7-15.2 % disagreement.
    for (const arm of ['city-greedy', 'demo-no-input'] as const) {
      const r = runJunctionArm(arm)
      expect(r.refusalMisses, `${arm}: a refused car found both slots free`).toBe(0)
      expect(r.grantMisses, `${arm}: an ordinary grant found its own lane taken`).toBe(0)
      expect(r.saturatedStalls, `${arm}: a saturated car did not cross, so the valve did not fire`).toBe(0)
      // Vacuity: the invariants above are trivially true over an empty set.
      expect(r.blockedCarTicks, `${arm}: nothing was ever refused`).toBeGreaterThan(1000)
      expect(r.ticksDriven, `${arm}: nothing was ever driven`).toBeGreaterThan(4000)
    }
  })

  it('reproduces the figures the other two drivers assert, so the rig is not a third opinion', () => {
    // `startingCity.test.ts` drives `step` by hand and `integration.test.ts`
    // drives `createGame`'s frame loop. This is a third driver and it must agree
    // with both before anything it says alone is worth reading — the
    // reproduce-before-you-contradict rule applied to my own new rig, which is
    // the step that caught the closing sweep's harness on the last milestone.
    const city = runJunctionArm('city-greedy')
    expect(city.deathTick, 'the shipped arm dies here').toBe(21783)
    expect(city.trips).toBe(368)
    expect(city.blockedCarTicks).toBe(29267)
    expect(city.valveFirings).toBe(5)
    expect(city.worstWait).toBe(1350)
    expect(city.routesRefused, 'and routing still refuses nothing').toBe(0)
    // **The size of the narrowing itself, and it is asserted because three
    // source files quote it** — `blocking.ts` twice, `integration.test.ts` and
    // `blocking.test.ts` once each — and a figure nothing runs is a figure that
    // comes back. These are the entries into a junction whose other lane was
    // occupied on a NON-crossing axis: every crossing Task 2's wide rule refused
    // and this one admits, turning occupants included.
    expect(city.ticksDriven, 'ticks driven after the warm start').toBe(21525)
    // The reconciliation constant `integration.test.ts`'s per-week row rests on.
    expect(city.ticksWithBlockedCar, 'including the death tick — the per-week row says 4,797').toBe(4798)
    expect(city.finalTickRefusals, 'because eight cars are blocked on the tick it ends').toBe(8)
    expect(
      city.grantsWithOtherLaneTaken,
      'the whole of the narrowing on THIS arm, in crossings — the demo board is 163',
    ).toBe(43)
    expect(city.warmStartRefusals, 'the city warm start lays no road, so nothing is refused').toBe(0)
    expect(city.conflicts, 'co-presence census').toBe(42)
    expect(city.ruleEvents, 'rule-visible census').toBe(133)
    expect(city.firstRuleEventTick).toBe(10207)

    const demo = runJunctionArm('demo-no-input')
    expect(demo.deathTick, 'and the demo board is deathTicks.ts’s constant').toBe(DEMO_DEATH_TICK)
    expect(demo.deathTick).toBe(6660)
    expect(demo.trips).toBe(410)
    expect(demo.blockedCarTicks).toBe(12364)
    // The demo board's warm start is 1,200 busy ticks, so the boot-inclusive
    // figure `constants.ts` carries is this much larger. Both windows asserted,
    // because the two tables disagree about which one they mean and that
    // ambiguity was a real defect in that table once.
    expect(demo.warmStartRefusals, 'and the demo warm start is already busy').toBe(1463)
    // **The narrowing on the board a person opens, which is the count that
    // bounds what a human sees.** `blocking.ts` quotes both figures and names
    // the board for each; the city's 43 alone was quoted bare once and read as
    // if it covered both.
    expect(demo.grantsWithOtherLaneTaken, 'the narrowing on the demo board').toBe(163)
    expect(demo.finalTickRefusals, 'two cars are still standing when the demo board dies').toBe(2)
    expect(
      demo.blockedCarTicks + demo.warmStartRefusals,
      'from boot, which is MAX_BLOCKED_TICKS’s evidence table’s convention',
    ).toBe(13827)
    // The city's no-input death tick is unmoved by either M1f rule and is
    // asserted where it is derived; named here so the two constants cannot be
    // confused for one another in this file's table.
    expect(CITY_DEATH_TICK, 'unmoved by both M1f rules — see deathTicks.ts').toBe(5580)
  })

  it('CRITERION 2: the city board still has the problem, at least 10x pre-M1f', () => {
    // **A survivability criterion with no load floor is satisfiable by deleting
    // the difficulty**, so the triage's criteria 2 and 3 are load floors and
    // this is the city half. The narrowed rule must not be so narrow that it is
    // the pre-M1f board wearing a new name.
    const city = runJunctionArm('city-greedy')
    expect(
      city.blockedCarTicks / PRE_M1F_BLOCKED_CAR_TICKS,
      'blocked car-ticks against the pre-M1f 2,120',
    ).toBeGreaterThanOrEqual(10)
    expect(city.blockedCarTicks / PRE_M1F_BLOCKED_CAR_TICKS).toBeCloseTo(13.8, 1)
  })

  it('CRITERION 3: the demo board still has load — queue and completed trips', () => {
    // The demo half of the same floor, on the repaired probe. **The trips floor
    // is what stops "the board is quiet" being read as "the board is fine"**:
    // Task 2's wide rule left this board at 105 trips, which passes a queue
    // floor and fails a throughput one.
    const demo = runJunctionArm('demo-no-input')
    expect(demo.longestQueue, 'cars really do stand behind each other').toBeGreaterThanOrEqual(4)
    expect(demo.trips, 'and the board still delivers').toBeGreaterThanOrEqual(200)
    expect(demo.longestQueue).toBe(10)
    expect(demo.trips).toBe(410)
  })

  it(
    'CRITERION 4 and 6: every junction-eligible hot cell can take an upgrade in some boundary window, and here is the table',
    () => {
      const run = runJunctionArm(SHIPPED_ARM)

      // **(b) JUNCTION-CAUSED refusals, not total.** An upgrade can only ever
      // remove a refusal whose cause was the junction clause, and spillback onto
      // degree <= 2 cells is not one. Ranking by the total nominates cells no
      // object can be placed on: on this arm `(13,18)` carries **19.5 %** of all
      // refusals and is never a junction at any tick, and `(11,20)` at 11.0 % is
      // the same. The previous draft of this criterion said "if any hot cell
      // accepts at zero boundaries, stop and report", so it would have halted
      // the milestone on two cells that were never candidates.
      const hot = cellsCarryingAtLeast(run.junctionRefusalsByCell, 5)
      expect(hot.length, 'the effect is concentrated (criterion 4)').toBeGreaterThanOrEqual(3)

      // The share, pinned, so the criterion cannot be satisfied by a board where
      // the rule does nothing. Reproduce: 6,536 / 29,267 = 22.3 %.
      const share = (1000 * run.junctionRefusals) / run.blockedCarTicks
      expect(share, 'junction-caused refusals as a share of all blocking').toBeGreaterThan(100)
      expect(share / 10, 'and the figure, so a drift is legible').toBeCloseTo(22.3, 1)

      // **(c) ONE replay pass, snapshotting at every sample tick.** See
      // `SURVEY_TIMEOUT_MS`.
      const snaps = replayCapturing(SHIPPED_ARM, SAMPLES)
      expect(snaps.size, 'every sample tick was captured').toBe(SAMPLES.length)

      const table: string[] = []
      // **(d) SITES per boundary, not only acceptance per cell**: this is the
      // number that bounds how much relief a player can seat, and the plan
      // predicted 0 / 2 / 6 / 6.
      //
      // **These were UPPER BOUNDS on the seatable sites when Task 3 wrote them,
      // and M1f Task 9 Step 5 turned them into COUNTS.** Task 3's predicate here
      // is `isJunctionCell` plus a bounds check, which is deliberately the DEGREE
      // half of `canPlaceUpgrade`'s five refusals; the other four — no-inventory,
      // capacity, off-board, occupied — are the player's ledger and bookkeeping
      // rather than board properties, and Task 3 could not exercise them because
      // neither `canPlaceUpgrade` nor an inventory existed. **The case below,
      // *"the REAL predicate agrees with Task 3s cell-for-cell"*, re-runs this
      // table through `canPlaceUpgrade` over all 16 sample ticks x 960 cells with
      // ZERO disagreements, gets the same 1 / 2 / 6 / 6, and exercises all four
      // of the remaining refusals on this board.** So these numbers are exact for
      // a player holding at least one upgrade and below the cap — and 0 / 0 / 0 / 0
      // for a player holding none, which is the same timing finding read off the
      // other axis. This test is kept as Task 3's own instrument rather than
      // rewritten: the two predicates agreeing is the evidence, and it needs
      // both.
      const sitesPerBoundary: number[] = []
      for (const b of BOUNDARIES) {
        const sites = new Set<number>()
        for (const w of WINDOW) {
          const snap = snaps.get(b + w)
          if (snap === undefined) continue
          for (let cell = 0; cell < snap.world.cells; cell++) {
            if (isJunctionCell(snap.state, cell)) sites.add(cell)
          }
        }
        sitesPerBoundary.push(sites.size)
        table.push(
          `boundary ${b}: distinct legal sites in window = ${sites.size} ` +
            `[${[...sites].sort((x, y) => x - y).map((c) => cellName(c, run.w)).join(' ')}]`,
        )
      }

      for (const cell of hot) {
        const accepts = SAMPLES.filter((t) => {
          const snap = snaps.get(t)
          return (
            snap !== undefined && cell >= 0 && cell < snap.world.cells && isJunctionCell(snap.state, cell)
          )
        })
        table.push(
          `${cellName(cell, run.w)} cell=${cell} junctionRefusals=${run.junctionRefusalsByCell[cell]} ` +
            `total=${run.refusalsByCell[cell]} accepts=[${accepts}]`,
        )
      }
      table.push('-- junction-caused refusals, descending --', ...distributionTable(run.junctionRefusalsByCell, run.w))
      table.push('-- ALL refusals, descending --', ...distributionTable(run.refusalsByCell, run.w))
      // Printed, not summarised: the previous milestone's shape died of a
      // one-number answer to this exact question.
      console.log(table.join('\n'))

      // **The measured site counts are 1 / 2 / 6 / 6, not the plan's 0 / 2 / 6 /
      // 6, and the difference is the whole reason the window exists.** The plan
      // said the board's first junction is born at tick 4,530 — thirty ticks
      // after the first boundary — and a boundary-tick sample would have
      // reported zero. Measured, `(8,23)` is already a junction AT 4,500, so the
      // count is one even before the window helps; the window is still what
      // makes the answer a board property rather than a metronome artefact, and
      // it is what turns boundary 2's answer from a coin flip into a 2.
      expect(
        sitesPerBoundary,
        'distinct legal sites per boundary window — an UPPER bound; see above',
      ).toEqual([1, 2, 6, 6])

      // **The criterion the roundabout failed.** If a junction-eligible hot cell
      // accepts in zero windows, stop and report — an early card would have to
      // be held forever rather than merely held, and the dossier's Inventory
      // section only licenses the latter (see the citation below).
      const seatable = hot.filter((cell) =>
        SAMPLES.some((t) => {
          const snap = snaps.get(t)
          return snap !== undefined && isJunctionCell(snap.state, cell)
        }),
      )
      // **The brief's snippet asserted `>= 4` here and that is unsatisfiable
      // under its own fix (b), which is a finding rather than a threshold to
      // meet.** The four it expected are the six cells carrying the most TOTAL
      // refusals minus the two that can never be seated — i.e. the ranking fix
      // (b) exists to replace. Ranked by junction-caused refusals at the 5 %
      // the criterion states, this board has THREE hot cells, which is exactly
      // criterion 4's own floor. The `>= 4` is left out and criterion 4's floor
      // is asserted instead; at a 2 % threshold there are four, and that figure
      // is recorded rather than adopted, because moving a threshold to reach a
      // number is the defect this whole step was rewritten to prevent.
      expect(seatable.length, 'every junction-eligible hot cell can be seated').toBeGreaterThanOrEqual(3)
      expect(
        seatable.length,
        'and the ranking did not smuggle in a cell that is never a junction',
      ).toBe(hot.length)
      expect(cellsCarryingAtLeast(run.junctionRefusalsByCell, 2).length, 'four at a 2 % threshold').toBe(4)

      // **The timing finding this survey exists to produce.** Not every hot cell
      // is a legal site at every boundary: `(12,19)` accepts from boundary 2 and
      // the other two only from boundary 3. So an early relief card must be
      // HELD, which the research dossier permits — §2.2 INVENTORY of
      // `docs/research/2026-08-02-original-game-research-dossier.md`, "Items sit
      // unplaced indefinitely" — and this is how long for. **Naming the document
      // is the correction, made at M1f Task 4**: a bare "§2.2" resolves in the
      // DESIGN SPEC to "Deferred", which is about expert mode and rail terrain.
      // The spec clause that does govern this mechanism is §5.10's "no skip, no
      // bank, no reroll", and it applies to the OFFER rather than to the item the
      // card grants — two different objects.
      const accepted = (cell: number, b: number): boolean =>
        WINDOW.some((w) => {
          const snap = snaps.get(b + w)
          return snap !== undefined && isJunctionCell(snap.state, cell)
        })
      expect(hot.every((cell) => !accepted(cell, 4500)), 'no hot cell is a site at boundary 1').toBe(true)
      expect(hot.filter((cell) => accepted(cell, 9000)).length, 'one of the three at boundary 2').toBe(1)
      expect(hot.every((cell) => accepted(cell, 13500)), 'and all three from boundary 3').toBe(true)
    },
    SURVEY_TIMEOUT_MS,
  )

  it(
    'M1f Task 9 Step 5: the REAL predicate agrees with Task 3s cell-for-cell, and the bound becomes a count',
    () => {
      // **Task 3 Step 3a could not call `canPlaceUpgrade` — it did not exist —
      // and used `isJunctionCell` plus a bounds check instead.** That
      // substitution is sound by inspection, and *"sound by inspection"* is what
      // this project's catalogue calls a claim, so it is checked here rather than
      // trusted across five tasks. The four refusals Task 3 could not exercise
      // are exercised too, at the bottom of this case.
      const run = runJunctionArm(SHIPPED_ARM)
      const snaps = replayCapturing(SHIPPED_ARM, SAMPLES)
      expect(snaps.size, 'every sample tick was captured').toBe(SAMPLES.length)

      // (a) AGREEMENT, cell for cell, tick for tick, with inventory and capacity
      // NEUTRALISED — one in hand, none placed, nothing on the board. Those two
      // refusals are a property of the player's ledger and not of the board, so
      // neutralising them is what isolates the question Task 3 was asking.
      let asked = 0
      let accepted = 0
      const disagreements: string[] = []
      for (const t of SAMPLES) {
        const snap = snaps.get(t)!
        snap.state.header[H_INV_UPGRADES] = 1
        snap.state.header[H_UPGRADE_COUNT] = 0
        for (let cell = 0; cell < snap.world.cells; cell++) {
          const task3 = isJunctionCell(snap.state, cell)
          const real = canPlaceUpgrade(snap.state, snap.world, cell).ok
          asked++
          if (real) accepted++
          if (task3 !== real) disagreements.push(`tick ${t} ${cellName(cell, run.w)}: ${task3} vs ${real}`)
        }
      }
      expect(asked, 'non-vacuous: 16 sample ticks x 960 cells').toBe(SAMPLES.length * run.cells)
      expect(accepted, 'and the predicate accepts SOMETHING, or agreement is trivial').toBeGreaterThan(0)
      expect(disagreements, "Task 3's predicate and canPlaceUpgrade disagree — see the report").toEqual([])

      // (b) The site table, RE-DERIVED through `canPlaceUpgrade` rather than
      // re-asserted. **This is where 1 / 2 / 6 / 6 stops being an upper bound**:
      // for a player holding at least one upgrade and below the cap, these are
      // the exact counts of legal sites, because the three remaining refusals
      // (off-board, not-a-junction, occupied) are all board properties and all
      // three are now the real function's.
      const sitesPerBoundary: number[] = []
      for (const b of BOUNDARIES) {
        const sites = new Set<number>()
        for (const w of WINDOW) {
          const snap = snaps.get(b + w)!
          for (let cell = 0; cell < snap.world.cells; cell++) {
            if (canPlaceUpgrade(snap.state, snap.world, cell).ok) sites.add(cell)
          }
        }
        sitesPerBoundary.push(sites.size)
      }
      expect(
        sitesPerBoundary,
        'legal sites per boundary window through the REAL predicate — a COUNT, not a bound',
      ).toEqual([1, 2, 6, 6])

      // (c) The four refusals Task 3 could not exercise, each on the real board
      // at the boundary-3 snapshot, where six sites exist. **This is what closes
      // M4 of Task 3's review**: the bound was a bound because these were
      // untested, not because they were suspected.
      const late = snaps.get(13500)!
      const site = [...Array(late.world.cells).keys()].find((c) => isJunctionCell(late.state, c))!
      const reasonAt = (cell: number): string => {
        const r = canPlaceUpgrade(late.state, late.world, cell)
        return r.ok ? 'ok' : r.reason
      }
      late.state.header[H_INV_UPGRADES] = 0
      late.state.header[H_UPGRADE_COUNT] = 0
      expect(reasonAt(site), 'a player holding nothing has no legal site anywhere').toBe('no-inventory')
      late.state.header[H_INV_UPGRADES] = 1
      late.state.header[H_UPGRADE_COUNT] = MAX_UPGRADES
      expect(reasonAt(site), 'and one at the cap has none either').toBe('capacity')
      late.state.header[H_UPGRADE_COUNT] = 0
      expect(reasonAt(late.world.cells), 'off-board').toBe('off-board')
      expect(reasonAt(site), 'and with the ledger clear the site is legal').toBe('ok')
      expect(applyPlaceUpgrade(late.state, late.world, site)).toBe(true)
      late.state.header[H_INV_UPGRADES] = 1
      expect(reasonAt(site), 'occupied, once something is on it').toBe('occupied')

      // And the count really did fall by one, on the real board: the site that
      // was legal is no longer offered, which is the half of "the bound is now a
      // count" that a cell-for-cell agreement cannot show.
      let stillLegal = 0
      for (let cell = 0; cell < late.world.cells; cell++) {
        if (canPlaceUpgrade(late.state, late.world, cell).ok) stillLegal++
      }
      let junctions = 0
      for (let cell = 0; cell < late.world.cells; cell++) if (isJunctionCell(late.state, cell)) junctions++
      expect(stillLegal, 'one fewer site than there are junctions, and it is the seated one').toBe(
        junctions - 1,
      )
    },
    SURVEY_TIMEOUT_MS,
  )

  it('the refusal distribution and the two conflict distributions name the same cells', () => {
    // **They measure different things and a divergence is information rather
    // than an error** — a conflict is a co-presence or a swap observed BETWEEN
    // ticks, and a refusal is what the rule does INSTEAD. Cross-checked here
    // because Step 3 asks for the answer in writing and an answer nothing runs
    // is an answer that goes stale.
    const run = runJunctionArm(SHIPPED_ARM)
    const junctionHot = new Set(cellsCarryingAtLeast(run.junctionRefusalsByCell, 0))
    const ruleCells = new Set(cellsCarryingAtLeast(run.ruleEventsByCell, 0))
    const coCells = new Set(cellsCarryingAtLeast(run.conflictsByCell, 0))

    // Five cells carry a junction-caused refusal; the rule-visible census names
    // the same five; co-presence names four of them, and it is a strict subset
    // for the structural reason `junctionCensus.ts` gives.
    expect([...junctionHot].sort((a, b) => a - b)).toEqual([422, 468, 512, 537, 560])
    expect([...ruleCells].sort((a, b) => a - b)).toEqual([422, 468, 512, 537, 560])
    for (const c of coCells) expect(ruleCells.has(c), `co-presence cell ${c} is not rule-visible`).toBe(true)
    expect(coCells.size, 'co-presence names one fewer').toBe(4)

    // The ORDER differs, and that is the information. Ranked by refusals the
    // busiest cell is (12,19); ranked by rule-visible events it is also (12,19);
    // ranked by co-presence it is (12,19) too — but the rankings below them
    // disagree, because a cell that refuses often is a cell where the rule
    // FIRES, while a census event is a cell where two cars got through.
    expect(cellsCarryingAtLeast(run.junctionRefusalsByCell, 0)[0], 'busiest by refusal').toBe(468)
    expect(cellsCarryingAtLeast(run.ruleEventsByCell, 0)[0], 'busiest by rule-visible event').toBe(468)
    expect(
      cellsCarryingAtLeast(run.junctionRefusalsByCell, 0),
      'and the orders are not the same list',
    ).not.toEqual(cellsCarryingAtLeast(run.ruleEventsByCell, 0))
  })
})

/**
 * **M1f Task 9 Step 11 — WHERE the upgrade goes, measured against a control
 * rather than against zero.**
 *
 * *"Does it help"* is already measured: Task 3 Step 3b exempted the junction
 * rule at these cells by a committed-then-reverted edit and got 759 trips
 * against 368. **The question this block asks is whether the PLACEMENT is a
 * real decision**, and the answer is that it is the whole decision — see the
 * table the case prints.
 *
 * **Two instruments, one answer, and that is the strongest thing here.** Task 3
 * measured the three-cell exemption by editing `junctionAdmitsOne` to consult a
 * hard-coded cell set and reverting it; this measures the same three cells by
 * placing three upgrades through `applyPlaceUpgrade` on a tick, driven by the
 * production `step`, with the rule untouched. They agree to the digit — **759
 * trips, 2,298 blocked car-ticks, death at 31,761** — which is what says the
 * shipped object does what the spike's edit stood in for.
 */
describe('M1f Task 9: one upgrade per junction-eligible jam cell, against the same run with none', () => {
  /**
   * The week-3 boundary. **Stated, and it is the only boundary that works**, for
   * two reasons that come from opposite directions and are both measured below:
   * the site survey says `(8,21)` and `(9,22)` are not junctions until boundary
   * 3, and the run dies at 21,783 — so by boundary 4 (18,000) there are 3,783
   * ticks left and the jam has already done its damage.
   */
  const SEAT_TICK = 13_500

  beforeAll(() => {
    runJunctionArm(SHIPPED_ARM)
  }, 120_000)

  it(
    'the control reproduces the memoised arm, so the two rigs are one instrument',
    () => {
      // `runUpgradeArm` drops the occupancy replay — an attribution instrument
      // that writes nothing — so a row costs a third of what `runJunctionArm`
      // costs. What must be identical is the INPUT, and this is what says it is
      // rather than the paragraph in the source that claims it.
      const arm = runJunctionArm(SHIPPED_ARM)
      const control = runUpgradeArm({ upgrades: [], seatTick: SEAT_TICK })
      expect(control.trips, 'trips').toBe(arm.trips)
      expect(control.deathTick, 'death tick').toBe(arm.deathTick)
      expect(control.blockedCarTicks, 'blocked car-ticks').toBe(arm.blockedCarTicks)
      expect(control.valveFirings, 'valve firings').toBe(arm.valveFirings)
      expect(control.longestQueue, 'longest queue').toBe(arm.longestQueue)
      expect(control.placed, 'a control places nothing and reports so vacuously').toBe(true)

      // And the inventory grant every arm pays is behaviour-free: three controls
      // seated at three different ticks are byte-identical at the end.
      const early = runUpgradeArm({ upgrades: [], seatTick: 9_000 })
      const late = runUpgradeArm({ upgrades: [], seatTick: 18_000 })
      expect(early.hash, 'the grant itself changes nothing, at any tick').toBe(control.hash)
      expect(late.hash).toBe(control.hash)
    },
    UPGRADE_TIMEOUT_MS,
  )

  it(
    'one upgrade per junction-eligible jam cell, each measured against the same run with none',
    () => {
      // **The metric is TRIPS.** An upgrade never makes a car wait, so blocked
      // car-ticks is a valid secondary read — but it is REPORTED, never
      // asserted, because a placement that improves it by killing the board
      // faster is not help.
      const arm = runJunctionArm(SHIPPED_ARM)
      const control = runUpgradeArm({ upgrades: [], seatTick: SEAT_TICK })

      // Ranked by JUNCTION-CAUSED refusals, not total: spillback lands on
      // degree <= 2 cells that can never be seated, and ranking by the total
      // names two of them in the top six on this board. Task 3 Step 3a owns that
      // finding, and Task 9 Step 5 above turned its bound into a count.
      const hot = cellsCarryingAtLeast(arm.junctionRefusalsByCell, 5)
      expect(hot.length, 'three junction-eligible hot cells, as Task 3 measured').toBe(3)

      const rows = hot.map((cell) => {
        const r = runUpgradeArm({ upgrades: [cell], seatTick: SEAT_TICK })
        expect(r.placed, `applyPlaceUpgrade refused at ${cellName(cell, arm.w)}`).toBe(true)
        return { cell, ...r }
      })

      // The board still has the problem, so a green result is not a green board:
      expect(control.blockedCarTicks, 'the control still jams').toBeGreaterThan(10000)

      // The object does SOMETHING. An upgrade that changed nothing anywhere would
      // mean `junctionAdmitsOne`'s clause is not reaching the movement path.
      expect(rows.some((r) => r.hash !== control.hash), 'at least one placement changes the run').toBe(
        true,
      )

      // **The object does something GOOD at its best cell.**
      const best = rows.reduce((m, r) => (r.trips > m.trips ? r : m))
      const worst = rows.reduce((m, r) => (r.trips < m.trips ? r : m))
      expect(best.trips, `best ${cellName(best.cell, arm.w)} vs control`).toBeGreaterThan(control.trips)

      // **THE SPREAD IS THE SECOND DECISION AND IT IS WHAT TASK 12 ASSERTS.** An
      // upgrade cannot make its own junction worse, so "does it help" is not the
      // interesting question; "does it matter WHERE" is. Measured: 755 at (9,22)
      // against 394 at (12,19), a spread of 91.6 % — and the threshold Task 12
      // uses is written from this table minus a stated margin (report §11).
      console.log(
        `spread: best ${cellName(best.cell, arm.w)} ${best.trips} / ` +
          `worst ${cellName(worst.cell, arm.w)} ${worst.trips} / control ${control.trips}`,
      )
      console.log(formatUpgradeRows(control, rows, arm.w))

      // **AND THE RANKING DOES NOT PREDICT THE PAYOFF, WHICH IS THE FINDING.**
      // `hot` is descending by junction-caused refusals, so `hot[0]` carries the
      // most (2,579, 39.5 %) and `hot[2]` the fewest (1,418, 21.7 %) — and the
      // LAST is the best placement by a factor of nearly two. A policy that
      // upgrades the cell with the most refusals buys +7.1 % where the right cell
      // buys +105.2 %. Task 12 must not assume the top-ranked cell is the site.
      expect(best.cell, 'the best placement is the LOWEST-ranked hot cell').toBe(hot[2])
      expect(worst.cell, 'and the worst is the highest-ranked').toBe(hot[0])

      // Reachability, because a placement that helps by disconnecting a
      // destination is not help. Measured as a graph question over `roads` — see
      // `reachableDestinations` — and compared against the control rather than
      // against a literal, because a longer run spawns more destinations.
      expect(control.reachableDestinations).toBe(control.destinations)
      for (const r of rows) {
        expect(r.reachableDestinations, `cell ${cellName(r.cell, arm.w)}`).toBe(r.destinations)
        expect(r.destinations, 'and relief never costs the board a destination').toBeGreaterThanOrEqual(
          control.destinations,
        )
      }

      // **How many rows are strictly WORSE than the control.** Not zero on
      // principle — an upgrade is a buff at its own cell but relief moves traffic
      // downstream, and the spike's eight-seed row contains a -5. Measured here:
      // 0 of 3, and that count is what Task 12 compares its larger population
      // against.
      const worseRows = rows.filter((r) => r.trips < control.trips)
      expect(worseRows.length, 'rows strictly worse than the control — see the report').toBe(0)
    },
    UPGRADE_TIMEOUT_MS,
  )

  it(
    'the three together reproduce Task 3s committed-then-reverted exemption to the digit',
    () => {
      // **Two instruments, one answer.** Task 3 measured this by editing
      // `junctionAdmitsOne` to read `isJunctionCell(state, cell) && !HOT.has(cell)`
      // on a committed tree and reverting it. This places three upgrades through
      // `applyPlaceUpgrade` on tick 13,500, with the rule untouched, driven by
      // the production `step`. The catalogue's *"two independent measurements
      // that share one wrong constant agree perfectly"* is the hazard, and these
      // two share no constant at all: one is a hard-coded cell set inside a
      // predicate, the other is three `TickAction`s.
      const arm = runJunctionArm(SHIPPED_ARM)
      const hot = cellsCarryingAtLeast(arm.junctionRefusalsByCell, 5)
      const all = runUpgradeArm({ upgrades: hot, seatTick: SEAT_TICK })
      expect(all.placed).toBe(true)
      expect(all.trips, "Task 3 Step 3b's 759").toBe(759)
      expect(all.blockedCarTicks, "Task 3 Step 3b's 2,298").toBe(2298)
      expect(all.deathTick, "Task 3 Step 3b's 31,761").toBe(31761)
      expect(all.valveFirings, 'and its zero valve firings').toBe(0)

      // And the third cell is free: `(12,19)` adds nothing on top of the other
      // two, which is the same inversion the per-cell table shows from the other
      // side. Reported as an assertion because it is what says the +7.1 % that
      // cell buys alone is not additive.
      const two = runUpgradeArm({ upgrades: [hot[1]!, hot[2]!], seatTick: SEAT_TICK })
      expect(two.trips, 'the top-ranked cell adds no trip to the other two').toBe(all.trips)
    },
    UPGRADE_TIMEOUT_MS,
  )

  it(
    'the delivery fraction the junction rule cost, restored by ONE upgrade — the step-driven half',
    () => {
      // **Task 3 left two allowances written to FAIL when the board is restored**
      // — `startingCity.test.ts`'s GATE B and `integration.test.ts`'s per-week
      // block, both `trips / fires < 0.9`, both saying in as many words that the
      // milestone still owed a restoration. Task 9 landed the MECHANISM and
      // deliberately no observability: nothing in `game/src` enqueued an
      // `'upgrade'`, so both arms still measured 0.891, both lines were green,
      // and neither was widened or deleted — a tripwire authored to fire at a
      // known moment must be removed AT that moment and not before. What was
      // wrong at both sites was the RECIPIENT, and that was corrected in place
      // to name Task 10.
      //
      // **M1f Task 10 landed the chip, the gesture and the marker, and BOTH
      // LINES ARE NOW DELETED** — not widened, and with 0.891 still pinned
      // exactly at each site as the control's measured value. The restored
      // `>= 0.9` gate lives on the arms that exercise the object: this one, and
      // `integration.test.ts`'s *"restores the delivery fraction the junction
      // rule cost"*, which reaches the same 0.973 through two taps on the
      // production pointer instead of through a seated `TickAction`.
      //
      // **Two instruments, one number**, which is the reason this case survives
      // its own tripwires rather than being deleted with them: a rig that seats
      // an action on tick 13,500 and a player who taps a chip at 8:56 produce
      // the same 755 trips, the same 31,672-tick death and the same 0.973.
      const arm = runJunctionArm(SHIPPED_ARM)
      const hot = cellsCarryingAtLeast(arm.junctionRefusalsByCell, 5)
      const control = runUpgradeArm({ upgrades: [], seatTick: SEAT_TICK })
      expect(control.deliveryFraction, "the control is Task 3's 0.891").toBeCloseTo(0.891, 3)
      expect(control.deliveryFraction, 'and it is BELOW the M1e gate — the allowance is honest').toBeLessThan(0.9)

      const best = runUpgradeArm({ upgrades: [hot[2]!], seatTick: SEAT_TICK })
      expect(best.deliveryFraction, 'one upgrade puts it back above the M1e gate').toBeGreaterThan(0.9)
      expect(best.deliveryFraction, 'measured — and 0.975 is the pre-M1f figure').toBeCloseTo(0.973, 3)
      expect(best.deliveryFraction, 'not all the way back, and that is the honest reading').toBeLessThan(0.975)
      console.log(
        `delivery fraction: control ${control.deliveryFraction.toFixed(3)} / ` +
          `one upgrade at ${cellName(hot[2]!, arm.w)} ${best.deliveryFraction.toFixed(3)} — ` +
          'the two `< 0.9` tripwires were deleted at Task 10, not widened',
      )
    },
    UPGRADE_TIMEOUT_MS,
  )

  it(
    'WHEN it is seated decides as much as WHERE — the window is one boundary wide',
    () => {
      // **The seat tick is not a free parameter and this is the case that says
      // so.** The rejected traffic light's seat phase — a parameter with no
      // design meaning — swung its result 1.19x-1.70x, more than any positive
      // effect it produced, and that was the strongest single argument against
      // it. The upgrade's seat tick is NOT meaningless (a card arrives on a week
      // boundary and a player chooses when to spend it), but it is measured here
      // for the same reason: a payoff quoted without its tick is not a number.
      const arm = runJunctionArm(SHIPPED_ARM)
      const hot = cellsCarryingAtLeast(arm.junctionRefusalsByCell, 5)
      const control = runUpgradeArm({ upgrades: [], seatTick: SEAT_TICK })
      const best = hot[2]!

      // Boundary 2: the site survey says this cell is not a junction yet, and
      // the REAL predicate refuses. This is the survey's timing finding arriving
      // as a placement failure rather than as a table.
      const early = runUpgradeArm({ upgrades: [best], seatTick: 9_000 })
      expect(early.placed, 'not a junction at boundary 2 — the card must be HELD').toBe(false)
      expect(early.trips, 'so the arm is the control').toBe(control.trips)

      // Boundary 3: legal, and worth more than doubling the run.
      const onTime = runUpgradeArm({ upgrades: [best], seatTick: SEAT_TICK })
      expect(onTime.placed).toBe(true)
      expect(onTime.trips).toBeGreaterThan(control.trips * 2)

      // Boundary 4: still legal, and worth NOTHING — the run dies at 21,783, so
      // 18,000 leaves 3,783 ticks and the jam has already taken the board.
      const late = runUpgradeArm({ upgrades: [best], seatTick: 18_000 })
      expect(late.placed, 'still a junction').toBe(true)
      expect(late.trips, 'and the same upgrade at the same cell buys nothing').toBe(control.trips)

      console.log(
        `seat-tick sweep at ${cellName(best, arm.w)}: 9,000 refused (${early.trips}) / ` +
          `13,500 ${onTime.trips} / 18,000 ${late.trips} / control ${control.trips}`,
      )
    },
    UPGRADE_TIMEOUT_MS,
  )
})
