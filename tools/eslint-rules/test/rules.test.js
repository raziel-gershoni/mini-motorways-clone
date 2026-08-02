import { describe, it } from 'vitest'
import { RuleTester } from 'eslint'
import { parser } from 'typescript-eslint'
import plugin from '../index.js'

// ESLint's RuleTester defaults to Mocha-style globals (`describe`/`it`); vitest
// provides its own, so it is wired in explicitly here rather than relying on
// vitest's `globals: true` mode (which this repo does not enable anywhere
// else). This is also the reason this file's tests only actually run if
// `tools/eslint-rules` is executed by `pnpm test` — see the workspace/root
// package.json wiring, which is exactly the gap Step 7 exists to close.
RuleTester.describe = describe
RuleTester.it = it

const languageOptions = { parser, sourceType: 'module', ecmaVersion: 2022 }

const ruleTester = new RuleTester()

ruleTester.run('no-module-mutable-state', plugin.rules['no-module-mutable-state'], {
  valid: [
    // Brief's literal table cases.
    { code: 'Object.freeze([0,1,1,1,0,-1,-1,-1] as const)', languageOptions },
    { code: 'Object.freeze({ LAND: 0 } as const)', languageOptions },
    { code: 'export const DENOM = 1000', languageOptions },
    { code: 'const x = Math.imul(a, b)', languageOptions },
    { code: 'function f() { let i = 0; const a = new Uint8Array(4) }', languageOptions },

    // Realistic usage the brief's own rationale demands stay legal: Task 2/3
    // write exactly this shape for DX/DY/TERRAIN/OPPOSITE and the map rows. A
    // rule that reports these would make Task 3 unimplementable.
    { code: 'export const DX = Object.freeze([0, 1, 1, 1, 0, -1, -1, -1] as const)', languageOptions },
    { code: 'export const TERRAIN = Object.freeze({ LAND: 0, WATER: 1 } as const)', languageOptions },
    // Freeze is shallow; a table of frozen rows must freeze each row too, and
    // this must NOT be reported when every level actually is frozen.
    {
      code: 'export const ROWS = Object.freeze([Object.freeze([0, 1]), Object.freeze([1, 0])])',
      languageOptions,
    },
    // The exact pattern this task's own state.ts uses for its region table.
    {
      code: "const REGIONS = Object.freeze([Object.freeze({ name: 'rng', len: 1 }), Object.freeze({ name: 'header', len: 3 })])",
      languageOptions,
    },
    // computeLayout's own `Set` used only through has/add — function-scoped,
    // so module-scope mutable-state rules do not apply regardless.
    {
      code: 'function computeLayout(regions) { const seen = new Set(); for (const r of regions) { seen.add(r.name) } return seen }',
      languageOptions,
    },
    // A plain function declaration at module scope is not a variable
    // declaration at all.
    { code: 'export function step(s, inputs) { return s }', languageOptions },
  ],
  invalid: [
    { code: 'const DX = [0,1]', languageOptions, errors: [{ messageId: 'unfrozenLiteral' }] },
    { code: 'const DX = [0,1] as const', languageOptions, errors: [{ messageId: 'unfrozenLiteral' }] },
    { code: 'const T = { LAND: 0 }', languageOptions, errors: [{ messageId: 'unfrozenLiteral' }] },
    { code: 'let x = 0', languageOptions, errors: [{ messageId: 'letOrVar' }] },
    { code: 'var y', languageOptions, errors: [{ messageId: 'letOrVar' }] },
    { code: 'export let c = 0', languageOptions, errors: [{ messageId: 'letOrVar' }] },
    { code: 'const m = new Map()', languageOptions, errors: [{ messageId: 'mutableContainer' }] },
    {
      code: 'export const buf =\n  new Uint8Array(4)',
      languageOptions,
      errors: [{ messageId: 'mutableContainer' }],
    },
    { code: '  let s = 0', languageOptions, errors: [{ messageId: 'letOrVar' }] },
    // Object.freeze is shallow: the inner arrays are each their own
    // unfrozen literal and must each be reported (two errors, not one).
    // The brief's table gives this as a bare `Object.freeze([[1],[2]])`,
    // but the rule (by its own written bullet) only inspects `const`
    // initialisers, so it is wrapped in a declaration here to be
    // reachable at all — see the task report for this discrepancy.
    {
      code: 'const x = Object.freeze([[1],[2]])',
      languageOptions,
      errors: [{ messageId: 'unfrozenLiteral' }, { messageId: 'unfrozenLiteral' }],
    },
    // Extra: a Map/Set/TypedArray constructed at module scope but never
    // reached by the freeze-carve-out logic at all, since it is not a
    // literal — this is bullet 2, not bullet 3.
    { code: 'const cache = new WeakMap()', languageOptions, errors: [{ messageId: 'mutableContainer' }] },
    { code: 'const scratch = new ArrayBuffer(64)', languageOptions, errors: [{ messageId: 'mutableContainer' }] },
  ],
})

ruleTester.run('no-aliased-globals', plugin.rules['no-aliased-globals'], {
  valid: [
    { code: 'Math.imul(a, b)', languageOptions },
    { code: 'Math.min(a, b)', languageOptions },
    { code: 'const x = 1', languageOptions },
    // Bracket access is not aliasing — it stays the job of
    // no-restricted-properties, which this AST rule does not duplicate.
    { code: "Math['random']()", languageOptions },
  ],
  invalid: [
    { code: 'const m = Math', languageOptions, errors: [{ messageId: 'aliasedGlobal' }] },
    { code: 'let d = Date', languageOptions, errors: [{ messageId: 'aliasedGlobal' }] },
    { code: 'const p = performance', languageOptions, errors: [{ messageId: 'aliasedGlobal' }] },
    { code: 'const g = globalThis', languageOptions, errors: [{ messageId: 'aliasedGlobal' }] },
    { code: 'f(Math)', languageOptions, errors: [{ messageId: 'aliasedGlobal' }] },
    { code: 'const { ...rest } = Math', languageOptions, errors: [{ messageId: 'aliasedGlobal' }] },
    { code: 'const arr = [Math]', languageOptions, errors: [{ messageId: 'aliasedGlobal' }] },
    { code: 'const obj = { m: Math }', languageOptions, errors: [{ messageId: 'aliasedGlobal' }] },
  ],
})

ruleTester.run('no-collection-iteration', plugin.rules['no-collection-iteration'], {
  valid: [
    { code: 's.has(x)', languageOptions },
    { code: 's.add(x)', languageOptions },
    { code: 'm.get(k)', languageOptions },
    { code: 'm.set(k, v)', languageOptions },
    { code: 'm.delete(k)', languageOptions },
    { code: 'for (const c of arr) { f(c) }', languageOptions },
    // From layout.ts's own `{ ...r, offset }` — spread, not iteration.
    { code: 'const o = { ...r, offset }', languageOptions },
  ],
  invalid: [
    { code: 'Object.keys(o)', languageOptions, errors: [{ messageId: 'noEnumeration' }] },
    { code: 'Object.entries(o)', languageOptions, errors: [{ messageId: 'noEnumeration' }] },
    { code: 'Object.values(o)', languageOptions, errors: [{ messageId: 'noEnumeration' }] },
    { code: 'Object.getOwnPropertyNames(o)', languageOptions, errors: [{ messageId: 'noEnumeration' }] },
    { code: 'for (const k in o) {}', languageOptions, errors: [{ messageId: 'noForIn' }] },
    {
      code: 'for (const [k, v] of m.entries()) {}',
      languageOptions,
      errors: [{ messageId: 'noIteratorMethod' }],
    },
    {
      code: 'for (const v of s.values()) {}',
      languageOptions,
      errors: [{ messageId: 'noIteratorMethod' }],
    },
  ],
})
