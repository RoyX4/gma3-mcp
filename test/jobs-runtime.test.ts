import { test } from "node:test";
import assert from "node:assert/strict";
import { observeSequence, timedBridge } from "../src/jobs/runtime.ts";
import { compileTracking } from "../src/tracking/model.ts";
import { startHarness } from "./helpers/tool-harness.ts";
const plan = () => compileTracking({ version: 1, sequence: 500, data_pool: 2, cues: [{ cue: 1, changes: [{ kind: "value", fixtures: "1", attribute: "Dimmer", value: 30 }] }] });
const context = { identity: { generation: "1", showfile: "Private.show", hostname: "lab", user: "user", profile: "profile" }, contextKey: "same", environment: "Normal", identityUncertain: [], observedAt: 0, atomic: false };
const patch = (h: Awaited<ReturnType<typeof startHarness>>) => h.fake.on("patch.collections", () => ({ live: ["Stages", "FixtureTypes", "AttributeDefinitions"] })).on("patch.fingerprint", (a) => ({ collection: a.collection, hash: "stable", objects: 10, complete: true, ms: Math.random() * 100 }));

test("native checkpoints bind an explicitly absent sequence and guard both ends of the read", async () => {
  const h = await startHarness(() => {});
  try {
    h.fake.on("fast.context", () => context).on("objects", () => ({ items: [] })).on("object", () => ({ class: "DataPool", index: 1 }));
    patch(h);
    const r = await observeSequence(h.ctx, plan());
    assert.equal(r.complete, true);
    assert.equal(r.contextKey, "same");
    assert.equal((r.detail as any).existingCueCount, 0);
    assert.equal(h.fake.requests.find((r) => r.op === "objects")?.args.ref, "DataPool 2 Sequence 500");
    assert.equal(r.requests?.length, 7);
    assert.equal(h.fake.commands.length, 0);
  } finally { await h.close(); }
});

test("checkpoints hash native raw channel bytes, reject incomplete content and detect identity drift", async () => {
  const h = await startHarness(() => {});
  try {
    let raw = JSON.stringify({ entries: [{ keyType: "string", key: "absolute", value: 30 }] }), complete = true;
    h.fake.on("fast.context", () => context).on("objects", () => ({ items: [{ name: "Sequence 500" }] }));
    patch(h);
    h.fake.on("cue.content", () => ({ complete, sequence: { fields: { Tracking: "Yes" } }, cues: [{ no: 1, parts: [{ encoding: "json", contentJson: "{}", rawChannelsJson: raw }] }], limitations: [] }));
    const a = await observeSequence(h.ctx, plan()); raw = JSON.stringify({ entries: [{ keyType: "string", key: "absolute", value: 80 }] });
    const b = await observeSequence(h.ctx, plan());
    assert.notEqual(a.contentFingerprint, b.contentFingerprint);
    complete = false;
    assert.equal((await observeSequence(h.ctx, plan())).complete, false);
    let count = 0;
    h.fake.on("fast.context", () => ({ ...context, contextKey: count++ ? "different" : "same" }));
    await assert.rejects(() => observeSequence(h.ctx, plan()), /changed/);
    assert.equal(h.fake.commands.length, 0);
  } finally { await h.close(); }
});

test("checkpoint dependencies include full patch collection fingerprints and referenced preset trees", async () => {
  const h = await startHarness(() => {});
  try {
    let presetValue = 40, patchHash = "same", complete = true;
    h.fake.on("fast.context", () => context).on("objects", () => ({ items: [] })).on("object", () => ({ class: "DataPool", index: 1 }));
    patch(h);
    h.fake.on("patch.fingerprint", (a) => ({ collection: a.collection, hash: patchHash, objects: 10, complete, ms: Math.random() * 10 }));
    h.fake.on("preset.read", (a) => ({ ref: a.ref, rows: [{ fixture: "1", attribute: "Dimmer", value: presetValue }], truncated: false, count: 1, dependenciesReadable: true, dependencies: String(a.ref).includes("4.1") ? [{ addr: "1.2.3", valid: true }] : [] }));
    const p = compileTracking({ version: 1, sequence: 500, cues: [{ cue: 1, changes: [{ kind: "preset", fixtures: "1", pool: 4, preset: 1, attributes: ["Dimmer"] }] }] });
    const a = await observeSequence(h.ctx, p); presetValue = 80;
    const b = await observeSequence(h.ctx, p); patchHash = "changed";
    const c = await observeSequence(h.ctx, p);
    assert.notEqual(a.contentFingerprint, b.contentFingerprint);
    assert.notEqual(b.contentFingerprint, c.contentFingerprint);
    assert.equal(h.fake.requests.filter((r) => r.op === "preset.read").length, 6);
    complete = false;
    assert.equal((await observeSequence(h.ctx, p)).complete, false);
  } finally { await h.close(); }
});

test("bridge timing preserves failed reads, phase, progress and configured timeout", async () => {
  const h = await startHarness(() => {});
  try {
    const requests: any[] = [], progress: any[] = [];
    h.fake.on("programmer", () => { throw new Error("incomplete native API"); });
    const timed = timedBridge(h.bridge, requests, 100, (p) => progress.push(p));
    await assert.rejects(() => timed.request("programmer", {}), /incomplete native API/);
    assert.equal(requests[0].kind, "read");
    assert.equal(requests[0].phase, "programmer_verification");
    assert.equal(requests[0].status, "failed");
    assert.ok(requests[0].ms >= 0);
    assert.equal(progress[0].requestState, "running");
    assert.equal(progress.at(-1).requestState, "failed");
  } finally { await h.close(); }
});

test("implicit current data pool is resolved explicitly and a pool switch invalidates its fingerprint", async () => {
  const h = await startHarness(() => {});
  try {
    let pool = 1;
    h.fake.on("fast.context", () => context).on("objects", () => ({ items: [] })).on("object", () => ({ class: "DataPool", index: pool, addr: `DP${pool}` }));
    patch(h);
    const p = compileTracking({ version: 1, sequence: 500, cues: [{ cue: 1, hold: true }] });
    const a = await observeSequence(h.ctx, p); pool = 2;
    const b = await observeSequence(h.ctx, p);
    assert.equal((a as any).dataPool, 1);
    assert.notEqual(a.contentFingerprint, b.contentFingerprint);
    assert.ok(h.fake.requests.some((r) => r.op === "objects" && r.args.ref === "DataPool 1 Sequence 500"));
  } finally { await h.close(); }
});

test("current native DataPool is a Pool under DataPools, not an unrelated pool", async () => {
  const { resolveDataPool } = await import("../src/jobs/runtime.ts");
  const h=await startHarness(()=>{});
  try {
    h.fake.on("object",()=>({class:"Pool",index:1,addr:"14.14.1",parent:{class:"DataPools",addr:"14.14"}}));
    assert.equal(await resolveDataPool(h.bridge,undefined,400),1);
    h.fake.on("object",()=>({class:"Pool",index:1,addr:"14.14.1",parent:{class:"Other",addr:"14.14"}}));
    await assert.rejects(()=>resolveDataPool(h.bridge,undefined,400),/unreadable/);
    h.fake.on("object",()=>({class:"Pool",index:2,addr:"14.14.1",parent:{class:"DataPools",addr:"14.14"}}));
    await assert.rejects(()=>resolveDataPool(h.bridge,undefined,400),/unreadable/);
  } finally { await h.close(); }
});


test("native checkpoint v2 ignores encoded JSON order while retaining the exact legacy raw hash", async () => {
  const h = await startHarness(() => {});
  try {
    let changed = false;
    h.fake.on("fast.context", () => context).on("objects", () => ({ items: [{ name: "Sequence 500" }] }));
    patch(h);
    h.fake.on("cue.content", () => ({ complete: true, cues: [{ no: 1000, parts: [{ contentJson: changed ? '{"rows":[],"byFixtures":true}' : '{"byFixtures":true,"rows":[]}', rawChannelsJson: changed ? '{"entries":[{"value":20,"key":"1","keyType":"number"}]}' : '{"entries":[{"keyType":"number","key":"1","value":20}]}' }] }] }));
    const before = await observeSequence(h.ctx, plan()); changed = true;
    const after = await observeSequence(h.ctx, plan());
    assert.equal(before.contentFingerprintVersion, "native-json-v2");
    assert.equal(after.contentFingerprintVersion, "native-json-v2");
    assert.equal(before.contentFingerprint, after.contentFingerprint);
    assert.notEqual(before.legacyContentFingerprint, after.legacyContentFingerprint);
    assert.equal(h.fake.commands.length, 0);
  } finally { await h.close(); }
});
