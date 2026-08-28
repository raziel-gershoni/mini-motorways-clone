# M1f carry-forward

Opened by M1e Task 11 so that the items below have a **named recipient** rather
than a milestone mentioned in a comment. The catalogue's rule is that a handoff
with no home in the source evaporates; this file is the home for the ones with
no natural code site, and every other item is repointed at its own site with
`M1f` written in it.

This is not the M1f plan. It is the list of things M1e knowingly did not do,
each with what was measured about it.

---

## THE FIGURES' VINTAGE — read this before quoting any number below

**Every numeric figure in this file was re-derived against the tree at commit
`14e7dee` on 2026-08-11, in M1e's closing sweep**, and each one is now marked in
place as one of three things:

- **confirmed** — reproduced, or pinned by a green assertion at HEAD, with the
  site named;
- **corrected** — the old figure is struck through in the text with the measured
  one beside it and the rig stated;
- **UNVERIFIED** — the figure could not be reproduced on any arm this tree can
  drive, and is labelled as such rather than silently kept. There are five, all
  in §15, all inherited from rigs that no longer exist. **They are not known to
  be wrong. They are known to be unchecked**, which is a different and more
  useful thing to be told.

The sweep exists because this milestone's diagnosed dominant defect was *a
durable artefact stating the opposite of what the same task measured*, and the
review that named it found the family still open in the handoff. The generalised
cause, in the reviewer's words, is worth carrying more than the corrections are:
**"figures inherited from briefs written before the tree moved under them, and
no per-task review can see that."** A per-task review checks a figure against its
own task. Nothing checks it against the tree two tasks later, so a figure decays
silently and the document reads exactly as well as it did when it was true.

**So: a figure in this file is evidence about `14e7dee` and about nothing after
it.** If M1f is quoting one to justify a change, re-run it — most have a named
rig or a named assertion beside them now, which is what makes that cheap.

### The M1f wave-1 pass re-ran six of them, and four moved

Taking the paragraph above at its word, the wave-1 render pass re-derived the
figures it needed on a rig that first reproduced **5,580 / 8,661 / 31,456**,
their killers **D2 / D3 / D6**, trips **0 / 71 / 747**, twelve destinations and
`H_ROUTES_REFUSED` **0** — the reproduce-before-you-contradict step, which is
the only reason the disagreements below read as findings. What changed:

| § | was | is | why it moved |
|---|---|---|---|
| §5, §10 | the board cannot jam under shipped constants | **the shipped SEED, drawn WITH the column-8 trunk, does not jam; 6 of 8 seeds do, and so does the same policy without the trunk** | the claim was about one arm on one seed and read as a claim about the board |
| §5, §15.3 | `H_ROUTES_REFUSED` = 0 offered as evidence about traffic | **it cannot measure traffic at all and will stay 0 under every lever** | it counts route WALKS, not entry refusals |
| §12, §14 | greedy dies at **17:29** | **17:19.9 on §14's own stopwatch convention**; 17:28.5 is `tick / 30` | two counters, one sentence |
| §11 | the column-8 corridor "buys zero ticks" | still true, **and it also buys 21 trips and a climbing score** | "zero ticks" was read as "no effect", which is what makes it a trap |
| §16 | — | **a new class: constants that move digests with no behavioural content** | a re-bless authorisation for that class is a different authorisation |
| §15 | — | **seed variance dwarfs most single-constant effects (≥20x)** | any single-seed claim below 2x is inside the noise |

**Every row was measured, not read.** The rigs are named at each site.

---

## 0. THE MILESTONE'S ACCEPTANCE CRITERION, AND WHO OWNS EACH HALF

**Written at M1f Task 8, because at task seven of twelve nobody owned it.** Seven
tasks had shipped, six honestly reporting *"a human sees nothing"* and the
seventh reporting a board that stops dead at a week boundary with nothing drawn
on it. M1d shipped correct, tested, deployed and **invisible**, and the user
noticed before we did; the review of M1f Tasks 5 and 6 named the shape while it
was still recoverable — *"six invisible tasks with the acceptance criterion still
unowned at task seven of twelve is how M1d happened"*.

The criterion is two sentences, three tasks apart, and each has an owner.

**A — THE CHOICE. Owner: M1f Task 8. Satisfied.**

> On the board a plain link opens, with nobody told where to look: at **2 min
> 21 s** — tick 4,500, `(4500 − 258) / 30` = 141.4 s — the board stops and dims,
> and **CHOOSE A CARD** appears over two large cards. On the shipped seed the
> **top** one is **JUNCTION UPGRADE · 20 TILES · x2** and the bottom one is
> **ROAD TILES · 30 TILES** — measured (`offerSlot(state, 0)` is the upgrade),
> so **re-measure if the seed moves**. The player taps one. The modal goes, the
> **clock starts again**, and the HUD's tile counter is **20 or 30 higher**. The
> ERASE ROADS button is off the screen while the modal is up and back afterwards.
> Under **SEE THE BOARD** the modal disappears and the frozen city is visible at
> full contrast with **TAP TO RETURN** over it; the clock does not advance.
>
> **"The cars move again" is deliberately NOT in this criterion.** On a plain
> link with no road drawn there is nothing in motion at 2:21 — `0 TRIPS`, and
> the city's no-input arm has `maxInFlight` 0 — so what resumes is the clock.
> **A still board is not a failure of A.**

**B — THE JAM, AND WHICH CORNER. Owner: M1f Task 10. Satisfied at `453ed01`.**

> Take the **JUNCTION UPGRADE** card when it is offered and **hold it** — no
> corner is a legal site at the first boundary, so it has to be kept. From
> **8 min 56 s** (tick 16,337) cars stand still at a handful of corners; three at
> once is the first thing on this board a person can see that minute seven's rule
> changed. The chip in the **bottom** HUD band, fourth column, reads **2**. Tap
> it — the icon turns teal — then tap one of the stopped corners. A small teal
> square appears on that cell and **stays there; nothing about it moves**. Within
> about **twelve seconds** a car crosses that corner with another car already
> standing in it, which has not happened there since minute seven.
>
> **Which corner is the whole decision, and the busiest-looking one is the wrong
> answer.** On the shipped seed **(9, 22)** — 21.7 % of the junction refusals —
> takes the run from **368 trips to 755** (**2.05×**, 5 min 30 s longer).
> **(12, 19)** — 39.5 %, the one that looks worst — takes it to **394**, +7.1 %.
> Placing it at 8:56 buys the whole 755; waiting for the next card at **12:00**
> buys **368**, the control, to the trip.

**Four things a device tester must read literally**, each measured and two of
them wrong in an earlier draft:

- **The chip is in the BOTTOM band.** §8.3 forbids an interactive element in the
  top band, and the top band measures 86 / 95 / **27** CSS px across the three
  viewports `camera.test.ts` covers against a 60 px floor. Looking above the
  board is looking in the wrong place.
- **Nothing about the marker animates**, and that is spec §5.6's 2026-08-21
  amendment rather than an omission: the light that had a phase measured
  **−13.0 %** on trips and went to M1g. The whole feedback is in the traffic.
- **The mark is a square, not a ring.** A ring on a junction is what a traffic
  light looks like, and this board draws exactly one changing ring already — the
  overcrowd alarm.
- **The first crossing is 367 ticks (12.2 s) after the taps**, and the earliest
  crossing this board can produce at any corner from any seat tick is tick
  **15,001**. A corner that takes ten seconds to clear is not a failure.

**Both are verified on hardware by M1f Task 12's device session**, which owns the
half no test can hold: that a person who was told none of this finds the corner
anyway.

**The thresholds Task 12 inherits, quoted the way M1f Task 9 handed them over.**
`BEST_MARGIN` **measured 2.05×**, handed over at **1.50×**; `SPREAD_MARGIN` —
`(best − worst) / worst` — **measured 0.916**, handed over at **0.50**; single
placements strictly worse than the control **0 of 3**. **`BEST_MARGIN` must NOT
be applied per seed**: the spike's eight-seed row for perfect relief wins 7 of 8
and contains a loser, so a per-seed floor would fail on that seed for a correct
object. Aggregate or median.

**A does NOT claim the 30-vs-20 choice is a trade-off, and must not be quoted as
if it did.** Measured: the greedy arm's tile slack goes **2.7× → 4.3× for
identical roads**, `unaffordable` is 0 across the whole 21,783-tick run, so
**the card's tiles are free money and either card costs the player nothing** on
the board that ships. A is a claim that the loop is visible, reachable and
completable. Whether it is a *dilemma* is `CARD_GRANT_ITEM`'s "delete the weekly
grant" lever, handed to M1g with the number and not pulled here.

## 1. Everything waiting on the §5.10 card modal

M1e shipped the **load-bearing half** of §5.10 — `WEEKLY_TILE_GRANT`, 30 tiles a
week, flat and not week-indexed — and left the **two-card CHOICE**. Every other
card in the table grants an ITEM (bridge, tunnel, roundabout, traffic lights,
motorway) and none of them has a placement mechanism, so a pool with one
offerable entry is a menu with one item.

That single omission is what re-dated **eleven** source comments from M1e to
M1f. They are listed here so nobody has to re-derive the connection:

| site | what it is waiting for |
|---|---|
| `sim/regions.ts` × 5 (`carCell`/`occupancy`/`carBlockedTicks`/`ghostMask`/`ghostCommitted`) | demand-actuated **traffic lights**, IF they price waiting as an edge weight |
| `sim/scratch.ts` `NB`, `DISTINCT_EDGE_COSTS`, `entryPoolCapacity` | the **motorway** tier — the one card that changes `edgeCost`'s value set |
| `sim/cars.ts` `laneSpeedMul` | the same motorway tier, as a cost-model change |
| `sim/roads.ts` `LANE_OF_DIR` | **traffic lights and roundabouts**, for the two-lane model's intersection gap |
| `shared/constants.ts` `MOTORWAY_SPEED_MAX` / `ROUNDABOUT_SPEED_MUL` | both are still uncalled |
| ~~`render/types.ts` `HudRects`, `game/pointer.ts`'s `HUD_INERT`~~ | ~~§7.2's **inventory chip row**~~ — **CLOSED at M1f Task 10**: `HudRects.upgrades` is the fourth column of the bottom band, tapping it arms the placement mode, and `HUD_INERT` is still the honest answer at zero held |

**Read `scratch.ts`'s `NB` doc comment before adding any edge cost.** It carries
the full derivation, the measured modulus table, and the two ways a penalty can
be added that keep every assert green while producing wrong paths.

## 2. Board expansion, declined by M1d AND by M1e

§5.1's per-week reveal schedule still does not exist. `MapData` carries `w`/`h`
only and the revealed rect is four frozen integers in `shared/constants.ts`.
M1d declined it in its Out table; M1e declined it because its buffer budget was
one shape change and no task needed a growing rect.

**One thing changed about the handoff and it is easy to miss.** Until M1e the
claim was "the camera reads state instead of four constants and nothing else
moves". `sim/spawn.ts` now reads `REVEALED_X0`/`Y0`/`W`/`H` too, to decide where
a building may be placed. There are **two** readers now, and a dynamic rect that
only the camera honours would let the spawner place buildings the player cannot
see. `shared/constants.ts`'s `REVEALED_*` block used to say outright that
nothing in `sim` reads them; that sentence is gone.

The eight repointed sites: `shared/constants.ts`, `shared/mapFormat.ts`,
`shared/maps/firstCity.ts`, `shared/test/constants.test.ts`,
`render/src/types.ts`, `render/src/canvas.ts` (×2), `game/src/shell.ts`,
`game/test/frame.test.ts` (×2).

**Keep `frame.test.ts`'s diagonal-corner warning intact.** The terrain fold's
two sentinel markers sit at cells (0, 0) and (23, 39), which is sufficient only
while the fold is a flat 1-D loop. The moment it becomes 2-D over a dynamic
rect, a corner sits past two bounds at once and each of the four half-plane
bounds needs its own marker one cell past exactly one of them. This is the shape
that produced seven surviving mutants on M2 Task 5.

## 3. Destination REMOVAL — three inert properties waiting on it

M1e's spawner only ever **appends**, and §5.8's failure ends the run rather than
freeing a slot, so the append-only destination prefix is intact and all three of
these are still off the reachable manifold:

- `sim/state.ts` `houseAt`/`destAt` — removal needs an explicit hole marker for a
  slot in the middle of a live prefix; these two accessors are the one place that
  check must land, so removal does not invent a second liveness convention.
- `sim/trips.ts` — ascending arrival order is outcome-invisible only under
  decision 4's proved `destReserved <= destPins`, which removal breaks. Pinned
  off-manifold in `trips.test.ts`.
- `game/src/resolve.ts` — slot indexing removes the dense-*shift* class; the
  slot-*reuse* class (slot `i` owned by car A in prev and car B in curr,
  measured at a 12.6-cell false lerp) is closed **today only by reachability**.
  M1e's spawner did not reopen it because it appends at the next free index;
  removal will.

`sim/dispatch.ts`'s colour-order note is related but **keyed to the trigger
rather than the date**: what ends the ascending-order equivalence is *a
dispatch-time read of a shared, non-commutative resource*. Removal is one
instance; a rule letting one colour's dispatch refuse another's is another and
needs no removal to arrive.

## 4. The erase control never unsubscribes its click handler — HALF CLOSED at M1f Task 8

`retire()` (M1e Task 9) hides the control on game over and refuses every later
render, and `main.ts` calls it on both the edge and the already-terminal boot
path. What it does **not** do is unsubscribe: `offClick` is declared on the
`MainButton` shape (`telegram.ts:76`) and called nowhere in `packages/`, and the
DOM fallback's `click` listener is never removed. **That half is unchanged and
still open**, and still unreachable on every client this ships to — a hidden
`MainButton` delivers no clicks and `display: none` takes the pill out of the hit
test.

**The half worth fixing is fixed.** `press()` called `host.toggleEraseMode()`
before `render()`'s terminal guard ran, so a press that did arrive flipped the
player's erase mode with **no label anywhere to show it** — the "an erase mode
you cannot see you are in" hazard the whole file exists to prevent. `press` now
carries its own `retired || suspended` guard.

**It was ADDED to `press`, not MOVED out of `render`, and the difference is a
deleted guard.** `render()` is also called from `sync()`, so moving its check
down would have removed the terminal guard from a live path — which is how a
retired control gets re-shown. **Credit where it is due: the M1f Task 8 brief
said ADD and explicitly warned against moving.** It was an EARLIER DRAFT of that
step that said "move" where it meant "add", and the brief carried the warning
forward precisely so nobody repeated it. This paragraph reversed that until the
Task 8 fix round; §4's own subject is a comment that was wrong for a milestone,
so getting the attribution backwards here was worse than in most places.

**The other fix was refused and this records which.** Unsubscribing properly
means holding the handler reference and widening `mainButton()`'s shape re-check
to cover `offClick` — a change to the Telegram surface detection, which is the
one part of that file that has never run on a phone (`grep -rn "MainButton"
spike/src/` returns nothing). Two lines of guard against a shape change on
untested platform code, for a consequence that is bounded and cosmetic.

**M1f Task 8 also gave the control `suspend()`/`resume()`**, for §5.10's modal:
the scrim is canvas paint and this control is not, so without it the largest,
brightest thing on a screen asking the player to choose a card is a button
reading ERASE ROADS. Same defect as `retire`'s, different door. It is driven off
`frame.offerPending` in `main.ts`'s draw closure rather than off `onOfferRaised`,
because that callback fires only on ticks and could raise the suspension without
ever lifting it. `retired` outranks `suspended` in `resume`, so a city that dies
with a modal up does not get its erase button back.

## 5. `MAX_BLOCKED_TICKS` is unreachable on the arms M1e drove — NOT on the board

**The heading used to read "unreachable on everything that ships", and that is
false.** Every measurement in this section is real and none of them is about the
board; they are about three arms on one seed. The wave-1 pass drove the same
board with the same constants and reached the valve two ways:

```
  same seed, connect-on-sight WITHOUT the 20-tile opening
      max carBlockedTicks 1,350   longest queue 9   valve fires 11x
      first firing tick 19,957; a car blocked on every tick of a 3,424-tick
      (114 s) window; one car held the full 45 s threshold

  the SHIPPED arm (opening + connect-on-sight), nothing changed but RUN_SEED
      valve firings across 8 seeds: 0, 5, 2, 4, 11, 0, 13, 4
      -> 6 of 8 fire. `laneways-m2` is one of the two that do not.
```

Which half of the opening matters is measurable and it is the trunk: column 8
alone gives 32/queue 4/no valve, column 17 alone gives 1,350/queue 8/4 firings.
**So read every figure below as "on this arm, on this seed"** — the sentence a
reader takes away must not be "the board cannot jam", because it can.

The anti-deadlock valve's 45-second threshold never fires **on the three arms
M1e drove on the shipped seed**. Measured at the close of M1e by driving each
shipped layout from boot to its §5.8 death with no input:

```
  city  5,580 ticks   0 refusals      max carBlockedTicks    0   0 valve firings
  demo  6,703 ticks   7,544 refusals  max carBlockedTicks   55   0 valve firings
```

**All six numbers confirmed on `14e7dee`, and the "refusals" column does not
mean what the greedy row below means by it.** Driving each layout's own seed to
its §5.8 death reproduces `5,580 / 0 / 0 / 0` and `6,703 / 7,544 / 55 / 0`
exactly. But demo's 7,544 is **entry refusals** — `canEnter` saying no to a car,
counted per car per tick — and it is not `H_ROUTES_REFUSED`, which is **0** on
demo too. The greedy row's "0 refusals" IS `H_ROUTES_REFUSED`; that arm's entry
refusals are **2,120**, which is the same thing the 7,544 counts and is not
zero. Two quantities under one column heading, and the only reason the table
never looked wrong is that city is zero on both. **Read the column as: demo
7,544 entry / 0 route; city 0 / 0; city-greedy 2,120 entry / 0 route.**

`city` refuses nothing because a board nobody draws on has no route; `demo`
refuses constantly and its worst wait is **55 ticks, 1.8 s — a factor of 24.5
below the threshold** (confirmed: 55 measured, 55/1350 = 24.5). The only things that reach it are purpose-built fixtures
(`game/test/jamFixture.ts`'s STARVED variant, `sim/test/blocking.test.ts`'s
hand-built gridlock ring).

**Read that as a statement about the ARMS, not about the number and not about
the boards** — the sentence that used to stand here said "a valve that never
fires on a board that never deadlocks is a backstop doing its job", and
concluded that lowering the constant is a change no shipped board can observe.
**Both halves are wrong**: the board deadlocks on 6 of 8 seeds under the shipped
arm, and lowering the constant would be observable on all six. Raising it is
still free on the shipped seed and is not free in general. The first real tuning
evidence does not need a new board — it needs a seed sweep, and the numbers at
the top of this section are one.

**And the "refusals" column above is not evidence about blocking at all.** See
§15.3: `H_ROUTES_REFUSED` counts route WALKS that exceed `MAX_PATH_LEN` or come
back degenerate, and nothing in this module can reach it. It is 0 on all sixteen
seed x arm runs the wave-1 pass drove, and it will be 0 on the next sixteen. The
columns that measure blocking are `carBlockedTicks`, blocked car-ticks, the
longest queue and valve firings.

**This is the NO-INPUT path and it is NOT the blocking finding. See §10**, which
is a different claim on a different arm: on the *played* default, under the
greedy connector, `H_ROUTES_REFUSED` is 0 and the worst `carBlockedTicks` is 32
— 42× from firing — with cars genuinely queueing behind each other. `city`'s
zero here is the duller fact that an undrawn board has no route at all.

**M1e Task 12 re-measured the played arm on the PRODUCTION boot** — `createGame`,
its `InputQueue`, its frame loop — and reproduced Task 10's figures exactly, with
the valve count added: **0 firings in 31,456 ticks**, worst wait 32. Those three
numbers are now in `shared/constants.ts` as a third row and asserted in
`integration.test.ts`, so the constant's block no longer rests only on arms where
no car moves. **None of the three rows supersedes another**; they are three arms.
The first tuning evidence still needs a board that jams, which is M1f's.

## 6. The multi-tick draw divergence — documentation, not a regression

`resolve.ts`'s `MAX_DRAW_LAG_CELLS` bound is a **tick-boundary** bound and now
says so. Mid-frame, when a drain runs more than one tick, `|drawCar − lerpCar|`
reaches **0.9920 cells, 4.96× the clamp**, because `drawPrevXY → drawCurrXY`
spans the whole drain while `prevXY → currXY` spans only the last tick
(`frame.ts`'s `beforeStep` runs per tick, `afterDrain` once).

Not a regression — a multi-tick drain means the tab was starved and the car
really did move that far, and the chase adds at most its own outstanding lag on
top of it: measured as a per-(car, frame) excess of drawn step over exact step,
the worst is **0.2000** on the sustained schedule, which lands on
`MAX_DRAW_LAG_CELLS`. (An earlier draft argued this from a pair of
frame-displacement figures whose difference IS that bound — arithmetic dressed
as measurement. `resolve.ts` now names the three adjacent quantities separately,
because a review conflated two of them that differ by a third.) **One consequence is stated and NOT
measured**, and should not be quoted as if it were: over a multi-tick drain the
drawn car lerps along a chord spanning the whole drain, so the "never leaves the
road" argument's corner case is wider than 0.2 cells. The reproduction is
`resolve.ts`'s table with a route that turns inside one drain.

**Two things Task 12 adds to this section, both because the plan-time text and
the source disagree and the source is right.**

**The plan's *"What this plan does not settle"* quotes this divergence as
0.462 cells, 2.31× `MAX_DRAW_LAG_CELLS`. That figure is SUPERSEDED.** Task 11
Step 5 re-measured it with the enumeration written out — demo layout after its
warm start, one `snapshotPrev` per tick and one `snapshotCurr` per frame exactly
as `createFrameDriver` does it, alpha swept on a 21-point grid, the max over
every (car, frame) with `currLive === 1` — and got **0.9920 cells, 4.96×**, on
the every-frame-drains-7-ticks schedule. `resolve.ts`'s own table is the
artefact; the plan's number reproduces nothing. **Quote 0.9920 / 4.96×, and
quote the schedule with it**, because the three rows differ by 7.5× and a figure
without its schedule is not a measurement.

**And the DECELERATION half of the launch smoothing is not an open question — it
is PROVED unsatisfiable, and that proof must not be re-litigated.**
`resolve.ts` states three properties the renderer cannot give up: (i) `d <= s`,
a drawn car never further along its route than the sim car; (ii) `d = s` at
steady speed, no permanent offset; (iii) `|d''| <= A`, bounded acceleration.
Take a sim car going from constant `v` to a dead stop between two ticks at `t0`:
(ii) gives `d(t0) = s(t0)` and `d'(t0) = v`, (i) requires `d(t) <= s(t0)` after,
and (iii) forces `d(t) >= s(t0) + v(t - t0) - A(t - t0)^2/2`, which exceeds
`s(t0)` for small positive `t - t0`. **Contradiction.**

So the stop cannot be smoothed by anything that learns the car stopped only
after it stopped. The two escapes were considered and rejected with reasons: a
permanent speed-proportional lag gives up (ii) and can invert two cars' drawn
order under acceleration; reading `state.occupancy` to brake early gives up
causality-honesty, because in a moving platoon the next cell is occupied almost
all the time and distinguishing "occupied" from "occupied by a car that is
itself blocked" means re-deriving `canEnter` in the renderer — the exact
reconstruction `queueProbe.ts` already got wrong once, at a 5.7–15.2 %
disagreement rate.

**M1f may only fix the stop by giving the SIM a brake**, i.e. by making the
deceleration a fact about the simulation rather than an inference in the
renderer. That is a `rulesVersion` change and it belongs with §15.2's scheduler
work, not with the smoothing.

**Closing-sweep status of this section's figures: agreeing with the source of
record, and NOT independently re-measured.** 0.9920 cells / 4.96×, the 0.2000
excess, the 21-point alpha grid and the 5.7–15.2 % `queueProbe` disagreement all
match `resolve.ts:323-362` and `queueProbe.ts:36` word for word, and 0.2000 is
stated to equal `MAX_DRAW_LAG_CELLS`, which is a named constant. The superseded
0.462 / 2.31× appears nowhere in `packages/`, which is what "superseded" should
look like. **But every one of them is prose on both ends** — `resolve.ts` says
outright that `carSmoothing.test.ts` cannot see this quantity — so agreement
here means the handoff copied the source faithfully, not that the source was
re-checked. The 7.5× is arithmetic on `resolve.ts`'s own table (4.96 / 0.66) and
is not separately stated anywhere.

## 7. Things M1e verified are still inert, and must not acquire a manufactured test

Both were carried in as *correct as labelled*, each with a named condition that
ends it. Neither condition fired; both were re-confirmed by **reading the
constants**, not by re-running the equivalence.

- **`laneSpeedMul`'s rounding direction.** Inert because `speedUnits` maps each
  of 583/584 to 192 and each of 416/417 to 137, over the whole reachable set.
  Ends the moment `CAR_SPEED_UNITS_PER_TICK` or any multiplier constant moves.
  All five are byte-identical across M1e (base `1414e33`); the four `speedUnits`
  lines in `cars.test.ts` are the pin that fails when one does.
- **`stepCell`'s `y < 0`** (`roads.ts`) — a verified equivalent mutant through
  either caller, and the only change to that file in the whole milestone is a
  comment. **Do not tighten either caller's `next < 0` to `next === -1`** to
  manufacture a detector: that satisfies the label by strictly weakening two
  guards.

M1e adds two more to the register, both with derivations rather than assertions
and both recorded at their sites: the `while`-drain spelling in
`advanceAccumulators` (`demand.ts`) and `spawnScale`'s `>=`-vs-`>` cap
comparison.

**M1e Task 12's full pairwise sweep leaves the register at THREE, and moves one
entry off it.**

- **`4 <-> 5` — the spawn phase against the demand phase — is the milestone's
  one surviving 0-detector transposition**, over the complete C(10,2) = 45 set,
  four rounds against four fresh baselines. `step.ts` carries both reasons it
  commutes (a destination is ineligible on its own spawn tick, and §5.3.5's push
  goes through `fireColour` exactly as a scheduled pin does) and a tripwire for
  each. **Do not manufacture a detector for it**: the only edits that produce one
  are backdating `destSpawnTick` or routing the push around `fireColour`, and
  both are the changes the tripwires exist to catch.
- **`3 <-> 5` — inputs against demand — is OFF the register**, at 1 stable
  detector in 4 of 4 rounds. **The code did not change and this is not progress.**
  `step.ts`'s claim that *"a transposition of two commuting phases is inert
  however many phases sit between them"* was simply false: a positional
  transposition at distance 2 also drags inputs past the spawner, and it is
  `3 <-> 4`'s detector that fires. The two phases still commute with each other,
  and **the scheduled failure M1f owns is unchanged** — adding a `destPins` write
  to `placeRoad`/`eraseRoad` (§5.9's connectivity rule) makes them stop
  commuting, at 0 detectors, with `step.test.ts`'s disjointness scan as the only
  tripwire.
- The `laneSpeedMul` and `stepCell` entries are unchanged and were re-confirmed
  by reading the constants, not by re-running the equivalence. The four
  `speedUnits` pins ARE assertions — `583/584 → 192` and `416/417 → 137` at
  `cars.test.ts:1590-1593` — so that entry is anchored, not merely read.

**The closing sweep re-ran one register entry and added a second.** `4 <-> 5` is
re-measured at 0 over 1,843 (see §17). And `spawn.ts`'s `maxHouses`
short-circuit — the other labelled-inert line in this milestone — was
re-measured the same way: deleting it is **0 detectors over 1,843**, green in
all five packages, collection count unchanged, crash screen clean. Its comment
had carried only the 1,693-era figure. **Both entries now name the suite size
they were measured at**, because "0 detectors across the whole suite" in a
durable comment is a claim that silently re-points at whatever suite the reader
has.

---

# The four player-facing findings, which had no recipient at all

Sections 1–7 above were all anchored to a file, a constant or a function when
this document was written — **there is no section 8; the numbering skips it, and
renumbering is refused because `blocking.ts`, `layouts.ts`, `spawn.ts` and
`startingCity.ts` all cite §§9-12 by number** — which is this repository's catalogue entry *"a
handoff item with no home in the source is the one that evaporates"*, reproduced
**inside the document whose opening paragraph cites that rule**. The four items
below are the milestone's player-facing findings. They came from Task 10's
concerns and Task 5's carry, they lived only in `progress.md` and
`task-10-report.md` — neither of which is a plan-time artefact — and they were
dropped from the first draft of this file for exactly the reason the rule names:
none of them is about a function.

Each now has a home in the source as well, named per item. **Where a finding is
a judgement rather than a fact about code, that is said plainly rather than
disguised with a file path.**

## 9. THE DOMINANT FAILURE SHAPE: a spawner that is not connectivity-aware

*Task 5's carry, in its own words:* **"It killed three fixtures here and took two
commits to find the third. A player hits it the first time they don't connect a
spawned building, and NOTHING IN THE UI CAN EXPLAIN IT, because what they see is
a building they never asked for killing a city that looks fine. Design the ring
and the gate around UNREACHABILITY, not congestion."**

A spawned destination's carpark is road-free by construction, so it is never a
flow-field source, takes zero arrivals, and its §5.8 meter only ever fills.
Task 9's shutdown copy is keyed to exactly this (`NOTHING CAN REACH DESTINATION n`
rather than `OVERCROWDED`, chosen because it is computable from the board rather
than from run history), which makes the ENDING legible without making the DANGER
visible while there is still time to act.

**Updated M1f.** That copy read `NO ROAD REACHES DESTINATION n` and was decided
by `roads[carpark] !== 0` — a test one tile on the bay satisfies. The first
person to play the shipped build reported it inside a minute: *"the red dot
turns black when i start drawing a road from it and when i remove it turns red
again."* The predicate is now **"a house of this destination's colour is in the
same road component as its bay"**, folded in `game/frame.ts` and carried to
`render` as `RenderFrame.destReachable`; the sentence was re-worded with it. The
fix is a widening — every bay that was red is still red, because a bare carpark
is never a field source — so nothing about the danger-vs-ending gap above
changed. **The gap is still open**: the bay is red from the frame a destination
appears, which on the default board is **2,110 ticks (70.3 s) before the ring's
first byte** at tick 2,369, and neither says anything while there is still a
board worth saving on a run the player is actually playing.

**The obvious fix is not free and was refused with measurements.** M1e's plan
proposed tiering the spawn scan by proximity to the spawning colour's own
houses. Task 10 applied it verbatim across five seeds: it survives all twelve
weeks **by making the board inert** — peak `destPins` **1 in 65 of 65
week-observations**, zero blocked ticks in 63 of 65, four cars ever in motion,
delivery fraction ~1.00 — and the *baseline* is the arm that produces
the 1 → 2 → 5 → 10 gradient. A different greedy policy gives byte-identical
results, so it is not a tie-break artefact. **Connectivity awareness as
specified is a difficulty DELETION wearing a survivability improvement's
clothes.**

*(Corrected in the closing sweep: this paragraph read "four to five cars ever in
motion" and its home in the source, `spawn.ts:75`, says **four**. The lever is
not implemented, so nothing in the tree can arbitrate — but a handoff must not
be the looser of the two copies of a figure it is relaying. Every other number
in this paragraph matches `spawn.ts` word for word; the baseline gradient
`1 → 2 → 5 → 10` is separately ANCHORED at `integration.test.ts:3979`.)*

**Home in the source:** `packages/sim/src/spawn.ts`'s module comment, which is
the code that causes it.

## 10. M1d's HEADLINE FEATURE IS NOW DEMO-ONLY ON THE BOARD THAT SHIPS

*Task 10's concern 3, in the words its review asked to be carried:*
**"M1d's blocking on the default is a ~1-second hesitation, not a jam —
measured, not presumed. `H_ROUTES_REFUSED` is 0 over the whole run and the worst
`carBlockedTicks` is 32 against a 1,350-tick valve, 42× from firing. Cars do
stand behind each other (queue 4, 597 blocked ticks a week from week 5), but
nothing is ever refused a route and the valve cannot fire. For that feature
specifically the flip is a trade and the demo board is still the only place it
fires; for the user's actual complaint it is not — 3 houses become 25, 3
destinations become 12, 747 trips, and the outcome depends on what they drew."**

That is measured on the **played** default under the greedy connector, which is
the arm where cars actually run. **§5 of this document is not a substitute and
must not be read as one**: §5 measures the valve on the **no-input** path, where
the default has zero refusals for the different and duller reason that no road
exists at all.

**Narrowed by the M1f wave-1 pass, and the narrowing is the point of the item.**
Every figure in the quotation above reproduces exactly, and none of them is a
property of the board:

- **It is a property of the 20-tile opening.** The same connect-on-sight policy
  with the opening removed reaches `carBlockedTicks` **1,350** — the valve
  threshold itself — with longest queue **9** and **11** firings, first at tick
  19,957. Drawing only column 17 also valves (1,350 / queue 8 / 4 firings).
  Drawing only column 8 does not (32 / queue 4 / 0). **The trunk is the thing
  that prevents the jam.**
- **It is a property of `laneways-m2`.** On the shipped arm, nothing changed,
  **6 of 8 `RUN_SEED` values fire the valve** (0, 5, 2, 4, 11, 0, 13, 4).

So "M1d's headline feature cannot fire on the board that ships" is not what was
measured. What was measured is that it does not fire *on this seed when the
player draws the trunk*. Written as the board-level claim it tells M1f the board
cannot jam, and M1f would then have no reason to look — which is the same shape
as the milestone-scale defect this item exists to remember.

**Home in the source:** `packages/sim/src/blocking.ts`'s module comment, whose
heading now reads *"on the arm that draws column 8"* and carries the table.

The shape to notice is the previous milestone's: M1d shipped a headline feature
that could not fire on the board that shipped, and nobody found out until a
human opened it. The flip has re-created that condition for blocking
specifically, knowingly, with the trade stated.

**Home in the source:** `packages/sim/src/blocking.ts`'s module comment.

## 11. The five-tile save is undiscoverable in game

Nothing in the shipped UI tells a player that column 17 is the move. The
measurement is stark — a 15-tile column-8 road buys **zero ticks** and does not
even change which destination kills the city, while five tiles at column 17 buy
**750 ticks** — and both of the game's own signals arrive **on the board, after
the fact**: the overcrowd ring first appears at **1:19** and the run ends at
3:06. The ring names *which* destination; the shutdown line says *connect it*;
neither says *where*.

*(Corrected: this read 1:56, which is the **demo** board's first ring, tick
3,492. The city's is tick **2,369** — measured as the first tick
`frame.destOvercrowd[d]` is non-zero, which is `canvas.ts:1006`'s own draw
condition. D2 reaches its trigger cap at 2,191 and the meter needs 178 more
ticks to scale to 1 against `OVERCROWD_FULL_MILLITICKS`, so the cap tick is not
the visible tick. On a stopwatch, minus the 258-tick warm start: **1:10** and
2:57. The 750 ticks and the two death ticks are confirmed — 6,330 and 5,580,
both now asserted, see §15.7.)*

*("Buys zero ticks" is too strong and the M1f wave-1 pass measured how. Drawing
the corridor and nothing else agrees with drawing nothing on the death tick
(5,580), the killer (D2) and the first-ring tick (2,369) — and it produces **21
completed trips and a climbing score**, against 0 on the no-input arm. The score
is the only feedback the HUD gives, so the wrong first road does not read as
nothing happening; it reads as the game working. That is what makes it a trap
rather than a waste, and it is now the sentence beside the four-row table in
`startingCity.ts`. `startingCity.test.ts:928` already asserts `score > 0` on that
arm, labelled *vacuity* — it was doing more than that all along.)*

This is the same open question Task 9 left and Task 10 restated, and it is a
**design gap, not a bug**. It has no code artefact of its own, which is why it
is written at the site of the number that makes it true.

**Wave 1 closes part of it.** A destination **no car can drive to** now paints
its bay in the alarm colour from the frame it appears, so *where* is answered at
boot rather than at 1:19 — three red bays on the opening screen, and after the
corridor exactly one of the three, which is D2, the one that kills the run 5,321
ticks (2:57) later. *(M1f corrected the predicate behind that colour: it was
`roads[carpark] !== 0`, which one tile on the bay satisfies, and it is now "a
house of this destination's colour is in the same road component as its bay".
Every count in this section is re-measured against the corrected predicate and
none of them moved — the fix only widens the red arm, and the corridor genuinely
joins both left-hand bays to colour-0 houses at (8, 13) and (8, 24).)* It does not answer *which five tiles*; it answers
*which building*.

**Home in the source:** `packages/game/src/startingCity.ts`, in the four-row
death-tick table.

## 12. The first ten minutes are unloseable, and greedy play dies at 17:29

**17:29 is the un-subtracted clock, and this section's own §14 forbids it.**
`31456 / 30` = 1,048.5 s = 17:28.5, which is what rounds to 17:29. §14 defines
every time in this repo as `(tick − warmStart) / 30`, and the city's warm start
is 258 ticks: **(31,456 − 258) / 30 = 1,039.9 s = 17:19.9.** A player holding a
stopwatch reads 17:19.9. The heading is left at 17:29 because that is the phrase
Task 10's concern was written in and the quotation below is verbatim; every
other use should be the stopwatch figure, and `integration.test.ts:3981` now
carries both with a note saying which counter each is.

*Task 10's concern 1:* **"The board is easy for six minutes and then it is not,
and under greedy play it is dead at 17:29. The gate says the curve exists; it
says nothing about whether the curve is good. Weeks 0–3 hold every connected
destination at one pin — a competent player cannot lose in the first ten minutes
except by leaving a destination unconnected."**

Two further caveats travel with it. **The greedy arm's connector is optimal and
instant**, so it is an upper bound on "a player who keeps up" rather than a
model of one; Gate A's and Gate C's figures read as *what is reachable*, never
as *what is typical*. And **the gate is one seed** — `laneways-m2`, the one that
ships, which is the right choice for a claim about the shipped board, but three
of the five seeds measured do not produce the clean 1 → 2 → 5 → 10 gradient (two
jump 1 → 10, one never leaves 2). If M1f changes the spawner the gate may move
for reasons specific to this seed.

**This one is a judgement about pacing and the only instrument for it is a human
with the app open**, which is Task 12's device session — the thing in this
milestone with the least evidence behind it. Saying that plainly is more useful
than a file path; the file path below is where the caveats are recorded, not
where the question can be answered.

**Home in the source:** `packages/game/src/layouts.ts`, beside Decision 13's
own measurements.

---

## 13. Not carried here

The seed board is still **out of band** and therefore not replayable by a
Worker: `seedStartingCity`'s six placements happen before tick 1 and travel in
no input log. M1e's in-`step` spawner was expected to close that and does not —
it adds buildings on top of a seed it does not replace. M3's persistence depends
on it, and `game/src/startingCity.ts` says so at the site.

---

# 14. THE DEVICE CHECKLIST — five minutes, one phone, six questions

**Nobody has opened the flipped default.** Every visual judgement in M1e — the
overcrowd ring, the shutdown scrim, its four lines, the 2× killer ring — was made
by agents reading draw-command logs. The last time a person looked at this game
was the demo board on 2026-08-10, before the default was flipped, before the run
could end and before the ring existed. The sentence this milestone has to make
false is: **"zero human minutes on any of it: no person has seen a Laneways board
freeze."**

Task 12 cannot open a phone either. What it can do is leave a checklist ordered
by what is most likely to be wrong, with the expected observation and the moment
it happens beside each item. Run it in one sitting. Record the answers with the
words **"one device, qualitative"** attached, exactly as the 2026-08-10 session
did — it is evidence that the architecture holds, **not a measured budget**.

**Every clock time in this section was re-derived in the closing sweep.** They
are all `(tick − warmStart) / 30` and they all check out: tick 300 → 0:01.4,
378 → 0:04, 2,369 → 1:10 (**corrected from 2,191 / 1:04**, see Q2), 4,242 /
8,742 / 13,242 → 2:21 / 4:51 / 7:21, week 4's boundary → 9:51, 5,580 → 2:57,
6,703 → 3:03, 31,456 → 17:29. Two others are confirmed against the code: the
killer's ring really is drawn at **2× width** on the scrim
(`SHUTDOWN_RING_WIDTH_SCALE = 2`, `canvas.ts:347`, asserted at
`canvas.test.ts:3108`), and D2 really does reach **fourteen** pin dots on the
no-input run (measured `destPins[2] = 14` at the death tick, its
`PIN_CAP_CIRCLE_HARD`). Three are **UNVERIFIED** and marked where they appear:
"unmistakable by ~1:34", "the score should tick about 6 seconds after a 3-cell
stroke", and Q4's "182 assertions".

## Before you start: the clock you will be holding is NOT the clock in the source

Every time written in this repo — Task 10's report, `demoLayout.ts`'s "3 minutes
43 seconds", `startingCity.ts`'s "3:06" — is `tick / 30` counted from tick 0.
**Both boards run a warm start before the first frame**, so a stopwatch started
when the board appears reads *less*:

```
                warm start   dies at   source says   YOUR STOPWATCH WILL SAY
  city (default)   258        5,580      3:06                2:57
  demo             1,200      6,703      3:43                3:03
  city, greedy     258       31,456     17:29               17:19.9
```

**The third row was missing and §12 quoted its `source says` column as though it
were the stopwatch one.** It is the same 258-tick offset as row 1; the row is
here so the arithmetic is in the table rather than in a reader's head.

If the demo board goes dark at 3:03 rather than 3:43, **nothing is wrong** — the
1,200 warm-start ticks are 40 seconds the player never sees. Do not file that as
a bug; it is the difference between the two clocks, and it is written here
because it will otherwise look like a 40-second discrepancy in a headline figure.

## How to open each board

| what | link | note |
|---|---|---|
| the default (city) | the plain Mini App link | no parameter at all |
| the demo | `t.me/<bot>/<app>?startapp=demo` | send yourself the link and tap it |
| the DOM erase pill | `t.me/<bot>/<app>?startapp=fallback` | **new in Task 12** — opens the DEFAULT board with the DOM button instead of the MainButton. This is the recovery hatch for "the erase control reported a MainButton and never drew one"; before Task 12 it needed `?fallback=1`, which a Telegram webview cannot express. |

A Telegram webview has no address bar, so `?layout=` and `?fallback=1` are only
reachable in mobile Safari on the raw Worker URL. Use the `startapp` links.

---

## Q1 — Does the default board read as "draw a road here", or as a broken load?

**Highest risk, and it is the first second of the app.** The board this link
opens has **no roads on it at all**. Three houses, three destinations, six cars
parked, an empty grid. That is exactly what a failed asset load looks like, and
the person judging it is the person who will decide whether the app works.

- **At 0:00** you should see: a green field with a river running through it, a
  handful of trees, **three destination blocks** (two squares on the left at
  grid rows 10 and 18, one circle right of the river at row 14), **three houses**,
  six small cars sitting still, and a HUD reading **30 tiles** and score 0.
- **At 0:00, each of those three destinations has a RED parking bay** — the
  half-tile square beside it, in the same alarm red as the overcrowd ring
  (`#e8412e`), because no road reaches it. **This is new in M1f wave 1 and it is
  the answer to this question**: an empty board with three red bays on it is a
  board asking for something, where an empty board with three grey bays is a
  board that failed to load. Every seeded and every spawned carpark is bare by
  construction, so the count at boot is exactly three. *Watch for the failure
  mode: if it reads as "three things are broken" rather than "three things need
  a road", that is a finding.*
- **A bay turns grey the tick a road CONNECTS it — not the tick a road touches
  it.** Draw column 8 (the long clear column on the left) and the two left-hand
  bays go grey while the circle's stays red — one red bay on the board, measured,
  and it is the destination that ends the run 5,321 ticks (2:57) later. Column 8
  runs from D0's bay at (8, 10) past D1's at (8, 18) down to (8, 24), and it
  passes through colour-0 houses at (8, 13) and (8, 24), which is what makes both
  bays go grey; a stroke that stopped at (8, 12) would leave all three red. See
  Q3b for the ten-second version of that experiment. Each later spawn arrives with its own red bay: at
  1:06 (tick 2,250), 2:21 (4,500) and 3:56 (7,350) on the opening arm.
- **At 0:01.4** (tick 300) a **fourth house** appears next to one already there.
  *Does it read as an event, or does it just appear?* This is the only "the city
  is growing" signal the game has.
- **At 0:04** (tick 378) the first pin lands: a dot appears on one destination.
- Draw a road with your finger between a house and a same-colour destination's
  carpark. **A car should be running it within a second, and the score should
  tick about 6 seconds after a 3-cell stroke.** *(**UNVERIFIED** — the "6
  seconds" has no artefact. The nearest anchored figure is the seeded-city trip
  test, which scores at tick 435 from a first pin at 378, i.e. **1.9 s** on a
  much shorter route. Expect the right order of magnitude and do not file a bug
  against 6.)*

Answer: does the empty opening read as an invitation or as a failure?

## Q2 — Is the overcrowd ring readable at phone size, against the pin dots?

**The ring and the pins occupy the same few pixels by construction** — the ring
is drawn around the destination and the pins are dots on it. No human has seen
them together.

Do this on the **default board, doing nothing at all**:

- **At 1:10 on your stopwatch** (tick 2,369) a ring begins closing on the
  **circle right of the river, grid (14,14)–(16,15), whose carpark bay is at
  (17,14)**. It is colour 1's only destination and it is the one that kills the
  city. The ring starts empty and fills clockwise. *(Corrected: this said 1:04 /
  tick 2,191, which is when the METER starts, not when the ring first paints —
  `canvas.ts` draws nothing while the scaled byte is 0, and that takes 178 more
  ticks. If you are holding a stopwatch, 1:04 is six seconds early and you will
  look at an empty destination and file a bug.)*
- **1:10 is now the first LEGIBLE tick, which it was not before M1f wave 1.** The
  ring painted from 2,369, but at a meter of 1 the arc is 1.24–1.37 CSS px on
  the three tile sizes `fitCamera` produces, against a 4–5 px stroke — an arc a
  third of its own pen is a round cap and reads as a speck. `RING_MIN_SWEEP = 8`
  floors the drawn sweep at 8/255, so the first painted arc is 9.90–11.00 CSS
  px. **The first visible moment therefore advances by 326 ticks (10.87 s) per
  destination** — measured, and the same 326 on 12 of the 14 destinations across
  four arms; the two exceptions are destinations whose meter drains and
  re-climbs. Before wave 1 the first legible tick was 2,695, i.e. **1:21**.
  *(326 is the advance; the ring is legible on 327 ticks it previously was not.
  Two counters, one sentence — say which.)*
- The `meter !== 0` gate is untouched: a board with no overcrowding anywhere
  still draws no rings at all. The floor changes the shortest drawn arc, not
  whether one is drawn.
- **By about 1:34** (tick ~3,090) it should be unmistakable at arm's length.
  **UNVERIFIED** — "unmistakable" has no instrument in this tree and ~3,090 is
  not reproduced by anything; treat it as the reporter's estimate, not a
  measurement.
- **The same destination is accumulating pin dots the whole time**, up to
  fourteen. Question: can you tell the ring from the dots, or do they smear into
  one grey blob?
- The ring is drawn at **2× width** once the run has ended, over the scrim. That
  is the only place the thicker ring appears.

Answer: at what point is the ring legible without knowing to look for it? If the
answer is "never, until it is nearly full", the warning arrives too late to act
on and that is a finding, not a nitpick.

## Q3 — Does the shutdown screen say what happened, and can you find what it names?

Same run, keep watching.

- **At 2:57 on your stopwatch** (tick 5,580) the board dims and four lines
  appear:

  ```
  NOTHING CAN REACH DESTINATION 2
  CONNECT EVERY DESTINATION WITH A ROAD
  <your trip count>
  TAP TO PLAY AGAIN
  ```

  (`NO ROAD REACHES DESTINATION 2` until M1f. Same arm, same board, wider
  predicate — see Q3b below.)

  Trip count will be **0** if you drew nothing.
- **Nothing on the board is labelled "2".** The frozen board behind the scrim
  still shows the city, and the killer carries the 2× ring. Question: **with the
  screen in front of you, can you point at destination 2?** If the ring is the
  only way, say so — that makes the ring load-bearing for the ENDING as well as
  for the warning, which nothing has assumed.
- On the **demo** board (`?startapp=demo`, dies at **3:03** on your stopwatch)
  the first line is the other arm: `DESTINATION 2 WENT UNSERVED`. Both arms ship
  and they differ by two words. Do they read as different situations?

## Q3b — Draw ONE tile on a red bay and watch what the dot does

**This is the M1f fix, and it is the one question on this list a person can
answer in ten seconds.** Before it, one tile of road on a destination's parking
bay turned the bay from red to grey while nothing could still reach it. The
predicate now asks whether a house of that destination's colour is in the same
road component as the bay.

On a fresh default load, D2's bay is at grid **(17, 14)** — the red square just
right of the colour-1 circle.

1. Drag one tile down from the bay, to (17, 15). **The bay must stay red.**
2. Keep dragging to (17, 18), the colour-1 house. **The bay turns grey on the
   tile that lands on the house cell, and not before.** One cell short is not
   connected — a house whose own cell carries no road bit has `dist = INF`
   forever.
3. Erase any middle segment. **Red again, immediately.**

Question for the person holding the phone: **at step 2, is the moment the dot
changes legible as "you just connected it", or does it read as a flicker?** The
signal is now true; whether it is *noticeable* has never been looked at, and the
whole point of the change is that a player learns what the colour means by
causing it.

Also worth an eye: on the default board **all five** destinations are red at the
end, and three of them are red from the first frame. Is five red squares a
useful warning or wallpaper?

## Q4 — The ghost art: 182 assertions (UNVERIFIED count), zero human minutes

Two pure aesthetic judgements are baked into the renderer and neither has ever
been looked at: the ghost stroke is **half the live road's width**
(`atlas.ts:112`), and spec §6's 55–65 % width band was **deliberately ruled not
to apply** (`atlas.ts:120`) on the reasoning that the band governs roads and *"a
ghost is the absence of one."* That reasoning is sound and unvalidated. A
half-width dashed ghost may read as an elegant fade or as a rendering glitch, and
only a person looking at a phone can tell those apart.

Do this on **`?startapp=demo`**, which is the only board with enough traffic:

- Turn on erase (the button reads **ERASING - TAP TO DRAW** while it is on).
- **Drag over five cells of a busy corridor.** Five, not three: a drag samples
  adjacent pairs, so a stroke over N cells takes both road bits off only the
  **N − 2 in the middle.** A three-cell stroke fades one cell.
- Whether a cleared cell **ghosts at all** depends on the traffic at that
  instant: a cell with no car committed to it is deleted outright and refunded on
  the spot; a cell with cars committed fades and pays back as they cross off.
  **Try it twice** — once on a quiet stretch (expect: it just vanishes) and once
  behind a queue (expect: a half-width dashed remnant that disappears a second or
  two later).
- **Do one of these before 3:03 and one after a restart**, so the restart is
  exercised by a person rather than only by a test.

Answer: elegant fade, or glitch?

## Q5 — Does the run have an ending, or does the app just crash and reload?

**This is the question with the least evidence behind it in the whole
milestone.** The restart is `location.reload()`. It is correct by construction —
it preserves `?startapp=demo`, it costs one warm start, and no byte of sim state
survives it — and *correct is not the same as good*. Nobody has seen one.

After a shutdown screen, tap the board and answer three things:

1. Does the tap start a new run **at all**?
2. Does it read as *"tap to play again"* or as *"the app crashed and reloaded"*?
   Watch for a white flash, the Telegram loading bar, the board flickering in.
3. Does losing a four-minute run and being returned to an empty board feel like a
   game, or like being thrown out?

Also, cosmetically: **the erase control stays visible and active after the run
ends** (§4 of this document). Board input is refused and every tap restarts, so
it is harmless — but if pressing it does something visible, say so.

## Q6 — Are the first ten minutes good, or merely unloseable?

**§12 says this outright: no file path settles it, and this session is the only
instrument.** Measured: for the first eight weeks the only way to lose the
flipped board is to leave a destination unconnected, and a competent player will
not. Under optimal, instant play the board is dead at **17:29**.

Play the default board properly for as long as you can stand — five minutes is
enough:

- **Weeks 0–3 (up to 9:51 on your stopwatch)** every connected destination sits
  at **one pin**. Nothing queues, nothing waits, nothing is ever refused a route.
- **The tile counter jumps by 30 at 2:21, 4:51, 7:21, …** and you will never run
  out: the connection bill is **62 tiles against 210 granted** and the counter
  never falls below 37. *(Corrected from "41–57 against 390" — see §15.5. The
  three stopwatch times are arithmetic on `TICKS_PER_WEEK` minus the warm start
  and are confirmed: `(4500k − 258) / 30` gives 2:21, 4:51, 7:21.)*
- A new destination appears somewhere you have no road, roughly every 2.5
  minutes; a new house every 10 seconds or so until the board fills.

Answer: is that stretch pleasant, or is it dead air? The honest measured sentence
is *"the board is easy for twenty minutes and then it is not."* This plan made
that true and measured; it did not make it good.

---

## The five sentences this session is really testing

If the session does not produce these unprompted, the milestone missed:

1. A plain link opens a board where **buildings appear**.
2. **Tiles arrive** every two and a half minutes.
3. **Rings fill** on destinations you have not reached.
4. The city eventually **shuts down and tells you which destination did it and
   how many trips you made**.
5. **A tap starts you again.**

## One thing you will NOT see, and it belongs in the same session

**M1d's headline feature — blocking — is demo-only on the board that ships.**
Measured over 31,456 ticks of competent play on the default: `H_ROUTES_REFUSED`
is **0**, and the worst any car ever waits is **32 ticks — 1.07 s, a factor of 42
below the 1,350-tick anti-deadlock valve.** Cars do stand behind one another from
week 2 (longest queue 4, 597 blocked ticks a week from week 5), but nothing is
ever refused a route and the valve cannot fire.

So: if you are looking for a traffic jam on the default board, **there is not one
to find**, and its absence is not a regression. The demo board is the only place
the valve has ever fired outside a purpose-built fixture. See §10.

---

# 15. WHAT M1e DOES NOT SETTLE — the tuning questions, each with its measurement

Sections 1–8 are things M1e chose not to BUILD. This section is different in
kind: these are numbers M1e **shipped and did not tune**, or mechanisms it
implemented and could not evaluate. Every one comes out of the plan's *"What
this plan does not settle"* block, which is a plan-time artefact M1f will not
read; carrying the bullet without its measurement would leave M1f re-deriving
each figure from scratch, which is how a handoff becomes a rumour.

**Read the whole of this section before changing any constant in
`shared/constants.ts`.** Several of them are coupled in ways no single site
records, and three are `rulesVersion` bumps that invalidate stored replays.

### FIRST: seed variance dwarfs most single-constant effects, so most of the numbers below cannot be compared across one run each

Measured by the M1f wave-1 pass. **Eight `RUN_SEED` values, nothing else changed
at all** — same board, same constants, same greedy arm, driven to death or 12
weeks. The enumeration, because a span quoted without its seed list is not a
measurement: `laneways-m2` (the shipped one), `s1`, `s2`, `s3`, `s4`, `s5`,
`s6`, `s7`.

```
  blocked car-ticks   1,298 - 42,381   (32.7x)
  trips                 181 -  1,737   ( 9.6x)
  death tick         16,122 - 51,275   ( 3.2x)
  longest queue           4 -     13
  valve firings           0 -     13   (6 of 8 seeds fire at all)
  H_ROUTES_REFUSED        0 -      0   (see 15.3; it is not an instrument)
```

**The operational rule: a single-seed claim smaller than 2x is inside the
noise.** Almost every figure in §15.1 through §15.9 is a single-seed reading,
and several of the levers they discuss are being judged on differences far
below 2x. Before adopting one, run it across a seed set and compare
distributions, not runs — and state the seed list, because these endpoints are a
property of *these eight seeds* and a different eight will give different ones.
The ratios are the durable half; the endpoints are not.

Two consequences that bite immediately. **A tuning change that "improves" one
seed by 30 % has not been measured.** And **the shipped seed is not typical** —
it is the quietest of the eight on blocked car-ticks and one of only two that
never valve, so any claim of the form "the board does X" that was taken on
`laneways-m2` alone is a claim about `laneways-m2`.

## 15.1 The demand ramp's three numbers, and why the shipped board cannot judge them

Spec §5.3 calls `spawnScale` *"the single most important tuning unknown in the
project"* and §13 lists it as an open risk whose mitigation is the telemetry
overlay. M1e implemented it (Task 6) and tuned nothing.

Measured: on the shipped board the ramp changes the no-input death tick by
**1.0 %** and changes peak `destPins`, longest queue, refusals and blocked ticks
by **zero**. On a 41-cell corridor the same ramp is the entire difference between
surviving 60,000 ticks and dying at week 9.

**UNVERIFIED, all four figures** — 1.0 %, the 41-cell corridor, 60,000 ticks and
week 9. The corridor rig has no artefact in the tree; the nearest surviving
fixture is `loop.test.ts:2793-2836`'s **20×9, 25-cell** coping board, which does
reach its timer cap in week 9 (`loop.test.ts:2962`) but is a different geometry,
so quoting it as corroboration would be the mistake this sweep exists to stop.
The *shape* of the claim — that the ramp's effect is a function of round-trip
length, and this board does not produce one — is not in doubt; the numbers under
it were not re-run.

**So it is correctly implemented and its effect is a function of round-trip
length, which M1e's board does not produce.** Freezing `pinPeriodForWeek` at
week 0 leaves Task 10's Gate B green; freezing the destination SPAWNER takes
week 1's delivery fraction to 1.05 and turns it red. The dominant term in "demand
grows" on this board is the rotation slots each new destination adds, with the
ramp a distant second — and the ramp's effect is therefore **confounded with the
spawner's and cannot be attributed by a player.**

Changing it is a `rulesVersion` bump.

## 15.2 The round-robin / nearest-source mismatch — the biggest thing M1e leaves open

**This is the term that actually decides whether a CONNECTED destination lives**,
and it is the mechanism behind the default board's own death at 31,456.

`advanceAccumulators` (demand.ts) distributes pins **evenly** across a colour's
rotation slots. `assembleSources` (dispatch.ts) routes cars to the **nearest**
unfilled pin. Within one colour those two rules disagree, and the disagreement is
not marginal: a measured **297 / 10 / 0** trip split against a 2:1 demand ratio
is an ordinary outcome — **UNVERIFIED**, that split has no artefact anywhere in
the tree and was not re-run. What IS confirmed is the consequence stated at the
foot of this section (97.5 % delivery with `H_ROUTES_REFUSED` at 0, both
asserted at `integration.test.ts:3960` and `:3969`), which is the evidence the
handoff actually rests on. §5.9's house-clustering rule compounds it.

Task 10's lever — the greedy connector's ordering — is the cheap half. The real
fix is one of three, and **all three are changes to §5.3's stated scheduling rule
and to `dispatch.ts`'s Decision 4**:

1. seed the flow field only at the most-starved destination;
2. weight sources by `destPins`;
3. route the rotation to the shortest queue.

**M1f owns choosing between them.** Note the shape of the evidence M1e leaves:
the default board's greedy arm delivers **97.5 %** of every pin demand fires,
right up to the tick it dies, with `H_ROUTES_REFUSED` at 0. The network is not
the constraint. The scheduler is.

## 15.3 `MAX_PATH_LEN` = 96 is a hard ceiling and nothing in the game says so

96 route steps is the maximum distance a house may be from a carpark.
`MAX_PATH_LEN = 96` is confirmed (`constants.ts:289`, and `dispatch.test.ts`
keys many assertions off it). Measured: on a 101-cell corridor **every dispatch
is refused**, and a **fully connected** destination is unservable and dies, with
or without the ramp — **UNVERIFIED**, no 101-cell corridor fixture exists in the
tree; `dispatch.test.ts:1004` exercises the boundary at 97 steps instead. The
ceiling is real and pinned; the corridor demonstration is not reproducible here.

On a 14×22 rect a sensible road never approaches 96 steps. A winding one can, and
**the failure is silent** — `H_ROUTES_REFUSED` rises and nothing else. There is
no message, no ring, no colour, nothing on the HUD.

M1f should either surface it or bound it. Surfacing is the cheaper half: the
refusal count is already in the header.

### `H_ROUTES_REFUSED` IS NOT A BLOCKING INSTRUMENT, and this document has quoted it as one

**Measured by the M1f wave-1 pass, because §5's table and this section both lean
on it and neither says what it counts.** `dispatch.ts:619` increments it in
exactly one place, for three conditions that are all about the route WALK:

1. the walk exceeded `MAX_PATH_LEN`,
2. the route came back zero-length (the house cell IS a carpark),
3. the walk did not terminate on a colour-matching carpark.

**Nothing in `blocking.ts` can reach it.** A car refused entry keeps its
committed route and waits; no counter here is touched. So its being 0 is
evidence about route geometry and about nothing else, and reading a 0 in a
column headed "refusals" as "traffic flows freely" is the same error §5 already
records under *two quantities under one column heading*.

Two measurements settle it:

- On the shipped seed's greedy arm the **longest route ever walked is 21 steps**
  against the 96-step ceiling — 75 steps of headroom, on the widest arm this
  board produces.
- Setting `MAX_PATH_LEN` to **24** leaves the run behaviourally unchanged: tick
  31,456, 747 trips, refusals still **0**. A ceiling four times lower is still
  not binding.

It is 0 on all sixteen seed × arm runs measured. **It will stay 0 under every
traffic lever M1f can pull, for a reason unrelated to traffic.** The observables
that measure blocking are `carBlockedTicks`, blocked car-ticks, `longestQueue`
and valve firings; §5's table now says so, and so does `blocking.ts`.

**And lowering it is not free even though it changes nothing.** See §16's
digest-mover class: `ROUTE_BYTES = MAX_PATH_LEN / 2` sizes the `carRoute`
region, so 96 → 24 shrinks `firstCity`'s state buffer from 13,992 to 11,112
bytes and turns **8 of the 9 goldens red** on an identical run. Surfacing the
ceiling costs nothing; changing it costs a nine-site re-bless for no behaviour.

## 15.4 Whether `DESTINATIONS_PER_WEEK` = 2 and `HOUSES_PER_DESTINATION` = 2 pace the city

Both are [OURS] with no source in the spec. **All four bullets below were
re-measured in the closing sweep and three of them moved**, because the arms
that produce them changed under Task 8's freeze: nothing that ships now reaches
week 10, so a 40-week figure needs a rig that says so.

The rig, stated because the numbers are meaningless without it: the no-input
city, stepped 180,000 ticks with §5.8 SUPPRESSED — `destOvercrowd` and
`destOverTicks` zeroed after every step, which nothing but `overcrowd.ts` reads,
so the spawner, demand and dispatch are bit-for-bit the shipped ones and only
the ending is removed.

- the schedule delivers ~~0.275~~ **0.250 destinations a week**, not 2 — ten
  added over forty weeks. The retry cadence and the geometry dominate the
  nominal rate, which is the finding and it survives the correction;
- the board seats ~~14~~ **13** rather than the declared `maxDestinations` of
  16, with the last placement in ~~week 10~~ **week 8** (tick 38,700, 26 houses
  standing at that moment);
- on the PLAYED board it is ~~13 by week 8~~ **12, in week 6, and the run ends
  there** — the greedy arm dies at 31,456, which is week 6, so it never sees
  week 8 at all. Reproduced against the shipped figures first: this rig gives
  death 31,456, 747 trips, `H_ROUTES_REFUSED` 0, matching
  `integration.test.ts:3949` exactly before it was believed about anything else;
- ~~after that the spawner is in permanent `BOARD_FULL`~~ — **it is
  `SCAN_EXHAUSTED`, and `BOARD_FULL` is UNREACHABLE on this board.** This
  contradicted the paragraph twelve lines below it, which was right.

**`BOARD_FULL` has two returns and neither can fire on `firstCity`**
(`spawn.ts:426` and `:450`). The first needs `H_DEST_COUNT >= maxDestinations`,
i.e. **16** destinations, against a board measured to seat 13 with no input and
12 played. The second needs `limit >= zoneCells`, i.e. `24 >= 308`. Both
measured on the tree: `spawnZoneCells(firstCity) = 308`,
`SPAWN_CANDIDATE_LIMIT = 24`, `maxDestinations = 16`. So a failing destination
scan on this board is always `SCAN_EXHAUSTED`.

**Why this one mattered more than its size.** `pushBlockedSpawnDemand` — §5.3.5's
redistribution — is called from those two returns and from nowhere else, so a
task tuning `DESTINATIONS_PER_WEEK` off bullet 4 would believe the
redistribution is firing on the shipped board. It fires **zero** times. That is
exactly what the paragraph at the end of this section already said, and the two
have been contradicting each other since the section was written.

**The cause is geometric, not arithmetic**: seven contiguous free cells at
Chebyshev ≥ 2 from every other destination, inside a 308-cell rect already
carrying a river, **eight trees** (confirmed — 8 inside the zone, 24 on the
board) and **25–28 houses** (~~27~~ — measured 25 on the greedy arm at its
death, 26 at the last destination placement on the suppressed arm, 28 at forty
weeks; 27 is in the band and is not a reading of anything) and the player's
roads. `HOUSES_PER_DESTINATION` is measured **not to be a lever** at 1, 2 or 3 —
**UNVERIFIED**, that sweep has no artefact in the tree and was not re-run.

**A consequence Task 12 measured, and the bullet list above disagreed with it
for the whole life of this document:** on `firstCity` the clipped spawn zone is
**308** cells against a `SPAWN_CANDIDATE_LIMIT` of **24**, so a failing
destination scan is always `SCAN_EXHAUSTED` and never `BOARD_FULL` — which means
**§5.3.5's blocked-spawn redistribution never fires on the board that ships.**
0 pushes in 31,456 ticks of greedy play. Both of its arms are exercised only on
`jamFixture`, where `maxDestinations` is 1. All three figures confirmed on
`14e7dee`; `allocation.test.ts:2921-2939` carries the same paragraph and asserts
`SPAWN_CANDIDATE_LIMIT < 308`.

## 15.5 Whether 30 tiles a week is right for a 308-cell rect

It is §5.10's Road Tiles rate on a board a **tenth** of the original's, and it is
measured to be slack by a factor of **3.4** on the arm that ships:

- the whole destination-connection bill is ~~41–57 tiles against 390 granted~~
  **62 tiles against 210 granted** — 30 to start plus six weekly grants of 30,
  because the greedy arm dies in **week 6** and never collects the thirteen
  grants 390 assumes. Measured on the same rig that reproduces 31,456; the same
  pair is asserted at `integration.test.ts:3985`;
- the median connection is **3 tiles** — **UNVERIFIED**, no artefact;
- there were zero unaffordable events ~~in fifteen runs~~ — **confirmed for the
  one run that ships**, `expect(r.unaffordable).toBe(0)`
  (`integration.test.ts:3988`); the "fifteen runs" aggregate has no artefact and
  is UNVERIFIED. The greedy arm's `tilesLeft` never drops below **37** —
  confirmed, asserted exactly at `integration.test.ts:3986`.

*(The 41–57/390 pair is the shape this whole sweep is about: both halves were
right for a twelve-week run, and Task 8's freeze made the run six weeks long
without anyone re-reading the tile arithmetic. The CONCLUSION is unchanged and
is if anything understated — 62 of 210 is still 3.4× slack, and `tilesLeft`
bottoming at 37 says the constraint never binds.)*

Tiles stop binding around week 3. After the colour unlocks end at week 4 the
weekly boundary carries nothing but the destination timer — **which does not need
a week concept at all.**

**That is the honest cost of deferring the card modal** (§1), and it belongs
beside the ramp rather than inside the Out table's argument for the deferral: the
deferral did not merely postpone a feature, it left the week boundary doing
almost nothing on the board that ships.

## 15.6 `OvercrowdTimerCarArrivalDeceleration` = 0.5 — dossier §1.10's EIGHTH constant

**Dropped by spec §5.8's transcription, recovered by M1e's Decision 4, named,
measured and deliberately NOT implemented.** It has no code artefact anywhere in
this repo — no constant, no test, no comment at a call site — which is exactly
why it is written out in full here.

What it does: while a destination is at or over its pin capacity, an arriving car
**halves the rate the overcrowd meter climbs** for some window, on top of the
existing 10 %-of-current knockback.

**Carry the measurement with it.** It widens the survivable arrival interval for
a destination held at its cap from **90 ticks to roughly 300** — a factor of 3.3.
Below that interval the destination lives; above it, it dies.

**Its measured effect on both shipped boards is ZERO ticks**, and the reason is
worth stating because it is the reason it was deferred rather than a coincidence:
**both shipped boards die at an arrival interval of infinity.** `city`'s D2 and
`demo`'s D2 are each served by exactly nothing — a bare carpark on one and an
unreached destination on the other — so a constant that widens the survivable
interval cannot help a destination whose interval is unbounded.

**It becomes worth having the moment a board exists on which a dying destination
is still being served.** That is precisely the board §15.2's fix produces, so
these two items are coupled: implement the scheduler fix and this constant stops
being inert on the same day.

## 15.7 The square→circle upgrade, §5.2 — the missing half of a graded difficulty model

**The only mechanism in the spec that raises ONE destination's demand without
adding a destination.** M1e has exactly one difficulty dial that moves during a
run — the spawner adding destinations — and it is coarse, geometric and
self-limiting (§15.4). §5.2's upgrade is the fine one, and it is not implemented.

**Decision 2's arithmetic, carried with it, because it is what makes the
mechanism worth having and it is written down nowhere else:**

- a **square** carries **one** rotation slot, trigger cap **6**, hard cap **10**;
- a **circle** carries **TWO** rotation slots, trigger cap **8**, hard cap **14**;
- so upgrading one destination from square to circle **doubles its arrival rate**
  while raising its trigger cap by only 33 %.

The net effect on time-to-death is therefore **strongly negative** — the
destination becomes harder, not easier — and that is the measured asymmetry M1e
discovered on the board that ships: on `firstCity` the colour-1 **circle** dies
at **5,580** where the colour-0 **square** would have died at ~~6,357~~
**6,330**, despite the circle's higher cap. Same board, same first pin at tick
378; the circle takes a pin every 259 ticks and the square one every 518.

*(Corrected. **6,357 is the pre-spawner number** — D0 caps at 2,968 with
`H_DEST_SPAWN_TIMER` parked. On the live tree Task 5's spawner adds a third
colour-0 destination, `slotCount(0)` changes, and D0 caps at **2,941**, giving
`2,940 + 3,390 = 6,330`. `da63dc2` corrected this once and it came back, twice —
here and in a new `integration.test.ts` comment. **Both arms are now asserted**
in `startingCity.test.ts`'s *"is not vacuous: WITHOUT the link"*: 2,941/6,330
live and 2,968/6,357 parked, on the same rig, which is what a prose figure could
not do. 5,580, 378, 259 and 518 are all separately confirmed and anchored.)*

**So the upgrade is a real difficulty lever with a known sign and a known
magnitude, and M1f can price it before building it.** `integration.test.ts`'s
first arm carries the same derivation at the site where it is checkable.

## 15.8 Whether the pin capacities are the right run-length dial

§5.8 says they are: *"square triggers the timer at 6, hard cap 10; circle at 8,
hard cap 14. These are the primary run-length dial. Tune them before touching
anything else."*

M1e **implements them and tunes nothing.** `PIN_CAP_*` got its first reader in
Task 7; before that the four constants sat in `constants.ts` unread.

The asymmetry in §15.7 is the whole finding: **a circle carries two rotation
slots, so it receives pins twice as fast as a square and its higher cap does not
compensate.** Anybody tuning these four numbers has to tune them against
`computeSlotCounts`, not in isolation — raising `PIN_CAP_CIRCLE_TIMER` from 8 to
12 would be the *arithmetic* equivalent of leaving it at 8 and giving the circle
one slot, and only one of those two edits is legible at the screen.

## 15.9 Whether one car per lane-tile feels right

Still **half** the spec's density, on the spec's own two-lane road. Two cars per
lane-tile needs sub-cell slots whose identity changes at every turn, which is a
shape change to `occupancy` and to every `canEnter` caller.

**Do not add a `CARS_PER_CELL` constant "for later."** A constant with one
possible value is a comment that the type system pretends to enforce, and this
repo has an entry for the shape.

## 15.10 Frame cost under a full jam, with numbers — still unmeasured

A human reported the demo board **smooth throughout at 24 cars** — one device,
qualitative, no Android, no `performanceClass: LOW`. That retires the fear of a
latent cliff at that density. **It is not a budget.**

And the new default board's car count **grows without bound as the city fills**:
25 houses is 50 cars by week 6 under greedy play, twice the demo board's fixed
fleet, on a board nobody has profiled on a phone. The allocation harness says the
frame allocates nothing; it says nothing at all about frame TIME.

*(Confirmed: 25 houses by week 6 is asserted at `integration.test.ts:3984`, and
`CARS_PER_HOUSE = 2`, so 50 is arithmetic on two anchored numbers rather than a
third measurement. "Grows without bound" is loose — `firstCity`'s `maxHouses` is
**40**, so the ceiling is 80 cars and the board hits its §5.8 death long before
it. The concern stands; the phrase overstates it.)*

## 15.11 What the restart feels like

M1e's restart is `location.reload()`: correct by construction, preserves
`?startapp=demo`, costs one warm start, and mutates **not one byte** of sim state
(`integration.test.ts` asserts that directly). It is also a full page reload, and
**nobody has seen one.**

§14's Q5 is the only evidence there will be. A seamless in-place restart
(`resetState` in `sim`) is M3's.

---

# 16. THE GOLDEN LEDGER — nine digests, where each lives, and what moves it

> **SUPERSEDED IN PART — 2026-08-23, M1f Task 5.** This section is the handoff
> INTO M1f and its digests are M1f's OPENING values; two of the nine have moved
> since, and one line below is now wrong rather than merely dated. Read this
> section as history and `sim/test/determinism.test.ts` and
> `sim/test/loop.test.ts` as the authority.
>
> **Moved by Task 5, behaviourally, for `step`'s new phase 4 (the card offer):**
>
> | golden | prior (this table) | Task 4 | Task 5 |
> |---|---|---|---|
> | state | `1058753394` | `4189191826` | **`2986084740`** |
> | demand-pin | `894844668` | `2425471180` | **`884326142`** |
>
> Those are the only two of the nine that cross a week boundary — verified by
> running the other seven rather than by reading this table's descriptions: the
> road-network, field, seed, demo and rejected-circle fixtures take **no tick at
> all**, and the loop (130 ticks), queue (25) and multipliers (110) runs sit
> inside week 0.
>
> **And one sentence below is now FALSE, not just dated.** *"No golden sees phase
> 10"* is still true of the overcrowd meter (which is phase **11** from Task 5
> on — the phase count went 10 -> 11 by inserting at position 4). But the
> ledger's implicit claim that the goldens are blind to the CARD path has ended:
> the two above now fold `H_OFFER_A`/`H_OFFER_B`. What they still cannot see is
> `drawOfferPair`'s internal re-mix, because `poolFor` returns two cards and at
> `n = 2` slot B has one candidate — measured, 0 of 20,000 seeds differ at n = 2
> against 13,320 of 20,000 at n = 4. A three-card pin in `cards.test.ts` covers
> that line instead. **Do not diagnose a moved golden as the re-mix.**
>
> **M1f Task 6 moved NOTHING, and the reason is worth one line because it is the
> reason Task 7 and Task 8 will move things.** Task 6 wired `choose-card` as a
> `TickActionKind` and `applyChooseCard` as its phase-3 handler, which writes
> `H_TILES`, `H_INV_UPGRADES` and `H_OFFER_WEEK`. **No golden fixture enqueues
> any action at all**, so all nine are unmoved and `H_OFFER_WEEK` is 0 in every
> one of them — verified by running them, and re-verified as a property by
> `m1fSplice.ts`'s `assertM1fShapeApartFromTheOffer`, which asserts the slot
> beside the hash so a golden that started to resolve a week fails there rather
> than in a digest. The clause that ends this is **Task 7 giving the headless
> rigs a card policy**: from that point a rig that takes a card moves `H_TILES`
> by 20 or 30 on top of the weekly grant, and any golden it drives re-blesses.
> Task 7 owns naming which.
>
> **The nine, at Task 6, all green and all unmoved:** state `2986084740`,
> road-network `1099508647`, field `252514232`, loop `1219899230`, queue
> `3831930847`, demand-pin `884326142`, multipliers `2274456329`, seed
> `613441763` (both sites), demo `4178976587` — plus the rejected circle variant
> `2889011739`.

M1e opened with seven goldens and closes with **nine**. Two were minted in the
milestone (Task 1's re-bless produced no new digest; Task 6's demand-pin golden
and Task 10's inheritance of the demo golden are the arithmetic). All nine are
green and unmoved at the close of Task 12.

**The rule this table exists to enforce is the catalogue's:** *"before writing
'this task re-blesses X', derive that X actually moves — and name which task owns
each move, so a golden that moves for an unlisted reason still stops the world."*
A false authorisation to re-bless is worse than no authorisation, because it is a
standing permission that absorbs an unrelated regression silently.

> **SUPERSEDED FOR THE DIGEST COLUMN ONLY, at M1f Task 4 (the milestone's single
> shape change). Every other column still holds.** `HEADER_LENGTH` 13 -> 18 plus
> one region (`upgradeAt`, one `Uint8` flag per cell) moved **eight of the nine**
> for pure layout. The field golden did not, because it hashes flow fields rather
> than the buffer — which is the tripwire this table says it is, and it held.
>
> | name | this table | after M1f Task 4 |
> |---|---|---|
> | state | `1058753394` | **`4189191826`** |
> | road-network | `2312109239` | **`1099508647`** |
> | field | `252514232` | **`252514232` — unmoved** |
> | loop | `1877236894` | **`1219899230`** |
> | seed | `968680755` | **`613441763`** (both sites) |
> | queue | `307910575` | **`3831930847`** |
> | multipliers | `1531344761` | **`2274456329`** |
> | demo | `3152640907` | **`4178976587`** |
> | demand-pin | `894844668` | **`2425471180`** |
>
> The table below is left as written because it is the handoff INTO M1f and is
> correct as history — the catalogue's own classification warns against
> "correcting" a historical figure to today's number. What it is NOT safe to do
> is read the digest column as current, which is what this note exists to stop.
> Each new digest is asserted with an `spliceM1fInsertions` proof against the
> value in this table, so the two are linked by a running assertion rather than
> by this paragraph.
>
> A tenth digest joined the set here: the **rejected circle variant**,
> `3282272491` -> `2889011739`, which lived only in a `startingCity.ts` comment
> that instructed the reader to re-derive it by hand. M1f Task 4 put a runner
> under it (`startingCity.test.ts`), so it is now pinned like the rest.

| digest | name | asserted at | what moves it |
|---|---|---|---|
| `1058753394` | **state** | `sim/test/determinism.test.ts:733` | any change to the state buffer's SHAPE or to `createState`'s initialisation. Moved twice in M1e (`883875991 -> 1058753394` at Task 5). Mirror-scanned as a string by `loop.test.ts:1322`, so a re-bless must edit both. |
| `2312109239` | **road-network** | `sim/test/rollback.test.ts:820` | `placeRoad`/`eraseRoad` semantics, the tile ledger, the ghost regions. Scanned by `loop.test.ts:1324`. |
| `252514232` | **field** | `sim/test/rollback.test.ts:864` | `flowfield.ts`'s relaxation, `edgeCost`, the bucket structure. **Not** the allocation shape — Task 3 removed an allocation and this did not move. Scanned by `loop.test.ts:1327`. |
| `1877236894` | **loop** | `sim/test/loop.test.ts:1285` | the tick order, movement, dispatch, blocking. The broadest of the nine. |
| `968680755` | **seed** | `game/test/startingCity.test.ts:772` **and** `game/test/demoLayout.test.ts:599` | `firstCity`'s map bytes or `seedStartingCity`'s six placements. **Two sites**, deliberately: `demoLayout.test.ts` asserts it to prove the demo work left the shipped seed alone. |
| `307910575` | **queue** | `sim/test/loop.test.ts:2296` | the blocking/queueing path on the queue fixture. |
| `1531344761` | **multipliers** | `sim/test/cars.test.ts:1809` | `laneSpeedMul`, `CAR_SPEED_UNITS_PER_TICK`, any turn or intersection multiplier. |
| `3152640907` | **demo** | `game/test/demoLayout.test.ts:574` | `demoCity`'s map bytes or `seedDemoLayout`. **`firstCity` cannot reach it** — a correction M1e Task 2 got wrong and its reviewer measured: changing `firstCity.startingTiles` moves **one** golden, not two, because the demo golden is `hashState` over a state built on `demoCity()`. |
| `894844668` | **demand-pin** | `sim/test/loop.test.ts:2683` (`DG_GOLDEN`, declared 2409) | the demand timer, `pinPeriodForWeek`, the rotation, the week boundary's grant. New in M1e Task 6. |

**All nine re-checked at `14e7dee`: nine digests green and unmoved, and eight of
the ten cited line numbers exact.** The one that drifted is the `seed` golden's
`startingCity.test.ts` site, which read 767, was 764 before the closing sweep
and is **772** after it (the sweep added eight lines to that file's header
comment). Mirror-scan sites `loop.test.ts:1322 / 1324 / 1327` and the
`DG_GOLDEN` pair `2409 / 2683` are all exact. **A line number in a ledger is a
figure like any other and decays faster than the rest** — it moves whenever
anybody edits a comment above it, which is most commits. The digests are the
durable half; treat the line as a hint and grep the digest.

**Two properties of this set worth carrying.**

**No golden sees phase 10.** Every golden fixture in the repo holds at most one
pin per destination — five short of the square trigger cap — so `runOvercrowd`
writes zeroes on every tick of every one of them, whichever side of phase 9 it
runs. `trips.test.ts`'s pair of brink tests is the only thing standing between
that ordering and a silent regression, which is why they are written as a pair
rather than as one test with two assertions.

**No golden sees the week grant's off-by-one either.** Reading the un-advanced
tick moves the boundaries from 4,500/9,000 to 4,501/9,001 — still exactly two
grants inside the state fixture's 13,499 ticks, so the digest is unmoved and the
final `H_TILES` is identical. A golden that folds a whole buffer looks like it
must catch an off-by-one in the clock, and here it does not.

## A THIRD CLASS OF RE-BLESS: constants that move digests with no behavioural content

The rule above names *which task owns each move*. It implicitly assumes every
move is behavioural — somebody changed what the sim does, and the digest
followed. **There is a second kind, and authorising it is a different act.**

Five constants either **size a region of the state buffer** or are **written
into it at boot**, so editing one moves every whole-buffer digest whether or not
a single tick behaves differently:

| constant | how it reaches the buffer | site |
|---|---|---|
| `MAX_PATH_LEN` | `ROUTE_BYTES = MAX_PATH_LEN / 2` sizes `carRoute` | `dispatch.ts:55`, used at `regions.ts:35` |
| `CARS_PER_HOUSE` | sizes every per-car region | `regions.ts:1` |
| `LANE_COUNT` | `occupancy` is `cells * LANE_COUNT` slots | `regions.ts:89` |
| `DEST_SPAWN_PERIOD_TICKS` | written to `H_DEST_SPAWN_TIMER` at boot | `state.ts:479` |
| `HOUSE_SPAWN_PERIOD_TICKS` | `houseSpawnTimer.fill(...)` at boot | `state.ts:480` |

Two measured instances, both from the wave-1 pass, both **behaviourally
identical runs** on the shipped seed's greedy arm — same death tick 31,456, same
747 trips, same 0 refusals:

- **`MAX_PATH_LEN` 96 → 24** moves **8 of the 9 goldens**. The ninth, `field`
  (`252514232`), survives because it hashes flow fields rather than the state
  buffer — which is exactly the property that makes it the odd one out.
- **`WEEKLY_TILE_GRANT` 30 → 15** moves **2** — `state` (`1058753394` →
  `1818598576`) and `demand-pin` (`894844668` → `1829584893`). It is a sixth
  member of the class by a different route: it enters the buffer through
  `H_TILES` at each week grant rather than at boot.

**Two cautions, and the second is the one that cost the measurement twice.**

*A red golden test is not a moved digest.* Under `MAX_PATH_LEN` = 24, eight
golden tests go red and **only two of them reach their `expect(hashState(...))`
line** — the other six abort on a buffer-length pin sitting above it, and a
count taken off the red tests would have been a count of something else. The
digests do move (the buffer length changed by construction and the two that got
there both moved), but that was established by relaxing the pins and re-running,
not by reading the failure list. This is the catalogue's *"a green golden proves
the digest; a red golden TEST proves only that something in it failed"*, hit
again, and the asymmetry still holds: every `yes` needs a digest.

*"Bit-identical" is the wrong word for any of these.* The runs are
behaviourally identical; the buffers are not, which is the whole reason the
goldens move. Say "behaviourally identical, different buffer" — a reader told
"bit-identical" and then "moves 8 goldens" has been handed a contradiction and
will believe whichever half suits them.

**Why this deserves its own paragraph in a ledger about re-blessing.** An
authorisation of the form *"this task re-blesses the state golden"* normally
carries a behavioural claim a reviewer can check against the diff. An
authorisation for this class carries none — the digest moves because the buffer
is a different shape, and a genuine behavioural regression landing in the same
commit is absorbed with no trace. **So a re-bless in this class must state which
of the five (or six) constants moved, and the run's behavioural observables must
be asserted unchanged in the same commit** — death tick, trips, refusals — or
the re-bless is a blank cheque.

**And one durable non-golden.** `integration.test.ts`'s two 20,000- and
25,200-tick jam sweeps compare `hashState` between two identical runs and
deliberately do **not** pin the absolute digest. That is not an oversight: pinning
it would mint a tenth golden-shaped number that this ledger does not account for
— a re-bless licence nobody authorised. The guard against comparing two copies of
nothing is that the digest must differ from a fresh, untouched state of the same
shape, and both sweeps assert that.

---

# 17. THE TICK ORDER, RE-MEASURED AT THE FINAL PHASE COUNT

> **SUPERSEDED — 2026-08-23, M1f Task 5. "THE FINAL PHASE COUNT" IN THIS
> SECTION'S TITLE MEANS M1e'S TEN, AND IT IS ELEVEN NOW.** Task 5 inserted the
> card offer at position 4, re-ran the complete set at **C(11,2) = 55** over
> 2,044 tests with six interleaved baselines, and `step.ts` carries that table.
> Every index of 4 or above below moves by one: this section's `4 <-> 5` is
> today's **`5 <-> 6`** and its `3 <-> 5` is today's `3 <-> 6`.
>
> **The one 0-detector row survives its fourth independent measurement.**
> `5 <-> 6` scored 0 in 4 of 4 re-runs against 4 fresh baselines. It stays on the
> equivalent-mutant register (§7) with both commutation reasons and both
> tripwires, under the new label, and `step.ts` keeps the old label in the same
> paragraph so a later grep for `4 <-> 5` lands on the note.
>
> **Eighteen short-suite rows now, not sixteen** — 1,949 rather than 2,044,
> `carSmoothing.test.ts` (27) and `integration.test.ts` (68) failing to COLLECT,
> `packages/game` 652 -> 557. The two new ones are the offer's, `4 <-> 7` and
> `4 <-> 8`; all eighteen still involve the sync or the dispatch.
>
> **AND THIS SECTION'S SCREENING ADVICE IS INCOMPLETE, which matters more than
> the renumbering.** Its two rules — screen on non-vitest-result lines, run the
> complement check — are both right and **neither can see a per-case TIMEOUT**: a
> timeout raises no error class and does not change the collection count, so it
> is indistinguishable from an assertion kill in both instruments. Several
> `packages/game` cases run at roughly half vitest's 5,000 ms default, and under
> concurrent load **the UNMUTATED tree fails them**: 3 of Task 5's 14 baseline
> runs scored non-zero, a **21 %** flake rate, and two of the six baselines in
> the main sweep failed at 4 and at 1. Add `Test timed out` to the screen as a
> first-class class, and discard by REACHABILITY — ask whether the killing test
> can reach the mutated code — because counting cannot separate them.

`step.ts` carries the full table and every attribution. This section exists so
that M1f knows the table is there, knows what it says, and knows the two things
about it that are easy to get wrong.

**The set is C(10,2) = 45**, run as positional transpositions with the poison
check, `const tick` and both `H_EPOCH` writes excluded as prologue and epilogue.
Four unmutated baselines, all 0. 1,843 tests collected.

**One 0-detector row: `4 <-> 5`** — spawn against demand. It is on the
equivalent-mutant register (§7) with both of its commutation reasons and a
tripwire for each.

**Sixteen rows collected a SHORT suite** — 1,751 rather than 1,843, because the
reordering makes `step` throw during test COLLECTION and
`carSmoothing.test.ts` (27) plus `integration.test.ts` (65) never run. All
sixteen involve phase 6 or 7. **Their counts are lower bounds**, and `step.ts`
marks every one.

**Confirmed in the closing sweep, by re-running rather than by reading.** The
canonical invocation at `14e7dee` collects **1,843** — shared 49, render 252,
eslint-rules 69, sim 852, game 621 — so the suite has not moved since Task 12.
`carSmoothing.test.ts` runs **27** and `integration.test.ts` **65**, so the
short suite is 1,843 − 92 = **1,751** exactly. And `4 <-> 5` was re-applied
alone — `runDemand` before `runSpawn` — over the same invocation: **green in all
five packages, 0 detectors, collection count unchanged so the mutant ran, and no
crash-screen match.** Three suite sizes, three zeroes. This is the third
independent measurement of that row and the first taken after the milestone
closed. **The rest of the 45-cell table was NOT re-run** — one row is not the
sweep, and a reader wanting the other 44 should treat `step.ts`'s table as
Task 12's and re-run it.

**Two things that are easy to get wrong, and both were got wrong here first.**

1. **A positional transposition at distance ≥ 2 is not a swap of two adjacent
   phases.** It reverses phase `i` against everything between as well. That is
   why `3 <-> 5` now scores 1 while the two phases still commute with each
   other, and `step.ts` had a sentence asserting the opposite until Task 12
   measured it. If M1f re-runs this sweep, expect that row to be non-zero and do
   NOT read it as the commutativity handoff having been discharged.
2. **The crash screen's false positive is real and it is in this repo's own
   output.** Matching an error-class name anywhere on a line matches a vitest
   PASS line whose test NAME contains `TypeError`. Match on lines that are not
   vitest result lines, and record the matched line so a discard is auditable.
   Re-screened that way: 0 matches on all 45.

**And the discharged handoff stayed discharged.** `1 <-> 3` — which M1d recorded
as a 0-detector no-op in 4 of 4 rounds — scores **6**, with the same detector set
as `1 <-> 2`, because phase 2 reads the clock between them. That closure holds at
the final phase count.
