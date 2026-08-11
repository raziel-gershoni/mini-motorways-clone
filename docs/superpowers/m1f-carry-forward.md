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

---

# The four player-facing findings, which had no recipient at all

Sections 1–8 above were all anchored to a file, a constant or a function when
this document was written — which is this repository's catalogue entry *"a
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
