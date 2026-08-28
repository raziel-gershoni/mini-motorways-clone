import { describe, it, expect, beforeAll } from 'vitest'
import { MAX_UPGRADES, UPGRADES_PER_CARD, WEEKLY_TILE_GRANT } from '@laneways/shared'
import {
  formatSeedRuns,
  runSeedArm,
  seedCellName,
  RUN_SEEDS,
  SEED_ARM_WEEKS,
  type CardPolicy,
  type PlacementMode,
  type SeedRun,
} from './seedArms'

/**
 * **M1f Task 12 Step 4 — the long run, over eight seeds, with the card policies
 * driven against each other.**
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE
 * ---------------------------------------------------------------------------
 *
 * Two reasons and the second is the one that decided it. `seedArms.ts` is a rig
 * `integration.test.ts` does not otherwise use, and a rig's tests belong beside
 * it. And **vitest parallelises FILES, not cases**: this block is ~80 s of
 * measurement, and appending it to `integration.test.ts` would add all of that
 * to `packages/game`'s wall clock, where as a separate file it overlaps with the
 * rest. Measured: the package runs 44 s today.
 *
 * ---------------------------------------------------------------------------
 * REPRODUCE BEFORE YOU CONTRADICT
 * ---------------------------------------------------------------------------
 *
 * The first case below reproduces the shipped seed's whole record on this rig
 * before any of the other seven is believed about anything. This project has
 * twice built a closing-sweep rig that disagreed with the record, and both times
 * every conclusion drawn from it would have been *a confident correction of a
 * correct figure*.
 */

/**
 * **Derived.** Measured on this tree: 48 runs of the full matrix cost 149 s, and
 * the per-seed spread is wide — `s6` 11.5 s for six runs, `s3` 35.0 s for six,
 * because `s3` survives 51,275 ticks where `s6` dies at 15,892. This file
 * commits **25** runs; at `s3`'s 5.8 s/run that is 145 s, and the value below is
 * that plus headroom for a machine under a mutation battery, which is the
 * busiest this tree ever is. **Measured after the trim: 26 runs, 75 s.**
 */
const SEED_MATRIX_TIMEOUT_MS = 300_000

/** The shipped seed's own record, asserted before anything else is believed. */
const SHIPPED = {
  deathTick: 21_783,
  trips: 368,
  blockedCarTicks: 29_267,
  longestQueue: 8,
  valveFirings: 5,
  maxInFlight: 11,
  boundaries: 4,
  tilesLeftRunningMin: 7,
  tilesLeftWeekCloseMin: 37,
  unaffordable: 0,
} as const

const cache = new Map<string, SeedRun>()
function arm(seed: string, policy: CardPolicy, placing: PlacementMode): SeedRun {
  const key = `${seed}/${policy}/${placing}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const fresh = runSeedArm(seed, policy, placing)
  cache.set(key, fresh)
  return fresh
}

describe('M1f Task 12 Step 4: eight seeds, three card policies, and the MAX_UPGRADES bound', () => {
  /**
   * Warms all 26 runs, so no CASE pays for a drive and the per-case budget is
   * about the assertions rather than about which case asked first.
   */
  beforeAll(async () => {
    // **`await` between runs, and it is not decoration.** Each run is ~3-6 s of
    // uninterrupted synchronous JS; twenty-six of them back to back starve the
    // worker's RPC channel and vitest reports `Timeout calling "onTaskUpdate"`
    // as an UNHANDLED ERROR, which fails the file while every assertion passes.
    // Measured: without the yield this block fails that way on every run.
    const breathe = async (): Promise<void> => new Promise((r) => setTimeout(r, 0))
    // `'slot-a'` is warmed for the SHIPPED seed only — it is the reproduction
    // case's arm and nothing else reads it, and seven more of it costs 22 s.
    arm('laneways-m2', 'slot-a', 'none')
    await breathe()
    for (const seed of RUN_SEEDS) {
      arm(seed, 'always-tiles', 'none')
      await breathe()
      arm(seed, 'always-upgrades', 'eager')
      await breathe()
      arm(seed, 'alternate', 'eager')
      await breathe()
    }
    arm('laneways-m2', 'always-upgrades', 'none')
  }, SEED_MATRIX_TIMEOUT_MS)

  it('reproduces the shipped seed on this rig before it is believed about the other seven', () => {
    // **`'slot-a'` and not `'always-tiles'`, and the difference is one row.**
    // Every behavioural figure below is identical on the two arms — measured —
    // but the tile LEDGER is not: `slot-a` takes whatever the draw offers, which
    // on this seed is three upgrade cards and one tiles card, and
    // `'always-tiles'` banks 10 more tiles a week. The first draft of this case
    // asserted `integration.test.ts`'s `slot-a` series against the
    // `'always-tiles'` arm and went red on it — a figure borrowed from the
    // sibling fixture, caught because the series is asserted rather than read.
    const r = arm('laneways-m2', 'slot-a', 'none')
    expect(r.deathTick, 'the shipped board still dies here').toBe(SHIPPED.deathTick)
    expect(r.trips, 'and still scores this').toBe(SHIPPED.trips)
    expect(r.blockedCarTicks, 'blocked car-ticks').toBe(SHIPPED.blockedCarTicks)
    expect(r.longestQueue, 'peak longestQueue, on the REPAIRED probe').toBe(SHIPPED.longestQueue)
    expect(r.valveFirings, 'valve firings — 5 under arm B, not 15 and not 14').toBe(SHIPPED.valveFirings)
    expect(r.maxInFlight, 'the load floor: cars actually moving').toBe(SHIPPED.maxInFlight)
    expect(r.boundaries, 'week boundaries crossed').toBe(SHIPPED.boundaries)
    expect(r.tilesLeftRunningMin, 'the RUNNING minimum, sampled every tick').toBe(SHIPPED.tilesLeftRunningMin)
    expect(r.tilesLeftWeekCloseMin, 'and the WEEK-CLOSE one, which is a different number').toBe(
      SHIPPED.tilesLeftWeekCloseMin,
    )
    expect(r.unaffordable, 'the connector is never tile-bound on this seed').toBe(SHIPPED.unaffordable)
    expect(r.upgradesPlaced, 'and it places nothing').toBe(0)

    // The per-week tile ledger Task 7 re-based, quoted as a series so a reader
    // does not have to reconstruct it: 30/week automatic plus 30/week from the
    // tiles card.
    expect(
      r.weeks.map((w) => w.tilesLeft),
      "tilesLeft at each week close — integration.test.ts's own re-based series",
    ).toEqual([37, 70, 114, 154, 184])
    // And the sibling series, so the two are never confused again: taking the
    // TILES card every week banks 10 more a week and ends 30 tiles higher.
    expect(
      arm('laneways-m2', 'always-tiles', 'none').weeks.map((w) => w.tilesLeft),
      'the same ledger under `always tiles`, which is a DIFFERENT series',
    ).toEqual([37, 80, 134, 184, 214])

    // **The load floor beside the survival figure**, because a survivability
    // number and a *"it got easier"* number are the same number until something
    // separates them.
    expect(r.weeks.at(-1)!.peakDestPins, 'the last week reaches the pin cap').toBeGreaterThanOrEqual(10)
  })

  it('THE TILES CARD IS FREE MONEY: 10 more tiles a week buys nothing at all', () => {
    // Task 7 measured greedy-arm slack at 2.7x -> 4.3x and concluded the modal's
    // 30-vs-20 costs nothing. **This is that claim as an identity rather than as
    // a ratio**: the same seed, the same connector, the same twelve weeks, with
    // the ONLY difference being 30 tiles a week versus 20 — and every
    // behavioural figure is the same integer.
    const tiles = arm('laneways-m2', 'always-tiles', 'none')
    const items = arm('laneways-m2', 'always-upgrades', 'none')
    expect(items.upgradesGranted, 'the second arm really did take the other card').toBe(
      UPGRADES_PER_CARD * items.cardsTaken,
    )
    expect(items.cardsTaken, 'four offers, four cards').toBe(tiles.cardsTaken)
    expect(items.trips, 'trips').toBe(tiles.trips)
    expect(items.deathTick, 'death tick').toBe(tiles.deathTick)
    expect(items.blockedCarTicks, 'blocked car-ticks').toBe(tiles.blockedCarTicks)
    expect(items.valveFirings, 'valve firings').toBe(tiles.valveFirings)
    expect(items.upgradesPlaced, 'and the items were never spent').toBe(0)

    // The two ledgers DO differ, which is what says the arms were genuinely
    // different: 30 vs 20 a week on top of `WEEKLY_TILE_GRANT`.
    const gap = tiles.weeks.at(-1)!.tilesLeft - items.weeks.at(-1)!.tilesLeft
    expect(gap, 'ten tiles a week for four weeks, banked and never spent').toBe(10 * tiles.cardsTaken)
    expect(WEEKLY_TILE_GRANT, 'the automatic grant M1g may delete is the reason the gap is affordable').toBe(30)
  })

  it(
    'ALWAYS UPGRADES beats ALWAYS TILES on all eight seeds, and the tiles card never wins one',
    () => {
      const rows: string[] = []
      let upgradesWins = 0
      let alternateWins = 0
      let tilesWins = 0
      for (const seed of RUN_SEEDS) {
        const t = arm(seed, 'always-tiles', 'none')
        const u = arm(seed, 'always-upgrades', 'eager')
        const a = arm(seed, 'alternate', 'eager')
        // **The criterion is TRIPS**, and the death tick is reported beside it
        // rather than asserted: a policy that survives longer by delivering less
        // is not a better policy, and this project has shipped one gate a
        // *deletion of the difficulty* would have passed.
        expect(u.trips, `${seed}: always-upgrades must beat always-tiles on trips`).toBeGreaterThan(t.trips)
        expect(u.deathTick, `${seed}: and must not die sooner`).toBeGreaterThanOrEqual(t.deathTick)
        const best = Math.max(t.trips, u.trips, a.trips)
        if (u.trips === best) upgradesWins++
        else if (a.trips === best) alternateWins++
        else tilesWins++
        rows.push(
          `${seed.padEnd(11)} tiles ${String(t.trips).padStart(4)}/${String(t.deathTick).padStart(5)}  ` +
            `upgrades ${String(u.trips).padStart(4)}/${String(u.deathTick).padStart(5)}  ` +
            `alternate ${String(a.trips).padStart(4)}/${String(a.deathTick).padStart(5)}  ` +
            `u/t=${(u.trips / t.trips).toFixed(2)}x`,
        )
      }
      // **`always tiles` never wins a single seed.** That is the finding, and it
      // is asserted rather than reported because it is what says the modal's two
      // cards are not a trade-off on any board this project can drive.
      expect(tilesWins, 'the tiles card wins no seed').toBe(0)
      expect(upgradesWins + alternateWins, 'so every seed goes to a policy that takes the item').toBe(
        RUN_SEEDS.length,
      )
      // Reported, not asserted: which of the two item-taking policies wins is a
      // per-seed accident and the interesting half is that `alternate` wins any.
      console.log(`policy wins — upgrades ${upgradesWins}, alternate ${alternateWins}, tiles ${tilesWins}`)
      console.log(rows.join('\n'))
    },
    SEED_MATRIX_TIMEOUT_MS,
  )

  it('MAX_UPGRADES still bounds the grant — and the slack is 2, not a factor of three', () => {
    const runs = RUN_SEEDS.map((s) => arm(s, 'always-upgrades', 'eager'))
    const maxBoundaries = Math.max(...runs.map((r) => r.boundaries))
    // The plan's own derivation, pinned against measured data so it cannot rot
    // into a claim.
    expect(UPGRADES_PER_CARD * maxBoundaries, 'MAX_UPGRADES still bounds the grant').toBeLessThanOrEqual(
      MAX_UPGRADES,
    )
    // **And the slack, because reporting only the truth of a bound is how a
    // nearly-binding cap reads as a comfortable one.** Decision 15 says the cap
    // is "3x over on this board", derived from a FOUR-boundary run of the
    // shipped seed with no relief. Taking the upgrade card every week makes the
    // run longer, which makes more boundaries, which grants more upgrades: the
    // longest arm here reaches 11 boundaries and is granted 22 against a cap of
    // 24. **That is 1.09x, not 3x, and one more boundary makes it binding.**
    const granted = UPGRADES_PER_CARD * maxBoundaries
    expect(granted, 'the eight-seed maximum grant').toBe(22)
    expect(MAX_UPGRADES - granted, 'and the cap is two upgrades away from binding').toBe(2)
    expect(maxBoundaries, 'the longest run crosses this many boundaries').toBeLessThanOrEqual(SEED_ARM_WEEKS)
    console.log(
      `MAX_UPGRADES ${MAX_UPGRADES}; max boundaries ${maxBoundaries} (${runs.find((r) => r.boundaries === maxBoundaries)!.seed}); ` +
        `granted ${granted}; slack ${MAX_UPGRADES - granted} (${(MAX_UPGRADES / granted).toFixed(2)}x)`,
    )
    console.log(formatSeedRuns(runs))
  })

  it('the placement ranking is INERT when the card arrives, and that is a finding not a bug', () => {
    // **Every early placement is made against an EMPTY tally.** The first offer
    // lands at 2:21 and the board's first junction-caused refusal is thousands
    // of ticks later, so *"the highest-ranked cell the run's own tally names"*
    // ranks nothing and the rule degenerates to the lowest-index legal junction.
    // That is exactly the player's position — nothing on screen points at a
    // corner — and it is measured here rather than left as an impression.
    const eager = arm('laneways-m2', 'always-upgrades', 'eager')
    expect(eager.placements.length, 'it seated something').toBeGreaterThan(0)
    expect(eager.placementsWithEvidence, 'and not one of them had evidence behind it').toBe(0)

    // **The eager arm's OWN tally is empty at the end too, and that is the
    // object working rather than the instrument failing.** A junction-caused
    // refusal is one `junctionAdmitsOne` produced, and it returns false at an
    // upgraded cell — so an arm that seats every junction has nothing left to
    // tally. The ranking therefore only exists on a run where the player did
    // nothing, which is the whole difficulty: **the signal that would tell you
    // where to place is destroyed by placing.**
    expect(eager.junctionRefusals, 'every junction it could reach is upgraded').toBe(0)

    const control = arm('laneways-m2', 'always-tiles', 'none')
    const rank = [...control.junctionRefusalsByCell.entries()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
    expect(rank.length, 'the un-upgraded run does produce a ranking').toBeGreaterThan(2)
    // Task 3 measured the same ranking with a different instrument entirely — a
    // within-tick occupancy replay, against this rig's pre-tick reading — and
    // the two agree to a tenth of a point on the top three. The top cell is
    // `(12,19)` and Task 10 measured it as the one that buys the LEAST.
    const share = (n: number): number => (n * 100) / control.junctionRefusals
    expect(seedCellName(rank[0]![0], control.w), 'the highest-ranked cell').toBe('(12,19)')
    expect(share(rank[0]![1]), "Task 3's 39.5 % for it").toBeCloseTo(39.5, 0)
    expect(seedCellName(rank[2]![0], control.w), 'and the third-ranked one').toBe('(9,22)')
    expect(share(rank[2]![1]), "Task 3's 21.7 % for it, the cell that buys the MOST").toBeCloseTo(21.7, 0)
    console.log(
      `junction-caused refusal ranking on the un-upgraded shipped seed: ` +
        rank
          .slice(0, 5)
          .map(([c, n]) => `${seedCellName(c, control.w)}=${n} (${share(n).toFixed(1)}%)`)
          .join(' '),
    )
    console.log(`seated: ${eager.placements.map((c) => seedCellName(c, eager.w)).join(' ')}`)
  })
})
