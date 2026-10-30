# Owned tracking cue plans

`gma3_compile_tracking`, `gma3_explain_tracking_cue`, `gma3_compare_tracking_cues` and `gma3_lint_tracking` are offline tools in `src/tools/tracking.ts`. They perform no bridge requests, change no selection and send no console commands. A complete desired plan is their source. Native stored data and actual stage output are separate evidence; use the native cue-data and output inspection tools for those.

The compiler keeps what each fixture's attribute and layer should contain, remembers which cue introduced it, and stores only the changes needed at the next cue. For example, a front wash at 40% across ten cues needs one stored value followed by inherited state. An explicit hold stores an empty cue; it does not write the front wash ten more times.

## Plan format

```json
{
  "version": 1,
  "sequence": 401,
  "sequence_name": "Owned scene",
  "cues": [
    { "cue": 1, "name": "Opening", "changes": [
      { "kind": "value", "fixtures": "101 Thru 112", "attribute": "Dimmer", "value": 40, "unit": "percent" }
    ] },
    { "cue": 2, "name": "Dialogue continues", "hold": true },
    { "cue": 3, "mode": "cue_only", "changes": [
      { "kind": "value", "fixtures": "101 Thru 112", "attribute": "Dimmer", "value": 70, "unit": "percent" }
    ] },
    { "cue": 4, "name": "Back to dialogue", "hold": true },
    { "cue": 5, "mode": "block", "changes": [] }
  ]
}
```

Cue 1 writes 40%, cue 2 writes no fixture value, cue 3 writes 70%, cue 4 explicitly restores 40%, and cue 5 materializes the owned state. A hold after a cue-only change can therefore need restoration data; `hold` describes the desired cue rather than promising an empty compiled delta.

| Plan field | Meaning |
| --- | --- |
| `version` | `1`; versioned serialization and interpretation |
| `sequence`, `data_pool`, `sequence_name` | Explicit destination; optional data pool and name |
| `cues` | Unique ascending cue numbers, up to 10,000; playback order is significant |
| cue `name`, `fade`, `delay`, `out_fade`, `out_delay` | Optional name and timing in seconds |
| cue `trigger`, `time` | Trigger; time/follow require an explicit time in seconds |
| cue `mode` | `tracking` (default), `cue_only`, or `block` |
| cue `hold` | Explicitly no desired changes; incompatible with changes or another mode |
| cue `changes` | Ordered explicit changes; later changes to the same fixture/attribute/layer win |

Fixture targets are fixed IDs, subfixture IDs, ranges and `+`, such as `"1 Thru 10 + 15.2"`. Groups and the current selection are refused because their membership can change. Resolve their actual fixture IDs first. A target change supports at most 10,000 fixtures, plans at most 200,000 requested assignments and 1,000,000 materialized effective-state cells. These are resource bounds, not a promise that every such plan fits one console call.

## Change types

| `kind` | Additional fields | Meaning |
| --- | --- | --- |
| `value` | `attribute`, `value`, `unit`, optional `layer` | An explicit static value; default unit percent, default layer absolute |
| `off` | `attribute:"Dimmer"`, optional `layer` | Explicit zero Dimmer; it keeps this sequence's control |
| `release` | `attribute`, optional `layer` | Relinquish sequence control; never replaced by zero or `Off Attribute` |
| `preset` | `pool`, `preset`, `attributes` | Preset reference with declared complete attribute coverage |
| `phaser` | `phaser`, optional `restart` | The explicit step/phaser object accepted by `gma3_store_cues`; unchanged definitions carry unless restart is requested |

Every change includes `fixtures` and may include a provenance `note`. Absolute and relative layers have independent state. Relative static values require explicit percent or physical units for verified execution; signed relative percent is -100..100. The existing storage tool checks a relative layer with the same step/layer verifier used for phasers.

Omission inherits; zero is a real value; release gives up control. A release can reveal another sequence, defaults or other playback behavior. This model does not invent the resulting stage output.

Preset coverage is an explicit declaration, not a guess from its label. If a preset recall would overwrite an inherited static override inside that coverage, the compiler also emits that override after the recall. A preset can activate sibling attributes, so inspect its native data and fixture activation behavior before relying on its declared coverage.

The phaser definition retains all steps and layers. Unchanged carried phasers are omitted rather than reapplied. An explicit restart emits the definition again; native playback phase and restart behavior still require console qualification. A block that would restart a carried phaser without permission is blocking lint. Incompatible partial phaser overrides and mixed static/phaser layers of the same attribute are refused instead of being flattened.

## Tools and results

`gma3_compile_tracking({plan, detail?, include_serialized?})` returns the exact structured store payload, blocking/warning lint, stable plan/state/delta fingerprints and assignment/look/hold counts. `detail:true` includes every effective cell and emitted delta; `include_serialized:true` includes canonical JSON. The compiler groups identical fixture content into one look. The existing store limit of 16 looks per cue still applies.

`gma3_explain_tracking_cue({plan|job_id, cue, fixture?, attribute?, offset?, limit?})` returns each owned cell's introducing cue/change, note, whether it inherits and whether the compiler emits it here. Default page size is 200, maximum 2,000. It reads saved job intent when `job_id` is used.

`gma3_compare_tracking_cues({plan|job_id, from, to, offset?, limit?})` compares effective owned states, preserving release, preset, phaser and layer distinctions. Equal state can still have different timing or provenance. `gma3_lint_tracking({plan})` returns the same lint without the full store payload.

Fingerprints use SHA-256 over deterministic, sorted-key JSON. Provenance is excluded from effective-state fingerprints. Editing desired JSON changes its plan fingerprint. Native manual edits do not silently rewrite desired provenance: the [durable job](jobs.md) checks its native checkpoint and stops on drift. `invalidate` explicitly marks a known manual change.

## Execution and current limits

Compilation is not execution. Prepare and run a [durable programming job](jobs.md), which executes the compiled payload through the existing guarded Preview storage path with verification required and Tracking enabled. New jobs require an absent or empty sequence; this prevents a desired chain from silently inheriting arbitrary existing cues.

Layer-specific stored releases were qualified on isolated native 2.5.1.1: `Attribute "Dimmer" At Absolute Release` and `At Relative Release` produce native `abs_release`/`rel_release` flags, with distinct stored layer flags. The tool requires the normalized native release marker and the matching active-value mask (absolute bit 2, relative bit 4) on a complete target scan before Store. Old inactive release data is not proof, and the raw numeric special value is never guessed in TypeScript. An older bridge without these markers fails closed. `Off Attribute` removes programmer content and is not an equivalent implementation. Cue-only restoration of a newly introduced cell now emits the explicit release needed to stop it tracking.

Blocks are materialized only over owned state. They do not freeze unknown channels from other sequences or become a native all-channel Block command. This first compiler does not adopt or partially overwrite existing native cue chains. Recompiling an owned plan is supported; applying an arbitrary patch over a manually edited chain is not silently attempted.

## Checks and console qualification

Run `node --import tsx --test test/tracking-*.test.ts` and `npm run build`. Tests cover inherited holds, zero versus release, signed layers, preset action closure, cue-only restoration, blocks, phaser carry/restart, serialization, scope errors and fail-closed verification.

On a disposable show, author a few explicit values, hold and cue-only restoration into a reserved unused sequence. Inspect stored native data before playback, prove an empty hold has no hard values and the intended inherited state, check absolute and relative layers independently, then observe the sequence. Qualify release and phaser phase behavior separately. This procedure mutates only the chosen test sequence and Preview programmer; no live procedure is run by the offline tests.
