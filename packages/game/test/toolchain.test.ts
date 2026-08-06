import { describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/**
 * `eslint.config.js` had exactly one `files:` block, scoped to
 * `packages/sim/src/**` and `packages/shared/src/**`, with
 * `tseslint.configs.recommended` inside it. Adding `packages/render` and
 * `packages/game` the obvious way gives them NO linting at all, and
 * `pnpm lint` keeps exiting 0 — this project's signature defect shape
 * (a check that appears to cover something and does not) applied to the
 * toolchain itself.
 *
 * This asserts, via ESLint's own config resolution (not by re-reading the
 * config file's text, which would just restate its structure), that a
 * second `files:` block actually reaches both new packages with the
 * recommended TypeScript rules — and, symmetrically, that it does NOT carry
 * the determinism rules that are specific to `sim`/`shared`.
 *
 * *What else could make the positive half pass:* some unrelated default
 * config applying to every file regardless of package. Distinguishing
 * "covered by the right block" from "covered by anything" is exactly what
 * the negative assertions below are for: a `sim` source file must show the
 * `determinism/*` rules (proving the block those rules live in is real and
 * reachable), and a `render`/`game` source file must NOT show them (proving
 * render/game are covered by a *different, narrower* block, not by the sim
 * block accidentally widened to include them, and not by some ambient
 * config that would light up on any file at all).
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const CONFIG_FILE = join(REPO_ROOT, 'eslint.config.js')

// Rule names guaranteed present by `tseslint.configs.recommended` — verified
// live against this repo's installed typescript-eslint version. Stable
// enough to assert on directly rather than diffing the whole resolved rule
// set, which would break on every unrelated eslint upgrade.
const RECOMMENDED_MARKER_RULES = ['@typescript-eslint/no-unused-vars', '@typescript-eslint/no-explicit-any']

const DETERMINISM_MARKER_RULE = 'determinism/no-module-mutable-state'
const RESTRICTED_GLOBALS_RULE = 'no-restricted-globals'
const RESTRICTED_PROPERTIES_RULE = 'no-restricted-properties'
const RESTRICTED_SYNTAX_RULE = 'no-restricted-syntax'

async function configForRepoFile(relativePath: string) {
  // A fresh ESLint instance per call: calculateConfigForFile is documented
  // as pure with respect to the path argument, and a shared instance across
  // `it()` blocks would risk one test's config computation being confused
  // for another's if either ever mutated instance state.
  const eslint = new ESLint({ cwd: REPO_ROOT, overrideConfigFile: CONFIG_FILE })
  return eslint.calculateConfigForFile(join(REPO_ROOT, relativePath))
}

describe('packages/render and packages/game are covered by a real eslint block', () => {
  it('packages/render/src/index.ts resolves to a config at all', async () => {
    const config = await configForRepoFile('packages/render/src/index.ts')
    expect(config, 'no files: block in eslint.config.js matches packages/render/src — the gap is back').toBeDefined()
  })

  it('packages/render/src/index.ts is covered by the recommended TypeScript rules', async () => {
    const config = await configForRepoFile('packages/render/src/index.ts')
    for (const rule of RECOMMENDED_MARKER_RULES) {
      expect(config?.rules?.[rule], `missing recommended rule ${rule} for packages/render/src`).toBeDefined()
    }
  })

  it('packages/render/test/boundary.test.ts is also covered (the test glob, not just src)', async () => {
    const config = await configForRepoFile('packages/render/test/boundary.test.ts')
    expect(config, 'no files: block matches packages/render/test').toBeDefined()
    for (const rule of RECOMMENDED_MARKER_RULES) {
      expect(config?.rules?.[rule], `missing recommended rule ${rule} for packages/render/test`).toBeDefined()
    }
  })

  it('packages/game/src/index.ts resolves to a config at all', async () => {
    const config = await configForRepoFile('packages/game/src/index.ts')
    expect(config, 'no files: block in eslint.config.js matches packages/game/src — the gap is back').toBeDefined()
  })

  it('packages/game/src/index.ts is covered by the recommended TypeScript rules', async () => {
    const config = await configForRepoFile('packages/game/src/index.ts')
    for (const rule of RECOMMENDED_MARKER_RULES) {
      expect(config?.rules?.[rule], `missing recommended rule ${rule} for packages/game/src`).toBeDefined()
    }
  })

  it('packages/game/test/toolchain.test.ts is also covered (the test glob, not just src)', async () => {
    const config = await configForRepoFile('packages/game/test/toolchain.test.ts')
    expect(config, 'no files: block matches packages/game/test').toBeDefined()
    for (const rule of RECOMMENDED_MARKER_RULES) {
      expect(config?.rules?.[rule], `missing recommended rule ${rule} for packages/game/test`).toBeDefined()
    }
  })

  // I5: an earlier version of the glob covered `src/**` and `test/**` only,
  // so a package-ROOT file (not under either) was unlinted — and the plan
  // puts one there: `packages/game/vite.config.ts` (tech-stack line: "vite
  // and wrangler are added as devDependencies of packages/game for build and
  // deploy only"). Neither of these two paths exists yet — Task 9 adds
  // `vite.config.ts` — but `calculateConfigForFile` only matches the path
  // string against the glob, so this pins the glob shape now rather than
  // waiting for Task 9 to discover the gap. Not redundant with the src/test
  // assertions above: those all sit one directory level deeper, exactly the
  // level the narrower `src/**`/`test/**` globs already covered.
  it('a package-root file for game (e.g. vite.config.ts) is covered too, not just src/test', async () => {
    const config = await configForRepoFile('packages/game/vite.config.ts')
    expect(config, 'no files: block matches a package-root file under packages/game').toBeDefined()
    for (const rule of RECOMMENDED_MARKER_RULES) {
      expect(config?.rules?.[rule], `missing recommended rule ${rule} for a package-root game file`).toBeDefined()
    }
  })

  it('a package-root file for render is covered too, not just src/test', async () => {
    const config = await configForRepoFile('packages/render/some-root-level-file.ts')
    expect(config, 'no files: block matches a package-root file under packages/render').toBeDefined()
    for (const rule of RECOMMENDED_MARKER_RULES) {
      expect(config?.rules?.[rule], `missing recommended rule ${rule} for a package-root render file`).toBeDefined()
    }
  })

  it('a packages/sim/src file IS covered by the determinism rules — the block those rules actually live in', async () => {
    const config = await configForRepoFile('packages/sim/src/state.ts')
    expect(config?.rules?.[DETERMINISM_MARKER_RULE], 'sim lost its determinism coverage').toBeDefined()
    expect(config?.rules?.[RESTRICTED_GLOBALS_RULE]).toBeDefined()
  })

  it('a packages/shared/src file IS covered by the determinism rules too', async () => {
    const config = await configForRepoFile('packages/shared/src/constants.ts')
    expect(config?.rules?.[DETERMINISM_MARKER_RULE], 'shared lost its determinism coverage').toBeDefined()
  })

  it('packages/render/src is NOT covered by the determinism rules', async () => {
    const config = await configForRepoFile('packages/render/src/index.ts')
    expect(config?.rules?.[DETERMINISM_MARKER_RULE], 'render must not be inside the determinism boundary').toBeUndefined()
    expect(config?.rules?.[RESTRICTED_GLOBALS_RULE], 'render legitimately uses document/performance').toBeUndefined()
    expect(config?.rules?.[RESTRICTED_PROPERTIES_RULE], 'render legitimately uses Math.random/sin/cos').toBeUndefined()
    expect(config?.rules?.[RESTRICTED_SYNTAX_RULE]).toBeUndefined()
  })

  it('packages/game/src is NOT covered by the determinism rules', async () => {
    const config = await configForRepoFile('packages/game/src/index.ts')
    expect(config?.rules?.[DETERMINISM_MARKER_RULE], 'game must not be inside the determinism boundary').toBeUndefined()
    expect(config?.rules?.[RESTRICTED_GLOBALS_RULE], 'game legitimately uses document/performance').toBeUndefined()
    expect(config?.rules?.[RESTRICTED_PROPERTIES_RULE], 'game legitimately uses Math.random').toBeUndefined()
    expect(config?.rules?.[RESTRICTED_SYNTAX_RULE]).toBeUndefined()
  })
})

interface PackageJson {
  readonly scripts?: Readonly<Record<string, string>>
}

function readPackageJsonAt(absolutePath: string): PackageJson {
  try {
    return JSON.parse(readFileSync(absolutePath, 'utf8')) as PackageJson
  } catch {
    // M8: a missing or unparsable package.json degrades to "no scripts"
    // rather than an uncaught ENOENT/SyntaxError, so the caller's own
    // `scripts.test`/`scripts.typecheck` assertion is what names the
    // failure — the same design as `boundary.test.ts`'s `sourceFiles`.
    return {}
  }
}

function readPackageJson(pkg: 'render' | 'game'): PackageJson {
  return readPackageJsonAt(join(REPO_ROOT, 'packages', pkg, 'package.json'))
}

describe('readPackageJsonAt degrades gracefully instead of crashing (M8)', () => {
  it('does not throw on a path that does not exist, and returns no scripts', () => {
    const missing = join(REPO_ROOT, 'packages', 'game', 'package.json.DOES-NOT-EXIST')
    let result: PackageJson = {}
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
  // silently skips the one missing it rather than failing the run.
  //
  // I2: this exact block is ALSO hosted in `packages/render/test/boundary.test.ts`,
  // deliberately duplicated rather than shared, because a detector that
  // lives only inside the suite it protects cannot see that suite being
  // switched off — deleting `game`'s "test" script would silently delete
  // this check too if it lived only here. Hosting it in both suites means
  // either package losing its script is caught by the OTHER package's
  // suite; only removing both packages' scripts in the same edit survives,
  // since then neither suite runs to report it.
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

describe('the root "lint" script is not silently narrowed (M7)', () => {
  // The proof above is `calculateConfigForFile` against an explicit
  // `overrideConfigFile`, which is independent of how `pnpm lint` itself is
  // invoked — narrowing the root script to `eslint packages/sim` would leave
  // every test above green while `pnpm lint` stopped covering render/game
  // for real. This pins the invocation itself.
  it('the root package.json "lint" script is "eslint ." — the whole repo, not a narrowed scope', () => {
    const rootPkg = readPackageJsonAt(join(REPO_ROOT, 'package.json')) as { scripts?: Record<string, string> }
    expect(rootPkg.scripts?.lint).toBe('eslint .')
  })
})

/**
 * **The root scripts reach five packages, and none of them shadows another.**
 *
 * Task 9's own coverage bullet, and the thing that replaced the plan's deleted
 * "the sim's four goldens are unchanged by anything in `game` or `render`" —
 * which could not fail, because `packages/sim/test/loop.test.ts` already reads
 * the golden literals off disk on every run and no code path in the new packages
 * can reach a sim golden.
 *
 * This one CAN fail. The root scripts are
 * `pnpm -r --filter './packages/*' --filter './tools/*' <script>`, and `pnpm -r
 * run` matches by **directory glob** but resolves by **package name**: two
 * workspace packages sharing a `name` is not an error at install time and the
 * second silently shadows the first in every dependent's `node_modules`. With
 * four `@laneways/*` packages sharing a prefix, a copy-pasted `package.json` is
 * one keystroke away from it, and the symptom is a suite that still exits 0
 * while one package's sources are never imported by anybody.
 */
describe('the workspace resolves every package distinctly, and the root scripts reach all of them', () => {
  const PROJECTS = [
    'packages/shared',
    'packages/sim',
    'packages/render',
    'packages/game',
    'tools/eslint-rules',
  ] as const

  it('every workspace package has a DISTINCT name', () => {
    const names = PROJECTS.map(
      (dir) => (readPackageJsonAt(join(REPO_ROOT, dir, 'package.json')) as { name?: string }).name,
    )
    // Vacuity: five real names, not five `undefined`s from a mistyped path.
    for (const [i, name] of names.entries()) {
      expect(name, `${PROJECTS[i]}/package.json has no "name"`).toBeTruthy()
    }
    expect(new Set(names).size, `duplicate package names: ${names.join(', ')}`).toBe(PROJECTS.length)
  })

  it('every workspace package declares the two scripts the root scripts run', () => {
    // `pnpm -r run` SKIPS a package with no such script and fails only if NONE
    // has it — verified live in this file's earlier block. So a package can ship
    // with zero tests and a green CI, and the only detector is reading each
    // package.json directly. The `render`/`game` pair is asserted above and
    // duplicated into `boundary.test.ts`; this is the same check widened to the
    // two packages that predate this milestone plus the eslint rules.
    for (const dir of PROJECTS) {
      const scripts = readPackageJsonAt(join(REPO_ROOT, dir, 'package.json')).scripts ?? {}
      expect(scripts.test, `${dir} has no "test" script`).toBeDefined()
      expect(scripts.typecheck, `${dir} has no "typecheck" script`).toBeDefined()
    }
  })

  it('the root scripts still filter on both globs, so neither tree is dropped', () => {
    const root = readPackageJsonAt(join(REPO_ROOT, 'package.json'))
    for (const script of ['test', 'typecheck'] as const) {
      const value = root.scripts?.[script] ?? ''
      expect(value, `root "${script}" no longer covers packages/*`).toContain("'./packages/*'")
      expect(value, `root "${script}" no longer covers tools/*`).toContain("'./tools/*'")
    }
  })

  it('packages/game declares the build and deploy toolchain as DEV dependencies only', () => {
    // The Global Constraint is **zero runtime dependencies**. `vite` and
    // `wrangler` exist for `pnpm build` and `pnpm deploy` and must never be
    // reachable from a `dependencies` graph, or the claim stops being true the
    // first time somebody bundles the package.
    const pkg = readPackageJsonAt(join(REPO_ROOT, 'packages', 'game', 'package.json')) as {
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    expect(Object.keys(pkg.devDependencies ?? {}).sort()).toEqual(['vite', 'wrangler'])
    // Every runtime dependency is a workspace sibling — no third-party code at all.
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      expect(range, `${name} is not a workspace dependency`).toMatch(/^workspace:/)
    }
    expect(pkg.scripts?.build).toBe('vite build')
    expect(pkg.scripts?.deploy).toContain('wrangler deploy')
  })

  it('the deployed Worker is OURS and does not repoint the M0 spike', () => {
    // Plan Decision 10. `spike/wrangler.jsonc` is `laneways-spike`, is still
    // deployed, and still accepts `POST /api/result` into a live D1 database;
    // `wrangler deploy` keys on `name`, so sharing one would replace it.
    // `spike/` is also outside this workspace and outside `eslint.config.js`'s
    // scope, so nothing else in this suite would notice.
    // Read as CONFIG, not as text: both files are JSONC and this one explains
    // itself at length in `//` comments, which name `laneways-spike` in prose.
    // Asserting over the raw bytes would make the negative below true only until
    // somebody documented why it is there.
    const strip = (jsonc: string): string =>
      jsonc
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n')
    const ours = strip(readFileSync(join(REPO_ROOT, 'packages', 'game', 'wrangler.jsonc'), 'utf8'))
    const spike = strip(readFileSync(join(REPO_ROOT, 'spike', 'wrangler.jsonc'), 'utf8'))
    expect(ours).toContain('"name": "laneways"')
    expect(spike).toContain('"name": "laneways-spike"')
    expect(ours, 'this config names the spike — deploying it would REPLACE it').not.toContain(
      'laneways-spike',
    )
    // Vacuity: the stripper must not have eaten the file. Both configs still
    // parse as JSON once the comments are gone, and both still declare a name.
    expect((JSON.parse(ours) as { name: string }).name).toBe('laneways')
    expect((JSON.parse(spike) as { name: string }).name).toBe('laneways-spike')
    // Static assets only: no Worker script and no database binding.
    expect(ours, 'a static-asset deploy must declare no `main`').not.toMatch(/"main"\s*:/)
    expect(ours, 'M2 stores nothing; D1 is M3').not.toContain('d1_databases')
    expect(spike, 'the spike is the one with the D1 binding, and must keep it').toContain('d1_databases')
  })

  it('the no-store rule ships, on both URLs for the one document', () => {
    // Spec §8.5: Telegram Desktop caches Mini App bundles somewhere its own
    // cache-clear does not reach, and `index.html` is the only file in the build
    // whose URL never changes. Vite copies `public/` verbatim into `dist/`.
    const headers = readFileSync(join(REPO_ROOT, 'packages', 'game', 'public', '_headers'), 'utf8')
    const rules = headers
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    expect(rules).toMatch(/^\/\s*\n\s+Cache-Control: no-store, must-revalidate/m)
    expect(rules).toMatch(/^\/index\.html\s*\n\s+Cache-Control: no-store, must-revalidate/m)
  })
})
