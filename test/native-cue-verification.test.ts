import { test } from "node:test";
import assert from "node:assert/strict";
import { compileTracking } from "../src/tracking/model.ts";
import { verifyNativeOwnedState } from "../src/native-cue-verification.ts";

const compilation = compileTracking({ version: 1, sequence: 9001, cues: [{ cue: 1, changes: [{ kind: "value", fixtures: "1", attribute: "Dimmer", value: 40 }] }, { cue: 2, hold: true }, { cue: 3, changes: [{ kind: "value", fixtures: "1", attribute: "Dimmer", layer: "relative", value: -10 }] }] });
const native = (value = 40) => ({ complete: true, sequence: { fields: { Tracking: "Yes" } }, cues: [
  { no: 1000, parts: [{ no: 0, contentJson: JSON.stringify({ byFixtures: true, truncated: false, rows: [{ fixture: "1", attribute: "Dimmer", hasAbsolute: true, value, stepCount: 1 }] }) }] },
  { no: 2000, parts: [{ no: 0, contentJson: JSON.stringify({ byFixtures: true, truncated: false, rows: [] }) }] },
  { no: 3000, parts: [{ no: 0, contentJson: JSON.stringify({ byFixtures: true, truncated: false, rows: [{ fixture: "1", attribute: "Dimmer", hasRelative: true, relative: -10, stepCount: 1 }] }) }] },
] });
test("native semantic verifier checks stored tracking hold and signed relative values after Store", () => {
  assert.equal(verifyNativeOwnedState(compilation, native()).status, "matched");
  assert.equal(verifyNativeOwnedState(compilation, native(20)).status, "mismatched");
});
test("native semantic verifier cannot call incomplete content a match", () => {
  assert.equal(verifyNativeOwnedState(compilation, { ...native(), complete: false }).status, "unavailable");
});
test("an empty native sequence cannot verify a nonempty authored plan", () => {
  assert.notEqual(verifyNativeOwnedState(compilation, {...native(),cues:[]}).status,"matched");
});
test("a phaser containing one released step is not an entirely released layer", () => {
  const p=compileTracking({version:1,sequence:9001,cues:[{cue:1,changes:[{kind:"value",fixtures:"1",attribute:"Dimmer",value:40}]},{cue:2,changes:[{kind:"release",fixtures:"1",attribute:"Dimmer"}]}]});
  const n=native();
  n.cues=n.cues.slice(0,2);
  n.cues[1].parts[0].contentJson=JSON.stringify({byFixtures:true,truncated:false,rows:[{fixture:"1",attribute:"Dimmer",hasAbsolute:true,stepCount:2,steps:[{absolute:40},{absoluteKind:"release"}]}]});
  assert.equal(verifyNativeOwnedState(p,n).status,"mismatched");
});

const phaserNative = (steps: Array<Record<string, unknown>>, speedMaster: unknown = 0,
  fields: Record<string, unknown> = {}) => ({
  complete: true, sequence: { fields: { Tracking: "Yes" } }, cues: [{
    no: 1000, parts: [{ no: 0, contentJson: JSON.stringify({
      byFixtures: true, truncated: false, rows: [{
        fixture: "1", attribute: "Dimmer", hasAbsolute: true, stepCount: steps.length, steps, speedMaster, ...fields,
      }],
    }) }],
  }],
});

test("native phaser verification compares every step across case-insensitive attribute names", () => {
  const plan = compileTracking({ version: 1, sequence: 9001, cues: [{ cue: 1, changes: [{
    kind: "phaser", fixtures: "1", phaser: {
      steps: [{ values: { Dimmer: 40 } }, { values: { dimmer: 60 } }],
    },
  }] }] });
  assert.equal(plan.executable, true);
  assert.equal(verifyNativeOwnedState(plan, phaserNative([{ absolute: 40 }, { absolute: 60 }])).status, "matched");
  // A saved raw cell predates normalization of case-equivalent keys across steps.
  const savedRawPlan = JSON.parse(JSON.stringify(plan));
  savedRawPlan.cues[0].state[0].state.phaser.steps[1].values = { dimmer: 60 };
  const wrongSecondStep = verifyNativeOwnedState(savedRawPlan, phaserNative([{ absolute: 40 }, { absolute: 90 }]));
  assert.equal(wrongSecondStep.status, "mismatched");
  assert.match(wrongSecondStep.detail ?? "", /step 2.*expected 60/);
  // Existing journals can retain raw definitions from before stricter compiler normalization.
  const ambiguousSavedPlan = JSON.parse(JSON.stringify(plan));
  ambiguousSavedPlan.cues[0].state[0].state.phaser.steps[1].values = { Dimmer: 60, dimmer: 90 };
  assert.equal(verifyNativeOwnedState(ambiguousSavedPlan,
    phaserNative([{ absolute: 40 }, { absolute: 60 }])).status, "unavailable");
});

test("an unreadable native speed-master value is not speed master one", () => {
  const plan = compileTracking({ version: 1, sequence: 9001, cues: [{ cue: 1, changes: [{
    kind: "phaser", fixtures: "1", phaser: {
      steps: [{ values: { Dimmer: 40 } }, { values: { Dimmer: 60 } }], phaser: { speed_master: 1 },
    },
  }] }] });
  const steps = [{ absolute: 40 }, { absolute: 60 }];
  assert.equal(verifyNativeOwnedState(plan, phaserNative(steps, 0)).status, "matched");
  for (const unreadable of [null, false, ""]) {
    assert.notEqual(verifyNativeOwnedState(plan, phaserNative(steps, unreadable)).status, "matched",
      `unreadable speed master ${JSON.stringify(unreadable)} must not be coerced to zero`);
  }
});

test("native phaser speed comparisons refuse coercible nonnumeric observations", () => {
  const steps = [{ absolute: 40 }, { absolute: 60 }];
  for (const [bpm, nativeValues] of [
    [0.01, [null, false, "", []]], [60, [true, "1", [1]]],
  ] as const) {
    const plan = compileTracking({ version: 1, sequence: 9001, cues: [{ cue: 1, changes: [{
      kind: "phaser", fixtures: "1", phaser: {
        steps: [{ values: { Dimmer: 40 } }, { values: { Dimmer: 60 } }], phaser: { speed_bpm: bpm },
      },
    }] }] });
    assert.equal(plan.executable, true);
    assert.equal(verifyNativeOwnedState(plan, phaserNative(steps, 0, { speed: bpm / 60 })).status, "matched");
    for (const speed of nativeValues) assert.notEqual(
      verifyNativeOwnedState(plan, phaserNative(steps, 0, { speed })).status, "matched",
      `nonnumeric native speed ${JSON.stringify(speed)} cannot verify ${bpm} BPM`);
  }
});

test("native phaser measure comparisons require a numeric observation", () => {
  const plan = compileTracking({ version: 1, sequence: 9001, cues: [{ cue: 1, changes: [{
    kind: "phaser", fixtures: "1", phaser: {
      steps: [{ values: { Dimmer: 40 } }, { values: { Dimmer: 60 } }], phaser: { measure: 4 },
    },
  }] }] });
  const steps = [{ absolute: 40 }, { absolute: 60 }];
  assert.equal(verifyNativeOwnedState(plan, phaserNative(steps, 0, { measure: 400 })).status, "matched");
  for (const measure of ["400", [400]]) assert.notEqual(
    verifyNativeOwnedState(plan, phaserNative(steps, 0, { measure })).status, "matched");
});

for (const field of ["pool", "no"] as const) {
  test(`native preset ${field} identity cannot be fabricated by numeric coercion`, () => {
    const plan = compileTracking({ version: 1, sequence: 9001, cues: [{ cue: 1, changes: [{
      kind: "preset", fixtures: "1", pool: 1, preset: 1, attributes: ["Dimmer"],
    }] }] });
    const presetNative = (value: unknown) => ({
      complete: true, sequence: { fields: { Tracking: "Yes" } }, cues: [{ no: 1000, parts: [{ no: 0,
        contentJson: JSON.stringify({ byFixtures: true, truncated: false, rows: [{
          fixture: "1", attribute: "Dimmer", hasAbsolute: true, value: 40,
          absPreset: { valid: true, pool: 1, no: 1, [field]: value },
        }] }),
      }] }],
    });
    assert.equal(verifyNativeOwnedState(plan, presetNative(1)).status, "matched");
    for (const value of [true, "1", [1]]) assert.notEqual(
      verifyNativeOwnedState(plan, presetNative(value)).status, "matched");
  });
}
