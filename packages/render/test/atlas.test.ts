import { describe, it, expect } from 'vitest'
import {
  ATLAS_COLS,
  ATLAS_MASK_COUNT,
  AtlasVariant,
  GHOST_STROKE_ALPHA,
  GHOST_STROKE_FRACTION,
  MAX_ATLAS_DIMENSION_PX,
  ROAD_DIR_COUNT,
  ROAD_DIR_DX,
  ROAD_DIR_DY,
  ROAD_STROKE_ALPHA,
  ROAD_STROKE_FRACTION,
  atlasSourceX,
  atlasSourceY,
  buildAtlas,
  buildAtlases,
  type AtlasContext,
  type AtlasSurface,
  type AtlasSurfaceFactory,
} from '../src/atlas'
import { PALETTE } from '../src/palette'
import type { Palette } from '../src/types'

/**
 * Task 4's whole test strategy in one sentence: **the atlas is exercised
 * through an injected surface factory, and every assertion below is over
 * recorded drawing state.**
 *
 * This workspace has no jsdom, no `canvas` module and no vitest DOM config;
 * `node -e "typeof OffscreenCanvas"` prints `undefined`. Plan Decision 8 is
 * therefore not a convenience, it is the only way this file runs at all.
 *
 * **What the recorder can see is larger than "the commands issued", and the
 * first version of this file got that wrong in a way that hid a real defect.**
 * It filed the round cap's footprint under "browser property, only the deploy
 * can check it" — and a round cap's reach past an endpoint is `lineWidth / 2`
 * by the canvas spec, which is arithmetic over two things this recorder already
 * captures. 248 of 256 tiles were contaminated by their neighbours' ink and the
 * "cannot observe" label is what ended the search. `describe('the clip')` below
 * is the assertion that should always have existed; the review that found it is
 * why this comment names the mistake rather than quietly fixing it.
 *
 * **What is genuinely out of reach** is re-derived in the report's §2 and is
 * now a shorter, more specific list: rasterised pixel coverage and
 * antialiasing, whether a platform honoured a backing-store size it *reported*
 * honouring, colour management, and whether the rasteriser respects a `clip()`
 * it was issued. A recorder observes commands and geometry derivable from them;
 * it does not observe pixels.
 *
 * The plan's first draft asked for symmetry assertions and its own vacuity
 * check forbade the masks it named (N+S = 17 and E+W = 68 are both symmetric
 * under BOTH axes, so a blank tile would have passed). Every geometric
 * assertion here is a **hand-written literal endpoint list** instead.
 */

// ---------------------------------------------------------------------------
// The recording surface
// ---------------------------------------------------------------------------

/**
 * One recorded mutation of the drawing surface. This union IS the vocabulary of
 * plan Decision 8 — path commands, clip commands and state assignments, in
 * issue order.
 *
 * State assignments are recorded through real accessors rather than sampled at
 * the end, which is what makes "`lineCap` is `'round'`" an assertion about an
 * assignment the builder made rather than about a field's final value. A
 * builder that never touches `lineCap` would leave a plausible default sitting
 * there and pass a final-value check.
 */
type Command =
  | { readonly op: 'save' }
  | { readonly op: 'restore' }
  | { readonly op: 'beginPath' }
  | {
      readonly op: 'rect'
      readonly x: number
      readonly y: number
      readonly w: number
      readonly h: number
    }
  | { readonly op: 'clip' }
  | { readonly op: 'moveTo'; readonly x: number; readonly y: number }
  | { readonly op: 'lineTo'; readonly x: number; readonly y: number }
  | { readonly op: 'stroke' }
  | { readonly op: 'set'; readonly prop: string; readonly value: string | number }

class RecordingContext implements AtlasContext {
  readonly log: Command[] = []

  #lineWidth = 1
  #lineCap: CanvasLineCap = 'butt'
  #lineJoin: CanvasLineJoin = 'miter'
  #strokeStyle: string | CanvasGradient | CanvasPattern = '#000000'
  /** A real 2D context starts fully opaque; so does this, so an omitted assignment shows. */
  #globalAlpha = 1

  get globalAlpha(): number {
    return this.#globalAlpha
  }
  set globalAlpha(value: number) {
    this.#globalAlpha = value
    this.log.push({ op: 'set', prop: 'globalAlpha', value })
  }

  get lineWidth(): number {
    return this.#lineWidth
  }
  set lineWidth(value: number) {
    this.#lineWidth = value
    this.log.push({ op: 'set', prop: 'lineWidth', value })
  }

  get lineCap(): CanvasLineCap {
    return this.#lineCap
  }
  set lineCap(value: CanvasLineCap) {
    this.#lineCap = value
    this.log.push({ op: 'set', prop: 'lineCap', value })
  }

  get lineJoin(): CanvasLineJoin {
    return this.#lineJoin
  }
  set lineJoin(value: CanvasLineJoin) {
    this.#lineJoin = value
    this.log.push({ op: 'set', prop: 'lineJoin', value })
  }

  get strokeStyle(): string | CanvasGradient | CanvasPattern {
    return this.#strokeStyle
  }
  set strokeStyle(value: string | CanvasGradient | CanvasPattern) {
    this.#strokeStyle = value
    this.log.push({ op: 'set', prop: 'strokeStyle', value: String(value) })
  }

  save(): void {
    this.log.push({ op: 'save' })
  }
  restore(): void {
    this.log.push({ op: 'restore' })
  }
  beginPath(): void {
    this.log.push({ op: 'beginPath' })
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.log.push({ op: 'rect', x, y, w, h })
  }
  clip(): void {
    this.log.push({ op: 'clip' })
  }
  moveTo(x: number, y: number): void {
    this.log.push({ op: 'moveTo', x, y })
  }
  lineTo(x: number, y: number): void {
    this.log.push({ op: 'lineTo', x, y })
  }
  stroke(): void {
    this.log.push({ op: 'stroke' })
  }
}

class RecordingSurface implements AtlasSurface {
  width: number
  height: number
  readonly ctx = new RecordingContext()
  readonly contextRequests: string[] = []

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
  }

  getContext(contextId: '2d'): AtlasContext | null {
    this.contextRequests.push(contextId)
    return this.ctx
  }
}

interface Recorder {
  readonly create: AtlasSurfaceFactory
  readonly surfaces: RecordingSurface[]
  readonly calls: { readonly widthPx: number; readonly heightPx: number }[]
}

function recorder(): Recorder {
  const surfaces: RecordingSurface[] = []
  const calls: { widthPx: number; heightPx: number }[] = []
  const create: AtlasSurfaceFactory = (widthPx, heightPx) => {
    calls.push({ widthPx, heightPx })
    const surface = new RecordingSurface(widthPx, heightPx)
    surfaces.push(surface)
    return surface
  }
  return { create, surfaces, calls }
}

/** The single recorded surface of a build. Throws rather than returning `undefined`. */
function onlySurface(rec: Recorder): RecordingSurface {
  expect(rec.surfaces.length).toBe(1)
  const surface = rec.surfaces[0]
  if (surface === undefined) throw new Error('test: the factory recorded no surface')
  return surface
}

// ---------------------------------------------------------------------------
// Reading the recording back
// ---------------------------------------------------------------------------

interface Segment {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

interface Tile {
  /** The rect passed to `rect()` immediately before `clip()`, or null if none was. */
  readonly clip: Rect | null
  readonly segments: Segment[]
  /** Every op of the group in order, `save` and `restore` excluded. */
  readonly ops: string[]
}

/**
 * The recorded log split into one group per `save`/`restore` pair, in issue
 * order.
 *
 * **This is deliberately not "group by which tile the coordinates fall in".**
 * Grouping by position would use the mask -> tile mapping that is itself under
 * test; grouping by the save/restore structure uses only the shape of the
 * recording, so the coordinates in group *m* remain free to be wrong and the
 * hand-written literals below are what pin them.
 */
function tiles(log: readonly Command[]): Tile[] {
  const out: Tile[] = []
  let ops: string[] | null = null
  let segments: Segment[] = []
  let clip: Rect | null = null
  let lastRect: Rect | null = null
  let pendingX = Number.NaN
  let pendingY = Number.NaN

  for (const command of log) {
    if (command.op === 'save') {
      expect(ops, 'a nested save — the previous tile was never restored').toBeNull()
      ops = []
      segments = []
      clip = null
      lastRect = null
      continue
    }
    if (command.op === 'restore') {
      expect(ops, 'a restore with no matching save').not.toBeNull()
      out.push({ clip, segments, ops: ops ?? [] })
      ops = null
      continue
    }
    if (ops === null) continue // outside any tile group: the four state assignments
    ops.push(command.op)
    if (command.op === 'rect') {
      lastRect = { x: command.x, y: command.y, w: command.w, h: command.h }
    } else if (command.op === 'clip') {
      clip = lastRect
    } else if (command.op === 'moveTo') {
      pendingX = command.x
      pendingY = command.y
    } else if (command.op === 'lineTo') {
      expect(Number.isNaN(pendingX), 'a lineTo with no preceding moveTo').toBe(false)
      segments.push({ x1: pendingX, y1: pendingY, x2: command.x, y2: command.y })
      pendingX = Number.NaN
      pendingY = Number.NaN
    }
  }
  expect(ops, 'a save with no matching restore').toBeNull()
  return out
}

/** Tile group `mask`, with a hard failure rather than `undefined` if it is missing. */
function tileFor(log: readonly Command[], mask: number): Tile {
  const all = tiles(log)
  expect(all.length).toBe(ATLAS_MASK_COUNT)
  const tile = all[mask]
  if (tile === undefined) throw new Error(`test: no recorded tile group for mask ${mask}`)
  return tile
}

function segmentsFor(log: readonly Command[], mask: number): Segment[] {
  return tileFor(log, mask).segments
}

/**
 * A group's segments moved into the coordinate frame of whichever tile they
 * were drawn in, with the tile **derived from the recording itself** — the
 * common start point of the group's segments — and never from the mask.
 *
 * That is what makes the pairwise-distinctness assertion mean something. In
 * ABSOLUTE coordinates all 256 groups are distinct the moment the tile offsets
 * differ, so "ignore the mask's diagonal bits" — which makes 16 masks draw
 * nothing at all — would sail through. Normalised, those 16 collapse onto each
 * other and the assertion sees it.
 */
function localSegments(group: readonly Segment[], tileDevicePx: number): Segment[] {
  if (group.length === 0) return []
  const first = group[0]
  if (first === undefined) throw new Error('test: unreachable — non-empty group with no first')
  const ox = Math.floor(first.x1 / tileDevicePx) * tileDevicePx
  const oy = Math.floor(first.y1 / tileDevicePx) * tileDevicePx
  return group.map((s) => ({ x1: s.x1 - ox, y1: s.y1 - oy, x2: s.x2 - ox, y2: s.y2 - oy }))
}

/** Order-independent identity of a segment set. */
function key(segments: readonly Segment[]): string {
  return segments
    .map((s) => `${s.x1},${s.y1}->${s.x2},${s.y2}`)
    .sort()
    .join('|')
}

/**
 * Population count via a string, not via the bit loop the builder uses. An
 * independent formula, so this is an assertion rather than a restatement of the
 * code under test.
 */
function popcount(mask: number): number {
  return mask.toString(2).replaceAll('0', '').length
}

// --- the ink geometry a round cap makes derivable ---------------------------

/** Exact Euclidean distance from a point to a segment. */
function distanceToSegment(px: number, py: number, s: Segment): number {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const lengthSquared = dx * dx + dy * dy
  let t = 0
  if (lengthSquared > 0) {
    t = ((px - s.x1) * dx + (py - s.y1) * dy) / lengthSquared
    t = Math.max(0, Math.min(1, t))
  }
  return Math.hypot(px - (s.x1 + t * dx), py - (s.y1 + t * dy))
}

/**
 * Is `(px, py)` inside the ink an UNCLIPPED stroke of `segments` would lay
 * down?
 *
 * Not an approximation, not a rasterisation, and not a bounding box. A round
 * cap is a half-disc of diameter `lineWidth` centred on the endpoint and a
 * round join likewise, so the stroked region is exactly the set of points
 * within `lineWidth / 2` of the path — the Minkowski sum with a disc. Membership
 * is therefore one distance comparison per segment, and it is the arithmetic
 * the first version of this file wrongly called a browser property.
 */
function inkedUnclipped(
  px: number,
  py: number,
  segments: readonly Segment[],
  lineWidth: number,
): boolean {
  const radius = lineWidth / 2
  return segments.some((s) => distanceToSegment(px, py, s) <= radius)
}

function insideRect(rect: Rect, px: number, py: number): boolean {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/**
 * 40 device px per tile — chosen so every hand-written literal below is an
 * integer (`HALF` = 20, cap radius `R` = 12) and so the two tile sizes in this
 * file are visibly different. **Not** M2's real 58 px tile, which is used by
 * the second size in the `lineWidth`-varies case; a single-size file cannot see
 * a builder that ignores its argument.
 *
 * At T = 40 the surface is 16 * 40 = 640 px on each axis and tile (c, r) spans
 * `x ∈ [40c, 40c + 40)`, `y ∈ [40r, 40r + 40)` with its centre at
 * `(40c + 20, 40r + 20)`.
 */
const T = 40
const SURFACE = 640
const HALF = 20
/** Half the stroke width — `0.6 * 40 / 2` — and so the reach of a round cap. */
const R = 12

/**
 * The bit order, verified against `packages/sim/src/roads.ts:92-95` — bit *i* is
 * direction *i*, N=0 NE=1 E=2 SE=3 S=4 SW=5 W=6 NW=7, so:
 *
 *   85  = 0b0101_0101 = the four orthogonals
 *   170 = 0b1010_1010 = the four diagonals
 *   5   = 0b0000_0101 = N + E, an elbow — asymmetric under both axes
 *
 * **The four single-diagonal masks are review finding C2 and they are not
 * optional.** The brief's list (0, 1, 5, 85, 170, 255) contains exactly one
 * mask with any diagonal bit in it, and that mask has ALL FOUR — so it is
 * invariant under every permutation of the diagonal bits, and a bit permutation
 * also preserves popcount, tile-local distinctness and the common centre. Every
 * non-identity permutation of NE/SE/SW/NW survived the whole suite before these
 * cases existed. Masks 2, 8, 32 and 128 isolate one diagonal each, which is
 * what makes any permutation move at least one literal.
 */
const MASK_N = 1
const MASK_NE = 2
const MASK_E = 4
const MASK_N_E = 5
const MASK_SE = 8
const MASK_S = 16
const MASK_N_S = 17
const MASK_SW = 32
const MASK_NE_SW = 34
const MASK_ORTHOGONALS = 85
const MASK_NW = 128
const MASK_DIAGONALS = 170
const MASK_ALL = 255

function buildAt(tileDevicePx: number, palette?: Palette): { rec: Recorder; log: Command[] } {
  const rec = recorder()
  if (palette === undefined) buildAtlas(rec.create, tileDevicePx)
  else buildAtlas(rec.create, tileDevicePx, palette)
  return { rec, log: onlySurface(rec).ctx.log }
}

/** The same recorder, pointed at a GHOST build (M1d Task 8). */
function buildGhostAt(
  tileDevicePx: number,
  palette: Palette = PALETTE,
): { rec: Recorder; log: Command[] } {
  const rec = recorder()
  buildAtlas(rec.create, tileDevicePx, palette, AtlasVariant.GHOST)
  return { rec, log: onlySurface(rec).ctx.log }
}

/** The value a build assigned to one context property, or `undefined` if it never did. */
function setValue(log: readonly Command[], prop: string): string | number | undefined {
  const command = log.find((c) => c.op === 'set' && c.prop === prop)
  return command?.op === 'set' ? command.value : undefined
}

// ---------------------------------------------------------------------------

describe('buildAtlas: the surface', () => {
  it('asks the injected factory for ONE 16x16-tile surface and gets its size back', () => {
    const rec = recorder()
    const atlas = buildAtlas(rec.create, T)

    expect(rec.calls).toEqual([{ widthPx: SURFACE, heightPx: SURFACE }])
    expect(atlas.widthPx).toBe(SURFACE)
    expect(atlas.heightPx).toBe(SURFACE)
    expect(atlas.surface.width).toBe(SURFACE)
    expect(atlas.surface.height).toBe(SURFACE)
    expect(atlas.cols).toBe(ATLAS_COLS)
    expect(atlas.tileDevicePx).toBe(T)
  })

  it('scales the surface with the tile size, so 16x16 is a grid and not a constant', () => {
    const rec = recorder()
    const atlas = buildAtlas(rec.create, 58)

    // M2's real tile at the M0 device: 29 CSS px at the DPR-2 cap.
    expect(atlas.widthPx).toBe(928)
    expect(atlas.heightPx).toBe(928)
    expect(rec.calls).toEqual([{ widthPx: 928, heightPx: 928 }])
  })

  it('takes exactly one 2D context, not one per mask', () => {
    const rec = recorder()
    buildAtlas(rec.create, T)
    expect(onlySurface(rec).contextRequests).toEqual(['2d'])
  })
})

describe('buildAtlas: the stroke state', () => {
  it('sets lineWidth, lineCap, lineJoin, strokeStyle and globalAlpha ONCE, before any drawing', () => {
    const { log } = buildAt(T)

    const sets = log.filter((c) => c.op === 'set')
    const firstDraw = log.findIndex((c) => c.op !== 'set')

    // Five assignments, and every one of them ahead of the first drawing
    // command: a builder that sets its state after stroking draws 256 tiles
    // with the default 1 px butt-capped hairline and the recording says so.
    // Once, not per tile — `save`/`restore` around each tile restores exactly
    // this state, so re-setting it 1,024 times would be 1,024 chances to
    // invalidate a real context's state cache at boot.
    expect(sets.length).toBe(5)
    expect(firstDraw).toBe(5)

    const byProp = new Map(sets.map((c) => [c.prop, c.value]))
    expect(byProp.get('lineWidth')).toBe(24) // 0.6 * 40
    expect(byProp.get('lineCap')).toBe('round')
    expect(byProp.get('strokeStyle')).toBe(PALETTE.road)

    // `globalAlpha` on a ROAD build is INERT in exactly the sense `lineJoin` is
    // — 1 is a fresh context's own default and every build gets a fresh surface
    // — so deleting the assignment on this path rasterises identical pixels and
    // only this assertion kills it. It is written unconditionally rather than
    // behind `if (variant === GHOST)` so that no build can inherit an alpha it
    // did not choose, and it is the same line the GHOST build uses, where the
    // value is 0.35 and very much not inert. Labelled, so a reader does not take
    // this line as coverage of something the road layer depends on.
    expect(byProp.get('globalAlpha')).toBe(1)

    // `lineJoin` is asserted, and it is INERT — review m1. Every spoke is its
    // own two-point subpath, and a two-point subpath has no join, so nothing
    // here rasterises one and the `'miter'` mutation is an equivalent mutant
    // that only this assignment assertion kills. Kept because spec §6 mandates
    // the setting and because the first multi-segment subpath drawn here would
    // otherwise inherit a miter silently. What rounds the visible junction is
    // each spoke's start CAP. Said out loud so this line is not read as
    // coverage of something the atlas depends on.
    expect(byProp.get('lineJoin')).toBe('round')
  })

  it('keeps the stroke width inside spec §6’s 55-65% band at both sizes', () => {
    for (const size of [T, 58]) {
      const { log } = buildAt(size)
      const width = log.find((c) => c.op === 'set' && c.prop === 'lineWidth')
      expect(width?.op).toBe('set')
      const value = width?.op === 'set' ? Number(width.value) : Number.NaN
      expect(value).toBeGreaterThanOrEqual(0.55 * size)
      expect(value).toBeLessThanOrEqual(0.65 * size)
    }
  })

  it('CHANGES the stroke width when the tile size changes', () => {
    // The bullet that exists because a fixed width passes a single-size test.
    const widthAt = (size: number): number => {
      const { log } = buildAt(size)
      const c = log.find((x) => x.op === 'set' && x.prop === 'lineWidth')
      return c?.op === 'set' ? Number(c.value) : Number.NaN
    }
    expect(widthAt(T)).toBe(24) // 0.6 * 40
    expect(widthAt(58)).toBe(34.8) // 0.6 * 58
    expect(widthAt(T)).not.toBe(widthAt(58))
    expect(ROAD_STROKE_FRACTION).toBe(0.6)
  })

  it('reports the same stroke width on the Atlas as it assigned to the context', () => {
    // Review I3: `strokeWidthPx` is public — Task 5 needs it to line anything
    // up with a road, and the clip arithmetic below is stated in terms of half
    // of it — and it was returned by the builder and asserted by nobody, so it
    // could have been any number at all.
    for (const [size, expected] of [
      [T, 24],
      [58, 34.8],
    ] as const) {
      const rec = recorder()
      const atlas = buildAtlas(rec.create, size)
      const assigned = onlySurface(rec).ctx.log.find((c) => c.op === 'set' && c.prop === 'lineWidth')
      expect(atlas.strokeWidthPx).toBe(expected)
      expect(assigned?.op === 'set' ? assigned.value : undefined).toBe(atlas.strokeWidthPx)
    }
  })

  it('strokes in the palette it is handed, not a hard-coded colour', () => {
    const custom: Palette = { ...PALETTE, road: '#ff00ff' }
    const { log } = buildAt(T, custom)
    const c = log.find((x) => x.op === 'set' && x.prop === 'strokeStyle')
    expect(c?.op === 'set' ? c.value : undefined).toBe('#ff00ff')
    expect(custom.road).not.toBe(PALETTE.road)
  })

  it('carries the palette it was BAKED with, so a stale atlas is detectable', () => {
    // Review I2. `drawFrame(ctx, frame, atlas, palette)` takes its own palette
    // and a blit cannot re-tint, so without this field the two can disagree
    // silently: the roads keep the colour they were rasterised with while
    // every other element changes. Identity, because `PALETTE` is frozen and
    // preallocated and a different object IS a different palette.
    const custom: Palette = { ...PALETTE, road: '#ff00ff' }
    const rec = recorder()
    expect(buildAtlas(rec.create, T, custom).palette).toBe(custom)

    const rec2 = recorder()
    expect(buildAtlas(rec2.create, T).palette).toBe(PALETTE)
    expect(custom).not.toBe(PALETTE)
  })
})

describe('the GHOST variant: thinner and fainter, as two independent properties', () => {
  /**
   * M1d Task 8, spec §5.11: a road whose refund is deferred *"renders as a
   * thinner, lower-opacity ghost"*. Two properties, and the tests below are
   * split so that **each has a detector the other does not**.
   *
   * That split is the whole point and it cost this project a finding once
   * already: a single assertion that "the ghost differs from the road" is one
   * detector standing in for two behaviours, and it reports the same green
   * whether the width mutation or the opacity mutation is the one that survived.
   * So: `lineWidth` is asserted in its own `it()`, `globalAlpha` in its own, and
   * the third `it()` asserts only what must NOT change — colour, cap and join —
   * which fires on neither of them.
   */

  it('strokes the ghost layer THINNER: lineWidth is GHOST_STROKE_FRACTION of the tile', () => {
    // Width only. This assertion is blind to `globalAlpha` by construction.
    for (const size of [T, 58]) {
      const road = setValue(buildAt(size).log, 'lineWidth')
      const ghost = setValue(buildGhostAt(size).log, 'lineWidth')
      expect(ghost).toBe(GHOST_STROKE_FRACTION * size)
      expect(road).toBe(ROAD_STROKE_FRACTION * size)
      // The RELATION, not just the literal: an art pass may retune both numbers
      // and must not be able to make a ghost as fat as a road.
      expect(Number(ghost)).toBeLessThan(Number(road))
    }
    // Both sizes, so a builder that ignores its tile argument for the ghost — a
    // fixed 12 px hairline, say — cannot pass on one of them.
    expect(GHOST_STROKE_FRACTION).toBeLessThan(ROAD_STROKE_FRACTION)
  })

  it('reports that thinner width on the Atlas as well as assigning it', () => {
    const rec = recorder()
    const ghost = buildAtlas(rec.create, T, PALETTE, AtlasVariant.GHOST)
    expect(ghost.strokeWidthPx).toBe(12) // 0.3 * 40
    expect(setValue(onlySurface(rec).ctx.log, 'lineWidth')).toBe(ghost.strokeWidthPx)
    // `strokeWidthPx` is what a caller lining anything up with a ghost reads,
    // and half of it is the cap reach the clip assertions below are stated in.
    const roadRec = recorder()
    expect(buildAtlas(roadRec.create, T).strokeWidthPx).toBe(24)
  })

  it('strokes the ghost layer FAINTER: globalAlpha is GHOST_STROKE_ALPHA', () => {
    // Opacity only. This assertion is blind to `lineWidth` by construction.
    const road = setValue(buildAt(T).log, 'globalAlpha')
    const ghost = setValue(buildGhostAt(T).log, 'globalAlpha')
    expect(ghost).toBe(GHOST_STROKE_ALPHA)
    expect(road).toBe(ROAD_STROKE_ALPHA)
    expect(Number(ghost)).toBeLessThan(Number(road))
    // An alpha of 0 is not "fainter", it is "absent", and it would render the
    // whole feature invisible while satisfying every `<` above.
    expect(Number(ghost)).toBeGreaterThan(0)
  })

  it('reports that alpha on the Atlas as well as assigning it', () => {
    const rec = recorder()
    const ghost = buildAtlas(rec.create, T, PALETTE, AtlasVariant.GHOST)
    expect(ghost.strokeAlpha).toBe(GHOST_STROKE_ALPHA)
    expect(setValue(onlySurface(rec).ctx.log, 'globalAlpha')).toBe(ghost.strokeAlpha)

    const roadRec = recorder()
    const road = buildAtlas(roadRec.create, T)
    expect(road.strokeAlpha).toBe(ROAD_STROKE_ALPHA)
    expect(road.strokeAlpha).toBeGreaterThan(ghost.strokeAlpha)
  })

  it('changes NOTHING else about the stroke state — same colour, same cap, same join', () => {
    // The independence claim, made positively. Opacity is `globalAlpha` and not
    // an `#rrggbbaa` colour precisely so that this holds: bake the fade into the
    // colour instead and "full opacity" and "the road colour" become one edit.
    // Fires on neither the width nor the alpha mutation, which is why it is here
    // rather than folded into either of them.
    const road = buildAt(T).log
    const ghost = buildGhostAt(T).log
    for (const prop of ['strokeStyle', 'lineCap', 'lineJoin']) {
      expect(setValue(ghost, prop), prop).toBe(setValue(road, prop))
    }
    expect(setValue(ghost, 'strokeStyle')).toBe(PALETTE.road)
    // ...and it changes exactly the two that it must, so "nothing else" is a
    // statement about a complete list rather than about three sampled entries.
    expect(ghost.filter((c) => c.op === 'set').length).toBe(5)
    expect(setValue(ghost, 'lineWidth')).not.toBe(setValue(road, 'lineWidth'))
    expect(setValue(ghost, 'globalAlpha')).not.toBe(setValue(road, 'globalAlpha'))
  })

  it('bakes the palette it is handed, so a ghost atlas goes stale exactly as a road one does', () => {
    const custom: Palette = { ...PALETTE, road: '#ff00ff' }
    const rec = recorder()
    const ghost = buildAtlas(rec.create, T, custom, AtlasVariant.GHOST)
    expect(ghost.palette).toBe(custom)
    expect(setValue(onlySurface(rec).ctx.log, 'strokeStyle')).toBe('#ff00ff')
    // The consequence `canvas.ts`'s `assertAtlases` exists for: the ghost layer
    // carries the SAME baked-palette hazard as the road layer, so a rebuild that
    // refreshes one and not the other draws a board in two themes.
    expect(custom).not.toBe(PALETTE)
  })

  it('carries its variant, so a swapped pair is detectable at all', () => {
    const rec = recorder()
    const rec2 = recorder()
    expect(buildAtlas(rec.create, T, PALETTE, AtlasVariant.GHOST).variant).toBe(AtlasVariant.GHOST)
    expect(buildAtlas(rec2.create, T).variant).toBe(AtlasVariant.ROAD)
    // Defaulted, so every M2-era caller keeps building the road layer.
    expect(AtlasVariant.ROAD).not.toBe(AtlasVariant.GHOST)
  })

  it('draws the SAME 256 tiles, spoke for spoke — only the stroke differs', () => {
    // "The ghost stroke is derived from the mask" at the atlas end: a ghost tile
    // is the same geometry as the road tile of the same mask, which is what
    // makes a ghosted DIAGONAL segment draw diagonally rather than as whatever a
    // single hand-written ghost sprite happened to be.
    const road = tiles(buildAt(T).log)
    const ghost = tiles(buildGhostAt(T).log)
    expect(ghost.length).toBe(ATLAS_MASK_COUNT)
    for (let mask = 0; mask < ATLAS_MASK_COUNT; mask++) {
      expect(ghost[mask]?.segments, `mask ${mask}`).toEqual(road[mask]?.segments)
      expect(ghost[mask]?.clip, `mask ${mask}`).toEqual(road[mask]?.clip)
    }
    // Non-vacuous, and specifically about the diagonals: mask 8 is SE alone, and
    // its one spoke runs to the tile CORNER. A permutation of the diagonal bits
    // or a ghost builder that only emitted orthogonals would move this literal.
    // Mask 8 is tile (8, 0): origin (320, 0), centre (340, 20), SE to the
    // bottom-right corner (360, 40).
    expect(segmentsFor(buildGhostAt(T).log, MASK_SE)).toEqual([
      { x1: 340, y1: 20, x2: 360, y2: 40 },
    ])
    expect(segmentsFor(buildGhostAt(T).log, MASK_NE)).toEqual([
      { x1: 100, y1: 20, x2: 120, y2: 0 },
    ])
  })

  it('keeps every ghost spoke inside its own tile rect, at the ghost’s own cap radius', () => {
    // The C1 clip argument, re-derived for the thinner stroke rather than
    // assumed from the road atlas. A ghost cap is a half-disc of radius
    // `0.15 * tile` = 6 px at T = 40, so it reaches LESS far — but "less far
    // than a road" is not "inside the tile", and without the clip a ghost still
    // contaminates its neighbour. Same lesson-not-carried-to-its-sibling shape
    // the catalogue names; checked rather than inherited.
    const ghostR = (GHOST_STROKE_FRACTION * T) / 2
    expect(ghostR).toBe(6)
    let checked = 0
    for (const [mask, tile] of tiles(buildGhostAt(T).log).entries()) {
      const clip = tile.clip
      expect(clip, `mask ${mask} was not clipped at all`).not.toBeNull()
      if (clip === null) continue
      for (const s of tile.segments) {
        const length = Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
        const px = s.x2 + ((s.x2 - s.x1) / length) * (ghostR / 2)
        const py = s.y2 + ((s.y2 - s.y1) / length) * (ghostR / 2)
        expect(inkedUnclipped(px, py, tile.segments, 2 * ghostR), `mask ${mask}`).toBe(true)
        expect(insideRect(clip, px, py), `mask ${mask} ghost spoke leaves its own rect`).toBe(false)
        checked++
      }
    }
    expect(checked).toBe(1024)
  })
})

describe('buildAtlases: the pair, built together so it cannot go half-stale', () => {
  it('returns a ROAD atlas and a GHOST atlas at one tile size and one palette', () => {
    const rec = recorder()
    const atlases = buildAtlases(rec.create, T)

    expect(atlases.road.variant).toBe(AtlasVariant.ROAD)
    expect(atlases.ghost.variant).toBe(AtlasVariant.GHOST)
    expect(atlases.road.tileDevicePx).toBe(T)
    expect(atlases.ghost.tileDevicePx).toBe(T)
    expect(atlases.road.palette).toBe(PALETTE)
    expect(atlases.ghost.palette).toBe(PALETTE)
    // TWO surfaces, in this order. One surface shared between them would mean
    // the second build stroked over the first and every road tile carried a
    // ghost on top of it.
    expect(rec.calls).toEqual([
      { widthPx: SURFACE, heightPx: SURFACE },
      { widthPx: SURFACE, heightPx: SURFACE },
    ])
    expect(atlases.road.surface).not.toBe(atlases.ghost.surface)
  })

  it('hands the SAME palette to both, so the pair can never be half-rethemed', () => {
    const custom: Palette = { ...PALETTE, road: '#ff00ff' }
    const rec = recorder()
    const atlases = buildAtlases(rec.create, 58, custom)
    expect(atlases.road.palette).toBe(custom)
    expect(atlases.ghost.palette).toBe(custom)
    expect(atlases.road.tileDevicePx).toBe(atlases.ghost.tileDevicePx)
    // And the two really are different surfaces with different stroke state, so
    // "same palette" is not passing because they are the same object.
    expect(atlases.road.strokeWidthPx).not.toBe(atlases.ghost.strokeWidthPx)
    expect(atlases.road.strokeAlpha).not.toBe(atlases.ghost.strokeAlpha)
  })
})

describe('the clip: a tile’s ink stays inside the rect Task 5 blits', () => {
  /**
   * Review finding C1, and the assertion whose absence let a broken atlas pass
   * 37 green tests.
   *
   * The grid has NO gutter and every spoke runs to the tile edge. A round cap
   * is a half-disc of radius `lineWidth / 2` = `0.3 * tileDevicePx` centred on
   * that endpoint, so without a clip `0.3 * tileDevicePx` of every spoke's ink
   * lands in the NEIGHBOUR's rect — which is precisely the rect `drawFrame`
   * blits. 248 of 256 tiles carried foreign ink, mean 14% of tile area, worst
   * 37%. A dead end blitted as a through-road and an elbow as a crossing.
   *
   * None of this needs a rasteriser: it is a distance comparison against
   * recorded endpoints and a recorded `lineWidth`.
   */

  it('issues save -> rect -> clip BEFORE any path command, and restores after the stroke', () => {
    const tile = tileFor(buildAt(T).log, MASK_N_E)
    // The exact op sequence of one tile, hand-written. `save` and `restore`
    // delimit the group and so are not in `ops`; that they are balanced is
    // asserted by `tiles()` itself, which fails on a nested or unmatched one.
    expect(tile.ops).toEqual([
      'beginPath',
      'rect',
      'clip',
      'beginPath',
      'moveTo',
      'lineTo',
      'moveTo',
      'lineTo',
      'stroke',
    ])
  })

  it('clips EVERY one of the 256 tiles, before every path command it issues', () => {
    for (const [mask, tile] of tiles(buildAt(T).log).entries()) {
      expect(tile.ops.slice(0, 3), `mask ${mask}`).toEqual(['beginPath', 'rect', 'clip'])
      expect(tile.ops.filter((o) => o === 'clip').length, `mask ${mask}`).toBe(1)
      expect(tile.ops.filter((o) => o === 'stroke').length, `mask ${mask}`).toBe(1)
      const firstMove = tile.ops.indexOf('moveTo')
      if (firstMove >= 0) expect(firstMove, `mask ${mask}`).toBeGreaterThan(tile.ops.indexOf('clip'))
    }
  })

  it('clips each mask to its OWN tile rect, hand-written', () => {
    const { log } = buildAt(T)
    expect(tileFor(log, 0).clip).toEqual({ x: 0, y: 0, w: 40, h: 40 })
    expect(tileFor(log, MASK_N).clip).toEqual({ x: 40, y: 0, w: 40, h: 40 })
    expect(tileFor(log, MASK_S).clip).toEqual({ x: 0, y: 40, w: 40, h: 40 })
    expect(tileFor(log, MASK_N_S).clip).toEqual({ x: 40, y: 40, w: 40, h: 40 })
    expect(tileFor(log, MASK_ORTHOGONALS).clip).toEqual({ x: 200, y: 200, w: 40, h: 40 })
    expect(tileFor(log, MASK_DIAGONALS).clip).toEqual({ x: 400, y: 400, w: 40, h: 40 })
    expect(tileFor(log, MASK_ALL).clip).toEqual({ x: 600, y: 600, w: 40, h: 40 })
  })

  it('gives the 256 clip rects the exact tiling of the surface: no gap, no overlap', () => {
    const all = tiles(buildAt(T).log)
    const origins = new Set<string>()
    let area = 0
    for (const [mask, tile] of all.entries()) {
      const clip = tile.clip
      expect(clip, `mask ${mask} was not clipped at all`).not.toBeNull()
      if (clip === null) continue
      expect([clip.w, clip.h], `mask ${mask}`).toEqual([T, T])
      expect(clip.x % T, `mask ${mask}`).toBe(0)
      expect(clip.y % T, `mask ${mask}`).toBe(0)
      expect(clip.x).toBeGreaterThanOrEqual(0)
      expect(clip.x + clip.w).toBeLessThanOrEqual(SURFACE)
      expect(clip.y).toBeGreaterThanOrEqual(0)
      expect(clip.y + clip.h).toBeLessThanOrEqual(SURFACE)
      origins.add(`${clip.x},${clip.y}`)
      area += clip.w * clip.h
    }
    expect(origins.size).toBe(ATLAS_MASK_COUNT) // no two tiles share a rect
    expect(area).toBe(SURFACE * SURFACE) // and together they cover the surface
  })

  it('proves the clip is LOAD-BEARING: without it mask 4’s cap lands inside mask 5’s rect', () => {
    // Mask 4 is E only: tile (4, 0), centre (180, 20), spoke to (200, 20) —
    // which is the shared edge with tile (5, 0), mask 5's rect.
    const { log } = buildAt(T)
    const four = tileFor(log, MASK_E)
    expect(four.segments).toEqual([{ x1: 180, y1: 20, x2: 200, y2: 20 }])

    // (205, 20) is 5 px past that endpoint: well inside a round cap of radius
    // 12, and 5 px inside mask 5's rect. Hand-written, both halves.
    expect(inkedUnclipped(205, 20, four.segments, 2 * R)).toBe(true)
    const fiveRect = tileFor(log, MASK_N_E).clip
    expect(fiveRect).toEqual({ x: 200, y: 0, w: 40, h: 40 })
    expect(fiveRect !== null && insideRect(fiveRect, 205, 20)).toBe(true)

    // And the clip is what stops it: the point is outside mask 4's own rect,
    // so the ink is never laid down. Those two facts together ARE C1.
    const fourRect = four.clip
    expect(fourRect).toEqual({ x: 160, y: 0, w: 40, h: 40 })
    expect(fourRect !== null && insideRect(fourRect, 205, 20)).toBe(false)
  })

  it('proves it for EVERY spoke of every mask, not just that one pair', () => {
    // For each spoke, walk half a cap-radius past its far endpoint: that point
    // is inked by an unclipped stroke (distance R/2 < R) and lies strictly
    // outside the tile's own rect. So every non-empty tile would contaminate a
    // neighbour, and the clip is what all 1,024 spokes rely on.
    const all = tiles(buildAt(T).log)
    let checked = 0
    for (const [mask, tile] of all.entries()) {
      const clip = tile.clip
      // An `expect`, not a `throw`: a bare Error in a mutation battery's
      // failure list reads exactly like a crash, which is the one thing a
      // mutation report must never be ambiguous about.
      expect(clip, `mask ${mask} was not clipped at all`).not.toBeNull()
      if (clip === null) continue
      for (const s of tile.segments) {
        const length = Math.hypot(s.x2 - s.x1, s.y2 - s.y1)
        const px = s.x2 + ((s.x2 - s.x1) / length) * (R / 2)
        const py = s.y2 + ((s.y2 - s.y1) / length) * (R / 2)
        expect(inkedUnclipped(px, py, tile.segments, 2 * R), `mask ${mask}`).toBe(true)
        expect(insideRect(clip, px, py), `mask ${mask} spoke leaves its own rect`).toBe(false)
        checked++
      }
    }
    // Non-vacuity: 8 * 2^7 = 1,024 spokes across the 256 masks, every one
    // checked. A `segments` array that silently emptied would pass the loop.
    expect(checked).toBe(1024)
  })

  it('keeps the centre blob inside the tile, which is why the cap stays ROUND', () => {
    // The start cap at the tile centre is a disc of radius 12 at (cx, cy), and
    // 12 < HALF = 20, so it never reaches the tile edge. That is the half of
    // the round cap the clip does NOT remove, and it is what rounds the
    // junction where an elbow's two spokes meet.
    expect(R).toBeLessThan(HALF)
    const clip = tileFor(buildAt(T).log, MASK_N_E).clip
    expect(clip).not.toBeNull()
    for (const [px, py] of [
      [220 - R, 20 - R],
      [220 + R, 20 + R],
    ] as const) {
      expect(clip !== null && insideRect(clip, px, py)).toBe(true)
    }
  })
})

describe('buildAtlas: the recorded segments, against hand-written literals', () => {
  // Every literal below is hand-computed at T = 40, HALF = 20, from
  // tile (mask % 16, floor(mask / 16)) and the direction table above.
  // Nothing here is derived from the builder's own expressions.

  it('records 256 tile groups, one per mask, each closed by a stroke', () => {
    const { log } = buildAt(T)
    expect(tiles(log).length).toBe(ATLAS_MASK_COUNT)

    // Without this, "forget to call stroke()" leaves every literal below
    // passing and the device draws a blank atlas — a recorder CAN see it.
    expect(log.filter((c) => c.op === 'save').length).toBe(ATLAS_MASK_COUNT)
    expect(log.filter((c) => c.op === 'restore').length).toBe(ATLAS_MASK_COUNT)
    expect(log.filter((c) => c.op === 'stroke').length).toBe(ATLAS_MASK_COUNT)
    // Two beginPaths per tile: one for the clip rect, one for the spokes.
    expect(log.filter((c) => c.op === 'beginPath').length).toBe(2 * ATLAS_MASK_COUNT)
  })

  it('mask 0 (no neighbours) draws nothing at all', () => {
    expect(segmentsFor(buildAt(T).log, 0)).toEqual([])
  })

  it('mask 1 (N) draws exactly one spoke, centre -> the top edge midpoint', () => {
    // tile (1, 0): x ∈ [40, 80), y ∈ [0, 40), centre (60, 20).
    expect(segmentsFor(buildAt(T).log, MASK_N)).toEqual([{ x1: 60, y1: 20, x2: 60, y2: 0 }])
  })

  it('mask 5 (N+E) draws exactly two spokes — an elbow, asymmetric under both axes', () => {
    // tile (5, 0): centre (220, 20).
    expect(segmentsFor(buildAt(T).log, MASK_N_E)).toEqual([
      { x1: 220, y1: 20, x2: 220, y2: 0 }, // N
      { x1: 220, y1: 20, x2: 240, y2: 20 }, // E
    ])
  })

  it('mask 16 (S) draws one spoke, in the tile BELOW mask 1’s', () => {
    // tile (0, 1): centre (20, 60). Paired with mask 1 above, this is what
    // separates (mask % 16, mask / 16) from its transpose.
    expect(segmentsFor(buildAt(T).log, MASK_S)).toEqual([{ x1: 20, y1: 60, x2: 20, y2: 80 }])
  })

  it('mask 17 (N+S) draws two opposed spokes in tile (1, 1)', () => {
    expect(segmentsFor(buildAt(T).log, MASK_N_S)).toEqual([
      { x1: 60, y1: 60, x2: 60, y2: 40 }, // N
      { x1: 60, y1: 60, x2: 60, y2: 80 }, // S
    ])
  })

  it('mask 85 (0b01010101) draws the four ORTHOGONALS', () => {
    // tile (5, 5): centre (220, 220).
    expect(segmentsFor(buildAt(T).log, MASK_ORTHOGONALS)).toEqual([
      { x1: 220, y1: 220, x2: 220, y2: 200 }, // N
      { x1: 220, y1: 220, x2: 240, y2: 220 }, // E
      { x1: 220, y1: 220, x2: 220, y2: 240 }, // S
      { x1: 220, y1: 220, x2: 200, y2: 220 }, // W
    ])
  })

  it('mask 170 (0b10101010) draws the four DIAGONALS, to the tile corners', () => {
    // tile (10, 10): centre (420, 420).
    expect(segmentsFor(buildAt(T).log, MASK_DIAGONALS)).toEqual([
      { x1: 420, y1: 420, x2: 440, y2: 400 }, // NE
      { x1: 420, y1: 420, x2: 440, y2: 440 }, // SE
      { x1: 420, y1: 420, x2: 400, y2: 440 }, // SW
      { x1: 420, y1: 420, x2: 400, y2: 400 }, // NW
    ])
  })

  it('mask 255 draws all eight spokes in the last tile', () => {
    // tile (15, 15): centre (620, 620).
    expect(segmentsFor(buildAt(T).log, MASK_ALL)).toEqual([
      { x1: 620, y1: 620, x2: 620, y2: 600 }, // N
      { x1: 620, y1: 620, x2: 640, y2: 600 }, // NE
      { x1: 620, y1: 620, x2: 640, y2: 620 }, // E
      { x1: 620, y1: 620, x2: 640, y2: 640 }, // SE
      { x1: 620, y1: 620, x2: 620, y2: 640 }, // S
      { x1: 620, y1: 620, x2: 600, y2: 640 }, // SW
      { x1: 620, y1: 620, x2: 600, y2: 620 }, // W
      { x1: 620, y1: 620, x2: 600, y2: 600 }, // NW
    ])
  })

  it('scales every coordinate with the tile size', () => {
    // The same elbow at M2's real 58 px tile: tile (5, 0), centre (319, 29).
    expect(segmentsFor(buildAt(58).log, MASK_N_E)).toEqual([
      { x1: 319, y1: 29, x2: 319, y2: 0 },
      { x1: 319, y1: 29, x2: 348, y2: 29 },
    ])
  })
})

describe('the four diagonals, each isolated in its own mask (review C2)', () => {
  // Mask 170 has all four diagonals at once and is therefore INVARIANT under
  // every permutation of them; 0, 1, 5, 85 and 255 pin no diagonal at all. Every
  // non-identity permutation of NE/SE/SW/NW survived the suite before these
  // cases existed, because a permutation also preserves popcount, tile-local
  // distinctness and the common centre. Every literal is hand-computed.

  it('mask 2 = NE alone, to the top-right corner of tile (2, 0)', () => {
    // centre (100, 20) -> corner (120, 0).
    expect(segmentsFor(buildAt(T).log, MASK_NE)).toEqual([{ x1: 100, y1: 20, x2: 120, y2: 0 }])
  })

  it('mask 8 = SE alone, to the bottom-right corner of tile (8, 0)', () => {
    // centre (340, 20) -> corner (360, 40).
    expect(segmentsFor(buildAt(T).log, MASK_SE)).toEqual([{ x1: 340, y1: 20, x2: 360, y2: 40 }])
  })

  it('mask 32 = SW alone, to the bottom-left corner of tile (0, 2)', () => {
    // centre (20, 100) -> corner (0, 120).
    expect(segmentsFor(buildAt(T).log, MASK_SW)).toEqual([{ x1: 20, y1: 100, x2: 0, y2: 120 }])
  })

  it('mask 128 = NW alone, to the top-left corner of tile (0, 8)', () => {
    // centre (20, 340) -> corner (0, 320).
    expect(segmentsFor(buildAt(T).log, MASK_NW)).toEqual([{ x1: 20, y1: 340, x2: 0, y2: 320 }])
  })

  it('mask 34 = NE+SW, a diagonal pair asymmetric under BOTH axes', () => {
    // tile (2, 2): centre (100, 100). {NE, SW} maps to {NW, SE} under a flip in
    // either axis, so unlike {NE, SE} or {NE, NW} this pair cannot be satisfied
    // by a mirrored table.
    expect(segmentsFor(buildAt(T).log, MASK_NE_SW)).toEqual([
      { x1: 100, y1: 100, x2: 120, y2: 80 }, // NE
      { x1: 100, y1: 100, x2: 80, y2: 120 }, // SW
    ])
  })

  it('is non-vacuous: the four masks above name four DISTINCT single diagonals', () => {
    // If two of these constants collided, a permutation could still hide.
    expect(new Set([MASK_NE, MASK_SE, MASK_SW, MASK_NW]).size).toBe(4)
    for (const mask of [MASK_NE, MASK_SE, MASK_SW, MASK_NW]) {
      expect(popcount(mask)).toBe(1)
      expect(mask & MASK_ORTHOGONALS).toBe(0) // no orthogonal bit in any of them
    }
    expect(MASK_NE | MASK_SE | MASK_SW | MASK_NW).toBe(MASK_DIAGONALS)
    expect(MASK_NE_SW).toBe(MASK_NE | MASK_SW)
  })
})

describe('buildAtlas: properties over all 256 masks', () => {
  it('draws one spoke per set bit, counted by an independent formula', () => {
    const all = tiles(buildAt(T).log)
    for (let mask = 0; mask < ATLAS_MASK_COUNT; mask++) {
      expect(all[mask]?.segments.length, `mask ${mask}`).toBe(popcount(mask))
    }
    // Non-vacuity: the counts are not all the same number.
    expect(new Set(all.map((t) => t.segments.length)).size).toBe(9) // 0..8 spokes
  })

  it('starts every spoke of a mask at one common point, that tile’s centre', () => {
    const all = tiles(buildAt(T).log)
    for (let mask = 0; mask < ATLAS_MASK_COUNT; mask++) {
      const group = all[mask]?.segments ?? []
      for (const segment of group) {
        expect(segment.x1, `mask ${mask}`).toBe(group[0]?.x1)
        expect(segment.y1, `mask ${mask}`).toBe(group[0]?.y1)
        // A centre, not an edge: exactly HALF into its own tile on both axes.
        expect(segment.x1 % T, `mask ${mask}`).toBe(HALF)
        expect(segment.y1 % T, `mask ${mask}`).toBe(HALF)
      }
    }
  })

  it('keeps every recorded coordinate inside the surface', () => {
    for (const tile of tiles(buildAt(T).log)) {
      for (const s of tile.segments) {
        for (const v of [s.x1, s.y1, s.x2, s.y2]) {
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(SURFACE)
        }
      }
    }
  })

  it('gives all 256 masks pairwise-distinct spoke sets, in TILE-LOCAL coordinates', () => {
    const all = tiles(buildAt(T).log)
    const keys = all.map((t) => key(localSegments(t.segments, T)))
    expect(keys.length).toBe(ATLAS_MASK_COUNT)
    expect(new Set(keys).size).toBe(ATLAS_MASK_COUNT)

    // Vacuity guard on the normalisation itself: if `localSegments` returned
    // absolute coordinates, distinctness would be a property of the 256 tile
    // offsets and not of the masks at all. Mask 1 and mask 16 draw in
    // different tiles and must normalise into the SAME frame.
    expect(localSegments(all[MASK_N]?.segments ?? [], T)).toEqual([
      { x1: HALF, y1: HALF, x2: HALF, y2: 0 },
    ])
    expect(localSegments(all[MASK_S]?.segments ?? [], T)).toEqual([
      { x1: HALF, y1: HALF, x2: HALF, y2: T },
    ])
  })
})

describe('buildAtlas: determinism', () => {
  it('records an identical command sequence for two builds at the same size', () => {
    expect(buildAt(T).log).toEqual(buildAt(T).log)
  })

  it('records a DIFFERENT sequence at a different size, so the above is not vacuous', () => {
    expect(buildAt(T).log).not.toEqual(buildAt(58).log)
  })
})

describe('the atlas lookup Task 5 blits from', () => {
  it('maps mask m to tile (m % 16, floor(m / 16)) in device px', () => {
    const rec = recorder()
    const atlas = buildAtlas(rec.create, T)
    // Hand-written, at T = 40.
    expect([atlasSourceX(atlas, 0), atlasSourceY(atlas, 0)]).toEqual([0, 0])
    expect([atlasSourceX(atlas, MASK_N), atlasSourceY(atlas, MASK_N)]).toEqual([40, 0])
    expect([atlasSourceX(atlas, MASK_S), atlasSourceY(atlas, MASK_S)]).toEqual([0, 40])
    expect([atlasSourceX(atlas, MASK_N_S), atlasSourceY(atlas, MASK_N_S)]).toEqual([40, 40])
    expect([atlasSourceX(atlas, MASK_ORTHOGONALS), atlasSourceY(atlas, MASK_ORTHOGONALS)]).toEqual([
      200, 200,
    ])
    expect([atlasSourceX(atlas, MASK_ALL), atlasSourceY(atlas, MASK_ALL)]).toEqual([600, 600])
  })

  it('agrees with the rect each tile was actually CLIPPED to, for all 256', () => {
    // The lookup is what `drawImage` reads; the clip is what bounded the ink.
    // If those two disagree, a blit reads a rect the builder confined nothing
    // to — so this compares them across the whole atlas, not for a sample.
    const rec = recorder()
    const atlas = buildAtlas(rec.create, T)
    const all = tiles(onlySurface(rec).ctx.log)
    for (const [mask, tile] of all.entries()) {
      expect(tile.clip, `mask ${mask}`).toEqual({
        x: atlasSourceX(atlas, mask),
        y: atlasSourceY(atlas, mask),
        w: atlas.tileDevicePx,
        h: atlas.tileDevicePx,
      })
    }
  })
})

describe('buildAtlas: the dimension guard', () => {
  // 4096 / 16 = 256 device px per tile is the largest tile that fits. The
  // guard converts a silent, device-only, deploy-time failure into a loud one.

  it('throws at 4096/16 + 1 px per tile, naming BOTH dimensions in the message', () => {
    const rec = recorder()
    let thrown: unknown
    try {
      buildAtlas(rec.create, 257)
    } catch (error) {
      thrown = error
    }

    // "What else could prevent the throw": nothing else in the builder can fail
    // at this size, but the message is asserted anyway so a different throw —
    // an out-of-memory from a real surface, a null context — cannot be mistaken
    // for this one.
    expect(thrown).toBeInstanceOf(Error)
    const message = thrown instanceof Error ? thrown.message : ''
    expect(message).toContain('4112') // 16 * 257, the dimension asked for
    expect(message).toContain(String(MAX_ATLAS_DIMENSION_PX)) // the limit
    expect(message).toContain('257') // the tile size that produced it

    // And it throws BEFORE asking for a surface, so a platform that would have
    // clamped is never given the chance.
    expect(rec.calls).toEqual([])
  })

  it('does NOT throw at exactly 4096/16 px per tile', () => {
    const rec = recorder()
    const atlas = buildAtlas(rec.create, MAX_ATLAS_DIMENSION_PX / ATLAS_COLS)
    expect(atlas.widthPx).toBe(MAX_ATLAS_DIMENSION_PX)
    expect(atlas.heightPx).toBe(MAX_ATLAS_DIMENSION_PX)
    expect(tiles(onlySurface(rec).ctx.log).length).toBe(ATLAS_MASK_COUNT)
  })
})

describe('buildAtlas: the tile-size guard', () => {
  // game builds at floor(tileSize * dpr) precisely because the LOW-class cap of
  // 1.5 makes 29 * 1.5 = 43.5. A caller that forgets the floor, or measures a
  // transiently zero-height viewport, must not get a silently useless atlas.
  it.each([0, -1, 43.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws on tileDevicePx = %s, naming the value',
    (bad) => {
      const rec = recorder()
      expect(() => buildAtlas(rec.create, bad)).toThrow(/tileDevicePx must be a whole number/)
      expect(() => buildAtlas(rec.create, bad)).toThrow(new RegExp(String(bad).replace('+', '')))
      expect(rec.calls).toEqual([])
    },
  )

  it('accepts the smallest legal tile, so the guard is a floor and not a wall', () => {
    const rec = recorder()
    expect(buildAtlas(rec.create, 1).widthPx).toBe(16)
  })
})

describe('buildAtlas: the surface the factory actually returned', () => {
  // Review I1: a single 300x150 fixture fails BOTH halves of the width/height
  // comparison at once, so neither half had a detector of its own — deleting
  // either one left the suite green. One fixture per axis fixes that, and it is
  // the catalogue's "when a mutation touches two symmetric code paths, mutate
  // them separately" applied to the fixture instead of to the mutation.

  it('throws when the factory gets the WIDTH wrong and the height right', () => {
    const wrongWidth: AtlasSurfaceFactory = (_widthPx, heightPx) =>
      new RecordingSurface(300, heightPx)
    expect(() => buildAtlas(wrongWidth, T)).toThrow(/surface factory returned 300 x 640/)
    expect(() => buildAtlas(wrongWidth, T)).toThrow(/request of 640 x 640/)
  })

  it('throws when the factory gets the HEIGHT wrong and the width right', () => {
    const wrongHeight: AtlasSurfaceFactory = (widthPx) => new RecordingSurface(widthPx, 150)
    expect(() => buildAtlas(wrongHeight, T)).toThrow(/surface factory returned 640 x 150/)
    expect(() => buildAtlas(wrongHeight, T)).toThrow(/request of 640 x 640/)
  })

  it('throws when the factory ignores the size entirely', () => {
    // The shape of a platform that clamps: you ask for 640 and get 300x150.
    const lying: AtlasSurfaceFactory = () => new RecordingSurface(300, 150)
    expect(() => buildAtlas(lying, T)).toThrow(/surface factory returned 300 x 150/)
  })

  it('throws if the surface has no 2D context', () => {
    const noContext: AtlasSurfaceFactory = (widthPx, heightPx) => ({
      width: widthPx,
      height: heightPx,
      getContext: (): AtlasContext | null => null,
    })
    expect(() => buildAtlas(noContext, T)).toThrow(/no 2D context/)
  })

  it('is not vacuous: the honest factory of every other test throws nothing', () => {
    const rec = recorder()
    expect(() => buildAtlas(rec.create, T)).not.toThrow()
  })
})

describe('the direction table render keeps its own copy of', () => {
  it('is roads.ts:92-95 verbatim: bit i is direction i, N=0, clockwise', () => {
    expect(ROAD_DIR_COUNT).toBe(8)
    expect([...ROAD_DIR_DX]).toEqual([0, 1, 1, 1, 0, -1, -1, -1])
    expect([...ROAD_DIR_DY]).toEqual([-1, -1, 0, 1, 1, 1, 0, -1])
    // `packages/game/test/renderDirections.test.ts` pins this copy against
    // `sim`'s own DX/DY — `render` may not import `sim`, and `game` imports
    // both, so that is where the two can be compared. It guards the TABLE; the
    // single-diagonal literals above guard the bit INDEXING, which is a
    // different thing and was the hole review C2 found.
  })
})
