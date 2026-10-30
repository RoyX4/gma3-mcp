# How the grandMA3 MCP connects and programs a show

Current delivery state: this chat's disposable lab and its services were stopped at the user's request. Local integration is prepared, not yet claimed applied here; no further console test or plugin reload is part of that preparation. The latest general-PSR reproduction stopped before Finish. See the [portable qualification summary](qualification/2026-10-30.md).

The MCP gives an agent a set of checked console operations. The agent decides which lighting changes to request; the server translates those requests; grandMA3 still owns the programmer, stored show data and playback. Better programming therefore needs both dependable communication and a clear structure for the show.

The compact map is:

```text
Codex or another MCP client
        │ tool requests and results
        ▼
Node MCP server
        │ local TCP requests and replies
        ▼
Lua bridge running inside the intended grandMA3 instance
        │ grandMA3 commands and object APIs
        ▼
Programmer → presets and cues → sequence playback → output
```

There are two communication links and several different kinds of show state. Keeping those separate explains much of the apparently inconsistent behavior.

## The two links

The first link joins Codex to the Node server. Node is the program that advertises tools such as “read these fixtures” or “store these cues.” This setup uses standard input/output: the MCP client starts a server process and exchanges structured messages with it.

The second link joins Node to the Lua bridge plugin inside grandMA3. Node sends a request over a local TCP connection, and the plugin reads or changes console state and replies. Each request has an ID, so concurrent replies can be matched to the right caller.

Codex can successfully discover tools while the second link is unavailable. The Node server exists independently of the console plugin. Restarting Codex's MCP connection does not automatically start grandMA3 or its bridge.

The bridge must be imported and running in the intended show. Saving retains the imported plugin, but the running bridge needs starting again after a show load. Updating Node's build and importing updated console-plugin code are also separate operations. The Node build check compares its TypeScript inputs. Separate runtime fingerprints identify the actual imported bridge, hardkeys, feedback and control bytecode. A deployment manifest compares both with a measured qualification; a current Node build alone is insufficient.

## Why connection messages can be misleading

Some connection churn is intentional. The existing `grandma3-control` command starts a short-lived MCP client for one operation and closes it afterwards. A log that says “connected, request, disconnected” for each invocation can describe successful work. A persistent Codex MCP session can reuse its connection instead. The new `scripts/mcp-session.mjs` also accepts several JSON request lines over one connection and stops after an error; it avoids launching a fresh server for every line of a scripted workflow.

Other cases have different causes:

| Observation | What it establishes |
| --- | --- |
| Connection refused | Nothing is listening at that endpoint from this network context. The app may still be running. |
| TCP connected, request times out | A connection exists, but this request did not receive a reply in time. The console may be busy, blocked or slow. |
| Connection drops after a command was sent | The command's effect is uncertain until console state is inspected. |
| Replies identify another show/station | Communication works, but it reaches the wrong instance for this job. |

Some raw console commands can open a blocking dialog on the plugin thread, preventing the bridge from serving further requests. Structured workflows avoid particular known cases; for example, the save tool queues SaveShow and handles its expected confirmation separately. A timeout alone cannot identify the cause of a stall.

The upgraded transport records connection counts, timeouts, pending requests and the last reply. It distinguishes a responsive socket from one that has timed out. It also guards against a late close event from an old socket clearing a newly established connection. These are implemented behaviors covered by automated tests; they do not establish that every historical disconnect had that cause. See the [transport implementation](../src/bridge.ts#L94).

The strict twenty-minute lab connection check passed with 239 samples, one connection, zero disconnects/timeouts and unchanged generation/profile/module identities. It measured an idle native workload with read-only checks. An earlier four-second ping timeout overlapped a long native fingerprint request and remains a real failed observation; a healthy idle session does not prove every heavy operation will answer within four seconds. Later show/plugin loads start a new generation and do not automatically inherit that observation window. [Passed soak](qualification/2026-10-30.md), [retained failed attempt](qualification/2026-10-30.md).

## Instances, ports and private network rooms

A port is a numbered connection point. The main setup uses port `9800`; the secondary wrapper uses `9801`. The number configured in Node must match the plugin's listening port.

An isolated Linux console can use a network namespace. Think of each as a private network room: `127.0.0.1` means “inside this room.” A client outside that room cannot necessarily reach a bridge inside it, even with the correct port. The configured instance wrapper enters that console's verified namespace before starting its MCP server.

For reliable authoring, identify the instance by endpoint, network context, station and loaded show. The new `gma3_connection_check` samples replies on one persistent connection and can compare an expected show and station. It reports unavailable, unresponsive, intermittent, wrong-instance or healthy observations. Its healthy result describes the observation window. Named instance profiles additionally bind the route to expected station/show names; the transport checks a fresh ping on the same socket before each potential mutation. A profile never launches another console. The common launcher verifies namespace identity before entering and again inside it; it disables unguarded OSC sending for named routes.

## Using the maintained route

Configure a route using [the generic instance example](setup/instances.md), then use `node scripts/mcp-instance.mjs /absolute/path/instances.json stage session`. Pick the intended instance before sending requests; the route checks its namespace when configured, station and allowed show. It does not start MA, load a show or import a plugin.

The session reads one JSON request per line: `tool` names the operation, `args` supplies its inputs, and optional `timeout_ms` sets the client request wait. This lab example only reads status and samples the connection:

```bash
node scripts/mcp-instance.mjs /absolute/path/instances.json stage session <<'JSONL'
{"tool":"gma3_status","args":{},"timeout_ms":20000}
{"tool":"gma3_connection_check","args":{"samples":3,"interval_ms":100,"timeout_ms":4000,"expected_station":"MyConsole","expected_show":"MyShow"},"timeout_ms":20000}
JSONL
```

Both lines use one persistent session. Inspect the reported show/station, connection state and deployment information before programming. A fresh shared route uses the maintained Node build, while the console's imported Lua is a separate deployment: its actual fingerprints must match the intended qualification. Already-running older Codex connections and private clients keep their own code until separately reloaded and checked. This command does not update them or automatically import a plugin. A request timeout does not cancel or replay console work.

## Reconnection does not replay programming

When the socket is gone, a subsequent request can establish a new connection. That is different from repeating the previous request.

Suppose the agent sends “store Cue 12,” grandMA3 performs it, and the reply disappears. Repeating the command could merge into or overwrite something that already exists. The server therefore preserves an unknown outcome after dispatch. Reconnect, inspect Cue 12 and the programmer, then decide the next operation from observed state.

A show load or plugin restart can change the bridge generation while the saved show still contains the same data. Explicit rebind checks the station/show/profile, namespace and boot route, full owned cue content and dependencies before adopting that generation; rebind itself writes no cues. Resume is a separate action. A changed host boot or namespace is refused, and legacy opaque checkpoints cannot be converted by guessing. Versioned native fingerprints compare lossless JSON values rather than unstable object-key serialization order, so actual value changes and large integers remain meaningful.

The same rule applies within batches. An uncertain mutation stops the rest. Some general batch tools can continue independent items after a confirmed failure, depending on their options; uncertainty always stops them. A partial batch leaves completed work in place. See [batch behavior](../src/batch.ts#L1).

## What programming actually changes

The programmer is grandMA3's temporary working area. Selecting a fixture chooses what subsequent commands address. Setting intensity, colour or position puts values in the programmer. It does not automatically create a preset or cue.

Selection and stored working values are separate. `ClearSelection` deselects fixtures while keeping programmer values. `ClearAll` discards programmer content too. Selecting a different group does not prove that values from the previous group have disappeared.

Storage needs deliberate scope because active programmer channels can be stored even when their fixtures are no longer selected. The preset workflow scans the programmer and rejects content outside its requested fixtures, attributes or layers. Its storage mode also matters: selective data belongs to individual fixtures, global data is organized by fixture type, and universal data is shared by attribute. Different fixture values cannot always survive conversion to a shared mode. See [preset storage rules](tools/presets.md#L18).

A useful programming chain is: select explicit fixtures, apply a named colour/focus/intensity, verify the programmer, store a reusable preset, then reference it from cues. This makes the resulting show easier to revise than repeatedly writing unrelated numeric values.

## Cues, tracking and visible output

A sequence is an ordered cue list. A cue stores lighting data, references, timing and other settings. Playing the sequence causes grandMA3 to resolve that information over time.

With tracking enabled, an attribute can continue from an earlier cue when a later cue does not replace it. For example, Cue 1 can establish blue at 50 percent intensity; Cue 2 can change intensity to 80 percent while blue continues. Releases, blocks, assertions and other show settings can alter that behavior. An isolated cue's stored rows therefore do not necessarily describe the complete stage state at that moment.

Playback is another layer. Active programmer values, other sequences, priorities, executor levels and masters can affect the result. DMX output configuration and granted parameters then affect what is transmitted. “Cue stored,” “sequence reached this cue,” “output observed” and “physical fixture responded” are different claims.

The current native cue reader also reads hard CuePart channels through GetPresetData. It reconstructs sequence-owned tracking with source cue/part, including numeric Tracking Distance and Release. It refuses a complete claim for unsupported or incomplete native data. This still does not identify the winner across every playback, programmer and master. See [stored cue reading](tools/native-cues.md).

## Preview builds and reusable show structure

The batch cue builder stages looks in grandMA3's Preview environment, which has its own programmer and selection. It checks the Normal programmer before and after, applies and checks each look in Preview, then stores the cue. Its `ClearAll` is confined to Preview. This lets it construct stored programming without auditioning those looks as live output.

Stored cues and presets still change. Preview is a programming environment, not a separate disposable show, and another operator can still interfere. The server's mutation lock orders that server process's operations; `exclusive:true` expresses the required working conditions rather than providing a console-wide transaction.

Organize fixtures into role-based groups such as front wash, specials and backlight. A role is an agreed naming/programming convention, not automatic lighting understanding. Preserve selection grids because their order controls how MAtricks and phaser phases distribute across fixtures. Physical placement and selection-grid order serve different purposes.

Use position and colour presets as shared ingredients. Recipes connect selections, presets and distributions to targets; grandMA3 cooks those ingredients into stored data. Referenced ingredients can make a rig revision manageable, but cooking and changes to dependencies must be checked. See [Preview cue construction](../src/tools/cuelists.ts#L1772).

## What the upgrades add

The focus tool turns a named stage coordinate into legal physical Pan/Tilt values using live placement, fixture limits and supplied optical calibration. It chooses a nearby equivalent angular branch, accounts for supplied pivot/emitter offsets and can test sampled transition rays against supplied wall boxes. Native programmer readback passed with explicit synthetic calibration. The samples do not prove continuous beam clearance, native shadows or a real fixture’s optical calibration.

Fixture-aware colour plans across RGB, explicitly mapped subtractive CMY, calibrated wheel samples, CCT and warm/cool white channels. It reads attributes, preflights the whole request and verifies the explicit fixture/cell's programmer values. Physical colour matching still depends on calibration and optics.

MVR inspection and revision comparison preserve UUID identity, show changed transforms, fixture data and assets, and report conflicts. Native export verifies a newly produced MVR file through an explicitly mapped console folder. The positions-only apply tool accepts explicit fixture UUID decisions, preserves local patch addresses and other fixtures, then checks a fresh export and native patch/programming state. Its native test moved only fixture 1 and preserved conflicting local addresses, fixture 2, cues, presets and groups. General Partial Show Read (PSR) remains unqualified: a separate native test unexpectedly changed DmxCurves, and that failure is retained. Camera and 2D Layout tools create checked workspace objects. Appearance tools verify assignments; screen construction appends windows in unoccupied grid space. Actual Camera9010→9012→9010 binding and strict View save/recall passed, including the saved window tree, target child name/pose and camera reference. That camera test deliberately ended at Camera9010’s saved pose; it did not restore the initial navigated pose. These checks establish object state; screenshot provenance and physical lighting remain separate evidence.

Programming correctness also improves through explicit Percent/BPM phaser units, the regression-tested two-wing correction, verification of all requested executor settings, and explicit-fixture programmer readback. Automated regressions cover these changes. The disposable lab additionally qualified RGB programming, synthetic calibrated focus, camera/Layout/appearance/window construction, recipes and phaser recipes, multiple DMX breaks, compound removal, recording state and exact direct fader timecode events. Calibrated CMY, wheel, CCT and white routes still need appropriate native fixtures; physical beam/output claims require their own observations.


## The tracking and durable programming path

A complete desired cue plan is compiled before the console is changed. Tracking reduces repeated assignments; durable checkpoints add work of their own, so fewer assignments do not automatically mean a faster complete job. The compiler distinguishes an inherited value, explicit zero, release, absolute/relative layer, preset link and phaser. It calculates changes, blocks and cue-only restoration rather than rebuilding every channel in every cue. A deliberate hold cue still exists even when its change list is empty.

`gma3_programming_job` prepares this plan offline. Running it starts continuous server-side work; status reports verified cue counts, requests, phase timing and durable receipts. Each bounded batch builds in Preview, verifies relevant programmer state, stores cues and compares actual stored native owned state. Compatible final checks share a complete snapshot; checks needed before an intentional overwrite still happen at that point. Attribute filters skip irrelevant native phaser reads. Frozen programmer snapshots page one observation instead of rescanning each page.

New durable jobs default to twelve cues per batch. In the matched Intel lab matrix, twelve cues took a durable median of 22.729 seconds at batch size twelve, compared with 60.693 seconds at batch size three. Baseline full-state authoring at batch twelve was 22.884 seconds, so the result supports the batch-size choice rather than a general speed multiplier over baseline. Those measurements include verification and SaveShow on the stated synthetic rig; they do not time lighting design or physical checks. Existing journals and explicit smaller batch options retain their settings.

The final-build NVIDIA comparison also passed all nine equal-state twelve-cue samples. Baseline/current full-state/durable whole-job medians were 18.989/18.972/20.250 seconds, despite durable jobs sending fewer native requests. Complete dependency observation still costs time, so this workload establishes no material speed gain over baseline. Separate Intel/NVIDIA runs do not establish graphics-processor causality.

Cancellation stops between verified batches after Preview cleanup. Resume checks the console/show/user/profile, exact owned native content and patch/preset dependencies. A missing reply after a mutation produces an uncertain state that is inspected rather than replayed. A manual edit can block resume or explicitly invalidate the journal. The piped persistent session waits for admitted jobs to reach a terminal state before exiting; closing input is not permission to kill work halfway through Store.

## Running a reviewed cue plan

Prepare the whole intended cue plan, read its returned job ID, then run that ID. Preparation writes a local job record and does no console programming. Choose an unused sequence and the real fixtures first; `9901` and fixture `1` below are examples to replace for your plan:

```json
{"tool":"gma3_programming_job","args":{"action":"prepare","plan":{"version":1,"sequence":9901,"cues":[{"cue":1,"changes":[{"kind":"value","fixtures":"1","attribute":"Dimmer","value":40}]}]}}}
```

Submit that line to the chosen `node scripts/mcp-instance.mjs /absolute/path/instances.json stage session`, inspect the plan/result, and copy its returned UUID into the next request. Running requires `run:true` and `exclusive:true`: nobody else may program that console during the job.

```json
{"tool":"gma3_programming_job","args":{"action":"run","id":"<returned UUID>","run":true,"exclusive":true}}
```

The persistent CLI prints progress while waiting and keeps its server alive until the admitted job reaches a terminal state, even if piped input has ended. It does not replay `run` or kill the server halfway through Store. In an MCP client that returns immediately, use `status` to observe the same job.

| Job action | Inputs after the returned ID | What happens |
| --- | --- | --- |
| `status` | `{"action":"status","id":"<returned UUID>"}` | Read verified progress, timing and receipts. |
| `cancel` | `{"action":"cancel","id":"<returned UUID>"}` | Stop after the active verified batch and Preview cleanup. |
| `resume` | `{"action":"resume","id":"<returned UUID>","run":true,"exclusive":true}` | Continue only after exact context/content/dependency checks pass. |
| `rebind` | `{"action":"rebind","id":"<returned UUID>","exclusive":true}` | After a saved-show/plugin generation change on the same qualified route, prove unchanged content using console reads; it does not resume. A separate `resume` is required. |

These action objects belong in `args` with `tool:"gma3_programming_job"`. A changed boot/namespace, manual edit or uncertain in-flight mutation can refuse recovery; inspect the receipt instead of repeating Store. New jobs default to twelve cues per batch to reduce repeated observation work. Smaller explicit `batch_size` values give more frequent cancellation checkpoints; saved jobs keep their original option. The matched twelve-cue benchmark took about twenty seconds on this synthetic rig, including checks and a separate verified SaveShow; that is not a promise about lighting design or a different show. The job itself does not save the show: use `gma3_save_show` deliberately after successful verification if you want the stored changes saved.

See [durable job actions and recovery](tools/jobs.md) and [measured performance](programming-performance.md) for the complete contract and qualification limits.

`gma3_batch` is a separate bounded native queue: individual command/read/set results, fresh context checks, a short cooperative writer lease and one step per native frame. It reduces client round trips while keeping per-step outcomes. It is not an atomic show transaction. A long native command or modal dialog can still stall MA; a connected socket does not prove progress.

The remaining timing distinction matters: designing a cue, writing it, seeing the resulting stage, checking playback and recovering an unrelated dialog are different phases. A measured native read improvement is not automatically an equal improvement to the whole creative workflow. The [performance page](programming-performance.md) retains the original timings and the current measurement protocol. [qualification scope](qualification/2026-10-30.md) separates source implementation, native qualification and physical prerequisites.

Raw workstation records linked in earlier local drafts are not distributed here. References to measured results lead to the [portable qualification summary](qualification/2026-10-30.md); source-code links remain directly inspectable.
