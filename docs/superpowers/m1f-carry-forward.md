# M1f carry-forward

Opened by M1e Task 11 so that the items below have a **named recipient** rather
than a milestone mentioned in a comment. The catalogue's rule is that a handoff
with no home in the source evaporates; this file is the home for the ones with
no natural code site, and every other item is repointed at its own site with
`M1f` written in it.

This is not the M1f plan. It is the list of things M1e knowingly did not do,
each with what was measured about it.

---

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
| `render/types.ts` `HudRects`, `game/pointer.ts`'s `HUD_INERT` | §7.2's **inventory chip row** — there is now something to spend and still nothing to choose |

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

## 4. The erase control never unsubscribes its click handler

`retire()` (M1e Task 9) hides the control on game over and refuses every later
render, and `main.ts` calls it on both the edge and the already-terminal boot
path. What it does **not** do is unsubscribe: `offClick` is declared on the
`MainButton` shape (`telegram.ts:76`) and called nowhere in `packages/`, and the
DOM fallback's `click` listener is never removed.

Unreachable on every client this ships to — a hidden `MainButton` delivers no
clicks and `display: none` takes the pill out of the hit test — so the
consequence is bounded and cosmetic. The specific wrongness worth fixing:
`press()` calls `host.toggleEraseMode()` **before** `render()`'s terminal guard
runs, so a press that did somehow arrive would flip the player's erase mode with
no label to show it.

The fix is a choice, not a line: either hold the handler reference and widen
`mainButton()`'s shape re-check to cover `offClick`, or move the `retired` guard
into `press`. Recorded at the site in `eraseControl.ts` as well as here.

## 5. `MAX_BLOCKED_TICKS` is unreachable on everything that ships

The anti-deadlock valve's 45-second threshold has never fired on a board a
player can open. Measured at the close of M1e by driving each shipped layout
from boot to its §5.8 death with no input:

```
  city  5,580 ticks   0 refusals      max carBlockedTicks    0   0 valve firings
  demo  6,703 ticks   7,544 refusals  max carBlockedTicks   55   0 valve firings
```

`city` refuses nothing because a board nobody draws on has no route; `demo`
refuses constantly and its worst wait is **55 ticks, 1.8 s — a factor of 24.5
below the threshold**. The only things that reach it are purpose-built fixtures
(`game/test/jamFixture.ts`'s STARVED variant, `sim/test/blocking.test.ts`'s
hand-built gridlock ring).

**Read that as a statement about the boards, not about the number** — a valve
that never fires on a board that never deadlocks is a backstop doing its job.
What it means operationally is that lowering the constant is a change no shipped
board can observe and raising it is free. The first real tuning evidence needs a
board that jams, which is M1f's.

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
  by reading the constants, not by re-running the equivalence.

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
Task 9's shutdown copy is keyed to exactly this (`NO ROAD REACHES DESTINATION n`
rather than `OVERCROWDED`, chosen because it is computable from whether any road
reaches the carpark), which makes the ENDING legible without making the DANGER
visible while there is still time to act.

**The obvious fix is not free and was refused with measurements.** M1e's plan
proposed tiering the spawn scan by proximity to the spawning colour's own
houses. Task 10 applied it verbatim across five seeds: it survives all twelve
weeks **by making the board inert** — peak `destPins` **1 in 65 of 65
week-observations**, zero blocked ticks in 63 of 65, four to five cars ever in
motion, delivery fraction ~1.00 — and the *baseline* is the arm that produces
the 1 → 2 → 5 → 10 gradient. A different greedy policy gives byte-identical
results, so it is not a tie-break artefact. **Connectivity awareness as
specified is a difficulty DELETION wearing a survivability improvement's
clothes.**

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
the fact**: the overcrowd ring first appears at 1:56 and the run ends at 3:06.
The ring names *which* destination; the shutdown line says *connect it*; neither
says *where*.

This is the same open question Task 9 left and Task 10 restated, and it is a
**design gap, not a bug**. It has no code artefact of its own, which is why it
is written at the site of the number that makes it true.

**Home in the source:** `packages/game/src/startingCity.ts`, in the four-row
death-tick table.

## 12. The first ten minutes are unloseable, and greedy play dies at 17:29

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

## Before you start: the clock you will be holding is NOT the clock in the source

Every time written in this repo — Task 10's report, `demoLayout.ts`'s "3 minutes
43 seconds", `startingCity.ts`'s "3:06" — is `tick / 30` counted from tick 0.
**Both boards run a warm start before the first frame**, so a stopwatch started
when the board appears reads *less*:

```
                warm start   dies at   source says   YOUR STOPWATCH WILL SAY
  city (default)   258        5,580      3:06                2:57
  demo             1,200      6,703      3:43                3:03
```

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
  handful of trees, **three grey destination blocks** (two squares on the left at
  grid rows 10 and 18, one circle right of the river at row 14), **three houses**,
  six small cars sitting still, and a HUD reading **30 tiles** and score 0.
- **At 0:01.4** (tick 300) a **fourth house** appears next to one already there.
  *Does it read as an event, or does it just appear?* This is the only "the city
  is growing" signal the game has.
- **At 0:04** (tick 378) the first pin lands: a dot appears on one destination.
- Draw a road with your finger between a house and a same-colour destination's
  carpark. **A car should be running it within a second, and the score should
  tick about 6 seconds after a 3-cell stroke.**

Answer: does the empty opening read as an invitation or as a failure?

## Q2 — Is the overcrowd ring readable at phone size, against the pin dots?

**The ring and the pins occupy the same few pixels by construction** — the ring
is drawn around the destination and the pins are dots on it. No human has seen
them together.

Do this on the **default board, doing nothing at all**:

- **At 1:04 on your stopwatch** (tick 2,191) a ring begins closing on the
  **circle right of the river, grid (14,14)–(16,15), whose carpark bay is at
  (17,14)**. It is colour 1's only destination and it is the one that kills the
  city. The ring starts empty and fills clockwise.
- **By about 1:34** (tick ~3,090) it should be unmistakable at arm's length.
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
  NO ROAD REACHES DESTINATION 2
  CONNECT EVERY DESTINATION WITH A ROAD
  <your trip count>
  TAP TO PLAY AGAIN
  ```

  Trip count will be **0** if you drew nothing.
- **Nothing on the board is labelled "2".** The frozen board behind the scrim
  still shows the city, and the killer carries the 2× ring. Question: **with the
  screen in front of you, can you point at destination 2?** If the ring is the
  only way, say so — that makes the ring load-bearing for the ENDING as well as
  for the warning, which nothing has assumed.
- On the **demo** board (`?startapp=demo`, dies at **3:03** on your stopwatch)
  the first line is the other arm: `DESTINATION 2 WENT UNSERVED`. Both arms ship
  and they differ by two words. Do they read as different situations?

## Q4 — The ghost art: 182 assertions, zero human minutes

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
  out: the whole twelve-week connection bill is 41–57 tiles against 390 granted,
  and there were **zero unaffordable events in fifteen runs**.
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

## 15.1 The demand ramp's three numbers, and why the shipped board cannot judge them

Spec §5.3 calls `spawnScale` *"the single most important tuning unknown in the
project"* and §13 lists it as an open risk whose mitigation is the telemetry
overlay. M1e implemented it (Task 6) and tuned nothing.

Measured: on the shipped board the ramp changes the no-input death tick by
**1.0 %** and changes peak `destPins`, longest queue, refusals and blocked ticks
by **zero**. On a 41-cell corridor the same ramp is the entire difference between
surviving 60,000 ticks and dying at week 9.

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
is an ordinary outcome. §5.9's house-clustering rule compounds it.

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

96 route steps is the maximum distance a house may be from a carpark. Measured:
on a 101-cell corridor **every dispatch is refused**, and a **fully connected**
destination is unservable and dies, with or without the ramp.

On a 14×22 rect a sensible road never approaches 96 steps. A winding one can, and
**the failure is silent** — `H_ROUTES_REFUSED` rises and nothing else. There is
no message, no ring, no colour, nothing on the HUD.

M1f should either surface it or bound it. Surfacing is the cheaper half: the
refusal count is already in the header.

## 15.4 Whether `DESTINATIONS_PER_WEEK` = 2 and `HOUSES_PER_DESTINATION` = 2 pace the city

Both are [OURS] with no source in the spec. Measured over 40 weeks:

- the schedule delivers **0.275 destinations a week**, not 2 — the retry cadence
  and the geometry dominate the nominal rate;
- the board seats **14** rather than the declared `maxDestinations` of 16, with
  the last placement in **week 10**;
- on the PLAYED board it is **13 by week 8**, because the player's own road
  removes candidate cells;
- after that the spawner is in permanent `BOARD_FULL` for the rest of the run.

**The cause is geometric, not arithmetic**: seven contiguous free cells at
Chebyshev ≥ 2 from every other destination, inside a 308-cell rect already
carrying a river, eight trees, 27 houses and the player's roads.
`HOUSES_PER_DESTINATION` is measured **not to be a lever** at 1, 2 or 3.

**A consequence Task 12 measured and nothing else records:** on `firstCity` the
clipped spawn zone is **308** cells against a `SPAWN_CANDIDATE_LIMIT` of **24**,
so a failing destination scan is always `SCAN_EXHAUSTED` and never `BOARD_FULL`
— which means **§5.3.5's blocked-spawn redistribution never fires on the board
that ships.** 0 pushes in 31,456 ticks of greedy play. Both of its arms are
exercised only on `jamFixture`, where `maxDestinations` is 1.

## 15.5 Whether 30 tiles a week is right for a 308-cell rect

It is §5.10's Road Tiles rate on a board a **tenth** of the original's, and it is
measured to be **6–8× slack**:

- the whole twelve-week destination-connection bill is **41–57 tiles against 390
  granted**;
- the median connection is **3 tiles**;
- there were **zero unaffordable events in fifteen runs**, and the greedy arm's
  `tilesLeft` never drops below **37**.

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
at **5,580** where the colour-0 **square** would have died at **6,357**, despite
the circle's higher cap. Same board, same first pin at tick 378; the circle takes
a pin every 259 ticks and the square one every 518.

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

## 15.11 What the restart feels like

M1e's restart is `location.reload()`: correct by construction, preserves
`?startapp=demo`, costs one warm start, and mutates **not one byte** of sim state
(`integration.test.ts` asserts that directly). It is also a full page reload, and
**nobody has seen one.**

§14's Q5 is the only evidence there will be. A seamless in-place restart
(`resetState` in `sim`) is M3's.

---

# 16. THE GOLDEN LEDGER — nine digests, where each lives, and what moves it

M1e opened with seven goldens and closes with **nine**. Two were minted in the
milestone (Task 1's re-bless produced no new digest; Task 6's demand-pin golden
and Task 10's inheritance of the demo golden are the arithmetic). All nine are
green and unmoved at the close of Task 12.

**The rule this table exists to enforce is the catalogue's:** *"before writing
'this task re-blesses X', derive that X actually moves — and name which task owns
each move, so a golden that moves for an unlisted reason still stops the world."*
A false authorisation to re-bless is worse than no authorisation, because it is a
standing permission that absorbs an unrelated regression silently.

| digest | name | asserted at | what moves it |
|---|---|---|---|
| `1058753394` | **state** | `sim/test/determinism.test.ts:733` | any change to the state buffer's SHAPE or to `createState`'s initialisation. Moved twice in M1e (`883875991 -> 1058753394` at Task 5). Mirror-scanned as a string by `loop.test.ts:1322`, so a re-bless must edit both. |
| `2312109239` | **road-network** | `sim/test/rollback.test.ts:820` | `placeRoad`/`eraseRoad` semantics, the tile ledger, the ghost regions. Scanned by `loop.test.ts:1324`. |
| `252514232` | **field** | `sim/test/rollback.test.ts:864` | `flowfield.ts`'s relaxation, `edgeCost`, the bucket structure. **Not** the allocation shape — Task 3 removed an allocation and this did not move. Scanned by `loop.test.ts:1327`. |
| `1877236894` | **loop** | `sim/test/loop.test.ts:1285` | the tick order, movement, dispatch, blocking. The broadest of the nine. |
| `968680755` | **seed** | `game/test/startingCity.test.ts:767` **and** `game/test/demoLayout.test.ts:599` | `firstCity`'s map bytes or `seedStartingCity`'s six placements. **Two sites**, deliberately: `demoLayout.test.ts` asserts it to prove the demo work left the shipped seed alone. |
| `307910575` | **queue** | `sim/test/loop.test.ts:2296` | the blocking/queueing path on the queue fixture. |
| `1531344761` | **multipliers** | `sim/test/cars.test.ts:1809` | `laneSpeedMul`, `CAR_SPEED_UNITS_PER_TICK`, any turn or intersection multiplier. |
| `3152640907` | **demo** | `game/test/demoLayout.test.ts:574` | `demoCity`'s map bytes or `seedDemoLayout`. **`firstCity` cannot reach it** — a correction M1e Task 2 got wrong and its reviewer measured: changing `firstCity.startingTiles` moves **one** golden, not two, because the demo golden is `hashState` over a state built on `demoCity()`. |
| `894844668` | **demand-pin** | `sim/test/loop.test.ts:2683` (`DG_GOLDEN`, declared 2409) | the demand timer, `pinPeriodForWeek`, the rotation, the week boundary's grant. New in M1e Task 6. |

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

**And one durable non-golden.** `integration.test.ts`'s two 20,000- and
25,200-tick jam sweeps compare `hashState` between two identical runs and
deliberately do **not** pin the absolute digest. That is not an oversight: pinning
it would mint a tenth golden-shaped number that this ledger does not account for
— a re-bless licence nobody authorised. The guard against comparing two copies of
nothing is that the digest must differ from a fresh, untouched state of the same
shape, and both sweeps assert that.

---

# 17. THE TICK ORDER, RE-MEASURED AT THE FINAL PHASE COUNT

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
