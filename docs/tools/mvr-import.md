# MVR import decisions and verification

`gma3_mvr_import_plan` makes a concrete fixture import decision plan and checks the result of a native Partial Show Read (PSR). `action:"plan"` is the default and only reads the two named local archives. The tool does not currently stage, select, convert, delete, or commit native PSR data. Its response explicitly reports `nativeApplyQualified:false`.

Use an MVR exported from the destination show as `before_file`, the proposed revision as `incoming_file`, and explicit UUID decisions:

```json
{
  "before_file": "/mapped/mvr/Before.mvr",
  "incoming_file": "/mapped/mvr/Revision.mvr",
  "decisions": [
    {
      "uuid": "c2060c00-f165-802c-b34a-6ce28441da4f",
      "source": "local",
      "patch": "local",
      "transform": "incoming"
    }
  ]
}
```

`source` chooses fixture identity, FID, name, and GDTF type/mode. Optional `patch` and `transform` independently choose DMX breaks/addresses and the inherited world transform. They default to `source`. `source:"omit"` explicitly excludes a fixture. Every unmentioned local fixture is retained; every unmentioned new incoming fixture is omitted. Matching uses UUID, never a similar name or FID. Duplicate decisions, absent sources, conflicting desired FIDs, and incoming types without an inspected embedded GDTF asset are refused or make the plan invalid. `plan.executable` means the decisions passed these structural checks; it does not enable native application.

The plan includes archive hashes, a stable decision/result fingerprint, explicit added/removed/changed fixture lists, and the desired fixtures. `offset` and `limit` page the desired fixture list. Other scene-object kinds are outside this fixture decision model.

After performing native PSR, call the same tool with `action:"verify"` and `observed_file`. By default this compares the supplied archive and explicitly makes no claim about its freshness or console provenance. For a fresh console observation, additionally supply `native_export:true`, `exclusive:true`, and `mapped_to_drive1_mvr:true`. The observation path must not exist. The tool reuses `gma3_export_mvr`'s create-only Drive 1 export, requires a closed patch copy/Root/no modal, and checks complete generation/show/station/user/profile identity before and after export. It never overwrites an archive or retries an uncertain export. The parent directory mapping is an explicit caller assertion; remote or Wine paths are not guessed.

Verification compares the complete fixture UUID set, FIDs, names, GDTF asset identity/modes, every DMX break/address, attached fixture geometry references, and inherited world transforms. Translation tolerance is 0.01 mm; basis tolerance is 0.000001. Missing type proof is `unavailable`; wrong or missing fixtures/values are `mismatched`. Geometry-reference comparison does not validate the referenced mesh bytes. This does not verify non-fixture scenery, fixture calibration, photometry, rendering, or physical output.

## Native staging qualification

The installed 2.5.1.1 manual and bundled `lib_menus/ui/psr/psr_patch.lua` describe the supported PSR path. The current UI is the Show Creator wrapper (`ShowCreatorFTPresetsMainDialog`) with its Partial Show Read tab and MVR source, then preparation, patch choices, Finish, and Patch Summary. Preparation can show **Rename Show File**. Native MVR PSR clears the programmer; a future structured apply adapter must therefore require a complete empty Normal programmer, an exact owned context/staging token, and an exclusive writer lease. Automatic matching by FID or name cannot substitute for verified UUID choices.

The disposable 2.5.1.1 lab completed one discriminating native PSR conversion. Fixture 1's incoming X translation was +250 mm, its incoming DMX address also changed, and fixture 2 had a +500 mm distraction. Only fixture 1's Position property was selected through the actual native grid and toolbar. The Patch Summary reported one partially used PSR fixture, nine retained local fixtures, and zero replaced/deleted fixtures. A fresh native export proved only the requested +250 mm position, retained fixture 1's local address, and retained fixture 2's local position. Sequence 8840, Sequence 9002, Preset 1.9002 and Group 9001 preserved their native content hashes.

This does **not** qualify PSR as the production apply engine: the complete native `DmxCurves` collection fingerprint changed during conversion (same two objects). Its precise changed field remains unresolved. Other non-Stage collections, including fixture types, layers and attributes, matched. The failed preservation evidence is retained. Preparation and Finish are never replayed after uncertain delivery, and opaque `PatchFakeCollect` objects must not be inspected generically.

## Apply stable fixture positions

`gma3_apply_mvr_positions` applies the useful position-only case through the existing qualified fixture-placement engine. It does not import PSR data. Start with the same `before_file`, `incoming_file` and UUID decisions as above. Preview is the default, is offline, and returns `expected_plan`, targets and scope errors.

Apply with `preview:false`, the returned unchanged `expected_plan`, `exclusive:true`, `mapped_to_drive1_mvr:true`, and two absent `before_export_file` / `after_export_file` paths in the same mapped Drive 1 MVR folder. The server creates a fresh before export and refuses all position writes unless the complete inspected fixture and scene state matches the supplied baseline. Every individual native Set atomically checks the pinned show/station/user/profile/generation, the complete native fixture UUID/FID/type/mode/patch/pose snapshot and exact target UUID. Its own expected pose advances after each confirmed axis write. The existing placement engine retains readback, restore values and partial/unknown delivery reporting. Unknown writes are observed and never replayed.

This route requires 1–256 fixtures with stable UUID, positive unique FID, name, type/mode, parent and geometry. It only uses explicitly selected incoming translations. Local DMX and all unmentioned fixture positions remain local, including distracting changes in the input. Add/remove, renumber, type/rotation/scale and inspected scene changes are refused. Fixture ancestors must have identity transforms; nested fixtures and multiple native stages remain unqualified. Incoming selected positions must be within ±100000 metres. Console Lua must be enabled for the fixed atomic guard.

Fresh post-export verification compares all inspected fixture UUIDs/FIDs/names/type contents/modes/DMX/world transforms/geometry and parent memberships, every inspected nonfixture object, and embedded asset content. All native patch collections other than the intentionally changed `Stages` collection must retain their complete fingerprints. Configured DMX output settings are also checked. Optional `preserve` names explicit `sequences`, `presets`, `groups` and required `data_pool`; these native programming targets must match before/after. Unrequested programming and unknown XML extensions are outside the comparison. No show Save, programmer clear, selection change or playback is performed. Live positions have no Oops undo; the result includes previous values for manual restoration.

Two native export metadata differences are handled explicitly and disclosed with raw evidence. Valid embedded GDTF ZIPs compare a bounded hash of sorted member names and uncompressed bytes, because grandMA3 regenerates their ZIP timestamps; raw container SHA values remain available. A root identity Layer named `Fixture Layer` may be given a stable comparison alias only when its direct children are exactly the complete fixture UUID set and it has no other children. Consecutive untouched native exports regenerated that layer UUID. Other scene UUIDs and all fixture UUIDs remain strict. Container or layer changes outside these conditions are not normalized.

See [MVR asset identity](mvr-assets.md) for the exact nested ZIP hash and validation bounds.

The public position route passed its native registered-handler qualification on 2.5.1.1: fixture 1 moved from 0.25 m to 0.5 m, its local DMX address and fixture 2's local position survived conflicting incoming values, all inspected fixture/scene/asset checks matched, and requested programming/output/shared-patch preservation matched. The cooperative writer lease acquired, renewed twice and released. The current show was then saved through the structured save tool. [Native qualification and remaining PSR limitation](../probes/g25-mvr-positions-native-2.5.1.1.md).

The native span takes a cooperative bridge writer lease as well as this server's mutation lock. It renews the same token, stops after lost renewal, and never reacquires or replays automatically. A release failure retains applied proof and restore data with an explicit uncertainty warning. The lease coordinates bridge clients; `exclusive:true` remains the caller's assertion that a human operator or unrelated plugin is not changing the show.

Runnable checks: `node --import tsx --test test/mvr-position-*.test.ts test/mvr-import*.test.ts test/mvr.test.ts test/positions.test.ts`.
