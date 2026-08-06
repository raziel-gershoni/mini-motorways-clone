# M3 carry-forward

What M2 established that M3 must act on. M3 is persistence and the verified leaderboard: CloudStorage save/resume, the input log, `initData` validation, replay verification in a Worker, D1.

For how tests fail on this project, read [`testing-defect-catalogue.md`](testing-defect-catalogue.md) first. Roughly a third of it was written during M2.

---

## The one thing M2 measured that changes M3's design

**Base64 of the raw snapshot is 10,544 characters against CloudStorage's 4,096-char cap — 2.57× over at *every* occupancy, including an empty grid** [M1c]. Gzip-before-base64 is a **correctness requirement, not an optimisation**: the uncompressed path does not merely waste space, it never fits. A `CompressionStream` failure must therefore fall back to **not writing**, never to writing raw.

Headroom at full occupancy is **2.55×, not the ~6× the spec once claimed**. `carRoute` is 48.6% of the buffer and dominates the compressed size, so headroom scales inversely with how busy the city is. Re-measure when `maxCars` changes.

**The log budget is 2,488 chars** once the snapshot is accounted for — and the log grows with run length while the snapshot does not, so this fails on **long runs specifically**, which are the ones worth submitting.

---

## What M3 re-opens that M2 could leave alone

### 1. `initCarSnapshots` ordering stops being equivalent

Moving it before the warm start is a **0-detector today**, and genuinely so: the seed lays no roads, so no route exists, so no car leaves `PHASE_IDLE` during the ramp — verified byte-identical at 9,000 warm-start ticks. **That is a property of the seeded state, not of the code.**

**A restored state has cars mid-route.** Get the ordering wrong and frame 1 lerps them across 258 ticks of warm start. Keep the call last, and add the fixture the seed cannot provide.

### 2. Resume must not silently produce an unranked run

Spec §9.4: a session resumed without its input log is **unranked**, and the UI must say so rather than quietly dropping the score. That is a user-visible state with no owner yet.

### 3. The warm start interacts with restore

`main.ts` runs a **258-tick warm start** at boot so the first pin lands at 4.00 s instead of 12.6 s. A restored run must **not** re-run it — it would advance a loaded state by 258 ticks and desynchronise the replay from the log.

---

## Instruments M3 inherits, and their real limits

- **The allocation harness works and is now scoped to `game`, `render` and `sim`.** It caught three live violations in M2, two of them in code a green harness had already passed. Its limits: attribution is stable **per file, not per function**; figures move ~2× between rigs because a per-frame number encodes the driver's input density, so **pin per-call invariants**; and it was **silently inert in every worktree for two tasks** before that was found. Confirm it is live by injection before believing a green result.
- **`canPlaceRoad` allocates ~40 B per call in the frame loop** — a measured, deliberately-allowed violation carried to M1d. Its test asserts the allocation is **still present**, so M1d's fix turns the allowance red instead of leaving a dead exemption.
- **The deploy check greps the served bundle for a build-unique token**, in both the HTML meta tag and the module script name, and both halves are proven able to fail. Use it. On this project a `wrangler deploy` once printed `Success! Uploaded 2 files` while serving the previous asset hash, and `setChatMenuButton` once returned `ok: true` and changed nothing.
- **The Telegram Mini App URL is not settable through the Bot API** when the bot is configured via @BotFather — BotFather's setting wins. Changing it is a human action.

---

## Known-unverified, honestly

- **`MainButton` in Telegram fullscreen has never run on hardware.** It is the control that makes erase reachable; `?fallback=1` swaps in a DOM button. Every other Telegram surface in the build is a lift from code M0 actually ran.
- **The frame budget is qualitatively confirmed only** — a human reports it feels smooth on one phone. No numbers, no Android, no `performanceClass: LOW` device.
- **Nothing has measured CloudStorage beyond 78.5 minutes**, on one iPhone, one iOS version, one Telegram build. M3 is the milestone that depends on it.

---

## What M2 proved about the architecture

The sim→render→input round trip closes exactly: **7,392 drawn-rect round trips across 8 viewports including three at DPR 1.5, zero disagreements**, with the pixel read from the renderer's own recorded output rather than from the forward transform. **120,000 frames** of the assembled game with 3,000 drags, 3,000 aborts and 300 resizes mid-drag produced zero violations and two identical runs agreeing on the same state hash.

`render` imports nothing from `sim`, enforced by a scan whose one real catch — a raw relative path — is the form `tsc` cannot see.
