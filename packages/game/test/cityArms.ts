/**
 * The three input arms the default board is measured on, as ONE policy shared
 * by two independent drivers.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS RATHER THAN A SECOND COPY
 * ---------------------------------------------------------------------------
 *
 * Task 10 wrote the greedy connector inside `startingCity.test.ts`, which boots
 * with `layoutFor` and drives `step` by hand. Task 12 needs the same three arms
 * on the **production** boot — `createGame`, its `InputQueue`, its frame loop —
 * because "the figures hold when the sim is driven by hand" and "the figures
 * hold on the path a player's phone takes" are different claims and only the
 * second one is about the shipped game.
 *
 * **The policy is shared and the drivers are not, deliberately.** A copied
 * connector would drift, and this repo's catalogue has an entry for exactly
 * that (*"a copied constant needs a watcher"*). Two drivers agreeing on a death
 * tick, a killer and a per-week series is evidence; one driver run twice is
 * not. So everything below is a pure function of `(state, world)` with no
 * driver coupling at all, and each caller keeps its own loop.
 *
 * Nothing here reads a flow field, a pin, a car or a reservation. **That is the
 * definition of the arm, not an implementation detail**: the greedy policy is
 * an upper bound on *a player who keeps up*, and a player looking at a screen
 * can see roads, houses and destinations. Task 10's report says the same thing
 * in its own words, and Task 12's device checklist is the only instrument for
 * how far that bound is from a person.
 */
import {
  PIN_CAP_CIRCLE_TIMER,
  PIN_CAP_SQUARE_TIMER,
} from '@laneways/shared'
import {
  carparkCell,
  destMetaColour,
  destMetaKind,
  destMetaOrientation,
  isFootprintCell,
  roadMask,
  stepCell,
  tilesLeft,
  DEST_KIND_CIRCLE,
  H_DEST_COUNT,
  H_HOUSE_COUNT,
  H_PINS_DROPPED,
  H_SCORE,
  PHASE_RETURNING,
  type GameState,
  type TickAction,
  type WorldData,
} from '@laneways/sim'

/** The three arms, by name. `startingCity.test.ts` and `integration.test.ts` both use these. */
export type CityArm = 'no-input' | 'opening' | 'greedy'

/** How often the greedy policy is allowed to act. One decision per 30 ticks — 1 s. */
export const GREEDY_PERIOD_TICKS = 30

/**
 * The five cells that save D2: column x = 17 from its carpark (17, 14) down to
 * its own colour-1 house at (17, 18). Four `place` actions, five tiles.
 */
export const D2_LINK: readonly number[] = [
  14 * 24 + 17, 15 * 24 + 17, 16 * 24 + 17, 17 * 24 + 17, 18 * 24 + 17,
]

/** Column x = 8 from y = 10 to y = 24: 15 cells, 14 segments, 15 tiles. */
export const CORRIDOR: readonly number[] = [
  248, 272, 296, 320, 344, 368, 392, 416, 440, 464, 488, 512, 536, 560, 584,
]

/**
 * The tile prices Decision 13's opening pays, as the two strokes a player
 * draws: column 17 from D2's carpark down to its own colour-1 house (five
 * cells, four `place` actions) and column 8 down the colour-0 carparks (fifteen
 * cells, fourteen actions). 18 actions, 20 tiles of the 30 the board starts
 * with. **Both strokes are asserted accepted rather than assumed** by each
 * caller — a stroke silently refused for budget would make the whole arm a
 * second copy of `no-input` and every figure in it would still look like a
 * measurement.
 */
export const CITY_OPENING: readonly (readonly number[])[] = [D2_LINK, CORRIDOR]

/**
 * The number of times demand has FIRED, derived from the two writers of
 * `destPins` rather than counted by a second implementation of `fireColour`.
 *
 * `demand.ts` writes `destPins[recipient] + 1` on a fire that lands and
 * `H_PINS_DROPPED + 1` on one that does not; `trips.ts` writes `destPins[d] - 1`
 * on an arrival and `H_SCORE + 1` when that car gets home. So every fire is in
 * exactly one of four places — dropped, still standing on a destination, being
 * carried home by a returning car, or scored — and the sum is conserved by
 * construction:
 *
 * ```
 *   fires = H_PINS_DROPPED + sum(destPins) + #cars in PHASE_RETURNING + H_SCORE
 * ```
 *
 * **A structural oracle rather than a second integration, deliberately** — this
 * repo's catalogue records a milestone where two "independent" measurements
 * shared one wrong phase constant and agreed exactly. This derivation passes
 * through no phase constant it could get wrong except `PHASE_RETURNING`, and
 * that term is checked at both ends: on the no-input arm it is 0 for the whole
 * run and the identity still balances.
 */
export function firesSoFar(state: GameState): number {
  let n = (state.header[H_PINS_DROPPED] as number) + (state.header[H_SCORE] as number)
  const destCount = state.header[H_DEST_COUNT] as number
  for (let d = 0; d < destCount; d++) n += state.destPins[d] as number
  for (let c = 0; c < state.carPhase.length; c++) {
    if ((state.carPhase[c] as number) === PHASE_RETURNING) n++
  }
  return n
}

/** §5.8's trigger cap for destination `d` — the one `overcrowdTriggerCap` reads. */
export function armTimerCap(state: GameState, d: number): number {
  return destMetaKind(state.destMeta[d] as number) === DEST_KIND_CIRCLE
    ? PIN_CAP_CIRCLE_TIMER
    : PIN_CAP_SQUARE_TIMER
}

export function armCarpark(state: GameState, world: WorldData, d: number): number {
  return carparkCell(
    state.destCell[d] as number,
    destMetaOrientation(state.destMeta[d] as number),
    world.w,
    world.h,
  )
}

/** True iff `cell` is one of the six non-carpark footprint cells of a destination. */
export function inAnyFootprint(state: GameState, world: WorldData, cell: number): boolean {
  const destCount = state.header[H_DEST_COUNT] as number
  for (let d = 0; d < destCount; d++) {
    const orientation = destMetaOrientation(state.destMeta[d] as number)
    if (isFootprintCell(state.destCell[d] as number, orientation, world.w, cell)) return true
  }
  return false
}

/**
 * The set of cells reachable from `from` by following road bits.
 *
 * **Bits, not "both cells carry a road".** `graph.ts`'s `isConnected` already
 * makes that distinction for one pair and this is the transitive closure of the
 * same relation: two adjacent cells can each carry a road toward something else
 * and be in different components, and a policy that could not tell would
 * re-buy the same connection every 30 ticks forever.
 */
export function armRoadComponent(state: GameState, world: WorldData, from: number): Set<number> {
  const seen = new Set<number>([from])
  const stack: number[] = [from]
  while (stack.length > 0) {
    const c = stack.pop() as number
    const mask = roadMask(state, c)
    for (let dir = 0; dir < 8; dir++) {
      if ((mask & (1 << dir)) === 0) continue
      const next = stepCell(c, dir, world.w, world.h)
      if (next < 0 || seen.has(next)) continue
      seen.add(next)
      stack.push(next)
    }
  }
  return seen
}

/**
 * The cheapest road a player could draw from `from` to any cell in `goals`, in
 * TILES, with the path.
 *
 * A 0-1 breadth-first search: entering a cell that already carries a road bit
 * costs nothing and entering bare ground costs one tile, which is exactly
 * `canPlaceRoad`'s own price — its cost is "how many of the two endpoints have
 * a zero mask", and a cell's mask stops being zero after the first segment that
 * touches it, so the sum over a stroke is the number of bare cells on it.
 *
 * Refuses the cells `canPlaceRoad` refuses: impassable terrain, and the six
 * non-carpark footprint cells of any destination. A carpark and a house cell
 * are both road-legal by design (M1c decision 5), which is what makes a
 * carpark-to-house path expressible at all.
 */
export function armCheapestPath(
  state: GameState,
  world: WorldData,
  from: number,
  goals: ReadonlySet<number>,
): { cost: number; path: number[] } | undefined {
  const legal = (c: number): boolean => world.passable[c] === 1 && !inAnyFootprint(state, world, c)
  if (!legal(from)) return undefined
  const dist = new Int32Array(world.cells).fill(0x7fffffff)
  const prev = new Int32Array(world.cells).fill(-1)
  const buckets: number[][] = []
  const push = (c: number, d: number): void => {
    while (buckets.length <= d) buckets.push([])
    ;(buckets[d] as number[]).push(c)
  }
  const startCost = roadMask(state, from) === 0 ? 1 : 0
  dist[from] = startCost
  push(from, startCost)
  for (let d = 0; d < buckets.length; d++) {
    const bucket = buckets[d] as number[]
    for (let bi = 0; bi < bucket.length; bi++) {
      const c = bucket[bi] as number
      if ((dist[c] as number) !== d) continue
      if (goals.has(c)) {
        const path: number[] = []
        for (let cur = c; cur !== -1; cur = prev[cur] as number) path.push(cur)
        path.reverse()
        return { cost: d, path }
      }
      for (let dir = 0; dir < 8; dir++) {
        const next = stepCell(c, dir, world.w, world.h)
        if (next < 0 || !legal(next)) continue
        const nd = d + (roadMask(state, next) === 0 ? 1 : 0)
        if (nd < (dist[next] as number)) {
          dist[next] = nd
          prev[next] = c
          push(next, nd)
        }
      }
    }
  }
  return undefined
}

/** One stroke's worth of `place` actions, exactly as a drag emits them. */
export function armPathActions(path: readonly number[]): TickAction[] {
  const out: TickAction[] = []
  for (let i = 0; i + 1 < path.length; i++) {
    out.push({ kind: 'place', a: path[i] as number, b: path[i + 1] as number })
  }
  return out
}

/** The greedy policy's decision for this tick, or nothing to do. */
export function armGreedyActions(
  state: GameState,
  world: WorldData,
  tally: { unaffordable: number },
): TickAction[] | undefined {
  const destCount = state.header[H_DEST_COUNT] as number
  const houseCount = state.header[H_HOUSE_COUNT] as number
  for (let d = 0; d < destCount; d++) {
    const colour = destMetaColour(state.destMeta[d] as number)
    const goals = new Set<number>()
    for (let h = 0; h < houseCount; h++) {
      if ((state.houseColour[h] as number) === colour) goals.add(state.houseCell[h] as number)
    }
    if (goals.size === 0) continue
    const cp = armCarpark(state, world, d)
    if (cp < 0) continue
    const component = armRoadComponent(state, world, cp)
    let joined = false
    for (const g of goals) if (component.has(g)) joined = true
    if (joined) continue
    const found = armCheapestPath(state, world, cp, goals)
    if (found === undefined) continue
    if (found.cost > tilesLeft(state)) {
      tally.unaffordable++
      continue
    }
    return armPathActions(found.path)
  }
  return undefined
}
