import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInPreview, validateLooks } from "../src/tools/cuelists.ts";
import { Validator } from "../src/validate.ts";
import { commandStep } from "../src/results.ts";
import { captureProgrammer, verifyProgrammer } from "../src/tools/fixtures.ts";
import { startHarness } from "./helpers/tool-harness.ts";

async function build(options: { missingLastLink?: boolean; overwriteFirstLink?: boolean; incomplete?: boolean } = {}) {
  const h = await startHarness(() => {});
  let environment = "Normal", selection = false, value: number | undefined, preset: string | undefined, readsWithValues = 0;
  h.fake.on("objects", (a) => ({ total: 1, items: [{ name: String(a.ref), addrNative: String(a.ref).replace("Preset ", "P") }] }));
  h.fake.on("feedback.read", () => ({ environment }));
  h.fake.on("cmd", (a) => {
    const command = String(a.command);
    if (command === "Preview On") environment = "Preview";
    if (command === "Preview Off") environment = "Normal";
    if (command === "ClearSelection") selection = false;
    if (command === "ClearAll") { value = undefined; preset = undefined; selection = false; }
    if (command === "Fixture 1") selection = true;
    if (command === "At Preset 4.1") { value = 100; preset = options.overwriteFirstLink ? "wrong" : "P4.1"; }
    if (command === "At Preset 4.2") { value = 50; preset = options.missingLastLink ? undefined : "P4.2"; }
    if (command === 'Attribute "Dimmer" At Absolute Percent 30') value = 30;
    return { feedback: "OK" };
  });
  h.fake.on("programmer", (a) => {
    const active = environment === "Preview" && value !== undefined;
    if (active && a.scope === "selection") readsWithValues++;
    const scannedFixtures = [{ subfixtureIndex: 1, fid: "1", name: "Fixture 1", attributes: ["Dimmer"] }];
    return { environment, total: active ? 1 : 0, coverage: { complete: !(options.incomplete && active) }, scannedFixtures: selection || a.scope === "all" ? scannedFixtures : [], rows: active ? [{ subfixtureIndex: 1, attribute: "Dimmer", value, stepCount: 1, absPreset: preset ? { addrNative: preset } : null }] : [] };
  });
  const v = new Validator(), looks = validateLooks(v, { fixtures: "1", presets: [{ pool: 4, preset: 1 }, { pool: 4, preset: 2 }], values: [{ attribute: "Dimmer", value: 30, unit: "percent" }] }, "cue", undefined);
  assert.deepEqual(v.errors, []);
  try {
    const result = await buildInPreview(h.ctx, { verify: true, noun: "test cue", items: [{ prefix: "cue 1: ", looks, store: [{ name: "cue 1: store", run: () => commandStep(h.bridge, "cue 1: store", "Store Sequence 900 Cue 1 /NoConfirmation") }] }] });
    return { result, readsWithValues, commands: [...h.fake.commands] };
  } finally { await h.close(); }
}

test("last preset and static verification share one complete final snapshot, earlier preset remains immediate", async () => {
  const r = await build();
  assert.equal(r.result.items[0].status, "stored");
  assert.equal(r.readsWithValues, 2); // First preset, then one shared final-preset + static snapshot.
  assert.equal(r.result.normalProgrammer, "untouched");
});
test("missing or overwritten preset links and incomplete final snapshots fail before Store", async () => {
  for (const options of [{ missingLastLink: true }, { overwriteFirstLink: true }, { incomplete: true }]) {
    const r = await build(options);
    assert.equal(r.result.items[0].status, "failed");
    assert.equal(r.commands.some((c) => c.startsWith("Store ")), false);
    assert.equal(r.result.normalProgrammer, "untouched");
  }
});

test("shared snapshots require declared completeness, immutable rows and an identical verification scope", async () => {
  const h = await startHarness(() => {});
  try {
    h.fake.on("programmer", () => ({ total: 1, scannedFixtures: [{ subfixtureIndex: 1, fid: "1", attributes: ["Dimmer"] }], rows: [{ subfixtureIndex: 1, attribute: "Dimmer", value: 30 }] }));
    const incomplete = await captureProgrammer(h.bridge, { scope: "selection" });
    assert.equal(incomplete.result, undefined);
    h.fake.on("programmer", () => ({ total: 1, coverage: { complete: true }, scannedFixtures: [{ subfixtureIndex: 1, fid: "1", attributes: ["Dimmer"] }], rows: [{ subfixtureIndex: 1, attribute: "Dimmer", value: 30 }] }));
    const snapshot = await captureProgrammer(h.bridge, { scope: "selection" });
    assert.throws(() => { (snapshot.result as any).rows[0].value = 90; }, /read only|readonly|assign/i);
    const checked = await verifyProgrammer(h.bridge, [{ attribute: "Dimmer", value: 30, unit: "percent" }], [], [], "Fixture 2", snapshot);
    assert.equal(checked.verification.status, "unavailable");
  } finally { await h.close(); }
});
