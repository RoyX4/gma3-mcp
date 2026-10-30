import { test } from "node:test";
import assert from "node:assert/strict";
import { registerFastpathTools } from "../src/tools/fastpath.ts";
import { validateFastBatch } from "../src/fastpath.ts";
import { startHarness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

test("batch validation refuses raw Lua, compound commands and missing lease before network", async () => {
  const h = await startHarness(registerFastpathTools);
  try {
    for (const command of ["ClearAll; Store Sequence 1", "Lua 'x=1'", "Plugin 1", "ClearAll\nStore Sequence 1"]) {
      assert.equal((await h.call("gma3_batch", { action: "start", context_key: "ctx", lease_token: "lease", steps: [{ op: "cmd", args: { command } }] })).isError, true);
    }
    assert.equal((await h.call("gma3_batch", { action: "start", context_key: "ctx", steps: [{ op: "cmd", args: { command: "ClearAll" } }] })).isError, true);
    assert.equal(h.fake.requests.length, 0);
    assert.deepEqual(validateFastBatch([{ op: "cmd", args: { command: 'Label Sequence 1 "Lua look"' } }]), []);
  } finally { await h.close(); }
});

test("batch start forwards explicit steps once and status surfaces uncertainty", async () => {
  const h = await startHarness(registerFastpathTools);
  h.fake.on("fast.batch", (a) => a.action === "start" ? { id: "b", status: "running" } : { id: "b", status: "unknown", steps: [{ status: "unknown" }, { status: "skipped" }] });
  try {
    const steps = [{ op: "cmd", args: { command: "ClearAll" } }, { op: "programmer", args: { attributes: ["Dimmer"] }, expect: { path: "total", value: 0 } }];
    const start = await h.callJson("gma3_batch", { action: "start", context_key: "ctx", lease_token: "lease", steps });
    assert.equal(start.result.id, "b"); assert.equal(start.isError, false);
    assert.deepEqual(h.fake.requests[0].args.steps, steps);
    assert.equal((await h.call("gma3_batch", { action: "status", id: "b" })).isError, true);
    assert.equal(h.fake.requests.length, 2);
  } finally { await h.close(); }
});

test("lost batch start is never replayed", async () => {
  const h = await startHarness(registerFastpathTools, { requestTimeoutMs: 50 });
  h.fake.on("fast.batch", () => SILENT);
  try {
    const r = await h.call("gma3_batch", { action: "start", context_key: "ctx", lease_token: "lease", steps: [{ op: "cmd", args: { command: "ClearAll" } }] });
    assert.equal(r.isError, true); assert.match(JSON.stringify(r), /Nothing was retried/);
    assert.equal(h.fake.requests.length, 1);
  } finally { await h.close(); }
});

test("snapshot filter and cursor are forwarded without a second scan request", async () => {
  const h = await startHarness(registerFastpathTools);
  h.fake.on("programmer.snapshot", (a) => ({ snapshotId: "s", nextCursor: a.action === "create" ? "s/1" : undefined, rows: [], frozen: true }));
  try {
    await h.call("gma3_programmer_snapshot", { action: "create", scope: "fixtures", fixtures: "Fixture 1", attributes: ["Pan"], max_channels: 32, limit: 1 });
    await h.call("gma3_programmer_snapshot", { action: "page", snapshot_id: "s", cursor: "s/1", limit: 1 });
    assert.deepEqual(h.fake.requests.map((r) => r.op), ["programmer.snapshot", "programmer.snapshot"]);
    assert.deepEqual(h.fake.requests[0].args.attributes, ["Pan"]);
    assert.equal(h.fake.requests[0].args.maxChannels, 32);
    assert.equal(h.fake.requests[1].args.cursor, "s/1");
    assert.equal((await h.call("gma3_programmer_snapshot", { action: "create", attributes: [] })).isError, true);
    assert.equal(h.fake.requests.length, 2);
  } finally { await h.close(); }
});
