import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstructNativeCues, nativeContentFingerprint } from "../src/native-cues.ts";

const part = (rows: unknown[]) => ({ no: 0, fields: {}, encoding: "json", contentJson: JSON.stringify({ byFixtures: true, truncated: false, rows }), rawChannelsJson: JSON.stringify(rows) });
const cue = (no: number, rows: unknown[], fields = {}) => ({ no, name: String(no), fields, parts: [part(rows)] });
const row = (value: unknown) => ({ fixture: "1", attribute: "Dimmer", hasAbsolute: true, hasRelative: false, stepCount: 1, value });
const content = (cues: unknown[], tracking = "Yes") => ({ complete: true, sequence: { fields: { Tracking: tracking } }, cues });

test("native cue values track with source provenance; release stays distinct from zero", () => {
  const result = reconstructNativeCues(content([cue(1000, [row(0)]), cue(2000, []), cue(3000, [row("release")])]));
  assert.equal(result.complete, true);
  assert.equal(result.cues[1].effective[0].sourceCue, 1000);
  assert.equal(result.cues[1].effective[0].value, 0);
  assert.equal(result.cues[2].effective[0].value, "release");
});
test("native tracked reconstruction refuses unknown distance syntax and incomplete contents", () => {
  assert.equal(reconstructNativeCues(content([{ ...cue(1000, [row(50)]), parts: [{ ...part([row(50)]), fields: { TrackingDistance: "unreadable" } }] }])).complete, false);
  assert.equal(reconstructNativeCues({ ...content([]), complete: false }).complete, false);
  const bad = content([cue(1000, [])]);
  bad.cues[0] = { no: 1000, parts: [{ contentJson: "not json" }] };
  assert.equal(reconstructNativeCues(bad).complete, false);
});
test("tracking disabled uses only local cue channels; absolute and relative layers stay separate", () => {
  const result = reconstructNativeCues(content([cue(1000, [row(50)]), cue(2000, [{ ...row(10), hasAbsolute: false, hasRelative: true, relative: 10 }])], "No"));
  assert.equal(result.complete, true);
  assert.deepEqual(result.cues[1].effective.map(r => r.layer), ["relative"]);
});
test("content fingerprint is stable for object key order and changes on real stored edits", () => {
  assert.equal(nativeContentFingerprint({ a: 1, b: { z: 3, y: 2 } }), nativeContentFingerprint({ b: { y: 2, z: 3 }, a: 1 }));
  assert.notEqual(nativeContentFingerprint(content([cue(1000, [row(10)])])), nativeContentFingerprint(content([cue(1000, [row(20)])])));
});


test("native OffCue and null Break reference do not invalidate positive-cue tracking", () => {
  const result = reconstructNativeCues(content([{ name: "OffCue", fields: { Assert: "Assert", Release: "Yes", Break: "#FFFFFFFFFFFFFFFF" }, parts: [] }, cue(0, [], { Break: "#FFFFFFFFFFFFFFFF" }), cue(1000, [row(50)], { Break: "#FFFFFFFFFFFFFFFF" })]));
  assert.equal(result.complete, true);
  assert.equal(result.cues.at(-1)?.effective[0].value, 50);
});

test("native positive cue Release clears inherited layers before applying its hard values", () => {
  const result = reconstructNativeCues(content([cue(1000, [row(20)]), cue(2000, [], { Release: "Yes" }), cue(3000, [])]));
  assert.equal(result.complete, true);
  assert.deepEqual(result.cues[1].effective, []);
  assert.deepEqual(result.cues[2].effective, []);
});
test("native part tracking distance restores the previous tracked value after its inclusive endpoint", () => {
  const limited = (no: number, value: number, distance: string) => ({ ...cue(no, []), parts: [{ ...part([row(value)]), fields: { TrackingDistance: distance } }] });
  const result = reconstructNativeCues(content([cue(1000, [row(10)]), limited(2000, 80, "3"), cue(3000, []), cue(4000, [])]));
  assert.equal(result.complete, true);
  assert.deepEqual(result.cues.map(c => c.effective[0]?.value), [10, 80, 80, 10]);
  assert.equal(result.cues[3].effective[0].sourceCue, 1000);
  const absent = reconstructNativeCues(content([limited(1000, 50, "1"), cue(2000, [])]));
  assert.deepEqual(absent.cues[1].effective, []);
});
test("overlapping temporary values restore valid predecessors and permanent edits replace expired histories", () => {
  const limited = (no: number, value: number, distance: string) => ({ ...cue(no, []), parts: [{ ...part([row(value)]), fields: { TrackingDistance: distance } }] });
  const overlap = reconstructNativeCues(content([cue(1000, [row(10)]), limited(2000, 20, "3"), limited(3000, 30, "4"), cue(5000, [])]));
  assert.deepEqual(overlap.cues.map(c => c.effective[0]?.value), [10, 20, 30, 10]);
  const permanent = reconstructNativeCues(content([cue(1000, [row(10)]), limited(2000, 20, "3"), cue(3000, [row(40)]), cue(4000, [])]));
  assert.equal(permanent.cues[3].effective[0].value, 40);
});
test("Break and Shield protections are already materialized in stored data; Assert does not change owned layers", () => {
  const result = reconstructNativeCues(content([cue(1000, [row(30)]), cue(2000, [], { Break: "World 1", Shield: "Yes", Assert: "Assert" })]));
  assert.equal(result.complete, true);
  assert.equal(result.cues[1].effective[0].value, 30);
});

test("native cue observation does not call an environment switch or uncertain identity consistent", async () => {
  const { startHarness }=await import("./helpers/tool-harness.ts");
  const { registerNativeCueTools }=await import("../src/tools/native-cues.ts");
  const h=await startHarness(registerNativeCueTools);
  try {
    h.fake.on("cue.content",()=>content([cue(1000,[row(20)])]));
    let n=0;
    h.fake.on("fast.context",()=>({contextKey:"same",environment:++n%2?"Normal":"Preview",identityUncertain:[]}));
    assert.equal((await h.callJson("gma3_native_cue_data",{sequence:1})).result.nativeComplete,false);
    h.fake.on("fast.context",()=>({contextKey:"same",environment:"Normal",identityUncertain:["showfile"]}));
    assert.equal((await h.callJson("gma3_native_cue_data",{sequence:1})).result.contextMatched,false);
  } finally { await h.close(); }
});

test("AllowDuplicates chooses the highest native part separately for absolute and relative layers", () => {
  const p = (no: number, value: number, relative?: number) => ({ ...part([{ ...row(value), ...(relative === undefined ? {} : { hasRelative: true, relative }) }]), no });
  const duplicated = { ...cue(1000, []), fields: { AllowDuplicates: "Yes" }, parts: [p(2, 80), p(0, 20, 5), p(1, 50)] };
  const result = reconstructNativeCues(content([duplicated, cue(2000, [])]));
  assert.equal(result.complete, true, result.limitations.join("; "));
  assert.deepEqual(result.cues[0].effective.map(c => [c.layer, c.value, c.sourcePart]), [["absolute", 80, 2], ["relative", 5, 0]]);
  assert.deepEqual(result.cues[1].effective.map(c => [c.layer, c.value]), [["absolute", 80], ["relative", 5]]);
});
test("duplicate layers refuse inferred precedence when AllowDuplicates is absent or false", () => {
  for (const fields of [{}, { AllowDuplicates: "" }, { AllowDuplicates: "No" }]) {
    const duplicate = { ...cue(1000, []), fields, parts: [part([row(20)]), { ...part([row(80)]), no: 2 }] };
    assert.equal(reconstructNativeCues(content([duplicate])).complete, false);
  }
});
test("missing or malformed part identity is never silently treated as the main part", () => {
  for (const no of [undefined, null, false, "", "garbage", -1, 1.5]) {
    const result = reconstructNativeCues(content([{ ...cue(1000, []), parts: [{ ...part([row(10)]), no }] }]));
    assert.equal(result.complete, false, String(no));
  }
});
test("legacy native part identity uses an exact numeric parent cue address", () => {
  const { no: _discarded, ...legacyPart } = part([row(40)]);
  const parent = "14.14.1.7.9030.2000";
  const legacy = { ...cue(1000, []), addr: parent, parts: [{ ...legacyPart, addr: `${parent}.0` }] };
  const result = reconstructNativeCues(content([legacy]));
  assert.equal(result.complete, true);
  assert.equal(result.cues[0].effective[0].sourcePart, 0);
  assert.equal(reconstructNativeCues(content([{ ...legacy, parts: [{ ...legacyPart, addr: `${parent}0.0` }] }])).complete, false);
});
test("native delta distance tracks through the inclusive starting cue plus numeric delta", () => {
  const limited = { ...cue(2000, []), parts: [{ ...part([row(80)]), fields: { TrackingDistance: "Δ +2.5" } }] };
  const result = reconstructNativeCues(content([cue(1000, [row(10)]), limited, cue(4000, []), cue(4500, []), cue(4501, [])]));
  assert.equal(result.complete, true, result.limitations.join("; "));
  assert.deepEqual(result.cues.map(c => c.effective[0]?.value), [10, 80, 80, 80, 10]);
});

test("duplicate, reordered and coercible cue identities cannot qualify an inheritance chain", () => {
  for (const entries of [[cue(2000, []), cue(1000, [])], [cue(1000, []), cue(1000, [])], [{ ...cue(0, []), no: false }]]) {
    assert.equal(reconstructNativeCues(content(entries)).complete, false);
  }
});

test("large tracked lists stop materializing before the effective cell budget is exceeded", () => {
  const channels = Array.from({ length: 1000 }, (_, i) => ({ ...row(40), fixture: String(i + 1) }));
  const result = reconstructNativeCues(content([cue(1000, channels), ...Array.from({ length: 1000 }, (_, i) => cue((i + 2) * 1000, []))]));
  assert.equal(result.complete, false);
  assert.equal(result.cues.length, 1000);
  assert.match(result.limitations.join(" "), /1000000 materialized cells/);
});
