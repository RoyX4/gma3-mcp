# Durable programming jobs

`gma3_programming_job` in `src/tools/jobs.ts` runs complete owned [tracking plans](tracking.md) on the server. A client can poll progress while programming continues, and an MCP request timeout does not restart a cue batch. Journals retain the plan, receipts, timing and exact native checkpoints.

```json
{"action":"prepare","plan":{"version":1,"sequence":401,"cues":[{"cue":1,"changes":[{"kind":"value","fixtures":"101 Thru 112","attribute":"Dimmer","value":40}]}]}}
```

Preparation returns an `id` and `status:"prepared"`. It does no console work. Execution requires a separate concrete request:

```json
{"action":"run","id":"<returned UUID>","run":true,"exclusive":true}
```

`run:false` reads status and sends no bridge request. `exclusive:true` confirms nobody else is programming that console. A writer lease coordinates bridge clients; it does not disable the console operator or unrelated plugins.

## Actions

| Action | Parameters and behavior |
| --- | --- |
| `prepare` | `plan`, optional `batch_size` 1..100 (default 12), `max_batches_per_run`, `expected_context_key`; writes a private local journal only |
| `run` | `id`, `run:true`, `exclusive:true`; start prepared work and return promptly |
| `status` | `id`, optional `detail:true`; progress, current batch/operation, verified receipts, checkpoint, errors and measured timing |
| `list` | `offset`, `limit` (default 20, maximum 100); compact saved jobs |
| `cancel` | `id`; request a stop at the next safe batch boundary |
| `resume` | `id`, `run:true`, `exclusive:true`; continue cancelled/paused/blocked work only after exact context/content guards pass |
| `rebind` | `id`, `exclusive:true`, optional `reason`; read-only native proof and durable local journal update for a new bridge generation; forbids `run:true` and never starts programming |
| `invalidate` | `id`, optional `reason`; mark a nonrunning checkpoint unusable after a known manual edit |

`detail:true` returns the complete journal, including structured per-step receipts. Normal status keeps cue lists, summaries, outcome and verification for each completed batch. Work-count estimates distinguish assignments, looks, holds, batches and remaining cues. No unmeasured completion time is promised.

## What runs

1. Read `fast.context`, resolve an omitted current data pool into a fixed numeric pool, confirm the exact destination sequence with `objects`, read full `cue.content` if it exists, and read `fast.context` again. Identity must be complete and stable; environment must be Normal. A new owned chain requires an absent or empty sequence. Every executed batch addresses the bound pool explicitly; a current-pool switch before resume is detected.
2. Compare the saved checkpoint with the exact native sequence fingerprint before a subsequent batch or resume. The hash includes encoded full raw native channel data and all sequence/cue/part fields. A metadata-only view or incomplete native coverage is refused. At these batch boundaries, also fingerprint every enumerated live patch collection (including recursive fixture types and attribute definitions), and read declared presets plus their embedded dependency graph. These checks are not repeated per cue. Native patch hashing uses bounded FNV change detection, not cryptographic attestation of every source byte. Preset dependency traversal is bounded to 64 nodes/four levels and incomplete traversal stops work.
3. Persist and fsync the exact in-flight batch intent **before** mutation.
4. Under this server's mutation lock, check context again, acquire a connection-bound `fast.lease`, and execute the existing `storeCues` path with the compiled plan. The lease is renewed during long batches and released at their end.
5. Read full native content again, compare supported stored compiler-owned layers with their intended effective state, and persist receipts plus the new fingerprint before removing the in-flight marker. A native value mismatch or dependency drift stops all further batches as uncertain. Missing checkpointed cues cannot be skipped because a lower native cue number was returned.

The existing storage path reads and preserves the whole Normal programmer, enters Preview, proves Preview empty, applies explicit looks, verifies them, stores each cue, writes metadata, clears only its owned Preview data, leaves Preview, checks Normal preservation and reads cue metadata back. Its commands are `Preview On`, `ClearSelection`, explicit `Fixture ...`, ordered `At Preset ...`, `Attribute ... At Absolute|Relative ...`, `Store Sequence ... Cue ... /NoConfirmation`, scoped property `set` operations, `ClearAll` only in confirmed Preview, and `Preview Off`. Tracking is enabled through the sequence's structured configuration after each batch.

The selection and temporary programmer changes happen in Preview; the Normal programmer must read back unchanged. No playback, Go, Goto, save-show, executor assignment, OSC fallback or arbitrary Lua execution is added by jobs.

## Cancellation, crashes and resume

Cancellation is cooperative. An already-dispatched batch completes its guarded work and Preview cleanup; no cancellation packet pretends to retract a Store command. A smaller `batch_size` gives more frequent safe points; a larger batch amortizes expensive preflight/preservation reads. Status exposes the current request and accumulated request counts within the active server process.

New jobs default to 12 cues per batch, selected from the [matched native benchmark](../programming-performance.md#matched-native-intel-lab-matrix-2026-10-30). Explicit `batch_size:3` or `6` remains available when quicker cancellation checkpoints matter. Existing journals keep their stored batch size when read, resumed or rebound; this default does not rewrite them. Every batch retains the same complete fresh before/after native content and dependency checks, durable intent and no-replay rules.

Only a fully successful batch with matched verification, untouched Normal programmer and matched per-cue receipts advances `verifiedCues`. A failed batch remains available for inspection. A dispatched unknown mutation is `uncertain` and is never replayed. A crash with an in-flight marker is also uncertain, even if some cues may have stored successfully.

Paused/cancelled jobs resume from the first uncheckpointed cue only after exact context and native content comparison. Console generation, host, showfile, user or profile drift blocks continuation. Manual cue changes block it too. Explicit invalidation cannot be bypassed by resume. Incomplete observations never count as an empty sequence or a matching checkpoint.

After a saved show/plugin reload, `rebind` is the explicit recovery route for an otherwise safe checkpoint:

```json
{"action":"rebind","id":"<returned UUID>","exclusive":true,"reason":"Same isolated show restored; verify before adopting its new bridge generation"}
```

It requires the same work-host name, bridge address, native station/show/user/profile and bound data pool. New
checkpoints also pin the local Linux network namespace and boot ID when available, plus any
`GMA3_INSTANCE_PROFILE_DIGEST` supplied by the checked instance launcher. The qualified route must match exactly:
an identical show clone on another loopback namespace, a changed instance profile, or a new boot cannot be silently
adopted. Where namespace/boot evidence is unavailable, an instance-profile digest is required. Older journals with
no saved structured identity/route cannot rebind; prepare a reviewed new plan instead of guessing their target.

Fresh full native content and dependency fingerprints must equal the last complete checkpoint. Before and after
that read, recovery checks complete Normal-programmer scan coverage, idle writer/input/control/batch ownership,
and closed patch/no modal state. It sends no command, property setter, programmer mutation or lease acquisition.
An existing in-flight marker, uncertain/failed/unverified receipt, invalidated checkpoint or any other directory
writer claim refuses recovery. A durable local recovery gate prevents other job processes using that journal
directory from starting work during the proof. Claims left by a crash are never stolen automatically. A concurrent
journal edit or cancellation also prevents adoption.

On success the job stays paused/cancelled, retains all existing cue receipts/progress, and records the old/new
context identities/routes, equal content/dependency hashes, native safety observations and read timings. A separate
explicit `resume` request is still required. Normal resume remains strict and does not invoke rebind automatically.
These scoped observations do not lock out the console operator or unrelated plugins; `exclusive:true` remains a
real requirement, not a claim of an atomic console transaction.

An exclusive per-job filesystem claim prevents two server processes from executing the same journal. A second live process may read status and write a separate cancellation marker. A crash claim is not stolen automatically. Inspect uncertain work and prepare a fresh reviewed plan for the remaining objects; deleting a claim does not make replay safe.

Cancellation markers are checked again after the native preflight read and durable intent write,
immediately before dispatch. A cancellation received during either step stops that pending batch
without an executor call. Cancellation remains cooperative: it cannot retract an already dispatched batch.

## Native fingerprint format and older journals

New native checkpoints and rebind receipts declare `contentFingerprintVersion:"native-json-v2"`. Every covered sequence/cue/part field and raw channel value still contributes to the hash. The encoded `contentJson` and `rawChannelsJson` fields are validated and compared structurally: JSON object key order and the order of actual typed native value-map entries do not change meaning. Ordinary arrays remain ordered. Key types, unknown fields, large integer digits and all values are retained. Duplicate/ambiguous keys, invalid JSON or exceeded bounds refuse a complete checkpoint.

An older journal may contain only an opaque hash of the original raw JSON presentation. It cannot prove equivalent full native content after a different process serializes that JSON, so it cannot `rebind` across generations. Owned cue values alone are insufficient: they would omit unowned native data. No journal is silently rewritten or rebased. A legacy job can resume in its original generation only when the complete fresh **raw** hash matches exactly; a subsequent verified checkpoint uses the new format. Otherwise inspect the retained work and prepare a reviewed remaining plan.

## Recorded local recovery qualification, 30 October 2026

In the isolated onPC 2.5.1.1/Wine lab, jobs 8841–8843 passed process interruption/resume, in-flight cancellation/resume and manual-edit refusal. Legacy job 8844’s unsupported rebind was refused before native requests, preserving its paused journal. After an actual host reboot, versioned job 8880’s explicit rebind performed 28 native read requests and then refused the changed boot/namespace route with zero native mutations; status stayed paused at 1/2 and journal bytes were unchanged. This is a successful negative qualification, not a continued job. Full observations can occur before route rejection, so “read-only” does not mean “no console requests.”

Fresh same-boot job 8890 used a new reviewed plan and paused after one verified cue of two. Its full NVIDIA application-restart/rebind finish passed: app 36070→59195 with a changed generation; ordinary resume refused with zero writes; explicit rebind performed only native reads and stayed paused; separate resume stored exactly Cue 2 and finished 2/2 with native content matched and Normal empty. The prepared snapshot remains retained as partial history, separately from the complete report. No old journal/route was rewritten to simulate a successful continuation. The [qualification scope](../qualification/2026-10-30.md) records final source, native and release status separately.

## Persistence and timing

Default storage is `$XDG_STATE_HOME/gma3-mcp/jobs`, or `~/.local/state/gma3-mcp/jobs`; `GMA3_JOB_DIR` overrides it. Directories use mode 0700 and journal files 0600. Each journal write uses a unique temporary file, fsync and atomic rename, followed by directory fsync. IDs are validated UUID-shaped names; file paths are not supplied by the caller. Journals have a 32 MiB bound. These files are local state and are not automatically published.

Timing records total run time, native observation time, execution time, every actual bridge request's duration/outcome, read/mutation/coordination counts, per-operation totals and per-phase totals. Phases distinguish context/lease, native checkpoint, dependency checkpoint, programmer verification, look construction, Store, metadata and Preview cleanup. Tool timing and the sum of request timing are different measurements; both are retained. Per-request timeout is the server's configured timeout. A timeout is a diagnostic event, not cancellation or permission to retry.

## Verification scope and limits

The pre-store checks prove the requested explicit programmer values/links/steps at the moment of Store, and metadata receipts prove the cue exists with its requested metadata. Native post-store semantic verification separately checks supported stored absolute/relative values, inherited holds, preset references and percent phaser steps/timing. Its status appears in every receipt and checkpoint. Physical conversion and richer distributed phase can be `unavailable`; that status is retained separately from fingerprint coverage and is not presented as full stored semantic verification. A matching fingerprint is not a final stage-output comparison or an audit of every activation sibling. Dependencies outside the declared preset graph, external playback, hardware grants and network delivery still require their own verification or explicit invalidation.

Jobs are owned by the running MCP server process. Losing the client connection can leave that server working; stopping the server cannot continue execution in a new process. The durable journal preserves safe completed checkpoints and refuses uncertain in-flight work. This is deliberate: a crash cannot safely reveal whether an unacknowledged Store executed.

A terminal success or resumable status is published only after its final journal write and writer-claim cleanup settle. Local status waits for that owned lifetime; another process sees `running` while the worker still holds its claim. A cleanup failure reports `uncertain` and preserves the claim for inspection.

The bundled JSON-lines CLI (`scripts/mcp-session.mjs`) drains `gma3_programming_job` run/resume requests to a terminal checkpoint before closing its stdio server, including when piped stdin has already reached EOF. It prints changed progress to stderr and the terminal result to stdout, with `jobWait` timing/poll counts. It only polls status; it never replays run/resume. A timed-out status read is safe to repeat. Other MCP hosts must likewise retain the server process while a job is running; killing that process leaves its in-flight journal uncertain.

Run `node --import tsx --test test/jobs-*.test.ts` and `npm run build`. Tests cover zero bridge work before run, restart persistence, cancellation/resume, cross-process ownership, unknown mutation refusal, content/identity drift, complete native snapshots, timing failures and journal integrity. Console qualification belongs in an isolated disposable show with reserved sequence numbers; never point those checks at a live show.
