import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOUSE_SPAWN_PERIOD_TICKS,
  HOUSE_SPAWN_RETRY_TICKS,
  TICKS_PER_WEEK,
  WEEKLY_TILE_GRANT,
  parseMap,
} from '@laneways/shared'
import {
  createState,
  hashState,
  isGameOver,
  H_WEEK,
  H_DEST_COUNT,
  H_DEST_SPAWN_TIMER,
  H_FAILED_DEST,
  H_GAME_OVER,
  H_HOUSE_COUNT,
  H_SPAWN_COLOUR_CURSOR,
  H_TICK,
  H_TILES,
} from '../src/state'
import { createWorld } from '../src/world'
import { createFlowFields, createScratch } from '../src/scratch'
import { createFieldInputRanges } from '../src/regions'
import { nextRandom } from '../src/rng'
import { spawnScanStart } from '../src/spawn'
import { step, type TickAction, type TickInputs } from '../src/step'
import {
  DEST_KIND_SQUARE,
  ORIENTATION_W,
  placeDestination,
  placeHouse,
} from '../src/buildings'
import { hashBytes } from '../src/hash'
import { drawOfferPair, offerSeedFor, poolFor, popCountCards } from '../src/cards'
import { m1eInsertedRanges, spliceM1eInsertions } from './m1eSplice'
import { assertM1fShapeIsLayoutPlusOffer, spliceM1fInsertions } from './m1fSplice'

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
    //
    // Reconfirmed in M1b Task 6 (the milestone's last task, which adds no new
    // source file): the list below already named every `sim/src`/`shared/src`
    // file on disk, in sorted label order, including `scratch.ts` and
    // `flowfield.ts` from Task 5 — verified live by deleting one entry here,
    // observing this test fail, and reverting.
    expect(files.map(label).sort()).toEqual([
      'shared/src/constants.ts',
      'shared/src/index.ts',
      'shared/src/mapFormat.ts',
      // Added with the demo layout: a second hand-authored map, so that the
      // shipped `firstCity` is not edited and the four whole-buffer goldens
      // that fold its bytes cannot move. It is a `parseMap` call over frozen
      // row strings and is subject to every rule this scan enforces.
      'shared/src/maps/demoCity.ts',
      'shared/src/maps/firstCity.ts',
      'sim/src/blocking.ts',
      'sim/src/buildings.ts',
      // M1f Task 4: the card pool, the non-consuming weekly draw and the
      // rejection sampler. Named here for the same reason every other entry is —
      // a new source file must be added deliberately, and a module that skips
      // this scan skips every determinism rule below it. For THIS module that is
      // the worst possible omission twice over: it is the one file whose whole
      // purpose is to derive randomness, and it is the file the RNG-consumption
      // ban below was written to police.
      'sim/src/cards.ts',
      'sim/src/cars.ts',
      'sim/src/clock.ts',
      'sim/src/demand.ts',
      'sim/src/dispatch.ts',
      'sim/src/flowfield.ts',
      'sim/src/graph.ts',
      'sim/src/hash.ts',
      'sim/src/index.ts',
      'sim/src/layout.ts',
      // M1e Task 7: the per-destination overcrowd meter, `step` phase 11. Named
      // here for the same reason every other entry is — a new source file must
      // be added deliberately, and a module that skips this scan skips every
      // determinism rule below it.
      'sim/src/overcrowd.ts',
      'sim/src/regions.ts',
      'sim/src/rng.ts',
      'sim/src/roads.ts',
      'sim/src/scratch.ts',
      // M1e Task 5: the spawn phase, `step` phase 5 and the first module in
      // `sim` to read `REVEALED_*`. Named here for the same reason every other
      // entry is — a new source file must be added deliberately, and a module
      // that skips this scan skips every determinism rule below it, which for
      // the one module that introduces new randomness and new iteration order
      // is the worst possible omission.
      'sim/src/spawn.ts',
      'sim/src/state.ts',
      'sim/src/step.ts',
      'sim/src/trips.ts',
      // M1f Task 9: the junction upgrade's placement rule and its one flag read.
      // Named here for the same reason every other entry is — a new source file
      // must be added deliberately, and a module that skips this scan skips
      // every determinism rule below it. This one writes the only region M1f
      // adds to the hashed buffer, so a non-deterministic write here is a
      // browser-vs-Worker replay divergence rather than a local defect.
      'sim/src/upgrades.ts',
      // M1e Task 2: the weekly tile grant, `step` phase 2 and the first phase
      // in the game to read the clock. Named here for the same reason every
      // other entry is — a new source file must be added deliberately, and a
      // module that skips this scan skips every determinism rule below it.
      'sim/src/week.ts',
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

describe('fields[ direct indexing is banned outside flowfield.ts (1e, fix-list #21)', () => {
  // step's field-read rule: step calls fieldFor ONCE per colour per tick and
  // holds the reference for the tick — never `fields[c].dist[cell]` directly,
  // which passes every test today (Task 1 has no dispatch phase) and would
  // make fieldFor's staleness guard dead code in the exact place it exists
  // to protect once Task 4 adds one. This is deliberately NOT folded into
  // the general `RULES` array above: `flowfield.ts` legitimately indexes
  // `fields[colour]` inside `fieldFor`'s own definition, so a uniform ban
  // would flag its own implementation. `SCAN_ROOTS`/`sourceFiles` are reused,
  // filtered to exclude that one file.
  const FIELDS_INDEXING_RULE: Rule = {
    name: 'fields[ direct indexing',
    re: /\bfields\s*\[/,
    why:
      "reading fields[c] directly bypasses fieldFor's staleness guard (fix-list #21) — " +
      'call fieldFor(state, world, fields, colour, scratch) instead',
    hits: ['const d = fields[c].dist[cell]', 'return fields [ colour ]'],
    misses: ['const f = fieldFor(state, world, fields, c, scratch)', 'const x = myFields[c]'],
  }

  const allFiles = SCAN_ROOTS.flatMap(sourceFiles)
  const filesOutsideFlowfield = allFiles.filter((f) => label(f) !== 'sim/src/flowfield.ts')

  it('excludes exactly sim/src/flowfield.ts, and nothing else, from the scanned set', () => {
    expect(filesOutsideFlowfield.some((f) => label(f) === 'sim/src/flowfield.ts')).toBe(false)
    expect(filesOutsideFlowfield.length).toBe(allFiles.length - 1)
  })

  it('flowfield.ts itself DOES contain fields[ indexing, proving the exclusion is real and not vacuous', () => {
    const flowfieldFile = allFiles.find((f) => label(f) === 'sim/src/flowfield.ts')
    expect(flowfieldFile).toBeDefined()
    const hits = scanText(readFileSync(flowfieldFile as string, 'utf8'), [FIELDS_INDEXING_RULE])
    expect(hits.length).toBeGreaterThan(0)
  })

  it('contains no direct fields[ indexing anywhere else in sim/shared sources', () => {
    const hits = filesOutsideFlowfield.flatMap((f) =>
      scanText(readFileSync(f, 'utf8'), [FIELDS_INDEXING_RULE]).map((h) => `${label(f)}:${h}`),
    )
    expect(hits, `banned construct fields[\n${hits.join('\n')}`).toEqual([])
  })

  it('the fields[ rule fires on a real violation and leaves its counter-examples alone', () => {
    for (const sample of FIELDS_INDEXING_RULE.hits) {
      expect(scanText(sample, [FIELDS_INDEXING_RULE]), `not caught: ${sample}`).not.toEqual([])
    }
    for (const sample of FIELDS_INDEXING_RULE.misses) {
      expect(scanText(sample, [FIELDS_INDEXING_RULE]), `false positive: ${sample}`).toEqual([])
    }
  })
})

describe('RNG consumption is banned outside rng.ts (M1f Task 4)', () => {
  // **Why this is a standalone rule and NOT an entry in `RULES` above, which is
  // where the brief asked for it: it cannot be one.** The `RULES` loop scans
  // EVERY file in `SCAN_ROOTS`, and `rng.ts` both declares `nextRandom` and
  // calls it twice inside `randomBelow` — so a `RULES` entry would report its
  // own definition site and go red on the tree it was written to bless. The
  // only regex that would make it green there is one narrowed to miss the
  // declaration, which disarms the guard for the case it exists to catch. So it
  // takes `fields[`'s shape instead: its own describe, its own filtered file
  // list, an assertion that the filter excludes EXACTLY `sim/src/rng.ts`, and an
  // assertion that `rng.ts` itself does contain a hit — so the exclusion is
  // proved non-vacuous rather than assumed.
  //
  // The rule itself: the weekly offer draw (M1f Task 5) must be a pure function
  // of `rng[0]` and the week. **Measured: ONE `nextRandom` per week boundary
  // moves the greedy arm's death tick 31,456 -> 34,088, freezes
  // `spawn.test.ts` at 2,640,000 and fails Gate C** — every downstream consumer
  // shifts by one, so a draw on a schedule couples every later draw to that
  // schedule. `spawnScanStart` (spawn.ts) already reads the word without
  // advancing it, for the same reason and with the reason at the site;
  // `offerSeedFor` (cards.ts) is the second.
  //
  // This is the source-scan half. The behavioural half is
  // `a full multi-week run never advances state.rng[0]` below, and neither is
  // sufficient alone: the scan cannot see a hand-rolled `store[i] += 0x6d2b79f5`
  // and the behavioural test cannot see a draw on a path its fixture never
  // reaches.
  const RNG_CONSUMPTION_RULE: Rule = {
    name: 'RNG consumption outside rng.ts',
    re: /\b(?:nextRandom|randomBelow)\s*\(/,
    why: 'a consumer that draws on a schedule couples every later draw to that schedule',
    hits: ['const v = nextRandom(state.rng, 0)', 'randomBelow (store, 0, 6)'],
    // **These MUST NOT match the regex above**, and the previous draft's second
    // entry was `'export function nextRandom(store, i)'`, which matches its own
    // rule and turns the self-test below red on the first run.
    misses: ['const v = mixWord(state.rng[0] as number)', 'offerSeedFor(state, week)'],
  }

  const allFiles = SCAN_ROOTS.flatMap(sourceFiles)
  const filesOutsideRng = allFiles.filter((f) => label(f) !== 'sim/src/rng.ts')

  it('excludes exactly sim/src/rng.ts, and nothing else, from the scanned set', () => {
    expect(filesOutsideRng.some((f) => label(f) === 'sim/src/rng.ts')).toBe(false)
    expect(filesOutsideRng.length).toBe(allFiles.length - 1)
  })

  it('rng.ts itself DOES consume the stream, proving the exclusion is real and not vacuous', () => {
    const rngFile = allFiles.find((f) => label(f) === 'sim/src/rng.ts')
    expect(rngFile).toBeDefined()
    const hits = scanText(readFileSync(rngFile as string, 'utf8'), [RNG_CONSUMPTION_RULE])
    expect(hits.length).toBeGreaterThan(0)
  })

  it('contains no nextRandom/randomBelow call anywhere else in sim/shared sources', () => {
    const hits = filesOutsideRng.flatMap((f) =>
      scanText(readFileSync(f, 'utf8'), [RNG_CONSUMPTION_RULE]).map((h) => `${label(f)}:${h}`),
    )
    expect(hits, `banned RNG consumption\n${hits.join('\n')}`).toEqual([])
  })

  it('the rule fires on a real violation and leaves its counter-examples alone', () => {
    for (const sample of RNG_CONSUMPTION_RULE.hits) {
      expect(scanText(sample, [RNG_CONSUMPTION_RULE]), `not caught: ${sample}`).not.toEqual([])
    }
    for (const sample of RNG_CONSUMPTION_RULE.misses) {
      expect(scanText(sample, [RNG_CONSUMPTION_RULE]), `false positive: ${sample}`).toEqual([])
    }
  })

  it('uses no global-flagged regex, whose test() alternates between calls', () => {
    expect(RNG_CONSUMPTION_RULE.re.flags).not.toContain('g')
  })
})

describe('the seed word is read, never consumed', () => {
  const NO_INPUT: TickInputs = { actions: [] }

  /**
   * A 24x40 all-land board seeded with two CONNECTED colour-0 destinations, two
   * colour-0 houses, and a corridor laid on tick 0 — and `maxDestinations`
   * capped at exactly the two that are seeded.
   *
   * **Every clause of that is load-bearing, and the first draft of this rig had
   * none of them.** A bare board (`firstCity`, or an all-land copy of it) dies
   * at tick 8,618 of overcrowd, because the destination spawner keeps placing
   * destinations no road reaches; `step` then returns immediately and the run
   * spends its remaining ticks frozen. A frozen run satisfies "rng[0] did not
   * move" trivially — the catalogue's "safety properties are satisfied trivially
   * by a frozen system" — so the vacuity clauses below are what make the horizon
   * mean anything, and they are the reason this rig exists rather than a
   * three-line one. Measured across five bare configurations: 8,296 / 8,614 /
   * 8,618 / 8,618 / 8,762 ticks, every one dead, every one crossing a single
   * week boundary.
   *
   * Capping `maxDestinations` at 2 makes `attemptDestinationSpawn` return
   * `BOARD_FULL` forever, so no unconnected destination can ever appear, while
   * `attemptHouseSpawn` keeps firing on its own ladder — and `spawnScanStart`
   * is the first thing it reaches. That is what puts `rng[0]` on a live read
   * path for the whole run instead of only naming it.
   */
  const CORRIDOR_X = 8
  const CORRIDOR_TOP = 10
  const CORRIDOR_BOTTOM = 28

  function invarianceRig(): {
    s: ReturnType<typeof createState>
    world: ReturnType<typeof createWorld>
    fields: ReturnType<typeof createFlowFields>
    scratch: ReturnType<typeof createScratch>
    opening: TickAction[]
  } {
    const rows: string[] = []
    for (let y = 0; y < 40; y++) rows.push('.'.repeat(24))
    const map = parseMap('rng-invariance-v1', rows, 400, 40, 2, 5)
    const world = createWorld(map)
    const s = createState('rng-invariance-v1', map)
    const fields = createFlowFields(map.groupCount, world.cells)
    const scratch = createScratch(
      world.cells,
      map.groupCount,
      map.maxDestinations,
      createFieldInputRanges(map),
    )
    const cell = (x: number, y: number): number => y * world.w + x
    expect(
      placeDestination(s, world, cell(9, CORRIDOR_TOP), ORIENTATION_W, 0, DEST_KIND_SQUARE),
    ).toBe(true)
    expect(
      placeDestination(s, world, cell(9, CORRIDOR_TOP + 4), ORIENTATION_W, 0, DEST_KIND_SQUARE),
    ).toBe(true)
    expect(placeHouse(s, world, cell(CORRIDOR_X, CORRIDOR_BOTTOM), 0)).toBe(true)
    expect(placeHouse(s, world, cell(CORRIDOR_X, CORRIDOR_BOTTOM - 2), 0)).toBe(true)
    const opening: TickAction[] = []
    for (let y = CORRIDOR_TOP; y < CORRIDOR_BOTTOM; y++) {
      opening.push({ kind: 'place', a: cell(CORRIDOR_X, y), b: cell(CORRIDOR_X, y + 1) })
    }
    return { s, world, fields, scratch, opening }
  }

  it('a full multi-week run never advances state.rng[0]', () => {
    const rig = invarianceRig()
    const before = rig.s.rng[0] as number
    const ticks = TICKS_PER_WEEK * 3
    for (let t = 0; t < ticks; t++) {
      step(
        rig.s,
        rig.world,
        rig.fields,
        rig.scratch,
        t === 0 ? { actions: rig.opening } : NO_INPUT,
      )
    }
    expect(rig.s.rng[0], 'the seed word is read, never consumed').toBe(before)

    // ---- Vacuity, four ways ------------------------------------------------
    // A run that did nothing, a run that froze partway, a run whose spawner
    // never fired, and a run that never put the word on a read path would each
    // satisfy the line above for a reason that has nothing to do with the rule.
    expect(rig.s.header[H_TICK], 'the run reached the horizon').toBe(ticks)
    expect(isGameOver(rig.s), 'and all 13,500 of those ticks were LIVE').toBe(false)
    expect(rig.s.header[H_WEEK], 'crossing three week boundaries, which is the named hazard').toBe(3)
    // **Exact, not a floor.** Two of these seven houses are seeded and five were
    // SPAWNED, and a spawner that stopped firing is exactly the way this guard
    // goes quietly vacuous. If a later balance change moves this number, re-pin
    // it against the new measurement — do not widen it to an inequality, which
    // would swallow the spawner falling to zero.
    expect(rig.s.header[H_HOUSE_COUNT], 'and the spawner really ran: 2 seeded + 5 spawned').toBe(7)
    expect(rig.s.header[H_DEST_COUNT], 'with the destination cap holding at 2').toBe(2)
    // And the word was genuinely READ rather than merely left alone.
    // `spawnScanStart` is the reader — a pure function of the word and the tick,
    // reached on every house-spawn attempt — so this recomputes what it returned.
    expect(spawnScanStart(rig.s, 97), 'the word is on a live read path').toBe(
      ((before >>> 0) + ticks) % 97,
    )
  }, 60000)
})

describe('golden replay', () => {
  const NO_INPUT: TickInputs = { actions: [] }

  // A small map defined here, not `firstCity()` — that fixture is level-design
  // data that will keep changing through this milestone, and every edit to it
  // would otherwise churn this golden for no reason connected to sim
  // correctness. `firstCity()`'s own content hash is pinned separately, in
  // `world.test.ts`, which is the assertion that SHOULD fire when it changes.
  //
  // maxHouses/maxDestinations/groupCount are fixed, arbitrary-but-small
  // values (8/4/2) — part of this fixture's frozen recipe as of M1c, exactly
  // like `w`/`h`/`startingTiles` already were. This fixture stays
  // BUILDING-FREE (the plan's own constraint): no house or destination is
  // ever placed on it, so `pinAccum`/`rotationCursor` never advance and no
  // car ever exists — that is what makes M1c's Task 1 the only task that
  // re-blesses this golden, per the plan's "Why one re-bless is now true".
  const GOLDEN_MAP = parseMap('golden-fixture-v1', ['....', '.~^.', '.T..', '....'], 12, 8, 4, 2)
  const GOLDEN_WORLD = createWorld(GOLDEN_MAP)

  it('reproduces a known hash', () => {
    // What this pins, precisely: the buffer layout and byte order (now
    // including the full M1c region list — mapIdentity, the M1c header
    // slots, and every zero-initialised building/car region — none of which
    // this fixture ever writes into, per the building-free constraint
    // above), the seed derivation from the seed string, the map's content
    // hash and dimensions, tick accumulation, coarse week tracking,
    // TICKS_PER_WEEK itself, the rng stream's position after a known number
    // of draws, and one call to `syncFields` per tick via `step` (which,
    // with zero sources on every colour, never rebuilds any field and so
    // never touches anything `hashState` can see — fields live outside the
    // buffer). It does not pin `dayOfWeek` — no day is stored in the buffer
    // — and it is coarse about the clock by construction; `clock.test.ts`
    // walks a full week tick by tick and `step.test.ts` bites on a ±1
    // change, which is where that coverage actually lives.
    //
    // The run stops one tick short of a week boundary so that a change to
    // TICKS_PER_WEEK moves both the tick total and the stored week, and folds
    // rng draws into the run so the generator sits in the golden path rather
    // than beside it.
    //
    // When a rule change makes this fail intentionally, re-bless it in the same
    // commit as the rule change, never separately.
    const s = createState('golden-seed-v1', GOLDEN_MAP)
    const fields = createFlowFields(GOLDEN_MAP.groupCount, GOLDEN_WORLD.cells)
    const scratch = createScratch(
      GOLDEN_WORLD.cells,
      GOLDEN_MAP.groupCount,
      GOLDEN_MAP.maxDestinations,
      createFieldInputRanges(GOLDEN_MAP),
    )
    const ticks = TICKS_PER_WEEK * 3 - 1
    for (let i = 0; i < ticks; i++) {
      step(s, GOLDEN_WORLD, fields, scratch, NO_INPUT)
      if (i % 1000 === 0) nextRandom(s.rng, 0)
    }
    // **Re-blessed in M1e Task 2 (was 3507307907 at M1e Task 1; 340556353 at
    // M1d Task 5; 1729791425 at M1d Task 2; 2413319809 at M1c; 1073292924 at
    // M1b).** Task 1 was the milestone's only SHAPE change; this one is the
    // milestone's first BEHAVIOURAL change to this fixture, and the two are
    // deliberately proved in different ways.
    //
    // **What moved it: the weekly tile grant (`step` phase 2, M1e Task 2).**
    // This fixture runs `TICKS_PER_WEEK * 3 - 1` = 13,499 ticks, which crosses
    // the boundaries at 4,500 and 9,000 and stops short of 13,500 — so it takes
    // exactly two grants. **Asserted directly, so the digest is not the only
    // evidence**: a re-bless whose sole proof is "the digest moved" absorbs any
    // regression that lands in the same commit.
    //
    // **The layout proof survives, and Task 2 makes it say something stronger —
    // but strictly less than the first version of this paragraph claimed.**
    // Task 1's splice (see `m1eSplice.ts`) removes the two inserted ranges —
    // 16 B of new header slots at offset 52 and 40 B of new regions at offset
    // 404, both MID-BUFFER — and had to reproduce 340556353 bit-for-bit. The
    // grant writes `H_TILES`, which is header slot 3 and therefore OUTSIDE both
    // ranges, so the splice alone can no longer reproduce that digest and this
    // assertion went red on the first run of Task 2's implementation. Backing
    // the grant out before splicing restores it, and what the restored proof
    // establishes is: across 13,499 ticks, **`H_TILES` is the only byte OUTSIDE
    // THE TWO INSERTED RANGES that Task 2 changed.** A grant that also nudged
    // the rng stream, or wrote a different header slot, or touched a region
    // that predates M1e, fails here and not merely in the digest.
    //
    // **What it does NOT cover, and the correction is measured rather than
    // reasoned.** This comment first said a grant that "shifted a timer" would
    // fail here. It would not: both M1e timers live INSIDE the spliced ranges by
    // construction — that is the whole reason Task 1's re-bless was pure layout,
    // as `m1eSplice.ts`'s module comment says — so the splice is blind to them
    // BY DESIGN. Making `runWeekBoundary` also write
    // `H_DEST_SPAWN_TIMER = 12345` produces **exactly one failure, the
    // whole-buffer digest below; this splice assertion passes.**
    //
    // **Task 5 is the reader this matters to.** Its subject is those timers and
    // it holds this golden's last licensed move, so a Task 5 implementer who
    // read the old sentence could conclude the splice covers a stray timer write
    // and loosen the plan's hand-computed timer assertions accordingly. It does
    // not cover it. Those assertions ARE the coverage; a one-tick timer error
    // passes the splice, moves the digest, and would be absorbed by Task 5's own
    // re-bless licence.
    //
    // Offsets are FOR THIS FIXTURE: GOLDEN_MAP is 4x4 with groupCount 2 and
    // maxDestinations 4, so block B is 40 B and the whole buffer goes
    // 1,416 -> 1,472, not `firstCity`'s 148 B and 13,828 -> 13,992. The
    // assertions below are the derivation; this paragraph only reads them out.
    //
    // **That last move has now happened: M1e Task 5, 883875991 -> 1058753394**,
    // for the spawn timers cycling, with direct hand-computed assertions on
    // every changed slot beside the digest exactly as Task 2's is.
    //
    // **And the plan's golden table was wrong about the OTHER fixtures, which
    // matters here because this file is where that table is quoted.** It said
    // this was the only golden Task 5 could reach, deriving that from *"every
    // other fixture runs below the first spawn attempt at tick 300"*. Both
    // `loop.test.ts` goldens moved as well: the spawn timers are COUNTDOWNS, so
    // they move on every tick from tick 1 whether or not an attempt ever fires,
    // and a whole-buffer digest asks "did a byte move", not "did anything
    // spawn". Those two carry the same shape of direct assertion this one does
    // (`loop.test.ts`'s `assertNoSpawnHappened`).
    //
    // This fixture still places no building and therefore has no car, so the
    // grant is the ONLY behaviour it can exhibit — and both ghost regions are
    // all-zero in it, asserted below, which is what keeps "the digest moved for
    // one named reason" checkable rather than merely stated.
    expect(s.ghostMask.every((b) => b === 0), 'no fixture cell is a ghost').toBe(true)
    expect(s.ghostCommitted.every((b) => b === 0), 'no fixture cell has a committed count').toBe(true)
    expect(s.header[H_TILES]).toBe(GOLDEN_MAP.startingTiles + 2 * WEEKLY_TILE_GRANT)

    // ---------------------------------------------------------------------
    // M1e Task 5 moves this number too, and the plan said so in advance. This
    // fixture's clipped spawn zone is EMPTY (4x4 board against a rect at
    // x >= 5), so no building is placed and the ONLY bytes that moved are the
    // spawn timers. Hand-computed and asserted, so the digest is not the only
    // evidence: the destination timer is armed at 2,250, fires and fails at
    // tick 2,250, and re-fires every DEST_SPAWN_RETRY_TICKS = 600 ticks after
    // that (neither NO_ELIGIBLE_COLOUR nor ZONE_EMPTY is BOARD_FULL, so both
    // take the retry); the last attempt at or before tick 13,499 is 13,050, so
    // 13,499 finds it at 600 - (13,499 - 13,050) = 151.
    //
    // **Which of the two refusals this fixture actually takes, corrected from
    // the brief.** The brief's Step 11 prose says `attemptDestinationSpawn`
    // "returns ZONE_EMPTY after the cursor write". It does not: the colour
    // loop runs FIRST, this board has no house, so no colour is eligible and
    // the function returns `NO_ELIGIBLE_COLOUR` BEFORE the cursor write. The
    // timer arithmetic is identical either way (both take the retry) and the
    // cursor assertion below is the one the brief itself derives correctly.
    expect(s.header[H_DEST_COUNT], 'an empty zone places nothing').toBe(0)
    expect(s.header[H_HOUSE_COUNT]).toBe(0)
    expect(s.header[H_DEST_SPAWN_TIMER]).toBe(151)
    // The cursor is written before the ZONE_EMPTY return, but only when a
    // colour was chosen — and a colour needs a house, of which this board has
    // none. So it must NOT have moved, and that is a real assertion rather
    // than a restatement of zero.
    expect(s.header[H_SPAWN_COLOUR_CURSOR], 'no colour is eligible with no houses').toBe(0)
    for (let c = 0; c < GOLDEN_MAP.groupCount; c++) {
      // Hand-computed: the first attempt is at tick HOUSE_SPAWN_PERIOD_TICKS =
      // 300 and every failure takes HOUSE_SPAWN_RETRY_TICKS = 60, so attempts
      // land at 300 + 60k, the last at or before 13,499 is 13,440, and the
      // timer reads 60 - (13,499 - 13,440) = 1.
      const firstAttempt = HOUSE_SPAWN_PERIOD_TICKS
      const lastAttempt = firstAttempt + Math.floor((ticks - firstAttempt) / HOUSE_SPAWN_RETRY_TICKS) * HOUSE_SPAWN_RETRY_TICKS
      expect(lastAttempt, 'the house ladder lands at 13,440').toBe(13440)
      expect(s.houseSpawnTimer[c], `colour ${c}`).toBe(HOUSE_SPAWN_RETRY_TICKS - (ticks - lastAttempt))
      expect(s.houseSpawnTimer[c], `colour ${c}`).toBe(1)
    }
    // The two M1e header slots nothing writes yet, asserted so the re-bless
    // below cannot absorb a stray write to either. Task 8 owns both.
    expect(s.header[H_GAME_OVER]).toBe(0)
    expect(s.header[H_FAILED_DEST]).toBe(0)
    // **The two overcrowd regions are a STRUCTURAL zero on this board and the
    // label that said "Task 3 owns this region, not Task 5" is no longer the
    // reason.** Task 7 wired `runOvercrowd` as the last phase, so it runs on all
    // 13,499 ticks here — over a live prefix of **zero** destinations, because
    // this 4x4 golden map places none. The loop body is never entered, which is
    // a stronger statement than "no destination reached a cap", and it is
    // asserted rather than read off the map.
    expect(s.header[H_DEST_COUNT], 'the golden board has no destination at all').toBe(0)
    expect(s.destOvercrowd.every((v) => v === 0), 'so phase 11 writes nothing here').toBe(true)
    expect(s.destOverTicks.every((v) => v === 0)).toBe(true)
    const m1e = m1eInsertedRanges(GOLDEN_MAP)
    expect([m1e.aStart, m1e.aEnd, m1e.bStart, m1e.bEnd]).toEqual([52, 68, 424, 464])
    // Back the grant out for the splice, then put it back. `H_TILES` sits at
    // header slot 3, in front of block A, so it is NOT one of the bytes the
    // splice removes — see the paragraph above for why this step exists and
    // what its presence proves. Vacuity: the back-out must actually change
    // something, or the splice below reproduces the old digest by doing
    // nothing, which is the failure mode this whole proof exists to prevent.
    const granted = s.header[H_TILES] as number
    expect(granted, 'nothing to back out — the fixture took no grant').not.toBe(
      GOLDEN_MAP.startingTiles,
    )
    s.header[H_TILES] = GOLDEN_MAP.startingTiles
    const spliced = spliceM1eInsertions(s, GOLDEN_MAP)
    s.header[H_TILES] = granted
    // Vacuity: the splice must have removed exactly the 56 bytes Task 1
    // inserted, landing on M1d's own total for this map. A no-op splice would
    // otherwise "prove" a digest that never moved.
    expect(spliced.length, "the splice must land on M1d's buffer size").toBe(1416)
    expect(m1e.totalBytes).toBe(1508)
    expect(hashBytes(spliced), 'the splice must reproduce the pre-M1e digest').toBe(340556353)
    // **Re-blessed at M1f Task 4: 1058753394 -> 4189191826, PURE LAYOUT.** The
    // milestone's ONLY shape change — `HEADER_LENGTH` 13 -> 18 and one region,
    // `upgradeAt`, one Uint8 flag per cell. On this 4x4 fixture the buffer goes
    // 1,472 -> 1,508 B (+20 header, +16 cells) and `regionsFor` 29 -> 30.
    //
    // **The digest is not the evidence; these two lines are.** The splice removes
    // exactly the two inserted ranges and must reproduce the PRIOR digest
    // bit-for-bit, which says no pre-existing byte changed value; and the shape
    // assertion says every inserted byte is at the value it should be. A move
    // that was partly layout and partly a stray write fails the first, and one
    // that quietly initialised a new slot fails the second.
    //
    // ---------------------------------------------------------------------
    // **Re-blessed at M1f Task 5: 4189191826 -> 2986084740, BEHAVIOURAL — the
    // card offer, `step` phase 4.** Task 4's move was pure layout; this one is
    // not, and the two bytes that moved are named and hand-computed rather than
    // read back.
    //
    // This fixture runs 13,499 ticks and therefore crosses the boundaries at
    // 4,500 and 9,000, exactly as it takes two tile grants. Nothing resolves an
    // offer, so at tick 13,499 the slots hold **week 2's** pair and
    // `H_OFFER_WEEK` is still 0.
    //
    // **The reason for that changed at M1f Task 6 and the digest did not.** The
    // clause here used to read "no `TickAction` can until Task 6"; one can now,
    // and the fixture's log is still empty — `NO_INPUT` on every one of the
    // 13,499 ticks. So the golden is unmoved because this fixture takes no
    // action, not because no action exists, and a future task that scripts one
    // into it re-blesses this digest.
    //
    // **What makes this stronger than a re-bless with a story: the M1f splice
    // still reproduces 1058753394.** The offer slots sit inside block A, so the
    // splice removes them — which means that assertion now says something it
    // could not say before: across 13,499 ticks and two week boundaries, phase 4
    // changed **not one byte outside the two inserted ranges.**
    //
    // **Why the pair can be recomputed from the FINAL `rng[0]`.** `offerSeedFor`
    // reads the seed word live, and this fixture is the one place in the repo
    // that advances it deliberately — `nextRandom(s.rng, 0)` every 1,000
    // iterations, to keep the generator inside the golden path. The last such
    // draw is at `i = 13,000`; `13,499 % 1000 !== 0`, so no draw follows the
    // final tick and the word phase 4 read on it is the word still in the
    // buffer. That premise is asserted below rather than described here.
    expect((ticks - 1) % 1000, 'a draw after the last tick would invalidate the recomputation').not.toBe(0)
    expect(s.header[H_WEEK], 'the offer below is week 2s').toBe(2)
    const offer = new Int32Array(2)
    drawOfferPair(poolFor(GOLDEN_WORLD), offerSeedFor(s, 2), offer)
    // And the slots hold real cards, so the fixture is not silently exercising
    // the short-pool path: this map's pool is two cards.
    expect(popCountCards(poolFor(GOLDEN_WORLD)), 'GOLDEN_MAP can offer a pair').toBe(2)
    assertM1fShapeIsLayoutPlusOffer(s, GOLDEN_MAP, offer[0] as number, offer[1] as number)
    expect(
      hashBytes(spliceM1fInsertions(s, GOLDEN_MAP)),
      'the M1f splice must reproduce the pre-M1f digest',
    ).toBe(1058753394)
    expect(hashState(s)).toBe(2986084740)
  })
})
