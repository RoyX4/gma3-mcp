import { test } from "node:test";
import assert from "node:assert/strict";
import { registerConnectionTools } from "../src/tools/connection.ts";
import { startHarness } from "./helpers/tool-harness.ts";

test("checked reconnect opens a new socket and verifies exact station/show without replaying writes", async () => {
  const h = await startHarness(registerConnectionTools);
  h.fake.on("ping", () => ({ hostname: "Lab", showfile: "Test", bridgeVersion: "0.44.0" }));
  try {
    await h.ctx.bridge.request("ping");
    const result = await h.callJson("gma3_reconnect", { expected_station: "Lab", expected_show: "Test" });
    assert.equal(result.isError, false);
    assert.equal(result.result.status, "verified");
    assert.equal(h.ctx.bridge.diagnostics.connections, 2);
    assert.ok(h.fake.requests.every(r => ["ping", "fast.batch", "fast.lease"].includes(r.op)), "only read-only idle checks and identity reads are sent");
  } finally { await h.close(); }
});

test("reconnect cannot discard an asynchronous native batch after its start call returned", async () => {
  const h = await startHarness(registerConnectionTools);
  h.fake.on("ping", () => ({ hostname: "Lab", showfile: "Test" }));
  h.fake.on("fast.batch", () => ({ batches: [{ id: "owned-batch", status: "running", nextStep: 2 }] }));
  h.fake.on("fast.lease", () => ({ active: false, owned: false }));
  try {
    await h.bridge.request("ping");
    const r = await h.callJson("gma3_reconnect", { expected_station: "Lab", expected_show: "Test" });
    assert.equal(r.isError, true); assert.equal(r.result.status, "refused");
    assert.match(r.result.error, /batch/i); assert.equal(h.bridge.diagnostics.connections, 1);
    assert.equal(h.bridge.connected, true);
  } finally { await h.close(); }
});

test("reconnect refuses its own live writer lease without interrupting another connection's lease", async () => {
  const h = await startHarness(registerConnectionTools);
  h.fake.on("ping", () => ({ hostname: "Lab", showfile: "Test" }));
  h.fake.on("fast.batch", () => ({ batches: [] }));
  let owned = true;
  h.fake.on("fast.lease", () => ({ active: true, owned, expiresAt: 123 }));
  try {
    await h.bridge.request("ping");
    const refused = await h.callJson("gma3_reconnect", { expected_station: "Lab", expected_show: "Test" });
    assert.equal(refused.isError, true); assert.equal(refused.result.status, "refused");
    assert.match(refused.result.error, /lease/i); assert.equal(h.bridge.diagnostics.connections, 1);
    owned = false;
    assert.equal((await h.callJson("gma3_reconnect", { expected_station: "Lab", expected_show: "Test" })).isError, false);
    assert.equal(h.bridge.diagnostics.connections, 2);
  } finally { await h.close(); }
});

test("malformed native idle evidence cannot be treated as an idle socket", async () => {
  const h = await startHarness(registerConnectionTools);
  h.fake.on("ping", () => ({ hostname: "Lab", showfile: "Test" }));
  h.fake.on("fast.batch", () => ({ batches: "unreadable" }));
  try {
    await h.bridge.request("ping");
    const r = await h.callJson("gma3_reconnect", { expected_station: "Lab", expected_show: "Test" });
    assert.equal(r.isError, true); assert.equal(r.result.status, "refused");
    assert.equal(h.bridge.diagnostics.connections, 1);
  } finally { await h.close(); }
});

test("null native idle evidence is unreadable rather than an unsupported legacy operation", async () => {
  const h = await startHarness(registerConnectionTools);
  h.fake.on("ping", () => ({ hostname: "Lab", showfile: "Test" }));
  h.fake.on("fast.batch", () => null);
  h.fake.on("fast.lease", () => ({ active: false, owned: false }));
  try {
    await h.bridge.request("ping");
    const r = await h.callJson("gma3_reconnect", { expected_station: "Lab", expected_show: "Test" });
    assert.equal(r.isError, true); assert.equal(r.result.status, "refused");
    assert.equal(h.bridge.diagnostics.connections, 1);
  } finally { await h.close(); }
});
