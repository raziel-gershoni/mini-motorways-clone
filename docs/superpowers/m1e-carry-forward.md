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
and M1d is the first milestone to make such a workload constructible. Nothing has
been measured against one:

- no Android, no `performanceClass: LOW`, no frame timings, at any density;
- the draw path now blits a **second** atlas for ghost cells;
- the state buffer is 75 % larger, which touches `hashState`, `snapshot` and
  every rollback on every frame that takes one.

**Allocation, by contrast, is measured and green** — see §8.

---

## 8. The allocation harnesses, and what they now cover

There are **two**, and confusing them has been a recurring defect:

- `packages/game/test/allocation.test.ts` profiles `packages/game/src` **and**
  `packages/sim/src`. It measures **the tick**.
- `packages/game/test/drawAllocation.test.ts` profiles `packages/render/src`,
  with its own budget and rig. It measures **the frame**.

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
false negative.** Task 9 hit this: another worker ran `pnpm build` in the shared
checkout without deploying, and `verify-deploy.js` then reported *"the deployment
did not activate"* for 40 attempts while the live artefact was correct and
current. The script already warns that crying "did not activate" too early is as
corrosive as reporting success on a stale asset; **a third case belongs beside
those two — the artefact is fine and the EXPECTATION is stale.** The fix is to
record the last *deployed* id rather than only the last *built* one.

**The Telegram Mini App URL is set in @BotFather and is NOT settable through the
Bot API.** `setChatMenuButton` returns `ok: true` and changes nothing. If the URL
must change, **that is a human action** — say so rather than attempting it.

Live at **https://laneways.laneways-spike.workers.dev**.
