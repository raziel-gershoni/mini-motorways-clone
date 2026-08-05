import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
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
 *
 * Review finding C1: an earlier version of this scan matched only the bare
 * `@laneways/sim`/`@laneways/shared` specifier forms, which are ALSO already
 * rejected by `tsc` (TS2307) under pnpm's strict layout — render has no
 * dependency entry for either package, so the bare specifier never resolves.
 * That made the scan's coverage a subset of typecheck's, and its one real
 * blind spot was the form typecheck accepts: a relative path that walks back
 * out of `render/src` into a sibling package's source tree
 * (`../../sim/src/hash`), which resolves and compiles fine. `BANNED_IMPORT_RE`
 * below now matches that form too, plus a bare side-effect import
 * (`import '@laneways/sim'`, no `from`, no parens — review finding I3), and
 * scans the whole file rather than one line at a time, so a `from` clause
 * split across lines cannot evade it either.
 */

const PACKAGES_DIR = fileURLToPath(new URL('../..', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
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
    // here is deliberate: it is the "scans exactly the known files" guard
    // below, not this function, that must be the thing that catches a
    // misconfigured root — an uncaught exception would read like a crash,
    // not like the vacuity guard doing its job.
    return out
  }
  for (const name of entries.sort()) {
    const p = join(dir, name)
    // M9: `statSync` gets its own try, separate from `readdirSync`'s above.
    // A dangling symlink (or a file removed between the `readdirSync` and
    // this `statSync`) throws ENOENT here specifically, a different failure
    // point than a missing root, and one the outer try above never reached.
    let isDirectory: boolean
    try {
      isDirectory = statSync(p).isDirectory()
    } catch {
      continue // skip the unreadable entry rather than crashing the walk
    }
    if (isDirectory) out.push(...sourceFiles(p))
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
 * Matches every import form named in the brief (`from '...'`, `import(...)`,
 * `require(...)`) plus two evasions review found by probing with real files:
 * a bare side-effect import (`import '...'`, no `from`, no parens — I3) and
 * a `from` keyword whose quoted specifier sits on a later line. And it
 * matches two specifier shapes: the bare workspace specifier
 * (`@laneways/sim`, optionally with a deep subpath) and a relative escape
 * that walks out of `render/src` into a sibling package's tree
 * (`../../sim/src/...`, any depth of `../`, any number of intermediate
 * segments) — C1's fix, the one form `tsc` does not already reject.
 *
 * The relative alternative requires the LITERAL segment `sim/` or `shared/`
 * (trailing slash included), not a substring match, so `../simulation/x` and
 * `../shared-utils/x` do not false-positive — see the negative fixtures
 * below.
 *
 * Global-flagged and walked with `matchAll`, never `.test()`/`.exec()`.
 * `matchAll` takes its own snapshot of position state per call and cannot
 * leak between scans of different strings, unlike the stateful-`.test()`
 * footgun `determinism.test.ts`'s own meta-test guards against by staying
 * non-global. The `g` flag is required here — unlike the sim scan — because
 * a match can now start mid-string after a multi-line `from` clause, so the
 * text can no longer be split into independent lines before testing.
 */
const BANNED_IMPORT_RE =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])(?:@laneways\/(?:sim|shared)(?:\/[^'"]*)?|\.\.\/(?:[^'"]*\/)?(?:sim|shared)\/[^'"]*)\1/g

function lineNumberAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++
  return line
}

function scanForBannedImports(text: string): number[] {
  const stripped = stripComments(text)
  const hits: number[] = []
  for (const match of stripped.matchAll(BANNED_IMPORT_RE)) {
    hits.push(lineNumberAt(stripped, match.index ?? 0))
  }
  return hits
}

describe('render imports nothing from sim or shared', () => {
  const files = sourceFiles(SCAN_ROOT)

  it('scans exactly the known render source files, not some other or empty directory', () => {
    // I4: replaces a bare `files.length > 0` guard, which is satisfied by
    // ANY single file and cannot tell "the right two files" from "one
    // unrelated file" — it would not have caught SCAN_ROOT quietly pointing
    // one level too high, or too low. This is `determinism.test.ts`'s own
    // "scans the sim and shared sources, not some other directory" idiom:
    // the list must be updated deliberately when a later task adds a file.
    expect(files.map(label).sort()).toEqual([
      'render/src/atlas.ts', // M2 Task 4
      'render/src/camera.ts',
      'render/src/index.ts',
      'render/src/palette.ts',
      'render/src/types.ts',
    ])
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

  // --- C1: the relative-escape form tsc does not reject ---------------------
  // Not redundant with the bare-specifier fixtures above: those match
  // `@laneways/sim` as a literal specifier text, which resolves through the
  // pnpm-managed `@laneways` namespace and is rejected by `tsc` on its own
  // (render has no dependency entry for either package) whenever the scan
  // itself is bypassed. A relative path never goes through that namespace at
  // all, so it is the one specifier shape neither `tsc` nor the old regex
  // could see — this is the case the review's real-file probe found live.

  it('fires on a two-level relative escape into sim (the exact case the review probe found)', () => {
    expect(scanForBannedImports(`import { hashInt32 } from '../../sim/src/hash'`)).toEqual([1])
  })

  it('fires on a deeper relative escape into shared, proving both packages are covered by this form', () => {
    expect(
      scanForBannedImports(`import { GRID_W } from '../../../packages/shared/src/constants'`),
    ).toEqual([1])
  })

  it('does not fire on a relative import that merely CONTAINS "sim" as a substring, not as a path segment', () => {
    // Guards the literal `sim/`/`shared/` requirement (trailing slash) against
    // over-matching: "simulation" starts with "sim" but is not the sim package.
    expect(scanForBannedImports(`import { x } from '../simulation/foo'`)).toEqual([])
  })

  it('does not fire on a relative import that merely CONTAINS "shared" as a substring, not as a path segment', () => {
    expect(scanForBannedImports(`import { x } from '../shared-utils/x'`)).toEqual([])
  })

  // --- I3: the bare side-effect import, no `from`, no parens ----------------
  // Not redundant with the `from`/`import(`/`require(` fixtures above: those
  // all require one of three specific prefixes this form has none of. A bare
  // `import '...'` is valid TypeScript that really loads the module, and is
  // its own alternative in `BANNED_IMPORT_RE`, not a variant of an existing one.

  it('fires on a bare side-effect import with no from clause', () => {
    expect(scanForBannedImports(`import '@laneways/sim'`)).toEqual([1])
  })

  it('does not mistake an ordinary default import (has a from clause) for the bare-side-effect form', () => {
    // Regression guard for the alternative added for I3: `import X from '...'`
    // must still be judged solely by its `from`-clause specifier, never by the
    // new "import directly followed by whitespace" alternative — `Camera`
    // sits between `import` and the quote, which the bare-side-effect
    // alternative's `\s+` cannot skip over.
    expect(scanForBannedImports(`import Camera from './camera'`)).toEqual([])
  })

  // --- the from-clause-on-a-later-line evasion -------------------------------
  // Not redundant with "reports the correct line number" above: that fixture
  // has the violation entirely on one line, after unrelated lines — this one
  // splits a SINGLE logical import statement across two lines, which the old
  // per-line `.split('\n')` scan could never see even with a correct regex,
  // because the `from` keyword and the quoted specifier were never in the
  // same string being tested.

  it('fires when the from clause and its specifier are on different lines', () => {
    // The match starts at `from` itself (line 3, where the `from` keyword
    // sits), not at the specifier's own line (4) — what matters for this
    // fixture is that it fires AT ALL, which a per-line scan structurally
    // could not do: `from` and the quoted specifier never share one line.
    const src = ['import {', '  step,', '} from', `  '@laneways/sim'`].join('\n')
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

/**
 * I4: `render/src` holds two flat `.ts` files today, so the recursion branch
 * in `sourceFiles` and three of `SOURCE_EXTENSIONS`' four entries were never
 * exercised by anything scanning the real tree — review confirmed both
 * "disable recursion" and "narrow to ['.ts']" left 11/11 green. These are
 * real filesystem fixtures against `sourceFiles` itself, distinct from every
 * fixture above: those all exercise `scanForBannedImports` on in-memory
 * strings and never touch the directory walk.
 */
function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'boundary-walk-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the file walk itself: recursion, every declared extension, and a dangling symlink', () => {
  it('walks into a nested subdirectory, not just the top level', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'top.ts'), 'export {}')
      mkdirSync(join(dir, 'sub'), { recursive: true })
      writeFileSync(join(dir, 'sub', 'nested.ts'), 'export {}')

      const found = sourceFiles(dir)
        .map((f) => relative(dir, f).split(sep).join('/'))
        .sort()
      expect(found).toEqual(['sub/nested.ts', 'top.ts'])
    })
  })

  it('matches every declared extension and ignores an undeclared one', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'a.ts'), 'export {}')
      writeFileSync(join(dir, 'b.mts'), 'export {}')
      writeFileSync(join(dir, 'c.cts'), 'export {}')
      writeFileSync(join(dir, 'd.js'), 'export {}')
      writeFileSync(join(dir, 'e.md'), '# not a source file')

      const found = sourceFiles(dir)
        .map((f) => relative(dir, f).split(sep).join('/'))
        .sort()
      expect(found).toEqual(['a.ts', 'b.mts', 'c.cts', 'd.js'])
    })
  })

  it('does not crash on a dangling symlink — it skips the entry (M9)', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'real.ts'), 'export {}')
      symlinkSync(join(dir, 'does-not-exist.ts'), join(dir, 'dangling.ts'))

      let found: string[] = []
      expect(() => {
        found = sourceFiles(dir)
          .map((f) => relative(dir, f).split(sep).join('/'))
          .sort()
      }, 'sourceFiles crashed on a dangling symlink instead of skipping it').not.toThrow()
      expect(found).toEqual(['real.ts'])
    })
  })
})

/**
 * I2: the script-presence check in `packages/game/test/toolchain.test.ts`
 * lives inside `game`'s own suite, so deleting `game`'s "test" script makes
 * root `pnpm test` silently skip `game` — deleting the detector along with
 * the thing it was watching. Mirrored here so each package's suite guards
 * the OTHER: `render`'s suite catches `game` losing its script, and vice
 * versa. This closes both single-package cases; only removing BOTH
 * packages' scripts in the same edit survives, since then neither suite
 * runs to report it.
 */
interface PackageJsonWithScripts {
  readonly scripts?: Readonly<Record<string, string>>
}

function readPackageJsonAt(absolutePath: string): PackageJsonWithScripts {
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8')) as PackageJsonWithScripts
  } catch {
    // M8: a missing or unparsable package.json degrades to "no scripts"
    // rather than an uncaught ENOENT/SyntaxError, so the caller's own
    // `scripts.test`/`scripts.typecheck` assertion is what names the
    // failure — same shape as `sourceFiles`' missing-root guard above.
    return {}
  }
}

function readPackageJson(pkg: 'render' | 'game'): PackageJsonWithScripts {
  return readPackageJsonAt(join(REPO_ROOT, 'packages', pkg, 'package.json'))
}

describe('readPackageJsonAt degrades gracefully instead of crashing (M8)', () => {
  it('does not throw on a path that does not exist, and returns no scripts', () => {
    const missing = join(REPO_ROOT, 'packages', 'render', 'package.json.DOES-NOT-EXIST')
    let result: PackageJsonWithScripts = {}
    expect(() => {
      result = readPackageJsonAt(missing)
    }, 'readPackageJsonAt crashed on a missing file instead of degrading').not.toThrow()
    expect(result).toEqual({})
  })
})

describe('both new packages declare test and typecheck scripts, checked directly, from BOTH suites', () => {
  // The root scripts run `pnpm -r --filter './packages/*' --filter
  // './tools/*' test` (and `typecheck`), with no `--if-present`. The brief's
  // stated detector for a missing script was "caught by the root test
  // script reaching it" — but `pnpm help recursive` documents `run`'s real
  // semantics: "If a package doesn't have the command, it is skipped. If
  // NONE of the packages have the command, the command fails." Verified
  // live: removing "test" from either package's package.json still leaves
  // root `pnpm test` exiting 0, because the others still have theirs — pnpm
  // silently skips the one missing it rather than failing the run. This
  // direct check — reading each package's own package.json — is what
  // actually enforces it, independent of how many sibling packages happen
  // to have the script, and it is hosted in BOTH `render` and `game`'s
  // suites (see the module comment above) so removing one package's script
  // does not also remove the check that would have caught it.
  for (const pkg of ['render', 'game'] as const) {
    it(`packages/${pkg}/package.json declares a "test" script`, () => {
      const scripts = readPackageJson(pkg).scripts ?? {}
      expect(scripts.test, `packages/${pkg}/package.json has no "test" script`).toBeDefined()
    })

    it(`packages/${pkg}/package.json declares a "typecheck" script`, () => {
      const scripts = readPackageJson(pkg).scripts ?? {}
      expect(scripts.typecheck, `packages/${pkg}/package.json has no "typecheck" script`).toBeDefined()
    })
  }
})
