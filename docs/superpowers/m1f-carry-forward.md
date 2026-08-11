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

## 6. The multi-tick draw divergence — documentation, not a regression

`resolve.ts`'s `MAX_DRAW_LAG_CELLS` bound is a **tick-boundary** bound and now
says so. Mid-frame, when a drain runs more than one tick, `|drawCar − lerpCar|`
reaches **0.9920 cells, 4.96× the clamp**, because `drawPrevXY → drawCurrXY`
spans the whole drain while `prevXY → currXY` spans only the last tick
(`frame.ts`'s `beforeStep` runs per tick, `afterDrain` once).

Not a regression — a multi-tick drain means the tab was starved and the car
really did move that far — and the drawn car covers the ground more smoothly
than the exact interpolant, not less. **One consequence is stated and NOT
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

## 8. Not carried here

The seed board is still **out of band** and therefore not replayable by a
Worker: `seedStartingCity`'s six placements happen before tick 1 and travel in
no input log. M1e's in-`step` spawner was expected to close that and does not —
it adds buildings on top of a seed it does not replace. M3's persistence depends
on it, and `game/src/startingCity.ts` says so at the site.
