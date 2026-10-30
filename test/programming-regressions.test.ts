import { test } from "node:test";
import assert from "node:assert/strict";
import { effectCommands, expectedPhase, type Effect } from "../src/tools/phasers.ts";

test("phaser values and speed do not inherit the operator's current readout units", () => {
  const effect: Effect = {
    unit: "percent",
    steps: [{ values: { Dimmer: { absolute: 100 } }, width: 100, transition: 0 }, { values: { Dimmer: { absolute: 0 } }, accel: -100, decel: 100 }],
    phaser: { speedBpm: 120 },
  };
  const commands = effectCommands(effect);
  assert.ok(commands.includes('Attribute "Dimmer" At Absolute Percent 100'));
  assert.ok(commands.includes("At Speed BPM 120"));
  assert.ok(commands.includes("At Width Percent 100"));
  assert.ok(commands.includes("At Transition Percent 0"));
  assert.ok(commands.includes("At Acceleration Percent -100"));
  assert.ok(commands.includes("At Deceleration Percent 100"));
});

test("two wings mirror an odd rig around its single centre fixture", () => {
  const phase = Array.from({ length: 9 }, (_, k) => expectedPhase({ from: 0, to: 180 }, k, 9, { kind: "wings", count: 2 }));
  assert.deepEqual(phase, [0, 45, 90, 135, 180, 135, 90, 45, 0]);
});
