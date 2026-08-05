/**
 * `RenderFrame`, `Camera`, `Palette`, `TerrainClass` land here in a later M2
 * task (plan Decision 3 / File structure table). This file has no imports at
 * all, by design: `render`'s own interface types are the only thing it
 * depends on (spec §4).
 *
 * This is a Task 1 stub — it exists so the package has a real source file to
 * lint, typecheck, and scan from the start, rather than those checks being
 * discovered empty and declared "fine" by omission.
 */
export {}

/**
 * M11: makes `packages/render/tsconfig.json`'s `"lib": ["ES2022", "DOM",
 * "DOM.Iterable"]` override load-bearing from Task 1 onward, rather than
 * trusting Task 3 (the first task that actually uses `CanvasRenderingContext2D`)
 * to rediscover a dropped override. `CanvasRenderingContext2D` is a DOM-only
 * global type; a global-scope type reference needs no import. Dropping the
 * `lib` override fails `tsc --noEmit` here with "Cannot find name
 * 'CanvasRenderingContext2D'", rather than silently passing until Task 3.
 */
export type _RequiresDomLib = CanvasRenderingContext2D
