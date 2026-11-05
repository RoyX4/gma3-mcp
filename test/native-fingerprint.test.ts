import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeContentFingerprint } from "../src/native-cues.ts";
import * as nativeFingerprint from "../src/native-fingerprint.ts";

test("native fingerprints compare encoded objects independent of Lua process JSON key order", () => {
  const before = { contentJson: '{"byFixtures":true,"rows":[{"fixture":"1","value":10}],"truncated":false}', rawChannelsJson: '{"entries":[{"keyType":"number","key":"1","value":{"entries":[{"keyType":"string","key":"absolute","value":10}]}}]}' };
  const after = { rawChannelsJson: '{"entries":[{"value":{"entries":[{"value":10,"key":"absolute","keyType":"string"}]},"key":"1","keyType":"number"}]}', contentJson: '{"truncated":false,"rows":[{"value":10,"fixture":"1"}],"byFixtures":true}' };
  assert.equal(nativeContentFingerprint(before), nativeContentFingerprint(after));
});

test("native typed table order is immaterial while ordinary array order and every key type/value remain significant", () => {
  const entry = (keyType: string, key: string, value: unknown) => ({ keyType, key, value });
  const data = (entries: unknown[], rows = [1, 2]) => ({ rawChannelsJson: JSON.stringify({ entries }), contentJson: JSON.stringify({ rows }) });
  const entries = [entry("string", "1", 5), entry("number", "1", 6)];
  assert.equal(nativeContentFingerprint(data(entries)), nativeContentFingerprint(data([...entries].reverse())));
  assert.notEqual(nativeContentFingerprint(data(entries)), nativeContentFingerprint(data(entries, [2, 1])));
  assert.notEqual(nativeContentFingerprint(data(entries)), nativeContentFingerprint(data([entry("string", "1", 5), entry("number", "1", 7)])));
  assert.notEqual(nativeContentFingerprint(data([entry("number", "1", 5)])), nativeContentFingerprint(data([entry("string", "1", 5)])));
});

test("native JSON numbers retain large integer precision and reject invalid or ambiguous encoded data", () => {
  assert.notEqual(nativeContentFingerprint({ contentJson: '{"value":9007199254740992}' }), nativeContentFingerprint({ contentJson: '{"value":9007199254740993}' }));
  for (const rawChannelsJson of ['{"value":1,"value":2}', 'not json', '{"entries":[{"keyType":"string","key":"x","value":1},{"keyType":"string","key":"x","value":2}]}', '{"entries":[{"keyType":"boolean","key":"true","value":1}]}']) {
    assert.throws(() => nativeContentFingerprint({ rawChannelsJson }));
  }
});


test("ordinary entries arrays are not interpreted as native tables, and encoded JSON bounds fail closed", () => {
  const entries = [{ keyType: "string", key: "a", value: 1 }, { keyType: "string", key: "b", value: 2 }];
  assert.notEqual(nativeContentFingerprint({ contentJson: JSON.stringify({ entries }) }), nativeContentFingerprint({ contentJson: JSON.stringify({ entries: [...entries].reverse() }) }));
  assert.throws(() => nativeContentFingerprint({ contentJson: "[".repeat(65) + "0" + "]".repeat(65) }), /depth bound/);
  assert.throws(() => nativeContentFingerprint({ contentJson: JSON.stringify("x".repeat(16 * 1024 * 1024)) }), /byte bound/);
});

test("native numeric table keys reject equivalent duplicates and nonnative spellings without rounding int64 keys", () => {
  const data = (keys: string[]) => ({ rawChannelsJson: JSON.stringify({ entries: keys.map((key) => ({ keyType: "number", key, value: 1 })) }) });
  for (const keys of [["1", "1.0"], ["1", "10e-1"], ["0", "-0.0"], ["0x1"], [" 1"], ["1 "], ["01"]]) assert.throws(() => nativeContentFingerprint(data(keys)));
  assert.doesNotThrow(() => nativeContentFingerprint(data(["9007199254740992", "9007199254740993", "9223372036854775807", "1e-05"])));
});

test("only encoded View property values get native table ordering; window and property arrays keep their meaning", () => {
  const entries = [{ keyType: "string", key: "left", value: 1 }, { keyType: "number", key: "2", value: 2 }];
  const view = (values: unknown[], names = ["ONE", "TWO"]) => ({ kind: "saved_view", contentJson: JSON.stringify([{ configuration: { class: "Window3D", properties: names.map((name) => ({ name, value: { entries: values } })), children: [] } }]) });
  assert.equal(nativeContentFingerprint(view(entries)), nativeContentFingerprint(view([...entries].reverse())));
  assert.notEqual(nativeContentFingerprint(view(entries)), nativeContentFingerprint(view(entries, ["TWO", "ONE"])));
  assert.throws(() => nativeContentFingerprint({ contentJson: '{"a":1,"\\u0061":2}' }), /Duplicate/);
});


test("shared native JSON parser preserves numeric atoms through projections without accepting a rawJSON lookalike", () => {
  const parseLossless = (nativeFingerprint as { parseNativeJson?: (text: string) => unknown }).parseNativeJson ?? JSON.parse;
  const isRaw = (nativeFingerprint as { isNativeRawJson?: (value: unknown) => boolean }).isNativeRawJson ?? (() => false);
  const value = parseLossless('{"mask":9007199254740993,"pose":55.0}') as Record<string, unknown>;
  assert.equal(JSON.stringify({ ...value, label: "projected" }), '{"mask":9007199254740993,"pose":55.0,"label":"projected"}');
  assert.equal(isRaw(value.mask), true);
  assert.equal(isRaw({ rawJSON: "9007199254740993" }), false);
  assert.throws(() => parseLossless('{"a":1,"a":2}'), /Duplicate/);
  assert.throws(() => parseLossless("[".repeat(65) + "0" + "]".repeat(65)), /depth bound/);
});

test("branded native numeric atoms remain distinct from objects with a rawJSON property when hashed", () => {
  const parseLossless = (nativeFingerprint as { parseNativeJson: (text: string) => unknown }).parseNativeJson;
  const value = parseLossless('{"mask":9007199254740993}');
  assert.notEqual(nativeContentFingerprint(value), nativeContentFingerprint({ mask: { rawJSON: "9007199254740993" } }));
});

test("lossless projection exports preserve the previously published encoded native-json-v2 hash", () => {
  const value = { kind: "saved_view", contentJson: '[{"screen":1,"configuration":{"class":"Window3D","properties":[{"name":"MASK","value":9007199254740993}],"children":[]}}]', rawChannelsJson: '{"entries":[{"keyType":"number","key":"1","value":9223372036854775807}]}' };
  // Captured from the already-built FINALv3 implementation before the projection exports were added.
  assert.equal(nativeContentFingerprint(value), "8c9728807c08fc9b06cfb04dce8470229da0dabb1c29abd9f74259fa7f6a43c6");
});
