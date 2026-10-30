# Cue programming speed and measurement record

Current delivery state: this chat's disposable lab and its services were stopped at the user's request. Local integration is prepared, not yet claimed applied here; no further console test or plugin reload is part of that preparation. The latest general-PSR reproduction stopped before Finish. See the [portable qualification summary](qualification/2026-10-30.md).

The final-build NVIDIA comparison passed all nine matched twelve-cue samples. Baseline full-state, current full-state and durable tracking whole-job medians were **18.989, 18.972 and 20.250 seconds**. Fewer requests did not make the durable path faster: full native dependency observations still dominate. No material whole-job gain over baseline is established by this workload.

New durable jobs default to 12 cues per batch. The separate earlier Intel matrix passed 27 samples and supports that batch choice: its durable median fell from 60.693 seconds at batch three to 22.729 seconds at batch twelve, while retaining all checks. These are different recorded runs; their elapsed differences cannot be attributed solely to the graphics processor. Neither matrix times lighting design, physical fixtures or the complete brief-to-show workflow.

The preferred large authoring path is `gma3_compile_tracking` → `gma3_programming_job` prepare/run → status → native stored verification → saved-show checkpoint. Batch size trades off repeated preflight work against time until cooperative cancellation; it is measured with identical complete cue states, not picked from an unmeasured multiplier.

## Matched native NVIDIA lab comparison, 30 October 2026

The same disposable rig used twelve static-percent cues at batch size twelve: baseline full-state, current full-state and durable tracking, three repeats each in rotating order. All nine samples passed the same complete native effective stored-state gate. The current compiled source was FINALv4 `315abd2e…1377`; baseline Node `503b9` and current Node used the same imported native plugin `b5a53c86:271751`. Whole-job timing includes startup, preflight, compilation, programming, native post-verification, verified SaveShow and shutdown.

| Method | Whole-job median seconds | Observed range seconds | Native requests per sample |
| --- | --- | --- | --- |
| Baseline full-state | 18.989 | 18.920–19.050 | 743 |
| Current full-state | 18.972 | 18.913–19.356 | 744 |
| Durable tracking job | 20.250 | 20.245–28.723 | 369 |

Durable job phase medians were 10.482 seconds of observation and 6.471 seconds of execution. Its full patch fingerprint requests occupied a median 10.037 seconds. Phase medians need not sum to the whole-job median. One durable sample took 28.723 seconds; it remains in the observed range and raw samples. The durable path emits fewer requests but pays for checkpoint/dependency evidence. The result supports recovery/progress guarantees and the measured batch choice, with **no material whole-job speed gain over baseline**.

Actual NVIDIA process identity was pinned to app 59195 in the verified namespace. Detailed graphics environment, mapped libraries, device descriptors and sysfs identity were observed on the host **before and after** the nine-sample child, and matched at those boundaries. Inside each sample, the harness checked PID/start ticks, boot, namespace and runner continuity; it did not reobserve every graphics mapping or descriptor per sample. Concurrent host load was retained rather than assumed absent. The later strict soak started after this benchmark.

Evidence scope: the accepted timings and private-record limits are summarized in [qualification](qualification/2026-10-30.md). This is a separate final-build NVIDIA run; host load and workload context prevent a causal GPU-versus-Intel speed claim. Physical output, lighting design and larger/richer production shows remain unmeasured.

## Matched native Intel lab matrix, 2026-10-30

The isolated disposable test used grandMA3 onPC 2.5.1.1 under Wine, nine top-level fixtures and twelve static-percent cues. Baseline full-state authoring, current full-state authoring and durable tracking jobs each ran at batch sizes 3, 6 and 12, with three repeats per combination and rotating order. All 27 samples completed and passed the same full native stored-state gate; all effective-state fingerprints matched.

Whole-job seconds below include MCP startup, preflight, compilation, programming, native post-verification, verified SaveShow and shutdown. Each cell gives the median and observed range from three samples.

| Method | Batch 3 | Batch 6 | Batch 12 |
| --- | --- | --- | --- |
| Baseline full-state | 25.501 (22.334–27.841) | 22.887 (22.296–24.306) | 22.884 (19.605–22.907) |
| Current full-state | 26.291 (21.138–26.352) | 23.139 (22.915–23.502) | 23.228 (22.437–24.642) |
| Durable tracking job | 60.693 (58.641–67.197) | 36.319 (34.039–41.932) | 22.729 (21.885–24.329) |

The batch-12 durable median was 2.67 times faster than its batch-3 median, a 62.55% reduction in elapsed time. It was approximately equal to baseline full-state at batch 12; this matrix does **not** establish a broad end-to-end speedup over full-state authoring.

The slow batch-3 durable path spent a median 47.167 seconds observing state and 9.028 seconds executing batches. Each of four batches makes complete fresh before/after observations: eight whole-patch snapshots, or 72 collection fingerprints. In its first repeat, fingerprint RPCs occupied 44.615 seconds; native-reported collection work occupied 44.272 seconds. Fixture types, universe settings and attribute definitions dominated. This is evidence of expensive native traversal/hashing, rather than a diagnosis of network or status-poll overhead. It does not isolate property reads from the hash loop's CPU cost.

At batch 12 the same twelve cues form one batch, with two whole-patch snapshots and eighteen collection fingerprints. Median observation time fell to 11.755 seconds; median execution time was 7.404 seconds. Phase medians need not sum to the whole-job median. No dependency scope, fresh observation, per-cue verification, native stored-state gate or unknown-delivery rule was dropped or cached. The tradeoff is fewer cancellation/resume checkpoints. An explicit smaller batch remains supported, and previously saved journals retain their original option.

Evidence scope: raw matrix records are retained locally and are not distributed. The historical current-source fingerprint was `db0fbf345c296bad20c1e6d358164faa3e71ed554dfabfd18a84a3bf377d2103`; later correctness fixes are in FINALv4 (`315abd2e…1377`). This Intel matrix is retained historical evidence, not a timing of the final build. See [qualification](qualification/2026-10-30.md).

Both Node versions used the same final imported Lua plugin, so this isolates client/workflow behavior rather than plugin versions. A common proxy added the same fresh station/show guard before each mutation; that traffic and tracing overhead are included. The earlier failed read-only connection soak ended before the matrix, with zero overlap; its separate request records retain the long native fingerprint request that overlapped its timed-out ping. Each sample saved but did not reload the show. CPU-heavy regression tests were excluded during the matrix; concurrent host load was recorded. Physical output, rendering, calibrated optics, richer effects, large production rigs and other operating systems remain outside this measurement.

## What the timing evidence says

The recent Night Shift receipts cover 47 cues, numbered 2–48, across 16 authoring calls and 16 saves. The observed span from the first selected store request to the final verified save was 457.949 seconds, about 7 minutes 38 seconds. Authoring calls occupied 453.992 seconds; saves occupied 3.321 seconds. The observed mean span was about 9.74 seconds per cue. This excludes initial design, fixture/preset preparation and later visual qualification. It does not measure the complete brief-to-finished-show experience or establish the reported ten-minute wait's full cause.

Those cues contain 423 looks, nine per cue. Each cue starts by zeroing all 103 lights, then builds the required fixture-group looks. The compiled sequence explicitly has tracking disabled. This explains why each cue does more than a single Store command.

Another receipt records a save refusing an open 3D Viewer Settings dialog in 17 milliseconds. The next resumed authoring call began 292.059 seconds later. That interval belongs to recovery and workflow orchestration, rather than a slow save operation. Reducing save frequency is a weak target: saves occupied less than one percent of the measured main run.

Earlier Rock profiling gives a more detailed execution breakdown. Four complete cues took 17.5524 seconds and 410 serial bridge requests. Programmer scanning occupied 12.595 seconds, about 71.8%; the four actual Store commands occupied 0.064 seconds. That historical measurement excludes creative planning, startup, outer audits, visual checking and saving. Request times include MA API work, response construction, scheduling and transport; they are not isolated Lua or Wine CPU.

Historical production-workflow receipts and compiled plans are not distributed. Their aggregate timings are retained as context rather than a directly comparable benchmark of the synthetic lab workload.

## Changes implemented in this performance pass

**Cheaper fresh environment checks.** A current read-only Rock comparison used six alternating samples per method, after one warmup per method. A complete programmer scan had a median of 866.45 ms, with samples from 858.93–878.32 ms. Reading only Preview/Normal mode had a median of 15.67 ms, with samples from 13.38–29.11 ms. Both reported Normal and complete/available results. The full scan visited 1791 subfixtures and 8557 channels even with zero active programmer values.

The common batch builder now uses the small fresh mode read for environment-only guards. A four-cue test retains three necessary full scans—Normal before/after and proof that Preview is empty—instead of nine full scans. Six environment checks use feedback. An unavailable or malformed feedback capability falls back to complete reads for that call. The private Rock and Night Shift copies already had a similar shortcut; this common-build change is not presented as a new speedup of their historical run.

**Fewer repeated phaser scans.** Preflight coverage is reused within a build only for identical fixture expressions and identical attribute sets. The completed phaser snapshot supplies both coverage and value verification. A three-cue regression reduced targeted scans from nine to four; a compound-fixture case reduced three to two. These are measured request-count reductions, not a newly measured native whole-cue speedup. Complete coverage, cells, metadata and all required row pages remain checked.

**Stop before storing unverifiable looks.** A previous path could continue when verification was unavailable. With verification enabled, both mismatched and unavailable look checks now stop before Store. Faster programming must retain this distinction: an unreadable result is not a proven look.

**Visible client timing and explicit deadlines.** Persistent-session responses now separate MCP startup, waiting between requests and tool-call elapsed time. A line can set an explicit bounded whole-tool deadline. The previous implicit SDK default was 60 seconds, which matters when increasing batch size. A deadline is not cancellation; the client stops before later lines and never replays an uncertain mutation.

## Historical gap inventory and current implementation

| Gap | Why it matters | Concrete development direction |
| --- | --- | --- |
| Full-state cue compilation | The current Night Shift plan resets 103 lights and rebuilds nine looks for every cue | Maintain a canonical desired state, calculate the necessary changes and preserve an explicit initial/base state |
| Tracking provenance | An omitted attribute can inherit; absence is different from zero or release | Record inherited values and their origin cue, relative layers, preset/phaser references and explicit releases; support cue-only and blocking semantics |
| Several verification reads per look | Preset links and values are read after separate operations | Compile the expected final channel/reference state, then combine compatible checks without losing overwritten-preset semantics |
| Unrelated channel reads | A Dimmer verification can traverse other channels on the selected fixtures | Introduce a qualified attribute-filtered reader that skips unnecessary native data reads while retaining complete relevant coverage |
| Repeated pagination work | Each programmer page currently performs a fresh scan | Use a bounded connection/show-bound snapshot and cursor, so pages come from one consistent observation |
| Many individual command round trips | Selection, attributes, phaser steps, Store and metadata each await separate replies | Add a bounded structured command/read operation with per-step results and stop-on-failure; qualify when MA effects become observable |
| Fixed small chunks and timeouts | The API supports up to 100 cues, but the current Night Shift runner uses three; larger chunks can outlive client deadlines | Tune batch size from measurements, expose progress and verified checkpoints, and resume from observed state |
| Agent and recovery delays | A fast authoring call can sit inside a slow conversation/workflow | Time the whole job by phase; execute compiled batches continuously and route only real ambiguities or failures back to the agent |

Offline compilation, persistent connections, batching and project-specific checkpoints already exist. The improvement is to integrate and extend them, rather than rebuild them as if absent. Separate sequences can still have different tracking policies.

## Why tracking needs a state model

Consider a blue wash that remains at 40 percent across three cues. Cue 2 brings on a special at 70 percent; Cue 3 turns that special off. A tracking-aware plan can store the wash once, then store the special's change in each later cue. Cue 3 still needs an explicit off value or the intended release; simply omitting the special would let its previous value continue.

The compiler must also distinguish static values, relative values and running phasers. An effect continuing from an earlier cue is different from deliberately storing or restarting it. A blocked cue stores explicit state to stop earlier edits tracking through; a cue-only edit preserves subsequent behavior. A plain difference between two JSON objects cannot supply all those semantics.

For compiler-owned cues, an intended-state journal can provide provenance. Manual console edits must invalidate or reconcile that journal. The new CuePart reader can retrieve hard stored channels and reconstruct supported sequence-owned tracking. Unsupported native distance formats or ambiguous/incomplete channel data remain explicit limits. Turning Tracking on without a consistent initial state and off/release semantics is still insufficient.

The installed manual covers these mechanisms in `cue_tracking.html`, `cue_tracking_cue-only.html`, `keyword_block.html`, and related Tracking Distance/Shield/Break topics. This pass does not change the existing show's tracking setting.

## Connection latency and retained soak failure

The earlier soak is a failed attempt, not a completed long-session qualification: 26 samples covered 134.733 verified seconds. Its one persistent socket recorded one connection, zero disconnects and one ping timeout. The four-second ping overlapped a 4.671-second FixtureTypes fingerprint request; that is timing evidence consistent with a busy synchronous native handler, not an observed TCP drop. The matched Intel matrix began after that attempt ended, with zero overlap. FINALv4 corrects the status hint so an open but unresponsive socket is not described as an absent plugin. This diagnostic fix does not make the original timeout disappear. The final-build NVIDIA nine-sample comparison and current renderer/process proof passed. The new strict read-only soak passed: 239 samples covered 1,200,047.534537 ms of verified span (1,200,363.277672 ms elapsed), with one connection, zero disconnects and zero timeouts. Station/show/user/profile, bridge generation and module fingerprints stayed stable in that observation window. The native workload was idle apart from the declared read-only checks; host load was retained. This does not establish responsiveness during heavy native work or after a later show/plugin generation change. [Passed report](qualification/2026-10-30.md), [all samples](qualification/2026-10-30.md). The post-reboot route and eleven-section persistence checks also passed. Later general-PSR reproduction show loads are separate from that accepted soak generation/window.

## Qualification protocol for the current implementation

The desired-state/provenance compiler, native CuePart read, durable job engine, filtered/snapshotted reads and native bounded batches now exist in source. Compare the unchanged baseline full-state method, the new full-state method and the new delta job against the same complete states on the same disposable rig. Rotate run order, retain all samples and include startup, identity guards, Store, native postconditions, cleanup and Save. Report request counts and whole-job elapsed time separately from isolated read latency. Do not run the CPU-heavy regression suite during that comparison.

Cancellation, external-edit refusal, reload checkpoints and a persistent-session soak are correctness gates. Any native failure remains in the record. Physical fixture response, calibrated optics and other operating systems need independent observations.

Earlier reduced preset-link response and reference-pruning experiments failed their declared speed gates and were reverted. They remain rejected; this pass does not relabel them as successful optimizations. New native whole-cue speed claims need a matched disposable-show benchmark. That earlier performance-only pass did not mutate shows. The current comprehensive qualification uses a dedicated isolated lab; physical output remains unverified.
