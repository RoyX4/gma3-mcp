import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobTools } from "../src/tools/jobs.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";

/** Deliberately small independent console model: real ToolContext, TCP bridge, locks, Preview and durable executor. */
class Console {
  environment = "Normal";
  selected = false;
  absolute: number | undefined;
  relative: number | undefined;
  valueKind: string | undefined;
  relativeKind: string | undefined;
  cues = new Map<number, { values: { absolute?: number; relative?: number; valueKind?: string; relativeKind?: string }; fields: Record<string, unknown> }>();
  settings: Record<string, unknown> = { Tracking: "Yes", Lock: "", StructureLocked: "No", SystemLocked: "No", Name: "Owned" };
  row() {
    return { fixture: "Fixture 1", fid: "1", subfixtureIndex: 1, attribute: "Dimmer", value: this.absolute, relative: this.relative, valueKind: this.valueKind, relativeKind: this.relativeKind, masks: { activeValue: (this.absolute !== undefined ? 2 : 0) | (this.relative !== undefined ? 4 : 0) }, stepCount: 1, steps: [{ absolute: this.absolute, relative: this.relative }], absPreset: null, relPreset: null };
  }
  install(h: Harness) {
    h.fake.on("object", () => ({ class: "DataPool", index: 1 }));
    h.fake.on("fast.context", () => ({ contextKey: "lab-show-user-profile-generation", identityUncertain: [], environment: this.environment, identity: { generation: "lab" } }));
    h.fake.on("fast.lease", (a) => a.action === "release" ? { released: true } : { token: "lease" });
    h.fake.on("patch.collections", () => ({ live: ["Stages", "FixtureTypes", "AttributeDefinitions"] }));
    h.fake.on("patch.fingerprint", (a) => ({ collection: a.collection, complete: true, objects: 1, hash: 12, ms: 0 }));
    h.fake.on("feedback.read", () => ({ items: [{ name: "previewMode", available: true, value: this.environment }] }));
    h.fake.on("children", (a) => ({ items: String(a.ref).replace(/^DataPool 1 /, "") === "Sequence 900" ? [...this.cues].map(([no, c]) => ({ name: c.fields.Name, class: "Cue", fields: { No: no }, addr: `S900.C${no}` })) : [] }));
    h.fake.on("objects", (a) => {
      const ref = String(a.ref).replace(/^DataPool 1 /, ""), cue = /Sequence 900 Cue ([\d.]+)/.exec(ref);
      if (cue) {
        const c = this.cues.get(Number(cue[1]));
        return { total: c ? 1 : 0, items: c ? [{ fields: c.fields, addr: `S900.C${cue[1]}`, name: c.fields.Name }] : [] };
      }
      if (ref === "Sequence 900") return { total: this.cues.size ? 1 : 0, items: this.cues.size ? [{ name: "Owned", addr: "S900", hasActivePlayback: false, fields: this.settings }] : [] };
      return { total: 1, items: [{ name: ref, addr: ref, addrNative: ref, fields: {} }] };
    });
    h.fake.on("programmer", (a) => {
      const has = this.environment === "Preview" && (this.absolute !== undefined || this.relative !== undefined);
      const fixtures = this.selected || a.scope === "all" || a.scope === "fixtures" ? [{ fid: "1", rootFid: "1", name: "Fixture 1", subfixtureIndex: 1, attributes: ["Dimmer"] }] : [];
      return { environment: this.environment, coverage: { complete: true }, total: has ? 1 : 0, scannedFixtures: fixtures, rows: has ? [this.row()] : [] };
    });
    h.fake.on("cmd", (a) => {
      const command = String(a.command).replace(/DataPool 1 /g, "");
      if (command === "Preview On") this.environment = "Preview";
      else if (command === "Preview Off") this.environment = "Normal";
      else if (command === "ClearSelection") this.selected = false;
      else if (command === "Fixture 1") this.selected = true;
      else if (command === "ClearAll") { this.absolute = undefined; this.relative = undefined; this.valueKind = undefined; this.relativeKind = undefined; this.selected = false; }
      else {
        const value = /^Attribute "Dimmer" At (Absolute|Relative) Percent (-?[\d.]+)$/.exec(command);
        if (value) { if (value[1] === "Absolute") this.absolute = Number(value[2]); else this.relative = Number(value[2]); }
        if (command === 'Attribute "Dimmer" At Absolute Release') { this.absolute = 6600; this.valueKind = "release"; }
        if (command === 'Attribute "Dimmer" At Relative Release') { this.relative = 6600; this.relativeKind = "release"; }
        const store = /^Store Sequence 900 Cue ([\d.]+)/.exec(command);
        if (store) this.cues.set(Number(store[1]), { values: { absolute: this.absolute, relative: this.relative, valueKind: this.valueKind, relativeKind: this.relativeKind }, fields: { Name: "", TrigType: "Go", TrigTime: 0 } });
      }
      return { feedback: "OK" };
    });
    h.fake.on("set", (a) => {
      const cue = /Sequence 900 Cue ([\d.]+)/.exec(String(a.ref));
      const fields = cue ? this.cues.get(Number(cue[1]))!.fields : this.settings;
      fields[String(a.property)] = a.value;
      return { value: a.value };
    });
    h.fake.on("cue.content", () => ({ complete: true, sequence: { fields: this.settings }, cues: [...this.cues].map(([no, cue]) => ({ no: no * 1000, fields: cue.fields, parts: [{ no: 0, fields: cue.fields, encoding: "json", contentJson: JSON.stringify({ byFixtures: true, truncated: false, rows: cue.values.absolute === undefined && cue.values.relative === undefined ? [] : [{ fixture: "1", attribute: "Dimmer", hasAbsolute: cue.values.absolute !== undefined, hasRelative: cue.values.relative !== undefined, value: cue.values.absolute, relative: cue.values.relative, valueKind: cue.values.valueKind, relativeKind: cue.values.relativeKind }] }), rawChannelsJson: JSON.stringify(cue.values) }] })), limitations: [] }));
  }
}

test("a real durable tool run stores deltas, hold, signed relative data and per-layer releases across guarded batches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gma3-job-integration-")), h = await startHarness(createJobTools({ directory })), native = new Console();
  native.install(h);
  try {
    const plan = { version: 1, sequence: 900, cues: [{ cue: 1, changes: [{ fixtures: "1", kind: "value", attribute: "Dimmer", value: 40 }] }, { cue: 2, hold: true }, { cue: 3, changes: [{ fixtures: "1", kind: "value", attribute: "Dimmer", value: -10, layer: "relative" }] }, { cue: 4, changes: [{ fixtures: "1", kind: "release", attribute: "Dimmer" }] }, { cue: 5, changes: [{ fixtures: "1", kind: "release", attribute: "Dimmer", layer: "relative" }] }] };
    const prepared = await h.callJson("gma3_programming_job", { action: "prepare", plan, batch_size: 2 });
    const id = prepared.result.id;
    assert.equal(h.fake.requests.length, 0);
    await h.callJson("gma3_programming_job", { action: "run", id, run: true, exclusive: true });
    let state: any;
    for (let i = 0; i < 500; i++) {
      state = (await h.callJson("gma3_programming_job", { action: "status", id, detail: true })).result;
      if (state.status !== "running") break;
      await new Promise((r) => setTimeout(r, 2));
    }
    assert.equal(state.status, "completed", JSON.stringify(state));
    assert.equal(state.progress.verifiedCues, 5);
    assert.equal(native.cues.get(1)?.values.absolute, 40);
    assert.equal(Object.values(native.cues.get(2)!.values).every((v) => v === undefined), true);
    assert.equal(native.cues.get(3)?.values.relative, -10);
    assert.equal(native.environment, "Normal");
    assert.equal(native.cues.get(4)?.values.valueKind, "release");
    assert.equal(native.cues.get(5)?.values.relativeKind, "release");
    assert.equal(state.receipts.length, 3);
    assert.equal(state.checkpoint.semanticVerification.status, "matched");
    assert.equal(h.fake.requests.filter((r) => r.op === "fast.lease" && r.args.action === "acquire").length, 3);
    assert.ok(state.timing.byPhase.store.ms >= 0);
    assert.equal(h.fake.commands.some((c) => /Goto|Go\+|On Sequence/.test(c)), false);
  } finally { await h.close(); await rm(directory, { recursive: true, force: true }); }
});

test("cue-only introduction restores absence with a stored release verified after Store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gma3-job-cueonly-")), h = await startHarness(createJobTools({ directory })), native = new Console();
  native.install(h);
  try {
    const plan = { version: 1, sequence: 900, cues: [{ cue: 1, hold: true }, { cue: 2, mode: "cue_only", changes: [{ fixtures: "1", kind: "value", attribute: "Dimmer", value: 40 }] }, { cue: 3, hold: true }] };
    const id = (await h.callJson("gma3_programming_job", { action: "prepare", plan, batch_size: 3 })).result.id;
    await h.callJson("gma3_programming_job", { action: "run", id, run: true, exclusive: true });
    let state: any;
    for (let i = 0; i < 500; i++) {
      state = (await h.callJson("gma3_programming_job", { action: "status", id, detail: true })).result;
      if (state.status !== "running") break;
      await new Promise((r) => setTimeout(r, 2));
    }
    assert.equal(state.status, "completed", JSON.stringify(state));
    assert.equal(native.cues.get(3)?.values.valueKind, "release");
    assert.equal(state.checkpoint.semanticVerification.status, "matched");
  } finally { await h.close(); await rm(directory, { recursive: true, force: true }); }
});
