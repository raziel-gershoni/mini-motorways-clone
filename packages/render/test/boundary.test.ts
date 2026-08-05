import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Spec §4 / plan Decision 3: "render depends on nothing but its own
 * interface types." `render` must import nothing from `@laneways/sim` or
 * `@laneways/shared` — that is what keeps it testable with hand-built arrays
 * and keeps "swapping in Pixi is a one-file change" true. The dependency
 * direction alone (render's package.json declares no such dependency) would
 * still let a source file reach across with a raw relative path or a bare
 * specifier that resolves via node_modules hoisting, so this is a source
 * scan, not just an absence of a package.json entry.
 *
 * `packages/sim/test/determinism.test.ts` already runs a scan like this one,
 * but it is rooted at `../src` (sim) and `../../shared/src` and cannot reach
 * `packages/render` — this is a second, independent scan, not an extension
 * of it.
 */

const PACKAGES_DIR = fileURLToPath(new URL('../..', import.meta.url))
const SCAN_ROOT = fileURLToPath(new URL('../src', import.meta.url))

/** Not just `.ts`, so a stray module in another flavour cannot hide from the scan. */
const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js']

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    // A scan root that does not exist (a typo'd path, or a directory not yet
    // created) yields zero files rather than an uncaught ENOENT. Silence
    // here is deliberate: it is the "scanned a non-zero number of files"
    // guard below, not this function, that must be the thing that catches a
    // misconfigured root — an uncaught exception would read like a crash,
    // not like the vacuity guard doing its job.
    return out
  }
  for (const name of entries.sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (SOURCE_EXTENSIONS.some((e) => name.endsWith(e))) out.push(p)
  }
  return out
}

/** Stable, OS-independent label for a scanned file: `render/src/index.ts`. */
function label(file: string): string {
  return relative(PACKAGES_DIR, file).split(sep).join('/')
}

/**
 * Blanks `//` and `/* *\/` comments, preserving every newline so line numbers
 * survive, WITHOUT touching the contents of string or template literals.
 * This is the opposite trade from the determinism scan's `stripNonCode`:
 * there, the banned construct is code and a string merely *mentioning* it
 * must not count, so string contents are blanked too. Here the banned thing
 * — `'@laneways/sim'` — IS a string literal's contents, so blanking it would
 * blind the scan to the exact text it exists to find.
 */
function stripComments(src: string): string {
  const out: string[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i] as string
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      const end = nl === -1 ? src.length : nl
      for (; i < end; i++) out.push(' ')
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      for (; i < stop; i++) out.push(src[i] === '\n' ? '\n' : ' ')
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      out.push(c)
      i++
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') {
          out.push(src[i] as string)
          i++
          if (i < src.length) out.push(src[i] as string)
          i++
          continue
        }
        out.push(src[i] as string)
        i++
      }
      if (i < src.length) {
        out.push(src[i] as string)
        i++
      }
      continue
    }
    out.push(c)
    i++
  }
  return out.join('')
}

/**
 * Matches the three import forms named in the task brief: `from '...'`,
 * `import(...)`, and `require(...)`, each against a specifier that is
 * `@laneways/sim` or `@laneways/shared`, optionally with a deep subpath.
 * Deliberately NOT a global-flagged regex — see determinism.test.ts's own
 * note on why `.test()` on a stateful regex is a bug waiting to happen.
 */
const BANNED_IMPORT_RE = /(?:\bfrom\s*|\b(?:import|require)\s*\(\s*)(['"])@laneways\/(?:sim|shared)(?:\/[^'"]*)?\1/

function scanForBannedImports(text: string): number[] {
  const hitLines: number[] = []
  stripComments(text)
    .split('\n')
    .forEach((line, i) => {
      if (BANNED_IMPORT_RE.test(line)) hitLines.push(i + 1)
    })
  return hitLines
}

describe('render imports nothing from sim or shared', () => {
  const files = sourceFiles(SCAN_ROOT)

  it('scans a non-zero number of render source files', () => {
    // Vacuity guard named in the brief: if SCAN_ROOT were ever pointed at a
    // directory that does not exist (or is empty), every assertion below
    // would pass vacuously on zero files. This is the assertion that turns
    // that silent pass into a caught failure.
    expect(files.length).toBeGreaterThan(0)
  })

  it('contains no import of @laneways/sim or @laneways/shared', () => {
    const hits = files.flatMap((f) =>
      scanForBannedImports(readFileSync(f, 'utf8')).map((line) => `${label(f)}:${line}`),
    )
    expect(hits, `render imported sim/shared:\n${hits.join('\n')}`).toEqual([])
  })
})

describe('the import scan itself works', () => {
  // Fixture strings, not real files — proving the scan CAN fail, per the
  // brief's vacuity requirement ("the scan must be shown to fail on a file
  // that does import one").
  it('fires on a named import from @laneways/sim', () => {
    expect(scanForBannedImports(`import { step } from '@laneways/sim'`)).toEqual([1])
  })

  it('fires on a type-only import from @laneways/shared', () => {
    expect(scanForBannedImports(`import type { MapData } from "@laneways/shared"`)).toEqual([1])
  })

  it('fires on a deep subpath import', () => {
    expect(scanForBannedImports(`import { x } from '@laneways/sim/internal'`)).toEqual([1])
  })

  it('fires on a dynamic import(...)', () => {
    expect(scanForBannedImports(`const m = await import('@laneways/sim')`)).toEqual([1])
  })

  it('fires on require(...)', () => {
    expect(scanForBannedImports(`const m = require('@laneways/shared')`)).toEqual([1])
  })

  it('reports the correct line number for a hit below unrelated lines', () => {
    const src = ["import type { Camera } from './types'", '', `import { step } from '@laneways/sim'`].join('\n')
    expect(scanForBannedImports(src)).toEqual([3])
  })

  it('does not fire on an unrelated relative import', () => {
    expect(scanForBannedImports(`import { Camera } from './types'`)).toEqual([])
  })

  it('does not fire on a mention inside a line comment', () => {
    const src = ["// see @laneways/sim for the reference implementation", "import { x } from './x'"].join('\n')
    expect(scanForBannedImports(src)).toEqual([])
  })

  it('does not fire on a mention inside a block comment', () => {
    const src = ['/**', ' * @laneways/sim is the reference.', ' */', "import { x } from './x'"].join('\n')
    expect(scanForBannedImports(src)).toEqual([])
  })
})
