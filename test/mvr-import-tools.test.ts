import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { registerMvrImportTools } from "../src/tools/mvr-import.ts";
import { startHarness } from "./helpers/tool-harness.ts";
const UUID = "00000000-0000-4000-8000-000000000001";
async function fixtureFiles(fn: (files: { before: string; incoming: string; output: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "gma3-mvr-decisions-"));
  const files = { before: join(dir, "Before.mvr"), incoming: join(dir, "Incoming.mvr"), output: join(dir, "Observed.mvr") };
  try {
    execFileSync("python3", ["-I", "-c", `import sys,zipfile
for file,x in [(sys.argv[1],0),(sys.argv[2],250)]:
 with zipfile.ZipFile(file,'x') as z:
  z.writestr('GeneralSceneDescription.xml','<GeneralSceneDescription verMajor="1" verMinor="6"><Scene><Fixture uuid="${UUID}" name="Dimmer"><Matrix>{1,0,0}{0,1,0}{0,0,1}{'+str(x)+',0,0}</Matrix><FixtureID>1</FixtureID><GDTFSpec>dimmer.gdtf</GDTFSpec><GDTFMode>Mode 0</GDTFMode></Fixture></Scene></GeneralSceneDescription>')
  z.writestr('dimmer.gdtf','type bytes')`, files.before, files.incoming]);
    await fn(files);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
test("MVR import decision tool defaults to offline review and labels file-only verification", async () => {
  const h = await startHarness(registerMvrImportTools);
  try { await fixtureFiles(async (files) => {
    const args = { before_file: files.before, incoming_file: files.incoming, decisions: [{ uuid: UUID, source: "local", transform: "incoming" }] };
    const plan = await h.callJson("gma3_mvr_import_plan", args);
    assert.equal(plan.isError, false); assert.equal(plan.result.nativeApplyQualified, false);
    assert.equal(plan.result.plan.changed[0].fields.includes("worldMatrix"), true);
    const verified = await h.callJson("gma3_mvr_import_plan", { ...args, action: "verify", observed_file: files.incoming });
    assert.equal(verified.isError, false); assert.equal(verified.result.verification.status, "matched");
    assert.match(verified.result.observation.source, /supplied file/i);
    assert.deepEqual(h.fake.requests, []);
  }); } finally { await h.close(); }
});
test("native MVR verification reuses create-only export and fails on context drift", async () => {
  const h = await startHarness(registerMvrImportTools);
  try { await fixtureFiles(async (files) => {
    let reads = 0;
    h.fake.on("fast.context", () => ({ contextKey: ++reads === 1 ? "original" : "changed", identity: { generation: "g", hostname: "lab", showfile: "show", user: "Admin", profile: "Default" }, identityUncertain: [], environment: "Normal" }));
    h.fake.on("patch.state", () => ({ atRoot: true, copyOpen: false, modal: false }));
    h.fake.on("cmd", async () => { await copyFile(files.incoming, files.output); return { feedback: "OK" }; });
    const checked = await h.callJson("gma3_mvr_import_plan", { action: "verify", before_file: files.before, incoming_file: files.incoming, observed_file: files.output, decisions: [{ uuid: UUID, source: "incoming" }], native_export: true, exclusive: true, mapped_to_drive1_mvr: true });
    assert.equal(checked.result.verification.status, "unavailable");
    assert.match(checked.result.verification.detail, /context changed/i);
    assert.equal(h.fake.commands.length, 1);
  }); } finally { await h.close(); }
});
test("native MVR verification rejects missing identity and mapping before export", async () => {
  const h = await startHarness(registerMvrImportTools);
  try { await fixtureFiles(async (files) => {
    const args = { action: "verify", before_file: files.before, incoming_file: files.incoming, observed_file: files.output, native_export: true, decisions: [] };
    assert.equal((await h.call("gma3_mvr_import_plan", args)).isError, true);
    assert.deepEqual(h.fake.requests, []);
    h.fake.on("fast.context", () => ({ identity: { generation: "g" }, identityUncertain: ["showfile"], environment: "Normal" }));
    const missing = await h.callJson("gma3_mvr_import_plan", { ...args, exclusive: true, mapped_to_drive1_mvr: true });
    assert.equal(missing.result.verification.status, "unavailable");
    assert.equal(h.fake.commands.length, 0);
  }); } finally { await h.close(); }
});

test("fresh native export proves the planned fixture result without applying PSR", async () => {
  const h = await startHarness(registerMvrImportTools);
  try { await fixtureFiles(async (files) => {
    h.fake.on("fast.context", () => ({ contextKey: "same-context", identity: { generation: "g", hostname: "lab", showfile: "show", user: "Admin", profile: "Default" }, identityUncertain: [], environment: "Normal" }));
    h.fake.on("patch.state", () => ({ atRoot: true, copyOpen: false, modal: false }));
    h.fake.on("cmd", async (args) => { assert.equal(args.command, 'Export Stage /File "Observed" If Drive 1 /MVR'); await copyFile(files.incoming, files.output); return { feedback: "OK" }; });
    const checked = await h.callJson("gma3_mvr_import_plan", { action: "verify", before_file: files.before, incoming_file: files.incoming, observed_file: files.output, decisions: [{ uuid: UUID, source: "incoming" }], native_export: true, exclusive: true, mapped_to_drive1_mvr: true });
    assert.equal(checked.isError, false); assert.equal(checked.result.verification.status, "matched");
    assert.equal(checked.result.consolePatchChanged, false); assert.match(checked.result.observation.source, /fresh create-only native/i);
    assert.equal(h.fake.commands.length, 1);
  }); } finally { await h.close(); }
});
