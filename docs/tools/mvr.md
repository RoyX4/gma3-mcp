# MVR inspection and revision workflows

`gma3_inspect_mvr` reads a local `.mvr` archive. `gma3_compare_mvr` compares two revisions by persistent UUID. Neither tool contacts the console or imports, deletes, renumbers or changes show objects. `gma3_export_mvr` sends a native export once and checks the produced file.

## Local archive inspection

```json
{"file":"/absolute/path/rig.mvr","offset":0,"limit":100}
```

`file` must be an absolute `.mvr` path on the computer running the Node server. `offset` defaults to 0 and `limit` to 100, with a maximum of 500. Objects are paged with `total`, `count` and `incomplete`; metadata includes a SHA-256 fingerprint, MVR version, asset count and duplicate fixture IDs.

Each object includes its UUID, type, name, parent UUID, fixture ID, GDTF specification/mode, DMX addresses and geometry-reference hash. The `matrix` is its local affine transform; `worldMatrix` includes inherited parent transforms. Both are row-major 3 by 4 arrays. MVR translation units are **millimetres**. These transforms do not calibrate fixture axes, prove dimensions or establish visualizer occlusion.

Python 3 is an optional requirement of these file tools. The server invokes the shipped `scripts/mvr-inspect.py` through `execFile`, without a shell. On Windows it uses `python`; elsewhere `python3`. Set `GMA3_MVR_PYTHON` to the exact Python 3 executable path if needed. The helper works from both `src/` and compiled `dist/` and is included in the existing package's shipped `scripts/` directory.

The helper never extracts members or invokes archive-provided code. Limits are 256 MiB compressed archive, 16 MiB scene XML, 128 MiB per member, 512 MiB total uncompressed, 20,000 archive members, 100,000 XML nodes, 10,000 scene objects and 128 levels of nesting. It rejects unsafe member paths, duplicate member names, encrypted members, symbolic links, DTD/entities, duplicate object UUIDs, invalid transforms and files changed during inspection. The child process has a 15 second deadline and a bounded output buffer. It hashes embedded assets, but does not validate GLB/GDTF schemas or render the scene.

## Revision comparison

```json
{"before":"/absolute/path/rig-v1.mvr","after":"/absolute/path/rig-v2.mvr","limit":100}
```

The comparison uses **UUID identity**, retaining FIDs as a property to review. An object with a changed name stays the same object; a new UUID remains an addition even if the name matches a removed object. Results include complete change counts, a paged list of additions/removals/field changes, and added/removed/changed asset names. Parent-transform changes appear in descendants' world transforms.

`requiresIdentityReview` is set for removals, FID/address/type/mode changes, or duplicate fixture IDs in the incoming revision. Inspect these before performing a PSR import. A diff between two files does not establish that the live console currently contains either revision.

On the existing theatre pair `theatre-rig-ready.mvr` and `theatre-rig-revision.mvr`, the new reader observed 577 scene/hierarchy objects per file, no added or removed UUIDs, and exactly one changed scene object: `Movable_Rostrum`, whose local and world transforms changed. Embedded asset hashes were unchanged. This is an offline archive observation.

## Native export

```json
{"file":"/absolute/mapped/Drive1/mvr/New Rig.mvr"}
```

Preview is the default. `file` must name a currently absent target in the server's filesystem view of the selected console's **Drive 1 MVR directory**. This mapping must be supplied explicitly; the tool does not infer a Wine prefix, remote share or selected console from a path.

To execute the previewed export, additionally supply `dry_run:false`, `exclusive:true` and `mapped_to_drive1_mvr:true`. `timeout_ms` controls file observation, from 300 to 30,000 milliseconds, default 10,000. The simple filename supports ASCII letters, numbers, spaces, underscores and hyphens, with lowercase `.mvr` extension.

The tool checks the output directory and case-insensitive target absence, then reads `patch.state`. It refuses an open edit-patch copy, non-Root destination or modal dialog. It rechecks target absence, sends exactly:

```text
Export Stage /File "New Rig" If Drive 1 /MVR
```

There is no `/Overwrite`, automatic dialog confirmation or retry. The command exports the entire patch and does not save the show, select fixtures or clear programmer values. Serialization orders this server's requests only; `exclusive:true` states that the operator is coordinating other clients during the export.

Verification matches only when the previously absent regular file appears, stabilizes and parses as a valid MVR inventory. It includes the observed bytes and SHA-256. Accepted command feedback alone is insufficient. A missing/incomplete/invalid file is unavailable verification and an incomplete operation. A lost export reply remains an **unknown dispatch**, even if the file is later observed; the tool never resends it. Failed exports may leave a partial file for inspection; nothing is automatically removed.

The native syntax is documented in the installed 2.5 manual's `ok_mvr.html` (`Export Stage If Drive 1 /MVR`, `/File` syntax) and `patch_mvr.html`. Automated tests exercise that command and actual produced archive parsing against a fake bridge. No new live-console export was performed while implementing this tool.

## Import boundary

The installed `patch_mvr.html` directs MVR import through **Partial Show Read (PSR)**. The general `Import` keyword documents exported XML pool objects, not a complete MVR merge command. MA's shipped MVR system test uses the internal MVR add-on to load a file and then opens `MVRIMPORTPSR`; it does not supply a general verified merge policy for fixtures, scenery, deletions, identifiers and property columns.

These tools therefore prepare a revision review and provide export; they do not claim to perform a verified MVR import. Use PSR to choose incoming fixtures/scenery and position/rotation policies, then compare actual patch identities, types, addresses and transforms before accepting the result. A future structured importer needs to model and test those PSR decisions explicitly.
