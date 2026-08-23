# Testing defect catalogue

Every way this project's tests have lied, with the case that produced each one. **Thirty-plus findings across M1a-M2 have been defects in tests, or in untested code that looked covered — every single one passed a green suite, and none would have been found by running the code.** The count is deliberately not exact: it was wrong twice when maintained by hand, which is itself an entry below.

Read this before writing a plan, a brief, or a test. It is a review checklist, not a history.

It outlived its original filename (`m1c-carry-forward.md`): the shapes are milestone-independent. Milestone-specific structural items live in `m1<n>-carry-forward.md`.

## Process

**Never run two implementers at once. They share the main checkout; only reviewers get worktrees.**

This was violated once, knowingly, to parallelise a fix round against the next task. The consequence: one agent's verification came back **red with 48 failures in a package it had never opened**, because the other was mid-mutation-battery on a shared source file at that moment. The tree was restored before either looked at `git status`, so the evidence was gone by the time it was examined. It was caught only because the failure count was implausible for the change — **and had the stray mutation landed in the package that agent was actually editing, it would have read as its own regression.** A mutation battery makes the working tree transiently wrong by design; two of them interleaved make every measurement in both untrustworthy and leave no trace. Before quoting any suite-wide number, check `git status` for strays and source mtimes against your own last write.



Plan first, then **adversarially review the plan before executing it**. M0 and M1a ran plan → execute → review, and every substantive defect in both was a plan defect. M1b's pre-execution review returned 9 Critical for the cost of one review — two of which produce green tests and execution would never have caught.

Every task mutation-tests its own tests, **and confirms each mutant actually executed** — a crash count reads exactly like a kill count. For each behaviour, record the one-line change that makes its test fail, and where you cannot construct one, say so — that answer is useful.

Plans do not state expected test counts. The author got them wrong five times.

**Measure detector counts with this exact invocation, and no other:**

```
pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test
```

`pnpm test` **bails at the first failing package**, so any mutation that breaks an early package reports zero detectors for every later one. And the obvious fix is also broken: **`pnpm --no-bail test` bails too**, because the root script is itself `pnpm -r …`, so the flag lands on the outer run rather than the recursive one. Verified under a deliberate failure — `pnpm test` and `pnpm --no-bail test` both stop at `shared` with 2 failures and never reach `sim`, which has its own detector; the recursive form reports all five packages. A per-package `--filter` run is safe; anything claiming a whole-suite count is not, unless it used the line above.

### The shapes that keep recurring

- A test aimed slightly off-target — `snapshot()` already detaching masked `restore()`'s missing copy.
- A test at the wrong operating point — `bound = 3`, where modulo bias touches one value in 4.29 billion.
- A test that reimplements the thing it checks — a scan self-test re-typing its own regex.
- A fixture that cannot distinguish the variables — a square map hiding a width/height swap.
- Production code with no covering test, masked by a redundant sibling — `H_MAP_W`, and `placeRoad`'s `cleared[a]`.
- A test guarding a failure mode while exhibiting it — the row-seam self-blindness test.
- **Testing that a guard refuses bad input is not testing that the feature does its job.** `syncFields` — the once-per-tick rebuild the game actually runs — had three mutations survive a green 232-test suite, including one where the game builds fields at startup and then ignores every road the player draws.
- An assertion checked against the formula that produced the thing under test — the `ST_PUSHES` bound against its own allocation.
- **The inverse also happens: when two structures are INDEPENDENTLY SUFFICIENT, neither half can have an observer and the compound is the only meaningful mutation.** Task 6 found both halves of an arrival guard to be 0-detector no-ops — dropping the `else` while keeping the single read is as inert as the reverse — because either structure alone upholds the invariant. Demanding a per-half detector there would be demanding a test that cannot exist. **Decompose first; then ask whether a surviving half is unobservable because coverage is missing, or because the other half is sufficient.** Those look identical in a mutation table and want opposite responses: write the test, versus write the comment explaining why no test can exist so nobody deletes either guard on the strength of its own survival.
- **Two tests can each cover one half of a conjunction and leave the conjunction itself untested — while the one NAMED for it is the emptier half.** M1d states three times in source that *"the valve must not release a `REFUSED_GHOST`"*, and isolating that rule survives all 1,487 tests. Two tests look like they cover it: one occupies the slot but never saturates the blocked counter, the other — **named "THE VALVE DOES NOT RELEASE IT"** — saturates the counter but leaves the slot *free*, where the valve never applies. Neither reaches the state where both conditions hold. And an earlier task recorded the rule as killed at 2–3 detectors, from an over-broad mutation whose kills all came from a different arm. **A rule whose precondition is a conjunction needs a fixture where every clause is simultaneously true** — and a test's *name* is the weakest possible evidence that it reaches the state it names.
- **A compound mutation being caught does not mean each half is.** "Drop the carpark from the spacing comparison" applied as one edit is caught; applied to only the *existing* destination's side it survives all 366 tests. The fixture guarded one direction of a symmetric comparison. When a mutation touches two symmetric code paths, mutate them separately — otherwise one live mutant hides inside a caught one.
- **"A guard cannot guard its own deletion" is true in general and can be wrong in a specific case — check whether the code invites the compound edit.** Task 4 had two independent walk bounds; deleting either was caught, deleting both hung. That was accepted as an unrealistic compound edit, on the correct general principle that defending against guard-deletion regresses infinitely. It was still the wrong call: both bounds derive from the same constant, and **each one's doc comment cited the other as "why this looks redundant"** — so the code itself invites a single coherent cleanup PR removing both. One edit, one person, following the comments as written. Before dismissing a compound mutation as unrealistic, look for whether something in the code makes it the natural next edit.
- **A comment that overstates its case is the same defect class as a test that cannot fail** — it reads as verified and is not. A guard was justified by an `H_EPOCH`-poisoning argument that could not be true yet, since none of the implicated functions were wired into `step()`. The guard was right; the reason was falsifiable. Prefer a justification that does not depend on wiring that does not exist: validate at the boundary where the caller's mistake is made, not where its consequence surfaces.
- **A test written specifically to catch a thing can still be blind to it, when the code collapses several causes into one observable.** M1c's final reviewer wrote a seam test, ran it under its own target mutation, and it passed — `dispatchColour` funnels three distinct refusal reasons into a single branch, so the observable could not distinguish them. Writing the test for the right reason does not make it able to see. Always run it under the mutation it was written for.
- **A check whose coverage is a strict subset of another check's is worth nothing — and its blind spot is the other check's blind spot.** M2's render→sim import scan caught `from '@laneways/sim'`, `import()` and `require()`. Every one of those is *already* rejected by `tsc` with TS2307 under pnpm's strict layout. The form nothing else catches — `from '../../sim/src/hash'`, a raw relative path — passed lint, typecheck and the scan together. The test file's own comment named "a raw relative path" as the reason the scan existed. **Before writing a guard, ask what it catches that nothing else does; if the answer is nothing, it is decoration that reads as defence.**
- **A harness can skip work silently.** `pnpm -r run <script>` skips any package lacking that script and fails only if *none* have it — verified: deleting a package's `test` script left `pnpm test` exiting 0, and deleting its `typecheck` script left the package never typechecked. A new package can therefore ship with zero tests and green CI. Assert the scripts exist, per package, by reading `package.json` directly.
- **A truncated view of test output silently undercounts detectors.** M2 Task 2's first mutation battery reported detector counts about two low across the board, because it measured by piping vitest through `head` — which cuts the failure list before the end. Re-measured off vitest's own `Tests N failed` summary line, every count moved up. A detector count is evidence about how well-covered a behaviour is; measuring it through a truncating pipe biases every number in one direction, and the bias is invisible because the output still looks like output.
- **A fixture can be too PERMISSIVE to exercise its own guard, which is the mirror of being too narrow.** M2's liveness fixture set its revealed rect to the whole board, so the `inside()` bounds check never excluded anything and deleting it survived. The predicted failure had been the opposite — dead slots parked at cell 0, *outside* the rect, so the bounds check would do the work instead of the liveness prefix. Both produce a green 0-detector. **A guard needs a fixture where something is on each side of it**: a rect strictly smaller than the board, with live and dead slots both inside the drawn region.
- **A mutant anchored on a comment is never applied, and reads exactly like a survivor.** M1d's reviewer anchored two of its own mutations on a doc comment rather than on code, ran them, and got 0 detectors — indistinguishable in the output from a genuine coverage hole. It caught this itself and re-ran, after which all 22 counts reproduced exactly. Same family as the crashing mutant whose failure count reads like a kill count: **the mutation table's unit of evidence is "the mutant executed and changed behaviour", and both halves need checking.** Anchor on a line the program runs, and confirm the edit landed where you think it did.
- **A precise-looking number that cannot be reproduced from its own description is not evidence.** A plan cited "97,040 raw return-value differences" for an equivalence argument. An independent exhaustive run gave 92,040 in-range and 118,640 including extremes — the total depends entirely on which extreme cells were enumerated, which the plan never stated. Only the **0 sign differences** was load-bearing, and that reproduces robustly. **State the enumeration or drop the figure**: a number specified to five digits reads as measurement and was, here, unverifiable.
- **A FALSE authorisation to re-bless a golden is worse than no authorisation.** M1d's plan claimed a lane-speed task must move the loop golden. It must not — the fixture is a straight degree-≤2 corridor, so no turn or intersection multiplier ever applies. The danger is not the wrong claim, it is what the claim licenses: a standing permission to re-bless, in a milestone where two *other* tasks add state regions and move that same golden for real. The false licence would have absorbed both genuine regressions silently. **Before writing "this task re-blesses X", derive that X actually moves — and name which task owns each move, so a golden that moves for an unlisted reason still stops the world.**
- **A refutation pass is worth roughly four fifths of the Criticals, and multi-lens agreement predicts what survives.** M1d's review raised 124 findings; unrefuted it read as **48 Critical**, and after refutation and dedup it was **9**. Every survivor had been reached independently by two or more lenses; the single-lens Criticals were almost entirely killed. Two consequences. **Never act on an unrefuted review** — four fifths of its alarm is noise. And when a run dies before its refuters finish, **multi-lens agreement is the usable proxy**: it has predicted survival on three consecutive milestones.
- **"Handed to whoever owns X" is a drop when nobody owns X.** Three times on M2 a gap existed because *no task was assigned the work* — nothing placed a building, nothing made erase reachable, nothing repointed the bot. The fourth was subtler and reads as diligence: a review measured `canPlaceRoad` allocating in the frame loop, correctly scoped it out of its own task, and handed it to *"whoever owns the perf budget"*. **There was no such owner.** Two later tasks then scoped the allocation harness to their own packages, so the package doing the most work in the frame loop was covered by neither and the milestone's "mechanically enforced" claim was false as scoped. **A handoff needs a named recipient — a task, a milestone doc, a file. "Someone" is a synonym for "no one".**
- **A per-frame allocation figure is a property of the test driver, not of the code.** The final review measured `canPlaceRoad` at 37.96–39.39 B/frame; the fix round measured 81.79–84.45 in its own rig. Neither was wrong — one driver enqueues one action per frame, the other two. Both reduce to **~40 B per call**, and that is the invariant worth pinning. A per-frame band pinned as a budget silently encodes the drag density of whichever fixture happened to write it, and then fails when someone writes a busier one.
- **An allowance for a known violation must fail when the violation is fixed.** The `canPlaceRoad` budget asserts the allocation is **still present**, not merely under a ceiling — so when M1d removes it, the test goes red and the allowance gets deleted. Otherwise a dead exemption outlives the problem it documented, and the next reader treats it as a real constraint.
- **An optional dependency can silently reopen the defect it was added to close.** M2's erase control took a `createFallback` factory that was **optional** in its deps type — so `createEraseControl({ host })` compiled, reported `NONE`, and left the player with no way to erase: the milestone's Critical reinstated with no compile error and no test failure, by an omission a later task could make without noticing. **If a dependency is what makes a feature reachable, make it required and let the type system say so.** Every degradation path around it was handled correctly; the hole was in what the signature permitted, not in the logic.
- **A COUNT reads as complete information, in a handoff exactly as in an assertion.** Three times across two milestones the coordinator wrote "the five Minors" or "the two Minors" into a fix-round dispatch and included none of their text. Each time the implementer noticed and asked — which is the only reason none were lost. Task 5's implementer named the generalisation better than the catalogue had: **this is the same shape as its own C1 defect, "a signal that looks complete because the count is present."** An `endswith` assert that passes on the wrong line, a diffstat that grows while eleven tests leave, and a dispatch that says "two Minors" with no Minors in it all fail identically — **the recipient cannot distinguish present-and-empty from absent.** Carry the content, not the cardinality; and where a count is genuinely the payload, state what it counts so a mismatch is visible.
- **A self-check whose success condition is satisfiable by accident converts "I did not check" into "I checked".** The eleven-test deletion above happened because a splice ran to end-of-file, and the guard against exactly that — an `endswith('})')` assertion — **was satisfied by the file's own last line.** The check passed, confirmed nothing, and read as confirmation. The repair generalises: diff **test names** across every touched file rather than counts or line totals, which then surfaced five further differences nobody had noticed.
- **The minimum-over-N-windows trick defeats INDEPENDENT sampling noise and does nothing for CORRELATED attribution.** Having solved one flaky allocation window with a rate plus the minimum over three draws, the same prescription was applied to the next one and failed — because that blob is ~58 B/tick **correlated on one file per process**, a constant ~6 B/event that no window count or length dilutes. **A minimum over three correlated draws is just the draw.** The instrument for the correlated case is a **treatment/control delta**: a matched rig with the feature absent in the control, so the per-process constant cancels. Know which kind of noise you have before reaching for either.
- **`pnpm -r` prefixes every output line with the package name, which silently defeats start-of-line matching.** A multi-package run emits `packages/sim test:       Tests  35 passed (35)`, not `Tests  35 passed (35)` — so any screen anchored with `^` matches nothing and reports clean. Task 8 found this in its own crash screen alongside a second defect (a bare `Error:` never matched at all). **Both were silent**: a screen that matches nothing looks exactly like a screen that found nothing. Anchor on the substring, not the line start, and prove the screen fires by feeding it known-bad output before trusting a clean result.
- **The complement check catches what the crash screen misses, and vice versa.** Task 8's first screen defect was found not by the screen but by the **complement check** — verifying the *expected number of tests actually ran*. The two mechanisms fail differently: a crash screen looks for error classes and misses anything it is not spelled to match; a complement check notices that 1,450 tests became 1,204 regardless of why. **Run both.** Neither alone establishes that a mutant executed and behaved.
- **The crash screen itself produces false positives, and a false positive DISCARDS A VALID MUTANT.** Every task on this project screens mutation output for `ReferenceError`/`TypeError`/module-load failures, because a crashing mutant's failure count reads exactly like a kill count. Task 7's screen greps the whole output — and matched a **test name containing the word `TypeError`**. It flagged a perfectly valid mutant as a crash, and that mutant was discarded and replaced. The same screen had validated every other row in the table. **Both directions of this heuristic are lossy**: a false negative banks fake kills, a false positive throws away real coverage evidence and nobody notices, because a discarded mutant leaves no trace. Match on the **error-class line** rather than anywhere in the output, and when a mutant is discarded as a crash, record the matched line so the decision is auditable.
- **A test can get the right answer from the wrong mechanism, three ticks late.** Task 7's first attempt at catching a re-pathing mutant compared cell lists **at the end of the run**; the mutant died — but to the 180° reversal guard firing three ticks after the divergence, not to the divergence itself. Moving the comparison inside the tick loop made it fail where the defect actually is: *"carCell left the committed route on tick 33: expected 104 to be 125"*. A kill at the right time is evidence about the mechanism; a kill at any time is only evidence that something noticed.
- **A replacement guard can have teeth for one family and none for its sibling — write the violation and see.** Task 7 correctly retired a `state.roads[` source scan whose premise had died, replacing it with a stronger pair plus a behavioural test. Asked to try, the reviewer **wrote a re-pathing implementation that passes all three**: re-path only where the route's road bit is *absent*, which trips no scan because `roadMask` is already imported. The branch-following variant *is* caught, 13 detectors — so the guard covers one shape and misses the other, and **the shape it misses is the erase-under-traffic case the original promise existed for.** The invariant survived only by accident, through ghost tests written for something else. **Retiring a guard obliges you to write the violation it was protecting against and watch the replacement catch it** — "stronger" is a claim about a specific attack, not a property.
- **A source scan matches comments, not just code.** The same task's `not.toMatch(/state\s*\.\s*roads\b/)` failed on a mutant's *explanatory comment* while the code change alone passed — and the module's own doc comment is visibly worded to dodge it ("the `roads` region", never the literal). Two costs: a future author documenting the region by name breaks the build for a non-behavioural reason, and any claim of prose-immunity must be checked per scan rather than assumed from a sibling.
- **A green golden proves the digest; a red golden TEST proves only that something in it failed.** M1d Task 6 recorded "loop golden moved: yes" for a mutation whose digest was in fact byte-identical — the column came from a grep counting *"a test inside the loop-golden describe failed"*, and what had actually failed was an assertion the task itself had just added, throwing before the test ever reached `hashState`. Handed the one wrong row, the implementer **re-measured all five `yes` cells by digest** rather than fixing the row: four genuinely moved, one did not. **The asymmetry is the rule** — a `no` needs no re-check, because a green golden is the digest speaking directly; every `yes` needs one, because a failing test inside a golden's `describe` block attributes to the golden by proximity, not by evidence.
- **An OVER-BROAD mutation attributes its kill to the wrong cause, and can look like it refutes a true finding.** Task 6 reported that deleting blocking entirely leaves the loop golden **green** — only its new fixture catches it. Checking that, the coordinator replaced the whole of `canEnter` with `return ENTER_FREE`, and the loop golden **failed** — apparently refuting the finding. It did not: the over-broad edit also bypassed the **ghost check** two lines above, and *that* is what the loop golden caught. Re-applied narrowly, to the occupancy branch alone, the reported result reproduced exactly. **A mutation must isolate the mechanism it claims to test**; when one kills, ask which of the things it changed did the killing. The accidental discovery — that the loop golden *does* cover the ghost rule — was worth having, but it arrived disguised as a refutation.
- **A deletion masked by a larger addition in the same file is invisible in a diffstat.** M1d Task 5 removed **17** `it`/`describe` blocks from one test file and added 10, inside a commit whose stat line reads `337 insertions, 240 deletions` — the file grew, the report said nothing was dropped, and **eleven pre-existing tests left the repo unnoticed**. Among them the only *structural* enforcement that movement cannot re-path (a signature test asserting the module imports no flow field and never reads `roads`), and five off-manifold guards that a previous task had existed largely to establish. A surviving behavioural test that checks the same *outcome* is not a substitute for a signature test that makes the failure unconstructible. **Diff the test-block count, not the line count**, on any commit that rewrites a test file: `git diff BASE..HEAD -- <file> | grep -cE '^-\s*(it|describe)\('` against the same for `+`. A net-positive line count says nothing about coverage.
- **A TRUE claim established by a method that cannot establish it is still a defect — and it propagates further than a false one.** M1d Task 4 reported one package clean across a mutation battery. The claim was correct. But the command it cited, `pnpm test --no-bail`, *crashes* vitest, and the fallback it fell back to **bails before that package ever runs** — so the stated method could not have produced the stated result. Nobody re-checks a claim that turned out true; the *method* is what the next person copies, and it returns a green that means nothing. **When a result is right, the evidence still has to be the evidence.** Record the exact invocation, and confirm it reaches everything you are claiming about.

  **The exact invocation, since "record it" is only useful if someone does — and three of the four candidates are wrong.** Measured on this repo under a deliberate failure: `pnpm test` bails and never runs the last package; `pnpm test --no-bail` forwards the flag to vitest, whose option is `--bail <number>`, and every package dies with `CACError: option --bail <number> value is missing`; and — the trap — the *textually correct* fix `pnpm --no-bail test` **also silently bails**, because the root `test` script is itself `pnpm -r --filter … test`, so the flag lands on the outer single-project run and never reaches the inner recursive one. Only spelling the recursion out at the top level works: **`pnpm -r --no-bail --filter './packages/*' --filter './tools/*' test`**. Note what makes this class hard to catch at all: a runner's bail and filter behaviour is **invisible on a green tree**, which is exactly the state you are in when you write the sentence down. **Verify a suite-wide claim under a deliberate failure, not under a pass.**
- **Evidence can prove more than the report claims, and misfiling it invites someone to delete the wrong half.** The same task offered two proofs that a gridlock ring deadlocks, and described the weaker role for each: the byte-identity fixture was presented as headline evidence of "nothing moved", which its per-tick assertions already entailed, while a second fixture was built to establish permanence. In fact the byte-identity **is** the inductive step for permanence — state returns to its initial value, the counters are write-only without the valve, and the loop is deterministic, so it cycles forever. Both fixtures passed and the conclusion held; only the reasoning was misassigned. A reader deciding which fixture is redundant would have deleted the load-bearing one.
- **A report can carry, in its own body, the evidence that refutes its own headline.** M1d Task 3's summary claimed wiring the blocking primitive broke *exactly one* test in 1,308 — offered as confirmation that a later task's derivation held. The true count was **two**, and the report's own §9 predicted the second one. §10 contradicted §9 across a few pages, nobody noticed, and the wrong figure was relayed onward as evidence. **A headline number is a claim like any other: check it against the body that is supposed to support it**, especially when the body was written first and the summary last.
- **A guard that fail-closes on one parameter and not its sibling is worse than no guard**, because the unguarded path returns a *plausible* answer. `canEnter(state, world, car, freeCell, dir)` asserted the cell was on-board and did not assert the direction was in range — so an out-of-range `dir` read a `NaN` slot and returned `REFUSED_OCCUPIED`: the exact "answered occupied by a slot that does not exist" failure the cell guard's own comment existed to prevent, reached through the other parameter and indistinguishable from a real refusal. Unreachable in production *today* — which is the same unreachability the cell guard already accepts as a reason to guard. **When you guard one argument, guard the others in the same signature, or write down why they differ.**
- **A SAMPLING profiler produces bimodal results, and an absolute bound on one draw is a coin flip.** M1d's `completeTrip` allocation test failed ~2 runs in 12 under the full parallel suite and passed 8/8 in isolation. It was not a marginal threshold: when it fired the measurement was **5x the bound** (10,144 B against 2,048) and the rest of the time the file was **absent from the profile entirely**. `HeapProfiler.startSampling` samples at intervals, so an attribution either lands in your frames or it does not.
  **The diagnosis matters more than the fix, and it was reached two ways.** The charge *did not scale*: 8x the trips gave means of 208/1,073/451/996 B, where a real 15 B/trip predicts 2,430/4,905/9,780/19,560 every round. And it was *not that file's property*: every charge was attributed to `<top-level>` rather than to any function, and the same artefact hit four other files — one of them at **exactly the same 10,144 B** — while the accused file was the least-hit at 1 in 12.
  **The instrument, not the number:** assert a **rate** (the invariant does not change with window length) and take the **minimum over three windows** (a per-trip allocation appears in every window; a stray appears in about a fifth, so all three ≈ 0.8%). Note the implementer chose the minimum over *filtering `<top-level>`* deliberately — **a filter is a claim about attribution that could blind the guard, while a minimum makes no such claim.** And it stayed falsifiable: floor 0.00, quietest positive control 4.4x above the bound.
- **A non-escaping injection is not an injection — V8 deletes it, and the harness looks blind.** Verifying the allocation harness covered new code, the coordinator injected `const __sink = { a: 1, b: 2 }; void __sink;` into the function under test and got a green suite — apparently proving the harness blind. It was not: the object never escapes, so **scalar replacement removes the allocation entirely** and nothing was ever allocated to measure. Re-injected as `(globalThis as any).__sink = {…}` it fired immediately at 177 B/frame, two tests red. Same effect made a real `HudRects`-per-event mutation unobservable on M2. **When probing an allocation harness, make the object escape** — assign it somewhere observable, or you are testing the optimiser rather than the instrument. And note the shape: this is "a mutation that does not change behaviour reads like a survivor", one level up, aimed at the measuring device.
- **A coverage instrument's SCOPE does not follow the code — and it keeps passing while not covering the new thing.** The allocation harness has now failed this way **four times in two milestones**: silently inert in every worktree, reporting clean while measuring nothing; never run with a live drag, so a 152 B/tick defect sat under a green result; scoped to two packages while the third did the most work in the frame loop; and finally **live and provably blind to the task that had just shipped** — injecting into the old code went red, injecting into the new code stayed green, and the rig that produced the report's figures had been deleted. Every task adds paths and the scope stays where it was. **Prove liveness by injecting into the NEW code specifically, never into something already covered** — a green harness plus a red injection somewhere else is not evidence about the thing you just wrote.
- **The worktree mechanism hands out stale commits, and the instruction to check is the only thing that catches it — THREE occurrences now.** Twice the worktree was at the review's *base*; the third time it was at neither base nor head, but a docs commit two behind, where the file under review does not exist. **The dispatch instruction works; the mechanism producing the worktree does not.** So: name the expected SHA in the dispatch, make verifying it the literal first step, and tell the agent to check it out itself if wrong. Do not treat "the tool gave me a worktree" as evidence about which commit is in it.
- **Verify the head you were handed.** A review dispatched against a worktree was given the **base** commit rather than the head — it noticed and checked out the right one itself, but a reviewer that trusted the handoff would have reviewed the previous task and reported confidently on the wrong code. State the expected commit in the dispatch *and* have the agent verify it before starting.
- **A regression test for an environment-dependent bug must not depend on the environment.** The inert-harness fix could easily have been "repair the path and assert it works *here*" — which would have reproduced the original defect's blind spot exactly, since *here* was the only place it ever worked. The repair that holds pins the path derivation against **synthetic roots, including a worktree-shaped one**, so the test exercises the failing layout without needing to be run in it. Ask of every regression test: does this fail on the machine where the bug did *not* reproduce?
- **The house pattern for refusal-heavy code: return a distinct outcome code, never a boolean.** The most-repeated family in this catalogue is the negative assertion satisfied by the wrong mechanism — "idle cars do not move" passing because an unrelated guard stopped them. An **eight-valued `PointerOutcome` enum** made all five of a state machine's refusals discriminating instead of "something stopped it", mechanically, with no fixture cleverness required. When a function can refuse for several reasons, make the reason part of the return value and the whole family stops being possible.
- **A measurement instrument that reports "clean" while measuring nothing is worse than no instrument.** The allocation harness resolved file paths with `lastIndexOf('/mini-motorways-clone/')` and then filtered by prefix — so in **any checkout where the repo name is not the last such segment**, it returned an empty offender list *unconditionally*. Every review on this project runs in a git worktree, so for every reviewer the harness was **inert and silently green**, and the suite was red 17/17 without that being traced to it. Three real regressions applied there — including the very 152 B/tick defect the harness had been celebrated for catching — scored **0 detectors, indistinguishable from baseline**. The one assertion that would have noticed was a scope guard the report had argued down to "non-discriminating". **A harness must fail loudly when it resolves zero targets**, and "it passes here" is a claim about one machine's directory layout until it has been run somewhere else.
- **Checking one axis of a comparison and concluding about the whole thing.** Task 7 recorded "typed array vs plain object for the drag slots" as an equivalent mutant on a real measurement — 0.000 B/call either way — and then wrote into the source that no test could distinguish them and none should be added. The measurement was right and the conclusion was wrong on a **different axis**: `Int32Array` *coerces*, so a `pointerId` at 2^31 was stored as -2147483648 and no later event could match it. The drag latched, the single-pointer rule then refused every subsequent `pointerdown`, and **input died for the rest of the session from one event**. A conforming browser cannot send that id — which is exactly why it went untested, and exactly why it had to be. **When you write "no test can distinguish these", enumerate the axes before the sentence, not after it**; and an out-of-contract input must never be able to brick the thing, however unreachable it looks.
- **A state machine that can enter a stuck state needs a recovery path, and the guard that protects it is usually the thing blocking recovery.** The same latch had no way out because the single-pointer rule refused even the *owning* pointer's next `pointerdown` — the only fix available to a player was reloading the app. The recovery is one branch: a second `pointerdown` from the id that already owns the drag cannot happen in a conforming browser, so receiving one *means the end event was lost*, and ending the stale drag is what the player is asking for anyway. **For every "refuse while busy" rule, ask what clears `busy` if its clearing event never arrives.**
- **A green harness is a claim about the inputs it was given, not about the code.** Task 6's allocation harness passed clean — and Task 6 never ran it with a live drag. Task 7 added one and the *same* harness immediately charged `inputs.ts`'s `clear()` at **152 B per tick**: `length = 0` right-trims a JS array's backing store, and the method's own comment asserted it could not allocate. **Two live violations in two tasks, both under a harness that was already green**, because a measurement instrument only measures the paths you exercise. When you inherit a passing harness, the first question is which inputs it has never seen — not whether it passes.
- **A threshold set inside the noise band is a flaky test, and it looks like a tight one.** The new allocation harness needed a per-file budget for `loop.ts`. Both the coordinator's suggested figure and the implementer's first value (16) sat *inside* the residual's own upper cluster — measured across runs as `0 0 18.03 15.95 17.86 17.86 16.12 15.60 17.51 0 0 0` — so the suite failed about **one run in twenty**. A budget of 32 gave 15/15. **Measure the distribution before setting the bound**, and prefer a threshold that is loose enough to never fire on noise and still tight enough to catch the thing you care about: here, one object per frame is ~50 B, so 32 still catches every real regression.
- **The single most expensive false belief on this project: "there is no allocation profiler in this toolchain."** It was written into the plan and repeated in every task brief across five milestones, always with the corollary *"review is its only check"* — so a hot-path invariant was enforced by asking people to read carefully. **It was never true.** `node:inspector`'s `HeapProfiler.startSampling` is a Node builtin: no dependency, nothing to install. A reviewer took the report's own challenge — reinstate an allocation inside `buildFrame` and watch every test pass — and measured it appearing by name at **111.9 / 112.3 / 111.0 B/frame** over three 30,000-frame runs, against a baseline where it never appears.
  **Two lessons, and the second is the general one.** A capability claim about the *toolchain* deserves the same scrutiny as a claim about the code, and it is more dangerous because it never gets re-examined — a wrong test claim fails eventually, a wrong tooling claim just quietly caps what you attempt. And **the longer a constraint survives on "review is its only check", the more suspicious that should make you**, not less: five clean milestones read as evidence the honour system works, when they were really evidence nobody had tried the alternative.
- **A whole battery can test one DIRECTION of a bound and never the other.** M2 Task 5's draw tests asked, thoroughly and in many forms, whether the renderer draws *too much* — outside the revealed rect, past a liveness prefix, into a dead slot. Nothing asked whether it draws *enough*. Shrinking `xEnd` or `yEnd` on two different loops left **all 178 tests green**, because every fixture's content happened to sit in the rect's top-left corner; on the real camera the same mutation drops eight board rows and wraps three columns into the next row. **The liveness work reinforced the blind spot rather than covering it, because suppressing draws is the same direction.** For any bound, write the over- and under-approximation tests as a pair, and place fixture content away from the origin so the far edge is load-bearing.

  **And that prescription is itself only half a fix — the sweep it triggered proved it.** Closing the under-iteration half left **seven more 0-detector mutants** in the over-iteration half, because both out-of-rect markers sat in **diagonal corners**. A corner is past *two* bounds at once, so extending any single bound by one cell reaches nothing and draws nothing. **A marker must sit past exactly one bound, exactly one cell past it** — assert that of the fixture, or the corner placement that feels natural silently disables the test. Two further survivors in the same sweep came from a **parity accident**: the fixture's grid top and width were both even, so two of four device-pixel snaps had no detector until a second device made all four odd. Same shape as an earlier `Math.floor` mutation that survived because every fixture happened to have an even leftover.
- **A lesson gets applied where it was learned and not carried to its sibling case.** The M2 plan corrected a symmetry mistake for the *orthogonal* masks — 17 and 68 are symmetric under both axes, so a blank tile would have passed — and then prescribed a mask list that left every permutation of the *diagonal* bits invariant. The brief "already made this exact argument for the orthogonals and did not carry it across." The same shape hit M1c twice: an implementer decomposed a compound mutation for the cap check unprompted, then left the identical compound uncovered in a predicate two functions away. **When you fix an instance, name the class and search for its siblings** — the second instance is usually one grep away and nobody looks, because the lesson feels spent.
- **A test that pins a property nothing depends on reads exactly like one that matters.** `lineJoin` is set on the atlas context, but every spoke is its own two-point subpath and a two-point subpath has no join — so the assignment is inert and its only detector is the assertion that the assignment happened. Keeping it is right (the spec mandates it, and the first multi-segment subpath would silently inherit a miter), but it must be **labelled inert**, or a future reader treats a decorative assertion as a load-bearing one.
- **A stated limit of the test harness can be wrong, and the wrongness hides exactly the defect it excuses.** M2 Task 4's atlas stub records drawing commands, not pixels, and its report listed what it therefore "cannot observe" — including *the round cap's pixel footprint*, filed as a browser property only the deploy could check. It was not: cap overflow is arithmetic derivable from the recorded endpoints plus the recorded `lineWidth`. Sitting under that excuse was a real bug — a zero-gutter atlas grid where every round cap bleeds into the neighbouring tile, so **248 of 256 tiles carried foreign ink**, a dead end rendered as a through-road and an elbow as a four-way crossing. **A "cannot observe" list is a claim about the harness that needs the same scrutiny as a claim about the code**; write it as a derivation, not an intuition, and re-derive it whenever it is used to skip something.
- **A FLAKY mutation gets recorded as a survivor.** M2 Task 4's first nondeterminism mutation agreed with the original about 50% of the time; a single run would have shown it passing, and it would have entered the table as "survived" — i.e. as a coverage hole that does not exist, or worse as evidence the behaviour is unobservable. **Mutation testing assumes the mutant is deterministic.** When a mutation touches anything order-, hash- or time-dependent, run it several times and record the agreement rate, not one outcome.
- **A copied constant needs a watcher, and the watcher may not be able to live where the copy does.** `render` keeps its own direction table because it is forbidden to import from `sim`. "Verified against `roads.ts:92-95`" was a human re-read with no test behind it, so the copy could drift silently in either direction. The fix had to live in `game`, the only package importing both. **When an architectural boundary forces duplication, ask which module is allowed to see both copies, and put the equality test there.**
- **Verify the artifact, not the command's exit message.** During M0's deploy, `wrangler deploy` printed `Success! Uploaded 2 files` while the served HTML still referenced the *previous* asset hash — the upload succeeded and the deployment never activated. A grep over the command output hid the missing "Deployed … triggers" line. The practice: fetch the live artifact and grep it for a build-unique token. **This incident shaped the practice and was never written down**, so an M2 reviewer reading the M0 findings correctly reported the anecdote as unsupported. An undocumented incident is an incident that will recur — if a lesson is worth repeating in prompts, it belongs in a file.
- **A spec sentence that has never been executed against is an assumption, not a constraint.** Spec §4 said `render` "reads sim state" *and* "depends on nothing but its own interface types". Those read as compatible and are not, the moment anything needs a *function* from `sim` rather than a byte. The pair survived four milestones unchallenged **because nothing had tried to render yet**. When a milestone is the first to exercise a spec section, review that section as untested code.
- **A bounds check can hide the defect a fixture was built to expose.** The M2 review found that unused car slots are all cell 0, and predicted 80 phantom cars stacked on the top-left tile. Wrong, and instructively so: cell 0 is *outside* the revealed rect, so the renderer's own bounds check suppresses them — and a liveness fixture placing dead slots at cell 0 therefore **passes for the wrong reason**. Dead slots must be placed *inside* the drawn region. Whenever a fixture relies on a value that another guard also rejects, the test proves the other guard works.
- **Extrapolating past a sample is not interpolating between two.** A frame position of `progress + alpha × speed` overshoots wherever the route turns — measured at ≤0.19 cells at a corner and 0.13 at the carpark — because the extrapolation continues along the *current* direction past the point the route changes it. Lerp between two resolved snapshots instead. This one was caught in a ruling, before it reached code.
- **"Derived" is a claim about the code that needs its own evidence.** `step.ts` presented its seven-phase tick order as fully derived. Running all 13 reorderings: **two of the six adjacent transpositions are 0-detector no-ops**, and phase 1's stated justification — "moving this one slot later delays every first pin by exactly one tick" — is measurably false, since it takes moving *two* slots. Harmless today and not tomorrow: `placeDestination` stamps `destSpawnTick` from `H_TICK`, so when M1e makes building placement a `TickAction`, both swaps become real off-by-ones at once with nothing to catch them. When a comment says an ordering is derived, mutate the ordering.
- **An overstated comment that DISCHARGES AN OBLIGATION is worse than one that merely decorates.** `trips.ts` claimed its parameter-free signature was "the primary defence, exactly as it is in `cars.ts`", and the report cited that to justify not running two plan-named mutations. Unlike `cars.ts`, nothing pinned it — adding a `fields` parameter and wiring `step` to pass it passed all 520 tests. A decorative overstatement is cheap; one used as grounds for skipping a test silently *removes* coverage rather than failing to add it. **When you cite a structural defence as a reason not to mutate something, pin the structure first.**
- **A mutation that does not compile or does not load is NOT a caught mutation — and its crash count reads exactly like a kill count.** Task 5's report recorded both halves of a phase filter as "killed by 17 tests". The 17 was a `ReferenceError: PHASE_NONE is not defined` count: `cars.ts` imports only `PHASE_OUTBOUND` and `PHASE_RETURNING`, so the mutant never ran and the suite went red on module load. Applied validly, each half is killed by **1** test — claimed coverage was inflated 17×. This is mutation testing's own failure mode, and it is invisible unless you look at *why* the suite is red. **Before recording a kill, confirm the mutant executed:** the failures must be assertion failures naming the behaviour, not `ReferenceError`, `TypeError`, or a module-load error. Referencing a symbol the module does not import is the most common way to produce one. **The same artifact inverted a survivor into a kill — and that survivor was exactly the coverage hole the review later found.** A fake kill does not merely inflate a number; it conceals the gap it is standing on.

  The cheap heuristic, from the implementer who wrote the bad evidence: **an implausible detector count is a crash signature.** Seventeen tests failing for a change that only affects idle cars should have been read as "this did not run", not as strong coverage. Sanity-check the detector *set* against what the mutation can actually reach, not just its size.
- **A negative assertion is only meaningful if the fixture disables every OTHER mechanism that produces the same observation.** "A car in `PHASE_IDLE` does not move" was satisfied exactly — by cars whose `cursor = 0`, so the *exhaustion* guard stopped them and the phase filter was never exercised. Deleting the phase filter left all 582 tests green. You had tested that something stopped the car, not that the guard did. **This is the most mechanical instance of the family to check for:** for every "X does not happen" bullet, list what else could prevent X, and build the fixture so only the guard under test can. Six instances of this family on M1c alone.
- **A stated fixture condition can be met exactly and still be too weak.** 4a's brief required "at least one same-colour pair with `carparkCell(d1) > carparkCell(d2)`" to pin the ascending insertion. The fixture met it exactly — and a *pair* cannot separate a full shift from a one-element shift, so replacing the shift loop with a single-element shift survived all 51 tests, on a mutation that produces a hard throw during ordinary play. When a rule is about a *span*, the fixture needs a span, not an instance. Ask what the smallest input is that the rule's failure mode needs, not what the brief happened to name.
- **A fixture can satisfy every stated condition of a requirement and still defeat its purpose.** The overflow fixture met fix-list #19 exactly — ≥ 3 same-colour destinations, the capped one off index 0, the cursor off 0 — and then capped two of the three, leaving one destination with room. Every possible walk order reaches the same recipient, so `d = step % destCount`, the precise mutation the requirement exists to kill, passed all 381 tests. **Stated conditions are necessary, not sufficient.** The question is never "does my fixture meet the spec" but "can my fixture tell the right answer from the wrong one" — for a search-order rule, that means two valid candidates must remain reachable so the orders actually differ.
- **A confident wrong reason for why something cannot be tested is worse than an admitted unknown**, because it ends the search. A gap was reported as needing an allocation profiler the repo does not have; the real observable difference was which table the code consulted, and the test took twenty lines using a parameter already exposed. Interrogate your own "untestable" before writing it down.

  **And the same excuse, in its literal form, went unchallenged for five milestones.** Every brief from M0 to M2 said "nothing allocates inside the frame loop; this rule has no automated enforcement, review is its only check", and the M2 plan's Global Constraints said outright *"There is no allocation profiler and this plan does not pretend otherwise."* **`node:inspector`'s `HeapProfiler.startSampling` is a Node builtin** — no dependency, nothing to install — and with `includeObjectsCollectedByMinorGC` it counts transient allocation rather than only survivors. The harness is ~40 lines and runs in the normal suite. It found, on its first run, a violation that had shipped invisibly: a mutable double captured in a closure boxes a fresh `HeapNumber` on **every assignment**, so the frame loop's own accumulator variables allocated ~65 B/frame — *more than one object per frame*, against a rule stated as "zero, not small". **A phrase repeated in every brief is not evidence; it is the least-examined sentence in the document.**

- **A harness's SCOPE deserves the same scrutiny as its instrument.** The allocation harness above was built, verified with a positive control, and immediately caught a 65 B/frame violation — and it profiled the loop with an **idle input queue**, so `inputs.ts`'s `clear()` never had anything to clear and `pointer.ts` did not exist yet. Task 7 pointed the same harness at a live drag and it reported **64.30 B/frame on the first run**: `actions.length = 0` right-trims the array's elements backing store, so the next `push` re-grows it from zero and allocates a fresh 17-element `FixedArray` — 17 × 8 + 16 = **152 bytes per clear**, matched to the byte by measurement. A pop loop measures 0.00. **The instrument was sound and the sample was not.** When a guard is written, write down what it does *not* execute; "the harness is green" is a claim about the inputs it was given.

  **And the repair has its own lesson, learned the hard way one review later: a guard that can only fail in one environment is the same defect wearing a different coat.** The path bug above was caught by running the harness in a worktree. The *fix* is pinned by a separate test that feeds the path helper **synthetic** roots — plain, worktree-shaped, renamed — and asserts the old arithmetic's exact wrong answer. That test fails identically in CI, in a worktree, and in the main checkout, which the original defect's only detector did not. **When you fix an environment-dependent bug, the regression test must not inherit the dependence.**

  And the same finding is a second instance of the confident-wrong-reason shape, in its most expensive form: `inputs.ts`'s comment said *"the one allocation this module cannot avoid is inside the JS engine … there is no allocation-free array shape with a `.length` `step` can iterate"*. Three lines of measurement refuted it. **A module comment that says "unavoidable" is a hypothesis with no test behind it.**
- **A sampling profiler cannot have a budget of exactly 0, and setting one is the noise-band mistake wearing the opposite disguise.** At 512 B/sample over 3,000 frames the smallest reportable non-zero figure is **0.17 B/frame** — one sample, the signature of a *one-off* allocation (a feedback vector, an IC transition, a deopt), not a per-frame one. A budget of 0 therefore fails on a single stray sample, measured at one run in ten. The fix is a **floor measured before it is chosen**: across 40 runs the worst stray was 1.94 B/frame, a single escaping object per frame costs 37–77, and the floor sits at 4 — 2× above the noise and 9× below the signal, with the gap between them empty. "Tighter is safer" is false for a statistical instrument; *outside the band in the right direction* is the property to want.
- **A test that reads the JIT's attribution is a test that another test can turn red.** The allocation harness's positive control searched the profile for the allocator named `draw`. Adding an unrelated second profiled run to the same file gave TurboFan enough feedback to inline `draw` into its caller, and the control went red **without anyone touching it** — it had been reporting the inliner's choices, not the allocation. The file's own module comment already said function-level attribution was unstable and file-level was not; the control had not been written to that rule. Rewritten as a **delta between two profiles of the same rig**, summed over both files the residual can land in so the bimodality cancels rather than being inherited. **When a harness documents its own unstable axis, grep for the assertions that still depend on it** — the lesson-not-carried-to-its-sibling shape, applied to a harness instead of to production code.
- **A non-square fixture is not enough — the parameter may be invisible for the specific ENUM VALUES the fixture uses.** `carparkCell(cell, orientation, w, h)` reduces to `cell + dy·w + dx`, so for **E** it is `cell + 3` and for **W** it is `cell − 1`: `w` vanishes entirely. Task 2's seed is oriented W, W, E, so swapping `world.w` for `world.h` at the call site survived all 156 tests — on a **24×40** board, with the plan's own "the fixture must be non-square" vacuity rule followed to the letter. The sibling test could not help either: it called `carparkCell(..., world.w, world.h)` itself, so it reimplemented the thing it checked and agreed with the mutant. **Ask which *arguments* the fixture's values actually reach, not just whether the dimensions differ** — and when a function branches on an enum, cover the branches that read the parameter you are trying to pin (here N and S, and both, since N is `cell − w` and S is `cell + 3w`).

- **A driver that never enters a branch makes that branch indistinguishable from dead code, and the counters will not say so.** M2 Task 7's allocation rig drove `pointerdown`/`move`/`up` on the board and nothing else; the HUD, `pointercancel`, pause, the second-pointer refusal and the off-grid path were never entered. All measured clean — *while being unreachable from the driver*. Same shape as the harness that resolved zero files and reported "clean", one level up: the instrument worked and its **inputs** excluded the thing it was watching. The fix is **one counter per branch the driver claims to enter, and an assertion on each**, so deleting a branch turns the harness red instead of leaving it measuring less. And where two paths are behaviourally identical (`up` and `cancel`), **alternate between them** rather than driving one — otherwise the untaken one is an untested equivalence dressed as coverage.

- **A sampling profiler's figures are a verdict, not a quantity, and which of your two instruments is which is worth measuring rather than assuming.** The same report presented single draws — 109.20 and 119.00 B/frame — as measurements; a re-run gave 50.60. Repeated draws put the clean-window per-frame figure at **46.6–119.0, a 2.6× spread**, while the completion bound — a **minimum over three windows**, adopted one task earlier for exactly this reason — held to **0.5 %** across draws. Both were 1–3 orders of magnitude above their budgets in every draw, so the RED/GREEN verdict was never in doubt and the liveness proof stood. But the absolute numbers had been written into a report that the next task would have read as a baseline. **Report a bimodal instrument's output as a verdict or as a range over stated draws, never as a point** — and note that this is the noise-band and minimum-over-windows entries above paying off: the design that made one of the two instruments quotable was already in the file, and the report quoted the other one.

- **A mutation that ADDS a call where the original still stands is not the mutation you named.** Checking that `initCarSnapshots` must run *after* the warm start, the mutant inserted a second call before the loop and left the original in place. The later call overwrites the earlier one, so the mutant is a provable no-op and reported 0 detectors — indistinguishable in the output from the coverage hole it was looking for. Re-applied as a genuine **move** (delete, then insert) it died to exactly one test, the one written for it. Same family as the mutant anchored on a comment: **the unit of evidence is "the mutant changed behaviour", and an over-broad or under-broad edit fails that test in opposite directions.** When the rule is about ORDER, the mutation must be a permutation, not an insertion.
- **A SYMMETRIC fixture cannot see a direction reversal.** A queue probe reverses the return leg's travel direction; the obvious fixture — two returning cars on adjacent cells — gives a chain of 2 whichever way the relation points, because the mutation only swaps which car is behind which. Three separate two-element fixtures (return direction, exhausted-route guard, off-grid bounds) all scored 0 for the same reason, and all three needed a THIRD element placed asymmetrically before the mutant produced a different number. The generalisation is sharper than "the fixture was too small": **for a rule about an ORIENTED relation, the fixture must be one whose reverse is not also a valid instance.**
- **Queueing theory badly under-predicts a discrete blocking simulation, and building a layout from the estimate produced total gridlock.** A demo board was designed from `rho = pinRate x ticksPerCell` per lane, computed at 0.65 with a predicted "standing queue of 1-3 cars, excursions to 5". Measured, the same board delivered **47 trips in 20,000 ticks** with 22 refusals per tick and 214 anti-deadlock-valve firings — 28x below free flow, ground forward only by the valve. Two reasons the model cannot see: outbound and return traverse the SAME cells (a return leg is the committed route reversed), so a corridor's two lanes are not two independent servers; and there is no "do not block the box" rule, so a car standing in a junction waiting to turn holds a lane a perpendicular flow needs. **The failure is a spinlock, not a queue, and utilisation says nothing about it.** What fixed it was topology — three independent corridors instead of one shared trunk, same car count, same demand: 1,324 trips and zero valve firings. **Measure the operating point before writing the layout down; the load knee was between 12 and 16 cars and no arithmetic in the design predicted it.**
- **An instrument that REBUILDS a key the system already stores will rebuild it wrong, and its readers are too loose to notice.** The queue probe kept its own `Map<cell, car>` in a milestone whose premise is that a cell carries **two lanes**: it discarded the second car and linked followers to whichever was written last, sometimes to a car going the opposite way. It disagreed with `canEnter` — the function whose refusal a queue actually is — on **5.7-15.2 %** of the questions it asked, and both over- and under-reported (a discarded car breaks a real chain as easily as it invents a false one). Two things generalise. **Read the array the system writes, do not reconstruct it**: `occupantOf(next, LANE_OF_DIR[dir])` needs no derivation, and it gets turns, the outbound->return flip, the not-yet-crossed case and valve displacement right for free, where the plausible repair — keying by the car's own direction of TRAVEL — is still wrong on 5.9-10.0 % because **a car occupies the lane it ENTERED by, not the one it now faces**. And **test an instrument against the production oracle as a property, not against hand-built numbers**: "for every in-flight car on every tick, the probe's answer equals `canEnter`'s" is one assertion, ran 90,533 times over three fixtures, and it kills the whole defect class. The hand-built cases could not: every reader of the probe was an inequality (`longestQueue >= 4`) loose enough to survive a wrong answer, which is why three separate mutations of it had scored **0 detectors**.
- **A `toContain` over a composed message is satisfied by any other part of that message.** A boot-failure panel prints the failure, the bad token and the list of valid layout ids; the test asserted `text.toContain(id)` for each id and `toContain('demoo')` for the token. **Both scored 0 detectors on deleting the lines that produce them**, because the thrown error's own text already ends "the layouts that exist are city, demo" and already quotes the token — and a third assertion was propped up by the word "city" appearing in an unrelated sentence of the panel's own prose. The repair is to assert the **whole line** (`Layouts that exist: city, demo`) and to isolate the per-item form on a fixture whose other text cannot supply it. Same family as "a negative assertion satisfied by the wrong mechanism", pointed at string composition: **when a message is assembled from several sources, a substring assertion does not say which source produced it.**
- **A test runner can silently mint build artefacts, and this one had been blamed on a person for a milestone.** `verify-deploy.js` reads `.build-id` as "the id that should be live", and a stale-ahead file makes a healthy deploy report *"the deployment did not activate"*. The recorded cause was somebody running `pnpm build` without deploying. The real one: **vitest loads `vite.config.ts` as its own config**, so the build-id plugin was instantiated on every `vitest run` and Rollup's `closeBundle` wrote a fresh id at the end of the test run — including the run you do immediately before deploying. One diff of the file across a single-file test run finds it; `apply: 'build'` fixes it. **When a tool writes a file as a side effect, check which commands actually load it** — a config file is executed by every tool that discovers it, not only by the one it was written for.
- **A flaky test inflates a mutation kill count exactly as a crashing mutant does.** Two mutants in this round were reported as killed partly by `drawAllocation.test.ts`, which does not import the mutated module at all; the sampling allocation harness simply flakes at roughly one run in ten. The crash screen does not catch this — the failure is a genuine assertion failure, in a real test, that has nothing to do with the mutant. **Check that each killing test can actually reach the code you changed**, and re-run before recording a kill from a file with no path to it.


### One thing that went right, worth repeating

**When a module's job is to refuse things, put the refusal REASON in its return type.** The catalogue's most-repeated family — "a negative assertion is only meaningful if the fixture disables every OTHER mechanism that produces the same observation", six instances on M1c alone — is normally fixed by fixture surgery, which does not scale and rots as branches are added. M2 Task 7 made the reason part of the signature instead: `PointerOutcome` has eight non-zero codes, five of which exist so a negative assertion can name *which* guard fired. `queue.length === 0` is satisfied by a tap that missed, a paused game, a second pointer, an ended drag, an off-grid sample and a repeated cell — six causes, one observable — and the enum separates all six at no runtime cost. Two codes are consumed by production, so it is not test-only scaffolding. **Rule of thumb: if a function has more than two ways to decline, the reason belongs in the signature, not in a comment.** It converts "something stopped it" into "this guard stopped it" for every test at once.

An implementer inferred that destination-vs-destination overlap is *subsumed* by the Chebyshev spacing rule rather than needing its own check, stated the inference plainly, and flagged it. The reviewer checked all 4×4 orientation pairings and it held. Stating a load-bearing inference so someone can check it costs a sentence; the recurring failure is the same inference left silent. Cheap insurance, not distrust.

## A handoff document can be complete in structure and still drop items

M1d's final review enumerated eight items to carry into M1e. The carry-forward
written from it had **eleven well-organised sections and 336 lines** — and two of
the eight were absent. Not skimped: absent. The document read as thorough from
every angle except the only one that mattered, whether each named item was in it.

Both survivors were the ones with no code artefact to anchor them. The nine that
landed each had a file, a constant or a golden to hang off. The two that vanished
were *"routing and movement now disagree"* — a property of the gap **between** two
components, owned by neither — and *"no human has seen the ghost art"*, which is
an absence of evidence rather than a fact about code. **A handoff item with no
home in the source is the one that evaporates**, and those are disproportionately
the cross-cutting ones worth carrying.

Checking cost one grep per item against the list. Do that before believing a
handoff, and prefer a checklist of names over a reading of the prose: this
document passed a reading.

Related: [a signal that looks complete because the count is present]. Same shape
one level up — there, a count without its items; here, a structure without them.

## "Tested" and "looked at" are different claims, and only one has a test

M1d shipped ghost-road rendering with 182 assertions across three render test
files. Genuinely well covered — and **no human being has ever seen it.** The last
device check was the close of M2, before ghosts existed.

Inside those 182 assertions sit two pure aesthetic judgements: the ghost stroke is
half the live road's width, and spec §6's 55-65 % width band was **deliberately
ruled not to apply**, on the reasoning that the band governs roads and a ghost is
the absence of one. The reasoning is sound. It is also the kind of call that can
be perfectly self-consistent and still look like a rendering glitch on a phone,
and **every assertion in the suite would stay green either way** — the tests pin
that the code draws what it intended, never that the intention was right.

When a milestone adds anything visual, the coverage number is not the relevant
number. Ask when a person last looked, and if the answer predates the feature,
say so in the same sentence as the coverage. On this project the honest form is
"182 assertions, zero human minutes."

## A milestone can pass every gate it has and still change nothing a player can see

M1d shipped correct, tested (1,487 tests), reviewed at 0 Critical, and deployed with the artefact
verified byte-for-byte against the local build. Then the user opened it and said it looked like the
same demo. **They were right.** Instrumenting `canEnter` at its only call site, on the exact
production boot, over 200,000 ticks — 1 h 51 m of play — gives `REFUSED_OCCUPIED = 0`,
`ENTER_VALVE = 0`, ticks with a blocked car `= 0`. Not rare. **Never.** The milestone's headline
feature cannot fire on the board that ships.

The cause is arithmetic, not code: `PIN_PERIOD_TICKS = 518` with two slots per colour is one pin per
colour per 259 ticks, against a ~60-tick round trip. **Service is 4.3x faster than arrival**, so a
second car of a colour is never wanted, and the population is frozen at 6 by construction —
`placeHouse` has one caller, before tick 1, and no shipped control can add a car.

**The number that explains this was in the plan before Task 1 was written**, and in the plan review:
*"maxActive = 1 … six cars and no spawner."* Both filed it under **"What this plan does not settle"**
— an epistemic footnote — rather than treating it as a scope decision. And every observability
criterion M1d had was machine-side: assert a jam *on a purpose-built bottleneck fixture*, assert
per-branch counters non-zero *on that same fixture*, grep the served bundle for a build token.
**All three are satisfiable by a build no human can distinguish from the previous one.** All three
passed.

M2 did not have this hole — its plan opens with *"draw a road with your finger, watch a car take it,
see the score tick"* and treats an invisible playfield edge as an input defect rather than a styling
one. **The observability lens existed one milestone earlier and was dropped.**

So: every milestone that changes behaviour needs one acceptance criterion phrased as *what a human
will see, on the board that ships, without being told where to look.* If the honest answer is
"nothing", that is a legitimate milestone — but it must be **said out loud at plan time**, not
discovered by the user. A test fixture built to exhibit a feature proves the feature exists; it
proves nothing about whether the shipped configuration can reach it.

Related: [tested and looked-at are different claims]. That entry is this one at feature scale; this
is the milestone-scale version, and it is worse, because here the tests were not merely silent about
the player — they were passing *on inputs the player cannot produce*.

# The M1e entries — and the vintage of every figure in them

Everything below this line is M1e. **All of it was re-derived against the tree at commit `14e7dee` in
M1e's closing sweep**, which is the same sweep that produced the corrections in the *durable artefact*
entry further down. The classification, because "re-derived" is worth nothing without it:

- **Anchored at HEAD** — pinned by a green assertion or a named constant, so it cannot rot silently.
  The load-bearing ones: `[1,1,1,6,6]` and its four siblings; `1 → 2 → 5 → 10`; `maxInFlight >= 6`;
  `11` peak cars; `5,580` and `8,661`; `62 tiles of 210` (measured again in the sweep, and note that
  the M1f handoff carried `41–57 of 390` for the same quantity — **this file had it right and the
  handoff did not**); week `18` and the `167`/`172` clauses; `6,459`; `21` return statements against
  `grep -c`; `20.83`, budget `8`, `1.34`; `36`; `20,000`.
- **History, and correct as history** — figures describing a state of the tree that a later task
  deliberately changed. These must NOT be "corrected" to today's numbers; the entry is about the
  incident. They are marked in place where a reader could mistake them for current, the sharpest being
  the spawner-growth entry, whose `22 / 10 / 184 / exactly one` is the PRE-fix rig.
- **Unreproducible on this tree** — figures whose rig no longer exists, chiefly the rejected
  proximity lever (not implemented, so nothing can assert it) and several one-off allocation
  injections (`8 events per 3,000-frame window`, `0/1056/0`, `6/6 at 30–66 B/event`, `4.29–6.61`,
  `23 %`). They are left as written, because an entry's job here is to carry the *shape*, and marked
  where the number rather than the shape is being leaned on.

**The one rule this classification is for:** an entry in this file gets quoted into a brief, and a
number quoted out of a narrative arrives looking like a measurement of the current tree. Two of the
sixteen defects the closing sweep fixed entered the world exactly that way. If you are about to move a
figure from here into a plan, check which of the three kinds it is first.

## A mutation harness's restore step is untested code, and it can eat the work it was testing

M1e Task 1's implementer ran a mutation battery whose cleanup was `git checkout -- packages`. That is
correct only when the work is committed. In the fix round it was not, and one mutant's cleanup
**silently discarded all four uncommitted fixes.** It surfaced two mutants later, as
`TypeError: m1eRangesFromLayout is not a function` — i.e. as a confusing failure in an unrelated
place, not as "your work is gone."

The second implementation was wrong in a different way: `rm -rf packages` deletes pnpm's per-package
`node_modules` symlinks, so every subsequent run failed to resolve `@laneways/shared` and needed a
full `pnpm install` to recover. **Two restore implementations, two distinct silent failures.**

The harness is the instrument. When the instrument's own cleanup is broken, every measurement after
the breakage is against a tree you did not intend, and the symptom appears somewhere else entirely.
So: **commit before the battery, always, regardless of whether you think you need to** — a commit is
the only restore point that cannot be eaten by the thing doing the restoring. And make the harness
**print the tree state it restored to** after each mutant, so a bad restore is visible on the run
that caused it rather than two runs later.

Related: [my own probes were the broken thing repeatedly]. This is that entry's harness-level twin —
there the injected mutation was inert; here the mutation was fine and the cleanup was the defect.

## "Run twice, identical" is the expected outcome of a one-in-ten flake, not evidence against it

Task 1's report offered *"run twice, identical"* as evidence the suite is stable. The reviewer made
~25 canonical whole-suite runs across both rounds and saw the allocation harnesses fire spuriously
twice — once inflating a mutation row from 10 detectors to 11.

At a 1-in-10 flake rate, two clean runs in a row happen 81% of the time. **The observation is almost
perfectly uninformative and reads as reassurance.** If a flake matters to a claim, either run enough
times to bound it or state the known rate beside the result; do not offer a small number of clean
runs as stability.

## A correction can repeat the exact error it is correcting

M1e Task 2 found a wrong claim in `demoCity.ts` — that changing `firstCity` moves five goldens — and
corrected it to two, reporting that it had "checked against the source before writing it down."
The reviewer measured it by actually changing `firstCity`'s `startingTiles` from 30 to 31: **one**
golden moves, not two. The demo golden is `hashState` over a state built on `demoCity()`, which
`firstCity` cannot reach; the implementer had conflated *"`demoLayout.test.ts` also asserts the seed
golden"* with *"the demo golden moves."*

So a claim about blast radius, made without running the change, was replaced by another claim about
blast radius made without running the change — **the same defect one iteration later, now wearing the
authority of a correction.** A corrected figure reads as verified in a way the original never did.

The rule that would have caught both: **a blast-radius claim is a measurement, not a reading.** To
say "changing X moves goldens {A, B}", change X and run the suite. Tracing imports tells you what
*could* be reachable; it does not tell you which fixture a golden's state was actually built on.

Related: [I relayed a finding that was wrong], and [a handoff document can be complete in structure
and still drop items]. The common thread is that secondhand claims about code acquire confidence at
each hop while acquiring no evidence.

### Sharpening, from hitting it a third time

M1e Task 2's implementer hit the restore defect **while proving a fix had teeth**, and its two
corrections to the entry above are the useful part:

**"Commit before the battery" is too narrow.** It reads as advice about mutation *batteries*. The
failure has nothing to do with scale — a **one-line teeth-check probe** has the same cleanup step and
the same failure mode. The rule is: before any edit you intend to revert, commit; the size of the
experiment is irrelevant.

**A deleted guard is invisible in the test count.** M1d's version of this ate eleven tests and the
collection count moved, which is what surfaced it. Here the restore took a widened guard and a
rewritten tripwire that live *inside an existing `it`* — so **the suite stayed green at exactly 1,643
and the count was unchanged.** Nothing about the run looked wrong. It was caught only because the
file was missing from `git status` during a pre-commit sweep.

So the check that actually works is not "did the count hold" but: **diff your expected file list
against `git status` before quoting a green suite.** A test count detects deleted tests; it cannot
detect deleted assertions inside surviving tests, and a restore step deletes whatever it reverts.

## A harness's liveness check can be kept alive by the very defect it is measuring

`allocation.test.ts` called `assertScopeResolves(all, SIM_SRC)` at four frame-rig sites — the guard
that proves the profiler's scope is not blind. Every one of those four was satisfied **by the
flow-field allocation itself**. When M1e Task 3 removed that allocation, the guard **failed 4 runs in
5 — because the code got better.**

That is the worst possible polarity for a liveness check: it is green exactly while a defect exists
and goes red when the defect is fixed, so its signal is inverted relative to what anyone reads it as.
Worse, the natural response to "my fix turned the harness red" is to assume the fix is wrong.

The shape generalises past allocation. **Any check of the form "the instrument can see something
here" must be satisfied by something that will still be there after the work succeeds.** A liveness
guard anchored to the subject under repair is a guard with an expiry date nobody wrote down.

The fix used here was to repoint the guard at a scope that is structurally always populated — which
the file's own tick-rig control had already concluded independently, meaning the right answer was
sitting in the same file.

## Bytes-per-frame cannot see gated work — and changing the DENOMINATOR does not fix it

Task 2's reviewer found the allocation harness **structurally cannot see week-gated work**: an
escaping object inside a boundary-gated branch leaves the suite green, because a handful of events
across thousands of driven frames lands under the 4 B/frame floor *by construction*.

Task 3 proposed dividing by the **event count** instead, using `scratch.counters`. I wrote that up
here as closed. **It is wrong, and Task 3's reviewer measured it wrong:** injecting an escaping
object at 8 events per 3,000-frame window, at the shipped 512 B sampling interval, gives windows
`0 / 1056 / 0` and `528 / 0 / 0` — **min-over-windows 0 on 2 of 2 runs.** Invisible per frame *and*
per event.

**The arithmetic says why: dividing by the event count divides the signal and the stray-sample noise
by the same denominator, so the signal-to-noise ratio is unchanged. It is a change of units.** What
made the flow field measurable was never the denominator — it was that the event fires **381 times
per window**, which is enough draws to be sampled at all.

The real variable is **the sampling interval against the event's total bytes.** Measured: drop
`samplingInterval` from 512 to 32 or 64 and the same 8-event injection appears in **6/6 windows at
30-66 B/event**, against a true ~40 B/event.

So for gated work the per-event budget is necessary but not sufficient. The missing condition is
**a sampling interval sized to the gated event's total bytes, or enough events per window to be
sampled.** Without it, a per-event budget on a rare event is a guaranteed pass that reads as rigour —
this document's own worst-named defect, an instrument that reports clean while measuring nothing.

**The same trap exists one file over, in the opposite direction — and it is worse than first
measured.** The guard that replaced the flow-field allowance is a per-*frame* budget on a
**0.127-calls/frame** event. Sensitivity to the smallest realistic regression — one escaping object
per rebuild — was first reported as 4.29-6.61 B/frame against a 4 B floor, i.e. 1.07-1.65x, and
characterised as "flakes red-then-green". Re-measured over **eight draws** taking the same
minimum-over-three-windows the arm actually uses: `4.96 / 4.79 / 2.67 / 4.44 / 3.37 / 4.61 / 4.44 /
4.61`. **Two of the eight are below the floor: it is not a flaky red, it is a 25% false NEGATIVE**,
and the six it catches it catches by 1.11-1.24x. A per-**call** rate off the rebuild counter fires
8 of 8 on the same draws, at `39.06 / 37.69 / 20.83 / 34.96 / 26.35 / 36.33 / 34.96 / 36.33`, against
a clean 0.00 on 18 of 18 windows.

Note the second-order lesson, because it repeats this entry's own mistake at one tenth the scale: the
per-call separation was *estimated* at "36-52 B/call in every window", and a 20 B/call budget was
proposed from it. The measured minimum is **20.83** — the proposed budget would have cleared the
weakest real signal by 4%, reproducing the flake-red disease it was introduced to cure. The shipped
budget is **8**, chosen from the measured band (6x above a single stray at 512/381 = 1.34 B/call, 2.6x
below the weakest signal). **Even when the diagnosis is right and the prescription is right, the
NUMBER still has to be measured rather than sketched.**

**Why this entry was rewritten rather than deleted: I relayed a proposal into this document as a
closed finding without measuring it.** Third time in one milestone that a claim gained confidence at
each hop while gaining no evidence — see [a correction can repeat the exact error it is correcting].
**A proposed fix is not a closed finding until someone has run the failing case and watched it fail.**

## Coverage keyed to outcomes cannot pin statements, and the editor edits statements

M1e Task 4 replaced allocating loops with frozen singletons and wrote in the source: *"Reverting any
one `return` below to a literal turns exactly one identity assertion red."* Its case list enumerated
the **15 distinct outcomes**. The file has **21 `return` statements** — several outcomes are returned
from more than one place. Sweeping all 21 individually, **six were pinned by nothing**, and every one
was a carpark line.

**The unit of coverage has to match the unit of edit.** Nobody reverts an outcome; they revert a
line. Two `return B_TERRAIN` statements are one outcome and two editable sites, and a case list keyed
on the outcome pins whichever site the fixture happens to reach.

Worse, the same task had already **named this class and closed it for a different property** —
§6.3 found the carpark lines untested for *behaviour* and fixed them, in a commit whose own message
invokes "name the class and search for its siblings," then left the same five lines unpinned for
*allocation*, because the new sweep asserts with `toEqual`, which cannot see object identity. **One
class, two properties, fixed for one.** Finding a class is not the same as enumerating what it
applies to.

The durable fix used here is worth copying: assert the case count against `grep -c 'return B_'`, with
the grep command written into the comment, so adding a 22nd return site fails rather than silently
widening the gap.

## A margin that holds at exact equality is not a margin

The same task pinned its allocation budget with `expect(BUDGET * 20).toBeLessThanOrEqual(40.0)` —
true at **exact equality**, because both sides were literally the same number carried from the same
measurement. It reads as a 20× safety factor and encodes none: any drift in either direction breaks
it, and no drift in the wrong direction is caught.

Re-measured against the statistic the budget is actually compared against, the real margin was
**14.8×** — still ample, but the derivation was optimistic and the next task was going to copy it.

Two rules. **Assert a margin with a strict inequality against an independently measured bound**, so
the assertion can distinguish the two quantities. And **check whether your safety factor is a
measurement or a restatement** — if the number on the right came out of the same run as the number on
the left, it is the latter.

## A durable artefact that states the opposite of the measurement is the milestone's dominant defect

By Task 5, M1e's per-task reviews had found almost no wrong code. What they kept finding was **wrong
prose in places where prose is the mechanism**: a tripwire comment naming the wrong phases after a
renumber, a source comment promising coverage the sweep did not have, a commit message claiming a
transposition had detectors when the same task's own report said SURVIVES.

The commit-message case is the sharpest, because of *how* it happened. The brief's template sentence
was vague — "two more positions that now have detectors." The implementer **measured the truth,
found only one of the two had a detector, renamed a test to say so, wrote SURVIVES in its report —
and then sharpened the vague sentence into a specific false claim in the commit message.** Precision
was added after the evidence and pointed away from it.

`git log` is the artefact a future task reads when deciding whether a phase order is safe to change.
A comment can be corrected in place; a commit message can only be corrected by another commit that
someone has to find.

The rule: **when a task's report and its commit message disagree, the report is usually right and the
commit message is what ships.** Check the durable artefacts against the measurements last, deliberately,
as a step — not as a side effect of writing them.

### It was never brought under control, and the closing sweep says why

M1e's whole-milestone review found **sixteen** further instances of this family, in the three artefact
classes that cannot be corrected in place or that everything downstream reads: the final commit, the
handoff, and this file. The sweep that closed them measured every one first, and three things
generalise past the list.

**The mechanism is not carelessness, it is DECAY, and no per-task review can see it.** A per-task
review checks a figure against its own task's measurement, where it is correct. What makes it wrong is
the tree moving two tasks later. `allocation.test.ts`'s "tick 3,833" was right for the drive index
before someone joined it to an `H_TICK`; "41–57 tiles against 390 granted" was right for a twelve-week
run before Task 8's freeze made the run six weeks long; "all four rings" was right for a board before
Task 5's spawner added a fifth. **Every one of them passed the review that shipped it.** The only
instrument that finds this class is a sweep at the end, against the tree, with the rig written down
beside each number — and the sweep must record what it could NOT reproduce, or the unchecked figures
become indistinguishable from the confirmed ones on the next reading.

**The correction is where the danger concentrates, and this milestone produced four wrong ones.** A
corrected figure reads as verified in a way the original never did — that is already an entry above,
and here is its sharpest instance: `6,357` was correctly retired by `da63dc2` and **re-entered the tree
three commits later in a NEW comment**, carrying the pre-spawner derivation, eight lines above that
comment's own note that the spawner is live. Nothing was wrong with the correction. What was missing is
that it left **no artefact**: the right number lived in prose in two files and the wrong one was free to
be re-derived from first principles by anyone who did not know the spawner had landed. **A figure that
nothing runs is a figure that comes back.** So the repair was not to edit the number a second time but
to assert **both** arms — 2,941/6,330 live and 2,968/6,357 parked — in one test on one rig, which also
made true a sentence that had claimed the parked arm was "reproduced exactly here" while no test in that
file parked anything.

**And a review of a stale figure can be stale in the other direction — this is the one to be careful
of.** The sweep's most load-bearing item was a review finding that a boot-time `loop.end()` was
*"justified by a dead argument"*, because the absolute its comment rested on — *"pointer refuses board
input while paused and by nothing else"* — is measurably false since a later task put a `gameOver` arm
in front of it. The absolute **is** false, at four sites, and the review found it correctly. The
*inference* is wrong: `gameOver` reads the very flag `end()` alone sets, so that one line arms **both**
refusals. Deleting it and booting a terminal-at-boot rig put **two road actions into the queue on a dead
board**, with no restart offered, which is worse than the failure the comment described. **A premise can
rot while its conclusion holds.** "The stated reason is stale, therefore the mechanism is dead" is the
specific error to watch for when sweeping this class, because unlike the rest of the family it deletes
working code rather than merely mis-describing it. Measure the mechanism, not the sentence.

## Six ways a number goes wrong in prose while every test stays green

The sixteen instances the closing sweep worked through were not sixteen careless typings. They fall
into six mechanisms, and only the first is the one people look for. **Each is listed with the shipped
instance, because the abstract form is unrecognisable without it.**

1. **A stale count.** The figure was right and the tree grew. *"All four rings"* on a board that ends
   with five; `"the whole 1,693-test suite"` on a suite of 1,843. Cheap to find, cheap to fix, and the
   only one of the six that a careful reader can suspect from the text alone.
2. **A unit change inside one sentence, hidden by an off-by-one that cancels.** *"Reaches the trigger
   cap at tick 3,833, and 3,390 ticks later — tick 7,223."* 3,833 is a drive index, 7,223 is an
   `H_TICK`, the rig's setup step is the one-tick offset between them, and joining them with an
   inclusive-vs-exclusive gap made the arithmetic come out. **Both numbers were individually
   defensible and the sentence was still wrong.** When two quantities in one sentence come from
   different counters, say which counter each is.
3. **Two quantities under one column heading.** A table read `city 0 refusals / demo 7,544 refusals /
   city-greedy 0 refusals`. The demo figure is `canEnter` refusals; the greedy figure is
   `H_ROUTES_REFUSED`. The greedy arm's entry refusals are **2,120**, not 0. Nothing ever looked wrong
   because the third row is zero on both counters, so the ambiguity was invisible on exactly the row
   that would have exposed it.
4. **A ratio compared against an excess.** *"31,456 against 5,580 — 4.6x, not 1.077x."* 1.077 is
   `best / control`; 4.6 is `best / control − 1`. The ratio is 5.64. **The comparison is the entire
   content of the sentence and the two halves were different quantities.** Both sides are now asserted
   as ratios, which is the only fix that holds.
5. **A figure borrowed from the sibling fixture.** *"On the no-input default the ring first appears at
   1:56."* 1:56 is the **demo** board's first ring (tick 3,492); the city's is tick 2,369, which is
   1:19. Same repo, same paragraph shape, adjacent measurement — and a plausible number from the wrong
   board is far harder to notice than an implausible one.
6. **A comment quoting an enumeration far larger than the tripwire beneath it.** `spawn.ts` claimed
   **430,122** exhaustive cases; the shipped sweep ran 46,284 and asserted only `checked > 20000`.
   **The assertion is the tell**: a size guard loose enough to survive a 78 % narrowing is not
   protecting the claim above it. Assert the enumeration exactly, or state what the sweep covers.

**And one that is not about a number at all, because it is about the toolchain.** `buildings.ts`
justified a real fix with *"both are far too large for V8 to inline"*. Under
`--trace-turbo-inlining`, three runs out of three: `canPlaceDestination` refused for exceeding the
bytecode limit, **`canPlaceHouse` inlined**, at bytecode size 175. The fix is right, the 40.0 B/call
measurement is right, and *inlining is a precondition for scalar replacement rather than a guarantee
of it* — so the code stands and only the reason was false. **This is the most durable of the seven,
because the thing it explains is correct**: nothing will ever go red to question it, and the next
person to reason from the sentence will reason from something nobody measured. A claim about the
toolchain deserves the same scrutiny as a claim about the code, and it gets less.

## Growth in the entity count is not growth in the behaviour you wanted

M1e's spawner made the city grow: 22 houses, 10 destinations, 184 trips over 20,000 ticks. It also
produced **exactly one spawned car in motion.**

*(Those four numbers are the PRE-fix rig and must not be read as current. The repaired rig — same
20,000 ticks, but with the driver laying road reactively the way a player does — is **21 houses, 10
destinations, 615 trips and 24 of 38 spawned car slots in motion**, asserted at `spawn.test.ts:1443`
with the floor at 20. The population figures barely moved, which is the entry's whole point: the thing
that changed is the only thing that was ever evidence.)*

Two independent reasons, both invisible from the counts. A spawned house **cannot drive at all on its
own** — placement refuses a road cell and the flow field relaxes over the road graph, so a house with
no road adjacent has `dist = INF` forever; no longer run fixes it, the rig has to lay road reactively
the way a player does. And on the natural schedule the **seeded** houses absorb every dispatch, which
is the same "service is 4.3× faster than arrival" that made the previous milestone invisible,
reproduced by the mechanism meant to fix it.

So an acceptance gate reading "the board reaches N houses and M destinations" is satisfied by a board
where nothing new ever moves. **Gate on the behaviour, not on the population** — cars in motion, trips
completed, queues formed — because the population is the input to the thing you care about, not
evidence of it.

## An assertion placed above another can make the second unreachable

M1e Task 6 replaced a hard-coded bound with a derived one and wrote a test to prove the derivation
still holds as the maps change. **The test had no teeth**, and the implementer only found out by
attacking it: raising `maxDestinations` to 84 failed on `expected 168 to be 36` — an *identity pin*
sitting above the bound check, which fires for **any** map change at all. The bound it was written to
guard never ran.

Both assertions were correct. Their order made one of them dead. And the failure message named the
identity, so a maintainer reading the red would have concluded the bound was fine.

The fix is the diagnostic: **reorder, then prove the two assertions discriminate** — 84 must fire the
bound with *"that label is no longer true"*, and 20 must fire only the pins with *"a map grew
safely"*. Two different mutations, two different messages. If every mutation you can think of
produces the same red, the assertions after the first are decoration.

This generalises past ordering: **a broad assertion upstream of a specific one is a coverage hole
that reads as depth.** Count detectors per *mutation*, not per test — and check that the mutation you
care about produces the message you expect, not merely a red.

## A prediction written before the measurement is worth more than the measurement

Task 6's implementer derived where its new invariant would break, predicted the binding case would
fall at week 19, and wrote the assertion. **The assertion caught it at week 18.**

The reasoning was plausible and wrong in an instructive way: the 0→1 transition is the largest drop
absolutely, so it looks like the binding one — but it also has the largest period available to absorb
it. The tight case is the *last* drop before the cap, where the drop is small and the headroom is
smaller. `min(2·P_w − P_{w−1} + 1) = 167` against `min P_w = 172`.

Nothing about the shipped behaviour changed. What changed is that a wrong mental model was caught by
an artefact rather than carried forward — and it was only catchable because the prediction was
written down **before** the number came back. A measurement taken without a prediction confirms
whatever it finds.

## Two independent measurements that share one wrong constant agree perfectly, and the agreement is the trap

M1e Task 7 reported a destination's last arrival at tick 1,274, corrected a plan figure of 1,549 to
it, and offered as evidence that **two independent integrations agreed**. Both were wrong.

The harness hard-coded `PHASE_OUTBOUND = 1` and `PHASE_RETURNING = 2`. The real values are **2 and
3**. So the "arrival" predicate matched the `IDLE → OUTBOUND` edge and counted **dispatches**.
Both integrations imported that same constant — **independent on every axis except the one that
mattered** — so they agreed exactly, and their agreement was reported as corroboration.

Cross-checking is only worth what the checks fail to share. Two implementations of the same wrong
premise are one measurement quoted twice.

**The oracle that broke it touched no phase constant at all:** `destPins` is written in exactly two
places repo-wide, +1 on fire and −1 on arrival, so a decrement *is* an arrival by construction. That
is the property to look for — an oracle whose derivation does not pass through the thing you might
have wrong.

Two practical rules. **Prefer a structural oracle to a second implementation** — a conservation law,
a counter with one writer, an invariant — because it fails differently rather than identically. And
when a measurement contradicts a figure someone else derived, **suspect the instrument before the
figure**: here the plan's 1,549 was right all along, and the "correction" was the defect. Compare
against [a correction can repeat the exact error it is correcting] — this is its instrumented twin.

## An arithmetic model of what a rig does is not what the rig does

The same task needed to know where a profiling rig's last window ends, to keep it below a tick at
which the sim freezes. Its first answer was derived — warmup plus windows times frames — and gave
**5,250**. The rig actually ends at **6,459**, a 23% error, on the quantity a safety margin was being
computed from.

The shipped guard therefore reads `H_TICK` off the real rig rather than recomputing it, with a static
assertion at the knobs as a second line. **When a bound protects against a rig's behaviour, measure
the rig** — a model of the rig is a second implementation of it, and it can be wrong in the direction
that makes the bound look safe.

## A rule you can cite is not a rule you have applied

M1e Task 8 declined its own largest coverage restoration on the grounds that it "moves every other
fixture" — a claim it never ran. Its reviewer capped one constant and measured the real cost:
**exactly one failing test**, which simply reverted, recovering 12,778 ticks of live invariant
checking.

The implementer's own summary of it is the entry: *"I cited 'a blast-radius claim is a measurement,
not a reading' against the plan in the same report where I broke it."*

That is the failure mode of a catalogue. Entries get read, quoted, and used to judge other people's
work, while the behaviour they describe goes on happening in the writer's own. **Citing an entry is
evidence you recognised the shape somewhere else, not evidence you checked for it here.**

The operational form: when you invoke a rule against someone else's decision, run it against your own
open decisions in the same sitting. The rules in this file are cheap to apply and expensive to
re-learn, and every one of them was written by somebody who had just violated it.

## Safety properties are satisfied trivially by a frozen system

M1e Task 8 made the sim freeze on game over. A 20,000-tick invariant sweep then spent **12,778 ticks
asserting over a corpse** — and stayed green, because everything it asserts is a *safety* property:
occupancy soundness, the reservation invariant, no counter wrap, no starvation. "Nothing bad
happened" is trivially true of a system in which nothing happened.

The task documented the loss honestly and did not repair it, which is the subtler error: an honest
note about a dead sweep still leaves a dead sweep.

**Every long-horizon sweep needs a liveness assertion alongside its safety ones**, and it must be
strong enough to notice the run ending early. The fix here is worth copying: assert off the **peak
meter** rather than the terminal flag — because a meter that climbs and unwinds never sets the flag,
and it is the tick *before* the flag that says the margin is gone. A flag check would have passed on
a board one tick from death.

## An interlock is a mechanism; "the next commit will fix it" is a promise

Task 8 shipped a state where the default board is indistinguishable from a crash — frozen frame,
refused input, no message — with the UI deferred to the next task. Correct sequencing, disclosed
three times, and **nothing in the tree prevented a deploy landing there.**

This document's own entry says a handoff item with no code artefact is the one that evaporates, and
the milestone had already lost two. So the mitigation became a **deliberately failing test** that the
next task deletes as its first act.

What makes it good rather than annoying is the key it is anchored to: `RenderFrame` cannot
*express* a shutdown, and `render` imports nothing from `sim`, so nothing can be drawn without a new
field on the frame. **That is structural, not a guess about the next task's shape** — the interlock
cannot be satisfied by a cosmetic change, and its worst failure mode is that the next task deletes a
file it was going to delete anyway.

Use this whenever a commit knowingly ships a bad intermediate state: encode the constraint as a red
test keyed on something the fix must structurally change.

## The change that made a budget non-vacuous is the change that hid the thing it was measuring

M1e Task 9 reported an allocation regression in code it had just written — a fractional `lineWidth`
charging 17–37 B/frame on 5 of 5 runs — and wrote the figures into two source comments as a property
of the code shape. Re-measured by a reviewer, **both the fixed and the broken variant are clean 5/5.**

The explanation is the interesting part, and the implementer found it. The cost is a **one-off field
representation transition plus its deopt**, not a per-store box. On the rig as it stood when the
figures were taken, the first ring appeared around tick 2,500 and that one-off landed **inside a
profiled window**. The task then made the ring appear earlier so its budget would not be vacuous —
and that same change moved the transition into the warmup, where `min`-over-three-windows discards
it.

So the instrument told the truth twice and meant different things, and the durable comment recorded
the first reading as a permanent property. **A one-off cost is not a rate**, and a statistic built to
reject strays (min-over-N) is built to reject one-off costs too — by construction, not by accident.

Two rules. When a figure comes from a rig you are also changing, **re-measure after the last change
to the rig**, not when you first saw it. And a comment claiming *the harness can see this class of
defect* is a claim about the instrument that needs the same scrutiny as a claim about the code — this
one was false, and nothing in the suite could have caught it.

## Key a user-facing message to a fact the code can compute, not to history you would have to keep

Task 9's shutdown screen said `OVERCROWDED` for a destination that died of **receiving nothing**.
The controller proposed splitting the message on whether the meter had ever drained — correct, but it
needs per-run history.

The implementer keyed it instead on **whether any road reaches the carpark**, computed from data
already on the render frame: no new state, no new field, no history. And it justified the deviation
by measurement rather than by convenience — **both arms are reachable on the shipped boards**, where
the drain-history split would have shipped a third arm (`OVERCROWDED`) that no shipped board can
reach.

That last check is the transferable part. When you split a message into cases, **measure which cases
the shipped configuration can actually produce.** A branch no board reaches is dead copy that reads
as coverage, and the version with fewer reachable arms is usually the one keyed to a fact rather than
to a story about the past.

## A survivability improvement that removes the difficulty looks exactly like a survivability improvement

M1e Task 10's brief carried a measured lever — tier the destination spawn scan
by proximity to the spawning colour's own houses — with figures behind it:
greedy survival 6.0 → 7.7 weeks, round trip 360 → 153 ticks, dropped pins 85 a
week → 0, and *"peak `destPins` on connected destinations 1 → 2 → 10 across nine
weeks where the baseline steps straight to the cap."*

Re-measured on the tree that ships, five seeds, twelve weeks, both variants in
one run, **every one of those inverted or evaporated.** The lever survives
everything — and does it by making the board inert: peak `destPins` **1 in all
twelve weeks**, longest queue 1, zero blocked ticks, four cars in flight, mean
round trip 51 ticks, delivery fraction ~1.00. The *baseline* is the one that
produces 1 → 2 → 5 → 10. And the problems the lever was for did not reproduce
at all: 0 dropped pins in every week of the shipped seed, at most one
destination unconnected at any week boundary, 62 tiles spent of 210 granted.

Two things generalise.

**"It survives longer" and "it is a better game" are the same number until the
gate separates them.** Weeks lived, delivery fraction and dropped pins all moved
the right way under the lever. **Two kinds of measurement noticed, and I got
this wrong the first time I wrote it down here.** A *load* floor did: cars in
motion fell 11 → 4, so a gate asserting `maxInFlight >= 6` fires. And a *shape*
check did: a connected destination's pin count must climb through a gradient to
its timer cap, and under the lever it is flat at 1 in all twelve weeks.

The original version of this entry claimed cars moved the right way too and that
only the shape gate noticed. Both halves are false, and the entry **refuted
itself eight lines above** — where its own measurement reads *"four cars in
flight"* against a baseline of eleven. So: **pair every survival threshold with a
floor on the load that makes survival hard** (cars in motion, queue length,
backlog reaching a cap) *and* with a shape check. Either alone is weaker than the
pair, and a summary written from a conclusion rather than from the table is how
the load half went missing.

**A brief's measurements have a tree attached, and the tree moves under them.**
These figures were taken before Tasks 7 and 8 existed; the round-robin/nearest
mismatch they were compensating for now expresses itself through an overcrowd
meter that did not exist when they were taken. The rig that found this
reproduced both inherited death ticks bit-for-bit (5,580 and 8,661) *before* it
was believed about anything else — which is the only reason the contradiction
read as a finding rather than as a broken harness. **Reproduce an inherited
number with your new rig before you use the rig to contradict an inherited
claim.**

**That prescription paid for itself twice more in the closing sweep, and both
times the reproduction is what made the correction safe.** A replica of
`allocation.test.ts`'s dense rig, with `maxDestinations` put back to 4,
reproduced its death tick of 7,223 exactly — and only then was its "trigger cap
at 3,833" contradicted with 3,834. A hand-driven greedy arm reproduced 31,456
ticks, 747 trips and `H_ROUTES_REFUSED` 0 against the production driver's
assertions — and only then was the handoff's "13 destinations by week 8"
contradicted with 12, in week 6, on a run that ends there. **In both cases the
first rig I wrote did NOT reproduce** (23,935 ticks, 422 trips, 13 destinations —
because it had no warm start and no opening stroke), and every conclusion drawn
from it would have been a confident correction of a correct figure. The
reproduction step is not ceremony; it is the step that caught my own harness.

Related: [a blast-radius claim is a measurement, not a reading], and
[a prediction written before the measurement is worth more than the
measurement]. The prediction here was the brief's own, written months before,
and it is worth more than the measurement precisely because it was wrong in a
direction nobody would have guessed.

## A survivability gate can be passed by deleting the difficulty

M1e's plan specified a lever to make its default board survivable. The implementer measured it across
five seeds and refused it: the lever survives all twelve weeks by making the board **inert** — peak
backlog of **1 in 65 of 65 week-observations**, zero blocked ticks in 63 of 65, four cars ever in
motion, delivery fraction ~1.00.

That is the previous milestone's inert shipped board, reproduced exactly, **by the mechanism proposed
to fix the previous milestone's inert shipped board** — and it would have arrived with a green gate
blessing it and a "survival 6.0 → 7.7 weeks" headline in the commit log.

**Any gate phrased as "the system survives N of X" can be satisfied by removing the load.** Pair
every survival threshold with a floor on the thing that makes survival hard: cars in motion, queue
length, backlog reaching a cap, a delivery fraction that falls. The gate here catches the deletion
precisely because it also asserts a *gradient* — some week at 1, a later week strictly between 1 and
the cap, a later week at the cap — and a board with no difficulty fails the middle clause.

Note the near-miss inside the fix: the first version of that gradient check passed `[1,1,1,6,6]`,
because the capped week is also "a week above 1", so the middle clause was free. **A three-point
shape needs a middle point that cannot be served by an endpoint.**

## When the same wrong constant can reach both, extract the predicate rather than restating it

The gradient check above was verified with synthetic series against a comment describing the rule.
The repair extracted the predicate into one exported function, so the synthetic-series test runs
**the same function the gate runs** — rather than a second copy that could agree with the comment
while the gate disagrees with both.

That is the durable form of this document's [two independent measurements that share one wrong
constant] entry, applied preventively: where a rule is stated twice — once as prose, once as code —
a test written against the prose does not test the code. **One predicate, one caller for the
production path and one for the table of cases.**

## A restore guarded by `&&` and reported by `;` prints success over a dirty tree

Task 11's teeth-check restored with `git checkout -- packages && git status --porcelain`, run from
inside `packages/sim`. The checkout failed on the path, the `&&` short-circuited — and the
`(restored clean)` message printed anyway, from an unconditional `;` later in the line. **A mutated
constant sat in the tree behind a success message.** Caught by re-verifying from the repo root.

This is the fourth distinct harness-restore failure in one milestone, and it defeats the remedy the
earlier three produced. That remedy was *print `git status --porcelain` after every restore*. It is
still right, and it is insufficient as stated:

**The report of a restore must be unreachable when the restore did not run.** Chain the print to the
same success the restore needs — one `&&` chain, not a `;` — or better, make the check assert rather
than print, so a dirty tree fails loudly instead of scrolling past. A self-check whose success
message can be reached on the failure path converts *I did not check* into *I checked*.

Related: [a mutation harness's restore step is untested code]. Each occurrence has been a different
mechanism — a wrong command, a destroyed symlink tree, a stale script, and now a shell operator — and
none was caught by the suite. Every one was caught by looking at `git status` with human eyes. Assume
the next one is also a mechanism nobody has seen.

## The correction that would have deleted working code

M1e's final review found a production comment stating an absolute — *board input is refused while
paused and by nothing else* — that a later commit had falsified: a tap on a dead board returns
`RESTART_REQUESTED`, never `REFUSED_PAUSED`. Its inference was that the mechanism the comment
justified, a boot-time `loop.end()`, was therefore resting on a dead argument.

**The absolute was false. The inference was backwards, and acting on it would have removed the
player's only exit.** The sweep tested it the only way that settles it — by deleting the line and
booting a terminal-at-boot rig: `over` and `paused` both false, a tap returns `DRAG_START`, a drag
returns `DRAW`, and **two road actions queue on a dead board** with zero restarts. `gameOver()` reads
`loop.over`, which only `end()` sets, so that one line arms *both* refusals.

So a wrong comment can sit above correct and necessary code, and the wrongness of the comment says
nothing about the code. **When a stale comment is the stated justification for a mechanism, test the
mechanism before you touch either** — the comment is evidence about what someone believed, not about
what the code does.

This was the sixteenth member of the milestone's dominant defect family and **the only one where the
obvious repair was destructive.** Fifteen prose fixes with no behavioural risk is exactly the run that
makes the sixteenth feel safe.

## The rule caught the sweeper: reproduce before you contradict, including your own new rig

The same closing sweep built a rig to re-derive the milestone's figures and got 23,935 ticks / 422
trips / 13 destinations against a recorded 31,456 / 747 / 12. It had omitted the warm start and the
opening stroke.

**Every correction drawn from that rig would have been a confident correction of a correct figure** —
the precise failure this document already records twice, about to be committed by the task written to
clean it up. What stopped it was the rule the same document states: reproduce an inherited number
with your new rig *before* you use the rig to contradict an inherited claim.

The generalisation worth keeping: **a rig that disagrees with the record is more likely to be wrong
than the record is**, because the record was produced by a rig that had already reproduced something.
Disagreement is a reason to check the instrument first, and the check is cheap — pick one number you
are *not* trying to correct and see whether it comes back right.

## A module-scope constant read through an import cycle is `undefined`, and polarity decides whether you find out

M1f Task 1 hoisted a lookup mask to module scope for speed. **It evaluated to 0**, because
`roads.ts → dispatch.ts → scratch.ts → roads.ts` is a real cycle and the `DIR_COUNT` it read came back
`undefined` at module-evaluation time. Nothing in the type system, the linter or the test names says
so; the value is simply wrong before any test runs.

The implementer's own sentence is the entry: **"It failed loudly only by luck of polarity; the same
shape in a fail-open guard ships green."** A zero mask happened to make its guard reject everything,
so the suite went red immediately. Had the guard been written the other way — mask zero meaning
"nothing to check" — it would have passed every test forever while checking nothing.

Two rules. **Do not compute module-scope constants from imported values in a package with cycles**;
build them at first use, or on the object that owns them. And when a hoist is worth it anyway, make
the wrong value *unrepresentable* rather than merely detected — the fix here was a builder that
refuses a non-positive dimension, so the failure cannot recur even if the cycle returns.

The general shape is worth more than the instance: **an initialisation-order bug and a fail-open
guard compose into a permanently green test that checks nothing**, and neither half is visible in a
diff.

## A membership test is not the same as a bound, and the case that motivates the fix may pass both

Reviewing an assertion that caught illegal edge costs with `delta > maxEdge`, I proposed replacing it
with a membership test: `delta !== ORTHO_COST && delta !== DIAG_COST`.

The implementer measured it and **my fix does not catch my own motivating case.** The example I gave
was a +4 surcharge on an orthogonal step: `10 + 4 = 14`, which is exactly `DIAG_COST` — a legal value.
The bound passes it, and so does the membership test. What membership actually buys is the narrow
`{11, 12, 13}` window between the two legal costs.

It implemented membership anyway, pinned the surviving blind spot as an explicit table with a vacuity
guard, and replaced the overclaim with the property that does hold: **any surcharge touching a
diagonal is caught for every value ≥ 1** — which is the shape a real penalty takes, since a uniform
surcharge hits both tiers.

The lesson is not about edge costs. **When you propose a stronger-sounding assertion, run it against
the exact case you used to justify it.** "Bound" and "membership" differ only on the values between
the legal ones, and if your example is not in that window you have argued for a change that does not
address it.

## A report can claim a correction was applied when it was not, and the next task inherits the defect

M1f Task 1 swept for artefacts carrying a refuted claim and reported four corrected in place. Three
were: `scratch.ts` and `flowfield.ts` both now **quote the refuted sentence and refute it**, which is
the right shape — verified at Task 1's own commit.

The fourth was not corrected at all. `junctionCensus.ts` still said *"Both policies share one `prev`,
so a driver may run both in one pass over one buffer"* — and that is false in a way that silently
destroys a measurement: the loop writes `prev[i]`/`prev[i+1]` **unconditionally** at the end of every
cell iteration, so a second pass reads the first pass's writes and measures nothing. Both existing
drivers already allocate two buffers, so nothing was broken — but the comment invites the bug.

It was found by the *next* task, sweeping the whole file rather than patching the three lines it had
been handed.

**The generalisation is about reports, not comments.** A task report is the artefact a controller
reads to decide what still needs doing, and "corrected in place" is exactly the kind of claim nobody
re-checks — it closes the item. Two rules follow. **Spot-check a sweep's claims against the tree, not
against the report**, and do it per claim rather than per sweep: three of four right is the ratio that
makes the fourth invisible. And when a task reports N sites fixed, **the cheap verification is a grep
for the refuted string, at that task's own commit** — which is how this one surfaced.

Related, and this milestone produced both within a day: [a durable artefact that states the opposite
of the measurement]. There the correction was written **beside** the defect — one file quoted a wrong
figure and corrected it while the header two directories away kept asserting it. Here the correction
was **reported** but never written. Same failure, different half.

## A snapshot of a mid-edit tree becomes a verification in exactly one hop

An agent finishing M1f Task 4 noticed a second agent writing to the shared checkout, stopped, and —
before standing down — ran two greps to check whether the in-flight code respected the interlock and
the RNG ban it had just built. Both looked right. It reported that as *"a snapshot of a mid-edit tree,
not a review."*

**I relayed it as "the interlock is being used exactly as designed" and "the RNG ban is holding."**
One hop, and a qualified observation became an unqualified fact. The agent caught it and said so:
those greps are evidence the other task was on the right path *at that instant*, not evidence about
its eventual commit — the file was being edited while the grep ran, and its own test suite was
mid-flight.

This document already records that **a secondhand claim gains confidence at each hop while gaining no
evidence**. What this instance adds is how short the chain can be. There was no misunderstanding, no
paraphrase drift, and the original was explicitly hedged. The hedge simply did not survive being
useful — the observation was reassuring, and reassuring things get repeated without their conditions.

Two practical rules. **A measurement taken against a tree someone else is writing to is provisional by
construction**, and the provisionality belongs in the same sentence as the number, every time it is
repeated. And **schedule the re-check rather than trusting the snapshot**: both facts here are cheap
to confirm at the real commit — the RNG ban re-verifies itself the moment the suite runs, and the
interlock is one grep — so the correct response to a hedged snapshot is a queued verification, not a
confident restatement.
