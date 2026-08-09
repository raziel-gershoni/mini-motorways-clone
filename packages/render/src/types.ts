/**
 * `render`'s own interface types — spec §4: "`render` depends on nothing but
 * its own interface types". **This file has no imports at all, by design**, and
 * `test/boundary.test.ts` enforces that for the whole package.
 *
 * The load-bearing consequence, and the reason this file is written before
 * anything draws (plan Decision 3): `RenderFrame` carries **preallocated typed
 * arrays and scalars, never a `GameState`**. Everything that needs a *function*
 * from `sim` — `routeStep`, `edgeCost`, `OPPOSITE`, `destMetaColour`,
 * `carparkCell`, `weekOfTick` — is called in `game`, which writes the results
 * in here. That is what makes `render` testable with hand-built arrays and no
 * simulation at all, and what makes "swapping in Pixi is a one-file change"
 * true rather than aspirational.
 */

/**
 * Telegram-Android's injected device class, read from the **User-Agent, not a
 * JS API** (`game/deviceInfo.ts`, lifted from the M0 spike). `null` on iOS and
 * on desktop, where no equivalent exists.
 *
 * A deliberate second copy of the union `game` declares, for the same reason
 * `TerrainClass` below is a second copy of `shared`'s `TERRAIN`: `render`
 * imports from neither package. The two meet in `game`, where a mismatch is a
 * compile error rather than a silent divergence.
 */
export type PerformanceClass = 'LOW' | 'AVERAGE' | 'HIGH'

/**
 * The per-cell terrain byte `game` writes into `RenderFrame.terrainClass`, and
 * the only terrain vocabulary `render` has.
 *
 * **It is `game`'s fold of `world.terrain` AND `state.cleared`, not a copy of
 * either** (plan Decision 3). `world.terrain` is never mutated; a tree
 * destroyed by a road sets `state.cleared[cell] = 1` (`sim/roads.ts`). A
 * renderer reading `world.terrain` alone would draw a tree under every road the
 * player lays through a forest, permanently.
 *
 * The numbering matches `shared`'s `TERRAIN` (LAND 0, WATER 1, MOUNTAIN 2,
 * TREE 3) and is a **deliberate second copy** — the alternative is `render`
 * importing `shared`, which spec §4 forbids. The fold is a `game`-side function
 * with its own test, so the copy has one place to drift and one test watching
 * it.
 *
 * Worth knowing, so it does not read as coverage: on `firstCity` the revealed
 * rect excludes the mountain cluster entirely (rows 5-7, columns 3-4), so
 * `MOUNTAIN` is never exercised by a real M2 frame and is covered only by
 * hand-built ones.
 */
export const TerrainClass = Object.freeze({
  LAND: 0,
  WATER: 1,
  MOUNTAIN: 2,
  TREE: 3,
} as const)

/**
 * The four values `TerrainClass` can take, as a type — **derived from the const,
 * not hand-written as `0 | 1 | 2 | 3`.** A hand-written union is a second copy
 * of a numbering that already exists as a second copy of `shared`'s `TERRAIN`
 * (see above), and the two would drift silently: renumbering `WATER` in the
 * const would leave the union describing the old set with nothing to notice.
 */
export type TerrainClassCode = (typeof TerrainClass)[keyof typeof TerrainClass]

/**
 * What `screenToGrid` found under a CSS point. Every code is **non-zero**: a
 * `GRID` code of 0 would make `if (hit.region)` reject the one case the caller
 * wants.
 *
 * `ABOVE`, `BELOW`, `HUD`, `LEFT` and `RIGHT` all mean "not a grid cell" and
 * are kept apart because the callers need different things from them —
 * `pointer.ts` must route a `HUD` tap to the HUD hit-test and drop an `ABOVE`
 * one (spec §8.3 forbids any interactive element in the top band).
 *
 * `BELOW` covers everything under the grid rect that is not the HUD band: the
 * vertical letterbox between the two, and the bottom safe-area inset under the
 * band. Neither is interactive, and a tap in the home-indicator inset must not
 * toggle pause.
 */
export const HitRegion = Object.freeze({
  GRID: 1,
  ABOVE: 2,
  BELOW: 3,
  HUD: 4,
  LEFT: 5,
  RIGHT: 6,
} as const)

/** A `HitRegion` value, derived from the const for the same reason as above. */
export type HitRegionCode = (typeof HitRegion)[keyof typeof HitRegion]

/**
 * The viewport as measured, before any capping or fitting. Everything here is
 * CSS pixels except `rawDpr`.
 *
 * `topInset` is `max(contentSafeAreaInset.top, safeAreaInset.top)` and
 * `bottomInset` is `safeAreaInset.bottom` — spec §8.3 requires **both** inset
 * systems, and the lifted spike helper exposes only `contentSafeAreaInset.top`,
 * so the lift (Task 8) gains a `safeAreaInset` reader.
 *
 * `rawDpr` is the uncapped `devicePixelRatio`; `fitCamera` applies plan
 * Decision 6's cap itself, so no caller can forget to.
 */
export interface ViewportMetrics {
  readonly cssW: number
  readonly cssH: number
  readonly topInset: number
  readonly bottomInset: number
  readonly rawDpr: number
  readonly performanceClass: PerformanceClass | null
}

/**
 * The rectangle of the board that is drawn, in board cell coordinates.
 *
 * M2 fits **the revealed rect, not the full grid** (plan Decision 5). Fitting
 * the full 24x40 grid gives `floor(min(406/24, 870/40)) = 16` CSS px against
 * spec §5.1's hard floor of 28, and 40 rows at 28 px needs 1,120 CSS px of
 * height that no phone has.
 *
 * "Revealed grid" has no representation in any code — `MapData` has `w`/`h`
 * only — so Task 3 freezes it as four integer constants in `shared`
 * (`REVEALED_X0` = 5, `REVEALED_Y0` = 9, `REVEALED_W` = 14, `REVEALED_H` = 22),
 * which `game` reads and passes in here. **M1d owns making it dynamic**; when
 * it does, `game` reads state instead of the constants and nothing in `render`
 * moves.
 */
export interface RevealedRect {
  readonly x0: number
  readonly y0: number
  readonly cols: number
  readonly rows: number
}

/**
 * The fixed camera, in CSS pixels. Produced by `fitCamera` at boot and on a
 * stable viewport change — never per frame (spec §8.3: `getBoundingClientRect`
 * allocates a `DOMRect` per call, and re-measuring per frame is both a spec
 * violation and an atlas rebuild storm).
 *
 * `cssW`, `cssH`, `hudTop` and `hudHeight` are **not** in the plan's field
 * list, and they are here because two things the same task requires cannot be
 * computed without them: `hudRects` needs the canvas width to lay the band out,
 * and Task 5's "the three opaque fills tile the full backing store with no gap
 * and no overlap, asserted arithmetically against the camera" cannot be
 * asserted against a camera that does not know how big the canvas is.
 */
export interface Camera {
  /** Integer CSS px. Never below 1 — see `fitCamera`. */
  readonly tileSize: number
  /** CSS px from the canvas's left edge to the grid rect's left edge. */
  readonly originX: number
  /** CSS px from the canvas's top edge to the grid rect's top edge. */
  readonly originY: number
  /** Board column of the revealed rect's first cell. */
  readonly x0: number
  /** Board row of the revealed rect's first cell. */
  readonly y0: number
  readonly cols: number
  readonly rows: number
  /** The **effective** (capped) device pixel ratio — plan Decision 6. */
  readonly dpr: number
  /** Canvas width in CSS px, as measured. */
  readonly cssW: number
  /** Canvas height in CSS px, as measured. */
  readonly cssH: number
  /** CSS px from the canvas's top edge to the HUD band's top edge. */
  readonly hudTop: number
  /** The HUD band's height in CSS px. */
  readonly hudHeight: number
}

/** A CSS-pixel rectangle. Mutable, because these are reused across frames. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A CSS-pixel point. Mutable, because these are reused across frames. */
export interface Point {
  x: number
  y: number
}

/**
 * Spec §7.2's three persistent HUD elements, all in the **bottom** band.
 *
 * §7.2 puts the clock at the top and §8.3 forbids any interactive element in
 * the top band; M2 resolves that toward §8.3, because it is a platform fact and
 * §7.2 is a preference. The clock is still always-expanded and still doubles as
 * pause.
 *
 * `tiles` is the tiles-left readout standing in for §7.2's inventory chip row —
 * a substitution, not §7.2 compliance. There is nothing to spend until M1e.
 */
export interface HudRects {
  /** Week/day clock, which doubles as the pause control. */
  readonly clock: Rect
  /** Completed-trip count. */
  readonly score: Rect
  /** Road tiles remaining. */
  readonly tiles: Rect
}

/**
 * `screenToGrid`'s result. `gx`/`gy` are -1 unless `region` is `HitRegion.GRID`.
 *
 * `region` is narrowed to `HitRegionCode` rather than left as `number`, so a
 * caller that compares against a constant from the wrong enum — `TerrainClass`
 * has values 0-3, which overlap `HitRegion`'s 1-6 — is a compile error, and so
 * `pointer.ts` (Task 7) gets a real exhaustiveness check on its `switch`.
 */
export interface GridHit {
  region: HitRegionCode
  gx: number
  gy: number
}

/**
 * Spec §7.1's theme object, with `tree` **added** (§7.1's list omits it while
 * §5.1 makes tree one of the four terrains) and `shadow` **removed** (plan
 * Decision 7: M2 draws no shadows of any kind, and a palette entry for one
 * invites a full-canvas layer that costs twice what the road bake M0 deleted
 * did).
 *
 * Every colour is a **preallocated string**, because `ctx.fillStyle = '#' +
 * something` allocates a string inside the frame loop.
 */
export interface Palette {
  /** The letterbox, outside the grid rect. */
  readonly background: string
  readonly land: string
  readonly water: string
  readonly mountain: string
  readonly tree: string
  readonly road: string
  readonly roadEdge: string
  readonly uiText: string
  /** Per colour group. Length 6 — spec §4.2 allows 5 or 6 per map. */
  readonly groups: readonly string[]
}

/**
 * Everything one frame draws, and nothing else. Built by `game/frame.ts` (Task
 * 6) into **preallocated arrays that are rewritten in place**, never
 * reallocated.
 *
 * **The liveness prefixes are part of the interface, and they are not
 * decoration.** No region behind this interface carries a `-1` sentinel
 * (`sim/state.ts`; narrowed at M1d Task 2, whose `occupancy` region is the sim's
 * first `-1` fill and is deliberately not part of `RenderFrame`):
 * unused house and destination slots are simply those at index >=
 * `H_HOUSE_COUNT` / `H_DEST_COUNT`, and an unused car is `PHASE_NONE = 0` with
 * `carCell = 0`. So **every unused cell reads 0 — a real, in-bounds cell**, not
 * a sentinel a renderer could filter on. `render` reads `[0, count)` and
 * nothing beyond it, which makes a phantom *unrepresentable* rather than merely
 * undrawn.
 *
 * Cars get the strongest form of it: they have no index-based count in the sim
 * at all, so `game` **densifies** them — `carXY` holds 2 floats per LIVE car,
 * in grid-cell units, with `carCount` live cars packed at the front.
 */
export interface RenderFrame {
  readonly camera: Camera
  /** Board width, for `index = y * gridW + x` into the board-indexed arrays. */
  readonly gridW: number
  /** Board-indexed 8-bit neighbour masks; the raw `state.roads` view. */
  readonly roads: Uint8Array
  /** Board-indexed `TerrainClass`; `game`'s fold of `world.terrain` and `state.cleared`. */
  readonly terrainClass: Uint8Array
  readonly houseCount: number
  /** Raw view; only `[0, houseCount)` is read. */
  readonly houseCell: Int32Array
  /** Raw view; only `[0, houseCount)` is read. */
  readonly houseColour: Uint8Array
  readonly destCount: number
  /** Raw view; only `[0, destCount)` is read. */
  readonly destCell: Int32Array
  /** `game`-unpacked from `destMeta`, dense. */
  readonly destColour: Uint8Array
  /** `game`-unpacked from `destMeta`, dense. */
  readonly destKind: Uint8Array
  /** `game`-unpacked from `destMeta`, dense. */
  readonly destOrientation: Uint8Array
  /** Waiting-customer count per destination, dense. */
  readonly destPins: Uint8Array
  /** `game`-computed via `carparkCell`, dense. */
  readonly destCarpark: Int32Array
  /** Live cars only. */
  readonly carCount: number
  /**
   * DENSE: 2 floats per live car, in grid-cell units. Length may exceed
   * `carCount * 2`.
   *
   * **The units are cell CENTRES, and this is the one convention mismatch in the
   * milestone worth stating at the field.** `gridToScreen` maps a cell to its
   * top-LEFT corner, while plan Decision 2's resolver maps a parked car to
   * `(cx, cy)` of its cell and a car half way along an eastward edge to
   * `(cx + 0.5, cy)`. So an integer coordinate here names a cell's centre, and
   * `canvas.ts` draws a car centred at `gridToScreen(gx, gy) + tileSize / 2`.
   * `game`'s resolver (Task 6) must produce that same convention: emitting
   * corner units instead shifts every car half a cell up and left, which reads
   * as an art offset rather than as a coordinate bug.
   */
  readonly carXY: Float32Array
  /** Dense, one per live car. */
  readonly carColour: Uint8Array
  readonly week: number
  readonly day: number
  readonly score: number
  readonly tilesLeft: number
  readonly paused: boolean
}

/**
 * M11: makes `packages/render/tsconfig.json`'s `"lib": ["ES2022", "DOM",
 * "DOM.Iterable"]` override load-bearing from Task 1 onward, rather than
 * trusting Task 5 (the first task that actually uses `CanvasRenderingContext2D`)
 * to rediscover a dropped override. `CanvasRenderingContext2D` is a DOM-only
 * global type; a global-scope type reference needs no import. Dropping the
 * `lib` override fails `tsc --noEmit` here with "Cannot find name
 * 'CanvasRenderingContext2D'", rather than silently passing until then.
 */
export type _RequiresDomLib = CanvasRenderingContext2D
