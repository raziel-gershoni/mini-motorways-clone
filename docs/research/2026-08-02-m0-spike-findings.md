# M0 De-Risking Spike — Findings

**Date:** 2026-08-02
**Spike:** `spike/` (throwaway; see plan [`2026-08-02-m0-derisking-spike.md`](../superpowers/plans/2026-08-02-m0-derisking-spike.md))
**Spec under test:** [`2026-08-02-mini-motorways-clone-design.md`](../superpowers/specs/2026-08-02-mini-motorways-clone-design.md) §6, §9, §13

**In one line:** the iOS half of M0 is answered; the Android half was not run and remains fully open; the spec's baked-road-layer optimisation is refuted and must be deleted; and the spec's two persistence tiers are inverted — `localStorage` lost data nondeterministically across four of six gaps, while CloudStorage returned it byte-intact over the one 78-minute gap measured, so CloudStorage becomes the save store of record.

---

## 0. What M0 did **not** answer

**Only an iPhone was available. No Android device was tested. Zero measurements exist on a `performanceClass: LOW` device.**

Spec §12 defines M0's exit criteria as *"400 animated sprites measured in Telegram's Android WebView on a `performanceClass: LOW` device; `localStorage` persistence across sessions verified on a real iPhone."* **The first clause is unmet.** Spec §13's second risk — *"All renderer throughput evidence is from desktop"* — is improved (we now have one mobile WebKit device) but **not discharged**. The renderer question was posed about low-end Android because that is where it can fail. It was measured on the fastest mobile SoC available.

Concretely, the iPhone results below say nothing directly about:

- whether Canvas2D clears the 8 ms drawing budget on a cheap Android;
- whether Chromium GPU-rasterizes the canvas at all on that hardware (driver blocklist / low-end-device mode) — a binary worth 3–10×;
- the maximum viable car count on the device that constrains it;
- whether `performanceClass`-gated degradation is needed, and at what threshold.

Everything in §7 marked **provisional** is provisional on that run. The device is listed in spec §10.4 as a human deliverable and has not been supplied.

**Second-order caveat on the extrapolation.** §2 fits an effective pixel throughput of ~10 Gpx/s from the iPhone data. That is a *fitted rate for this workload*, not a hardware spec — it implies ~80 GB/s of naive read+write traffic against an SoC rated near 60 GB/s, which means WebKit is eliding some of the work (opaque-fill fast paths, tile caching, compressed framebuffers). **Do not carry that number to Android as a hardware ratio.** It is valid for comparing two paths on *this* device, which is all §3 uses it for.

---

## 1. Devices tested

| | Device A |
|---|---|
| Platform | `ios` (Telegram iOS Mini App) |
| Exact model / iOS version / Telegram client version | **Not captured in the recorded output.** `deviceInfo` collects `clientVersion`; it was not carried into the results log. Re-capture before citing this document externally |
| `performanceClass` | `null` — expected and correct. Telegram exposes the class only on Android, via the User-Agent string, not the JS API |
| `devicePixelRatio` | 3 |
| Canvas | 406 × 870 CSS → **1218 × 2610 device px = 3.179 Mpx** |
| Grid tile | `floor(min(406/24, 870/40))` = **16 CSS px** = 48 device px → 2,304 device px/tile |
| `performance.now()` granularity | **1 ms exactly** (WebKit clamps). Load-bearing — see §6 |
| Display | **60 Hz.** `frame.p50` read exactly 17.000 ms in all 15 config runs. No ProMotion in this WebView |

| | Device B |
|---|---|
| | **Not run.** A `performanceClass: LOW` Android device was never supplied |

---

## 2. Render benchmark

**Budget (spec §6): well under 8 ms of drawing per 16.7 ms frame.** That budget is defined *for a real cheap phone*. Every pass mark below is on the wrong device for it.

Per-draw cost, median of 3 batched passes of 20 draws each, `getImageData` GPU sync inside the timed region. Timer quantum on the reported figure is **0.050 ms** (1 ms ÷ 20) — every median is an exact multiple of it, which confirms the batching is sound.

| Config | median | min | max | spread | frame p50 | vs 8 ms |
|---|---|---|---|---|---|---|
| 100 sprites, baked roads | **0.750** | 0.750 | 0.900 | 20% | 17.000 | PASS (9%) |
| 200 sprites, baked roads | **1.100** | 1.000 | 1.350 | 32% | 17.000 | PASS (14%) |
| 400 sprites, baked roads | **1.750** | 1.550 | 1.850 | 17% | 17.000 | PASS (22%) |
| 800 sprites, baked roads | **2.200** | 2.150 | 2.750 | 27% | 17.000 | PASS (28%) |
| 400 sprites, per-frame roads | **1.600** | 1.600 | 2.300 | 44% | 17.000 | PASS (20%) |

**The device never dropped a frame at any tested load**, including 800 sprites and the 432-drawImage per-frame road path. `frame.p50` pinned at the vsync interval throughout.

**Cost model.** Least-squares over the four baked points gives `cost ≈ 0.65 ms + 2.0 µs × sprites` (R² 0.925; refit excluding the one outlying point, R² 0.990, intercept 0.62 ms, slope 1.99 µs). Marginal rates look sublinear (3.50 → 3.25 → 1.13 µs/sprite across the segments), but the entire deviation sits at n=400, **and the per-frame 400 config carries the same +0.25 ms residual against the same model** — two different workloads sharing one offset is a run-level systematic, not curvature. With 4 points, a 0.050 ms quantum and 17–32% run-to-run spread, **linear vs sublinear is not resolvable from this data. Budget with the linear model; the power fit is an extrapolation artifact.**

The 0.65 ms intercept is benchmark-inflated: production has no `getImageData` pipeline flush. Treat it as an upper bound.

**Headroom (iPhone only).** 400 sprites baked = 10.5% of a 16.67 ms frame; add an unconditional 5-colour flow-field rebuild (0.180 ms) and it is 11.6%. Extrapolating the linear model:

| Drawing budget | Sprites |
|---|---|
| 25% of frame | ~1,700 |
| 50% of frame | ~3,800 |
| 100% of frame | **~7,900** (high-n marginal rate instead: ~13,700) |

**~7,900 sprites before drawing alone eats a 60 Hz frame; plausible range 8k–14k.** That is 20–35× the 200–400 car design load. On this device the sprite count is not a constraint and no sprite-batching work is justified.

**Where sprite cost actually goes.** A benchmark sprite is a `roundRect` path 9.6 × 9.6 CSS px = 829 device px. At the fitted fill rate that is ~0.08 µs — **~4% of the measured 2.0 µs/sprite. Roughly 96% is CPU-side path construction and fill setup, not pixels.** Note this is a `roundRect` path, *not* an atlas blit; the production renderer draws sprites differently and its per-sprite cost will differ. The 2.0 µs figure bounds a path-based sprite, which is the pessimistic case.

---

## 3. Baked-layer verdict — **the spec is wrong; delete the optimisation**

> Spec §6: *"**Bake the road network to an offscreen canvas once per edit** and blit it as one `drawImage`. Drops per-frame draws from ~1,500 to ~300. Without this, the sprite budget above is meaningless."*

**Measured at 400 sprites: baked 1.750 ms, per-frame 1.600 ms. The bake is not faster. It is 0.150 ms slower at the median, and the pixel model says it is structurally slower at our road density.**

### 3.1 The measured difference is not statistically real — and that is enough

Raw passes: baked `{1.550, 1.750, 1.850}`, per-frame `{1.600, 1.600, 2.300}`.

- Ranges overlap on [1.600, 1.850]; no separation.
- **The ordering flips with the statistic.** Medians favour per-frame by 0.150 ms; **means (1.833 vs 1.717) favour baked by 0.117 ms.**
- Pooled sd 0.306 ms (CV 17%) against a 0.150 ms effect = 0.49σ. Mann–Whitney with n=3 vs n=3 has 20 arrangements, so **minimum achievable two-sided p = 0.10** — significance was unreachable before the data existed. Detecting 0.150 ms at 80% power would need **~65 passes per arm**.

The claim is therefore **not** "per-frame is faster." It is: **baking is not measurably faster, and the pixel accounting below says it is structurally slower here.**

### 3.2 The pixel accounting, which is not ambiguous

Both paths cover the same playfield with the same 400 sprites and the same full-canvas clear. The only difference:

| Path | `drawImage` calls | device px composited |
|---|---|---|
| Baked (one full-canvas blit) | 1 | **3,178,980** |
| Per-frame (432 tiles × 2,304 px) | 432 | **995,328** |
| Delta | +431 | **−2,183,652 px (−69%)** |

The bake blits the entire 1218 × 2610 canvas. The grid occupies only 1152 × 1920 of it (tiles are floored to 16 CSS px, so ~30% of the canvas is outside the grid entirely), and roads occupy only 45% of the grid. **The baked path composites 3.2× the pixels to draw the same roads.**

Two independent constraints bracket the effective rate: the 0.150 ms delta over 2.18 Mpx gives ≤ 6.9e−8 ms/px (**≥ 14.6 Gpx/s**) if calls were free; the 0.65 ms intercept must cover a full-canvas clear *and* a full-canvas blit (6.36 Mpx) giving ≤ 1.09e−7 ms/px (**≥ 9.2 Gpx/s**). Central estimate **~10 Gpx/s**, back-solving to **~0.16 µs per `drawImage`**.

| Road layer at ~10 Gpx/s | pixel cost | call cost | total |
|---|---|---|---|
| Baked | 0.318 ms (99.9%) | 0.0002 ms | **0.318 ms** |
| Per-frame | 0.100 ms (59%) | 0.068 ms (41%) | **0.168 ms** |

**Pixel throughput is the binding resource for the road layer; draw-call count is nearly free.** WebKit batches consecutive `drawImage` calls from a single atlas source into shared GPU draws — 432 JS calls are not 432 GPU draws. The spec optimises the count of a thing costing ~0.16 µs and ignores the thing costing 0.10 ns × 3.18 M. (The spec's arithmetic also does not reconcile: the baked path still issues 400 sprite draws, so it is 401 not ~300, and 432 road + 400 sprite is 832, not ~1500.)

### 3.3 Crossover density

Solving `baked = per-frame` for road density `d`:

| Assumption | Baking wins above |
|---|---|
| As benchmarked (bake sized to the full canvas) | **85% of cells** |
| Bake tightened to grid bounds only (a fix nobody has made) | **59% of cells** |
| Perfect call batching (`c_call` → 0) | **never** — the bake still blits the letterboxed area the tiles skip |

**Measured density is 45%. Typical Mini Motorways maps run well below that.** Baking loses at 45% under every reading of this data.

### 3.4 Costs the benchmark never charged the bake

- **+12.13 MiB** of surface memory (1218×2610×4 B) in a memory-constrained iOS WKWebView.
- **Invalidation.** The core mechanic *is* drawing roads. Every frame containing a road edit costs re-render (0.168) + offscreen clear (0.318) + blit (0.318) ≈ **0.81 ms, 4.8× the per-frame path.** During a drag this is every frame.
- A second full-canvas surface and an extra code path, for a measured tie.

### 3.5 Design consequence — act on this

1. **Delete the "bake the road network to an offscreen canvas" bullet from spec §6.** Draw road tiles per frame from the 256-entry atlas.
2. **Keep the 256-entry atlas.** It is unaffected; it is what makes the per-frame path cheap and the joins correct.
3. **The sprite budget does not depend on the bake.** §6 says "without this, the sprite budget above is meaningless." Measured: the per-frame path is the cheaper of the two.
4. Re-open only if measured road density exceeds ~60%, and then re-benchmark with **≥50 passes per arm**, not 3.
5. **Separately worth doing, and orthogonal:** put static content on a second stacked `<canvas>` under the sprite canvas and let the OS compositor own it, redrawing only on mutation. That removes the fixed cost entirely rather than moving it — unlike the bake, which pays it every frame.

---

## 4. Flow-field probe

**0.180 ms p50 per full 5-colour rebuild** (mean 0.184, p95 0.200; n=40 batched samples of 50 rebuilds each; timer quantum 0.020 ms, so ±5.6%). Consistent across 3 independent launches.

24 × 40 grid, 5 colour fields, multi-source Dijkstra with Dial's bucket queue. Per colour field: 0.036 ms. Per cell relaxation: ~37.5 ns.

| Budget | Cost of one unconditional rebuild per tick |
|---|---|
| 60 Hz frame (16.67 ms) | **1.08%** |
| 30 Hz tick (33.3 ms) | **0.54%** |

92 rebuilds per frame would be needed to saturate 60 Hz. **Rebuild unconditionally on dirty; do not amortise across frames.** Amortising buys ~1% and costs correctness.

Spec §5.4's desktop figures (21.5 µs for one field, 31.5 µs for four sources) scale correctly to 0.036 ms/field on mobile WebKit — roughly 1.7× the Node/M-series number, which is a sane WebKit-on-phone ratio. **The flow-field architecture is confirmed.** Spec's instruction *"do not build D\* Lite or LPA\*"* stands.

**Android caveat.** This is pure CPU with no GPU component, so it takes the full CPU multiplier: at 8–15× a Telegram-LOW device would spend **1.4–2.7 ms per rebuild**. At 30 Hz that is 4–8% of a tick — fine. At 60 Hz it is 8–16% of a frame — noticeable but survivable. **This is an argument for keeping the 30 Hz tick, not against the flow-field design.**

---

## 5. Storage persistence

**7 launches over ~3.7 hours**, one iPhone, Telegram iOS Mini App, 2026-08-02. `writeFailed = false` and `readFailed = false` on every launch. `freshContext = yes` on every launch. `localStorage` payload 4096 chars, byte-identical on every survival.

### 5.1 `localStorage` — nondeterministic, not a TTL

| Launch pair | Gap | Outcome |
|---|---|---|
| L1→L2 | 41 s (closed and reopened the Mini App) | survived |
| L2→L3 | 69 s (**force-quit Telegram from the app switcher**) | survived, 4096 chars byte-identical, 110 s since first write |
| L3→L4 | 19 min | **gone** |
| L4→L5 | 25 min | **gone** |
| L5→L6 | 96 min | **survived** |
| L6→L7 | 78 min | **gone** |

`writeFailed` and `readFailed` were false throughout, so storage access itself always worked: the writes were made, the reads ran, the data was simply not there. `freshContext = yes` on 7 of 7 — including plain close-and-reopen — so Telegram iOS destroys the WebView browsing context on **every** close. No in-memory state ever survives, every launch is a cold boot from disk, and the `survived = true` results are meaningful precisely because the context was provably new (see §6).

**Surviving 96 minutes once and dying at 19 minutes rules out a time-based eviction.** There is no horizon at which `localStorage` is safe on this platform, and no save cadence that outruns it. The signature — successful reads and writes, whole-origin data absent, no relationship to elapsed time — points to **OS memory-pressure reclamation: unpredictable and unbounded.**

### 5.2 What happened at launch 4: nothing special

The earlier 4-launch reading of this data treated launch 4 as a single unexplained loss and went looking for a per-event cause. The run notes had blamed a key-namespacing bug (a redeploy changing an asset hash embedded in the storage key); that was correctly refuted then and remains refuted — `spike/src/storageProbe.ts` hard-codes:

```ts
export const PROBE_KEY = 'laneways.m0.probe'
export const CONTEXT_KEY = 'laneways.m0.context'
```

no build hash, `localStorage` is origin-scoped, and `wrangler.jsonc` pins `name: "laneways-spike"` so the Worker URL never moved. What was left standing was a time-based eviction as the leading candidate, and a note that this was the one reading that would invalidate tier 1.

**The full 7-launch series settles it, and launch 4 needs no cause of its own.** It is one of three losses in a series that also contains a 96-minute survival at a *longer* gap. A TTL cannot produce loss at 19 min and survival at 96 min on the same device in the same afternoon. Launch 4 was not an anomaly in an otherwise reliable store; it was the first visible instance of the store's normal behaviour. The question "what happened at launch 4" was the wrong shape of question.

The follow-up that reading recommended — re-run over a ≥1 h gap to catch a time-based eviction — has now been run twice (96 min, 78 min). There is no time-based eviction to catch. Tier 1, as spec §9 originally defined it, is invalidated.

### 5.3 CloudStorage — works

| Launch | Operation | Result |
|---|---|---|
| L6, 16:50 | first write | read ok **187 ms**, write ok **194 ms** |
| L7, 18:08 | read back after **78.5 min** | `survived` **true**, `payloadIntact` **true**, `launches` 2, read ok **155 ms**, write ok **282 ms** |

No errors, no timeouts, no `stored:false` rejections across either launch. Read 155–187 ms, write 194–282 ms (~240 ms typical). One MTProto round trip per key, no batching on writes, no local cache.

**L6→L7 is a controlled comparison** — same device, same 78-minute gap, same launch pair. **`localStorage` lost the record; CloudStorage returned it byte-intact.** That single pairing is the whole basis of the store-of-record decision, and it is worth more than the other six launches combined because nothing else differs between the two arms.

**Fit against the 4096-char cap.** The snapshot sizing measured earlier in this spike — full binary game state **3,809 B raw, 492 B gzipped ≈ 656 chars base64** — leaves about **6× headroom** in one CloudStorage value. The benchmark grid was 43×35; ours is 24×40, so the real snapshot is smaller. The save fits comfortably in a single key, which matters because writes do not batch.

### 5.4 Limits of the evidence

n = 7 launches, **one device, one iOS version, one Telegram build**, one afternoon. **Maximum CloudStorage durability observed: 78.5 minutes, across one launch pair.** Nothing here establishes behaviour over days, across devices, or on Android — including whether `localStorage`'s reclamation behaviour is iOS-specific.

The rate-limit question is entirely unprobed: **two CloudStorage writes were issued in the whole spike.** Nothing was learned about throttling, and no rate limit is documented.

Client version coverage is one build. CloudStorage requires Bot API 6.9+; behaviour on older clients was not tested and must be version-gated rather than assumed.

---

## 6. Three measurement bugs, and why the numbers above are trustworthy

Two were caught by review before the real run; a third of the same class was caught by inspecting the first run's output. All three would have produced confident, wrong, publishable-looking numbers.

**(a) Flow probe vs. the 1 ms clock — caught by review.** The probe originally timed a single ~0.18 ms rebuild with one `performance.now()` pair. WebKit clamps `performance.now()` to **1 ms exactly**. The probe would have recorded a stream of `0`s and `1`s and reported percentiles over them as if they were measurements — a p50 of 0.000 ms reading as "free" and a p95 of 1.000 ms reading as jitter. **Fix:** 50 rebuilds per timed sample, 40 samples, 3 warm-up batches. Quantum drops to 0.020 ms and the reported values (0.180 = 9q, 0.200 = 10q, mean 0.184 = 9.2q) are all exact multiples of it, which is the signature of a correct batched measurement.

**(b) Storage probe could not tell disk from a warm WebView — caught by review.** The original probe reported `survived: true` whenever the record was found. But `survived: true` from a **reused** WebView proves nothing: it may never have touched disk. The probe would have validated the entire tier-1 persistence design against evidence that never tested it — the single highest-value measurement in M0, silently unfalsifiable. **Fix:** a `sessionStorage` sentinel (`checkFreshContext`) reporting `yes | no | unavailable`. Only `freshContext: yes` + `survived: true` is evidence, and that is exactly the combination launches 2 and 3 produced.

**(c) Render benchmark hit the same clock clamp — caught on first-run output, not by review.** The initial run reported every `draw` percentile as exactly `0.000` or `1.000` across all 15 config runs. Same root cause as (a). **Fix:** 20 draws per timed pass with a `getImageData` GPU sync inside the timed region, median of 3 passes (commits `2cebf8b`, `d50674d`). Every reported median is an exact multiple of the resulting 0.050 ms quantum.

**Standing rule for M1's telemetry overlay (spec §10.3):** on WebKit, **any sub-millisecond quantity must be measured over a batch, never a single `performance.now()` pair.** Per-frame timings of sub-ms work are unmeasurable on iOS and will silently report zeros.

**Standing rule before the Android run:** **remove the `getImageData` sync from the harness first.** Chromium disables GPU acceleration for a 2D canvas it detects being read back, at a threshold reported as low as two reads. Ported as-is, the Android run would measure *software* rasterization and wrongly conclude Canvas2D is dead. Replace it with multi-frame rAF percentile measurement.

---

## 7. Decisions forced

| Decision | Answer | Evidence | Status |
|---|---|---|---|
| **Canvas2D or escalate to Pixi/WebGL** | **Canvas2D.** Keep the ~10-method interface so WebGL stays a later option | 400 sprites at 10.5% of frame; ~7,900-sprite ceiling. WebGL attacks draw-call submission (~0.16 µs/call, 41% of a road layer that is 1% of the frame) and leaves the dominant pixel term identical — the same texels, the same blend, the same DRAM traffic. Costs 100–140 KB gzip, shader compile on entry GPUs, and a SwiftShader-fallback risk on exactly the LOW tier | **Confirmed on iOS; provisional pending Android** |
| **Sim tick 30 Hz or 60 Hz** | **30 Hz stands** (spec §3 decision 10 unchanged) | Nothing measured forces 60 Hz. The flow field costs 0.54% of a 30 Hz tick here and an estimated 4–8% on a LOW Android — the halving matters precisely on the device we could not test. Rendering interpolates | **Preserved default, not a resolved question** |
| **Max viable simultaneous cars** | **iOS: not a constraint** (~7,900 draw-limited, range 8k–14k). **Android: unknown.** Design target stays 200–400 | 800 sprites drew in 2.200 ms with zero dropped frames. Android extrapolation puts 400 sprites at ~5 ms central (range 3.3–10.6) *with DPR capped at 2*, and 800 at 8–10 ms — clearing at 400, marginal at 800 | **Provisional** |
| **Save store of record** *(originally framed as "tier 1: `localStorage` or IndexedDB")* | **Telegram CloudStorage.** Project owner's decision, not ours to relitigate. Resume works from CloudStorage alone; `localStorage` is demoted from a tier to a best-effort synchronous last-seconds write that nothing depends on. IndexedDB is *not* the fallback — it is async and cannot run in a teardown handler either | L6→L7 controlled comparison: same device, same 78-minute gap — `localStorage` lost the record, CloudStorage returned it byte-intact (§5.3). `localStorage` loss is nondeterministic, not a TTL (§5.1). CloudStorage read 155–187 ms, write 194–282 ms, zero errors | **Decided. Durability confirmed only to 78.5 min, one device, one iOS version, one Telegram build** |
| **`performanceClass`-gated degradation** | **Yes, and the lever is DPR, not sprite count.** Cap `devicePixelRatio` at **2 universally**, **1.5 on `performanceClass === 'LOW'`** | Fill is the dominant term. A 1080p LOW device at uncapped dpr 2.625 composites 1.96× the pixels of the same device capped at 2 — ~5 ms vs ~8.5 ms at 400 sprites, the difference between clearing and blowing the budget. Zero bytes, largest single lever available | **Adopt now** |
| **Bake the road network** *(not in the original decision list; forced by the data)* | **No. Delete it from spec §6** | §3 | **Decided** |
| **Sprite batching / pre-rotated atlas frames** | **Not now.** ~96% of sprite cost is CPU-side path work, so it is the available lever if sprite count ever binds — but it does not bind at 20–35× the design load | §2 | **Deferred** |

### Conditions attached to the store-of-record decision

1. **The storage key must be a stable, build-independent constant, and the payload explicitly versioned** — in both stores. The launch-4 hash theory never described this code, but the practice is correct regardless: a build-derived key would wipe every player's save on every deploy.
2. **Re-probe CloudStorage over a ≥24 hour gap, and on Android, before M3 ships on it.** The ≥1 hour condition has been discharged (96 min and 78 min gaps); 78.5 minutes remains the longest confirmed CloudStorage survival, on one device.
3. **Probe the write path under load before relying on the autosave cadence.** Two writes total were issued; nothing is known about throttling and no rate limit is documented.
4. **Design the resume path to tolerate a missing save** — start a fresh run cleanly, never a crash or a blank screen. For `localStorage` this is now the *expected* case, not an edge case.
5. **Never treat a missing or stale `localStorage` record as an error.** No warning log, no player-facing message; it is a bonus when present.
6. Spec §9's old fallback (IndexedDB primary, `localStorage` for the synchronous teardown write only) is retired, not shelved: it solves the wrong problem, since IndexedDB is as unusable in a teardown handler as CloudStorage is.

---

## 8. Spec §13 risk disposition

| Risk (spec §13) | Disposition | Note |
|---|---|---|
| iOS WKWebView may not persist `localStorage` across Telegram sessions | **Resolved — negatively** | It does not, reliably. Gone at 19 and 25 min, survived at 96 min, on a stable origin with reads and writes succeeding (§5.1). Not a TTL; nondeterministic. Spec §9's tier 1 is invalidated and rewritten: CloudStorage is the store of record, `localStorage` is a best-effort last-seconds write |
| All renderer throughput evidence is from desktop | **Still open** | Upgraded from desktop-only to one mobile WebKit device. The stated mitigation — "M0 measures on a real low-end Android" — did not happen |
| Weekly demand ramp is unvalidated | **Untouched** | Out of M0 scope; telemetry overlay from M1 as planned |
| `[MOD]` constants are from a 2021–22 decompile | **Untouched** | Out of M0 scope |
| Classic's unbounded run length is hostile to a chat-app session | **Still open, now quantified** | `freshContext: yes` on 7/7 launches — Telegram iOS destroys the browsing context on *every* close, not just on memory pressure. Every launch is a cold boot. Raises the stakes on persistence rather than lowering them |
| CloudStorage has no documented rate limit | **Still open, and now load-bearing** | Two writes were issued in the entire spike, so throttling was never exercised. CloudStorage is now the only durable store, which promotes throttling from an annoyance to save loss. Bound writes by construction: one key, dirty-gated, ≤2/min |
| A balance patch invalidates every stored replay | **Untouched** | `rulesVersion` plan unchanged |
| **NEW — Spec §6's baked road layer is a pessimisation** | **Newly discovered, resolved** | §3. Spec edit required |
| **NEW — `localStorage` loss on Telegram iOS is nondeterministic, not time-based** | **Newly discovered, resolved — supersedes "unexplained loss at launch 4"** | §5.1–5.2. Worse than a TTL: a TTL can be designed around, this cannot. Nothing may depend on `localStorage`. Spec §9 rewritten |
| **NEW — CloudStorage durability confirmed only to 78.5 min, one device, one iOS version, one Telegram build** | **Newly discovered, open** | §5.3–5.4. It is now the store of record, and it is backed by a single 78-minute observation. Re-probe over ≥24 h and on Android before M3 ships on it |
| **NEW — CloudStorage is unavailable below Bot API 6.9, and untested on any other client** | **Newly discovered, open** | §5.4. Version-gate it like every other Telegram surface; below 6.9 there is no durable store at all |
| **NEW — WebKit's 1 ms timer clamp makes sub-ms work unmeasurable per frame** | **Newly discovered, mitigated** | §6. Constrains the M1 telemetry overlay design |
| **NEW — `getImageData` in a harness disables GPU rasterization on Chromium** | **Newly discovered, open** | §6. Must be removed before the Android run or that run is invalid |
| **NEW — Telegram's `LOW` class is far below "budget Android 2025"** | **Newly discovered, open** | §7 note below. Affects what "degrade on LOW" should mean |

**On `performanceClass` as a proxy.** Telegram Android's `SharedConfig.measureDevicePerformanceClass()` averages per-core max frequencies rather than taking the maximum, so a Snapdragon 680 classifies **HIGH** and a Helio G99 / Unisoc T612 classifies **AVERAGE**. `LOW` in practice means Exynos 850 / MSM89xx / sub-2 GB RAM — Galaxy A13/A21s tier, Mali-G52 MP1 and Adreno 505/605. Spec §6's *"degrade on `LOW`"* therefore triggers on a much narrower and much slower population than "cheap phone" implies. If our real floor is a 2025 budget phone, that device reports `AVERAGE` or `HIGH` and gets no degradation at all. **Decide which floor we are targeting before wiring the gate.**

---

## 9. Surprises

1. **The bake is a pessimisation.** The spec called it load-bearing (*"without this, the sprite budget above is meaningless"*). It composites 3.2× the pixels to draw the same roads, is not measurably faster, costs 12 MiB, and is 4.8× slower on any frame containing a road edit — which is the game's core mechanic. §3.

2. **Draw calls are nearly free; pixels are not.** ~0.16 µs per `drawImage` versus ~0.10 ns per device pixel. WebKit batches consecutive blits from one atlas source, so 432 JS calls are not 432 GPU draws. Every draw-call-count optimisation in the spec is optimising the cheap resource.

3. **Sprites are ~96% CPU, ~4% pixels.** A 9.6 CSS px `roundRect` costs 2.0 µs, of which ~0.08 µs is fill. The cost is path construction and per-sprite state, not the GPU.

4. **`performance.now()` granularity is exactly 1 ms.** Two of three probes were unmeasurable as originally written. This is not an iOS quirk to note and move past — it changes how the M1 telemetry overlay must be built.

5. **60 Hz, not 120.** `frame.p50` = 17.000 ms in all 15 runs. Whatever ProMotion the device has is not reaching this WebView. Budget against 16.67 ms.

6. **Telegram iOS destroys the browsing context on a plain close-and-reopen**, not just under memory pressure. `freshContext: yes` on 7/7. There is no warm-resume path to design for on iOS.

7. **`localStorage` on Telegram iOS behaves like a cache, not like storage — and the spec had the tiers backwards.** It survived 96 minutes once and was gone after 19, with reads and writes succeeding throughout. There is no horizon at which it is safe and no cadence that outruns it. The store spec §9 called "tier 1, crash safety" is the unreliable one; the store it called "tier 2, cross-device" is the one that kept the record byte-intact over the identical 78-minute gap. §5.1–5.3.

8. **The fitted ~10 Gpx/s exceeds naive DRAM bandwidth arithmetic** (~80 GB/s implied against an SoC rated near 60 GB/s), which means WebKit elides part of the compositing work. Valid for comparing two paths on this device; invalid as a hardware ratio to scale to Android.

9. **The most valuable output of M0 was not a number.** Two of the three probes were measuring nothing, and both were caught by review rather than by running them — a green run and a plausible-looking table would have produced confident wrong answers in both cases. The third instance was caught only because someone looked at raw output that was all `0.000` and `1.000` and asked why.
