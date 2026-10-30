# Connection health and persistent sessions

`gma3_connection_check` sends only `ping` requests. It uses the current server's existing connection,
reports latency and transport counters, and can compare the exact expected show and station on every sample.

```json
{"samples":10,"interval_ms":100,"timeout_ms":1000,"expected_show":"MyShow","expected_station":"MyConsole"}
```

`samples` is 1–10 (default 3), `interval_ms` is 0–1000 (default 100), and `timeout_ms` is 50–4000
(default 1000). These bounded observations never poll inside Lua or mutate console state.

| Status | Meaning |
| --- | --- |
| `healthy` | Every ping answered during this check and any supplied expected identity matched |
| `wrong_instance` | Show/station differs from the expectation, or identity changed during the check |
| `intermittent` | Some pings answered and others failed |
| `unresponsive` | No ping answered and TCP remains connected |
| `unavailable` | No ping answered and TCP is disconnected |

A reachable bridge is not proof of hardware output or long-term stability. An unavailable bridge does not
prove that the MA application stopped. No automatic plugin start, restart, show switch, programmer clear,
output enablement or replay occurs. Expected identity in this check is not a lock on later operations.

`gma3_reconnect` takes exact `expected_station` and `expected_show` strings. Before closing an open
socket it refuses pending requests, running native batches owned by that connection, and its active
writer lease. It also refuses malformed or unavailable idle evidence, keeping the socket open for
inspection. Plugins that positively report these operations as unknown retain the legacy reconnect
path. A successful fresh identity check never resolves or replays an earlier uncertain mutation.
Configured instance guards also apply to writer-lease acquisition and renewal; lease status and
release remain available for diagnosis and cleanup after a show or station changes.
The same distinction applies to batches: start requires expected identity, while retained
status/list/cancel remain available after drift and the native bridge still checks their owning connection.

`gma3_status.connection` exposes the same process-local transport counters and times. The `connected`
flag remains a TCP observation; `responsive` requires a received reply. A timeout leaves its command's
outcome uncertain. The transport guards old socket callbacks so they cannot invalidate a replacement
connection, and closing a pending connection attempt cancels that attempt without blocking a fresh one.

`gma3_start_bridge` now passes the configured bridge port to the plugin start command. It sends one OSC
command and then checks ping. OSC must reach the intended instance; matching an IP alone does not identify
a private network namespace. A startup request does not restore a stopped plugin's optional input/Lua policy.

## Script several tools over one session

The existing one-shot `grandma3-control` helper intentionally creates and closes a session for each call.
For scripted workflows, feed JSON lines to `node scripts/mcp-session.mjs`:

```json
{"id":1,"tool":"gma3_connection_check","args":{"samples":3}}
{"id":2,"tool":"gma3_set_fixture_color","args":{"fixtures":[101],"color":"amber"}}
```

The session starts the compiled MCP server once, keeps the bridge connection, executes lines in order,
and emits one JSON result per line. It stops on a tool error, transport error or invalid input. It never
replays the failed line or continues into later programming. Normal EOF closes the session intentionally.
Environment settings such as `GMA3_BRIDGE_HOST`, `GMA3_BRIDGE_PORT` and the local helper path are preserved.
Use the instance's existing namespace wrapper when the bridge lives in a private namespace.

Each response now carries `timing.mcpConnectMs`, `timing.idleBeforeMs` and `timing.toolMs`. The first
measures MCP startup/initialization, the second time between completing the previous response and
processing this request, and the third the complete SDK tool call. Idle time can include agent/client
work or intentional pauses; it is not a direct measurement of model reasoning. Tool time includes
transport and MA work, not only native CPU. Error responses retain the active tool/ID and elapsed time.

Each input line may set `timeout_ms` (integer 50–600000; default 60000) independently of the tool's
own arguments and bridge-request deadline. For a reviewed longer batch, for example:

```json
{"tool":"gma3_store_cues","timeout_ms":240000,"args":{"sequence":9001,"exclusive":true,"cues":[]}}
```

Supply actual valid cue content; the empty list above is only the envelope shape. A larger client
deadline does not make the work faster or cancel it on expiry. The session stops on timeout and
does not dispatch the next line; inspect partial show state before retrying a mutation.

Automated checks use real local TCP sockets for disconnect/cancellation ordering, fake console replies
for bounded diagnosis, and actual MCP subprocesses for persistent-session behavior. Read-only native
checks establish current responsiveness; mutation qualification remains a separate test on a disposable show.
