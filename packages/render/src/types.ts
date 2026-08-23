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
 * which `game` reads and passes in here. **M1f owns making it dynamic** —
 * repointed at the close of M1d and again at the close of M1e, both of which
 * declined the work; when it does, `game` reads state instead of the constants
 * and nothing in `render` moves. Note that `sim`'s spawner reads the same four
 * constants as of M1e, so the change has two readers now, not one.
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
 * a substitution, not §7.2 compliance. **Half satisfied by M1e, and the halves
 * are worth separating**: there IS now something to spend, because §5.10's
 * weekly tile grant lands `WEEKLY_TILE_GRANT` tiles at every week boundary and
 * this readout is where the player watches it arrive. There is still no
 * INVENTORY — no bridge, tunnel, roundabout, traffic light or motorway to hold
 * — because every one of those is an item card and the card modal is M1f's. So
 * the chip row stays deferred and this readout stops being a stand-in for
 * nothing.
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
  /**
   * The overcrowd ring's stroke (M1e Task 9). In no colour group and unlike
   * every terrain and furniture entry, because it is an alarm: a ring drawn in
   * a colour the board already uses reads as art.
   */
  readonly overcrowd: string
  /**
   * The shutdown scrim (M1e Task 9). **The one entry in this palette that
   * carries alpha**, as `#rrggbbaa` — it dims the frozen board rather than
   * replacing it, so the player can still see the city they lost and the ring
   * that killed it. `interface.test.ts` pins that it is the only one.
   */
  readonly scrim: string
  /**
   * §5.10's card face — the two rectangles the offer modal draws over the
   * scrim, and the only opaque surface in this palette that is not a piece of
   * the board (M1f Task 8).
   *
   * Its own entry rather than `land` reused, because the two are answering
   * different questions: `land` is what the ground is, and a card is a thing
   * held in front of the ground. Reusing `land` would make the two impossible
   * to retheme apart, and the modal's contrast requirement is against the
   * SCRIM rather than against the sky.
   *
   * It doubles as the peek pill's LABEL colour, which is the same relationship
   * inverted — the pill is a small card turned inside out.
   */
  readonly cardFace: string
  /** The card's name, drawn on `cardFace`. Near-black; ~15:1 against the face. */
  readonly cardText: string
  /**
   * The grant lines (`30 TILES`, `x2`) on a card face, and the peek pill's
   * FILL. One entry with two users, and they are the same idea: the part of the
   * modal that is not the name is what the card is worth and how to get out of
   * it, and both are the accent against the face.
   */
  readonly cardAccent: string
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
  /**
   * Board-indexed 8-bit neighbour masks of **ghost** road — spec §5.11's
   * deferred refund, the raw `state.ghostMask` view (M1d Task 8).
   *
   * A mask, not a boolean, and the reason is mechanical: the ghost layer is
   * blitted from a 256-tile atlas indexed by exactly this byte, mask 0 is the
   * blank tile, and a ghost cell is by definition one whose LIVE mask reached 0.
   * A boolean would have nothing to index with.
   *
   * **`roads[c]` and `ghosts[c]` are never both non-zero**, by construction in
   * `sim`: a cell becomes a ghost only when an erase takes its last road bit,
   * and placing a road over a ghost pays the refund and clears the mask. So the
   * two layers never paint the same cell, and `canvas.ts` fixes their order for
   * safety rather than for appearance — see there.
   *
   * In production this byte holds 0 or a SINGLE set bit (the one bit the erase
   * removed), so a ghosted segment shows as two half-spokes, one per endpoint,
   * meeting on the edge they share. `render` does not rely on that: it blits
   * whatever mask it is given.
   */
  readonly ghosts: Uint8Array
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
  /**
   * Per destination, `0..255`, the overcrowd meter scaled against §5.8's FULL
   * 90 s rather than the 88 s at which the run ends — so a full ring is
   * unreachable and the spec's 2 s "hidden grace" is what the player does not
   * see. `render` never learns the milli-tick figures; `game` folds them.
   *
   * **What a filling ring MEANS is not "this destination is busy" — and it is
   * not the two-state gauge an earlier version of this comment described
   * either.** The meter integrates while a destination is over its pin capacity
   * and unwinds at 2,000 milli-ticks a tick while it is not, so *in principle* a
   * served destination's ring rises and falls while a starved one only rises.
   *
   * **Measured on both shipped boards, a player never sees the falling half.**
   * The destination that ends the run has **zero draining frames** on the demo
   * board and on the starting city; the only demo ring that drains at all peaks
   * at 19/255 — 27 degrees of arc — inside the last 25 s of a 223 s run. So on
   * the boards that ship, a ring means one thing: *this destination is not being
   * served, and it is what will end the run.* That is a stronger signal than the
   * two-state reading, not a weaker one — it is simply not the reading the
   * comment used to claim. `integration.test.ts`'s ring-timing case pins the
   * zero-drain measurement so the claim has an observer.
   */
  readonly destOvercrowd: Uint8Array
  /**
   * Per destination, `1` iff a car can actually DRIVE to it, `0` otherwise —
   * `game`'s fold, dense over `[0, destCount)`.
   *
   * **This byte replaced a road-bit test, because a road bit is not an answer
   * to the question the bay's colour asks.** M1e Task 9 painted the bay red
   * when `roads[carpark] === 0` and documented at the call site that the
   * predicate was *necessary and not sufficient*. The first person to play the
   * shipped build broke it inside a minute: *"the red dot turns black when i
   * start drawing a road from it and when i remove it turns red again."* One
   * tile on the bay, connected to nothing, and the game said the destination
   * was fine.
   *
   * **What `game` computes, and it is exactly what `sim` can serve.**
   * `assembleSources` (dispatch.ts) seeds a colour's flow field from carparks
   * that carry a road bit; `computeFlowField` relaxes over the road graph;
   * `dispatch` reads `dist[houseCell]` and refuses an `INF`. So a destination
   * takes an arrival iff its carpark carries a road bit AND some house of its
   * own colour sits in the same road component. That is the fold, and
   * `game/frame.ts` owns it.
   *
   * **One-sided, and the direction matters.** Every bay that was red under the
   * old test is still red: a bare carpark is never a field source, so it is
   * unreachable by construction. The fix widens the red arm only — it never
   * paints a working destination red.
   *
   * **What it still does not say**, written here rather than at the draw site
   * so the field carries its own limits: it is topological, so it says nothing
   * about a destination that is connected and starved (the ring carries that),
   * nothing about gridlock, nothing about a route longer than `MAX_PATH_LEN`,
   * and nothing about whether any car is free to be sent. It ignores pins
   * entirely, on purpose — pins are demand, and folding them in is how the
   * predicate it replaced ended up meaning two things at once.
   *
   * A grey bay is still not a promise. A red one is still a fact, and now it is
   * the right fact.
   */
  readonly destReachable: Uint8Array
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
  /**
   * True once a destination's timer completed (§5.8). The board behind the
   * scrim is frozen — `sim`'s `step` is a byte-identical no-op past the
   * failure and the loop stops draining — but the draw path keeps running at
   * display rate, which is what lets a shutdown screen exist at all.
   */
  readonly gameOver: boolean
  /** The destination that ended the run, or -1 while it is live. */
  readonly failedDest: number
  /**
   * True while §5.10's weekly card offer is waiting to be taken — M1f Task 7.
   *
   * **The board behind it is frozen and the freeze is the SHELL's, not the
   * sim's.** `game`'s frame driver pauses the loop on every tick this holds;
   * `sim` has no notion of pause and never will, because a replay has to reach
   * the same bytes whether or not a player stopped to read a modal.
   *
   * It is folded from `sim`'s own `offerPending`, so it goes false the tick the
   * week is resolved even though the two card ids below are still sitting in the
   * header — see `offerA`.
   */
  /**
   * ---------------------------------------------------------------------------
   * **IT IS TRUE AT THE SAME TIME AS `gameOver`, PERMANENTLY, AND A DRAW PATH
   * THAT ASSUMES OTHERWISE PAINTS TWO THINGS AT ONCE.**
   * ---------------------------------------------------------------------------
   *
   * `step` is a byte-identical no-op past a shutdown, so `H_OFFER_WEEK` can never
   * catch up to `H_WEEK` and this field stays TRUE for the rest of the process on
   * any board that died after its first week boundary. Measured on the demo board
   * warm-started to `DEMO_DEATH_TICK`: `gameOver` true, `offerPending` true,
   * `offerA` 1, `offerB` 7, on that frame and on every frame after it.
   *
   * **So the two are NOT mutually exclusive and the exclusion has to be drawn
   * rather than assumed.** `canvas.ts` gates the shutdown scrim and the offer
   * modal against each other for exactly this reason; the reachability argument
   * in the other direction — *"a dead board cannot have an offer up"* — is false,
   * and M1f Task 8 shipped two scrims a frame before an existing rig caught it.
   */
  readonly offerPending: boolean
  /**
   * The card id in slot A, or `0` (no card) when nothing is pending.
   *
   * **A plain number, because `render` imports nothing from `sim`** — the ids
   * are §5.10's and `sim`'s `cards.ts` is their only declaration. `0` is
   * `CARD_NONE` and is unreachable as an offered card.
   *
   * **It reads 0 on a resolved week even though the header does not.**
   * `applyChooseCard` deliberately leaves `H_OFFER_A`/`H_OFFER_B` holding the
   * real cards, so `game`'s fold goes through `offerSlot`, which is the one
   * guard between a resolved week and a modal showing last week's card for the
   * rest of the run.
   */
  readonly offerA: number
  /** The card id in slot B. Always a different card from `offerA` while pending. */
  readonly offerB: number
  /**
   * The tile bonus slot A's card pays, as a NUMBER — M1f Task 8.
   *
   * **The whole reason this is a frame field rather than a literal in
   * `canvas.ts`** (plan Decision 17, review finding I6): the modal shows the
   * player "30 TILES", and 30 is `CARD_GRANT_ROAD_TILES` in `shared`. A string
   * literal in the renderer keeps saying 30 after the constant becomes 40, with
   * every test in both packages still green — a UI lying about a rule, with no
   * observer anywhere. `game` folds `cardTileGrant(offerA)` in here and
   * `canvas.ts` formats it.
   *
   * `0` when nothing is pending, which is unreachable as a real grant: both
   * offerable cards pay a positive number of tiles.
   */
  readonly offerGrantA: number
  /** Slot B's tile bonus. See `offerGrantA`. */
  readonly offerGrantB: number
  /**
   * How many ITEMS slot A's card grants — `0` for the road-tiles card, and
   * `UPGRADES_PER_CARD` for the junction upgrade. Drawn only when positive, so
   * a tiles card shows no count rather than an `x0`.
   *
   * Same reasoning as `offerGrantA`: `UPGRADES_PER_CARD`'s own doc comment in
   * `shared` names this field as its reader, and until M1f Task 8 that sentence
   * named a field that did not exist.
   */
  readonly offerItemsA: number
  /** Slot B's item count. See `offerItemsA`. */
  readonly offerItemsB: number
  /**
   * True while the player is holding the modal out of the way to look at the
   * frozen board underneath (spec §5.10's peek, plan Decision 16).
   *
   * **Peek is UI and not simulation**, so it is owned by `pointer.ts` beside
   * `eraseMode` and reaches the renderer through this field. Putting it in the
   * state buffer would make a cosmetic toggle a replay input.
   *
   * **It hides the modal; it does not resume the sim.** The loop stays paused
   * and board input stays refused, so peeking is not a free unpause — the one
   * thing a modal with no timer and no skip must not offer. It only ever
   * matters while `offerPending`; `canvas.ts` reads it inside that gate.
   */
  readonly offerPeek: boolean
}

/**
 * The three tappable rectangles §5.10's offer modal puts on screen, in CSS px.
 * Laid out by `offerRects` (camera.ts) and hit-tested by `game/pointer.ts`
 * against **the same function the renderer draws from**, which is what stops the
 * faces and the hit test drifting apart.
 *
 * Mutable rects, reused across frames, exactly like `HudRects` — a modal is
 * drawn every frame it is up, and a fresh object per frame is an allocation in
 * the frame loop.
 */
export interface OfferRects {
  /** The card in slot A, drawn above slot B. */
  readonly cardA: Rect
  /** The card in slot B. */
  readonly cardB: Rect
  /**
   * The peek control. Below both cards, so a thumb reaching for it cannot
   * clip a card face — and outside both, which `camera.test.ts` asserts at
   * every viewport rather than at the one this was laid out on.
   */
  readonly peek: Rect
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
