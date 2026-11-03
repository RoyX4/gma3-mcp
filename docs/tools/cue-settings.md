# Existing cue and part settings

`gma3_cue_settings` reads the real settings of an existing Sequence, Cue and Cue Part.
`gma3_configure_cue` changes requested Cue and Part properties and checks their readback. These tools edit
existing show objects; they do not need a new tracking plan or a new Store.

**Tracking on/off belongs to the Sequence.** Use `gma3_configure_sequence` with `tracking: true` or `false`,
as shown in [playback configuration](playback.md#tracking-and-sequence-policy). A cue's Tracking Distance is a
separate Part setting. The offline [tracking compiler](tracking.md) describes desired fixture content and
restoration; it is not the switch for an existing Sequence's Tracking property.

| Task | Tool |
| --- | --- |
| Read Sequence policy, Cue flags and Part settings | `gma3_cue_settings` |
| Edit existing Cue flags and Part command, transition, tracking endpoint or MIB settings | `gma3_configure_cue` |
| Edit Sequence Tracking, first-cue Release, command policy or MIB policy | `gma3_configure_sequence` |
| Edit fade/delay or trigger type/time | `gma3_set_cue_timing`, `gma3_set_cue_trigger` ([cue tools](cues.md)) |
| Read actual stored fixture/attribute data and reconstructed inherited layers | `gma3_native_cue_data` ([native cue data](native-cues.md)) |

## Target and read result

Both tools use an explicit target:

| Parameter | Type | Meaning |
| --- | --- | --- |
| `data_pool` | optional integer 1–9999 | Defaults to the current data pool. |
| `sequence` | integer 1–99999 | Existing Sequence number. |
| `cue` | positive number or numeric string, at most three decimal places | One Cue, such as `3`, `2.5` or `"10.001"`; no range or selected-sequence shortcut. |
| `part` | integer 0–999, default 0 | Existing Cue Part; Part 0 is the main part. |

For example, call `gma3_cue_settings` with:

```json
{"data_pool":1,"sequence":401,"cue":3,"part":0}
```

It returns `target`, `sequenceSettings`, `cueSettings`, `partSettings` and explanatory `notes`.
Settings retain native property names and native Edit-role representations. A missing value is `null`,
not an assumed default, false or zero. A missing Sequence, Cue or Part is an error; no object is created.

The Sequence read includes `Lock`, `Tracking`, `ReleaseFirstCue`, `CueCommand`, `SequMIB` and `SequMIBMode`.
The Cue read includes its lock, number, `Break`, trigger type/time and the Cue fields below. The Part read
includes its lock, number, fade/delay fields, `Duration` and the Part fields below. This is a settings read,
not a scan of fixture hard data or a measurement of playback output.

## gma3_configure_cue

In addition to the target, supply `cue_settings`, `part_settings`, or both. At least one nested setting is
required. `preview` defaults to `false`. Unknown setting names and invalid enum choices are rejected.
There is no `unlock` or optional `verify` argument: this tool refuses locked targets and always checks
setter replies and the requested final settings.

`cue_settings` applies to the **whole Cue**, even when `part` is greater than zero:

| Field | Accepted value | Native property |
| --- | --- | --- |
| `release` | `"default"`, `"yes"` | `Release`; `default` clears the explicit flag. |
| `assert` | `"none"`, `"assert"`, `"x_assert"` | `Assert`; `none` clears it, `x_assert` writes `X-Assert`. |
| `allow_duplicates` | boolean | `AllowDuplicates`; false clears the flag. |
| `mib_preference` | `"never"`, `"worst"`, `"bad"`, `"normal"`, `"good"`, `"best"` | `MIBPreference` |
| `note` | string, at most 1024 characters | `Note`; trimmed, and an empty string clears it. |
| `trigger_sound` | `"All"`, `"Bass"`, `"Mid"`, `"High"`, `"Band1"`…`"Band7"`, or their `Inv` forms | `TrigSound`; does not change the trigger type. |

The exact inverted sound choices are `InvAll`, `InvBass`, `InvMid`, `InvHigh`, and `InvBand1` through
`InvBand7`. Use `gma3_set_cue_trigger` separately to set a Sound trigger.

`part_settings` applies to the selected **Part**:

| Field | Accepted value | Native property |
| --- | --- | --- |
| `name` | nonempty validated name, at most 200 characters | `Name`; Part 0 supplies the cue's main name. See [name restrictions](cues.md#common-behaviour). |
| `tracking_distance` | positive cue number/string, or `"none"` | `TrackingDistance`; an inclusive ending cue number, not a cue count. |
| `command` | one command line, at most 1024 characters | `Command`; trimmed, balanced quotes, no control characters; empty clears. |
| `command_enabled` | boolean | `CommandEnabled` |
| `command_delay` | finite seconds, 0–3600 | `CommandDelay` |
| `transition` | `"linear"`, `"slow"`, `"slow_plus"`, `"fast"`, `"fast_plus"`, `"s_curve"`, `"swing_minus"`, `"swing"`, `"swing_plus"` | `Transition`; respectively Linear, Slow, Slow+, Fast, Fast+, SCurve, Swing-, Swing, Swing+. |
| `mib_mode` | `"default"`, `"none"`, `"defined"`, `"early"`, `"upon_go"`, `"late"` | `MibMode` |
| `mib_target` | positive cue number/string | `MibTarget`; must be supplied together with `mib_mode: "defined"`. |
| `mib_fade`, `mib_delay` | finite seconds, 0–3600, or `"default"` | `MibFade`, `MibDelay`; use the string for the native Default value. |
| `mib_multistep` | `"paused"`, `"running"` | `MibMultistep` |

First inspect a plan with `gma3_configure_cue`:

```json
{
  "data_pool":1,"sequence":401,"cue":3,"part":0,
  "cue_settings":{"assert":"x_assert","note":"Temporary change"},
  "part_settings":{"tracking_distance":4,"transition":"s_curve"},
  "preview":true
}
```

`preview: true` reads the target and locks, then returns `before`, the requested native-property `plan`,
and `notes`. It sends no writes and does not switch the console into its Preview environment. Apply the
same call with `preview` omitted or `false`. The apply result contains the shared `OperationResult`
(`outcome`, `steps`, `verification`) and `before`/`after` settings when available.

For a defined MIB target, both fields belong in the same call:

```json
{
  "data_pool":1,"sequence":401,"cue":3,
  "part_settings":{"mib_mode":"defined","mib_target":2,"mib_fade":1.5,"mib_delay":"default"}
}
```

A target without `defined`, or `defined` without a target, is rejected. This pairing validates the request;
it does not prove that the named target cue exists or that physical movement will occur.

## Explicit Release and inherited Release

`release: "yes"` sets the Cue's explicit Release flag. `release: "default"` clears that explicit flag;
it is not an explicit instruction to disable every effective Release behavior. In particular, a first
cue can still inherit Release from the Sequence's `release_first_cue: true`.

The tools read the native **Edit** role so these states stay distinct. For example, the first cue's
explicit `Release` can read `""` while the console's display shows `<Yes>` inherited from `ReleaseFirstCue`.
Inspect both `cueSettings.Release` and `sequenceSettings.ReleaseFirstCue`. To change the Sequence policy,
use `gma3_configure_sequence`; `release: false` and `release: "no"` are not accepted cue settings.

Cue Release clears incoming tracked state before that cue's own hard data is applied. It differs from
an attribute-specific release value stored in a cue, which relinquishes that attribute/layer only.
See [native cue data](native-cues.md) and [tracking changes](tracking.md#change-types).

## Tracking Distance and policy overrides

`tracking_distance: 4` means that this Part's temporary values can track **through Cue 4**. It does not
mean “four cues after this one.” The endpoint may be a fractional cue number and need not itself exist.
After the endpoint, the preceding still-valid value can resume. `"none"` clears the endpoint. Delta syntax
is not supported by this tool. Read back the stored endpoint and inspect [native cue data](native-cues.md)
when checking resulting inherited fixture state.

MIB means Move In Black: preparing non-dimmer attributes while the fixture is dark. The stored Part mode
and the Cue's MIB preference are inputs to that behavior. Sequence `mib_policy` can suppress or force MIB;
`mib_default_mode` supplies the mode for Parts set to `"default"`. A confirmed property write therefore
does not prove that a fixture moved. See [Sequence policy](playback.md#tracking-and-sequence-policy).

Similarly, `command_enabled: false` is the Part's setting. Sequence `cue_command: "force_yes"` can override
it, while `"force_no"` suppresses cue commands. Setting `command` stores text; this call never executes
that text. During apply, referenced `$variables` must be readable and exist as user or global variables.
Preview validates command syntax but does not perform that variable-existence check.

Clearing `command` makes `CommandEnabled` unavailable. Omit `command_enabled` when clearing the
command. Likewise, MIB mode `none` hides its fade/delay/multistep fields: reset those while MIB is
active, then disable it in a separate call. Contradictory combined requests refuse before console work.

## Checks, refusals and remaining gaps

- All three objects must exist, and Sequence, Cue and selected Part locks must read as unlocked. A locked
  or unavailable lock refuses the edit before writes. This tool never unlocks them automatically.
- Missing setting values remain unavailable. An unreadable current setting is not treated as already
  matched; if a setter is sent, its reply must confirm the requested value. A missing readback leaves the
  step uncertain. The tool stops after the first failed or uncertain write and never resends it.
- Requested values already matched at preflight are skipped. The final read compares **every requested
  field**, including those initially unchanged, so coupled setters cannot silently invalidate the request.
- Calls are serialized with this server's mutation lock, including preview. Other operators, macros or
  MCP servers can still change the console; this is not an atomic console transaction.
- No Store, programmer change, Goto, Go, Load, playback command or Save is sent. Existing fade/delay and
  trigger edits remain in the [cue tools](cues.md). Changing live show properties can affect later playback.
- `Break` is readable, but assigning a Filter/World handle is not implemented here. `Duration` is read-only.
  Delta Tracking Distance is also unsupported. None is accepted as a configure field.
- Block, CueOnly and Tracking Shield are programming actions or Store options, not editable cue boolean
  flags. This settings API does not implement those native actions. The owned tracking compiler's `block`
  and `cue_only` modes have their separate, bounded [semantics](tracking.md#execution-and-current-limits).

Representative native checks on an isolated grandMA3 onPC 2.5.1.1 show confirmed Tracking off/on; Cue
Release yes/default; X-Assert/none; duplicate flags on/off; MIB preference good/normal; note set/clear;
Tracking Distance endpoint 4/none; SCurve/Linear transitions; stored command text, disable and delay;
and Part MIB early, fade, delay and multistep pause. Each of the five additional Sequence settings
fields in [playback configuration](playback.md#gma3_configure_sequence) was changed and restored with
readback. These are representative setting checks, not coverage of every enum combination, proof of
physical movement, or qualification of a future build.
