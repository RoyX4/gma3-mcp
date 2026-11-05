# Scoped native Block and Unblock

`gma3_cue_tracking_action` applies native Block or Unblock to selected existing cues, fixture IDs and
attributes. Block materializes an inherited value in the cue. Unblock removes a native block when the
same value can come from the preceding cue again. The tool verifies the stored data and reconstructed
sequence values after each command. [MA Block](https://help.malighting.com/grandMA3/2.5/HTML/keyword_block.html) · [MA Unblock](https://help.malighting.com/grandMA3/2.5/HTML/keyword_unblock.html)

| Parameter | Meaning |
| --- | --- |
| `data_pool` | Optional explicit data pool number. |
| `sequence` | Explicit existing sequence number. Tracking must be enabled. |
| `cues` | List of existing cue numbers. Fractional cue numbers are accepted. |
| `fixtures` | List of fixture IDs, subfixture IDs or ranges such as `"101 Thru 105"`. Up to 200 expanded IDs. |
| `attributes` | Native attribute names such as `"Dimmer"` or `"Pan"`. Up to 100 cue and attribute combinations per call. |
| `part` | Optional `0`. The supported action materializes or removes main-part layers. |
| `action` | `"block"` or `"unblock"`. |
| `preview` | `true` reads the scope and returns the exact planned commands and expected hard-layer changes. Defaults to `false`. |

Preview a dimmer Block on Cues 12 and 12.5 with the following input.

```json
{
  "sequence": 401,
  "cues": [12, 12.5],
  "fixtures": ["101 Thru 105"],
  "attributes": ["Dimmer"],
  "action": "block",
  "preview": true
}
```

Apply by sending the same request with `"preview": false`. The tool rechecks console identity, locks,
tracking coverage and the projected effect. Each command uses an explicit fixture and attribute filter.
An empty change list means the supported layers already satisfy the request. A mismatch or uncertain
result stops the batch and leaves its receipts available for inspection.

Supported layers are static numeric absolute or relative values with readable ownership. A selected
phaser, preset-linked value, cooked value or nonzero-part channel causes a preflight refusal. Native
Unblock uses the observed block flags and removes a layer when its prior tracked value matches. The tool
also simulates the hard-data change and compares every reconstructed cue before sending a command.
This catches a block that would make a temporary value persist beyond its tracking distance.

Verification checks the resulting block flags, stored layers, effective sequence values, complete native
data on untouched parts and unscoped normalized channels in the changed part. Console identity must
remain stable across the observations. The comparison covers stored sequence data and its inheritance.

Use `gma3_configure_cue` for Break assignments and absolute or delta Tracking Distance settings on
existing cue parts. Use scoped cue-range edits to change looks. [Cue settings](cue-settings.md)
