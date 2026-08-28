# M1g carry-forward

What M1f measured, refused, and left open — with the rig beside every figure and
a **named recipient** on every item, because *"handed to whoever owns X" is a
drop when nobody owns X*.

Written at the close of M1f Task 12, against commit `473a6da` and the four
commits before it.

---

## THE FIGURES' VINTAGE — read this before quoting any number below

**A figure in this document is evidence about the commit it was measured at and
about nothing after it.** M1e's closing sweep found sixteen instances of a
durable artefact stating the opposite of a measurement, and the mechanism was
never carelessness — it was **decay**: a number that was right for its own task
and wrong two tasks later, having passed the review that shipped it.

Every figure below is one of four kinds and is marked where a reader could
mistake it:

- **ANCHORED** — pinned by a green assertion or a named constant, so it cannot
  rot silently. The load-bearing ones: `368 / 29,267 / 21,783 / 5` (the shipped
  control); `747 / 2,120 / 31,456` (the pre-M1f board, and the board a player who
  takes the item card every week gets back); `755` at `(9,22)`; `394` at
  `(12,19)`; `42 / 15,001 / four` and `133 / 10,207 / five` (both censuses on the
  shipped rule); `0 / 2 / 6 / 6`; `14,972` bytes and `30` regions; the ten golden
  digests; `MAX_UPGRADES` 24 against a measured maximum grant of 22.
- **PROBE-ONLY** — reproducible only by reverting a shipped predicate on a
  committed tree. **The pre-M1f record and both pre-M1f censuses are in this
  class and nothing in the tree asserts them.** See §11.
- **SPIKE** — measured in a throwaway spike whose code is not in the tree. Every
  traffic-light figure in §1 is of this kind. They are carried because
  re-deriving them costs a task; they are **not** re-runnable here.
- **UNVERIFIED** — could not be reproduced on any arm this tree can drive. *Not
  known to be wrong; known to be unchecked.* Each is marked in place.

---

## 0. THE DEVICE CHECKLIST — five minutes, one phone, one sitting

**NOBODY HAS SEEN ANY OF M1f ON A PHONE.** Not the four-column HUD band, not the
upgrade marker, not the chip or its badge, not the modal at either card height,
not the peek screen, not the erase button getting out of the way. The last time a
person looked at this game was **2026-08-10**, on the demo board, before the
default was flipped, before the run could end, before the ring existed and before
any of this milestone was written.

Run it in one sitting, in the order below — **ordered by what is most likely to
be wrong, not by what happens first.** Record every answer with the words **"one
device, qualitative"** attached: it is evidence that the architecture holds, not
a measured budget.

### Before you start: the clock in your hand is not the clock in the source

Every time in this repo is `(tick − warmStart) / 30`. The city's warm start is
**258 ticks**; the demo's is **1,200**. A stopwatch started when the board
appears therefore reads *less* than `tick / 30`:

```
                     warm start   dies at    source says    YOUR STOPWATCH
  city, no input        258        5,580        3:06            2:57.4
  city, greedy play     258       21,783       12:06           11:57.5
  city, greedy + the item card taken and placed every week
                        258       31,456       17:29           17:19.9
  demo                1,200        6,660        3:42            3:02.0
```

**The third row is new in M1f and it is the headline: taking the JUNCTION UPGRADE
card every week and seating it gives back the entire cost of the junction rule** —
747 trips against 368, and tick 31,456, which is the pre-M1f board to the digit.

### How to open each board

| what | link |
|---|---|
| the default (city) | the plain Mini App link, no parameter |
| the demo | `t.me/<bot>/<app>?startapp=demo` |
| the DOM erase pill | `t.me/<bot>/<app>?startapp=fallback` |

A Telegram webview has no address bar, so `?layout=` and `?fallback=1` are only
reachable in mobile Safari on the raw Worker URL. Use the `startapp` links.

---

### Q1 — THE MODAL AT 2:21, AND WHETHER THE CHOICE IS BLIND *(highest risk)*

**At 2:21.4 on your stopwatch (tick 4,500)** the board stops and dims and
**CHOOSE A CARD** appears over two cards.

- **The top card (A) is `JUNCTION UPGRADE` — `20 TILES`, `×2`.** The bottom card
  (B) is `ROAD TILES` — `30 TILES`. *(The acceptance criterion's first draft had
  these the other way round; Task 8 measured the order off the renderer's own
  draw calls. A is the upgrade.)*
- Tap one. The modal goes, the board runs again, and **the HUD tile counter is 20
  or 30 higher** than the frame before.
- **ERASE ROADS is off screen for as long as the modal is up**, and back
  immediately after. There is no frame in which the modal is up and the button is
  visible — that is asserted, but nobody has watched it.
- **SEE THE BOARD** shows the frozen city at full contrast with **TAP TO RETURN**,
  and the clock does not advance while you are there.

**Ask directly: *do you know what you are choosing between?*** This is the first
time this game has ever interrupted the player, and **it happens before they have
seen a single jam** — the first visible jam is at **8:56.0** and no week length in
§5.10's plausible range moves the first boundary past it.

*Watch for two things that are measured and should be invisible: up to **7 ticks**
of drain land after the boundary before the pause takes hold; and the paused cars
sit **0.09–0.22 cells** short of their sim positions — about 6 CSS px — frozen
there for as long as the player takes.*

**And do not read a still board as a failure.** On a board where you have drawn a
plain link and no more, the HUD reads **`0 TRIPS`** at 2:21 and nothing is moving.
That is correct. *"The cars move again"* is not literally true of that scenario.

---

### Q2 — THE TWO CARDS: is it a decision, or is one obviously right?

Ask the person **before they place anything: *what do you think a "junction
upgrade" does?*** The object is M1f's own invention. It is not a row in §5.10's
table, and a card whose name explains nothing is a card the player picks at
random.

**The measured answer goes beside whatever they say, and if they disagree with it,
say so.** Over eight seeds, twelve weeks each, greedy connection:

| policy | wins | trips vs `always tiles` |
|---|---|---|
| `always upgrades` | **7 of 8** | 1.03× – 2.03× |
| `alternate` | 1 of 8 (`s7`) | — |
| `always tiles` | **0 of 8** | — |

**And the tiles card is free money, as an identity rather than a ratio**: the same
seed, the same connector, the same twelve weeks, 30 tiles a week versus 20 — and
trips, death tick, blocked car-ticks and valve firings are all the *same integer*.
Ten extra tiles a week buys nothing at all, on every seed. `unaffordable` is 0 on
six of eight seeds and 75 on the other two, and even there the extra tiles change
nothing.

So the honest measured answer to *"is this a decision"* is **no, not yet** — one
card dominates and the other is inert. **What makes it survivable is §2.2's
*"items sit unplaced indefinitely"***, which is load-bearing rather than
decorative: see Q3.

---

### Q3 — THE CHIP AND THE GESTURE

Tap the inventory chip in the HUD. **The badge should read `2`** (a card grants
`UPGRADES_PER_CARD` = 2) **and the icon should turn teal.** Then tap a junction.

- Does the mode read as *armed*? The teal icon is the only signal.
- **Does a refused placement read as refused?** It does not move the badge, and
  the badge is the only feedback there is. Tap plain road, tap grass, tap a
  building. Ask whether anything you did was interpretable.
- **THE TIMING TRAP, and it is measured:** the board has **no junction at all
  until tick 4,530 — 2:22.4 on your stopwatch, one second after the first
  modal.** A player who takes the card at 2:21 and immediately tries to place it
  gets a silent refusal on **every cell on the board**. Ask whether that reads as
  *"not yet"* or as *"broken"*.
- Legal sites per week boundary, measured at the boundary tick on the greedy arm:
  **0 / 2 / 6 / 6** at 4,500 / 9,000 / 13,500 / 18,000.

---

### Q4 — THE JAM AT 8:56

Play normally. **Look for three cars stopped at once.** That is the measured
onset: **tick 16,337, 8:56.0 on your stopwatch.**

The board first *diverges* from the pre-M1f build at tick 12,780 (**6:57.4**), and
nobody can see that. 8:56.0 is the first moment a person can.

**Does a car stopping at a corner read as traffic, or as a bug?** This is the
question M1d's failure makes mandatory: the feature has to be visible to somebody
who was not told where to look.

---

### Q5 — THE UPGRADE WORKING, AND WHETHER ANYONE CAN TELL

At **8:56 (tick 16,337)**, with a card held, tap the chip and then tap **the
corner at grid (9, 22)**. A **static teal square** appears on that cell.
**About 12 seconds later (tick 16,704, +367 ticks) a car crosses that cell with
another car already in it** — the crossing §5.5's junction rule refuses and
§5.6's upgrade gives back.

**There is nothing to watch on the cell itself.** The marker is static; it has no
state and nothing to animate. The only evidence is that cars stop stopping there.
**Can the person tell it did anything?**

Then, on a fresh run, place one on **(8, 15)** or **(8, 23)** instead. Both are
legal junctions at the same moment and both are worth **exactly nothing** — 368
trips, the control to the digit.

**Can the person tell the difference?** If not, the spread is a number in a test
and not a mechanic — **and that is this milestone's most likely failure, because
the previous relief object at least blinked.**

*The measured spread over all six legal sites at the week-3 boundary:*

```
  (8,15)    368 trips     0.0 %   <- worth nothing
  (14,17)   377          +2.4 %
  (12,19)   394          +7.1 %   <- carries 39.4 % of the refusals
  (8,21)    679         +84.5 %
  (9,22)    755        +105.2 %   <- carries 21.7 % of the refusals
  (8,23)    368           0.0 %   <- worth nothing
  control   368
```

**THE BUSIEST-LOOKING CORNER IS THE WRONG ONE.** `(12,19)` carries the most
refusals and buys the least; `(9,22)` carries a third as many and buys the most.
Nothing on screen says so. See §13.

---

### Q6 — THE PERMANENCE

**An upgrade placed on the wrong junction cannot be removed this milestone.**
Place one badly on purpose — on `(8,15)`, which is worth nothing — and ask whether
that reads as a mistake the player can live with.

**And note the M1g consequence while the person is looking at it:** §5.6 makes a
relief object and a roundabout mutually exclusive on a cell, so a permanent
upgrade **forecloses a roundabout site M1g may want**. See §4.

---

### Q7 — THE EMPTY OPENING *(carried from the pre-M1f checklist; re-derived)*

The default board opens with **no roads on it at all**: three houses, three
destinations, six parked cars, an empty grid. That is also what a failed asset
load looks like.

- **At 0:00**: a green field, a river, trees, three destination blocks, three
  houses, six still cars, a HUD reading **30 TILES** and score 0.
- **Each of the three destinations has a RED parking bay**, in the alarm red
  (`#e8412e`), because no road reaches it. *Does that read as "three things need a
  road" or as "three things are broken"?*
- **At 0:01.4** (tick 300) a fourth house appears. *Does it read as an event?*
- **At 0:04.0** (tick 378) the first pin lands.
- Draw a road between a house and a same-colour bay. A car should run it within a
  second. **A bay turns grey the tick a road CONNECTS it**, not the tick a road
  touches it.

**Unchanged by M1f** — the board is bit-identical to the pre-M1f build until tick
12,780, so every figure in this question is the one the previous checklist
carried, re-derived and confirmed rather than copied.

---

### Q8 — THE FIVE-TILE SAVE *(carried; still applies, still undiscoverable)*

Nothing in the shipped UI tells a player that **column 17** is the move. A
15-tile column-8 road buys **zero ticks** and does not even change which
destination kills the city; **five tiles at column 17 buy 750 ticks.**

Both of the game's own signals arrive on the board, after the fact: the overcrowd
ring first appears at **1:10.4** (tick 2,369) and the no-input run ends at
**2:57.4**. The ring names *which* destination; the shutdown line says *connect
it*; **neither says where.**

*Watch for the trap: the wrong first road is not "nothing happening". The corridor
alone produces **21 completed trips and a climbing score** against 0 on the
no-input arm, so it reads as the game working.*

**M1f does not close this and M1g inherits it.** It is the same shape as §13's
*"nothing hints which corner"*, one milestone earlier.

---

### Q9–Q12 — the rest of the pre-M1f six, re-derived against the M1f board

| # | question | the moment, on the M1f board |
|---|---|---|
| Q9 | **Is the overcrowd ring readable at phone size, against the pin dots?** The ring and the dots occupy the same few pixels by construction. | city first ring **1:10.4** (tick 2,369, unmoved — the board is bit-identical until 12,780); demo first ring **1:16.4** (tick 3,492) |
| Q10 | **Does the shutdown screen say what happened, and can you find what it names?** The killer's ring is drawn at 2× width on the scrim. | no-input city **2:57.4**; demo **3:02.0** (tick 6,660 — **this moved: `DEMO_DEATH_TICK` was 6,703 pre-M1f and is 6,660 under the shipped junction rule**) |
| Q11 | **The ghost art — 182 assertions (UNVERIFIED count), zero human minutes.** Drag-erase a **five**-cell stroke, not three: a drag samples adjacent pairs, so only the N−2 middle cells lose both bits and ghost. | any time on the demo board |
| Q12 | **Does the run have an ending, or does the app just crash and reload?** The restart is still `location.reload()`. | after any shutdown screen |

**Every clock time in this section was re-derived against the M1f board rather
than copied forward.** Three moved: the demo death (6,703 → 6,660, so 3:03 →
3:02.0), the greedy death (31,456 → 21,783, so 17:19.9 → 11:57.5), and the new
third row of the clock table above.

---

## 1. THE METERED TRAFFIC LIGHT — built, measured, and deferred with every number

**Recipient: M1g, as a DESIGN QUESTION before it is a task.**

This is the second largest thing M1f hands on and it must not arrive as *"the
light was deferred"*. M1f built §5.6's light **to specification** in a throwaway
spike and measured it against its own control. Every figure here is **SPIKE**
vintage: the code is not in the tree and none of it is re-runnable.

**The control, ANCHORED:** 368 trips, 29,267 blocked car-ticks, death at tick
21,783, **5 valve firings with the first at tick 17,658 (9:40.0 on a stopwatch)
and a worst wait of 1,350 — saturated**, and 6,536 junction-caused refusals
(22.3 % of blocked).

**And what the shipped relief object does to that valve, which is the cleanest
derivation of the mechanism this milestone has:** an upgrade admits cars the bare
junction refuses, so it takes pressure OFF the valve. Taking the item card every
week and seating it gives **0 firings and a worst wait of 32** — the pre-M1f
values exactly. **But the direction is NOT uniform and that is a finding: three
of the six legal SINGLE placements RAISE the count from 5 to 6**, because relief
moves traffic downstream rather than deleting it and a badly-seated upgrade
admits cars into a queue that saturates somewhere else.

| variant | trips | vs control |
|---|---|---|
| **perfect relief ceiling** — exempt the six refusal cells | **750** | **+103.8 %** |
| exempt the six census conflict cells | **747 / 31,456 / 2,120** | the pre-M1f board **exactly** |
| exempt the top two by total refusals | 394 | +7.1 % |
| fixed alternating light, **best** seat phase | **320** | **−13.0 %** |
| fixed alternating light, median phase | 306 | −17 % |
| the plan's own **demand controller**, as specified | **228** | **−38 %** |
| the best variant found anywhere | **353** | still below 368 |

- **3 of 30 seat phases beat the control.** The seat phase is a parameter with no
  design meaning, and the spread it alone causes is **1.19×–1.70× per seed** —
  larger than any positive effect measured.
- **The demand controller swaps once in an entire run.** Over eight seeds the
  swap counts are `1 0 0 6 4 5 0 11` — **three seeds never swap at all**, so the
  light becomes a permanent closure released only by the 45 s valve. Only
  **12 of 192** phase-seed pairs beat the control.
- **`LIGHT_CHANGE_DELAY` probe:** 150 → 48 % wins, 300 → 31 %, 600 → 15 %.
- **Red-light refusals are 16,490–19,536** against the **6,536** junction-caused
  refusals the object exists to drain — **2.5–3.0× against**.
- **At `(12,19)` a light admitted ZERO entries the rule would have refused, while
  refusing 8,886.** That single number is the whole finding in one cell.

**STATE THE CAUSE AS A DENSITY MISMATCH, NOT AS A DEFECT IN THE DATAMINED
CONSTANTS.** `minimumNearbyCarsBeforeSwapping` = 2 within 2 tiles is essentially
never satisfied on a board carrying **about eleven cars in flight**
(`maxInFlight` = 11, ANCHORED). The datamined constants are a correct description
of the game being cloned and presuppose traffic far denser than this one has.
Nothing here says the mechanic is wrong; it says **this board is too empty for
it.**

**The three levers Decision 14 names, and M1g must choose:**

1. **Raise the board's car density** until the constants have something to meter.
2. **Lower `minimumNearbyCarsBeforeSwapping` to 1.** Measured: swaps rise to
   13–80 per run and `laneways-m2` recovers 228 → **349** — still below the 368
   control on **6 of 8 seeds**.
3. **Make the light a MODIFIER ON AN UPGRADED JUNCTION** rather than a
   replacement for it: the upgrade lifts the exclusion, the light meters what
   crosses. **This is the one M1f would bet on, stated so it can be wrong**,
   because it composes with a mechanic now measured to work rather than replacing
   it.

**`CARD_TRAFFIC_LIGHTS` is declared in `cards.ts` and excluded by
`CARD_IMPLEMENTED_MASK`** — an interlock, not an absence — and it keeps its
`CARD_LABELS` row in `render/src/canvas.ts`. See §7.

---

## 2. THE ROUNDABOUT — deferred behind a GEOMETRY decision, with the measurement

**Recipient: M1g, and it must answer the geometry question before writing a
task.** This is the largest thing M1f hands on.

**The measurement, SPIKE vintage:** on the shipped board, every legal 3×3
roundabout placement covering every cell that actually jams was enumerated at
every tick of the run. **Five of the six conflicting cells admit ZERO legal
centres at every tick. The sixth admits one — and it is the cell measured as
worth exactly nothing.**

**The cause is structural, not incidental.** The greedy connector merges
approaches **at carparks and at houses**, so degree-3 cells form *against
buildings* by construction — and §5.6 requires a roundabout's centre **plus all
eight neighbours** to be clear of buildings. **The rule that creates junctions
and the rule that permits roundabouts are in direct conflict on this board.**

**The four options the review enumerated, which are M1g's input:**

| | option | what it costs |
|---|---|---|
| (a) | **a smaller footprint** | changes §5.6's object; the whole geometry finding is about the 3×3 |
| (b) | **relax §5.6 to bulldoze-and-refund buildings inside the block** | needs a house-removal path that does not exist, and a determinism story for the car slots |
| (c) | **re-seed the city layout** so junctions form in open ground | invalidates all ten goldens |
| (d) | **leave it out** | what M1f did, and it is not a descope — it is a *substitution*: the JUNCTION UPGRADE places on one junction cell and **therefore cannot fail to reach the jam** |

**The single-cell object's placement rule IS the jam's location**, which is
exactly the property the roundabout lacked, and it is why `upgrades.ts` exists at
all. `ROUNDABOUT_SPEED_MUL` = 2000 is declared, uncalled, and **re-dated to M1g**
with this finding at its site in `shared/constants.ts`.

---

## 3. DELETING A PLACED UPGRADE, AND THE MID-TRAVERSAL RULE CHANGE

**Recipient: M1g.** §2.2's inventory counter is **bidirectional** — *"deleting a
placed item returns it once in-flight traffic clears"*. M1f places and never
removes.

**The reason is the same class the roundabout had:** un-marking a cell while a car
is **mid-crossing on it** changes that car's entry rule *inside a traversal*.
`junctionAdmitsOne` is read by `canEnter` from inside `runMovement` and by
`queueProbe.carAheadOf`, and both would answer differently on either side of the
removal.

**Amendment 2 made it CHEAPER than it was without making it free.** The previous
design was a metered light that owned timers whose retirement had to be defined;
the shipped object is **one bit per cell**, so removal is a flag to clear, a
count to decrement and an inventory to credit. What survives is the traversal
question, and it is the whole of the work.

**M1f's own invariants are what a removal path would break, and they are
asserted:** `H_UPGRADE_COUNT` **only ever rises** and `H_INV_UPGRADES` **never
goes negative**, sampled on every one of 31,456 ticks
(`integration.test.ts`, Task 12 Step 5). A removal path makes both false by
design — **that is a feature arriving, not a regression, and whoever lands it must
edit those two assertions deliberately rather than discover them.**

---

## 4. A PERMANENT UPGRADE FORECLOSES AN M1g ROUNDABOUT SITE

**Recipient: M1g, and it is recorded here because the previous draft recorded it
nowhere.**

§5.6 makes a relief object and a roundabout **mutually exclusive on a cell**. M1f
has no removal path (§3). So every upgrade a player seats **permanently removes a
cell from the set of legal roundabout sites for that run** — and §2's measurement
says that set is already almost empty.

Compounding: the measured best strategy is `always upgrades` and the measured best
placement policy seats **10 upgrades on the shipped seed** (§13). A player
following the dominant strategy forecloses ten cells.

---

## 5. `overtimeChangeDelay`, `americanRedLightRules`, AND RIGHT-ON-RED'S THREE RULES

**Recipient: M1g. This is CORRECT WORK THAT SHOULD NOT BE RE-DERIVED.**

- **`overtimeChangeDelay` = 5 s.** A real dossier row with **no referent in this
  game**. The closest candidate mapping M1f found: *"any destination's overcrowd
  timer is non-zero"*, computable from `destOvercrowd` in **O(destCount)** with no
  new state. Carried as a candidate, not as a decision.
- **`americanRedLightRules`** — the dossier flag that turns right-on-red on.
  Carried whole; nothing in M1f reads it.
- **Right-on-red decomposes into THREE rules and M1f honours the second one
  already.** (i) The turn skips the *stop*. (ii) **The turn does NOT skip the
  intersection SLOWDOWN** — §5.5's *"approaching an intersection = 0.5"* keeps
  applying. (iii) The turn is still subject to the blocking primitive.
  **M1f honours (ii) by a different route:** `isJunctionCell` is **unchanged at an
  upgraded cell**, so `INTERSECTION_SPEED_MUL` still applies there. That is why
  `isJunctionCell` and `junctionAdmitsOne` are two predicates and not one, and
  the split must survive M1g.
- **`greenLightsIgnoreCollisions` (dossier §1.7) IS WHAT M1f SHIPS** — as a
  whole-cell rule with **no phase** rather than a per-axis one. The §5.6
  amendment says so. A per-axis version is the light in §1.
- **`nextLegDir` does not exist anywhere in the tree**, and must not be
  re-introduced as an export: its only reason to exist was right-on-red.

**`EnterOutcome` gains NOTHING in M1f** and its size is pinned by
`blocking.test.ts`, specifically so `REFUSED_RED` cannot grow back by reflex.
M1g adding a light must edit that pin deliberately.

---

## 6. THE TILE ECONOMY — the lever, its price, and a correction to the plan

**Recipient: M1g. M1f has already paid the expensive half.**

**Measured at Task 12 Step 4, ANCHORED** (shipped seed, greedy connector, twelve
weeks or death):

```
  income          WEEKLY_TILE_GRANT 30 a week, plus the card's 20 or 30
  tilesLeft, week close   37  70  114  154  184        (slot-A policy)
  tilesLeft, week close   37  80  134  184  214        (always tiles)
  RUNNING minimum          7   (tick ~2,280)
  WEEK-CLOSE minimum      37
  unaffordable events      0   on six of eight seeds; 75 on s1 and s2
```

**Quote the qualifier or drop the figure.** *"`tilesLeft` never below 37"* is a
**week-close** sample. The running minimum is **7**. Both are now asserted, side
by side, with the qualifier in the assertion message, so they cannot be confused
again.

**THE PRODUCT FINDING, AND IT IS M1f's OWN:** **the card's tiles are free money.**
Greedy-arm slack went 2.7× → **4.3×** for *identical roads*, `unaffordable` is 0,
so the modal's **30-vs-20 costs nothing**. The plan's adversarial review predicted
this before a line was written. Task 12 turned it from a ratio into an
**identity**: 30 a week versus 20 a week gives the *same integer* for trips, death
tick, blocked car-ticks and valve firings, **on all eight seeds**.

> **Caveat, and it travels with the finding:** it is measured on a **greedy**
> connector laying **minimal** road. *"Costs nothing"* is proven for that arm and
> not for a human who paves. The direction is not in doubt at 4.3×.

**THE LEVER: stop granting `WEEKLY_TILE_GRANT` on a week the player takes the
tiles card — or delete phase 2's grant entirely.** Its price, so M1g budgets it:

- Two goldens' `H_TILES` become a **function of the input log** rather than of
  the tick count.
- `runWeekBoundary` loses its whole body, which is a **phase deletion and a
  second renumbering** — and the phase count is currently final at **eleven**.

**M1f HAS ALREADY PAID THE EXPENSIVE HALF.** Every frame-driven rig acquired a
card policy at Task 7 (`cardPolicy.ts`, four rigs, one function). So M1g's version
is **a one-line deletion plus two hand-computed re-blesses**.

> **AND A CORRECTION TO DECISION 5, WHICH THIS PLAN CARRIED AS TRUE.** *"Deleting
> phase 2 is the only version in which 30-vs-20 costs the player anything"* is
> **FALSE.** **Lowering `WEEKLY_TILE_GRANT` does it too**, with no phase deletion
> and no renumbering. The honest reason M1f does neither is **scope**, which the
> plan says elsewhere; the overclaim is dropped here.

---

## 7. `CARD_IMPLEMENTED_MASK` AND THE FIVE CARDS BEHIND IT

**Recipient: M1g, one bit at a time.**

`CARD_IMPLEMENTED_MASK = (1 << CARD_ROAD_TILES) | (1 << CARD_JUNCTION_UPGRADE)`.
It is **an interlock, not an absence**: all eight ids are declared, all eight have
`CARD_LABELS` rows, and five are excluded.

| id | card | why it is out | recipient |
|---|---|---|---|
| 2 | `CARD_BRIDGE` | breaks `assertNoRoadOnImpassable`, `placeRoad`'s `world.passable` gate, and `graph.test.ts`'s randomised *"every neighbour has `passable === 1`"* | M1g |
| 3 | `CARD_TUNNEL` | same three sites | M1g |
| 4 | `CARD_ROUNDABOUT` | §2's geometry finding | M1g, behind a geometry decision |
| 5 | `CARD_TRAFFIC_LIGHTS` | §1's density finding | M1g, as a design question |
| 6 | `CARD_MOTORWAY` | the one item in §5.10's table that changes `edgeCost`'s **value set** (the ÷3 tier), which `COST_UNIT_SCALE`, `CAR_SPEED_UNITS_PER_TICK`, `NB` and `DISTINCT_EDGE_COSTS` are jointly calibrated against | M1g |

**`poolFor(world) = capabilityMask(world) & CARD_IMPLEMENTED_MASK`, and today it
returns the same `130` on every one of the ten maps in the repo** — because both
implemented cards are capable everywhere. **That is pinned as a TRIPWIRE**
(`cards.test.ts`), so the day M1g deletes a bit, that test is the notice the
goldens are about to move.

> **DO NOT TIDY AWAY THE CAPABILITY HALF'S FIVE DIRECT TESTS.** The capability
> filter has **no detector reachable through `step`** and will not have one until
> a bit is deleted from the mask — measured: mutant 8 of Task 11's battery scores
> **0 on every map**. Its five detectors read `capabilityMask` directly. They look
> like assertions of the obvious and they are the only coverage that exists.
>
> Two of those five **cannot fail today** and are LABELLED INERT at the site, with
> a behavioural half added beside them. Keep the labels.

**And a shape warning:** `WorldData` gained **two fields for one consumer**
(`hasWater`, `hasMountain`, precomputed in `createWorld`'s existing walk). **A
third terrain predicate wants a different shape — re-decide rather than adding a
fourth field.**

---

## 8. THE ROUND-ROBIN / NEAREST-SOURCE MISMATCH — better evidence now

**Recipient: M1g.** §15.2 of the M1f carry-forward addressed this to M1f in the
imperative — *"M1f owns choosing between them"* — and **M1f declined it
deliberately**, so that the junction rule and the relief object stayed
attributable.

**The evidence is better now, and that is the reason to carry it rather than
restate it: there are queues to measure.** Before M1f the shipped board had
`REFUSED_OCCUPIED = 0` over 200,000 ticks. Today the greedy arm carries **29,267
blocked car-ticks**, a peak `longestQueue` of **8**, **5** valve firings and a
worst wait of **1,350** (saturated, i.e. the 45 s valve).

Demand distributes **evenly** over destinations (round-robin) while
`assembleSources` routes to the **nearest** source. It is the term that actually
decides whether a *connected* destination lives, and it is the largest thing this
project leaves open after the roundabout. All three candidate fixes are changes to
§5.3's scheduling rule and to `dispatch.ts`'s Decision 4.

---

## 9. THE EQUIVALENT-MUTANT REGISTER AT ITS M1f STATE — **it did not shrink**

**Recipient: whoever runs M1g's transposition sweep.** The previous plan predicted
the register would shrink. **It did not.**

| entry | state at M1f close |
|---|---|
| **`4 <-> 5`** — the card offer against the spawner | **OPEN, 0 detectors, AND THE OWNER TASK 5 NAMED HAS LANDED.** Task 5 recorded it as an absence and named **Task 8's frame fold** as what would give it a detector. Task 8 landed; Task 12 re-measured it at **0**. The obligation is open and it is nobody's until M1g assigns it |
| **`5 <-> 6`** — spawn against demand | **OPEN**, 0 detectors. Renamed from `4 <-> 5` by Task 5's insertion at position 4; `step.ts` carries a sentence a grep for `4 <-> 5` lands on. **Do not manufacture a detector**: the only edits that produce one are backdating `destSpawnTick` or routing §5.3.5's push around `fireColour`, and both are what the tripwires exist to catch |
| **`laneSpeedMul`'s rounding inertness** | **UNCHANGED AND STILL OPEN.** The values that would have closed it came from `ROUNDABOUT_SPEED_MUL`, and M1f defers the roundabout. `583/584 → 192` and `416/417 → 137` are pinned at `cars.test.ts:1590-1593`, so the entry is anchored rather than merely read |
| **`stepCell`'s `y < 0`** | unchanged, verified equivalent through either caller |
| **`spawn.ts`'s `maxHouses` short-circuit** | unchanged, 0 detectors — **and its comment names the suite size it was measured at**, because *"0 detectors across the whole suite"* in a durable comment silently re-points at whatever suite the reader has |
| **`3 <-> 5`** (M1e's numbering; `3 <-> 6` today) | still OFF the register at 1 detector. The scheduled failure M1f owns is unchanged: adding a `destPins` write to `placeRoad`/`eraseRoad` (§5.9's connectivity rule) makes phases 3 and 6 stop commuting, **at 0 detectors**, with `step.test.ts`'s disjointness scan as the only tripwire |

**One row M1f recorded as an absence and closed:** `3 <-> 4` (inputs against the
offer) was 0 at Task 5 and is **2** from Task 6's boundary-tick `choose-card`
test, re-measured at exactly 2 by Task 12's battery.

**Task 12 re-ran 27 of the 55 pairs** — every pair involving phase 3, 5 or 9,
which is the set a code-only diff (comments stripped) says actually changed since
Task 5's sweep, and it is **eight rows larger than the brief's `{3, 9}`**:
`buildings.ts` gained three `isUpgraded` refusals at Task 9 and `runSpawn` is
phase 5. Phase 4 is discharged by Task 11's **pinned identity** (`poolFor` returns
130 on all ten maps) rather than by a diff, and the remaining 21 by a zero
code-line diff. **Every re-run row scored >= 1 except the two above.** Flake over
both batteries: **1 of 7 baselines = 14.3 %**, all allocation windows — so every
non-zero row is +/-1 and every zero is safe, because a flake can only add.

**And the counts of the 28 rows NOT re-run are lower bounds today**: the suite has
grown 2,044 -> 2,286 cases since Task 5's sweep, and a mutation count goes stale
**upward** every time somebody adds a pin.

---

## 10. THE GOLDEN LEDGER AND THE BUFFER

**Recipient: every M1g task, before it writes *"this task re-blesses X"*.**

**TEN digests, at eleven assertion sites** (`613441763` has two), plus the two
splice proofs. All ANCHORED, all green, **none moved by M1f Task 12** — proved by
a **zero diff**: `git diff da6dd19..HEAD` contains **no line matching any of the
twelve literals**, and the only files it touches are four test files, `+1421 −0`.

```
  state             2986084740     (moved at Task 5, phase 4)
  road-network      1099508647
  field              252514232
  loop              1219899230
  queue             3831930847
  demand-pin         884326142     (moved at Task 5, phase 4)
  multipliers       2274456329
  seed               613441763     (two sites; was 968680755 before Task 4)
  demo              4178976587
  rejected circle   2889011739
  M1f splice proof   968680755     (spliceM1fInsertions must reproduce the pre-M1f digest)
  M1e splice proof  1178110182
```

**THE BUFFER: `13,992 → 14,972` bytes, `29 → 30` regions, `+980`, `+7.00 %`.**
Re-derived twice at Task 4 — an independent model and a real `computeLayout` run —
agreeing. Two splice ranges: `[52, 68]` and `[1696, 1844]`. **The Int16 tier is
UNCHANGED and there is zero padding.**

> **`1,940 / 4,560 / 8,856 / 15,356` and `35 regions` are SUPERSEDED and must not
> survive anywhere.** Task 12 grepped for `15,356`, `1,364`, `35 regions` and
> `1,940` across `packages/`, `tools/` and `docs/`: **zero hits.** The live
> arithmetic is `1,844 / 4,320 / 8,808 / 14,972`.

**M3 must re-measure the CloudStorage budget rather than extrapolate**, because
this buffer grew 7 % in one milestone.

---

## 11. BOTH CENSUSES — each with the definition that produced it

**Recipient: anyone dating this milestone, and anyone tempted to correct these
numbers.**

There are **two** policies and they measure different things. Quoting one as the
other is how this project spent three drafts being wrong in two directions.

- **`CENSUS_CO_PRESENCE`** asks *"were two different cars ever standing on one
  junction cell at the end of a tick?"* It is **STRUCTURALLY BLIND TO A SAME-TICK
  SWAP**: when two cars exchange cells across an edge, the junction holds one car
  at the start of the tick and a different car at the end, never two at once —
  and a swap across an edge with a junction at its end is exactly the case that
  produces the 2-cycles M1f Task 2 creates. **This policy cannot see the first
  thing the rule changes.**
- **`CENSUS_RULE_VISIBLE`** additionally counts an **occupant change within a
  tick**: cell holds `a` at the end of `t−1` and `b` at the end of `t`, never
  observed empty between. Its branch contains the co-presence predicate
  **verbatim as a disjunct**, so its cell set is a **strict superset** of
  co-presence's. **A five-cell rule-visible set is unconstructible.**

| arm | co-presence | rule-visible | vintage |
|---|---|---|---|
| **rule-disabled (pre-M1f)** | **232 / 15,001 / six cells** | **538 / 10,207 / six cells** | **PROBE-ONLY** |
| Task 2's WIDE rule | 11 / 17,658 / three | 44 / 10,207 / five | superseded |
| **arm B, the rule that SHIPS** | **42 / 15,001 / four** | **133 / 10,207 / five** | **ANCHORED** — two drivers plus the rig |

> **THE PLAN'S `271 / 12,780 / five` IS SUPERSEDED AND MUST NOT BE DERIVED FROM.**
> Task 1 measured 538 / 10,207 / six on two independent drivers with the
> definition unaltered. `(14,17)` does take a rule-visible event at exactly
> 12,780 — the plan's named event is real — it is simply not the first;
> `(12,19)` takes one **2,573 ticks earlier**.
>
> **What 12,780 actually is:** the first tick on which the board **DIVERGES** from
> the pre-M1f build, measured by hashing the whole state buffer every tick against
> the parent commit. It is not a census tick. **An artefact quoting 12,780 as
> "the tick the census fires" is wrong; one quoting 10,207 as "the tick the board
> diverges" is also wrong.** The gap between the two censuses is **159.8 s**, not
> 74.0 s, and the *direction* the earliest draft had backwards survives.

**The pre-M1f pair is PROBE-ONLY and has no standing assertion anywhere.**
Decision 3 declined a runtime switch for the junction rule, so after Task 2 the
shipped board has no rule-disabled arm. The figures are checked in exactly **two**
places, both through the same revert of the same named predicate
(`crossesDirections` in `blocking.ts`): **Task 3 Step 7 and Task 12 Step 1.**
Task 12 re-ran it and reproduced all eight quantities.

*UNVERIFIED: the plan asks this document to record that "two honest readings of an
earlier wording differed by 3 %". Nothing in the tree reproduces a 3 % figure. The
two honest readings that exist differ by **538 vs 271** on the count and by
**159.8 s vs 74.0 s** on the gap. Recorded as unchecked rather than repeated.*

---

## 12. THE REACHABILITY ARITHMETIC — what bounds the relief a player can get

**Recipient: M1g, before it tunes anything.** This is the sharpest thing M1f
leaves open and it is left open with numbers rather than with a shrug.

```
  junctions / legal sites per week boundary TICK   0 / 2 / 6 / 6
  the same, sampled over a 4-tick WINDOW           1 / 2 / 6 / 6
  the first junction on the board                  tick 4,530  (2:22.4)
  two of the six top refusal cells                 NEVER reach degree 3:
                                                   (13,18) at 19.5 % and (11,20)
  two cells (top two by TOTAL refusals)            +7.1 %
  six cells                                       +103.8 %   <- the ceiling
```

**AND A CORRECTION THE PLAN GOT WRONG IN BOTH DIRECTIONS.**

The plan says *"at most 8 upgrades are obtainable against a cap of 24 — a factor
of three"*, and Decision 15 says `MAX_UPGRADES` is 3× over. **That is a
FOUR-boundary run of the shipped seed with NO relief.** Taking the item card makes
the run longer, which produces more boundaries, which grants more upgrades:

```
  eight seeds, `always upgrades`, upgrades seated
  max boundaries reached          11   (s3, death 51,275)
  upgrades granted                22   = 2 x 11
  MAX_UPGRADES                    24
  SLACK                            2   -> 1.09x, NOT 3x
```

**One more boundary makes the cap binding.** `MAX_UPGRADES` is now pinned against
this measurement (`seedArms.test.ts`) so the derivation cannot rot back into a
claim.

**And the ceiling turns out to be REACHABLE, which the plan assumed it was not.**
On the shipped seed, `always upgrades` with eager seating reproduces
**747 trips / 31,456 ticks / 2,120 blocked car-ticks** — the pre-M1f board *to the
digit*, from an instrument sharing no constant with the one that measured it. The
+103.8 % exemption ceiling was described as unreachable because two of its six
cells never become junctions; a player who takes the card every week seats **ten**
cells and gets the whole thing anyway.

> **THE `+68 %` EXEMPTION CEILING FROM THE PREVIOUS MILESTONE SHAPE IS STILL NOT
> A COMPARISON FOR ANYTHING, AND BOTH DISAVOWALS MUST STAY.** It was an exemption
> of a *different object with unlimited throughput*. It is not a target and it is
> not a bound. It survives only in the M1f plan; do not tidy it away and do not
> promote it.

---

## 13. IS THE MODAL A DECISION? — the answer, as a measurement

**Recipient: M1g's first design question.**

Two numbers were specified as the answer before either was taken.

**(a) Single placements strictly worse than the control: 0 of 6.** A zero is not a
pass on its own and it was interrogated: the rig **is** measuring placement —
`(14,17)` moves trips by +9 and `(8,23)` moves blocked car-ticks and valve firings
while leaving trips alone. What the zero says is that on `laneways-m2` relief
never pushes traffic into a worse jam downstream. The spike's eight-seed row for
the six-cell exemption contains a **−5**, so a strictly-worse placement is a
multi-seed phenomenon this seed does not exhibit.

**The number that actually answers the question is the other one: THREE OF THE SIX
LEGAL SITES ARE WORTH EXACTLY NOTHING**, and the best is **2.05×**.

**(b) The policy comparison, eight seeds: `always upgrades` 7, `alternate` 1,
`always tiles` 0.** One policy dominates and the other is inert.

**So the measured answer is: the CARD is not a decision, and WHERE you put it is.**
The plan predicted `always upgrades` would dominate and it does; what it did not
predict is that the tiles card would be *exactly* inert rather than merely weaker.

> ### AND NOTHING HINTS WHICH CORNER. **This is M1g's first design question.**
>
> The placement decision is real and measured at **2.05×** — 368 → 755 at
> `(9,22)` against 368 → 394 at `(12,19)` — **and the player has no signal
> pointing at it.** Worse, measured:
>
> - **The busiest-looking corner is the wrong one.** `(12,19)` carries **39.4 %**
>   of the junction-caused refusals and buys the least; `(9,22)` carries
>   **21.7 %** and buys the most.
> - **The signal is not available when the card arrives.** Over ten seatings on
>   the shipped seed, **0** were made against a non-empty refusal tally: the first
>   offer is at 2:21 and the first junction-caused refusal is thousands of ticks
>   later.
> - **And placing DESTROYS the signal.** `junctionAdmitsOne` is false at an
>   upgraded cell, so an arm that seats every junction ends with a junction-caused
>   refusal tally of **exactly zero**. The information that would say where to
>   place only exists on a run where the player did nothing.
> - **Waiting for the evidence is worth up to +50 %.** An arm that seats only on
>   cells whose tally is already non-zero scores 245 vs 201 on `s1`, 363 vs 306 on
>   `s2` and **876 vs 584 on `s4`** — and is *worse* on `s6` and `s7`. So even the
>   right instinct is not uniformly right.
>
> **The same shape, one milestone older, is §Q8's five-tile save.** Both are
> *"the game has the information and shows the player none of it"*. M1g should
> answer them together.

---

## 14. UNOWNED ITEMS, GIVEN OWNERS HERE

### 14.1 GATE A (`trips < 400`) — **RETIRED, with the derivation**

**Owner: this section, and it is retired rather than reassigned.**

`startingCity.test.ts`'s GATE A asserted `trips < 400` on the greedy arm as an
allowance for the junction rule's cost. Task 10 left it standing with the reason
written in — **its arm places nothing** — and named nobody.

**The derivation that retires it.** An allowance for a known violation *must fail
when the violation is fixed*, or a dead exemption outlives the problem it
documented. This one cannot fail: the arm it guards seats no upgrade, so its trips
are the control's **368** and the gate has **32 trips of slack it can never use**.
It is not an allowance, it is a restatement of the control.

**What replaces it, and it is strictly stronger:** `integration.test.ts` and
`junctionArms.test.ts` assert **368 exactly** on the un-upgraded arm, and Task 12
Step 3 asserts **`best.trips / control.trips > 1.5`** on the upgraded one — an
inequality in the *opposite* direction that fails the moment relief stops working.
The pair says what GATE A was trying to say and can both go red.

**M1g: if you want GATE A back, it must be an assertion about an arm that
PLACES**, or it is the same dead exemption under a new number.

### 14.2 A PER-TICK TIME BUDGET — **owner: M1g, and it is not optional**

**Nobody owns per-tick cost, and the only instrument watching it is a per-case
timeout.**

Task 11 measured the generalisation and it is uncomfortable: `poolFor` is
evaluated as an **argument** to `runOffer`, so its 960-cell walk ran on **every
tick of every run**, not *"every tick of an unresolved week"*. Measured **2.16×**
on `demoCity` (1.58 → 3.46 s) and it **blew vitest's 5,000 ms per-case default
under the full suite.** Gating on `offerPending` still left +34 %. Fixed by
precomputing two flags in `createWorld`'s existing walk.

**The instrument that caught it was a TIMEOUT — invisible to both mutation
screens.** So the same signal that banks phantom kills in a battery is the only
thing watching per-tick cost. Both readings are true and the milestone needed
both.

**Consequences M1g must act on:**

1. **`packages/game`'s `testTimeout` was NOT raised, deliberately.** Cases run at
   2.1-2.7 s against the 5,000 ms default and the package's wall clock went
   44 s -> 61 s this task, so raising it is tempting. **Raising it blinds the only
   per-tick cost instrument the project has**: a 2.16× regression on a 2.7 s case
   is 5.8 s, which passes a 15,000 ms budget silently. The long cases added by
   Task 12 carry **explicit per-case timeouts** instead (`SWEEP_TIMEOUT_MS`
   60,000; `SEED_MATRIX_TIMEOUT_MS` 180,000; the Step 5 sweep 120,000), so the
   default stays tight for everything else.
2. **A SECOND instrument was needed for a different reason and it is worth
   knowing about.** Committing 24 frame-driven twelve-week runs made
   `packages/game` report `Timeout calling "onTaskUpdate"` as an **unhandled
   error** — 764 tests passing, the package red. Yielding inside the driver's tick
   loop, splitting the file in two, `--pool=forks` and `--maxWorkers=6` were each
   measured and none fixed it; removing the two files made the package clean. **It
   is total CPU**: the matrix doubled the package's worker time and starved
   vitest's parent of the scheduling it needs to answer a worker's RPC inside the
   60,000 ms birpc default. The fix is a `step`-driven twin at 0.45-0.73 s a run
   against 2.4-3.9 s, with the two drivers' agreement asserted on the shipped
   seed. **M1g: a long test is an availability risk for the RUNNER, not only a
   slow test.**
3. **The offer path has no cost instrument at all.** `poolFor` is guarded by a
   **source scan over one function body** and by nothing else. **Assign a real
   per-tick time budget** — a treatment/control delta against a same-process
   reference workload, so machine speed cancels — or accept that the next
   regression of this class is found by a timeout again, at whatever moment the
   suite happens to be slowest.
4. **The allocation harness says NOTHING about time**, and a per-frame 960-byte
   `Uint8Array` copy was **invisible to all three allocation windows** until Task
   10 caught it at 213.83 B/frame charged to a frame with no file. That hole is
   older than this milestone; the guard added for it is narrow.

### 14.3 TWO COVERAGE GAPS, DISCLOSED HONESTLY — **carry them, do not paper over**

**`applyPlaceUpgrade` and `applyChooseCard` have no tick-window allocation
coverage and cannot have one on any board a player produces.** Task 8's
`modalGame()` template does not transfer, and the reason is structural: **a modal
is a STATE and a placement is an EVENT.** You can park the sim in a modal and
profile 3,000 frames of it; you cannot park it in a placement. One event per
3,000-frame window is below the sampling floor **by construction** — that is the
catalogue's *"bytes-per-frame cannot see gated work, and changing the denominator
does not fix it"*, and dividing by the event count is a change of units.

**What would actually close it**, from the same catalogue entry: a sampling
interval sized to the gated event's total bytes (512 → 32 or 64 made an 8-event
injection visible in 6/6 windows), or enough events per window to be sampled.
**Neither is free and neither is scoped here.**

Both functions are covered behaviourally and by identity pins (the frozen
`UpgradePlaceResult` singletons). Neither has an allocation window. **Say so; do
not manufacture one.**

### 14.4 THE STALE-COMMENT SWEEP M1g INHERITS

Task 12 corrected three live comments that predicted an object M1f deferred
(`sim/src/roads.ts`, `game/src/demoLayout.ts`, `game/test/carSmoothing.test.ts`),
and one wide-rule figure that survived Task 3 in `game/test/junctionCensus.ts`.
**The scoping lesson is the durable part:** a sweep scoped to the files *you*
edited cannot find the artefact in a file you never opened that made a prediction
*about* what you did. **Grep for the claim, not the file.**

---

## 15. EVERYTHING ELSE IN M1f's OUT TABLE, WITH ITS MEASUREMENT

| deferred | owner | the measurement that goes with it |
|---|---|---|
| **Motorways, bridges, tunnels (§5.7, §5.1)** | **M1g** | Bridges and tunnels break a named, tested invariant in **three** places: `assertNoRoadOnImpassable` (`roads.ts`), `placeRoad`'s `world.passable` gate, and `graph.test.ts`'s randomised *"every neighbour has `passable === 1`"*. The motorway is the one §5.10 item that changes `edgeCost`'s **value set** (the ÷3 tier), which `COST_UNIT_SCALE`, `CAR_SPEED_UNITS_PER_TICK`, `NB` and `DISTINCT_EDGE_COSTS` are jointly calibrated against. **`NB`'s corrected margin is 14, not "zero slack"** — that claim was refuted and three sibling artefacts were corrected for repeating it |
| **Board expansion / a real revealed region (§5.1)** | **M1g** | Declined by M1d, by M1e and now by M1f, said out loud rather than re-pointed quietly. `MapData` carries no per-week schedule; adding one means folding it into `mapIdHash`, which moves every whole-buffer golden a **second** time in a milestone that budgets exactly one shape change |
| **Destination removal, and the square→circle upgrade (§5.2)** | **M1g** | Four source sites name removal as the trigger that ends an inert property — `state.ts`'s `houseAt`/`destAt`, `dispatch.ts`'s colour-order note, `trips.ts`'s ascending-arrival-order note, and `game/src/resolve.ts`'s slot-**reuse** class, closed today **only by reachability**. The upgrade's price is derived: a circle takes two rotation slots against a trigger cap only 33 % higher, so on `firstCity` the colour-1 circle dies at **5,580** where the colour-0 square would have died at **6,330** |
| **Surfacing or bounding `MAX_PATH_LEN` = 96 (§15.3)** | **M1g** | Declined with a reason: the HUD gained two surfaces this milestone (the modal and the chip) and a third readout competing with them is scope. The measurement that makes the deferral safe: the longest route ever walked on the shipped seed's greedy arm is **21 steps** against the 96 ceiling. **`H_ROUTES_REFUSED` IS NOT A BLOCKING INSTRUMENT** — it measures the route *walk* and is **0** on every arm this project has ever measured |
| **The demand ramp's three numbers, `DESTINATIONS_PER_WEEK`, `HOUSES_PER_DESTINATION`, the pin capacities, one car per lane-tile** | **M1g / tuning** | All shipped, all untuned. **Do not add a `CARS_PER_CELL` constant "for later"** — a constant with no caller reads as a supported configuration. Changing the ramp is a `rulesVersion` bump that invalidates stored replays. **And seed variance dwarfs most single-constant effects**: over the eight seeds on the `always upgrades` arm, trips span **181 – 1,737 (9.6×)**, death ticks **16,122 – 51,275 (3.2×)** and blocked car-ticks **1,303 – 42,381 (32.5×)**. **A single-seed claim below 2× is inside the noise** |
| **A real in-place restart (`resetState`), persistence, the out-of-band seed board** | **M3** | M1f's restart is still `location.reload()`. `seedStartingCity`'s six placements still happen before tick 1 and travel in **no input log**, so the seed board is still not Worker-replayable |
| **The perpendicular lane offset in the renderer, and the multi-tick draw divergence** | **M1g (renderer)** | Cars are still drawn on the centreline. The offset is `(-DY[dir], DX[dir])` at about **0.15 cells**, and the supremum M1g must re-derive is the offset table **plus** the chase bound. The tick-boundary divergence figure to quote is **0.9920 cells, 4.96 × `MAX_DRAW_LAG_CELLS`** |
| **Spawn weights** | **nobody, deliberately** | §5.9's *"ignore spawn weights after 5 consecutive failures"* governs a structure that does not exist. When weights land, the constant lands with them |
| **Whether one card a week is the right rate, and whether two items per card is the right grant** | **M1g** | §5.10 says both; M1f honours both and **measures nothing about them.** The one adjacent measurement: four boundaries fit inside the un-upgraded run and **eleven** inside the longest upgraded one, so the rate interacts with the run length the card itself creates |

---

## 16. THE REPLAY ECHO — carry this to M3 loudly

`applyChooseCard` throws when the client's echoed card id disagrees with what the
simulation offered, and that throw is the replay-divergence detector.

**Quantified by an independent Python reimplementation, 100k–200k trials:**
`P(echo fires per card taken) = 0.5020 / 0.5035 / 0.5026 / 0.5007` for a week
error of +1/+2/+3/−1, and **0.5006** for an `rng[0]` difference. So `1 − 0.5^N` is
**exact, not approximate**: one card 50 %, six cards 98.4 %.

**And it can ONLY fire on a divergence in `rng[0]` or the week, and only on ticks
where a card is taken.** **M3 MUST TREAT A PASSING ECHO AS A CHEAP EARLY SIGNAL
AND THE BYTE-IDENTICAL DIGEST AS THE INSTRUMENT.**

---

## 17. CHECKING THIS DOCUMENT — one grep per item, not a reading

The catalogue's rule: *a handoff can be complete in structure and still drop
items*, and the only check that works is one grep per item against a **list of
names**. M1d's handoff had eleven sections and 336 lines and was missing two of
eight items; it passed a reading.

This is the list. Every entry must appear in the body above with its number:

```
  metered traffic light .......... §1    (368 control, 320 best phase, 228 controller, 353 best variant)
  roundabout geometry ............ §2    (five of six admit zero centres; four options a-d)
  upgrade deletion path .......... §3    (mid-traversal; Amendment 2 made it cheaper)
  forecloses a roundabout site ... §4
  overtimeChangeDelay ............ §5    (+ americanRedLightRules, right-on-red's three rules, nextLegDir)
  tile economy + the lever ....... §6    (free money as an identity; the Decision 5 correction)
  CARD_IMPLEMENTED_MASK .......... §7    (five cards; the capability half's five tests)
  round-robin / nearest .......... §8
  equivalent-mutant register ..... §9    (it did NOT shrink; laneSpeedMul open; 5 <-> 6 open)
  golden ledger + buffer ......... §10   (ten digests, 14,972 B, 30 regions)
  both censuses .................. §11   (232/15,001/six and 538/10,207/six, PROBE-ONLY)
  reachability arithmetic ........ §12   (0/2/6/6; MAX_UPGRADES slack 2, not 3x; the +68 % disavowals)
  is the modal a decision ........ §13   (0 of 6 worse; 3 of 6 worth nothing; 7-1-0; nothing hints which corner)
  GATE A ......................... §14.1 (retired with a derivation)
  a per-tick time budget ......... §14.2 (and why testTimeout was NOT raised)
  two allocation coverage gaps ... §14.3 (a modal is a state, a placement is an event)
  the stale-comment sweep ........ §14.4
  the rest of the Out table ...... §15
  the replay echo ................ §16
  THE DEVICE CHECKLIST ........... §0    (twelve questions, nobody has run it)
```

**Run the greps. Do not read the prose.**
