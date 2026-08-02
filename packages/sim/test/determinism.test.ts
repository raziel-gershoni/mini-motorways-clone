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
    expect(hashState(s)).toBe(2147314566)
  })
})
