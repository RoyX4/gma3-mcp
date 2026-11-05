import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCueTrackingActionTools } from "../src/tools/cue-tracking-actions.ts";
import { startHarness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

const row = (value: number, fixture = "1", attribute = "Dimmer", blocked = false) => ({ fixture, attribute, hasAbsolute: true, hasRelative: false, value, stepCount: 1, dictFlags: { blocked: blocked ? 1 : 0 } });
const part = (no: number, rows: unknown[]) => ({ no, fields: { TrackingDistance: "" }, contentJson: JSON.stringify({ byFixtures: true, truncated: false, rows }), rawChannelsJson: JSON.stringify(rows) });
const cue = (no: number, rows: unknown[], parts?: unknown[]) => ({ no: no * 1000, fields: { Release: "", AllowDuplicates: "" }, parts: parts ?? [part(0, rows)] });
async function fixture() {
  const h = await startHarness(registerCueTrackingActionTools);
  const native = { complete: true, sequence: { fields: { Tracking: "Yes" } }, cues: [cue(1, [row(40), row(50, "2", "Pan")]), cue(2, []), cue(3, [])] };
  const locks: Record<string, unknown> = {};
  h.fake.on("fast.context", () => ({ contextKey: "same", environment: "Normal", identityUncertain: [] }));
  h.fake.on("cue.content", () => structuredClone(native));
  h.fake.on("objects", a => ({ total: 1, count: 1, offset: 0, items: [{ fields: { Lock: locks[String(a.ref)] ?? "" } }] }));
  h.fake.onCommand(command => {
    const number = Number(/Cue (\d+)/.exec(command)![1]), pn = 0;
    const c = native.cues.find(c => c.no === number * 1000)!;
    const existing = c.parts.find((p: any) => p.no === pn) as any;
    const rows = command.startsWith("Unblock") ? [] : [row(40, "1", "Dimmer", true)];
    Object.assign(existing, part(pn, rows));
    return "OK";
  });
  return { ...h, native, locks };
}
const args = { sequence: 10, cues: [2], fixtures: ["1"], attributes: ["Dimmer"] };

test("native Block materializes explicit scoped static values without changing sequence-owned looks", async t => {
  const h = await fixture(); t.after(() => h.close());
  const r = await h.callJson("gma3_cue_tracking_action", { ...args, action: "block" });
  assert.equal(r.isError, false, r.text); assert.equal(r.result.verification.status, "matched");
  assert.deepEqual(h.fake.commands, ['Block Sequence 10 Cue 2 If Fixture 1 Attribute "Dimmer" EndIf']);
  assert.equal(JSON.parse((h.native.cues[1].parts[0] as any).contentJson).rows[0].value, 40);
});
test("native Unblock removes redundant scoped hard data while preserving tracked values", async t => {
  const h = await fixture(); t.after(() => h.close()); h.native.cues[1].parts = [part(0, [row(40, "1", "Dimmer", true)])];
  const r = await h.callJson("gma3_cue_tracking_action", { ...args, action: "unblock" });
  assert.equal(r.isError, false, r.text); assert.equal(r.result.verification.status, "matched");
  assert.deepEqual(JSON.parse((h.native.cues[1].parts[0] as any).contentJson).rows, []);
});
test("preview validates complete state but sends no action", async t => {
  const h = await fixture(); t.after(() => h.close());
  const r = await h.callJson("gma3_cue_tracking_action", { ...args, action: "block", preview: true });
  assert.equal(r.isError, false, r.text); assert.equal(r.result.preview, true); assert.equal(h.fake.commands.length, 0);
});
test("ignored Block acknowledgement mismatches and prevents the next cue action", async t => {
  const h = await fixture(); t.after(() => h.close()); h.fake.onCommand(() => "OK");
  const r = await h.callJson("gma3_cue_tracking_action", { ...args, cues: [2, 3], action: "block" });
  assert.equal(r.isError, true); assert.equal(r.result.verification.status, "mismatched"); assert.equal(h.fake.commands.length, 1);
});
test("later locked cue and scoped phaser/preset refuse all actions before mutation", async t => {
  const h = await fixture(); t.after(() => h.close());
  h.locks["Sequence 10 Cue 3"] = "UL";
  assert.equal((await h.callJson("gma3_cue_tracking_action", { ...args, cues: [2, 3], action: "block" })).isError, true);
  assert.equal(h.fake.commands.length, 0); delete h.locks["Sequence 10 Cue 3"];
  for (const extra of [{ stepCount: 2, steps: [{ absolute: 0 }, { absolute: 100 }] }, { absPreset: { pool: 1, no: 1 } }]) {
    h.native.cues[0].parts = [part(0, [{ ...row(40), ...extra }])];
    assert.equal((await h.callJson("gma3_cue_tracking_action", { ...args, action: "block" })).isError, true);
    assert.equal(h.fake.commands.length, 0);
  }
});
test("changes outside requested fixtures/attributes/part are rejected by final hard-data checks", async t => {
  const h = await fixture(); t.after(() => h.close());
  h.fake.onCommand(() => { h.native.cues[1].parts = [part(0, [row(40), row(99, "2", "Pan")])]; return "OK"; });
  const r = await h.callJson("gma3_cue_tracking_action", { ...args, action: "block" });
  assert.equal(r.isError, true); assert.equal(r.result.verification.status, "mismatched");
});
test("dispatched action timeout is unknown, never retried and stops the batch", async t => {
  const h = await fixture(); t.after(() => h.close()); h.fake.onCommand(() => SILENT);
  const r = await h.callJson("gma3_cue_tracking_action", { ...args, cues: [2, 3], action: "block" });
  assert.equal(r.isError, true); assert.equal(r.result.outcome, "unknown"); assert.equal(h.fake.commands.length, 1);
});
test("a scoped channel in a nonzero part refuses the cue-level native action", async t => {
  const h = await fixture(); t.after(() => h.close());
  h.native.cues[1].parts = [part(0, []), part(2, [row(40)])];
  const r = await h.callJson("gma3_cue_tracking_action", { ...args, action: "block" });
  assert.equal(r.isError, true);
  assert.equal(h.fake.commands.length, 0);
});
test("invalid or ambiguous scope refuses before any bridge request", async t => {
  const h = await fixture(); t.after(() => h.close());
  for (const changes of [{ fixtures: [] }, { attributes: [] }, { cues: [] }, { cues: [2, 2] }, { fixtures: ["Group 1"] }, { attributes: ['Dimmer";Go'] }, { part: -1 }]) {
    const r = await h.callJson("gma3_cue_tracking_action", { ...args, action: "block", ...changes });
    assert.equal(r.isError, true); assert.equal(h.fake.requests.length, 0);
  }
});

test("an attribute case alias uses the native name in the materialization check", async t => {
  const h = await fixture(); t.after(() => h.close());
  const r = await h.callJson("gma3_cue_tracking_action", { ...args, attributes: ["dimmer"], action: "block" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.result.verification.status, "matched");
});
