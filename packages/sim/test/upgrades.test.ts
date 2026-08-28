import { describe, it, expect } from 'vitest'
import { INTERSECTION_DEGREE, MAX_UPGRADES } from '@laneways/shared'
import {
  canPlaceUpgrade,
  applyPlaceUpgrade,
  isUpgraded,
  type UpgradePlaceResult,
  type UpgradeRefusal,
} from '../src/upgrades'
import { H_INV_UPGRADES, H_UPGRADE_COUNT, H_TILES, H_EPOCH, hashState, type GameState } from '../src/state'
import { isJunctionCell, junctionAdmitsOne, roadDegree } from '../src/graph'
import { eraseRoad } from '../src/roads'
import { step, type TickInputs } from '../src/step'
import {
  teeJunction,
  straightCorridor,
  bentCorridor,
  type TeeRig,
  type CorridorRig,
  type BentRig,
} from './junctionRigs'

/**
 * **The placement rule and the flag, which are the whole of `upgrades.ts`.**
 * The ENTRY rule this object exists for is one clause in `junctionAdmitsOne` and
 * is tested in `graph.test.ts` (the four-case table) and `blocking.test.ts` (the
 * entry outcomes and the head-on derivation) — deliberately not here, because
 * this module does not import `blocking.ts` and a test file that reaches across
 * that boundary would be the only thing suggesting it should.
 */

const NO_INPUT: TickInputs = { actions: [] }

/** The refusal reason, or `'ok'` — so a failing case prints the reason it got. */
function reasonOf(r: UpgradePlaceResult): UpgradeRefusal | 'ok' {
  return r.ok ? 'ok' : r.reason
}

function tilesLeft(s: GameState): number {
  return s.header[H_TILES] as number
}

function withInventory<T extends { readonly s: GameState }>(rig: T, held: number): T {
  rig.s.header[H_INV_UPGRADES] = held
  return rig
}

/** A degree-3 T with `held` upgrades in hand. */
function junctionWithInventory(held: number, id = 'upgrade-tee'): TeeRig {
  return withInventory(teeJunction(id), held)
}

/** A degree-2 straight corridor with `held` upgrades in hand. */
function corridorWithInventory(held: number, id = 'upgrade-corridor'): CorridorRig {
  return withInventory(straightCorridor(id), held)
}

/**
 * One board carrying all three of the shapes that are "never plain road" for
 * different reasons: bare ground, a dead end, and a degree-2 elbow.
 */
function mixedBoardWithInventory(held: number, id = 'upgrade-mixed'): BentRig & {
  readonly bare: number
  readonly deadEnd: number
  readonly elbow: number
} {
  const rig = withInventory(bentCorridor(id), held)
  return { ...rig, bare: 0, deadEnd: rig.west, elbow: rig.mid }
}

describe('canPlaceUpgrade — spec 5.6, "only on an existing road junction, never plain road"', () => {
  it('accepts a degree-3 cell with an upgrade in hand', () => {
    const rig = junctionWithInventory(1)
    expect(roadDegree(rig.s, rig.centre), 'the fixture is exactly at the threshold').toBe(
      INTERSECTION_DEGREE,
    )
    expect(canPlaceUpgrade(rig.s, rig.world, rig.centre)).toEqual({ ok: true })
  })

  it('refuses with none in hand', () => {
    const rig = junctionWithInventory(0)
    expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, rig.centre))).toBe('no-inventory')
  })

  it('refuses at MAX_UPGRADES, rather than silently dropping the placement', () => {
    const rig = junctionWithInventory(1)
    rig.s.header[H_UPGRADE_COUNT] = MAX_UPGRADES
    expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, rig.centre))).toBe('capacity')
  })

  it('refuses an off-board cell', () => {
    const rig = junctionWithInventory(1)
    expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, rig.world.cells + 3))).toBe('off-board')
    expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, -1))).toBe('off-board')
    // A non-integer is off-board too, and it is the one form `inBounds` alone
    // would admit: `1.5 >= 0 && 1.5 < cells` is true, and `upgradeAt[1.5]` is
    // `undefined` — a silent no-op write rather than a refusal.
    expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, 1.5))).toBe('off-board')
  })

  it('refuses PLAIN ROAD — a corridor cell of degree 2', () => {
    const rig = corridorWithInventory(1)
    expect(roadDegree(rig.s, rig.mid), 'the fixture really is degree 2').toBe(2)
    expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, rig.mid))).toBe('not-a-junction')
  })

  it('refuses BARE GROUND, a dead end, and a degree-2 elbow, all with the same reason', () => {
    // Three shapes, one reason: "never plain road" is about degree, not about
    // whether the cell has any road at all, and a fixture that only tried bare
    // ground would not distinguish them.
    const rig = mixedBoardWithInventory(1)
    expect(roadDegree(rig.s, rig.bare), 'bare ground').toBe(0)
    expect(roadDegree(rig.s, rig.deadEnd), 'a dead end').toBe(1)
    expect(roadDegree(rig.s, rig.elbow), 'an elbow').toBe(2)
    for (const cell of [rig.bare, rig.deadEnd, rig.elbow]) {
      expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, cell)), `cell ${cell}`).toBe('not-a-junction')
    }
  })

  it('refuses a cell that already carries an upgrade', () => {
    const rig = junctionWithInventory(2)
    expect(applyPlaceUpgrade(rig.s, rig.world, rig.centre)).toBe(true)
    expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, rig.centre))).toBe('occupied')
  })

  it('checks in the stated order: no-inventory beats not-a-junction', () => {
    // Two things wrong at once, and the reason a caller gets is a decision. The
    // cheap check comes first, and only a fixture with BOTH conditions true can
    // tell the two orders apart.
    const rig = corridorWithInventory(0)
    expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, rig.mid))).toBe('no-inventory')
  })

  it('checks in the stated order: capacity beats not-a-junction, and off-board beats both', () => {
    // The same decision at the other two boundaries, because "cheapest first" is
    // a total order and a single pair only pins one link of it.
    const cap = corridorWithInventory(1)
    cap.s.header[H_UPGRADE_COUNT] = MAX_UPGRADES
    expect(reasonOf(canPlaceUpgrade(cap.s, cap.world, cap.mid))).toBe('capacity')
    // Off-board is checked after the two header reads, so a caller with nothing
    // in hand asking about nowhere hears 'no-inventory' — asserted rather than
    // left to a reading, because it is the one order a reader might expect to be
    // the other way round.
    const oob = corridorWithInventory(0)
    expect(reasonOf(canPlaceUpgrade(oob.s, oob.world, -1))).toBe('no-inventory')
  })

  it('is total: every refusal reason is reachable, so the union has no dead member', () => {
    // A union with an unreachable member is a signature that lies about the
    // function. Each reason is produced above; this collects them so a sixth
    // reason added without a fixture fails here rather than nowhere.
    const seen = new Set<string>()
    seen.add(reasonOf(canPlaceUpgrade(junctionWithInventory(0).s, teeJunction('t0').world, 0)))
    const j = junctionWithInventory(1, 'total-j')
    seen.add(reasonOf(canPlaceUpgrade(j.s, j.world, j.centre)))
    seen.add(reasonOf(canPlaceUpgrade(j.s, j.world, -1)))
    seen.add(reasonOf(canPlaceUpgrade(j.s, j.world, j.bare)))
    const cap = junctionWithInventory(1, 'total-cap')
    cap.s.header[H_UPGRADE_COUNT] = MAX_UPGRADES
    seen.add(reasonOf(canPlaceUpgrade(cap.s, cap.world, cap.centre)))
    const occ = junctionWithInventory(2, 'total-occ')
    applyPlaceUpgrade(occ.s, occ.world, occ.centre)
    seen.add(reasonOf(canPlaceUpgrade(occ.s, occ.world, occ.centre)))
    expect([...seen].sort()).toEqual([
      'capacity',
      'no-inventory',
      'not-a-junction',
      'occupied',
      'off-board',
      'ok',
    ])
  })

  it('returns FROZEN singletons, so no call allocates a result object', () => {
    // The same discipline `canPlaceRoad` and `canPlaceHouse` carry, for the same
    // measured reason: an escaping object literal costs 40 B a call on a path a
    // UI can drive per frame. Identity, not shape — `toEqual` cannot see this.
    const a = junctionWithInventory(1, 'frozen-a')
    const b = junctionWithInventory(1, 'frozen-b')
    expect(canPlaceUpgrade(a.s, a.world, a.centre)).toBe(canPlaceUpgrade(b.s, b.world, b.centre))
    expect(canPlaceUpgrade(a.s, a.world, a.bare)).toBe(canPlaceUpgrade(b.s, b.world, b.bare))
    expect(Object.isFrozen(canPlaceUpgrade(a.s, a.world, a.centre))).toBe(true)
    expect(Object.isFrozen(canPlaceUpgrade(a.s, a.world, a.bare))).toBe(true)
  })
})

describe('applyPlaceUpgrade', () => {
  it('sets the flag, counts it, and spends one from the inventory', () => {
    const rig = junctionWithInventory(2)
    expect(applyPlaceUpgrade(rig.s, rig.world, rig.centre)).toBe(true)
    expect(rig.s.header[H_UPGRADE_COUNT]).toBe(1)
    expect(rig.s.header[H_INV_UPGRADES]).toBe(1)
    expect(rig.s.upgradeAt[rig.centre], 'a flag, not an index').toBe(1)
    expect(isUpgraded(rig.s, rig.centre)).toBe(true)
    expect(isUpgraded(rig.s, rig.bare), 'a plain cell answers false').toBe(false)
  })

  it('costs ZERO tiles, per 5.6', () => {
    const rig = junctionWithInventory(1)
    const tiles = tilesLeft(rig.s)
    applyPlaceUpgrade(rig.s, rig.world, rig.centre)
    expect(tilesLeft(rig.s)).toBe(tiles)
  })

  it('lays no road and erases none', () => {
    const rig = junctionWithInventory(1)
    const before = [...rig.s.roads]
    applyPlaceUpgrade(rig.s, rig.world, rig.centre)
    expect([...rig.s.roads]).toEqual(before)
  })

  it('returns false and changes NOTHING when validity refuses', () => {
    const rig = corridorWithInventory(1)
    const before = hashState(rig.s)
    expect(applyPlaceUpgrade(rig.s, rig.world, rig.mid)).toBe(false)
    expect(hashState(rig.s)).toBe(before)
  })

  it('writes exactly ONE flag byte and two header slots, and nothing else', () => {
    // `hashState` above can only say "something changed"; this says what. The
    // whole-buffer diff is what catches a write that lands in a neighbouring
    // region — the failure a bare count of `upgradeAt` non-zeros cannot see.
    const rig = junctionWithInventory(2)
    const before = new Uint8Array(rig.s.buffer.slice(0))
    applyPlaceUpgrade(rig.s, rig.world, rig.centre)
    const after = new Uint8Array(rig.s.buffer)
    const moved: number[] = []
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) moved.push(i)
    // Two Int32 header slots (4 bytes each, one byte of each actually moving on
    // these values) plus one Uint8 flag. Byte-level, so the assertion is on the
    // OFFSETS rather than on a count that a wider write could satisfy.
    const upgradeOffset = rig.s.upgradeAt.byteOffset + rig.centre
    const invOffset = rig.s.header.byteOffset + H_INV_UPGRADES * 4
    const countOffset = rig.s.header.byteOffset + H_UPGRADE_COUNT * 4
    expect(moved).toEqual([invOffset, countOffset, upgradeOffset].sort((a, b) => a - b))
  })

  it('PERSISTS when the player erases a road and the cell stops being a junction', () => {
    // A decision, not an accident. `canPlaceUpgrade` asks about degree; the ENTRY
    // rule asks about `upgradeAt` and nothing else. An upgrade that silently went
    // inert when a player redrew a road would be a mechanism that stops working
    // with no visible cause, which is this project's worst defect shape. Deleting
    // an upgrade is M1g's, so the player's recourse is to redraw the junction.
    const rig = junctionWithInventory(1)
    applyPlaceUpgrade(rig.s, rig.world, rig.centre)
    eraseRoad(rig.s, rig.world, rig.centre, rig.north)
    expect(roadDegree(rig.s, rig.centre), 'now a corridor').toBe(2)
    expect(isJunctionCell(rig.s, rig.centre)).toBe(false)
    expect(isUpgraded(rig.s, rig.centre), 'and the upgrade is still there').toBe(true)
    expect(junctionAdmitsOne(rig.s, rig.centre), 'and still governs the cell').toBe(false)
  })

  it('IS INERT, NOT FATAL, on a cell whose roads have ALL been erased', () => {
    // **This is Decision 9 applied to this object, and it is the rule that
    // survived the second review's C1 after the swap deleted C1's mechanism.**
    // The previous design's controller called `bestAxis`, which THREW when no
    // candidate axis had road — reachable by placing on a four-way and erasing
    // every arm, and fatal because `step` had already written `H_EPOCH`, so the
    // buffer was poisoned for the rest of the run and `restore` refused it.
    //
    // NOTHING IN `upgrades.ts` THROWS ON ANY STATE-DEPENDENT PATH. There is no
    // axis to select, no candidate to search and no per-tick entry point. Drive
    // it anyway: this test is the standing proof, not the argument.
    const rig = junctionWithInventory(1)
    applyPlaceUpgrade(rig.s, rig.world, rig.centre)
    for (const arm of [rig.north, rig.east, rig.west]) {
      expect(eraseRoad(rig.s, rig.world, rig.centre, arm), `arm ${arm}`).toBe(true)
    }
    expect(roadDegree(rig.s, rig.centre)).toBe(0)
    expect(() => {
      for (let t = 0; t < 400; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    }, 'step must not throw over a configuration a player can reach').not.toThrow()
    expect(rig.s.header[H_EPOCH], 'and the buffer is not poisoned').toBe(0)
    expect(isUpgraded(rig.s, rig.centre), 'the flag is still set and simply has nothing to exempt')
      .toBe(true)
  })

  it('refuses the second placement on one cell, so the inventory cannot drain into a no-op', () => {
    // The `occupied` check's real job. Without it the second call would spend an
    // item and set a flag that is already set, and the only visible symptom
    // would be an inventory that empties faster than the board fills.
    const rig = junctionWithInventory(3)
    expect(applyPlaceUpgrade(rig.s, rig.world, rig.centre)).toBe(true)
    expect(applyPlaceUpgrade(rig.s, rig.world, rig.centre)).toBe(false)
    expect(rig.s.header[H_INV_UPGRADES], 'two still in hand').toBe(2)
    expect(rig.s.header[H_UPGRADE_COUNT], 'and one on the board').toBe(1)
  })

  it('keeps H_UPGRADE_COUNT equal to the number of set flags, in both directions', () => {
    // The two-directional invariant `state.ts` names at `H_UPGRADE_COUNT`, and
    // the reason the count is a slot rather than a scan.
    const rig = junctionWithInventory(2)
    const centres = [rig.centre]
    for (const cell of centres) expect(applyPlaceUpgrade(rig.s, rig.world, cell)).toBe(true)
    let flags = 0
    for (let i = 0; i < rig.s.upgradeAt.length; i++) if ((rig.s.upgradeAt[i] as number) !== 0) flags++
    expect(rig.s.header[H_UPGRADE_COUNT]).toBe(flags)
    expect(flags).toBe(centres.length)
  })
})
