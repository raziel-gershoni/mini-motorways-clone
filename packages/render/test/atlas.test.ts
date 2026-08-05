import { describe, it, expect } from 'vitest'
import {
  ATLAS_COLS,
  ATLAS_MASK_COUNT,
  MAX_ATLAS_DIMENSION_PX,
  ROAD_DIR_COUNT,
  ROAD_DIR_DX,
  ROAD_DIR_DY,
  ROAD_STROKE_FRACTION,
  atlasSourceX,
  atlasSourceY,
  buildAtlas,
  type AtlasContext,
  type AtlasSurface,
  type AtlasSurfaceFactory,
} from '../src/atlas'
import { PALETTE } from '../src/palette'
import type { Palette } from '../src/types'

/**
 * Task 4's whole test strategy in one sentence: **the atlas is exercised
 * through an injected surface factory, and every assertion below is over
 * recorded drawing state — never over ink.**
 *
 * This workspace has no jsdom, no `canvas` module and no vitest DOM config;
 * `node -e "typeof OffscreenCanvas"` prints `undefined`. Plan Decision 8 is
 * therefore not a convenience, it is the only way this file runs at all. What a
 * recorder observes is exactly the atlas's decision content: which segments it
 * strokes for each mask, and with what stroke state — `moveTo`/`lineTo`
 * coordinates, `lineWidth`, `lineCap`, `lineJoin`, `strokeStyle`, and the
 * surface's width and height.
 *
 * **What it cannot observe, stated so nobody records it as covered:** whether a
 * browser rasterises those segments the way we expect. That is a browser
 * property, not ours, and Task 9's deploy is its only check.
 *
 * The plan's first draft asked for symmetry assertions and its own vacuity
 * check forbade the masks it named (N+S = 17 and E+W = 68 are both symmetric
 * under BOTH axes, so a blank tile would have passed). Symmetry was a proxy for
 * "the right spokes are drawn"; every geometric assertion here is instead a
 * **hand-written literal endpoint list**, which says it directly and has no
 * vacuity condition to get wrong.
 */

// ---------------------------------------------------------------------------
// The recording surface
// ---------------------------------------------------------------------------

/**
 * One recorded mutation of the drawing surface. This union IS the vocabulary of
 * plan Decision 8 — path commands and state assignments, in issue order.
 *
 * State assignments are recorded through real accessors rather than sampled at
 * the end, which is what makes "`lineCap` is `'round'`" an assertion about an
 * assignment the builder made rather than about a field's final value. A
 * builder that never touches `lineCap` would leave a plausible default sitting
 * there and pass a final-value check.
 */
type Command =
  | { readonly op: 'beginPath' }
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

  beginPath(): void {
    this.log.push({ op: 'beginPath' })
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

/**
 * The recorded log split into one group per `beginPath`, in issue order.
 *
 * **This is deliberately not "group by which tile the coordinates fall in".**
 * Grouping by position would use the mask -> tile mapping that is itself under
 * test; grouping by `beginPath` uses only the structure of the recording, so
 * the coordinates in group *m* remain free to be wrong and the hand-written
 * literals below are what pin them. A builder that drew the masks in a
 * different order, or into the wrong tiles, produces literal mismatches here
 * rather than a silently re-labelled group.
 */
function groups(log: readonly Command[]): Segment[][] {
  const out: Segment[][] = []
  let current: Segment[] | null = null
  let pendingX = Number.NaN
  let pendingY = Number.NaN

  for (const command of log) {
    if (command.op === 'beginPath') {
      current = []
      out.push(current)
      continue
    }
    if (command.op === 'moveTo') {
      expect(current, 'a moveTo was issued before any beginPath').not.toBeNull()
      pendingX = command.x
      pendingY = command.y
      continue
    }
    if (command.op === 'lineTo') {
      expect(current, 'a lineTo was issued before any beginPath').not.toBeNull()
      expect(Number.isNaN(pendingX), 'a lineTo with no preceding moveTo').toBe(false)
      current?.push({ x1: pendingX, y1: pendingY, x2: command.x, y2: command.y })
      pendingX = Number.NaN
      pendingY = Number.NaN
    }
  }
  return out
}

/** Group `mask`, with a hard failure rather than `undefined` if it is missing. */
function segmentsFor(log: readonly Command[], mask: number): Segment[] {
  const all = groups(log)
  expect(all.length).toBe(ATLAS_MASK_COUNT)
  const group = all[mask]
  if (group === undefined) throw new Error(`test: no recorded group for mask ${mask}`)
  return group
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
  const col = Math.floor(first.x1 / tileDevicePx)
  const row = Math.floor(first.y1 / tileDevicePx)
  const ox = col * tileDevicePx
  const oy = row * tileDevicePx
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

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/**
 * 40 device px per tile — chosen so every hand-written literal below is an
 * integer (`half` = 20) and so the two tile sizes in this file are visibly
 * different. **Not** M2's real 58 px tile, which is used by the second size in
 * the `lineWidth`-varies case; a single-size file cannot see a builder that
 * ignores its argument.
 *
 * At T = 40 the surface is 16 * 40 = 640 px on each axis and tile (c, r) spans
 * `x ∈ [40c, 40c + 40)`, `y ∈ [40r, 40r + 40)` with its centre at
 * `(40c + 20, 40r + 20)`.
 */
const T = 40
const SURFACE = 640
const HALF = 20

/**
 * The bit order, verified against `packages/sim/src/roads.ts:92-95` — bit *i* is
 * direction *i*, N=0 NE=1 E=2 SE=3 S=4 SW=5 W=6 NW=7, so:
 *
 *   85  = 0b0101_0101 = the four orthogonals
 *   170 = 0b1010_1010 = the four diagonals
 *   5   = 0b0000_0101 = N + E, an elbow — asymmetric under both axes
 *
 * The last one matters: the plan's deleted symmetry bullet named 17 (N+S) and
 * 68 (E+W), both of which are symmetric under both axes, which is exactly how a
 * blank tile passes a symmetry test.
 */
const MASK_N = 1
const MASK_N_E = 5
const MASK_S = 16
const MASK_N_S = 17
const MASK_ORTHOGONALS = 85
const MASK_DIAGONALS = 170
const MASK_ALL = 255

function buildAt(tileDevicePx: number, palette?: Palette): { rec: Recorder; log: Command[] } {
  const rec = recorder()
  if (palette === undefined) buildAtlas(rec.create, tileDevicePx)
  else buildAtlas(rec.create, tileDevicePx, palette)
  return { rec, log: onlySurface(rec).ctx.log }
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
  it('sets lineWidth, lineCap, lineJoin and strokeStyle ONCE, before any drawing', () => {
    const { log } = buildAt(T)

    const sets = log.filter((c) => c.op === 'set')
    const firstDraw = log.findIndex((c) => c.op !== 'set')

    // Four assignments, and every one of them ahead of the first path command:
    // a builder that sets its state after stroking draws 256 tiles with the
    // default 1 px butt-capped hairline and the recording says so.
    expect(sets.length).toBe(4)
    expect(firstDraw).toBe(4)

    const byProp = new Map(sets.map((c) => [c.prop, c.value]))
    expect(byProp.get('lineWidth')).toBe(24) // 0.6 * 40
    expect(byProp.get('lineCap')).toBe('round')
    expect(byProp.get('lineJoin')).toBe('round')
    expect(byProp.get('strokeStyle')).toBe(PALETTE.road)
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

  it('strokes in the palette it is handed, not a hard-coded colour', () => {
    // The atlas bakes its colour at build time — `drawFrame(ctx, frame, atlas,
    // palette)` cannot re-tint a blit — so the colour must come from the
    // palette, and a palette change means a rebuild. Stated in atlas.ts.
    const custom: Palette = { ...PALETTE, road: '#ff00ff' }
    const { log } = buildAt(T, custom)
    const c = log.find((x) => x.op === 'set' && x.prop === 'strokeStyle')
    expect(c?.op === 'set' ? c.value : undefined).toBe('#ff00ff')
    expect(custom.road).not.toBe(PALETTE.road)
  })
})

describe('buildAtlas: the recorded segments, against hand-written literals', () => {
  // Every literal below is hand-computed at T = 40, HALF = 20, from
  // tile (mask % 16, floor(mask / 16)) and the direction table above.
  // Nothing here is derived from the builder's own expressions.

  it('records 256 groups, one per mask, each closed by a stroke', () => {
    const { log } = buildAt(T)
    expect(groups(log).length).toBe(ATLAS_MASK_COUNT)

    // Without this, "forget to call stroke()" leaves every literal below
    // passing and the device draws a blank atlas — a recorder CAN see it.
    expect(log.filter((c) => c.op === 'beginPath').length).toBe(ATLAS_MASK_COUNT)
    expect(log.filter((c) => c.op === 'stroke').length).toBe(ATLAS_MASK_COUNT)
    let open = 0
    for (const c of log) {
      if (c.op === 'beginPath') {
        expect(open, 'a beginPath with the previous path unstroked').toBe(0)
        open = 1
      } else if (c.op === 'stroke') {
        expect(open, 'a stroke with no open path').toBe(1)
        open = 0
      }
    }
    expect(open).toBe(0)
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

describe('buildAtlas: properties over all 256 masks', () => {
  it('draws one spoke per set bit, counted by an independent formula', () => {
    const all = groups(buildAt(T).log)
    for (let mask = 0; mask < ATLAS_MASK_COUNT; mask++) {
      expect(all[mask]?.length, `mask ${mask}`).toBe(popcount(mask))
    }
    // Non-vacuity: the counts are not all the same number.
    expect(new Set(all.map((g) => g.length)).size).toBe(9) // 0..8 spokes
  })

  it('starts every spoke of a mask at one common point, that tile’s centre', () => {
    const all = groups(buildAt(T).log)
    for (let mask = 0; mask < ATLAS_MASK_COUNT; mask++) {
      const group = all[mask] ?? []
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
    const all = groups(buildAt(T).log)
    for (const group of all) {
      for (const s of group) {
        for (const v of [s.x1, s.y1, s.x2, s.y2]) {
          expect(v).toBeGreaterThanOrEqual(0)
          expect(v).toBeLessThanOrEqual(SURFACE)
        }
      }
    }
  })

  it('gives all 256 masks pairwise-distinct spoke sets, in TILE-LOCAL coordinates', () => {
    const all = groups(buildAt(T).log)
    const keys = all.map((g) => key(localSegments(g, T)))
    expect(keys.length).toBe(ATLAS_MASK_COUNT)
    expect(new Set(keys).size).toBe(ATLAS_MASK_COUNT)

    // Vacuity guard on the normalisation itself: if `localSegments` returned
    // absolute coordinates, distinctness would be a property of the 256 tile
    // offsets and not of the masks at all. Mask 1 and mask 16 draw in
    // different tiles and must normalise into the SAME frame.
    const local1 = localSegments(all[MASK_N] ?? [], T)
    const local16 = localSegments(all[MASK_S] ?? [], T)
    expect(local1).toEqual([{ x1: HALF, y1: HALF, x2: HALF, y2: 0 }])
    expect(local16).toEqual([{ x1: HALF, y1: HALF, x2: HALF, y2: T }])
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

  it('agrees with where the segments were actually recorded', () => {
    // The lookup and the builder are two expressions of the same mapping in the
    // same file; this is what stops one being changed without the other. It is
    // NOT the primary check — the hand-written literals above are.
    const rec = recorder()
    const atlas = buildAtlas(rec.create, T)
    const all = groups(onlySurface(rec).ctx.log)
    for (const mask of [MASK_N, MASK_N_E, MASK_S, MASK_N_S, MASK_ORTHOGONALS, MASK_ALL]) {
      const first = (all[mask] ?? [])[0]
      expect(first, `mask ${mask}`).toBeDefined()
      expect(Math.floor((first?.x1 ?? -1) / T) * T).toBe(atlasSourceX(atlas, mask))
      expect(Math.floor((first?.y1 ?? -1) / T) * T).toBe(atlasSourceY(atlas, mask))
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
    expect(groups(onlySurface(rec).ctx.log).length).toBe(ATLAS_MASK_COUNT)
  })
})

describe('buildAtlas: the tile-size guard', () => {
  // game builds at floor(tileSize * dpr) precisely because the LOW-class cap of
  // 1.5 makes 29 * 1.5 = 43.5. A caller that forgets the floor, or measures a
  // transiently zero-height viewport, must not get a silently useless atlas.
  it.each([0, -1, 43.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws on tileDevicePx = %p, naming the value',
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
  it('throws if the factory ignores the size it was asked for', () => {
    // The shape of a platform that clamps: you ask for 928 and get 300x150.
    // Without this the atlas builds happily and every blit reads the wrong
    // tile — a scrambled board with no error anywhere.
    const lying: AtlasSurfaceFactory = () => new RecordingSurface(300, 150)
    expect(() => buildAtlas(lying, T)).toThrow(/surface factory returned 300 x 150/)
    expect(() => buildAtlas(lying, T)).toThrow(/640 x 640/)
  })

  it('throws if the surface has no 2D context', () => {
    const noContext: AtlasSurfaceFactory = (w, h) => ({
      width: w,
      height: h,
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
    // both, so that is where the two can be compared.
  })
})
