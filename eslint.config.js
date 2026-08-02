import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'spike/**'] },
  {
    files: ['packages/sim/src/**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'document', message: 'The sim must run in a Worker with no DOM.' },
        { name: 'window', message: 'The sim must run in a Worker with no DOM.' },
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
    },
  },
)
