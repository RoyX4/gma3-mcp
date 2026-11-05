import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { inspectMvr, compareMvr } from "../src/mvr.ts";
import { registerMvrTools } from "../src/tools/mvr.ts";
import { startHarness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";
const UUID = "00000000-0000-4000-8000-000000000001";
const LAYER = "00000000-0000-4000-8000-000000000002";
const scene = (x = 0, fid = "101", extra = "") =>
  `<?xml version="1.0"?><GeneralSceneDescription verMajor="1" verMinor="6"><Scene><Layers><Layer uuid="${LAYER}" name="Stage"><ChildList><Fixture uuid="${UUID}" name="Mover"><Matrix>{1,0,0}{0,1,0}{0,0,1}{${x},0,6000}</Matrix><FixtureID>${fid}</FixtureID><GDTFSpec>mover.gdtf</GDTFSpec><GDTFMode>Mode 1</GDTFMode><Addresses><Address break="0">513</Address></Addresses></Fixture>${extra}</ChildList></Layer></Layers></Scene></GeneralSceneDescription>`;
function zip(entries: Record<string, string>, compressed = true): Buffer {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const body = Buffer.from(text),
      filename = Buffer.from(name),
      payload = compressed ? deflateRawSync(body) : body;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(compressed ? 8 : 0, 8);
    local.writeUInt32LE(crc32(body), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(compressed ? 8 : 0, 10);
    c.writeUInt32LE(crc32(body), 16);
    c.writeUInt32LE(payload.length, 20);
    c.writeUInt32LE(body.length, 24);
    c.writeUInt16LE(filename.length, 28);
    c.writeUInt32LE(offset, 42);
    locals.push(local, filename, payload);
    central.push(c, filename);
    offset += local.length + filename.length + payload.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
async function withFiles(
  entries: Record<string, Record<string, string>>,
  fn: (files: Record<string, string>) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "gma3-mvr-"));
  try {
    const files: Record<string, string> = {};
    for (const [name, contents] of Object.entries(entries)) {
      files[name] = join(dir, name);
      await writeFile(files[name], zip(contents));
    }
    await fn(files);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("inspects a real compressed MVR archive without console access", async () => {
  await withFiles(
    { "rig.mvr": { "GeneralSceneDescription.xml": scene(), "mover.gdtf": "fixture bytes" } },
    async (files) => {
      const m = await inspectMvr(files["rig.mvr"]);
      assert.equal(m.version, "1.6");
      assert.equal(m.objects.length, 2);
      const f = m.objects.find((o) => o.kind === "Fixture")!;
      assert.equal(f.uuid, UUID);
      assert.equal(f.fixtureId, "101");
      assert.equal(f.parent, LAYER);
      assert.equal(f.addresses[0].address, 513);
      assert.equal(f.worldMatrix[11], 6000);
      assert.equal(m.archive.sha256.length, 64);
      assert.equal(m.assets[0].sha256.length, 64);
    },
  );
});
test("MVR comparison preserves UUID identity and flags readdress/retype changes", async () => {
  await withFiles(
    {
      "before.mvr": { "GeneralSceneDescription.xml": scene() },
      "after.mvr": { "GeneralSceneDescription.xml": scene(1000, "201").replace("Mode 1", "Mode 2") },
    },
    async (files) => {
      const d = compareMvr(await inspectMvr(files["before.mvr"]), await inspectMvr(files["after.mvr"]));
      assert.equal(d.added.length, 0);
      assert.equal(d.removed.length, 0);
      assert.equal(d.changed.length, 1);
      assert.equal(d.changed[0].uuid, UUID);
      assert.ok(d.changed[0].fields.includes("worldMatrix"));
      assert.ok(d.changed[0].fields.includes("fixtureId"));
      assert.ok(d.changed[0].fields.includes("gdtfMode"));
      assert.equal(d.requiresIdentityReview, true);
    },
  );
});
test("detects changed embedded assets even when object names are unchanged", async () => {
  await withFiles(
    {
      "a.mvr": { "GeneralSceneDescription.xml": scene(), "mover.gdtf": "a" },
      "b.mvr": { "GeneralSceneDescription.xml": scene(), "mover.gdtf": "b" },
    },
    async (files) => {
      const d = compareMvr(await inspectMvr(files["a.mvr"]), await inspectMvr(files["b.mvr"]));
      assert.equal(d.changed.length, 0);
      assert.deepEqual(d.assets.changed, ["mover.gdtf"]);
    },
  );
});
test("propagates parent transforms to world transforms", async () => {
  const xml = scene().replace("<ChildList>", "<Matrix>{1,0,0}{0,1,0}{0,0,1}{0,2000,0}</Matrix><ChildList>");
  await withFiles({ "rig.mvr": { "GeneralSceneDescription.xml": xml } }, async (files) => {
    assert.equal((await inspectMvr(files["rig.mvr"])).objects.find((o) => o.uuid === UUID)!.worldMatrix[7], 2000);
  });
});
test("rejects duplicate UUIDs, malformed matrices and document entities", async () => {
  const bad = [
    scene(0, "101", `<SceneObject uuid="${UUID}"/>`),
    scene().replace("{0,0,6000}", "{NaN,0,0}"),
    '<!DOCTYPE x [<!ENTITY a "boom">]>' + scene(),
  ];
  for (const [i, xml] of bad.entries())
    await withFiles({ [`bad${i}.mvr`]: { "GeneralSceneDescription.xml": xml } }, async (files) => {
      await assert.rejects(inspectMvr(files[`bad${i}.mvr`]));
    });
});
test("rejects traversal archive entries and missing scene descriptions", async () => {
  for (const entries of [{ "GeneralSceneDescription.xml": scene(), "../outside": "x" }, { "other.xml": scene() }]) {
    await withFiles({ "bad.mvr": entries }, async (files) => {
      await assert.rejects(inspectMvr(files["bad.mvr"]));
    });
  }
});
test("MVR tools paginate inspection and expose PSR import boundary without mutations", async () => {
  const h = await startHarness(registerMvrTools);
  try {
    await withFiles(
      {
        "a.mvr": { "GeneralSceneDescription.xml": scene() },
        "b.mvr": { "GeneralSceneDescription.xml": scene(500) },
      },
      async (files) => {
        const a = await h.callJson("gma3_inspect_mvr", { file: files["a.mvr"], offset: 0, limit: 1 });
        assert.equal(a.isError, false);
        assert.equal(a.result.total, 2);
        assert.equal(a.result.objects.length, 1);
        assert.equal(a.result.incomplete, true);
        const b = await h.callJson("gma3_compare_mvr", { before: files["a.mvr"], after: files["b.mvr"] });
        assert.equal(b.isError, false);
        assert.equal(b.result.summary.changed, 1);
        assert.match(b.result.importBoundary, /PSR/);
        assert.equal(b.result.consoleChanged, false);
        assert.deepEqual(h.fake.requests, []);
      },
    );
  } finally {
    await h.close();
  }
});
test("native export defaults to preview and requires explicit filesystem mapping to apply", async () => {
  const h = await startHarness(registerMvrTools),
    dir = await mkdtemp(join(tmpdir(), "gma3-export-"));
  try {
    h.fake.on("patch.state", () => ({ atRoot: true, copyOpen: false, modal: false }));
    const file = join(dir, "Rig.mvr");
    const preview = await h.callJson("gma3_export_mvr", { file });
    assert.equal(preview.isError, false);
    assert.equal(preview.result.preview, true);
    assert.equal((await h.call("gma3_export_mvr", { file, dry_run: false, exclusive: true })).isError, true);
    assert.deepEqual(h.fake.commands, []);
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("native export verifies a newly produced real MVR and refuses an existing output", async () => {
  const h = await startHarness(registerMvrTools),
    dir = await mkdtemp(join(tmpdir(), "gma3-export-"));
  try {
    h.fake.on("patch.state", () => ({ atRoot: true, copyOpen: false, modal: false }));
    const file = join(dir, "Rig.mvr");
    h.fake.on("cmd", async (a) => {
      assert.equal(a.command, 'Export Stage /File "Rig" If Drive 1 /MVR');
      await writeFile(file, zip({ "GeneralSceneDescription.xml": scene() }));
      return { feedback: "OK" };
    });
    const { result, isError } = await h.callJson("gma3_export_mvr", {
      file,
      dry_run: false,
      exclusive: true,
      mapped_to_drive1_mvr: true,
      timeout_ms: 1000,
    });
    assert.equal(isError, false);
    assert.equal(result.verification.status, "matched");
    assert.equal(result.file.archive.sha256.length, 64);
    assert.equal(
      (await h.call("gma3_export_mvr", { file, dry_run: false, exclusive: true, mapped_to_drive1_mvr: true })).isError,
      true,
    );
    assert.equal(h.fake.commands.length, 1);
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("native export refuses an open patch and never calls an unverified export successful", async () => {
  const h = await startHarness(registerMvrTools),
    dir = await mkdtemp(join(tmpdir(), "gma3-export-"));
  try {
    const args = {
      file: join(dir, "Rig.mvr"),
      dry_run: false,
      exclusive: true,
      mapped_to_drive1_mvr: true,
      timeout_ms: 300,
    };
    h.fake.on("patch.state", () => ({ atRoot: false, copyOpen: true, modal: false }));
    assert.equal((await h.call("gma3_export_mvr", args)).isError, true);
    assert.deepEqual(h.fake.commands, []);
    h.fake.on("patch.state", () => ({ atRoot: true, copyOpen: false, modal: false }));
    h.fake.onCommand(() => "OK");
    const { result } = await h.callJson("gma3_export_mvr", args);
    assert.equal(result.verification.status, "unavailable");
    assert.equal(result.file, null);
    assert.equal(h.fake.commands.length, 1);
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("native export preserves unknown delivery even when a valid file appears and never replays", async () => {
  const h = await startHarness(registerMvrTools, { requestTimeoutMs: 100 }),
    dir = await mkdtemp(join(tmpdir(), "gma3-export-"));
  try {
    const file = join(dir, "Rig.mvr");
    h.fake.on("patch.state", () => ({ atRoot: true, copyOpen: false, modal: false }));
    h.fake.on("cmd", async () => {
      await writeFile(file, zip({ "GeneralSceneDescription.xml": scene() }));
      return SILENT;
    });
    const { result, isError } = await h.callJson("gma3_export_mvr", {
      file,
      dry_run: false,
      exclusive: true,
      mapped_to_drive1_mvr: true,
      timeout_ms: 1000,
    });
    assert.equal(isError, true);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.verification.status, "matched");
    assert.equal(h.fake.commands.length, 1);
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("invalid MVR and relative paths fail without any bridge request", async () => {
  await assert.rejects(inspectMvr("relative.mvr"), /absolute/);
  const dir = await mkdtemp(join(tmpdir(), "gma3-mvr-"));
  try {
    const file = join(dir, "invalid.mvr");
    await writeFile(file, "not an archive");
    await assert.rejects(inspectMvr(file), /MVR inspection failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
