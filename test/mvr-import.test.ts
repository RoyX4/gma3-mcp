import { test } from "node:test";
import assert from "node:assert/strict";
import { planMvrImport, verifyMvrImport } from "../src/mvr-import.ts";
import type { MvrInventory, MvrObject } from "../src/mvr.ts";
const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002", C = "00000000-0000-4000-8000-000000000003";
const fixture = (uuid: string, fixtureId: string, x = 0): MvrObject => ({ uuid, kind: "Fixture", name: fixtureId, parent: null, matrix: [1,0,0,x,0,1,0,0,0,0,1,0], worldMatrix: [1,0,0,x,0,1,0,0,0,0,1,0], fixtureId, gdtfSpec: "type.gdtf", gdtfMode: "Mode 1", addresses: [{ break: 0, address: Number(fixtureId) }], geometryHash: null });
const inventory = (objects: MvrObject[], hash = "baseline"): MvrInventory => ({ version: "1.6", archive: { file: "/mapped/rig.mvr", sha256: hash, bytes: 1, members: 2 }, objects, assets: [{ name: "type.gdtf", bytes: 10, sha256: "asset" }], fixtureIdConflicts: {}, units: { translation: "millimetres" } });

test("MVR decisions use UUID identity, preserve unmentioned local fixtures and select patch/transform independently", () => {
  const before = inventory([fixture(A, "1"), fixture(B, "2")]), incoming = inventory([fixture(A, "101", 1000), fixture(C, "3")], "incoming");
  const plan = planMvrImport(before, incoming, [{ uuid: A, source: "local", patch: "incoming", transform: "incoming" }, { uuid: C, source: "incoming" }]);
  assert.equal(plan.executable, true);
  assert.equal(plan.expectedFixtures.length, 3);
  const a = plan.expectedFixtures.find((f) => f.uuid === A)!;
  assert.equal(a.fixtureId, "1");
  assert.equal(a.addresses[0].address, 101);
  assert.equal(a.worldMatrix[3], 1000);
  assert.equal(plan.expectedFixtures.find((f) => f.uuid === B)?.fixtureId, "2");
  assert.equal(plan.removed.length, 0);
});

test("explicit MVR removals and duplicate fixture IDs are concrete reviewable decisions", () => {
  const before = inventory([fixture(A, "1"), fixture(B, "2")]), incoming = inventory([fixture(C, "1")], "incoming");
  const conflict = planMvrImport(before, incoming, [{ uuid: C, source: "incoming" }]);
  assert.equal(conflict.executable, false);
  const plan = planMvrImport(before, incoming, [{ uuid: A, source: "omit" }, { uuid: C, source: "incoming" }]);
  assert.equal(plan.executable, true);
  assert.deepEqual(plan.removed, [A]);
  assert.throws(() => planMvrImport(before, incoming, [{ uuid: B, source: "incoming" }]), /no incoming/i);
  assert.throws(() => planMvrImport(before, incoming, [{ uuid: C, source: "incoming" }, { uuid: C, source: "omit" }]), /duplicate/i);
});

test("post-import verification checks UUID/FID/type/address/world transform and never matches by fixture number", () => {
  const before = inventory([fixture(A, "1")]), incoming = inventory([fixture(A, "1", 500)], "incoming");
  const plan = planMvrImport(before, incoming, [{ uuid: A, source: "incoming" }]);
  assert.equal(verifyMvrImport(plan, incoming).status, "matched");
  assert.equal(verifyMvrImport(plan, inventory([fixture(B, "1", 500)])).status, "mismatched");
  const changed = fixture(A, "1", 500); changed.gdtfMode = "Wrong mode";
  assert.equal(verifyMvrImport(plan, inventory([changed])).status, "mismatched");
  assert.equal(verifyMvrImport(plan, inventory([fixture(A, "1", 501)])).status, "mismatched");
});

test("MVR verification cannot approve invalid decisions or a changed authored fixture name", () => {
  const before = inventory([fixture(A, "1")]), incoming = inventory([fixture(B, "1")], "incoming");
  const invalid = planMvrImport(before, incoming, [{ uuid: B, source: "incoming" }]);
  assert.equal(verifyMvrImport(invalid, inventory(invalid.expectedFixtures)).status, "unavailable");
  const plan = planMvrImport(before, incoming, []), changed = fixture(A, "1"); changed.name = "unexpected rename";
  assert.equal(verifyMvrImport(plan, inventory([changed])).status, "mismatched");
});

test("incoming MVR types require an explicit mode and cannot reuse a DMX break ambiguously", () => {
  const incoming = fixture(A, "1"); incoming.gdtfMode = "";
  assert.equal(planMvrImport(inventory([]), inventory([incoming]), [{ uuid: A, source: "incoming" }]).executable, false);
  incoming.gdtfMode = "Mode 1"; incoming.addresses = [{ break: 0, address: 1 }, { break: 0, address: 2 }];
  assert.equal(planMvrImport(inventory([]), inventory([incoming]), [{ uuid: A, source: "incoming" }]).executable, false);
});

test("fixture geometry references remain part of the desired import result", () => {
  const before = fixture(A, "1"), incoming = fixture(A, "1"); incoming.geometryHash = "incoming-geometry";
  const plan = planMvrImport(inventory([before]), inventory([incoming]), [{ uuid: A, source: "incoming" }]);
  assert.ok(plan.changed[0]?.fields.includes("geometryHash"));
  assert.equal(verifyMvrImport(plan, inventory([before])).status, "mismatched");
});
