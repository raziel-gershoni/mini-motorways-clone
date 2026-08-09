import { describe, it, expect } from 'vitest'
import { fitCamera } from '../src/camera'
import { PALETTE } from '../src/palette'
import { HitRegion, TerrainClass, type RenderFrame } from '../src/types'

/**
 * The interface half of Task 3. `RenderFrame` is consumed VERBATIM by Tasks 5,
 * 6 and 9, so the hand-built frame below is the pin: it is a plain object of
 * typed arrays and scalars with no `sim` types anywhere in it, and it fails
 * `pnpm typecheck` — which covers `test/` — the moment a field is renamed,
 * retyped or dropped. That is the check that "later tasks consume it verbatim"
 * actually needs; a prose list in a brief is not one.
 *
 * It doubles as the existence proof for plan Decision 3: `render` can be
 * exercised with hand-built arrays and no simulation at all.
 */

const W = 8
const H = 6
const CELLS = W * H

/**
 * The revealed rect this fixture's camera draws: a STRICT SUB-RECT of the 8x6
 * board, `x ∈ [1, 7)`, `y ∈ [1, 5)`.
 *
 * Review finding R1, and the reason it is not `{0, 0, W, H}`: with the rect
 * covering the whole board, `inside()` below returns `true` for every cell
 * index that exists, so the assertion named "places every dead slot INSIDE the
 * drawn region" asserts nothing — mutating `inside` to `return true` left all
 * 82 tests green. That is the same trap as the cell-0 one, from the other
 * direction: **if there is no outside, in-side-ness cannot be what does the
 * work.** A sub-rect gives `inside()` content, and it puts cell 0 — the sim's
 * real dead value — genuinely outside, which is the fact the whole fixture
 * shape exists to encode.
 */
const RECT = { x0: 1, y0: 1, cols: 6, rows: 4 } as const

/**
 * Deliberately built the way a LIVENESS fixture must be built (plan Decision 2,
 * and the catalogue's "a bounds check can hide the defect a fixture was built
 * to expose"): the dead house/dest/car slots below carry cell indices INSIDE
 * the drawn region, not the sim's real dead value of 0. No region behind
 * `RenderFrame` carries a -1 sentinel — unused building slots are simply those
 * at index >= H_HOUSE_COUNT / H_DEST_COUNT and unused cars are PHASE_NONE — so
 * every unused cell reads 0, which is a real, in-bounds cell. (Narrowed at M1d
 * Task 2: `sim` gained its first -1-filled region, `occupancy`, which is
 * cell-indexed, has no liveness prefix, and is not part of this interface.) At M2's camera cell 0
 * is OUTSIDE the revealed rect, so a fixture that leaves dead slots at 0 is
 * proved correct by the renderer's bounds check rather than by the liveness
 * prefix, and the prefix is never exercised.
 *
 * **All three collections carry a dead slot, destinations included.** Six of
 * the frame's twenty-two fields sit behind `destCount`, and an earlier version
 * of this fixture had `destCell.length === destCount` — no dead destination
 * existed, so appending one at cell 0 past the count, and setting `destCount`
 * to 0 outright, both left all 82 tests green. Task 5 draws destinations from
 * this prefix; a template that cannot represent a dead destination would hand
 * it an assertion that passes whether or not `drawFrame` respects the count.
 */
function handBuiltFrame(): RenderFrame {
  const roads = new Uint8Array(CELLS)
  const terrainClass = new Uint8Array(CELLS)
  roads[2 * W + 3] = 0b0001_0001 // N|S, a non-zero mask
  terrainClass[1 * W + 1] = TerrainClass.WATER
  terrainClass[1 * W + 2] = TerrainClass.TREE

  // Four house slots allocated, two live. The two dead ones sit on real,
  // in-bounds, drawn cells: (3, 3) and (4, 3).
  const houseCell = new Int32Array([2 * W + 2, 4 * W + 5, 3 * W + 3, 3 * W + 4])
  const houseColour = new Uint8Array([0, 1, 0, 0])

  // THREE destination slots allocated, two live. The dead one is at (2, 3) —
  // inside the drawn rect, non-zero, and distinct from every live entry. Every
  // one of the six parallel dense arrays is extended with it, because `render`
  // indexes all six by the same slot number.
  const destCell = new Int32Array([1 * W + 5, 3 * W + 1, 3 * W + 2])
  const destColour = new Uint8Array([0, 0, 0])
  const destKind = new Uint8Array([0, 1, 0])
  const destOrientation = new Uint8Array([0, 2, 0])
  const destPins = new Uint8Array([3, 0, 0])
  const destCarpark = new Int32Array([1 * W + 4, 3 * W + 2, 2 * W + 2])

  // Eight car slots allocated, two live; the tail holds a stale in-bounds
  // position rather than (0, 0).
  const carXY = new Float32Array(16)
  carXY[0] = 3.5
  carXY[1] = 2.25
  carXY[2] = 5
  carXY[3] = 4
  for (let i = 4; i < 16; i += 2) {
    carXY[i] = 2
    carXY[i + 1] = 2
  }
  const carColour = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0])

  return {
    camera: fitCamera(
      { cssW: 390, cssH: 844, topInset: 47, bottomInset: 34, rawDpr: 2.625, performanceClass: 'LOW' },
      RECT,
    ),
    gridW: W,
    roads,
    terrainClass,
    houseCount: 2,
    houseCell,
    houseColour,
    destCount: 2,
    destCell,
    destColour,
    destKind,
    destOrientation,
    destPins,
    destCarpark,
    carCount: 2,
    carXY,
    carColour,
    week: 3,
    day: 5,
    score: 12,
    tilesLeft: 17,
    paused: false,
  }
}

describe('RenderFrame is constructible from plain typed arrays and scalars alone', () => {
  it('builds with no sim state, no world, and no functions — only bytes and numbers', () => {
    const frame = handBuiltFrame()
    expect(frame.gridW).toBe(8)
    expect(frame.roads.length).toBe(48)
    expect(frame.camera.tileSize).toBeGreaterThan(0)
    expect(frame.paused).toBe(false)
  })

  it('carries a liveness prefix for each of the three variable-length collections', () => {
    // Plan Decision 3: `render` is handed houseCount, destCount and carCount
    // and reads [0, count) only, so a phantom is UNREPRESENTABLE at the
    // boundary rather than merely undrawn. Cars have no index-based count in
    // the sim at all — PHASE_NONE is their only liveness marker — which is why
    // `game` must densify them before the frame is handed over.
    //
    // All three comparisons are STRICT. `toBeLessThanOrEqual` on destinations
    // passed at equality and therefore carried no information — it was true of
    // a fixture with no dead destination at all, which is exactly the fixture
    // that was shipped (review R1).
    const frame = handBuiltFrame()
    expect(frame.houseCount).toBeLessThan(frame.houseCell.length)
    expect(frame.destCount).toBeLessThan(frame.destCell.length)
    expect(frame.carCount * 2).toBeLessThan(frame.carXY.length)
  })

  it('is non-vacuous: every collection has at least one LIVE entry as well as a dead slot', () => {
    // The other half of the prefix's meaning, and the half a strict `<` cannot
    // give: a count of 0 satisfies "count < length" trivially while making
    // every downstream liveness assertion vacuous, because nothing is drawn at
    // all and "the dead slots were not drawn" is then true by accident.
    const frame = handBuiltFrame()
    expect(frame.houseCount).toBe(2)
    expect(frame.destCount).toBe(2)
    expect(frame.carCount).toBe(2)
  })

  it('keeps all six destination arrays the same length, so one slot index addresses all of them', () => {
    // `render` reads destCell/destColour/destKind/destOrientation/destPins/
    // destCarpark by the same slot number. A short array hands `undefined` to
    // a fillStyle or a coordinate on the last live destination — and under
    // `noUncheckedIndexedAccess` that is a type error in `render` but not in a
    // hand-built fixture, so the fixture is where it has to be caught.
    const frame = handBuiltFrame()
    const n = frame.destCell.length
    expect(n).toBe(3)
    expect(frame.destColour.length).toBe(n)
    expect(frame.destKind.length).toBe(n)
    expect(frame.destOrientation.length).toBe(n)
    expect(frame.destPins.length).toBe(n)
    expect(frame.destCarpark.length).toBe(n)
  })

  it('places every dead slot INSIDE the drawn region, not on cell 0', () => {
    // The whole point of the fixture shape (see the module comment). If the
    // dead slots sat at cell 0 the renderer's bounds check would suppress them
    // and Task 5's liveness assertions would pass for the wrong reason.
    const frame = handBuiltFrame()
    const cam = frame.camera
    const inside = (cell: number): boolean => {
      const x = cell % frame.gridW
      const y = Math.floor(cell / frame.gridW)
      return x >= cam.x0 && x < cam.x0 + cam.cols && y >= cam.y0 && y < cam.y0 + cam.rows
    }

    // NEGATIVE CONTROL for `inside` itself, which is the fix for review R1.
    // Without it, `inside` returning `true` unconditionally satisfies every
    // assertion below — and that is not hypothetical: the previous fixture
    // revealed the whole board, so `inside` COULD NOT return false for any
    // cell that exists, and mutating it to `return true` left all 82 tests
    // green. Cell 0 is the sim's real dead value and the one that must be
    // outside; (7, 5) is the far corner, outside on both axes at once.
    expect(inside(0), 'cell 0 must be OUTSIDE the drawn rect or this fixture proves nothing').toBe(
      false,
    )
    expect(inside(5 * W + 7)).toBe(false)
    expect(inside(2 * W + 2), 'a live house must be inside, or the rect excludes everything').toBe(
      true,
    )

    for (let i = frame.houseCount; i < frame.houseCell.length; i++) {
      expect(inside(frame.houseCell[i] as number), `dead house slot ${i} is outside the drawn rect`).toBe(true)
      expect(frame.houseCell[i] as number).not.toBe(0)
    }
    for (let i = frame.destCount; i < frame.destCell.length; i++) {
      expect(inside(frame.destCell[i] as number), `dead dest slot ${i} is outside the drawn rect`).toBe(true)
      expect(frame.destCell[i] as number).not.toBe(0)
    }
    for (let i = frame.carCount * 2; i < frame.carXY.length; i += 2) {
      const x = frame.carXY[i] as number
      const y = frame.carXY[i + 1] as number
      expect(x >= cam.x0 && x < cam.x0 + cam.cols, `dead car slot ${i / 2} is outside the drawn rect`).toBe(true)
      expect(y >= cam.y0 && y < cam.y0 + cam.rows).toBe(true)
      expect(x === 0 && y === 0).toBe(false)
    }
  })

  it('indexes the board-indexed arrays as y * gridW + x', () => {
    const frame = handBuiltFrame()
    expect(frame.roads[2 * frame.gridW + 3] as number).toBe(0b0001_0001)
    expect(frame.terrainClass[1 * frame.gridW + 1] as number).toBe(TerrainClass.WATER)
  })
})

describe('TerrainClass — render\'s own copy of the terrain numbering', () => {
  it('numbers LAND 0, WATER 1, MOUNTAIN 2, TREE 3', () => {
    // Plan Decision 3: this is a DELIBERATE second copy of `shared`'s TERRAIN
    // numbering. `render` importing `shared` is forbidden by spec 4, so the
    // choice is between a copy and a violation. The fold that produces these
    // bytes lives in `game` (Task 6) and has its own test, so the copy has one
    // place to drift and one test watching it — this assertion is the anchor
    // that test is written against.
    expect(TerrainClass.LAND).toBe(0)
    expect(TerrainClass.WATER).toBe(1)
    expect(TerrainClass.MOUNTAIN).toBe(2)
    expect(TerrainClass.TREE).toBe(3)
  })

  it('is frozen, so a consumer cannot renumber terrain in place', () => {
    expect(Object.isFrozen(TerrainClass)).toBe(true)
  })
})

describe('HitRegion — screenToGrid\'s classification codes', () => {
  it('gives every region a distinct, truthy code', () => {
    // Truthy matters: a GRID code of 0 invites `if (hit.region)` to reject the
    // one case the caller wants.
    const codes = Object.values(HitRegion)
    expect(new Set(codes).size).toBe(codes.length)
    for (const c of codes) expect(c).toBeGreaterThan(0)
  })

  it('is frozen', () => {
    expect(Object.isFrozen(HitRegion)).toBe(true)
  })
})

describe('the palette — spec 7.1\'s theme object, plus tree, minus shadow', () => {
  it('carries every field spec 7.1 names, with tree added and shadow removed', () => {
    // `tree` is added because spec 7.1's list omits it while spec 5.1 makes
    // tree one of the four terrains. `shadow` is removed by plan Decision 7:
    // M2 ships no shadows of any kind, and a palette entry for one is an
    // invitation to reintroduce a full-canvas layer that costs twice what the
    // road bake M0 deleted did.
    expect(Object.keys(PALETTE).sort()).toEqual([
      'background',
      'groups',
      'land',
      'mountain',
      'road',
      'roadEdge',
      'tree',
      'uiText',
      'water',
    ])
    expect('shadow' in PALETTE).toBe(false)
  })

  it('is every colour a preallocated #rrggbb string', () => {
    // Plan Decision 3 / Task 3: the strings are preallocated because
    // `ctx.fillStyle = '#' + something` allocates a string INSIDE the frame
    // loop, which the plan's Global Constraints forbid.
    const hex = /^#[0-9a-f]{6}$/
    for (const [name, value] of Object.entries(PALETTE)) {
      if (name === 'groups') continue
      expect(typeof value, `${name} is not a string`).toBe('string')
      expect(value as string, `${name} is not a #rrggbb literal`).toMatch(hex)
    }
    for (let i = 0; i < PALETTE.groups.length; i++) {
      expect(PALETTE.groups[i] as string, `group ${i}`).toMatch(hex)
    }
  })

  it('carries six group colours, the ceiling MAX_GROUP_COUNT allows', () => {
    // Spec 4.2: colour group count is per-map, 5 or 6. A palette of 5 would
    // hand `undefined` to fillStyle on a 6-group map.
    expect(PALETTE.groups.length).toBe(6)
  })

  it('makes every colour in the palette distinct, groups included', () => {
    const all = [
      PALETTE.background,
      PALETTE.land,
      PALETTE.water,
      PALETTE.mountain,
      PALETTE.tree,
      PALETTE.road,
      PALETTE.roadEdge,
      PALETTE.uiText,
      ...PALETTE.groups,
    ]
    expect(new Set(all).size).toBe(all.length)
  })

  it('separates the group colours on LIGHTNESS as well as hue', () => {
    // Spec 7.4 names the original's weakest area: real protanopes report
    // yellow and light green being indistinguishable in BOTH of its colour
    // modes, and 5-6 similar pastels are materially harder to tell apart on a
    // 5-inch screen. Full 7.4 compliance — simulator passes as a build step —
    // is explicitly NOT in M2 ("the palette is a placeholder"), so this is the
    // weaker claim it can honestly make: no two groups differ in hue alone.
    // WCAG relative luminance, and the ladder below was solved for, not
    // stumbled into.
    const lum = (hex: string): number => {
      const ch = (o: number): number => {
        const c = parseInt(hex.slice(o, o + 2), 16) / 255
        return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5)
    }
    const ys = PALETTE.groups.map(lum).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i++) {
      expect(
        (ys[i] as number) - (ys[i - 1] as number),
        `group luminances ${(ys[i - 1] as number).toFixed(3)} and ${(ys[i] as number).toFixed(3)} are too close`,
      ).toBeGreaterThan(0.04)
    }
  })

  it('is frozen, array included — `readonly` is a type-level claim with no runtime effect', () => {
    expect(Object.isFrozen(PALETTE)).toBe(true)
    expect(Object.isFrozen(PALETTE.groups)).toBe(true)
  })
})
