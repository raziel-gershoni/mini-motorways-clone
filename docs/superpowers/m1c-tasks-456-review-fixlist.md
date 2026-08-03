# M1c Tasks 4-6 — pre-dispatch review fix list

Scope: Task 4 (including 4a), Task 5, Task 6 of `docs/superpowers/plans/2026-08-03-m1c-trip-loop.md`.
Three lenses (mechanism, drift, coverage), every finding attacked by an independent refuter. This is the
merged, deduplicated list.

---

## 1. Verdict

**Safe to execute — no Critical survived refutation.** The mechanisms work: no deadlock, no missing
return leg, no unspecified decision point that stops an implementer. What is broken is the *verification
story* — nine listed mutations survive the coverage the plan pairs them with, and one Global Constraint
has no legal home in Task 4's Files list. Apply the nine Importants before dispatching; every one is a
plan-text edit, none changes a mechanism.

Counts: **0 Critical · 9 Important · 7 Minor.**

---

## 2. Criticals

None. All four Criticals raised by the lenses were downgraded on refutation, for the same reason in each
case: the plan's *production* prose is unambiguous and correct, so executing it yields working code. The
defects are in the fixtures and mutation lists that are supposed to prove it works. Two of the four
(`nearest ≡ own`, deferred reservation) are nonetheless the highest-value items on this list and appear
first under Importants.

---

## 3. Importants

### I1. The Task 6 fixture still cannot see "return to the nearest house" — nearest is *still* ≡ own
**Lenses: mechanism + coverage (independent).** Plan §"The end-to-end test", fixture bullets (lines
653-656), coverage bullet line 670, mutation line 672.

**What breaks.** The plan's own indictment of the previous fixture is *"'return to the nearest house' is
invisible because nearest ≡ own — the plan's own listed mutation survived the plan's own fixture."* The
rewrite answers it with "≥ 2 houses at genuinely different route costs". That does not answer it.
Dispatch selects `argmin dist[houseCell]`, and `dist` is the cost to the *nearest* pinned destination —
so on the **first dispatch of any tick** the dispatching house is, by a two-line proof, the nearest
colour-c house to the destination its walk terminates at. Adding houses cannot break that. Divergence
requires a *later* iteration of the same tick's loop, i.e. two concurrent unreserved pins on distinct
destinations, which no fixture bullet requires and which the natural pin cadence forbids.

**Witness.** Two colour-0 squares → `slotCount = 2` → a fire every `518 / 2 = 259` eligible ticks, first
at tick 378 (`destSpawnTick = 0`, eligible from 120, `acc = 2(t-119) ≥ 518 ⟺ t ≥ 378`). A ~10-cell round
trip is `2 × ceil(25000/330) ≈ 152` ticks. Trips never overlap; exactly one pin is ever outstanding;
every trip departs from and returns to the near house. The mutation is an unconditional no-op.

**Fix — append to the fixture bullets:**

> - **At least one completed, scored trip must depart from and return to the house that is *not* nearest
>   to its own destination.** Construct it with two unreserved pins live on the same tick at distinct
>   same-colour destinations `d1`, `d2`, and a cost matrix satisfying
>   `cost(H1,d1) < cost(H1,d2) < cost(H0,d2) < cost(H0,d1)` — e.g. 10, 20, 30, 40 with `H1` the nearer
>   house at the higher index. Trace: `H1` wins on `dist = 10` and commits to `d1`; `H1` is re-selected,
>   walks to `d1` again, finds `destPins − destReserved === 0` and is excluded by decision 4's rule; `H0`
>   then commits to `d2`. `H0`'s trip returns to `H0`, while the nearest house to `d2` is `H1`.
> - **Vacuity check:** for at least one scored car `i`, `carHome[i] !== argmin dist[houseCell]` over
>   colour-c houses for that car's `carTargetDest`.

**Also fix the mutation, which is not constructible as named.** Under decision 2's retrace there is no
house search on the return leg at all — `trips.ts` contains no house lookup, and by the arrivals phase
the fields are stale, so no nearest-house ranking is even computable. Restate line 672's entry as:

> return to the nearest house — *i.e.* on trip completion set `carCell[i] = houseCell[nearestHouse]` and
> free the car slot at `nearestHouse`, rather than at `carHome[i]`, where `nearestHouse` is the fixture's
> hand-computed nearest colour-c house to `carTargetDest`.

**Do not** weaken the existing `carCell === houseCell[carHome[i]]` assertion: with the nearer house at
the higher index it still kills "pick the first house", "pick the lowest index" and "pick the largest
`dist`". This is an addition, not a replacement.

---

### I2. The one-pin/two-house bullet cannot kill "apply reservations after the house loop"
**Lenses: mechanism + coverage (independent).** Plan 4b, line 602 and the bolded coverage bullet at 606.

**What breaks.** The plan bolds *"Reservation is written inside the loop, immediately, never after it"*,
claims the deferred version *"survives every coverage bullet phrased in terms of 'the next field's
sources'"*, and offers the one-pin/two-house bullet as the killer. It is not one. `remaining` is
initialised to `Σ(destPins − destReserved)` and decremented per commit; with one unreserved pin the loop
body runs exactly once whether or not `destReserved` is written inside. Mutant and correct code are
byte-identical.

**Witness (killing fixture).** One colour-c house `H` with 2 free cars; `A` nearest with `destPins = 1`,
`B` farther with `destPins = 1`. `remaining = 2`.
*Correct:* iter 1 commits car 0 to `A`, `destReserved[A] = 1`; iter 2 re-selects `H`, walks to `A`,
`1 − 1 = 0`, excludes `H`, breaks → **1 dispatch**.
*Mutant:* iter 2 reads `1 − 0 = 1 > 0` and commits car 1 to `A` → **2 dispatches**, `destReserved[A] = 2
> destPins[A] = 1`.
Note `sum(destReserved) === count(PHASE_OUTBOUND)` is **blind** to this (2 === 2), and the decision-4
artefact bullet is blind too (its `destReserved` is carried in from a prior tick, which the mutant reads
identically).

**Fix — replace the bullet at line 606:**

> ~~**one pin, two same-colour houses each with a free car → exactly one car dispatched that tick**~~
>
> **two same-colour destinations each holding exactly one unreserved pin, with the winning house's
> downhill walk terminating at the same destination on consecutive iterations (one house with two free
> cars is the minimal shape) → exactly one car dispatched that tick, and `destReserved[A] === 1` at every
> point after the first commit**; and, separately, **`destReserved[d] <= destPins[d]` for every `d` after
> the dispatch phase** — the sum-equality invariant cannot see over-reservation on a single destination.

Keep the one-pin/two-house bullet as well; it still kills "every eligible house dispatches" and
"one dispatch per house per tick". It just is not the deferred-reservation killer the plan says it is.

---

### I3. 4a's ascending-order fixture condition is the wrong knob; a bare slot-order copy passes it
**Lenses: mechanism + coverage (independent).** Plan 4a coverage, line 580.

**What breaks.** The bullet requires *"pins are created in descending destination-slot order"*.
`destPins` is a Uint8 array of counts indexed by slot; the chronological order in which pins were written
leaves **zero trace in state** — `destPins[1]=1; destPins[0]=1` is byte-identical to the reverse. Source
assembly enumerates slots `0..H_DEST_COUNT` and reads counts, so the stated condition cannot discriminate
anything. The property that actually separates "insert in ascending cell order" from "copy in slot order"
is that `carparkCell` is not monotone in the slot index. This is the only guard on a rule whose violation
is a hard throw in `computeFlowField` (`flowfield.ts:119-128`, verified).

**Witness.** Dest slot 0 at origin 100 orientation E (carpark 103), slot 1 at origin 300 orientation E
(carpark 303), both colour 0, both pinned, pins written slot 1 then slot 0. Slot-order copy emits
`[103, 303]` — strictly ascending, no throw, test green, mutation alive. Swap the two origins and the
copy emits `[303, 103]` and `computeFlowField` throws.

**Fix — replace the bullet:**

> sources land in ascending cell order for a fixture containing **at least one same-colour pair of
> pinned destinations `d1 < d2` with `carparkCell(d1) > carparkCell(d2)`** (the inversion a bare
> slot-order copy turns into a `computeFlowField` throw; pin *creation* order is not observable in state
> and proves nothing)

**And add the two lines 4a is missing.** 4a is the only subsection in the plan with neither a
**Vacuity self-checks** line nor a **Mutations** line — every other one (Tasks 2, 3, 4b, 5, 6, 1e) has
both. Add:

> **Vacuity self-check for 4a:** the fixture must genuinely contain a same-colour slot/cell inversion —
> assert `carparkCell(d1) > carparkCell(d2)` for some pinned same-colour `d1 < d2` before asserting the
> emitted order. A cross-colour inversion discriminates nothing, because colours occupy disjoint slices.
>
> **Mutations for 4a:** copy in destination-slot order; seed from `destCell` instead of the carpark cell;
> seed with a fixed orientation instead of `destMetaOrientation(destMeta[d])` (see M6 below); drop the
> `roadMask(carpark) !== 0` check; write into the wrong colour's slice; append instead of overwriting
> `sourceCounts[c]`.

---

### I4. "The fixture must turn" is the wrong discriminator for the re-pathing mutation
**Lenses: mechanism + coverage (independent).** Plan Task 5, mutation list line 629.

**What breaks.** The committed route *is* the downhill walk of `dir`: 4b commits `route[i] = dir[cell_i]`
with `cell_{i+1} = step(cell_i, route[i])`. Therefore `dir[carCell] === route[carRouteCursor]` at every
tick of the outbound leg, **identically, by construction** — on a path with two turns exactly as much as
on a straight corridor. The plan's stated reason ("on a straight corridor a field read and a route read
agree", implying they disagree once it turns) is false, and it steers the implementer into a fixture that
proves nothing. Worse, the mutation is not constructible against the signature Task 5 specifies: movement
"never reads a field", so `cars.ts` takes no `fields`/`scratch` parameter, and at Task 5 time `step` does
not call movement at all.

**Witness.** House → `E, E, SE, S, S` → carpark, one destination, one pin, no road edits. The field is
rebuilt only when the input hash moves, which it does not, so `dir` is byte-identical every tick.
Route-following and `dir`-following produce the same cell sequence and the same arrival tick. Mutation
survives a fixture that turns twice.

**Fix — replace the mutation-list entry:**

> make movement read `dir[cell]` instead of the committed route (the re-pathing mutation). **Turning is
> not the discriminator** — the committed route is by construction the downhill walk of `dir`, so the two
> agree step-for-step on any path while the field is unchanged. The discriminator is a field whose
> *content* changes mid-flight: a second pin fires at a nearer same-colour destination on the tick after
> dispatch, and the correct car still arrives at its original destination on its original tick while the
> mutant re-targets. That fixture needs demand + 4a + `syncFields` + dispatch, so it belongs in **Task
> 6's loop test**, not `cars.test.ts`. Task 5's in-task substitute: after committing a route, overwrite
> one `dir[]` entry on the car's path and assert the car still follows `carRoute`.

Also add one sentence to Task 5's prose noting that the *primary* defence is the signature — `cars.ts`
takes no field — and that this is why the mutation must be exercised one task later.

---

### I5. The dispatch loop's `excluded` set has no specified storage, and Task 4 has no legal place to put one
**Lenses: mechanism + drift + coverage (three, independently).** Plan 4b pseudocode line 588; Global
Constraints line 63; Task 4 Files line 566.

**What breaks.** Global Constraints says "Nothing allocates inside a tick. This now binds three new
things: source assembly, the field-input hash, and route commitment. Each says below how it stays
allocation-free." The dispatch exclusion set is an unnamed fourth, and 4b literally writes `excluded = ∅`
once per colour per tick (5/tick on `firstCity`). Every clean home is foreclosed: module-scope mutable
state is ESLint-banned (`determinism/no-module-mutable-state`); a sixth `step` parameter is banned by a
live arity pin (`packages/sim/test/step.test.ts:92`, `expect(step.length).toBe(5)` — verified); and
`Scratch` has no per-house member and `createScratch(cells, groupCount, maxDestinations,
fieldInputRanges)` does not take `maxHouses` (verified, `scratch.ts:94-107` and `:209-214`). `scratch.ts`
appears in no Files list after Task 1.

Nothing watches it: there is no allocation harness, and `tools/eslint-rules/index.js` explicitly exempts
`Set`/`Map` used only through `has`/`add`. `const excluded = new Set()` ships green, correct,
deterministic — and in violation of a constraint the plan calls literal.

**Fix — the cheapest correct answer needs no new file and no Scratch change.** Within one colour's loop
`dist` is frozen, free cars only decrease and exclusions only grow, so the candidate set shrinks
monotonically and the selected key `(dist[houseCell], houseIndex)` is non-decreasing. Replace lines
588-597 with:

> ```
> remaining = Σ over colour-c destinations of (destPins[d] - destReserved[d])
> lastKey   = (-1, -1)          // (dist, houseIndex) of the previous selection
> reselect  = false             // true iff the previous winner may be picked again
> while (remaining > 0) {
>   h = reselect ? the previous winner
>                : the colour-c house with a free car and minimal (dist[houseCell], houseIndex)
>                  strictly greater than lastKey
>   if (no such h, or dist[houseCell(h)] === INF) break
>   lastKey = (dist[houseCell(h)], h)
>   d = walk dir downhill from houseCell(h), recording directions into that car's carRoute slice,
>       to the terminating carpark cell
>   if (walk exceeded MAX_PATH_LEN, or the route is zero-length) {
>     H_ROUTES_REFUSED++; zero the bytes the walk wrote; reselect = false; continue
>   }
>   if (destPins[d] - destReserved[d] === 0) { zero the bytes the walk wrote; reselect = false; continue }
>   commit the route to the lowest free car index of h; destReserved[d]++; remaining--
>   reselect = (h still has a free car)
> }
> ```
>
> **There is no exclusion container.** The exclusion set is a monotone `(dist, houseIndex)` cursor, not a
> collection: because free cars only decrease and exclusions only grow, the selected key never decreases,
> so "not excluded" is exactly "key strictly greater than the last key, unless the last winner still has
> a free car". Two scalar locals, zero allocations, and the loop cannot spin by construction. That is the
> fourth thing the zero-allocation constraint binds; add it to the list at line 63.

The alternative — `houseExcluded: Uint8Array(maxHouses)` on `Scratch` — is also correct but costs a fifth
`createScratch` parameter rippling across ~19 call sites, `Modify: packages/sim/src/scratch.ts` added to
Task 4's Files list, and a clear-per-colour rule with its own coverage bullet ("a stale flag from colour
`c` does not exclude a house in colour `c+1`"). Prefer the cursor.

This rewrite also settles **I8** in prose (`reselect` is the multi-dispatch-per-house rule, made explicit)
and **I7** (the zeroing on both refusal paths).

---

### I6. The 4-bit route codec has no stated nibble convention, no owner, and no round-trip coverage
**Lens: mechanism.** Decision 2 line 190; Task 4 Files (writes it); Task 5 Files (reads it).

**What breaks.** `carRoute` is written by `dispatch.ts` and read by `cars.ts` and `trips.ts`, and no task
states which nibble is step `i` or names a shared pack/unpack. `destMeta` was given a bit layout *and* a
48-combination round-trip test precisely because "the packing bug is silent" (line 274); the identical
argument applies here and the plan makes none of the three moves. This matters most because Tasks 4 and 5
are dispatched to separate subagent sessions.

**Witness — a pure nibble-order swap survives every bullet in Tasks 4, 5 and 6.** Swapping permutes the
route as `(s0,s1) → (s1,s0)`, `(s2,s3) → (s3,s2)`, … Displacement vectors commute, so the endpoint is
unchanged; the multiset of steps is unchanged, so the total cost and therefore the arrival tick are
unchanged. Exact-arrival-tick, diagonal-only, mixed-path, return-leg-duration, road-erased-under-a-car,
and "the car returns to its own house" all pass. Arrival is cursor-driven, not position-driven, so a car
sitting on the wrong cell still "arrives". Only intermediate cells differ, and nothing asserts a cell
trace. Odd-length routes are worse: the last step is written low and read high, decoding as the
never-written `0` = N, which is orthogonal — so even the arrival tick still matches on an all-orthogonal
fixture. Goldens cannot help; they are building-free.

**Fix.** (a) In decision 2, after "two per byte", add: *"Step `i` occupies bits `(i & 1) * 4 … +3` of byte
`base + (i >> 1)`."* (b) Name one owner in the File Structure table — `packRouteStep` / `routeStep`
exported from `dispatch.ts` — and have `cars.ts` and `trips.ts` import it rather than re-deriving.
(c) Add to Task 4's coverage: *"pack/unpack round-trips for every direction 0..7 in both nibble positions,
over an odd-length and an even-length route."* (d) Add to Task 5's mutations: *"swap the nibble order —
killable only by a per-tick cell trace; the endpoint, the total cost and the arrival tick are all
invariant under it."*

---

### I7. A refused or excluded dispatch leaves non-zero route bytes in an IDLE car
**Lens: drift.** 4b pseudocode ordering; Task 6 line 639 ("route and progress cleared"); Task 1g line 496.

**What breaks.** Decision 2 mandates that the walk record into `carRoute` in the buffer (there is no legal
staging buffer — see I5), and the walk happens *before* the MAX_PATH_LEN/zero-length refusal and *before*
the eligibility exclusion. So both refusal paths leave up to 48 bytes of live nibbles in an IDLE car's
slot with `carRouteLen === 0`. That contradicts decision 3's stated intent ("an idle car's bytes are a
function of nothing but 'idle'", line 229) and falsifies Task 1g's compression prediction ("`carRoute` is
all-zero for every idle car", line 496) — which feeds the M3 4,096-char CloudStorage budget claim.
3,840 B of quasi-random nibbles does not compress like a run of zeros.

**Witness.** The MAX_PATH_LEN refusal fixture Task 4 already mandates: after it, `H_ROUTES_REFUSED === 1`,
`carPhase[0] === PHASE_IDLE`, `carRouteLen[0] === 0` — every listed bullet passes — while `carRoute[0..47]`
holds 96 garbage nibbles that persist in every snapshot forever. The **more common** trigger is the second
path: decision 4's own eligibility exclusion, which the plan describes as occurring in ordinary play and
which is reachable inside Task 6's own loop fixture.

**Fix.** (a) The pseudocode rewrite in I5 already carries `zero the bytes the walk wrote` on both
`continue` paths. (b) Make Task 6 line 639 explicit: *"`H_SCORE++`, `PHASE_IDLE`, `carTargetDest = -1`,
`carProgress = 0`, `carRouteLen = 0`, `carRouteCursor = 0`, and all 48 `carRoute` bytes zeroed."*
(c) Add a coverage bullet to Task 4: *"after a refused or excluded dispatch, every `PHASE_IDLE` car's 48
route bytes, `carRouteLen` and `carRouteCursor` are all zero"*, and to Task 6 the same after a completed
trip. (d) Add the mutation *"skip the route zeroing on refusal"*.

---

### I8. Whether one house may dispatch both its cars in a single tick is unpinned
**Lens: coverage.** 4b, "The loop bound is specified, not left to reading" (line 600).

**What breaks.** The paragraph settles the *total* (capped at `remaining`) and never says whether the
winner is excluded after a *successful* dispatch. Read from the pseudocode it is not — `h` is re-selected
each iteration and a house with a second free car is still eligible. That decides which car slots receive
route bytes, therefore the buffer bytes, therefore `hashState`, therefore browser-vs-Worker byte identity
— exactly the reason line 604 pins the sibling rule ("lowest free car index"). This one gets neither a
bullet nor a mutation, and `excluded.add(h)` at the end of the loop body is the belt-and-braces idiom an
implementer reaches for to guarantee progress.

**Witness.** One destination `D` with `destPins = 2`; houses `H0` (`dist 50`) and `H1` (`dist 30`), all
four cars idle. Plan-as-written: `H1` sends cars 2 and 3, `H0` sends nothing. Mutant: `H1` sends car 2,
`H0` sends car 0. Divergent `carPhase`, `carRoute`, `carRouteLen`, `carRouteCursor`, `carTargetDest` →
divergent `hashState`. Every listed bullet passes under both (all are one-pin or single-dispatch shapes),
and `sum(destReserved) === count(PHASE_OUTBOUND)` holds identically.
**Narrowing that the fixture author must respect:** the two pins must sit on the **same** destination. With
two pins on two destinations, decision 4's exclusion fires on iteration 2 and both variants produce
`H1` then `H0` — a reader who builds the obvious "2 pins, 2 destinations" fixture will wrongly conclude
the mutation is dead.

**Fix.** Add to line 600: *"A house may dispatch more than one car in a tick; it is excluded only on
refusal or on ineligibility, never after a successful commit."* Add the coverage bullet: *"one destination
with `destPins = 2`, two same-colour houses at genuinely different `dist`, all four cars idle → the nearer
house sends **both** cars and the farther sends none."* Add the mutation: *"exclude the winning house
after a successful dispatch."*

---

### I9. Phase 1's position is only observable through demand, which Task 6's fixture freezes
**Lens: mechanism.** Task 6 mutation "move the tick advance after demand"; coverage line 670; tick-order
table row 1.

**What breaks.** `H_TICK` is read inside a tick by exactly one thing — demand's eligibility gate
(`tick - destSpawnTick[d] >= FIRST_PIN_DELAY_TICKS`). Dispatch, movement and arrivals never read it.
Task 6's fixture requires the pin timer "frozen or exactly pinned", and **both** readings are blind: under
"frozen", `destSpawnTick` is pushed out of reach and the gate never changes state; under "exactly pinned"
(backdated `destSpawnTick` plus pre-loaded `pinAccum`) eligibility is already true at `T-1`. Only a
fixture that *crosses* the 120-tick boundary mid-run can see it, and nothing requires that. Task 3's
demand tests call `runDemand` directly, never through `step`, so they cannot see phase order either.

**The plan's stated safety net does not exist.** Tick-order row 1 claims moving the tick advance "moves
the goldens". It does not: the determinism golden is 13,499 steps with **zero destinations**
(`slotCounts` all 0, `pinAccum` never moves), and end-of-tick `H_TICK` is identical under the mutation.
The road-network and field goldens never call `step`.

**Fix.** (a) Strike *"and moves the goldens"* from the phase-1 row of the tick-order table. (b) Add to
Task 6's "Coverage required, beyond the loop test": *"the tick advance's position is pinned by a dedicated
boundary test driven through `step`: one destination placed at `H_TICK = 0` with `pinAccum[c]` pre-set to
`PIN_PERIOD_TICKS − slotCount`, stepped to tick 120 — `destPins` is 0 after tick 119 and 1 after tick 120.
Moving the advance after demand delays the fire to tick 121."*

---

## 4. Minors

- **M1. `carTargetDest` (and the rest of the idle-car reset) has a mutation and no bullet.**
  *Lenses: coverage + drift.* Task 6 lists "leave `carTargetDest` set after the trip" and nothing reads it
  after a trip; the goldens are building-free, and the mid-flight replay compares mutant to mutant. Same
  gap for "route … cleared". **Fix:** at the first score increment in `loop.test.ts`, assert the whole car
  slot equals a freshly created car's slot — `carPhase === PHASE_IDLE`, `carCell === houseCell[carHome[i]]`,
  `carTargetDest === -1`, `carProgress === 0`, `carRouteLen === 0`, `carRouteCursor === 0`, all 48 route
  bytes zero. Closes I7's Task 6 half too.

- **M2. The anti-double-act mutation is a provable no-op, and the sentence naming it is self-contradictory.**
  *Lenses: mechanism + coverage.* Arrivals flips OUTBOUND→RETURNING leaving `cursor = routeLen ≥ 1`, and
  the home test is `cursor === 0`, so no in-tick re-test can fire. Worse, 4b's dispatch loop **must** write
  `carPhase` in place or it re-selects the same car — so line 323 names as "the reachable failure" the exact
  pattern the plan's own pseudocode requires. **Fix:** strike "The reachable failure is…" and the
  "net-zero double act" clause from line 323 (the conservation check keeps its other three stated kills,
  each with a live mutation). Replace the Task 6 mutation with two that have witnesses: *"treat a car as
  free when `carPhase !== PHASE_OUTBOUND` rather than `=== PHASE_IDLE`"* (RETURNING→OUTBOUND, killed by the
  transition table) and *"commit and reserve before the MAX_PATH_LEN check, then revert `carPhase` on
  refusal"* (net-zero IDLE→OUTBOUND→IDLE, killed only by the conservation check, exercisable on the
  refusal fixture Task 4 already mandates).

- **M3. `COST_UNIT_SCALE` and `CAR_SPEED_UNITS_PER_TICK` do not exist and Task 5 has no `Modify` line.**
  *Lenses: drift + coverage.* Verified: `grep` over `packages/` returns zero hits; `constants.ts` ends at
  line 117 with `FIRST_PIN_DELAY_TICKS`. Task 1 shipped four of the six constants the File Structure table
  names and skipped these two; no later task lists `constants.ts`. Self-correcting (decision 3 states both
  values and the file by name), but a subagent obeying its Files list literally would define them in
  `cars.ts` — a second source of truth this codebase rejects elsewhere. **Fix:** add
  `- Modify: packages/shared/src/constants.ts` to Task 5's Files list, and name `speedUnits`' home module
  (`cars.ts`) in the File Structure table.

- **M4. Task 6's arrival-order bullet needs its construction stated, not deleting.** *Lens: coverage; see
  §6.* Arrival order is not outcome-visible over reachable states (all writes are per-car or commutative
  counters), so a loop-fixture assertion is vacuous. It *is* killable off the reachable manifold, in the
  idiom the plan already mandates for the corrupted-`dir` cycle. **Fix:** append to line 643: *"It is
  killable only off the reachable manifold: hand-write two cars `i < j` both OUTBOUND on `d`, both
  exhausting their route on tick `T`, with `destPins[d] = 1` and `destReserved[d] = 2`. The named arrival
  assert throws; catch it and read `carPhase[i]` vs `carPhase[j]` — ascending flips `i`, descending flips
  `j`. Drive it through `trips.ts` directly, not through `step`, so no `H_EPOCH` poisoning is involved."*

- **M5. No mutation covers the dispatch loop bound in the under-dispatch direction.** *Lens: drift.* An
  implementation that writes `if` where the pseudocode says `while` survives all fourteen 4b bullets and
  every 4b mutation. **Fix:** add *"dispatch at most one car per colour per tick (replace the `while` with
  an `if`)"* to 4b's mutation list, with the covering fixture spelled out: two same-colour destinations
  each holding one unreserved pin, positioned so house A's downhill walk terminates at `d1` and house B's
  at `d2` (assert the two committed routes end at different destination indices) → exactly 2 dispatches on
  that tick.

- **M6. 4a's fixtures may all be orientation-N, making "seed with a fixed orientation" a no-op.** *Lens:
  coverage.* `carparkCell` accepts orientation 0, so a fixed-0 mutation is semantically inert on an all-N
  fixture. (Mitigated in practice: `demand.test.ts` uses `ORIENTATION_S` throughout, because
  `carparkCell` returns −1 for N at `y0 = 0`.) **Fix:** add to the 4a vacuity line from I3: *"at least one
  pinned destination must carry a non-N orientation, and the assembled source cell must be asserted equal
  to `carparkCell(destCell[d], destMetaOrientation(destMeta[d]), w, h)` over ≥ 2 distinct orientations."*

- **M7. Four stale line/symbol references in Tasks 4a and 6.** *Lens: drift.* All verified:
  (a) "silently skips a source with no road bit (`flowfield.ts:150`)" → the skip is at **`:167`**; `:150` is
  `pushesPerCell[cell] = …`.
  (b) "throws unless sources are strictly ascending (`flowfield.ts:114-121`)" → **`:119-128`**.
  (c) "`flowfield.test.ts:750` exists specifically for this case" → the duplicate-source tests are
  **`:626`** and **`:883`**; `:883` is literally the M1c-dispatch scenario and is the better citation.
  (d) Task 6 vacuity: "`rollback.test.ts` already does this with `hashRoadRegion`" → renamed to
  `hashFieldInputRegions` in Task 1; the pattern to mirror is **`rollback.test.ts:485-489`**.
  While refreshing, also fix the two the lenses found in passing: the quoted docstring cited as
  `flowfield.ts:80-86` is at **`:85-88`**, and the `fieldFor` staleness throw cited as `:352-358` now lands
  in a docstring. No substantive claim at any of these citations is falsified — the behaviours are all
  real; only the coordinates moved, because Task 1 edited `flowfield.ts`.

---

## 5. Deduplicated across lenses

Highest confidence — found independently by two or three lenses, in different words:

| # | Finding | Lenses |
|---|---|---|
| **I5** | `excluded` set: per-tick allocation, no Scratch home, `scratch.ts` off Task 4's Files list | **mechanism + drift + coverage (3)** |
| **I1** | Task 6 fixture: `nearest ≡ own` survives the rewrite; the mutation is also not constructible as named | mechanism + coverage |
| **I2** | `remaining` caps the loop, so the one-pin bullet cannot kill deferred reservation | mechanism + coverage |
| **I3** | 4a's "descending slot order" condition is unobservable; the discriminator is a slot/cell inversion | mechanism + coverage |
| **I4** | "the fixture must turn" is the wrong discriminator for the re-pathing mutation | mechanism + coverage |
| **M1** | `carTargetDest` / idle-car reset: mutation listed, nothing reads it | coverage + drift |
| **M2** | The in-place-`carPhase` mutation is a provable no-op | mechanism + coverage |
| **M3** | Movement constants absent; Task 5 has no `Modify` line for `constants.ts` | drift + coverage |

Note the three lenses converged on I5 with *different* proposed fixes (two demanded a Scratch widening;
one showed a scalar cursor is exact). The cursor is correct and cheaper — see I5.

---

## 6. Refutations worth a second look

1. **Two refuters reached opposite verdicts on the arrival-order bullet.** One found the coverage-lens
   finding irrefutable ("no assertion can distinguish ascending from descending"); another refuted the
   near-identical mechanism-lens version by *constructing* a killer (corrupt `destPins[d] = 1` against two
   reservations, catch the named throw, read which car flipped). The constructive refutation is right —
   the first refuter only searched the reachable state space, and the plan itself mandates off-manifold
   testing for the corrupted-`dir` cycle. Resolved as **M4**: keep the bullet, state the construction,
   downgrade from Important to Minor.

2. **The "route staging buffer" refutation is correct and creates I7.** The refuter is right that the walk
   should write straight into the chosen car's `carRoute` slice — a free car is established as part of
   selecting `h`, so no staging is needed. But that is precisely what leaves live nibbles behind on the two
   `continue` paths. The refutation closes one finding and opens another; do not treat it as closing both.

3. **The `speed-constants-absent` refutation ("Files lists are summaries, not whitelists") is right on
   process and wrong on risk containment.** It is true the implementer will not stall. But the same
   argument was used to refute the Scratch half of I5 — and there the omission *does* bite, because
   `createScratch` needs a new parameter and 19 call sites. Do not generalise "Files lists are advisory"
   from M3 to I5.

4. **Two refuters described `remaining` as making a claim impossible that it does not.** One refuted the
   coverage-lens deferred-reservation finding partly on "the plan's justification sentence is false".
   It is not: with pins at two destinations and two houses whose walks converge, the mutant genuinely does
   dispatch two cars at one pin. The plan's *sentence* is sound; only its *fixture* is blind. I2 is written
   accordingly — do not delete line 602's justification when applying the fix.
