# Tracking: what is built and what remains

Core tracking is implemented for complete cue chains authored through the MCP's owned-plan workflow.
Full coverage of every existing show, native tracking feature and playback interaction remains unfinished.
The compiler, native reader and stage output each answer a different question.

## How an owned cue chain works

The plan declares the desired state of each explicit fixture attribute. The compiler remembers where
each value came from, carries unchanged values forward and emits only the changes needed for each cue.
The job runner stores those changes, checks actual stored native content and saves a durable checkpoint.

| Cue | Desired instruction | Compiled result |
| --- | --- | --- |
| 1 | Front wash at 40 percent | Store 40 percent |
| 2 | Hold | Store an empty cue; inherit 40 percent |
| 3 | Cue-only change to 70 percent | Store 70 percent here |
| 4 | Hold the ongoing scene | Explicitly restore 40 percent |

Zero Dimmer keeps this sequence's control at zero. Release gives up its control and can expose other
playbacks or defaults. Omitting an attribute lets the preceding sequence-owned value track forward.
Those are separate operations.

## Implemented paths

- Absolute and relative layers, explicit values, zero/off, release, holds and cue-only restoration.
- Blocks over the declared owned state, preset references and supported phaser carry/restart intent.
- Explanations of inherited values and their source cue, cue comparisons, lint and stable fingerprints.
- Guarded Preview storage with Tracking enabled, native stored-value checks, checkpoints, progress,
  cancellation and verified resume. Manual edits or changed identity stop continuation.
- Reading supported existing native cue/part values and sequence-owned inheritance, including supported
  numeric Tracking Distance endpoints. This reading does not silently adopt the sequence for editing.

The [plan/tool reference](tools/tracking.md), [native reader](tools/native-cues.md) and
[durable jobs](tools/jobs.md) describe the exact formats and supported scope.

## Corrections from the tracking review

Overlapping presets now follow coverage dependencies, so attribute sorting cannot reverse their recall
order. A desired combination with no valid order is blocking lint. Phaser attribute names are trimmed
and normalized across a plan; duplicate aliases in one step are refused. A harmless spelling change
between cues therefore does not restart a carried effect or turn it into an empty hold.

Stored phaser comparison checks every case-equivalent step attribute. Unreadable native numbers cannot
become zero, master 1 or a valid preset identity through JavaScript coercion. Cue inspection no longer
attaches missing part numbers to Part 0 or calls malformed part data complete. Query tools validate cue
notation. Compact compiler responses use each cue's existing counts instead of searching the whole
cue list twice per cue.

These fixes have offline regression checks and separate native follow-up observations. They do not
replace the earlier full qualification manifest.
Older saved jobs whose compiled payload or normalized plan changes will fail their integrity check;
their journals are retained. Prepare a reviewed new plan for the remaining work rather than rewriting
old receipts or replaying uncertain mutations.

## Remaining tracking gaps

| Area | Current boundary |
| --- | --- |
| Existing-show editing | [Scoped cue range edits](tools/cue-range-edits.md) apply values to explicit fixtures, attributes, cues and parts. Preview lists potential downstream impact. Apply checks native content after each Store and verifies protected stored and inherited layers. Owned compiler jobs still require an absent or empty sequence. |
| Large chains | Maintained native checkpoints assemble frozen pages, up to 10,002 cue objects including internal cues. Dense cue data and time, part, byte and reconstruction limits still apply. Large jobs check paging support before writing. |
| Native tracking controls | Sequence Tracking, Cue Release/Assert, Break World/static Filter and absolute/relative part Tracking Distance are configurable. Native Store Cue Only/Shield options are separate operations. Duplicate parts are evaluated per layer only with confirmed Allow Duplicates and supported distance semantics. |
| Blocks | [Native Block/Unblock](tools/cue-tracking-actions.md) supports scoped static main-part data and compares effective and stored values. The console refused the tested explicit Part Block form. Complex unsupported cells remain outside this action's scope. |
| Effects and units | Actual phase continuity, restart/distribution, richer repetition and physical-unit conversions need the stated native calibration/qualification. Unsupported comparisons remain unavailable. |
| Stage output | The winning mix of sequences, priorities, masters, fades, programmer and hardware output is outside the sequence-owned tracking model. |

The [tracking review qualification](qualification/tracking-2026-11-04.md) separates automated checks,
native follow-up observations and the historical full baseline. The user authorized resuming only
this chat's lab. PSR/show merging and physical checks are deferred from the current cue-settings scope.
