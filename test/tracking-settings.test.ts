import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPlaybackTools } from "../src/tools/playback.ts";
import { startHarness } from "./helpers/tool-harness.ts";

test("a verified no-op Tracking=Yes configuration returns matched without writing settings", async () => {
  const h = await startHarness(registerPlaybackTools);
  try {
    h.fake.on("objects", () => ({ items: [{ name: "Sequence 500", addr: "1.2.3", hasActivePlayback: false, fields: { Name: "Sequence 500", Tracking: "Yes", Lock: "", StructureLocked: "No", SystemLocked: "No" } }] }));
    h.fake.on("children", () => ({ items: [] }));
    const r = await h.callJson("gma3_configure_sequence", { sequence: 500, tracking: true });
    assert.equal(r.result.noop, true);
    assert.equal(r.result.verification.status, "matched");
    assert.equal(h.fake.requests.some((r) => r.op === "set" || r.op === "cmd"), false);
    assert.ok(r.result.steps.some((s: any) => s.name === "read_back"));
  } finally { await h.close(); }
});

test("a setting that drifts after a no-op plan is mismatched by the fresh final read", async () => {
  const h = await startHarness(registerPlaybackTools);
  try {
    h.fake.on("objects", (a) => ({ items: [{ name: "Sequence 500", addr: "1.2.3", hasActivePlayback: false, fields: { Name: "Sequence 500", Tracking: Array.isArray(a.fields) && a.fields.length === 2 ? "No" : "Yes", Lock: "", StructureLocked: "No", SystemLocked: "No" } }] }));
    h.fake.on("children", () => ({ items: [] }));
    const r = await h.callJson("gma3_configure_sequence", { sequence: 500, tracking: true });
    assert.equal(r.result.verification.status, "mismatched");
    assert.equal(r.isError, true);
  } finally { await h.close(); }
});
