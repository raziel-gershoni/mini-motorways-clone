/**
 * `render`'s public surface. The atlas (Task 4) and `drawFrame` (Task 5) land
 * here in later M2 tasks — see the plan's File structure table.
 *
 * `render` never imports from `@laneways/sim` or `@laneways/shared`; see
 * `test/boundary.test.ts`, which scans this package's sources for both the bare
 * workspace specifier and the relative escape that `tsc` alone would accept.
 */
export * from './types'
export * from './camera'
export * from './palette'
