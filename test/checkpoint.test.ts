import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpointTools } from "../src/tools/checkpoint.ts";
import { startHarness } from "./helpers/tool-harness.ts";

test("immutable scoped checkpoints compare native channel values and accept an explicitly allowed reload generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gma3-checkpoints-")), h = await startHarness(createCheckpointTools({ directory }));
  let raw = '{"value":30,"unknownFlag":true}', generation = "before", unstable = false, calls = 0;
  h.fake.on("fast.context", () => ({ contextKey: `${generation}${unstable ? calls++ : ""}`, identity: { generation, hostname: "lab", showfile: "Private.show", user: "user", profile: "profile" }, identityUncertain: [], environment: "Normal" }));
  h.fake.on("cue.content", () => ({ complete: true, sequence: { fields: { Tracking: "Yes" } }, cues: [{ no: 1, parts: [{ rawChannelsJson: raw, contentJson: "{}" }] }], limitations: [] }));
  h.fake.on("object", () => ({ class: "DataPool", index: 1 }));
  try {
    const scope = { sequences: [401], include_patch: false, include_dmx_output: false };
    const saved = await h.callJson("gma3_show_checkpoint", { action: "capture", scope });
    assert.equal(saved.result.complete, true);
    const id = saved.result.id;
    generation = "after";
    const strict = await h.callJson("gma3_show_checkpoint", { action: "compare", id });
    assert.equal(strict.result.matched, false);
    const reloaded = await h.callJson("gma3_show_checkpoint", { action: "compare", id, allow_generation_change: true });
    assert.equal(reloaded.result.matched, true);
    raw = '{"value":80,"unknownFlag":true}';
    const edited = await h.callJson("gma3_show_checkpoint", { action: "compare", id, allow_generation_change: true });
    assert.equal(edited.result.matched, false);
    assert.equal(edited.result.sections[0].matched, false);
    assert.equal((await h.callJson("gma3_show_checkpoint", { action: "status", id })).result.sections[0].hash, saved.result.sections[0].hash);
    unstable = true;
    const drift = await h.callJson("gma3_show_checkpoint", { action: "capture", scope });
    assert.equal(drift.isError, true);
    assert.equal(h.fake.commands.length, 0);
  } finally { await h.close(); await rm(directory, { recursive: true, force: true }); }
});

test("checkpoint completeness covers patch/types and configured DMX settings, excluding runtime grants", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gma3-checkpoints-")), h = await startHarness(createCheckpointTools({ directory }));
  let granted = false, request = "Auto", patchHash = "stable";
  h.fake.on("fast.context", () => ({ contextKey: "same", identity: { generation: "g", hostname: "lab", showfile: "Private.show", user: "u", profile: "p" }, identityUncertain: [], environment: "Normal" }));
  h.fake.on("patch.collections", () => ({ live: ["Stages", "FixtureTypes", "AttributeDefinitions"] }));
  h.fake.on("patch.fingerprint", (a) => ({ complete: true, hash: a.collection === "FixtureTypes" ? patchHash : "same", objects: 1, ms: Math.random() * 100 }));
  h.fake.on("dmx.output", (a) => {
    assert.equal(a.all, true);
    return { protocols: { artnet: { out: false, in: false, entries: [] }, sacn: { out: false, in: false, entries: [] } }, universes: [{ no: 1, name: "1", request, granted, portOut: false, portIn: false, portRdm: false, mergeMode: "HTP" }], totals: { universes: 1, grantedOfWanted: granted ? 1 : 0 }, stations: [] };
  });
  try {
    const saved = await h.callJson("gma3_show_checkpoint", { action: "capture", scope: {} });
    assert.equal(saved.result.complete, true);
    granted = true;
    assert.equal((await h.callJson("gma3_show_checkpoint", { action: "compare", id: saved.result.id })).result.matched, true);
    request = "Off";
    assert.equal((await h.callJson("gma3_show_checkpoint", { action: "compare", id: saved.result.id })).result.matched, false);
    request = "Auto"; patchHash = "fixture-type-edited";
    const changed = await h.callJson("gma3_show_checkpoint", { action: "compare", id: saved.result.id });
    assert.equal(changed.result.sections.find((s: any) => s.name === "live_patch").matched, false);
    const path = join(directory, `${saved.result.id}.json`), record = JSON.parse(await readFile(path, "utf8"));
    record.sections[0].data = { edited: true };
    await writeFile(path, JSON.stringify(record));
    assert.equal((await h.callJson("gma3_show_checkpoint", { action: "status", id: saved.result.id })).isError, true);
  } finally { await h.close(); await rm(directory, { recursive: true, force: true }); }
});

test("checkpoints capture actual saved View contents and report unsupported/incomplete sections honestly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gma3-checkpoints-")), h = await startHarness(createCheckpointTools({ directory }));
  h.fake.on("fast.context", () => ({ contextKey: "same", identity: { generation: "g", hostname: "lab", showfile: "Private.show", user: "u", profile: "p" }, identityUncertain: [], environment: "Normal" }));
  try {
    const scope = { views: [24], include_patch: false, include_dmx_output: false };
    const unavailable = await h.callJson("gma3_show_checkpoint", { action: "capture", scope });
    assert.equal(unavailable.result.complete, false);
    assert.equal(unavailable.isError, true);
    h.fake.on("view.content", () => ({ complete: true, kind: "saved_view", ref: "View 24", contentJson: '[{"screen":1,"configuration":{"class":"Window3D","camera":18}}]' }));
    const saved = await h.callJson("gma3_show_checkpoint", { action: "capture", scope });
    assert.equal(saved.result.complete, true);
    assert.ok(h.fake.requests.some((r) => r.op === "view.content" && r.args.ref === "View 24"));
    assert.equal((await h.call("gma3_show_checkpoint", { action: "capture", scope: { ...scope, arbitrary_path: "/tmp/out" } })).isError, true);
  } finally { await h.close(); await rm(directory, { recursive: true, force: true }); }
});

test("checkpoint comparison accepts encoded JSON and typed-map presentation order while preserving raw integrity and real changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gma3-checkpoint-canonical-")), h = await startHarness(createCheckpointTools({ directory }));
  let raw = '{"entries":[{"keyType":"string","key":"absolute","value":30},{"keyType":"number","key":"1","value":9007199254740993}]}';
  let content = '{"unknown":{"enabled":true,"value":30},"rows":[]}';
  let view = '[{"screen":1,"configuration":{"name":"Window3D","class":"ViewWidget","properties":[{"name":"CAMERA","nilValue":false,"value":{"entries":[{"keyType":"string","key":"addr","value":"camera9010"},{"keyType":"string","key":"class","value":"Camera"}]}}]}}]';
  let stage = "original-stage";
  h.fake.on("fast.context", () => ({ contextKey: "same", identity: { generation: "g", hostname: "lab", showfile: "Private.show", user: "u", profile: "p" }, identityUncertain: [], environment: "Normal" }));
  h.fake.on("cue.content", () => ({ complete: true, cues: [{ no: 1, parts: [{ contentJson: content, rawChannelsJson: raw }] }], limitations: [] }));
  h.fake.on("view.content", () => ({ complete: true, kind: "saved_view", contentJson: view }));
  h.fake.on("patch.collections", () => ({ live: ["Stages", "FixtureTypes", "AttributeDefinitions"] }));
  h.fake.on("patch.fingerprint", a => ({ complete: true, collection: a.collection, hash: a.collection === "Stages" ? stage : "stable", objects: 1 }));
  try {
    const saved = await h.callJson("gma3_show_checkpoint", { action: "capture", scope: { data_pool: 1, sequences: [401], views: [24], include_patch: true, include_dmx_output: false } });
    assert.equal(saved.result.complete, true);
    const id = saved.result.id;
    raw = '{"entries":[{"value":9007199254740993,"key":"1","keyType":"number"},{"value":30,"key":"absolute","keyType":"string"}]}';
    content = '{"rows":[],"unknown":{"value":30,"enabled":true}}';
    view = '[{"configuration":{"properties":[{"value":{"entries":[{"value":"Camera","key":"class","keyType":"string"},{"value":"camera9010","key":"addr","keyType":"string"}]},"nilValue":false,"name":"CAMERA"}],"class":"ViewWidget","name":"Window3D"},"screen":1}]';
    const reordered = await h.callJson("gma3_show_checkpoint", { action: "compare", id });
    assert.equal(reordered.result.matched, true, JSON.stringify(reordered.result));
    assert.equal(reordered.result.comparisonFingerprintVersion, "native-json-v2");
    for (const section of reordered.result.sections.filter((s: any) => s.name !== "live_patch")) {
      assert.notEqual(section.beforeHash, section.afterHash, "stored immutable hashes remain exact raw fingerprints");
      assert.equal(section.beforeComparisonHash, section.afterComparisonHash);
    }
    raw = raw.replace("9007199254740993", "9007199254740994");
    const edited = await h.callJson("gma3_show_checkpoint", { action: "compare", id });
    assert.equal(edited.result.sections.find((s: any) => s.name === "sequence:401").matched, false, "64-bit channel value changes cannot disappear through Number rounding");
    raw = raw.replace("9007199254740994", "9007199254740993");
    content = content.replace('"enabled":true', '"enabled":false');
    assert.equal((await h.callJson("gma3_show_checkpoint", { action: "compare", id })).result.matched, false, "unknown encoded fields remain compared");
    content = content.replace('"enabled":false', '"enabled":true');
    view = view.replace("camera9010", "camera9012");
    const changedView = await h.callJson("gma3_show_checkpoint", { action: "compare", id });
    assert.equal(changedView.result.sections.find((s: any) => s.name === "view:24").matched, false, "a real saved Camera reference change remains visible");
    view = view.replace("camera9012", "camera9010");
    stage = "authorized-real-position-change";
    const moved = await h.callJson("gma3_show_checkpoint", { action: "compare", id });
    assert.equal(moved.result.sections.find((s: any) => s.name === "live_patch").matched, false, "opaque Stage hashes are never normalized");
    assert.equal((await h.callJson("gma3_show_checkpoint", { action: "status", id })).result.sections[0].hash, saved.result.sections[0].hash);
    const file = join(directory, id + ".json"), immutable = JSON.parse(await readFile(file, "utf8"));
    immutable.sections[0].data.cues[0].parts[0].contentJson = content;
    await writeFile(file, JSON.stringify(immutable));
    assert.equal((await h.callJson("gma3_show_checkpoint", { action: "status", id })).isError, true, "even presentation-only edits must fail the saved record's raw integrity check");
    assert.deepEqual(h.fake.commands, []);
  } finally { await h.close(); await rm(directory, { recursive: true, force: true }); }
});

test("malformed encoded native data is retained as incomplete evidence and never compares as a complete match", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gma3-checkpoint-malformed-")), h = await startHarness(createCheckpointTools({ directory }));
  let raw = '{"value":30}';
  h.fake.on("fast.context", () => ({ contextKey: "same", identity: { generation: "g", hostname: "lab", showfile: "Private.show", user: "u", profile: "p" }, identityUncertain: [], environment: "Normal" }));
  h.fake.on("cue.content", () => ({ complete: true, cues: [{ parts: [{ contentJson: "{}", rawChannelsJson: raw }] }] }));
  try {
    const scope = { data_pool: 1, sequences: [401], include_patch: false, include_dmx_output: false };
    const valid = await h.callJson("gma3_show_checkpoint", { action: "capture", scope });
    for (const malformed of ['{"value":', '{"value":30,"value":80}']) {
      raw = malformed;
      const captured = await h.callJson("gma3_show_checkpoint", { action: "capture", scope, detail: true });
      assert.equal(captured.result.complete, false);
      assert.equal(captured.isError, true);
      assert.equal(captured.result.sections[0].data.cues[0].parts[0].rawChannelsJson, malformed, "keep exact malformed evidence");
      const comparison = await h.callJson("gma3_show_checkpoint", { action: "compare", id: valid.result.id });
      assert.equal(comparison.result.complete, false);
      assert.equal(comparison.result.matched, false);
      assert.equal(comparison.isError, true);
    }
    assert.deepEqual(h.fake.commands, []);
  } finally { await h.close(); await rm(directory, { recursive: true, force: true }); }
});
