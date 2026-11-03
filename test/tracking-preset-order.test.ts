import { test } from "node:test";
import assert from "node:assert/strict";
import { compileTracking, presetRecallOrder, type Cell } from "../src/tracking/model.ts";

test("overlapping preset recalls retain later-wins state despite alphabetical attribute order", () => {
  const compiled = compileTracking({ version: 1, sequence: 400, cues: [
    { cue: 1, changes: [
      { kind: "preset", fixtures: "1", pool: 21, preset: 1, attributes: ["Pan", "Tilt"] },
      { kind: "preset", fixtures: "1", pool: 21, preset: 2, attributes: ["Dimmer", "Tilt"] },
    ] },
  ] });
  assert.equal(compiled.executable, true);
  const definitions: Record<number, Record<string, number>> = {
    1: { Pan: 10, Tilt: 11 }, 2: { Dimmer: 20, Tilt: 21 },
  };
  const applied: Record<string, number> = {};
  const look = compiled.store.cues[0].looks[0];
  for (const preset of look.presets) Object.assign(applied, definitions[preset.preset]);
  assert.deepEqual(applied, { Pan: 10, Tilt: 21, Dimmer: 20 });
});

test("preset action coverage cycles have no accepted recall order", () => {
  const cells: Cell[] = [
    { fixture: "1", attribute: "Pan", layer: "absolute", state: { kind: "preset", pool: 21, preset: 1, attributes: ["Pan", "Tilt"] }, provenance: { cue: "1", change: 0, reason: "changed" } },
    { fixture: "1", attribute: "Tilt", layer: "absolute", state: { kind: "preset", pool: 21, preset: 2, attributes: ["Pan", "Tilt"] }, provenance: { cue: "1", change: 1, reason: "changed" } },
  ];
  assert.equal(presetRecallOrder(cells), null);
});
