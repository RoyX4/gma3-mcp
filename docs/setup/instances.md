# Named instances and maintained releases

One maintained Node build can serve several private consoles. Each route names its loopback port, exact station and allowed show names. A private namespace route also supplies the exact receipt, runner and Wine prefix. Selecting a route never launches or replaces an MA instance.

Use `node scripts/mcp-instance.mjs /absolute/instances.json name session` for persistent JSON-line requests, or use `mcp` as the last argument for an MCP stdio server. The configuration has `schemaVersion:1` and an `instances` object. Each entry contains `station`, `shows`, `port`, optional `namespace:{receipt,runner,prefix}`, and optional `install_dir`/`local_ui_helper` absolute paths. The host is loopback only.

The launcher verifies that the receipt PID still runs the configured runner and that its prefix matches. After namespace entry it checks the current network namespace and an unchanged profile digest. It clears inherited bridge routing variables, sets expected station/show guards and disables OSC sending. Before every potentially mutating TCP request, Node pings the same connected socket and checks expected identity. These guards reduce accidental routing mistakes; they do not lock out another console operator between native steps.

`gma3_connection_check` measures responsiveness and identity over a bounded observation. `gma3_reconnect` refreshes an idle connection without starting MA or replaying a command; active requests or owned native work can prevent reconnect. A sent mutation with a lost reply stays uncertain until observed state resolves it.

Three version checks answer different questions:

| Check | Meaning |
| --- | --- |
| Node build stamp | The running JavaScript matches the covered TypeScript inputs |
| Plugin source SHA-256 | The local Lua/XML source files match a release manifest |
| Runtime component fingerprints | The actual imported bridge/hardkeys/feedback/control bytecode matches the native qualification |

Runtime fingerprints are VM-specific noncryptographic change detectors. Source hashes and a current Node build do not prove that an already-running console imported new Lua. `deployment.json` records the observed software/Lua platform and component identities; missing evidence cannot establish qualification. Reload each private console only when its own work is safely saved and its owner permits it. A fresh launcher can use common Node code while an older running console plugin remains explicitly different.

## Configure your own route

Copy [the example profile](../../examples/instances.example.json) to an absolute local path, then replace its station and show names with the console you intend to use:

```bash
node scripts/mcp-instance.mjs /absolute/path/instances.json stage session
```

A basic profile can use the console's ordinary loopback connection. Namespace fields are optional and apply only to an explicitly managed Linux instance; use its actual receipt, runner and prefix. Personal station names, shows, filesystem paths and namespace receipts are not bundled with this source export.

Set `GMA3_BRIDGE_TIMEOUT_MS` explicitly when a native request needs a different bridge deadline. The persistent session's separate per-request `timeout_ms` defaults to 60000 and accepts a bounded explicit value. Neither deadline cancels an already-dispatched operation. Named routes do not install console plugins or launch/restart MA.

See [qualification scope](../qualification/2026-10-30.md) for the measured deployment and limits. A new Node process and an existing imported Lua plugin remain separate versions until each is checked.
