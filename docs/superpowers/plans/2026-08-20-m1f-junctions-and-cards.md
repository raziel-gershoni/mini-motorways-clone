# M1f: the junction costs something, and a card fixes it — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a junction cost something a player can see — two cars may no longer cross inside one cell — and then give the player the one thing that fixes it: a weekly choice between road tiles and a pair of **junction upgrades** they place themselves, each of which lifts the new rule at the corner they put it on.

**Architecture:** One new rule in `canEnter` (a junction cell admits one car at a time), one new `step` phase (**the offer**, inserted at position 4, renumbering the old 4–10 to 5–11 — **the only renumbering this milestone pays for, and the phase count is final at eleven**), two new `TickAction` kinds (`choose-card`, `upgrade`), five new header slots, **one** new state region, **one clause in `junctionAdmitsOne`**, and a full-screen modal in `render` that the shell pauses behind. Routing does not change and must not: §5.4's *"model intersection penalties as extra integer edge weight"* is **refused by amendment** in Task 1, because a junction that repels traffic is a junction the player never feels.

**Tech Stack:** TypeScript, pnpm workspaces, zero runtime dependencies, integer-only in `sim`, Vitest, Canvas2D, Cloudflare Workers.

---

## AMENDMENT 2 — THE RELIEF ITEM'S **EFFECT** CHANGED, AFTER A SPIKE MEASURED IT. READ THIS FIRST.

**What did not change: the card, its placement rules, its inventory chip, the modal, the
non-consuming draw, `choose-card` as a logged input, the pause, the pool filter — and Task 2, the
junction mutual exclusion, which is the milestone.** The scope is full and the user chose it.

**What changed: the item's EFFECT, from METERING to RESOLVING.**

| | Was | Is |
|---|---|---|
| Object | A traffic light on a junction cell | A **junction upgrade** on a junction cell |
| Effect | Alternates which axis may enter, on a 10 s timer, with 2 s amber and a demand controller | **The Task 2 mutual-exclusion rule does not apply at this cell.** Cars cross without conflict |
| State | 5 header slots + 6 regions: phase, timer, axis, per-axis idle, a prefix-packed table | **One flag per cell.** 5 header slots + **1** region |
| Tick order | An appended phase 12 (`runLights`) | **No new phase.** The rule is one clause in `junctionAdmitsOne` |
| Everything else about the cell | — | **Unchanged, including `INTERSECTION_SPEED_MUL`.** An upgraded junction still slows cars |

Concretely: `junctionAdmitsOne(state, cell)` returns `false` on an upgraded cell, and `canEnter`'s
Task 2/Task 3 clause then reduces to the pre-M1f own-lane rule there. **`canEnter` is not touched by
Task 9 at all.**

### Why — measured by a throwaway spike, never merged, on the shipped seed's greedy arm

The relief item's central claim was unmeasured, and the previous draft measured it at **its Task 9 Step 14** —
after eight tasks, 1,364 bytes of buffer, six regions, a phase renumbering, a modal and a card
economy had shipped. An adversarial review called that sequencing *the bet* and specified a spike to
settle it for the price of one task instead of eight. The spike ran. These are its numbers.

**The control, and the size of the hole Task 2 digs:**

| arm | death | trips | blocked car-ticks |
|---|---|---|---|
| rule disabled (pre-M1f) | 31,456 | **747** | 2,120 |
| arm B, no relief — **the control** | 21,783 (11:57.5) | **368** | 29,267 |

**Task 2 costs 379 trips. Task 9's entire job is to give some back.**

**The upgrade gives back all of it.**

- Exempting the junction rule at the **six cells carrying ≥ 5 % of arm B's refusals**: **750 trips,
  +382 against the control, +103.8 %**, death 31,539, blocked 2,229.
- Exempting it at the **six census conflict cells** (`(12,19) (9,22) (14,17) (8,23) (8,11) (8,21)`)
  reproduces the rule-disabled board **exactly** — 747 / 31,456 / 2,120, junction-caused refusals
  **0**. **These are two different six-cell sets and this plan keeps them apart everywhere**; the
  brief that commissioned this amendment conflated them.
- Across eight seeds the exemption beats its own control on **7 of 8**, deltas
  `+382 +47 +203 +385 +157 −5 +20 +129`, summed 4,373 against 3,055 = **+43.1 %**.

**And the metered light does not.** The spike built the light as specified — fixed alternating green
at `LIGHT_CHANGE_DELAY` = 300 with `LIGHT_AMBER_TICKS` = 60 of closure, six cells, seated at card
boundaries:

- **320 trips, −13.0 % against the control.** With right-on-red, 315. Seated at junction formation
  instead of at a card boundary, 234 (−36.4 %). On the conflict-six, 220 (−40.2 %).
- Sliding the seat tick across one full 360-tick period enumerates every phase the same light could
  have had — **a change with no design meaning**. Over 8 seeds × 30 phases = 240 pairs, one light
  beats its own control on **74/240 (31 %)** and all lights on **52/240 (22 %)**; the per-seed phase
  spread is **1.19×–1.70×, more swing than any positive effect measured**. On the shipped seed
  −13.0 % is the **maximum** over 30 phases; only **3 of 30** beat the control and the **median is
  306 (−17 %)**.
- `LIGHT_CHANGE_DELAY` 150 → 92/192 wins (48 %), summed median delta −421; **300 (datamined)** →
  60/192 (31 %), −753; 600 → 28/192 (15 %), −1,102. **Halving the hysteresis moves it to a coin flip
  and never past it.** The best variant found anywhere — delay 150, right-on-red, six cells — is
  **353, still below the 368 control.**

**And this plan's own demand controller is the worst of them.** Transcribed from Decision 14 and Task
9 Step 11 verbatim, four lights, shipped seed: **228 trips, −38 %**, death 16,663, blocked 34,425,
valve firings 16 against the control's 5 — and **one phase swap in the entire run**. Across 8 seeds ×
24 phases it beats its own control on **12/192 (6 %)**. Swaps per run across the eight seeds are
`1 0 0 6 4 5 0 11`: **on three of eight seeds the light never changes phase at all.**
`LIGHT_MIN_NEARBY_CARS = 2` within `LIGHT_NEARBY_RADIUS` = 2 tiles is essentially never satisfied on a
board carrying **about eleven cars in flight**, so the light latches on its opening axis and becomes a
**permanent closure released only by the 45 s valve**. Setting `LIGHT_MIN_NEARBY_CARS = 1` raises
swaps to 13–80 and recovers m2 from 228 to 349 — still below the control on 6 of 8 seeds. Widening
the radius alone does nothing.

**The inequality, on the one channel that can be counted.** The pool a relief object can drain is
**6,536 junction-caused refusals**, 22.3 % of arm B's 29,267 blocked car-ticks. The light's own
red-light refusals measure **16,490** (fixed) and **19,536** (demand controller) — **2.5–3.0× against
the pool it exists to drain.** At `(12,19)`, the board's worst jam, a light admitted **zero** entries
arm B would have refused while refusing 8,886: its entire mechanism there is serialisation, not
admission.

### What this means for the plan, stated plainly

1. **The relief *mechanic* is sound and the object was wrong.** Do not read this as "relief does not
   work". The ceiling is worth the entire 379 trips Task 2 costs.
2. **§5.6's demand-actuated light is rejected for THIS board's density, not in general.** The
   datamined constants — 2 nearby cars within 2 tiles before a swap, 10 s of hysteresis, a 30 s idle
   cap — presuppose traffic far denser than eleven cars in flight. They are a correct description of
   the game being cloned and a wrong fit for the board this project ships.
3. **The light is DEFERRED TO M1g with these numbers attached, not dropped.** This project's rule is
   that a handoff item needs a named recipient; the recipient is M1g and the record is the §5.6
   amendment in Task 9 Step 1 and `docs/superpowers/m1g-carry-forward.md` (Task 12 Step 11).
4. **Do not call the shipped object a traffic light.** Its behaviour is not §5.6's light. It is a
   **junction upgrade**: constant prefix `UPGRADE_`, header slot `H_INV_UPGRADES`, card id
   `CARD_JUNCTION_UPGRADE`, source module `packages/sim/src/upgrades.ts`.

### An upgrade is a BUFF, and that changes what the tests must prove

A metered light can make a junction worse — it refuses cars the bare junction would have admitted.
**An upgrade cannot.** At its own cell it admits a strict superset of what the bare junction admits,
so the whole class of risk the light carried — a bad phase, a starved approach, a permanent closure —
does not exist. **That removes "does it help?" as the question.** It is measured, yes, up to the full
379 trips.

**The question the tests must answer instead is whether the PLACEMENT is a real decision.** Two
things say it is, and both are measured:

- **Two cells are not six.** Exempting the top **two** refusal cells alone measures **394 trips,
  +7.1 %**, against **+103.8 %** for six. One card grants two upgrades. So *how many* and *which*
  dominate the outcome by a factor of fourteen.
- **A single relief placement's value varies by cell, and the jam a player can most easily see is not
  the best one to fix.** Measured on the light — `(8,21)` **+28.8 %** against `(14,17)` **−11.4 %**,
  with the board's most visible jam `(12,19)` not the good one. **That figure is the light's spread,
  not the upgrade's**, and this plan says so wherever it quotes it: the upgrade's own per-cell spread
  is **unmeasured**, Task 9 Step 11 measures it, and Task 12's acceptance criterion is written from
  that table.

**And "a buff at the cell" is not "a buff on the run".** The eight-seed exemption row contains a
**−5**: on one seed, exempting six cells made the whole run slightly worse, because relief at one
junction moves traffic downstream. So no test may assert *every* placement beats the control. The
criteria are **best beats control** and **best minus worst is real** — and Task 12 reports how many
placements are strictly worse, because that number is the other half of the modal's decision.

### The reachability finding this amendment must not lose

Two of the six refusal-ranked hot cells — **`(13,18)` at 19.5 % and `(11,20)`** — **never reach road
degree ≥ 3 on any tick of the run**, so `canPlaceUpgrade` refuses them at every boundary and **the
board has at most four legal sites among that six.** The 750-trip ceiling was measured by exempting
all six, two of which can never be seated. **The reachable ceiling is therefore bounded below by 394
(two cells) and above by 750 (six), and it is not measured.** Task 3's site survey and Task 9 Step 11
own closing that gap. Junctions on the board at the four week boundaries are **0 / 2 / 6 / 6**, and
at most **8** upgrades can be granted across the run — see Decision 15.

### What the swap DELETES, said out loud so nothing is dropped silently

**Confirm each of these is gone rather than assuming it.** Task 12 Step 8 greps for every identifier
in the right-hand column and requires every surviving hit to be either §5.6/dossier prose, the
`CARD_TRAFFIC_LIGHTS` id (declared, unimplemented, excluded by `CARD_IMPLEMENTED_MASK`), or an M1g
deferral with a named recipient — the same shape the roundabout's sweep uses.

| Deleted | It was | Identifiers to grep |
|---|---|---|
| The demand controller and its phase | `runLights` as an appended phase 12, once per light per tick | `runLights`, `bestAxis`, `nearbyCarsOnAxis`, `axisHasRoad`, `axisOf`, `lightIdleSlot` |
| The hysteresis, the amber and the demand thresholds | Six datamined timing constants | `LIGHT_CHANGE_DELAY`, `LIGHT_AMBER_TICKS`, `LIGHT_MIN_NEARBY_CARS`, `LIGHT_NEARBY_RADIUS`, `LIGHT_IDLE_CAP`, `LIGHT_IDLE_WEIGHT` |
| The phase/axis machine | A green axis, a pending amber axis, a per-junction clock and four per-junction idle counters | `lightGreenAxis`, `lightAmberFor`, `lightSince`, `lightIdle`, `LIGHT_AXES`, `LIGHT_NO_PENDING`, `LIGHT_STOP`, `LIGHT_GO`, `LIGHT_RIGHT_ON_RED`, `lightAdmits` |
| The prefix-packed light table | `lightCell` × `MAX_LIGHTS`, and `lightAt` holding `slot + 1` | `lightCell`, `MAX_LIGHTS`, `lightSlotAt`, `H_LIGHT_COUNT` (renamed `H_UPGRADE_COUNT`), `H_INV_LIGHTS` (renamed `H_INV_UPGRADES`) |
| Right-on-red, and everything under it | A fifth entry outcome, a 64-pair turn table, an exported `nextLegDir`, and the patch note's demand exclusion | `REFUSED_RED`, `isRedLightRightTurn`, `RIGHT_TURN_STEPS`, `nextLegDir`, `americanRedLightRules` |
| The two-colour render fold | `game` folding `lightAmberFor` into a colour byte for `render` | `LIGHT_COLOUR_GREEN`, `LIGHT_COLOUR_AMBER`, `lightColour`, `lightGreenAxis` on `RenderFrame` |
| The appended phase, and the second tick-order change | Phase 12, one tick of controller lag, eleven new transposition pairs | `phase 12` in `sim`, `10 <-> 12`, `11 <-> 12`, `3 <-> 12` |
| `MAX_BLOCKED_TICKS`'s **third** reader | The valve as the only release for a car starving below `LIGHT_MIN_NEARBY_CARS` | Carry-forward §5's row — the valve keeps **two** readers, and an upgrade *removes* valve pressure rather than adding it |

**And the second review's Criticals that this swap deletes outright, confirmed rather than assumed:**

- **C1** — `bestAxis` throws inside `runLights` and permanently poisons the buffer. **Deleted: there
  is no axis selection.** The *rule* behind it is not deleted and is re-checked in Task 9 Step 3:
  Decision 9 says **nothing in `step` may throw over a configuration a player can reach**, and an
  upgrade on a cell whose roads have all been erased must be **inert, not fatal**. `upgrades.ts`
  contains no `throw` on any state-dependent path, and Task 9 Step 3 drives that fixture.
- **I1** — the controller and its own tests are off by one, three times. **Deleted with the
  controller.**
- **I2** — the challenger score is written three times in two contradictory forms. **Deleted with the
  score.**
- **I3** — `nearbyCarsOnAxis` reads a lane and calls it a direction. **Deleted with the function.**
- **I10** — `nextLegDir` is declared with four parameters and called with two. **Deleted:
  `nextLegDir` existed only for right-on-red.**
- **I12** — the payoff mechanism is demonstrated only from a hand-set state and the controller cannot
  reach it. **Deleted:** the upgrade needs no state to be set — Task 9 Step 7's head-on fixture
  resolves the moment both cells are upgraded, with no phase, no clock and nothing hand-written.
- **I4(a)/(b)** — mutant 1's impossible prediction and `queueProbe.ts`'s orphaned red-light answer.
  **Deleted, and the underlying defect is closed structurally**: `carAheadOf` and `canEnter` both read
  `junctionAdmitsOne`, so they cannot disagree about an upgraded cell. Plan line 1036's *"and its
  red-light answer (Task 9)"* is **corrected to Task 2 only**. What survives is one obligation, kept:
  Task 9 re-runs Task 2's `canEnter`-agreement property on a board with an upgrade placed.

Everything else in the second review's fixlist survives the swap and is applied — see this plan's
Self-review, which lists each item with its disposition.

---

## AMENDMENT 1 — THIS PLAN IS A REWRITE. READ THIS SECTION SECOND.

The previous draft of this file shipped a **3×3 roundabout** as the relief item and was returned
**DO NOT EXECUTE** by a five-lens adversarial review with an independent reproduction. The verdict
was not a fixlist; it was a shape finding, and it is worth stating in full because the reasoning
generalises:

> The review enumerated every legal roundabout placement covering every cell that actually jams, at
> every tick from the earliest a card can exist through death. **Five of the six conflicting cells
> have ZERO legal centres, ever. The sixth has exactly one, and it is the cell the plan's own trap 4
> had already measured as worth exactly zero — bit-identical to placing nothing.**

The cause is structural, not a bad seed. The greedy connector merges approaches **at** carparks and
houses, so degree-3 cells form hard against buildings *by construction*; §5.6 requires a
roundabout's centre plus all eight neighbours to be clear of buildings. **The rule that creates
junctions and the rule that permits roundabouts are in direct conflict on this board.**

**The roundabout is therefore replaced by a SINGLE-CELL RELIEF OBJECT, and moves to M1g behind a
geometry decision.** §5.6: *"Lights place only on an existing road junction, never plain road, and
cost 0 tiles."* The object is a single cell, placed **on** the jamming junction. It cannot fail to
reach the jam for geometric reasons, because the jam's location is the object's placement rule.

**Amendment 2 kept that placement rule and changed the object's EFFECT** — from a metered light to a
junction upgrade — after measuring both. Read Amendment 2 for the numbers. Everywhere this section
says "light", read "the single-cell relief object"; the geometry finding that produced this rewrite
is unaffected by which effect that object has.

**What the swap deletes outright, said out loud so nothing is dropped silently:**

| Deleted | It was |
|---|---|
| The ring's 8-cycle geometry, `roundaboutCellAt`, `roundaboutCodeAt`, the twelve-vs-eight adjacency confusion (review C4) | A property of a 3×3 block. There is no block. |
| The four free `RA_ENTRY`↔`RA_ENTRY` diagonal chords, an unlimited-throughput 2× crossing a player could redraw for zero tiles (review C4) | A property of the ring. There is no ring. |
| `eraseRoad` minting eight unpaid tiles per roundabout, and the half-erased-ring state (review I7) | A property of eight ring segments laid at zero cost. An upgrade lays no road. |
| A house spawning on `RA_CENTRE` and never being connectable (review I15) | A property of a nine-cell footprint with an interior. **Its analogue survives and is closed in Task 9 Step 9**: a building must not spawn on an upgraded cell. |
| `laneSpeedMul`'s rounding-inertness register entry ending | The two new compound averages (1333.5, 1166.5) came from `ROUNDABOUT_SPEED_MUL`. **The entry stays on the register, unchanged and untouched**, and Task 9 must not manufacture a detector for it. |
| Task 11's 545-arm sweep | 545 candidate centres of which ~518 were bare grass. The upgrade sweep enumerates junctions, which is 19–40 cells, measured in Task 12 Step 3. |
| `ROUNDABOUT_SPEED_MUL`'s first caller | Still uncalled at the end of M1f. Re-dated to **M1g** in Task 1, beside `MOTORWAY_SPEED_MAX`. |

**Confirm each of these is gone rather than assuming it.** Task 12 Step 8's artefact sweep greps the
repo for `roundabout`, `RA_ENTRY`, `RA_CENTRE`, `RA_CORNER` and `ROUNDABOUT_SPAN` and requires every
surviving hit to be either §5.6/§1.8 prose, the `CARD_ROUNDABOUT` id (declared, unimplemented), or an
M1g deferral with a named recipient.

---

## Read this paragraph before Task 1, because it is the milestone's honest shape

**The tick order changes ONCE, and that one change renumbers everything above phase 3.** Task 5
inserts the **offer** at position **4**, so the old phases 4–10 become 5–11. **Nothing else moves and
the phase count is FINAL AT ELEVEN.** Amendment 2 deleted the appended phase 12 (`runLights`) along
with the controller it drove: a junction upgrade is a flag `canEnter` reads through
`junctionAdmitsOne`, and a flag has nothing to advance once per tick. **Every phase number above 3
written anywhere in `packages/` and in every doc under `docs/superpowers/` is wrong from Task 5
onward**, and Task 5 owns re-pointing all of them, once. The equivalent-mutant register's one
surviving 0-detector row, `4 <-> 5` (spawn against demand), becomes **`5 <-> 6`** and must be re-run
under its new name.

**A reader who remembers the previous draft's twelfth phase should note what went with it:** the one
tick of controller lag, the `10 <-> 12` / `11 <-> 12` / `3 <-> 12` predictions, and the eleven extra
transposition rows Task 9 was going to run. Task 12's closing sweep is `C(11, 2) = 55` pairs, of which
**19** involve a phase whose content changed after Task 5 — see Task 12 Step 2, where that arithmetic
is re-derived.

### When the board actually diverges, dated off the right instrument

**The previous draft dated this milestone off a census that is structurally blind to the event that
dates it, and got the direction of its own correction backwards.** Both figures below are real, both
reproduce to the digit, and they measure **two different events**:

| instrument | what it counts | first occurrence | over the run | cells |
|---|---|---|---|---|
| **co-presence census** | two different cars in the two lanes of one junction cell at END of tick | tick **15,001** (8:11.4) | **232** | six |
| **rule census** — *the one the milestone is dated from* | a tick on which Task 2's rule would refuse an entry that today succeeds, **including a same-tick swap across a junction** | tick **12,780** (**6:57.4**) | **271** | five |

`countJunctionConflicts` as the previous draft wrote it samples end-of-tick occupancy. At tick 12,780
two cars **swap** across `(14,17)`: the cell holds one car at the start of the tick and a different
car at the end, never two at once, so the co-presence reading cannot see it — **and a swap across an
edge with a junction at its end is precisely the case Decision 2 names as producing the genuine
2-cycles this rule creates.** The two readings differ by `15,001 − 12,780 = 2,221` ticks = **74.0
seconds**, and the board diverges **74 s EARLIER than the co-presence census says, not later.** The
sentence that stood here — *"the board is unchanged for 74 s longer than the old plan claimed"* — was
wrong in both its arithmetic and its direction, and the escape hatch attached to it would never have
fired, because an implementer using the same definition reproduces 232 exactly and the protocol stays
silent. **Task 1 Step 11 therefore makes `countJunctionConflicts` measure BOTH policies and Task 1
Step 12 asserts BOTH numbers**; reproducing 232 alone is not reproduction.

So, precisely:

- **The board is bit-identical to today until tick 12,780 — 6:57.4 on a stopwatch.** Every
  minute-three figure this project owns is unchanged **by construction**: 0.602 cars in flight, 0
  blocked ticks, longest queue 1.
- **The first divergence is invisible.** One swap resolves differently. **The first tick a person can
  SEE — three cars stopped at once on the board — is tick 16,337, 8:56.0.** That is the number the
  device checklist and every observability line use, and it is a different quantity from either
  census.
- **M1f changes nothing observable on the board before minute seven, and nothing a player can see
  before 8:56** — with exactly one exception, which is the whole reason this section exists: **the
  modal appears at 2:21**, and again at 4:51, 7:21 and 9:51. That is the first thing a player sees
  change, and it lands six and a half minutes before the problem it exists to fix.

**The first three offers are BLIND, and this is structural rather than a tuning miss.** Measured:
the week boundaries land at ticks 4,500 / 9,000 / 13,500 / 18,000, which on §14's stopwatch
convention `(tick − 258) / 30` are **2:21, 4:51, 7:21 and 9:51**. The first player-visible jam is at
tick 16,337 = **8:56**. The post-Task-2 greedy run ends at tick 21,783 = **11:57.5** under arm B
(21,704 = 11:54 under the wide rule). So the run reaches **four boundaries, not twelve**, and **three
of the four offers are made before the player has ever seen a jam.**

**The one knob that exists cannot fix it, and that is derived rather than asserted.**
`SECONDS_PER_WEEK` is [OURS] at 150 with a stated plausible range of 120–180. Holding the run length
fixed, the boundaries `(k * TICKS_PER_WEEK − 258) / 30` fall at:

| week length | boundaries | blind of them |
|---|---|---|
| 120 s | 1:51, 3:51, 5:51, 7:51, 9:51, 11:51 | **four of six** |
| 150 s (shipped) | 2:21, 4:51, 7:21, 9:51 | **three of four** |
| 180 s | 2:51, 5:51, 8:51, 11:51 | **two of four** |

**Every value in the range leaves the first visible jam behind at least the first two boundaries**,
because the first boundary is at most 2:51 and the second at most 5:51 against a jam at 8:56 — and
pushing the *first* boundary past 8:56 would need a week of roughly nine minutes, far outside the
range. A longer week improves the ratio and buys fewer decisions; **and it is not a free knob
anyway**, because the demand ramp is week-indexed, so changing `SECONDS_PER_WEEK` changes the death
tick and the table above with it. That is the second reason this is not the fix.

So M1f does not fix the timing; it **states it**, and it relies on the one property of §2.2 that
makes a blind pick survivable: *"items sit unplaced indefinitely"*. A player who takes upgrades at
2:21 holds them until the jam and places them where it is. **The blind half of the decision is which
card, not where the object goes** — and Task 12 Step 4 measures whether that is a decision at all by
running `always tiles` / `always upgrades` / `alternate` across eight seeds.

**But holding is not free, and the arithmetic says so.** Junctions on the board at the four
boundaries are **0 / 2 / 6 / 6**, and the board's first junction is born at tick 4,530 — thirty ticks
*after* the first offer, and those thirty ticks are a `GREEDY_PERIOD_TICKS` metronome artefact rather
than a board property, which is why Task 3 Step 3a samples a **window** around each boundary rather
than the boundary tick alone. A card grants **two** upgrades and `canPlaceUpgrade` refuses `occupied`,
so a boundary-1 taker cannot seat the second until a second junction exists. At most **eight**
upgrades can be granted across the whole run. Against a measured ceiling that needs **six cells** to
reach +103.8 % and gives only **+7.1 % at two**, that is the tightest constraint in the milestone.

**M1f does not tune the tile economy, deliberately, and Task 12 reports it as an output.** Measured
before this milestone: **210 tiles granted, 62 spent, 0 unaffordable, week-close minimum 37** (and
the honest running minimum is **7, at tick 2,280, in week 0 before the first grant** — the 37 is a
minimum over week-close samples and this plan says so wherever it quotes it). Tiles have not been
the binding constraint since roughly week 3 and M1f loosens them further, because an upgrade costs 0
tiles and its card grants 20. **The binding constraint after M1f is intersection capacity, and Task
2 creates it on purpose**: on the predicted shipping arm (arm B) blocked car-ticks go 2,120 →
**29,267**, trips 747 → **368**, run 17:19.9 → **11:57.5**. Task 12 Step 7 reports tile slack as a
measurement of the run and hands the lever to M1g with the number and with the cost of pulling it,
which M1f has already half-paid.

**The milestone's honest acceptance criterion, and the only one that matters:** *a person who was
never told where to look sees cars queue at a specific corner around minute nine, and has already
chosen, at minute two, whether to hold the thing that fixes it — with a measurable difference between
a good placement and a bad one.*

---

### THE ACCEPTANCE CRITERION, SPLIT IN TWO AND EACH HALF GIVEN AN OWNER — written at Task 8

The sentence above is the milestone's, and at task seven of twelve **nobody owned it**. Seven tasks
had shipped, six of them honestly reporting *"a human sees nothing"* and the seventh reporting a
board that stops dead at a week boundary with nothing drawn on it. The review of Tasks 5 and 6 put
the danger exactly right: *"Six invisible tasks is fine; six invisible tasks with the acceptance
criterion still unowned at task seven of twelve is how M1d happened."* M1d shipped correct, tested,
deployed and invisible, and the user noticed before we did.

The sentence above cannot be owned by one task, because its two halves are three tasks apart. So it
is split, each half is a criterion in its own right, and each has an owner. **A milestone that
satisfies A and not B is diminished; a milestone that satisfies neither is M1d again.**

**A — THE CHOICE. Owner: Task 8. Satisfied at commit `9054b18`.**

> *On the board a plain link opens, with nobody told where to look: at **2 min 21 s** — tick 4,500,
> `(TICKS_PER_WEEK − WARM_START_TICKS) / TICKS_PER_SECOND` = `(4500 − 258) / 30` = 141.4 s — the
> board stops and dims, and one line reading **CHOOSE A CARD** appears over two large cards:
> **ROAD TILES · 30 TILES** and **JUNCTION UPGRADE · 20 TILES · x2**. The player taps one. The modal
> goes, the cars move again, and the tile counter in the HUD is **20 or 30 higher** than it was. The
> ERASE ROADS button is off the screen for as long as the modal is up and back afterwards. Under
> **SEE THE BOARD** the modal disappears and the frozen city is visible at full contrast with
> **TAP TO RETURN** over it; the clock does not advance while it is held.*
>
> Driven end to end on the production boot in `integration.test.ts` ›
> *"takes a card from a TAP at the drawn rect, and the board runs on with the tiles"* and
> *"gives the modal the whole screen: the erase control leaves and comes back"*.
> **Verified on hardware by Task 12's device session, which owns the half no test can hold: that a
> person who was not told any of this does it anyway.**

**B — THE JAM, AND WHETHER THE CHOICE MATTERED. Owner: Task 10, verified by Task 12.**

> *At **8 min 56 s** cars begin to stack at a handful of specific corners. The player taps the
> inventory chip and then a jammed junction; a marker appears on that cell and, from that tick, cars
> cross that corner the way they did before minute seven. A good corner makes the run measurably
> longer; a corner that was not the constraint changes almost nothing.*

**Task 8's own honest caveat, and it must not be papered over: criterion A does NOT require the
30-vs-20 choice to be a trade-off, because measured, it is not one.** Task 7 measured the greedy
arm's tile slack going **2.7× → 4.3× for identical roads** — `armGreedyActions` reads the budget in
exactly one place and `unaffordable` is **0** across the whole 21,783-tick run — so on the board that
ships today **the card's tiles are free money and taking either card costs the player nothing.** A
criterion phrased as *"the player weighs 30 tiles against 2 upgrades"* would be **false**, and Task
12 would find that on a device. What A asserts is that the loop is **visible, reachable and
completable**: the game stops, says what it is offering, takes an answer, and visibly pays for it.
Whether the answer is a *dilemma* is `CARD_GRANT_ITEM`'s "delete the automatic weekly grant" lever,
which M1f hands to M1g **with the number attached** and does not pull.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **`sim` is integer-only, allocation-free, and deterministic.** One `ArrayBuffer`; struct-of-arrays typed-array views; seeded mulberry32 held **inside** `GameState`; `hashState` is FNV-1a over the whole buffer. **Browser and Cloudflare Worker replay of identical inputs must produce BYTE-IDENTICAL state.** No `Math.random`, no `Date`, no transcendentals, no float literals, no module-scope mutable state, no iteration over `Map`/`Set`/object keys for anything sim-affecting. `packages/sim/test/determinism.test.ts`'s file list is exhaustive: **a new file in `sim/src` must be added to it in the same commit**, or it skips every rule. **A junction upgrade owns no timer** — Amendment 2 deleted the controller — but it does own one bit per cell, which is buffer state and not `Scratch` state, because a Worker replay must reproduce which cells are upgraded. That is why the upgrade costs a shape change and gets one (Task 4).
- **Rule constants are integer numerators over a denominator of `DENOM` = 1000**, converted only in `packages/shared/src/constants.ts`. Times are integer ticks derived from `TICKS_PER_SECOND`, never literals.
- **Index conventions, still three, and M1f adds none.** `cell = y * w + x`; `occupancySlot = cell * LANE_COUNT + lane`; `zoneIndex = zy * spawnZoneW + zx` (spawn.ts only). The previous draft added a fourth, `lightIdleSlot(slot, axis)`, for the light's per-axis idle counters; **Amendment 2 deleted it with the counters.** `upgradeAt` is indexed by `cell` and nothing else.
- **Zero allocations per tick and per frame.** Three harnesses, and confusing them is a recurring defect: `packages/game/test/allocation.test.ts` profiles `packages/game/src` **and** `packages/sim/src` and measures **the tick**; `packages/game/test/drawAllocation.test.ts` profiles `packages/render/src` and measures **the frame** (it flakes roughly 1 run in 10 — re-run before recording a kill from it); `packages/game/test/demoAllocation.test.ts` profiles all three on the demo board. `NOISE_FLOOR_BYTES_PER_FRAME` is 4. **A green harness is a claim about the inputs it was given** — prove liveness by injecting into the **new** code, and make the injected object escape (`(globalThis as any).__sink = {…}`), never `void __sink`.
- **Every window that profiles or measures a live sim states its end tick and its margin to game over**, and asserts `expect(isGameOver(state)).toBe(false)` after its final drive. Task 2 and Task 3 move `DEMO_DEATH_TICK`; every such window must be re-derived against the moved value, not against `deathTicks.ts` as it reads today. **`CITY_DEATH_TICK` does NOT move** — see Task 2 Step 6, where that is derived rather than assumed.
- **`packages/render` imports NOTHING from `packages/sim`.** `packages/render/package.json` declares no dependencies at all, so a `CARD_*` or `H_*` import inside `render/test` does not resolve — see Task 8's Files and Task 10's. Every new field the modal or the upgrade marker needs arrives on `RenderFrame` as a plain number, boolean or raw typed-array view folded by `packages/game`, and **every constant duplicated across the boundary is pinned in `packages/game/test/frame.test.ts`**, which is the only package that can see both copies, in the idiom `TerrainClass` already established there.
- **NINE goldens.** `1058753394` state (`sim/test/determinism.test.ts`), `2312109239` road-network (`sim/test/rollback.test.ts`), `252514232` field (`sim/test/rollback.test.ts`), `1877236894` loop (`sim/test/loop.test.ts`), `968680755` seed (`game/test/startingCity.test.ts` **and** `game/test/demoLayout.test.ts`), `307910575` queue (`sim/test/loop.test.ts`), `1531344761` multipliers (`sim/test/cars.test.ts`), `3152640907` demo (`game/test/demoLayout.test.ts`), `894844668` demand-pin (`sim/test/loop.test.ts`). **Which move, in which task, and why, is tabulated below and nowhere else.** A golden that moves in a task this plan did not name is a stop-the-world event, not a re-bless. **Every re-bless is paired with hand-computed direct assertions on the changed slots in the same commit — a digest is never the only evidence.** Grep the digest; the line numbers in any ledger decay faster than the digests do.
- **Canonical test invocation, and no other:**
  ```
  pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test
  ```
  `pnpm test` bails at the first failing package; `pnpm test --no-bail` crashes vitest; `pnpm --no-bail test` also bails, because the root script is itself recursive.
- **Every task mutation-tests its own tests.** For each behaviour, record the one-line change that makes its test fail. **Every kill must be an ASSERTION FAILURE naming the behaviour, never a `ReferenceError`, `TypeError` or module-load failure.** Screen for crashes on lines that are **not vitest result lines**, and record the matched line so a discard is auditable — a test *name* containing the word `TypeError` has already produced a false positive here, and a false positive silently throws away real coverage evidence. Run the **complement check** too: per-package test totals unchanged under each mutant, or the mutant stopped collection. Anchor every mutation on a line the program runs, never on a comment. **Coverage is keyed to the unit an editor edits** — a line, not an outcome: two `return` statements yielding one outcome are two editable sites and need two detectors.
- **Commit before ANY edit you intend to revert**, whatever its size — a one-line teeth-check probe has the same cleanup step and the same failure mode as a full battery. **The report of a restore must be unreachable when the restore did not run:** chain the `git status --porcelain` check to the restore's own success in one `&&` chain, or make it assert rather than print. Diff your expected file list against `git status` before quoting a green suite; a test count cannot detect deleted assertions inside surviving tests.
- **Never run two implementers at once.** They share the main checkout; only reviewers get worktrees. Before quoting any suite-wide number, check `git status` for strays and source mtimes against your own last write.
- **A single-seed claim smaller than 2× is inside the noise.** Across eight `RUN_SEED` values with nothing else changed, baseline blocked car-ticks span 1,298–42,381 (32.7×), trips 181–1,737 (9.6×) and death tick 16,122–51,275 (3.2×). **The shipped seed `laneways-m2` is an outlier** — the quietest of the eight on blocked car-ticks and one of only two that never fire the valve. Any claim of the form "the board does X" taken on `laneways-m2` alone is a claim about `laneways-m2`, and must say so.
- Do not modify `spike/`.
- Plans do not state expected test counts, and neither do reports.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8
  ```

---

## The observability contract

M1d shipped correct, tested at 0 Critical, and deployed with the artefact verified byte-for-byte —
and the user opened it and said it looked like the same demo. They were right, and every acceptance
criterion M1d had was machine-side and satisfiable on a purpose-built fixture.

**So every task in this plan carries an `Observability:` line phrased as what a human will see, on
the board that boots by default, at the time that task lands. Where the honest answer is "nothing",
the task says so.** Six of the twelve say nothing, and they say it out loud rather than by omission.

**The milestone-level answer.** After M1f, a player opening the plain link sees the same board they
see today until **2:21**, when it dims and two cards appear: **30 ROAD TILES** or **2 JUNCTION
UPGRADES · +20 TILES**. Taking the upgrades puts a chip in the HUD with a badge reading 2; the chip
persists until they are placed. At **8:56** cars begin to stack up at a handful of specific corners
instead of driving through each other — the first traffic jam this game has ever shown on the board
that ships. Tapping the chip and then a jammed junction drops an upgrade there, drawn as a static
marker on the cell. **From that tick, cars cross that corner the way they did before minute seven** —
the queue drains and does not re-form there. Put it on the right corner and the run lasts measurably
longer; put it on a corner that was not the constraint and almost nothing changes, which is the half
of the decision that makes it one.

**Say what a player does NOT see, because the previous draft's object promised it and this one does
not:** nothing about an upgrade animates, alternates or cycles. There is no phase to watch. The
feedback is entirely in the traffic — a corner that was stopping cars stops stopping them — which is
a harder thing to notice and is exactly what Task 12's device session has to answer.

---

## Scope

**In:** the junction mutual-exclusion rule and its triage; the offer phase; the two-card weekly
choice with a non-consuming seeded draw; the `choose-card` input with an echo-checked
replay-divergence detector; the pause, the modal, the peek button and the tap arbitration; the
**junction upgrade** as a placeable single-cell object with its own inventory chip, placement
gesture, five-refusal placement rule and one-clause entry rule; the pool's **map**-capability filter;
the long run, the deploy and the handoff.

**Out, each with a named recipient, because "handed to whoever owns X" is a drop when nobody owns X:**

| Deferred | Owner | Why |
|---|---|---|
| **The roundabout (§5.6, §1.8)** | **M1g, behind a geometry decision** | Measured: on the shipped board, **five of the six conflicting cells admit zero legal 3×3 centres at every tick of the run, and the sixth admits one — the cell measured as worth exactly zero.** The cause is structural: the greedy connector merges approaches at carparks and houses, so degree-3 cells form against buildings by construction, and §5.6 requires nine building-free cells. **M1g must answer the geometry question before writing a task**, and the four options the review enumerated are its input: (a) a smaller footprint; (b) relax §5.6 to bulldoze-and-refund buildings inside the block, which needs a house-removal path that does not exist and a determinism story for the car slots; (c) re-seed the city layout so junctions form in open ground, which invalidates all nine goldens; (d) leave it out. `CARD_ROUNDABOUT` is declared in `cards.ts` and excluded by `CARD_IMPLEMENTED_MASK` — an interlock, not an absence. |
| **THE METERED TRAFFIC LIGHT ITSELF (§5.6, dossier §1.7), and every constant under it** | **M1g, with a full measurement attached** | **This is Amendment 2's deferral and it is the largest thing M1f hands on after the roundabout.** M1f built the light as specified in a throwaway spike and measured it: fixed alternating green at the datamined `changeDelay` scores **320 trips against a 368 control (−13.0 %)**, wins on only **3 of 30 seat phases** on the shipped seed with a **median of −17 %**, and the spread caused by the seat phase alone — a parameter with no design meaning — is **1.19×–1.70×**, larger than any positive effect measured. **The plan's own demand controller is worse: 228 trips, −38 %, with ONE phase swap in the whole run**, because `minimumNearbyCarsBeforeSwapping = 2` within 2 tiles is essentially never satisfied on a board carrying about **eleven cars in flight** — on three of eight seeds the light never swaps at all and becomes a permanent closure released only by the 45 s valve. Measured red-light refusals are **16,490–19,536** against the **6,536** junction-caused refusals the object exists to drain, **2.5–3.0× against**. **The rejection is about THIS BOARD'S DENSITY, not about the mechanic**: the datamined constants are a correct description of the game being cloned and presuppose traffic far denser than this one has. **M1g's input is those numbers plus three named levers** — raise the board's car density until the constants have something to meter; lower `minimumNearbyCarsBeforeSwapping` to 1 (measured: swaps 13–80 per run, m2 recovers 228 → 349, still below control on 6 of 8 seeds); or make the light a *modifier on an upgraded junction* rather than a replacement for it. Everything under the light goes with it: `overtimeChangeDelay` (5 s, a real row with no referent in this game — the closest candidate mapping is *"any destination's overcrowd timer is non-zero"*, computable from `destOvercrowd` in O(destCount)), `americanRedLightRules` and right-on-red, `greenLightsIgnoreCollisions` as a *per-axis* rule, and amber. **None of them is declared as a constant in M1f**, because a constant with no caller reads as a supported configuration. `CARD_TRAFFIC_LIGHTS` **is** declared and excluded by `CARD_IMPLEMENTED_MASK` — an interlock, not an absence, exactly as `CARD_ROUNDABOUT` is. |
| **Deleting a placed upgrade, and the bidirectional inventory (§2.2)** | **M1g** | §2.2's counter is bidirectional — *"deleting a placed item returns it once in-flight traffic clears"*. M1f places and never removes. The reason is the same class the roundabout had: un-marking a cell while a car is mid-crossing on it changes that car's entry rule inside a traversal. **Amendment 2 makes this cheaper than it was** — there are no timers whose retirement has to be defined, only a flag to clear — but it does not make it free, and it is not in scope. **Consequence, stated so it is not discovered:** an upgrade placed on the wrong junction is permanent for the run. Task 12's device session asks whether that reads as a mistake the player can live with. **And a second consequence, which the previous draft recorded nowhere:** §5.6 makes a relief object and a roundabout mutually exclusive on a cell, so a permanent upgrade **forecloses an M1g roundabout site permanently**. Task 12 Step 11 carries that to M1g by name. |
| **Motorways, bridges, tunnels (§5.7, §5.1)** | **M1g** | Bridges and tunnels break a named, tested invariant in three places — `assertNoRoadOnImpassable` (`roads.ts`), `placeRoad`'s `world.passable` gate, and `graph.test.ts`'s randomised *"every neighbour has `passable === 1`"* property. The motorway is the one item in §5.10's table that changes `edgeCost`'s **value set** (the ÷3 tier), which re-opens `NB`, `DISTINCT_EDGE_COSTS` and `entryPoolCapacity` together; `scratch.ts`'s penalty-routing note is re-pointed at M1g in Task 1 and its corrected margin is quoted in this plan's trap 2. All three are absent from the offer pool by `CARD_IMPLEMENTED_MASK` (Task 11), not merely unimplemented. |
| **Board expansion / a real revealed region (§5.1)** | **M1g** | Declined by M1d, by M1e, and now by M1f, so it is said out loud rather than re-pointed quietly. Unchanged reasons: `MapData` carries no per-week schedule and adding one means folding it into `mapIdHash`, which moves every whole-buffer golden a second time in a milestone that budgets exactly one shape change; `canvas.ts` needs a `clip` around the board phases; `frame.test.ts`'s two fold markers sit in **diagonal corners**, which stops working the moment the fold is 2-D over a dynamic rect — a corner is past two bounds at once, so each of the four half-plane bounds needs its own marker one cell past exactly one of them. **And the reader count is TWO, not one:** `sim/src/spawn.ts` reads `REVEALED_X0/Y0/W/H` to bound where buildings may appear. |
| **Destination removal, and the square→circle upgrade (§5.2)** | **M1g** | Three source sites name removal as the trigger that ends an inert property — `state.ts`'s `houseAt`/`destAt`, `dispatch.ts`'s colour-order note, and `trips.ts`'s ascending-arrival-order note — plus `game/src/resolve.ts`'s slot-*reuse* class, closed today **only by reachability**. M1f removes no destination and upgrades none, so all four stay inert and all four comments keep their M1g date. The upgrade's price is already derived and carried: a circle takes two rotation slots against a trigger cap only 33 % higher, so on `firstCity` the colour-1 circle dies at **5,580** where the colour-0 square would have died at **6,330**. |
| **The round-robin / nearest-source mismatch (§15.2 of the carry-forward)** | **M1g** | The carry-forward addresses this to M1f in the imperative — *"M1f owns choosing between them"* — and **M1f declines it, deliberately and with a reason, rather than silently.** The three candidate fixes are all changes to §5.3's scheduling rule and to `dispatch.ts`'s Decision 4. Landing one in the same milestone as the junction rule and the relief object makes **both** unattributable. The evidence M1f leaves for it is better than M1e's: Task 12 measures delivery fraction per week on a board that now has real queues. `OvercrowdTimerCarArrivalDeceleration` (§15.6) is coupled to this and moves with it. |
| **Surfacing or bounding `MAX_PATH_LEN` = 96 (§15.3)** | **M1g** | Also addressed to M1f, also declined with a reason. The HUD gains two surfaces this milestone (the modal and the inventory chip) and a third readout competing with them is scope. The measurement that makes the deferral safe is on the tree: the longest route ever walked on the shipped seed's greedy arm is **21 steps** against the 96-step ceiling, and setting `MAX_PATH_LEN` to **24** leaves the run behaviourally unchanged. **And lowering it is not free even though it changes nothing:** `ROUTE_BYTES = MAX_PATH_LEN / 2` sizes `carRoute`, so 96 → 24 shrinks `firstCity`'s buffer and turns **8 of the 9 goldens** red on a behaviourally identical run. |
| **Moving tile income onto the card entirely** | **M1g, and M1f makes it cheap** | §5.10 literally says every card grants tiles *so a bad draw can never softlock*, which reads as the card being the income. Deleting phase 2's `WEEKLY_TILE_GRANT` would make 30-vs-20 a real ten-tile decision. M1f refuses it — see Decision 5 — because it changes two goldens' `H_TILES` into a function of the input log **and** because `runWeekBoundary` does nothing else, so deleting the grant deletes phase 2 and forces a second renumbering. **What M1f hands M1g is the expensive half already paid:** every headless rig has a card policy from Task 7, so the change is then a one-line deletion plus two hand-computed re-blesses. Task 12 Step 7 states it with the measured slack. |
| **The demand ramp's three numbers, `DESTINATIONS_PER_WEEK`, `HOUSES_PER_DESTINATION`, the pin capacities, one car per lane-tile** | **M1g / tuning** | All shipped and untuned. Do **not** add a `CARS_PER_CELL` constant "for later". Changing the ramp is a `rulesVersion` bump that invalidates stored replays. |
| **A real in-place restart (`resetState`), persistence, and the out-of-band seed board** | **M3** | M1f's restart is still `location.reload()`. `seedStartingCity`'s six placements still happen before tick 1 and travel in no input log, so the seed board is still not Worker-replayable. **M3 must re-measure the CloudStorage budget rather than extrapolate:** Task 4 grows `firstCity`'s buffer 13,992 → **14,972 bytes** (+7.00 %), of which **960 of the 980 added bytes** are the all-zero `upgradeAt` region — one byte per cell, and 98 % of the growth. |
| **The perpendicular lane offset in the renderer, and the multi-tick draw divergence** | **M1g (renderer)** | Cars are still drawn on the centreline. The offset is `(-DY[dir], DX[dir])` at about 0.15 cells, and the supremum M1g must re-derive is the offset table **plus** the chase bound. The tick-boundary divergence figure to quote is **0.9920 cells, 4.96 × `MAX_DRAW_LAG_CELLS`**, on the every-frame-drains-7-ticks schedule — quote the schedule with it. The **0.462 / 2.31×** pair is SUPERSEDED. The deceleration half of the launch smoothing is **proved unsatisfiable** and must not be re-litigated. |
| **Spawn weights** | **nobody, deliberately** | §5.9's *"ignore spawn weights after 5 consecutive failures"* governs a structure that does not exist. When weights land, the constant lands with them. |

---

## Carry-forward coverage — every item, with its task or its deferral

The catalogue's rule is that a handoff item with no home in the source is the one that evaporates,
and that checking costs one grep per item against a **list of names**, never a reading of the prose.
This is that list. Every section of `docs/superpowers/m1f-carry-forward.md` appears exactly once.

| Carry-forward § | Item | Where it lands |
|---|---|---|
| §1 | `regions.ts` × 5 FIELD_IRRELEVANT reasons dated M1f | **Task 1** promotes `carCell` / `occupancy` / `carBlockedTicks` from comment to failing assertion and re-dates all five to M1g. **Note the irony and record it**: the five reasons are dated *"M1f's demand-actuated lights"*, M1f ships exactly those lights, and they still do not become a field input — because Task 1's amendment says junction cost is not edge weight, which is the general rule those five reasons were always an instance of. **Task 4** — not Task 9 — adds the one upgrade region to the FIELD_IRRELEVANT list with that reason, because Task 4 is the task that declares it. (The previous draft said Task 9 here and Task 4 in the region block; Task 4 was right and this row was stale.) |
| §1 | `scratch.ts` `NB` / `DISTINCT_EDGE_COSTS` / `entryPoolCapacity` | **Task 1** re-points to M1g's motorway tier and adds the runtime bucket-window assert trap 2 asks for, with **both** of its arms |
| §1 | `cars.ts` `laneSpeedMul` as a cost-model change | **Task 1** re-points to M1g. **The rounding-inertness register entry is UNTOUCHED by M1f** — the values that would have ended it came from the roundabout, which is deferred |
| §1 | `roads.ts` `LANE_OF_DIR`, "the two-lane model's intersection gap" | **Task 2** — the gap *is* the junction mutual exclusion — and **Task 9**, which is where a junction upgrade gives the gap back **whole, at one cell**, rather than one axis at a time. The comment is closed in Task 9, not Task 2 |
| §1 | `shared/constants.ts` `ROUNDABOUT_SPEED_MUL` uncalled | **Still uncalled.** Re-dated to **M1g** in Task 1 beside `MOTORWAY_SPEED_MAX`, with the geometry finding as the reason |
| §1 | `render/types.ts` `HudRects`, `game/pointer.ts` `HUD_INERT` | **Task 10** — the inventory chip row's first chip |
| §2 | Board expansion | **Deferred, M1g** (Out table) |
| §3 | Destination removal's three inert properties | **Deferred, M1g** (Out table) |
| §4 | The erase control never unsubscribes its click handler | **Task 8** — it also has to be suspended under the modal, which is the same code |
| §5 | `MAX_BLOCKED_TICKS` unreachable on the arms M1e drove | **Task 2** — the valve fires on the shipped board for the first time; `constants.ts`'s two false claims are corrected in the same commit. **The previous draft said Task 9 adds a THIRD reader — it does not, and Amendment 2 deleted the reason it would have.** There was no third reader once the metered light left: an upgrade admits cars rather than refusing them, so it **reduces** valve pressure. Task 12 Step 7 measures by how much, and that measurement is the cleanest derivation of the relief mechanism this milestone has |
| §6 | The multi-tick draw divergence | **Deferred, M1g** (Out table); **Task 7** records the paused-car settling measurement beside the pause decision |
| §7 | The equivalent-mutant register (five entries) | **Task 5** re-runs `4 <-> 5` under its new name `5 <-> 6`; **all five entries survive M1f unchanged** and none may acquire a manufactured detector |
| §9 | The spawner is not connectivity-aware | **Deferred**, with the measurement that killed the obvious fix: the proposed proximity tier survives all twelve weeks **by making the board inert** — peak `destPins` 1 in 65 of 65 week-observations, four cars ever in motion, delivery fraction ~1.00. Task 12 restates it in the handoff |
| §10 | M1d's headline feature is demo-only on the board that ships | **Task 2 closes it.** This is the milestone |
| §11 | The five-tile save is undiscoverable in game | **Deferred.** Task 8's modal is the first UI this game has that teaches anything, and it teaches about cards. Named for M1g's tutorial surface |
| §12 | The first ten minutes are unloseable; greedy dies at 17:19.9 | **Tasks 2, 3 and 12** — the junction rule shortens the run; Task 12 re-measures on the shipped rule and states both clocks |
| §13 | The seed board is out of band | **Deferred, M3** (Out table) |
| §14 | The device checklist | **Task 12** ships an updated checklist; the five sentences and the six questions are re-derived against the M1f board |
| §15.1 | The demand ramp | **Deferred** (Out table) |
| §15.2 | The round-robin / nearest-source mismatch | **Deferred, M1g, with a reason** (Out table) |
| §15.3 | `MAX_PATH_LEN` is a silent ceiling | **Deferred, M1g, with a reason** (Out table) |
| §15.3 | `H_ROUTES_REFUSED` is not a blocking instrument | **Task 12** — it is 0 on all sixteen seed × arm runs measured and will stay 0 under every lever in this milestone. No task may quote it as evidence about traffic |
| §15.4 | `DESTINATIONS_PER_WEEK` / `HOUSES_PER_DESTINATION` | **Deferred** (Out table). Note `BOARD_FULL` is unreachable on `firstCity` and §5.3.5's redistribution fires **zero** times on the board that ships |
| §15.5 | Is 30 tiles a week right | **Task 6 changes the answer** (the card adds tiles on top) and **Task 12 re-measures the slack and reports it as an output**, with the M1g lever named and half-paid |
| §15.6 | `OvercrowdTimerCarArrivalDeceleration` | **Deferred, M1g, coupled to §15.2** (Out table) |
| §15.7 | The square→circle upgrade | **Deferred, M1g** (Out table) |
| §15.8 | The pin capacities | **Deferred** (Out table) |
| §15.9 | One car per lane-tile | **Deferred; do not add `CARS_PER_CELL`** (Out table) |
| §15.10 | Frame cost under a full jam | **Task 12** — M1f is the first milestone that can produce a full jam on the shipped board, and the allocation harness says nothing at all about frame TIME. A device question, not a budget |
| §15.11 | What the restart feels like | **Task 12**, device question |
| §16 | The golden ledger, and the third class of re-bless | This plan's *"Which goldens move"* section |
| §17 | The tick order, re-measured at the final phase count | **Task 5** runs all `C(11, 2) = 55` pairs at the final count of eleven phases; **Task 9 adds no phase and runs no new pairs** (Amendment 2 deleted the appended phase 12); **Task 12** re-runs only the **19** rows involving a phase whose content changed since Task 5 — phases 3 and 10 — and proves the other 36 unchanged by `git diff` rather than by assertion |


---

## The six traps

Each of these is a way this milestone can be built correctly and still be worthless, or be wrong
while every assertion passes. They are not warnings; each names the task that closes it.

### Trap 1 — the riskiest thing in this milestone is Task 1, not the relief object

Spec §5.4 line 179 says *"model intersection and traffic-light penalties as extra integer edge
weight, which Dijkstra absorbs for free."* **The dossier says the opposite, and it says it about
lights by name.** Dossier line 74: *"It is shortest by **distance, not time** — junctions, lights and
roundabouts carry no path cost, which is exactly why players observe 'the game picks the shortest
path but not the fastest'"*. And dossier §1.5's closing line: *"Do not add a congestion term to path
cost. The omission is load-bearing: it makes the player the only rerouting mechanism, which is the
entire game."* **The shipped code follows the dossier and nothing enforces it.**

If a later hand reads L179 and prices the junction — or the light — as edge weight, cars route
**around** the upgraded junction and the 29,267 blocked car-ticks Task 2 creates (45,986 under the wide rule) evaporate before a
single player feels one. The milestone would be correct, tested, deployed, and invisible — M1d
again, and this time it could happen **after** Task 9 is built, making every light worthless
retroactively. So Task 1 ratifies the dossier by amending the spec with provenance, and lands an
interlock that fails loudly rather than a comment that reads well.

**Two corrections to the previous draft's provenance, both of which a reviewer caught and both of
which would have shipped as fabricated citations:**

1. The amendment must **not** say "the dossier says the opposite" about the whole clause. Dossier
   §3.3 is the *verbatim source* of spec L179's surrounding paragraph, so most of that line is the
   dossier speaking. What is refuted is the final clause alone, and what refutes it is **dossier
   line 74** (quoted above) plus **dossier line 101**, the verifier's own correction: the lane-speed
   constants *"sit among pure driving-physics params, the source contains zero references to
   pathfinding … Time-weighted routing is a plausible hypothesis, **not established**."* Cite those
   two lines and nothing else.
2. §1 of the spec's *"no congestion term"* does **not** cover a static junction surcharge — a
   surcharge is not congestion. Do not cite it as if it did.

### Trap 2 — a penalty applied inside `computeFlowField` keeps every assert green and produces wrong paths

`assertBucketCountExceedsEveryEdgeCost` inspects **only** `edgeCost(k)`. A penalty added inside
`computeFlowField` — say `+2` for a cell of degree ≥ 3, read off `state.roads`, or `+1` for a lit
cell read off `state.upgradeAt` — leaves that assert passing while Dial's cyclic queue aliases two
distances into one bucket. Measured, by mutating only the modulus: at `d % 13` the run scores **31
detectors including the field golden**, and the failure reads like a routing regression rather than
a queue bug; a push at `d + 14` lands in the bucket drained at `d + 1`, where the drain loop's
staleness check **discards** it. Wrong paths, no crash.

**Correction to a claim this project has repeated, and it must not be repeated again: `NB =
DIAG_COST + 1 = 15` does NOT have zero slack.** `scratch.ts:55-70` supersedes that: the bound is
`M >= max edge cost`, the minimum is **14**, and the `+1` is **one bucket** of slack. What the spare
bucket buys was measured too — at modulus 15, moving `bucketHead[b] = -1` from before the walk to
after it is a **0-detector no-op**; at modulus 14 the same move makes `computeFlowField` **not
terminate**. So at 14 correctness is a joint property of the modulus and one statement's position;
at 15 it is a property of the modulus alone.

**And the guard needs TWO arms, which the previous draft did not have.** A single bound of
`pushed − draining <= NB` accepts a push of `d + 15`, i.e. **the smallest possible added term** —
`+1` on a diagonal. That is precisely the mutation the guard exists to catch, and it would pass. So
`assertPushWithinBucketWindow` takes the maximum legal edge cost as a fourth parameter and throws on
two distinct conditions with two distinct messages: *aliasing* (`delta > buckets`) and *an illegal
edge cost* (`delta > maxEdge`). Two arms, two tests, two mutants. Task 1 Step 9.

Note also: a **per-cell** penalty changes `edgeCost`'s signature, not its value. It makes cost depend
on more than direction, so `edgeCost(dir)`, `NB`, `DISTINCT_EDGE_COSTS`, `entryPoolCapacity`,
`COST_UNIT_SCALE` and `CAR_SPEED_UNITS_PER_TICK` all go structurally blind at once.

### Trap 3 — Task 2 makes the game measurably WORSE by every gate this project owns

Two rules were measured and the plan predicts **arm B** (Task 3). **Both columns are here because the
previous draft quoted only the wide rule and then wrote one of its figures into a permanent spec
amendment two tasks before the arm was chosen** — the second review's I6. Nothing downstream may
quote a wide-rule figure without saying so.

| gate | today | after Task 2, **wide rule** | after Task 3, **arm B (predicted)** |
|---|---|---|---|
| blocked car-ticks | 2,120 | **45,986** (×21.7 up) | **29,267** (×13.8 up) |
| ticks with a blocked car | 6.2 % | **26 %** | measure |
| worst `carBlockedTicks` | 32 | **1,350 (saturated)** | **1,350 (saturated)** |
| valve firings | 0 | **15** | **5** |
| run length | 17:19.9 | **11:54** (tick 21,704) | **11:57.5** (tick 21,783) |
| completed trips | 747 | **344** (down 54 %) | **368** (down 51 %) |
| `H_ROUTES_REFUSED` | 0 | 0 | **0** |
| junction-caused refusals | — | 18,458 (40.1 % of blocked) | **6,536 (22.3 % of blocked)** |
| `game` tests moved | — | **at least 20** (see Task 2 Step 5) plus `DEMO_DEATH_TICK` | — |
| `CITY_DEATH_TICK` | 5,580 | **5,580, unmoved** | **5,580, unmoved** (derived, Task 2 Step 6) |
| goldens moved | — | **zero of nine** | **zero of nine** |

**Valve firings are 15 and 5, not 14.** The previous draft's 14 was reproduced as 15 under the wide
rule and 5 under arm B; both are corrected here and both must be re-measured rather than pasted.

**Write those numbers into the task before it executes, which this table does.** The catalogue
records *"a survivability gate can be passed by deleting the difficulty"*; this is its mirror image,
and a reviewer who has not been told will read it as a regression and ask for it to be reverted. It
is not a regression: **a junction that costs nothing is the bug**, and 13.8× is the size of the bug
on the arm this plan predicts.

**And the size of the hole is exactly the size of Task 9's job: 379 trips.** That is measured, not
projected — see Amendment 2. **A junction upgrade at the six census conflict cells reproduces the
pre-M1f board to the digit** (747 / 31,456 / 2,120, junction-caused refusals 0), so the relief is
worth the whole cost. What closes this gate is **Task 3's early efficacy check and Task 9's placement
table**, not Task 2's own numbers.

**Zero of the nine goldens move in Task 2, and that is derived rather than hoped:** every golden
fixture in the repo either has no cars (`rollback.test.ts`, the state golden's 4×4 board), or runs a
corridor where no cell reaches degree 3, or never puts two cars on one junction cell within its run
length. Task 2 Step 4 proves it by running the suite before touching a golden literal. **If a golden
moves in Task 2, stop and report — do not re-bless.**

### Trap 4 — an upgrade cannot make its own junction worse, and that is NOT the same as making the run better

**This trap replaced two earlier ones and it is the sharpest of the three.** The first draft's was
*"+68 % is a ceiling"*; the second's was *"a light meters a junction, so a metric that counts waiting
cannot tell you whether it helped"*. Amendment 2 deleted the metering, and with it the reason blocked
car-ticks was the wrong instrument. **The trap that replaces it is the opposite shape: the object is
now so obviously good locally that a test can pass while proving nothing.**

**Locally, an upgrade is strictly a buff and this is not an assumption.** At its own cell it admits a
strict superset of what the bare junction admits: `junctionAdmitsOne` returns false there, so the
crossing check is skipped and only the entrant's own lane is consulted — exactly the pre-M1f rule,
permanently, for every axis. There is no phase, no red, no starved approach and no wrong moment. **A
whole class of risk the metered light carried does not exist here, and the tests must not spend
effort proving it absent.**

**Globally, it is not monotone, and the spike measured that.** Relief at one junction moves traffic
downstream and changes arrival order. Across eight seeds the six-cell exemption beat its control on
**seven**, with deltas `+382 +47 +203 +385 +157 −5 +20 +129` — **one seed went backwards by 5 trips.**
So:

- **No test may assert that every placement beats the control.** Task 9 Step 11 and Task 12 Step 3
  assert **best beats control** and **best minus worst is real**, and both **report** how many
  placements are strictly worse.
- **The instrument is still `trips`**, and the death tick second. Blocked car-ticks are now a *valid*
  secondary read — the exemption takes them 29,267 → 2,229 — but they are reported, never asserted as
  the benefit, because a placement that improves them by killing the board faster is not help. Every
  measurement additionally asserts that every live destination is still reachable.

**The mechanism is derivable, which means it can be checked.** `LANE_OF_DIR[d] !==
LANE_OF_DIR[OPPOSITE[d]]` for every `d` — that is the property that made a head-on swap resolve in one
tick before M1f. Task 2's mutual exclusion **destroys that property at junctions**: two cars swapping
across an edge whose endpoints are both junctions now each require the other's cell to be entirely
empty, which is a genuine 2-cycle cleared only by the valve at 1,350 ticks. **An upgrade gives it back
whole.** Dossier §1.7's `greenLightsIgnoreCollisions` is the row that names the behaviour — the
crossing check is skipped and only the entrant's own lane is consulted — and an upgrade is that row
with no phase attached: it applies to every axis, always.

**Task 9 Step 7 asserts that derivation directly**, on Task 2's own `twoAdjacentJunctions` fixture
with an upgrade on each: both cars move on the same tick, with nothing hand-written into state. **The
previous draft could only demonstrate this from a hand-set light phase, and its own controller could
not reach that phase in the two-car case** (second review I12); with an upgrade there is no phase to
reach. If that test cannot be made to pass, the mechanism is not what this plan says it is and **that
is the milestone's headline finding**.

### Trap 5 — the ceiling needs six cells, the board can seat at most four of them, and one card grants two

**This is the trap the spike found and nobody had looked for.** The relief object works. Whether a
player can get *enough of it, soon enough, onto the right cells* is a separate question with a
measured and uncomfortable answer.

| measured | value |
|---|---|
| exemption at the **top two** refusal cells | **394 trips, +7.1 %** over the 368 control |
| exemption at the **top six** refusal cells | **750 trips, +103.8 %** |
| of those six, how many ever reach road degree ≥ 3 | **four.** `(13,18)` (19.5 % of refusals, the second-largest cell) and `(11,20)` are **never junctions on any tick** |
| junctions existing on the board at the four week boundaries | **0 / 2 / 6 / 6** |
| upgrades obtainable across the whole run | **8** (2 per card × 4 boundaries), against `MAX_UPGRADES` = 24 |

Three consequences, each of which changes a task:

1. **The measured 750 is an upper bound that includes two cells no player can ever use.** The
   *reachable* ceiling is bounded below by 394 and above by 750 and **is not measured**. Task 9 Step
   11 measures it on the junction-eligible cells only, and its report writes Task 12's thresholds.
2. **Two upgrades buy +7.1 % and six buy +103.8 %** — a factor of fourteen for a factor of three in
   count. So the card decision is not "is an upgrade good" but "how many weeks do I spend on
   upgrades", and Task 12 Step 4's `always tiles` / `always upgrades` / `alternate` comparison is the
   instrument for it.
3. **A criterion that requires all six hot cells to be seatable HALTS THE MILESTONE ON A FALSE
   POSITIVE.** Task 3's site survey must rank by *junction-eligible* refusals and must be satisfiable
   on four — see Task 3 Step 3a, where the second review's C2(b) is closed.

### Trap 6 — `destPins` and `destReserved` are `Uint8Array`

An unguarded decrement at 0 wraps to **255**, and where the slot gates eligibility it excludes that
destination from dispatch **forever**, silently, surviving snapshot/restore and replaying identically
in the Worker. The complete set of `Uint8Array` decrement paths in `sim/src` today is three:
`destPins` and `destReserved` in `trips.ts` (guarded by `assertArrivalHonoured`) and `ghostCommitted`
in `roads.ts` (guarded by `assertGhostCommittedPositive`).

M1f's new writers are, after Amendment 2, **three and only three**: the offer phase (writes
`H_OFFER_A`, `H_OFFER_B` and `H_OFFER_WEEK`, all `Int32`); `choose-card` (increments `H_TILES` and
`H_INV_UPGRADES`, both `Int32`); and `applyPlaceUpgrade` (writes `upgradeAt[cell] = 1` — `Uint8`, a
constant, **never relative and never downward** — increments `H_UPGRADE_COUNT`, `Int32`, and
decrements `H_INV_UPGRADES`, `Int32`). **So M1f adds no fourth `Uint8Array` decrement path** — and
Task 12 verifies that the way M1d and M1e did, by **enumerating every write to every `Uint8` region**
rather than grepping for `--`, because the one path M1d actually added spells it
`const left = committed - 1` across two statements and no `--`-shaped pattern matches it.

**Amendment 2 removed the only interesting part of this trap and that is worth stating.** The
previous draft's light wrote five regions across three tiers — `lightAt` holding `slot + 1`,
`lightCell`, `lightGreenAxis`, `lightAmberFor` and two saturating `Int16` counters — and needed a
paragraph explaining why `LIGHT_IDLE_CAP` = 900 and `MAX_BLOCKED_TICKS` = 1,350 forced `Int16`.
**There are no counters now.** `upgradeAt` holds 0 or 1, so no width question can arise, no sentinel
can collide with a real value, and the `MAX_UPGRADES < 255` assertion the previous draft needed
(because `lightAt` held a slot index) **is deleted with the index**. `MAX_UPGRADES` is now a pure
placement cap and Task 4 states it as one.

---

## Which goldens move, exactly, and in which task

`hashState(s)` is FNV-1a over the **whole** buffer, sized by
`computeLayout(regionsFor(map)).totalBytes`, so adding a region changes the digest even when every
new byte is zero.

**Buffer shape changes in exactly ONE task, Task 4.** That is deliberate structure, copied from M1e:
a standing re-bless licence is a window in which a genuine behavioural regression is absorbed as an
expected hash update, and this milestone keeps the window one task wide. Every task after Task 4
appends behaviour, never shape. **The one upgrade region is therefore declared in Task 4 and first
read in Task 9**, five tasks later, exactly as M1e declared `destOvercrowd` in Task 1 and first read
it in Task 7.

### The arithmetic, re-derived from scratch under Amendment 2

**Do not carry the previous draft's figures forward.** It sized a metered light: five header slots
plus **six** regions — `lightCell`, `lightSince`, `lightIdle`, `lightAt`, `lightGreenAxis`,
`lightAmberFor` — for **1,364 bytes and 29 → 35 regions**, taking `firstCity` to 15,356 B. A junction
upgrade is **one bit per cell**: a flag, not a machine. Every one of those figures is superseded.

`firstCity` sizes: `cells` 960, `groupCount` 5, `maxHouses` 40, `maxDestinations` 16, `maxCars` 80,
`routeBytes` 48.

| Added in Task 4 | Type | Length | Bytes |
|---|---|---|---|
| `header` grows 13 → 18 (`H_OFFER_A`, `H_OFFER_B`, `H_OFFER_WEEK`, `H_INV_UPGRADES`, `H_UPGRADE_COUNT`) | `Int32` | +5 | **+20** |
| `upgradeAt` | `Uint8` | `cells` = 960 | **+960** |
| | | **total** | **+980** |

| tier | before | after | why |
|---|---|---|---|
| 4-byte (`Int32`/`Uint32`) | 1,824 B (456 elements) | **1,844 B** (461) | the header's five slots |
| 2-byte (`Int16`) | 4,320 B | **4,320 B, UNCHANGED** | the upgrade owns no counter |
| 1-byte (`Uint8`) | 7,848 B | **8,808 B** | `upgradeAt`, appended at the end |
| `regionsFor` | 29 regions | **30 regions** | one region, not six |
| `totalBytes` (`firstCity`) | 13,992 B | **14,972 B** | +980, **+7.00 %** |

**Padding stays at zero and that is arithmetic, not luck:** 1,844 is a multiple of 4, so the `Int16`
tier starts aligned; 1,844 + 4,320 = 6,164 is even, so the `Uint8` tier starts aligned; and the total
14,972 = 4 × 3,743 is a multiple of the largest alignment, so no tail pad is inserted either.
`regions.test.ts`'s zero-padding assertion still holds. **Verify every one of these claims by running
`computeLayout(regionsFor(firstCity()))` rather than by trusting this table.**

**One insertion, ONE append, and Task 4's proof depends on knowing which is which.** `header` is the
**third** region in the 4-byte tier (`rng`, `mapIdentity`, `header`, …), so its five new slots go in
mid-buffer and shift everything after them. `upgradeAt` is appended to the **end of the `Uint8`
tier**, which is the end of the buffer. **`m1fSplice.ts` therefore has TWO contiguous ranges, not
four** — the header's five slots and the `Uint8` tail — which is exactly `m1eSplice.ts`'s shape, and
each one's boundaries are computed from the layout rather than written down. The previous draft
needed four ranges because the light added a tail to three separate tiers; two of those three tails no
longer exist.

### Which digests move, and why — re-derived, not carried

> **The digest column is the PRE-TASK-4 value, not the current one. Dated note added
> at Task 4's fix round.** Task 4 landed the shape change and moved eight of the nine
> exactly as the "Moves in" column predicts; Task 5 then moved the two this table marks
> as its own. **Every literal in the left column below is now historical.**
>
> Deliberately NOT re-listing today's values here: this table would go stale again at
> Task 5, Task 7 and Task 9, and a ledger that has to be re-edited every task is the
> defect rather than the fix. **The source of truth is the assertion**, and each one
> carries an `spliceM1fInsertions` proof against its own prior digest, so the chain
> from this table's value to the current one is running code rather than prose. To read
> the current digest, grep the fixture named in the middle column.
>
> The "Moves in" column is unchanged and still correct — it is a claim about WHICH task
> owns each move, which is the part of this table that was worth writing down.

| Golden | Fixture | Moves in |
|---|---|---|
| `1058753394` **state** | `determinism.test.ts`, 4×4 map, no buildings, 13,499 ticks | **Task 4** (layout), and **Task 5** — it is one of only two golden fixtures that cross a week boundary, so it is one of only two the offer phase can reach |
| `2312109239` **road-network** | `rollback.test.ts`, never calls `step` | **Task 4** only |
| `252514232` **field** | `rollback.test.ts`, `foldedFieldsHash` over `dist`/`dir` | **NEVER.** It hashes flow fields, not the buffer — which is exactly the property that makes it the odd one out, and exactly what makes it a tripwire for trap 1. **If it moves in any task of this milestone, stop and report** |
| `1877236894` **loop** | `loop.test.ts`, 20×12, 150 ticks | **Task 4** only |
| `307910575` **queue** | `loop.test.ts`, `Q_RUN_TICKS` = 130 | **Task 4** only |
| `1531344761` **multipliers** | `cars.test.ts`, `M_GOLDEN_TICK` = 110 | **Task 4** only |
| `968680755` **seed** | `startingCity.test.ts` **and** `demoLayout.test.ts`, pre-tick | **Task 4** only. **Two sites — a re-bless must edit both** |
| `3152640907` **demo** | `demoLayout.test.ts`, pre-tick on `demoCity` | **Task 4** only |
| `894844668` **demand-pin** | `loop.test.ts`, 20×9 fixture across a week boundary | **Task 4** (layout), and **Task 5** — same reason as the state golden |

**Eight of nine in Task 4, ten assertion sites, and the count did NOT change under Amendment 2 —
which is the point of re-deriving it rather than assuming it.** A smaller buffer change is still a
buffer change: the header insertion shifts every region after it and `upgradeAt` extends the total, so
every digest taken over the buffer moves regardless of how many bytes were added. What changed is the
*size* of the move, not its *extent*. The field golden is the only exception and for a reason that has
nothing to do with size.

**Why only two move behaviourally, derived rather than assumed.** The offer phase writes
`H_OFFER_A`/`H_OFFER_B` on every tick of a week ≥ 1 in which no choice has been made. Exactly two
golden fixtures run past tick 4,500: the state golden (13,499 ticks) and the demand-pin golden
(`DG_RUN_TICKS` across a boundary). Every other fixture stops inside week 0, where `runOffer` returns
on its first line. **Verify that claim per fixture by reading its run length before Task 5 changes
any literal — do not infer it from this table.**

**Both Task 5 moves carry a direct assertion on the bytes that changed, beside the digest.** The
state golden's fixture is a 4×4 map with water at (1,1) and mountain at (2,1). **Under the first
draft its pool collapsed to one card and `drawOfferPair` threw inside `step` after `H_EPOCH` had
been written, permanently poisoning the buffer.** That cannot happen here for two independent
reasons and both are landed: **the upgrade is capable on every map** (dossier line 227 grants
*"roundabouts / lights / motorways everywhere"*, and Task 11's `capabilityMask` reads terrain only),
so the pool on `GOLDEN_MAP` is `{CARD_ROAD_TILES, CARD_JUNCTION_UPGRADE}` — two cards; **and**
`runOffer` degrades rather than throws when a pool holds fewer than two (Task 4 Step 7). Task 5
asserts the two offer slots' exact values at tick 13,499 by hand from `offerSeedFor` and `poolFor`,
and Task 11 asserts them again after the pool acquires its capability half. **A digest is never the
only evidence for a re-bless in this milestone.**

**Task 2 moves no golden, Task 3 may move `3152640907` and nothing else, Tasks 1, 6, 7, 8, 10, 11 and
12 move none, and Task 9 moves none.** Task 3's exception is stated in its own preamble and is the
only conditional entry in this table: one of its three arms edits `demoCity`'s map bytes, which is
the one input `3152640907` folds. **Task 9 moves no golden and that is derived, and Amendment 2 made
the derivation shorter rather than longer**: it adds no region (Task 4 did) and no golden fixture
places an upgrade, so `upgradeAt` is all-zero in every one of them and `junctionAdmitsOne`'s new
clause is the identity there. There is no controller to run, no phase to append and no per-tick write
of any kind, so the only way a golden could move is if the clause answered differently on an
un-upgraded cell.

### The third class of re-bless applies to Task 4 and to nothing else

The ledger's rule is that a re-bless carries a behavioural claim a reviewer can check against the
diff. **Task 4's carries none** — the digests move because the buffer is a different shape, and a
genuine behavioural regression landing in the same commit would be absorbed with no trace. So Task 4
must state which shape change moved them **and assert the run's behavioural observables unchanged in
the same commit**: death tick, trips and refusals on the greedy arm, plus the splice proof. Without
both halves the re-bless is a blank cheque.

**And "bit-identical" is the wrong word for it.** The runs are *behaviourally identical with a
different buffer*. A reader told "bit-identical" and then "moves 8 goldens" has been handed a
contradiction and will believe whichever half suits them.

**A red golden test is not a moved digest.** Under a shape change, several golden tests abort on a
buffer-length pin sitting **above** their `expect(hashState(...))` line and never reach it. Every
`yes` in the table above must be re-measured **by digest**, by relaxing the pins and re-running; a
`no` needs no re-check, because a green golden is the digest speaking directly.

---

## Seventeen design decisions

### 1. Routing stays congestion-blind, junction-blind and upgrade-blind; the cost lives in MOVEMENT and ENTRY only

Ratified in Task 1 as a spec amendment with provenance, because the spec and the dossier disagree and
the code follows the dossier. The amendment's text is in Task 1 Step 1. Three consequences, each
enforced rather than asserted:

- `edgeCost`'s signature stays `(dir: number) => number`. A per-cell or per-pair cost is a
  **signature change**, and the interlock pins the signature line, not the values.
- `computeFlowField` reads no per-cell penalty region. The behavioural arms in `flowfield.test.ts`
  scramble every FIELD_IRRELEVANT region and cannot see a penalty derived from `roads` (which is
  FIELD_INPUT), so Task 1 adds the **structural** half: a scan banning `roadDegree`,
  `INTERSECTION_DEGREE`, `isJunctionCell`, `junctionAdmitsOne` and `upgradeAt` inside `flowfield.ts`,
  with **`graph.ts`** as its positive control. (`graph.ts`, not `cars.ts`: Task 2 removes
  `roadDegree` and `INTERSECTION_DEGREE` from `cars.ts` entirely, which would silently disarm a
  control anchored there — see Task 1 Step 2's comment and Task 2 Step 9.)
- The Dial queue's aliasing is converted from "wrong paths, no crash" into a named throw by
  `assertPushWithinBucketWindow`, **with two arms** (trap 2).

### 2. The junction rule is MUTUAL EXCLUSION at the cell, and it is spec §5.5 taken literally

§5.5: *"One blocking primitive: does an inbound vehicle collide with a traversing vehicle on this
chunk?"* The lane model already resolves the parallel and the head-on cases —
`LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]` for every `d`, so two cars in exactly opposite
directions never contend. What it has never resolved is the **crossing** case, and a junction is
where crossings happen.

The rule Task 2 lands: **entering a cell of road degree ≥ `INTERSECTION_DEGREE` requires BOTH lanes
free.** One extra `Int16Array` read on 0.35 crossings per tick, zero new state bytes, zero
allocations.

**Two things this breaks that are currently written down as true, and Task 2 corrects both in the
same commit:**

1. `constants.ts`'s `MAX_BLOCKED_TICKS` comment says *"Head-on is structurally impossible …, so no
   2-cycle can deadlock and the valve is not the answer to opposing traffic. It is the answer to a
   cycle of length >= 3."* **False after Task 2.** Two cars swapping across an edge whose endpoints
   are both junctions each require the other's cell to be empty, and each is standing in it: a
   genuine 2-cycle, cleared only by the valve at 1,350 ticks. That is one of the reasons the valve
   goes from 0 firings to 14. **And it is exactly the property Task 9's green light gives back.**
2. The same comment says *"lowering this constant is a change no shipped board can observe, and
   raising it is free."* **Also false after Task 2** — the valve fires on the shipped board, so both
   directions are observable. And `blocking.ts`'s `canEnter` doc says *"Give-way is not implemented
   because it does not need to be"*; after Task 2 it is implemented, as mutual exclusion, and the
   sentence has to say so.

**Fairness is decided explicitly, not inherited from a loop bound.** When two cars would enter one
junction cell on one tick, **the lower car index wins** — the same rule `runMovement`'s ascending
iteration already produces, but written down as a rule with a test rather than left as a property of
a `for`.

### 3. `isJunctionCell` and `junctionAdmitsOne` are TWO predicates, and the relief object forces the split

The previous draft had one predicate with two readers — `canEnter`'s exclusion and
`intersectionSpeedMul`'s slowdown — and argued that one edit should lift both. **The relief object
proves that wrong**, and it does so under either effect. Amendment 2 changed *why*, not *whether*:

- Under the metered light, §5.6's right-on-red clause forced it — *"skips the stop, not the
  intersection slowdown"*.
- Under the junction upgrade it is forced by the upgrade's own definition: **the mutual-exclusion
  rule does not apply at an upgraded cell, and everything else about the cell is unchanged, including
  `INTERSECTION_SPEED_MUL`.** An upgraded junction is still an intersection — it still slows cars —
  and is no longer under the default rule.

**A correction the previous draft over-claimed and the second review caught:** *"a single predicate
cannot express §5.6"* is too strong. One predicate returning an enum could express it. The split is
worth having for two better reasons, and they are the ones to state: it puts each rule's edit in
exactly one place, and it makes the divergence a **table** in `graph.test.ts` rather than a branch
inside a caller.

So Task 2 lands two functions in `graph.ts`, both trivial, both with one job:

```ts
/** Degree >= INTERSECTION_DEGREE. The SLOWDOWN's reader. An upgrade does not change this. */
export function isJunctionCell(state: GameState, cell: number): boolean

/** Does the DEFAULT mutual-exclusion rule apply here? The EXCLUSION's reader. */
export function junctionAdmitsOne(state: GameState, cell: number): boolean
```

In Task 2, `junctionAdmitsOne` is exactly `isJunctionCell`. In Task 9 it gains **one clause** —
`if (state.upgradeAt[cell] !== 0) return false` — and `isJunctionCell` gains none. **That one clause
is the entire entry rule of this milestone's relief object**; `canEnter` is not touched by Task 9 at
all, and `carAheadOf` (`queueProbe.ts`) reads the same predicate, so the probe and the entry rule
**cannot disagree about an upgraded cell**. That closes the second review's I4(b) structurally rather
than by adding a step. **Both are pinned by `graph.test.ts` as a table over the four combinations**
(upgraded/plain × junction/corridor), so the pair cannot drift into agreement.

This also settles the review's C5, which asked for the junction rule to be switchable off at runtime
so Task 2 could measure an exclusion-only exemption. **This plan does not build that switch, and the
reason is stated rather than skipped.** Module-scope mutable state is banned in `sim/src`; a
`Scratch` or `WorldData` field read on `canEnter`'s hot path would be a production code path
consulting a test-only array, which is *"dead configuration that reads as support"*; and a state
region for a measurement is a shape change in a milestone that budgets one. What replaces it:

- Task 2's *"five cells are the whole story"* claim is replaced by **Task 1's census**, which
  measures the per-cell distribution directly and is a standing test.
- Task 12 Step 1's *"reproduce before you contradict"* is a **committed-then-reverted three-line
  probe** on `canEnter`, run under the project's standard commit-first / `&&`-chained-restore
  discipline. Task 3's arm must therefore be a **single named predicate**, so the revert is
  mechanical.

`INTERSECTION_DEGREE = 3` moves out of `cars.ts` module scope into `@laneways/shared` in Task 1,
because `graph.ts` now needs it and a private constant with two conceptual readers is a copy waiting
to happen.

### 4. Task 3 is a fork resolved BEFORE the shape change, and its criterion is written before its measurement

Junction exclusion freezes the demo board inside `demoAllocation.test.ts`'s profiling window:
**97,138 blocked car-ticks, longest queue 17, trips 420 → 105**, and the rig's liveness guard fires.
The rig ends at tick **6,459** against a `DEMO_DEATH_TICK` of 6,703 — a 3.6 % margin, the tightest in
the repo.

Measured demo death ticks, so the fork is arithmetic rather than a guess: **today 6,703; under Task
2's wide rule 5,757; under arm B 6,660.** Arm B against the pinned 6,459 is a **3.0 % margin —
worse than the status quo**, so criterion 1 as the previous draft wrote it fails on the predicted
arm, and its fallback clause did not name criterion 1.

**The escape exists and the previous draft missed it.** `demoAllocation.test.ts` puts explicit
floors on `PROFILED_FRAMES` (≥ 3000) and `WINDOW_COUNT` (≥ 3) and **no floor at all on
`WARMUP_FRAMES`** (1,500). Lowering it to 500 gives `framesDriven = 9,500`, an end tick of ≈**5,959**
and a **10.5 %** margin, with the profiled window length and count untouched — which is *not* arm C's
disqualified trade. Task 3 Step 9 names that knob, states its one risk (500 frames of JIT warm-up
instead of 1,500, mitigated by the minimum over three windows and checked by recording the per-window
figures), and extends the fallback to criterion **1**.

**This is a balance decision and it must not be discovered inside Task 9.** Task 3 measures three
arms in one sitting and applies a criterion stated before any of them runs.

### 5. The offer is a `step` PHASE at position 4, and the card's tiles are paid by the INPUT

Phase 2 (`runWeekBoundary`) keeps `WEEKLY_TILE_GRANT` and writes `H_TILES` and nothing else. Phase 4
(`runOffer`) writes `H_OFFER_A`/`H_OFFER_B` and nothing else. **The card's tile bonus is paid inside
`applyChooseCard`, in phase 3, never at the boundary** — so phases 2 and 4 are disjoint **by
construction**.

Position 4 is forced from both sides: **after phase 3**, because a `choose-card` action queued on the
boundary tick must resolve *this* week's offer before the phase that would raise one; **before phase
5 (spawn)**, because nothing downstream may observe a half-raised offer.

**The consequence for tile income is a balance regression and it is named, not hidden.** A player now
receives 30 automatic tiles plus the card's 30 (tiles) or 20 (an item), against a measured **3.4×
slack** — 62 tiles spent of 210 granted on the arm that ships, with a week-close minimum of 37 (and a
running minimum of 7, in week 0, before the first grant — quote both or neither).

**The alternative was re-examined against the review's product finding and refused again, with a
second reason the previous draft did not have.** Deleting phase 2's grant so the card is the only
income is §5.10 taken literally and is the only version in which 30-vs-20 costs anything. It was
refused because it turns two goldens' `H_TILES` into a function of the input log **and** because
`runWeekBoundary`'s entire body is that one grant — the week counter is written in phase 1 — so
deleting it deletes phase 2 and forces a **second renumbering** in a milestone that has already paid
for one. **Task 12 Step 7 hands M1g the lever with the number and with the observation that M1f has
already paid its expensive half**: every headless rig acquires a card policy in Task 7, which is what
made the change dear.

### 6. The draw does NOT advance `state.rng[0]`, and the guard lands before the hazard

Measured: **one `nextRandom` per week boundary moves the greedy arm's death tick 31,456 → 34,088**,
freezes `spawn.test.ts` at 2,640,000 and fails Gate C. The spawner already reads the RNG word
**without** advancing it, for the same reason and with the reason written at the site.

So the offer is a pure function of the word and the week:

```
offerSeedFor(state, week) = mixWord(rng[0] ^ imul(week + 1, 0x9E3779B1))
```

`mixWord` is mulberry32's output transform with the state write removed, extracted from `nextRandom`
so there is **one** copy of that arithmetic rather than two. Successive words inside one draw come
from re-mixing (`mixWord(w)`), so rejection sampling needs no counter and no storage.

**Selection is rejection over a `CARD_COUNT`-bit pool bitmask, with no array**:
`no-module-mutable-state` forbids a module-scope one and a local one allocates on a per-tick path.
`nthSetBit(mask, k)` walks the bits.

**Task 4 lands the guard before the hazard**: a `determinism.test.ts` rule banning `nextRandom(` and
`randomBelow(` anywhere in `sim/src` outside `rng.ts`, plus an `rng[0]`-invariance test that drives a
full multi-week run and asserts the word never changes — **both green at HEAD before the offer code
exists**. The rule's own `misses` self-test entries must be strings the regex genuinely does not
match; the previous draft's `'export function nextRandom(store, i)'` matches its own regex and turns
the meta-test red on the first run.

### 7. `H_OFFER_WEEK === H_WEEK` is the SINGLE mechanism for "one per week" AND "already chosen"

`H_OFFER_WEEK` holds the week whose offer has been **resolved**. Zero-initialised means 0, and week 0
has no offer, so the sentinel needs no write in `createState`.

- **Pending** iff `H_OFFER_WEEK !== H_WEEK && H_WEEK > 0`.
- `runOffer` raises an offer iff pending, and it is **idempotent**: the draw is a pure function of
  `(rng[0], week)`, so re-running it on every tick of the week writes the same two ids.
- `applyChooseCard` sets `H_OFFER_WEEK = H_WEEK`, which simultaneously ends the modal and blocks a
  second card this week.

**A second flag would be the catalogue's independently-sufficient-structures defect**: with both "an
offer exists" and "it has been taken", neither half can have a detector of its own.

**Three consequences, all stated rather than discovered.** A duplicate `choose-card` in the same
tick's batch is a **silent no-op**, not a throw. If two week boundaries pass with an offer pending
(only reachable from a Worker replaying a log that contains no choice), week `w+1`'s offer
**replaces** week `w`'s and week `w`'s card is lost — deterministic, and what "no bank, no skip"
means. And **`applyChooseCard` never clears `H_OFFER_A`/`H_OFFER_B`**, so every reader must go
through `offerSlot`, which folds `pending ? header[slot] : CARD_NONE`. A frame that read the header
directly would show last week's card forever.

### 8. The echo is the replay-divergence detector, and it is the only thing that throws

`enqueue('choose-card', slot, cardId)`: `a` is the slot, `b` is **the card id the client believes it
is taking**. `applyChooseCard` compares `b` against the slot's actual contents and **throws with the
diagnosis** on a mismatch. A mismatch can only happen if the draw is not a pure function of state.
**A Worker that hits it returns `unverifiable`** — never a score, and never apply-anyway.

Order inside `applyChooseCard` is load-bearing: **pending check first (silent no-op), slot validity
second (throw), echo third (throw).**

`sim` gains **no notion of pause**. Nothing in `packages/sim` knows a modal exists.

### 9. A short pool DEGRADES; nothing in `step` may throw over a configuration

**This is the review's C2 and it is fixed twice over, because one fix would have been a bet.**

The previous draft's `drawOfferPair` threw on a pool of fewer than two cards, `runOffer` called it
unconditionally, and `capabilityMask` made the roundabout's capability depend on **board state**
rather than on the map — so on the state golden's 4×4 fixture the pool fell to one card and `step`
threw **after** writing `H_EPOCH`, poisoning the buffer for the rest of the run. A throw inside
`step` over a map configuration is never acceptable.

1. **Capability is a property of the MAP, not of the board.** Dossier line 227: *"Pool is filtered by
   map capability: tunnels only on mountain maps, bridges absent on Mexico City,
   **roundabouts/lights/motorways everywhere**."* `capabilityMask` reads `world.terrain` and nothing
   else. Lights are capable on every map, unconditionally, so the pool always holds at least
   `{CARD_ROAD_TILES, CARD_JUNCTION_UPGRADE}`.
2. **And a short pool still degrades gracefully.** `runOffer` returns without raising when
   `popCountCards(pool) < 2`, and writes `H_OFFER_WEEK = H_WEEK` so nothing is left pending and the
   shell never pauses on an empty modal. `drawOfferPair` keeps its throw, because reaching it with a
   short pool is a programming error in `runOffer` and a plausible fallback would hide it — but
   `runOffer` is now structurally unable to.

Task 11 Step 1's non-emptiness guard must enumerate **every map any test drives past
`TICKS_PER_WEEK`** — `firstCity`, `demoCity`, `GOLDEN_MAP` (`determinism.test.ts:551`), the
demand-pin golden's 20×9 fixture, `allLandRows(20, 9)`, and Task 11's own `striped` fixture — not the
two shipped ones. The previous draft's guard iterated the two shipped maps, neither of which is a
fixture that drives `step` past a boundary.

### 10. The pause is raised on the CONDITION, not on the edge — and `loop.ts` is not touched

`loop.ts` reads `paused` **above** the `while`, so a pause raised from inside `advance` does not stop
the drain in progress: measured, a pause raised inside a clamped 250 ms drain still advances **7
ticks**. **This plan does not change that**, and the decision is made here rather than inside Task 7.

Three reasons. The 7 ticks are **invisible**: `loop.frame` renders once, after the drain. They are
**replay-safe**: `sim` has no pause concept and `runOffer` is idempotent. And re-checking `paused`
inside the `while` would only **defer** the burst — `setPaused(false)` resets `lastTime` and leaves
the accumulator, so the banked time drains after the modal closes instead of before it opens.

**The pause fires on the condition rather than the edge, and that is the opposite of `onGameOver`.**
Game over is terminal and must announce once, so `advance` reads `wasOver` before the step. An offer
is recurring and self-healing, so `advance` calls `deps.onOfferRaised()` whenever `offerPending(state)`
holds after the step, and `setPaused(true)` is already idempotent. **Any path that unpauses with an
offer still pending re-pauses on the next tick.**

**And a test of that property needs TWO frames, not one.** `setPaused(false)` sets `resetClock`, so
the next `frame(now)` assigns `L_LAST_TIME = now` before computing `rawDt`, `rawDt` is 0, and the
accumulator is untouched — the first frame after **any** resume runs zero ticks, `advance` is never
called, and `paused` stays false. The previous draft's one-frame re-pause test asserts something
`loop.ts` cannot do.

**Recorded, not fixed:** M1e measured that paused cars do **not** settle onto their sim positions —
they stop 0.09–0.22 cells short. Under a modal that lasts as long as the player takes to choose, that
frozen offset is visible for the first time. It is under `MAX_DRAW_LAG_CELLS` (0.2) at the top of its
range and about 6 CSS px at the smallest tile size. **State which reference frame that 0.09–0.22 was
measured against** when quoting it — it is the gap between the drawn position and the *sim* position
at the moment of the pause, not the tick-boundary divergence figure (0.9920 cells), which is a
different measurement on a different schedule.

### 11. Every headless rig that drives `game.frame` gets an explicit card policy, and the arms re-base

**This is the review's C3, and its second-order half is the expensive one.**

`main.ts` builds `createFrameDriver` and `createLoop` **inside `createGame`**, which every headless
rig boots. From Task 7, `onOfferRaised` pauses the loop, and `loop.ts` gates the whole drain on
`if (!paused)`. So every rig that drives `game.frame` past tick 4,500 freezes: `integration.test.ts`'s
`driveArm` throws *"5 frames ran no tick at all after 4500"*; `demoAllocation.test.ts` profiles a
**stopped board** for two of three windows while its allocation numbers still look fine, which is the
catalogue's *"a measurement instrument that reports clean while measuring nothing"*.

**The rule, and it is a property of how a rig drives, not of `createGame`:**

- **A rig that drives `step` directly needs no policy.** `sim` has no pause. The offer is raised,
  never resolved, replaced each boundary, and `H_TILES` grows by `WEEKLY_TILE_GRANT` alone. That is
  a well-defined no-input arm and **it is what `deathTicks.ts` measures**, which is why
  `CITY_DEATH_TICK` and `DEMO_DEATH_TICK` stay measurements of a genuinely no-input board.
- **A rig that drives `game.frame` past a boundary needs one**, stated at the rig with its reason.
  Task 7 Step 1 enumerates them by grep rather than by memory; the four already known are
  `integration.test.ts` (`buildRig`/`driveArm`), `demoAllocation.test.ts`, `drawAllocation.test.ts`
  and `allocation.test.ts`.

**The second-order effect, named so it is not discovered:** any policy that takes a card pays
`CARD_GRANT_*` **on top of** `WEEKLY_TILE_GRANT`, so the frame-driven "no-input" and "opening" arms
stop being no-input, and **every figure Tasks 1–4 pin on those arms is re-based at Task 7**. Task 7
Step 6 predicts and records the re-based figures, and **Task 4 Step 12's re-bless warrant must cite
the post-Task-7 numbers, not the Task-2 ones** — Step 12 is the behavioural warrant and Step 13 is the
digest re-measurement; the previous draft cited the wrong one — which is why that step asserts equality against
Task 3's recorded values by name rather than against a literal.

### 12. A junction upgrade is ONE cell, placed ON a junction, and that is why it can reach the jam

§5.6: *"Lights place only on an existing road **junction**, never plain road, and cost 0 tiles."*
§5.10 grants **2 items for 20 tiles**. **The upgrade inherits both rules unchanged** — Amendment 2
changed the effect and not the placement — so this decision is the one part of the relief object that
survived the swap verbatim.

`canPlaceUpgrade(state, world, cell)` refuses, in this order and with a named reason each:
`no-inventory`, `capacity` (`H_UPGRADE_COUNT === MAX_UPGRADES`), `off-board`, `not-a-junction`
(`!isJunctionCell`), `occupied` (`upgradeAt[cell] !== 0`). **That is the whole rule.** Every cell that
carries a junction refusal is a junction by definition, so the object's placement rule and the jam's
location are the same predicate — which is exactly the property the roundabout lacked.

**Measured, not assumed, and the measurement is uncomfortable.** Task 3 criterion 6 enumerates, for
every cell carrying ≥ 5 % of the run's **junction-caused** refusals, whether `canPlaceUpgrade` accepts
it in a window around each of the four week boundaries (4,500 / 9,000 / 13,500 / 18,000), and prints
the table. **The expected answer is not "yes at every tick" and it is not even "yes at some tick for
every cell":** of the six cells carrying the most refusals under arm B, **two — `(13,18)` at 19.5 %
and `(11,20)` — never reach road degree ≥ 3 on any tick of the run.** Spillback lands on degree ≤ 2
cells one hop downstream by construction, so a *total*-refusal ranking names cells the object can
never be placed on. **Ranking by junction-caused refusals is what makes the criterion satisfiable**,
and junctions carry **60.3 % (arm B) / 76.3 % (wide rule)** of all refusals, so the substance
survives the re-ranking. See Task 3 Step 3a, and trap 5.

§2.2's *"items sit unplaced indefinitely"* is what makes an early card survivable, and the criterion
measures how long a player must hold.

**An upgrade persists even if its cell stops being a junction.** If a player erases a road and the
degree drops to 2, the upgrade stays and keeps exempting. The alternative — silently going inert — is
a mechanism that stops working with no visible cause, which is this project's worst defect shape.
**And it must be INERT rather than FATAL in the degenerate case:** an upgrade on a cell whose roads
have *all* been erased has nothing to exempt, and `junctionAdmitsOne` answers `false` there with no
throw, no lookup and no candidate-axis search. **That is Decision 9 applied to this object** —
nothing in `step` may throw over a configuration a player can reach — and it is the rule that survived
the second review's C1 after the swap deleted C1's mechanism. Task 9 Step 3 tests both cases directly.

### 13. An upgrade LIFTS the mutual exclusion and changes NOTHING else

This decision replaces the previous draft's *"green means `greenLightsIgnoreCollisions`, amber means
closed, red means stop unless it is a right turn"*, which described a three-colour object that
Amendment 2 deleted.

The rule, in full:

| at an upgraded cell | rule |
|---|---|
| **entry** | the entrant's **own lane** must be free. The crossing check is skipped — **this is dossier §1.7's `greenLightsIgnoreCollisions` with no phase attached**, applied to every axis, always, and it is exactly the pre-M1f rule |
| **speed** | **`INTERSECTION_SPEED_MUL` still applies.** `isJunctionCell` is unchanged, so a car crossing an upgraded junction is still slowed. §5.6's *"skips the stop, not the intersection slowdown"* is honoured for the same reason it was under the light, by a different route |
| **the valve** | unchanged, and now **less used**: an upgrade admits cars the bare junction would refuse, so it reduces `carBlockedTicks` at that cell rather than adding to it |
| **routing** | unchanged and blind to it, per Task 1's amendment. `flowfield.ts` never reads `upgradeAt` and the structural scan in Task 1 Step 2 is extended to that name |
| **buildings** | `canPlaceHouse` and `canPlaceDestination` refuse an upgraded cell (Task 9 Step 9) |

**What is NOT here, and each absence is deliberate:** no phase, no timer, no amber, no red, no
per-axis anything, no right-on-red, no fifth `EnterOutcome`, and no per-tick work of any kind. The
whole rule is `if (state.upgradeAt[cell] !== 0) return false` inside `junctionAdmitsOne`. **A reader
who expects a `runUpgrades` phase should stop and re-read Amendment 2** — its absence is the
milestone's largest simplification and the thing most likely to be "fixed" back in by reflex.

### 14. The demand-actuated light is DEFERRED to M1g, and this is the record of why

The previous draft's Decision 14 was a table of seven datamined constants and a controller
specification. **It was built, measured, and rejected.** The numbers are in Amendment 2 and in the Out
table; this decision records what a reader needs in order not to re-litigate it, and what M1g needs in
order to try again.

**What was tried, in one sentence each:**

| variant | shipped seed, trips vs the 368 control | across 8 seeds |
|---|---|---|
| perfect relief (the junction rule exempted) | **750, +103.8 %** | wins 7/8, summed **+43.1 %** |
| fixed alternating green, 300 + 60 amber, 6 cells | **320, −13.0 %** — and that is the **best** of 30 seat phases; the median is 306, −17 % | one light wins **74/240** phase-seed pairs; all lights win **52/240** |
| the same, plus right-on-red | 315 | — |
| **this plan's own demand controller**, transcribed verbatim | **228, −38 %**, valve firings 16 against the control's 5 | wins **12/192** |
| `LIGHT_CHANGE_DELAY` 150 instead of 300 | best variant found anywhere is **353 — still below 368** | wins 92/192 (48 %), never past a coin flip |

**Why it failed, and the cause is a density mismatch rather than a bug.** The controller's gate is
`minimumNearbyCarsBeforeSwapping = 2` within `distanceToCountForNearbyCars = 2` tiles. On this board
there are about **eleven cars in flight**. Measured swaps per run across eight seeds: `1 0 0 6 4 5 0
11` — **on three of eight the light never changes phase at all**, latches on its opening axis, and
becomes a permanent closure released only by the 45 s valve. Its own red-light refusals measure
**16,490–19,536** against the **6,536** junction-caused refusals it exists to drain: **2.5–3.0×
against**, on the one channel that can be counted. And the seat phase — a parameter with no design
meaning at all — swings the result **1.19×–1.70×**, more than any positive effect measured, which
means the sign of the result is not a property of the design.

**The datamined constants are not wrong; they describe a denser game.** Ten seconds of hysteresis and
a two-car swap threshold are a sensible metering policy for a junction with a continuous queue on
every arm. They are the wrong policy for a junction that sees a car every few seconds.

**What M1g inherits, by name:** the numbers above; three levers (raise the board's car density until
the constants have something to meter; lower the swap threshold to 1, measured at swaps 13–80 per run
and m2 recovering 228 → 349 while still losing on 6 of 8 seeds; or make the light a *modifier on an
upgraded junction* rather than a replacement for the exclusion); `overtimeChangeDelay` with its
candidate mapping; `americanRedLightRules` and the three-rule decomposition of right-on-red, which
was correct work and is worth not re-deriving; and `CARD_TRAFFIC_LIGHTS`, declared and behind
`CARD_IMPLEMENTED_MASK`. **None of the seven `LIGHT_*` timing constants is declared in M1f** — a
constant with no caller reads as a supported configuration.

### 15. `MAX_UPGRADES` is a global cap of 24, derived, and the placement refuses at it

§5.10 grants 2 items per card. The longest death tick across the eight measured seeds is 51,275,
which is 11 whole weeks — so at most **22** upgrades can be granted on any run this project has
measured, and post-M1f runs are much shorter. `MAX_UPGRADES = 24` in `@laneways/shared`, with the
derivation at the site. It is a **global constant rather than a per-map layout size** because it is a
property of §5.10's grant rate and the week clock, not of the board; adding a `maxUpgrades` field to
`MapData` would fold into `mapIdHash` and move every golden a second time.

**Two corrections Amendment 2 forces, and the second is a finding rather than a tidy-up.**

1. **The cap no longer sizes anything.** Under the light it bounded a five-column table and
   `lightAt` held `slot + 1`, so `MAX_LIGHTS < 255` was a real constraint asserted in
   `constants.test.ts`. `upgradeAt` holds 0 or 1 and there is no table, so **the cap is a pure
   placement rule** and that assertion is deleted with the index it guarded.
2. **On the board that ships the cap is 3× larger than anything reachable, and that is worth saying
   out loud.** Only **four** week boundaries occur before death, so at most **8** upgrades can ever
   be granted — against a cap of 24. The derivation above comes from run lengths **Task 2 deletes**.
   The cap is kept anyway, because it is cheap, because it makes `applyPlaceUpgrade` refuse rather
   than silently drop, and because M1g may lengthen runs again; but **no task may cite it as a
   binding constraint**, and Task 12 Step 4 asserts `2 * maxBoundariesAcrossTheEightSeeds <=
   MAX_UPGRADES` on measured data so the derivation cannot rot into a claim.

`applyPlaceUpgrade` refuses with `'capacity'` at the cap rather than silently dropping, and
`H_INV_UPGRADES` is allowed to exceed it — the player can hold cards they cannot place, which §2.2
permits.

### 16. Peek hides the modal; it does not resume the sim

§5.10 gives the modal a peek button and no skip, no bank, no reroll and no timer. Peek is a
**`game`-side** boolean owned by `pointer.ts` beside `eraseMode` — it is UI, not simulation, and
putting it in the state buffer would make a cosmetic toggle a replay input.

While peeking: the modal chrome is not drawn, the board is, the loop stays **paused**, and board
input stays refused. Any tap returns to the modal. If peek resumed the sim it would be a free unpause
with no cost, which is the one thing a no-timer modal must not offer.

**`RenderFrame.offerPeek` and `PointerInput.peeking` are declared in the SAME task (Task 8).** The
previous draft declared the frame field in Task 7 and wired it from `pointer.peeking`, which Task 8
creates — a forward reference that does not compile.

### 17. Cross-package constants are pinned in `game`, and numbers cross the boundary as numbers

`packages/render/package.json` declares **no dependencies at all**, so `render/test` cannot import
`CARD_ROAD_TILES` or `CARD_COUNT` — the previous draft's render tests used both and would not have
resolved. And the sharper half: if the modal's *"30 ROAD TILES"* and *"+20 TILES"* are string
literals in `canvas.ts`, then changing `CARD_GRANT_ROAD_TILES` to 40 leaves every test in both
packages green while the modal lies to the player.

**Amendment 2 shrank this problem and the shrinkage is worth stating.** The previous draft needed a
third pin — `game` folding `lightAmberFor` into a two-value colour byte so `render` could tell green
from amber without importing `LIGHT_NO_PENDING`. **An upgrade has no colour**: `render` reads
`upgradeAt` as a **raw `Uint8Array` view**, exactly as it already reads `roads`, and draws a marker
on every non-zero cell in the pass it already makes over the board. No constant crosses the boundary
for the glyph, so there is no fold to get wrong and no pin to keep honest. What still crosses, and
still needs pinning, is the **card**: its label and its two grant numbers.

The repo already solved this for `TerrainClass` and pinned it in `packages/game/test/frame.test.ts`.
M1f follows that idiom exactly:

- `render` owns `CARD_LABELS` (a frozen module-scope array of card **names**, no numbers in them) and
  a render-side `CARD_LABEL_COUNT`. `canvas.test.ts` indexes it with bare integer literals and a
  comment naming the sim-side constant each stands for.
- **Every number in the modal arrives on the frame**: `offerGrantA`/`offerGrantB` (tiles, folded by
  `game` from `cardTileGrant`) and `offerItemsA`/`offerItemsB` (items, from `cardItemGrant`).
  `canvas.ts` formats them with the memoised number→string cache `scoreText`/`tilesText` already
  establishes, keyed on the number so a value change invalidates.
- **The pins live in `packages/game/test/frame.test.ts`**: `CARD_LABELS.length === CARD_COUNT`,
  `CARD_LABELS[CARD_ROAD_TILES] === 'ROAD TILES'`, and
  `CARD_LABELS[CARD_JUNCTION_UPGRADE] === 'JUNCTION UPGRADE'`. **`LIGHT_COLOUR_GREEN` and
  `LIGHT_COLOUR_AMBER` are deleted** — see above.
- `render/test/boundary.test.ts`'s `SCAN_ROOT` stays `render/src`, and Task 8 states why: the scan's
  one real catch is a raw relative path in shipped source, and a test file cannot ship. **But its
  vacuity guard pins the exact `render/src` file list**, so any new render module must be added to
  it in the same commit.

---

## File Structure

Two new source modules, both in `sim`, both small and single-purpose. Everything else is an edit to a
file that already owns the concept.

**Created**

| File | Responsibility |
|---|---|
| `packages/sim/src/cards.ts` | The card ids, the pool masks and their two filters, the non-consuming draw (`offerSeedFor`, `nthSetBit`, `pickFromPool`, `drawOfferPair`), `runOffer` (phase 4), `applyChooseCard`, `cardTileGrant`, `cardItemGrant`. **Nothing else may own the offer slots.** |
| `packages/sim/src/upgrades.ts` | `UpgradeRefusal`, `UpgradePlaceResult`, `isUpgraded`, `canPlaceUpgrade`, `applyPlaceUpgrade`. **Owns `upgradeAt` and nothing else, and is the only writer of it.** Reads `state.roads` through `isJunctionCell` and writes no other region. **No phase, no timer, no per-tick entry point** — Amendment 2 deleted `runLights` and everything under it. About sixty lines. |
| `packages/sim/test/cards.test.ts` | The draw, the pool, the echo, the one-per-week flag, the short-pool degradation, the pool's synthetic-mask arms. |
| `packages/sim/test/upgrades.test.ts` | The five placement refusals with a fixture each, placement's effects, persistence through an erase, the inert-not-fatal degenerate case, the entry rule's four-case table against `graph.test.ts`'s, and the head-on-restored derivation on Task 2's own deadlock fixture. |
| `packages/sim/test/m1fSplice.ts` | Task 4's re-bless proof: the **four** M1f byte ranges for a given map, with every structural assumption checked rather than assumed. |
| `packages/sim/test/m1fSplice.test.ts` | The splice's own guards, fed synthetic layouts. |
| `packages/game/test/junctionCensus.ts` | The census policy — the "two cars on one junction cell" definition — as one function shared by the two drivers that use it, on `cityArms.ts`'s precedent. |
| `packages/game/test/junctionArms.ts` | Task 3's three-arm rig, and the per-cell refusal tally every later task reads its jam cells from. |
| `packages/game/test/cardPolicy.ts` | Task 7's `takeCardPolicy`, the one policy every frame-driven rig uses to resolve the weekly offer. Four files need it and two copies of a policy drift. |
| `packages/game/test/upgradeSweep.ts` | Task 12's junction enumeration and per-placement scoring, shared between the sweep test and the report. |

**Modified**

| File | Change |
|---|---|
| `docs/superpowers/specs/2026-08-02-mini-motorways-clone-design.md` | Task 1's §5.4 amendment; Task 9's §5.6 amendment (the two dropped dossier rows) |
| `packages/shared/src/constants.ts` | `INTERSECTION_DEGREE` (moved in from `cars.ts`); `CARD_GRANT_ROAD_TILES`, `CARD_GRANT_ITEM`, `UPGRADES_PER_CARD`; `MAX_UPGRADES`; two corrections to `MAX_BLOCKED_TICKS`'s comment (Task 2); `ROUNDABOUT_SPEED_MUL` and `MOTORWAY_SPEED_MAX` re-dated to M1g (Task 1). **No `LIGHT_*` timing constant is declared** — Amendment 2, Decision 14 |
| `packages/sim/src/rng.ts` | `mixWord` extracted from `nextRandom`; byte-identical output |
| `packages/sim/src/graph.ts` | `isJunctionCell` and `junctionAdmitsOne` (Task 2); `junctionAdmitsOne`'s **one** upgrade clause (Task 9) |
| `packages/sim/src/scratch.ts` | `assertPushWithinBucketWindow` with both arms; the penalty note re-pointed to M1g |
| `packages/sim/src/flowfield.ts` | Calls the new assert inside the relaxation's push |
| `packages/sim/src/blocking.ts` | `canEnter`'s junction clause (Task 2) and, under arm B, `crossesAt`/`crossesDirections` (Task 3); the give-way and head-on paragraphs corrected. **Task 9 does not touch this file** — the upgrade's whole entry rule is one clause in `graph.ts`, and `EnterOutcome` gains no fifth code |
| `packages/sim/src/cars.ts` | `intersectionSpeedMul` reads `isJunctionCell`; `INTERSECTION_DEGREE` deleted. **`nextLegDir` is NOT exported** — it existed only for right-on-red, which Amendment 2 deleted, so this file changes in Task 2 and not again |
| `packages/sim/src/roads.ts` | `otherLane`, beside `LANE_OF_DIR` |
| `packages/sim/src/buildings.ts` | `canPlaceHouse` and `canPlaceDestination` refuse an upgraded cell (Task 9) |
| `packages/sim/src/state.ts` | Five header slots, `HEADER_LENGTH` 13 → 18, `offerPending`/`offerSlot` accessors, **one** name in `REGION_FIELD_NAMES` (29 → 30), `viewsOver`'s converse check |
| `packages/sim/src/regions.ts` | **One** region, `upgradeAt`; five FIELD_IRRELEVANT reasons re-dated; the new region classified FIELD_IRRELEVANT with its reason |
| `packages/sim/src/step.ts` | Phase 4 inserted and phases renumbered (Task 5) — **the only tick-order change**; two new action kinds dispatched (`choose-card`, Task 6; `upgrade`, Task 9). **No phase is appended** |
| `packages/sim/src/index.ts` | Exports the two new modules |
| `packages/render/src/types.ts` | `RenderFrame`'s new offer fields, `upgradeAt` (a raw view) and `upgradeMode`; `HudRects.upgrades`; `OfferRects`; `Palette`'s new colours |
| `packages/render/src/camera.ts` | `hudRects` gains the chip; `offerRects` |
| `packages/render/src/canvas.ts` | The upgrade marker; the inventory chip; the modal (a render phase, unrelated to `step`'s) |
| `packages/render/src/palette.ts` | The new colours |
| `packages/game/src/frame.ts` | Folds the new frame fields; `FrameDriverDeps.onOfferRaised` and `peeking` |
| `packages/game/src/pointer.ts` | Modal arbitration, peek, upgrade mode, five new outcomes |
| `packages/game/src/main.ts` | Wires `onOfferRaised`, the resume, the chip's count, the erase control's suspension |
| `packages/game/src/eraseControl.ts` | `suspend`/`resume`; a `retired` guard **added** to `press` |
| `packages/game/src/queueProbe.ts` | `carAheadOf`'s junction tie-break (**Task 2 only**). **Corrected:** the previous draft assigned this file a Task 9 change (*"its red-light answer"*) that no Task 9 step owned and Task 9's Modify list did not carry — the second review's I4(b). Amendment 2 deletes the red-light answer outright, and `carAheadOf` reads `junctionAdmitsOne`, so it tracks the upgrade with **no edit at all**. Task 9's only obligation here is to re-run Task 2's `canEnter`-agreement property on an upgraded board |
| `packages/game/test/deathTicks.ts` | `DEMO_DEATH_TICK` re-measured in Task 2 and again in Task 3; `CITY_DEATH_TICK` re-derived and documented as unmoved |

**Test files that must move for reasons other than their own subject** (named here so a task that
turns them red knows it was expected): `sim/test/determinism.test.ts` (the file list, the new RNG
rule, the state golden), `sim/test/state.test.ts` (`HEADER_LENGTH`), `sim/test/regions.test.ts`
(`totalBytes`, the ordered region list, the partition), `sim/test/loop.test.ts` (three golden
literals plus the cross-file literal scan), `sim/test/rollback.test.ts`, `sim/test/cars.test.ts`
(including *"movement cannot re-path, by signature"*, which pins `cars.ts`'s import lines and goes
red in **Task 2 only** — Amendment 2 deleted `nextLegDir`'s export, so `cars.ts` does not change
again), `sim/test/step.test.ts` (the `TickActionKind` line-anchored pin — **twice**, in Tasks 6 and
9), `sim/test/m1eSplice.ts`, `game/test/startingCity.test.ts`,
`game/test/demoLayout.test.ts`, `game/test/integration.test.ts`, `game/test/allocation.test.ts`,
`game/test/carSmoothing.test.ts`, `game/test/demoAllocation.test.ts`,
`game/test/drawAllocation.test.ts`, `game/test/queueProbe.test.ts`, `game/test/pointer.test.ts`,
`game/test/frame.test.ts`, `render/test/canvas.test.ts`, `render/test/camera.test.ts`.

---

## Task 1: The routing decision, ratified and ENFORCED — plus the census that dates the milestone

**Observability:** nothing. This task changes no behaviour at all and it says so out loud: it moves one constant between packages, amends a document, and adds tests and one assert that cannot fire on any state the game can reach today. **No golden moves.** If one does, stop and report.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-02-mini-motorways-clone-design.md:179`
- Modify: `packages/shared/src/constants.ts` (`INTERSECTION_DEGREE` in; `ROUNDABOUT_SPEED_MUL` / `MOTORWAY_SPEED_MAX` re-dated)
- Modify: `packages/sim/src/cars.ts:238` (delete the module-scope constant, import it)
- Modify: `packages/sim/src/scratch.ts` (the penalty note; `assertPushWithinBucketWindow`)
- Modify: `packages/sim/src/flowfield.ts` (call the assert in the push)
- Modify: `packages/sim/src/regions.ts` (re-date five reasons)
- Create: `packages/game/test/junctionCensus.ts`
- Test: `packages/sim/test/scratch.test.ts`, `packages/sim/test/flowfield.test.ts`, `packages/shared/test/constants.test.ts`, `packages/game/test/integration.test.ts`, `packages/game/test/startingCity.test.ts`

**Interfaces:**
- Produces: `INTERSECTION_DEGREE: number` (= 3) exported from `@laneways/shared`; `assertPushWithinBucketWindow(pushed: number, draining: number, buckets: number, maxEdge: number): void` exported from `packages/sim/src/scratch.ts`; `countJunctionConflicts(state: GameState, world: WorldData, prev: Int32Array, policy: number): number`, `CENSUS_CO_PRESENCE = 0`, `CENSUS_RULE_VISIBLE = 1` and `CENSUS_SLOTS_PER_CELL = 2` exported from `packages/game/test/junctionCensus.ts`. **Two policies, not one** — see Step 11.
- **Produces NO cell-set constant.** The previous draft's `JUNCTION_CENSUS_CELLS` had no consumer that survives this rewrite: Task 3 derives its jam cells from its own refusal tally and Task 9 derives its from the run it drives, so an exported list would be a stale literal with a reader.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Amend the spec, with provenance that survives a check**

Replace the tail of `docs/superpowers/specs/2026-08-02-mini-motorways-clone-design.md:179` — the clause reading `model intersection and traffic-light penalties as extra integer edge weight, which Dijkstra absorbs for free.` — with:

```markdown
coalesce dirty rebuilds to at most one per tick.

> **AMENDMENT, 2026-08-21 (M1f Task 1). Intersection, traffic-light and roundabout
> penalties are NOT edge weight.** The sentence that stood here said to model them
> as extra integer edge weight. It contradicts the research this spec is built on
> and it contradicts the shipped code, and the research is right.
>
> **Scope of this amendment, stated because the rest of the paragraph is sound.**
> The surrounding implementation constraints are verbatim from dossier 3.3 and are
> not touched. What is refused is the final clause alone.
>
> **The two lines that refute it.** Dossier 1.5, line 74: *"It is shortest by
> DISTANCE, NOT TIME — junctions, lights and roundabouts carry no path cost, which
> is exactly why players observe 'the game picks the shortest path but not the
> fastest'"*. And dossier 1.6, line 101, the verifier's own correction of the
> opposite inference: the lane-speed constants *"sit among pure driving-physics
> params, the source contains zero references to pathfinding … Time-weighted
> routing is a plausible hypothesis, NOT established."* Dossier 1.5 also closes
> with *"Do not add a congestion term to path cost. The omission is load-bearing:
> it makes the player the only rerouting mechanism, which is the entire game"* —
> quoted for the design intent, and noting that a STATIC junction surcharge is not
> a congestion term, so that sentence alone would not have settled this.
>
> **The rule, which supersedes the clause above:** path cost is a function of the
> DIRECTION of a step and of nothing else. `edgeCost(dir: number): number` is the
> whole cost model. Junction cost lives in MOVEMENT — `laneSpeedMul`, which scales
> a car's per-tick progress — and in ENTRY — `canEnter`, which refuses a crossing
> and, from M1f, obeys a traffic light. Neither is visible to Dijkstra,
> deliberately.
>
> **What it would cost to reverse this**, measured on the shipped board's greedy
> arm at M1f Task 2 under the WIDE rule (both lanes free at any degree-3 cell):
> junction exclusion produces 45,986 blocked car-ticks. The narrower CROSSING-ONLY
> rule that M1f Task 3 is predicted to ship measures 29,267 on the same arm. The
> arm is chosen two tasks after this amendment is written, which is why both
> numbers are here and why neither is quoted bare. Priced
> as edge weight instead, cars route around the junctions and the player never sees
> one, and every traffic light M1f ships is relieving a jam that no longer forms.
> The milestone would be correct, tested, deployed and invisible.
>
> This amendment is enforced rather than recorded: see `packages/sim/src/graph.ts`
> (`edgeCost`'s signature is pinned by a line-anchored scan), `packages/sim/src/scratch.ts`
> (`assertPushWithinBucketWindow`), and `packages/sim/test/flowfield.test.ts`
> (the congestion-blindness arms and the structural scan).
```

Note the line number: `179` is where it reads today. **Grep for the clause text rather than trusting the number.**

- [ ] **Step 2: Write the failing test for the pinned signature and the structural scan**

Add to `packages/sim/test/flowfield.test.ts`:

```ts
describe('the M1f amendment: path cost is a function of direction and nothing else', () => {
  const graphSrc = readFileSync(new URL('../src/graph.ts', import.meta.url), 'utf8')
  const flowfieldSrc = readFileSync(new URL('../src/flowfield.ts', import.meta.url), 'utf8')

  it('reads both sources back non-empty', () => {
    expect(graphSrc.length, 'graph.ts read back empty').toBeGreaterThan(4000)
    expect(flowfieldSrc.length, 'flowfield.ts read back empty').toBeGreaterThan(4000)
  })

  it("pins edgeCost's signature line, because a per-cell penalty changes the signature and not the value", () => {
    expect(
      graphSrc,
      'edgeCost no longer takes exactly one direction — see the 2026-08-21 amendment to spec 5.4',
    ).toMatch(/^export function edgeCost\(dir: number\): number \{$/m)
    expect(edgeCost.length, 'edgeCost arity').toBe(1)
  })

  // The behavioural arms below scramble every FIELD_IRRELEVANT region and cannot
  // see a penalty derived from `roads`, which is FIELD_INPUT. This is the half
  // that can: the names a junction or traffic-light penalty inside the pathfinder
  // would have to use.
  //
  // **The positive control is `graph.ts`, not `cars.ts`, and that is not
  // arbitrary.** M1f Task 2 replaces `intersectionSpeedMul`'s body with a call to
  // `isJunctionCell`, which deletes both `roadDegree` and `INTERSECTION_DEGREE`
  // from `cars.ts` — so a control anchored there would silently stop matching two
  // of the names and report green while guarding nothing. `graph.ts` DECLARES
  // `roadDegree`, `isJunctionCell` and `junctionAdmitsOne` and IMPORTS
  // `INTERSECTION_DEGREE`, permanently.
  const PENALTY_NAMES = ['roadDegree', 'INTERSECTION_DEGREE']

  const nameRe = (n: string): RegExp => new RegExp(`\\b${n}\\b`)

  for (const name of PENALTY_NAMES) {
    it(`flowfield.ts does not mention ${name}`, () => {
      expect(
        flowfieldSrc,
        `flowfield.ts now uses ${name} — a junction penalty inside computeFlowField keeps ` +
          'assertBucketCountExceedsEveryEdgeCost green while Dial aliases two distances into one ' +
          'bucket. See the 2026-08-21 amendment to spec 5.4 and scratch.ts NB.',
      ).not.toMatch(nameRe(name))
    })
  }

  it('every pattern matches something in graph.ts, so the guards above can fail', () => {
    for (const name of PENALTY_NAMES) {
      expect(
        graphSrc,
        `the ${name} pattern matches nothing in graph.ts — the guard cannot fail`,
      ).toMatch(nameRe(name))
    }
  })
})
```

- [ ] **Step 3: Run it and confirm it passes at HEAD**

Run: `pnpm --filter @laneways/sim test -- flowfield`
Expected: **PASS.** Both names already exist in `graph.ts` (`roadDegree` is declared there;
`INTERSECTION_DEGREE` arrives in Step 5 — so **run this step again after Step 5** and record both
results). Before Step 5 the `INTERSECTION_DEGREE` control is red; that is the correct first failure
and it proves the control is doing its job.

Then prove the guards' teeth: temporarily add `roadDegree(state, cell)` to a line inside
`computeFlowField`, re-run, watch the scan go red, and revert. Commit first; chain the restore and
its report in one `&&`.

- [ ] **Step 4: Move `INTERSECTION_DEGREE` into `@laneways/shared`**

Delete `packages/sim/src/cars.ts:238`'s `const INTERSECTION_DEGREE = 3` and add to `packages/shared/src/constants.ts`, beside the lane-speed block:

```ts
/**
 * The road degree at which a cell counts as an INTERSECTION — a third road
 * meets there. Degree 2 is a corridor cell, 1 a dead end, 0 bare ground.
 *
 * **Moved out of `sim/src/cars.ts` module scope at M1f Task 1, because it
 * acquired a second reader.** M1d used it in exactly one place, to select spec
 * §5.5's *"approaching an intersection"* speed multiplier. M1f gives the same
 * threshold two more jobs — `canEnter`'s mutual exclusion and the junction
 * upgrade's placement rule (§5.6: *"place only on an existing road junction,
 * never plain road"*) — and a private constant with three conceptual readers is a copy
 * waiting to happen. All three now go through `graph.ts`'s `isJunctionCell`.
 *
 * **It is NOT an edge weight and must never become one** — see the 2026-08-21
 * amendment to spec §5.4. `flowfield.test.ts` scans `flowfield.ts` for this
 * name for exactly that reason, with `graph.ts` as its positive control.
 */
export const INTERSECTION_DEGREE = 3
```

Add `INTERSECTION_DEGREE` to `cars.ts`'s existing `@laneways/shared` import list, and to `graph.ts`'s.

**And re-date two constants in the same block.** `ROUNDABOUT_SPEED_MUL` and `MOTORWAY_SPEED_MAX` are both still uncalled and their shared doc comment names **M1f** as the milestone that gives them callers. Correct it:

```
 * **`ROUNDABOUT_SPEED_MUL` and `MOTORWAY_SPEED_MAX` are still uncalled, and the
 * date moves from M1f to M1g for two different reasons.** The motorway was never
 * in M1f's scope. The roundabout WAS, and it was removed after measurement: on the
 * shipped board, five of the six cells that actually jam admit ZERO legal 3x3
 * centres at every tick of the run, and the sixth admits one — the cell measured
 * as worth exactly zero. The greedy connector merges approaches at carparks and
 * houses, so degree-3 cells form against buildings by construction, and spec 5.6
 * requires a roundabout's centre plus all eight neighbours to be clear of them.
 * M1f ships a single-cell JUNCTION UPGRADE instead, which places on one junction cell and
 * therefore cannot fail to reach the jam. M1g owns the roundabout's geometry
 * question; see the M1f plan's Out table for the four options.
```

- [ ] **Step 5: Add it to the shared registry test and run both packages**

`packages/shared/test/constants.test.ts` has an `ALL` registry that every exported constant must appear in. Add `INTERSECTION_DEGREE` with an exact-value assertion:

```ts
    expect(INTERSECTION_DEGREE, 'a third road meeting is what makes a cell a junction').toBe(3)
```

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS everywhere. `cars.test.ts`'s junction fixtures still pass unchanged — the value did not move, only its home. **Note whether `cars.test.ts > movement cannot re-path, by signature` moved**: it pins `cars.ts`'s import lines, and adding one name to the `@laneways/shared` import may touch it. If it does, re-derive it here rather than in Task 2, and record that Task 2's expected-failure list is one shorter.

Then re-run Step 2's suite: the `INTERSECTION_DEGREE` control now matches in `graph.ts`.

- [ ] **Step 6: Write the failing test for the bucket-window assert, BOTH arms**

Add to `packages/sim/test/scratch.test.ts`:

```ts
describe('assertPushWithinBucketWindow — trap 2, converted from wrong paths into a named throw', () => {
  it('accepts every real edge cost', () => {
    for (let k = 0; k < DIR_COUNT; k++) {
      expect(() => assertPushWithinBucketWindow(1000 + edgeCost(k), 1000, NB, DIAG_COST)).not.toThrow()
    }
  })

  it('accepts a push exactly at the maximum legal edge cost', () => {
    expect(() => assertPushWithinBucketWindow(100 + DIAG_COST, 100, NB, DIAG_COST)).not.toThrow()
  })

  it('THE ARM THE PREVIOUS DRAFT DID NOT HAVE: throws on the SMALLEST possible added term', () => {
    // A junction surcharge of +1 on a diagonal is `d + 15`. Under a single
    // aliasing bound of `delta <= NB` that is ACCEPTED, because NB is 15 — so the
    // guard would have been silent on precisely the mutation it exists to catch.
    expect(() => assertPushWithinBucketWindow(100 + DIAG_COST + 1, 100, NB, DIAG_COST)).toThrow(
      /is not a legal edge cost.*max 14/s,
    )
  })

  it('throws with the ALIASING message when the gap also exceeds the modulus', () => {
    expect(() => assertPushWithinBucketWindow(100 + NB + 1, 100, NB, NB + 8)).toThrow(
      /aliases into the bucket drained at 101.*NB=15/s,
    )
  })

  it('accepts a push exactly NB above the draining distance, which lands in the freshly-detached bucket', () => {
    // Kept as a separate case from the edge-cost arm: it is a statement about
    // Dial's queue, not about the cost model, and the two bounds are independent.
    expect(() => assertPushWithinBucketWindow(100 + NB, 100, NB, NB)).not.toThrow()
  })

  it('throws for a push BELOW the draining distance, which is a monotonicity violation', () => {
    expect(() => assertPushWithinBucketWindow(99, 100, NB, DIAG_COST)).toThrow(
      /below the distance being drained/,
    )
  })
})
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @laneways/sim test -- scratch`
Expected: FAIL with "assertPushWithinBucketWindow is not defined".

- [ ] **Step 8: Implement the assert and call it from the relaxation**

Add to `packages/sim/src/scratch.ts`, below `NB`:

```ts
/**
 * Throws if a relaxation would push a distance the cost model or Dial's cyclic
 * queue cannot represent from the bucket currently draining.
 *
 * **This is the mechanism for the trap `NB`'s note above describes and could
 * not close.** `assertBucketCountExceedsEveryEdgeCost` inspects only
 * `edgeCost(k)`, so a penalty applied INSIDE `computeFlowField` — a per-cell
 * term read off `roads`, a junction surcharge, a traffic-light delay — leaves it
 * green while the queue silently aliases two distances into one bucket. Measured
 * at modulus 13: 31 detectors, all of which read like a routing regression
 * rather than a queue bug, because the drain loop's staleness check DISCARDS the
 * aliased entry.
 *
 * **TWO bounds, because one is not enough and the difference is the whole
 * point.** The aliasing bound is `delta <= buckets`; the legality bound is
 * `delta <= maxEdge`. On the shipped constants `NB` is 15 and `DIAG_COST` is 14,
 * so a surcharge of `+1` on a diagonal — the SMALLEST edit that could introduce
 * one — produces `delta = 15`, which the aliasing bound accepts. A guard silent
 * on the minimal instance of the thing it guards is decoration. The aliasing arm
 * stays because it is a true and separate statement about the queue: at
 * `delta = buckets` the entry lands in a bucket `computeFlowField` has already
 * detached (`bucketHead[b] = -1`) and drains on its next visit, which is exactly
 * why `NB = DIAG_COST + 1` rather than `DIAG_COST` — measured, at 14 the drain
 * loop does not terminate if that detach moves after the walk, and at 15 it is a
 * no-op.
 *
 * Parameterised rather than closing over `NB` and `DIAG_COST`, on the precedent
 * of `assertBucketCountExceedsEveryEdgeCost`, `assertSingleCrossing` (cars.ts)
 * and `assertDispatchProgress` (dispatch.ts): the failure path is then testable
 * directly, without editing a constant and rebuilding.
 *
 * Unreachable today, by construction: the only pushes are `d + edgeCost(dir)`
 * and `max(edgeCost) = DIAG_COST`. It is reachable the moment anybody adds a
 * term, which is the point.
 *
 * @internal `computeFlowField` is the production call site.
 */
export function assertPushWithinBucketWindow(
  pushed: number,
  draining: number,
  buckets: number,
  maxEdge: number,
): void {
  const delta = pushed - draining
  if (delta < 0) {
    throw new Error(
      `scratch: a relaxation pushed distance ${pushed}, below the distance being drained (${draining}) — ` +
        'Dijkstra over non-negative weights cannot do that, so this is a negative or corrupted edge cost',
    )
  }
  if (delta > buckets) {
    throw new Error(
      `scratch: a relaxation pushed distance ${pushed} while draining ${draining}, a gap of ${delta} ` +
        `against NB=${buckets} — it aliases into the bucket drained at ${draining + (delta % buckets)}, ` +
        'where the staleness check discards it: wrong paths, no crash. An edge cost above NB - 1 needs ' +
        'NB resized (see NB, and the 2026-08-21 amendment to spec 5.4)',
    )
  }
  if (delta > maxEdge) {
    throw new Error(
      `scratch: a relaxation advanced the distance by ${delta}, which is not a legal edge cost ` +
        `(max ${maxEdge}). Path cost is a function of the DIRECTION of a step and of nothing else — ` +
        'a junction, traffic-light or congestion term inside computeFlowField is exactly what this ' +
        'catches. See the 2026-08-21 amendment to spec 5.4.',
    )
  }
}
```

In `packages/sim/src/flowfield.ts`, in `computeFlowField`'s relaxation, immediately before the push that writes the new distance, add:

```ts
      assertPushWithinBucketWindow(nd, d, NB, DIAG_COST)
```

using the local names the loop already has for the candidate distance and the draining distance. **Do not rename them to match this snippet** — read the loop and use its own identifiers, and if it has no local for the draining distance, hoist one rather than recomputing it. Import `DIAG_COST` from `@laneways/shared`.

- [ ] **Step 9: Run the sim suite and confirm the field golden did not move**

Run: `pnpm --filter @laneways/sim test`
Expected: PASS, including `252514232`. Three comparisons per push change no distance.

- [ ] **Step 10: Re-date the five FIELD_IRRELEVANT reasons and the `scratch.ts` predictions**

In `packages/sim/src/regions.ts`, the five reasons dated *"M1f's demand-actuated lights"* (`carCell`, `occupancy`, `carBlockedTicks`, `ghostMask`, `ghostCommitted`) gain:

```
 * **M1f is the milestone these five reasons were dated against, and not one of
 * them became a field input — for a reason STRONGER than the one they
 * anticipated.** They were dated "M1f's demand-actuated lights" and were
 * conditional: "IF they price waiting as an edge weight". Two things happened.
 * First, M1f answered the condition in the negative, in writing, in the spec:
 * junction, traffic-light and roundabout cost is NOT edge weight (amendment,
 * 2026-08-21). Second, **M1f did not ship a demand-actuated light at all** — it
 * measured one and deferred it (amendment to spec 5.6, 2026-08-21), shipping a
 * JUNCTION UPGRADE instead: a flag that changes a car's RIGHT TO ENTER a cell,
 * with the cell's SPEED unchanged and the distance of a step never touched. So
 * the five reasons outlived both the object they named and the condition they
 * set.
 *
 * **Three of the five are no longer resting on this comment.** `carCell`,
 * `occupancy` and `carBlockedTicks` are pinned by `flowfield.test.ts`'s derived
 * arm, which scrambles EVERY region this list names and requires byte-identical
 * `dist`/`dir` and an unmoved `CT_REBUILDS` — so the classification is a failing
 * assertion rather than a sentence.
 *
 * The date moves to M1g because the two things that could still argue with it
 * are the motorway's divide-by-three tier, which changes `edgeCost`'s VALUE SET
 * rather than adding a per-cell term, and the demand-actuated light M1f deferred,
 * if it returns and prices waiting — and either would have to beat the amendment
 * first.
```

In `packages/sim/src/scratch.ts`, `NB`'s note and `DISTINCT_EDGE_COSTS`'s note both predict M1f's motorway tier. **M1f ships no motorway.** Re-point both to M1g, and add to `NB`'s note:

```
 * **Third wrong prediction, and this one is worth counting.** This comment has
 * now named M1d, M1e and M1f as the milestone that would exceed NB, and none of
 * them did. The reason is structural rather than lucky and it is now written
 * down in the spec: junction and traffic-light cost is not edge weight
 * (amendment, 2026-08-21), so the only thing that can change the VALUE SET is a
 * tier on the step itself — the motorway's divide-by-three. Until a motorway
 * ships, `DISTINCT_EDGE_COSTS` is 2 and the set is {10, 14}. M1f Task 1 also
 * added `assertPushWithinBucketWindow`, whose SECOND arm catches an added term of
 * +1 that the modulus bound alone would accept, so a fourth wrong prediction is
 * a throw rather than a wrong path.
```

- [ ] **Step 11: Write the junction census, TWO policies, shared by two drivers, with both definitions pinned**

**Read this before writing the file.** The previous draft shipped one policy, dated the milestone off
it, and got the direction of its own correction backwards. Both figures below are real, both
reproduce, and they measure different events — see *"When the board actually diverges"* in this
plan's opening. **The milestone is dated off the RULE-VISIBLE policy. The co-presence policy is kept
as a second instrument with its blindness written beside it, not deleted.**

Create `packages/game/test/junctionCensus.ts`:

```ts
import { INTERSECTION_DEGREE, LANE_COUNT } from '@laneways/shared'
import { FREE, occupancySlot, roadDegree, type GameState, type WorldData } from '@laneways/sim'

/**
 * **The census this milestone is dated from, as ONE module with TWO named
 * policies, shared by every driver that measures it**, on `cityArms.ts`'s
 * precedent: two drivers agreeing is evidence, one driver run twice is not.
 *
 * **WHY TWO.** The two policies answer two different questions and the previous
 * draft conflated them, dated the milestone off the wrong one, and then wrote a
 * correction that was 74 seconds out IN THE WRONG DIRECTION.
 *
 * - `CENSUS_CO_PRESENCE` asks *"were two different cars ever standing on one
 *   junction cell at the end of a tick?"* Answer on the greedy arm: **232
 *   events, first at tick 15,001, six cells.** It is a true statement about the
 *   board and it is **STRUCTURALLY BLIND TO A SAME-TICK SWAP**: when two cars
 *   exchange cells across an edge, the junction holds one car at the start of the
 *   tick and a different car at the end, never two at once. A swap across an edge
 *   with a junction at its end is exactly the case Decision 2 names as producing
 *   the genuine 2-cycles M1f Task 2 creates, so this policy cannot see the first
 *   thing the rule changes.
 * - `CENSUS_RULE_VISIBLE` asks *"did anything happen on a junction cell that
 *   Task 2's mutual exclusion is about?"* — which additionally counts an
 *   OCCUPANT CHANGE WITHIN A TICK: a junction cell holding car `a` at the end of
 *   tick `t - 1` and a different car `b` at the end of tick `t`, with the cell
 *   never observed empty between them. Answer on the greedy arm: **271 events,
 *   first at tick 12,780, five cells.** At tick 12,780 cars 8 and 9 swap across
 *   `(14,17)`; this policy sees it and the other does not.
 *
 * `15,001 - 12,780 = 2,221` ticks = **74.0 s**, and the board therefore diverges
 * 74 s EARLIER than the co-presence reading says, not later.
 *
 * **Both counts are values to REPRODUCE, and reproducing one is not
 * reproduction.** They were measured by a review's rig rather than by this
 * project's. `CENSUS_RULE_VISIBLE`'s count is specified here by its EVENT rather
 * than derived from first principles, because whether a given swap would actually
 * have been refused depends on car index order inside `runMovement`, which a
 * between-ticks sampler cannot observe. **If the extended policy reproduces 232
 * and not 271, that IS the finding**: record the measured number with this
 * definition beside it, mark 271 superseded in the task report, and DO NOT adjust
 * the definition until it reaches 271. Tuning an instrument toward a number is
 * the defect this whole section exists to prevent.
 *
 * **Read off `state.occupancy` and `state.roads`, never reconstructed.** The
 * queue probe's 5.7-15.2 % disagreement rate came from rebuilding a key the
 * system already stores.
 *
 * `prev` is caller-owned, `CENSUS_SLOTS_PER_CELL` entries per cell, and carries
 * the previous tick's occupancy across calls so the edges are detected with no
 * allocation. **Both policies share one `prev`**, so a driver may run both in one
 * pass over one buffer and the two counts are guaranteed to be about the same
 * run.
 */
export const CENSUS_CO_PRESENCE = 0
export const CENSUS_RULE_VISIBLE = 1

/** Two lanes' occupants, per cell. Both policies read the same two slots. */
export const CENSUS_SLOTS_PER_CELL = 2

export function countJunctionConflicts(
  state: GameState,
  world: WorldData,
  prev: Int32Array,
  policy: number,
): number {
  let rising = 0
  for (let cell = 0; cell < world.cells; cell++) {
    let lane0 = FREE
    let lane1 = FREE
    const isJunction = roadDegree(state, cell) >= INTERSECTION_DEGREE
    if (isJunction) {
      lane0 = state.occupancy[occupancySlot(cell, 0)] as number
      lane1 = state.occupancy[occupancySlot(cell, LANE_COUNT - 1)] as number
    }
    const i = cell * CENSUS_SLOTS_PER_CELL
    const was0 = prev[i] as number
    const was1 = prev[i + 1] as number

    if (policy === CENSUS_CO_PRESENCE) {
      // The ORIGINAL definition, unchanged: one rising edge per
      // (cell, lane-0 car, lane-1 car) ORDERED TRIPLE. A pair sitting together
      // for k ticks is one conflict that lasted; a cell whose lane-0 occupant
      // changes while lane 1 stands still is a NEW conflict, because it is a new
      // pair of cars that would have crossed.
      const both = lane0 !== FREE && lane1 !== FREE && lane0 !== lane1
      if (both && (was0 !== lane0 || was1 !== lane1)) rising++
    } else {
      // RULE-VISIBLE. Co-presence, PLUS the swap the other policy cannot see: a
      // junction cell that held a car last tick and holds a DIFFERENT car this
      // tick, on either lane, having never been observed empty in between. That
      // is one tick in which two distinct cars both had business inside one
      // junction cell, which is what mutual exclusion is about.
      const both = lane0 !== FREE && lane1 !== FREE && lane0 !== lane1
      const swapped =
        (was0 !== FREE && lane0 !== FREE && was0 !== lane0) ||
        (was1 !== FREE && lane1 !== FREE && was1 !== lane1) ||
        (was0 !== FREE && lane1 !== FREE && was0 !== lane1 && lane0 === FREE) ||
        (was1 !== FREE && lane0 !== FREE && was1 !== lane0 && lane1 === FREE)
      if (isJunction && (swapped || (both && (was0 !== lane0 || was1 !== lane1)))) rising++
    }

    prev[i] = lane0
    prev[i + 1] = lane1
  }
  return rising
}
```

**The four `swapped` disjuncts are four editable sites and therefore need four detectors** — the
project's coverage rule, applied. Step 14's table has one mutant per disjunct; if any of them scores
0 on this board, record it with the reason and say which crossing geometry the board never produces,
rather than deleting the disjunct.

- [ ] **Step 12: Land BOTH censuses in `driveArm`, on the production boot, and in the hand driver**

`integration.test.ts`'s `driveArm` already samples per tick. Extend that block with **both** censuses
— two `prev` buffers, two counters, one pass each — extend `ArmRun` with `conflicts`,
`firstConflictTick`, `conflictCells`, `ruleEvents`, `firstRuleEventTick` and `ruleEventCells`
(each cell list built from a local `Int32Array` tally, sorted descending by count and reported with
the counts), and assert them in the existing greedy-arm `describe` **beside** the pins that are
already there:

```ts
    // BOTH censuses, measured on the SAME run as every other figure in this
    // block. Their vacuity guard is their neighbours: `r.deathTick`, `r.trips`
    // and the seven week rows are pinned three lines above, so this test adds no
    // second copy of them.
    //
    // The milestone is dated off the RULE-VISIBLE pair. The co-presence pair is
    // asserted too, because it is the figure every earlier artefact quotes and
    // because a change in either one, alone, is a finding.
    expect(r.ruleEvents, 'junction events the Task 2 rule is about').toBe(271)
    expect(r.firstRuleEventTick, 'the first one — 6:57.4 on a stopwatch, (12780 - 258) / 30').toBe(12780)
    expect(r.ruleEventCells.length, 'distinct cells that ever carried one').toBe(5)

    expect(r.conflicts, 'co-presence conflicts — blind to same-tick swaps').toBe(232)
    expect(r.firstConflictTick, '8:11.4, and 74.0 s LATER than the rule-visible first').toBe(15001)
    expect(r.conflictCells.length).toBe(6)

    // The relationship between the two, asserted rather than left to a comment,
    // because it is the thing the previous draft got backwards:
    expect(r.firstRuleEventTick, 'the rule diverges EARLIER than co-presence, not later')
      .toBeLessThan(r.firstConflictTick)
```

Then add the **second driver**: `startingCity.test.ts` drives `step` by hand with the same
`cityArms.ts` policy. Run both censuses there and assert the two drivers agree. **Two policies, two
drivers.**

**These six figures are values to REPRODUCE, and they were measured by a review's rig rather than by
this project's.** The reproduce-or-report protocol is stated here in the form that can actually fire:

> **Reproducing 232 / 15,001 / six is NOT reproduction.** The previous draft asked only for those
> three, and an implementer using the previous draft's single policy reproduces them exactly, the
> protocol stays silent, and a sentence that is 74 s wrong in the wrong direction survives into a
> spec amendment. **All six must reproduce, or the disagreement is the finding**: record the measured
> numbers with both definitions beside them, mark the superseded figure in the task report, and do
> not adjust either definition to reach a number.

Record the per-cell tables too — the review's run gave co-presence
`(12,19)=73 (9,22)=52 (14,17)=49 (8,23)=49 (8,11)=6 (8,21)=3` — because Task 3 cross-checks its
refusal distribution against it. Record the rule-visible table beside it and **state whether the two
name the same cells**; the review's run gave **five** cells for the rule-visible policy against six
for co-presence, so at least one cell differs and the difference is information.

- [ ] **Step 13: Run it**

Run: `pnpm --filter @laneways/game test -- integration startingCity`
Expected: PASS with 271 / 12,780 / 5 **and** 232 / 15,001 / 6, or a reported disagreement, and the
two drivers agreeing on both.

- [ ] **Step 14: Mutation-test this task's tests**

Apply each mutant alone, run the canonical invocation, record detectors as **assertion failures naming the behaviour**, screen non-vitest-result lines for error classes, and check per-package totals are unchanged. Commit first; chain the restore and its report in one `&&`.

| # | Mutant | Expected |
|---|---|---|
| 1 | `assertPushWithinBucketWindow`: `delta > buckets` → `delta >= buckets` | ≥ 1, in *"exactly NB above"* |
| 2 | `assertPushWithinBucketWindow`: delete the `delta > maxEdge` arm | ≥ 1, in *"the smallest possible added term"* — **and if this is 0 the second arm is not being tested and the whole point of it is lost** |
| 3 | `assertPushWithinBucketWindow`: delete the `delta < 0` arm | ≥ 1, in the monotonicity test |
| 4 | `flowfield.ts`: delete the `assertPushWithinBucketWindow` call | **0 expected, and that is the correct answer** — the assert is unreachable on every state the game can reach. Record it as a deliberately unreachable guard in the same register as `assertSingleCrossing`, and **do not manufacture a detector by weakening `NB`** |
| 5 | `INTERSECTION_DEGREE` 3 → 4 | ≥ 1, in `cars.test.ts`'s junction fixture and in `constants.test.ts` |
| 6 | The scan: `not.toMatch` → `toMatch` on one name | ≥ 1. **Do NOT mutate by shortening `PENALTY_NAMES`** — that drops the name from the control too, so the honest answer is 0 and it is not evidence |
| 7 | `countJunctionConflicts`: `lane0 !== lane1` → `true` | ≥ 1, in the co-presence assertion |
| 8 | `countJunctionConflicts`: drop the rising-edge test (count every tick) | ≥ 1 — both totals inflate |
| 9 | `countJunctionConflicts`: co-presence compares only `prev[i] !== lane0` | ≥ 1 if a lane-1 change ever occurs alone; **if 0, record it with the reason and note that the pair definition is then indistinguishable from the lane-0 one on this board**, which is a finding about the board, not a coverage hole |
| 10 | `countJunctionConflicts`: `>= INTERSECTION_DEGREE` → `>= 2` | ≥ 1, in both assertions |
| 11 | `countJunctionConflicts`: **delete the whole `swapped` term** — i.e. make `CENSUS_RULE_VISIBLE` identical to `CENSUS_CO_PRESENCE` | **≥ 1, and this is the most important row in the table.** It must fail on **271 AND on 12,780 AND on the five-vs-six cell count**. This is the exact defect the previous draft shipped, and a mutant that reproduces it must not survive |
| 12–15 | `countJunctionConflicts`: delete each of the four `swapped` disjuncts, one at a time | ≥ 1 each is the hope. **Record each 0 with the crossing geometry this board never produces**, and do not delete a disjunct that scores 0 — the four are the four ways an occupant can change within a tick and dropping one makes the instrument silently narrower on a board that happens not to exercise it |
| 16 | `countJunctionConflicts`: ignore `policy` and always run co-presence | ≥ 1, same set as #11 |

- [ ] **Step 15: Commit**

```bash
git add docs/superpowers/specs packages/shared packages/sim packages/game
git commit -m "feat(sim): junction and traffic-light cost is not edge weight, ratified and interlocked

Spec 5.4's 'model intersection and traffic-light penalties as extra integer edge
weight' is amended. The refutation is dossier line 74 (shortest by distance, not
time - junctions, lights and roundabouts carry no path cost) and dossier line 101
(the verifier's own correction: time-weighted routing is not established). The
amendment scopes itself to that one clause, because the rest of the paragraph is
dossier 3.3 verbatim. It quotes BOTH junction-rule arms, because the arm is not
chosen until Task 3 and a permanent document must not carry an arm-specific
figure as if it were settled.

Enforced rather than recorded: edgeCost's signature line is pinned, flowfield.ts
is scanned for the names a junction penalty would need with graph.ts as the
positive control (NOT cars.ts, which loses two of them in the next task), and
assertPushWithinBucketWindow converts Dial's aliasing into a named throw. It has
TWO arms: the modulus bound alone accepts a surcharge of +1 on a diagonal, which
is the smallest edit it exists to catch.

INTERSECTION_DEGREE moves to @laneways/shared: it acquires two more readers in
the next tasks, one of them the junction upgrade's placement rule.
ROUNDABOUT_SPEED_MUL and MOTORWAY_SPEED_MAX are re-dated to M1g, the first with
the measurement that removed the roundabout from this milestone.

The junction census lands as a test on the production boot and on the hand
driver, with TWO named policies rather than one. Rule-visible: 271 events, first
at tick 12,780 (6:57.4), five cells - this is what dates the milestone.
Co-presence: 232, first at 15,001 (8:11.4), six cells - kept as a second
instrument and documented as structurally blind to a same-tick swap, which is
precisely the event at 12,780. The board therefore diverges 74.0 s EARLIER than
the co-presence reading says; the previous plan had that sentence backwards.

No golden moves. No behaviour changes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8"
```

---

## Task 2: Junction mutual exclusion in `canEnter` — the wait this project shipped the ceiling for

**Read trap 3 before starting.** This task makes every gate worse. Under the **wide** rule it lands: 2,120 → 45,986 blocked car-ticks, 17:19.9 → 11:54, 747 → 344 trips, valve firings 0 → 15, at least 20 `game` tests moved. Under **arm B**, which Task 3 is predicted to ship: 2,120 → 29,267, 17:19.9 → 11:57.5, 747 → 368, valve firings 0 → 5. **Quote the arm with every figure.** That is the size of the bug being fixed, not a regression, and it is measured at **379 trips**. The thing that closes it is Task 9 — and unlike the previous draft, this plan knows it closes it: a junction upgrade at the census conflict cells reproduces the pre-M1f board to the digit (Amendment 2).

**Observability:** **the first traffic jam this game has ever shown on the board that ships.** **Before tick 12,780 — 6:57.4 on a stopwatch — the board is bit-identical to today**, same cars, same trips, same everything, and that is by construction: 12,780 is the first tick on which Task 1's rule-visible census fires. **The first divergence is invisible** — one swap across `(14,17)` resolves differently. **The first tick a person can SEE is 16,337, 8:56.0**, when three cars are stopped at once for the first time; from there queues stand at a handful of specific cells instead of cars driving through each other, and the anti-deadlock valve fires for the first time outside a purpose-built fixture. **Correcting the previous draft, which said the board was unchanged until 8:11 and that nobody should look for a difference in the first eight minutes:** by 8:00 the board has already diverged for **63 seconds**. The honest sentence is *nothing changes before minute seven, and nothing is visible before nine*. See *"When the board actually diverges"* in this plan's opening for both instruments and why they differ by 74.0 s.

**Files:**
- Modify: `packages/sim/src/graph.ts` (`isJunctionCell`, `junctionAdmitsOne`)
- Modify: `packages/sim/src/roads.ts` (`otherLane`, beside `LANE_OF_DIR`)
- Modify: `packages/sim/src/cars.ts` (`intersectionSpeedMul` reads the shared predicate; `INTERSECTION_DEGREE` and `roadDegree` leave the file)
- Modify: `packages/sim/src/blocking.ts` (`canEnter`; two corrected paragraphs)
- Modify: `packages/shared/src/constants.ts` (`MAX_BLOCKED_TICKS`'s two false claims)
- **Modify: `packages/game/src/queueProbe.ts`** — `carAheadOf` disagrees with `canEnter` the moment this rule lands, and it is the instrument three of Task 3's criteria are read from
- Modify: `packages/game/test/deathTicks.ts`
- Test: `packages/sim/test/blocking.test.ts`, `packages/sim/test/graph.test.ts`, `packages/sim/test/loop.test.ts`, `packages/game/test/queueProbe.test.ts`, `packages/game/test/integration.test.ts`, `packages/game/test/allocation.test.ts`, `packages/game/test/carSmoothing.test.ts`, `packages/game/test/demoLayout.test.ts`

**Interfaces:**
- Consumes: `INTERSECTION_DEGREE` from `@laneways/shared` (Task 1); `countJunctionConflicts` (Task 1).
- Produces: `isJunctionCell(state: GameState, cell: number): boolean` and `junctionAdmitsOne(state: GameState, cell: number): boolean` from `packages/sim/src/graph.ts`; `otherLane(lane: number): number` from `packages/sim/src/roads.ts`. **Task 9 amends `junctionAdmitsOne` and nothing else** — `isJunctionCell` keeps its body for the rest of the milestone, because §5.6 requires a lit junction to keep the intersection slowdown.

- [ ] **Step 1: Write the failing unit test for the rule, and for the two-predicate split**

Add to `packages/sim/test/blocking.test.ts`, using the file's existing hand-built board helpers:

```ts
describe('a junction cell admits ONE car at a time (spec 5.5, M1f Task 2)', () => {
  /**
   * A plus: cell C at the centre with four orthogonal arms, so `roadDegree(C)`
   * is 4. Car 0 stands on C having entered from the west (lane
   * `LANE_OF_DIR[DIR_E]`); car 1 stands on the north arm and wants to enter C
   * heading south (lane `LANE_OF_DIR[DIR_S]`), which is the OTHER lane.
   *
   * The fixture is a PLUS and not a corridor deliberately: on a degree-2 cell
   * the rule must not fire, and the sibling test below is that arm.
   */
  it('refuses a crossing entrant while the other lane is held', () => {
    const rig = plusJunction()
    expect(roadDegree(rig.s, rig.centre), 'the fixture really is a junction').toBe(4)
    expect(LANE_OF_DIR[DIR_E], 'the two cars really are in different lanes').not.toBe(LANE_OF_DIR[DIR_S])
    claimCell(rig.s, 0, rig.centre, DIR_E)
    expect(canEnter(rig.s, rig.world, 1, rig.centre, DIR_S)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })

  it('admits the same entrant when the cell is a corridor rather than a junction', () => {
    const rig = straightCorridor()
    expect(roadDegree(rig.s, rig.mid), 'the fixture really is degree 2').toBe(2)
    claimCell(rig.s, 0, rig.mid, DIR_E)
    expect(canEnter(rig.s, rig.world, 1, rig.mid, DIR_S)).toBe(EnterOutcome.ENTER_FREE)
  })

  it('still admits an entrant onto an EMPTY junction', () => {
    const rig = plusJunction()
    expect(canEnter(rig.s, rig.world, 1, rig.centre, DIR_S)).toBe(EnterOutcome.ENTER_FREE)
  })

  it('refuses on the OWN lane at a junction exactly as it does on a corridor', () => {
    const rig = plusJunction()
    claimCell(rig.s, 0, rig.centre, DIR_S)
    expect(canEnter(rig.s, rig.world, 1, rig.centre, DIR_S)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })

  it('releases a junction refusal through the valve, and the valve is still inside the occupied family', () => {
    const rig = plusJunction()
    claimCell(rig.s, 0, rig.centre, DIR_E)
    rig.s.carBlockedTicks[1] = MAX_BLOCKED_TICKS
    expect(canEnter(rig.s, rig.world, 1, rig.centre, DIR_S)).toBe(EnterOutcome.ENTER_VALVE)
  })

  it('does NOT let the valve release a junction cell that is also a ghost', () => {
    // The ghost check is an early return in FRONT of the occupancy read, so the
    // junction clause cannot reach it either. This is the conjunction the
    // catalogue records as untested for a whole milestone: BOTH clauses true at
    // once — a saturated counter AND a ghost AND a junction AND the other lane
    // held — on one fixture.
    const rig = plusJunction()
    claimCell(rig.s, 0, rig.centre, DIR_E)
    rig.s.carBlockedTicks[1] = MAX_BLOCKED_TICKS
    rig.s.ghostMask[rig.centre] = 1 << DIR_E
    expect(isCommittedTo(rig.s, rig.world, 1, rig.centre), 'the fixture is off-manifold on purpose').toBe(false)
    expect(canEnter(rig.s, rig.world, 1, rig.centre, DIR_S)).toBe(EnterOutcome.REFUSED_GHOST)
  })

  it('breaks the 2-cycle that the two-lane model used to make impossible', () => {
    // Two junctions joined by one edge, one car standing on each, each wanting
    // the other's cell. Neither can move; the valve is the only way out. This is
    // the case `MAX_BLOCKED_TICKS`'s comment said could not exist, this task
    // corrects that comment, and **Task 9 Step 7 reuses this exact fixture to
    // show that a junction upgrade on each cell gives the property back, with
    // nothing hand-written into state.**
    const rig = twoAdjacentJunctions()
    claimCell(rig.s, 0, rig.left, DIR_E)
    claimCell(rig.s, 1, rig.right, DIR_W)
    expect(canEnter(rig.s, rig.world, 0, rig.right, DIR_E)).toBe(EnterOutcome.REFUSED_OCCUPIED)
    expect(canEnter(rig.s, rig.world, 1, rig.left, DIR_W)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })
})
```

Write `plusJunction()`, `straightCorridor()` and `twoAdjacentJunctions()` beside the file's existing rig helpers, each returning `{ s, world }` plus the named cells, and each asserting its own degree inside the test rather than in the helper. **`twoAdjacentJunctions()` must be exported from the test file or moved to a shared fixture module, because Task 9 imports it.**

Add to `packages/sim/test/graph.test.ts`, the table that keeps the two predicates from drifting:

```ts
describe('isJunctionCell and junctionAdmitsOne are TWO predicates with two jobs', () => {
  // They agree at Task 2 and diverge at Task 9, when an UPGRADED junction keeps
  // the SLOWDOWN (INTERSECTION_SPEED_MUL still applies; spec 5.6's right-on-red
  // clause protects the same property) and loses the DEFAULT EXCLUSION. This
  // table is what stops them silently collapsing back into one.
  it('a degree-3 cell is a junction, and the default exclusion applies', () => {
    const rig = plusJunction()
    expect(isJunctionCell(rig.s, rig.centre)).toBe(true)
    expect(junctionAdmitsOne(rig.s, rig.centre)).toBe(true)
  })

  it('a degree-2 cell is neither', () => {
    const rig = straightCorridor()
    expect(isJunctionCell(rig.s, rig.mid)).toBe(false)
    expect(junctionAdmitsOne(rig.s, rig.mid)).toBe(false)
  })

  it('an off-board index answers false from both, with no guard, exactly as roadDegree does', () => {
    const rig = plusJunction()
    expect(isJunctionCell(rig.s, rig.world.cells + 5)).toBe(false)
    expect(junctionAdmitsOne(rig.s, rig.world.cells + 5)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @laneways/sim test -- blocking graph`
Expected: FAIL — the crossing entrant is currently `ENTER_FREE`, and neither predicate exists.

- [ ] **Step 3: Implement the two predicates, `otherLane`, and the rule**

`packages/sim/src/graph.ts`:

```ts
/**
 * Is `cell` an INTERSECTION — a cell where a third road meets?
 *
 * **This is the SLOWDOWN's predicate and the PLACEMENT rule's predicate, and it
 * is deliberately NOT the exclusion's.** See `junctionAdmitsOne` below. A cell
 * carrying a junction upgrade is still an intersection for the purposes of
 * `intersectionSpeedMul` — M1f's upgrade lifts the mutual exclusion and changes
 * nothing else about the cell — while no longer being governed by the default
 * rule. Keeping the two apart puts each rule's edit in exactly one place and
 * turns the divergence into a table in `graph.test.ts` rather than a branch
 * inside a caller.
 *
 * Counted off the MASK by `roadDegree`, which differs from `neighbours` only for
 * a bit written directly into `state.roads`. An off-board `cell` reads
 * `undefined`, `roadDegree` answers 0, and this answers `false` — the same answer
 * bare ground gives. No guard, for the same reason `roadDegree` has none.
 *
 * **NOT an edge weight, and never.** See the 2026-08-21 amendment to spec §5.4.
 */
export function isJunctionCell(state: GameState, cell: number): boolean {
  return roadDegree(state, cell) >= INTERSECTION_DEGREE
}

/**
 * Does the DEFAULT junction rule — spec §5.5's mutual exclusion, one car at a
 * time — govern `cell`?
 *
 * **`canEnter`'s exclusion clause is this function's only production reader**
 * — with one deliberate second reader in test-adjacent code, `carAheadOf`
 * (`game/src/queueProbe.ts`), which reads the same predicate precisely so the
 * probe and the entry rule cannot disagree. It exists as a separate name from
 * `isJunctionCell` so that M1f Task 9 can add its upgrade clause HERE and nowhere
 * else. An upgraded junction is still an intersection (it slows cars) and is no
 * longer under the default rule (nothing replaces it; the rule is simply lifted).
 * `graph.test.ts` holds the table over all four combinations, so the two cannot
 * drift into agreement.
 *
 * Identical to `isJunctionCell` at this task. That is not redundancy; it is the
 * seam, named before it is needed, in the one commit where both readers are still
 * asking the same question.
 */
export function junctionAdmitsOne(state: GameState, cell: number): boolean {
  return isJunctionCell(state, cell)
}
```

`packages/sim/src/roads.ts`, beside `LANE_OF_DIR`:

```ts
/**
 * The other of the two lanes. `LANE_COUNT` is 2 and this function is the one
 * place that assumes it, so raising `LANE_COUNT` fails here loudly rather than
 * silently returning a lane index that means something else.
 *
 * Its one production caller is `canEnter`'s junction clause: mutual exclusion at
 * a junction means the entrant's own lane AND the lane it is crossing.
 */
export function otherLane(lane: number): number {
  if (LANE_COUNT !== 2) {
    throw new Error(`roads: otherLane assumes exactly two lanes, but LANE_COUNT is ${LANE_COUNT}`)
  }
  if (lane !== 0 && lane !== 1) throw new Error(`roads: lane ${lane} is not one of the two`)
  return lane === 0 ? 1 : 0
}
```

`packages/sim/src/blocking.ts`, replacing `canEnter`'s last three lines:

```ts
  const lane = LANE_OF_DIR[dir] as number
  const own = state.occupancy[occupancySlot(cell, lane)] as number
  // ------------------------------------------------------------------------
  // THE JUNCTION'S MUTUAL EXCLUSION — M1f Task 2, spec §5.5
  // ------------------------------------------------------------------------
  //
  // §5.5's blocking primitive is *"does an inbound vehicle collide with a
  // traversing vehicle on this chunk?"*, and until M1f this function only ever
  // asked about the entrant's OWN lane. That resolves the parallel case and the
  // head-on case (`LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]`) and leaves the
  // CROSSING case unresolved — so two cars crossed inside one cell and nothing
  // stopped them. `MAX_BLOCKED_TICKS` is the datamined ceiling on the wait at an
  // intersection; this is the wait.
  //
  // **A junction cell admits one car at a time.** On a cell of degree >= 3 the
  // OTHER lane must be free too. One extra `Int16Array` read on 0.35 crossings
  // per tick, no new state, no allocation.
  //
  // **THIS BREAKS THE HEAD-ON PROPERTY AT JUNCTIONS, AND THAT IS THE COST.** Two
  // cars swapping across an edge whose endpoints are both junctions each require
  // the other's cell to be empty and each is standing in it. Measured: the valve
  // goes from 0 firings to 15 (wide rule) or 5 (crossing-only) on the shipped
  // board's greedy arm. M1f Task 9's JUNCTION UPGRADE is what gives the property
  // back — whole, at one cell, with no phase — which is dossier §1.7's
  // `greenLightsIgnoreCollisions` applied to every axis at once.
  //
  // **`junctionAdmitsOne` and NOT `isJunctionCell`**, because the two diverge at
  // Task 9: an upgraded junction keeps the intersection SLOWDOWN and loses this
  // rule. See `graph.ts`.
  //
  // **It inherits `assertOccupancySound`'s valve exception and introduces no new
  // soundness question**: the other lane's slot is read exactly as the own lane's
  // is, so a stale claim left by a valve displacement is stale in both and is
  // already in that assert's exception set.
  const other = junctionAdmitsOne(state, cell)
    ? (state.occupancy[occupancySlot(cell, otherLane(lane))] as number)
    : FREE
  if (own === FREE && other === FREE) return EnterOutcome.ENTER_FREE
  if ((state.carBlockedTicks[i] as number) >= MAX_BLOCKED_TICKS) return EnterOutcome.ENTER_VALVE
  return EnterOutcome.REFUSED_OCCUPIED
```

And in `cars.ts`, `intersectionSpeedMul` becomes:

```ts
export function intersectionSpeedMul(state: GameState, cell: number): number {
  return isJunctionCell(state, cell) ? INTERSECTION_SPEED_MUL : MUL_NONE
}
```

**This removes `roadDegree` and `INTERSECTION_DEGREE` from `cars.ts` entirely.** Delete both imports; do not leave them for lint to find. `cars.ts`'s `./graph` import becomes `{ edgeCost, isJunctionCell }`.

- [ ] **Step 4: Run the SIM suite before touching any golden literal**

Run: `pnpm --filter @laneways/sim test`
Expected: **one failure, and all seven `sim`-side goldens green.** The one failure is
`cars.test.ts > movement cannot re-path, by signature`, which pins `cars.ts`'s import lines and sees
`roadDegree` leave and `isJunctionCell` arrive. Re-derive that pin — do not widen it — and record the
before/after import line in the commit message.

Trap 3's derivation says no golden fixture ever puts two cars on one junction cell. **If a golden is
red here, stop and report — do not re-bless.** Read the failure: if it is a `hashState` line, the
derivation is wrong and this task's scope has changed; if it is a queue-length or arrival-tick
assertion inside a golden's `describe`, that is a behavioural test moving, not the digest.

- [ ] **Step 5: Run the whole suite and enumerate exactly which `game` tests moved**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: RED in `packages/game`. **Write down the full failure list before changing anything.** The
expectation is **at least 20** tests plus `DEMO_DEATH_TICK`. The previous draft said 18 and its
enumeration omitted two files whose failures are **non-vacuity floors**, which is a different and
worse kind of failure than a moved number:

- `game/test/allocation.test.ts` — its M1e window (`M1E_FIRST_WINDOW_START` 14,059, three windows of
  4,600 → 27,858) now profiles a **corpse**, because the greedy death tick moves to 21,704 (wide rule; 21,783 under arm B). **Task 2
  is not the task that repairs it** — Task 3 moves the death tick again — so leave it red, add a
  one-line note at the site keyed to Task 3, and record it here.
- `game/test/carSmoothing.test.ts` — two floors: `nearQueuePairs > 100` measures **46**, and
  `standingStarts > 100` measures **58**. A floor that fails is a fixture that stopped exercising its
  own subject; re-derive both against the new rule rather than lowering them, and say in the commit
  message what each now measures and why the new value is the right one.

A count materially different from 20 is a finding: too few means the rule is not firing on the arms
that should feel it, too many means it is firing somewhere the derivation did not predict.

- [ ] **Step 6: Re-measure `DEMO_DEATH_TICK`; DERIVE that `CITY_DEATH_TICK` does not move**

`deathTicks.ts`'s two constants are measured by driving `step` directly with **no input**, which needs
no card policy — `sim` has no pause (Decision 11). So both are still measurable exactly as its header
specifies.

**`CITY_DEATH_TICK` does not move, and this is a derivation, not a hope.** The no-input city dies at
tick 5,580 (`deathTicks.ts`: D2, colour 1's lone circle). The earliest junction event on **any** arm
of this board is at tick **12,780** (Task 1's rule-visible census; the co-presence census says
15,001, and the earlier of the two is the one this derivation must use). A board that is dead at
5,580 never reaches either, so this rule cannot touch it. **Drive it anyway and confirm 5,580**; then add to its doc comment:

```ts
/**
 * … **Confirmed unmoved at M1f Task 2, and that is derived rather than lucky.**
 * Junction mutual exclusion can only change a run in which two cars both have
 * business inside one junction cell on one tick, and the earliest that ever
 * happens on this board is tick 12,780 (`junctionCensus.ts`'s RULE_VISIBLE
 * policy, on the greedy arm; its CO_PRESENCE policy says 15,001 and is blind to
 * the same-tick swap at 12,780 — use the earlier figure here). This board is
 * dead at 5,580 with no input, well over twice as early either way. The previous
 * milestone's plan predicted BOTH constants would move; only one does.
 */
export const CITY_DEATH_TICK = 5580
```

`DEMO_DEATH_TICK` **does** move — the demo board is a deliberately overloaded city with 7,544
refusals before this change. Re-measure it and replace the constant:

```ts
/**
 * … **Moved at M1f Task 2** from 6,703 by junction mutual exclusion: the demo
 * board is a deliberately overloaded city and a junction that costs something is
 * what it was built to exhibit. Re-measured on the same rig this file's header
 * specifies — `step` driven directly, no input, no card policy needed.
 * **Task 3 may move it again** — it is the task that decides the shipped rule —
 * and if it does, both this constant and `demoAllocation.test.ts`'s margin are
 * re-derived there.
 */
export const DEMO_DEATH_TICK = /* measured */
```

**Do not copy a number from this plan into `deathTicks.ts`.** It is a measurement, and the plan states
none for it precisely because Task 3 may move it again. (For orientation only, and **not** to be
pasted: the review measured the wide rule at 5,757 and arm B at 6,660.)

**Correct `constants.ts`'s `MAX_BLOCKED_TICKS` evidence table in the same edit.** It records `city
5,580 ticks / 0 refusals / max 0 / 0 valve firings`, `demo 6,703 / 7,544 / 55 / 0` and `city, greedy
31,456 / 0 / 32 / 0`, and concludes *"nothing that ships can reach it"*. Two of those three rows move
and the conclusion is false. Replace the table with the measured post-Task-2 rows, keep the old rows
struck through with their date, and say which arm each is.

- [ ] **Step 7: Repair `queueProbe.ts` — it disagrees with `canEnter` from this commit onward**

`carAheadOf` reads exactly one slot: `occupantOf(next, LANE_OF_DIR[dir])` — the entrant's own lane.
**Junction exclusion refuses on the OTHER lane**, so from this commit the probe reports "nothing
ahead" for a car that `canEnter` is refusing. Its own doc states the premise this destroys (*"the
relation is FUNCTIONAL … at most one car ahead"*), it is imported by five files, and it produces
Task 3's criterion 3 and the *"longest queue 17"* figure.

**The tie-break, decided here rather than discovered:**

```ts
/**
 * The car standing in the slot car `i` is trying to cross into, or `FREE`.
 *
 * … [existing doc] …
 *
 * **M1f Task 2: at a JUNCTION the entrant can be held by either lane, and this
 * function answers with the OWN lane first.** Mutual exclusion means a car
 * entering a cell of degree >= `INTERSECTION_DEGREE` needs both lanes free, so
 * "the car ahead" is no longer a single well-defined slot. The relation must stay
 * FUNCTIONAL — `longestQueue` walks it and would otherwise need a graph — so the
 * tie-break is: the own lane's occupant if there is one, otherwise the other
 * lane's. That is the car whose departure the entrant is actually waiting on in
 * the common case, and the fallback is what makes the chain reflect a crossing
 * refusal instead of reporting an empty road in front of a stopped car.
 *
 * The probe's property test — *"for every in-flight car on every tick, the probe's
 * answer equals `canEnter`'s"* — is re-pointed accordingly: the probe reports a
 * car ahead **iff** `canEnter` refuses for occupancy. That is the assertion that
 * catches this whole class, and hand-built cases could not: every reader is an
 * inequality loose enough to survive a wrong answer.
 */
```

```ts
export function carAheadOf(state: GameState, world: WorldData, i: number): number {
  const dir = travelDir(state, i)
  if (dir === NO_CROSSING) return FREE
  const next = stepCell(state.carCell[i] as number, dir, world.w, world.h)
  if (next < 0) return FREE
  const lane = LANE_OF_DIR[dir] as number
  const own = occupantOf(state, next, lane)
  if (own !== FREE) return own
  if (!junctionAdmitsOne(state, next)) return FREE
  return occupantOf(state, next, otherLane(lane))
}
```

Extend `packages/game/test/queueProbe.test.ts`: a junction fixture where the entrant's own lane is
free and the other lane is held, asserting the probe names the other lane's car **and** that
`canEnter` refuses on the same tick; the corridor case asserting `FREE`; and re-run the existing
90,533-question agreement property against the new rule. **Then re-measure every `longestQueue`
figure this repo carries**, including *"longest queue 17"* on the demo board and the `[1,1,2,3,3,4,4]`
per-week row in `integration.test.ts`, and state in the commit message that they are
post-repair numbers.

- [ ] **Step 8: Repair the remaining moved `game` tests, one at a time, by re-deriving rather than re-fitting**

For each: read what it asserts, decide whether the new value is the *correct* value for the new rule,
and record the pair in the commit message. **A test whose new value cannot be derived from the rule is
a test that was measuring something else** — say so rather than pasting the number in.
`demoAllocation.test.ts`'s window margin and `allocation.test.ts`'s M1e window are **not** repaired
here; they are Task 3's, and they are allowed to stay red between these two commits. Add a one-line
note at each site saying so, keyed to Task 3.

- [ ] **Step 9: Correct the two false claims in `MAX_BLOCKED_TICKS`'s comment**

```
 * **M1f Task 2 falsified two sentences that stood here, and both are corrected
 * rather than deleted, because the reasoning that produced them is still worth
 * reading.**
 *
 * The first said head-on is structurally impossible, so no 2-cycle can deadlock
 * and the valve is the answer only to a cycle of length >= 3. That was true while
 * `canEnter` asked about one lane. Under junction mutual exclusion two cars
 * swapping across an edge whose endpoints are BOTH junctions each require the
 * other's cell to be empty and each is standing in it: a 2-cycle, cleared only by
 * this constant. `blocking.test.ts`'s *"breaks the 2-cycle"* test is the fixture,
 * and `upgrades.test.ts`'s *"an upgrade gives the head-on property back"* is the
 * relief.
 *
 * The second said lowering this constant is a change no shipped board can observe
 * and raising it is free. Also true then, false now: the valve fires **15 times**
 * under the wide rule and **5** under the crossing-only rule on the shipped
 * board's greedy arm, where it fired 0 — so both directions are observable and the
 * first real tuning evidence exists. (The M1f plan's earlier drafts said 14; both
 * arms were re-measured and neither is 14. Re-measure rather than pasting either.)
 *
 * **A THIRD READER WAS PREDICTED AT M1f TASK 9 AND DOES NOT EXIST, and the reason
 * is worth keeping.** The prediction was that a demand-actuated traffic light
 * needing 2 cars on an approach before swapping (dossier §1.7's
 * `minimumNearbyCarsBeforeSwapping`) would starve a lone car on a quiet approach,
 * and that this constant would be its only release. M1f measured that light and
 * rejected it: on a board carrying about eleven cars in flight the threshold is
 * essentially never met, so the light did not meter — it latched, and this
 * constant became its only release for the whole run rather than an occasional
 * one. M1f ships a JUNCTION UPGRADE instead, which admits cars rather than
 * refusing them and therefore *reduces* the pressure on this valve. The reader
 * count stays at two. See the M1f plan's Amendment 2 and Decision 14, and
 * `docs/superpowers/m1g-carry-forward.md`.
```

In `packages/sim/src/blocking.ts`, `canEnter`'s doc: *"Give-way is not implemented because it does not
need to be"* becomes a statement of what IS implemented — mutual exclusion, in whose favour it
resolves (lowest car index), that it costs the head-on property at junctions, and that a traffic
light is the only thing that lifts it.

- [ ] **Step 10: State the fairness rule and test it**

Add to `packages/sim/test/loop.test.ts`, on a fixture where two cars would enter one junction cell on one tick:

```ts
  it('gives the junction to the LOWER car index, as a rule and not as a loop bound', () => {
    const rig = junctionRace()          // cars 0 and 1, both one step from the centre, crossing axes
    step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.carCell[0], 'car 0 crossed').toBe(rig.centre)
    expect(rig.s.carCell[1], 'car 1 held its progress').not.toBe(rig.centre)
    expect(rig.s.carBlockedTicks[1], 'and was counted as blocked, not merely slow').toBe(1)
    expect(rig.s.carBlockedTicks[0], 'while the winner was not').toBe(0)
  })
```

- [ ] **Step 11: Run the whole suite**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS in every package **except** `demoAllocation.test.ts`'s window margin and
`allocation.test.ts`'s M1e window, which Task 3 owns and which must be the only red things. If
anything else is red, it was not predicted and is a finding.

- [ ] **Step 12: Mutation-test**

| # | Mutant | Expected |
|---|---|---|
| 1 | `canEnter`: delete the junction clause (`other` always `FREE`) | high; must include `blocking.test.ts`'s crossing test **and** `integration.test.ts` |
| 2 | `canEnter`: drop `junctionAdmitsOne` (always read the other lane) | ≥ 1, in *"admits the same entrant on a corridor"* |
| 3 | `canEnter`: read `lane` instead of `otherLane(lane)` for `other` | ≥ 1 — this is the mutant that makes the clause a duplicate of the own-lane read and it must not be equivalent |
| 4 | `canEnter`: hoist the valve above the ghost early return | ≥ 1, in *"does NOT let the valve release a ghost"* |
| 5 | `isJunctionCell`: `>= INTERSECTION_DEGREE` → `> INTERSECTION_DEGREE` | ≥ 1 |
| 6 | `junctionAdmitsOne`: `return true` unconditionally | ≥ 1, in the corridor arm of `graph.test.ts`'s table **and** in `blocking.test.ts` |
| 7 | `otherLane`: `lane === 0 ? 1 : 0` → `lane` | ≥ 1, same set as #3 |
| 8 | `otherLane`: delete the `LANE_COUNT !== 2` throw | **0 expected** — unreachable while `LANE_COUNT` is 2. Record as a deliberately unreachable guard; do not manufacture a detector |
| 9 | `carAheadOf`: drop the other-lane fallback | ≥ 1, in the new junction probe test and in the `canEnter` agreement property |
| 10 | `carAheadOf`: return the other lane FIRST | ≥ 1 — the tie-break is a decision and must have a detector, not just a comment |
| 11 | `runMovement`: iterate descending | high, and it must now include the fairness test by name |

- [ ] **Step 13: Commit**

```bash
git add packages/sim packages/shared packages/game
git commit -m "feat(sim): a junction admits one car at a time

MAX_BLOCKED_TICKS is the datamined ceiling on the wait at an intersection and
this project shipped it without the wait. canEnter read one lane, so two cars
crossed inside one cell and nothing stopped them. Spec 5.5's blocking primitive
is mutual exclusion at the chunk; a cell of road degree >= 3 now admits one car.

TWO predicates, not one. isJunctionCell (degree) is the SLOWDOWN's reader;
junctionAdmitsOne is the EXCLUSION's. They are identical today and diverge at
Task 9, when a junction upgrade lifts the exclusion at its cell and leaves
everything else - including INTERSECTION_SPEED_MUL - unchanged. The split puts
each rule's edit in exactly one place and makes the divergence a table in
graph.test.ts rather than a branch inside a caller.

The cost, stated because it reads as a regression and is not, on the WIDE rule
this task lands: blocked car-ticks 2,120 -> 45,986, worst wait 32 -> 1,350
saturated, valve firings 0 -> 15, run 17:19.9 -> 11:54, trips 747 -> 344. Task 3
may narrow the rule to crossing-only, which measures 29,267 / 5 / 11:57.5 / 368;
every figure above says which arm it is. Bit-identical to the previous commit
until tick 12,780 (6:57.4), by construction: that is the first tick two cars
both have business inside one junction cell, per junctionCensus.ts's RULE_VISIBLE
policy. The first tick a person can SEE a difference is 16,337 (8:56.0).

This also breaks the head-on property at junctions - two cars swapping across an
edge with junctions at both ends now deadlock until the valve. Task 9's junction
upgrade gives it back whole, at one cell, with no phase.

DEMO_DEATH_TICK moves. CITY_DEATH_TICK does NOT, and that is derived: the
no-input city is dead at 5,580, nearly three times before the first conflict.

queueProbe.ts is repaired in the same commit: carAheadOf read one lane and would
have disagreed with canEnter from here on. Own lane first, other lane as the
tie-break, with the canEnter agreement property re-pointed at the new rule. Every
longestQueue figure in the repo is a post-repair measurement from this commit.

Zero goldens move. Two sentences in MAX_BLOCKED_TICKS's comment were falsified by
this change and are corrected, and its evidence table is re-measured.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8"
```

---

## Task 3: Demo-board triage — a fork resolved BEFORE the shape change, and the site survey the roundabout failed

**The problem, measured.** Junction exclusion freezes the demo board inside `demoAllocation.test.ts`'s profiling window: **97,138 blocked car-ticks, longest queue 17, trips 420 → 105**, and the rig's liveness guard fires. That rig ends at tick **6,459** against `DEMO_DEATH_TICK`, and its margin was already the tightest in the repo at 3.6 %. Measured demo death ticks: **today 6,703; wide rule 5,757; arm B 6,660.**

**Observability:** depends on the arm. Under arm A or C, nothing changes on the default board and the demo board (`?startapp=demo`) gridlocks visibly. Under arm B the default board's queues get shorter than Task 2's and the demo board keeps roughly the traffic it has. **Whichever arm wins, the task states what a person sees on BOTH boards in its report.**

**Files:** depends on the arm; all three touch `packages/game/test/demoAllocation.test.ts`, `packages/game/test/allocation.test.ts` and `packages/game/test/deathTicks.ts`.
- Create: `packages/game/test/junctionArms.ts`

**Interfaces:**
- Consumes: `isJunctionCell`, `junctionAdmitsOne`, `otherLane` and `canEnter`'s junction clause (Task 2); `countJunctionConflicts` with **both** policies (Task 1); the repaired `longestQueue` (Task 2). **Consumes NOTHING from Task 4 or Task 9** — the previous draft's Step 3a called `canPlaceLight` and wrote `H_INV_LIGHTS`, both of which later tasks produce, and Sequencing makes Task 3 → Task 4 a correctness ordering. That is the second review's C2(a) and it is fixed in Step 3a.
- Produces: `runJunctionArm(arm: JunctionArm): JunctionArmRun` from `packages/game/test/junctionArms.ts`, where `JunctionArmRun = { readonly deathTick: number; readonly trips: number; readonly blockedCarTicks: number; readonly longestQueue: number; readonly refusalsByCell: Int32Array; readonly junctionRefusalsByCell: Int32Array; readonly conflicts: number; readonly ruleEvents: number }`; and `replayCapturing(arm: JunctionArm, ticks: readonly number[]): Map<number, Snapshot>` — **one replay pass, many snapshots**, which is C2(c)'s fix. **`junctionRefusalsByCell` is the artefact every later task reads its jam cells from** — Task 9's per-cell table and Task 12's sweep both derive from a run rather than from a literal, and both rank by the junction-caused tally rather than the total, because spillback lands on cells no object can be placed on. Under arm B, `crossesAt(state: GameState, i: number): number` and `crossesDirections(a: number, b: number): boolean` exported from `packages/sim/src/blocking.ts`.

### The three arms, written out before any of them runs

**Arm A — the wide rule everywhere, plus a demo layout change.** Keep Task 2's rule exactly. Edit `demoCity`'s map bytes or `seedDemoLayout`'s roads to give the overloaded board somewhere for its crossings to go. **Cost:** moves `3152640907` (the demo golden), which is the only golden this whole task may move; re-opens `demoLayout.test.ts`'s hand-computed figures; and the board being edited is the one board a human has ever played.

**Arm B — crossing conflicts only.** Refuse at a junction only when the occupant of the other lane is travelling on a **crossing axis**. §5.5 says *collide*, not *co-occupy*. The occupant's heading is not stored, and it is not reconstructed either: `previousLegDir` (cars.ts) — the function `advanceCar` already uses for exactly this — returns the direction a car's last crossing used, which for a car standing on `cell` is the direction it entered by.

```ts
/**
 * The direction the car standing on a cell ENTERED it by, or `NO_PREVIOUS_DIR`
 * if it has not crossed on this leg.
 *
 * **Not a reconstruction.** `previousLegDir` (cars.ts) is the same derivation
 * `advanceCar` runs to price the turn, over the same arrays, on the same tick.
 *
 * `NO_PREVIOUS_DIR` is fail-CLOSED: a car that has not crossed on its leg has no
 * axis, and a junction whose occupant's axis is unknown refuses. The two
 * reachable cases are a just-dispatched car on its house cell and a car that has
 * just flipped to RETURNING on the carpark.
 */
export function crossesAt(state: GameState, i: number): number
```

with the conflict test `d1 === NO_PREVIOUS_DIR || d2 === NO_PREVIOUS_DIR || !(d1 === d2 || d1 === (OPPOSITE[d2] as number))`. Measured: **1.85× blocked car-ticks on demo, 13.8× on city** against today.

**Two facts about arm B that the previous draft did not have, and both are derivable rather than measurable:**

1. **`d1 === d2` is UNREACHABLE through `canEnter`.** `LANE_OF_DIR` is a total function of direction, and the other-lane occupant is by definition in `otherLane(LANE_OF_DIR[d1])`, so `LANE_OF_DIR[d2] !== LANE_OF_DIR[d1]` and therefore `d2 !== d1`. The clause reduces to `d1 === OPPOSITE[d2]`. **The `d1 === d2` case is the one arm B's own justification talks about** (*"two cars going straight through a crossroads on the same axis"*) — so the justification describes a dead branch, and it must be rewritten to describe the live one: arm B admits **opposing** traffic at a junction, which the two-lane model already admitted everywhere else. Add a Step 10 mutant that deletes `d1 === d2` and record the **0** with this derivation beside it, so it is a labelled equivalent rather than an unexplained survivor.
2. **A TURNING occupant is admitted, and that is the conflict the milestone exists to stop.** `crossesAt` returns an *entry* direction. An occupant that entered heading E and is about to exit N presents `d2 = E`; an entrant heading W has `d1 = W = OPPOSITE[E]` and is **admitted**, straight across the occupant's path. Fix or document, and Step 5 must choose in writing: either compare the occupant's `(in, out)` pair — `advanceCar` already reads `routeStep` on the same tick, so the exit direction is available at no new cost — or state in Step 6's table test, as a **named fixture case**, that a turning occupant is a knowingly admitted crossing and why.

**Arm C — a relief-driven harness.** Keep the wide rule and repair `demoAllocation.test.ts` by shortening its window or by giving the demo board relief. **Cost, and it is disqualifying:** the only relief that exists is the junction upgrade, which is Task 9, and a Task 3 that depends on Task 9 is the fork being discovered inside Task 9 — the exact thing this task exists to prevent. Shortening the *profiled* window trades away coverage to hide a balance change. **Note carefully that lowering `WARMUP_FRAMES` is NOT arm C** — it is a knob outside the profiled window and it is criterion 1's own escape, named in Step 9.

### The criterion, stated before the measurement

An arm ships iff **all six** hold. The load floors are in it precisely because a survivability
criterion with no load floor is satisfiable by deleting the difficulty.

1. **The demo rig has margin.** `WARMUP_FRAMES + WINDOW_COUNT * PROFILED_FRAMES` frames of driving
   ends at a tick at least **10 %** below the arm's own re-measured `DEMO_DEATH_TICK`, with
   `isGameOver` false after the final drive. (3.6 % was already too tight.) **`WARMUP_FRAMES` may be
   moved to satisfy this** — see Step 9.
2. **The city board still has the problem.** Blocked car-ticks on the shipped seed's greedy arm are
   **at least 10×** today's 2,120.
3. **The demo board still has load.** Longest queue ≥ 4 **on the repaired probe** (Task 2 Step 7) and
   completed trips ≥ 200 over its run.
4. **The city board still has a bad corner, and the corner is one an object can be placed on.** At
   least three distinct **junction-eligible** cells each carry ≥ 5 % of the run's **junction-caused**
   refusals — i.e. the effect is *concentrated* **and reachable**. See Step 3a for why both
   qualifiers are load-bearing.
5. **No golden moves except `3152640907`, and only under arm A.**
6. **THE SITE SURVEY — the criterion the previous milestone shape failed, rewritten because the
   previous draft's version would have halted the milestone on a false positive.** For every cell
   carrying ≥ 5 % of the run's **junction-caused** refusals, the Task-3 placement predicate must
   accept it in a **window** around at least one of the four week boundaries, and the table of which
   boundaries accept which cells is **printed**, not summarised. This is a test, not a paragraph.
   See Step 3a.
7. **THE EFFICACY CHECK, moved here from Task 9.** Exempting the junction rule at the
   junction-eligible hot cells beats the same arm with no exemption, on **trips**, by a margin stated
   before it runs. See Step 3b, and read Amendment 2 first.

**The plan's prediction is arm B**, and it is written here so a disagreement is a finding rather than
a fill-in. Two reasons: it is the more faithful reading of §5.5, and it is the only arm that leaves
the one board a human has played alone. **If arm B fails criterion 1, 2, 4, 6 or 7, ship arm A** —
the wide rule with a demo layout change — and record the failure. **Do not ship arm C.**

- [ ] **Step 1: Commit the tree, then build the three-arm rig**

Add `packages/game/test/junctionArms.ts`, exporting one function per arm that drives the shipped city's greedy arm and the demo board's no-input arm and returns the `JunctionArmRun` shape above. **One rig, three arms, driven in one run** — the catalogue's *"measure both variants in the same run"*, so a difference cannot be a difference between two rigs. `refusalsByCell` and `junctionRefusalsByCell` are tallied inside `advanceCar`'s refusal path via two rig-owned counters, never reconstructed: the second increments only when the refusal came from the junction clause — the entrant's **own lane was free and the other lane was occupied** — which is the only refusal an upgrade can ever remove.

- [ ] **Step 2: Reproduce an inherited number before contradicting anything**

Before believing the rig about any arm, run it with the junction clause **disabled** (the three-line revert in `canEnter`, applied to a committed tree and restored by an `&&`-chained command) and assert it reproduces the pre-M1f figures exactly: death 31,456, trips 747, blocked car-ticks 2,120, `H_ROUTES_REFUSED` 0.

Run: `pnpm --filter @laneways/game test -- junctionArms`
Expected: those four exactly. **A rig that disagrees with the record is more likely to be wrong than the record is** — this project has caught its own harness this way twice, both times by omitting the warm start or the opening stroke.

- [ ] **Step 3: Measure all three arms and fill the criterion table**

Record, per arm, the seven criteria's quantities plus `DEMO_DEATH_TICK`, the greedy death tick, **both** census totals, and **the full `refusalsByCell` and `junctionRefusalsByCell` distributions sorted descending with each cell's share**. Put the table in the task report. Cross-check the top cells against Task 1's two conflict-cell lists — the review's run gave co-presence `(12,19) (9,22) (14,17) (8,23) (8,11) (8,21)` — and **state whether the refusal distribution and the conflict distributions name the same cells.** They measure different things (a conflict is a co-presence or a swap before the rule; a refusal is what the rule does instead) and a divergence between them is information, not an error.

**Two figures to reproduce here, both from the spike, both load-bearing for Step 3a:** junction-caused refusals are **6,536 of 29,267 blocked car-ticks = 22.3 %** under arm B (**18,458 of 45,986 = 40.1 %** under the wide rule); and refusals landing on cells that are junctions are **60.3 %** of all refusals under arm B (**76.3 %** wide). The first says how much of the blocking an upgrade can address at all. The second says that re-ranking from total to junction-caused refusals does not throw away the subject.

- [ ] **Step 3a: The site survey, as a test — rewritten three ways**

**The previous draft's version of this step was broken in three independent ways and each one is
fixed here.** They are stated before the code because an implementer who reads only the code will
re-introduce at least one.

**(a) It could not run where it was placed.** Its body called `canPlaceLight` and wrote
`H_INV_LIGHTS`. `canPlaceLight` is Task 9's `Produces`; `H_INV_LIGHTS` is Task 4's; Task 3's own
Interfaces list neither, and Sequencing makes Task 3 → Task 4 a **correctness** ordering. All three
exits an implementer had — improvise, defer to Task 9, or pull the function forward — lost or
corrupted the criterion. **Fix:** Task 3's predicate is `isJunctionCell(state, cell)` plus a bounds
check, which is Task 2's and is available. It is deliberately the **degree half** of
`canPlaceUpgrade`'s five refusals, and the other four (`no-inventory`, `capacity`, `off-board`,
`occupied`) are not board properties at all — they are inventory and bookkeeping. **Task 9 Step 5 is
named here as the step that re-runs this exact table through the real `canPlaceUpgrade` and asserts
the two agree cell-for-cell**, so nothing is taken on trust across the task boundary.

**(b) It ranked by TOTAL refusals, and would have halted the milestone on a false positive.**
Spillback lands on degree ≤ 2 cells **by construction** — one hop downstream of the junction, which is
the roundabout's mismatch in a smaller form. Measured on the predicted shipping arm: `(13,18)` carries
**19.5 %** of all refusals, the second-largest cell on the board, and **is never a junction at any
tick**; `(11,20)` is the same. The previous draft's text said *"if any hot cell accepts at zero
boundaries, stop and report"*, so the milestone would have stopped on two cells that were never
candidates. **Fix:** rank by **junction-caused** refusals — the entrant's own lane free, the other
lane occupied — which is the only refusal an upgrade can remove, and which by construction occurs only
on junction cells. **And pin the share** so the criterion cannot be satisfied by a board on which the
rule does nothing.

**(c) It would have timed out.** `replayTo(tick)` sat inside the cell loop and did not depend on the
cell: 3–6 hot cells × 4 boundaries = **12–24 full replays** of a ~21,700-tick run, at a measured
3.5–4.8 s each, against Vitest's 5,000 ms default. The cheapest exit from that timeout is to cut the
boundary list or the hot-cell set, which is the criterion quietly weakening itself. **Fix:** one
replay pass that snapshots at every sample tick, then a loop over cells against the snapshots — and a
`SURVEY_TIMEOUT_MS` derived and written down.

**And (d), the second review's I11: sample a WINDOW, and report SITES.** The board's first junction is
born at tick **4,530** — thirty ticks *after* the first boundary — and those thirty ticks are a
`GREEDY_PERIOD_TICKS = 30` metronome artefact, not a board property. A survey that samples the
boundary tick alone reports "no legal site at boundary 1" for a reason that is an accident of the
connector's clock. And the useful number is not only *"can this cell take one"* but **how many
distinct legal sites exist at each boundary** — measured as **0 / 2 / 6 / 6**, which is what bounds
how much relief a player can actually seat.

```ts
  // **This is the criterion the roundabout failed, and it is also the criterion
  // that would have halted THIS milestone on a false positive if it had shipped
  // as written.** Read the four fixes above before changing anything here.
  //
  // The interesting failure it can still find is TIMING: a cell that only becomes
  // a junction at tick 12,000 is not a legal site at 4,500, so an early card must
  // be HELD. Section 2.2 permits that ("items sit unplaced indefinitely") and
  // this table says for how long.
  const BOUNDARIES = [4500, 9000, 13500, 18000] as const
  // A window, not a tick: the connector fires every GREEDY_PERIOD_TICKS, so
  // whether a junction exists exactly ON a boundary is a metronome artefact.
  const WINDOW = [0, GREEDY_PERIOD_TICKS, 2 * GREEDY_PERIOD_TICKS, 3 * GREEDY_PERIOD_TICKS] as const
  const SAMPLES = BOUNDARIES.flatMap((b) => WINDOW.map((w) => b + w))

  it('every junction-eligible hot cell can take an upgrade in some boundary window, and here is the table', () => {
    const run = runJunctionArm(SHIPPED_ARM)

    // (b) JUNCTION-CAUSED refusals, not total. An upgrade can only ever remove a
    // refusal whose cause was the junction clause, and spillback onto degree <= 2
    // cells is not one.
    const hot = cellsCarryingAtLeast(run.junctionRefusalsByCell, 5)   // percent of junction-caused
    expect(hot.length, 'the effect is concentrated (criterion 4)').toBeGreaterThanOrEqual(3)

    // The share, pinned, so the criterion cannot be satisfied by a board where the
    // rule does nothing. Reproduce: 6,536 / 29,267 = 22.3 % (arm B).
    const share = (1000 * sum(run.junctionRefusalsByCell)) / run.blockedCarTicks
    expect(share, 'junction-caused refusals as a share of all blocking').toBeGreaterThan(100)  // > 10 %

    // (c) ONE replay pass, snapshotting at every sample tick. The previous draft
    // replayed inside the cell loop, which does not depend on the cell: 12-24
    // full replays of a ~21,700-tick run at 3.5-4.8 s each, against a 5,000 ms
    // default. Measure ONE arm first and derive SURVEY_TIMEOUT_MS from it.
    const snaps = replayCapturing(SHIPPED_ARM, SAMPLES)   // Map<tick, Snapshot>

    const table: string[] = []
    // (d) SITES per boundary, not only acceptance per cell: this is the number
    // that bounds how much relief a player can seat, and it is 0 / 2 / 6 / 6.
    for (const b of BOUNDARIES) {
      const sites = new Set<number>()
      for (const w of WINDOW) {
        const snap = snaps.get(b + w)!
        for (let cell = 0; cell < snap.world.cells; cell++) {
          if (isJunctionCell(snap.state, cell)) sites.add(cell)
        }
      }
      table.push(`boundary ${b}: distinct legal sites in window = ${sites.size}`)
    }

    for (const cell of hot) {
      const accepts = SAMPLES.filter((t) => {
        const snap = snaps.get(t)!
        return cell >= 0 && cell < snap.world.cells && isJunctionCell(snap.state, cell)
      })
      table.push(
        `${cellName(cell, WORLD.w)} junctionRefusals=${run.junctionRefusalsByCell[cell]} ` +
          `total=${run.refusalsByCell[cell]} accepts=[${accepts}]`,
      )
    }
    // Printed, not summarised: the previous milestone's shape died of a
    // one-number answer to this exact question.
    console.log(table.join('\n'))

    // **The criterion must be satisfiable on FOUR, and this is why it does not
    // demand every hot cell.** Two of the six cells carrying the most TOTAL
    // refusals - (13,18) at 19.5 % and (11,20) - never reach degree >= 3 on any
    // tick, so they can never be sites. Ranking by junction-caused refusals
    // should exclude them by construction; if it does not, that is the finding
    // and it goes in the report's first line.
    const seatable = hot.filter((cell) => SAMPLES.some((t) => isJunctionCell(snaps.get(t)!.state, cell)))
    expect(seatable.length, 'at least four junction-eligible hot cells can be seated')
      .toBeGreaterThanOrEqual(4)
    expect(seatable.length, 'and the ranking did not smuggle in a cell that is never a junction')
      .toBe(hot.length)
  }, SURVEY_TIMEOUT_MS)
```

**If a junction-eligible hot cell accepts in zero windows, stop and report** — that is the same class
of finding that killed the roundabout. **A cell that is never a junction is NOT that finding**; it is
the expected behaviour of spillback, and the ranking is what keeps it out of the criterion.

**Derive `SURVEY_TIMEOUT_MS` and write the number down.** One greedy arm is 3.5–4.8 s measured; this
step runs the arm once and the snapshotting pass once, so budget two arms plus headroom. **Measure
one arm in this task and multiply**; do not paste a number from this plan.

- [ ] **Step 3b: The efficacy check, moved out of Task 9 and made cheap**

**Why it is here.** The second review's C4 was that nobody had measured whether the relief item helps,
and that the previous draft measured it at its Task 9 Step 14 — after eight tasks of infrastructure. A spike has now
measured it (Amendment 2), and the answer is yes. **But the point of the gate was never the answer; it
was that the milestone's central claim should not be tested at task nine.** So the cheapest possible
version of it lives here, beside the site survey, where the rig already exists and the cost is two
more arm runs.

**This is a committed-then-reverted probe, in exactly the shape Step 2 already uses**, not a runtime
switch — Decision 3 declined that and the reason still holds. On a committed tree, change
`junctionAdmitsOne`'s body to `isJunctionCell(state, cell) && !HOT_CELLS.has(cell)` with `HOT_CELLS`
the junction-eligible hot cells Step 3a printed; drive the arm; record; restore with an `&&`-chained
command; verify `git status --porcelain` is empty as part of the same chain.

Record three rows, from **one sitting on one rig**:

| row | what | reproduce |
|---|---|---|
| control | the shipped arm, no exemption | **368** trips, 29,267 blocked, death 21,783 |
| all junction-eligible hot cells exempted | the reachable ceiling | between **394** and **750** — see below |
| the two highest-ranked cells only | what one card buys | **394** trips, +7.1 % |

**Assert, with the margin stated before running:** the all-cells row's trips exceed the control's by
at least **25 %**. That threshold is deliberately far below the spike's +103.8 %, for a reason that
must be stated rather than absorbed: **the spike's 750 was measured by exempting six cells, two of
which can never be seated** (`(13,18)` and `(11,20)`), so the reachable figure is bounded below by the
two-cell 394 (+7.1 %) and above by 750 (+103.8 %) and **is not known**. A criterion set at the
unreachable ceiling would fail on a working board. **Whatever this step measures is the first honest
measurement of the reachable ceiling, and Task 9 Step 11 refines it per cell.**

**If the all-cells row does not beat the control at all, stop and report before Task 4.** That is the
gate the spike was commissioned to install, and it is worth one task rather than eight.

- [ ] **Step 4: Apply the criterion, in writing, before editing anything**

State which arm passes, which criteria each arm failed, and whether the prediction held. **If the prediction did not hold, say so in the report's first line** — a prediction that is quietly replaced by its outcome is worth nothing.

- [ ] **Step 5: Implement the winning arm, behind ONE named predicate**

**Whatever the arm, the shipped rule must be a single named function**, because Task 12 Step 1's reproduce-before-you-contradict step reverts it and a rule smeared across `canEnter` cannot be reverted mechanically.

For **arm B**: add `crossesAt` and `crossesDirections` to `blocking.ts` with the doc above, and change `canEnter`'s junction clause to

```ts
  const other = junctionAdmitsOne(state, cell)
    ? (state.occupancy[occupancySlot(cell, otherLane(lane))] as number)
    : FREE
  const blocked = own !== FREE || (other !== FREE && crossesDirections(dir, crossesAt(state, other)))
  if (!blocked) return EnterOutcome.ENTER_FREE
```

with `crossesDirections(a: number, b: number): boolean` total over `[0, DIR_COUNT)` plus `NO_PREVIOUS_DIR`, fail-closed on the sentinel. **Resolve the turning-occupant question here, in writing**, per the second numbered fact above.

For **arm A**: edit the demo layout, re-bless `3152640907` with the prior value in a comment at **both** its assertion sites, and re-derive `demoLayout.test.ts`'s hand-computed figures rather than re-fitting them.

- [ ] **Step 6: Write the arm's own tests**

Arm B needs, at minimum: a same-axis **opposing** pair admitted at a junction; a crossing pair refused; a **turning occupant** case, named, with whichever answer Step 5 chose asserted; a `NO_PREVIOUS_DIR` occupant refusing (fail-closed) with the fixture's off-manifold posture asserted; and `crossesDirections` tested against **all 64 ordered direction pairs plus both sentinel positions**, with the count asserted against `DIR_COUNT * DIR_COUNT` so a shortened table fails rather than passing quietly.

- [ ] **Step 7: Re-run Task 1's census and INVERT its invariant**

The previous draft said *"the census's 271 is a property of the board, not of the rule, so it must be unchanged by this task"*, and then told the implementer to conclude the definition was wrong if it moved. **That instruction is backwards and it would have redefined the milestone's dating instrument mid-flight to force a wrong number back.** Task 1 Step 12's own doc says the rising edge *"is exactly the event M1f Task 2's rule makes impossible"* — so post-Task-2 the count is **tens, not hundreds**, made up of valve releases and degree promotions, and it **differs between arms**.

The correct invariant, and the one to assert:

> **BOTH censuses on the RULE-DISABLED arm must be unchanged — 271 / 12,780 / five (rule-visible) and
> 232 / 15,001 / six (co-presence). That is the board property**, and it is what Task 2 Step 2's
> revert measures. Each census on each shipped arm is a *measurement of that arm*, expected to be near
> zero, bounded above by valve firings plus degree-promotions, and expected to differ between arm A
> and arm B. Record all six numbers; assert only the two rule-disabled ones against literals.

- [ ] **Step 8: Repair BOTH allocation harnesses, by re-siting rather than by editing literals**

- `demoAllocation.test.ts`: raise the margin assertion to 10 %, re-derive `TICKS_PER_FRAME` (`(endTick − 1200) / framesDriven`, currently 0.5009 and measured under the old rule), and update the three knob-mutation rows in its comment (`WINDOW_COUNT` 3 → 4, `PROFILED_FRAMES` → 2000, `PROFILED_FRAMES` → 3100) **by running each**, not by scaling the old ones. The discrimination proof at lines 362-367 must still hold: each knob must fail on a *different* assertion.
- `allocation.test.ts`: `M1E_FIRST_WINDOW_START`, `M1E_DEATH_TICK` and `M1E_FIRST_OVER_CAPACITY_TICK` are a **re-siting, not a literal edit**. The window's placement is load-bearing — only the third of three windows may contain the first over-capacity tick — and the margin assertion pins `M1E_DEATH_TICK − M1E_END_TICK` exactly. Re-derive all four against the shipped arm's new death tick, **and confirm the nine branch counters are still non-zero inside the new window** before believing it, because a re-sited window that stops entering a branch measures less while reporting clean.

- [ ] **Step 9: Name the knob that saves criterion 1, and extend the fallback**

`demoAllocation.test.ts` puts explicit floors on `PROFILED_FRAMES` (≥ 3000) and `WINDOW_COUNT` (≥ 3) and **no floor at all on `WARMUP_FRAMES`** (1,500). Step 8 may move `WARMUP_FRAMES` and may not move the other two. Arithmetic, so the change is a derivation rather than a search: with `WARMUP_FRAMES` 500, `framesDriven = 9,500`, and at the re-derived ticks-per-frame that is an end tick of ≈**5,959** against arm B's `DEMO_DEATH_TICK` of ≈6,660 — a **10.5 %** margin. The ceiling's premise `WARMUP_FRAMES + 4 * PROFILED_FRAMES > framesToDeath` still holds (12,500 against ≈10,900).

**The one risk, stated and checked:** 500 frames of JIT warm-up instead of 1,500 could charge warm-up allocation to the first profiled window. The minimum over three windows is the existing mitigation; **record the per-window figures, not just the minimum**, and if window 1 is materially above windows 2 and 3, raise `WARMUP_FRAMES` to the largest value that still clears 10 % and say so.

**And extend the fallback sentence in this task's preamble to name criterion 1** — the previous draft's said "if arm B fails criterion 2 or 4", and criterion 1 is the one arm B actually fails as written.

**`WARMUP_FRAMES` binds a second thing and the previous draft named only one.** `demoAllocation.test.ts:595` pins `framesDriven`, which is `WARMUP_FRAMES + WINDOW_COUNT * PROFILED_FRAMES`; moving the warm-up moves that literal too. Re-derive it in the same edit and say so, or the step lands a green suite with one stale pin in it.

- [ ] **Step 10: Run the whole suite green**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS everywhere, no exceptions this time.

- [ ] **Step 11: Mutation-test the winning arm**

Under arm B, at minimum: `crossesDirections` returning `true` always (≥ 1, the same-axis test); returning `false` always (≥ 1, the crossing test); the `NO_PREVIOUS_DIR` clause deleted (≥ 1, fail-closed test); `crossesAt` reading `carRouteCursor` instead of going through `previousLegDir` (≥ 1 — the reconstruction mutant, and it must not be equivalent); **and `d1 === d2` deleted (0 expected, labelled with the `LANE_OF_DIR` derivation, not left bare)**.

- [ ] **Step 12: Commit, naming the arm, the criteria it passed, and the site-survey table**

---

## Task 4: The buffer shape, and a draw that does not touch the RNG — the guard lands before the hazard

**This is the milestone's only shape change.** Every task after it appends behaviour, never shape.

**Observability:** nothing. Five header slots and **one** region, all zero; no code reads any of them until Task 5 (the offer) and Task 9 (the upgrade), and nothing on screen moves. **Eight of the nine goldens move for pure layout; `252514232` (field) does not, because it hashes flow fields rather than the buffer.** Amendment 2 cut this task's byte cost from 1,364 to **980** and its region count from six to one; the golden count is unchanged, because a shape change of any size moves every digest taken over the buffer.

**Files:**
- Modify: `packages/sim/src/state.ts`, `packages/sim/src/regions.ts`, `packages/sim/src/rng.ts`, `packages/shared/src/constants.ts`
- Create: `packages/sim/src/cards.ts`, `packages/sim/test/cards.test.ts`, `packages/sim/test/m1fSplice.ts`, `packages/sim/test/m1fSplice.test.ts`
- Modify: `packages/sim/src/index.ts`, `packages/sim/test/m1eSplice.ts`
- Test/re-bless: `packages/sim/test/determinism.test.ts`, `state.test.ts`, `regions.test.ts`, `loop.test.ts`, `rollback.test.ts`, `cars.test.ts`, `packages/shared/test/constants.test.ts`, `packages/game/test/startingCity.test.ts`, `demoLayout.test.ts`, `integration.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–3.
- Produces, from `@laneways/shared`: `MAX_UPGRADES = 24`. **One constant, not three** — `LIGHT_AXES` and `LIGHT_NO_PENDING` existed only for the metered light's axis machine and Amendment 2 deleted both.
- Produces, all from `packages/sim`:
  - `H_OFFER_A = 13`, `H_OFFER_B = 14`, `H_OFFER_WEEK = 15`, `H_INV_UPGRADES = 16`, `H_UPGRADE_COUNT = 17`, `HEADER_LENGTH = 18` (`state.ts`)
  - `offerPending(state: GameState): boolean`, `offerSlot(state: GameState, slot: number): number` (`state.ts`)
  - **one** region on `GameState`: `upgradeAt` (`Uint8Array`, `cells`) (`regions.ts`)
  - `mixWord(t: number): number` (`rng.ts`)
  - `CARD_NONE = 0`, `CARD_ROAD_TILES = 1`, `CARD_BRIDGE = 2`, `CARD_TUNNEL = 3`, `CARD_ROUNDABOUT = 4`, `CARD_TRAFFIC_LIGHTS = 5`, `CARD_MOTORWAY = 6`, `CARD_JUNCTION_UPGRADE = 7`, `CARD_COUNT = 8`, `OFFER_SLOT_A = 0`, `OFFER_SLOT_B = 1` (`cards.ts`)
  - `offerSeedFor(state, week): number`, `nthSetBit(mask, k): number`, `popCountCards(mask): number`, `pickFromPool(pool, n, word): number`, `drawOfferPair(pool, seed, out: Int32Array): void` (`cards.ts`)
- Task 5 consumes `drawOfferPair` and the header slots; Task 6 consumes `offerPending`; Task 9 consumes `upgradeAt`, `H_INV_UPGRADES` and `H_UPGRADE_COUNT`; Task 11 consumes `CARD_*` and the mask helpers.

**`CARD_TRAFFIC_LIGHTS` keeps id 5 and `CARD_JUNCTION_UPGRADE` is a NEW id 7, and that is a decision rather than an oversight.** §5.10's table is a documented domain of six items and the light is one of them; renaming its id would delete a row from that domain to record a scope change, which is the shape of defect `CARD_ROUNDABOUT` is declared to avoid. So the light stays declared, stays excluded by `CARD_IMPLEMENTED_MASK`, and carries Decision 14's measurement; the upgrade — which is **not** in §5.10's table and is M1f's own substitution, recorded by the §5.6 amendment in Task 9 Step 1 — gets its own id and honours §5.10's *"2 items for 20 tiles"* grant row. `CARD_COUNT` is therefore **8**, the pool bitmask is eight bits wide, and `cards.test.ts`'s exhaustive mask loop runs 256 masks instead of 128.

- [ ] **Step 1: Land the two determinism guards FIRST, and prove them green at HEAD**

Add to `packages/sim/test/determinism.test.ts`'s `RULES` array:

```ts
  {
    name: 'RNG consumption outside rng.ts',
    // The offer draw must be a pure function of `rng[0]` and the week. Measured:
    // ONE `nextRandom` per week boundary moves the greedy arm's death tick
    // 31,456 -> 34,088, freezes `spawn.test.ts` at 2,640,000 and fails Gate C.
    // `spawn.ts` already reads the word without advancing it, for the same reason
    // and with the reason at the site.
    re: /\b(?:nextRandom|randomBelow)\s*\(/,
    why: 'a consumer that draws on a schedule couples every later draw to that schedule',
    hits: ['const v = nextRandom(state.rng, 0)', 'randomBelow (store, 0, 6)'],
    // **These MUST NOT match the regex above.** The previous draft's second entry
    // was `'export function nextRandom(store, i)'`, which matches its own rule and
    // turns the RULES meta-test red on the first run — and the hazard is that an
    // implementer narrows the regex to make it green, disarming the guard.
    misses: ['const v = mixWord(state.rng[0] as number)', 'offerSeedFor(state, week)'],
  },
```

This rule must exempt `sim/src/rng.ts`, which defines both. Follow `flowfield.ts`'s exemption exactly:
a separate `describe` with its own filtered file list, an assertion that the filter excludes
**exactly** `sim/src/rng.ts` and nothing else, and an assertion that `rng.ts` itself **does** contain
a hit so the exclusion is proved non-vacuous.

Add a second, behavioural guard:

```ts
  it('a full multi-week run never advances state.rng[0]', () => {
    const rig = bootCity()
    const before = rig.s.rng[0] as number
    for (let t = 0; t < TICKS_PER_WEEK * 3; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.rng[0], 'the seed word is read, never consumed').toBe(before)
    // Vacuity: a run that did nothing would satisfy this trivially.
    expect(rig.s.header[H_TICK]).toBe(TICKS_PER_WEEK * 3)
    expect(rig.s.header[H_HOUSE_COUNT], 'and the spawner really ran').toBeGreaterThan(3)
  })
```

- [ ] **Step 2: Run both guards at HEAD and confirm GREEN**

Run: `pnpm --filter @laneways/sim test -- determinism`
Expected: **PASS**, including the `RULES` meta-test that checks every `misses` entry is clean. The guard is landing before the hazard, so it must be satisfied by the tree that does not yet contain the thing it guards. Then prove its teeth: temporarily add `const v = nextRandom(state.rng, 0)` to `week.ts`, re-run, watch **both** the scan and the invariance test go red, and revert (commit first; chain the restore and its report with `&&`).

- [ ] **Step 3: Commit the guards alone**

```bash
git add packages/sim/test/determinism.test.ts
git commit -m "test(sim): ban RNG consumption outside rng.ts, and pin rng[0] invariance

Landed before the code that could violate it. One nextRandom per week boundary
moves the greedy death tick 31,456 -> 34,088 and freezes spawn.test.ts at
2,640,000; the offer draw two tasks from now must be a pure function of the seed
word and the week. Both guards are green at this commit and their teeth were
proved by a reverted injection into week.ts.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8"
```

- [ ] **Step 4: Extract `mixWord` from `nextRandom` with byte-identical output**

`nextRandom`'s current body is `let t = (store[i] = ...)` followed by exactly the three statements
`mixWord` will own, so the extraction is a move rather than a rewrite:

```ts
/**
 * mulberry32's OUTPUT TRANSFORM, with no state. `nextRandom` is exactly this
 * applied to the advanced word.
 *
 * **Extracted at M1f Task 4 so there is one copy of this arithmetic rather than
 * two.** The weekly offer needs a well-mixed value from the seed word and the
 * week WITHOUT advancing the stream — see `offerSeedFor` (cards.ts) and
 * `determinism.test.ts`'s ban on `nextRandom` outside this file.
 *
 * **The extraction is output-preserving and `rng.test.ts`'s sequence golden is
 * the proof**, not this comment: the previous body assigned the advanced word to
 * a local and applied these three statements to it in place, which is what this
 * function does to its parameter.
 */
export function mixWord(t0: number): number {
  let t = t0 >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return (t ^ (t >>> 14)) >>> 0
}

export function nextRandom(store: Uint32Array, i: number): number {
  assertStreamIndex(store, i)
  const t = (store[i] = (((store[i] as number) + 0x6d2b79f5) | 0) >>> 0)
  return mixWord(t)
}
```

Add to `packages/sim/test/rng.test.ts`:

```ts
  it('mixWord is exactly the transform nextRandom applies to its advanced word', () => {
    const store = new Uint32Array([12345])
    const advanced = ((12345 + 0x6d2b79f5) | 0) >>> 0
    expect(nextRandom(store, 0)).toBe(mixWord(advanced))
    expect(store[0], 'and nextRandom advanced the store while mixWord touched nothing').toBe(advanced)
  })
```

Run: `pnpm --filter @laneways/sim test -- rng`
Expected: PASS, including the existing sequence golden. **If the sequence golden moves, the extraction is not output-preserving — stop.**

- [ ] **Step 5: Add the ONE sizing constant to `@laneways/shared`**

```ts
/**
 * How many junction upgrades one run may place on the board.
 *
 * **Derived, not chosen.** §5.10 grants 2 items per card and the card is offered
 * once per week. The longest death tick across the eight measured `RUN_SEED`
 * values is 51,275, which is 11 whole weeks at `TICKS_PER_WEEK`, so no run this
 * project has measured can be granted more than 22. 24 is that bound plus one
 * card's worth of slack. `applyPlaceUpgrade` refuses with `'capacity'` at the cap
 * rather than dropping silently, and M1f Task 12 asserts
 * `2 * maxBoundaries <= MAX_UPGRADES` on the eight-seed sweep so the derivation
 * cannot rot.
 *
 * **It sizes NOTHING, and that is new at M1f Amendment 2.** The earlier design
 * was a metered traffic light with a five-column prefix-packed table of this many
 * rows, and `lightAt` held `slot + 1` — so this constant bounded a region and
 * `MAX_LIGHTS < 255` was a real width constraint. An upgrade is one bit per cell:
 * `upgradeAt` holds 0 or 1, there is no table, and this is a **pure placement
 * cap**. The `< 255` assertion is deleted with the index it guarded.
 *
 * **And on the board that ships it is 3x larger than anything reachable.** Only
 * four week boundaries occur before death, so at most 8 upgrades can ever be
 * granted. The derivation above comes from run lengths M1f Task 2 deletes. The cap
 * is kept because it is cheap and because M1g may lengthen runs again, but **no
 * task may cite it as a binding constraint.**
 *
 * **A global constant rather than a per-map layout size**, because it is a
 * property of §5.10's grant rate and the week clock and not of the board. A
 * `maxUpgrades` field on `MapData` would fold into `mapIdHash` and move every
 * whole-buffer golden a second time.
 */
export const MAX_UPGRADES = 24
```

Add it to `constants.test.ts`'s `ALL` registry with an exact-value assertion. **No tier assertion is
needed and none should be invented**: `upgradeAt` is a flag, `H_INV_UPGRADES` and `H_UPGRADE_COUNT`
are `Int32`, and M1f declares no counter with a cap.

- [ ] **Step 6: Write the failing tests for the draw, including the SHORT POOL**

Create `packages/sim/test/cards.test.ts`:

```ts
describe('the offer draw is a pure function of the seed word and the week', () => {
  it('does not touch rng[0]', () => {
    const s = createState('laneways-m2', firstCity())
    const before = s.rng[0] as number
    offerSeedFor(s, 1)
    offerSeedFor(s, 2)
    expect(s.rng[0]).toBe(before)
  })

  it('gives a different word for each week, and the same word for the same week', () => {
    const s = createState('laneways-m2', firstCity())
    const w1 = offerSeedFor(s, 1)
    expect(offerSeedFor(s, 1), 'idempotent').toBe(w1)
    const seen = new Set<number>()
    for (let w = 1; w <= 40; w++) seen.add(offerSeedFor(s, w))
    expect(seen.size, '40 weeks, 40 distinct words').toBe(40)
  })

  it('avalanches: adjacent weeks differ in at least a third of their bits', () => {
    // The bare xor would give a different word too, so "different" is not enough
    // to pin `mixWord`. This is.
    const s = createState('laneways-m2', firstCity())
    for (let w = 1; w <= 20; w++) {
      const a = offerSeedFor(s, w)
      const b = offerSeedFor(s, w + 1)
      let bits = 0
      let x = (a ^ b) >>> 0
      while (x !== 0) { bits += x & 1; x >>>= 1 }
      expect(bits, `weeks ${w} and ${w + 1} differ in ${bits} bits`).toBeGreaterThan(10)
    }
  })

  it('gives a different word for a different seed at the same week', () => {
    const a = createState('laneways-m2', firstCity())
    const b = createState('some-other-seed', firstCity())
    expect(offerSeedFor(a, 1)).not.toBe(offerSeedFor(b, 1))
  })
})

describe('nthSetBit and popCountCards', () => {
  it('agrees with a brute-force scan on every mask a CARD_COUNT-bit pool can hold', () => {
    for (let mask = 0; mask < 1 << CARD_COUNT; mask++) {
      const bits: number[] = []
      for (let b = 0; b < CARD_COUNT; b++) if ((mask & (1 << b)) !== 0) bits.push(b)
      expect(popCountCards(mask), `popcount of ${mask}`).toBe(bits.length)
      for (let k = 0; k < bits.length; k++) {
        expect(nthSetBit(mask, k), `bit ${k} of ${mask}`).toBe(bits[k])
      }
    }
  })

  it('throws rather than returning a plausible index when k is past the end', () => {
    expect(() => nthSetBit(0b0110, 2)).toThrow(/only 2 set bits/)
    expect(() => nthSetBit(0, 0)).toThrow(/only 0 set bits/)
  })
})

describe('drawOfferPair', () => {
  const out = new Int32Array(2)

  it('draws two DISTINCT cards from the pool', () => {
    const pool = (1 << CARD_ROAD_TILES) | (1 << CARD_JUNCTION_UPGRADE) | (1 << CARD_BRIDGE)
    for (let seed = 0; seed < 500; seed++) {
      drawOfferPair(pool, seed, out)
      expect(out[0], `seed ${seed}`).not.toBe(out[1])
      expect((pool & (1 << (out[0] as number))) !== 0, `seed ${seed} slot A in pool`).toBe(true)
      expect((pool & (1 << (out[1] as number))) !== 0, `seed ${seed} slot B in pool`).toBe(true)
    }
  })

  it('reaches both orders on a two-card pool, which is the shipped case', () => {
    const pool = (1 << CARD_ROAD_TILES) | (1 << CARD_JUNCTION_UPGRADE)
    let aFirst = 0
    for (let seed = 0; seed < 200; seed++) {
      drawOfferPair(pool, seed, out)
      if (out[0] === CARD_ROAD_TILES) aFirst++
    }
    // The only randomness the shipped pool has is the ORDER, and without it a
    // player learns "slot A is always tiles" in two weeks. A hard bound rather
    // than a proportion: 200 draws that all come out the same way is the defect.
    expect(aFirst, 'both orders occur').toBeGreaterThan(20)
    expect(aFirst, 'both orders occur').toBeLessThan(180)
  })

  it('covers every card of a four-card pool across enough draws', () => {
    const pool =
      (1 << CARD_ROAD_TILES) | (1 << CARD_JUNCTION_UPGRADE) | (1 << CARD_BRIDGE) | (1 << CARD_TUNNEL)
    const seen = new Set<number>()
    for (let seed = 0; seed < 400; seed++) {
      drawOfferPair(pool, seed, out)
      seen.add(out[0] as number)
      seen.add(out[1] as number)
    }
    expect(seen.size, 'the rejection path reaches every card, not just the low bits').toBe(4)
  })

  it('is deterministic: the same seed and pool give the same pair', () => {
    const pool = (1 << CARD_ROAD_TILES) | (1 << CARD_TRAFFIC_LIGHTS) | (1 << CARD_BRIDGE)
    drawOfferPair(pool, 987654, out)
    const first = [out[0], out[1]]
    drawOfferPair(pool, 987654, out)
    expect([out[0], out[1]]).toEqual(first)
  })

  it('THROWS on a pool with fewer than two cards — and this throw must be unreachable from runOffer', () => {
    // Kept as a throw because reaching it means `runOffer`'s guard is gone, which
    // is a programming error and a plausible fallback would hide it. What must
    // never happen is `step` reaching it: see `runOffer`'s degradation (Task 5)
    // and `capabilityMask`'s map-only inputs (Task 11). The previous draft had
    // this throw with no guard in front of it, and on the state golden's 4x4 map
    // it fired at tick 4,500 of a 13,499-tick fixture, AFTER `step` had written
    // `H_EPOCH` — poisoning the buffer permanently.
    expect(() => drawOfferPair(1 << CARD_ROAD_TILES, 1, out)).toThrow(/needs at least two/)
    expect(() => drawOfferPair(0, 1, out)).toThrow(/needs at least two/)
  })

  it('allocates nothing', () => {
    const pool = (1 << CARD_ROAD_TILES) | (1 << CARD_JUNCTION_UPGRADE)
    expect(drawOfferPair(pool, 1, out)).toBeUndefined()
  })
})
```

- [ ] **Step 7: Run them to verify they fail; then write `cards.ts`'s draw half**

Run: `pnpm --filter @laneways/sim test -- cards`
Expected: FAIL, "Cannot find module '../src/cards'".

```ts
import { mixWord } from './rng'
import { H_WEEK, type GameState } from './state'

/**
 * §5.10's card pool, its non-consuming weekly draw, and the `choose-card` input.
 * **The offer slots live in the header and this module is their only writer.**
 *
 * Card ids are the SIX in §5.10's table plus **one M1f adds**, declared in full
 * rather than only the two M1f can offer, because they are an enumeration of a
 * documented domain rather than speculative configuration. What keeps the five
 * unimplemented ones out of play is `CARD_IMPLEMENTED_MASK` (M1f Task 11) — a
 * scope gate with a named owner — and not their absence.
 *
 * **`CARD_ROUNDABOUT` is one of the five, and it is declared for a specific
 * reason.** M1f measured that on the shipped board five of the six cells that
 * actually jam admit no legal 3x3 roundabout centre at any tick, so the item was
 * removed from the milestone rather than from the domain. M1g owns the geometry
 * question; the id costs nothing and its absence would read as a decision nobody
 * made.
 *
 * **`CARD_TRAFFIC_LIGHTS` is another, for the same shape of reason and a
 * different measurement.** M1f built §5.6's demand-actuated light in a throwaway
 * spike and measured it against its own control: a fixed alternating light scores
 * -13 % on trips at its best seat phase and -17 % at the median, and this
 * milestone's own specified controller scores -38 %, because
 * `minimumNearbyCarsBeforeSwapping` = 2 within 2 tiles is essentially never
 * satisfied on a board carrying about eleven cars in flight. The light is
 * deferred to M1g with those numbers; `CARD_JUNCTION_UPGRADE` is what M1f ships
 * in its place.
 *
 * `CARD_NONE = 0` is load-bearing: `H_OFFER_A`/`H_OFFER_B` are zero-initialised
 * and must read as "no offer" without `createState` writing a sentinel.
 */

export const CARD_NONE = 0
export const CARD_ROAD_TILES = 1
export const CARD_BRIDGE = 2
export const CARD_TUNNEL = 3
export const CARD_ROUNDABOUT = 4
export const CARD_TRAFFIC_LIGHTS = 5
export const CARD_MOTORWAY = 6
/**
 * M1f's own item, and the only one here that is NOT a row of spec §5.10's table.
 *
 * §5.6's TRAFFIC LIGHT is id 5 above, declared and excluded by
 * `CARD_IMPLEMENTED_MASK` like the roundabout, because M1f built it, measured it
 * and deferred it (M1f plan, Amendment 2 and Decision 14: a fixed light measures
 * -13 % against its control and this plan's own demand controller -38 %, on a
 * board carrying about eleven cars in flight). A JUNCTION UPGRADE takes its place
 * in the pool and its grant row - "2 items for 20 tiles" - and does one thing:
 * the junction mutual-exclusion rule does not apply at its cell.
 *
 * It is a NEW id rather than a rename of 5, so §5.10's documented six-item domain
 * stays intact and the deferral reads as an interlock rather than an absence.
 */
export const CARD_JUNCTION_UPGRADE = 7
/** One past the highest card id. The pool bitmask is `CARD_COUNT` bits wide; bit 0 is never set. */
export const CARD_COUNT = 8

export const OFFER_SLOT_A = 0
export const OFFER_SLOT_B = 1

/**
 * A well-mixed word for `week`'s offer, derived from the seed **without
 * advancing it**.
 *
 * The golden-ratio odd constant decorrelates adjacent weeks before mixing, so
 * weeks 1 and 2 do not produce neighbouring inputs to a function that is only an
 * avalanche and not a stream. `week + 1` rather than `week` so week 0 — which has
 * no offer — is not the identity case.
 *
 * **Why not `nextRandom`:** measured, one draw per week boundary moves the greedy
 * arm's death tick 31,456 -> 34,088, freezes `spawn.test.ts` at 2,640,000 and
 * fails Gate C, because every downstream consumer shifts by one. `spawnScanStart`
 * (spawn.ts) reads the word the same way for the same reason.
 * `determinism.test.ts` bans the alternative outright.
 */
export function offerSeedFor(state: GameState, week: number): number {
  return mixWord(((state.rng[0] as number) ^ Math.imul(week + 1, 0x9e3779b1)) >>> 0)
}

/** How many cards a pool bitmask holds. */
export function popCountCards(mask: number): number {
  let n = 0
  for (let b = 0; b < CARD_COUNT; b++) if ((mask & (1 << b)) !== 0) n++
  return n
}

/**
 * The `k`-th set bit of `mask`, counting from 0.
 *
 * Throws rather than returning -1 or 0: a caller that has already asked
 * `popCountCards` cannot legitimately be past the end, and both plausible
 * sentinels are valid card ids or read as one (`CARD_NONE`).
 */
export function nthSetBit(mask: number, k: number): number {
  let seen = 0
  for (let b = 0; b < CARD_COUNT; b++) {
    if ((mask & (1 << b)) === 0) continue
    if (seen === k) return b
    seen++
  }
  throw new Error(`cards: asked for set bit ${k} of pool ${mask}, which has only ${seen} set bits`)
}

/**
 * Fills `out[0]`/`out[1]` with two DISTINCT card ids drawn from `pool`.
 *
 * **Rejection sampling, over a bitmask, with no array.** A plain modulo
 * over-represents the low card ids whenever the pool size does not divide 2^32,
 * and a skewed offer distribution is invisible in play while quietly invalidating
 * every balance measurement built on it. `no-module-mutable-state` forbids a
 * module-scope candidate array and a local one allocates on a per-tick path, so
 * the pool IS the array and `nthSetBit` is the index.
 *
 * Successive words come from re-mixing the previous one, so the rejection loop
 * needs no counter and no storage. The loop terminates because `mixWord` is a
 * bijection on 32 bits and at most `2^32 % n` of the inputs are rejected.
 *
 * `out` is caller-owned and length 2. Slot A is drawn first from the whole pool;
 * slot B from the pool with A's bit cleared, which is what makes the two distinct
 * **by construction** rather than by a retry loop that could spin.
 *
 * **The `n < 2` throw is a programming-error guard and `runOffer` must never
 * reach it.** See `runOffer`'s degradation and `capabilityMask`'s map-only
 * inputs: a throw inside `step` after `H_EPOCH` is written poisons the buffer
 * permanently, which is what the previous design did on a 4x4 golden fixture.
 */
export function drawOfferPair(pool: number, seed: number, out: Int32Array): void {
  const n = popCountCards(pool)
  if (n < 2) {
    throw new Error(`cards: an offer needs at least two cards, and pool ${pool} holds ${n}`)
  }
  let word = seed >>> 0
  const a = pickFromPool(pool, n, word)
  out[0] = a
  word = mixWord(word)
  const rest = pool & ~(1 << a)
  out[1] = pickFromPool(rest, n - 1, word)
}

/**
 * One unbiased card from `pool`, which holds exactly `n` cards, starting from
 * `word`. Exported for the rejection path's own test — the bound at which
 * rejection actually happens is unreachable from `drawOfferPair`'s two- to
 * six-card pools in any realistic number of draws.
 */
export function pickFromPool(pool: number, n: number, word: number): number {
  const limit = 0x100000000 - (0x100000000 % n)
  let v = word >>> 0
  while (v >= limit) v = mixWord(v)
  return nthSetBit(pool, v % n)
}
```

Run: `pnpm --filter @laneways/sim test -- cards`
Expected: PASS.

Add `'sim/src/cards.ts'` to `determinism.test.ts`'s sorted file list with a comment saying why a new file must be added deliberately. Re-run the determinism suite.

- [ ] **Step 8: Declare the five header slots**

`packages/sim/src/state.ts`:

```ts
/**
 * The card offered in slot A this week, or `CARD_NONE`. Written only by
 * `runOffer` (cards.ts), read only through `offerSlot` below.
 */
export const H_OFFER_A = 13
/** The card offered in slot B. Always a different card from `H_OFFER_A`. */
export const H_OFFER_B = 14
/**
 * The week whose offer has been RESOLVED — i.e. whose card the player took, or
 * which was skipped because the pool was too short to offer from.
 *
 * **This one slot is the whole mechanism for BOTH "one card per week" and
 * "already chosen this week", and a second flag would be a defect rather than a
 * clarification.** With two flags — "an offer exists" and "it has been taken" —
 * neither half can have a detector of its own, because either alone upholds the
 * invariant; a mutation table would then show two survivors that are not coverage
 * holes. One flag, one meaning, one test.
 *
 * Zero-initialised is correct with no write in `createState`: it means week 0,
 * and week 0 has no offer, so "resolved through week 0" and "nothing resolved
 * yet" are the same statement.
 */
export const H_OFFER_WEEK = 15
/**
 * Junction upgrades held and not yet placed (§2.2's inventory). `Int32`, so the
 * `Uint8Array`-decrement wrap class does not apply — and it IS decremented, in
 * `applyPlaceUpgrade` (upgrades.ts, M1f Task 9).
 *
 * **May exceed `MAX_UPGRADES`.** §2.2 permits holding items indefinitely, and the
 * cap is on upgrades ON THE BOARD, not on upgrades in hand; `applyPlaceUpgrade`
 * refuses with `'capacity'`.
 */
export const H_INV_UPGRADES = 16
/**
 * How many upgrades are placed on the board.
 *
 * **It indexes nothing.** The previous design was a metered light with a
 * prefix-packed table and this slot was that table's length; `upgradeAt` is one
 * flag per cell, so this is a COUNT and its only jobs are `canPlaceUpgrade`'s
 * `capacity` refusal and the HUD. Task 12 Step 5 asserts it equals the number of
 * non-zero entries in `upgradeAt`, in both directions, so it cannot drift from
 * the flag array it summarises.
 */
export const H_UPGRADE_COUNT = 17
export const HEADER_LENGTH = 18
```

and the two accessors, in the idiom `isGameOver`/`failedDestination` already set:

```ts
/**
 * Is a card offer waiting for the player?
 *
 * Read by `runOffer` (to decide whether to raise one), by `applyChooseCard` (to
 * no-op a duplicate) and by `game`'s frame driver (to raise the pause). Week 0 is
 * excluded because the first boundary is the START of week 1.
 */
export function offerPending(s: GameState): boolean {
  const week = s.header[H_WEEK] as number
  return week > 0 && (s.header[H_OFFER_WEEK] as number) !== week
}

/**
 * The card in slot 0 or 1, or "no card" when no offer is pending — so no caller
 * can read a stale card off a resolved week. Same construction as
 * `failedDestination`'s -1, and for the same reason.
 *
 * **`applyChooseCard` deliberately does NOT clear `H_OFFER_A`/`H_OFFER_B`**, so
 * this guard is the only thing standing between a resolved week and a frame that
 * shows last week's card forever. Every reader goes through here.
 *
 * **Returns the literal `0` rather than `CARD_NONE`, and that is not sloppiness:**
 * `cards.ts` imports `H_WEEK` from this module, so importing `CARD_NONE` back
 * would be an import cycle. `cards.test.ts` asserts `CARD_NONE === 0` beside the
 * declaration so the two cannot drift.
 */
export function offerSlot(s: GameState, slot: number): number {
  if (!offerPending(s)) return 0
  if (slot === 0) return s.header[H_OFFER_A] as number
  if (slot === 1) return s.header[H_OFFER_B] as number
  throw new Error(`state: offer slot ${slot} is not 0 or 1`)
}
```

- [ ] **Step 9: Declare the ONE upgrade region**

`packages/sim/src/regions.ts`. **Placement is load-bearing** — appended to the end of the `Uint8`
tier, which is the end of the buffer, so no pad byte can appear and `m1fSplice.ts` can compute a
contiguous tail range:

- **1-byte tier, appended after `ghostCommitted`:** `upgradeAt`, `Uint8Array`, `cells`.

**The 2-byte tier gains nothing and the 4-byte tier gains nothing but the header's five slots.** The
previous draft added six regions across all three tiers for a metered light's phase, clock, axis and
four per-axis idle counters; Amendment 2 deleted every one of them.

With this comment on the block:

```ts
    // M1f Task 4. **ONE region, appended to the end of the last tier, and that
    // is what keeps the padding at zero**: the 4-byte tier goes 1,824 -> 1,844 B
    // (a multiple of 4), the Int16 tier is UNCHANGED at 4,320, the Uint8 tier goes
    // 7,848 -> 8,808, and the total 13,992 -> 14,972 is a multiple of 4 — so
    // `computeLayout` inserts no pad byte and `regions.test.ts`'s zero-padding
    // assertion still holds. Verify by running `computeLayout`, not by trusting
    // this comment.
    //
    // **ONE APPEND and one mid-buffer INSERTION** — the header's five new slots,
    // landing in the same commit, grow a region in the middle of the 4-byte tier.
    // `m1fSplice.ts` depends on knowing which is which, and it has TWO ranges:
    // the header's slots, and this tail. (An earlier draft of this milestone had
    // four ranges, because its relief object added a tail to every tier.)
    //
    // `upgradeAt` is a FLAG, not an index: 1 means "the junction mutual-exclusion
    // rule does not apply at this cell", 0 means it does, and 0 is the correct
    // initial value with no write in `createState`. `canEnter` reaches it in one
    // array read through `junctionAdmitsOne` (graph.ts) and that read IS the
    // whole entry rule of M1f's relief object.
    //
    // **It owns no timer and no phase.** The previous design's `lightSince` and
    // `lightIdle` were Int16 because their caps were above 255; there is nothing
    // here to cap. If a later milestone gives an upgraded junction a schedule,
    // that is a new region and a new shape change, and it must not be smuggled
    // into this byte by widening it.
    //
    // FIELD_IRRELEVANT. A junction upgrade changes a car's right to ENTER a cell
    // and nothing else — not its SPEED through one (`isJunctionCell` is
    // unchanged, so `INTERSECTION_SPEED_MUL` still applies) and never the distance
    // of a step. Routing is upgrade-blind for exactly the reason it is
    // congestion-blind — see the 2026-08-21 amendment to spec §5.4. Note that this
    // is the very region the five FIELD_IRRELEVANT reasons above were dated
    // against ("M1f's demand-actuated lights"), and the relief object shipped
    // without making one of them a field input.
```

Add `upgradeAt` to `FIELD_IRRELEVANT_REGIONS` (24 → 25) and to `REGION_FIELD_NAMES` in `state.ts`
(29 → 30), in layout order.

**And close `viewsOver`'s one-directional check while here.** It throws for a name in
`REGION_FIELD_NAMES` with no layout entry, and never for a layout entry with no name — so a region
declared in `regions.ts` alone is laid out and hashed while its `GameState` field is `undefined`
until `tsc` notices. Add the converse:

```ts
    // The converse of the check above, added at M1f Task 4 because this task
    // declares a region and five header slots at once and a typo in a name would
    // otherwise surface as a hash change with no failing assertion.
    for (const e of layout.entries) {
      if (!REGION_FIELD_NAMES.includes(e.name)) {
        throw new Error(`state layout: region "${e.name}" is laid out but is not in REGION_FIELD_NAMES`)
      }
    }
```

- [ ] **Step 10: Extend the splice proof, in TWO directions**

Create `packages/sim/test/m1fSplice.ts`, in `m1eSplice.ts`'s shape, exporting `m1fInsertedRanges(map)`
returning the **two** M1f ranges — the header's five new slots (`header.offset + 13 * 4` to
`header.offset + 18 * 4`) and the `Uint8` tail (`upgradeAt.offset` to `totalBytes`) — with structural
guards, each throwing by name, each reachable from a synthetic layout, and each fed a violation in
`m1fSplice.test.ts`:

- `header.len === HEADER_LENGTH`;
- `upgradeAt` is the **last entry of the layout**;
- the tail range runs to `totalBytes` exactly, with no trailing pad;
- both ranges non-empty, disjoint, in ascending order, inside `totalBytes`.

**Two ranges, not four, and say so at the site**: the previous draft's relief object appended a tail
to the 4-byte and `Int16` tiers as well, and an implementer working from a stale memory will write
guards for tails that do not exist and get a throw they cannot explain.

**And repair `m1eSplice.ts`, which this task silently breaks.** Its block A is
`header.offset + M1D_HEADER_LENGTH * 4 .. header.offset + HEADER_LENGTH * 4`, and `HEADER_LENGTH` is
now 18, so it would splice out M1f's slots as well and "prove" the pre-M1e digest for the wrong
reason. Freeze its upper bound:

```ts
/** `HEADER_LENGTH` as M1e closed it. M1f's slots are `m1fSplice.ts`'s, not this file's. */
export const M1E_HEADER_LENGTH = 13
```

and add the `upgradeAt` tail as a further block, so the composed splice still reproduces the pre-M1e
digest. Assert `M1E_HEADER_LENGTH < HEADER_LENGTH` in `m1eSplice.test.ts`, so the day a task grows the
header without reading this file, it fails here.

- [ ] **Step 11: Re-bless the eight goldens, each with its splice proof and its direct assertion**

At **each** of the ten assertion sites (`968680755` has two), in one commit:

1. update the literal, with a re-bless comment naming the prior value and the reason, in the form `determinism.test.ts` already uses;
2. add `expect(hashBytes(spliceM1fInsertions(s, MAP))).toBe(<prior digest>)` beside it — **the ranges are computed from that fixture's OWN map**, because the re-blessed fixtures run on five different maps and quoting one map's offsets at another's site reads as a fabricated derivation;
3. update the cross-file literal scan in `loop.test.ts`, which reads `determinism.test.ts` and `rollback.test.ts` off disk and asserts three literals verbatim — **one of which is the field golden and must not change**;
4. update `state.test.ts`'s *"HEADER_LENGTH is exactly 13"* to 18 — this test **must** go red and be re-derived, not widened;
5. update `regions.test.ts`: `totalBytes` (13,992 → **14,972**), the ordered region-name list, the per-region element counts and the FIELD_INPUT exact-set pin. The parameterised staleness test needs no update and is doing real work for free — it pokes one byte of **every declared region** and asserts `hashFieldInputRegions` moves iff that region is FIELD_INPUT, so `upgradeAt` is covered the moment it is declared;
6. update the prose sites that quote a retired digest and that no test reads: grep the whole repo for each prior digest and fix every hit. **A stale digest in a comment passes every test and reads as verified.**

- [ ] **Step 12: Assert the behavioural observables unchanged, in the same commit**

The third class of re-bless carries no behavioural claim, so it must borrow one. In
`packages/game/test/integration.test.ts`, in the same commit, assert the greedy arm's death tick, trip
count and `H_ROUTES_REFUSED` are **exactly** what **Task 3** left them at. **Without this the re-bless
is a blank cheque**: a genuine regression landing in this commit is absorbed with no trace.

**Note for Task 7's implementer, and for whoever reviews this step later:** these three values are
re-based again at Task 7, when frame-driven arms acquire a card policy and start receiving
`CARD_GRANT_*` on top of `WEEKLY_TILE_GRANT`. That is expected, it is named in Task 7 Step 6, and it
is why this step asserts against Task 3's recorded values by name in the commit message rather than
inviting a reader to treat the literals as permanent.

- [ ] **Step 13: Re-measure the eight `yes` cells by DIGEST, not by red test**

Several golden tests abort on a buffer-length pin sitting **above** their `expect(hashState(...))`
line. Relax those pins, re-run, and record the digest each fixture actually produces. **A `no` needs
no re-check; every `yes` does.** Confirm `252514232` is green and untouched.

- [ ] **Step 14: Run the whole suite green**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS.

- [ ] **Step 15: Mutation-test**

| # | Mutant | Expected |
|---|---|---|
| 1 | `offerSeedFor`: drop `^ Math.imul(week + 1, …)` | ≥ 1, in *"40 weeks, 40 distinct words"* |
| 2 | `offerSeedFor`: `week + 1` → `week` | **0 expected** — week 0 has no offer, so the identity case is unreachable. Record as deliberate; the `+ 1` is there so the function is total |
| 3 | `offerSeedFor`: `mixWord(...)` → the raw xor | ≥ 1, in the avalanche test (which exists for exactly this mutant — *"a different word"* alone would not have caught it) |
| 4 | `drawOfferPair`: draw B from `pool` instead of `rest` | ≥ 1, in *"two DISTINCT cards"* |
| 5 | `drawOfferPair`: do not re-mix between A and B | ≥ 1 — with the same word both picks correlate; the two-card order test is the detector |
| 6 | `pickFromPool`: `v % n` with no rejection | **likely 0** at these pool sizes, and that is the honest answer. Record it, and note that the rejection path's justification is the bias argument rather than a detector — the same shape as `randomBelow`'s own |
| 7 | `nthSetBit`: `seen === k` → `seen >= k` | ≥ 1, in the exhaustive agreement test |
| 8 | `nthSetBit`: return -1 instead of throwing | ≥ 1, in the past-the-end test |
| 9 | `offerPending`: drop `week > 0` | ≥ 1 — a week-0 offer would raise the modal before the first boundary |
| 10 | `offerSlot`: return the slot without the pending check | ≥ 1 |
| 11 | `regions.ts`: `upgradeAt` declared `MAX_UPGRADES` instead of `cells` | ≥ 1, in `regions.test.ts`'s per-region element counts **and** in `totalBytes` |
| 12 | `viewsOver`: delete the new converse check | **0 expected today** — every declared region has a name. Add a `m1fSplice.test.ts`-style synthetic layout with an unnamed region so it has a detector, or record it as an unreachable guard with the reason |

- [ ] **Step 16: Commit**

```bash
git add packages/sim packages/shared packages/game
git commit -m "feat(sim): the offer's header slots, one flag per cell, and a draw that reads the seed without spending it

HEADER_LENGTH 13 -> 18 (H_OFFER_A, H_OFFER_B, H_OFFER_WEEK, H_INV_UPGRADES,
H_UPGRADE_COUNT) and ONE region for the relief object: upgradeAt, Uint8, one flag
per cell. firstCity's buffer goes 13,992 -> 14,972 B (+980, +7.00 %) and
regionsFor goes 29 -> 30. This is the milestone's ONLY shape change; every later
task appends behaviour.

An earlier draft of this milestone sized a metered traffic light here: six
regions across three tiers for a phase, a clock, an axis and four per-axis idle
counters, 1,364 bytes, 29 -> 35 regions. That object was built in a throwaway
spike, measured at -13 % to -38 % on trips against its own control, and replaced
by a junction upgrade - which is one bit. Every figure in this commit is
re-derived and none is carried forward.

The header's five slots are a mid-buffer INSERTION and upgradeAt is an APPEND to
the end of the last tier, so no pad byte appears anywhere (1,844 is a multiple of
4, the Int16 tier is unchanged at 4,320, and 14,972 is a multiple of 4) and
m1fSplice.ts computes TWO contiguous ranges rather than four.

MAX_UPGRADES is derived, not chosen: 2 items per card, one card per week, and the
longest of the eight measured seeds is 11 weeks. It sizes nothing - upgradeAt is
a flag - and on the board that ships only 8 upgrades are obtainable, so no task
may cite it as a binding constraint.

CARD_JUNCTION_UPGRADE is a NEW id 7 and CARD_COUNT is 8. CARD_TRAFFIC_LIGHTS
keeps id 5, declared and behind CARD_IMPLEMENTED_MASK with its measurement, so
spec 5.10's documented six-item domain stays intact.

Eight goldens re-blessed for PURE LAYOUT, each with a splice proof over its own
map's ranges beside the digest, and the greedy arm's death tick, trips and
refusals asserted unchanged in this same commit - the third class of re-bless
carries no behavioural claim of its own, so it borrows one. 252514232 (field)
does not move: it hashes flow fields, not the buffer.

The draw is offerSeedFor(state, week) = mixWord(rng[0] ^ imul(week+1, GOLDEN)),
which reads the seed word and never advances it. mixWord is mulberry32's output
transform extracted from nextRandom so there is one copy of that arithmetic.
Selection is rejection over a CARD_COUNT-bit mask with no array. The two guards
that make this a rule rather than a memory landed in the previous commit, green -
including a RULES self-test entry that the previous draft wrote so that it matched
its own regex.

H_OFFER_WEEK === H_WEEK is the SINGLE mechanism for both 'one card per week' and
'already chosen'. applyChooseCard never clears the slots, so offerSlot's pending
guard is the only thing preventing a stale card on every later frame.

viewsOver now checks both directions: a region laid out under a name nothing
declares is a throw rather than an undefined field.

Prior digests: <ten pairs>.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01P7U1VshXa8t3sv8iRHBot8"
```

---

## Task 5: Phase 4 — the offer — and the eleven-phase sweep

**Observability:** nothing a player can see. The offer slots fill at every week boundary from 2:21 onward and nothing draws them until Task 8. Say so; do not let a green suite here read as a shipped feature.

**Files:**
- Modify: `packages/sim/src/cards.ts` (`runOffer`, the interim `poolFor`), `packages/sim/src/step.ts` (the phase and the renumbering), `packages/sim/src/scratch.ts` (`offerPair`)
- Modify: every source file and doc that names a phase number above 3
- Test: `packages/sim/test/cards.test.ts`, `step.test.ts`, `loop.test.ts`, `determinism.test.ts`, `scratch.test.ts`

**Interfaces:**
- Consumes: `drawOfferPair`, `offerSeedFor`, `offerPending`, `popCountCards`, the five header slots (Task 4).
- Produces: `runOffer(state: GameState, world: WorldData, scratch: Scratch): void` and `poolFor(world: WorldData): number`, both exported from `cards.ts`; `Scratch.offerPair: Int32Array` (length 2). `runOffer` matches `runDemand`/`runSpawn`/`runOvercrowd`'s `void` shape and takes `scratch` for the same reason `runSpawn` does. Task 11 gives `poolFor` its capability half; the signature does not change.

- [ ] **Step 1: Write the failing tests for the phase, INCLUDING the degradation**

Add to `packages/sim/test/cards.test.ts`:

```ts
describe('runOffer — phase 4', () => {
  it('raises nothing in week 0', () => {
    const rig = bootCity()
    for (let t = 0; t < 100; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_OFFER_A]).toBe(CARD_NONE)
    expect(rig.s.header[H_OFFER_B]).toBe(CARD_NONE)
    expect(offerPending(rig.s)).toBe(false)
  })

  it('raises an offer on the first tick of week 1 and not before', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK - 1)
    expect(rig.s.header[H_OFFER_A], 'still week 0').toBe(CARD_NONE)
    step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_TICK]).toBe(TICKS_PER_WEEK)
    expect(rig.s.header[H_WEEK]).toBe(1)
    expect(offerPending(rig.s)).toBe(true)
    expect(rig.s.header[H_OFFER_A]).not.toBe(CARD_NONE)
    expect(rig.s.header[H_OFFER_B]).not.toBe(rig.s.header[H_OFFER_A])
  })

  it('matches the pair drawOfferPair gives for this seed and week, computed independently', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const out = new Int32Array(2)
    drawOfferPair(poolFor(rig.world), offerSeedFor(rig.s, 1), out)
    expect(rig.s.header[H_OFFER_A]).toBe(out[0])
    expect(rig.s.header[H_OFFER_B]).toBe(out[1])
  })

  it('is IDEMPOTENT: re-raising the same week rewrites the same pair', () => {
    // This is what lets ONE flag do both jobs, and it is also what makes the
    // up-to-7 ticks between the boundary and the shell's pause landing harmless.
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const a = rig.s.header[H_OFFER_A]
    const b = rig.s.header[H_OFFER_B]
    for (let t = 0; t < 50; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_OFFER_A]).toBe(a)
    expect(rig.s.header[H_OFFER_B]).toBe(b)
  })

  it('replaces an unresolved offer at the next boundary, and the old card is lost', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const week1 = [rig.s.header[H_OFFER_A], rig.s.header[H_OFFER_B]]
    driveTo(rig, TICKS_PER_WEEK * 2)
    expect(rig.s.header[H_WEEK]).toBe(2)
    expect(offerPending(rig.s), 'still pending, now for week 2').toBe(true)
    const out = new Int32Array(2)
    drawOfferPair(poolFor(rig.world), offerSeedFor(rig.s, 2), out)
    expect([rig.s.header[H_OFFER_A], rig.s.header[H_OFFER_B]]).toEqual([out[0], out[1]])
    expect([rig.s.header[H_OFFER_A], rig.s.header[H_OFFER_B]], 'week 1 is gone').not.toEqual(week1)
  })

  it('raises nothing after game over', () => {
    const rig = bootTerminal()
    const before = hashState(rig.s)
    for (let t = 0; t < TICKS_PER_WEEK; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(hashState(rig.s), 'step is a byte-identical no-op past the failure').toBe(before)
  })

  it('writes H_TILES never, so phases 2 and 4 are disjoint by construction', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK - 1)
    const tiles = rig.s.header[H_TILES] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_TILES], 'the boundary granted exactly the weekly tiles').toBe(
      tiles + WEEKLY_TILE_GRANT,
    )
  })

  it('DEGRADES on a pool with fewer than two cards: it resolves the week and does not throw', () => {
    // **This is review Critical 2, closed in the sim rather than argued away.**
    // The previous design called `drawOfferPair` unconditionally, so a short pool
    // threw INSIDE `step`, AFTER `H_EPOCH` had been written — poisoning the
    // buffer permanently, on a golden fixture, at tick 4,500 of 13,499.
    //
    // A throw inside `step` over a map's configuration is never acceptable. This
    // is the second of two independent fixes; the first is that `capabilityMask`
    // reads only immutable terrain and the junction upgrade is capable everywhere (Task 11),
    // so no shipped or fixture map can produce a short pool at all. Belt and
    // braces, deliberately: the previous design had one of the two and it was a
    // bet that lost.
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK - 1)
    const short = withPoolStub(rig, 1 << CARD_ROAD_TILES)   // the test's own seam, not production's
    expect(() => step(short.s, short.world, short.fields, short.scratch, NO_INPUT)).not.toThrow()
    expect(short.s.header[H_EPOCH], 'the buffer is not poisoned').toBe(0)
    expect(short.s.header[H_OFFER_A], 'no card was offered').toBe(CARD_NONE)
    expect(offerPending(short.s), 'and nothing is left pending, so the shell never pauses').toBe(false)
    expect(short.s.header[H_OFFER_WEEK], 'the week is resolved, not skipped-and-retried').toBe(1)
  })
})
```

`withPoolStub` is a **test-only** rig: it drives the same `step` on a world whose terrain has been
built so that `poolFor` returns one card. **Do not add a pool parameter to `runOffer`.** Until Task
11, `poolFor` ignores its `world` argument, so this fixture cannot exist yet — so write this test
now with `it.skip` and a comment naming Task 11 Step 1 as the step that un-skips it, or build the
short-pool world by temporarily narrowing `CARD_IMPLEMENTED_MASK` in a committed-then-reverted probe
and record the result. **State which of those two you did.**

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @laneways/sim test -- cards`
Expected: FAIL — `runOffer` and `poolFor` do not exist.

- [ ] **Step 3: Write `runOffer` and the interim `poolFor`**

In `cards.ts`:

```ts
/**
 * The set of cards this map and this build can offer, as a bitmask.
 *
 * **Two filters with two reasons, and M1f Task 11 lands the first one.** Until
 * then this is the second filter alone: `CARD_IMPLEMENTED_MASK`, M1f's scope
 * boundary. An offerable card with no placement mechanism is dead configuration
 * that reads as support; this constant is the interlock that stops one shipping,
 * and M1g deletes bits from it.
 */
export const CARD_IMPLEMENTED_MASK = (1 << CARD_ROAD_TILES) | (1 << CARD_JUNCTION_UPGRADE)

export function poolFor(world: WorldData): number {
  return CARD_IMPLEMENTED_MASK
}

/**
 * Phase 4 of the tick order: raise this week's card offer (spec §5.10).
 *
 * **Position, and why both bounds are forced.** AFTER phase 3, because a
 * `choose-card` queued on the boundary tick must resolve THIS week's offer before
 * the phase that would raise one. BEFORE phase 5, because nothing downstream may
 * observe a half-raised offer.
 *
 * **It writes the two offer slots and NOTHING else** — except in the degenerate
 * case below, where it writes `H_OFFER_WEEK`. Phase 2 writes `H_TILES`; the
 * card's own tile bonus is paid by `applyChooseCard` in phase 3. So phases 2 and
 * 4 touch disjoint state BY CONSTRUCTION.
 *
 * **Idempotent, and that is load-bearing rather than an optimisation.** The draw
 * is a pure function of `(rng[0], week)`, so re-running it on every tick of an
 * unresolved week writes the same pair. That is what lets `H_OFFER_WEEK ===
 * H_WEEK` be the single mechanism for both "one per week" and "already chosen".
 * It also means the up-to-7 ticks between the boundary and the shell's pause
 * landing (see `game/src/frame.ts`) cannot change what the player is shown.
 *
 * **A POOL OF FEWER THAN TWO RESOLVES THE WEEK AND RAISES NOTHING.** It does not
 * throw. `step` has already written `H_EPOCH` by the time this runs, so a throw
 * here poisons the buffer for the rest of the run — which is exactly what the
 * previous design did on a 4x4 golden fixture whose pool collapsed to one card.
 * Writing `H_OFFER_WEEK` rather than merely returning is deliberate: it leaves
 * NOTHING PENDING, so `game`'s frame driver never pauses the shell behind a modal
 * that has nothing to show. Unreachable on every map this project ships or
 * fixtures — `capabilityMask` grants road tiles and the junction upgrade unconditionally
 * (dossier §2.1: *"roundabouts/lights/motorways everywhere"*) — and it is here
 * because unreachable-by-argument is what the previous design also believed.
 *
 * Nothing here allocates: `scratch.offerPair` is preallocated and `poolFor` is a
 * mask. **The allocation harness structurally cannot see this**, for the same
 * reason it cannot see `runWeekBoundary`'s grant — a handful of events across
 * thousands of driven frames lands under the 4 B/frame floor by construction — so
 * this is an argument, not a measurement, and it is labelled as one.
 */
export function runOffer(state: GameState, world: WorldData, scratch: Scratch): void {
  if (!offerPending(state)) return
  const pool = poolFor(world)
  if (popCountCards(pool) < 2) {
    state.header[H_OFFER_WEEK] = state.header[H_WEEK] as number
    return
  }
  const week = state.header[H_WEEK] as number
  drawOfferPair(pool, offerSeedFor(state, week), scratch.offerPair)
  state.header[H_OFFER_A] = scratch.offerPair[0] as number
  state.header[H_OFFER_B] = scratch.offerPair[1] as number
}
```

Add `offerPair: new Int32Array(2)` to `createScratch` with a one-line comment saying it is caller-owned output for `drawOfferPair` and why the callee cannot allocate it.

- [ ] **Step 4: Insert the phase and renumber every comment**

In `step.ts`, between the input loop (phase 3) and `runSpawn`:

```ts
  runOffer(s, world, scratch)
```

Then renumber. `step.ts`'s phase table gains a row and every row from the old 4 down shifts by one; **and every phase number above 3 written anywhere else in the repo moves with it.** Find them:

```bash
grep -rn "phase \([4-9]\|10\)\b\|Phase \([4-9]\|10\)\b\|phases \([4-9]\|10\)" packages/ docs/superpowers/ --include=*.ts --include=*.md
```

Fix each by reading what it means, not by adding one blindly — some name a pair (`4 <-> 5`), some name a position, and `regions.ts`'s and `blocking.ts`'s references are to phases whose *content* did not move.

**The equivalent-mutant register's one surviving 0-detector row, `4 <-> 5` (spawn against demand), is now `5 <-> 6`.** Rename it at its site in `step.ts` with a sentence saying it was renumbered and by which task, so a reader who greps `4 <-> 5` in a later milestone finds the note rather than nothing.

**And write, at the phase table, that THE PHASE COUNT IS FINAL AT ELEVEN and no later task adds one.** An earlier draft of this milestone appended a twelfth phase at Task 9 to drive a traffic light's controller; Amendment 2 deleted the controller, so M1f's relief object is a flag `canEnter` reads and there is nothing to advance once per tick. **Say that at the phase table**, because the next reader's two failure modes are renumbering a second time by reflex and leaving a gap for a phase that never arrives.

- [ ] **Step 5: Re-bless the two goldens that move behaviourally, with hand-computed slot values**

The state golden (13,499 ticks, crosses two boundaries) and the demand-pin golden (crosses one) both now carry non-zero offer slots. For each, **before** touching the literal:

```ts
    // The bytes that moved, hand-computed rather than read back. `poolFor` on this
    // fixture's map is CARD_IMPLEMENTED_MASK; the seed word is this fixture's own;
    // the week is 2 at tick 13,499.
    const out = new Int32Array(2)
    drawOfferPair(poolFor(WORLD), offerSeedFor(s, 2), out)
    expect(s.header[H_OFFER_A]).toBe(out[0])
    expect(s.header[H_OFFER_B]).toBe(out[1])
    expect(s.header[H_OFFER_WEEK], 'nothing chose, so nothing resolved').toBe(0)
    // And the slots hold real cards, so the fixture is not silently exercising
    // the short-pool path: the 4x4 map's pool is two cards because the junction
    // upgrade is capable everywhere.
    expect(popCountCards(poolFor(WORLD)), 'GOLDEN_MAP can offer a pair').toBe(2)
```

Then update the digest with a re-bless comment naming the prior value and the reason, and update
`loop.test.ts`'s cross-file literal scan. **Verify by reading each fixture's run length that no OTHER
golden crosses a boundary** — do not take this plan's table for it.

- [ ] **Step 6: Run the whole suite green**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS.

- [ ] **Step 7: Run the complete C(11,2) = 55-pair transposition sweep**

Positional transpositions, with the poison check, `const tick` and both `H_EPOCH` writes excluded as prologue and epilogue. **Four unmutated baselines first, all 0.** Then each of the 55, one at a time, under the canonical invocation.

Four rules this project has learned:

- **Run the CONTROL as many times as the mutant.** The allocation harnesses flake ~10–17 %, and a mutant credited with a kill from `drawAllocation.test.ts` — a file that may not even import the mutated module — is a flake recorded as coverage.
- **Screen crash-vs-kill on lines that are NOT vitest result lines**, and record the matched line so a discard is auditable.
- **Run the complement check**: per-package totals unchanged, or the mutant stopped collection. A short suite's counts are lower bounds and must be marked as such.
- **A positional transposition at distance ≥ 2 is NOT a swap of two adjacent phases.** It reverses phase `i` against everything between as well. Expect non-zero rows that are not commutativity findings, and do not read them as one.

- [ ] **Step 8: Write the table into `step.ts` and predict three rows before running them**

Predict, in writing, before Step 7's results are read:

- **`2 <-> 4`** (week grant against offer) — **predicted NON-ZERO, in THIS task, and the previous draft's "predict 0 here" is falsified by a test this plan already cites.** Phase 2 and phase 4 *are* disjoint. But a positional transposition of 2 and 4 also **reverses phase 2 against phase 3**, and phase 3 spends `H_TILES` **today**, through `placeRoad`, with no card involved: `packages/sim/test/week.test.ts:71-97` drives a boundary-tick placement funded by that same tick's grant, and under the transposition the grant lands after the spend and the placement is refused for budget. **Name `week.test.ts:71-97` as the detector.** Task 6 adds a *second, independent* reason — `applyChooseCard` writes `H_TILES` in phase 3 as well — so from Task 6 the row is non-zero for two reasons and a mutation table that records only one of them is recording half the coverage. **An implementer who predicts 0 here will find a red row, look for a defect that does not exist, and then edit the prediction after the fact — which is the one thing Step 8 exists to prevent.**
- **`3 <-> 4`** (inputs against offer) — **predicted 0 in THIS task and non-zero from Task 6 onward**, because nothing yet enqueues a `choose-card`.
- **`5 <-> 6`** (the old `4 <-> 5`) — **predicted 0**, unchanged, and it stays on the equivalent-mutant register with both of its commutation reasons and both tripwires. **Do not manufacture a detector for it.**

- [ ] **Step 9: Mutation-test this task's own tests**

| # | Mutant | Expected |
|---|---|---|
| 1 | `runOffer`: drop the `offerPending` early return | ≥ 1 — a week-0 offer, caught by *"raises nothing in week 0"* |
| 2 | `runOffer`: write `H_OFFER_B` from `offerPair[0]` | ≥ 1, in *"B is not A"* |
| 3 | `runOffer`: pass `week - 1` to `offerSeedFor` | ≥ 1, in the independent-computation test |
| 4 | `runOffer`: also write `H_OFFER_WEEK = week` on the normal path | ≥ 1 — it would resolve its own offer; caught by *"replaces an unresolved offer"* and by `offerPending` |
| 5 | `runOffer`: short pool `return`s without writing `H_OFFER_WEEK` | ≥ 1, in the degradation test's *"nothing is left pending"* — **this is the assertion that separates "does not throw" from "does not hang the shell", and they are different failures** |
| 6 | `runOffer`: delete the short-pool guard entirely | ≥ 1, in the degradation test — an uncaught throw inside `step` |
| 7 | `step.ts`: call `runOffer` before the input loop | ≥ 1 from Task 6 onward; **0 here**, and record it as such rather than as coverage. **Task 6 Step 6 must add the boundary-tick `choose-card` test that gives this mutant a detector** — the previous draft predicted ≥ 1 from Task 6 with no test that would produce one |
| 8 | `step.ts`: call `runOffer` after `runSpawn` | **0 expected here.** Record it: nothing between them reads the offer slots yet. Task 8's frame fold is what makes the position observable, and Task 12's sweep re-runs it |

- [ ] **Step 10: Commit**

---

## Task 6: `choose-card` as an input, with the echo that detects a divergent replay

**Observability:** nothing yet — no UI enqueues the action. A test can choose a card; a person cannot. Task 8 is what makes it reachable, and this task ships two commits before it deliberately, so the input's semantics can be wrong in a test before they can be wrong on a screen.

**Files:**
- Modify: `packages/sim/src/step.ts` (`TickActionKind`, the dispatch), `packages/sim/src/cards.ts` (`applyChooseCard`, `cardTileGrant`, `cardItemGrant`), `packages/shared/src/constants.ts` (the grants)
- Modify: `packages/game/src/inputs.ts` (nothing structural — `enqueue` already takes a kind and two numbers; confirm and pin)
- Test: `packages/sim/test/cards.test.ts`, `step.test.ts`, `packages/shared/test/constants.test.ts`

**Interfaces:**
- Consumes: `offerPending`, `H_OFFER_*`, `H_INV_UPGRADES`, `CARD_*`, `OFFER_SLOT_A`/`OFFER_SLOT_B` (Task 4); `runOffer` (Task 5).
- Produces: `TickActionKind = 'place' | 'erase' | 'choose-card'`; `applyChooseCard(state, slot, cardId): void`; `cardTileGrant(cardId): number`; `cardItemGrant(cardId): number`; `CARD_GRANT_ROAD_TILES = 30`, `CARD_GRANT_ITEM = 20` and `UPGRADES_PER_CARD = 2` in `@laneways/shared`. Task 8's pointer calls `queue.enqueue('choose-card', slot, cardId)`; Task 9 adds a fourth kind, `'upgrade'`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('applyChooseCard — the echo is the replay-divergence detector', () => {
  it('grants the card tiles, sets H_OFFER_WEEK, and ends the offer', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const tiles = rig.s.header[H_TILES] as number
    const card = rig.s.header[H_OFFER_A] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, card))
    expect(rig.s.header[H_TILES]).toBe(tiles + cardTileGrant(card))
    expect(rig.s.header[H_OFFER_WEEK]).toBe(1)
    expect(offerPending(rig.s)).toBe(false)
  })

  it('adds TWO upgrades to the inventory when that is the card, and none otherwise', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const slot = rig.s.header[H_OFFER_A] === CARD_JUNCTION_UPGRADE ? OFFER_SLOT_A : OFFER_SLOT_B
    const card = (slot === OFFER_SLOT_A ? rig.s.header[H_OFFER_A] : rig.s.header[H_OFFER_B]) as number
    expect(card, 'the shipped pool always offers it').toBe(CARD_JUNCTION_UPGRADE)
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(slot, card))
    // §5.10's table: "Traffic Lights | 2 | 20". TWO, not one, and this is the
    // assertion that would catch it being implemented as one.
    expect(rig.s.header[H_INV_UPGRADES]).toBe(UPGRADES_PER_CARD)
    expect(rig.s.header[H_INV_UPGRADES]).toBe(2)
  })

  it('adds no upgrades when the road-tiles card is taken', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const slot = rig.s.header[H_OFFER_A] === CARD_ROAD_TILES ? OFFER_SLOT_A : OFFER_SLOT_B
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(slot, CARD_ROAD_TILES))
    expect(rig.s.header[H_INV_UPGRADES]).toBe(0)
  })

  it('raises no new offer for the rest of the week', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, rig.s.header[H_OFFER_A] as number))
    const after = hashState(rig.s)
    for (let t = 0; t < 100; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    expect(rig.s.header[H_OFFER_WEEK], 'still resolved').toBe(1)
    expect(offerPending(rig.s)).toBe(false)
    expect(hashState(rig.s), 'and the run went on').not.toBe(after)
  })

  it('offers again at the NEXT boundary', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, rig.s.header[H_OFFER_A] as number))
    driveTo(rig, TICKS_PER_WEEK * 2)
    expect(offerPending(rig.s)).toBe(true)
  })

  it('is a SILENT NO-OP for a second choice in the same batch — a double tap must not brick a run', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const a = rig.s.header[H_OFFER_A] as number
    const b = rig.s.header[H_OFFER_B] as number
    const tiles = rig.s.header[H_TILES] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, {
      actions: [
        { kind: 'choose-card', a: OFFER_SLOT_A, b: a },
        { kind: 'choose-card', a: OFFER_SLOT_B, b: b },
      ],
    })
    expect(rig.s.header[H_TILES], 'only the first was paid').toBe(tiles + cardTileGrant(a))
    expect(rig.s.header[H_EPOCH], 'and nothing threw').toBe(0)
  })

  it('is a SILENT NO-OP in week 0, where no offer exists', () => {
    const rig = bootCity()
    const before = hashState(rig.s)
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, CARD_ROAD_TILES))
    expect(rig.s.header[H_EPOCH]).toBe(0)
    expect(rig.s.header[H_OFFER_WEEK]).toBe(0)
    expect(hashState(rig.s), 'the tick still ran').not.toBe(before)
  })

  it('THROWS, naming both cards, when the echo disagrees with the slot', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const wrong =
      (rig.s.header[H_OFFER_A] as number) === CARD_ROAD_TILES ? CARD_JUNCTION_UPGRADE : CARD_ROAD_TILES
    expect(() =>
      step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, wrong)),
    ).toThrow(/believed slot 0 held card \d+.*this simulation offered \d+.*replay/s)
  })

  it('THROWS for a slot that is neither 0 nor 1', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    expect(() => step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(2, CARD_ROAD_TILES))).toThrow(
      /slot 2 is not 0 or 1/,
    )
  })

  it('checks PENDING before the echo, so a stale choice after a new week is a no-op and not a throw', () => {
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK)
    const week1A = rig.s.header[H_OFFER_A] as number
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, week1A))
    driveTo(rig, TICKS_PER_WEEK + 10)
    expect(() =>
      step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, week1A)),
    ).not.toThrow()
  })

  it('RESOLVES on the boundary tick itself when the action arrives with it', () => {
    // The reason phase 4 sits after phase 3, asserted rather than argued. It is
    // also the detector Task 5 Step 9's mutant #7 needs: with `runOffer` moved in
    // front of the input loop, this week's choice would resolve the PREVIOUS
    // week's slots and then be overwritten.
    const rig = bootCity()
    driveTo(rig, TICKS_PER_WEEK - 1)
    // The offer for week 1 does not exist yet, so the client cannot echo it —
    // which is itself the finding: a boundary-tick choice can only be a REPLAYED
    // one, and the log carries the card id the original client saw.
    const out = new Int32Array(2)
    drawOfferPair(poolFor(rig.world), offerSeedFor(rig.s, 1), out)
    step(rig.s, rig.world, rig.fields, rig.scratch, chooseCard(OFFER_SLOT_A, out[0] as number))
    expect(rig.s.header[H_WEEK]).toBe(1)
    // Phase 3 ran before phase 4 raised anything, so the choice found nothing
    // pending for week 1 and was a silent no-op; phase 4 then raised week 1's
    // offer. **Record which of these two the run actually produces and make the
    // assertion match the DERIVATION, not the other way round.**
    expect(offerPending(rig.s), 'the offer for week 1 is up and unresolved').toBe(true)
  })
})

describe('cardTileGrant and cardItemGrant', () => {
  it('pays 30 for road tiles and 20 for an item, per spec 5.10', () => {
    expect(cardTileGrant(CARD_ROAD_TILES)).toBe(30)
    expect(cardTileGrant(CARD_JUNCTION_UPGRADE)).toBe(20)
  })

  it('gives two upgrades and zero items for road tiles, per spec 5.10s grant row', () => {
    expect(cardItemGrant(CARD_JUNCTION_UPGRADE)).toBe(2)
    expect(cardItemGrant(CARD_ROAD_TILES)).toBe(0)
  })

  it('THROWS for a card with no placement mechanism, rather than inventing a grant', () => {
    for (const id of [CARD_BRIDGE, CARD_TUNNEL, CARD_ROUNDABOUT, CARD_MOTORWAY, CARD_NONE]) {
      expect(() => cardTileGrant(id)).toThrow(/has no tile grant/)
      expect(() => cardItemGrant(id)).toThrow(/has no item grant/)
    }
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @laneways/sim test -- cards`
Expected: FAIL — `applyChooseCard`, the two grant functions and the `'choose-card'` kind do not exist.

- [ ] **Step 3: Add the three grant constants**

`packages/shared/src/constants.ts`:

```ts
/**
 * Spec §5.10's Road Tiles card: the per-map constant "30 or 40" — 30 here, the
 * same value `WEEKLY_TILE_GRANT` uses, and deliberately a separate constant
 * because they are two different rules that happen to agree today.
 */
export const CARD_GRANT_ROAD_TILES = 30
/**
 * Spec §5.10's tile bonus on every ITEM card except the motorway, which grants
 * 10. **The motorway's number is not declared**, because the motorway is not
 * offerable in M1f and an untested value reads as a supported configuration —
 * `cardTileGrant` throws for it instead. M1g declares it with the card.
 *
 * **This is a bonus ON TOP of `WEEKLY_TILE_GRANT`, not a replacement**, and that
 * is a balance change stated rather than hidden: tile income goes from 30 a week
 * to 50 or 60, against a measured 3.4x slack — 62 tiles spent of 210 granted on
 * the arm that ships, with a WEEK-CLOSE minimum of 37. **Quote the week-close
 * qualifier or do not quote the 37**: `integration.test.ts` takes the minimum over
 * per-week-close samples, and the true running minimum is **7, at tick 2,280**, in
 * week 0 before the first grant.
 *
 * The alternative — deleting the automatic grant so the card is the only income —
 * is what §5.10 literally describes, and it is the only version in which the
 * modal's 30-vs-20 costs the player anything. It was refused for two reasons: it
 * makes two goldens' `H_TILES` a function of the input log, and `runWeekBoundary`
 * has no other body, so deleting the grant deletes a phase and forces a second
 * renumbering in a milestone that has already paid for one. **M1f Task 12
 * measures the new slack and hands the lever to M1g with the number** — and notes
 * that M1f has already paid its expensive half, because every headless rig
 * acquired a card policy at Task 7.
 */
export const CARD_GRANT_ITEM = 20
/**
 * Spec §5.10's grant row for the item card: **two per card, for 20 tiles.** The
 * row is headed "Traffic Lights" in §5.10; M1f ships a JUNCTION UPGRADE in that
 * slot and honours the grant unchanged — see the 2026-08-21 amendment to §5.6 and
 * the M1f plan's Decision 14 for the measurement that made the substitution.
 *
 * A named constant rather than a literal inside `cardItemGrant` because the modal
 * draws it (`RenderFrame.offerItemsA`/`offerItemsB`) and a literal in `canvas.ts`
 * is how a UI ends up lying about a rule — the failure mode I6 of the M1f review.
 */
export const UPGRADES_PER_CARD = 2
```

Add all three to `constants.test.ts`'s `ALL` registry with exact-value assertions.

- [ ] **Step 4: Implement the grants and `applyChooseCard`**

```ts
/**
 * §5.10's tile bonus for a card. **Total over the OFFERABLE set and a throw
 * outside it**, rather than a default arm: a card with no placement mechanism
 * cannot be offered (`CARD_IMPLEMENTED_MASK`), so reaching this with one means the
 * pool and the grant table disagree, and a plausible fallback would hide that.
 */
export function cardTileGrant(cardId: number): number {
  if (cardId === CARD_ROAD_TILES) return CARD_GRANT_ROAD_TILES
  if (cardId === CARD_JUNCTION_UPGRADE) return CARD_GRANT_ITEM
  throw new Error(
    `cards: card ${cardId} has no tile grant — only the cards in CARD_IMPLEMENTED_MASK do, and a ` +
      'card that can be offered but not priced means the pool and this table disagree',
  )
}

/**
 * §5.10's ITEM count for a card: 2 for Traffic Lights, 0 for Road Tiles. Same
 * totality rule as `cardTileGrant`, and a separate function rather than a second
 * return value because `render` needs the number on its own, folded onto the
 * frame, so the modal's "x2" is not a string literal in `canvas.ts`.
 */
export function cardItemGrant(cardId: number): number {
  if (cardId === CARD_ROAD_TILES) return 0
  if (cardId === CARD_JUNCTION_UPGRADE) return UPGRADES_PER_CARD
  throw new Error(`cards: card ${cardId} has no item grant — see cardTileGrant`)
}

/**
 * Applies a `choose-card` action, in phase 3.
 *
 * **Three checks, and their ORDER is load-bearing.**
 *
 *   1. **Not pending -> silent no-op.** A duplicate `choose-card` in one batch is
 *      what a double tap produces, and a throw there would poison `H_EPOCH` and
 *      end the run over a UI event. `H_OFFER_WEEK === H_WEEK` absorbs it, which is
 *      why `pointer.ts` needs no second guard — a second guard here would be the
 *      catalogue's independently-sufficient-structures defect. This check must
 *      come FIRST: after a later week's offer has overwritten the slots, an echo
 *      check would report a divergence that is not one.
 *   2. **A slot outside {0, 1} -> throw.** A malformed action, exactly like
 *      `step`'s unknown-kind throw.
 *   3. **The echo -> throw.** `b` is the card id the CLIENT believes it is taking.
 *      A mismatch means the browser and this simulation disagree about what was
 *      offered, which can only happen if the draw is not a pure function of state.
 *      **That is exactly what a verified leaderboard exists to catch**, so a
 *      Worker that hits it returns `unverifiable`: never a score, and never
 *      apply-anyway.
 *
 * **The tile bonus is paid HERE and never at the week boundary.** Phase 2 owns
 * `H_TILES`'s weekly grant and phase 4 owns the offer slots, so the two are
 * disjoint by construction.
 *
 * **`H_OFFER_A`/`H_OFFER_B` are NOT cleared**, deliberately: `offerSlot` already
 * folds `pending ? slot : CARD_NONE`, and clearing them here would be a second
 * mechanism for the same fact. Every reader goes through `offerSlot`.
 */
export function applyChooseCard(state: GameState, slot: number, cardId: number): void {
  if (!offerPending(state)) return
  if (slot !== OFFER_SLOT_A && slot !== OFFER_SLOT_B) {
    throw new Error(`cards: choose-card slot ${slot} is not 0 or 1`)
  }
  const offered = (slot === OFFER_SLOT_A ? state.header[H_OFFER_A] : state.header[H_OFFER_B]) as number
  if (offered !== cardId) {
    throw new Error(
      `cards: the client believed slot ${slot} held card ${cardId}, and this simulation offered ` +
        `${offered} — the offer is a pure function of the seed word and the week, so the two cannot ` +
        'disagree unless the replay has diverged. A verifier must report unverifiable rather than ' +
        'apply either card.',
    )
  }
  state.header[H_TILES] = (state.header[H_TILES] as number) + cardTileGrant(cardId)
  state.header[H_INV_UPGRADES] = (state.header[H_INV_UPGRADES] as number) + cardItemGrant(cardId)
  state.header[H_OFFER_WEEK] = state.header[H_WEEK] as number
}
```

Note that `cardItemGrant` returns 0 for road tiles, so the increment is unconditional and there is no
`if (cardId === …)` branch to get wrong. Say so at the site.

In `step.ts`'s input loop, add the third arm **before** the `else throw`:

```ts
    } else if (action.kind === 'choose-card') {
      applyChooseCard(s, action.a, action.b)
```

- [ ] **Step 5: Re-derive `step.test.ts`'s `TickActionKind` tripwire — do not widen it**

The line-anchored pin `/^export type TickActionKind = 'place' \| 'erase'$/m` goes red. **This is the tripwire working**, and its comment is what a reader is meant to arrive at, so the comment is re-derived rather than the regex retyped. Three things it must now say:

1. The pin becomes `/^export type TickActionKind = 'place' \| 'erase' \| 'choose-card'$/m`, still line-anchored, because `toContain` scored 0 detectors against a widened union last time. **And it goes red AGAIN at Task 9**, which adds `'upgrade'` — say so, so the second re-derivation is expected rather than alarming.
2. **Half 2 of the tripwire — "`roads.ts` cannot observe the clock" — still holds and is still meaningful**, because `applyChooseCard` lives in `cards.ts`, not in `roads.ts`. Say so explicitly: the new action kind was deliberately given its own module so this guard keeps its subject.
3. **A `TickAction` now reads the clock**, which is the condition M1c and M1d recorded as keeping two transpositions inert. `applyChooseCard` reads `H_WEEK` and writes `H_TILES`, so **phase 3 is no longer clock-blind**. Add a fourth half: a scan of `cards.ts` for the demand-state names `runDemand` reads, with `demand.ts` as its positive control, exactly as half 3 does for `roads.ts` — because the pair that matters now is phase 3 against phase 6.

- [ ] **Step 6: Re-run the affected transposition rows, and give mutant #7 its detector**

Rows `1 <-> 3`, `2 <-> 3`, `2 <-> 4`, `3 <-> 4` and `3 <-> 6` change meaning under a clock-reading, tile-writing action. Run those five now, record them against Task 5 Step 8's predictions, and note in `step.ts` that the other 50 are Task 5's and are re-run in Task 12.

**And confirm that Task 5's mutant #7 (`runOffer` before the input loop) now scores ≥ 1**, using this task's boundary-tick `choose-card` test. If it still scores 0, **write the test that makes it non-zero rather than recording the 0** — the previous draft predicted ≥ 1 from Task 6 with nothing in the suite that could produce it, which is a prediction with no instrument.

- [ ] **Step 7: Run the whole suite green**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS. **No golden moves**: no golden fixture enqueues an action, so `H_OFFER_WEEK` stays 0 in all of them and the header bytes are the ones Task 5 already blessed.

- [ ] **Step 8: Mutation-test**

| # | Mutant | Expected |
|---|---|---|
| 1 | `applyChooseCard`: drop the pending check | ≥ 1, in the double-tap test **and** the week-0 test |
| 2 | Move the pending check below the echo | ≥ 1, in the stale-choice test |
| 3 | Drop the echo check | ≥ 1, in the mismatch test |
| 4 | Echo compares against the OTHER slot | ≥ 1, in the mismatch test |
| 5 | `H_OFFER_WEEK = week + 1` | ≥ 1, in *"offers again at the next boundary"* |
| 6 | `cardItemGrant(CARD_JUNCTION_UPGRADE)` returns 1 | ≥ 1, in the two-upgrades test — **the §5.10 grant row says 2 and this is the mutant that proves the table was read** |
| 7 | Drop the `H_INV_UPGRADES` increment | ≥ 1 |
| 8 | `cardTileGrant`: swap the two grants | ≥ 1 |
| 9 | `cardTileGrant` / `cardItemGrant`: return 0 instead of throwing | ≥ 1 each, in the throw test |
| 10 | `step.ts`: dispatch `choose-card` to `placeRoad` | ≥ 1. (Putting the arm after the `else throw` does not compile and is not a mutant.) |

- [ ] **Step 9: Commit**

---

## Task 7: The pause, the card policy for EVERY headless rig, and the arms that re-base

**Observability:** at **2:21** on a stopwatch — the week-1 boundary — the board stops. Cars freeze mid-road, the pause bars appear, and nothing says why, because the modal is Task 8's. **This task ships a build in which the default board hangs at the first week boundary with no way out, and that is knowingly a bad intermediate state.** It is mitigated the way M1e mitigated the same shape: with a **deliberately failing test** that Task 8 deletes as its first act, keyed on something Task 8 must structurally change. Tasks 7 and 8 must be adjacent, with nothing between them.

**This is the review's Critical 3, and its cost is spread across four test files and every figure they pin.** Read Decision 11 before starting.

**Files:**
- Modify: `packages/game/src/frame.ts` (`FrameDriverDeps.onOfferRaised`, the driver's call, three new frame fields)
- Modify: `packages/game/src/main.ts` (the wiring)
- Modify: `packages/render/src/types.ts` (`RenderFrame`'s three offer fields — **not `offerPeek`, which is Task 8's, together with `pointer.peeking`**)
- Modify: `packages/game/test/integration.test.ts` (`buildRig`, `driveArm`), `packages/game/test/demoAllocation.test.ts`, `packages/game/test/drawAllocation.test.ts`, `packages/game/test/allocation.test.ts`
- **Modify: `packages/game/test/carSmoothing.test.ts`** — it constructs `createFrameDriver` directly, so a **required** `onOfferRaised` on `FrameDriverDeps` stops it compiling. It was missing from the previous draft's list, and the failure is **typecheck-only**: `vitest` transpiles without type-checking, so the suite stays green while `tsc` is red. **Add `pnpm typecheck` to Step 7's run** — no step in this plan ran it, which is why a compile-only breakage could hide behind a green suite for a whole task
- Create: `packages/game/test/offerInterlock.test.ts` — the deliberately failing test
- Test: `packages/game/test/frame.test.ts`, `loop.test.ts`

**Interfaces:**
- Consumes: `offerPending`, `offerSlot` (Task 4); `runOffer` (Task 5); `applyChooseCard` and the `'choose-card'` kind (Task 6).
- Produces: `FrameDriverDeps.onOfferRaised: () => void` (**required**, not optional); `RenderFrame.offerPending: boolean`, `RenderFrame.offerA: number`, `RenderFrame.offerB: number`; and a shared test helper `takeCardPolicy(rig, slot: 0 | 1): void` in `packages/game/test/cardPolicy.ts`, used by every frame-driven rig.

- [ ] **Step 1: Enumerate every rig that drives `game.frame`, by grep, before writing anything**

```bash
grep -rln "game\.frame\|rig\.oneTick\|\.advance(" packages/game/test
```

For each hit, decide and record **in the task report**, before any code changes:

- does it drive past tick 4,500 (`TICKS_PER_WEEK`)? If not, it needs nothing and the reason is "it stops inside week 0" — write that down rather than leaving it unlisted;
- if it does, which policy: **take slot A**, **take slot B**, or **take neither** (only available to rigs that drive `step` directly, which is not this list);
- what re-bases as a result.

The four already known are `integration.test.ts` (`buildRig`/`driveArm`), `demoAllocation.test.ts`, `drawAllocation.test.ts` and `allocation.test.ts`. **Confirm each by reading it, not by trusting this line** — `allocation.test.ts` in particular has both a frame-loop block and a tick-path block, and only one of them may be affected.

**And confirm the rigs that drive `step` directly need nothing**: `deathTicks.ts`'s two measurements, `cityArms.ts`'s hand driver in `startingCity.test.ts`, and `junctionArms.ts`. `sim` has no pause, so a no-input arm stays genuinely no-input, its offers are raised and replaced weekly, and `H_TILES` grows by `WEEKLY_TILE_GRANT` alone. **That is what keeps `CITY_DEATH_TICK` and `DEMO_DEATH_TICK` measurements of a no-input board**, and it is worth stating because it is the property that stops this task re-basing everything.

- [ ] **Step 2: Write the failing interlock test FIRST**

Create `packages/game/test/offerInterlock.test.ts`:

```ts
/**
 * **A deliberately failing test, and Task 8 deletes this file as its first act.**
 *
 * Task 7 pauses the loop when a card offer is raised and ships no modal, so
 * between this commit and the next the default board freezes at 2:21 with no
 * message and no way out — indistinguishable from a crash. Correct sequencing,
 * disclosed, and **nothing in the tree would prevent a deploy landing here**;
 * this project has shipped that exact intermediate state once already and the
 * mitigation that worked was a red test rather than a promise.
 *
 * **The key is structural, not a guess about the next task's shape.** `render`
 * imports nothing from `sim`, so a modal cannot be drawn without new fields on
 * `RenderFrame` AND a hit-test the pointer can reach. This test asserts the
 * pointer can produce `PointerOutcome.CARD_CHOSEN`, which no cosmetic change can
 * satisfy: the outcome does not exist until Task 8 declares it, and it cannot be
 * produced without the rects, the arbitration and the enqueue.
 *
 * Its worst failure mode is that Task 8 deletes a file it was going to delete
 * anyway.
 */
it('FAILS UNTIL TASK 8: a tap can choose a card', () => {
  expect(
    Object.keys(PointerOutcome),
    'the offer modal is unreachable — see this file for why it exists',
  ).toContain('CARD_CHOSEN')
})
```

Run: `pnpm --filter @laneways/game test -- offerInterlock`
Expected: **FAIL.** That is the deliverable.

- [ ] **Step 3: Write the failing tests for the pause behaviour**

Add to `packages/game/test/loop.test.ts` and `integration.test.ts`:

```ts
  it('pauses the loop the frame a card offer is raised', () => {
    const g = bootGame()                       // production createGame, city layout
    driveFramesTo(g, TICKS_PER_WEEK)
    expect(offerPending(g.state), 'the sim raised one').toBe(true)
    expect(g.loop.paused, 'and the shell followed').toBe(true)
  })

  it('advances up to 7 more ticks after the pause is raised, because the drain does not re-check', () => {
    // MEASURED, and this plan decided not to change it. `loop.ts` reads `paused`
    // ABOVE the `while` (line 228), so a pause raised from inside `advance` does
    // not stop the drain in progress. The ticks are invisible (the frame renders
    // once, after the drain), replay-safe (`sim` has no pause concept) and
    // idempotent-safe (`runOffer` rewrites the same pair). Re-checking inside the
    // `while` would only DEFER the burst.
    const g = bootGame()
    driveFramesToJustBefore(g, TICKS_PER_WEEK)
    const before = g.state.header[H_TICK] as number
    g.frame(nowAfterA250msGap())
    const after = g.state.header[H_TICK] as number
    expect(after - before, 'the clamped drain ran to completion').toBeGreaterThan(1)
    expect(after - before, 'and no further than the clamp allows').toBeLessThanOrEqual(8)
    expect(g.loop.paused).toBe(true)
    // The offer the player will see is the offer raised at the boundary:
    expect(g.state.header[H_OFFER_A]).toBe(offerSlotAAt(g, 1))
  })

  it('re-pauses if something unpauses with an offer still pending — and it takes TWO frames', () => {
    // The pause fires on the CONDITION, not the edge — the opposite of
    // onGameOver, which is terminal and must announce once.
    //
    // **Two frames, and one would assert something `loop.ts` cannot do.**
    // `setPaused(false)` sets `resetClock`, so the NEXT `frame(now)` assigns
    // `L_LAST_TIME = now` before computing `rawDt`; `rawDt` is 0, the accumulator
    // is untouched, and that frame runs ZERO ticks. `advance` is never called,
    // `onOfferRaised` never fires, and `paused` stays false. The second frame is
    // the first one that can drain. The file's own sibling tests already use two
    // frames for exactly this reason.
    const g = bootGame()
    driveFramesTo(g, TICKS_PER_WEEK)
    g.loop.setPaused(false)
    g.frame(nowPlusOneTick())
    expect(g.loop.paused, 'the first frame after ANY resume runs no ticks').toBe(false)
    g.frame(nowPlusTwoTicks())
    expect(g.loop.paused, 'the condition re-armed it on the first frame that drained').toBe(true)
  })

  it('does not pause when no offer is pending', () => {
    const g = bootGame()
    driveFramesTo(g, TICKS_PER_WEEK - 10)
    expect(g.loop.paused).toBe(false)
  })

  it('carries the offer onto the render frame, through offerSlot and not off the header', () => {
    const g = bootGame()
    driveFramesTo(g, TICKS_PER_WEEK)
    const f = lastFrame(g)
    expect(f.offerPending).toBe(true)
    expect(f.offerA).toBe(offerSlot(g.state, 0))
    expect(f.offerB).toBe(offerSlot(g.state, 1))
  })

  it('reports no offer on the frame once the week is resolved, and not a stale card', () => {
    // `applyChooseCard` never clears H_OFFER_A/B, so a frame that read the header
    // directly would show last week's card on every frame for the rest of the
    // run. THIS is why `buildFrame` folds through `offerSlot`.
    const g = bootGame()
    driveFramesTo(g, TICKS_PER_WEEK)
    g.queue.enqueue('choose-card', 0, g.state.header[H_OFFER_A] as number)
    g.loop.setPaused(false)
    g.frame(nowPlusOneTick())
    g.frame(nowPlusTwoTicks())
    const f = lastFrame(g)
    expect(f.offerPending).toBe(false)
    expect(f.offerA, 'reads as no offer').toBe(CARD_NONE_NUMBER)
    expect(g.state.header[H_OFFER_A], 'while the header still holds the raw card, deliberately')
      .not.toBe(CARD_NONE_NUMBER)
  })
```

`CARD_NONE_NUMBER` is a bare `0` with a comment in `game`'s test file naming `CARD_NONE`; `game` may
import from `sim`, so **use the real import** — this note is only to flag that `render`'s tests may
not, which is Task 8's problem.

- [ ] **Step 4: Run to verify they fail**

Run: `pnpm --filter @laneways/game test -- loop integration`
Expected: FAIL — `onOfferRaised` and the three frame fields do not exist.

- [ ] **Step 5: Add the three `RenderFrame` fields and fold them**

```ts
  /**
   * True while §5.10's weekly card offer is waiting to be taken. The board
   * behind the modal is frozen because the shell paused the loop; `sim` has no
   * notion of pause and never will.
   */
  readonly offerPending: boolean
  /** The card id in slot A, or 0 (no card) when nothing is pending. A plain number: `render` imports nothing from `sim`. */
  readonly offerA: number
  /** The card id in slot B. */
  readonly offerB: number
```

`buildFrame`, in the HUD block, **through `sim`'s own guards rather than off the header**:

```ts
  frame.offerPending = offerPending(state)
  frame.offerA = offerSlot(state, 0)
  frame.offerB = offerSlot(state, 1)
```

`createFrameDriver`'s `advance`:

```ts
    advance(inputs: TickInputs): void {
      const wasOver = isGameOver(state)
      step(state, world, fields, scratch, inputs)
      if (!wasOver && isGameOver(state)) deps.onGameOver()
      // **On the CONDITION, not the edge, and the contrast with the line above is
      // the point.** Game over is terminal and must announce once, so it reads
      // `wasOver` first. An offer is recurring and self-healing: firing whenever
      // it holds means any path that unpauses with an offer still pending
      // re-pauses on the next frame that drains a tick, so a lost `choose-card`
      // cannot strand a modal over a live board. `setPaused(true)` is already
      // idempotent, so the repetition costs one boolean read per tick.
      if (offerPending(state)) deps.onOfferRaised()
    },
```

`main.ts`:

```ts
      // Required, not optional: an optional dependency is how M2's erase control
      // shipped a compiling `createEraseControl({ host })` that left the player
      // with no way to erase. A game whose offer cannot pause the loop is a game
      // whose modal is drawn over a running sim.
      onOfferRaised: () => {
        loop.setPaused(true)
      },
```

- [ ] **Step 6: Land the card policy in every frame-driven rig, and RE-BASE what it moves**

Create `packages/game/test/cardPolicy.ts`:

```ts
/**
 * **The card policy every frame-driven rig needs, as one function, because four
 * files need it and two copies of a policy drift.**
 *
 * From M1f Task 7 the production loop pauses whenever `offerPending(state)`
 * holds, and `loop.ts` gates the whole drain on `if (!paused)`. So a headless rig
 * that drives `game.frame` past tick 4,500 and does not resolve the offer stops
 * dead — `integration.test.ts`'s liveness guard throws, and
 * `demoAllocation.test.ts` profiles a FROZEN board for two of three windows while
 * its allocation numbers still look fine, which is the catalogue's *"an
 * instrument that reports clean while measuring nothing"*.
 *
 * **A rig that drives `step` directly needs none of this**: `sim` has no notion
 * of pause. That is why `deathTicks.ts`'s two measurements are still measurements
 * of a genuinely no-input board.
 *
 * **THE SECOND-ORDER EFFECT, NAMED SO IT IS NOT DISCOVERED.** Taking a card pays
 * `CARD_GRANT_ROAD_TILES` (30) or `CARD_GRANT_ITEM` (20) ON TOP of
 * `WEEKLY_TILE_GRANT` (30). So a frame-driven "no-input" arm is no longer
 * no-input: it receives 50-60 tiles a week instead of 30, and the greedy arm can
 * afford connections it previously could not. **Every figure the frame-driven
 * arms pin is re-based at this commit** — the death tick, the trips, the tile
 * ledger, the week rows. They are re-derived here, not scaled.
 *
 * Slot A rather than "whichever card is X": the pool's only randomness is the
 * ORDER, so a slot-keyed policy exercises both cards across the run and a
 * card-keyed one would silently become a constant if the draw were ever fixed.
 */
export function takeCardPolicy(rig: FrameRig, slot: 0 | 1): void {
  if (!offerPending(rig.state)) return
  rig.queue.enqueue('choose-card', slot, offerSlot(rig.state, slot))
  rig.loop.setPaused(false)
}
```

Call it from each of the four rigs' per-frame loop, **before** the frame that would otherwise stall,
and assert in each that it fired at least once (a policy that never runs is a policy that is not
being tested):

```ts
    expect(cardsTaken, 'the rig crossed at least one boundary and resolved it').toBeGreaterThan(0)
```

Then, in this task's report, **state the re-based figures per arm** — the same table `driveArm`'s
assertions carry (`deathTick`, `trips`, `fires`, the seven week rows, `tilesLeft` min/max,
`unaffordable`, `maxInFlight`, `maxBlockedTicks`, `valveFirings`) — with the pre-Task-7 value beside
each. **Update the assertions to the re-derived values, and say for each whether the new value
follows from the extra tiles.** A value that moved and cannot be explained by more tiles is a
finding, not a number to paste.

**And the six census figures are in that list, which the previous draft's enumeration omitted — the
second review's I8, and it bites the figure the milestone is dated from.** `driveArm` is
frame-driven, so a card policy changes how many tiles it has, which changes which cells the greedy
connector links, which changes **which cells reach degree 3 and when**. `r.ruleEvents`,
`r.firstRuleEventTick`, `r.ruleEventCells.length`, `r.conflicts`, `r.firstConflictTick` and
`r.conflictCells.length` are all pinned to literals in Task 1 Step 12 and all six can move here, with
no prediction to compare against unless one is written now. **Write the prediction before running:**

> The census figures are properties of the ROAD NETWORK, and a card policy that takes tiles builds
> more of it sooner. **Predicted direction: the first event tick moves EARLIER and the event counts
> move UP**, on both policies that take the tiles card and on the alternating one. **Predicted for
> `always upgrades`: unchanged from Task 3's arm**, because that policy takes 20 tiles rather than 30
> and the connector is not tile-bound at this point in the run — if it moves anyway, that is a
> finding about the tile economy, not about the census.

Then re-derive all six and say, for each, whether the movement follows from the extra tiles. **Step
6's own rule — *"a value that moved and cannot be explained is a finding, not a number to paste"* —
applies most sharply here**, because these six are the only figures in the milestone whose job is to
date it.

**And note the consequence for Task 4 Step 12**, which asserted the greedy arm's death tick, trips and
refusals as its behavioural warrant: those three re-base here. The warrant was correct at Task 4 and
this is the task that supersedes it; say so at both sites.

- [ ] **Step 7: Run the game suite AND the typecheck**

Run: `pnpm --filter @laneways/game test`
Expected: PASS on the new tests and on all four repaired rigs; `offerInterlock.test.ts` still red, by design; **no golden moves**, because none of this is in `sim`.

Then run: `pnpm typecheck`
Expected: PASS. **This is the only step in the milestone that runs it, and it is here because this task makes a `FrameDriverDeps` field required.** `vitest` transpiles without type-checking, so every rig that constructs `createFrameDriver` by hand — `carSmoothing.test.ts` is the one this plan found — can be broken with a green suite. If `typecheck` is red on a file this task's list does not name, **that file is a finding**: add it, and record that the enumeration was short.

- [ ] **Step 8: Record the paused-car settling measurement where it now matters**

Add to `packages/game/src/resolve.ts`'s existing table:

```
 * **M1f gives this its first long-lived audience.** Paused cars do NOT settle
 * onto their sim positions — measured at 0.09-0.22 cells short, because the chase
 * advances inside the drain and the drain has stopped. **The reference frame
 * matters and is stated here because two different divergence figures live in
 * this repo:** this one is the gap between the DRAWN position and the SIM position
 * at the moment the pause lands, and it is bounded by `MAX_DRAW_LAG_CELLS` (0.2)
 * at the top of its range. It is NOT the tick-boundary divergence (0.9920 cells,
 * 4.96x `MAX_DRAW_LAG_CELLS`, on the every-frame-drains-7-ticks schedule), which
 * is a different measurement of a different quantity and must not be quoted here.
 *
 * Until M1f the only pause was a HUD-clock tap; from M1f the weekly modal holds a
 * pause for as long as the player takes to choose, so a frozen offset of up to
 * 0.22 cells — about 6 CSS px at the smallest tile size `fitCamera` produces — is
 * on screen for seconds at a time, four times a run. **Not fixed here**:
 * converging while paused means advancing the chase with `ticks = 0`, which is a
 * drawn position moving while the sim's does not, and that gives up the property
 * that a drawn car is never ahead of its sim car. Task 12's device session is the
 * instrument.
```

- [ ] **Step 9: Mutation-test**

| # | Mutant | Expected |
|---|---|---|
| 1 | `advance`: fire `onOfferRaised` on the EDGE (`!wasPending && offerPending`) | ≥ 1, in the two-frame re-pause test |
| 2 | Delete the `onOfferRaised` call | ≥ 1, in the pause test |
| 3 | `buildFrame`: read `state.header[H_OFFER_A]` directly instead of `offerSlot` | ≥ 1, in *"reads as no offer, not a stale card"* |
| 4 | `main.ts`: `setPaused(false)` in `onOfferRaised` | ≥ 1 |
| 5 | Make `onOfferRaised` optional in `FrameDriverDeps` | must fail `tsc`; if it compiles, the type is wrong and that is the finding |
| 6 | `takeCardPolicy`: drop the `setPaused(false)` | ≥ 1, in every frame-driven rig's liveness guard |
| 7 | `takeCardPolicy`: enqueue slot 1's card id under slot 0 | ≥ 1 — `applyChooseCard`'s echo throws, and the rig dies loudly rather than quietly taking the wrong card |

- [ ] **Step 10: Commit, disclosing the intermediate state in the message**

The commit message must say, in its own words, that this build freezes at 2:21 with no way out, that `offerInterlock.test.ts` is red on purpose, that Task 8 deletes it, **and that every frame-driven arm's figures are re-based here because the card's tiles now land on top of the weekly grant.**

---

## Task 8: The modal, the peek button, the tap arbitration — and the erase control that has to get out of the way

**Observability: this is the task the milestone's first half is for.** At **2:21** the board dims and two cards appear: **ROAD TILES · 30 TILES** and **JUNCTION UPGRADE ×2 · 20 TILES**. Tapping one dismisses the modal and the board runs again, with the tile counter jumping. Holding the eye button shows the frozen board underneath without resuming it. The erase control disappears while the modal is up and comes back after.

**Files:**
- Modify: `packages/render/src/types.ts` (`OfferRects`, `RenderFrame.offerPeek`/`offerGrantA`/`offerGrantB`/`offerItemsA`/`offerItemsB`, `Palette`'s new colours), `camera.ts` (`offerRects`), `canvas.ts` (**draw phase 12 — `canvas.ts`'s own layer count, which has nothing to do with `step`'s eleven tick phases; the two numbering schemes now differ and a reader who conflates them will look for a sim phase that does not exist**), `palette.ts`
- Modify: `packages/game/src/pointer.ts` (arbitration, peek, three outcomes), `frame.ts` (five more folds), `main.ts`, `eraseControl.ts`
- Delete: `packages/game/test/offerInterlock.test.ts`
- Test: `packages/render/test/canvas.test.ts`, `camera.test.ts`, `boundary.test.ts`, `packages/game/test/pointer.test.ts`, `eraseControl.test.ts`, **`packages/game/test/frame.test.ts` (the cross-package pins)**

**Interfaces:**
- Consumes: `RenderFrame.offerPending`/`offerA`/`offerB` (Task 7); `queue.enqueue('choose-card', slot, cardId)` (Task 6); `cardTileGrant`, `cardItemGrant` (Task 6).
- Produces: `OfferRects { readonly cardA: Rect; readonly cardB: Rect; readonly peek: Rect }`, `createOfferRects(): OfferRects` and `offerRects(camera: Camera, out: OfferRects): OfferRects` from `packages/render`; `CARD_LABELS: readonly string[]` and `CARD_LABEL_COUNT: number` from `packages/render`; `PointerOutcome.CARD_CHOSEN = 10`, `PEEK_TOGGLED = 11`, `REFUSED_OFFER_MODAL = 12`; `PointerInput.peeking: boolean`; `RenderFrame.offerPeek`, `offerGrantA`, `offerGrantB`, `offerItemsA`, `offerItemsB`; `EraseControl.suspend(): void` / `resume(): void`.
- **`PointerHost.cardLabel` is NOT added** — `render` owns every string it draws.

- [ ] **Step 1: Delete the interlock test as the first act**

```bash
git rm packages/game/test/offerInterlock.test.ts
```

- [ ] **Step 2: Land the cross-package contract FIRST, in `game`, where both halves are visible**

**This is review I6 and it has two halves; the second is the one that matters.** `packages/render/package.json` declares **no dependencies**, so `render/test` cannot import `CARD_ROAD_TILES` or `CARD_COUNT` — the previous draft's render tests used both. And if the modal's *"30 ROAD TILES"* is a string literal in `canvas.ts`, changing `CARD_GRANT_ROAD_TILES` to 40 leaves every test in both packages green while the modal lies.

`render` owns only **names**:

```ts
/**
 * One label per card id, indexed by the id, frozen at module scope so the modal
 * allocates no strings per frame.
 *
 * **Names only — no numbers.** Every quantity the modal shows (the tile grant,
 * the item count) arrives on `RenderFrame` as a number and is formatted here with
 * the same memoised number->string cache `scoreText`/`tilesText` already use. A
 * literal "30" in this file is a UI that keeps telling the player 30 after the
 * constant becomes 40, with a green suite in both packages.
 *
 * **`render` imports nothing, so this array's agreement with `sim`'s card ids is
 * pinned in `packages/game/test/frame.test.ts`** — the only package that can see
 * both — in the idiom `TerrainClass` already established there.
 */
export const CARD_LABELS: readonly string[] = Object.freeze([
  '',              // 0 CARD_NONE — never drawn; present so the array is id-indexed
  'ROAD TILES',    // 1
  'BRIDGE',        // 2
  'TUNNEL',        // 3
  'ROUNDABOUT',       // 4
  'TRAFFIC LIGHTS',   // 5 — declared, not offerable; deferred to M1g with its measurement
  'MOTORWAY',         // 6
  'JUNCTION UPGRADE', // 7 — M1f's own item, and the only offerable one besides road tiles
])
export const CARD_LABEL_COUNT = CARD_LABELS.length
```

and the pins go in `packages/game/test/frame.test.ts`:

```ts
describe('render and sim agree about cards, and game is the only package that can check', () => {
  // `TerrainClass`'s idiom, lines 187-191 of this file, applied to a second
  // forced duplication. `render` declares no dependencies at all, so neither side
  // can assert this in its own package.
  it('one label per card id', () => {
    expect(CARD_LABEL_COUNT).toBe(CARD_COUNT)
  })

  it('the two offerable labels are the strings canvas.test.ts expects', () => {
    expect(CARD_LABELS[CARD_ROAD_TILES]).toBe('ROAD TILES')
    expect(CARD_LABELS[CARD_JUNCTION_UPGRADE]).toBe('JUNCTION UPGRADE')
    // The deferred light keeps its row, so the array stays id-indexed and the
    // deferral reads as an interlock rather than a gap.
    expect(CARD_LABELS[CARD_TRAFFIC_LIGHTS]).toBe('TRAFFIC LIGHTS')
  })

  it('the modal draws the grants as NUMBERS folded from sim, so a constant change reaches the screen', () => {
    const f = frameAtOffer(CARD_ROAD_TILES, CARD_JUNCTION_UPGRADE)
    expect(f.offerGrantA).toBe(cardTileGrant(CARD_ROAD_TILES))
    expect(f.offerGrantB).toBe(cardTileGrant(CARD_JUNCTION_UPGRADE))
    expect(f.offerItemsA).toBe(cardItemGrant(CARD_ROAD_TILES))
    expect(f.offerItemsB).toBe(cardItemGrant(CARD_JUNCTION_UPGRADE))
  })
})
```

**And extend `render/test/boundary.test.ts`'s vacuity guard** with any new `render/src` file this task
adds. `SCAN_ROOT` stays `render/src` and this task states why rather than widening it: the scan's one
real catch is a raw relative path in **shipped** source, and a test file does not ship. The file-list
pin is what stops a new module hiding from it.

- [ ] **Step 3: Write the failing render tests**

Add to `packages/render/test/canvas.test.ts`, against the existing command-recording stub. **Bare
integer literals with comments, because this package cannot import the ids:**

```ts
describe('phase 12: the offer modal', () => {
  const ROAD_TILES = 1        // CARD_ROAD_TILES, pinned in game/test/frame.test.ts
  const JUNCTION_UPGRADE = 7  // CARD_JUNCTION_UPGRADE, same pin

  it('draws NOTHING when no offer is pending', () => {
    const cmds = draw(frameWith({ offerPending: false }))
    expect(cmds.filter((c) => c.text !== undefined).map((c) => c.text)).not.toContain('ROAD TILES')
  })

  it('covers the whole canvas, not just the board, so the HUD cannot read as live', () => {
    // The shutdown scrim stops at the grid rect's bottom edge so the HUD keeps its
    // contrast. The modal is the opposite case and deliberately so: the HUD clock
    // is a PAUSE TOGGLE, and a legible pause toggle under a modal that forbids
    // skipping is an invitation to a control that does nothing.
    const cmds = draw(frameWith({ offerPending: true }))
    const scrim = cmds.find((c) => c.fillStyle === PALETTE.scrim && c.rect !== undefined)
    expect(scrim?.rect).toEqual({ x: 0, y: 0, w: CANVAS_W, h: CANVAS_H })
  })

  it('draws both card names and both grant lines, with the numbers coming from the FRAME', () => {
    const cmds = draw(
      frameWith({
        offerPending: true,
        offerA: ROAD_TILES,
        offerB: JUNCTION_UPGRADE,
        offerGrantA: 30,
        offerGrantB: 20,
        offerItemsA: 0,
        offerItemsB: 2,
      }),
    )
    const texts = cmds.filter((c) => c.text !== undefined).map((c) => c.text)
    expect(texts).toContain('ROAD TILES')
    expect(texts).toContain('30 TILES')
    expect(texts).toContain('JUNCTION UPGRADE')
    expect(texts).toContain('x2')
    expect(texts).toContain('20 TILES')
  })

  it('follows the frame when the grants change, which a string literal could not', () => {
    const cmds = draw(frameWith({ offerPending: true, offerA: ROAD_TILES, offerGrantA: 40 }))
    const texts = cmds.filter((c) => c.text !== undefined).map((c) => c.text)
    expect(texts).toContain('40 TILES')
    expect(texts).not.toContain('30 TILES')
  })

  it('draws the two faces at exactly the rects offerRects reports, so the hit test cannot drift', () => {
    const rects = offerRects(CAMERA, createOfferRects())
    const cmds = draw(frameWith({ offerPending: true }))
    const faces = cmds.filter((c) => c.fillStyle === PALETTE.cardFace && c.rect !== undefined)
    expect(faces.map((c) => c.rect)).toEqual([rects.cardA, rects.cardB])
  })

  it('suppresses the chrome and keeps the scrim off while peeking', () => {
    const cmds = draw(frameWith({ offerPending: true, offerPeek: true, offerA: ROAD_TILES }))
    const texts = cmds.filter((c) => c.text !== undefined).map((c) => c.text)
    expect(texts).not.toContain('ROAD TILES')
    expect(cmds.some((c) => c.fillStyle === PALETTE.scrim), 'the board is visible').toBe(false)
    expect(texts, 'and the way back is still on screen').toContain(PEEK_RETURN_TEXT)
  })

  it('draws the modal ABOVE the shutdown screen when both are somehow true', () => {
    // Unreachable in production — `step` freezes past the failure so no boundary
    // can be crossed — and drawn in a defined order anyway, because a scrim over a
    // modal over a scrim is the one composition nobody can debug from a
    // screenshot.
    const cmds = draw(frameWith({ offerPending: true, offerA: ROAD_TILES, gameOver: true }))
    const lastScrim = cmds.map((c) => c.fillStyle).lastIndexOf(PALETTE.scrim)
    const lastText = cmds.map((c) => c.text).lastIndexOf('ROAD TILES')
    expect(lastText).toBeGreaterThan(lastScrim)
  })

  it('has one label per card id, so an eighth card fails here rather than drawing undefined', () => {
    // **CORRECTED AT EXECUTION: this read `toBe(7)` and `CARD_COUNT` is 8.**
    // `cards.ts` declares ids 0-7 and `CARD_COUNT` is "one past the highest id",
    // and the label array in Step 2 above has eight rows — so the literal here
    // and the array it was written beside disagreed, and the pin in
    // `frame.test.ts` (`CARD_LABEL_COUNT === CARD_COUNT`) would have failed
    // against it. See Task 8's report.
    expect(CARD_LABEL_COUNT).toBe(8)   // CARD_COUNT, pinned in game/test/frame.test.ts
  })
})
```

Add to `packages/render/test/camera.test.ts`: `offerRects` gives two non-overlapping rects inside the
canvas at three viewport sizes including the degenerate clamps `fitCamera` produces; the peek rect
overlaps neither; the whole set is inside `[0, cssW] x [0, cssH]`; and it fills a caller-owned object
and returns it, allocating nothing.

- [ ] **Step 4: Run to verify they fail; then implement the render side**

`palette.ts` gains `scrim`, `cardFace`, `cardText` and `cardAccent`. `canvas.ts` gains phase 12,
**after** phase 11's shutdown for the reason the test names, plus two more memoised caches in the
`scoreText` idiom:

```ts
let cachedGrantValue = -1
let cachedGrantText = ''
/** `${tiles} TILES`, memoised on the number. See `scoreText` for why. */
function grantText(tiles: number): string { … }

let cachedItemsValue = -1
let cachedItemsText = ''
/** `x${items}`, memoised. Drawn only when `items > 0`, so a tiles card shows no count. */
function itemsText(items: number): string { … }
```

- [ ] **Step 5: Write the failing pointer tests**

```ts
describe('the offer modal owns every tap while it is up', () => {
  it('queues a choose-card with the slot and the card id it believes it is taking', () => {
    const h = host({ offerPending: true, offerA: CARD_ROAD_TILES, offerB: CARD_JUNCTION_UPGRADE })
    const p = createPointerInput(h)
    expect(p.down(1, ...centreOf(offerRects(h.camera(), r).cardB))).toBe(PointerOutcome.CARD_CHOSEN)
    expect(h.queue.length).toBe(1)
    expect(lastAction(h.queue)).toEqual({ kind: 'choose-card', a: 1, b: CARD_JUNCTION_UPGRADE })
  })

  it('resumes the loop on the choice, because the tick that resolves the offer cannot run while paused', () => {
    const h = host({ offerPending: true })
    createPointerInput(h).down(1, ...centreOf(offerRects(h.camera(), r).cardA))
    expect(h.setPausedCalls).toEqual([false])
  })

  it('refuses a tap that misses both cards, and names the guard that refused it', () => {
    const h = host({ offerPending: true })
    expect(createPointerInput(h).down(1, ...aPointInNoRect())).toBe(PointerOutcome.REFUSED_OFFER_MODAL)
    expect(h.queue.length).toBe(0)
  })

  it('refuses a HUD-CLOCK tap while the modal is up — a pause toggle would resume a dead board', () => {
    const h = host({ offerPending: true })
    expect(createPointerInput(h).down(1, ...centreOf(hudRects(h.camera(), hr).clock))).toBe(
      PointerOutcome.REFUSED_OFFER_MODAL,
    )
    expect(h.setPausedCalls, 'and the clock did not toggle').toEqual([])
  })

  it('refuses a GRID tap while the modal is up', () => {
    const h = host({ offerPending: true, paused: true })
    expect(createPointerInput(h).down(1, ...aGridPoint())).toBe(PointerOutcome.REFUSED_OFFER_MODAL)
  })

  it('refuses the next tap of a stroke that was mid-drag when the boundary arrived', () => {
    // The case the ordering exists for, as a fixture rather than as a comment:
    // the modal branch is ABOVE the `dragging` block, so a modal raised mid-stroke
    // does not answer REFUSED_SECOND_POINTER in front of a screen asking for a
    // choice.
    const h = host({ offerPending: false })
    const p = createPointerInput(h)
    expect(p.down(1, ...aGridPoint())).toBe(PointerOutcome.DRAG_START)
    h.offerPending = () => true
    expect(p.down(2, ...centreOf(offerRects(h.camera(), r).cardA))).toBe(PointerOutcome.CARD_CHOSEN)
  })

  it('toggles peek, and a tap anywhere returns from it', () => {
    const h = host({ offerPending: true })
    const p = createPointerInput(h)
    expect(p.down(1, ...centreOf(offerRects(h.camera(), r).peek))).toBe(PointerOutcome.PEEK_TOGGLED)
    expect(p.peeking).toBe(true)
    expect(p.down(2, ...aGridPoint())).toBe(PointerOutcome.PEEK_TOGGLED)
    expect(p.peeking).toBe(false)
  })

  it('does NOT resume the loop while peeking — peek inspects, it does not skip', () => {
    const h = host({ offerPending: true })
    const p = createPointerInput(h)
    p.down(1, ...centreOf(offerRects(h.camera(), r).peek))
    expect(h.setPausedCalls).toEqual([])
  })

  it('is BELOW the game-over branch, so a city that dies mid-modal still restarts', () => {
    const h = host({ offerPending: true, gameOver: true })
    expect(createPointerInput(h).down(1, ...aGridPoint())).toBe(PointerOutcome.RESTART_REQUESTED)
  })

  it('leaves every existing path alone when no offer is pending', () => {
    const h = host({ offerPending: false })
    const p = createPointerInput(h)
    expect(p.down(1, ...aGridPoint())).toBe(PointerOutcome.DRAG_START)
    expect(p.down(2, ...centreOf(hudRects(h.camera(), hr).clock))).toBe(PointerOutcome.REFUSED_SECOND_POINTER)
  })
})
```

- [ ] **Step 6: Implement the arbitration, in a stated order**

In `down()`, immediately **below** the `host.gameOver()` early return and **above** the `dragging` block:

```ts
    // **The modal owns every tap while it is up, and it is ONE branch rather than
    // a guard on each of the paths below.** Two guards can disagree; and the HUD
    // clock in particular is a pause TOGGLE, which under a no-skip modal would
    // resume the sim from outside this decision entirely.
    //
    // **Below the game-over branch** for the same reason that branch is first: a
    // city that died with a modal up must still offer the restart.
    //
    // **Above the `dragging` block**, so a modal raised mid-stroke does not answer
    // the next tap REFUSED_SECOND_POINTER in front of a screen asking for a
    // choice.
    //
    // `move`, `up` and `cancel` need no companion guard and must not grow one:
    // the loop is paused, `move` already refuses every board sample while paused,
    // and `up`/`cancel` must stay live so a captured pointer can be released. A
    // second independently sufficient structure would leave neither half with a
    // detector.
    if (host.offerPending()) {
      if (peek) {
        peek = false
        return PointerOutcome.PEEK_TOGGLED
      }
      offerRects(host.camera(), offerRectScratch)
      const cssX = clientX - host.canvasLeft()
      const cssY = clientY - host.canvasTop()
      if (inRect(offerRectScratch.peek, cssX, cssY)) {
        peek = true
        return PointerOutcome.PEEK_TOGGLED
      }
      if (inRect(offerRectScratch.cardA, cssX, cssY)) return chooseCard(OFFER_SLOT_A, host.offerA())
      if (inRect(offerRectScratch.cardB, cssX, cssY)) return chooseCard(OFFER_SLOT_B, host.offerB())
      return PointerOutcome.REFUSED_OFFER_MODAL
    }
```

with

```ts
  function chooseCard(slot: number, cardId: number): PointerOutcomeCode {
    // The echo: the card id THIS CLIENT believes the slot holds, read from the
    // same frame the player tapped. `applyChooseCard` throws on a mismatch, and
    // that throw is the replay-divergence detector — so this must pass on what it
    // saw, never re-derive it.
    host.queue.enqueue('choose-card', slot, cardId)
    // The resume is here because the tick that resolves the offer cannot run while
    // the loop is paused. The 1-2 frame window in which the modal is still drawn
    // after the tap is harmless: a second tap enqueues a second `choose-card` and
    // `sim` no-ops it against `H_OFFER_WEEK === H_WEEK`.
    host.setPaused(false)
    return PointerOutcome.CARD_CHOSEN
  }
```

`PointerHost` gains `offerPending: () => boolean`, `offerA: () => number`, `offerB: () => number`,
supplied by `main.ts` from `offerPending(state)` / `offerSlot(state, 0)` / `offerSlot(state, 1)` —
`pointer.ts` must not grow a `sim` import. `PointerInput` gains `peeking: boolean`, which `main.ts`
hands `createFrameDriver` as `peeking: () => pointer.peeking`, and `buildFrame` folds into
`frame.offerPeek`. **Both halves land in this task**; the previous draft declared the frame field one
task early and read it from something that did not exist yet.

- [ ] **Step 7: Suspend the erase control under the modal, and fix its press guard while there**

Carry-forward §4: `retire()` hides the control and refuses every later render, but never unsubscribes
— `offClick` is declared on the `MainButton` shape and called nowhere, and the DOM fallback's listener
is never removed. Unreachable on every client this ships to, and the specific wrongness worth fixing
is that **`press()` calls `host.toggleEraseMode()` BEFORE `render()`'s terminal guard runs**, so a
press that did arrive would flip erase mode with no label to show it.

Two changes:

```ts
  /** Hidden while a modal owns the screen; `resume` puts it back exactly as it was. */
  readonly suspend: () => void
  readonly resume: () => void
```

and **ADD a `retired` guard at the top of `press`** — do not *move* `render`'s. `render()` is also
called from `sync()`, so moving its guard would delete the terminal guard from a live path; the
previous draft's step said "move" where it meant "add", and the difference is a deleted guard.
Record at the site that the alternative — holding the handler reference and widening `mainButton()`'s
shape re-check to cover `offClick` — was refused as the more invasive of the two for a consequence
that is bounded and cosmetic.

`main.ts` calls `erase.suspend()` from `onOfferRaised` and `erase.resume()` when a frame reports the
offer resolved. **A full-width bright button reading ERASE ROADS under a modal asking for a choice is
the same defect `onGameOver`'s `erase.retire()` already exists to prevent**, arrived at through a
different door.

- [ ] **Step 8: Run the whole suite green**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS. No golden moves — nothing here is in `sim`.

- [ ] **Step 9: Drive the real thing once, headless, and assert the whole loop end to end**

In `integration.test.ts`, on the production boot: drive to 2:21, assert paused and `offerPending`;
synthesise a tap at the junction-upgrade card's rect through `createPointerInput`; drive two more
frames; assert `H_INV_UPGRADES === 2`, `H_TILES` up by `CARD_GRANT_ITEM`, the loop unpaused, and the
frame's `offerPending` false. **This is the first test in the repo that exercises a player decision
from a screen coordinate to a header slot**, and it is the one that would catch a rect/draw mismatch
that both sides' own tests miss.

- [ ] **Step 10: Mutation-test**

| # | Mutant | Expected |
|---|---|---|
| 1 | Move the offer branch above the `gameOver` branch | ≥ 1, in the dead-board test |
| 2 | Move the offer branch below the `dragging` block | ≥ 1, in the mid-stroke test (which exists for exactly this row) |
| 3 | Delete the `return REFUSED_OFFER_MODAL` fallthrough | ≥ 1, in the clock and grid tests |
| 4 | `chooseCard`: enqueue `host.offerB()` for slot A | ≥ 1, in the enqueue test — and note this is the mutant the sim's echo throw exists for |
| 5 | `chooseCard`: drop `setPaused(false)` | ≥ 1, in the resume test |
| 6 | Peek: also call `setPaused(false)` | ≥ 1, in *"peek inspects, it does not skip"* |
| 7 | `offerRects`: swap `cardA` and `cardB` | ≥ 1, in the draw/hit-test agreement test |
| 8 | `canvas.ts`: draw phase 12 before phase 11 | ≥ 1, in the ordering test |
| 9 | `canvas.ts`: hard-code `'30 TILES'` instead of `grantText(frame.offerGrantA)` | ≥ 1, in *"follows the frame when the grants change"* — **this is review I6's sharp half and it must not score 0** |
| 10 | `frame.ts`: fold `offerItemsB` from a literal 2 | ≥ 1, in `frame.test.ts`'s grant test |
| 11 | `eraseControl`: make `suspend` a no-op | ≥ 1 — write the test if it survives |
| 12 | `eraseControl`: delete the new `retired` guard in `press` | ≥ 1 — a press on a retired control flips erase mode with no label; write the test if it survives |

- [ ] **Step 11: Commit**

---

## Task 9: The junction upgrade — placement, the one-clause entry rule, and the measurement that says where it goes

**This was the largest task in the milestone and Amendment 2 made it one of the smallest.** The
previous draft's Task 9 was four deliverables that could not be split — a placement rule, a
three-colour entry rule, a demand-actuated controller with hysteresis and idle weighting, and a
relief measurement. **The controller, the colours and right-on-red are gone** (Amendment 2, Decision
14). What is left is: the placement rule, **one clause in `junctionAdmitsOne`**, a building refusal,
a fourth action kind, and the measurement — which is now the task's centre of gravity rather than its
last step, because the object's *value* is settled and its *placement* is not.

**Read Amendment 2 and trap 5 before starting.** In particular: the spike's +103.8 % ceiling was
measured by exempting six cells, **two of which can never be seated**, so this task's job is to
measure the reachable ceiling per cell and hand Task 12 a threshold that is not the unreachable one.

**Observability: nothing a player can see.** No UI grants an upgrade and no gesture places one. Say
so; the payoff lands at Task 10. **No golden moves, and that is derived**: this task adds no region
(Task 4 did), no phase, and no per-tick work of any kind, and no golden fixture places an upgrade, so
`upgradeAt` is all-zero in every one of them and the new clause is the identity there. **If a golden
moves, stop and report** — the only cause is `junctionAdmitsOne` answering differently on an
un-upgraded cell, which would move `1531344761` and every arrival tick behind it.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-02-mini-motorways-clone-design.md` §5.6 (the substitution, the measurement, the deferral)
- Create: `packages/sim/src/upgrades.ts`, `packages/sim/test/upgrades.test.ts`
- Modify: `packages/sim/src/graph.ts` (`junctionAdmitsOne`'s **one** clause), `buildings.ts` (two refusals), `step.ts` (the fourth action kind — **no phase**), `index.ts`
- **Not modified, and each absence is a correction to the previous draft:** `packages/shared/src/constants.ts` (no `LIGHT_*` constant is declared); `packages/sim/src/blocking.ts` (`canEnter` is untouched and `EnterOutcome` gains no code); `packages/sim/src/cars.ts` (`nextLegDir` is not exported); `packages/game/src/queueProbe.ts` (`carAheadOf` reads `junctionAdmitsOne` and tracks the upgrade with no edit — this is the second review's I4(b), closed structurally); `regions.ts` (Task 4 declared the region)
- Test: `packages/sim/test/graph.test.ts`, `blocking.test.ts`, `buildings.test.ts`, `step.test.ts`, `determinism.test.ts`, `packages/game/test/queueProbe.test.ts`, `packages/game/test/integration.test.ts`, `packages/game/test/junctionArms.ts`

**Interfaces:**
- Consumes: `upgradeAt`, `H_INV_UPGRADES`, `H_UPGRADE_COUNT`, `MAX_UPGRADES` (Task 4); `isJunctionCell`, `junctionAdmitsOne` (Task 2); `CARD_JUNCTION_UPGRADE` (Task 4); the shipped junction rule and `junctionRefusalsByCell` and `replayCapturing` (Task 3).
- Produces:
  - `packages/sim/src/upgrades.ts`: `isUpgraded(state, cell): boolean`; `UpgradeRefusal` and `UpgradePlaceResult`; `canPlaceUpgrade(state, world, cell): UpgradePlaceResult`; `applyPlaceUpgrade(state, world, cell): boolean`
  - `TickActionKind` gains `'upgrade'`
- Task 10 consumes `isUpgraded`, `H_INV_UPGRADES`, `H_UPGRADE_COUNT` and the `upgradeAt` view. Task 12 consumes `canPlaceUpgrade` and `applyPlaceUpgrade`.
- **Produces no constant, no axis arithmetic, no entry-outcome code and no phase.** A reader who
  expects `runUpgrades` should re-read Amendment 2: there is nothing to advance once per tick.

- [ ] **Step 1: Amend §5.6 — record what was tried, what it measured, and who owns it now**

§5.6 specifies a demand-actuated traffic light. **M1f built it, measured it, and ships something
else.** A milestone that quietly substitutes an object leaves the next reader to rediscover why; this
amendment is the record, and it is the only place the light's numbers live in a durable artefact
besides the M1g carry-forward. Append to §5.6:

```markdown
> **AMENDMENT, 2026-08-21 (M1f Task 9). This section's traffic light was built,
> measured, and DEFERRED. M1f ships a JUNCTION UPGRADE in its place.**
>
> **What §5.6 specifies.** A light on a junction, demand-actuated with hysteresis,
> 10 s minimum between changes, 2 s amber, at least 2 nearby cars within 2 tiles
> before it swaps, idle time weighted up to a 30 s cap, right-on-red modelled.
> Every one of those numbers is datamined from the game being cloned and none of
> them is wrong about that game.
>
> **What was tried, in a throwaway spike, never merged.** The light was built to
> this specification and run against a control — the same board, the same seed,
> the same connector, junction mutual exclusion on, no relief object. Control:
> **368 completed trips.**
>
> - A perfect relief object (the mutual-exclusion rule simply exempted at the
>   jamming cells) scores **750 trips, +103.8 %** — it recovers the entire cost of
>   the junction rule, and at the census conflict cells it reproduces the
>   pre-junction-rule board to the digit.
> - A fixed alternating light at this section's `changeDelay` and `amberDelay`
>   scores **320, −13.0 %** — and that is its BEST result over the 30 distinct
>   phases the same light could have been seated at. Its median is 306, **−17 %**,
>   and it beats the control on 3 of those 30. The seat phase, which has no design
>   meaning at all, swings the result **1.19x–1.70x**: more than any positive
>   effect measured.
> - The demand-actuated controller this section specifies scores **228, −38 %**,
>   with **one phase swap in an entire run**.
>
> **Why, and the reason is a density mismatch rather than a defect.**
> `minimumNearbyCarsBeforeSwapping = 2` within `distanceToCountForNearbyCars = 2`
> tiles is essentially never satisfied on a board carrying about **eleven cars in
> flight**. Across eight seeds the light swaps `1 0 0 6 4 5 0 11` times per run —
> **on three of eight it never swaps at all**, latches on its opening axis, and
> becomes a permanent closure released only by the 45 s
> `MaximumTimeToWaitAtIntersection` valve. Its own red-light refusals measure
> **16,490–19,536** against the **6,536** junction-caused refusals it exists to
> drain: 2.5–3.0x against, on the one channel that can be counted. **These
> constants presuppose traffic far denser than this board has.**
>
> **What M1f ships instead.** A JUNCTION UPGRADE: the same placement rule as the
> light — *"only on an existing road junction, never plain road, cost 0 tiles"* —
> and the same §5.10 grant of two items for 20 tiles, with one effect: **at an
> upgraded cell the junction mutual-exclusion rule does not apply.** Cars cross
> without conflict. Everything else about the cell is unchanged, including the
> intersection slowdown, so §5.5's *"approaching an intersection = 0.5"* still
> applies there. In dossier terms it is `greenLightsIgnoreCollisions` with no
> phase attached: the collision check is skipped, for every axis, permanently.
>
> **Deferred to M1g, with a named recipient and the numbers above:** the metered
> light itself; `overtimeChangeDelay` (5 s — a real dossier row with no referent
> in this game, closest candidate mapping *"any destination's overcrowd timer is
> non-zero"*); `americanRedLightRules` and right-on-red, whose three-rule
> decomposition (may enter on red; still pays the intersection slowdown; does NOT
> get the collision exemption, because it crosses a live stream) is correct work
> and should not be re-derived; and `greenLightsIgnoreCollisions` as a per-axis
> rather than a whole-cell rule. **No constant from this section is declared in
> M1f**, because a constant with no caller reads as a supported configuration.
> `CARD_TRAFFIC_LIGHTS` is declared and excluded by `CARD_IMPLEMENTED_MASK` — an
> interlock, not an absence.
>
> **The three levers M1g inherits**, so the next attempt starts from the
> measurement rather than from the spec: raise the board's car density until the
> datamined constants have something to meter; lower
> `minimumNearbyCarsBeforeSwapping` to 1 (measured: swaps rise to 13–80 per run and
> the shipped seed recovers 228 → 349, still below its control on 6 of 8 seeds); or
> make the light a MODIFIER on an upgraded junction rather than a replacement for
> the exclusion.
```

**Do not delete §5.6's original text.** The amendment sits below it, exactly as Task 1's does under
§5.4, because the section is a correct description of the game being cloned and the deviation is
M1f's.

- [ ] **Step 2: Write the failing placement-validity tests — one per refusal**

Five refusals, each with its own fixture and its own outcome code, because *"a function with more than
two ways to decline puts the reason in the signature"*:

```ts
export type UpgradeRefusal = 'no-inventory' | 'capacity' | 'off-board' | 'not-a-junction' | 'occupied'
export type UpgradePlaceResult = { readonly ok: true } | { readonly ok: false; readonly reason: UpgradeRefusal }
```

```ts
describe('canPlaceUpgrade — spec 5.6, "only on an existing road junction, never plain road"', () => {
  it('accepts a degree-3 cell with an upgrade in hand', () => {
    const rig = junctionWithInventory(1)
    expect(canPlaceUpgrade(rig.s, rig.world, rig.centre)).toEqual({ ok: true })
  })

  it('refuses with none in hand', () => {
    const rig = junctionWithInventory(0)
    expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, rig.centre))).toBe('no-inventory')
  })

  it('refuses at MAX_UPGRADES, rather than silently dropping the placement', () => {
    const rig = junctionWithInventory(1)
    rig.s.header[H_UPGRADE_COUNT] = MAX_UPGRADES
    expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, rig.centre))).toBe('capacity')
  })

  it('refuses an off-board cell', () => {
    const rig = junctionWithInventory(1)
    expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, rig.world.cells + 3))).toBe('off-board')
    expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, -1))).toBe('off-board')
  })

  it('refuses PLAIN ROAD — a corridor cell of degree 2', () => {
    const rig = corridorWithInventory(1)
    expect(roadDegree(rig.s, rig.mid), 'the fixture really is degree 2').toBe(2)
    expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, rig.mid))).toBe('not-a-junction')
  })

  it('refuses BARE GROUND, a dead end, and a degree-2 elbow, all with the same reason', () => {
    // Three shapes, one reason: "never plain road" is about degree, not about
    // whether the cell has any road at all, and a fixture that only tried bare
    // ground would not distinguish them.
    const rig = mixedBoardWithInventory(1)
    for (const cell of [rig.bare, rig.deadEnd, rig.elbow]) {
      expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, cell)), `cell ${cell}`).toBe('not-a-junction')
    }
  })

  it('refuses a cell that already carries an upgrade', () => {
    const rig = junctionWithInventory(2)
    expect(applyPlaceUpgrade(rig.s, rig.world, rig.centre)).toBe(true)
    expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, rig.centre))).toBe('occupied')
  })

  it('checks in the stated order: no-inventory beats not-a-junction', () => {
    // Two things wrong at once, and the reason a caller gets is a decision. The
    // cheap check comes first, and only a fixture with BOTH conditions true can
    // tell the two orders apart.
    const rig = corridorWithInventory(0)
    expect(reasonOf(canPlaceUpgrade(rig.s, rig.world, rig.mid))).toBe('no-inventory')
  })
})
```

- [ ] **Step 3: Write the failing tests for placement's effects, persistence, and the INERT case**

```ts
describe('applyPlaceUpgrade', () => {
  it('sets the flag, counts it, and spends one from the inventory', () => {
    const rig = junctionWithInventory(2)
    expect(applyPlaceUpgrade(rig.s, rig.world, rig.centre)).toBe(true)
    expect(rig.s.header[H_UPGRADE_COUNT]).toBe(1)
    expect(rig.s.header[H_INV_UPGRADES]).toBe(1)
    expect(rig.s.upgradeAt[rig.centre], 'a flag, not an index').toBe(1)
    expect(isUpgraded(rig.s, rig.centre)).toBe(true)
    expect(isUpgraded(rig.s, rig.other), 'a plain cell answers false').toBe(false)
  })

  it('costs ZERO tiles, per 5.6', () => {
    const rig = junctionWithInventory(1)
    const tiles = tilesLeft(rig.s)
    applyPlaceUpgrade(rig.s, rig.world, rig.centre)
    expect(tilesLeft(rig.s)).toBe(tiles)
  })

  it('lays no road and erases none', () => {
    const rig = junctionWithInventory(1)
    const before = [...rig.s.roads]
    applyPlaceUpgrade(rig.s, rig.world, rig.centre)
    expect([...rig.s.roads]).toEqual(before)
  })

  it('returns false and changes NOTHING when validity refuses', () => {
    const rig = corridorWithInventory(1)
    const before = hashState(rig.s)
    expect(applyPlaceUpgrade(rig.s, rig.world, rig.mid)).toBe(false)
    expect(hashState(rig.s)).toBe(before)
  })

  it('PERSISTS when the player erases a road and the cell stops being a junction', () => {
    // A decision, not an accident. `canPlaceUpgrade` asks about degree; the ENTRY
    // rule asks about `upgradeAt` and nothing else. An upgrade that silently went
    // inert when a player redrew a road would be a mechanism that stops working
    // with no visible cause, which is this project's worst defect shape. Deleting
    // an upgrade is M1g's, so the player's recourse is to redraw the junction.
    const rig = junctionWithInventory(1)
    applyPlaceUpgrade(rig.s, rig.world, rig.centre)
    eraseRoad(rig.s, rig.world, rig.centre, rig.northArm)
    expect(roadDegree(rig.s, rig.centre), 'now a corridor').toBe(2)
    expect(isJunctionCell(rig.s, rig.centre)).toBe(false)
    expect(isUpgraded(rig.s, rig.centre), 'and the upgrade is still there').toBe(true)
    expect(junctionAdmitsOne(rig.s, rig.centre), 'and still governs the cell').toBe(false)
  })

  it('IS INERT, NOT FATAL, on a cell whose roads have ALL been erased', () => {
    // **This is Decision 9 applied to this object, and it is the rule that
    // survived the second review's C1 after the swap deleted C1's mechanism.**
    // The previous design's controller called `bestAxis`, which THREW when no
    // candidate axis had road — reachable by placing on a four-way and erasing
    // every arm, and fatal because `step` had already written `H_EPOCH`, so the
    // buffer was poisoned for the rest of the run and `restore` refused it.
    //
    // NOTHING IN `upgrades.ts` THROWS ON ANY STATE-DEPENDENT PATH. There is no
    // axis to select, no candidate to search and no per-tick entry point. Drive
    // it anyway: this test is the standing proof, not the argument.
    const rig = junctionWithInventory(1)
    applyPlaceUpgrade(rig.s, rig.world, rig.centre)
    eraseEveryArm(rig, rig.centre)
    expect(roadDegree(rig.s, rig.centre)).toBe(0)
    expect(() => {
      for (let t = 0; t < 400; t++) step(rig.s, rig.world, rig.fields, rig.scratch, NO_INPUT)
    }, 'step must not throw over a configuration a player can reach').not.toThrow()
    expect(rig.s.header[H_EPOCH], 'and the buffer is not poisoned').toBe(0)
    expect(isUpgraded(rig.s, rig.centre), 'the flag is still set and simply has nothing to exempt')
      .toBe(true)
  })
})
```

- [ ] **Step 4: Write `upgrades.ts`**

```ts
/**
 * §5.6's relief object, as M1f ships it: a single-cell JUNCTION UPGRADE placed ON
 * an existing road junction, costing 0 tiles, at which **the junction
 * mutual-exclusion rule does not apply.**
 *
 * **Why an upgrade and not §5.6's traffic light.** M1f built the light to
 * specification in a throwaway spike and measured it against its own control: a
 * fixed alternating light scores -13.0 % on trips at its best seat phase and
 * -17 % at the median, and this milestone's own specified demand controller
 * scores -38 % with ONE phase swap in an entire run, because
 * `minimumNearbyCarsBeforeSwapping` = 2 within 2 tiles is essentially never
 * satisfied on a board carrying about eleven cars in flight. Exempting the rule
 * outright at the same cells scores **+103.8 %** and recovers the entire cost of
 * the junction rule. See the 2026-08-21 amendment to spec 5.6, and
 * `docs/superpowers/m1g-carry-forward.md`, which owns the light.
 *
 * **Why a light and not a roundabout, kept because the geometry finding is the
 * reason this file exists at all.** M1f measured every legal 3x3 roundabout
 * placement covering every cell that actually jams, at every tick of the run:
 * five of the six had ZERO, and the sixth had one — the cell measured as worth
 * exactly nothing. The greedy connector merges approaches AT carparks and houses,
 * so degree-3 cells form against buildings by construction. A single-cell object's
 * placement rule IS the jam's location, so it cannot fail that way.
 *
 * **What an upgrade BUYS, derived rather than hoped.** Spec 5.5's mutual
 * exclusion (M1f Task 2) destroyed the two-lane model's head-on guarantee at
 * junctions: `LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]` used to make two cars
 * swapping across an edge resolve in one tick, and under the junction rule they
 * deadlock until the 45 s valve. Dossier 1.7's `greenLightsIgnoreCollisions`
 * names the behaviour that gives it back — only the entrant's OWN lane is
 * consulted — and an upgrade is that row with no phase attached: every axis,
 * always. `upgrades.test.ts`'s "an upgrade gives the head-on property back" is
 * that derivation as a test, on Task 2's own deadlock fixture.
 *
 * **THIS FILE CONTAINS NO `throw` ON ANY STATE-DEPENDENT PATH**, and that is a
 * requirement rather than an observation — Decision 9: nothing in `step` may throw
 * over a configuration a player can reach. An upgrade on a cell whose roads have
 * all been erased is INERT, not fatal.
 *
 * Everything here is integer-only, allocation-free, and reads `state.roads`
 * through `isJunctionCell` while writing only `upgradeAt` and two header slots.
 */

/** Does `cell` carry a junction upgrade? `upgradeAt` is a FLAG: 1 or 0. */
export function isUpgraded(state: GameState, cell: number): boolean {
  return (state.upgradeAt[cell] as number) !== 0
}

const UPGRADE_OK: UpgradePlaceResult = Object.freeze({ ok: true })
const UPGRADE_NO_INVENTORY: UpgradePlaceResult = Object.freeze({ ok: false, reason: 'no-inventory' })
const UPGRADE_CAPACITY: UpgradePlaceResult = Object.freeze({ ok: false, reason: 'capacity' })
const UPGRADE_OFF_BOARD: UpgradePlaceResult = Object.freeze({ ok: false, reason: 'off-board' })
const UPGRADE_NOT_A_JUNCTION: UpgradePlaceResult = Object.freeze({ ok: false, reason: 'not-a-junction' })
const UPGRADE_OCCUPIED: UpgradePlaceResult = Object.freeze({ ok: false, reason: 'occupied' })

/**
 * §5.6: *"place only on an existing road junction, never plain road, and cost 0
 * tiles."* That is the whole rule, and the checks are ordered cheapest-first.
 *
 * **`isJunctionCell` and not `junctionAdmitsOne`**: the placement rule asks
 * whether the cell IS a junction, and `junctionAdmitsOne` asks whether the default
 * rule governs it — which is false on a cell that already carries an upgrade, so
 * using it here would refuse with the wrong reason.
 */
export function canPlaceUpgrade(state: GameState, world: WorldData, cell: number): UpgradePlaceResult {
  if ((state.header[H_INV_UPGRADES] as number) < 1) return UPGRADE_NO_INVENTORY
  if ((state.header[H_UPGRADE_COUNT] as number) >= MAX_UPGRADES) return UPGRADE_CAPACITY
  if (!Number.isInteger(cell) || cell < 0 || cell >= world.cells) return UPGRADE_OFF_BOARD
  if (!isJunctionCell(state, cell)) return UPGRADE_NOT_A_JUNCTION
  if (isUpgraded(state, cell)) return UPGRADE_OCCUPIED
  return UPGRADE_OK
}

/** Places an upgrade. Returns false and writes nothing on a refusal. */
export function applyPlaceUpgrade(state: GameState, world: WorldData, cell: number): boolean {
  if (!canPlaceUpgrade(state, world, cell).ok) return false
  state.upgradeAt[cell] = 1
  state.header[H_UPGRADE_COUNT] = (state.header[H_UPGRADE_COUNT] as number) + 1
  state.header[H_INV_UPGRADES] = (state.header[H_INV_UPGRADES] as number) - 1
  return true
}
```

Add `'sim/src/upgrades.ts'` to `determinism.test.ts`'s sorted file list with a comment saying why a
new file must be added deliberately, and export the module from `packages/sim/src/index.ts`.

- [ ] **Step 5: Re-run Task 3's site-survey table through the REAL predicate, and assert agreement**

**This step exists because Task 3's Step 3a could not call `canPlaceUpgrade` — it did not exist yet —
and used `isJunctionCell` plus a bounds check instead.** That substitution is sound by inspection and
*"sound by inspection"* is what this project's catalogue calls a claim, so it is checked here rather
than trusted across five tasks.

Re-run Step 3a's exact sample-tick set through `replayCapturing`, and for every cell and every sample
tick assert that `canPlaceUpgrade(state, world, cell).ok` agrees with Task 3's predicate **once
inventory and capacity are neutralised** (`H_INV_UPGRADES = 1`, `H_UPGRADE_COUNT = 0`, nothing
placed). Print the two tables side by side and assert cell-for-cell equality. **A disagreement is a
finding about Task 3's criterion, not about this function**, and it goes in the report's first line.

- [ ] **Step 6: Write the failing tests for the ENTRY rule — four cases and the head-on derivation**

```ts
describe('an upgrade lifts the junction rule at its cell, and changes nothing else', () => {
  it('ADMITS a crossing entrant a bare junction would refuse', () => {
    const rig = upgradedJunction()
    claimCell(rig.s, 0, rig.centre, DIR_E)          // the OTHER lane is held
    expect(canEnter(rig.s, rig.world, 1, rig.centre, DIR_S)).toBe(EnterOutcome.ENTER_FREE)
  })

  it('and the SAME geometry with no upgrade refuses it — the upgrade is what changed', () => {
    const rig = upgradedJunction()
    rig.s.upgradeAt.fill(0)
    rig.s.header[H_UPGRADE_COUNT] = 0
    claimCell(rig.s, 0, rig.centre, DIR_E)
    expect(canEnter(rig.s, rig.world, 1, rig.centre, DIR_S)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })

  it('still refuses on the OWN lane — an upgrade gives capacity, not immunity', () => {
    const rig = upgradedJunction()
    claimCell(rig.s, 0, rig.centre, DIR_S)
    expect(canEnter(rig.s, rig.world, 1, rig.centre, DIR_S)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })

  it('KEEPS the intersection slowdown — 5.6, "not the intersection slowdown"', () => {
    const rig = upgradedJunction()
    expect(isJunctionCell(rig.s, rig.centre), 'still a junction for the SLOWDOWN').toBe(true)
    expect(junctionAdmitsOne(rig.s, rig.centre), 'and not for the default EXCLUSION').toBe(false)
    expect(intersectionSpeedMul(rig.s, rig.centre)).toBe(INTERSECTION_SPEED_MUL)
  })

  it('the GHOST check still comes first, even on an upgraded cell', () => {
    const rig = upgradedJunction()
    rig.s.ghostMask[rig.centre] = 1 << DIR_S
    claimCell(rig.s, 0, rig.centre, DIR_E)
    expect(isCommittedTo(rig.s, rig.world, 1, rig.centre)).toBe(false)
    expect(canEnter(rig.s, rig.world, 1, rig.centre, DIR_S)).toBe(EnterOutcome.REFUSED_GHOST)
  })

  it('adds NO new EnterOutcome, and isEntryGranted is untouched', () => {
    // The previous design added REFUSED_RED as a FIFTH code. An upgrade never
    // refuses anything a bare junction would have admitted, so there is nothing
    // new to say and the enum must not grow.
    //
    // **The count is FOUR at HEAD** — ENTER_FREE, ENTER_VALVE, REFUSED_OCCUPIED,
    // REFUSED_GHOST — and it is asserted rather than quoted, because a plan that
    // states an enum's size is a plan that can be one out. Read the declaration
    // (`blocking.ts`: `export const EnterOutcome = Object.freeze({`) and re-derive
    // the number here if it disagrees; a disagreement means a code arrived that
    // this milestone did not add, which is itself the finding.
    expect(Object.keys(EnterOutcome).length, 'M1f adds no entry outcome').toBe(4)
    expect(isEntryGranted(EnterOutcome.ENTER_FREE)).toBe(true)
    expect(isEntryGranted(EnterOutcome.REFUSED_OCCUPIED)).toBe(false)
  })
})
```

And the four-case table, extending Task 2's in `graph.test.ts` — **upgraded/plain × junction/corridor**:

```ts
  it('an upgraded junction keeps isJunctionCell and loses junctionAdmitsOne', () => {
    const rig = upgradedJunction()
    expect(isJunctionCell(rig.s, rig.centre)).toBe(true)
    expect(junctionAdmitsOne(rig.s, rig.centre)).toBe(false)
  })

  it('an upgraded CORRIDOR — reachable only by erasing a road — is neither', () => {
    // The flag persists through an erase, so this combination is a state a player
    // can reach. It answers false from both, and from `junctionAdmitsOne` it does
    // so for two independent reasons, which is why the fourth row exists.
    const rig = upgradedThenErased()
    expect(isJunctionCell(rig.s, rig.centre)).toBe(false)
    expect(junctionAdmitsOne(rig.s, rig.centre)).toBe(false)
  })
```

- [ ] **Step 7: The derivation test — the one that says an upgrade does anything at all**

```ts
  it('AN UPGRADE GIVES THE HEAD-ON PROPERTY BACK, on Task 2s own deadlock fixture', () => {
    // **This is the milestone's mechanism, as a test rather than as a paragraph.**
    // Before M1f, `LANE_OF_DIR[d] !== LANE_OF_DIR[OPPOSITE[d]]` made two cars
    // swapping across an edge resolve in one tick. Task 2's mutual exclusion broke
    // that at junctions: each needs the other's cell entirely empty and each is
    // standing in it, so the pair deadlocks until the 45 s valve, and that is one
    // reason valve firings went 0 -> 5 on the shipped board's predicted arm.
    //
    // **Nothing is hand-written into state here, and that is the difference from
    // the previous draft.** Its version had to assign `lightGreenAxis` on both
    // endpoints, and its own controller could not reach that state in the two-car
    // case (second review I12): two head-on cars give each junction a nearby count
    // of 1, below `LIGHT_MIN_NEARBY_CARS` = 2, so neither light could ever swap to
    // the axis that releases the pair. An upgrade has no phase to reach.
    //
    // If this test cannot be made to pass, the mechanism is not what this plan
    // says it is and THAT IS THE MILESTONE'S HEADLINE FINDING.
    const rig = twoAdjacentJunctions()            // exported by blocking.test.ts, Task 2 Step 1
    rig.s.header[H_INV_UPGRADES] = 2
    expect(applyPlaceUpgrade(rig.s, rig.world, rig.left)).toBe(true)
    expect(applyPlaceUpgrade(rig.s, rig.world, rig.right)).toBe(true)
    claimCell(rig.s, 0, rig.left, DIR_E)
    claimCell(rig.s, 1, rig.right, DIR_W)
    expect(canEnter(rig.s, rig.world, 0, rig.right, DIR_E)).toBe(EnterOutcome.ENTER_FREE)
    expect(canEnter(rig.s, rig.world, 1, rig.left, DIR_W)).toBe(EnterOutcome.ENTER_FREE)
  })

  it('and the same pair still deadlocks when only ONE of the two is upgraded', () => {
    // Half the fix is half a fix, and a player with two upgrades has to spend both.
    const rig = twoAdjacentJunctions()
    rig.s.header[H_INV_UPGRADES] = 1
    applyPlaceUpgrade(rig.s, rig.world, rig.right)
    claimCell(rig.s, 0, rig.left, DIR_E)
    claimCell(rig.s, 1, rig.right, DIR_W)
    expect(canEnter(rig.s, rig.world, 0, rig.right, DIR_E)).toBe(EnterOutcome.ENTER_FREE)
    expect(canEnter(rig.s, rig.world, 1, rig.left, DIR_W)).toBe(EnterOutcome.REFUSED_OCCUPIED)
  })
```

- [ ] **Step 8: Implement the entry rule — ONE clause, in `graph.ts`, and nowhere else**

```ts
export function junctionAdmitsOne(state: GameState, cell: number): boolean {
  // **A JUNCTION UPGRADE LIFTS THE DEFAULT RULE — M1f Task 9.** It does NOT stop
  // the cell being a junction: `isJunctionCell` is unchanged, so
  // `intersectionSpeedMul` still slows every car crossing here, which is §5.6's
  // *"skips the stop, not the intersection slowdown"* honoured by a different
  // route. The two predicates diverge here and nowhere else, and
  // `graph.test.ts`'s four-case table is what keeps them apart.
  //
  // **This one line is the whole entry rule of M1f's relief object.** `canEnter`
  // is not modified by this task; its Task 2/Task 3 clause reads `false` here and
  // reduces to the pre-M1f own-lane rule, which is exactly what a spike measured
  // at +103.8 % on trips. `carAheadOf` (game/src/queueProbe.ts) reads the same
  // predicate, so the queue probe and the entry rule cannot disagree about an
  // upgraded cell.
  //
  // No guard on `cell`: an off-board index reads `undefined`, `!== 0` is false,
  // and `isJunctionCell` answers false — the same answer bare ground gives, and
  // the same no-guard convention `roadDegree` sets.
  if ((state.upgradeAt[cell] as number) !== 0) return false
  return isJunctionCell(state, cell)
}
```

**And re-run Task 2's `canEnter`-agreement property on an UPGRADED board.** That property —
*"for every in-flight car on every tick, the probe's answer equals `canEnter`'s"* — was 90,533
questions on a board with no relief object, which makes it vacuous about the one case this task adds.
It is cheap to re-point and it is the surviving half of the second review's I4: extend
`queueProbe.test.ts` with an arm that places an upgrade on the run's own top refusal cell and re-runs
the property. **Expected: it passes unchanged, because both sides read `junctionAdmitsOne`.** If it
does not, one of them has grown a second copy of the predicate and that is the finding.

- [ ] **Step 9: Refuse buildings on an upgraded cell**

`canPlaceHouse` and `canPlaceDestination` gain `!isUpgraded(state, cell)` as a condition. **The
reachable path is narrow and real:** an upgrade's cell has road at placement, and §5.9 says nothing
spawns on road — but a player can erase every road at the cell, at which point the spawner sees bare
ground with an upgrade on it. A house under an upgrade would be undrawable and unexplainable.

```ts
  // M1f Task 9. A cell carrying a junction upgrade is not buildable, even if the
  // player has erased every road under it. The reachable path is exactly that
  // erase; §5.9's "nothing ever spawns on an existing road tile" covers the rest.
  if (isUpgraded(state, cell)) return B_UPGRADE
```

**Give it its own refusal code, `B_UPGRADE`, rather than reusing `B_BUILDING`.** The previous draft
reused `B_BUILDING` for this, which is the *"a function with more than two ways to decline puts the
reason in the signature"* rule broken at the site that states it — and a caller that logs "there is a
building here" about an empty cell with an upgrade on it is a diagnosis that sends the next reader to
the wrong file. Add it to whatever table enumerates the `B_*` codes, with a test per kind.

For a destination, the check applies to **all seven cells** (six footprint plus carpark), in the same
pass shape as the existing road check.

- [ ] **Step 10: Add the fourth action kind, and re-derive the tripwire a second time**

`TickActionKind = 'place' | 'erase' | 'choose-card' | 'upgrade'`, dispatched in `step.ts`'s input loop
to `applyPlaceUpgrade(s, world, action.a)`. The line-anchored pin in `step.test.ts` goes red **again**;
re-derive its comment **again**, and add `upgrades.ts` to the fourth half's demand-state scan set.

**No phase is appended and the phase table must say so.** Amendment 2 deleted the previous draft's
phase 12. Add a line to `step.ts`'s phase table recording that the count is final at eleven and that
M1f's relief object is a flag read inside movement rather than a phase — so the next reader neither
renumbers again nor leaves a gap for a phase that never arrives.

- [ ] **Step 11: Measure WHERE the upgrade goes — the task's real deliverable**

**Read trap 4 and trap 5 before writing this.** The question is not *"does it help"* — that is
measured (Amendment 2: +103.8 % at six cells, and Task 3 Step 3b re-measured the reachable version on
this project's own rig). **The question is whether the PLACEMENT is a real decision**, and the
previous draft never asked it: its Step 14 asserted only that *some* placement beats the control.

```ts
  it('one upgrade per junction-eligible jam cell, each measured against the same run with none', () => {
    // **The metric is TRIPS.** An upgrade never makes a car wait, so blocked
    // car-ticks is now a valid secondary read (the exemption takes them
    // 29,267 -> 2,229) — but it is REPORTED, never asserted, because a placement
    // that improves it by killing the board faster is not help. See trap 4.
    const control = runShippedArm({ upgrades: [] })
    // Ranked by JUNCTION-CAUSED refusals, not total: spillback lands on degree <= 2
    // cells that can never be seated, and ranking by the total names two of them
    // in the top six on this board. Task 3 Step 3a owns that finding.
    const hot = topCellsByJunctionRefusal(control.junctionRefusalsByCell, 6)
      .filter((cell) => everSeatable(cell))

    // **The placement tick is stated, and the placement is ASSERTED to have
    // happened.** The previous draft's version never said when the object was
    // placed; if a rig places at tick 0 or at the first boundary, EVERY placement
    // is refused (`not-a-junction` — the board has no junctions until 4,530),
    // every arm is byte-identical to the control, and the failure surfaces as
    // "at least one placement changes the run at all", which reads as an entry-rule
    // bug and sends the implementer into `canEnter`. Second review I5.
    const SEAT_TICK = 13_500            // week-3 boundary: 6 junctions exist (0 / 2 / 6 / 6)
    const rows = hot.map((cell) => {
      const r = runShippedArm({ upgrades: [cell], seatTick: SEAT_TICK })
      expect(r.placed, `applyPlaceUpgrade refused at ${cellName(cell, WORLD.w)}`).toBe(true)
      return { cell, ...r }
    })

    // The board still has the problem, so a green result is not a green board:
    expect(control.blockedCarTicks, 'the control still jams').toBeGreaterThan(10000)

    // The object does SOMETHING. An upgrade that changed nothing anywhere would
    // mean `junctionAdmitsOne`'s clause is not reaching the movement path.
    expect(rows.some((r) => r.hash !== control.hash), 'at least one placement changes the run')
      .toBe(true)

    // **The object does something GOOD at its best cell.** Measured ceiling for
    // reference, NOT as a threshold: six-cell exemption is +103.8 %, two-cell is
    // +7.1 %, and this row is ONE cell.
    const best = rows.reduce((m, r) => (r.trips > m.trips ? r : m))
    expect(best.trips, `best ${cellName(best.cell, WORLD.w)} vs control`).toBeGreaterThan(control.trips)

    // **THE SPREAD IS THE SECOND DECISION AND IT IS WHAT TASK 12 ASSERTS.** An
    // upgrade cannot make its own junction worse, so "does it help" is not the
    // interesting question; "does it matter WHERE" is. Reported here with the
    // numbers, and the threshold Task 12 uses is written from this table minus a
    // stated margin.
    const worst = rows.reduce((m, r) => (r.trips < m.trips ? r : m))
    console.log(`spread: best ${best.cell} ${best.trips} / worst ${worst.cell} ${worst.trips} ` +
      `/ control ${control.trips}`)

    // Reachability, because a placement that helps by disconnecting a destination
    // is not help:
    for (const r of rows) expect(r.allDestinationsReachable, `cell ${r.cell}`).toBe(true)

    // REPORTED, not asserted: trips, death tick, blocked car-ticks and valve
    // firings per cell, and **how many rows are strictly WORSE than the control.**
    // That last number is not zero on principle: an upgrade is a buff at its own
    // cell but relief moves traffic downstream, and the spike's eight-seed row
    // contains a -5. Task 12's criterion is written from this table.
    console.log(formatUpgradeRows(control, rows))
  })
```

**Three things this task's report must hand to Task 12, in writing, before Task 12 runs** — the
catalogue's *"a prediction written before the measurement is worth more than the measurement"*,
applied across a task boundary:

1. `BEST_MARGIN` — the best single placement's trips ratio over the control, **minus a stated
   margin**. Task 12 measures a different population (every legal junction, eight seeds), so the
   margin is not decoration.
2. `SPREAD_MARGIN` — `(best − worst) / worst` from this table, minus a stated margin.
3. **The count of single placements strictly worse than the control**, so Task 12 can say whether
   that count grew when the population did.

**And the honest caveat, which must appear in the report rather than only here:** Amendment 2's
+103.8 % was measured by exempting six cells, two of which can never be seated. **This table is the
first per-cell measurement of the reachable object**, and if its best single cell is close to the
control, the finding is that the milestone's payoff needs *several* upgrades rather than a good one —
which is a design finding about the card rate, not a defect in the object, and it goes to Task 12
Step 4's policy comparison.

- [ ] **Step 12: Run the whole suite green, and run the AFFECTED transposition rows**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS. **No golden moves** (derived above).

**There are no new phase pairs to run, and that is a deletion rather than an omission.** The previous
draft appended a twelfth phase here and owed eleven new transposition rows plus three written
predictions (`10 <-> 12`, `11 <-> 12`, `3 <-> 12`). Amendment 2 deleted the phase. What this task
*does* change is **phase 3's content** — a fourth action kind — so the rows involving phase 3 are
re-run by Task 12 Step 2 along with phase 10's, and this task runs none of its own. **Say that in the
report**, because "Task 9 ran no transposition rows" reads as a gap unless the reason is beside it.

- [ ] **Step 13: Mutation-test**

| # | Mutant | Expected |
|---|---|---|
| 1 | `junctionAdmitsOne`: delete the upgrade clause | high; must include the admits test **and** the head-on-restored test **and** Step 11's measurement |
| 2 | `isJunctionCell`: add the upgrade clause too | ≥ 1, in *"keeps the intersection slowdown"* — **this is the mutant that collapses the two predicates back into one, and it must not score 0** |
| 3 | `junctionAdmitsOne`: `!== 0` → `=== 0` | ≥ 1, in the four-case table and in every entry test |
| 4 | `canPlaceUpgrade`: check `roadDegree >= 2` | ≥ 1, in the corridor refusal |
| 5 | `canPlaceUpgrade`: drop the `capacity` check | ≥ 1, in the `MAX_UPGRADES` test. **Note the correction to the previous draft's hazard note here:** it warned that the slot write would corrupt the buffer past the region. There is no slot and there is no such write — and a typed-array write past `length` is **silently discarded** by the runtime, not corrupting, so the previous note was wrong on both counts |
| 6 | `canPlaceUpgrade`: reorder `no-inventory` after `not-a-junction` | ≥ 1, in the both-wrong-at-once test |
| 7 | `canPlaceUpgrade`: drop the `occupied` check | ≥ 1, in the already-upgraded test — **and the inventory would drain with no second effect, so check the count assertion catches it too** |
| 8 | `applyPlaceUpgrade`: write `upgradeAt[cell] = 0` | ≥ 1 |
| 9 | `applyPlaceUpgrade`: skip the inventory decrement | ≥ 1 |
| 10 | `applyPlaceUpgrade`: skip the `H_UPGRADE_COUNT` increment | ≥ 1, in the count assertion **and** in Task 12 Step 5's two-directional invariant |
| 11 | `applyPlaceUpgrade`: write the flag before checking validity | ≥ 1, in *"changes NOTHING when validity refuses"* (`hashState` unchanged) |
| 12 | `canPlaceHouse` / `canPlaceDestination`: drop the upgrade refusal | ≥ 1 each |
| 13 | `canPlaceDestination`: check only the centre cell, not all seven | ≥ 1 — **and if 0, the fixture does not place an upgrade under a non-centre footprint cell and must** |
| 14 | `step.ts`: dispatch `'upgrade'` to `placeRoad` | ≥ 1 |
| 15 | `isUpgraded`: `!== 0` → `> 1` | ≥ 1 — the flag is 1, so this makes every upgrade invisible |

**Fifteen rows against the previous draft's twenty-six, and the missing eleven are not lost
coverage** — they tested a controller, an axis selector, a demand read and a 64-pair turn table that
no longer exist. Task 12 Step 8's grep is what proves they are gone rather than merely untested.

- [ ] **Step 14: Commit**

The commit message must carry: the mechanism (the mutual-exclusion rule lifted at one cell, giving
the head-on property back whole, with the two-upgrade and one-upgrade fixtures named); **the fact that
`canEnter` was not touched and `EnterOutcome` did not grow**; the §5.6 amendment with the light's
measured numbers and its M1g recipient; that no phase was appended and the count is final at eleven;
and **Step 11's per-cell table with the metric named as trips, the seat tick stated, and the spread
between the best and worst legal placement**, which is the number Task 12's criterion is built from.

---

## Task 10: The chip, the gesture, the marker — and the whole loop from a screen coordinate to a state flag

**Observability: the payoff.** A player who took the junction-upgrade card sees a **chip in the top band with a badge reading 2**. Tapping it highlights the board; tapping a junction drops an upgrade there, drawn as a static marker on the cell. Traffic that was stopping dead at that corner from **8:56** crosses it again, the way it did before minute seven — the queue drains and does not re-form there. **Nothing about the marker animates**, and that is a deliberate consequence of Amendment 2: the feedback is entirely in the traffic. **Put it on the right corner and the run lasts measurably longer; put it on a corner that was not the constraint and almost nothing changes** — and the size of that gap is what Task 12 measures.

**Files:**
- Modify: `packages/render/src/types.ts` (`HudRects.upgrades`, `RenderFrame.upgradeAt`/`upgradeCount`/`invUpgrades`/`upgradeMode`), `camera.ts`, `canvas.ts`, `palette.ts`
- Modify: `packages/game/src/frame.ts`, `pointer.ts`, `main.ts`
- Test: `packages/render/test/canvas.test.ts`, `camera.test.ts`, `boundary.test.ts`, `packages/game/test/pointer.test.ts`, `frame.test.ts`, `integration.test.ts`

**Interfaces:**
- Consumes: `isUpgraded`, `H_INV_UPGRADES`, `H_UPGRADE_COUNT`, the `upgradeAt` region (Tasks 4, 9); `queue.enqueue('upgrade', cell, 0)` (Task 9).
- Produces: `HudRects.upgrades: Rect`; `RenderFrame.upgradeAt: Uint8Array` (**raw view**), `upgradeCount: number`, `invUpgrades: number`, `upgradeMode: boolean`; `PointerOutcome.UPGRADE_ARMED = 13`, `UPGRADE_PLACED = 14`; `PointerInput.upgradeMode: boolean`; `PointerHost.upgradesHeld: () => number`.
- **Produces no colour constant.** See Step 2.

- [ ] **Step 1: Resolve the chip's home with a measurement, before writing any rect**

§7.2's inventory chip row arrives with its first chip, and **where it goes is a fork with a measurable
answer, not a preference.**

- **Preferred: the TOP BAND.** `canvas.ts`'s phase 1 already fills a top band above the playfield and
  it currently holds nothing. A chip there changes **no existing rect**, so `hudRects`'s three equal
  columns and every geometry test that reads them are untouched.
- **The fork:** measure `camera.gridTop` across the three viewport sizes `camera.test.ts` already
  covers, including the degenerate clamps `fitCamera` produces. **If the smallest is below
  `CHIP_MIN_CSS + 2 * HUD_PAD_CSS`, the chip goes in the bottom band as a FOURTH column**, and then
  every `hudRects` geometry test moves and must be **re-derived rather than nudged**, with the
  degenerate clamps still covered.

Record the three measured `gridTop` values and the decision in the task report. **Do not write the
rect before this step is answered.**

The pointer hit-tests `rects.upgrades` **explicitly, before the `HitRegion` dispatch**, in the same
idiom the offer-modal branch uses — so `HitRegion` gains no value and `screenToGrid` is untouched.
`camera.test.ts` asserts the chip rect lies entirely inside its band and overlaps neither the grid
rect nor the other HUD rects, at all three viewport sizes.

- [ ] **Step 2: There is NO cross-package fold for the marker, and that is the step**

**The previous draft needed one and Amendment 2 deleted the need.** Its relief object had a phase, so
`render` had to know green from amber without importing `LIGHT_NO_PENDING`: `game` folded
`lightAmberFor` into a two-value colour byte, `render` owned `LIGHT_COLOUR_GREEN`/`LIGHT_COLOUR_AMBER`,
and `frame.test.ts` pinned that the two agreed. **An upgrade has no state to fold.**

So:

```ts
// packages/render/src/types.ts
  /**
   * One flag per cell: non-zero means a junction upgrade sits there. A RAW VIEW
   * of `sim`'s `upgradeAt` region, exactly as `roads` and `ghosts` are — assigned
   * once in `createFrameBuilder` and never rewritten — because `sim` already
   * stores it in the shape `render` wants and a per-frame copy would be a second
   * copy with a staleness question attached.
   */
  readonly upgradeAt: Uint8Array
  /** How many are placed. Drawn nowhere; used to skip the marker pass entirely at zero. */
  readonly upgradeCount: number
```

```ts
// packages/game/src/frame.ts, in createFrameBuilder — ONCE, not per frame
  frame.upgradeAt = state.upgradeAt
// and in buildFrame's HUD block
  frame.upgradeCount = state.header[H_UPGRADE_COUNT] as number
  frame.invUpgrades = state.header[H_INV_UPGRADES] as number
```

**`canvas.ts` draws the marker inside the pass it already makes over the board's cells**, keyed on
`upgradeAt[cell] !== 0`, so there is no second iteration and no list to keep in sync. That also
deletes a whole trap the previous draft had to warn about — *"a renderer that iterated the array
length instead of the count would draw 24 lights at cell 0"* — because there is no
`MAX_*`-length array of cell indices any more.

**What still crosses the boundary and still needs pinning is the CARD, not the marker**, and Task 8
already owns those pins (`CARD_LABELS.length === CARD_COUNT`, the two offerable labels, and the grants
as numbers on the frame). Add one line to `packages/game/test/frame.test.ts` here:

```ts
  it('the frame carries sims upgrade flags by reference, not by copy', () => {
    // A copy would be a second source of truth for a per-cell array that `sim`
    // rewrites; a view cannot go stale. Same construction as `roads`.
    const rig = bootCity()
    const f = buildFrame(rig)
    expect(f.upgradeAt, 'the same object, not an equal one').toBe(rig.s.upgradeAt)
  })
```

- [ ] **Step 3: Write the failing render tests**

```ts
describe('the upgrade marker and the inventory chip', () => {
  it('draws a marker on every upgraded cell and on no other', () => {
    const cmds = draw(frameWith({ upgradeAt: flagsAt([100, 205]), upgradeCount: 2 }))
    expect(markerCells(cmds)).toEqual([100, 205])
  })

  it('draws nothing at all when no upgrade is placed', () => {
    const cmds = draw(frameWith({ upgradeAt: flagsAt([]), upgradeCount: 0 }))
    expect(markerCells(cmds)).toEqual([])
  })

  it('draws the marker UNDER the buildings and OVER the road mask', () => {
    // Ordering is the one thing a static glyph can still get wrong: a marker
    // drawn over a destination hides the thing the player is routing to.
    const cmds = draw(frameWith({ upgradeAt: flagsAt([CELL]), upgradeCount: 1 }))
    expect(indexOfRoadMask(cmds)).toBeLessThan(indexOfMarker(cmds))
    expect(indexOfMarker(cmds)).toBeLessThan(indexOfDestinations(cmds))
  })

  it('draws the chip with a numeric badge when upgrades are held', () => {
    const texts = textsOf(draw(frameWith({ invUpgrades: 2 })))
    expect(texts).toContain('2')
  })

  it('SUPPRESSES the badge and greys the chip at zero held, per 2.2', () => {
    // §2.2: "solid dark icon + numeric badge when held, grey outline, badge
    // suppressed at zero".
    const cmds = draw(frameWith({ invUpgrades: 0 }))
    expect(textsOf(cmds)).not.toContain('0')
    expect(cmds.some((c) => c.strokeStyle === PALETTE.chipOutline)).toBe(true)
  })

  it('draws the chip in the ACCENT colour while the mode is armed', () => {
    // The mode must be visible, or a player who armed it by accident has no way to
    // know why their next tap did not draw a road.
    const armed = draw(frameWith({ invUpgrades: 1, upgradeMode: true }))
    const idle = draw(frameWith({ invUpgrades: 1, upgradeMode: false }))
    expect(chipFill(armed)).toBe(PALETTE.cardAccent)
    expect(chipFill(idle)).not.toBe(PALETTE.cardAccent)
  })

  it('allocates nothing per frame: the badge text is memoised on the number', () => {
    expect(badgeText(2)).toBe(badgeText(2))
  })
})
```

- [ ] **Step 4: Write the failing pointer tests**

```ts
describe('the upgrade chip and its placement gesture', () => {
  it('arms the mode when the chip is tapped and the badge is non-zero', () => {
    const h = host({ upgradesHeld: 2 })
    const p = createPointerInput(h)
    expect(p.down(1, ...centreOf(hudRects(h.camera(), hr).upgrades))).toBe(PointerOutcome.UPGRADE_ARMED)
    expect(p.upgradeMode).toBe(true)
  })

  it('refuses to arm at zero held, and HUD_INERT is the honest answer there', () => {
    const h = host({ upgradesHeld: 0 })
    expect(createPointerInput(h).down(1, ...centreOf(hudRects(h.camera(), hr).upgrades))).toBe(
      PointerOutcome.HUD_INERT,
    )
  })

  it('queues an upgrade action at the tapped cell and DISARMS', () => {
    const h = host({ upgradesHeld: 2 })
    const p = createPointerInput(h)
    p.down(1, ...centreOf(hudRects(h.camera(), hr).upgrades))
    expect(p.down(2, ...pointOnCell(JUNCTION))).toBe(PointerOutcome.UPGRADE_PLACED)
    expect(lastAction(h.queue)).toEqual({ kind: 'upgrade', a: JUNCTION, b: 0 })
    expect(p.upgradeMode, 'one tap, one attempt').toBe(false)
  })

  it('disarms on a REFUSED placement too, and the badge is the feedback', () => {
    // `pointer.ts` cannot know whether `sim` accepted — it is in `game` and must
    // not grow a `sim` import. One tap, one attempt, and a badge that did not
    // decrement is what tells the player it was refused. The alternative — a latch
    // that watches the count — is a second piece of state that can disagree.
    const h = host({ upgradesHeld: 1 })
    const p = createPointerInput(h)
    p.down(1, ...centreOf(hudRects(h.camera(), hr).upgrades))
    p.down(2, ...pointOnCell(BARE_GROUND))
    expect(p.upgradeMode).toBe(false)
  })

  it('does NOT start a drag while armed', () => {
    const h = host({ upgradesHeld: 1 })
    const p = createPointerInput(h)
    p.down(1, ...centreOf(hudRects(h.camera(), hr).upgrades))
    p.down(2, ...pointOnCell(JUNCTION))
    expect(p.dragging).toBe(false)
    expect(h.queue.length, 'exactly one action, and it is not a road').toBe(1)
  })

  it('a second chip tap cancels', () => {
    const h = host({ upgradesHeld: 2 })
    const p = createPointerInput(h)
    p.down(1, ...centreOf(hudRects(h.camera(), hr).upgrades))
    p.down(2, ...centreOf(hudRects(h.camera(), hr).upgrades))
    expect(p.upgradeMode).toBe(false)
  })

  it('is below the offer modal and below game over', () => {
    const h = host({ upgradesHeld: 1, offerPending: true })
    expect(createPointerInput(h).down(1, ...centreOf(hudRects(h.camera(), hr).upgrades))).toBe(
      PointerOutcome.REFUSED_OFFER_MODAL,
    )
  })

  it('is refused while paused by the HUD clock, like every other board action', () => {
    const h = host({ upgradesHeld: 1, paused: true })
    const p = createPointerInput(h)
    p.down(1, ...centreOf(hudRects(h.camera(), hr).upgrades))
    expect(p.down(2, ...pointOnCell(JUNCTION))).toBe(PointerOutcome.REFUSED_PAUSED)
    expect(p.upgradeMode, 'and the mode is dropped rather than latched over a paused board').toBe(false)
  })
})
```

- [ ] **Step 5: Implement the chip, the mode and the marker**

`canvas.ts` draws the marker **after** the road mask layers and **before** the destinations, so it
sits on the road and under the buildings; `drawHud`'s chip is drawn in the band Step 1 chose, with the
badge suppressed at zero and the accent fill while armed. The badge text uses the same memoised
number→string cache `scoreText` establishes.

**Choose a marker that reads as "this junction resolves", not as a signal.** It has no state, so it
must not look like something that could change: a filled diamond or a ring centred on the cell, in a
single accent colour, sized well inside the tile so the road mask stays legible under it. **Record the
choice and the reason in the task report**, because Task 12's device session asks whether a person can
tell an upgraded corner from a plain one at a glance, and the answer is a property of this decision.

- [ ] **Step 6: Run the whole suite green**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS. No golden moves — nothing here is in `sim`.

- [ ] **Step 7: Prove the whole loop end to end, on the production boot**

In `integration.test.ts`, extending Task 8 Step 9's test: drive to the week-1 boundary, tap the
junction-upgrade card, tap the chip, tap a junction cell **the run's own junction-caused refusal tally
names**, and assert — `H_INV_UPGRADES` 2 → 1, `H_UPGRADE_COUNT` 1, `upgradeAt` set on that cell,
`tilesLeft` unchanged by the placement, the frame carrying a marker at that cell, and **a car crossing
that cell within the following 300 ticks on a tick when the other lane is occupied** — which is the
behaviour, rather than the flag, and is the only thing that proves the loop reached the movement path.
**This is the only test in the repo that goes from a screen coordinate to a `sim` region and back to a
pixel**, and it is the one that would catch a rect/draw/hit-test mismatch that all three packages' own
tests miss.

**Note the timing constraint this test has to respect and the previous draft's version did not:** the
board's first junction is born at tick **4,530**, thirty ticks *after* the week-1 boundary. A test
that taps a junction at 4,500 taps bare ground and gets `not-a-junction`. Drive past the boundary far
enough for a junction to exist, and **assert the placement returned true** rather than inferring it
from a later effect.

- [ ] **Step 8: Mutation-test**

| # | Mutant | Expected |
|---|---|---|
| 1 | `canvas.ts`: draw a marker on every cell, ignoring `upgradeAt` | ≥ 1, in the marker-cells test |
| 2 | `canvas.ts`: draw the marker after the destinations | ≥ 1, in the layer-order test |
| 3 | `canvas.ts`: draw the badge at zero held | ≥ 1, in the suppression test |
| 4 | `canvas.ts`: ignore `upgradeMode` for the chip fill | ≥ 1, in the armed-colour test |
| 5 | `frame.ts`: copy `upgradeAt` into a fresh array each frame instead of assigning the view | ≥ 1, in the by-reference pin — **and check `drawAllocation.test.ts` too; a per-frame 960-byte copy should also breach the 4 B/frame floor, and if it does not, say so** |
| 6 | `pointer.ts`: keep `upgradeMode` armed after a placement | ≥ 1, in the disarm test |
| 7 | `pointer.ts`: arm the mode at zero held | ≥ 1 |
| 8 | `pointer.ts`: enqueue `'place'` instead of `'upgrade'` | ≥ 1, in the queued-action test |
| 9 | `pointer.ts`: put the chip branch above the offer-modal branch | ≥ 1, in the ordering test |
| 10 | `pointer.ts`: allow a placement while paused | ≥ 1, in the paused test |

- [ ] **Step 9: Commit**

---

## Task 11: The pool filter by MAP capability

**Observability:** nothing on the default board — `firstCity` has water and mountain, and the unconditional cards are capable everywhere, so its capability mask is all seven and the shipped pool is unchanged. **Say that out loud rather than letting a green suite read as a feature.** What the task buys is that a map with no water can never offer a bridge, and that the rule which lets M1g add the other four cards is a bit-deletion rather than a re-derivation.

**Files:**
- Modify: `packages/sim/src/cards.ts` (`capabilityMask`, `poolFor`)
- Test: `packages/sim/test/cards.test.ts`

**Interfaces:**
- Consumes: `CARD_*`, `CARD_IMPLEMENTED_MASK`, `poolFor` (Tasks 4–5).
- Produces: `capabilityMask(world: WorldData): number`; `poolFor(world)` becomes `capabilityMask(world) & CARD_IMPLEMENTED_MASK`. **The signature does not change**, which is the one place a redefinition could go unnoticed — Step 3 re-derives the two golden assertions that read it.

**The correction this task exists to carry.** The previous draft made the roundabout's capability
*"the map has at least one all-passable 3×3 block"* — a scan of the current board. **Capability is a
property of the MAP, not of the board state**, and dossier line 227 says so in one sentence:
*"Pool is filtered by map capability: tunnels only on mountain maps, bridges absent on Mexico City,
roundabouts/lights/motorways everywhere."* Making it state-dependent is what collapsed the state
golden's pool to one card and threw inside `step`. **Road tiles, lights, motorways, roundabouts and
M1f's junction upgrade are capable unconditionally**; bridges need water and tunnels need mountain,
and that is the whole filter. The junction upgrade is not a dossier row at all — it is M1f's own item
— and it is capable everywhere for the same reason road tiles are: it needs nothing from the terrain.

- [ ] **Step 1: Write the failing tests, on the two SHIPPED maps and on every fixture that crosses a boundary**

```ts
describe('capabilityMask — spec 5.10, "the pool is filtered by map capability"', () => {
  it('firstCity has water and mountain, so bridge and tunnel are capable there', () => {
    const m = capabilityMask(createWorld(firstCity()))
    expect((m & (1 << CARD_BRIDGE)) !== 0, 'the river at column 12').toBe(true)
    expect((m & (1 << CARD_TUNNEL)) !== 0, 'the mountain at rows 5-7').toBe(true)
  })

  it('demoCity has NEITHER, so both are excluded there', () => {
    // **Both arms of this filter are reachable on the two boards that ship**,
    // which is the catalogue's "measure which cases the shipped configuration can
    // actually produce" satisfied by the game rather than by a fixture.
    const m = capabilityMask(createWorld(demoCity()))
    expect((m & (1 << CARD_BRIDGE)) !== 0).toBe(false)
    expect((m & (1 << CARD_TUNNEL)) !== 0).toBe(false)
  })

  it('road tiles, lights, motorways and the JUNCTION UPGRADE are capable EVERYWHERE, including a barren map', () => {
    // Dossier §2.1: "roundabouts/lights/motorways everywhere". This is the row the
    // previous design got wrong by making an item's capability depend on the board
    // rather than the map, and the pool then fell below two on a golden fixture
    // and threw inside `step`. `CARD_JUNCTION_UPGRADE` joins them: it needs nothing
    // from the terrain, and it is the card that keeps the shipped pool at two.
    for (const w of [createWorld(firstCity()), createWorld(demoCity()), createWorld(barren())]) {
      for (const id of [CARD_ROAD_TILES, CARD_TRAFFIC_LIGHTS, CARD_MOTORWAY, CARD_JUNCTION_UPGRADE]) {
        expect((capabilityMask(w) & (1 << id)) !== 0, `card ${id}`).toBe(true)
      }
    }
  })

  it('reads TERRAIN only: covering the board in roads and buildings changes nothing', () => {
    const rig = bootCity()
    const at0 = capabilityMask(rig.world)
    fillEveryPassableCellWithRoad(rig)
    expect(capabilityMask(rig.world), 'capability is a property of the map').toBe(at0)
  })

  it('is a pure function of terrain, so it cannot change during a run', () => {
    const rig = bootCity()
    const at0 = capabilityMask(rig.world)
    for (let w = 1; w <= 6; w++) {
      driveTo(rig, TICKS_PER_WEEK * w)
      chooseWhateverIsOffered(rig)
      expect(capabilityMask(rig.world), `week ${w}`).toBe(at0)
    }
  })
})

describe('poolFor is the two filters, with two reasons', () => {
  it('is the capability mask AND the implemented mask', () => {
    const w = createWorld(firstCity())
    expect(poolFor(w)).toBe(capabilityMask(w) & CARD_IMPLEMENTED_MASK)
  })

  it('excludes the five cards with no placement mechanism even where the map is capable', () => {
    const m = poolFor(createWorld(firstCity()))
    for (const id of [CARD_BRIDGE, CARD_TUNNEL, CARD_ROUNDABOUT, CARD_MOTORWAY, CARD_TRAFFIC_LIGHTS]) {
      expect((m & (1 << id)) !== 0, `card ${id} is offerable with nothing to place`).toBe(false)
    }
  })

  it('ALWAYS leaves at least two cards on EVERY map any test drives past a week boundary', () => {
    // **The guard the previous draft got wrong, and the one that would have caught
    // its Critical.** Its version iterated the two SHIPPED maps — neither of which
    // is a fixture that drives `step` past tick 4,500 — while the map that
    // actually broke was `determinism.test.ts`'s 4x4 GOLDEN_MAP. Enumerate the
    // fixtures, not the products.
    const maps: readonly [string, MapData][] = [
      ['firstCity', firstCity()],
      ['demoCity', demoCity()],
      ['GOLDEN_MAP (determinism.test.ts, 13,499 ticks)', GOLDEN_MAP],
      ['the demand-pin golden 20x9 (loop.test.ts)', DEMAND_PIN_MAP],
      ['allLandRows(20, 9)', allLandRows(20, 9)],
      ['striped (this file)', parseMap('striped', STRIPED_ROWS, 30, 8, 4, 2)],
      ['barren', barren()],
    ]
    for (const [name, map] of maps) {
      expect(popCountCards(poolFor(createWorld(map))), `${name} cannot offer a pair`)
        .toBeGreaterThanOrEqual(2)
    }
  })

  it('and every card it admits has a tile grant and an item grant', () => {
    const m = poolFor(createWorld(firstCity()))
    for (let id = 0; id < CARD_COUNT; id++) {
      if ((m & (1 << id)) !== 0) {
        expect(() => cardTileGrant(id)).not.toThrow()
        expect(() => cardItemGrant(id)).not.toThrow()
      }
    }
  })
})
```

**THREE OF THOSE SEVEN NAMES DO NOT RESOLVE AS WRITTEN, and an implementer will discover it as a
module error rather than as a decision.** Fix each deliberately, in this step, and say which route
was taken:

- **`GOLDEN_MAP`** is declared **inside a `describe`** in `determinism.test.ts` and is not exported.
  Hoist it to module scope and export it, or move it to a shared fixture module. It is the map that
  produced the original Critical, so it must be in this list — do not drop it because it is awkward
  to reach.
- **`DEMAND_PIN_MAP`** does not exist under any name: the demand-pin golden's 20×9 fixture is built
  inline in `loop.test.ts`. Extract and export it under that name.
- **`barren()`** does not exist. Define it in `cards.test.ts` itself — an all-land map with no water
  and no mountain — and say so at the site, because it is the only fixture here whose whole job is to
  make both conditional bits false at once.

**A guard that cannot be imported is a guard that gets deleted**, and this one is the second half of
the fix for the review's Critical 2.

- [ ] **Step 2: Run to verify they fail; implement**

```ts
/**
 * The cards this MAP could ever offer — spec §5.10's *"pool is filtered by map
 * capability (no tunnels without mountains, no bridges without water)"*, and
 * dossier §2.1's *"roundabouts/lights/motorways everywhere"*.
 *
 * **A pure function of IMMUTABLE TERRAIN, and that word is the whole correction.**
 * The first design of this function asked whether the CURRENT BOARD had room for
 * a 3x3 roundabout — a state-dependent capability — and on a 4x4 golden fixture
 * the answer was no, the pool fell to one card, and `runOffer` threw inside `step`
 * after `H_EPOCH` had been written, poisoning the buffer for 9,000 ticks.
 * Capability answers what the MAP permits; `canPlaceUpgrade` answers what the board
 * permits, and it refuses with a reason.
 *
 * **Not cached, deliberately.** A cached mask is a second copy of a derived value
 * with a staleness question attached, and `cards.test.ts` asserts the answer is
 * identical at six consecutive boundaries rather than trusting the word
 * "immutable".
 *
 * **Cost, corrected.** The previous comment said this runs *"once every 4,500
 * ticks, which is nothing"*. False: `runOffer` calls it on **every tick of an
 * unresolved week**. In a browser that is the up-to-7 ticks before the modal's
 * pause lands. In a Worker replaying a log with no choice in it, it is a whole
 * week — so the scan early-exits the moment both flags are set, which on
 * `firstCity` is a few hundred cells and on a map with neither is the full 960.
 * Under the floor either way, and stated as an argument rather than a measurement.
 */
export function capabilityMask(world: WorldData): number {
  let mask =
    (1 << CARD_ROAD_TILES) |
    (1 << CARD_TRAFFIC_LIGHTS) |
    (1 << CARD_MOTORWAY) |
    (1 << CARD_ROUNDABOUT) |
    (1 << CARD_JUNCTION_UPGRADE)
  let water = 0
  let mountain = 0
  for (let c = 0; c < world.cells; c++) {
    const t = world.terrain[c] as number
    if (t === TERRAIN.WATER) water = 1
    else if (t === TERRAIN.MOUNTAIN) mountain = 1
    if (water === 1 && mountain === 1) break
  }
  if (water === 1) mask |= 1 << CARD_BRIDGE
  if (mountain === 1) mask |= 1 << CARD_TUNNEL
  return mask
}

export function poolFor(world: WorldData): number {
  return capabilityMask(world) & CARD_IMPLEMENTED_MASK
}
```

Note that `CARD_ROUNDABOUT` is **capable everywhere** and excluded by `CARD_IMPLEMENTED_MASK`, which
is the correct division: the map can seat one, and M1f has no mechanism to place one. **M1g deletes a
bit; it does not touch this function.** Say so at the site.

- [ ] **Step 3: Re-assert the two moved goldens' offer slots against the narrowed pool, and un-skip Task 5's degradation test**

Task 5 asserted the state golden's and the demand-pin golden's offer slots by hand from `poolFor`.
**`poolFor` has changed**, so re-derive both. On both fixtures' maps the answer is the same two cards
— lights and road tiles are capable everywhere and neither map's terrain adds an implemented card — so
the digests should **NOT** move. **Verify that by running, not by arguing**, and if either moves, the
narrowing changed a draw and the re-bless belongs to this task with its own derivation.

Then un-skip Task 5's short-pool degradation test if it was skipped, using a fixture whose
`CARD_IMPLEMENTED_MASK` intersection is one card, and record how it was built.

- [ ] **Step 4: Run the whole suite green**

Run: `pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`
Expected: PASS, no goldens moved.

- [ ] **Step 5: Mutation-test**

| # | Mutant | Expected |
|---|---|---|
| 1 | `capabilityMask`: set the bridge bit unconditionally | ≥ 1, on `demoCity` |
| 2 | `capabilityMask`: set the tunnel bit unconditionally | ≥ 1, on `demoCity` |
| 3 | `capabilityMask`: swap the water and mountain arms | ≥ 1, on `demoCity`; **if 0, the fixture cannot distinguish them and a map with water but no mountain is needed** |
| 4 | `capabilityMask`: drop `CARD_JUNCTION_UPGRADE` from the unconditional set | high — it empties the shipped pool below two; **and confirm the failure is `runOffer`'s degradation and not a throw**, because that is the whole point of Task 5's guard |
| 4b | `capabilityMask`: drop `CARD_TRAFFIC_LIGHTS` from the unconditional set | **0 expected**, because `CARD_IMPLEMENTED_MASK` excludes it anyway. Record it as the honest cost of declaring a deferred card: its capability bit has no detector until M1g implements it |
| 5 | `capabilityMask`: gate lights on `world.cells > 0` | 0 expected, equivalent; record it |
| 6 | `capabilityMask`: delete the early exit | 0 expected, equivalent; record it as a pure-cost mutant with the reason |
| 7 | `poolFor`: return `capabilityMask` alone | ≥ 1, in the five-unimplemented-cards test |
| 8 | `poolFor`: return `CARD_IMPLEMENTED_MASK` alone | **0 expected on every map**, because both implemented cards are capable everywhere. Record it, and note this is the honest consequence of the correction: with a state-independent capability and two universally-capable cards, the capability half of the filter has **no shipped detector at all**. Its detectors are the bridge/tunnel arms on `demoCity`, which are about cards M1f cannot offer. **Say that plainly rather than inventing a fixture** — it is what "M1g deletes bits" means |

- [ ] **Step 6: Commit**

---

## Task 12: Integration, the long run, the sweep, the deploy, the handoff

**Observability:** the whole milestone, checked by a person. This task's deliverable is not code; it is evidence, and the one thing it must not do is report a figure it did not measure.

**Files:**
- Create: `packages/game/test/upgradeSweep.ts`, `docs/superpowers/m1g-carry-forward.md`
- Modify: `packages/game/test/integration.test.ts`, `packages/sim/src/step.ts` (the sweep table), and every durable artefact whose figures this milestone moved

**Interfaces:**
- Consumes: everything Tasks 1–11 produce. Specifically `countJunctionConflicts` with **both** policies (Task 1), the shipped junction rule as a **single named predicate** so Step 1 can revert it cleanly (Task 3), `runJunctionArm`'s `junctionRefusalsByCell` (Task 3), `canPlaceUpgrade` / `applyPlaceUpgrade` / `isUpgraded` (Task 9), `takeCardPolicy` (Task 7), and `poolFor` (Task 11).
- Produces: `sweepUpgradePlacements(seed: string): readonly UpgradeSweepRow[]` from `packages/game/test/upgradeSweep.ts`, where `UpgradeSweepRow = { readonly cell: number; readonly deathTick: number; readonly trips: number; readonly blockedCarTicks: number; readonly valveFirings: number; readonly reachable: boolean }`; and `docs/superpowers/m1g-carry-forward.md`.

- [ ] **Step 1: Reproduce inherited numbers before contradicting anything — ONE probe, three claims**

Before this task believes its own rig about anything, drive the greedy arm with **Task 3's shipped
rule reverted** — the revert of the **one named predicate** Task 3 Step 5 requires, on a committed
tree, restored by an `&&`-chained command — and assert it reproduces the pre-M1f record exactly:
**31,456 / 747 / 0 refusals / 2,120 blocked car-ticks**. This project's closing sweep has caught its
own harness twice this way, and both times every conclusion drawn from the bad rig would have been *a
confident correction of a correct figure*.

**Name the revert, precisely, here and in Task 3 Step 5.** The rule ships behind a single named
function — `crossesDirections` under arm B — and this probe is the whole reason that is a requirement
rather than a preference: a rule smeared across `canEnter` cannot be reverted mechanically, and a
probe that has to be hand-reconstructed is a probe nobody runs.

**And run the census in the SAME probe, rather than a second time in Step 7.** Both census figures
are properties of the **rule-disabled** board:

| figure | policy | value to reproduce |
|---|---|---|
| rule-visible | `CENSUS_RULE_VISIBLE` | **271 events, first at 12,780, five cells** |
| co-presence | `CENSUS_CO_PRESENCE` | **232 events, first at 15,001, six cells** |

**Say plainly in the report that these are PROBE-ONLY figures from Task 2 onward.** After Task 2 the
shipped board has no rule-disabled arm — Decision 3 declined the runtime switch — so these six numbers
have no standing assertion outside this reverted probe and Task 3 Step 7's. That is the second
review's I9, and the honest resolution is to say so rather than to build the switch or to drop the
figures: **Task 3 Step 7 and this step are the only two places they are checked, they use the same
revert, and the report names both.**

**Note that the arm must be driven through `step`, not through `game.frame`**, or Task 7's card policy
adds tiles the pre-M1f record did not have and the reproduction fails for a reason that is not a bug.
Say which driver was used.

- [ ] **Step 2: Re-run the transposition rows whose phases changed, and PROVE the rest did not**

The tick order is **eleven** phases: Task 5 inserted the offer at 4 and **nothing else moved**.
Amendment 2 deleted the previous draft's appended phase 12, so the arithmetic here is re-derived
rather than carried: `C(11, 2) = 55` pairs. **Two** phases' content changed after Task 5's own 55-pair
sweep — **phase 3** (Tasks 6 and 9 added two action kinds, a clock read and an `H_TILES` write) and
**phase 10** (Task 9's clause in `junctionAdmitsOne`, which `canEnter` reads from inside movement).
Pairs involving at least one of `{3, 10}` are `55 − C(9, 2) = 55 − 36 = **19 rows**`, plus four fresh
unmutated baselines.

**Phase 10's row set is included even though Task 9 did not edit `cars.ts` or `blocking.ts`**, and the
reason is worth stating: the phase's *behaviour* changed because a predicate it calls gained a clause.
A sweep scoped by "which files did we edit" would have missed it.

**The remaining 36 are PROVEN, not assumed**: `git diff <Task-5-commit>..HEAD --stat` over the files
each of those phases calls must show no change to the phases involved, and the proof goes in the
report as the command and its output. *"One row is not the sweep"* cuts both ways — a claim that 36
rows still hold is a claim, and a `git diff` is the cheapest honest evidence for it.

Run the control as many times as each mutant; screen crashes on non-vitest-result lines and record
every matched line; run the complement check.

- [ ] **Step 3: The upgrade placement sweep — bounded, controlled, timed, and asserting the SPREAD**

Create `packages/game/test/upgradeSweep.ts`.

**The enumeration is bounded by construction and that is the point.** `canPlaceUpgrade` accepts only
junctions, and the shipped board's greedy arm produces on the order of tens of them, not hundreds —
**measure and report the count**; the previous milestone's shape enumerated 545 candidate centres of
which about 518 were bare grass and bit-identical to the control. Enumerate every cell
`canPlaceUpgrade` accepts at the week-3 boundary of the greedy arm (**six junctions exist there,
against two at week 2 and none at week 1** — Task 3 Step 3a's site table); for each, run the greedy
arm to death with that one placement and nothing else; the control is the same arm with the card taken
and **nothing placed**.

```ts
  it('an upgrade is a decision: where it goes changes the run, and the best placement beats doing nothing', () => {
    const rows = sweepUpgradePlacements(SHIPPED_SEED)
    const control = sweepControl(SHIPPED_SEED)

    // Not vacuous, and BOUNDED — report the number rather than asserting a large one.
    expect(rows.length, 'the sweep found some junctions').toBeGreaterThan(5)
    expect(rows.length, 'and not so many that this is a 40-minute test').toBeLessThan(120)

    // The board has the problem, so a green result is not a green board:
    expect(control.blockedCarTicks, 'the control still jams').toBeGreaterThan(10000)

    // **The metric is TRIPS.** An upgrade never makes a car wait, so blocked
    // car-ticks is a valid secondary read here — unlike the metered object this
    // milestone started with — but it is still REPORTED per row and asserted
    // nowhere, because a placement that improves it by killing the board faster is
    // not help. See trap 4.
    const best = rows.reduce((m, r) => (r.trips > m.trips ? r : m))
    const worst = rows.reduce((m, r) => (r.trips < m.trips ? r : m))

    // Both thresholds are written into this step BY TASK 9'S REPORT, from its
    // per-cell table, minus a stated margin — a prediction made before this
    // measurement, across a task boundary. Task 9 measured the junction-eligible
    // hot cells on one seed; this measures EVERY legal junction on eight, so the
    // two are different populations and the margin is why.
    expect(best.trips / control.trips, 'the object helps at all').toBeGreaterThan(1 + BEST_MARGIN)

    // **THIS IS THE MILESTONE'S SECOND ACCEPTANCE CRITERION AND THE ONE THAT
    // CHANGED.** An upgrade cannot make its own junction worse — at its cell it
    // admits a strict superset of what the bare junction admits — so "does it
    // help" is settled and "does it matter WHERE" is not. A relief object whose
    // placements all score the same is free income with a tap attached, and the
    // modal is then a decision with one right answer.
    expect((best.trips - worst.trips) / worst.trips, 'and WHERE it goes matters')
      .toBeGreaterThan(SPREAD_MARGIN)

    // A placement that helps by disconnecting a destination is not help:
    for (const r of rows) expect(r.reachable, `cell ${r.cell} disconnected a destination`).toBe(true)

    // **Reported as named lines, not asserted.** The first is the answer to "is
    // the item card a risk or free income". The second is the reachability bound
    // that decides how much of the measured ceiling a player can actually get.
    const worseThanControl = rows.filter((r) => r.trips < control.trips).length
    console.log(`placements strictly worse than the control: ${worseThanControl} of ${rows.length}`)
    console.log(`legal sites per boundary (Task 3 measured 0 / 2 / 6 / 6): ${sitesPerBoundary()}`)
    console.log(formatSweep(control, rows))
  }, SWEEP_TIMEOUT_MS)
```

**`worseThanControl` is expected to be non-zero and a zero is not a pass.** An upgrade is a buff at
its own cell and not on the run: relief moves traffic downstream, and the spike's eight-seed row for
the six-cell exemption contains a **−5**. If every single placement beats the control, say so and ask
whether the rig is measuring placement at all — the likely cause is a seat tick at which most
placements are refused, which is the second review's I5 in a new place.

**State `SWEEP_TIMEOUT_MS` explicitly** and derive it: vitest's default is 5,000 ms and one greedy arm
takes 3.5–4.8 s, so a sweep of `n` arms plus a control needs roughly `(n + 1) * 5000` ms with headroom.
**Measure one arm first, multiply, and write the number down** — the previous draft ran an unbounded
sweep inside one `it` with no timeout argument.

**If either threshold misses, that is the milestone's headline finding and it goes in the report's
first line.** Do not weaken the criterion. Report the measured values, the best and worst cells, the
count of placements worse than the control, and what Task 9 measured for the same cells, so M1g
inherits the gap.

**And report the two-versus-six arithmetic beside it**, because it is what the criterion cannot see:
the spike measured **+7.1 % from the top two cells and +103.8 % from six**, and only four of that six
are ever seatable. A sweep of *single* placements answers "does the corner matter". It does not answer
"how many corners does a player need", and Step 4's policy comparison is the instrument for that.

- [ ] **Step 4: The long run, the card policies against each other, and the `MAX_UPGRADES` derivation**

Drive `createGame` with its own `InputQueue` and frame loop, greedy connector plus `takeCardPolicy`,
across the **eight** `RUN_SEED` values the carry-forward enumerates (`laneways-m2`, `s1`…`s7`).
Record per seed: death tick, trips, blocked car-ticks, longest queue (**on the repaired probe**),
valve firings, peak `destPins` per week, delivery fraction per week, `tilesLeft` minimum (**stating
whether it is the running minimum or the week-close one**), unaffordable events, boundaries reached,
upgrades granted and upgrades placed.

**And measure the card policies against each other**, because *"is this a decision"* is answerable
now and the plan should not hand it to M1g as an opinion. Over the eight seeds: death tick and trips
for **`always tiles`** vs **`always upgrades`** vs **`alternate`**. Place every granted upgrade on the
highest-ranked cell the run's own **junction-caused** refusal tally names and that is legal at that
boundary, so the policy comparison is about the card and not about placement skill.

> **If one policy dominates on all eight seeds, that is an M1f finding and it belongs in the report's
> first line, not in M1g's inbox.** The plan's prediction, written here before the measurement:
> **`always upgrades` dominates, and by more than the previous draft would have predicted.** Three
> measured reasons: tiles are at 3.4× slack, so 10 extra tiles buy nothing; an upgrade is a buff at
> its own cell and cannot backfire the way a metered light could; and the ceiling **needs several
> cells** — two cells measured +7.1 % against six cells at +103.8 %, so a policy that takes the item
> every week is the only one that can approach it. **The interesting result would be `alternate`
> winning**, which would mean the upgrades a player can seat are already enough and the tiles are
> worth something after all. **Report the two numbers that decide whether M1f shipped a decision**:
> this comparison, and Step 3's count of single placements strictly worse than the control.

**And pin the `MAX_UPGRADES` derivation against measured data**, so it cannot rot into a claim:

```ts
    expect(2 * Math.max(...perSeed.map((s) => s.boundaries)), 'MAX_UPGRADES still bounds the grant')
      .toBeLessThanOrEqual(MAX_UPGRADES)
```

**Report the slack in that bound rather than only its truth.** On the shipped board only four
boundaries occur, so at most 8 upgrades are obtainable against a cap of 24 — a factor of three. The
cap is not binding on anything M1f can produce, Decision 15 says so, and this assertion exists to
catch a future run long enough to make it binding, not to claim it currently is.

**Report distributions, not runs.** A single-seed claim below 2× is inside the noise, and **the
shipped seed is an outlier** — the quietest of the eight on blocked car-ticks and one of only two that
never valved before this milestone. Every headline figure gets both: the shipped seed's value, and the
eight-seed range.

State both clocks for every time: `tick / 30`, and the stopwatch figure `(tick − warmStart) / 30` with
`warmStart` 258 for `city` and 1,200 for `demo`. **Two counters, one sentence — say which counter each
is.**

- [ ] **Step 5: The invariants, over the longest run, with a LIVENESS assertion beside them**

Occupancy soundness and completeness, the reservation invariant, no counter wrap, the tile ledger, and
`assertNoRoadOnImpassable`. **Every safety property is trivially true of a frozen system**, and this
milestone freezes on game over — so the sweep asserts off the **peak overcrowd meter** and off
cars-in-motion rather than off the terminal flag.

**Two M1f-specific invariants to add:**

- **The upgrade count agrees with the flags, in both directions.** `H_UPGRADE_COUNT` equals the
  number of cells with `upgradeAt !== 0`, **and** every cell with `upgradeAt !== 0` is inside
  `[0, world.cells)`. Both directions, because the count alone is satisfied by a board that lost a
  flag and gained one elsewhere. (This replaces the previous draft's prefix-packing invariant over a
  `lightCell` table; Amendment 2 deleted the table, and this is the smaller statement that survives.)
- **`H_UPGRADE_COUNT` only ever rises, and `H_INV_UPGRADES` never goes negative.** Sample both every
  tick of the longest run and assert monotonicity on the first and `>= 0` on the second. M1f has no
  removal path, so a fall in either is a defect and not a feature arriving early.
- **The tile ledger is unchanged by upgrades.** `tilesLeft + roadCells + ghostCells` steps by exactly
  `WEEKLY_TILE_GRANT + cardTileGrant(chosen)` between boundaries and by nothing else. **An upgrade
  lays no road and erases none**, so this is the assertion that would catch one that did.

- [ ] **Step 6: Enumerate every `Uint8Array` write, and confirm M1f added no decrement path**

By **enumeration of the writes**, never by grepping for `--`: the one path M1d actually added spells
it `const left = committed - 1` across two statements. The expected answer is three paths, unchanged:
`destPins` and `destReserved` in `trips.ts`, `ghostCommitted` in `roads.ts`.

M1f's new `Uint8` region is **one**: `upgradeAt`. Enumerate every write to it and confirm there is
exactly one — `state.upgradeAt[cell] = 1` in `applyPlaceUpgrade` — a constant, never relative and
never downward. `H_INV_UPGRADES` and `H_UPGRADE_COUNT` are `Int32`. **M1f declares no `Int16` region
at all**, which is a change from the previous draft (it had `lightSince` and `lightIdle`), and the
enumeration should say so rather than leaving a reader to wonder whether they were missed. Record the
enumeration in the report.

- [ ] **Step 7: Re-measure the carry-forward figures this milestone moved, and report tile slack as an OUTPUT**

- **§15.5's tile slack — as an OUTPUT of the run, not an input this milestone tuned.** It was 62 tiles
  spent of 210 granted on a six-week run, week-close minimum 37, running minimum 7 at tick 2,280.
  Income is now 30 + the card's 20 or 30, and the run is shorter. Give the new pair, both minima
  **with their qualifiers**, and the new unaffordable count. Then hand the lever to M1g **with its
  price**: deleting phase 2's `WEEKLY_TILE_GRANT` makes the card the only income, which is §5.10
  taken literally; its cost is two goldens' `H_TILES` becoming a function of the input log and
  `runWeekBoundary` losing its whole body (a phase deletion and a second renumbering). **Note that
  M1f has already paid the expensive half** — every frame-driven rig acquired a card policy at Task 7
  — so M1g's version is a one-line deletion plus two hand-computed re-blesses. **And correct the
  claim this plan carried in Decision 5:** *"deleting phase 2 is the only version in which 30-vs-20
  costs the player anything"* is **false**. Lowering `WEEKLY_TILE_GRANT` does it too, with no phase
  deletion and no renumbering. The honest reason M1f does neither is **scope**, which the plan already
  says elsewhere; say it here and drop the overclaim.
- **§12's run length.** 17:19.9 on the stopwatch before this milestone; give the new figure on the
  shipped rule, **with and without the upgrade card taken and placed**, and say which arm.
- **§10 / §5's valve.** It fired 0 times on the shipped board and now fires 15 (wide rule) or 5
  (arm B) — **not 14, which is the figure earlier drafts carried and which reproduces as neither.**
  Give the new count, the worst wait, the first firing tick, **and how many firings a placed upgrade
  REMOVES.** That last number is now the cleanest derivation of the relief mechanism this milestone
  has: an upgrade admits cars the bare junction refuses, so it takes pressure *off* the valve. The
  spike measured the six-cell exemption at 2,229 blocked car-ticks against the control's 29,267, so
  the expected direction is sharply down; **a valve count that does not fall is a finding.**
- **§15.10's frame cost.** M1f is the first milestone that can produce a real jam on the shipped
  board. The allocation harness says **nothing at all** about frame time; this is a device question,
  not a budget, and it must be labelled *"one device, qualitative"* if a person answers it.
- **BOTH censuses.** **271 / 12,780 / five (rule-visible)** and **232 / 15,001 / six (co-presence)**
  on the **rule-disabled** arm. **This re-check is folded into Step 1's single probe run** rather than
  repeated here — Task 3 Step 7 inverted the invariant that would have forced them back, and Step 1 is
  the only other place the revert exists. Prove they did **not** move, and record that they are
  probe-only figures with no standing assertion after Task 2.

- [ ] **Step 8: Sweep every durable artefact against the tree, deliberately, as a step**

The three artefact classes that cannot be corrected in place or that everything downstream reads:
**the final commit message, the handoff, and the testing defect catalogue.** For each figure in each,
check it against the tree, and mark it **confirmed** (with the assertion or constant that pins it),
**corrected** (with the measured value and the rig beside it), or **UNVERIFIED** (could not be
reproduced on any arm this tree can drive — *not known to be wrong, known to be unchecked*).

The mechanism to look for is **decay, not carelessness**: a figure that was right for its own task and
wrong two tasks later. **And the correction is where the danger concentrates** — a corrected figure
reads as verified in a way the original never did, and this project has produced four wrong
corrections. Where a figure matters, the repair is not to edit it a second time but to **assert it**,
on a rig, so it cannot come back.

**THE TWO IDENTIFIER SWEEPS, which are the halves this step kept promising and never contained.**
Both are greps, both are cheap, and both exist because this milestone replaced its relief object
twice.

**Sweep A — the roundabout**, promised by Amendment 1 and absent from the previous draft's Step 8:

```bash
grep -rn "roundabout\|RA_ENTRY\|RA_CENTRE\|RA_CORNER\|ROUNDABOUT_SPAN" packages/ docs/ tools/
```

Every surviving hit must be §5.6/§1.8 prose, the `CARD_ROUNDABOUT` id, `ROUNDABOUT_SPEED_MUL` (still
uncalled, re-dated to M1g in Task 1), or an M1g deferral with a named recipient. **Three live comments
are known to read stale and two of them have no owner:** `sim/src/roads.ts:167`,
`game/src/demoLayout.ts:242` and `game/test/carSmoothing.test.ts:793`. Give each an owner or correct
it; do not leave a comment predicting an object this milestone deferred.

**Sweep B — the metered traffic light**, which Amendment 2 deleted:

```bash
grep -rn "LIGHT_CHANGE_DELAY\|LIGHT_AMBER_TICKS\|LIGHT_MIN_NEARBY_CARS\|LIGHT_NEARBY_RADIUS\|\
LIGHT_IDLE_CAP\|LIGHT_IDLE_WEIGHT\|LIGHT_AXES\|LIGHT_NO_PENDING\|RIGHT_TURN_STEPS\|MAX_LIGHTS\|\
lightAt\|lightCell\|lightSince\|lightIdle\|lightGreenAxis\|lightAmberFor\|lightSlotAt\|lightIdleSlot\|\
runLights\|bestAxis\|nearbyCarsOnAxis\|axisHasRoad\|axisOf\|lightAdmits\|isRedLightRightTurn\|\
LIGHT_STOP\|LIGHT_GO\|LIGHT_RIGHT_ON_RED\|REFUSED_RED\|nextLegDir\|LIGHT_COLOUR_\|lightColour\|\
lightMode\|LIGHT_ARMED\|LIGHT_PLACED\|H_INV_LIGHTS\|H_LIGHT_COUNT\|LIGHT_ITEMS_PER_CARD\|\
greenLightsIgnoreCollisions\|americanRedLightRules" packages/ docs/ tools/
```

Every surviving hit must be one of exactly four things, and **anything else is a leftover, not a
judgement call**:

1. §5.6 / dossier §1.7 prose, including the Task 9 amendment that records the measurement;
2. the `CARD_TRAFFIC_LIGHTS` id and its `CARD_LABELS` row, both declared and both excluded by
   `CARD_IMPLEMENTED_MASK`;
3. an M1g deferral with a named recipient — the Out table, Decision 14, or
   `docs/superpowers/m1g-carry-forward.md`;
4. `nextLegDir` **as a private function inside `cars.ts`** if it existed before M1f; it must **not**
   be exported, because the only reason to export it was right-on-red.

**Confirm each is gone rather than assuming it**, and put the grep and its output in the report — the
same discipline Amendment 1 applied to the ring, applied to the object that replaced it.

**Specific known hazards in this milestone:**

| Hazard | Why |
|---|---|
| Every phase number above 3 | Moved **once**, in Task 5, and the count is final at **eleven**. An earlier draft appended a twelfth phase at Task 9; Amendment 2 deleted it. Grep for `phase 12` in `sim` and for any comment predicting a second renumbering |
| `4 <-> 5` | Renamed to `5 <-> 6` in Task 5 |
| `DEMO_DEATH_TICK` | Moved twice, in Tasks 2 and 3. `CITY_DEATH_TICK` did not move and the derivation must be quoted with it — **and the derivation now cites 12,780, not 15,001**, because the earlier of the two censuses is the one that bounds it |
| `232 / 15,001 / six cells` **and** `271 / 12,780 / five cells` | **Both** must be unmoved on the rule-disabled arm, both are probe-only after Task 2, and **the previous draft deleted the second and called the first a correction 74 s in the wrong direction.** Grep for any surviving sentence claiming the board is unchanged past 12,780 |
| `8:11` as the player-visible onset | Wrong twice over: divergence is 6:57.4 and the first tick a person can see is **8:56.0**. Grep for `8:11` |
| The nine golden digests and their **ten** assertion sites | `968680755` has two |
| The buffer arithmetic | **13,992 → 14,972 B, 29 → 30 regions, +980 bytes.** An earlier draft said 15,356 / 35 / 1,364 and those figures may have reached a comment or a doc before Amendment 2. Grep for `15,356`, `1,364`, `35 regions` and `1,940` |
| `NB`'s corrected margin | 14, not "zero slack" |
| **The SPEC** | Amended twice — §5.4 in Task 1 and §5.6 in Task 9. A spec is the most-quoted artefact this project has, and §5.6's amendment is the only durable record of why the light was deferred |
| **`packages/shared/src/constants.ts`** | It carries `MAX_BLOCKED_TICKS`'s measured evidence table (**15 / 5 valve firings, not 14**, and the third-reader prediction that did not come true), `CARD_GRANT_ITEM`'s slack figures, `WEEKLY_TILE_GRANT`'s week-3 estimate and `MAX_UPGRADES`'s derivation — four quantitative claims in doc comments that no test reads |
| **Any wide-rule figure surviving Task 3** | `45,986` blocked car-ticks and the trap-3 table's first column are Task 2's WIDE rule; Task 3 may have shipped arm B, in which case every one of them is superseded by `29,267 / 368 / 21,783 / 5`. Grep for `45,986`, `21.7`, `11:54` and `344` |
| **The queue figures** | Every `longestQueue` number in the repo is a **post-repair** measurement from Task 2 Step 7 |
| **`tilesLeft never below 37`** | A **week-close** minimum reported as if it were a running one. The running minimum is 7. Quote the qualifier or drop the figure |
| **The two `+68 %` disavowals** | They must **stay**. The exemption ceiling from the previous milestone shape was a different object with unlimited throughput, and it is not a comparison for anything M1f measured |

- [ ] **Step 9: Deploy, and verify the ARTEFACT rather than the command's exit message**

`wrangler deploy` has printed `Success! Uploaded 2 files` while the served HTML still referenced the
previous asset hash — the upload succeeded and the deployment never activated. **Fetch the live
artefact and grep it for a build-unique token.** And note that `vitest` loads `vite.config.ts` as its
own config, so a test run immediately before a deploy can mint a fresh `.build-id`; confirm
`apply: 'build'` is still on the build-id plugin before trusting `verify-deploy.js`.

- [ ] **Step 10: Write the device checklist — six questions, one phone, one sitting**

Ordered by what is most likely to be wrong, each with the expected observation and the moment it
happens, each answer recorded with the words **"one device, qualitative"** attached. The M1f-specific
ones, in order of risk:

1. **The modal at 2:21, and whether the choice is blind.** Does a board that stops dead and shows two
   cards read as a choice, or as a freeze? It is the first time this game has ever interrupted the
   player — **and it happens before they have seen a single jam**, which is measured and structural
   (the first visible jam is at **8:56** and no week length in §5.10's plausible range moves the first
   boundary past it). Ask directly: *"do you know what you are choosing between?"* *Watch for: the
   up-to-7 ticks of drain before the pause lands, which should be invisible; and the paused cars
   sitting 0.09–0.22 cells short of their sim positions, about 6 CSS px, frozen for as long as the
   player takes.*
2. **The two cards.** Is "ROAD TILES · 30 TILES" against "JUNCTION UPGRADE ×2 · 20 TILES" a decision,
   or is one obviously right every time? **The honest measured answer from Step 4's policy comparison
   goes beside whatever the person says**, and if they disagree with the measurement, say so. *Also
   ask what they think a "junction upgrade" does before they place one* — the object is M1f's own
   invention, it is not in §5.10's table, and a card whose name explains nothing is a card the player
   picks at random.
3. **The chip and the gesture.** Tap the chip, tap a junction. Does the mode read as armed? Does a
   refused placement read as refused — the badge is the only feedback, and it does not move. Does
   tapping plain road do anything a player can interpret? *And note the timing trap: the board has no
   junction at all until tick 4,530, so a player who takes the card at 2:21 and immediately tries to
   place gets a silent refusal on every cell.* Ask whether that reads as "not yet" or as "broken".
4. **The jam at 8:56.** Play normally and watch for the first queue. Does a car stopping at a corner
   read as traffic, or as a bug? *This is the question M1d's failure makes mandatory: the feature has
   to be visible to somebody who was not told where to look.* **Look for three cars stopped at once**
   — that is the measured onset, tick 16,337, and it is 2 minutes after the board first diverges at
   6:57.4, which nobody can see.
5. **The upgrade working — and this question changed shape with the object.** Place one on the corner
   the sweep names as best. **There is nothing to watch on the cell itself**: the marker is static, so
   the only evidence is that cars stop stopping there. Can the person tell it did anything? Then, on a
   fresh run, place one on the cell the sweep names as worthless. **Can the person tell the
   difference?** If not, the spread is a number in a test and not a mechanic — **and that is the
   milestone's most likely failure, because the previous object at least blinked.**
6. **The permanence.** An upgrade placed on the wrong junction cannot be removed this milestone. Place
   one badly on purpose and ask whether that reads as a mistake the player can live with. **And note
   the M1g consequence while the person is looking at it:** §5.6 makes a relief object and a
   roundabout mutually exclusive on a cell, so a permanent upgrade forecloses a roundabout site M1g
   may want.

Keep the existing six questions too — the empty opening, the ring's legibility, the shutdown copy, the
ghost art, the restart, the first ten minutes — and **re-derive every clock time in them against the
M1f board** rather than copying them forward. Several will have moved: the run is shorter, the ring
appears at a different tick under a different rule, and the shutdown arrives sooner.

- [ ] **Step 11: Write `docs/superpowers/m1g-carry-forward.md`**

Every item gets a **named recipient** — a task, a milestone doc, or a file — because *"someone" is a
synonym for "no one"*. Every figure gets its rig, and the document opens with the same vintage warning
this one inherited: a figure in it is evidence about the commit it was measured at and about nothing
after it.

It must contain, at minimum:

- **THE METERED TRAFFIC LIGHT, in full, with every number the spike measured.** This is the second
  largest thing M1f hands on and it must not arrive as *"the light was deferred"*. Carry: the control
  (368 trips / 29,267 blocked / death 21,783); the perfect-relief ceiling (750, +103.8 %, and the
  conflict-cell exemption reproducing 747 / 31,456 / 2,120 exactly); the fixed light (320 at its best
  seat phase, −13.0 %; median 306, −17 %; 3 of 30 phases beat the control; per-seed phase spread
  1.19×–1.70×); the plan's own demand controller (228, −38 %, one phase swap in a whole run, 12/192
  phase-seed pairs); swaps per run across eight seeds (`1 0 0 6 4 5 0 11`, **three seeds never swap**);
  the `LIGHT_CHANGE_DELAY` probe (150 → 48 % wins, 300 → 31 %, 600 → 15 %); the best variant found
  anywhere (353, still below 368); red-light refusals 16,490–19,536 against a 6,536 pool; and that at
  `(12,19)` a light admitted **zero** entries the rule would have refused while refusing 8,886.
  **State the cause as a density mismatch — about eleven cars in flight — not as a defect in the
  datamined constants**, and carry the three levers Decision 14 names. **Recipient: M1g, as a design
  question before a task.**
- **The roundabout's geometry finding, in full**, with the four options the review enumerated and the
  measurement that produced it. This is the largest thing M1f hands on and it must not arrive as
  *"the roundabout was deferred"*.
- Everything in this plan's Out table with its measurement.
- **The upgrade deletion path and the mid-traversal rule change it implies** — and the note that
  Amendment 2 made it *cheaper* than it was (a flag to clear, no timers to retire) without making it
  free.
- **That a permanent upgrade forecloses an M1g roundabout site**, which is a carry-forward gap the
  previous draft recorded nowhere.
- `overtimeChangeDelay` with its candidate mapping, `americanRedLightRules`, and the three-rule
  decomposition of right-on-red — **correct work that should not be re-derived.**
- The tile economy with Step 7's numbers, the M1g lever, and the note that M1f has already paid its
  expensive half — **and the correction that deleting phase 2 is not the only way to make 30-vs-20
  cost something.**
- `CARD_IMPLEMENTED_MASK` and the **five** cards behind it, `CARD_TRAFFIC_LIGHTS` among them.
- The round-robin/nearest mismatch with the better evidence a queued board now gives it.
- The equivalent-mutant register at its M1f state: `laneSpeedMul`'s entry **unchanged and still open**
  (the values that would have closed it came from the roundabout), `5 <-> 6` **open**, the other three
  unchanged. **Say that the register did not shrink**, because the previous plan predicted it would.
- The golden ledger at nine digests with their new values, and the buffer at **14,972 B / 30 regions**.
- **Both censuses** — 271 / 12,780 / five and 232 / 15,001 / six — **each with the definition that
  produced it**, the note that the co-presence policy is structurally blind to a same-tick swap, and
  the note that two honest readings of an earlier wording differed by 3 %.
- **The reachability arithmetic**: junctions at the four boundaries 0 / 2 / 6 / 6; at most 8 upgrades
  obtainable against a cap of 24; two of the six top refusal cells never reach degree 3; two cells buy
  +7.1 % and six buy +103.8 %. **This is what bounds the relief a player can actually get, and it is
  the number M1g needs before it tunes anything.**
- The answer to *"is the modal a decision"* from Step 3's worse-than-control count and Step 4's policy
  comparison, stated as a measurement.

**And carry the CONTENT, not the cardinality.** *"The five open items"* with none of their text is the
same defect as a count without its items. Check the finished document with **one grep per item against
a list of names**, not by reading it — this project's last handoff read as thorough from every angle
except that one, and two of eight items were absent.

- [ ] **Step 12: Final commit, with the report and the commit message checked against each other**

**When a task's report and its commit message disagree, the report is usually right and the commit
message is what ships.** Check the durable artefacts against the measurements last, deliberately, as a
step — not as a side effect of writing them. A vague sentence sharpened into a specific claim *after*
the evidence and pointing away from it is how this project's dominant defect family works.

---

## Sequencing: what can be reviewed apart, and where the real dependencies are

- **Task 1 blocks Task 2** and nothing else, but it must be first in time regardless: it is the task
  that decides whether the junction's cost can be routed around, and trap 1 is that Task 1 can make
  Task 9 worthless **after** Task 9 is built. A milestone that lands the interlock last has spent ten
  tasks on a feature the eleventh could delete.
- **Task 2 blocks Task 3, and Task 3 must land before Task 4.** This is the one ordering in the plan
  that is a correctness requirement rather than a convenience: Task 3 decides the shipped junction
  rule, and every death tick, every profiling window and every gate figure in Tasks 4–12 is measured
  against it. **A Task 3 discovered inside Task 9 is the balance decision arriving after the object
  built on it.** Task 3 also runs the **site survey** that the previous milestone shape failed, so it
  is the last cheap moment to discover that the relief object cannot reach the jam — **and, from
  Amendment 2, the EFFICACY CHECK (Step 3b), which is the last cheap moment to discover that it does
  not help.** That check costs two arm runs on a rig that already exists. The previous draft measured
  the milestone's central claim at its Task 9 Step 14, after eight tasks of infrastructure; a spike
  settled the claim for the price of one task, and Step 3b is what keeps it settled on this project's
  own rig rather than on a scratchpad copy. **If Step 3b comes back negative, stop at Task 3.**
- **Task 4 blocks everything after it.** It is the milestone's only shape change and every later task
  assumes the header slots and `upgradeAt` exist. It also lands the two RNG guards **before** Task
  5's draw can violate them, which is why its first three steps are a separate commit.
- **Task 5 depends on Task 4** and owns the renumbering. Nothing may be inserted between Task 5 and
  the repointing of every phase number in the repo, because a half-renumbered tree has two conventions
  in it and no way to tell which a given comment uses.
- **Task 6 depends on Tasks 4 and 5** and is deliberately two commits ahead of the UI, so
  `choose-card`'s semantics can be wrong in a test before they can be wrong on a screen.
- **Tasks 7 and 8 must be ADJACENT, with nothing between them.** Task 7 ships a build in which the
  default board freezes at 2:21 with no way out; Task 8 is what gives it a screen and a choice.
  Between those two commits the build is strictly worse than the one before them, and
  `offerInterlock.test.ts` is red for exactly that span. **Task 7 also re-bases every frame-driven
  arm's figures**, so a task that reads them must come after it — which is why Task 4 Step 12's
  behavioural warrant names Task 3's values and is explicitly superseded at Task 7.
- **Task 9 depends on Tasks 2, 3, 4 and 8** — on Task 2 for the two-predicate split, on Task 3 for the
  shipped rule its relief is measured against **and for the site table its Step 5 re-runs through the
  real predicate**, on Task 4 for `upgradeAt` and the two header slots, and on Task 8 because an
  upgrade nobody can be granted is a mechanic with no way in. It does **not** depend on Tasks 10 or 11.
  **Amendment 2 made this the smallest of the four middle tasks** rather than the largest: no
  constants, no phase, no controller, and one clause in `graph.ts`.
- **Task 10 depends on Task 9** and touches only `game` and `render`. It is the one task in this
  milestone a UI reviewer can take on its own.
- **Task 11 depends on Tasks 4 and 5 only.** It no longer needs any geometry — capability is a
  function of terrain — so it could be reviewed in parallel with Task 9 by a second reviewer.
- **Task 12 depends on everything**, and its Step 1 depends on being able to revert Task 3's rule
  cleanly — so Task 3's arm must be implemented behind a single, named predicate rather than smeared
  across `canEnter`, or the reproduce-before-you-contradict step cannot be run.

**Three tasks could be reviewed by someone with no context on the game**: Task 1 (a spec amendment, a
constant move, one assert and two scans), Task 11 (a pure function of terrain) and Task 10 (a chip, a
glyph and a gesture). Everything else needs the milestone in its head.

---

## What this plan does not settle

- **Whether the two-card modal is a real decision — but M1f MEASURES it rather than opining.** The
  pool is exactly two cards, only the side varies, and three of the four offers land before the board
  has ever shown a jam (2:21, 4:51 and 7:21 against a first conflict at 8:11). No week length in
  §5.10's plausible range fixes that; the plan derives it and states it. What makes the choice
  survivable is §2.2's *"items sit unplaced indefinitely"* — the blind half is which card, not where
  the object goes. **Task 12 Step 3 reports how many single-upgrade placements are strictly worse than
  the control and Step 4 runs `always tiles` / `always upgrades` / `alternate` across eight seeds;
  those two numbers together are the answer**, and if one policy dominates on all eight that is an M1f
  finding rather than an M1g question. **The plan's own prediction is that `always upgrades`
  dominates**, for three measured reasons — tiles are at 3.4× slack, an upgrade cannot backfire at its
  own cell, and the ceiling needs several cells (+7.1 % at two against +103.8 % at six) — which is a
  weaker decision than the previous draft expected and is stated so the measurement can contradict
  it.
- **Whether the tile economy should have moved onto the card.** Decision 5 states the refusal and its
  two reasons, and Task 12 Step 7 hands M1g the lever with the number, the price and the note that
  M1f already paid the expensive half. **This is the one thing in the milestone that would most change
  how the modal feels, and it is deliberately not done here.**
- **Whether the junction rule's shipped arm is the right one.** Task 3 picks between three with a
  criterion written before the measurement, and the criterion is about instruments and load floors
  rather than about feel. The arm that survives may still be too harsh or too weak for a player; the
  only instrument for that is Task 12's device session.
- **How much of the measured ceiling a player can actually reach.** This is the sharpest thing M1f
  leaves open and it is left open with numbers rather than with a shrug. A throwaway spike measured
  the perfect relief object at **+103.8 %** by exempting six cells — **two of which never become
  junctions and can never be seated** — and at **+7.1 %** from the top two. The reachable figure is
  therefore bounded below by 394 trips and above by 750 and **is not measured**. Task 3 Step 3b takes
  the first honest reading on the junction-eligible cells and Task 9 Step 11 refines it per cell, but
  neither answers whether the result is *enough* relief for the run to feel different — only Task 12's
  device session can. **The +68 % exemption ceiling from the previous milestone shape is still NOT a
  comparison**: it was an exemption of a different object with unlimited throughput, and this plan
  does not carry it forward as a target.
- **Whether the metered light comes back, and in what form.** Deferred to M1g with a full measurement
  (Decision 14, the §5.6 amendment, the carry-forward). M1f's answer is *"not on a board with eleven
  cars in flight"*, which is a statement about density rather than about the mechanic. The three
  levers are named; **which of them is right is not settled and M1f does not guess.** The one M1f
  would bet on, stated so it can be wrong: a light as a **modifier on an upgraded junction** — the
  upgrade lifts the exclusion, the light meters what crosses — because that composes with a mechanic
  now measured to work rather than replacing it.
- **Whether one card a week is the right rate**, and whether two lights per card is the right grant.
  §5.10 says both; M1f honours both and measures nothing about them.
- **The roundabout.** Deferred with a measurement and four named options. **This is the largest thing
  M1f leaves open and the review is the reason it is open**, so it is handed on as a geometry decision
  rather than as an implementation task.
- **Deleting a placed light.** Out, with a reason: un-marking a cell while a car is mid-crossing on it
  changes that car's entry rule inside a traversal, and the light also owns timers whose retirement
  has to be defined. **A light placed on the wrong junction is permanent for the run**, and the device
  session asks whether that reads as a mistake a player can live with.
- **What an upgraded junction should look like.** It has no state, so it has nothing to animate, and
  the only feedback a player gets is that cars stop stopping at that corner. Task 10 Step 5 picks a
  static marker and records the reason; **Task 12's device session is the only instrument for whether
  a person can tell an upgraded corner from a plain one**, and that is the most likely place this
  milestone is invisible in the way M1d was.
- **The scheduler.** §15.2's round-robin/nearest mismatch is the term that actually decides whether a
  *connected* destination lives, and M1f declines it deliberately so that the junction rule and the
  light stay attributable. It is the largest thing this milestone leaves open after the roundabout,
  and the evidence for it is better now, because there are queues to measure.
- **Frame time under a real jam.** M1f is the first milestone that can produce one on the board that
  ships. The allocation harness measures allocation and says nothing about time. One device,
  qualitative, or nothing.

---

## Self-review

**1. Spec coverage.**

§5.5's *"one blocking primitive: does an inbound vehicle collide with a traversing vehicle on this
chunk"* → **Task 2**, with **Task 3** deciding between the co-presence and the collision readings
against a written criterion. §5.5's *"max wait at intersection before proceeding anyway = 45 s"* →
already shipped as `MAX_BLOCKED_TICKS`; Task 2 is the first thing that makes it fire on a shipped
board and corrects the two sentences in its comment that Task 2 falsifies. **It keeps TWO readers, not
three** — the previous draft predicted a third at Task 9 (a lone car starving below a light's swap
threshold) and Amendment 2 deleted the light; an upgrade *reduces* valve pressure, and Task 12 Step 7
measures by how much. §5.5's lane-speed table: *"approaching an intersection = 0.5"* keeps applying on
an upgraded junction, which is the same clause §5.6's right-on-red sentence protects, honoured by a
different route; *"where multiple multipliers apply, average them"* is untouched, and **so is
`laneSpeedMul`'s rounding-inertness register entry** — the values that would have closed it came from
`ROUNDABOUT_SPEED_MUL`, which M1f defers.

§5.6's **traffic light** → **built, measured, and DEFERRED to M1g by amendment in Task 9 Step 1**, with
every number in Amendment 2 and Decision 14. Clause by clause, so nothing is dropped silently:
*"demand-actuated with hysteresis, not fixed-cycle"* → measured at **−38 %** as specified and deferred.
*"10 s minimum between changes"*, *"2 s amber"*, *"needs ≥ 2 nearby cars within 2 tiles to swap"*,
*"idle time weights up to a 30 s cap"* → **not declared as constants**, because a constant with no
caller reads as a supported configuration; all four are carried to M1g with the measurement that
rejected them for this board's density. *"Right-on-red skips the stop, not the intersection
slowdown"* → **its three-rule decomposition is correct work and is carried to M1g intact**, and its
second rule (the slowdown still applies) is honoured by M1f, because `isJunctionCell` is unchanged at
an upgraded cell. *"Place only on an existing road junction, never plain road, cost 0 tiles"* →
**honoured unchanged by the junction upgrade**: `canPlaceUpgrade`, five refusals, one fixture each.
Dossier §1.7's `greenLightsIgnoreCollisions` → **this is what M1f ships**, as a whole-cell rule with no
phase rather than a per-axis one; the amendment says so. `americanRedLightRules` and
`overtimeChangeDelay` → M1g, with candidate mappings named.

§5.6's **roundabout** → **deferred to M1g behind a geometry decision**, with the measurement that
produced the deferral and four named options.

**§5.6's relief object is therefore the one place M1f DEVIATES from the spec rather than implementing
it**, and the deviation is recorded in the spec itself rather than only in this plan. The junction
upgrade is not a §5.10 row and not a §5.6 object; it is M1f's substitution, it inherits §5.6's
placement rule and §5.10's grant row verbatim, and the amendment states what was tried and what it
measured so the next reader does not re-derive it.

§5.10's *"fires at the end of each in-game week, full-screen paused modal, exactly 2 options, plus a
peek button, no skip, no bank, no reroll, no timer"* → **Tasks 5–8**, unchanged by Amendment 2: the
card system is at full scope. *"Every card grants road tiles, so a bad draw can never softlock"* →
Task 6's `cardTileGrant`, with Decision 5 recording that the purpose is met by the automatic grant
plus the bonus rather than by the card alone. *"Traffic Lights | 2 | 20"* → **the grant row is honoured
by `CARD_JUNCTION_UPGRADE`** through `cardItemGrant` and `UPGRADES_PER_CARD`, with a mutant for the
off-by-one; the row's *name* belongs to `CARD_TRAFFIC_LIGHTS`, which stays declared and unimplemented.
*"Pool is filtered by map capability"* → **Task 11**, corrected to read terrain only, per dossier line
227. The Bridge / Tunnel / Roundabout / Motorway / **Traffic Lights** rows → out, behind
`CARD_IMPLEMENTED_MASK`, which is an interlock rather than an absence.

§5.4's *"model intersection and traffic-light penalties as extra integer edge weight"* → **refused by
amendment** in Task 1, scoped to that clause alone, with dossier lines 74 and 101 as the refutation
and the cost of reversing it written into the amendment **for both junction-rule arms**, because the
arm is not chosen until Task 3. §5.4's Dial's-bucket-queue constraint → Task 1's
`assertPushWithinBucketWindow`, **with two arms**, and `NB`'s corrected margin quoted rather than the
wrong one this project has repeated three times.

§2.2's *"solid dark icon + numeric badge when held, grey outline, badge suppressed at zero"* and
*"items sit unplaced indefinitely"* → Task 10's chip, and the second half is what makes the blind
early offer survivable — **with the measured caveat that the board has no junction at all until tick
4,530**, so "unplaced indefinitely" is load-bearing rather than decorative. §2.2's bidirectional
counter → out, M1g, with the mid-traversal reason.

§5.9's *"nothing ever spawns on an existing road tile"* → unchanged, and Task 9 Step 9 adds the one
case it does not cover: an upgrade on a cell whose roads the player has erased, refused with its own
code `B_UPGRADE` rather than by reusing `B_BUILDING`.

§4.1's determinism rules → Global Constraints, plus two new enforcement points landed green before the
code that could violate them, and a `RULES` self-test entry that — unlike the previous draft's — does
not match its own regex. §11's testing spine → Global Constraints and every task's mutation table.

**2. What the FIRST adversarial review changed, item by item.**

| Review finding | Disposition here |
|---|---|
| **C1** the roundabout cannot be placed where the jams are | **Object replaced.** The relief object places on the jamming junction by definition. **Re-verified rather than assumed**: Task 3 criterion 6 is a test that enumerates the placement predicate per hot cell in a window around all four boundaries and prints the table, and Task 3 Step 3b measures whether relief there *helps* — which is C1's corollary and was not in the review's own fix |
| **C2** `drawOfferPair` throws inside `step` and poisons the buffer | **Fixed twice.** Capability is terrain-only and the upgrade is capable everywhere (Task 11); and `runOffer` degrades by resolving the week rather than throwing (Task 5 Step 3), with its own test and two mutants. Task 11's guard enumerates every map any test drives past a boundary — **and Task 11 Step 1 now also fixes the three of those seven fixture names that do not resolve as written**, because a guard that cannot be imported is a guard that gets deleted |
| **C3** the pause freezes every headless rig | **Task 7 owns it**, names the five files (`carSmoothing.test.ts` added, and it is a typecheck-only break, which is why Step 7 now runs `pnpm typecheck`), enumerates the rest by grep, states the rule, and **re-bases every affected figure in Step 6 — including the six census figures the previous enumeration omitted** |
| **C4** the ring is twelve pairs, not eight | **Deleted with the ring**, and confirmed by Task 12 Step 8's sweep A |
| **C5** three tasks need the junction rule switchable off and nothing builds it | **Split, and the switch is disputed.** The two-reader problem is fixed structurally (`isJunctionCell` / `junctionAdmitsOne`, Task 2). The runtime switch is **not built**, per Decision 3 — and the consequence is now stated rather than glossed: the census figures are **probe-only** after Task 2, checked in exactly two places (Task 3 Step 7 and Task 12 Step 1) through the same named revert |
| **C6** `queueProbe.carAheadOf` disagrees with `canEnter` | **Task 2 Step 7**, with the tie-break decided in writing, its own tests, the `canEnter` agreement property re-pointed, and every `longestQueue` figure re-measured. **Amendment 2 closed its reopening for free**: both `carAheadOf` and `canEnter` read `junctionAdmitsOne`, so they cannot disagree about an upgraded cell |
| **I1** both acceptance criteria satisfiable by harm | **Both replaced**, and replaced again by Amendment 2: trips against a control, plus reachability, plus a load floor — and **the spread between the best and worst placement**, which is the criterion that survives an object which cannot make its own junction worse |
| **I2** the census does not reproduce and is under-specified | **REVERSED.** The previous draft pinned one definition, carried 232 / 15,001 / six, and deleted 271 / 12,780 / five as irreproducible. **271 / 12,780 was correct**: it measures what Task 2's rule changes, including a same-tick swap, and the co-presence census is structurally blind to exactly that. Task 1 Step 11 now ships **both** policies, Task 1 Step 12 asserts **both**, and the milestone is dated off the rule-visible one |
| **I3** *"the census must be unchanged"* is false by construction | **Inverted** in Task 3 Step 7, and extended to both policies |
| **I4** `JUNCTION_CENSUS_CELLS` is a number and nothing produces it | **Deleted.** Nothing consumes it: Tasks 3, 9 and 12 derive their cells from the runs they drive, and from the **junction-caused** tally rather than the total |
| **I5** Task 1's census pins values Task 2 moves | **Removed**; the census tests borrow their vacuity from the sibling pins in the same `describe` |
| **I6** `render` has no dependencies; the modal's numbers are string literals | **Task 8 Step 2**, both halves. **And Amendment 2 shrank it**: the marker needs no cross-package constant at all, because `render` reads `upgradeAt` as a raw view exactly as it reads `roads` |
| **I7** `eraseRoad` mints tiles per roundabout | **Deleted with the ring**, and confirmed |
| **I8** `allocation.test.ts`'s windows profile a corpse | **Task 3 Step 8**, as a re-siting with the branch-counter check |
| **I9** criterion 1 fails on the predicted arm | **Task 3 Step 9** names `WARMUP_FRAMES`, derives 1,500 → 500 → 10.5 %, states the JIT risk and its check, extends the fallback to criterion 1, **and re-derives `demoAllocation.test.ts:595`'s `framesDriven` pin, which the same knob binds** |
| **I10** arm B admits a turning occupant; `d1 === d2` is dead | **Task 3**, both, with the `LANE_OF_DIR` derivation making the dead branch provable rather than measured, and a labelled 0-detector mutant |
| **I11** *"tilesLeft never below 37"* is a week-close sample | **Qualified everywhere it appears**, with the running minimum of 7 beside it, and named in Task 12 Step 8's hazard list |
| **I12** the RNG rule's own `misses` entry matches its regex | **Task 4 Step 1**, with the hazard (an implementer narrowing the regex) named |
| **I13** Task 1's positive control dies in Task 2 | **Control moved to `graph.ts`**, which declares all three names permanently, with the reason at the site |
| **I14** the sweep is unbounded and untimed | **Task 12 Step 3** is bounded by `canPlaceUpgrade`, reports its own count, asserts an upper bound on it, and states a derived `SWEEP_TIMEOUT_MS`. **The same fix is now applied to Task 3 Step 3a**, which had the identical shape and did not have it |
| **I15** a house can spawn on `RA_CENTRE` | **Analogue closed**: Task 9 Step 9 refuses buildings on an upgraded cell, with `buildings.ts` in the Modified table and its own refusal code |
| **I16** three mutation rows record impossible kills | **All three corrected**, and **`2 <-> 4` corrected again** — see the second review's I7 below |
| **I17** the re-pause test asserts something `loop.ts` cannot do | **Two frames**, with `resetClock` quoted as the reason |
| **I18** `applyChooseCard` never clears the slots | **Named as a decision**, with `offerSlot` as the single guard |
| **I19** Task 2's expected `sim` result and moved-test list are wrong | **One failure named**, and `allocation.test.ts` and `carSmoothing.test.ts` added with their non-vacuity floors quoted |
| **I20** the observability wording is wrong; `CITY_DEATH_TICK` does not move | **Both, and the first is now correct in the other direction too.** The board is identical until **6:57.4**, the first visible jam is **8:56.0**, and the modal at 2:21 is the exception; Task 2 Step 6 derives that `CITY_DEATH_TICK` is unmoved, off 12,780 rather than 15,001 |

**3. What the SECOND review changed, and what Amendment 2 deleted before it could be fixed.**

The second review returned **EXECUTE AFTER FIXES** with a hard gate before Task 4. The gate was run —
that is the spike behind Amendment 2 — and it changed the object. Each finding below is marked
**FIXED**, **DELETED BY THE SWAP** (the code it was about no longer exists), or **DEFERRED** with a
recipient.

| # | Finding | Disposition |
|---|---|---|
| **C1** | `bestAxis` throws inside `runLights` and permanently poisons the buffer | **DELETED BY THE SWAP** — there is no axis selection. **The RULE behind it is kept and re-checked**: Decision 9 says nothing in `step` may throw over a reachable configuration, `upgrades.ts` contains no `throw` on a state-dependent path, and **Task 9 Step 3's last test drives the exact fixture** — place, erase every arm, drive 400 ticks — and asserts no throw and an unpoisoned `H_EPOCH` |
| **C2(a)** | Task 3 Step 3a calls `canPlaceLight` and writes `H_INV_LIGHTS`, neither of which Task 3 has | **FIXED.** Task 3's predicate is `isJunctionCell` plus bounds, which is Task 2's; **Task 9 Step 5 re-runs the same table through the real `canPlaceUpgrade` and asserts cell-for-cell agreement**, so the substitution is checked rather than trusted |
| **C2(b)** | It ranks by TOTAL refusals, so the milestone halts on a false positive | **FIXED.** Ranked by **junction-caused** refusals (own lane free, other lane occupied), with the share pinned (6,536 / 29,267 = 22.3 % arm B; 18,458 / 45,986 = 40.1 % wide) so the criterion cannot be satisfied by a board where the rule does nothing, and with the note that junctions carry **60.3 % / 76.3 %** of all refusals so the substance survives. **And the criterion is stated as satisfiable on FOUR**, because `(13,18)` at 19.5 % and `(11,20)` never reach degree ≥ 3 |
| **C2(c)** | `replayTo` inside the cell loop — 12–24 replays at 3.5–4.8 s against a 5,000 ms default | **FIXED.** One `replayCapturing` pass snapshotting every sample tick, plus a derived `SURVEY_TIMEOUT_MS` measured from one arm rather than pasted |
| **C3** | The milestone is dated off the wrong instrument, 74 s in the wrong direction, and the escape hatch cannot fire | **FIXED, in six places.** The sentence is deleted; the milestone is dated **12,780 (6:57.4)** with player-visible onset **16,337 (8:56.0)**; `countJunctionConflicts` gains a second policy that catches a same-tick swap; Task 1 Step 12 asserts **both** pairs and states that reproducing 232 alone is **not** reproduction; Task 2's observability sentence is corrected (by 8:00 the board has diverged for 63 s); self-review row I2 is reversed; and Task 12 Step 8's hazard list greps for the wrong figures |
| **C4** | Nobody had measured whether the relief item helps | **FIXED by measurement, and the measurement changed the object.** See Amendment 2. **And the sequencing point is honoured rather than absorbed**: a cheap version of the check lives in **Task 3 Step 3b**, two arm runs on a rig that already exists, with an explicit *"stop at Task 3"* if it comes back negative. Task 9 Step 11's criterion is rewritten around the spike's control and the **placement spread** |
| **I1** | The controller and its own tests are off by one, three times | **DELETED BY THE SWAP** |
| **I2** | The challenger score is written three times in two contradictory forms | **DELETED BY THE SWAP** |
| **I3** | `nearbyCarsOnAxis` reads a lane and calls it a direction | **DELETED BY THE SWAP** |
| **I4(a)** | Mutant 1's prediction is impossible | **DELETED BY THE SWAP** — `canEnter` has no light clause to mutate |
| **I4(b)** | `queueProbe.ts` is an orphaned Task 9 deliverable | **DELETED BY THE SWAP, and the defect closed structurally.** There is no red-light answer; `carAheadOf` reads `junctionAdmitsOne` and tracks the upgrade with no edit. Plan line 1036 is corrected to Task 2 only. **The one obligation that survives is kept**: Task 9 Step 8 re-runs Task 2's `canEnter`-agreement property on an upgraded board |
| **I5** | The previous draft's Task 9 Step 14 never says when the object is placed | **FIXED.** Task 9 Step 11 states `SEAT_TICK = 13,500` with the reason (six junctions exist there; 0 / 2 / 6 / 6 across the four boundaries) and **asserts `applyPlaceUpgrade` returned true per row**. Task 10 Step 7 carries the same warning for the end-to-end test |
| **I6** | The timing section is computed on the arm the plan predicts will not ship, and a spec amendment quotes it | **FIXED.** Trap 3 carries both arms in one table; the §5.4 amendment quotes both and says the arm is chosen two tasks later; Task 12 Step 8 greps for surviving bare wide-rule figures |
| **I7** | Task 5's `2 ↔ 4` prediction of 0 is falsified by a test the plan cites | **FIXED.** Predicted **≥ 1 in Task 5**, with `week.test.ts:71-97` named as the detector and Task 6's second independent reason stated |
| **I8** | Task 7 Step 6's re-base list omits the census triple | **FIXED**, and extended to **six** figures because there are now two policies, with a written directional prediction per policy |
| **I9** | Task 3 Step 7 demands a committed literal on a rule-disabled arm that needs a switch | **FIXED by saying so plainly.** The figures are **probe-only** from Task 2; the revert is the single named predicate Task 3 Step 5 requires; Task 12 Step 7's re-check is folded into Step 1's one probe run; and Task 3 Step 5's *"one named predicate"* is defined rather than asserted |
| **I10** | `nextLegDir` is declared with four parameters and called with two | **DELETED BY THE SWAP** — it existed only for right-on-red, and it is explicitly **not exported** now |
| **I11** | Reachability residue: no legal site at the first offer, one card cannot be seated, `MAX_LIGHTS` 3× over | **FIXED, and promoted to trap 5.** Task 3 Step 3a samples a **window** around each boundary and reports distinct legal **sites** per boundary (0 / 2 / 6 / 6); Decision 15 states that `MAX_UPGRADES` is 3× over on this board, that its derivation comes from run lengths Task 2 deletes, and that **no task may cite it as binding** |
| **I12** | The payoff mechanism is only demonstrated from a hand-set state, unreachable by the controller | **DELETED BY THE SWAP** — Task 9 Step 7 places two upgrades and drives nothing; there is no phase to reach |
| Minor — valve firings are 15 / 5, not 14 | | **FIXED** in trap 3, Task 2 Step 9's comment, the `canEnter` comment, the commit message and Task 12 Step 7 |
| Minor — "six cells" is seven for the rule and six for the census | | **FIXED**: the two counts are separated everywhere, and the census now reports five (rule-visible) and six (co-presence) |
| Minor — player-visible onset is 8:56, not 8:11 or 6:57 | | **FIXED** in the opening, in Task 2's and Task 10's observability lines, and in the device checklist, which now says what to look for (three cars stopped at once) |
| Minor — the tie-break to lower axis index contradicts "ties and never wins" | | **DELETED BY THE SWAP** |
| Minor — amber does not empty the cell, so the stated safety rationale is a guarantee the code does not provide | | **DELETED BY THE SWAP** |
| Minor — mutant 10's hazard note is wrong about the runtime | | **FIXED and kept as a correction**: Task 9's mutation table records that a typed-array write past `length` is **silently discarded, not corrupting** — and that there is no such write any more |
| Minor — "two ticks per second for 2 s is 60 ticks" | | **DELETED BY THE SWAP** (`TICKS_PER_SECOND` is 30 and there is no amber) |
| Minor — `runLights`'s stated 384 reads/tick counts only the idle loop | | **DELETED BY THE SWAP** — there is no per-tick work at all |
| Minor — line 224 says Task 9 adds the FIELD_IRRELEVANT regions; Task 4 is correct | | **FIXED**: the carry-forward row now says Task 4, and says which draft was stale |
| Minor — `B_BUILDING` reused as a refusal code | | **FIXED**: Task 9 Step 9 adds `B_UPGRADE` with the reason |
| Minor — a permanent light forecloses an M1g roundabout site, recorded nowhere | | **FIXED**: recorded in the Out table, in the device checklist's question 6, and in Task 12 Step 11's carry-forward list |
| Minor — Task 12 Step 8 contains no roundabout grep despite the opening's promise; three stale comments have no owner | | **FIXED**: Step 8 now carries **two** identifier sweeps, A for the roundabout with the three comment sites named, and B for the metered light |
| Minor — three of Task 11 Step 1's seven fixtures are not importable | | **FIXED**: `GOLDEN_MAP`, `DEMAND_PIN_MAP` and `barren()` each get a stated route |
| Minor — `carSmoothing.test.ts` is missing from Task 7's Files, and no step runs `pnpm typecheck` | | **FIXED**: both, in Task 7's Files and Step 7 |
| Minor — Task 3 Step 9 omits `demoAllocation.test.ts:595`'s `framesDriven` pin | | **FIXED** |
| Minor — Decision 11 cites Task 4 Step 13; the warrant is Step 12 | | **FIXED** |
| Minor — *"deleting phase 2 is the only version in which 30-vs-20 costs anything"* is false | | **FIXED** in Task 12 Step 7: lowering `WEEKLY_TILE_GRANT` does it too, and the honest reason is scope |
| Minor — *"a single predicate cannot express §5.6"* is an overclaim | | **FIXED** in Decision 3: the split is kept, with two better reasons |
| Minor — Pushback 3's conclusion is right and its reasoning stale | | **FIXED** below |
| Minor — the two `+68 %` disavowals should stay | | **KEPT**, and named in Task 12 Step 8's hazard list so they are not tidied away |

**4. Three findings this plan disputes, with the evidence.**

1. **Fix 4's exemption seam (a runtime switch for the junction rule).** Still declined, per Decision 3
   — but the cost is now stated rather than waved past: the census figures have no standing assertion
   after Task 2 and are checked only in two reverted probes. That is the honest trade and it is
   written where an implementer will read it.
2. **Fix 1's option (d) as "descope".** Taken as a *substitution*, not a descope — and Amendment 2 is
   the second substitution on the same reasoning. Shipping Tasks 1–3 plus card scaffolding with a
   one-card implemented mask would have made `runOffer`'s pool one card on every map, which is the
   exact configuration that produced Critical 2, and would have shipped a modal with no choice in it.
3. **"`2 <-> 4` predicted 0 is wrong because the disjointness claim is false."** **The conclusion is
   right and this plan now agrees with it; the reasoning was stale in both directions.** The
   disjointness claim IS true — phase 2 writes `H_TILES` and phase 4 writes the offer slots. The row
   is non-zero because a positional transposition of 2 and 4 also reverses 2 against **3**, and phase
   3 spends `H_TILES` **today**, through `placeRoad`, with no card involved: `week.test.ts:71-97` is
   the detector and it exists at HEAD. The previous draft got this half-right — it predicted non-zero
   only from Task 6 — and predicted **0 in Task 5**, which is falsified by a test this plan cites two
   lines away.

**5. Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N", no
"write tests for the above". Every code step carries real code, and every function, constant and type
used in a later task is defined in an earlier one's Produces block.

**Deliberate blanks, and each is a value only running the code can produce:** the eight re-blessed
digests and their ten sites (Task 4 Step 11); the two re-blessed digests in Task 5 Step 5;
`DEMO_DEATH_TICK` (Task 2 Step 6 and Task 3, which is why no number for it appears anywhere in this
plan); Task 3's three-arm measurement table, its site-survey table and its Step 3b efficacy rows;
Task 7 Step 6's re-based arm figures **including both censuses**; Task 9 Step 11's per-cell table and
the two thresholds it writes into Task 12 Step 3; Task 10 Step 1's three `gridTop` measurements and
Step 5's marker choice; Task 12's sweep, seed distributions, policy comparison and device answers.

**Everything else that looks like a blank is a figure this plan states as the value to REPRODUCE**, so
a disagreement is a finding rather than a fill-in:

- **the two censuses**, `271 / 12,780 / five` (rule-visible) and `232 / 15,001 / six` (co-presence),
  each with its definition beside it (Task 1 Steps 11–12);
- the pre-M1f record `31,456 / 747 / 0 / 2,120` (Task 3 Step 2 and Task 12 Step 1);
- **the arm-B control** `368 trips / 29,267 blocked / death 21,783 / 0 refusals`, and the wide rule's
  `344 / 45,986 / 21,704 / 0` (trap 3);
- **the spike's relief figures**: 750 (+103.8 %) at the six refusal cells, 747 / 31,456 / 2,120 exactly
  at the six census conflict cells, 394 (+7.1 %) at the top two, and the eight-seed deltas
  `+382 +47 +203 +385 +157 −5 +20 +129` (Amendment 2, trap 5, Task 3 Step 3b);
- **the light's figures**, carried so M1g does not re-measure them: 320 / −13.0 % best phase, 306
  median, 3 of 30 phases, 228 / −38 % for the demand controller, swaps `1 0 0 6 4 5 0 11`, red-light
  refusals 16,490–19,536 against a 6,536 pool (Decision 14, the §5.6 amendment);
- **the reachability figures**: junctions per boundary `0 / 2 / 6 / 6`, first junction at tick 4,530,
  at most 8 upgrades obtainable, `(13,18)` and `(11,20)` never junctions;
- the demo death ticks `6,703 / 5,757 / 6,660` and the rig end `6,459` (Task 3);
- `CITY_DEATH_TICK` **5,580**, unmoved (Task 2 Step 6);
- the week boundaries **2:21 / 4:51 / 7:21 / 9:51** against a first visible jam at **8:56**;
- **the buffer arithmetic `1,844 / 4,320 / 8,808 / 14,972` and `30` regions**, which Task 4 is told to
  verify by running `computeLayout` rather than by trusting the table. **The previous draft's
  `1,940 / 4,560 / 8,856 / 15,356` and 35 regions are SUPERSEDED and must not survive anywhere** —
  Task 12 Step 8 greps for them.

**6. Type consistency.** `runOffer(state, world, scratch)` returns `void` and matches
`runDemand`/`runSpawn`/`runOvercrowd`'s shape. **M1f declares no other phase function** — Amendment 2
deleted `runLights`, so `step.ts` ends at eleven phases and `packages/sim/src/upgrades.ts` exports no
per-tick entry point at all. `offerPending(s)` and `offerSlot(s, slot)` are defined in Task 4 and used
under those exact names in Tasks 5, 6, 7 and 8. `poolFor(world)` is defined in Task 5 as the
implemented mask alone and **redefined in Task 11** as `capabilityMask(world) & CARD_IMPLEMENTED_MASK`
— the signature does not change, which is the one place a redefinition could go unnoticed, and Task 11
Step 3 re-derives the two golden assertions that read it. `drawOfferPair(pool, seed, out)` writes a
caller-owned `Int32Array` in Tasks 4, 5 and both golden re-blesses. `cardTileGrant(cardId)` and
`cardItemGrant(cardId)` are Task 6's and are consumed by Task 8's frame fold and Task 11's agreement
test. `isJunctionCell(state, cell)` is Task 2's and is **NOT amended** in Task 9 — that is the whole
point of the split — while `junctionAdmitsOne(state, cell)`, also Task 2's, gains exactly one clause
there. `intersectionSpeedMul` **keeps its name**: it never returns a speed-up, because the roundabout
that would have made it one is deferred. `isUpgraded(state, cell)`, `canPlaceUpgrade(state, world,
cell)` and `applyPlaceUpgrade(state, world, cell)` are Task 9's; the first takes scalars and the other
two take `WorldData` for their bounds check, the same split M1e drew between `spawnZoneW` and
`inSpawnZone`. **`upgradeAt` stores 1 or 0 and `isUpgraded` is the only reader outside
`junctionAdmitsOne`** — there is no `slot + 1` convention to state, because Amendment 2 deleted the
table it indexed. `PointerOutcome` gains 10–14 across two tasks (`CARD_CHOSEN`, `PEEK_TOGGLED`,
`REFUSED_OFFER_MODAL` in Task 8; `UPGRADE_ARMED`, `UPGRADE_PLACED` in Task 10) and no value is reused.
**`EnterOutcome` gains NOTHING and `isEntryGranted` is untouched** — the previous draft added
`REFUSED_RED = 5`, and Task 9 Step 6 pins the enum's size so it cannot grow back by reflex.
`FrameDriverDeps.onOfferRaised` is declared **required** in Task 7 and passed in `main.ts` in the same
task; `FrameDriverDeps.peeking` and `RenderFrame.offerPeek` are **both** Task 8's, together with
`PointerInput.peeking`, so no field reads something that does not exist yet.
`EraseControl.suspend`/`resume` are Task 8's and are called from `main.ts` in the same task.
`takeCardPolicy(rig, slot)` is Task 7's and is called from four test files in that same commit.
`RenderFrame.upgradeAt` is a **raw view** assigned once in `createFrameBuilder`, exactly as `roads`
is, and `packages/game/test/frame.test.ts` pins it by identity rather than by value.
