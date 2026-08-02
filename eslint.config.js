import tseslint from 'typescript-eslint'
import determinismRules from './tools/eslint-rules/index.js'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'spike/**'] },
  {
    // Both packages are inside the determinism boundary: spec §4 makes
    // `shared` the sim's sole dependency, so an unseeded draw or a wall-clock
    // read there reaches a replay exactly as directly as one in the sim.
    //
    // Three mechanisms enforce determinism here, deliberately overlapping
    // rather than deferring to one another:
    //   - `no-restricted-globals` / `no-restricted-properties` /
    //     `no-restricted-syntax` below are name-based: they catch bracket
    //     access (`Math['random']()`) and destructuring
    //     (`const { random } = Math`), but not variable aliasing.
    //   - `determinism/*` (tools/eslint-rules) is AST-based: it catches that
    //     aliasing (`const m = Math; m.random()`), module-scope mutable
    //     state, and Map/Set/object-key iteration — none of which is
    //     expressible as a banned name or property.
    //   - The regex scan in `packages/sim/test/determinism.test.ts` catches
    //     float literals, `new Date`, bare `.sort()`, and bare
    //     `globalThis`/`window`/`self`/`document`; it runs in CI with the
    //     rest of the suite, and, being a plain text scan rather than an
    //     ESLint rule, cannot be silenced by an inline `eslint-disable`.
    // Each covers a blind spot the other two do not.
    files: ['packages/sim/src/**/*.{ts,mts,cts,js}', 'packages/shared/src/**/*.{ts,mts,cts,js}'],
    extends: [tseslint.configs.recommended],
    plugins: { determinism: determinismRules },
    rules: {
      'determinism/no-module-mutable-state': 'error',
      'determinism/no-aliased-globals': 'error',
      'determinism/no-collection-iteration': 'error',
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'The sim must run in a Worker with no DOM.' },
        { name: 'window', message: 'The sim must run in a Worker with no DOM.' },
        { name: 'globalThis', message: 'No ambient state; everything lives in the state buffer.' },
        { name: 'self', message: 'The sim must run in a Worker with no DOM.' },
        { name: 'performance', message: 'Wall-clock time is not in the state buffer.' },
        { name: 'fetch', message: 'No I/O in the simulation.' },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded rng in state.' },
        { object: 'Math', property: 'sin', message: 'Transcendentals differ across engines.' },
        { object: 'Math', property: 'cos', message: 'Transcendentals differ across engines.' },
        { object: 'Math', property: 'pow', message: 'Transcendentals differ across engines.' },
        { object: 'Math', property: 'exp', message: 'Transcendentals differ across engines.' },
        { object: 'Math', property: 'log', message: 'Transcendentals differ across engines.' },
        { object: 'Date', property: 'now', message: 'Wall-clock time is not in the state buffer.' },
      ],
      // `no-restricted-properties` cannot see a constructor call, so `new Date()`
      // passed ESLint while the source scan caught it. The two mechanisms are
      // meant to overlap, not to cover for one another's blind spots.
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Wall-clock time is not in the state buffer.',
        },
      ],
    },
  },
)
