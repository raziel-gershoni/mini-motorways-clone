# M1e carry-forward

What M1d established that M1e must act on. The SDD workspace ledgers are
git-ignored scratch; this is the part that must survive them.

M1d shipped the chunk-blocking primitive: per-(cell, lane) occupancy, refusal at
cell entry, the anti-deadlock valve, delayed refunds and ghost roads (§5.11),
lane-speed multipliers with a live caller, and ghost rendering. **Cars no longer
pass through each other. A badly-built city visibly jams and its throughput
collapses — and nothing punishes you for it yet. That is M1e's job.**

For how tests fail on this project, read
[`testing-defect-catalogue.md`](testing-defect-catalogue.md) first. It is a
checklist, not a history, and every one of M1d's nine tasks hit at least one
entry in it.

---

## 0. The state of the goldens, and the two re-bless records

**Seven goldens at the close of M1d.** Five inherited (four re-blessed twice
each, for layout only) and two blessed new.

| golden | kind | site | history |
|---|---|---|---|
| `340556353` | state, FNV over the whole buffer | `packages/sim/test/determinism.test.ts:572` | `2413319809` (M1c) → `1729791425` (Task 2) → `340556353` (Task 5) |
| `2076760277` | road-network | `packages/sim/test/rollback.test.ts:709` | `2790151213` (M1c) → `3949962277` (Task 2) → `2076760277` (Task 5) |
| `2942219448` | loop | `packages/sim/test/loop.test.ts:1073` | `3896659943` (M1c) → … (Task 2) → `2942219448` (Task 5) |
| `1178110182` | seed | `packages/game/test/startingCity.test.ts:631` | `2505371110` (M2) → `3576722662` (Task 2) → `1178110182` (Task 5) |
| `252514232` | **field** (`foldedFieldsHash` over `dist`/`dir`) | `packages/sim/test/rollback.test.ts:753` | **never moved, in any milestone** |
| `294084758` | queue fixture | `packages/sim/test/loop.test.ts:2010` | new in Task 6 |
| `3113654132` | multiplier fixture | `packages/sim/test/cars.test.ts:1777` | new in Task 7 |
| `1039862014` | **demo layout** seed | `packages/game/test/demoLayout.test.ts` | new with the demo layout (post-M1d) |

**An EIGHTH golden was blessed after M1d closed, and it moved none of the seven.**
`1039862014` is `hashState` immediately after `seedDemoLayout` on a fresh
`createState('laneways-demo', demoCity())` — a **second map**, `demoCity`, with
its own `id`, so `mapIdHash` cannot collide with `firstCity` and none of the four
whole-buffer digests can see it. `firstCity.ts` and `startingCity.ts` were not
edited. All seven were re-run green by digest in the same suite run that blessed
the eighth, and `demoLayout.test.ts` asserts `1178110182` **in its own file** so
the two live side by side.

**There is deliberately no post-warm-start golden for the demo layout.** A demo
board gets tuned, and a golden that is re-blessed on every tune stops being a
tripwire; its behaviour is pinned as inequalities over a measured 3,000-tick run
instead, with the shipped city as the zero-scoring contrast in the same file.

**Both re-bless licences are spent.** The four whole-buffer digests moved exactly
twice, in the two tasks that changed buffer shape (Task 2: `occupancy`,
`carBlockedTicks`; Task 5: `ghostMask`, `ghostCommitted`), and the structure that
made that safe is worth repeating rather than re-deriving: *a standing re-bless
licence is a window in which a genuine behavioural regression is absorbed as an
expected hash update.* M1d's plan therefore settled the region list early and let
later tasks append behaviour, never shape. **If a golden moves in M1e and the
task did not say it would, stop and report.**

**The field golden `252514232` is a tripwire, not a golden.** It folds `dist` and
`dir`, which live outside the state buffer, so it is immune to layout. If it
moves, a lane-speed term has leaked into `edgeCost` or a region has been
misclassified `FIELD_INPUT`. M1d Task 7 was the first thing to test that sentence
and it did not fire.

**The buffer is now 13,828 bytes, up from 7,908 at M1c — +74.9 %.** See §5.

---

## 1. The board expansion handoff, which M1d DECLINED — and which is now yours

**This is the item most likely to be missed, because it was addressed to M1d in
the imperative in eight files and M1d did not do it.**

M2's deferral table handed board expansion / a real revealed region (§5.1) to
M1d by name. M1d declined it, for two stated reasons: no M1d task needed it, and
a revealed region in state would have been a **third** change to buffer shape in
a milestone that budgeted exactly two.

The comments phrased it as *"M1d owns making it dynamic"*, which reads as
**satisfied** the moment M1d ships. Task 9 repointed every one of them to M1e.
The sites, all verified still open at the close of M1d — `REVEALED_X0/Y0/W/H` are
still frozen literals, `MapData` still carries only `w`/`h`, and nothing in `sim`
knows the word "revealed":

- `packages/shared/src/constants.ts` (the `REVEALED_*` block)
- `packages/shared/src/mapFormat.ts` (`MapData.w`)
- `packages/shared/src/maps/firstCity.ts`
- `packages/render/src/types.ts` (`RevealedRect`)
- `packages/render/src/canvas.ts` — **three** sites: the bottom-band fill, the
  culling note, and the carpark-sentinel equivalence argument
- `packages/game/src/shell.ts` (`ShellDeps.reveal`)
- `packages/shared/test/constants.test.ts`
- `packages/game/test/frame.test.ts` — **three** sites, one of which is a trap
  described below

**Two of those are not just labels and will cost real work:**

- **`canvas.ts`'s culling note.** Buildings and cars are culled by testing their
  anchor cell against the rect, so a building whose anchor is outside is not
  drawn even if its footprint reaches inside. Correct while the rect is frozen
  and M2's seed places everything well inside it. The fix when the rect moves is
  a `clip` around draw phases 3-8.
- **`frame.test.ts`'s two fold markers are diagonal corners**, and that is
  sufficient *only* because the fold is a flat 1-D `for c < cells` loop. **The
  moment the fold becomes 2-D over a dynamic rect the markers stop working** — a
  corner sits past two bounds at once, so extending any single bound by one cell
  reaches nothing and draws nothing. Each of the four half-plane bounds will need
  its own marker, one cell past exactly one of them. This is the M2 Task 5 shape
  that produced seven 0-detector mutants; the note is in the file.

---

## 2. Drawing the two lanes — deferred, and it is not a two-line change

The sim models one lane each way. **The renderer still draws every car on the
cell centreline**, so two cars in opposite lanes visually pass through each
other. Demonstrable in the project's own loop fixture: cars 0 and 1 cross at
x ≈ 13.25 on row 5 between ticks 71 and 72.

The fix is a perpendicular offset of about 0.15 cells in `resolve.ts` —
`(-DY[dir], DX[dir])`, which flips sign with the direction and therefore agrees
with `LANE_OF_DIR` for free. **It is deferred because it is not free:** the offset
rotates at a turn and reverses at the outbound→return flip, which adds rows of
**0.212** and **0.30** cells to `resolve.ts`'s displacement table against its
current supremum of **0.1333**. M2's whole interpolation derivation and the tests
quoting it (`resolve.test.ts:225-236`, `:550`, `frame.test.ts:1055`) must be
re-derived. That is a milestone-sized change to a shipped, carefully-argued piece
of rendering.

---

## 3. The two labelled-inert equivalent mutants

Both are **correct as labelled** and must not be "fixed" by adding a test that
cannot fail. Both stop being inert under a specific, named change.

1. **The rounding direction of the lane-speed multiplier average** (`cars.ts`,
   `laneSpeedMul`). Exactly two averages are reachable — a right angle at a
   junction (583.5) and a sharp turn at a junction (416.5) — and `speedUnits`
   maps each of 583/584 to **192** and each of 416/417 to **137**. So truncate
   and round-half-up are indistinguishable **over the whole reachable set**, not
   over a sample. **It stops being inert the moment `CAR_SPEED_UNITS_PER_TICK` or
   any multiplier constant changes**, which M1e's tuning may well do.
2. **`y < 0` in `stepCell`** (`roads.ts`). With the `x` guards retained, any
   `y ≤ −1` gives `y*w + x ≤ −1`, and both callers reduce every negative to one
   observable. Re-verified exhaustively at M1d: 1,600 geometries × all in-range
   cells × Int32 extremes × 8 directions gave **0 differences in the sign**.
   **Do not tighten either caller's `next < 0` to `next === -1`** to manufacture
   a detector — that satisfies the bullet by strictly weakening two guards.

   Note the raw difference *count* is deliberately not stated. Three independent
   runs gave three different five-digit figures because the total depends
   entirely on which extreme cells are enumerated. Only the sign result is
   load-bearing and only it reproduces.

---

## 4. The two tick-order transpositions, re-measured at the close of M1d and
   **still inert**

`step.ts` runs seven phases. **`1↔2` (the clock advance after input application)
and `2↔3` (inputs after demand) are still 0-detector no-ops**, for exactly one
reason: **no `TickAction` reads `H_TICK`.**

Task 9 re-ran the complete pairwise set — **C(7,2) = 21**, stated as an
enumeration because the historical figure of "13 reorderings" is written down
nowhere and cannot be reproduced from its own description. Both transpositions
scored 0 detectors in 4 of 4 rounds, against 19-75 for every other pair.

**`placeDestination` stamps `destSpawnTick[d]` from `H_TICK`, and M1e's job is to
make building placement a `TickAction`.** The day it does, **both swaps become
real off-by-ones in every destination's first-pin delay at once, and nothing in
the suite catches either.** Whoever adds an action that reads the clock owns
re-deriving those two positions and pinning them. `step.test.ts` carries a
tripwire on the *condition* — it reads `step.ts` and `roads.ts` off disk and pins
both halves — so the person who ends it gets a red test rather than a paragraph.

**Also re-measured and also still inert: `runDispatch`'s colour iteration order.**
Its comment predicted that *"M1d's blocking gives cars a shared resource, at
which point colour order becomes outcome-visible"*. It did not, and Task 9
corrected the comment rather than repointing it: descending scores **0**
detectors. The prediction was wrong about where the shared resource is read —
**blocking is in movement, not dispatch**, `runMovement` iterates by car index,
and dispatch claims no occupancy slot at all. What would actually end it is a
dispatch-time read of a shared non-commutative resource: **M1e's destination
removal is the obvious candidate.**

---

## 5. M3's compression re-measurement, which M1d made materially harder

The state buffer grew **7,908 → 13,828 bytes** in this milestone, **+74.9 %**,
against M3's 4,096-character CloudStorage budget.

The added bytes are one long run of `0xFF` (`occupancy` at rest, `-1`-filled) and
two runs of `0x00` (`ghostMask`, `ghostCommitted`), which is the compressible
case. **M3 must re-measure rather than assume.** The ratio it needs is now
noticeably worse than the one M1c's figure was taken against.

Every rollback, `snapshot`/`restore` and `hashState` now walks 75 % more bytes as
well. Nothing measured a frame or a tick against that; see §7.

---

## 6. What M1d does NOT settle

- **Whether one car per lane-tile feels right.** It is **half** the spec's
  density, on the spec's own two-lane road. Two cars per lane-tile needs sub-cell
  slots whose identity changes at every turn — a second positional system beside
  `carProgress` that must be deterministic, allocation-free and correct across
  the outbound→return flip. M1e's tuning is the first real evidence. **Do not add
  a `CARS_PER_CELL` constant "for later"**: an untested second value is dead code
  that reads as a supported configuration.
- **Whether 1,350 ticks is the right valve.** It is the spec's 45 s at 30 Hz,
  unvalidated in play — and under two lanes it fires far less often than the
  first revision of M1d's plan assumed, so play has *less* evidence about it than
  before, not more. Measured at the close of M1d: on a deliberately starved
  corridor it fires 98 times in 20,000 ticks; on the shipped starting city, never.
- **Intersection crossing conflicts.** Two lanes do not model an intersection. Two
  cars may share a junction cell whenever their directions land in different
  lanes — an eastbound and a northbound car can occupy one cell simultaneously
  and cross paths inside it, and nothing stops them. That is the spec's own model
  (§5.5 prices intersections with a *speed* multiplier and a *wait*, not with
  mutual exclusion) and it is **what M1e's traffic lights and roundabouts are
  for.**
- **Whether the shipped starting city ever jams.** Measured on today's board:
  45,000 ticks over a 14-segment column-8 road gave `maxActive = 1` and zero
  adjacent-opposing events — about 20 % utilisation, six cars, no spawner. That is
  *"head-on is not yet visible on the seeded board"*, not *"head-on is not a
  problem"*. **It changes the day M1e's demand ramp lands.**

---

## 7. Frame cost under a full jam — the one thing nobody has measured

M2's only device evidence is qualitative, from a near-empty board: a human
reports it feels smooth, on one phone, with a handful of cars.

**A hundred queued cars is the first workload whose cost scales with traffic**,
and M1d is the first milestone to make such a workload constructible. The demo
layout now CONSTRUCTS one — 24 cars, 20+ in flight, a car refused entry on 53 %
of ticks — and it is measured for *allocation* (§8) but still not for *frame
time* on a device. Nothing has been measured against one:

- no Android, no `performanceClass: LOW`, no frame timings, at any density;
- the draw path now blits a **second** atlas for ghost cells;
- the state buffer is 75 % larger, which touches `hashState`, `snapshot` and
  every rollback on every frame that takes one.

**Allocation, by contrast, is measured and green** — see §8.

---

## 8. The allocation harnesses, and what they now cover

There are **three**, and confusing them has been a recurring defect:

- `packages/game/test/allocation.test.ts` profiles `packages/game/src` **and**
  `packages/sim/src`. It measures **the tick**.
- `packages/game/test/drawAllocation.test.ts` profiles `packages/render/src`,
  with its own budget and rig. It measures **the frame**.
- `packages/game/test/demoAllocation.test.ts` profiles all three scopes on the
  **demo board** — 24 cars, 18 destinations, 71 road cells. It measures the
  existing frame loop under a **load no other rig produces**, and it is a
  separate file for the same reason `drawAllocation` is: one context shape, one
  profiled rig, because a profiler cannot tell the code under test from the
  harness around it.

**It found something on its first run, and the finding is exactly the shape the
catalogue predicts.** `packages/sim/src/flowfield.ts` charges **16.8-21.8
B/frame** on the demo board across four draws — present in every draw, so a
signal and not a stray — against **1.5-1.8 B/frame** on the shipped starting
city under the identical rig, which is below the 4 B noise floor and is why
every existing harness is green. The difference is field-rebuild frequency: 18
destinations move `destPins` almost every tick, so `syncFields` re-runs
`computeFlowField`, where the starting city (no roads, one pin per 129 ticks)
almost never does.

**It is pre-existing, not introduced.** No `sim` file was touched by the demo
layout; the code is M1b's and only the input is new. Likely mechanism, stated as
a hypothesis because function-level profiler attribution is documented unstable
in this repo: `computeFlowField`'s `push` helper is a closure over the mutable
`top` and `pending`, which V8 boxes into a `Context` — the same shape `loop.ts`'s
known residual has, one level up.

**Owner: M1e, and the evidence lives in `demoAllocation.test.ts`'s
`FLOWFIELD_ALLOWANCE_BYTES_PER_FRAME`.** That allowance asserts the violation is
STILL PRESENT as well as bounded, so fixing it turns the test red and forces the
exemption to be deleted rather than outliving the problem it documents. This is
a named recipient, not "whoever owns the perf budget".

At the close of M1d the tick side has four windows: a clean per-crossing window,
a `completeTrip` window, a ghost treatment/control window, and Task 9's jam
window. Between them every branch M1d added is entered inside a profiled window
**and asserted non-zero**, which is the half that was missing — the plan's
requirement is that *a fixture that stops jamming must turn the harness RED, not
quietly measure less*.

**Three instrument lessons that cost real time and should not be re-learned:**

1. **Know which kind of noise you have before choosing a statistic.** The
   completion and jam windows use a **minimum over three windows**, which defeats
   *independent* stray samples. The ghost window cannot: its artefact is
   ~58 B/tick **correlated on one file per process**, a constant per-event charge
   no window count dilutes, so it uses a **treatment/control delta** with a
   matched rig. A minimum over three correlated draws is just the draw.
2. **A positive control must ESCAPE.** `const __sink = {…}; void __sink` is
   deleted by V8's scalar replacement and reads exactly like a blind harness.
   Every control in these files uses `(globalThis as any).__sink = {…}`.
3. **File-level attribution is stable across runs but NOT across an inline
   boundary.** Task 9's control injected into `noteEntryRefused` (`blocking.ts`)
   and the charge appeared on **`cars.ts`**, because V8 inlines the one-line
   counter bump into `advanceCar`. Budgets are therefore applied per file across
   the whole set of candidate files, so the guard fires whichever one it lands on.

---

## 9. Known residuals, each disclosed rather than hidden

- **`REFUSED_GHOST` is unreachable through `runDispatch` + `runMovement`**, and
  that is a property to record rather than a bug to fix. `advanceCar` asks
  `canEnter` about exactly one cell — the next step of its own committed route —
  and `isCommittedTo` walks that same route from that same cell, so the answer is
  always `true`. Verified by enumeration: 131,930 in-flight shapes gave **zero**
  non-committed next cells. It is a fail-closed guard, exercised directly.
  **Do not delete it on the strength of its own survival.**
- **`isEntryGranted` must not be re-inlined at its call site.** The inlined
  fail-open spelling (`if (outcome === REFUSED_OCCUPIED) return`) is provably a
  0-detector mutant for the reason above; moving the rule into a pure function of
  one enum value is what gives it a test.
- **`assertOccupancyConsistent` has two halves of different strength.**
  Soundness holds unconditionally. **Completeness does not**, and its exception
  set is real: a car that has not crossed on its current leg, and a car displaced
  by the valve. Assert the weaker half only on fixtures where the valve has not
  fired.
- **Deleting all three route-walk bounds together still hangs.** Each is caught
  individually; the compound is irreducible and all three sites say so.
- **No golden covers demand-produced pins.** The loop golden's fixture pre-pins to
  keep `destPins` stable under assertion, so the pin timer is frozen. **Worth
  closing when M1e's authored spawn schedule lands** — this has now been carried
  forward twice.
- **The refund ledger is BUDGET-EXACT, and this was open going into the review.**
  The whole-milestone review ran 25,000 ticks with an erase/re-place cycle every
  700 and found **`tiles + roadCells + ghostCells` constant at 9,999 throughout**,
  with `valves=40`, `maxBlocked=1350`, `ghostTicks=8052`, no starvation, no
  reservation mismatch and no wrap. So a deferred refund is never lost and never
  double-paid — **only its TIMING can be early or late.** M1d's plan left the
  exactness question to M1e; it is answered, and the tile-ledger identity is the
  invariant to assert if anyone touches `settleErasedCell`, `payGhostRefund` or
  `noteGhostDeparture`.
- **The shipped long-run test never erases a road**, so the ghost path has no
  long-horizon coverage *in the suite* — the 25,000-tick evidence above lives in a
  review, not in a test. **M1e should fold the erase/re-place cycle into the
  long-run test** and assert the tile-ledger identity there. A finding whose only
  carrier is a report is the shape this project keeps getting bitten by.

---

## 10. The deploy, and the one thing that is not settable from code

**Verify the artefact, not the command's exit message.** `wrangler deploy` can
print `Success! Uploaded N files` while the deployment never activates and the
previous asset hash keeps being served. `packages/game/scripts/verify-deploy.js`
is the check: it reads a build-unique id minted per build by `vite.config.ts` into
`.build-id`, then makes **two** fetches — `GET /` must carry
`<meta name="laneways-build" content="…">` with that id, and **the module script
the served document actually names** must contain it too. A fresh document
pointing at a stale bundle is a blank board and the first check cannot see it.

**`.build-id` is shared mutable state, and a build-without-deploy produces a
false negative.** Task 9 hit this: `verify-deploy.js` reported *"the deployment
did not activate"* for 40 attempts while the live artefact was correct and
current. The script already warns that crying "did not activate" too early is as
corrosive as reporting success on a stale asset; **a third case belongs beside
those two — the artefact is fine and the EXPECTATION is stale.**

**The cause was found and fixed, and it was not the one recorded here.** Task 9
attributed it to another worker running `pnpm build` without deploying. The real
mechanism is much cheaper and fires constantly: **vitest loads
`packages/game/vite.config.ts` as its own config**, so the build-id plugin was
instantiated on every `vitest run` in that package and Rollup's `closeBundle`
hook wrote a fresh id at the end of the test run. Every `pnpm test` left
`.build-id` ahead of anything that had ever been deployed — including, always,
the test run you do immediately before deploying. Measured by diffing the file
across a single-file test run. The fix is `apply: 'build'` on the plugin, pinned
by `test/toolchain.test.ts`; after it, a full suite run leaves the file
untouched. Recording the last *deployed* id rather than the last *built* one is
still a good idea and is still not implemented.

**Sequencing still matters for anything that writes the file.** Run the suite,
then `pnpm build`, then deploy, then verify — and re-verify rather than
re-building if it reports a mismatch.

**The Telegram Mini App URL is set in @BotFather and is NOT settable through the
Bot API.** `setChatMenuButton` returns `ok: true` and changes nothing. If the URL
must change, **that is a human action** — say so rather than attempting it.

Live at **https://laneways.laneways-spike.workers.dev**.

---

## 11. Routing and movement now disagree, and the fix has a trap waiting in it

**`flowfield.ts` contains zero references to `occupancy`, `carBlockedTicks` or
blocking of any kind.** Verified by grep at the close of M1d. Cars are routed as
if every road were empty, and since M1d they no longer move as if it were.

So a jam does not repel traffic — it attracts it. The field keeps handing every
car the shortest *distance*, which is still the jammed corridor, and each new
arrival lengthens the queue that made it slow. **Nothing in the sim can currently
express "this way is slower because other cars are on it."** That is not a bug
in M1d: routing cost was never in its scope, and it is invisible on the shipped
board, where §6 measured `maxActive = 1`. **It becomes visible the day M1e's
demand ramp lands** — which is the same trigger §6 records for head-on. Expect
both to arrive together.

**When you add the first congestion penalty, read `scratch.ts:43-49` before
writing a line of it.** The bucket queue's `NB = DIAG_COST + 1` is the *exact*
minimum with **zero slack** — an earlier version of that comment read the spread
as 4 and called it headroom, and instrumenting 200 seeded random graphs measured
the true maximum at 14, the full interval. A 3.5× overestimate of room that does
not exist. The specific trap: a penalty applied **inside** `computeFlowField`
rather than through the cost function merges two distances into one bucket, and
the result is **wrong paths and no crash**. A silent failure in the component
whose golden (`252514232`, §0) is a tripwire rather than a golden.

Note also that M1d's intersection penalty is **not** an edge weight — it is a
`laneSpeedMul` applied at movement time — so it set no precedent here and left
`NB` untouched. Yours will be the first thing to actually change edge cost.

## 12. The ghost art is tested but has never been LOOKED AT

`ghostMask` renders through its own atlas pass, and it is not thinly tested:
182 assertions across `atlas.test.ts`, `canvas.test.ts` and `interface.test.ts`.
The automated side is in good shape.

**What is missing is a human.** The last time anyone saw this game on a real
phone was the close of M2 — *before ghost roads existed*. Every visual judgement
in the ghost pass has been made by agents reading the spec:

- the ghost stroke is **half the live road's width** (`atlas.ts:112`), and
- **spec §6's 55–65 % width band was deliberately ruled not to apply**
  (`atlas.ts:120`) on the reasoning that the band is a rule about roads and *"a
  ghost is the absence of one."*

That reasoning is sound and it is still an unvalidated aesthetic call, of the
kind this project has no test for. A half-width dashed ghost may read as an
elegant fade or as a rendering glitch, and **only a person looking at a phone can
tell those apart.** Fold it into the next hardware check alongside §7's frame
cost — one session on a device answers both, and neither has any other route to
an answer.

---

## 13. How to open the demo layout, and why it is not a query parameter

**`t.me/<bot>/<app>?startapp=demo`.** Send yourself that line in Saved Messages
and tap it; send a second message with no `?startapp=` for the shipped city.
Switching board is then tapping a different line in one chat, with no BotFather
edit and no redeploy.

**Why not `?layout=demo`.** A Telegram webview has no address bar, so nothing can
be typed into the URL. Telegram's SDK reads `location.hash` and never
`location.search` — every launch parameter arrives in the fragment — so a query
parameter inside Telegram exists only if it was baked into the Web App URL by
hand. That is also why **`?fallback=1`, this project's documented recovery hatch
for "MainButton reported but never rendered", is unreachable on a phone today.**
`layoutToken` (`packages/game/src/main.ts`) already reads three sources; wiring
`?startapp=fallback` into `preferFallback` would revive that hatch for the cost
of one line, and it is the obvious next thing to do here.

`?layout=demo` on the plain Worker URL still works in mobile Safari, and is the
only path that works under `pnpm dev`.

**A mistyped token throws by name.** `layoutFor` refuses an unknown id rather
than falling back to the shipped city, because a silent fallback is
indistinguishable from "the link did nothing" — which is the exact report this
layout exists to answer.

**And the throw is now caught at the entry point, because it used to take the
whole bundle down.** `main.ts`'s last line was `if (shouldAutoStart())
startGame()` at module scope, so that throw propagated out of the module's own
evaluation: no canvas sizing, no pointer wiring, no erase control, no visibility
handler and no message — a blank page, reachable by a link anyone can send
(`https://<app>/#tgWebAppStartParam=x`), on a device with no console and no
address bar. `startOrReport` wraps the call site and renders a readable panel
carrying the failure, the token and `LAYOUT_IDS`; the throw itself is unchanged
and still loud. `integration.test.ts`'s "a boot that throws puts the reason on
the screen" is the detector, and the irreducible gap is the same two `document`
calls `createFallbackButton` has.


---

## 14. The queue probe was lane-blind, and every figure it produced is corrected

`packages/game/src/queueProbe.ts` — the only instrument in the repo that answers
"how long is the queue" — built its own `Map<cell, car>` keyed by the **cell
alone**, in the milestone whose premise is that a cell carries **two lanes**.
Two in-flight cars legitimately share a `carCell` in opposite directions; the map
kept whichever was written last and linked the follower to it, sometimes to a car
travelling the other way, and dropped the other car entirely so that real chains
broke as well as false ones forming.

It now reads `occupantOf(next, LANE_OF_DIR[dir])` — **the slot `canEnter` itself
consults** — through two exported helpers, `travelDir` and `carAheadOf`, so the
direction derivation and the occupancy lookup each have their own detector.

**Do not "simplify" it back to deriving the lane from the car's own direction of
travel.** That looks equivalent and is not: a car occupies the lane of the
direction it ENTERED by, which differs at every turn and at every
outbound→return flip. Measured, that variant disagrees with `canEnter` on
5.9–10.0 % of questions, and worst where it matters most — on a starved corridor,
where the queue stands behind the car that has just flipped, it read a longest
queue of **11 against a true 16**.

**The evidence is a property, not a number.** `queueProbe.test.ts` and
`demoLayout.test.ts` each drive a real board and assert, for every in-flight car
on every tick, that the probe's answer and `canEnter`'s agree — 90,533
car-questions across the demo board, the jam corridor and the starved corridor,
zero disagreements. The old key disagreed on 5.7–15.2 %.

**Corrected figures. Nothing about the layouts or the sim moved; only the
instrument did.**

| window | figure | was | is |
|---|---|---|---|
| demo, 3,000 ticks from the seed | longest queue | 7 (comment said 8) | **7** |
| demo, 3,000 ticks from the seed | ticks with queue ≥ 3 | 56.6 % | **46.5 %** |
| demo, 900 ticks after the warm start | longest queue | 7 | **7** |
| demo, 900 ticks after the warm start | ticks with queue ≥ 3 | 68.9 % ("69 %") | **55.8 %** |
| demo, 20,000 ticks after the warm start | longest queue | 10 | **8** |
| demo, 20,000 ticks after the warm start | ticks with queue ≥ 3 | 69.3 % ("69 %") | **58.8 %** |
| demo, at the first frame (tick 1,200) | queue standing | 7 | **7** |
| jam corridor, 900 ticks | longest queue | 10 | **13** |
| starved corridor, 900 ticks | longest queue | 12 | **16** |

Note the direction: on the demo board the old probe **over**-reported, and on the
two corridors it **under**-reported. A cell-keyed map does both, because
discarding a car can break a chain as easily as inventing one.

**Everything not read through the probe is unchanged** — trips, dispatches,
refusals, blocked ticks, cars in flight, the valve count, and all eight goldens.
`refusals` and `blockedTicks` are deltas of `carBlockedTicks`, which no probe
touches, so the *other* two figures `demoLayout.test.ts` used to quote (3,483
refusals and 1,563 blocked ticks, against a measured 3,125 and 1,350) were never
this fixture's and were not caused by the probe. Re-measured and re-stated with
their window.

## 15. The demo layout's ghost claim was a guarantee and the behaviour is conditional

`demoLayout.ts`'s fourth headline told a playtester to drag-erase three corridor
cells and watch them fade. Two things were wrong. A drag samples adjacent pairs,
so a stroke over N cells clears both bits off only the **N − 2 in the middle** —
three fading cells wants a five-cell stroke. And *whether* a cleared cell fades
at all depends on the traffic at that instant: `settleErasedCell` ghosts a cell
only if a car's committed route still runs through it, and deletes it outright
otherwise.

Measured on the real boot path over `(8,15)..(8,19)`: **at the first frame a
player sees, all three middle cells are uncommitted**, so the stroke deletes them
and refunds +3 immediately with no ghost at all. Eighteen ticks later all three
are committed, and the identical stroke pays nothing, ghosts all three at
`ghostCommitted = 1`, and the tiles arrive 120 ticks later. Across the 3,000
ticks after the warm start the three cells are committed on 69.8 %, 69.8 % and
89.4 % of ticks, all three at once on 68.2 %, and none of them on 10.6 %.

The prose now states the conditional, and `demoLayout.test.ts` §6 is the
detector — **the first test in the repo that erases anything on the demo board**,
covering both branches and asserting the tile-ledger identity (§9's `tiles +
roadCells + ghostCells`) across the deferral.

---

## 16. TWO CARRIED QUESTIONS, ANSWERED BY A HUMAN ON HARDWARE (2026-08-10)

The user opened the demo board — 24 cars, a car refused entry on ~53 % of ticks, queues forming and
draining — on their phone in Telegram, and reported:

- **Frame cost under a full jam: SMOOTH THROUGHOUT.** §7 asked for exactly this and had no other
  route to an answer. It is one device, qualitative, no numbers, no Android, no
  `performanceClass: LOW` — so it is **evidence the architecture holds at 24 cars, not a measured
  budget.** What it does retire is the fear that cost scaling with traffic was a latent cliff.
  Note the board they ran also carries `flowfield.ts`'s 16.8–21.8 B/frame (§8), so that allocation
  is not perceptible at this density either.
- **The stop/start snap: CONFIRMED ROBOTIC, worth fixing.** A blocked car holds `carProgress`
  bit-identical, so it renders perfectly frozen and then resumes at the full 330 units/tick on the
  granting tick — 0 to 3.96 cells/s across one frame. Predicted from the code before it was seen,
  and the prediction was right the first time a human could observe it. **This is a RENDERER
  concern**: the sim's step function is spec-correct (§5.5 prices speed by geometry) and must not
  change. Fixing it in `sim` would move goldens and buy nothing the player can see.

**Both answers exist only because the default board changed.** Neither question was answerable on
the shipped starting city, which never moves a car. That is the practical argument for §12's rule:
a feature nobody can see is a feature nobody can judge.
