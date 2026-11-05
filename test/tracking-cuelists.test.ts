import { test } from "node:test";
import assert from "node:assert/strict";
import { Validator } from "../src/validate.ts";
import { validateLooks } from "../src/tools/cuelists.ts";

test("cue looks preserve signed relative values alongside absolute values", () => {
  const v = new Validator();
  const looks = validateLooks(v, { fixtures: "1", values: [{ attribute: "Pan", value: 40, unit: "percent" }, { attribute: "Pan", value: -10, layer: "relative", unit: "percent" }] }, "cue", undefined);
  assert.deepEqual(v.errors, []);
  assert.equal((looks[0].values[1] as any).layer, "relative");
});

test("explicit hold accepts an empty looks list and refuses hidden content", () => {
  const v = new Validator();
  assert.deepEqual(validateLooks(v, { hold: true, looks: [] }, "cue", undefined, true), []);
  assert.deepEqual(v.errors, []);
  const bad = new Validator();
  validateLooks(bad, { hold: true, fixtures: "1", intensity: 0 }, "cue", undefined, true);
  assert.match(bad.errors.join(";"), /hold/);
});

test("stored release is distinct from Off Attribute and validates its explicit target", () => {
  const v = new Validator();
  const looks = validateLooks(v, { fixtures: "1", releases: ["Dimmer"] }, "cue", undefined);
  assert.deepEqual(v.errors, []);
  assert.deepEqual((looks[0] as any).releases, [{ attribute: "Dimmer", layer: "absolute" }]);
  const bad = new Validator();
  validateLooks(bad, { fixtures: "1", releases: ["Dimmer"], intensity: 20 }, "cue", undefined);
  assert.match(bad.errors.join(";"), /release.*value|both/i);
});

test("release layers are explicit and a relative release may coexist with an absolute value", () => {
  const v = new Validator();
  const looks = validateLooks(v, { fixtures: "1", values: [{ attribute: "Dimmer", value: 30, unit: "percent" }], releases: [{ attribute: "Dimmer", layer: "relative" }] }, "cue", undefined);
  assert.deepEqual(v.errors, []);
  assert.deepEqual((looks[0] as any).releases, [{ attribute: "Dimmer", layer: "relative" }]);
});
