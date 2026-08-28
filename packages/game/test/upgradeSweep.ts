import { canPlaceUpgrade, isJunctionCell, H_INV_UPGRADES, H_UPGRADE_COUNT } from '@laneways/sim'
import { RUN_SEED } from '../src/startingCity'
import {
  cellName,
  replayCapturing,
  runJunctionArm,
  runUpgradeArm,
  SHIPPED_ARM,
  type UpgradeArmRun,
} from './junctionArms'

/**
 * **M1f Task 12 Step 3: the upgrade placement sweep — every legal site, one
 * placement each, against a control that takes the card and places nothing.**
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AND WHAT IT IS ALLOWED TO CONCLUDE
 * ---------------------------------------------------------------------------
 *
 * Task 9 measured what an upgrade buys at three cells it had already ranked as
 * hot. That answers *"does the object help"*, and the milestone's second
 * acceptance criterion is the harder question: **does it matter WHERE.** An
 * upgrade cannot make its own junction worse — at its cell it admits a strict
 * superset of what the bare junction admits — so *"does it help"* is settled by
 * construction and a relief object whose placements all score the same is free
 * income with a tap attached. The modal would then be a decision with one right
 * answer, and this file is the instrument that says whether it is.
 *
 * The measure is **trips**. Blocked car-ticks is reported per row and asserted
 * nowhere: a placement that improves it by killing the board faster is not help,
 * and this project has already shipped one gate that a *deletion of the
 * difficulty* would have passed.
 *
 * ---------------------------------------------------------------------------
 * THE ENUMERATION IS BOUNDED BY CONSTRUCTION, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * `canPlaceUpgrade` accepts junctions and nothing else, so the candidate set is
 * not "every cell on the board". The previous milestone's shape enumerated 545
 * candidate centres of which about 518 were bare grass and bit-identical to the
 * control; **this enumerates six** — measured, not hoped, and reported by
 * `sitesPerBoundary()` beside it. `SWEEP_TIMEOUT_MS` below is derived from one
 * measured arm rather than pasted, because the previous draft of this step ran
 * an unbounded sweep inside one `it` with no timeout argument at all.
 *
 * ---------------------------------------------------------------------------
 * THE `seed` PARAMETER IS A GUARD, NOT AN AXIS — SAID OUT LOUD
 * ---------------------------------------------------------------------------
 *
 * The specified signature is `sweepUpgradePlacements(seed: string)`, and
 * `runUpgradeArm` boots `DEFAULT_LAYOUT_ID` and takes its seed from the layout.
 * **There is no seed axis in this rig and this file does not pretend there is
 * one.** The parameter is checked against the shipped layout's own `RUN_SEED`
 * and throws on anything else, so a caller that believes it is sweeping eight
 * seeds finds out here rather than reading eight identical tables.
 *
 * That is the honest shape for three reasons. The criterion this file serves is
 * a ratio against **one** control, which is a single-seed statement by
 * construction. The eight-seed question — *"which card policy wins"* — is
 * `integration.test.ts`'s, through `createGame`'s own `seed` option, which is a
 * rig that genuinely has the axis. And every figure Task 9 handed this step
 * (`BEST_TRIPS_RATIO`, `SPREAD_MARGIN`) was measured on `laneways-m2`, with
 * Task 9's own warning **not to apply them per seed** attached.
 */

/** The shipped board's seed. The only one this rig can drive; see the header. */
export const SHIPPED_SEED = RUN_SEED

/**
 * **The week-3 boundary, and it is the only boundary that works** — Task 9's
 * `SEAT_TICK`, kept identical so the two measurements are comparable cell for
 * cell rather than merely similar. `(8,21)` and `(9,22)` are not junctions until
 * boundary 3, and the control run dies at 21,783, so by boundary 4 (18,000) an
 * upgrade has 3,783 ticks to work in and Task 10 measured `(9,22)` buying
 * exactly the control's 368 there.
 */
export const SWEEP_SEAT_TICK = 13_500

/** The four week boundaries. `sitesPerBoundary()` reports the count at each. */
export const SWEEP_BOUNDARIES = [4500, 9000, 13500, 18000] as const

/**
 * **Derived, and stated, because the previous draft of this step had no timeout
 * argument at all.**
 *
 * Measured on this tree: one `runUpgradeArm` row costs **0.37-1.6 s** (the
 * control is the cheapest because it dies first; the rows that help run 9,000
 * more ticks), and the memoised `runJunctionArm` the enumeration replays through
 * costs **3.8-4.5 s** on the first case that asks for it. The sweep is
 * `n + 1 = 7` arms plus one replay. `(n + 1) * 5,000 ms` is 35,000; the value
 * below is that plus the replay plus headroom for a `-t` run of one case on a
 * machine under a mutation battery, which is the busiest this tree ever is.
 */
export const SWEEP_TIMEOUT_MS = 60_000

/**
 * **Task 9's threshold, written into this step by Task 9's report before this
 * measurement was taken** — a prediction across a task boundary, which is worth
 * more than the measurement it is checked against.
 *
 * **It is a RATIO and it is compared as one.** The brief specified
 * `best.trips / control.trips > 1 + BEST_MARGIN` with `BEST_MARGIN = 1.50`,
 * which demands 2.5x and is the catalogue's *"a ratio compared against an
 * excess"* defect: Task 9 measured **2.05x** and named 1.50 as the **ratio**
 * floor, not the excess. Both sides here are ratios.
 *
 * Task 9's warning travels with it: **do not apply this per seed.** It was
 * measured on `laneways-m2` and §15's seed sweep puts trips at a 9.6x spread
 * across eight seeds.
 */
export const BEST_TRIPS_RATIO = 1.5

/**
 * **The milestone's second acceptance criterion, as an EXCESS**, and the one
 * that changed: `(best - worst) / worst`. Task 9 measured 0.916 over its three
 * cells and named 0.50 as the floor. This sweep runs six, which can only widen
 * it — a cell Task 9 never measured cannot score above its best without also
 * being its best.
 */
export const SPREAD_MARGIN = 0.5

/** One placement, one arm, one row. */
export interface UpgradeSweepRow {
  readonly cell: number
  readonly deathTick: number
  readonly trips: number
  readonly blockedCarTicks: number
  readonly valveFirings: number
  readonly reachable: boolean
}

/**
 * The cells `canPlaceUpgrade` accepts at `SWEEP_SEAT_TICK`, in ascending cell
 * order, **with inventory and capacity neutralised** — those two refusals are
 * properties of the player's ledger and not of the board, and every arm below is
 * granted inventory at the seat tick anyway.
 */
export function sweepSites(): readonly number[] {
  const snaps = replayCapturing(SHIPPED_ARM, [SWEEP_SEAT_TICK])
  const snap = snaps.get(SWEEP_SEAT_TICK)
  if (snap === undefined) throw new Error(`upgradeSweep: no snapshot at tick ${SWEEP_SEAT_TICK}`)
  snap.state.header[H_INV_UPGRADES] = 1
  snap.state.header[H_UPGRADE_COUNT] = 0
  const sites: number[] = []
  for (let cell = 0; cell < snap.world.cells; cell++) {
    if (canPlaceUpgrade(snap.state, snap.world, cell).ok) sites.push(cell)
  }
  return sites
}

/**
 * Distinct legal sites at each of the four boundary TICKS.
 *
 * **Reported as a line, never asserted here.** `junctionArms.test.ts` owns the
 * assertion, and it samples a four-tick WINDOW around each boundary rather than
 * the tick itself — because whether a junction exists exactly ON a boundary is
 * an artefact of the greedy connector's 30-tick metronome. The two therefore
 * disagree at boundary 1 by exactly one site (the window finds `(8,15)` at tick
 * 4,530; the boundary tick has none), and that difference is information rather
 * than a discrepancy: **a card taken at the first offer has nowhere to go on the
 * tick it is taken.**
 */
export function sitesPerBoundary(): readonly number[] {
  const snaps = replayCapturing(SHIPPED_ARM, [...SWEEP_BOUNDARIES])
  return SWEEP_BOUNDARIES.map((b) => {
    const snap = snaps.get(b)
    if (snap === undefined) throw new Error(`upgradeSweep: no snapshot at tick ${b}`)
    snap.state.header[H_INV_UPGRADES] = 1
    snap.state.header[H_UPGRADE_COUNT] = 0
    let sites = 0
    for (let cell = 0; cell < snap.world.cells; cell++) {
      if (canPlaceUpgrade(snap.state, snap.world, cell).ok) sites++
    }
    return sites
  })
}

/** Junctions at each of the four boundary ticks — the denominator of the line above. */
export function junctionsPerBoundary(): readonly number[] {
  const snaps = replayCapturing(SHIPPED_ARM, [...SWEEP_BOUNDARIES])
  return SWEEP_BOUNDARIES.map((b) => {
    const snap = snaps.get(b)
    if (snap === undefined) throw new Error(`upgradeSweep: no snapshot at tick ${b}`)
    let n = 0
    for (let cell = 0; cell < snap.world.cells; cell++) if (isJunctionCell(snap.state, cell)) n++
    return n
  })
}

function assertShippedSeed(seed: string): void {
  if (seed !== SHIPPED_SEED) {
    throw new Error(
      `upgradeSweep: this rig drives the shipped layout and its own seed (${SHIPPED_SEED}); ` +
        `it was asked for '${seed}'. There is no seed axis here — see the module comment, and use ` +
        `integration.test.ts's createGame rig, which has one.`,
    )
  }
}

/**
 * The control: the same arm, the card taken (inventory granted at the seat tick,
 * exactly as every row pays it), **and nothing placed.**
 */
export function sweepControl(seed: string): UpgradeArmRun {
  assertShippedSeed(seed)
  return runUpgradeArm({ upgrades: [], seatTick: SWEEP_SEAT_TICK })
}

/**
 * One arm per legal site. **A row is a full 12-week drive**, so this is `n`
 * drives and the caller owns `SWEEP_TIMEOUT_MS`.
 *
 * `reachable` is *"no destination this run produced is cut off from a house of
 * its own colour at the end"*, asked of `state.roads` and nothing else, because
 * an upgrade lays no road: the only path by which relief could disconnect
 * anything is the greedy connector laying different roads once the traffic
 * differs. The control satisfies it too, and the test asserts that so the clause
 * is not vacuous.
 */
export function sweepUpgradePlacements(seed: string): readonly UpgradeSweepRow[] {
  assertShippedSeed(seed)
  return sweepSites().map((cell) => {
    const r = runUpgradeArm({ upgrades: [cell], seatTick: SWEEP_SEAT_TICK })
    if (!r.placed) {
      throw new Error(
        `upgradeSweep: canPlaceUpgrade accepted cell ${cell} at tick ${SWEEP_SEAT_TICK} and ` +
          `applyPlaceUpgrade refused it. The enumeration and the arm disagree; do not weaken either.`,
      )
    }
    return {
      cell,
      deathTick: r.deathTick,
      trips: r.trips,
      blockedCarTicks: r.blockedCarTicks,
      valveFirings: r.valveFirings,
      reachable: r.reachableDestinations === r.destinations,
    }
  })
}

/** The table, for the report. Reported, not asserted. */
export function formatSweep(control: UpgradeArmRun, rows: readonly UpgradeSweepRow[]): string {
  const w = runJunctionArm(SHIPPED_ARM).w
  const pct = (t: number): string =>
    t === control.trips ? '  0.0' : (((t - control.trips) * 1000) / control.trips / 10).toFixed(1).padStart(5)
  const out = [
    `control        trips=${String(control.trips).padStart(4)} death=${String(control.deathTick).padStart(6)} ` +
      `blocked=${String(control.blockedCarTicks).padStart(6)} valves=${String(control.valveFirings).padStart(3)} ` +
      `reach=${control.reachableDestinations}/${control.destinations}`,
  ]
  for (const r of rows) {
    out.push(
      `${cellName(r.cell, w).padEnd(14)} trips=${String(r.trips).padStart(4)} death=${String(r.deathTick).padStart(6)} ` +
        `blocked=${String(r.blockedCarTicks).padStart(6)} valves=${String(r.valveFirings).padStart(3)} ` +
        `reachable=${r.reachable} vs control ${pct(r.trips)}%`,
    )
  }
  return out.join('\n')
}
