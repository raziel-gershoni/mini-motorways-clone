/**
 * `render`'s public surface: the interface types, the camera, the palette, the
 * road tile atlas, and `drawFrame` — the whole per-frame draw path.
 *
 * `render` never imports from `@laneways/sim` or `@laneways/shared`; see
 * `test/boundary.test.ts`, which scans this package's sources for both the bare
 * workspace specifier and the relative escape that `tsc` alone would accept.
 */
export * from './types'
export * from './camera'
export * from './palette'
export * from './atlas'
export * from './canvas'
