import type { Palette } from './types'

/**
 * The theme object, frozen. Spec §7.1's `{ background, land, water, mountain,
 * road, roadEdge, shadow, uiText, groups[5..6] }` with `tree` **added** (§7.1's
 * list omits it while §5.1 makes tree one of the four terrains) and `shadow`
 * **removed** (plan Decision 7: M2 draws no shadows of any kind — a full-canvas
 * shadow layer costs twice what the road bake M0 deleted did, and even bounded
 * to the grid rect it is three times M2's entire road layer).
 *
 * **This palette is a placeholder and the plan says so** ("M2 ships legible
 * pastels and a `Palette` object to replace"). Art direction is a separate
 * exercise, and spec §7.4's colour-accessibility work — running every palette
 * through deuteranopia and protanopia simulators as a build step — is **not in
 * M2**. What is here is the weaker property M2 can honestly hold: the six group
 * colours are separated on **lightness as well as hue** (§7.4's first bullet),
 * on a solved WCAG-relative-luminance ladder of roughly 0.09 / 0.15 / 0.24 /
 * 0.35 / 0.48 / 0.66 with no adjacent pair closer than 0.06. That is what stops
 * a placeholder from shipping two groups a protanope sees as one colour, and it
 * is not a claim of §7.4 compliance.
 *
 * Every value is a **preallocated string**. `ctx.fillStyle = '#' + something`
 * allocates a string inside the frame loop, which the plan's Global Constraints
 * forbid — the same rule as the tick, for the same reason.
 *
 * `Object.freeze` on the object AND on the `groups` array: `readonly` in
 * TypeScript is a property-level, compile-time claim with no runtime effect,
 * and this object is exported into two packages.
 */
export const PALETTE: Palette = Object.freeze({
  /** The letterbox outside the grid rect, and the top band. */
  background: '#d9d3c7',
  land: '#f2ece1',
  water: '#a8cbe0',
  mountain: '#9a9287',
  tree: '#8fb47a',
  road: '#4a4a52',
  roadEdge: '#33333a',
  uiText: '#2e2b28',
  /**
   * The overcrowd ring. Deliberately outside the board's pastel range and
   * outside every colour group — a destination's meter filling is the only
   * warning the game gives, and a ring in a group colour reads as decoration
   * belonging to that group. Checked distinct from all fourteen other entries
   * by `interface.test.ts`.
   */
  overcrowd: '#e8412e',
  /**
   * The shutdown scrim: `uiText` at alpha `0xd8` (84.7 %). **Eight hex digits,
   * and the only entry in this palette with alpha.**
   *
   * `#rrggbbaa` rather than `rgba(...)` because it is still one preallocated
   * string with no parse-time concatenation, and it is CSS Color 4 — supported
   * by every Safari and Chrome version a Telegram Mini App can run on.
   *
   * Translucent rather than opaque so the frozen board and the ring that
   * killed it stay visible underneath: the screen has to answer *which
   * destination*, and pointing at it is stronger than naming it. It is the same
   * two colours `index.html` and `BOOT_FAILURE_STYLE` invert against each
   * other, so the shutdown text draws in `land` over this and lands at ~10:1.
   *
   * **This is the one place the canvas is painted twice**, and plan Decision
   * 4's "cover every pixel exactly once" is not violated by it: the five opaque
   * fills still partition the canvas each frame, so nothing ghosts, and the
   * extra source-over pass only ever runs on a frame where the sim is frozen
   * and there is no tick budget to compete with.
   */
  scrim: '#2e2b28d8',
  /**
   * §5.10's card face (M1f Task 8). Warmer and lighter than `land`, and
   * DISTINCT from it deliberately: a card is held in front of the board, not
   * cut out of it, and two entries that happen to be equal today cannot be
   * rethemed apart tomorrow. `interface.test.ts` checks every entry is distinct
   * from every other, which is what keeps that a rule rather than a preference.
   *
   * Contrast, computed rather than eyeballed — WCAG relative luminance, the same
   * ladder `groups` is separated on, `(Yl + 0.05) / (Yd + 0.05)` over
   * sRGB-linearised channels:
   *
   * ```
   *   cardFace   #fbf7ef   Y = 0.93264
   *   cardText   #1f1c1a   Y = 0.01197   ->  15.86 : 1  on the face
   *   cardAccent #1f6f6b   Y = 0.12722   ->   5.54 : 1  on the face
   * ```
   *
   * Both clear §7.4's AA bar (4.5:1 for body text) at the sizes this modal draws
   * at, on the one screen in the game that asks the player a question. **The
   * figures read 15.2 and 5.6 until the Task 8 fix round measured them**, which
   * is the wrong direction for the accent by 0.06 — "computed rather than
   * eyeballed" is a claim that has to survive someone recomputing it.
   */
  cardFace: '#fbf7ef',
  /** The card's NAME. Near-black, 15.2:1 on `cardFace`. See `cardFace`. */
  cardText: '#1f1c1a',
  /**
   * The grant lines on a card, and the peek pill's fill. A deep teal, which is
   * in no colour group and is not `overcrowd`: the modal is not an alarm and
   * must not borrow the one colour that is. 5.6:1 on `cardFace` in both
   * directions — as ink on a card, and as a fill under `cardFace` text.
   */
  cardAccent: '#1f6f6b',
  /**
   * Six, because spec §4.2's enumeration makes the group count per-map and
   * either 5 or 6 (`MAX_GROUP_COUNT` in `shared`). A palette of five hands
   * `undefined` to `fillStyle` on a six-group map, which paints black.
   */
  groups: Object.freeze([
    '#953328', // deep red
    '#9251b8', // purple
    '#378dd0', // blue
    '#49b466', // green
    '#ebaa72', // peach
    '#f0d363', // yellow
  ]),
})
