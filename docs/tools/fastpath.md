# Faster bridge reads and bounded programming batches

The bridge can now capture a programmer scan once, skip native phaser reads for unrelated attributes, and execute a bounded list of command/read steps without a separate network round trip for each step. These primitives reduce transport and repeated scan work. They do not make the console's own command execution faster or prove that an accepted command produced the intended lighting look.

The normal path is MCP client → Node server → persistent local JSON-lines TCP connection → imported Lua bridge → grandMA3 native API. Node's in-process mutation queue orders that server's requests. The new writer lease also coordinates different connections to the same bridge. The console operator and unrelated plugins remain independent writers.

## Context and imported component identity

`gma3_fast_context` (`fast.context`) freshly observes hostname, showfile, user, profile and the bridge start generation. `contextKey` exists only if every identity field is readable. An epoch changes whenever this bridge observes a different identity or an unavailable identity. Returning to a former profile does not revive an old key. The programmer environment is reported separately: switching Normal/Preview leaves the show identity key stable.

Every bridge start creates a new generation. `ping.plugin.fingerprint` identifies the actual imported bridge bytecode. `ping.modules.<name>.fingerprint` identifies each actual imported component. Fingerprints are computed once when each component chunk loads, with an Adler32 checksum and byte length of stripped Lua bytecode. They are non-cryptographic, depend on the Lua VM/compiler, and are **not source SHA hashes**. Comments or other source changes that compile identically can retain the same fingerprint. Node build identity and imported plugin identity must be reported separately.

Identity is best-effort observation of shared console state. It is not a lock against an operator changing the show between observations. A caller should use explicit `DataPool` references for objects whose pool must stay fixed.

## Writer ownership

`gma3_writer_lease` (`fast.lease`) supports `acquire`, `renew`, `release` and `status`. Acquire needs the current `context_key`. Acquire/renew accept `ttl_ms` from 100 to 30000; the default is 10000. The returned token belongs to that exact TCP connection and show context. Renew before expiry during long work. A different connection cannot renew or release it. Disconnect releases it.

While a lease exists, mutations through other bridge connections are refused before dispatch; reads remain available. The owner can use existing programming tools. Renewal after context drift fails. Release is still available after drift, so stale ownership can be cleaned up. Existing behavior remains available when no lease is held.

## Batches and cancellation

`gma3_batch` maps to `fast.batch`:

1. `start` requires `context_key` and 1–128 steps. Mutating steps also require `lease_token`.
2. Each step contains `op`, `args`, an optional `name`, and optional `expect: {path, value}`. Paths address returned fields such as `total` or `rows.1.attribute` (Lua array indexes start at 1).
3. The start reply returns a connection-bound batch `id`; it dispatches no command inline.
4. The bridge loop executes at most one step globally per frame, rotating between active batches. It verifies context, lease and input ownership again before each mutating step.
5. Poll `status` to read each step's `succeeded`, `failed`, `unknown` or `skipped` result. Unattempted later steps remain skipped after failure, unfamiliar command feedback, incomplete read coverage, mismatched expectation or cancellation.
6. `cancel` requests cancellation before the next step. A native API call already running cannot be interrupted or undone. `list` discovers this connection's retained handles after a lost start reply, without replaying the start.

Allowed mutations are single `cmd` and `set` operations. Allowed reads are explicitly listed in `src/fastpath.ts`. No arbitrary `lua` op is accepted. Commands reject semicolons, control characters, Lua, nested Cmd and Plugin keywords. A batch has at most 128 KiB of input and 1 MiB of retained results; at most 32 batches are retained, with completed handles expiring after 60 seconds. Large read results should use narrower scopes or programmer snapshots.

Known positive `Ok` command feedback is accepted. Known negative feedback fails. Unfamiliar or absent feedback stops as unknown. A thrown mutation operation is conservatively unknown because native work may already have started. There is no automatic retry or rollback. Include explicit read-back steps to check resulting objects/values. A successful command alone does not verify a cue's stored content, tracking behavior, visual output or save persistence.

Explicit incomplete/truncated read results also stop the batch. If serialization would lose nested data,
a cycle, a nonfinite number, or an unsupported value/key, the step reports `serializationLoss` and stops:
reads fail and mutation receipts become unknown. A shortened receipt never silently certifies complete
evidence. Large structured readers such as `cue.content` and `view.content` carry bounded JSON content
strings to preserve their supported nested configuration through the wire envelope.

Other mutations from the batch's own connection are also refused until it finishes; otherwise a separate tool call could alter the programmer between batch steps. Lease renewal, status, reads and emergency input releases remain available.

Terminal `outcome` distinguishes success, failure, uncertainty and partial work. For example, cancelling after one successful command returns `status:"cancelled"`, `outcome:"partial"` and the later steps skipped. Cancellation is not rollback.

## Filtered programmer scans and frozen pages

`gma3_programmer` now accepts `attributes`, a nonempty list of up to 128 case-insensitive attribute names. Lua enumerates the requested fixtures' channels, reads attribute metadata, and calls `GetProgPhaser` only for matching attributes. Returned `filter.completeness` explicitly says that completeness covers the requested attributes. An empty filtered result does not prove the whole programmer empty. Unreadable attribute metadata makes coverage incomplete rather than silently omitting a possible match.

`stats.phaserReads` and `stats.filteredChannels` expose the native work performed. `max_channels` is a hard bound within a fixture as well as between fixtures. The default remains 5000 and the maximum remains 50000; partial coverage is explicit.

Cue phaser-support preflight uses the attribute filter because it only needs fixture-support metadata. Full build/value verification remains unfiltered so it still sees activation siblings and unexpected programmer content. Cue and phaser environment-only guards share the cheap fresh `feedback.read` reader, with a per-call fallback to complete programmer scans when that capability is unavailable. Normal preservation snapshots, initial empty Preview proof and full phaser build checks retain complete scans.

`gma3_programmer_snapshot` (`programmer.snapshot`) supports `create`, `page`, `release`. Create takes the same fixture scope and optional attribute filter, plus page `limit` and `ttl_ms`. It performs one scan and returns `snapshotId`, `nextCursor`, `capturedAt`, `expiresAt`, `frozen:true` and `atomic:false`. Pages contain the same frozen captured rows; they perform no new `GetProgPhaser` scan. This preserves paging consistency while making clear that later pages are historical observations, not fresh current values.

Snapshots belong to the creating connection, generation/show/user/profile and programmer environment. An observed identity/environment change or expiry refuses further pages. Limits are four snapshots per connection, 16 total, 5000 captured rows, 4 MiB per snapshot and 16 MiB total. TTL is 100–30000 ms. Row truncation sets coverage incomplete. Release snapshots when finished. No snapshot claims to be an atomic console transaction or detect an operator's same-context value edit during capture.

## Verification

Run `PATH="$PWD/.test-tools/runtime/usr/bin:$PATH" node --import tsx --test test/fastpath.test.ts test/fastpath-plugin.test.ts` when the local Lua 5.4 runtime is present. The Lua harness counts native calls: a Pan-only scan invokes one phaser read for a fixture with Dimmer/Pan/Tilt, while an unfiltered scan invokes three; a snapshot page invokes zero additional phaser reads. It also checks hard channel budgets, disconnect cleanup, stale context/expiry rejection, unknown-feedback stop, step-boundary cancellation, command rejection, and differing imported code retaining the same version label. These are deterministic API-stub checks. Native onPC timing and visual cue qualification are separate evidence.

Native qualification on 2026-10-29 used an isolated loopback-only lab running onPC 2.5.1.1 under Wine, with protocol output disabled. Across 109 subfixtures, 430 UI channels and 318 active programmer rows, three same-shape limit-one scans measured median 164.414 ms unfiltered versus 65.144 ms with the Dimmer filter. The actual phaser-read count fell from 430 to 108. These are bridge read timings on this lab, not an end-to-end cue-authoring speed claim.

Native command → stored-object read → property-write batching succeeded. A second connection's mutation was refused while the lease was held; a stale context was refused; negative command feedback stopped later steps; cancellation completed one command and skipped the remaining 127. Snapshot expiry and foreign-connection pages were refused. Normal programmer content was checked empty before and after the Preview-only test. One large detailed cue result exceeded the explicit 1 MiB batch budget: the batch reported partial work and skipped its following write. That safe stop is a limit, not successful verification of the stored cue. Large frozen pages still incur JSON serialization and transfer cost: a 317-row page measured 343 ms, so avoiding a rescan does not guarantee a faster large response. No physical output was qualified.
