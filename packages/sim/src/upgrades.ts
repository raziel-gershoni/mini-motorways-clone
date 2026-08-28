import { MAX_UPGRADES } from '@laneways/shared'
import { H_INV_UPGRADES, H_UPGRADE_COUNT, type GameState } from './state'
import type { WorldData } from './world'
import { isJunctionCell } from './graph'

/**
 * §5.6's relief object, as M1f ships it: a single-cell JUNCTION UPGRADE placed ON
 * an existing road junction, costing 0 tiles, at which **the junction
 * mutual-exclusion rule does not apply.**
 *
 * **Why an upgrade and not §5.6's traffic light.** M1f built the light to
 * specification in a throwaway spike and measured it against its own control: a
 * fixed alternating light scores -13.0 % on trips at its best seat phase and
 * -17 % at the median, and this milestone's own specified demand controller
 * scores -38 % with ONE phase swap in an entire run, because
 * `minimumNearbyCarsBeforeSwapping` = 2 within 2 tiles is essentially never
 * satisfied on a board carrying about eleven cars in flight. Exempting the rule
 * outright at the same cells scores **+103.8 %** and recovers the entire cost of
 * the junction rule. See the 2026-08-21 amendment to spec 5.6, and
 * `docs/superpowers/m1g-carry-forward.md`, which owns the light.
 *
 * **THE +103.8 % IS AN UNREACHABLE CEILING AND THIS FILE IS THE REACHABLE
 * OBJECT.** The spike exempted six cells and **two of them never reach degree 3
 * on any tick of the run** — `canPlaceUpgrade` refuses them with
 * `'not-a-junction'` at every sample tick of the site survey, so no player can
 * buy that number. The per-cell measurement of what one reachable upgrade
 * actually buys is `game/test/junctionArms.test.ts`'s *"one upgrade per
 * junction-eligible jam cell"*; read it beside the ceiling, never instead of it.
 *
 * **Why a light and not a roundabout, kept because the geometry finding is the
 * reason this file exists at all.** M1f measured every legal 3x3 roundabout
 * placement covering every cell that actually jams, at every tick of the run:
 * five of the six had ZERO, and the sixth had one — the cell measured as worth
 * exactly nothing. The greedy connector merges approaches AT carparks and houses,
 * so degree-3 cells form against buildings by construction. A single-cell object's
 * placement rule IS the jam's location, so it cannot fail that way.
 *
 * **What an upgrade BUYS, derived rather than hoped.** Spec 5.5's mutual
 * exclusion (M1f Task 2) destroyed the two-lane model's head-on guarantee at
 * junctions: `LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]` used to make two cars
 * swapping across an edge resolve in one tick, and under the junction rule they
 * deadlock until the 45 s valve. **Task 3's narrowing already gave the STRAIGHT
 * swap back** — two opposed cars present the same axis and are admitted — so what
 * is left for this object is the TURNING swap, where each car entered its cell on
 * a crossing axis and the pair is a 2-cycle nothing but the valve clears.
 * Dossier 1.7's `greenLightsIgnoreCollisions` names the behaviour that lifts it —
 * only the entrant's OWN lane is consulted — and an upgrade is that row with no
 * phase attached: every axis, always. `blocking.test.ts`'s *"an upgrade gives the
 * TURNING swap back"* is that derivation as a test, on Task 2's own deadlock
 * fixture.
 *
 * **THIS FILE CONTAINS NO `throw` ON ANY STATE-DEPENDENT PATH**, and that is a
 * requirement rather than an observation — Decision 9: nothing in `step` may throw
 * over a configuration a player can reach. An upgrade on a cell whose roads have
 * all been erased is INERT, not fatal.
 *
 * Everything here is integer-only, allocation-free, and reads `state.roads`
 * through `isJunctionCell` while writing only `upgradeAt` and two header slots.
 *
 * **The import cycle is real and safe by the same invariant every other one in
 * this package is.** `buildings.ts` imports `isUpgraded` from here, this file
 * imports `isJunctionCell` from `graph.ts`, `graph.ts` imports `roads.ts` and
 * `roads.ts` imports `buildings.ts`. Every cross-reference is read inside a
 * function body, never at module-evaluation time, and the only module-scope
 * bindings here are the six frozen literals below, which touch no other module.
 */

/** Why a placement was refused. */
export type UpgradeRefusal = 'no-inventory' | 'capacity' | 'off-board' | 'not-a-junction' | 'occupied'
export type UpgradePlaceResult = { readonly ok: true } | { readonly ok: false; readonly reason: UpgradeRefusal }

/** Does `cell` carry a junction upgrade? `upgradeAt` is a FLAG: 1 or 0. */
export function isUpgraded(state: GameState, cell: number): boolean {
  return (state.upgradeAt[cell] as number) !== 0
}

/**
 * Module-scope frozen singletons, exactly as `canPlaceRoad`'s and
 * `canPlaceHouse`'s are and for the same measured reason: the object literal
 * these functions would otherwise return ESCAPES, and M1d measured the identical
 * literal in `canPlaceRoad` at 40.6-44.3 B per call. `upgrades.test.ts` pins the
 * identity, because `toEqual` cannot see it and no allocation window covers a
 * function a player calls once a week.
 */
const UPGRADE_OK: UpgradePlaceResult = Object.freeze({ ok: true })
const UPGRADE_NO_INVENTORY: UpgradePlaceResult = Object.freeze({ ok: false, reason: 'no-inventory' })
const UPGRADE_CAPACITY: UpgradePlaceResult = Object.freeze({ ok: false, reason: 'capacity' })
const UPGRADE_OFF_BOARD: UpgradePlaceResult = Object.freeze({ ok: false, reason: 'off-board' })
const UPGRADE_NOT_A_JUNCTION: UpgradePlaceResult = Object.freeze({ ok: false, reason: 'not-a-junction' })
const UPGRADE_OCCUPIED: UpgradePlaceResult = Object.freeze({ ok: false, reason: 'occupied' })

/**
 * §5.6: *"place only on an existing road junction, never plain road, and cost 0
 * tiles."* That is the whole rule, and the checks are ordered cheapest-first.
 *
 * **`isJunctionCell` and not `junctionAdmitsOne`**: the placement rule asks
 * whether the cell IS a junction, and `junctionAdmitsOne` asks whether the default
 * rule governs it — which is false on a cell that already carries an upgrade, so
 * using it here would refuse with the wrong reason. The two predicates disagree
 * at exactly the cells this function is most often asked about.
 *
 * **`Number.isInteger` is part of the bounds check and not tidiness.** A
 * fractional index passes `cell >= 0 && cell < world.cells`, and
 * `upgradeAt[1.5] = 1` is **silently discarded** by the runtime — so without it
 * the one reachable failure is a placement that reports success, spends an item
 * and does nothing.
 *
 * Five ways to decline, five reasons, because *"a function with more than two
 * ways to decline puts the reason in the signature"*. The ORDER is a decision:
 * two of the five can be true at once and the caller is told the cheapest.
 */
export function canPlaceUpgrade(state: GameState, world: WorldData, cell: number): UpgradePlaceResult {
  if ((state.header[H_INV_UPGRADES] as number) < 1) return UPGRADE_NO_INVENTORY
  if ((state.header[H_UPGRADE_COUNT] as number) >= MAX_UPGRADES) return UPGRADE_CAPACITY
  if (!Number.isInteger(cell) || cell < 0 || cell >= world.cells) return UPGRADE_OFF_BOARD
  if (!isJunctionCell(state, cell)) return UPGRADE_NOT_A_JUNCTION
  if (isUpgraded(state, cell)) return UPGRADE_OCCUPIED
  return UPGRADE_OK
}

/**
 * Places an upgrade. Returns false and writes nothing on a refusal.
 *
 * **Validity first, then every write**, so a refused placement is a no-op on the
 * whole buffer rather than on most of it — `upgrades.test.ts` asserts that with
 * `hashState`, which is the only instrument that can see a partial write into a
 * region the caller was not looking at.
 *
 * `H_UPGRADE_COUNT` and the flag move together, in one direction each, and the
 * test that keeps them in step asserts the count against a scan of `upgradeAt`
 * rather than against this function's own arithmetic.
 */
export function applyPlaceUpgrade(state: GameState, world: WorldData, cell: number): boolean {
  if (!canPlaceUpgrade(state, world, cell).ok) return false
  state.upgradeAt[cell] = 1
  state.header[H_UPGRADE_COUNT] = (state.header[H_UPGRADE_COUNT] as number) + 1
  state.header[H_INV_UPGRADES] = (state.header[H_INV_UPGRADES] as number) - 1
  return true
}
