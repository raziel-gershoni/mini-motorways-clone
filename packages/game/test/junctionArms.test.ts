import { describe, it, expect, beforeAll } from 'vitest'
import { isJunctionCell } from '@laneways/sim'
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
    expect(city.grantsWithOtherLaneTaken, 'the whole of the narrowing, in crossings').toBe(43)
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
      expect(sitesPerBoundary, 'distinct legal sites per boundary window').toEqual([1, 2, 6, 6])

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
