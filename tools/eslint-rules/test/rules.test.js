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
    // NOTE: the brief's literal table gave two of these as bare
    // `Object.freeze(...)` expression statements with no `const x = `
    // wrapper. As bare expression statements they are not `VariableDeclaration`
    // nodes at all, so the rule (by its own written bullet, "a const whose
    // initialiser...") never inspects them — they would pass even with the
    // freeze carve-out deleted entirely, which was proved by mutation and is
    // exactly the "test that cannot fail" this project watches for. Deleted
    // rather than fixed in place, since the realistic wrapped forms two lines
    // down already carry the real coverage — see the task report.
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

    // --- static class fields (finding 1: PropertyDefinition was never visited) ---
    // A `readonly` static field holding a primitive is the class-field
    // equivalent of `const N = 30` — not reassignable, nothing to freeze.
    { code: 'class C { static readonly N = 30 }', languageOptions },
    // A `readonly` static field holding a properly (fully) frozen literal.
    { code: 'class C { static readonly ROWS = Object.freeze([1, 2, 3]) }', languageOptions },
    // Instance fields are per-instance — a fresh Map per `new C()` — and
    // explicitly out of scope for a rule about state that outlives an instance.
    { code: 'class C { instance = new Map() }', languageOptions },
    { code: 'class C { rows = [1, 2] }', languageOptions },

    // --- module-scope IIFEs (finding 2) ---
    // An ordinary factory (not immediately invoked) returns a closure with
    // its OWN private counter on every call — `n` never persists at module
    // scope, unlike the reviewer's IIFE example below. Must stay legal, or
    // this fix would ban an ordinary and common closure-factory pattern.
    {
      code: 'export const makeCounter = () => { let n = 0; return () => n++ }',
      languageOptions,
    },
    // A module-scope call to a NAMED function is not an IIFE shape at all
    // (the callee is an Identifier, not a function/arrow expression) — must
    // not be affected by the IIFE-descent logic.
    { code: 'export const value = computeSomething(a, b)', languageOptions },
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

    // --- static class fields (finding 1) ---
    { code: 'class Cache { static instance = new Map() }', languageOptions, errors: [{ messageId: 'mutableContainer' }] },
    {
      code: 'class Foo { static rows = [[1, 2], [3, 4]] }',
      languageOptions,
      // Nothing here is frozen at any level: the outer array and both inner
      // rows are each their own report, exactly mirroring how a module-scope
      // `const` with the same unfrozen shape would be reported three times.
      errors: [{ messageId: 'unfrozenLiteral' }, { messageId: 'unfrozenLiteral' }, { messageId: 'unfrozenLiteral' }],
    },
    {
      code: 'class Counter { static n = 0; static get next() { return Counter.n++ } }',
      languageOptions,
      // Exactly one error: the field itself (no `readonly`), not the getter
      // method — a method is behavior, not state, and PropertyDefinition
      // does not visit it.
      errors: [{ messageId: 'staticMutableField' }],
    },

    // --- module-scope IIFEs (finding 2) ---
    {
      // The reviewer's exact example: `n` is captured by the closure
      // returned from an IIFE bound to a module-scope const, so it persists
      // for the life of the module exactly like an ordinary module-scope
      // `let`. The returned object IS correctly frozen, so this produces
      // exactly one error — the `let`, not the (properly frozen) return value.
      code: [
        'export const counter = (() => {',
        '  let n = 0',
        '  return Object.freeze({ next: () => n++ })',
        '})()',
      ].join('\n'),
      languageOptions,
      errors: [{ messageId: 'letOrVar' }],
    },
    {
      // The IIFE's return value itself is an unfrozen literal — descent
      // into a module-scope IIFE's return path must also apply the literal
      // check, not just the let/var check.
      code: ['export const rows = (() => {', '  return [[1, 2], [3, 4]]', '})()'].join('\n'),
      languageOptions,
      errors: [{ messageId: 'unfrozenLiteral' }, { messageId: 'unfrozenLiteral' }, { messageId: 'unfrozenLiteral' }],
    },
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
    // A plain array is not a banned collection — for...of over one, even
    // one declared right next to the loop, must stay legal.
    { code: 'const arr = [1, 2, 3]; for (const x of arr) {}', languageOptions },
    // Finding 4's documented residual, pinned as a valid case on purpose: a
    // binding this rule cannot trace to its own `new Set/Map(...)` — here, a
    // function parameter — is NOT caught. This is the known gap, not a
    // guarantee of safety; see the rule's own doc comment.
    { code: 'function f(s) { for (const x of s) {} }', languageOptions },
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

    // --- direct for...of over a Set/Map identifier (finding 4) ---
    {
      code: 'const s = new Set(); for (const x of s) {}',
      languageOptions,
      errors: [{ messageId: 'noDirectCollectionIteration' }],
    },
    {
      code: 'const m = new Map(); for (const x of m) {}',
      languageOptions,
      errors: [{ messageId: 'noDirectCollectionIteration' }],
    },
    {
      code: 'const w = new WeakSet(); for (const x of w) {}',
      languageOptions,
      errors: [{ messageId: 'noDirectCollectionIteration' }],
    },
  ],
})
