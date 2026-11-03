# Native cue settings follow-up, 4 November 2026

The current scope is existing-cue editing and actual Sequence/Cue/Part settings. Physical checks
and PSR/show merging are deferred. Only this chat's disposable Roy-McpLab instance was used;
other instances were neither changed nor closed. Native software was 2.5.1.1. No show Save,
playback or output enabling was performed. Lab objects remain unsaved.

## Verified observations

At source `d0aaa60ca5ea78f0cc861294713081ed1c8003eb052c06f41f254791381638e5`, eleven
configuration calls succeeded with matched final requested settings:

- Sequence Tracking off/on.
- Cue Release yes/default, Assert X-Assert/none, Allow Duplicates on/off, MIB preference good/normal,
  note set/clear, tracking endpoint 4/none and transition SCurve/Linear.
- Sequence command policy, MIB policy/default, Prefer Cue Appearance and CueZeroMode change/restore.
- Part command text, disabled command execution and delay; MIB Early with numeric fade/delay and
  paused multistep; Defined target Cue 2; default fade/delay and running multistep; then MIB None.

All requested final fields were read in the native Edit role. Normal programmer scans before/after
were empty with complete coverage. This qualifies representative stored settings, not all combinations
or physical movement. The reader preserves unavailable properties as null.

At source `bbc0cc19c2f0172cd5e10343cef251eadc8dabd55252593469f77602bc08515f`, a separate
explicit-look Store test created two three-cue lab sequences and then merged Cue 1:

| Operation | Before | Observed after |
| --- | --- | --- |
| Cue Only On | Dimmer 40 in Cue 1; Cues 2/3 empty | Cue 1 stored 70; Cue 2 gained restoration 40 |
| Tracking Shield DAZ | Pan 10 with Dimmer 0 in Cue 1; Dimmer 100 in Cue 2 | Editing Cue 1 Pan to 50 inserted Pan 10 restoration into Cue 2 |

The checks read actual native hard channels, with numeric tolerance 0.0001 for native float encoding.
The new Store option paths are unchanged between the two listed sources; the later source adds
preflight rejection of contradictory inactive-MIB/empty-command settings. Native checks do not establish
every CueOnly/Shield mode or multipart interaction. Ordinary Store tool metadata verification explicitly
does not claim that it verified following-cue restoration.

## Failure cases retained and corrected

An initial inventory fixture assumed that AllowDuplicates was Yes/No. Native metadata and an ignored
clear showed it uses Yes/blank. The correction sends blank for false, and the setter failure stopped
subsequent writes. Regression checks preserve that behavior.

Disabling MIB makes subordinate timing/multistep fields unavailable. A combined disable/default reset
therefore reported partial/mismatched, rather than success. Such contradictory requests now refuse
before console work; qualified reset first changes the active settings, then disables MIB separately.

An exploratory Store run followed a failed TypeScript build and is excluded from final qualification.
Its commands succeeded, but the private harness then compared float values exactly and failed. The
final Store run used a successfully stamped build, fresh absent targets and explicit float tolerance.
The private runner now refuses stale/partially emitted builds before making a console connection.
Receipts for all passes/failures remain in the private qualification workspace; no uncertain Store
was replayed. These observations are separate from the historical full deployment manifest.

## Remaining boundaries

The integrated candidate passed 1,275 Node tests with zero failures, cancellations or skips, all 20
maintained standalone Lua suites, TypeScript/build and consumer tarball smoke. Fresh packaged discovery
found 150 unique tools, including both cue-settings tools, with zero native connections or OSC packets.
The first local gate lacked the already available private Lua runtime; it is retained as a failed
environment check. The final gate explicitly supplied that runtime and ran every skipped Lua-backed test.

Break Filter/World assignment, native Block/Unblock wrappers, delta Tracking Distance and comprehensive
multipart reconstruction remain unimplemented in the typed settings API. Duration is read-only.
Automatic adoption of arbitrary existing cue chains into owned compiler jobs and native pagination
beyond the checkpoint limit remain separate gaps. Refer to [cue settings](../tools/cue-settings.md)
and [tracking coverage](../tracking-status.md).
