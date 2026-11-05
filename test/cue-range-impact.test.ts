import { test } from "node:test";
import assert from "node:assert/strict";
import { planCueRangeImpact, verifyCueRangeEdit } from "../src/cue-range-impact.ts";

const row = (fixture: string, attribute: string, value: number) => ({ fixture, attribute, hasAbsolute: true, hasRelative: false, value });
const native = (last = 20) => ({ complete: true, sequence: { fields: { Tracking: "Yes" } }, cues: [
  { no: 1000, name: "One", fields: {}, parts: [{ no: 0, fields: {}, contentJson: JSON.stringify({ byFixtures: true, truncated: false, rows: [row("101", "Dimmer", 45), row("101", "ColorRGB_B", 0)] }) }] },
  { no: 2000, name: "Two", fields: {}, parts: [{ no: 0, fields: {}, contentJson: JSON.stringify({ byFixtures: true, truncated: false, rows: [] }) }] },
  { no: 3000, name: "Three", fields: {}, parts: [{ no: 0, fields: {}, contentJson: JSON.stringify({ byFixtures: true, truncated: false, rows: [row("101", "ColorRGB_B", last)] }) }] },
] });
const scope = [{ attribute: "ColorRGB_B", layer: "absolute" as const }];
test("tracking-forward preview stops at independent later stored value and preserves intensity scope", () => {
  const p = planCueRangeImpact(native(), [1], ["101"], scope, "tracking_forward", 0);
  assert.equal(p.complete, true); assert.deepEqual(p.potentialLaterCues, [2]);
  assert.deepEqual(p.selectedCues, [1]); assert.equal(p.preservesIntensity, true);
});
test("cue-only preview distinguishes intended preserved looks and native restoration data", () => {
  const p = planCueRangeImpact(native(), [1], ["101"], scope, "cue_only", 0);
  assert.deepEqual(p.potentialLaterCues, []); assert.deepEqual(p.restorationCandidates, [2]);
});
test("unqualified tracking data remains unavailable instead of a fabricated impact", () => {
  const n = native(); n.complete = false;
  const p = planCueRangeImpact(n, [1], ["101"], scope, "tracking_forward", 0);
  assert.equal(p.complete, false); assert(p.limitations.length > 0);
});
test("native postcheck detects an unrequested Dimmer change or new block", () => {
  const before = native(), after = structuredClone(before);
  const data = JSON.parse(after.cues[1].parts[0].contentJson);
  data.rows.push(row("101", "ColorRGB_B", 100), row("101", "Dimmer", 45));
  after.cues[1].parts[0].contentJson = JSON.stringify(data);
  const r = verifyCueRangeEdit(before, after, [2], ["101"], scope, [{ attribute: "ColorRGB_B", layer: "absolute", value: 100 }], 0);
  assert.equal(r.status, "mismatched"); assert.match(r.detail!, /unrequested/i);
});
test("native postcheck confirms scoped edit and unchanged inherited Dimmer", () => {
  const before = native(), after = structuredClone(before);
  after.cues[1].parts[0].contentJson = JSON.stringify({ byFixtures: true, truncated: false, rows: [row("101", "ColorRGB_B", 100)] });
  const r = verifyCueRangeEdit(before, after, [2], ["101"], scope, [{ attribute: "ColorRGB_B", layer: "absolute", value: 100 }], 0);
  assert.equal(r.status, "matched", r.detail);
});
test("wrong requested stored value fails even if other channels stayed unchanged", () => {
  const before = native(), after = structuredClone(before);
  after.cues[1].parts[0].contentJson = JSON.stringify({ byFixtures: true, truncated: false, rows: [row("101", "ColorRGB_B", 99)] });
  const r = verifyCueRangeEdit(before, after, [2], ["101"], scope, [{ attribute: "ColorRGB_B", layer: "absolute", value: 100 }], 0);
  assert.equal(r.status, "mismatched");
});
test("relative layer stays protected when only absolute layer is requested", () => {
  const before = native(), after = structuredClone(before);
  after.cues[1].parts[0].contentJson = JSON.stringify({ byFixtures: true, truncated: false, rows: [{ ...row("101", "ColorRGB_B", 100), hasRelative: true, relative: 5 }] });
  const r = verifyCueRangeEdit(before, after, [2], ["101"], scope, [{ attribute: "ColorRGB_B", layer: "absolute", value: 100 }], 0);
  assert.equal(r.status, "mismatched"); assert.match(r.detail!, /unrequested/i);
});

test("newly introduced channel values can track into cues with no previous channel value", () => {
  const input = native();
  input.cues[0].parts[0].contentJson = JSON.stringify({ byFixtures: true, truncated: false, rows: [row("101", "Dimmer", 45)] });
  const plan = planCueRangeImpact(input, [1], ["101"], scope, "tracking_forward", 0);
  assert.deepEqual(plan.potentialLaterCues, [2]);
});

test("Cue Only requires effective values outside the selected cues to be restored", () => {
  const before = native(), after = structuredClone(before);
  after.cues[0].parts[0].contentJson = JSON.stringify({ byFixtures: true, truncated: false, rows: [row("101", "Dimmer", 45), row("101", "ColorRGB_B", 100)] });
  const args = [[1], ["101"], scope, [{ attribute: "ColorRGB_B", layer: "absolute" as const, value: 100 }], 0, "cue_only"] as const;
  const verify = () => verifyCueRangeEdit(before, after, [...args[0]], [...args[1]], args[2], [...args[3]], args[4], args[5]);
  assert.equal(verify().status, "mismatched");
  assert.match(verify().detail!, /cue only/i);
  after.cues[1].parts[0].contentJson = JSON.stringify({ byFixtures: true, truncated: false, rows: [row("101", "ColorRGB_B", 0)] });
  assert.equal(verify().status, "matched", verify().detail);
});
