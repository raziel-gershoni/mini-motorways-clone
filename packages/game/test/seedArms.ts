import { MAX_BLOCKED_TICKS, TICKS_PER_WEEK } from '@laneways/shared'
import type { AtlasContext, AtlasSurface } from '@laneways/render'
import {
  canPlaceUpgrade,
  isJunctionCell,
  junctionAdmitsOne,
  occupantOf,
  offerPending,
  offerSlot,
  otherLane,
  stepCell,
  tilesLeft,
  isGameOver,
  weekOfTick,
  CARD_JUNCTION_UPGRADE,
  CARD_NONE,
  CARD_ROAD_TILES,
  FREE,
  H_DEST_COUNT,
  H_HOUSE_COUNT,
  H_INV_UPGRADES,
  H_SCORE,
  H_TICK,
  H_UPGRADE_COUNT,
  LANE_OF_DIR,
  PHASE_OUTBOUND,
  PHASE_RETURNING,
  type GameState,
  type TickAction,
  type WorldData,
} from '@laneways/sim'
import { createGame, type GameContext } from '../src/main'
import { longestQueue, travelDir, NO_CROSSING } from '../src/queueProbe'
import {
  armGreedyActions,
  armPathActions,
  firesSoFar,
  CITY_OPENING,
  GREEDY_PERIOD_TICKS,
} from './cityArms'

/**
 * **M1f Task 12 Step 4: the long run, across eight seeds, with the three card
 * policies driven against each other.**
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE AND NOT A BLOCK INSIDE `integration.test.ts`
 * ---------------------------------------------------------------------------
 *
 * `integration.test.ts`'s own `driveArm` is the right rig for the shipped seed
 * and the wrong one for thirty-two runs of it: it drives a `RecordingContext`
 * that appends every draw call of every frame to an array, which is what makes
 * it able to assert that the modal drew `CHOOSE A CARD` — and what makes it
 * unaffordable at 8 seeds x 4 arms x 54,000 ticks. This rig hands `createGame` a
 * context whose methods are empty and asserts nothing about drawing.
 *
 * **It is otherwise the same driver, deliberately**: `createGame` with the
 * property `layoutId` genuinely absent (the board a plain bot link opens), roads
 * pushed through `game.queue.enqueue` — the method `pointer.ts` calls and the
 * only way a finger reaches the sim — and time advanced by handing
 * `game.frame` a timestamp. Upgrades are enqueued as `'upgrade'` actions on the
 * same queue rather than by calling `applyPlaceUpgrade`, so a placement travels
 * the production path.
 *
 * ---------------------------------------------------------------------------
 * REPRODUCE BEFORE YOU CONTRADICT — THIS RIG'S OWN CHECK
 * ---------------------------------------------------------------------------
 *
 * On `laneways-m2` with `'slot-a'` and no placement this rig returns **death
 * 21,783, trips 368, cards 4, upgrades held 6, destinations 10, `tilesLeft` 184,
 * fires 413, `unaffordable` 0** — every one of which `integration.test.ts`
 * already asserts off its own driver. `seedArms.test`-side cases pin that
 * agreement, and nothing this file measures about the other seven seeds should
 * be believed if that row moves.
 *
 * ---------------------------------------------------------------------------
 * THE PLACEMENT RULE IS DELIBERATELY NAIVE, AND THAT IS THE EXPERIMENT
 * ---------------------------------------------------------------------------
 *
 * Every granted upgrade is seated on **the highest-ranked cell the run's own
 * junction-caused refusal tally names, among the cells legal at that moment.**
 * Task 10 measured that this ranking *inverts the payoff* on the shipped seed —
 * `(12,19)` carries 39.5 % of the junction-caused refusals and buys 394 trips,
 * while `(9,22)` carries 21.7 % and buys 755 — so this policy is a **lower
 * bound** on what an upgrade card is worth, and it is the right one here,
 * because the question is whether the CARD is a decision rather than whether the
 * placement is. A policy comparison run with optimal placement would be
 * measuring a skill the game gives the player no signal for.
 */

// ---------------------------------------------------------------------------
// The eight seeds
// ---------------------------------------------------------------------------

/**
 * **The enumeration, because a span quoted without its seed list is not a
 * measurement** — `m1f-carry-forward.md` §15's rule, and these are its eight.
 * `laneways-m2` is the shipped one and it is **not typical**: the quietest of
 * the eight on blocked car-ticks and one of only two that never valved before
 * this milestone.
 */
export const RUN_SEEDS = ['laneways-m2', 's1', 's2', 's3', 's4', 's5', 's6', 's7'] as const

/** Twelve weeks, matching `integration.test.ts`'s `ARM_WEEKS`. */
export const SEED_ARM_WEEKS = 12

/** How often `longestQueue` is sampled, matching `junctionArms.ts`'s city arm. */
const QUEUE_SAMPLE = 10

// ---------------------------------------------------------------------------
// Card policies
// ---------------------------------------------------------------------------

/**
 * `'slot-a'` is what every other frame-driven rig in this repo runs
 * (`cardPolicy.ts`'s `takeCardPolicy(rig, 0)`), and it is a **draw**: the pool's
 * only randomness is the order, so slot A is sometimes the tiles and sometimes
 * the upgrade. The other three are card-keyed, which is what makes them
 * policies rather than samples.
 */
export type CardPolicy = 'slot-a' | 'always-tiles' | 'always-upgrades' | 'alternate'

export const CARD_POLICIES: readonly CardPolicy[] = [
  'slot-a',
  'always-tiles',
  'always-upgrades',
  'alternate',
]

/**
 * Called after every tick, with the card the offer resolver took on this tick or
 * `CARD_NONE`. **The card id is the parameter that makes the tile-ledger
 * invariant checkable** — the ledger steps by `WEEKLY_TILE_GRANT +
 * cardTileGrant(chosen)` and by nothing else, and an observer that could not see
 * which card was chosen could only assert the weaker *"it went up"*.
 */
export type SeedTickObserver = (
  state: GameState,
  world: WorldData,
  tick: number,
  cardTakenThisTick: number,
) => void

/** The slot this policy takes for offer number `taken` (0-based). */
function slotFor(state: GameState, policy: CardPolicy, taken: number): 0 | 1 {
  if (policy === 'slot-a') return 0
  const want =
    policy === 'always-tiles'
      ? CARD_ROAD_TILES
      : policy === 'always-upgrades'
        ? CARD_JUNCTION_UPGRADE
        : taken % 2 === 0
          ? CARD_JUNCTION_UPGRADE
          : CARD_ROAD_TILES
  return offerSlot(state, 0) === want ? 0 : 1
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export interface SeedWeek {
  readonly week: number
  readonly dests: number
  readonly houses: number
  readonly trips: number
  readonly fires: number
  /** `trips / fires` for this week alone; `1` on a week that fired nothing. */
  readonly deliveryFraction: number
  readonly peakDestPins: number
  readonly longestQueue: number
  readonly blockedCarTicks: number
  /** `tilesLeft` at the CLOSE of this week. See `tilesLeftWeekCloseMin`. */
  readonly tilesLeft: number
  readonly cardsTaken: number
  readonly upgradesHeld: number
  readonly upgradesPlaced: number
}

/**
 * Where a granted upgrade goes.
 *
 *  - `'none'` — held and never placed. **The arm that isolates the tile bonus
 *    from the object**, which is the configuration Task 7's product verdict is
 *    about: 20 unspendable tiles versus 30 unspendable tiles.
 *  - `'eager'` — placed on the top of the run's own junction-caused tally as
 *    soon as any legal site exists, ties broken low-index. **On this board the
 *    tally is EMPTY at every early placement**, so this degenerates to *"seat
 *    the lowest-index junction the moment one appears"* — which is what a player
 *    with no signal does, and it is measured rather than assumed (`placementsWithEvidence`).
 *  - `'evidence'` — placed only on a cell whose tally is already non-zero, which
 *    is the brief's literal *"the highest-ranked cell the run's own
 *    junction-caused refusal tally NAMES"*. It waits, and what it is waiting for
 *    is the jam the player also cannot see until 8:56.
 */
export type PlacementMode = 'none' | 'eager' | 'evidence'

export interface SeedRun {
  readonly seed: string
  readonly policy: CardPolicy
  readonly placing: PlacementMode
  /** The tick `isGameOver` first read true, or -1 if twelve weeks came first. */
  readonly deathTick: number
  readonly endTick: number
  readonly trips: number
  readonly fires: number
  readonly deliveryFraction: number
  readonly blockedCarTicks: number
  readonly longestQueue: number
  readonly valveFirings: number
  readonly maxInFlight: number
  readonly weeks: readonly SeedWeek[]
  /**
   * **The RUNNING minimum**, sampled every tick — not the week-close one. The
   * two differ by a factor of five on the shipped seed and this project has
   * already reported one as the other once.
   */
  readonly tilesLeftRunningMin: number
  /** The minimum over the week-CLOSE samples in `weeks`. */
  readonly tilesLeftWeekCloseMin: number
  /** Times the greedy connector wanted a road it could not afford. */
  readonly unaffordable: number
  /** Week boundaries this run actually crossed. */
  readonly boundaries: number
  /** `UPGRADES_PER_CARD` per upgrade card taken. */
  readonly upgradesGranted: number
  /** `H_UPGRADE_COUNT` at the end. */
  readonly upgradesPlaced: number
  readonly cardsTaken: number
  /** Cells seated, in the order they were seated. */
  readonly placements: readonly number[]
  /** How many of those were the top of a tally that was actually non-zero. */
  readonly placementsWithEvidence: number
  /** Junction-caused refusals per cell over the run — the ranking's source. */
  readonly junctionRefusalsByCell: Int32Array
  readonly junctionRefusals: number
  readonly w: number
}

// ---------------------------------------------------------------------------
// The context stubs
// ---------------------------------------------------------------------------

function silentContext(): GameContext {
  return {
    canvas: { width: 0, height: 0 },
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 0,
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    arc: () => undefined,
    stroke: () => undefined,
    font: '',
    textAlign: 'center',
    textBaseline: 'middle',
    setTransform: () => undefined,
    fillRect: () => undefined,
    fillText: () => undefined,
    drawImage: () => undefined,
  } as unknown as GameContext
}

function stubSurface(widthPx: number, heightPx: number): AtlasSurface {
  const context: AtlasContext = {
    lineWidth: 0,
    lineCap: 'round',
    lineJoin: 'round',
    globalAlpha: 1,
    strokeStyle: '',
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
  }
  return { width: widthPx, height: heightPx, getContext: () => context }
}

/** The same viewport every other frame rig in this package measures. */
const M0_VIEW = {
  cssW: 406,
  cssH: 870,
  topInset: 46,
  bottomInset: 34,
  rawDpr: 3,
  performanceClass: null,
} as const

const TICK_MS = 1000 / 30

// ---------------------------------------------------------------------------
// The junction-caused refusal instrument
// ---------------------------------------------------------------------------

/**
 * The cell car `i` is trying to enter, and whether the ONLY thing holding it is
 * the other lane of a junction — which is exactly the refusal a junction upgrade
 * removes, and exactly `junctionArms.ts`'s `junctionRefusalsByCell` definition.
 *
 * **This is a pre-tick reading and Task 3's rig is a within-tick replay**, so
 * the two are not the same instrument. `runMovement` processes cars in ascending
 * slot order and occupancy changes under later cars, so a car this reads as
 * junction-blocked may be admitted by the time its turn comes. The difference
 * matters for a COUNT and does not matter for a RANKING, which is all this is
 * used for; `seedArms`'s own case cross-checks the shipped seed's top three
 * cells against Task 3's exact table rather than assuming they agree.
 *
 * Returns -1 when the car is not junction-blocked.
 */
function junctionBlockedTarget(state: GameState, world: WorldData, i: number): number {
  const dir = travelDir(state, i)
  if (dir === NO_CROSSING) return -1
  const next = stepCell(state.carCell[i] as number, dir, world.w, world.h)
  if (next < 0) return -1
  const lane = LANE_OF_DIR[dir] as number
  if (occupantOf(state, next, lane) !== FREE) return -1
  if (!junctionAdmitsOne(state, next)) return -1
  return occupantOf(state, next, otherLane(lane)) === FREE ? -1 : next
}

/** The highest-ranked cell that is legal right now, or -1. Ties break low-index. */
function topLegalSite(
  state: GameState,
  world: WorldData,
  tally: Int32Array,
): { readonly cell: number; readonly evidence: boolean } {
  let best = -1
  let bestScore = -1
  for (let cell = 0; cell < world.cells; cell++) {
    if (!isJunctionCell(state, cell)) continue
    if (!canPlaceUpgrade(state, world, cell).ok) continue
    const score = tally[cell] as number
    if (score > bestScore) {
      bestScore = score
      best = cell
    }
  }
  return { cell: best, evidence: bestScore > 0 }
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/**
 * One seed, one card policy, twelve weeks or death.
 *
 * `onTick` is called after every tick with the live state and world, and it is
 * how M1f Task 12 Step 5's invariant sweep rides this rig rather than building a
 * fourth driver. It is optional so the 26 policy runs pay nothing for it.
 *
 * `placing` is a `PlacementMode`; see its doc for why there are three and not
 * two. It is a parameter rather than implied by the policy because *"always
 * upgrades and never place them"* is the arm that isolates the tile bonus from
 * the object, and Task 7's product verdict is about exactly that configuration.
 */
export function runSeedArm(
  seed: string,
  policy: CardPolicy,
  placing: PlacementMode,
  onTick?: SeedTickObserver,
): SeedRun {
  const game = createGame({
    restart: () => undefined,
    // The property genuinely absent: the board a plain bot link opens.
    layoutId: undefined,
    seed,
    canvas: {
      width: 0,
      height: 0,
      style: { width: '', height: '' },
      getBoundingClientRect: () => ({ left: 11, top: 7 }),
    },
    context: silentContext(),
    createSurface: stubSurface,
    createFallback: () => null,
    measure: () => M0_VIEW,
    settle: (run) => {
      run()
    },
  })
  const { state, world, loop, queue } = game
  const startTick = state.header[H_TICK] as number
  const endHorizon = startTick + SEED_ARM_WEEKS * TICKS_PER_WEEK

  const tally = { unaffordable: 0 }
  const openingActions: TickAction[] = []
  for (const stroke of CITY_OPENING) openingActions.push(...armPathActions(stroke))

  const carSlots = state.carPhase.length
  const preCell = new Int32Array(carSlots)
  const preBlocked = new Int32Array(carSlots)
  const preInFlight = new Uint8Array(carSlots)
  const preTarget = new Int32Array(carSlots)
  const junctionRefusalsByCell = new Int32Array(world.cells)

  const weeks: SeedWeek[] = []
  const placements: number[] = []
  let placementsWithEvidence = 0
  let cardsTaken = 0
  let upgradesGranted = 0
  let deathTick = -1
  let blockedCarTicks = 0
  let junctionRefusals = 0
  let valveFirings = 0
  let peakQueue = 0
  let maxInFlight = 0
  let tilesLeftRunningMin = tilesLeft(state)
  let boundaries = 0

  let week = weekOfTick(startTick)
  let weekTrips = state.header[H_SCORE] as number
  let weekFires = firesSoFar(state)
  let wkQueue = 0
  let wkBlocked = 0
  let wkPins = 0

  const closeWeek = (): void => {
    const trips = (state.header[H_SCORE] as number) - weekTrips
    const fires = firesSoFar(state) - weekFires
    weeks.push({
      week,
      dests: state.header[H_DEST_COUNT] as number,
      houses: state.header[H_HOUSE_COUNT] as number,
      trips,
      fires,
      deliveryFraction: fires === 0 ? 1 : trips / fires,
      peakDestPins: wkPins,
      longestQueue: wkQueue,
      blockedCarTicks: wkBlocked,
      tilesLeft: tilesLeft(state),
      cardsTaken,
      upgradesHeld: state.header[H_INV_UPGRADES] as number,
      upgradesPlaced: state.header[H_UPGRADE_COUNT] as number,
    })
    weekTrips = state.header[H_SCORE] as number
    weekFires = firesSoFar(state)
    wkQueue = 0
    wkBlocked = 0
    wkPins = 0
  }

  let now = 1000
  for (let tick = startTick + 1; tick <= endHorizon; tick++) {
    let actions: readonly TickAction[] | undefined
    if (tick === startTick + 1) actions = openingActions
    else if (tick % GREEDY_PERIOD_TICKS === 0) actions = armGreedyActions(state, world, tally)
    if (actions !== undefined) for (const a of actions) queue.enqueue(a.kind, a.a, a.b)

    // The player's placement: as soon as a legal site exists, on the top of the
    // run's own tally. One per attempt, so a card's two upgrades take two.
    if (
      placing !== 'none' &&
      tick % GREEDY_PERIOD_TICKS === 0 &&
      (state.header[H_INV_UPGRADES] as number) >= 1
    ) {
      const top = topLegalSite(state, world, junctionRefusalsByCell)
      if (top.cell >= 0 && (placing === 'eager' || top.evidence)) {
        queue.enqueue('upgrade', top.cell, 0)
        placements.push(top.cell)
        if (top.evidence) placementsWithEvidence++
      }
    }

    for (let c = 0; c < carSlots; c++) {
      preCell[c] = state.carCell[c] as number
      preBlocked[c] = state.carBlockedTicks[c] as number
      const phase = state.carPhase[c] as number
      const inFlight = phase === PHASE_OUTBOUND || phase === PHASE_RETURNING
      preInFlight[c] = inFlight ? 1 : 0
      preTarget[c] = inFlight ? junctionBlockedTarget(state, world, c) : -1
    }

    // One tick, however many frames that takes. The card policy runs BEFORE the
    // frame so the action is enqueued and drained inside the same call.
    const before = state.header[H_TICK] as number
    let frames = 0
    let cardThisTick = CARD_NONE
    while ((state.header[H_TICK] as number) === before) {
      if (!loop.over && loop.paused && offerPending(state)) {
        const slot = slotFor(state, policy, cardsTaken)
        const card = offerSlot(state, slot)
        queue.enqueue('choose-card', slot, card)
        loop.setPaused(false)
        cardsTaken++
        cardThisTick = card
        if (card === CARD_JUNCTION_UPGRADE) upgradesGranted += 2
      }
      now += TICK_MS + 0.5 * TICK_MS - loop.accumulator
      game.frame(now)
      frames++
      if (frames > 6) {
        throw new Error(`seedArms: ${frames} frames ran no tick at all after ${before} (${seed}/${policy})`)
      }
    }
    if ((state.header[H_TICK] as number) !== before + 1) {
      throw new Error(`seedArms: one frame ran ${(state.header[H_TICK] as number) - before} ticks`)
    }

    if (onTick !== undefined) onTick(state, world, state.header[H_TICK] as number, cardThisTick)

    let inFlight = 0
    for (let c = 0; c < carSlots; c++) {
      const phase = state.carPhase[c] as number
      if (phase === PHASE_OUTBOUND || phase === PHASE_RETURNING) inFlight++
      if (preInFlight[c] === 0) continue
      const moved = (state.carCell[c] as number) !== (preCell[c] as number)
      const blocked = state.carBlockedTicks[c] as number
      if (!moved && blocked === (preBlocked[c] as number) + 1) {
        blockedCarTicks++
        wkBlocked++
        const target = preTarget[c] as number
        if (target >= 0) {
          junctionRefusals++
          junctionRefusalsByCell[target] = (junctionRefusalsByCell[target] as number) + 1
        }
      } else if (moved && (preBlocked[c] as number) >= MAX_BLOCKED_TICKS) {
        valveFirings++
      }
    }
    if (inFlight > maxInFlight) maxInFlight = inFlight

    const left = tilesLeft(state)
    if (left < tilesLeftRunningMin) tilesLeftRunningMin = left
    for (let d = 0; d < (state.header[H_DEST_COUNT] as number); d++) {
      const pins = state.destPins[d] as number
      if (pins > wkPins) wkPins = pins
    }
    if (tick % QUEUE_SAMPLE === 0) {
      const q = longestQueue(state, world)
      if (q > wkQueue) wkQueue = q
      if (q > peakQueue) peakQueue = q
    }

    const nowWeek = weekOfTick(state.header[H_TICK] as number)
    if (nowWeek !== week) {
      closeWeek()
      week = nowWeek
      boundaries++
    }

    if (isGameOver(state)) {
      deathTick = state.header[H_TICK] as number
      break
    }
  }
  closeWeek()

  const fires = firesSoFar(state)
  const trips = state.header[H_SCORE] as number
  return {
    seed,
    policy,
    placing,
    deathTick,
    endTick: state.header[H_TICK] as number,
    trips,
    fires,
    deliveryFraction: fires === 0 ? 1 : trips / fires,
    blockedCarTicks,
    longestQueue: peakQueue,
    valveFirings,
    maxInFlight,
    weeks,
    tilesLeftRunningMin,
    tilesLeftWeekCloseMin: Math.min(...weeks.map((w) => w.tilesLeft)),
    unaffordable: tally.unaffordable,
    boundaries,
    upgradesGranted,
    upgradesPlaced: state.header[H_UPGRADE_COUNT] as number,
    cardsTaken,
    placements,
    placementsWithEvidence,
    junctionRefusalsByCell,
    junctionRefusals,
    w: world.w,
  }
}

/** `houseCount` is read by the per-seed table; kept here so callers need no import. */
export function houseCount(state: GameState): number {
  return state.header[H_HOUSE_COUNT] as number
}

/** `(x,y)`, matching `junctionArms.ts`'s `cellName`. */
export function seedCellName(cell: number, w: number): string {
  return `(${cell % w},${Math.floor(cell / w)})`
}

/** The per-seed table, for the report. */
export function formatSeedRuns(runs: readonly SeedRun[]): string {
  const head =
    'seed        policy          place     death  trips  blocked  queue  valve  inFlt  bnd  granted  placed  tileMinRun  tileMinWk  unaff  deliv'
  const rows = runs.map(
    (r) =>
      `${r.seed.padEnd(11)} ${r.policy.padEnd(15)} ${r.placing.padEnd(8)} ` +
      `${String(r.deathTick).padStart(6)} ${String(r.trips).padStart(6)} ${String(r.blockedCarTicks).padStart(8)} ` +
      `${String(r.longestQueue).padStart(6)} ${String(r.valveFirings).padStart(6)} ${String(r.maxInFlight).padStart(6)} ` +
      `${String(r.boundaries).padStart(4)} ${String(r.upgradesGranted).padStart(8)} ${String(r.upgradesPlaced).padStart(7)} ` +
      `${String(r.tilesLeftRunningMin).padStart(11)} ${String(r.tilesLeftWeekCloseMin).padStart(10)} ` +
      `${String(r.unaffordable).padStart(6)} ${r.deliveryFraction.toFixed(3).padStart(6)}`,
  )
  return [head, ...rows].join('\n')
}

/** The per-week block of one run, for the report. */
export function formatSeedWeeks(run: SeedRun): string {
  const head = `${run.seed}/${run.policy}/place=${run.placing}  week dests houses trips fires deliv pins queue blocked tiles cards held placed`
  const rows = run.weeks.map(
    (w) =>
      `  ${String(w.week).padStart(4)} ${String(w.dests).padStart(5)} ${String(w.houses).padStart(6)} ` +
      `${String(w.trips).padStart(5)} ${String(w.fires).padStart(5)} ${w.deliveryFraction.toFixed(3)} ` +
      `${String(w.peakDestPins).padStart(4)} ${String(w.longestQueue).padStart(5)} ${String(w.blockedCarTicks).padStart(7)} ` +
      `${String(w.tilesLeft).padStart(5)} ${String(w.cardsTaken).padStart(5)} ${String(w.upgradesHeld).padStart(4)} ` +
      `${String(w.upgradesPlaced).padStart(6)}`,
  )
  return [head, ...rows].join('\n')
}
