import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TICKS_PER_WEEK, parseMap } from '@laneways/shared'
import { createState, hashState } from '../src/state'
import { nextRandom } from '../src/rng'
import { step, type TickInputs } from '../src/step'

/**
 * The determinism boundary is the sim *plus everything it depends on*. Spec §4
 * makes `@laneways/shared` the sim's sole dependency and the home of the rule
 * constants, so a banned construct there reaches a replay exactly as directly
 * as one in `step()` — and until this scan walked it, `Math.random()` in
 * `packages/shared/src` passed both this suite and `pnpm lint`.
 */
const PACKAGES = fileURLToPath(new URL('../..', import.meta.url))
const SCAN_ROOTS = [
  fileURLToPath(new URL('../src', import.meta.url)),
  fileURLToPath(new URL('../../shared/src', import.meta.url)),
]

/** Not just `.ts`, so a stray module in another flavour cannot hide from the scan. */
const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js']

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (SOURCE_EXTENSIONS.some((e) => name.endsWith(e))) out.push(p)
  }
  return out
}

/** Stable, OS-independent label for a scanned file: `sim/src/step.ts`. */
function label(file: string): string {
  return relative(PACKAGES, file).split(sep).join('/')
}

/**
 * Blanks everything that is not code — comment bodies and the contents of
 * string and template literals — by replacing each character with a space and
 * leaving every newline in place. Both the line count and the column of every
 * surviving character therefore survive, which the rules below depend on.
 *
 * Two measured defects in the previous regex stripper motivated this:
 *
 *   - `const u = 'https://x.dev'; const r = Math.random()` stripped to
 *     `const u = 'https:` — the `//` inside the string was read as a comment
 *     and the violation was erased. A string containing `/*` was worse: it
 *     swallowed every line up to the next close.
 *   - block comments were replaced by the empty string rather than by
 *     newline-preserving whitespace, so every hit below a JSDoc header — which
 *     is every file in `src` — was reported at the wrong line, in the one
 *     situation where the message has to be right.
 *
 * Substitutions inside a template literal are scanned as code, so
 * `` `at ${Date.now()}` `` is still caught.
 *
 * Known limitation, recorded rather than solved: regex literals are not
 * tracked, so a `//` or an unbalanced quote inside one would blank the rest of
 * that line. There are no regex literals in the scanned sources, and the
 * failure mode is a false negative confined to the line that holds one.
 */
function stripNonCode(src: string): string {
  type Frame = { kind: 'code'; braces: number } | { kind: 'template' }
  const out: string[] = []
  const stack: Frame[] = [{ kind: 'code', braces: 0 }]
  const blank = (c: string): string => (c === '\n' ? '\n' : ' ')
  let i = 0

  const blankUntil = (end: number): void => {
    for (; i < end && i < src.length; i++) out.push(blank(src[i] as string))
  }

  while (i < src.length) {
    const frame = stack[stack.length - 1] as Frame
    const c = src[i] as string

    if (frame.kind === 'template') {
      if (c === '\\') {
        out.push(' ')
        i++
        if (i < src.length) out.push(blank(src[i++] as string))
        continue
      }
      if (c === '`') {
        out.push('`')
        i++
        stack.pop()
        continue
      }
      if (c === '$' && src[i + 1] === '{') {
        out.push('$', '{')
        i += 2
        stack.push({ kind: 'code', braces: 0 })
        continue
      }
      out.push(blank(c))
      i++
      continue
    }

    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      blankUntil(nl === -1 ? src.length : nl)
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      blankUntil(end === -1 ? src.length : end + 2)
      continue
    }
    if (c === "'" || c === '"') {
      out.push(c)
      i++
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') {
          out.push(' ')
          i++
          if (i < src.length) out.push(blank(src[i++] as string))
          continue
        }
        out.push(' ')
        i++
      }
      if (i < src.length && src[i] === c) out.push(src[i++] as string)
      continue
    }
    if (c === '`') {
      out.push('`')
      i++
      stack.push({ kind: 'template' })
      continue
    }
    if (c === '{') {
      frame.braces++
      out.push(c)
      i++
      continue
    }
    if (c === '}') {
      if (frame.braces === 0 && stack.length > 1) {
        out.push(c)
        i++
        stack.pop()
        continue
      }
      frame.braces--
      out.push(c)
      i++
      continue
    }
    out.push(c)
    i++
  }
  return out.join('')
}

interface Rule {
  /** Short name, used in the test title and in every reported hit. */
  readonly name: string
  readonly re: RegExp
  readonly why: string
  /** Lines that MUST match. Drives the meta-tests; a rule without one fails. */
  readonly hits: readonly string[]
  /** Lines that must NOT match, pinning the rule against over-reach. */
  readonly misses: readonly string[]
}

const RULES: readonly Rule[] = [
  {
    name: 'Math.random',
    re: /\bMath\s*\.\s*random\b/,
    why: 'unseeded randomness breaks replay',
    hits: ['const x = Math.random()', 'return Math . random ()'],
    misses: ['const x = randomBelow(s.rng, 0, 10)'],
  },
  {
    name: 'Date.now',
    re: /\bDate\s*\.\s*now\b/,
    why: 'wall-clock time is not in the state buffer',
    hits: ['const t = Date.now()'],
    misses: ['const t = s.header[H_TICK]'],
  },
  {
    name: 'new Date',
    re: /\bnew\s+Date\b/,
    why: 'wall-clock time is not in the state buffer',
    hits: ['const d = new Date()', 'const d = new Date(0)'],
    misses: ['const d = createState("x")'],
  },
  {
    name: 'performance.now',
    re: /\bperformance\s*\.\s*now\b/,
    why: 'wall-clock time is not in the state buffer',
    hits: ['const t = performance.now()'],
    misses: ['const t = tickOf(s)'],
  },
  {
    name: 'Math.sin/cos/tan/exp/log/pow/sqrt/atan2/hypot/cbrt',
    re: /\bMath\s*\.\s*(sin|cos|tan|asin|acos|atan|atan2|exp|log|log2|log10|pow|sqrt|cbrt|hypot)\b/,
    why: 'transcendentals are implementation-defined across engines',
    hits: ['const y = Math.sin(x)', 'const d = Math.hypot(dx, dy)', 'const p = Math.pow(a, b)'],
    misses: ['const y = Math.imul(a, b)', 'const y = Math.max(a, b)', 'const y = Math.min(a, b)'],
  },
  {
    name: 'document/window/globalThis/self',
    re: /\b(document|window|globalThis|self)\b/,
    why: 'the sim must run in a Worker with no DOM',
    hits: ['document.body.append(el)', 'const w = window.innerWidth', 'globalThis.cache = m', 'const g = self'],
    misses: ['const selfish = 1', 'const windowless = true'],
  },
  {
    name: 'fetch',
    re: /\bfetch\s*\(/,
    why: 'no I/O in the simulation',
    hits: ['const r = await fetch(url)'],
    misses: ['const r = prefetch(url)', 'const fetched = 1'],
  },
  {
    name: 'float literal',
    // Rule constants are integers over a denominator of 1000; a decimal in
    // scanned code means a conversion leaked out of the constants file.
    // Covers `0.5`, leading-dot `.5`, exponent forms `1e-3` / `1.5e3`, and
    // numeric separators `1_000.5`. The trailing-dot form `1.` needs its own
    // alternative, guarded so that `arr[0].length` is not a hit.
    re: /(?<![\w.$])(?:\d[\d_]*\.\d|\.\d|\d[\d_]*(?:\.\d[\d_]*)?e[+-]?\d|\d[\d_]*\.(?![\w.]))/i,
    why: 'every scaled quantity is an integer numerator over DENOM',
    hits: [
      'const x = 0.5',
      'const x = .5',
      'const x = 1e-3',
      'const x = 1.5e3',
      'const x = 1_000.5',
      'const x = 1.',
      'const x = 2E7',
      'const x = -0.25',
    ],
    misses: [
      'const x = 1000',
      'const x = 0x1F',
      'const x = 2e',
      'const n = arr[0].length',
      'const h = 0x6d2b79f5',
      'const v = s.header[H_TICK]',
      'const x = 1_000_000',
    ],
  },
  {
    name: 'bare .sort()',
    re: /\.sort\s*\(\s*\)/,
    why: 'engine-dependent for equal keys; pass an explicit comparator',
    hits: ['ids.sort()', 'ids.sort( )'],
    misses: ['ids.sort((a, b) => a - b)'],
  },
  {
    name: 'module-scope let/var',
    // The core invariant: everything the simulation can change lives in the
    // state buffer. A module-scope binding is shared across every state
    // instance and survives a rollback — it would present as a
    // browser-vs-Worker replay divergence, or as a snapshot that restores to a
    // position that never existed. Module scope is unindented, so a column-0
    // match is a reliable signal.
    re: /^(?:export\s+)?(?:let|var)\s/,
    why: 'the sim owns no mutable state outside the state buffer',
    hits: ['let visited = new Uint8Array(960)', 'var frontier = 0', 'export let counter = 0'],
    misses: ['  let h = 0x811c9dc5', 'const x = 1', 'letters.push(1)', 'variance += 1'],
  },
  {
    name: 'module-scope preallocated container',
    // Same invariant as above, reached the other way: a `const` binding to a
    // typed array, buffer, Map or Set is immutable only in the binding. The
    // contents are exactly the reusable scratch state this milestone exists to
    // forbid — and flow-field pathfinding in M1b is precisely the code that
    // wants one.
    re: /^(?:export\s+)?const\s+\w+\s*=\s*new\s+(?:\w*Array|ArrayBuffer|SharedArrayBuffer|Map|Set|WeakMap|WeakSet)\b/,
    why: 'the sim owns no mutable state outside the state buffer',
    hits: [
      'const visited = new Uint8Array(960)',
      'const scratch = new ArrayBuffer(64)',
      'export const cache = new Map()',
      'const seen = new Set()',
      'const rows = new Array(24)',
    ],
    misses: [
      '  const s = new Uint32Array(1)',
      'const s = viewsOver(new ArrayBuffer(STATE_BYTES))',
      'const e = new Error("x")',
      'export const DENOM = 1000',
    ],
  },
]

/**
 * The one scanning implementation. Both the file scan and the meta-tests below
 * call it, so a rule that cannot fire fails the meta-test rather than passing
 * the whole suite quietly — the previous meta-test re-typed the regex literal
 * and stayed green when the real one was replaced with `/__NEVER__/`.
 *
 * Returns `line: rule: source` per hit; callers prefix the file.
 */
function scanText(text: string, rules: readonly Rule[]): string[] {
  const hits: string[] = []
  const original = text.split('\n')
  stripNonCode(text)
    .split('\n')
    .forEach((line, i) => {
      for (const rule of rules) {
        if (rule.re.test(line)) hits.push(`${i + 1}: ${rule.name}: ${(original[i] ?? line).trim()}`)
      }
    })
  return hits
}

describe('sim source obeys the determinism rules', () => {
  const files = SCAN_ROOTS.flatMap(sourceFiles)

  it('scans the sim and shared sources, not some other directory', () => {
    // `files.length > 0` passed against any directory holding .ts files — the
    // reviewer ran the whole suite green against the wrong package. The list is
    // the point: a new source file must be added here deliberately.
    expect(files.map(label).sort()).toEqual([
      'shared/src/constants.ts',
      'shared/src/index.ts',
      'shared/src/mapFormat.ts',
      'shared/src/maps/firstCity.ts',
      'sim/src/clock.ts',
      'sim/src/hash.ts',
      'sim/src/index.ts',
      'sim/src/layout.ts',
      'sim/src/rng.ts',
      'sim/src/roads.ts',
      'sim/src/state.ts',
      'sim/src/step.ts',
      'sim/src/world.ts',
    ])
  })

  for (const rule of RULES) {
    it(`contains no ${rule.name} — ${rule.why}`, () => {
      const hits = files.flatMap((f) =>
        scanText(readFileSync(f, 'utf8'), [rule]).map((h) => `${label(f)}:${h}`),
      )
      expect(hits, `banned construct ${rule.name}\n${hits.join('\n')}`).toEqual([])
    })
  }
})

describe('the scan itself works', () => {
  it('gives every rule at least one known violation to prove itself against', () => {
    // A rule added without a sample would go unchecked forever, which is how
    // the previous meta-test managed to be green and useless at once.
    for (const rule of RULES) {
      expect(rule.hits.length, `rule "${rule.name}" has no positive sample`).toBeGreaterThan(0)
    }
  })

  it('uses no global-flagged regex, whose test() alternates between calls', () => {
    for (const rule of RULES) {
      expect(rule.re.flags, `rule "${rule.name}" is stateful`).not.toContain('g')
    }
  })

  for (const rule of RULES) {
    it(`the ${rule.name} rule fires on a real violation`, () => {
      for (const sample of rule.hits) {
        expect(scanText(sample, [rule]), `not caught: ${sample}`).not.toEqual([])
      }
    })

    it(`the ${rule.name} rule leaves its counter-examples alone`, () => {
      for (const sample of rule.misses) {
        expect(scanText(sample, [rule]), `false positive: ${sample}`).toEqual([])
      }
    })
  }

  it('does not flag a banned name that appears only in a line comment', () => {
    expect(scanText('// never call Math.random here\nconst x = 1', RULES)).toEqual([])
  })

  it('does not flag a banned name that appears only in a block comment', () => {
    expect(scanText('/**\n * Never call Date.now() here.\n */\nconst x = 1', RULES)).toEqual([])
  })

  it('still catches a violation on a line that also holds a URL string', () => {
    // The `//` in `https://` used to be read as a comment start, erasing the
    // rest of the line — violation included.
    const src = "const u = 'https://x.dev'; const r = Math.random()"
    expect(scanText(src, RULES)).toEqual(['1: Math.random: ' + src])
  })

  it('still catches a violation after a string containing a block-comment opener', () => {
    const src = "const open = '/*'\nconst r = Math.random()\nconst close = '*/'"
    expect(scanText(src, RULES)).toEqual(['2: Math.random: const r = Math.random()'])
  })

  it('catches a banned construct inside a template substitution', () => {
    expect(scanText('throw new Error(`bad at ${Date.now()}`)', RULES)).not.toEqual([])
  })

  it('does not flag a banned name inside template literal text', () => {
    expect(scanText('const s = `call Math.random for chaos`', RULES)).toEqual([])
  })

  it('reports the true line number below a multi-line JSDoc header', () => {
    // Block comments are blanked, not deleted, so line numbers survive. Every
    // file in src opens with a JSDoc header, so under the old stripper every
    // real hit pointed at the wrong line.
    const src = ['/**', ' * A header.', ' *', ' * More prose.', ' */', 'const r = Math.random()'].join('\n')
    expect(scanText(src, RULES)).toEqual(['6: Math.random: const r = Math.random()'])
  })

  it('preserves the column of code that follows a block comment on one line', () => {
    // Indentation matters to the module-scope rules: a blanked comment must not
    // shift real code left into column 0, nor a real column-0 declaration right.
    expect(stripNonCode('/* x */ let a = 1')).toBe('        let a = 1')
    expect(stripNonCode('let a = 1 /* x */')).toBe('let a = 1        ')
  })
})

describe('golden replay', () => {
  const NO_INPUT: TickInputs = { actions: [] }

  // A small map defined here, not `firstCity()` — that fixture is level-design
  // data that will keep changing through this milestone, and every edit to it
  // would otherwise churn this golden for no reason connected to sim
  // correctness. `firstCity()`'s own content hash is pinned separately, in
  // `world.test.ts`, which is the assertion that SHOULD fire when it changes.
  const GOLDEN_MAP = parseMap('golden-fixture-v1', ['....', '.~^.', '.T..', '....'], 12)

  it('reproduces a known hash', () => {
    // What this pins, precisely: the buffer layout and byte order (now
    // including the map-derived header slots and the roads/cleared regions
    // Task 3 will write into), the seed derivation from the seed string, the
    // map's content hash and dimensions, tick accumulation, coarse week
    // tracking, TICKS_PER_WEEK itself, and the rng stream's position after a
    // known number of draws. It does not pin `dayOfWeek` — no day is stored
    // in the buffer — and it is coarse about the clock by construction;
    // `clock.test.ts` walks a full week tick by tick and `step.test.ts` bites
    // on a ±1 change, which is where that coverage actually lives.
    //
    // The run stops one tick short of a week boundary so that a change to
    // TICKS_PER_WEEK moves both the tick total and the stored week, and folds
    // rng draws into the run so the generator sits in the golden path rather
    // than beside it.
    //
    // When a rule change makes this fail intentionally, re-bless it in the same
    // commit as the rule change, never separately.
    const s = createState('golden-seed-v1', GOLDEN_MAP)
    const ticks = TICKS_PER_WEEK * 3 - 1
    for (let i = 0; i < ticks; i++) {
      step(s, NO_INPUT)
      if (i % 1000 === 0) nextRandom(s.rng, 0)
    }
    // Re-blessed in M1b Task 2 (was 917870623): the buffer grew by the
    // `roads`/`cleared` regions and the header grew from 3 to 7 slots
    // (H_MAP, H_MAP_W, H_MAP_H, H_TILES), and this replay now also pins the
    // map's content hash and dimensions via those new header slots. This is
    // the milestone's one deliberate golden re-bless (design decision 5) —
    // no later M1b task should need another.
    expect(hashState(s)).toBe(1073292924)
  })
})
