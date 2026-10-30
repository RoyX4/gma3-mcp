# Show-state persistence checkpoints

`gma3_show_checkpoint` (`src/tools/checkpoint.ts`) captures scoped saved show state and compares it later. It does not save, load, discard, restore or overwrite a show. It changes no selection, programmer, playback, output setting or current screen. Captures are new immutable records in the server's private state directory.

```json
{
  "action": "capture",
  "label": "Before isolated save and reload",
  "scope": {
    "data_pool": 1,
    "sequences": [401],
    "presets": [{"pool":4,"preset":901}],
    "views": [24,25,26],
    "cameras": [18],
    "include_patch": true,
    "include_dmx_output": true
  }
}
```

The result contains a new UUID `id`, overall and per-section completeness, hashes, source descriptions and limitations. `detail:true` includes captured payloads. An unsupported reader still produces an explicitly incomplete saved record; its unavailable section never becomes a match.

| Action | Parameters |
| --- | --- |
| `capture` | Explicit `scope`, optional label/detail; publishes a new ID only |
| `compare` | `id`, optional `allow_generation_change:true`, detail; reads the same scope again without replacing the baseline |
| `status` | `id`, detail; inspect the immutable saved record offline |
| `list` | Offset and limit; default 20 records, maximum 100 |

Scope limits are 32 sequences, 64 individual presets, 16 Views and 32 cameras. Targets are numeric IDs, never arbitrary command or filesystem paths. An omitted data pool is resolved to its native numeric ID at capture and stored explicitly. Views/cameras remain in the bound user profile. Patch and output settings default on; set each inclusion flag false when intentionally excluding that section. An empty effective scope is refused.

## Exactly what is observed

The observer reads `fast.context` before and after the complete bounded capture. Both identity observations must match and report Normal. The context includes console generation, host, showfile, user and profile; a drift during capture prevents publication.

| Section | Native reads and compared scope |
| --- | --- |
| Sequence | One `cue.content` for its explicit data-pool sequence; saved properties, all cue parts and complete encoded raw stored channels/phasers/preset links |
| Preset | `preset.read`; normalized stored values, steps, layers and references, with truncation/dependency readability required; dynamic reference counts excluded |
| View | `view.content`; actual saved View contents, including its stored windows; existence/name/current-screen metadata alone does not satisfy this section |
| Camera | `objects` for NAME, POSX/Y/Z, PAN, TILT, ROLL, FOV and lock properties; saved pose only, not rendered pixels or current viewport selection |
| Live patch | `patch.collections`, then complete `patch.fingerprint` for every enumerated live collection; recursive fixture-type/attribute-definition content included; documented derived/volatile fields excluded by the native patch fingerprint |
| DMX output settings | `dmx.output {all:true}`; configured Art-Net/sACN entries, every universe's request/port/merge settings and station routing |

DMX hardware grants, current output levels, parked/tester counts and network packet delivery are runtime observations and are excluded from persistence comparisons. Native patch fingerprints use the existing bounded FNV change detector; the enclosing record uses SHA-256. The tool reports that distinction.

Captures are coverage-complete for their stated sections when every required native read succeeds without truncation. They do not exclude a console operator or freeze the whole application atomically. Capture while the show is stable. Missing native View support stays incomplete instead of being replaced with a screenshot or View existence check.

## Comparing after an isolated save/reload

Capture the baseline, then perform the human-controlled or separately authorized save/reload on a disposable show. Compare with:

```json
{"action":"compare","id":"<baseline UUID>","allow_generation_change":true}
```

Generation changes are refused by default. The explicit flag permits a reload/restarted bridge while host, showfile, user and profile still must match. The result separately reports generation drift and per-section differences. A mismatch is an MCP tool error with the comparison retained. A partial/incomplete baseline or observation never reports matched.

The tool does not infer that a Save command succeeded, that a file contains all desired data, or that a successful reload historically preserved something it never captured. A matched post-reload observation is evidence only for the explicit captured scope. It adds no automatic Load/Save actions or recovery replay.

## Stored integrity and native comparison

Saved section/record hashes continue to protect the exact captured payload, including its original JSON strings. Reading an old record validates those original hashes first; changing even the presentation of its saved data without its original integrity hash is rejected. Comparisons do not edit or replace the baseline.

Comparison results declare `comparisonFingerprintVersion:"native-json-v2"` and retain the stored `beforeHash`/`afterHash` alongside `beforeComparisonHash`/`afterComparisonHash`. The comparison hashes validate and canonicalize only encoded native JSON presentation: object key order and typed native value-map entry order. Ordinary arrays, key types, unknown fields, exact large integer digits and values remain significant. Malformed/ambiguous encoded data remains captured as incomplete evidence and cannot match. A real patch fingerprint or camera/fixture value change still mismatches.

## Local persistence and checks

Checkpoints live beside the default jobs directory under the server state directory in `checkpoints/`. Test harnesses inject a temporary directory. Files use mode 0600 and directories 0700. The writer fsyncs a unique temporary file, publishes it with an atomic create-only hard link, removes the temporary file, and fsyncs the directory. It never replaces an existing checkpoint ID. Each record is bounded to 32 MiB and validates section/record fingerprints when read; callers cannot supply disk paths.

`node --import tsx --test test/checkpoint.test.ts` checks exact raw-cue differences, immutable baseline preservation, explicit generation changes, context drift, unavailable native View content, full patch/type changes, configured DMX changes versus runtime grants, and record-integrity failure. `npm run build` checks the public types. The tests issue no console mutations.
