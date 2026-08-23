import {
  atlasSourceX,
  atlasSourceY,
  AtlasVariant,
  type Atlas,
  type Atlases,
  type AtlasSurface,
} from './atlas'
import {
  OFFER_GAP_CSS,
  OFFER_TITLE_H_CSS,
  createHudRects,
  createOfferRects,
  gridToScreenX,
  gridToScreenY,
  hudRects,
  offerRects,
} from './camera'
import { TerrainClass } from './types'
import type { Camera, HudRects, OfferRects, Palette, Rect, RenderFrame } from './types'

/**
 * `drawFrame` — the whole per-frame draw path, and the only function in this
 * package that runs 60 or 120 times a second.
 *
 * **It reads `frame` and nothing else.** No globals, no `sim`, no `shared`, no
 * clock, no `devicePixelRatio`. Every function that lives in `sim` —
 * `routeStep`, `carparkCell`, `weekOfTick`, the terrain fold — was called in
 * `game` before the frame was handed over (plan Decision 3), which is what makes
 * this file testable with hand-built arrays and no simulation at all.
 *
 * **There is no notion of interpolation alpha anywhere in `render`.** A car's
 * position arrives as two floats in grid-cell units, already resolved and
 * already lerped; drawing it is one multiply.
 *
 * ## Three rules this file exists to keep
 *
 * **1. No `clearRect`, ever** (plan Decision 4). **Five** opaque fills cover the
 * canvas exactly once — the top band, the two letterbox columns, the playfield,
 * and the bottom band — and everything else draws on top. A `clearRect` plus a
 * land fill covers it twice; at M2's regime on the M0 device that is a wasted
 * full-canvas pass of **1,412,880 device px, ~0.141 ms — more than the entire
 * road layer costs**. The rule this creates is unforgiving: *every* pixel of the
 * canvas must be covered by one of those five fills each frame, or the previous
 * frame ghosts. `DrawContext` below deliberately does not declare `clearRect`,
 * so reaching for it is a type error as well as a test failure.
 *
 * **Five, not three — Task 9, and the pixel budget was RECOMPUTED rather than
 * assumed.** The three-band form painted the letterbox in the **land** colour,
 * so land ran to the screen edge and nothing on screen distinguished a tap on
 * the rect's first column from a tap in the letterbox, which does nothing. On a
 * phone that reads as an unresponsive game — an input-affordance defect, not a
 * styling one. The playfield is now exactly the grid rect and everything outside
 * it is `palette.background`, which is what that palette entry has always
 * claimed to be (`palette.ts`: *"The letterbox outside the grid rect, and the top
 * band"*). **A partition of the same canvas into more rectangles paints the same
 * pixels**: the M0 device is still 812 x 1740 = 1,412,880 device px covered
 * exactly once, and the whole cost of the change is **two extra `fillRect`
 * calls** — 5 x 0.16 us + 1,412,880 / 10 Gpx/s = 0.1421 ms against 0.1418 ms, a
 * 0.23% increase on a pass the plan already charges at 0.141 ms. Both figures are
 * recomputed from the recording in `test/canvas.test.ts` rather than carried over.
 *
 * On the M0 device `originX` is 0 (406 = 14 x 29 exactly), so the two letterbox
 * columns are zero-width there and the change is visible only at the grid rect's
 * **bottom** edge — 40 CSS px on the M0 device, 49 on a 390 x 844 one, which is
 * the strip a finger can actually land in. The zero-area fills are still issued,
 * so the fill count does not vary with the viewport and the tiling assertion
 * stays uniform; a `fillRect` of zero width paints nothing on a real context.
 *
 * **2. Nothing allocates here.** No array literal, no object literal, no closure,
 * no string concatenation. The two places that would have — `hudRects`'s output
 * and the HUD's four formatted numbers — are a module-level scratch object and a
 * value-keyed text cache respectively. There IS an allocation profiler —
 * `packages/game/test/allocation.test.ts`, built in Task 6 and pointed at the
 * input path in Task 7 — and this file's draw path runs under it whenever
 * `game` supplies the context; what it cannot see is a `render`-only call with
 * no `game` caller.
 *
 * **This paragraph used to end "Review is the only check", four lines below the
 * sentence saying a profiler exists.** That is the fourth copy of the same
 * refuted claim found on this milestone, in three rounds of fixing it, and two
 * of them were in this one doc comment. What is true is narrower and is now
 * stated as such: a Task 3 reviewer reinstated an allocation here and watched
 * all 82 tests pass, which was a fact about the coverage of the day rather than
 * about the toolchain. Today the harness reaches this file through a `game`-side
 * caller; Task 9's integration is what supplies one, and until then review is
 * the only check **of this file specifically** — not of the rule.
 *
 * **3. The draw order is load-bearing, not cosmetic.** Buildings draw above
 * roads because a road is legal on a house cell and on a carpark cell and would
 * otherwise cover them; cars draw above buildings because a car drives *onto*
 * the carpark. The order is asserted in `test/canvas.test.ts` as a chain of
 * strict inequalities over the recorded log, which is the only form that
 * survives an art change.
 *
 * ## The inherited hazard, stated at the signature
 *
 * `drawFrame(ctx, frame, atlases, palette)` reads as though `palette` governed
 * every colour on screen. It does not govern the roads: **the atlas bakes its
 * stroke colour in at build time and a blit cannot re-tint its source**, so a
 * palette change without an atlas rebuild leaves every road in the previous
 * theme while everything else follows — a failure that reads as a rendering bug
 * rather than a caching one. Task 4 put the baked palette on `Atlas` so the
 * mismatch is *detectable*; `assertAtlases` below is what makes it *loud*.
 *
 * **M1d Task 8 doubled that hazard rather than adding a different one.** The
 * ghost layer is a second baked surface with the same property — it strokes
 * `palette.road` too, faded by a bake-time `globalAlpha` — so a rebuild that
 * refreshes one surface and not the other ships a board whose ghosts are in last
 * week's theme. `Atlases` keeps the pair together, `buildAtlases` is the
 * constructor that cannot mismatch them, and `assertAtlases` checks BOTH
 * palettes: a guard on half the hazard is the failure mode this whole paragraph
 * exists to record.
 */

/**
 * What `drawImage` accepts. The union is not decoration: a real
 * `CanvasRenderingContext2D.drawImage` takes `CanvasImageSource`, and
 * `AtlasSurface` is not assignable to that type in either direction, so a
 * parameter typed as `AtlasSurface` alone makes `CanvasRenderingContext2D`
 * fail to satisfy `DrawContext` even with method syntax. Verified by running
 * `tsc` on both forms — see `_RealContextIsADrawContext` at the bottom of this
 * file, and the report's §9 note that Task 4's guidance here was wrong.
 */
export type DrawImageSource = AtlasSurface | CanvasImageSource

/**
 * The slice of `CanvasRenderingContext2D` the draw path uses, and nothing more.
 * A real 2D context satisfies it structurally, which is what lets tests pass a
 * recorder and production pass a canvas with no branch between them (plan
 * Decision 8).
 *
 * **`clearRect` is deliberately absent** — see rule 1 above. The test recorder
 * implements it anyway, so the mutation that calls it still executes and dies on
 * an assertion rather than on a missing method, which a mutation battery must
 * never confuse.
 *
 * `drawImage` is declared with **method syntax**, not as a property holding an
 * arrow type: TypeScript method parameters are bivariant and property ones are
 * contravariant under `strictFunctionTypes`, and only the bivariant form lets a
 * real context satisfy this interface.
 */
export interface DrawContext {
  fillStyle: string | CanvasGradient | CanvasPattern
  /**
   * **M1e Task 9: the overcrowd ring.** The union rather than `string`, for
   * exactly the reason `fillStyle` above carries it — a real
   * `CanvasRenderingContext2D.strokeStyle` is
   * `string | CanvasGradient | CanvasPattern`, and a mutable property is checked
   * by assignability of its type, so narrowing it here makes
   * `_RealContextIsADrawContext` at the bottom of this file fail with
   * `TS2344: Type 'false' does not satisfy the constraint 'true'`. Measured,
   * not assumed: the narrow form was written first and `tsc --noEmit` refused
   * it.
   */
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  font: string
  textAlign: CanvasTextAlign
  textBaseline: CanvasTextBaseline
  fillRect(x: number, y: number, w: number, h: number): void
  /**
   * The other half of the ring. **`arc` alone paints nothing** — it appends to
   * the current path — so the pair `beginPath`/`arc`/`stroke` arrives together
   * or not at all. `clearRect` stays out; see rule 1 above, and note that
   * nothing here ever clears.
   */
  beginPath(): void
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void
  stroke(): void
  /**
   * `maxWidth` is **required here though the DOM makes it optional**, so that a
   * caller cannot draw an unconstrained label by omission. See `fillCentred`:
   * it is what turns "the text fits its HUD rect" from a device-dependent risk
   * into a construction guarantee. A real `CanvasRenderingContext2D` satisfies
   * both forms — pinned below.
   */
  fillText(text: string, x: number, y: number, maxWidth: number): void
  drawImage(
    image: DrawImageSource,
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ): void
}

// --- the art constants, all fractions of the tile ---------------------------
//
// Fractions rather than pixels, because the tile is 27, 29 or 30 CSS px
// depending on the viewport (Task 3) and every sprite has to follow it. The art
// pass owns the numbers; it does not own the rule that they are relative.

/** A tree is drawn INSET, so the land band shows around it — it is not a terrain tile. */
export const TREE_INSET_FRACTION = 0.25
export const TREE_SIZE_FRACTION = 0.5
export const HOUSE_INSET_FRACTION = 1 / 6
export const HOUSE_SIZE_FRACTION = 2 / 3
export const CARPARK_INSET_FRACTION = 0.25
export const CARPARK_SIZE_FRACTION = 0.5
/** A car is half a tile, centred on its resolved position. */
export const CAR_SIZE_FRACTION = 0.5
export const PIN_SIZE_FRACTION = 1 / 6
export const PIN_STRIDE_FRACTION = 1 / 3

/**
 * The most waiting customers a destination draws pins for.
 *
 * Six pins at a `1/3`-tile stride starting `1/6` of a tile in ends exactly two
 * tiles along, which is the narrow footprint's full width. The sim's pin count
 * has no upper bound, so without the cap a busy destination draws a row of pins
 * across the whole board.
 */
export const MAX_DRAWN_PINS = 6

/**
 * The overcrowd ring's radius, as a fraction of the destination footprint's
 * LONGER side in tiles.
 *
 * `0.62 * 3` = 1.86 tiles against a footprint half-diagonal of
 * `hypot(1, 1.5)` = 1.803, so the ring encircles the building with a little air
 * rather than cutting through its corners.
 *
 * **The radius is the same for both orientations, and that is geometry rather
 * than an accident.** Every footprint is a 2x3 or a 3x2 box, so `max(w, h)` is
 * 3 either way and the two boxes share a diagonal. The `max` is written out
 * anyway so the derivation survives a footprint change; no test can separate it
 * from the constant 3 today, and `canvas.test.ts` says so rather than pretending
 * otherwise.
 */
export const RING_RADIUS_FRACTION = 0.62

/**
 * The ring's stroke width, as a fraction of the tile, **rounded to a whole CSS
 * pixel and floored at 1**. A fixed pixel width does not follow the three tile
 * sizes `fitCamera` produces (27, 29, 30 CSS px); at 0.16 the ring is 4 or 5 CSS
 * px — visible on a phone, and thin enough that a nearly-closed ring still reads
 * as a ring rather than as a disc.
 *
 * **The floor at 1 is a correctness fix and the ROUND is not — this paragraph
 * said otherwise and was wrong, so read the whole of it before citing it.**
 *
 * The floor: `fitCamera` clamps the tile at 1 for a degenerate viewport, where
 * `round(1 * 0.16)` is 0 — and a `lineWidth` of 0 paints *nothing* on a real
 * canvas, which is a ring that silently disappears rather than one that is thin.
 * That is real and it has a detector.
 *
 * The round: `ctx.lineWidth` is a native accessor on a real
 * `CanvasRenderingContext2D` but a JS property initialised to the Smi `0` on
 * every test double in this repo, so a fractional store transitions that
 * field's representation to Double. The first draft of this comment called that
 * a `HeapNumber` **per store** and cited *"17.34 / 18.90 / 20.46 / 25.66 / 37.27
 * B/frame on five consecutive runs"*. **Both halves are wrong.** V8 mutates a
 * Double field in place after the transition, so it is ONE allocation plus the
 * deopt of every function holding the old map — and re-measured on the current
 * rig, which writes a ring meter before every frame so the transition happens
 * during WARMUP, the fractional form is **clean 5 of 5** and so is the rounded
 * one. The original figures were real, but they measured a one-off landing
 * inside a profiled window on a rig where the first ring did not appear until
 * ~tick 2,500; they are a property of that rig, not of this expression.
 *
 * So the round stays on its own merits — a whole-CSS-pixel stroke is a crisper
 * one at the DPR-2 cap, and avoiding a needless representation transition costs
 * nothing — and **not** because a harness is watching it. See
 * `drawAllocation.test.ts`'s `countingContext`, which says the same thing from
 * the instrument's side.
 */
export const RING_WIDTH_FRACTION = 0.16

/** The thinnest ring that is still a ring. See `RING_WIDTH_FRACTION`. */
export const RING_MIN_WIDTH_CSS = 1

/** The ring's stroke width in whole CSS px on a given tile. See `RING_WIDTH_FRACTION`. */
export function ringWidth(tile: number): number {
  const rounded = Math.round(tile * RING_WIDTH_FRACTION)
  return rounded > RING_MIN_WIDTH_CSS ? rounded : RING_MIN_WIDTH_CSS
}

/**
 * Twelve o'clock. A gauge that starts anywhere else is readable only by someone
 * who already knows where it starts.
 */
export const RING_START_ANGLE = -Math.PI / 2

/** The frame's meter is a byte; this is the value a closed ring would need. */
export const RING_FULL = 255

/**
 * The smallest sweep the ring is DRAWN at, in meter units of 255. The gate on
 * `meter !== 0` is untouched: an empty board still draws no rings at all, and
 * this floor only applies once a meter has left zero.
 *
 * **Why a floor at all.** A meter of 1 sweeps `1/255 * TAU` = 0.0246 rad. On the
 * three tile sizes `fitCamera` produces the ring radius is `3 * tile * 0.62`, so
 * the painted arc is:
 *
 * ```
 * tile 27  r = 50.22  arc = 1.24 CSS px   stroke 4
 * tile 29  r = 53.94  arc = 1.33 CSS px   stroke 5
 * tile 30  r = 55.80  arc = 1.37 CSS px   stroke 5
 * ```
 *
 * An arc a THIRD of its own stroke width is a round cap and nothing else — an
 * anti-aliased dot on a 5 px pen, which is indistinguishable from a rendering
 * speck. At 8 the same three tiles give 9.90 / 10.63 / 11.00 CSS px, roughly
 * 2-2.75x the stroke, which reads as a tick mark on a dial.
 *
 * **What it costs.** The ring stops being a faithful readout of the meter over
 * `[1, 8]` — 8 values of 255, 3.1 % of the range. It is bought back in the only
 * currency that matters here: measured on the board a plain load opens, the
 * first *visible* moment of every destination's ring arrives **327 ticks
 * (10.9 s) earlier**, because 8/255 of the meter is 327 ticks of climbing at
 * this board's rate. The ring's job is "act now", not "read off a number".
 */
export const RING_MIN_SWEEP = 8

/** One turn. Named so the ring's sweep is not `Math.PI * 2` written twice. */
const TAU = Math.PI * 2

/** A pause bar's width, as a fraction of the clock rect's height. */
export const PAUSE_BAR_FRACTION = 1 / 8

/**
 * How many bar-widths of the clock rect the pause indicator reserves before the
 * clock text starts. Four is the bars themselves (`[1·barW, 4·barW]`); the fifth
 * is the gap between the indicator and the text.
 */
export const PAUSE_GUTTER_BARS = 5

/**
 * A preallocated font string. Fixed at 20 CSS px rather than derived from the
 * tile size, because a computed font string (`\`${size}px …\``) is an allocation
 * in the frame loop and the HUD band is a fixed 72 CSS px on every viewport M2
 * targets.
 */
export const HUD_FONT = '600 20px system-ui, -apple-system, sans-serif'

/**
 * The shutdown screen's font, preallocated for the same reason `HUD_FONT` is.
 *
 * Larger than the HUD's 20 px because this is the only text in the game that
 * has to be read rather than glanced at, and one size for all three lines
 * because a second `ctx.font` assignment per frame buys a typographic hierarchy
 * the three lines do not need — they are already ordered by what they answer.
 */
export const SHUTDOWN_FONT = '700 24px system-ui, -apple-system, sans-serif'

/** Baseline-to-baseline spacing of the three shutdown lines, in CSS px. */
export const SHUTDOWN_LINE_STRIDE_CSS = 34

/**
 * The margin the shutdown text keeps from each canvas edge, in CSS px. It is
 * what `maxWidth` is derived from, so it is also the guarantee that
 * "DESTINATION 12 OVERCROWDED" cannot leave the screen at the 320 CSS px
 * viewport `fitCamera` accepts — the run condenses instead.
 */
export const SHUTDOWN_TEXT_INSET_CSS = 16

/** The two shutdown lines that carry no number, so they are preallocated whole. */
export const RESTART_TEXT = 'TAP TO PLAY AGAIN'

/**
 * The verb of the game, said out loud on the one screen where the player has
 * been proved not to know it.
 *
 * Before this line the failure state contained none of the words "road",
 * "connect" or "draw" — it named a building and a number and left the remedy to
 * be inferred. `startingCity.ts` measures what inference produces: the road a
 * player is most drawn to on the shipped city buys **zero ticks**.
 */
export const ADVICE_TEXT = 'CONNECT EVERY DESTINATION WITH A ROAD'

/**
 * §5.10's offer modal — the strings, the fonts and the one label table, all
 * preallocated at module scope for the reason `HUD_FONT` is (M1f Task 8).
 *
 * ---------------------------------------------------------------------------
 * NAMES ONLY — NO NUMBERS. THIS IS REVIEW FINDING I6 AND IT HAS TEETH
 * ---------------------------------------------------------------------------
 *
 * Every QUANTITY the modal shows — the tile grant, the item count — arrives on
 * `RenderFrame` as a number (`offerGrantA`, `offerItemsA`, ...) and is formatted
 * below by a memoised number->string cache. **A literal `'30 TILES'` in this
 * file is a UI that keeps telling the player 30 after `CARD_GRANT_ROAD_TILES`
 * becomes 40, with a green suite in both packages and no observer anywhere.**
 * `canvas.test.ts` › *"follows the frame when the grants change"* is what makes
 * that a caught mutation rather than an intention.
 *
 * ---------------------------------------------------------------------------
 * THE ARRAY IS ID-INDEXED, AND ITS AGREEMENT WITH `sim` IS PINNED IN `game`
 * ---------------------------------------------------------------------------
 *
 * `render` declares no dependencies at all (spec §4, `test/boundary.test.ts`),
 * so this file cannot import `CARD_ROAD_TILES` or `CARD_COUNT` and cannot assert
 * its own agreement with them. The watcher lives in
 * **`packages/game/test/frame.test.ts`** — the only package that can see both
 * copies — in the idiom `TerrainClass` already established there:
 * `CARD_LABEL_COUNT === CARD_COUNT`, and each offerable id's label by name.
 * A copied constant needs a watcher, and this is where this one's lives.
 */
export const CARD_LABELS: readonly string[] = Object.freeze([
  '', //                0 CARD_NONE — never drawn; present so the array is id-indexed
  'ROAD TILES', //      1
  'BRIDGE', //          2
  'TUNNEL', //          3
  'ROUNDABOUT', //      4
  'TRAFFIC LIGHTS', //  5 — declared, not offerable; deferred to M1g with its measurement
  'MOTORWAY', //        6
  'JUNCTION UPGRADE', //7 — M1f's own item, and the only offerable one besides road tiles
])

/** One past the highest card id this file can name. Pinned against `CARD_COUNT` in `game`. */
export const CARD_LABEL_COUNT = CARD_LABELS.length

/**
 * The modal's one instruction, and the reason it is here rather than left to
 * the two cards to imply.
 *
 * The board has just stopped for the first time in the run, with no explanation
 * anywhere else on screen. Two card faces say what is on offer; they do not say
 * that the game is waiting, that the choice is compulsory, or that the board
 * comes back afterwards. This project has already shipped one screen that named
 * a state and left the verb to be inferred (`ADVICE_TEXT` above is the repair),
 * and `startingCity.ts` measures what inference produces.
 */
export const OFFER_TITLE_TEXT = 'CHOOSE A CARD'

/** The peek control's label while the modal is up. Says what a press DOES. */
export const PEEK_TEXT = 'SEE THE BOARD'

/**
 * The peek control's label while peeking, and **the one thing on screen that is
 * still the modal**. Peek hides the chrome and keeps the loop paused (plan
 * Decision 16), so without this the player is looking at a frozen board with no
 * visible reason and no visible way forward — the exact state M1f Task 7 shipped
 * on purpose and interlocked against. Any tap returns; this says so.
 */
export const PEEK_RETURN_TEXT = 'TAP TO RETURN'

/** The modal's heading font — the title and the two card names. */
export const OFFER_TITLE_FONT = '700 22px system-ui, -apple-system, sans-serif'

/** The modal's smaller font — the grant lines, the item badge, the peek label. */
export const OFFER_GRANT_FONT = '600 18px system-ui, -apple-system, sans-serif'

/** The inset every modal run keeps from its own rect's edges, CSS px — this is what `maxWidth` is derived from. */
export const OFFER_TEXT_INSET_CSS = 16

/**
 * Where the three lines sit inside a card, as fractions of the card's height.
 *
 * Fractions rather than CSS px because the card's height is a function of the
 * viewport (`offerRects`), so a fixed stride would bunch the lines at the top of
 * a tall card and overflow a short one. The item badge is last and lowest
 * because it is the only line that is sometimes absent.
 */
export const OFFER_NAME_Y_FRACTION = 0.36
export const OFFER_GRANT_Y_FRACTION = 0.62
export const OFFER_ITEMS_Y_FRACTION = 0.82

/**
 * How much thicker the killer's ring is drawn over the scrim than under it.
 *
 * Two, because the ring is competing with a 24 px bold line for attention and
 * because the scrim is between the player and the board but not between them
 * and this — anything less reads as the same ring rather than as the answer to
 * the sentence above it.
 */
export const SHUTDOWN_RING_WIDTH_SCALE = 2

/**
 * `sim/buildings.ts`'s orientation numbering, N and S only — the two values that
 * select the 2x3 footprint box rather than the 3x2 one.
 *
 * **A deliberate second copy**, for the same reason `ROAD_DIR_DX` is one: spec
 * §4 forbids `render` importing `sim`, and `test/boundary.test.ts` enforces it.
 * Unlike a copied constant with no reader, this one has a watcher in the one
 * package allowed to see both sides: **`packages/game/test/renderFootprint.test.ts`**
 * compares `destFootprintW`/`destFootprintH` against `sim`'s own exported
 * `isFootprintCell`, cell by cell, for all four orientations.
 * (`renderDirections.test.ts` is the *direction table*'s watcher and says
 * nothing about footprints — a reader sent there concludes this copy is
 * unwatched.)
 */
export const DEST_ORIENTATION_N = 0
export const DEST_ORIENTATION_S = 2

/** Footprint width in cells: 2 for N/S, 3 for E/W. See `DEST_ORIENTATION_N`. */
export function destFootprintW(orientation: number): number {
  return orientation === DEST_ORIENTATION_N || orientation === DEST_ORIENTATION_S ? 2 : 3
}

/** Footprint height in cells: 3 for N/S, 2 for E/W. See `DEST_ORIENTATION_N`. */
export function destFootprintH(orientation: number): number {
  return orientation === DEST_ORIENTATION_N || orientation === DEST_ORIENTATION_S ? 3 : 2
}

// --- module-level scratch, allocated once at load ---------------------------

/**
 * `hudRects` writes into a caller-owned object and returns it, precisely so the
 * frame loop does not allocate one per frame (Task 3). This is that object.
 *
 * Module-level mutable state is legal in `render` and `game` by design — the
 * `determinism/no-module-mutable-state` rule applies to `sim` and `shared` only
 * (plan Task 1), because both the atlas cache Decision 4 requires and the action
 * pool Decision 9 requires are module-level state.
 */
const HUD_SCRATCH: HudRects = createHudRects()

/**
 * `offerRects`'s output object, allocated once at load for the same reason
 * `HUD_SCRATCH` is. The modal is laid out on every frame it is up, and
 * `game/pointer.ts` holds its own separate scratch for the hit test — two
 * callers, two objects, one function, so the faces and the targets cannot drift.
 */
const OFFER_SCRATCH: OfferRects = createOfferRects()

/**
 * The HUD's formatted numbers, memoised on the values that produced them.
 *
 * `'W' + week` allocates a string, and the HUD formats four numbers per frame —
 * 240 allocations a second at 60 Hz, in the one loop the zero-allocation rule
 * exists for. Memoising makes that "on change" instead: the score moves a few
 * times a minute, the day every 643 ticks, the tile count only when the player
 * draws.
 *
 * **What is and is not testable about this, said plainly — and this paragraph
 * used to end "this toolchain has no allocation profiler", which is false and
 * contradicted the top of this very file.** There is one:
 * `packages/game/test/allocation.test.ts`, built in Task 6 and pointed at the
 * input path in Task 7. What is genuinely unobservable is narrower and it is a
 * property of *strings*, not of the toolchain: two equal strings are
 * indistinguishable no matter how many were allocated, so no assertion on the
 * recorded text can tell a memoised cache from a re-formatted one. The profiler
 * WOULD see it — as bytes charged to this file — but only through a `game`-side
 * caller that actually calls `drawFrame`, which the harness's no-op `draw` is
 * not. Task 9's integration is where that closes.
 *
 * The *staleness* is observable here and now, and it is the failure mode that
 * matters: a cache that never invalidates draws last week's score forever.
 * `test/canvas.test.ts` changes every value between two frames and asserts the
 * text follows, then changes them back.
 */
let cachedWeek = -1
let cachedDay = -1
let cachedClockText = ''
let cachedScore = -1
let cachedScoreText = ''
let cachedTiles = -1
let cachedTilesText = ''

function clockText(week: number, day: number): string {
  if (week !== cachedWeek || day !== cachedDay) {
    cachedWeek = week
    cachedDay = day
    cachedClockText = `W${week} D${day}`
  }
  return cachedClockText
}

function scoreText(score: number): string {
  if (score !== cachedScore) {
    cachedScore = score
    cachedScoreText = `${score} TRIPS`
  }
  return cachedScoreText
}

function tilesText(tilesLeft: number): string {
  if (tilesLeft !== cachedTiles) {
    cachedTiles = tilesLeft
    cachedTilesText = `${tilesLeft} TILES`
  }
  return cachedTilesText
}

/**
 * The modal's two formatted numbers, memoised on the values that produced them —
 * the fifth and sixth instances of this file's single-slot cache, in
 * `scoreText`'s idiom and for its reason (M1f Task 8).
 *
 * **Two SEPARATE slots for A and B, and that is a correctness requirement here
 * rather than a size choice.** The modal draws two grants in the same frame with
 * different values (30 and 20 on the shipped pair), so one shared slot would
 * miss on every single call and re-format both strings on every frame — the
 * cache would be strictly worse than no cache, while reading as one. Two slots
 * make both calls hits from the second frame of the modal onward, and the modal
 * is up for as long as a person takes to read it.
 *
 * `tilesText` is deliberately not reused even though it formats the same
 * `${n} TILES` shape: it is keyed on `frame.tilesLeft`, which is a different
 * number changing on a different schedule, and sharing the slot would make the
 * HUD and the modal evict each other every frame.
 */
let cachedGrantA = -1
let cachedGrantTextA = ''
let cachedGrantB = -1
let cachedGrantTextB = ''
let cachedItems = -1
let cachedItemsText = ''

function grantTextA(tiles: number): string {
  if (tiles !== cachedGrantA) {
    cachedGrantA = tiles
    cachedGrantTextA = `${tiles} TILES`
  }
  return cachedGrantTextA
}

function grantTextB(tiles: number): string {
  if (tiles !== cachedGrantB) {
    cachedGrantB = tiles
    cachedGrantTextB = `${tiles} TILES`
  }
  return cachedGrantTextB
}

/**
 * `x${items}`, memoised on one slot rather than two: the item counts are drawn
 * only when POSITIVE, and the shipped pair offers items on at most one card
 * (`cardItemGrant` returns 0 for the road-tiles card and
 * `UPGRADES_PER_CARD` for the junction upgrade), so one slot is one hit. If a
 * later pool offers two item cards at once this becomes a per-frame miss on one
 * of them — a re-formatted short string, not a correctness change — and the
 * repair is the second slot above.
 */
function itemsText(items: number): string {
  if (items !== cachedItems) {
    cachedItems = items
    cachedItemsText = `x${items}`
  }
  return cachedItemsText
}

/**
 * A card's name, with a fallback that draws an EMPTY card rather than the word
 * `undefined`.
 *
 * `CARD_LABELS` is id-indexed and `game` pins its length against `CARD_COUNT`,
 * so an out-of-range id means the two packages have already disagreed. `render`
 * cannot detect that itself; what it can do is not print the JavaScript for it.
 */
function cardLabel(cardId: number): string {
  return CARD_LABELS[cardId] ?? ''
}

/**
 * The line naming what died — **and the word it does NOT use is the point.**
 *
 * The first version of this screen read `DESTINATION 2 OVERCROWDED`, and
 * "overcrowded" describes too much traffic. Measured on both shipped boards,
 * that is the opposite of what happens: on the demo board the destination that
 * ends the run has **zero draining frames** — its meter climbs from tick 3,492
 * to the end and never once falls, i.e. it is never served at all — and on the
 * starting city **all five** rings behave the same way. A player who reads
 * "overcrowded" concludes the roads are congested and draws fewer of them. The
 * sharpest evidence that this matters: the 15-tile column-8 road that
 * `startingCity.ts` calls *"the natural first road the player draws"* buys
 * **zero ticks**, while five tiles somewhere else buy 750.
 *
 * So the line says which of the two things happened, and it is decided from
 * data `render` already holds rather than from new state:
 *
 * - **`NOTHING CAN REACH DESTINATION n`** when no car can drive to it —
 *   `frame.destReachable[n] !== 1`. A car drives *onto* the carpark and the
 *   flow field relaxes over the road graph, so a destination with no road
 *   component joining its bay to a house of its own colour is one nothing can
 *   ever serve — which is the shape a spawned building has by construction, and
 *   the shape **all five** of the starting city's have. The remedy is literally
 *   a road. (Both counts in this comment read *"four"* until M1e's closing
 *   sweep. Measured on the no-input city driven to its 5,580: **three** seeded,
 *   a fourth spawned at tick 2,250 and a fifth at 4,500, so **five** at the
 *   death tick — five bare carparks, five meters that climb and not one that
 *   ever drains. *"Four"* is the count for the 2,250 ticks between those two
 *   spawns and for no part of the run this comment is about; the spawner had
 *   been live for thirty commits when the sentence was written.)
 *
 *   **The line reads `NOTHING CAN REACH` and not `NO ROAD REACHES` since M1f**,
 *   because the predicate stopped being about roads. Under the old wording a
 *   player who laid one tile on the bay was told the road had arrived — the bug
 *   report that produced this change — and the sentence would have been
 *   literally false the moment the widened predicate started catching the stub.
 * - **`DESTINATION n WENT UNSERVED`** otherwise. Not "overcrowded": the meter
 *   integrates time spent over pin capacity, so what it measures is demand that
 *   went unmet, in the congested case as much as in the abandoned one. This is
 *   the demo board's case — D2's carpark IS on the network and it still received
 *   nothing.
 *
 * Both arms are reachable on the boards that ship, which is why the split is a
 * split and not a branch with a dead side.
 *
 * Memoised on the index and the arm together — **the fourth instance of
 * this file's single-slot cache, and by a wide margin the cheapest.**
 * `scoreText` rebuilds whenever the score moves; `failedDest` changes at most
 * once per run, so after the first shutdown frame this is one integer
 * comparison and nothing else, forever.
 *
 * **The sentinel is -2 rather than -1, and — measured — that choice is an
 * EQUIVALENT MUTANT today. This paragraph says so rather than claiming a
 * correctness it does not have.**
 *
 * The reasoning for -2 is real: -1 is the LIVE value `failedDestination`
 * returns, and a cache primed with -1 would HIT on a first call of
 * `failedText(-1)` and then name destination -1 for the rest of the run. But
 * that call cannot happen. This function has one caller, `drawShutdown`, which
 * runs only when `frame.gameOver` — and `frame.failedDest` is
 * `failedDestination(state)`, which returns `-1` only when the flag is CLEAR.
 * So `d` is always `>= 0` here, and both sentinels miss on the first shutdown
 * frame.
 *
 * Swapping -2 for -1 was run through the whole suite and scored **0 detectors**
 * — no crash, no collection loss, 1,804 of 1,804 passing. It is kept at -2
 * because it costs nothing and because the day something draws this text on a
 * live frame is the day -1 becomes wrong; it is recorded as unpinned so nobody
 * reads its survival as a coverage hole, and nobody "simplifies" it thinking a
 * test is watching.
 *
 * This is what makes `RenderFrame.failedDest` a field with a consumer. A field
 * nothing reads is dead weight in every frame's type and a false claim in
 * whatever the plan promised the shutdown screen would say.
 */
let cachedFailedKey = -2
let cachedFailedText = ''

function failedText(d: number, unreachable: boolean): string {
  // One key for both inputs, so the pair cannot go half-stale: `d * 2 + arm`.
  // The `unreachable` arm can genuinely flip for a fixed `d` — the player may
  // connect the carpark while the shutdown screen is up on a future in-place
  // restart — and a cache keyed on the index alone would keep the old sentence
  // forever.
  const key = d * 2 + (unreachable ? 1 : 0)
  if (key !== cachedFailedKey) {
    cachedFailedKey = key
    cachedFailedText = unreachable
      ? `NOTHING CAN REACH DESTINATION ${d}`
      : `DESTINATION ${d} WENT UNSERVED`
  }
  return cachedFailedText
}

/**
 * Can nothing drive to destination `d`? See `failedText`.
 *
 * **It reads one byte and derives nothing.** Until M1f this function tested
 * `frame.roads[carpark] !== 0`, which is *necessary* for service and nowhere
 * near sufficient — a single tile laid on the bay, joined to nothing, turned
 * the bay grey and told the player they had fixed a destination that still took
 * zero arrivals. That was the shipped build's first user-reported bug. The
 * question needs the road GRAPH and the house colours, which `render` is
 * forbidden to reach for (spec §4), so `game` folds the answer into
 * `destReachable` and this function reads it. See `RenderFrame.destReachable`
 * for what the fold does and does not know.
 *
 * **Two callers, and that is the point of it being a function.** `drawShutdown`
 * picks the ending's sentence with it, and `drawDestinations` picks the live
 * bay's colour with it. Restating the predicate at the second site would let the
 * red bay and `NOTHING CAN REACH DESTINATION n` drift apart, which is precisely
 * the disagreement a player would read as the game lying to them — and the bug
 * above proves the point in the other direction: because they shared one
 * predicate, one fix corrected both at once.
 */
function destinationIsUnreachable(frame: RenderFrame, d: number): boolean {
  // **The index is guarded and fails CLOSED.** `failedDest` is -1 on a live
  // frame and is bounded above only by `destCount`. An OUT-OF-RANGE read is
  // `undefined`, which is already `!== 1`, so that half of the guard agrees
  // with its absence by accident — but a DEAD SLOT is a real index holding a
  // real byte: `destReachable` is preallocated for every slot and `game` folds
  // only `[0, destCount)`, so a slot that was live under a longer prefix still
  // holds its old 1. Without this line that stale byte answers for a
  // destination that no longer exists. `canvas.test.ts` builds exactly that
  // frame.
  if (d < 0 || d >= frame.destCount) return true
  // `!== 1` rather than `=== 0`, so every byte the fold does not set is
  // unreachable. A freshly allocated `Uint8Array` is all zeroes, which means a
  // frame built before the fold ran reads RED — the arm that overstates a
  // problem rather than the arm that hides one.
  return (frame.destReachable[d] as number) !== 1
}

// ---------------------------------------------------------------------------

/**
 * Draws one frame. Twelve phases, in this order, and the order is load-bearing:
 *
 * ```
 * 1 top band + letterbox fills    2 playfield fill    3 non-land terrain
 * 4 ghost roads                   5 live roads        6 destinations
 *                                   (+ the overcrowd ring, M1e Task 9)
 * 7 houses                        8 cars              9 bottom band fill
 * 10 HUD content                  11 the shutdown screen — ONLY when
 *                                    `frame.gameOver`, see `drawShutdown`
 *                                 12 the offer modal — ONLY when
 *                                    `frame.offerPending`, see `drawOffer`
 * ```
 *
 * **These twelve are THIS FILE'S LAYER COUNT and have nothing to do with
 * `sim`'s eleven tick phases.** The two numbering schemes were equal at eleven
 * for exactly one milestone and diverged at M1f Task 8; a reader who conflates
 * them goes looking for a tick phase 12 that does not exist, or reads "phase 4"
 * in a `sim` comment as the ghost layer. There is no correspondence between the
 * two lists at any index and there never was.
 *
 * **Phases 11 and 12 are the conditional ones, and that is worth a warning
 * rather than a note.** A new gated phase is unconstrained by every fixture that
 * does not set its gate: a trial version of the shutdown scrim left the whole
 * render suite green because the two base fixtures never set `gameOver` and
 * `undefined` is falsy. Anything added under a flag needs a fixture on both
 * sides of it — which is why `frameA` and `frameB` set every offer field
 * explicitly rather than leaving them absent.
 *
 * **11 EXCLUDES 12, and that pair is reachable — the first draft of this file
 * said it was not and was wrong.** The argument was: `step` is a byte-identical
 * no-op past the failure, so no week boundary can be crossed on a dead board.
 * True, and it is the wrong direction. The boundary is crossed BEFORE the death,
 * with the offer left unresolved, and then the death freezes `offerPending`
 * **true forever** — `H_OFFER_WEEK` can never catch up on a state that does not
 * advance. `game/test/drawAllocation.test.ts`'s already-dead rig is exactly that
 * state and it is what caught this: with the two phases as independent `if`s it
 * drew two scrims a frame, a modal over a shutdown screen.
 *
 * A player is protected from it in production by the shell's pause rather than
 * by the sim (the loop stops at the boundary and the run cannot continue until a
 * card is taken), and that protection ends wherever a warm start crosses a week
 * — which every long-warm-start rig does today, and which **M3's restore** will
 * do with a real saved game.
 *
 * So the shutdown WINS, and the reason is not aesthetic: `game/pointer.ts` puts
 * its game-over branch ABOVE its modal branch, so a tap on that screen restarts
 * the run. Drawing a modal over it would put a question on screen that the next
 * tap answers differently. **Draw order and tap order have to agree**, and this
 * `else` is where that agreement lives on the drawing side.
 *
 * **Phases 4 and 5 cannot paint the same cell, and the order between them is
 * fixed anyway.** `sim` only ghosts a cell whose live mask reached 0, and
 * `placeRoad` pays the pending refund and clears the ghost, so
 * `roads[c] !== 0 && ghosts[c] !== 0` is unreachable — which means swapping
 * these two calls changes no pixel today and is an equivalent mutant *on the
 * pixels*. It is written ghost-first regardless, so that the LIVE layer wins if
 * that invariant is ever broken: a road that exists must not be hidden under the
 * memory of one that does not. Recorded rather than left as apparent coverage —
 * the command ORDER is asserted in `test/canvas.test.ts` and that assertion is
 * pinning a chosen safety margin, not a visible behaviour.
 *
 * **The five fills partition the canvas, and the count is forced rather than
 * chosen.** Plan Decision 4 requires them to cover the canvas *exactly once* —
 * its own frame model charges that at 1,412,880 device px, the M0 device's whole
 * backing store — and the complement of an interior rectangle inside a rectangle
 * needs **four** rectangles, so painting the playfield as its own rect is five
 * fills, not the "fourth fill" Task 9's brief names. The four background pieces
 * would be five if the vertical gap below the grid rect and the HUD band were
 * kept apart, and they are not: both are `palette.background`, so one fill from
 * the grid rect's bottom edge to the canvas bottom covers the gap, the HUD band
 * and the bottom safe-area inset together.
 *
 * **The bottom fill stays after the cars, which is where the old HUD band fill
 * was, and that is load-bearing.** It is the only thing stopping a sprite that
 * overhangs the grid rect from painting into the HUD band and staying there
 * forever — there is no `clearRect` coming. The consequence is new and
 * deliberate: a car driving off the rect's **bottom** edge is now clipped at that
 * edge (up to 3/4 of a tile of overhang) instead of trailing across the gap, so
 * the playfield reads as a hard rectangle. The two letterbox columns are painted
 * *before* the content, so a car at the left or right edge still straddles it —
 * asymmetric, inherited rather than introduced, and 0 CSS px wide on the M0
 * device anyway. This also implements half of what the note below says M1f must
 * do when the revealed rect becomes dynamic.
 *
 * **The band edges are snapped to whole device pixels, and that is a fix for a
 * real ghosting seam rather than tidiness.** `fitCamera` works in integer CSS
 * px, but `DPR_CAP_LOW` is **1.5**, so an odd CSS edge lands on a *half* device
 * pixel. `Pixel 412x915, insets 24/24, LOW` — integer inputs, a real device
 * shape — gives `hudTop = 819` and `819 x 1.5 = 1228.5`. The device row at
 * 1228 is then covered by two source-over passes at alpha 0.5 rather than one
 * opaque pass, so it keeps **25% of the previous frame**: exactly the ghosting
 * Decision 4's "every pixel of the canvas must be covered" exists to prevent,
 * on the class of device the DPR cap was written for. `deviceEdge` below rounds
 * each cut to a whole device pixel before dividing back into CSS.
 *
 * Only the three OPAQUE BAND EDGES are snapped. Cell boundaries are not: at a
 * 29 px tile and DPR 1.5 a cell is 43.5 device px, and that resample is Task
 * 3's stated, accepted trade. It is a softness, not a coverage hole — the bands
 * underneath are opaque and complete.
 *
 * Everything on the board is culled to the revealed rect: terrain and roads by
 * iterating it, buildings and cars by testing their anchor cell against it. A
 * building whose anchor is outside is not drawn at all, even if its footprint
 * would reach inside — correct for M2, where the rect is frozen and Task 2's
 * seed places every building well within it, and the thing M1f must revisit when
 * the rect becomes dynamic (the fix then is a `clip` around phases 3-8, which
 * would also stop a partially-visible building painting into the HUD band).
 * **Repointed from M1d at the close of M1d and from M1e at the close of M1e**,
 * both of which declined board expansion; the rect is still frozen and this is
 * still open. M1e did sharpen the claim in one way: `sim/spawn.ts` now places
 * buildings by scanning the same frozen rect, so nothing can spawn outside it
 * and the "anchor outside, footprint inside" case stays as rare as the seed
 * made it.
 *
 * **Cars are culled by their own position and not by anything the buildings do,
 * and a car near the rect's last column or row overhangs it by up to
 * `3 * tileSize / 4` CSS px.** That is correct — the sprite is centred on a
 * position the sim genuinely put at the edge — and the reason it never reaches
 * the HUD is the **draw order**: the bottom band is phase 9 and cars are phase
 * 8, so it paints over anything that spilled below the grid rect. Not anchor
 * culling, which is the buildings' protection and not the cars'. Sideways the
 * overhang survives, because the two letterbox columns are phase 1.
 */
export function drawFrame(
  ctx: DrawContext,
  frame: RenderFrame,
  atlases: Atlases,
  palette: Palette,
): void {
  assertAtlases(atlases, palette)

  const camera = frame.camera
  const dpr = camera.dpr
  // The canvas's own extent in CSS px, as the backing store will actually be
  // sized: `round(css * dpr)` device px. Task 8 MUST size the canvas with the
  // same rounding, or the last device row/column is outside every band.
  const right = deviceEdge(camera.cssW, dpr)
  const bottom = deviceEdge(camera.cssH, dpr)
  // Clamped and kept monotone, so the five fills tile the ON-CANVAS area for
  // every viewport including the degenerate ones `fitCamera` clamps for: at
  // `cssH = 0` the plain formula gives `originY = -41` and a negative-height
  // fill, which the canvas normalises but which is a wasted call and a geometry
  // no test should have to reason about. At `cssW = 0` the same happens
  // horizontally — `originX = -7` at a clamped tile of 1 — and the two letterbox
  // clamps collapse the playfield to zero width rather than to a negative one.
  const gridTop = clamp(deviceEdge(camera.originY, dpr), 0, bottom)
  const gridBottom = clamp(
    deviceEdge(camera.originY + camera.rows * camera.tileSize, dpr),
    gridTop,
    bottom,
  )
  const gridLeft = clamp(deviceEdge(camera.originX, dpr), 0, right)
  const gridRight = clamp(
    deviceEdge(camera.originX + camera.cols * camera.tileSize, dpr),
    gridLeft,
    right,
  )

  // 1. The background matte, in three pieces: the top band down to the grid
  //    rect, then the letterbox column on each side of it. The fourth piece is
  //    phase 9, because it has to paint over the cars.
  ctx.fillStyle = palette.background
  ctx.fillRect(0, 0, right, gridTop)
  ctx.fillRect(0, gridTop, gridLeft, gridBottom - gridTop)
  ctx.fillRect(gridRight, gridTop, right - gridRight, gridBottom - gridTop)

  // 2. The playfield: exactly the grid rect, and the only land on the canvas.
  //    `drawTerrain` relies on this having covered every LAND cell already.
  ctx.fillStyle = palette.land
  ctx.fillRect(gridLeft, gridTop, gridRight - gridLeft, gridBottom - gridTop)

  drawTerrain(ctx, frame, palette)
  // 4 then 5. See the phase list: the two layers are disjoint per cell, and the
  // live one is drawn second so that it wins if they ever stop being.
  drawMaskLayer(ctx, frame, frame.ghosts, atlases.ghost)
  drawMaskLayer(ctx, frame, frame.roads, atlases.road)
  drawDestinations(ctx, frame, palette)
  drawHouses(ctx, frame, palette)
  drawCars(ctx, frame, palette)

  // 9. The bottom band: from the grid rect's bottom edge down to the canvas
  // BOTTOM, not merely to the HUD band's own height. It covers three things at
  // once — the vertical gap between the grid rect and the band, the band, and
  // the bottom safe-area inset under it. A fill that started at `hudTop` would
  // leave the gap painted land (the defect this task closes) and one that
  // stopped at `hudTop + hudHeight` would leave the inset holding the previous
  // frame forever; there is no clearRect coming to fix either.
  ctx.fillStyle = palette.background
  ctx.fillRect(0, gridBottom, right, bottom - gridBottom)

  drawHud(ctx, frame, palette)

  // 11. The shutdown screen, and NOTHING when the run is live. Last, after the
  //     HUD, because the HUD's own labels must not be able to paint over it.
  // 12. §5.10's offer modal — and NOTHING on a dead board, which is an `else`
  //     rather than a second `if` for a reason `drawOffer` spells out: the
  //     pointer's game-over branch sits ABOVE its modal branch, so a tap on
  //     that screen restarts the run. A modal drawn over a shutdown screen
  //     would be asking for a choice the next tap cannot make.
  if (frame.gameOver) drawShutdown(ctx, frame, palette, right, gridTop, gridBottom)
  else if (frame.offerPending) drawOffer(ctx, frame, palette, right, bottom)
}

/**
 * Phase 11, and the only phase in this file that does not run every frame.
 *
 * **What a person sees.** The board they were watching dims but stays visible —
 * the scrim is translucent, so the frozen cars, the frozen queues and the
 * nearly-closed ring around the destination that killed the city are all still
 * there. Three lines sit over it: which destination shut the city down, how
 * many trips they made, and that a tap starts a new one.
 *
 * **The scrim covers the BOARD and stops at the grid rect's bottom edge**, so
 * the HUD band underneath keeps its own contrast and the clock, score and tile
 * readouts stay legible. `camera.hudTop` is the top edge of the BOTTOM band —
 * `max(originY + gridHeight, cssH - bottomInset - HUD_BAND_CSS)` — so the board
 * is `[originY, hudTop)` and a rect that started at `hudTop + hudHeight` would
 * cover zero board pixels, and on a viewport with no bottom inset would have
 * zero height. It runs from `y = 0` rather than from the board top so the top
 * band and the two letterbox columns dim with it; a bright frame around a dark
 * board reads as a rendering fault rather than as a state.
 *
 * **This is the one place plan Decision 4's "every pixel exactly once" is
 * knowingly exceeded**, and it is not the ghosting hazard that rule exists for:
 * the five opaque fills still partition the canvas on this frame as on every
 * other, so nothing from the previous frame survives. It is one extra
 * source-over pass over pixels that are already correct, on a frame where the
 * sim is frozen and there is no tick budget to compete with.
 *
 * **Nothing here allocates.** Two of the three lines are the same memoised
 * caches the HUD uses (`failedText`, `scoreText`) and the third is a
 * preallocated constant.
 */
function drawShutdown(
  ctx: DrawContext,
  frame: RenderFrame,
  palette: Palette,
  right: number,
  gridTop: number,
  gridBottom: number,
): void {
  ctx.fillStyle = palette.scrim
  ctx.fillRect(0, 0, right, gridBottom)

  // **The killer's ring, redrawn OVER the scrim and thicker.** Under the scrim
  // it is dimmed with everything else, so "which destination" was inferable
  // only from being the biggest arc on a board of 18 buildings. Over it, the
  // sentence below and the thing it names are the two bright objects on the
  // screen, and the player's eye goes from one to the other without counting.
  // Guarded on the live prefix, because `failedDest` is -1 on a frame no other
  // line of this function can be reached from.
  const failed = frame.failedDest
  if (failed >= 0 && failed < frame.destCount) {
    strokeRing(ctx, frame, palette, failed, SHUTDOWN_RING_WIDTH_SCALE)
  }

  const cx = right / 2
  const cy = (gridTop + gridBottom) / 2
  const maxWidth = right - 2 * SHUTDOWN_TEXT_INSET_CSS
  // Four lines, centred as a block: `cy` is the middle of the run, so the top
  // line sits 1.5 strides above it rather than 1.
  const top = cy - 1.5 * SHUTDOWN_LINE_STRIDE_CSS

  ctx.font = SHUTDOWN_FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  // `land` on `scrim` is `index.html`'s own pair inverted, which is the same
  // choice `BOOT_FAILURE_STYLE` makes for the same reason: the panel must not
  // be mistakable for part of the board.
  ctx.fillStyle = palette.land
  // In the order a reader needs them: what happened, **what to do about it**,
  // what it was worth, and how to start again.
  //
  // **The third line is the one the first version was missing.** A failure
  // state whose text contains none of the words "road", "connect" or "draw"
  // leaves the player to infer the verb of the game from a noun, and the
  // measurement in `startingCity.ts` is what happens when they infer wrong.
  //
  // `maxWidth` on every line, so a long label condenses instead of leaving the
  // canvas — the same construction guarantee `fillCentred` gives the HUD.
  ctx.fillText(failedText(failed, destinationIsUnreachable(frame, failed)), cx, top, maxWidth)
  ctx.fillText(ADVICE_TEXT, cx, top + SHUTDOWN_LINE_STRIDE_CSS, maxWidth)
  ctx.fillText(scoreText(frame.score), cx, top + 2 * SHUTDOWN_LINE_STRIDE_CSS, maxWidth)
  ctx.fillText(RESTART_TEXT, cx, top + 3 * SHUTDOWN_LINE_STRIDE_CSS, maxWidth)
}

/**
 * Phase 12 — §5.10's weekly card offer, and the second of this file's two
 * conditional phases (M1f Task 8).
 *
 * **What a person sees.** At the first week boundary the board stops and this
 * draws over it: the whole canvas dims, one line says CHOOSE A CARD, and two
 * large cards stack down the middle of the screen with a name and what they pay
 * — `ROAD TILES / 30 TILES` and `JUNCTION UPGRADE / 20 TILES / x2`. Under them
 * sits SEE THE BOARD. Tapping a card takes it and the board runs on with the
 * tile counter jumped; tapping SEE THE BOARD hides all of this and shows the
 * frozen board, with TAP TO RETURN left standing so the way back is visible.
 *
 * ---------------------------------------------------------------------------
 * NOT DRAWN AT ALL ON A DEAD BOARD, AND THAT IS TAP ORDER RATHER THAN TASTE
 * ---------------------------------------------------------------------------
 *
 * `drawFrame` reaches this phase only when `!frame.gameOver`. A dead board with
 * an unresolved offer is a real state — see the phase list — and on it
 * `game/pointer.ts` answers every tap with `RESTART_REQUESTED`, because its
 * game-over branch is above its modal branch. A modal drawn over that screen
 * would be asking a question the next tap does not answer.
 *
 * ---------------------------------------------------------------------------
 * THE SCRIM COVERS THE **WHOLE CANVAS**, AND `drawShutdown`'s STOPS AT THE BOARD
 * ---------------------------------------------------------------------------
 *
 * That difference is deliberate and it is the opposite choice from the one 40
 * lines above, so it is worth saying which reason belongs to which screen.
 *
 * The shutdown screen leaves the HUD band undimmed because the score is part of
 * what it is telling the player, and the clock is inert there (`drawHud` takes
 * the pause bars down on a game-over frame for the same reason).
 *
 * **This screen must dim the HUD, because the HUD clock is a pause TOGGLE.**
 * §5.10 gives this modal no skip and no timer; a bright, legible pause control
 * sitting under it is an invitation to press the one thing that looks like a way
 * out and is not. `game/pointer.ts` refuses that tap — `REFUSED_OFFER_MODAL` —
 * and a refusal the player cannot see coming is a control that does nothing.
 * Dimming it is the visible half of the same decision.
 *
 * ---------------------------------------------------------------------------
 * PEEK HIDES THE CHROME. IT DOES NOT RESUME THE SIM, AND IT KEEPS THE WAY BACK
 * ---------------------------------------------------------------------------
 *
 * Plan Decision 16. While `frame.offerPeek` holds there is **no scrim at all**,
 * so the frozen board is at full contrast — that is the entire point of the
 * control, and a dimmed peek would be a peek at nothing. The loop stays paused
 * (`pointer.ts` never calls `setPaused` on this path) and board input stays
 * refused, so peek is not a free unpause, which is the one thing a modal with no
 * timer must not offer.
 *
 * The peek pill stays drawn in both states, in the same place and the same
 * colours, with only its label changing. A control that vanishes when you use it
 * is a control that has to be rediscovered.
 *
 * **Nothing here allocates.** The rects are a module-level scratch, every string
 * is either a preallocated constant or one of the three memoised
 * number->string caches above, and the two fonts are preallocated exactly as
 * `HUD_FONT` and `SHUTDOWN_FONT` are.
 */
function drawOffer(
  ctx: DrawContext,
  frame: RenderFrame,
  palette: Palette,
  right: number,
  bottom: number,
): void {
  const rects = offerRects(frame.camera, OFFER_SCRATCH)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  if (frame.offerPeek) {
    drawPeekPill(ctx, palette, rects, PEEK_RETURN_TEXT)
    return
  }

  // The scrim, edge to edge — see above for why this one does not stop at the
  // board. `right`/`bottom` are the canvas's own device-snapped extent, the
  // same pair the five opaque fills are cut against, so the dim lands on
  // exactly the pixels that were painted this frame.
  ctx.fillStyle = palette.scrim
  ctx.fillRect(0, 0, right, bottom)

  // The instruction, one gap above the first card. Positioned off `cardA`
  // rather than off a second copy of `offerRects`' own clamped `top`, so there
  // is one derivation of where the modal starts and not two.
  ctx.font = OFFER_TITLE_FONT
  ctx.fillStyle = palette.land
  ctx.fillText(
    OFFER_TITLE_TEXT,
    right / 2,
    rects.cardA.y - OFFER_GAP_CSS - OFFER_TITLE_H_CSS / 2,
    right - 2 * OFFER_TEXT_INSET_CSS,
  )

  drawCard(ctx, palette, rects.cardA, frame.offerA, grantTextA(frame.offerGrantA), frame.offerItemsA)
  drawCard(ctx, palette, rects.cardB, frame.offerB, grantTextB(frame.offerGrantB), frame.offerItemsB)

  drawPeekPill(ctx, palette, rects, PEEK_TEXT)
}

/**
 * One card face and its three lines. The grant string is passed IN rather than
 * formatted here, because the two cards have their own memo slots — see
 * `grantTextA`.
 *
 * `maxWidth` on every run, so a long card name condenses instead of leaving the
 * face: the same construction guarantee `fillCentred` gives the HUD, and it
 * matters more here because `CARD_LABELS`' longest entry is `JUNCTION UPGRADE`
 * at 16 characters against a card that is `cssW - 32` CSS px wide, which is 288
 * at the 320 px viewport `fitCamera` accepts.
 */
function drawCard(
  ctx: DrawContext,
  palette: Palette,
  rect: Rect,
  cardId: number,
  grant: string,
  items: number,
): void {
  ctx.fillStyle = palette.cardFace
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h)

  const cx = rect.x + rect.w / 2
  const maxWidth = rect.w - 2 * OFFER_TEXT_INSET_CSS

  ctx.font = OFFER_TITLE_FONT
  ctx.fillStyle = palette.cardText
  ctx.fillText(cardLabel(cardId), cx, rect.y + rect.h * OFFER_NAME_Y_FRACTION, maxWidth)

  ctx.font = OFFER_GRANT_FONT
  ctx.fillStyle = palette.cardAccent
  ctx.fillText(grant, cx, rect.y + rect.h * OFFER_GRANT_Y_FRACTION, maxWidth)
  // **Only when positive**, so the road-tiles card shows no count rather than
  // an `x0`. `cardItemGrant` returns 0 for it by design — that zero is what
  // lets `applyChooseCard` pay both grants unconditionally with no `if` to get
  // wrong — and this is the one place the zero has to be re-read as "no badge".
  if (items > 0) {
    ctx.fillText(itemsText(items), cx, rect.y + rect.h * OFFER_ITEMS_Y_FRACTION, maxWidth)
  }
}

/** The peek control, identical in both states except for its label. */
function drawPeekPill(
  ctx: DrawContext,
  palette: Palette,
  rects: OfferRects,
  label: string,
): void {
  const rect = rects.peek
  ctx.fillStyle = palette.cardAccent
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h)
  ctx.font = OFFER_GRANT_FONT
  ctx.fillStyle = palette.cardFace
  ctx.fillText(
    label,
    rect.x + rect.w / 2,
    rect.y + rect.h / 2,
    rect.w - 2 * OFFER_TEXT_INSET_CSS,
  )
}

/**
 * A CSS coordinate moved to the nearest whole **device** pixel and expressed
 * back in CSS px. The identity on any edge that is already integral in device
 * space, which is every edge at the universal DPR-2 cap with an integer CSS
 * camera — so this changes nothing on the M0 device and everything at 1.5.
 */
function deviceEdge(cssValue: number, dpr: number): number {
  return Math.round(cssValue * dpr) / dpr
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

/**
 * Phase 3. Only non-LAND cells paint: the land band has already covered every
 * cell in the land colour, and painting it a second time per cell is exactly the
 * double coverage Decision 4 removed the `clearRect` to avoid.
 *
 * Water and mountain fill the whole cell — they are terrain. A tree is drawn
 * INSET, so the land shows around it: a tree is a thing standing on land, and a
 * cell-filling green square reads as a different terrain type.
 *
 * An unrecognised class draws nothing, rather than falling through to a colour.
 * The alternative — a default arm — turns a `game`-side fold bug into a board
 * painted in the wrong terrain with nothing to notice.
 */
function drawTerrain(ctx: DrawContext, frame: RenderFrame, palette: Palette): void {
  const camera = frame.camera
  const tile = camera.tileSize
  const treeInset = tile * TREE_INSET_FRACTION
  const treeSize = tile * TREE_SIZE_FRACTION
  const yEnd = camera.y0 + camera.rows
  const xEnd = camera.x0 + camera.cols

  for (let y = camera.y0; y < yEnd; y++) {
    const rowBase = y * frame.gridW
    const py = gridToScreenY(camera, y)
    for (let x = camera.x0; x < xEnd; x++) {
      const terrain = frame.terrainClass[rowBase + x] as number
      if (terrain === TerrainClass.LAND) continue
      const px = gridToScreenX(camera, x)
      if (terrain === TerrainClass.WATER) {
        ctx.fillStyle = palette.water
        ctx.fillRect(px, py, tile, tile)
      } else if (terrain === TerrainClass.MOUNTAIN) {
        ctx.fillStyle = palette.mountain
        ctx.fillRect(px, py, tile, tile)
      } else if (terrain === TerrainClass.TREE) {
        ctx.fillStyle = palette.tree
        ctx.fillRect(px + treeInset, py + treeInset, treeSize, treeSize)
      }
    }
  }
}

/**
 * Phases 4 and 5. One `drawImage` per non-zero cell of `masks`, from that mask's
 * own tile of the 256-entry `atlas` — the whole reason the atlas exists (plan
 * Decision 4: 139 blits, ~0.069 ms at M2's regime, against a path-stroke per
 * cell).
 *
 * **One function, called twice, and that is a deliberate departure from the
 * brief's "one more loop".** The catalogue's most expensive bounds finding is
 * that `drawTerrain`'s and `drawRoads`' `xEnd`/`yEnd` could each be shrunk with
 * 178 tests green — *two* loops, *two* bounds, and the fixture happened to
 * defeat both. A third copy would be a third bound whose only protection is a
 * copied test. Sharing means there is exactly one bound here, and the ghost
 * bounds tests in `test/canvas.test.ts` are a second, independent detector for
 * it rather than the only detector for a second one. What they DO uniquely
 * cover, and what the brief's separate-loop shape would not have made any
 * easier, is that the ghost pass is called with `frame.ghosts` and the GHOST
 * atlas: pass `frame.roads` or `atlases.road` and every ghost assertion fails.
 *
 * The source rect is in **device** px (`atlas.tileDevicePx`) and the destination
 * rect in **CSS** px (`camera.tileSize`); at the DPR-2 cap the two differ by
 * exactly the ratio, and swapping them draws every road at half or double size.
 *
 * Mask 0 is never blitted. `state.roads` and `state.ghostMask` both use 0 for
 * "nothing here", and tile 0 is a blank that exists only so the mask indexes the
 * atlas grid directly.
 */
function drawMaskLayer(
  ctx: DrawContext,
  frame: RenderFrame,
  masks: Uint8Array,
  atlas: Atlas,
): void {
  const camera = frame.camera
  const tile = camera.tileSize
  const source = atlas.tileDevicePx
  const yEnd = camera.y0 + camera.rows
  const xEnd = camera.x0 + camera.cols

  for (let y = camera.y0; y < yEnd; y++) {
    const rowBase = y * frame.gridW
    const py = gridToScreenY(camera, y)
    for (let x = camera.x0; x < xEnd; x++) {
      const mask = masks[rowBase + x] as number
      if (mask === 0) continue
      ctx.drawImage(
        atlas.surface,
        atlasSourceX(atlas, mask),
        atlasSourceY(atlas, mask),
        source,
        source,
        gridToScreenX(camera, x),
        py,
        tile,
        tile,
      )
    }
  }
}

/**
 * Phase 6, above both road layers: a road is legal on a carpark cell (it is the
 * driveway), so drawing the building first would leave the road on top of it.
 *
 * The footprint box is derived from the orientation — the second copy of
 * `sim`'s geometry documented at `DEST_ORIENTATION_N`. The carpark cell is NOT
 * derived: `game` computed it with `sim`'s own `carparkCell` and put it in the
 * frame, so there is one fewer convention to copy. `-1` means the carpark fell
 * off the grid, which stored placements never produce but the value is
 * representable, and drawing it would put a bay at the board's top-left corner.
 */
function drawDestinations(ctx: DrawContext, frame: RenderFrame, palette: Palette): void {
  const camera = frame.camera
  const tile = camera.tileSize
  const carparkInset = tile * CARPARK_INSET_FRACTION
  const carparkSize = tile * CARPARK_SIZE_FRACTION
  const pinSize = tile * PIN_SIZE_FRACTION
  const pinStride = tile * PIN_STRIDE_FRACTION

  for (let d = 0; d < frame.destCount; d++) {
    const cell = frame.destCell[d] as number
    const ax = cell % frame.gridW
    const ay = Math.floor(cell / frame.gridW)
    if (!insideRevealed(camera, ax, ay)) continue

    const orientation = frame.destOrientation[d] as number
    const footprintW = destFootprintW(orientation)
    const footprintH = destFootprintH(orientation)
    const px = gridToScreenX(camera, ax)
    const py = gridToScreenY(camera, ay)
    ctx.fillStyle = groupColour(palette, frame.destColour[d] as number)
    ctx.fillRect(px, py, footprintW * tile, footprintH * tile)

    // **The `>= 0` test is SUBSUMED by the `insideRevealed` below it, and this
    // comment is why neither may be deleted on the strength of its own
    // survival.** `carparkCell` returns -1 when the bay would fall off the grid;
    // `-1 % w` is `-1` and `floor(-1 / w)` is `-1` in JavaScript, so a -1
    // carpark decomposes to (-1, -1), which `insideRevealed` rejects for **any
    // `x0 >= 0`** — not merely for M2's frozen `x0 = 5`, so the equivalence
    // survives M1f making the rect dynamic all the way down to column 0.
    // Deleting this line **outright** (`if (true)`) therefore passes the whole
    // suite, which is stronger evidence of equivalence than widening it to
    // `>= -1` and is the form to reach for when re-checking. It stays because
    // the two guards mean different things — one rejects a sentinel, the other
    // clips to the camera — and the compound edit that removes both IS caught.
    const carpark = frame.destCarpark[d] as number
    if (carpark >= 0) {
      const cx = carpark % frame.gridW
      const cy = Math.floor(carpark / frame.gridW)
      if (insideRevealed(camera, cx, cy)) {
        // **The bay is painted in the alarm colour when nothing can reach the
        // destination, and this is the same predicate the shutdown screen
        // splits its sentence on** — `destinationIsUnreachable`, called from
        // here and from `drawShutdown` rather than restated, so the live signal
        // and the ending's sentence cannot disagree about which destination was
        // unreachable. (Inside this branch the index guard is redundant: `d` is
        // below `destCount` by the loop bound.)
        //
        // **Why the bay rather than a new sprite.** A destination nothing can
        // drive to takes zero arrivals for as long as that holds, so it is
        // doomed from the frame it appears, and until M1e Task 9 it was
        // pixel-identical to a healthy one for the 95-107 s its meter needed
        // before the ring painted its first pixel. The fill already happens;
        // this is zero extra draw calls, and both palette strings are
        // preallocated, so it is zero allocations.
        //
        // **The predicate was `roads[carpark] !== 0` and that was WRONG, in the
        // one direction a player can produce with a finger.** A stub laid on
        // the bay alone set the road bit, so the bay turned grey while nothing
        // could still reach the destination — reported by the first person to
        // play the shipped build, inside a minute. It now reads `game`'s
        // `destReachable` fold: bay and house of the same colour in one road
        // component. Every bay that was red before is still red; only the grey
        // arm was ever lying.
        //
        // **What it still does not detect, stated here because the colour looks
        // more certain than it is.** Reachability is topological. It says
        // nothing about the CONNECTED-but-under-served failure — a bay on the
        // network that receives too little, which is the greedy arm's killer
        // (D6, one arrival per 436 ticks) and the demo board's — nor about
        // gridlock, nor about a route longer than `MAX_PATH_LEN`. The overcrowd
        // ring carries pressure and covers those: measured, it is legible 131.9
        // s before the greedy arm's death. **The bay stays two-state
        // deliberately.** A third state would be a second threshold on the same
        // fact the ring already draws, and it would make one mark mean two
        // things — which is how the predicate this replaced went wrong.
        //
        // A grey bay is not a promise; a red one is a fact.
        ctx.fillStyle = destinationIsUnreachable(frame, d) ? palette.overcrowd : palette.roadEdge
        ctx.fillRect(
          gridToScreenX(camera, cx) + carparkInset,
          gridToScreenY(camera, cy) + carparkInset,
          carparkSize,
          carparkSize,
        )
      }
    }

    const pins = frame.destPins[d] as number
    if (pins > 0) {
      const drawn = pins < MAX_DRAWN_PINS ? pins : MAX_DRAWN_PINS
      ctx.fillStyle = palette.uiText
      for (let p = 0; p < drawn; p++) {
        ctx.fillRect(px + pinSize + p * pinStride, py + pinSize, pinSize, pinSize)
      }
    }

    // **The overcrowd ring, §5.8's timer made visible.** Inside this loop, so it
    // inherits the phase's `insideRevealed` cull rather than growing a second
    // copy of it — the catalogue's most expensive bounds finding is that two
    // loops mean two bounds and one fixture defeating both.
    //
    // **What the ring says, measured rather than reasoned.** The meter
    // integrates while a destination is over its pin capacity and unwinds while
    // it is not, so a served destination's ring *can* fall — but on both shipped
    // boards it does not: every destination that ends a run has **zero draining
    // frames**, and the only demo ring that drains peaks at 19/255 in the last
    // 25 s. So a ring here means "this destination is not being served and it
    // will end the run", full stop. Drawn AT the building rather than as a bar
    // in the HUD for exactly that reason — the answer to "which one" has to be a
    // place, not a number.
    //
    // Zero draws nothing: an empty ring on every destination is 16 rings of
    // noise and the one that matters stops standing out.
    const meter = frame.destOvercrowd[d] as number
    if (meter !== 0) strokeRing(ctx, frame, palette, d, 1)
  }
}

/**
 * One overcrowd ring, around destination `d`'s footprint.
 *
 * Shared by phase 6 and phase 11, and shared rather than copied for the reason
 * `drawMaskLayer` is called twice instead of written twice: two copies would be
 * two geometries, and the second one's only protection would be a copied test.
 * `widthScale` is the only thing the two call sites differ by — the shutdown
 * screen redraws the killer's ring thicker, over the scrim.
 */
function strokeRing(
  ctx: DrawContext,
  frame: RenderFrame,
  palette: Palette,
  d: number,
  widthScale: number,
): void {
  const camera = frame.camera
  const tile = camera.tileSize
  const cell = frame.destCell[d] as number
  const orientation = frame.destOrientation[d] as number
  const footprintW = destFootprintW(orientation)
  const footprintH = destFootprintH(orientation)
  const px = gridToScreenX(camera, cell % frame.gridW)
  const py = gridToScreenY(camera, Math.floor(cell / frame.gridW))
  // `max` of the two, which is 3 for both orientations today — see
  // `RING_RADIUS_FRACTION` for why it is written derived anyway.
  const span = footprintW > footprintH ? footprintW : footprintH
  ctx.strokeStyle = palette.overcrowd
  // A whole CSS pixel, and an integer store — see `RING_WIDTH_FRACTION`, and
  // note that no allocation harness is watching this.
  ctx.lineWidth = ringWidth(tile) * widthScale
  // `beginPath` per ring, not per frame: without it every ring after the first
  // joins the previous one's subpath and the board grows a web of straight
  // lines between destinations.
  ctx.beginPath()
  // **Floored at `RING_MIN_SWEEP`, not gated by it** — see that constant. The
  // caller's `meter !== 0` test is what decides whether a ring exists; this only
  // decides how short the shortest drawn one is allowed to be.
  const meter = frame.destOvercrowd[d] as number
  const sweep = meter > RING_MIN_SWEEP ? meter : RING_MIN_SWEEP
  ctx.arc(
    px + (footprintW * tile) / 2,
    py + (footprintH * tile) / 2,
    span * tile * RING_RADIUS_FRACTION,
    RING_START_ANGLE,
    RING_START_ANGLE + (sweep / RING_FULL) * TAU,
  )
  // `arc` alone appends to the path and paints nothing.
  ctx.stroke()
}

/**
 * Phase 7, above the roads for the same reason as phase 6: `placeRoad` allows a
 * road on a house cell.
 *
 * Reads `[0, houseCount)` and nothing beyond it. That prefix is the whole
 * liveness contract (plan Decision 3): no region behind `RenderFrame` carries a
 * `-1` sentinel, so an unused slot holds cell 0 — a real, in-bounds cell — and
 * the count is the only thing separating a house from a phantom. (Narrowed at
 * M1d Task 2: `sim` now has one `-1`-filled region, `occupancy`, and `render`
 * neither receives it nor could.)
 */
function drawHouses(ctx: DrawContext, frame: RenderFrame, palette: Palette): void {
  const camera = frame.camera
  const tile = camera.tileSize
  const inset = tile * HOUSE_INSET_FRACTION
  const size = tile * HOUSE_SIZE_FRACTION

  for (let h = 0; h < frame.houseCount; h++) {
    const cell = frame.houseCell[h] as number
    const x = cell % frame.gridW
    const y = Math.floor(cell / frame.gridW)
    if (!insideRevealed(camera, x, y)) continue
    ctx.fillStyle = groupColour(palette, frame.houseColour[h] as number)
    ctx.fillRect(
      gridToScreenX(camera, x) + inset,
      gridToScreenY(camera, y) + inset,
      size,
      size,
    )
  }
}

/**
 * Phase 8, above the buildings: a car drives onto the carpark, and a car parked
 * under its destination is a car the player cannot see.
 *
 * **`carXY` is in cell-CENTRE units and this is the one place the two coordinate
 * conventions in this milestone meet.** `gridToScreen` maps a cell to its
 * top-left corner; `game`'s resolver maps a car to `(cx, cy)` when it is parked
 * on cell `(cx, cy)` and to `(cx + 0.5, cy)` half way along an eastward edge
 * (plan Decision 2). So an integer grid coordinate names a cell's centre, and
 * the CSS centre is `gridToScreen(gx, gy) + tileSize / 2`. Dropping the half-tile
 * shifts every car up and left by half a cell — visible, and easy to mistake for
 * an art offset.
 *
 * `carXY` is dense: `game` packs `carCount` live cars at the front, because cars
 * have no index-based count in the sim at all and `PHASE_NONE` is their only
 * liveness marker.
 */
function drawCars(ctx: DrawContext, frame: RenderFrame, palette: Palette): void {
  const camera = frame.camera
  const tile = camera.tileSize
  const size = tile * CAR_SIZE_FRACTION
  const half = size / 2
  const centre = tile / 2

  for (let c = 0; c < frame.carCount; c++) {
    const gx = frame.carXY[c * 2] as number
    const gy = frame.carXY[c * 2 + 1] as number
    if (!insideRevealed(camera, gx, gy)) continue
    ctx.fillStyle = groupColour(palette, frame.carColour[c] as number)
    ctx.fillRect(
      gridToScreenX(camera, gx) + centre - half,
      gridToScreenY(camera, gy) + centre - half,
      size,
      size,
    )
  }
}

/**
 * Phase 10. Spec §7.2's three persistent elements, laid out by `hudRects` and
 * drawn centred in its rectangles.
 *
 * All three are in the **bottom** band: §7.2 puts the clock at the top and §8.3
 * forbids any interactive element in the top band, and M2 resolves that toward
 * §8.3 because it is a platform fact and §7.2 is a preference.
 *
 * The pause indicator is two bars at the left of the clock rect, drawn only when
 * the frame is paused — the clock doubles as the pause control (§7.2), so its
 * own rect is where its state belongs.
 *
 * **When the bars are up, the clock text is centred in what is LEFT of the rect,
 * not in the whole rect.** The bars occupy `[x + barW, x + 4·barW]`; centring
 * the text on the full rect puts a long clock string straight through them.
 * That is a layout fact, true whatever the glyph widths are, and it is cheaper
 * to reserve the gutter than to discover the collision on a device.
 */
function drawHud(ctx: DrawContext, frame: RenderFrame, palette: Palette): void {
  const rects = hudRects(frame.camera, HUD_SCRATCH)
  const clock = rects.clock
  const barW = clock.h * PAUSE_BAR_FRACTION
  // **`loop.end()` pauses, so a shutdown frame arrives with `paused: true` —
  // and the pause glyph would then be offering "tap the clock to resume" while
  // the clock starts a NEW RUN and throws this city away.** A resume
  // affordance in front of a destructive action is the class of defect this
  // task exists to remove, so the bars come down with the board.
  const showPause = frame.paused && !frame.gameOver
  const gutter = showPause ? PAUSE_GUTTER_BARS * barW : 0

  if (showPause) {
    const barH = clock.h / 2
    const barY = clock.y + clock.h / 4
    ctx.fillStyle = palette.uiText
    ctx.fillRect(clock.x + barW, barY, barW, barH)
    ctx.fillRect(clock.x + 3 * barW, barY, barW, barH)
  }

  ctx.font = HUD_FONT
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = palette.uiText
  fillCentred(ctx, clockText(frame.week, frame.day), clock, gutter)
  fillCentred(ctx, scoreText(frame.score), rects.score, 0)
  fillCentred(ctx, tilesText(frame.tilesLeft), rects.tiles, 0)
}

/**
 * Draws `text` centred in `rect` minus a left `gutter`, **constrained by
 * `maxWidth` so that it cannot leave the rect**.
 *
 * `fillText`'s fourth argument is the whole point of this function, and it
 * closes a claim the first version of this task got wrong. The rendered advance
 * width of a string at `600 20px system-ui` genuinely is not observable here —
 * there is no font engine in this workspace and `system-ui` resolves to
 * different faces on iOS and Android. But **"the label fits its rect" does not
 * need to be measured, it can be made true by construction**: the canvas 2D spec
 * condenses the run to at most `maxWidth`, and with `textAlign = 'center'` the
 * text then occupies exactly `[cx - maxWidth/2, cx + maxWidth/2]`, which is the
 * rect. The argument is recorded, so the guarantee is asserted rather than
 * hoped for, at zero runtime cost and zero allocation.
 *
 * This matters more than it looks. `hudRects` gives `floor((cssW - 32) / 3)`:
 * 124 CSS px on the M0 device, 119 at 390, and **96 at a 320 px viewport**,
 * which `fitCamera` accepts. And the labels are unbounded — `score` and `week`
 * have no ceiling in the sim, so `'N TRIPS'` grows without limit and overflow is
 * a certainty at some value rather than a device-dependent risk. Condensing is a
 * legible failure; overlapping the neighbouring element is not.
 */
function fillCentred(ctx: DrawContext, text: string, rect: Rect, gutter: number): void {
  const width = rect.w - gutter
  ctx.fillText(text, rect.x + gutter + width / 2, rect.y + rect.h / 2, width)
}

/**
 * Is a board position inside the revealed rect? Takes a position, not a cell
 * index, so cars (fractional) and buildings (integral) share one test.
 *
 * Half-open on the far edges, exactly as `screenToGrid` is: a car at
 * `x0 + cols` is the first column of the next, unrevealed cell.
 */
function insideRevealed(camera: Camera, x: number, y: number): boolean {
  return (
    x >= camera.x0 && x < camera.x0 + camera.cols && y >= camera.y0 && y < camera.y0 + camera.rows
  )
}

/**
 * A colour group's preallocated string, with a fallback that is a colour rather
 * than `undefined`.
 *
 * `packDestMeta` validates colour against the full 3-bit range `[0, 7]` while a
 * palette carries at most `MAX_GROUP_COUNT` = 6 groups, so 6 and 7 are
 * representable in sim state and unmapped here. `fillStyle = undefined` is
 * silently ignored by a real context, which leaves the *previous* element's
 * colour on the brush — a house painted in the last car's colour, with nothing
 * to notice. `uiText` is in no group, so a building drawn in it is visibly wrong
 * rather than plausibly wrong.
 */
function groupColour(palette: Palette, index: number): string {
  return palette.groups[index] ?? palette.uiText
}

/**
 * Both atlases must be current, and each must be the layer it is being used as.
 *
 * Three checks, and each catches something no other one does:
 *
 * - **Palette identity, per surface.** See `assertAtlasPalette`. Checked on the
 *   ghost too, because it bakes `palette.road` exactly as the road atlas does —
 *   a rebuild that refreshes one and not the other is the whole new hazard M1d
 *   Task 8 introduced, and a guard on half of it would report clean for it.
 * - **Variant.** Nothing else can see a swapped pair: the two atlases have the
 *   same size, grid, tile count and palette, so `{ road: ghost, ghost: road }`
 *   type-checks, builds, draws, and renders every live road as a faded hairline.
 *   `buildAtlases` cannot produce that pair — but `Atlases` is a plain
 *   interface, `main.ts` could construct one by hand, and every test in
 *   `render` does.
 * - **Tile size.** The two are rebuilt together by `buildAtlases`; a differing
 *   `tileDevicePx` means somebody rebuilt one of them alone, which is the
 *   palette hazard's twin and the only symptom would be a resampled ghost layer.
 *
 * Four reference comparisons and two number comparisons per frame, allocating
 * only on the failing path.
 */
function assertAtlases(atlases: Atlases, palette: Palette): void {
  assertAtlasPalette(atlases.road, palette, 'road')
  assertAtlasPalette(atlases.ghost, palette, 'ghost')
  if (
    atlases.road.variant !== AtlasVariant.ROAD ||
    atlases.ghost.variant !== AtlasVariant.GHOST
  ) {
    throw new Error(
      'drawFrame: the two atlases are the wrong way round — `atlases.road` must be built with ' +
        'AtlasVariant.ROAD and `atlases.ghost` with AtlasVariant.GHOST. Swapped, every live road ' +
        'draws as a thin faded ghost and every ghost draws as a solid road, which reads as an art ' +
        'regression rather than as a wiring error. Use buildAtlases, which cannot produce this pair',
    )
  }
  if (atlases.road.tileDevicePx !== atlases.ghost.tileDevicePx) {
    throw new Error(
      `drawFrame: the road atlas is built for a ${atlases.road.tileDevicePx} px tile and the ghost ` +
        `atlas for a ${atlases.ghost.tileDevicePx} px one, so one of them was rebuilt without the ` +
        'other. Both are rasterised at a fixed tile size and the shell rebuilds on every tile-size ' +
        'change; rebuild them together with buildAtlases',
    )
  }
}

/**
 * The atlas and the palette must be the same object, and this is the loud half
 * of plan Task 5's inherited hazard.
 *
 * **Identity, not structural equality**, and that is deliberate: `PALETTE` is
 * frozen and preallocated, so a caller holding a different object either rebuilt
 * the theme — in which case the atlas is genuinely stale — or is allocating a
 * palette per frame, which the same Global Constraint forbids. Both want to be
 * loud.
 *
 * `which` is the literal union `'road' | 'ghost'` and not `string`: the only
 * job this parameter has is to send the reader to the right rebuild, and a
 * mislabelled call — `'ghost'` passed for the road atlas — would produce a
 * confident, precise, wrong message that no test would ever read. A `string`
 * cannot refuse that; the union does, at compile time.
 *
 * **Why a throw rather than a comment**, which was the option the plan also
 * offered. The failure it prevents is silent, permanent and misattributed: roads
 * in the previous theme, everything else correct, presenting as a rendering bug
 * in a milestone where nobody is looking for a cache. A comment discharges the
 * obligation without checking anything — the catalogue's own entry on
 * overstated comments — and Task 4 put `Atlas.palette` on the type specifically
 * so this check could exist. It costs one reference comparison per frame and
 * allocates only on the failing path.
 *
 * **Why throwing inside the frame loop is acceptable here, when `fitCamera`
 * chose to clamp instead.** `fitCamera`'s degenerate viewport is a transient a
 * rotation produces and the next event resolves; a palette mismatch is a static
 * wiring error that is true on frame 1 and every frame after, so failing fast in
 * development is the only outcome that differs from shipping the bug.
 */
function assertAtlasPalette(atlas: Atlas, palette: Palette, which: 'road' | 'ghost'): void {
  if (atlas.palette !== palette) {
    throw new Error(
      `drawFrame: the ${which} atlas was baked with a different palette than this frame is being ` +
        'drawn in. The atlas rasterises its road colour at build time and a blit cannot re-tint ' +
        'its source, so the roads would keep the old theme while everything else changed — ' +
        'rebuild the atlas with the new palette instead of passing it here. If both palettes ' +
        'LOOK identical, the cause is two resolved copies of @laneways/render (a duplicated ' +
        'dependency, a stale build output on the import path), each with its own frozen PALETTE ' +
        'object — rebuilding the atlas will not help and the module graph is what to fix',
    )
  }
}

/**
 * Compile-time pin: a real `CanvasRenderingContext2D` satisfies `DrawContext`.
 *
 * The `Assert<T extends true>` wrapper is load-bearing for the reason Task 4
 * recorded — `type X = A extends B ? true : never` pins nothing, because `never`
 * is a perfectly good type and `tsc` stays silent. This one has already earned
 * its keep: with `drawImage`'s image parameter typed as `AtlasSurface` alone it
 * fails with `TS2344: Type 'false' does not satisfy the constraint 'true'`,
 * which is how `DrawImageSource` came to be a union.
 */
type Assert<T extends true> = T
export type _RealContextIsADrawContext = Assert<
  CanvasRenderingContext2D extends DrawContext ? true : false
>
