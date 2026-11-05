import { test } from "node:test";
import assert from "node:assert/strict";
import { effectCommands, parsePhaser, parseStep, type Effect } from "../src/tools/phasers.ts";

// Recorded 2.5.1.1 failure: Zoom's natural readout clamped 75.5107 to 100%,
// and a bare Transition 100 after Zoom read back as 0.00059604644775391%.
test("percent phasers qualify Zoom and transition independently of the console readout", () => {
  const steps = [
    { values: { Dimmer: 15, Zoom: 75.51070336391437 }, transition: 100 },
    { values: { Dimmer: 55, Zoom: 83.51070336391437 }, transition: 100 },
  ];
  const effect: Effect = {
    unit: "percent",
    steps: steps.map((step, i) => parseStep(`steps[${i}]`, step, "percent")),
    phaser: parsePhaser({ speed_bpm: 30, measure: 1, phase: { from: 0, to: 0 } }),
  };
  assert.deepEqual(effectCommands(effect), [
    "Step 1", 'Attribute "Dimmer" At Absolute Percent 15', 'Attribute "Zoom" At Absolute Percent 75.5107',
    "Step 2", 'Attribute "Dimmer" At Absolute Percent 55', 'Attribute "Zoom" At Absolute Percent 83.5107',
    "Step 1", "At Transition Percent 100", "Step 2", "At Transition Percent 100",
    "At Speed BPM 30", "At Phase 0 Thru 0", "At Measure 1", "Step 1",
  ]);
});

test("physical step values still write transition as percent", () => {
  const effect: Effect = { unit: "physical", steps: [
    { values: { Pan: { absolute: -30 } }, transition: 0 },
    { values: { Pan: { relative: 20 } }, transition: 100 },
  ], phaser: {} };
  assert.deepEqual(effectCommands(effect), [
    "Step 1", 'Attribute "Pan" At Absolute Physical -30',
    "Step 2", 'Attribute "Pan" At Relative Physical 20',
    "Step 1", "At Transition Percent 0", "Step 2", "At Transition Percent 100", "Step 1",
  ]);
});

test("per-fixture overrides preserve explicit percent for both value layers", () => {
  const effect: Effect = { unit: "percent", steps: [
    { values: { Pan: { absolute: 50 } } }, { values: { Pan: { absolute: 50 } } },
  ], phaser: {} };
  const commands = effectCommands(effect, [{ member: 0, step: 2, attribute: "Pan", value: { absolute: 45, relative: -10 } }],
    { all: ["Fixture 1 + 2"], some: () => ["Fixture 1"] });
  assert.ok(commands.includes('Attribute "Pan" At Absolute Percent 45'));
  assert.ok(commands.includes('Attribute "Pan" At Relative Percent -10'));
  assert.equal(commands.some((command) => /At (Absolute|Relative) -?\d/.test(command)), false);
});
