# Scoped value edits in existing cues

`gma3_edit_cue_values` applies one fixture look to selected existing cues and one existing part per cue. It uses grandMA3's scoped Merge Store with an explicit fixture and attribute filter. This limits the Store when setting an attribute activates its whole feature group.

Give one sequence number and one of `cues`, `from` with `to`, or `all: true`. A range includes the existing cues between both endpoints. An explicit list requires every named cue to exist. Specify `part` when editing a part other than the main part 0. Each call supports up to 100 cues and 512 resolved fixture IDs. Fixture selections use explicit IDs, ranges and dotted cell IDs.

For example, this preview sets the RGB channels in Cues 10 through 20 for Fixtures 101 through 112. Dimmer remains outside the Store scope.

```json
{
  "sequence": 7,
  "from": 10,
  "to": 20,
  "fixtures": "101 Thru 112",
  "part": 0,
  "values": [
    {"attribute": "ColorRGB_R", "value": 0},
    {"attribute": "ColorRGB_G", "value": 0},
    {"attribute": "ColorRGB_B", "value": 100}
  ],
  "tracking": "cue_only"
}
```

Values use percent and default to the absolute layer. Specify `layer: "relative"` for a signed relative value. Add `intensity` for an explicit Dimmer change. You can also recall ordered presets using `presets: [{"pool": 4, "preset": 12}]`. The tool needs readable native preset attribute and layer coverage. It excludes preset Dimmer from the Store filter unless the request explicitly changes Dimmer.

Choose `tracking_forward` when the new values should carry into later cues. Sequence Tracking must already be enabled. Preview lists potentially affected later cues based on native stored layers, cue releases and tracking distances. Temporary overrides can expire and expose a prior edit again, so the list is conservative.

Choose `cue_only` when the selected cues should change while other cue looks retain their sequence-owned values. grandMA3 can add restoration values to the following cues. Preview lists the restoration candidates and the final read checks that values outside the selection were preserved.

## Apply a preview

Send the same request with `preview: false` and `exclusive: true`. Pass the preview's `fingerprint` as `expected_fingerprint` to require the same observed cue and preset state. The tool checks the sequence, cue and part locks before applying. Store preferences must be Programmer, Active, Look Off and Tracking Shield Off. The call uses Preview to build the look and checks the Normal programmer before and after.

Each Store addresses the selected part and verifies the resulting native hard data before continuing to the next cue. The final check compares protected stored layers and their inherited values and sources. Cue Only additionally checks that the selected channels outside the edit retain their effective values. If a Store is unconfirmed, the report shows the last attempted cue and leaves the remaining cues unattempted.

Readable native Part identities and cue data are required. A legacy bridge can identify a proven singleton main part. Native multipart reads require the maintained bridge when legacy results omit Part numbers. Unsupported native reconstruction, unresolved Break effects in a tracking-forward preview and ambiguous movement of a layer between parts prevent apply. These are sequence-owned values. Stage output also depends on playback priorities, masters and fixture behavior.
