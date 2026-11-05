import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Gma3Bridge, BridgeError } from "../src/bridge.ts";
import { FakeBridge, SILENT } from "./helpers/fake-bridge.ts";

const connect = async () => {
  const fake = new FakeBridge();
  const port = await fake.listen();
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port, requestTimeoutMs: 100 });
  return { fake, bridge };
};

test("review: a new explicit request after cancelling a connection starts a fresh session", async () => {
  const { fake, bridge } = await connect();
  fake.on("ping", () => "new session");
  try {
    const cancelled = bridge.connect().then(() => "opened", () => "cancelled");
    bridge.close();
    // Deliberately do not await the cancelled attempt: this request was made after close().
    const replacement = bridge.request("ping");
    assert.equal(await cancelled, "cancelled");
    assert.equal(await replacement, "new session");
    assert.equal(fake.requests.filter(r => r.op === "ping").length, 1);
  } finally { bridge.close(); await fake.close(); }
});

test("review: retired socket errors and data cannot reject or spoof a replacement request", async () => {
  const { fake, bridge } = await connect();
  fake.on("first", () => true);
  let release!: () => void;
  let reached!: () => void;
  const seen = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  fake.on("replacement", async () => { reached(); await gate; return "real reply"; });
  try {
    await bridge.request("first");
    const old = (bridge as unknown as { socket: net.Socket }).socket;
    const errorCallbacks = old.listeners("error"), dataCallbacks = old.listeners("data");
    bridge.close();
    const pending = bridge.request("replacement");
    await seen;
    const id = fake.requests.at(-1)!.id;
    for (const callback of dataCallbacks) callback(JSON.stringify({ id, ok: true, result: "stale spoof" }) + "\n");
    for (const callback of errorCallbacks) callback(new Error("late error from old socket"));
    assert.equal(bridge.connected, true);
    assert.equal(bridge.diagnostics.pendingRequests, 1);
    release();
    assert.equal(await pending, "real reply");
    assert.equal(bridge.diagnostics.connections, 2);
    assert.equal(bridge.diagnostics.disconnects, 1);
  } finally { release(); bridge.close(); await fake.close(); }
});

test("review: closing a dispatched mutation rejects it as unknown and never replays on reconnect", async () => {
  const { fake, bridge } = await connect();
  let reached!: () => void;
  const seen = new Promise<void>(resolve => { reached = resolve; });
  fake.on("cmd", () => { reached(); return SILENT; });
  fake.on("ping", () => true);
  try {
    const mutation = bridge.request("cmd", { command: "Store Cue 77" });
    const rejected = assert.rejects(mutation, (err: unknown) => err instanceof BridgeError && err.dispatched);
    await seen;
    bridge.close();
    await rejected;
    assert.equal(await bridge.request("ping"), true);
    assert.equal(fake.requests.filter(r => r.op === "cmd").length, 1);
    assert.equal(bridge.diagnostics.pendingRequests, 0);
    assert.equal(bridge.diagnostics.timeouts, 0);
  } finally { bridge.close(); await fake.close(); }
});
