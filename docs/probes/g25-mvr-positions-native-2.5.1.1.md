# G25: native MVR position revisions, grandMA3 2.5.1.1

The public `gma3_apply_mvr_positions` handler completed one guarded native apply and full scoped preservation check on 2026-10-30. General PSR import remains unqualified because its separate native experiment changed a shared DMX-curve fingerprint.

## Qualified direct position route

The disposable instance used onPC 2.5.1.1 under Wine. The final bridge fingerprint was `lua-bytecode-adler32:b5a53c86:271751`. The test invoked the actual registered public tool handler with validated arguments, its offline preview fingerprint, explicit Drive 1 filesystem mapping and fresh create-only before/post exports. It did not use PSR to apply positions.

The test deliberately included two unwanted incoming changes:

| Property | Before | Incoming | Observed after apply |
| --- | --- | --- | --- |
| Fixture 1 X | 0.25 m | 0.5 m, selected | 0.5 m |
| Fixture 1 DMX | 1.001 | 1.050, retain local | 1.001 |
| Fixture 2 X | 0 m | 0.5 m, retain local | 0 m |

Fixtures 1 and 2 had distinct persistent UUIDs; their private identifiers are not distributed. All nine fixture UUIDs/FIDs/names, embedded GDTF member contents/modes, every DMX break/address, world matrices, geometry references and parent memberships matched the desired result. All inspected nonfixture scene objects and embedded asset contents were preserved.

The complete before/after native content checks matched for Sequence 8840, Sequence 9002, Preset 1.9002 and Group 9001. Configured DMX output settings matched. Complete fingerprints of every native live patch collection except the intentionally changed `Stages` collection matched, including `DmxCurves`, fixture types, attribute definitions and layers. The cooperative lease lifecycle was acquire, renew, renew, release. Final operation outcome was `succeeded`, verification `matched`; no generic FID-only setter was used.

The lab returned to Normal, a complete empty programmer, Root command destination, closed patch copy, no modal and no active writer lease. The current show was saved through structured `saveShow`; that save verified a newly written current show file. No reload was performed by this stage.

Raw evidence is retained privately and is not bundled with this source release. The [qualification summary](../qualification/2026-10-30.md) records accepted scope. The original records include:

- `mvr-public-positions-intent.json`: exact preview/apply arguments, nine source SHA values and all 59 native RPC receipts.
- `mvr-public-positions-qualified-result.json`: extracted complete operation result and source hashes.
- `CodexMvrPublicBefore.mvr`, `CodexMvrPublicAfter.mvr` in the private Drive 1 MVR directory: fresh actual exports.
- `mvr-public-save-current-intent.json`, `mvr-public-final-state.jsonl`: matched save and clean final state.
- `mvr-public-positions-archive-manifest-v1.json`: discriminating incoming file and unchanged ZIP-member evidence.

The exact public tool source SHA at qualification was `4e5ac0260a35c95a3f2693dacbc419a3c81b8e4a1083a91ed2864fbfa9a542d7`; atomic guard source SHA was `a57c61ec86d67430137e8ab36cbc108be15d661c1cabaf55409d2bb6afd8fc1f`. Other qualified source hashes are in the receipt. Later source changes require corresponding revalidation.

## Export metadata normalization

Two consecutive untouched native exports regenerated the root `Fixture Layer` UUID. The native `Layers` collection fingerprint stayed identical. Comparison aliases only this single root identity layer when its direct children are exactly the entire stable fixture UUID set, with no other children. Both raw UUIDs and the membership condition are reported. Other scene UUIDs and every fixture UUID remain strict.

All four exported GDTF raw ZIP hashes changed while their complete uncompressed member bytes stayed identical. The parser now retains raw hashes and also compares a bounded, validated, sorted-member content hash. See [asset identity](../tools/mvr-assets.md). Changed contents, paths, duplicate names and invalid nested archives are not normalized.

## Separate native PSR experiment: selective property works, full preservation does not pass

The proper Show Creator wrapper, native PSR tab, MVR preparation, owned Rename Show File modal, complete UUID-bearing source fixture inventories and actual native grids were qualified. A source-specific bijection bound each real source fixture UUID to its unique source FID and actual grid row. Negative 64-bit native row IDs remained entirely in Lua. The selected row/Position column was proved before an actual toolbar Use Property click. This does not claim FID or name establishes cross-version UUID identity.

The discriminating PSR input selected fixture 1 X +250 mm while retaining its conflicting incoming DMX address and fixture 2's conflicting +500 mm position. Finish was dispatched once. Patch Summary reported one partially used PSR fixture, nine local fixtures retained, nine matched, zero replaced/deleted. A fresh export proved exactly the requested position and retained distractors. The same cue/preset/group programming targets preserved their native hashes.

However, native `DmxCurves` changed from complete fingerprint `2746530785` to `2571754115`, with the same two visited objects (the collection root is included; this does not prove two curve entries). The precise changed field remains unresolved. Other non-Stage collections matched. This is negative preservation evidence and prevents shipping PSR conversion as the production apply engine. It must not be dismissed based on successful fixture positions or type ZIP normalization.

PSR evidence: `mvr-selective-semantic-qualification.json`, `mvr-selective-live-patch-comparison.json`, `mvr-reference-preservation-after-1793319365916.json` and the recorded selection/Finish/Summary intents, all retained privately.

## Scope limits and checks

The shipped route supports selected world translations for stable UUID/FID/name/type/mode/geometry with identity fixture ancestors and one native stage. It preserves all unmentioned local fixture positions and local DMX. Add/remove, renumber, rotation/scale, type/patch changes and inspected scene changes remain refused. Unknown XML extensions and unrequested show programming are outside the comparison; incoming extensions are not imported. Rendering, physical output, clearance, calibration and photometry were not verified.

Source regressions cover malformed setter replies, stale UUID/FID/context/pose, lost renewal without reacquisition, unknown delivery without replay, restore data retained after post-write failure, missing post-export assets, strict layer normalization and explicit group collateral changes. The existing placement suite remains passing, including its default setter path.
