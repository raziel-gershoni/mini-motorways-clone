/**
 * Task 1 stub. `game`'s real wiring (starting city, the accumulator loop,
 * pointer input, the Telegram boot sequence, `main.ts`) lands in later M2
 * tasks — see the plan's File structure table. `game` depends on
 * `@laneways/sim`, `@laneways/shared` and `@laneways/render` (declared in
 * package.json); the dependency direction is one-way — nothing in `sim` or
 * `render` ever imports from `game`.
 */
export {}

/**
 * M11: makes `packages/game/tsconfig.json`'s `"lib": ["ES2022", "DOM",
 * "DOM.Iterable"]` override load-bearing from Task 1 onward, rather than
 * trusting a later task to rediscover a dropped override. `document` is a
 * DOM-only global (the brief: "game needs document, performance, pointer
 * events and globalThis.innerHeight"); `typeof document` is a type-only
 * reference and needs no import. Dropping the `lib` override fails
 * `tsc --noEmit` here with "Cannot find name 'document'".
 */
export type _RequiresDomLib = typeof document
