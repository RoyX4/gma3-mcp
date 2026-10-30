import { test } from "node:test";
import assert from "node:assert/strict";
import { compileTracking, compareCues, explainCue, fingerprint, parsePlan, serializePlan } from "../src/tracking/model.ts";

const value = (value: number, extra = {}) => ({ fixtures: "1 Thru 2", kind: "value", attribute: "Dimmer", value, unit: "percent", ...extra });
const plan = (cues: unknown[]) => ({ version: 1, sequence: 400, cues });

test("tracking reduces repeated values to an explicit empty hold and retains provenance", () => {
  const r = compileTracking(plan([{ cue: 1, changes: [value(40)] }, { cue: 2, changes: [value(40)] }, { cue: 3, hold: true }]));
  assert.equal(r.executable, true);
  assert.equal(r.cues[0].delta.length, 2);
  assert.equal(r.cues[1].delta.length, 0);
  assert.equal(r.store.cues[1].hold, true);
  const why = explainCue(r, "3");
  assert.equal(why.cells[0].provenance.cue, "1");
  assert.equal(why.cells[0].inherited, true);
  assert.equal(r.statistics.eliminatedAssignments, 2);
});

test("off, release and absence have different state fingerprints", () => {
  const r = compileTracking(plan([{ cue: 1, changes: [{ fixtures: "1 Thru 2", kind: "off", attribute: "Dimmer" }] }, { cue: 2, changes: [{ fixtures: "1 Thru 2", kind: "release", attribute: "Dimmer" }] }]));
  assert.notEqual(r.cues[0].stateFingerprint, r.cues[1].stateFingerprint);
  assert.equal(r.cues[1].delta[0].state.kind, "release");
  assert.deepEqual(r.store.cues[1].looks[0].releases[0], { attribute: "Dimmer", layer: "absolute" });
  assert.equal(compareCues(r, "1", "2").changes.length, 2);
});

test("cue-only restores tracked values at the following cue and blocks materialize them", () => {
  const r = compileTracking(plan([{ cue: 1, changes: [value(30)] }, { cue: 2, mode: "cue_only", changes: [value(80)] }, { cue: 3, hold: true }, { cue: 4, mode: "block", changes: [] }]));
  assert.equal(r.cues[2].delta[0].state.kind, "value");
  assert.equal((r.cues[2].delta[0].state as any).value, 30);
  assert.equal(r.cues[3].delta.length, 2);
  assert.equal(explainCue(r, "3").cells[0].provenance.cue, "1");
});

test("absolute and relative layers coexist and signed relative values are retained", () => {
  const r = compileTracking(plan([{ cue: 1, changes: [value(40), value(-10, { layer: "relative" })] }]));
  assert.equal(r.cues[0].state.length, 4);
  assert.equal(r.store.cues[0].looks[0].values.length, 2);
  assert.equal(r.store.cues[0].looks[0].values[1].layer, "relative");
});

test("presets retain declared coverage and phasers carry until explicitly restarted", () => {
  const phaser = { steps: [{ values: { Dimmer: 0 } }, { values: { Dimmer: 100 } }] };
  const r = compileTracking(plan([{ cue: 1, changes: [{ fixtures: "1", kind: "preset", pool: 4, preset: 1, attributes: ["ColorRGB_R", "ColorRGB_G", "ColorRGB_B"] }, { fixtures: "1", kind: "phaser", phaser }] }, { cue: 2, changes: [{ fixtures: "1", kind: "phaser", phaser }] }, { cue: 3, changes: [{ fixtures: "1", kind: "phaser", phaser, restart: true }] }]));
  assert.equal(r.cues[1].delta.length, 0);
  assert.equal(r.cues[2].delta.length, 1);
  assert.equal(r.cues[1].state.find((c) => c.attribute === "Dimmer")?.provenance.cue, "1");
});

test("serialization is stable and rejects malformed, duplicate and ambiguous input", () => {
  const p = parsePlan(plan([{ cue: 1, changes: [value(20)] }]));
  assert.equal(serializePlan(p), serializePlan(parsePlan(JSON.parse(serializePlan(p)))));
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.throws(() => parsePlan(plan([{ cue: 1, changes: [value(20, { fixtures: "Group 1" })] }])), /explicit fixture/i);
  assert.throws(() => parsePlan(plan([{ cue: 1, changes: [value(20)] }, { cue: 1, hold: true }])), /ascending|duplicate/i);
  assert.throws(() => parsePlan(plan([{ cue: 1, hold: true, changes: [value(20)] }])), /hold/i);
  assert.throws(() => parsePlan(plan([{ cue: 1, changes: [{ fixtures: "1", kind: "off", attribute: "Pan" }] }])), /Dimmer/i);
  assert.throws(() => parsePlan(plan([{ cue: 1, changes: [{ fixtures: "1", kind: "off", attribute: "Dimmer", layer: "relative" }] }])), /absolute/i);
  assert.throws(() => parsePlan(plan([{ cue: 1, changes: [value(2, { layer: "relative", unit: "decimal8" })] }])), /relative.*percent|relative.*physical/i);
});

test("recalling a changed preset restores an inherited override within its declared coverage", () => {
  const preset = (preset: number) => ({ kind: "preset", fixtures: "1", pool: 4, preset, attributes: ["ColorRGB_R", "ColorRGB_G", "ColorRGB_B"] });
  const r = compileTracking(plan([{ cue: 1, changes: [preset(1), { fixtures: "1", kind: "value", attribute: "ColorRGB_R", value: 50 }] }, { cue: 2, changes: [preset(2), { fixtures: "1", kind: "value", attribute: "ColorRGB_R", value: 50 }] }]));
  assert.equal(r.store.cues[1].looks[0].values.some((v: any) => v.attribute === "ColorRGB_R" && v.value === 50), true);
});

test("a relative-only phaser occupies the relative layer and cannot silently override an absolute value", () => {
  const phaser = { steps: [{ values: { Pan: { relative: -10 } } }, { values: { Pan: { relative: 10 } } }] };
  const r = compileTracking(plan([{ cue: 1, changes: [{ fixtures: "1", kind: "value", attribute: "Pan", value: 50 }, { fixtures: "1", kind: "phaser", phaser }] }]));
  assert.equal(r.cues[0].state.length, 2);
  assert.equal(r.cues[0].state.find((c) => c.state.kind === "phaser")?.layer, "relative");
  // The existing store tool cannot combine static and phaser layers of the same attribute in one look.
  assert.equal(r.executable, false);
  assert.equal(r.lint.some((l) => l.code === "mixed_static_phaser_layers"), true);
});

test("release plans preserve native-qualified layer-specific release without substituting zero", () => {
  const r = compileTracking(plan([{ cue: 1, changes: [{ kind: "release", fixtures: "1", attribute: "Dimmer" }] }]));
  assert.equal(r.executable, true);
  assert.deepEqual(r.store.cues[0].looks[0].releases, [{ attribute: "Dimmer", layer: "absolute" }]);
});
