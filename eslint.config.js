import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'spike/**'] },
  {
    // Both packages are inside the determinism boundary: spec §4 makes
    // `shared` the sim's sole dependency, so an unseeded draw or a wall-clock
    // read there reaches a replay exactly as directly as one in the sim.
    files: ['packages/sim/src/**/*.{ts,mts,cts,js}', 'packages/shared/src/**/*.{ts,mts,cts,js}'],
    extends: [tseslint.configs.recommended],
    rules: {
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
