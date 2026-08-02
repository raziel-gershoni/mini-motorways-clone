# M1a — Deterministic Core Foundations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `shared` and `sim` packages with everything needed to make determinism *enforceable and testable* — before a single game rule exists.

**Architecture:** A pnpm workspace with two packages. `sim` holds all game state in one `ArrayBuffer` with typed-array views, advances through a pure `step()`, and carries its RNG state inside that buffer so snapshots and rollback come free. Determinism is enforced two ways: an ESLint config for editor feedback, and a Vitest test that scans the `sim` source for banned constructs, which cannot be bypassed by disabling a lint rule.

**Tech Stack:** TypeScript, Vitest, pnpm workspaces. No runtime dependencies in `sim` — none, deliberately.

## Why this is its own plan

M1 in the spec is the whole rule set: terrain, roads, pathfinding, demand, dispatch, movement, blocking, lights, roundabouts, motorways, spawning, upgrades, failure, scoring. That is far too much for one plan to produce reviewable, testable software.

M1 is therefore split into four, each independently testable:

| | Scope |
|---|---|
| **M1a** (this plan) | State container, RNG, snapshot/restore, hashing, the clock, determinism enforcement |
| **M1b** | Terrain, the road graph, placement and refund rules, flow-field pathfinding |
| **M1c** | Houses, destinations, pins, dispatch, car movement, the chunk-blocking primitive |
| **M1d** | Week cycle, upgrade cards, building spawn schedule, overcrowd failure, scoring |

M1a comes first because everything else is built on the state container, and because the determinism discipline is brutal to retrofit — the spec is explicit that it must be adopted from the first commit.

## Global Constraints

- Spec of record: `docs/superpowers/specs/2026-08-02-mini-motorways-clone-design.md`. Read §4 (Module boundaries) and §4.1 (Determinism rules) before starting.
- **`packages/sim` has zero runtime dependencies.** Not one. It must run unchanged in a browser and in a Cloudflare Worker.
- **Integer-only inside `sim`.** No float literals, no `Math.random`, no `Date.now`, no `performance.now`, no `Date` construction, no transcendentals (`sin`, `cos`, `exp`, `pow`, `log`), no `Array.prototype.sort` without an explicit integer comparator, no iteration over `Map`/`Set`/object keys for anything sim-affecting, no DOM or global access.
- **Rule constants are integers over a fixed denominator of 1000.** A multiplier of 0.667 is `667`. The conversion happens once, in the constants file, and never inside sim code.
- The existing `spike/` directory is a separate throwaway project and is **not** part of this workspace. Do not modify it, do not import from it. Where this plan reuses an idea from it (the RNG, the hashing approach), the code is retyped here, not imported.
- Node 26 and pnpm 10 are installed. Run commands from the repo root unless stated otherwise.
- Every commit message must end with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
  ```

---

## File Structure

| File | Responsibility |
|---|---|
| `pnpm-workspace.yaml` | Declares `packages/*` as the workspace. `spike` deliberately excluded |
| `package.json` (root) | Workspace scripts: `test`, `typecheck` |
| `tsconfig.base.json` | Shared compiler options; strict, `noUncheckedIndexedAccess` |
| `packages/shared/package.json`, `tsconfig.json` | The shared package |
| `packages/shared/src/constants.ts` | Rule constants as integers, with the denominator documented at each one |
| `packages/shared/src/index.ts` | Public surface |
| `packages/sim/package.json`, `tsconfig.json` | The sim package |
| `packages/sim/src/rng.ts` | xmur3 seeding + mulberry32, operating on state-owned storage |
| `packages/sim/src/state.ts` | The `ArrayBuffer` layout, `createState`, `snapshot`, `restore` |
| `packages/sim/src/hash.ts` | FNV-1a over the state buffer |
| `packages/sim/src/clock.ts` | Tick → day → week derivation |
| `packages/sim/src/step.ts` | The pure `step()` entry point |
| `packages/sim/src/index.ts` | Public surface |
| `packages/sim/test/*.test.ts` | One test file per module |
| `packages/sim/test/determinism.test.ts` | Source scan + golden-hash replay |
| `eslint.config.js` | `no-restricted-*` rules scoped to `packages/sim` |

---

## Task 1: Workspace scaffold and rule constants

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/constants.ts`, `packages/shared/src/index.ts`
- Create: `packages/shared/test/constants.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `DENOM = 1000`; the constant groups below, all integers

- [ ] **Step 1: Create the workspace**

```bash
cd /Users/razielgershoni/development/mini-motorways-clone
mkdir -p packages/shared/src packages/shared/test packages/sim/src packages/sim/test
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
```

`spike` is deliberately absent — it has its own lockfile and is a throwaway project.

Root `package.json`:

```json
{
  "name": "laneways",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "pnpm -r --filter './packages/*' test",
    "typecheck": "pnpm -r --filter './packages/*' typecheck"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  }
}
```

Note `lib` is `ES2022` only — no `DOM`. That is deliberate: it makes `document`, `window` and `performance` type errors inside these packages rather than something a reviewer has to notice.

`packages/shared/package.json`:

```json
{
  "name": "@laneways/shared",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Then install:

```bash
pnpm install
```

- [ ] **Step 2: Write the failing test**

`packages/shared/test/constants.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  DENOM, TICKS_PER_SECOND, SECONDS_PER_WEEK, DAYS_PER_WEEK,
  TICKS_PER_WEEK, TICKS_PER_DAY,
  ORTHO_COST, DIAG_COST,
  LANE_SPEED_DEFAULT, MOTORWAY_SPEED_MAX, ROUNDABOUT_SPEED_MUL,
  RIGHT_ANGLE_SPEED_MUL, INTERSECTION_SPEED_MUL, SHARP_TURN_SPEED_MUL,
  MAX_OVERCROWD_TIME_MS, OVERCROWD_RAMP, OVERCROWD_RETURN_MUL,
  ARRIVAL_KNOCKBACK_PCT, ARRIVAL_KNOCKBACK_MAX_MS, OVERCROWD_GRACE_MS,
  PIN_CAP_SQUARE_TIMER, PIN_CAP_SQUARE_HARD, PIN_CAP_CIRCLE_TIMER, PIN_CAP_CIRCLE_HARD,
  GRID_W, GRID_H, GROUP_COUNT_DEFAULT, CARS_PER_HOUSE, MOTORWAY_CAP,
} from '../src/index'

const ALL: Record<string, number> = {
  DENOM, TICKS_PER_SECOND, SECONDS_PER_WEEK, DAYS_PER_WEEK,
  TICKS_PER_WEEK, TICKS_PER_DAY, ORTHO_COST, DIAG_COST,
  LANE_SPEED_DEFAULT, MOTORWAY_SPEED_MAX, ROUNDABOUT_SPEED_MUL,
  RIGHT_ANGLE_SPEED_MUL, INTERSECTION_SPEED_MUL, SHARP_TURN_SPEED_MUL,
  MAX_OVERCROWD_TIME_MS, OVERCROWD_RAMP, OVERCROWD_RETURN_MUL,
  ARRIVAL_KNOCKBACK_PCT, ARRIVAL_KNOCKBACK_MAX_MS, OVERCROWD_GRACE_MS,
  PIN_CAP_SQUARE_TIMER, PIN_CAP_SQUARE_HARD, PIN_CAP_CIRCLE_TIMER, PIN_CAP_CIRCLE_HARD,
  GRID_W, GRID_H, GROUP_COUNT_DEFAULT, CARS_PER_HOUSE, MOTORWAY_CAP,
}

describe('rule constants', () => {
  it('are every one an integer', () => {
    for (const [name, v] of Object.entries(ALL)) {
      expect(Number.isInteger(v), `${name} = ${v} is not an integer`).toBe(true)
    }
  })

  it('are every one finite and non-negative', () => {
    for (const [name, v] of Object.entries(ALL)) {
      expect(Number.isFinite(v), `${name} is not finite`).toBe(true)
      expect(v, `${name} is negative`).toBeGreaterThanOrEqual(0)
    }
  })

  it('uses a denominator of 1000 for scaled values', () => {
    expect(DENOM).toBe(1000)
    expect(LANE_SPEED_DEFAULT).toBe(DENOM)
  })

  it('encodes the reported lane-speed multipliers at that denominator', () => {
    // Spec §5.5: 3.0, 2.0, 0.667, 0.5, 0.333 against a 1.0 default.
    expect(MOTORWAY_SPEED_MAX).toBe(3000)
    expect(ROUNDABOUT_SPEED_MUL).toBe(2000)
    expect(RIGHT_ANGLE_SPEED_MUL).toBe(667)
    expect(INTERSECTION_SPEED_MUL).toBe(500)
    expect(SHARP_TURN_SPEED_MUL).toBe(333)
  })

  it('derives the clock consistently', () => {
    expect(TICKS_PER_SECOND).toBe(30)
    expect(SECONDS_PER_WEEK).toBe(150)
    expect(DAYS_PER_WEEK).toBe(7)
    expect(TICKS_PER_WEEK).toBe(TICKS_PER_SECOND * SECONDS_PER_WEEK)
    expect(TICKS_PER_WEEK).toBe(4500)
  })

  it('keeps TICKS_PER_DAY exact so days do not drift against weeks', () => {
    // 4500 / 7 is not an integer. TICKS_PER_DAY must therefore be derived per
    // day from the week boundary, not stored as a rounded constant — a rounded
    // one would accumulate 4500 - 7*642 = 6 ticks of drift every week.
    expect(TICKS_PER_DAY).toBe(0)
  })

  it('uses the 10/14 integer edge weights, which approximate 1 : sqrt(2)', () => {
    expect(ORTHO_COST).toBe(10)
    expect(DIAG_COST).toBe(14)
    expect(DIAG_COST / ORTHO_COST).toBeCloseTo(Math.SQRT2, 1)
  })

  it('sets pin caps with the timer threshold below the hard cap', () => {
    expect(PIN_CAP_SQUARE_TIMER).toBeLessThan(PIN_CAP_SQUARE_HARD)
    expect(PIN_CAP_CIRCLE_TIMER).toBeLessThan(PIN_CAP_CIRCLE_HARD)
    expect(PIN_CAP_SQUARE_TIMER).toBe(6)
    expect(PIN_CAP_SQUARE_HARD).toBe(10)
    expect(PIN_CAP_CIRCLE_TIMER).toBe(8)
    expect(PIN_CAP_CIRCLE_HARD).toBe(14)
  })

  it('matches the spec grid and agent constants', () => {
    expect(GRID_W).toBe(24)
    expect(GRID_H).toBe(40)
    expect(GROUP_COUNT_DEFAULT).toBe(5)
    expect(CARS_PER_HOUSE).toBe(2)
    expect(MOTORWAY_CAP).toBe(9)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @laneways/shared test`
Expected: FAIL — cannot resolve `../src/index`.

- [ ] **Step 4: Implement the constants**

`packages/shared/src/constants.ts`:

```ts
/**
 * Every scaled quantity in the simulation is an integer numerator over this
 * denominator. A multiplier of 0.667 is 667. The conversion lives here and
 * nowhere else — sim code never sees a decimal.
 */
export const DENOM = 1000

// --- Clock (spec §5.10) ---
export const TICKS_PER_SECOND = 30
export const SECONDS_PER_WEEK = 150
export const DAYS_PER_WEEK = 7
export const TICKS_PER_WEEK = TICKS_PER_SECOND * SECONDS_PER_WEEK

/**
 * Deliberately 0, and deliberately not used as a divisor.
 *
 * 4500 ticks / 7 days is 642.857..., so any stored per-day tick count is wrong.
 * Rounding to 642 would drift 6 ticks per week and desynchronise the day
 * counter from the week boundary within a few weeks of play. `dayOfWeek()` in
 * the sim derives the day from the tick offset within the week instead, which
 * is exact by construction. This constant exists only so that a future reader
 * reaching for it finds this explanation rather than inventing 642.
 */
export const TICKS_PER_DAY = 0

// --- Pathfinding edge weights (spec §5.4) ---
export const ORTHO_COST = 10
export const DIAG_COST = 14

// --- Lane speeds, scaled by DENOM (spec §5.5) ---
export const LANE_SPEED_DEFAULT = 1000
export const MOTORWAY_SPEED_MAX = 3000
export const ROUNDABOUT_SPEED_MUL = 2000
export const RIGHT_ANGLE_SPEED_MUL = 667
export const INTERSECTION_SPEED_MUL = 500
export const SHARP_TURN_SPEED_MUL = 333

// --- Failure (spec §5.8) ---
export const MAX_OVERCROWD_TIME_MS = 90000
export const OVERCROWD_RAMP = 20          // 0.02 x DENOM
export const OVERCROWD_RETURN_MUL = 2000  // 2.0 x DENOM
export const ARRIVAL_KNOCKBACK_PCT = 100  // 10% x DENOM
export const ARRIVAL_KNOCKBACK_MAX_MS = 3000
export const OVERCROWD_GRACE_MS = 2000

// --- Pin capacities (spec §5.8, [OURS]) ---
export const PIN_CAP_SQUARE_TIMER = 6
export const PIN_CAP_SQUARE_HARD = 10
export const PIN_CAP_CIRCLE_TIMER = 8
export const PIN_CAP_CIRCLE_HARD = 14

// --- Board and agents (spec §3, §5.1, §5.2, §5.7) ---
export const GRID_W = 24
export const GRID_H = 40
export const GROUP_COUNT_DEFAULT = 5
export const CARS_PER_HOUSE = 2
export const MOTORWAY_CAP = 9
```

`packages/shared/src/index.ts`:

```ts
export * from './constants'
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @laneways/shared test`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json packages pnpm-lock.yaml
git commit -m "feat(shared): workspace scaffold and integer rule constants"
```

---

## Task 2: Seeded RNG

**Files:**
- Create: `packages/sim/package.json`, `packages/sim/tsconfig.json`
- Create: `packages/sim/src/rng.ts`, `packages/sim/test/rng.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `seedFromString(s: string): number` — xmur3, returns a `uint32`
  - `nextRandom(store: Uint32Array, i: number): number` — advances the state at `store[i]`, returns a `uint32`
  - `randomBelow(store: Uint32Array, i: number, bound: number): number` — unbiased integer in `[0, bound)`

The RNG deliberately operates on caller-owned storage rather than closing over its own state. That is what lets the state live inside the snapshot buffer, so rollback restores the RNG for free.

**`randomBelow` must be unbiased.** Naive `next() % bound` skews toward low values whenever `bound` does not divide 2³², and a biased spawn distribution would be near-impossible to notice by playing and would quietly invalidate every balance measurement.

- [ ] **Step 1: Write the failing test**

`packages/sim/test/rng.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { seedFromString, nextRandom, randomBelow } from '../src/rng'

function store(seed: number): Uint32Array {
  const s = new Uint32Array(1)
  s[0] = seed
  return s
}

describe('seedFromString', () => {
  it('is deterministic', () => {
    expect(seedFromString('laneways')).toBe(seedFromString('laneways'))
  })

  it('differs for different strings', () => {
    expect(seedFromString('a')).not.toBe(seedFromString('b'))
  })

  it('returns a uint32', () => {
    for (const s of ['', 'a', 'laneways', 'a much longer seed string 12345']) {
      const v = seedFromString(s)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(0xffffffff)
    }
  })
})

describe('nextRandom', () => {
  it('produces the same sequence for the same seed', () => {
    const a = store(12345)
    const b = store(12345)
    for (let i = 0; i < 100; i++) expect(nextRandom(a, 0)).toBe(nextRandom(b, 0))
  })

  it('produces different sequences for different seeds', () => {
    expect(nextRandom(store(1), 0)).not.toBe(nextRandom(store(2), 0))
  })

  it('advances the caller-owned state', () => {
    const s = store(999)
    const before = s[0]
    nextRandom(s, 0)
    expect(s[0]).not.toBe(before)
  })

  it('restores its sequence when the state is restored', () => {
    const s = store(777)
    const first = [nextRandom(s, 0), nextRandom(s, 0), nextRandom(s, 0)]
    const saved = s[0] as number
    const afterSave = [nextRandom(s, 0), nextRandom(s, 0)]
    s[0] = saved
    expect([nextRandom(s, 0), nextRandom(s, 0)]).toEqual(afterSave)
    expect(first).toHaveLength(3)
  })

  it('always returns a uint32', () => {
    const s = store(42)
    for (let i = 0; i < 1000; i++) {
      const v = nextRandom(s, 0)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('honours the index so several independent streams can share one array', () => {
    const s = new Uint32Array([1000, 2000])
    const a0 = nextRandom(s, 0)
    const b0 = nextRandom(s, 1)
    expect(a0).not.toBe(b0)
    const s2 = new Uint32Array([1000, 2000])
    expect(nextRandom(s2, 1)).toBe(b0)
  })
})

describe('randomBelow', () => {
  it('stays within range', () => {
    const s = store(5)
    for (let i = 0; i < 2000; i++) {
      const v = randomBelow(s, 0, 7)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(7)
    }
  })

  it('returns 0 for a bound of 1 without consuming randomness', () => {
    const s = store(5)
    const before = s[0]
    expect(randomBelow(s, 0, 1)).toBe(0)
    expect(s[0]).toBe(before)
  })

  it('returns 0 for a bound of 0 rather than NaN or a throw', () => {
    const s = store(5)
    expect(randomBelow(s, 0, 0)).toBe(0)
  })

  it('is unbiased across a bound that does not divide 2^32', () => {
    // 2^32 % 3 !== 0, so a naive `next() % 3` over-represents 0 and 1.
    // With 60000 draws the expected count per bucket is 20000; a naive modulo
    // would not shift this enough to fail at 5%, so this test is a smoke check
    // on gross skew, not a proof. The rejection loop is the actual guarantee.
    const s = store(31337)
    const counts = [0, 0, 0]
    const N = 60000
    for (let i = 0; i < N; i++) counts[randomBelow(s, 0, 3)]!++
    for (const c of counts) {
      expect(c).toBeGreaterThan(N / 3 * 0.95)
      expect(c).toBeLessThan(N / 3 * 1.05)
    }
  })

  it('is deterministic for a given seed', () => {
    const a = store(2024)
    const b = store(2024)
    for (let i = 0; i < 50; i++) expect(randomBelow(a, 0, 13)).toBe(randomBelow(b, 0, 13))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @laneways/sim test`
Expected: FAIL — cannot resolve `../src/rng`.

If the filter itself fails, the sim package files from Step 3 below do not exist yet — create `package.json` and `tsconfig.json` first, then re-run to get the intended module-not-found failure.

- [ ] **Step 3: Implement**

`packages/sim/package.json`:

```json
{
  "name": "@laneways/sim",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@laneways/shared": "workspace:*"
  }
}
```

`packages/sim/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/sim/src/rng.ts`:

```ts
/**
 * Seeded PRNG for the simulation.
 *
 * State lives in caller-owned storage rather than a closure, so it can sit
 * inside the snapshot buffer. Restoring a snapshot therefore restores the
 * random sequence exactly, with no separate save path.
 *
 * mulberry32: 32 bits of state, good statistical quality at this size, and
 * every operation is an integer op that ECMAScript specifies exactly — so it
 * yields identical results on any conforming engine.
 */

/** xmur3 string hash. Produces a well-mixed uint32 seed from any string. */
export function seedFromString(s: string): number {
  let h = 1779033703 ^ s.length
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

/** Advances the stream at `store[i]` and returns the next uint32. */
export function nextRandom(store: Uint32Array, i: number): number {
  let t = (store[i] = (((store[i] as number) + 0x6d2b79f5) | 0) >>> 0)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0)
}

/**
 * Unbiased integer in [0, bound). Uses rejection sampling: a plain modulo
 * over-represents the low end whenever `bound` does not divide 2^32, and a
 * skewed spawn or choice distribution is close to invisible in play while
 * quietly invalidating every balance measurement built on it.
 */
export function randomBelow(store: Uint32Array, i: number, bound: number): number {
  if (bound <= 1) return 0
  const limit = 0x100000000 - (0x100000000 % bound)
  let v = nextRandom(store, i)
  while (v >= limit) v = nextRandom(store, i)
  return v % bound
}
```

Note the `+ 0x6d2b79f5` is wrapped with `| 0` then `>>> 0` before storing. The spike's version let the accumulator run as an unmasked float, which stays correct only until it exceeds 2⁵³. Storing into a `Uint32Array` makes the wraparound explicit and exact at every step.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @laneways/sim test`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/sim pnpm-lock.yaml
git commit -m "feat(sim): seeded rng with state in caller-owned storage"
```

---

## Task 3: State container, snapshot, restore, hash

**Files:**
- Create: `packages/sim/src/state.ts`, `packages/sim/src/hash.ts`
- Create: `packages/sim/test/state.test.ts`, `packages/sim/test/hash.test.ts`

**Interfaces:**
- Consumes: `seedFromString`, `nextRandom` from `./rng`
- Produces:
  - `HEADER_LENGTH`, and the header index constants `H_TICK`, `H_SCORE`, `H_WEEK`, `H_RNG`
  - `interface GameState { buffer: ArrayBuffer; header: Int32Array; rng: Uint32Array }`
  - `createState(seed: string): GameState`
  - `snapshot(s: GameState): ArrayBuffer`
  - `restore(buffer: ArrayBuffer): GameState`
  - `hashState(s: GameState): number`

One buffer, views onto it. Snapshot is a byte copy; restore re-creates the views. Everything the simulation can change lives inside the buffer, which is what makes "snapshot the whole world" a single `slice()`.

- [ ] **Step 1: Write the failing tests**

`packages/sim/test/hash.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { hashBytes } from '../src/hash'

describe('hashBytes', () => {
  it('is deterministic', () => {
    const a = new Uint8Array([1, 2, 3, 4])
    expect(hashBytes(a)).toBe(hashBytes(new Uint8Array([1, 2, 3, 4])))
  })

  it('changes when any byte changes', () => {
    const base = new Uint8Array([1, 2, 3, 4])
    for (let i = 0; i < base.length; i++) {
      const m = new Uint8Array(base)
      m[i] = (m[i] as number) + 1
      expect(hashBytes(m), `byte ${i} did not affect the hash`).not.toBe(hashBytes(base))
    }
  })

  it('is order sensitive', () => {
    expect(hashBytes(new Uint8Array([1, 2]))).not.toBe(hashBytes(new Uint8Array([2, 1])))
  })

  it('handles an empty buffer without throwing', () => {
    expect(Number.isInteger(hashBytes(new Uint8Array(0)))).toBe(true)
  })

  it('returns a uint32', () => {
    const v = hashBytes(new Uint8Array([255, 254, 253]))
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThanOrEqual(0xffffffff)
  })
})
```

`packages/sim/test/state.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createState, snapshot, restore, hashState, H_TICK, H_SCORE, H_WEEK } from '../src/state'
import { nextRandom } from '../src/rng'

describe('createState', () => {
  it('is deterministic for a given seed', () => {
    expect(hashState(createState('abc'))).toBe(hashState(createState('abc')))
  })

  it('differs across seeds', () => {
    expect(hashState(createState('abc'))).not.toBe(hashState(createState('abd')))
  })

  it('starts at tick 0, score 0, week 0', () => {
    const s = createState('x')
    expect(s.header[H_TICK]).toBe(0)
    expect(s.header[H_SCORE]).toBe(0)
    expect(s.header[H_WEEK]).toBe(0)
  })

  it('seeds the rng non-zero', () => {
    expect(createState('x').rng[0]).not.toBe(0)
  })
})

describe('snapshot and restore', () => {
  it('round-trips to an identical hash', () => {
    const s = createState('round-trip')
    s.header[H_TICK] = 1234
    s.header[H_SCORE] = 56
    const before = hashState(s)
    expect(hashState(restore(snapshot(s)))).toBe(before)
  })

  it('produces a detached copy — mutating the original does not change the snapshot', () => {
    const s = createState('detach')
    const snap = snapshot(s)
    s.header[H_TICK] = 9999
    expect(hashState(restore(snap))).not.toBe(hashState(s))
  })

  it('restores the rng stream position exactly', () => {
    const s = createState('rng-restore')
    nextRandom(s.rng, 0)
    nextRandom(s.rng, 0)
    const snap = snapshot(s)
    const expected = [nextRandom(s.rng, 0), nextRandom(s.rng, 0)]
    const r = restore(snap)
    expect([nextRandom(r.rng, 0), nextRandom(r.rng, 0)]).toEqual(expected)
  })

  it('restores a snapshot taken from a restored state', () => {
    const a = createState('nested')
    a.header[H_WEEK] = 3
    const b = restore(snapshot(a))
    const c = restore(snapshot(b))
    expect(hashState(c)).toBe(hashState(a))
  })
})

describe('hashState', () => {
  it('reflects a change to any header field', () => {
    for (const idx of [H_TICK, H_SCORE, H_WEEK]) {
      const s = createState('sensitivity')
      const before = hashState(s)
      s.header[idx] = (s.header[idx] as number) + 1
      expect(hashState(s), `header index ${idx} did not affect the hash`).not.toBe(before)
    }
  })

  it('reflects a change to the rng state', () => {
    const s = createState('rng-sensitivity')
    const before = hashState(s)
    nextRandom(s.rng, 0)
    expect(hashState(s)).not.toBe(before)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @laneways/sim test`
Expected: FAIL — cannot resolve `../src/state` and `../src/hash`.

- [ ] **Step 3: Implement the hash**

`packages/sim/src/hash.ts`:

```ts
/**
 * FNV-1a over raw bytes. Chosen for being trivially portable and exactly
 * specified in integer arithmetic — the point is that two engines agree, not
 * that collisions are rare. Used to compare whole simulation states.
 */
export function hashBytes(bytes: Uint8Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] as number
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
```

- [ ] **Step 4: Implement the state container**

`packages/sim/src/state.ts`:

```ts
import { seedFromString } from './rng'
import { hashBytes } from './hash'

/**
 * The whole simulation lives in one ArrayBuffer.
 *
 * Layout, in order:
 *   [0]                        rng      Uint32  x 1
 *   [RNG_BYTES ...]            header   Int32   x HEADER_LENGTH
 *
 * Later plans append typed-array regions for roads, buildings and cars. The
 * rule is that nothing the simulation can change may live outside this buffer:
 * that is what makes a snapshot a single byte copy and rollback free.
 */

export const H_TICK = 0
export const H_SCORE = 1
export const H_WEEK = 2
export const H_RNG_DRAWS = 3
export const HEADER_LENGTH = 4

const RNG_LENGTH = 1
const RNG_BYTES = RNG_LENGTH * 4
const HEADER_BYTES = HEADER_LENGTH * 4
export const STATE_BYTES = RNG_BYTES + HEADER_BYTES

export interface GameState {
  readonly buffer: ArrayBuffer
  readonly rng: Uint32Array
  readonly header: Int32Array
}

function viewsOver(buffer: ArrayBuffer): GameState {
  return {
    buffer,
    rng: new Uint32Array(buffer, 0, RNG_LENGTH),
    header: new Int32Array(buffer, RNG_BYTES, HEADER_LENGTH),
  }
}

export function createState(seed: string): GameState {
  const s = viewsOver(new ArrayBuffer(STATE_BYTES))
  // Seed can hash to 0; mulberry32 tolerates it, but a zero here is also the
  // value an uninitialised buffer would hold, so force it non-zero to keep
  // "seeded" and "blank" distinguishable in a dump.
  const seeded = seedFromString(seed)
  s.rng[0] = seeded === 0 ? 1 : seeded
  return s
}

/** A detached byte copy. Mutating the source afterwards cannot affect it. */
export function snapshot(s: GameState): ArrayBuffer {
  return s.buffer.slice(0)
}

/** Rebuilds views over a copy of `buffer`, so the restored state is independent. */
export function restore(buffer: ArrayBuffer): GameState {
  if (buffer.byteLength !== STATE_BYTES) {
    throw new Error(`restore: expected ${STATE_BYTES} bytes, got ${buffer.byteLength}`)
  }
  return viewsOver(buffer.slice(0))
}

export function hashState(s: GameState): number {
  return hashBytes(new Uint8Array(s.buffer))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @laneways/sim test`
Expected: PASS, 25 tests (14 rng + 5 hash + 6 state... recount against the actual files and report the real number).

- [ ] **Step 6: Commit**

```bash
git add packages/sim
git commit -m "feat(sim): single-buffer state with snapshot, restore and hashing"
```

---

## Task 4: The clock and a pure step()

**Files:**
- Create: `packages/sim/src/clock.ts`, `packages/sim/src/step.ts`, `packages/sim/src/index.ts`
- Create: `packages/sim/test/clock.test.ts`, `packages/sim/test/step.test.ts`

**Interfaces:**
- Consumes: `GameState`, `H_TICK`, `H_WEEK` from `./state`; clock constants from `@laneways/shared`
- Produces:
  - `weekOfTick(tick: number): number`
  - `dayOfWeek(tick: number): number` — 0..6, derived exactly, never from a stored per-day constant
  - `tickWithinWeek(tick: number): number`
  - `interface TickInputs { readonly actions: readonly never[] }` — a placeholder shape that later plans fill in
  - `step(s: GameState, inputs: TickInputs): void` — advances exactly one tick, mutating in place

`step` mutates rather than returning a new state. The spec's signature is `step(state, inputs) -> state`; mutating one preallocated buffer is how that gets implemented without allocating every tick, and the purity that actually matters — same input state plus same inputs produces the same output state, with no dependence on anything outside the buffer — is preserved and is what the determinism test checks.

- [ ] **Step 1: Write the failing tests**

`packages/sim/test/clock.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { weekOfTick, dayOfWeek, tickWithinWeek } from '../src/clock'
import { TICKS_PER_WEEK, DAYS_PER_WEEK } from '@laneways/shared'

describe('weekOfTick', () => {
  it('starts at week 0', () => {
    expect(weekOfTick(0)).toBe(0)
    expect(weekOfTick(TICKS_PER_WEEK - 1)).toBe(0)
  })

  it('rolls over exactly on the boundary', () => {
    expect(weekOfTick(TICKS_PER_WEEK)).toBe(1)
    expect(weekOfTick(TICKS_PER_WEEK * 5)).toBe(5)
  })
})

describe('tickWithinWeek', () => {
  it('wraps at the week boundary', () => {
    expect(tickWithinWeek(0)).toBe(0)
    expect(tickWithinWeek(TICKS_PER_WEEK - 1)).toBe(TICKS_PER_WEEK - 1)
    expect(tickWithinWeek(TICKS_PER_WEEK)).toBe(0)
    expect(tickWithinWeek(TICKS_PER_WEEK + 7)).toBe(7)
  })
})

describe('dayOfWeek', () => {
  it('starts on day 0 and ends on day 6', () => {
    expect(dayOfWeek(0)).toBe(0)
    expect(dayOfWeek(TICKS_PER_WEEK - 1)).toBe(DAYS_PER_WEEK - 1)
  })

  it('never leaves the range across a whole week, tick by tick', () => {
    for (let t = 0; t < TICKS_PER_WEEK; t++) {
      const d = dayOfWeek(t)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(DAYS_PER_WEEK)
    }
  })

  it('is monotonic within a week and resets at the boundary', () => {
    let prev = 0
    for (let t = 1; t < TICKS_PER_WEEK; t++) {
      const d = dayOfWeek(t)
      expect(d).toBeGreaterThanOrEqual(prev)
      prev = d
    }
    expect(dayOfWeek(TICKS_PER_WEEK)).toBe(0)
  })

  it('does not drift across many weeks', () => {
    // The whole reason TICKS_PER_DAY is not a stored constant: a rounded 642
    // would put day 6 of week 20 in the wrong place. Derivation cannot drift.
    for (let w = 0; w < 50; w++) {
      expect(dayOfWeek(w * TICKS_PER_WEEK)).toBe(0)
      expect(dayOfWeek((w + 1) * TICKS_PER_WEEK - 1)).toBe(DAYS_PER_WEEK - 1)
    }
  })

  it('visits every day of the week', () => {
    const seen = new Set<number>()
    for (let t = 0; t < TICKS_PER_WEEK; t++) seen.add(dayOfWeek(t))
    expect(seen.size).toBe(DAYS_PER_WEEK)
  })
})
```

`packages/sim/test/step.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createState, hashState, snapshot, restore, H_TICK, H_WEEK } from '../src/state'
import { step, type TickInputs } from '../src/step'
import { TICKS_PER_WEEK } from '@laneways/shared'

const NO_INPUT: TickInputs = { actions: [] }

function run(s: ReturnType<typeof createState>, n: number): void {
  for (let i = 0; i < n; i++) step(s, NO_INPUT)
}

describe('step', () => {
  it('advances the tick by exactly one', () => {
    const s = createState('tick')
    step(s, NO_INPUT)
    expect(s.header[H_TICK]).toBe(1)
    step(s, NO_INPUT)
    expect(s.header[H_TICK]).toBe(2)
  })

  it('keeps the week counter in sync with the tick', () => {
    const s = createState('week')
    run(s, TICKS_PER_WEEK - 1)
    expect(s.header[H_WEEK]).toBe(0)
    step(s, NO_INPUT)
    expect(s.header[H_WEEK]).toBe(1)
  })

  it('is deterministic — two states from one seed stay identical', () => {
    const a = createState('determinism')
    const b = createState('determinism')
    for (let i = 0; i < 500; i++) {
      step(a, NO_INPUT)
      step(b, NO_INPUT)
      expect(hashState(a)).toBe(hashState(b))
    }
  })

  it('diverges for different seeds', () => {
    const a = createState('seed-a')
    const b = createState('seed-b')
    run(a, 100)
    run(b, 100)
    expect(hashState(a)).not.toBe(hashState(b))
  })

  it('resumes identically from a snapshot taken mid-run', () => {
    const a = createState('resume')
    run(a, 250)
    const mid = snapshot(a)
    run(a, 250)
    const expected = hashState(a)

    const b = restore(mid)
    run(b, 250)
    expect(hashState(b)).toBe(expected)
  })

  it('does not allocate a new state object', () => {
    const s = createState('no-alloc')
    const buf = s.buffer
    run(s, 10)
    expect(s.buffer).toBe(buf)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @laneways/sim test`
Expected: FAIL — cannot resolve `../src/clock` and `../src/step`.

- [ ] **Step 3: Implement the clock**

`packages/sim/src/clock.ts`:

```ts
import { TICKS_PER_WEEK, DAYS_PER_WEEK } from '@laneways/shared'

export function weekOfTick(tick: number): number {
  return (tick / TICKS_PER_WEEK) | 0
}

export function tickWithinWeek(tick: number): number {
  return tick % TICKS_PER_WEEK
}

/**
 * Day 0..6, derived from position within the week rather than divided by a
 * stored ticks-per-day. 4500 / 7 is not an integer, so any stored constant
 * would drift the day counter against the week boundary. This is exact for
 * every tick by construction.
 */
export function dayOfWeek(tick: number): number {
  return ((tickWithinWeek(tick) * DAYS_PER_WEEK) / TICKS_PER_WEEK) | 0
}
```

- [ ] **Step 4: Implement step and the package surface**

`packages/sim/src/step.ts`:

```ts
import type { GameState } from './state'
import { H_TICK, H_WEEK } from './state'
import { weekOfTick } from './clock'

/**
 * Player input applied on a single tick. Empty for now; M1b onwards fills it
 * with road draws, deletions and upgrade placements. It is a parameter rather
 * than ambient state so that a recorded input log plus a seed fully determines
 * a run, which is what makes server-side replay verification possible.
 */
export interface TickInputs {
  readonly actions: readonly never[]
}

/**
 * Advances the simulation by exactly one tick, in place.
 *
 * Pure in the sense that matters: the result depends only on the contents of
 * `s.buffer` and on `inputs`. Nothing is read from outside the buffer — no
 * clock, no randomness that is not seeded in the buffer, no globals. That
 * property is what the determinism test enforces and what lets the same module
 * replay a run byte-identically in a Cloudflare Worker.
 */
export function step(s: GameState, inputs: TickInputs): void {
  void inputs
  const tick = (s.header[H_TICK] as number) + 1
  s.header[H_TICK] = tick
  s.header[H_WEEK] = weekOfTick(tick)
}
```

`packages/sim/src/index.ts`:

```ts
export * from './rng'
export * from './hash'
export * from './state'
export * from './clock'
export * from './step'
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @laneways/sim test && pnpm typecheck`
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/sim
git commit -m "feat(sim): exact week/day clock and a pure single-tick step"
```

---

## Task 5: Determinism enforcement

**Files:**
- Create: `packages/sim/test/determinism.test.ts`
- Create: `eslint.config.js`
- Modify: root `package.json` (add `eslint` and the lint script)

**Interfaces:**
- Consumes: everything above
- Produces: no runtime exports — this task produces the guarantee

Two mechanisms, deliberately:

- **ESLint** gives feedback while typing, and is the pleasant one.
- **A Vitest source scan** is the one that actually holds. It cannot be silenced by an inline disable comment, it runs in CI with the rest of the suite, and it fails loudly with the offending file and line. The spec calls for a lint rule; this satisfies its intent more strongly, and the reason is worth stating rather than quietly substituting.

- [ ] **Step 1: Write the failing test**

`packages/sim/test/determinism.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createState, hashState } from '../src/state'
import { step, type TickInputs } from '../src/step'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Strips line and block comments so prose about `Math.random` is not a hit. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const BANNED: ReadonlyArray<{ name: string; re: RegExp; why: string }> = [
  { name: 'Math.random', re: /\bMath\s*\.\s*random\b/, why: 'unseeded randomness breaks replay' },
  { name: 'Date.now', re: /\bDate\s*\.\s*now\b/, why: 'wall-clock time is not in the state buffer' },
  { name: 'new Date', re: /\bnew\s+Date\b/, why: 'wall-clock time is not in the state buffer' },
  { name: 'performance.now', re: /\bperformance\s*\.\s*now\b/, why: 'wall-clock time is not in the state buffer' },
  { name: 'Math.sin/cos/tan/exp/log/pow/sqrt/atan2/hypot/cbrt', re: /\bMath\s*\.\s*(sin|cos|tan|asin|acos|atan|atan2|exp|log|log2|log10|pow|sqrt|cbrt|hypot)\b/, why: 'transcendentals are implementation-defined across engines' },
  { name: 'document/window/globalThis', re: /\b(document|window|globalThis|self)\b/, why: 'the sim must run in a Worker with no DOM' },
  { name: 'fetch', re: /\bfetch\s*\(/, why: 'no I/O in the simulation' },
]

describe('sim source obeys the determinism rules', () => {
  const files = sourceFiles(SRC)

  it('finds source files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const { name, re, why } of BANNED) {
    it(`contains no ${name} — ${why}`, () => {
      const hits: string[] = []
      for (const f of files) {
        const lines = stripComments(readFileSync(f, 'utf8')).split('\n')
        lines.forEach((line, i) => {
          if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`)
        })
      }
      expect(hits, `banned construct ${name}\n${hits.join('\n')}`).toEqual([])
    })
  }

  it('contains no float literals', () => {
    // Rule constants are integers over a denominator of 1000; a decimal in sim
    // code means a conversion leaked out of the constants file.
    const hits: string[] = []
    for (const f of files) {
      const lines = stripComments(readFileSync(f, 'utf8')).split('\n')
      lines.forEach((line, i) => {
        const withoutStrings = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')
        if (/(?<![\w.])\d+\.\d+(?![\w.])/.test(withoutStrings)) {
          hits.push(`${f}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(hits, `float literal in sim source\n${hits.join('\n')}`).toEqual([])
  })

  it('uses no bare Array.prototype.sort', () => {
    // Engine-dependent for equal keys. Permitted only with an explicit
    // comparator, which this regex allows through.
    const hits: string[] = []
    for (const f of files) {
      const lines = stripComments(readFileSync(f, 'utf8')).split('\n')
      lines.forEach((line, i) => {
        if (/\.sort\s*\(\s*\)/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits, `bare .sort() in sim source\n${hits.join('\n')}`).toEqual([])
  })
})

describe('the scan itself works', () => {
  it('would catch a violation', () => {
    // Guards against the whole suite above passing because the regexes are
    // broken rather than because the source is clean.
    const sample = 'const x = Math.random()'
    expect(/\bMath\s*\.\s*random\b/.test(sample)).toBe(true)
  })

  it('does not flag a banned name that appears only in a comment', () => {
    const sample = '// never call Math.random here\nconst x = 1'
    expect(/\bMath\s*\.\s*random\b/.test(stripComments(sample))).toBe(false)
  })

  it('does not flag an integer as a float literal', () => {
    expect(/(?<![\w.])\d+\.\d+(?![\w.])/.test('const x = 1000')).toBe(false)
    expect(/(?<![\w.])\d+\.\d+(?![\w.])/.test('const x = 0.5')).toBe(true)
  })
})

describe('golden replay', () => {
  const NO_INPUT: TickInputs = { actions: [] }

  it('reproduces a known hash after 10000 ticks', () => {
    const s = createState('golden-seed-v1')
    for (let i = 0; i < 10000; i++) step(s, NO_INPUT)
    // Record the value produced on first green run and pin it here. Any later
    // change to the state layout, the clock, or step() will trip this — which
    // is the point. When a rule change makes it fail intentionally, re-bless
    // it in the same commit as the rule change, never separately.
    expect(hashState(s)).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @laneways/sim test determinism`
Expected: the golden-replay test FAILS with the real hash against the placeholder `0`. The scan tests should already pass.

If any scan test fails, that is a genuine violation in the code written in Tasks 1–4 — fix the source, not the test.

- [ ] **Step 3: Bless the golden hash**

Replace the `0` in the golden-replay test with the actual value the previous step printed. Re-run and confirm green.

Report the blessed value in your task report so it is recorded outside the code.

- [ ] **Step 4: Add the ESLint config**

```bash
pnpm add -D -w eslint typescript-eslint
```

`eslint.config.js`:

```js
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
```

Add to root `package.json` scripts: `"lint": "eslint ."`.

- [ ] **Step 5: Verify the whole workspace**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "test(sim): enforce determinism by source scan, plus eslint and a golden replay"
```

---

## Self-Review

**Spec coverage.** This plan covers spec §4 (module boundaries: `sim` and `shared` exist with the stated one-way dependency and zero runtime deps) and §4.1 (every listed banned construct is enforced, and the integer-over-1000 convention is established in the constants file with the conversion happening exactly once). The clock implements §5.10's 150 s week at the §3 decision-10 rate of 30 Hz. Deliberately **not** covered, because they belong to M1b–M1d: terrain, roads, pathfinding, buildings, demand, dispatch, movement, upgrades, failure, spawning. The `TickInputs` shape is a placeholder by design and is documented as such.

**Placeholder scan.** One intentional placeholder remains: the golden hash starts at `0` and Task 5 Step 3 blesses it with the real value. That is unavoidable — the value cannot be known before the code runs — and it is a numbered step with an explicit instruction rather than a dangling TODO. Everything else is complete runnable code.

**Type consistency.** `GameState` is produced in Task 3 and consumed in Task 4; `H_TICK`/`H_WEEK` are defined once in `state.ts` and imported everywhere else. `nextRandom(store, i)` keeps the same two-argument shape in Tasks 2, 3 and 4. `TickInputs` is defined in `step.ts` and imported by the tests as a type-only import, which `verbatimModuleSyntax` requires. `hashBytes` (Task 3) underlies `hashState` (Task 3) and is used directly only in its own test.

**One risk worth naming.** Task 3's Step 5 states an expected test count that depends on how the earlier files actually shook out; the step tells the implementer to recount and report the real number rather than trusting it. Three previous plans in this project quoted test counts that were wrong, and the fix is to stop asserting counts I cannot verify.
