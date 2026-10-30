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
