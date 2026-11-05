# Programming completion, 4 November 2026

The work covers the programming path, scoped edits to existing cues, native tracking controls and
larger native checkpoints. Qualification used grandMA3 onPC 2.5.1.1 in the isolated software lab.
Physical checks and show merging were deferred.

## Programming time

An interleaved six-sample comparison ran the previous and candidate programming paths against the
same console generation and fixture workload. Each sample created eight static looks, renamed and
retimed those cues, then merged eight colour changes. The before and after paths checked the
programmer before Store. The native trace separates command setup, Store, identity and programmer
reads. The timing begins at the workflow call and ends at its verified result.

| Eight-cue workload | Previous median | Candidate median | Native requests per sample |
| --- | ---: | ---: | --- |
| Create | 9.287 s | 5.210 s | 205 to 94 |
| Metadata edit | 1.432 s | 1.772 s | 50 to 50 |
| Colour merge | 6.405 s | 3.810 s | 151 to 88–89 |

All three candidate create samples and all three candidate colour merges were faster than the
fastest corresponding baseline samples. The metadata ranges overlapped and that path retained
the same request count. Host load was high and variable. A separate before/after run across
different load conditions is retained as inconclusive. These measurements cover the console
workflow with exact identity guards and receipts. Time spent by an AI preparing the request
or waiting between requests was outside the measurement.

The bridge now groups adjacent static Preview commands in one request. It validates the entire
series first, checks context and Preview before each command, retains each receipt and stops on
uncertain feedback. The existing programmer check precedes Store. Presets, phasers, releases,
relative values and individual timing retain their existing checked command path. An older bridge
uses individual commands.

## Native edits and large checkpoints

- Scoped colour edits changed two existing cues while preserving Dimmer and restoring the
  original colour in the following cue. Scoped edits to Part 2 passed with Cue Only for one cue
  and for consecutive cues. The consecutive case preserved its unrelated Zoom value.
- Block/Unblock materialized and removed the selected static Dimmer value with matched stored
  and effective readback. World and static Filter Break assignment and clearing passed.
  A relative distance was stored as native `Δ +2`. The model tests cover expiration and restoration.
- A native sequence with 503 authored cues and two internal cues produced a complete checkpoint
  with matched compiler-owned state. Its frozen pages returned 200, 200 and 105 objects.
  The first live attempt revealed that internal OffCue and CueZero main parts lack the Part
  property. Their exact native identity is now recognized and covered by a regression.
- The durable job runner created and verified 501 cues from an absent sequence in six batches.
  The plan contained one explicit Dimmer look followed by holds. The entire job took 154.19 seconds
  and reached a matched final native checkpoint.
- Native inspection returned per-function channel details. A stored Pan value of 25 percent
  retained its individual 1.5-second fade and 0.25-second delay.

The consolidated source includes the Rock individual timing, channel-function and executor
alias fixes, plus Night Shift's descending physical Zoom conversion for programmer readback.
The latter is covered by captured-data regressions.

The console returned `Not implemented` for the tested explicit Part form of native Block.
The action uses the verified cue-level command with a static main-part scope. Unknown layer
precedence, preset/phaser Block semantics and excessive native capture size are reported
explicitly. Private show-building assets and app routes are maintained in their own projects.
