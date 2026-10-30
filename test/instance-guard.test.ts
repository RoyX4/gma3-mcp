import { test } from "node:test";
import assert from "node:assert/strict";
import { Gma3Bridge, BridgeError } from "../src/bridge.ts";
import { FakeBridge } from "./helpers/fake-bridge.ts";

test("named instance guard refuses wrong station/show before dispatch and checks again after reconnect", async () => {
  const fake = new FakeBridge(); const port = await fake.listen();
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port, expectedStation: "Lab", expectedShows: ["Test"] });
  let identity = { hostname: "Wrong", showfile: "Test" };
  fake.on("ping", () => identity); fake.on("cmd", () => ({ feedback: "OK" }));
  try {
    await assert.rejects(bridge.request("cmd", { command: "Store Cue 1" }), e => e instanceof BridgeError && !e.dispatched);
    assert.equal(fake.requests.filter(r => r.op === "cmd").length, 0);
    identity = { hostname: "Lab", showfile: "Test" };
    await bridge.request("cmd", { command: "Store Cue 1" });
    bridge.close(); identity = { hostname: "Lab", showfile: "Other" };
    await assert.rejects(bridge.request("cmd", { command: "Store Cue 2" }), /expected show/);
    assert.equal(fake.requests.filter(r => r.op === "cmd").length, 1);
  } finally { bridge.close(); await fake.close(); }
});
test("instance guard checks same-connection show changes and preserves read-only diagnosis", async () => {
  const fake = new FakeBridge(); const port = await fake.listen();
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port, expectedStation: "Lab", expectedShows: ["Test"] });
  let showfile = "Test"; fake.on("ping", () => ({ hostname: "Lab", showfile }));
  fake.on("set", () => true); fake.on("object", () => ({ name: "evidence" }));
  try {
    await bridge.request("set", { ref: "Sequence 1", property: "Name", value: "One" });
    showfile = "Other";
    await assert.rejects(bridge.request("set", { ref: "Sequence 1", property: "Name", value: "Two" }), /expected show/);
    assert.deepEqual(await bridge.request("object", { ref: "Sequence 1" }), { name: "evidence" });
    assert.equal(fake.requests.filter(r => r.op === "set").length, 1);
  } finally { bridge.close(); await fake.close(); }
});

test("writer lease acquisition and renewal require expected identity, while status and cleanup remain available", async () => {
  const fake = new FakeBridge(); const port = await fake.listen();
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port, expectedStation: "Lab", expectedShows: ["Test"] });
  let station = "Wrong";
  fake.on("ping", () => ({ hostname: station, showfile: "Test" }));
  fake.on("fast.lease", (a) => ({ action: a.action, active: false, owned: false, token: "lease" }));
  try {
    await assert.rejects(bridge.request("fast.lease", { action: "acquire", contextKey: "foreign-context" }), /expected station/);
    await assert.rejects(bridge.request("fast.lease", { action: "renew", token: "lease" }), /expected station/);
    assert.equal(fake.requests.filter(r => r.op === "fast.lease").length, 0);
    await bridge.request("fast.lease", { action: "status" });
    await bridge.request("fast.lease", { action: "release", token: "lease" });
    station = "Lab";
    await bridge.request("fast.lease", { action: "acquire", contextKey: "lab-context" });
    assert.deepEqual(fake.requests.filter(r => r.op === "fast.lease").map(r => r.args.action), ["status", "release", "acquire"]);
  } finally { bridge.close(); await fake.close(); }
});

test("batch start requires expected identity while retained receipts and cancellation remain available after drift", async () => {
  const fake = new FakeBridge(); const port = await fake.listen();
  const bridge = new Gma3Bridge({ host: "127.0.0.1", port, expectedStation: "Lab", expectedShows: ["Test"] });
  fake.on("ping", () => ({ hostname: "Lab", showfile: "Other" }));
  fake.on("fast.batch", (a) => ({ action: a.action, id: a.id, status: "cancelled" }));
  try {
    await assert.rejects(bridge.request("fast.batch", { action: "start", contextKey: "foreign-context", steps: [] }), /expected show/);
    await assert.rejects(bridge.request("fast.batch", { action: "future-action" }), /expected show/);
    assert.equal(fake.requests.filter(r => r.op === "fast.batch").length, 0);
    for (const action of ["status", "list", "cancel"]) await bridge.request("fast.batch", { action, id: "owned-retained-batch" });
    assert.deepEqual(fake.requests.filter(r => r.op === "fast.batch").map(r => r.args.action), ["status", "list", "cancel"]);
  } finally { bridge.close(); await fake.close(); }
});
