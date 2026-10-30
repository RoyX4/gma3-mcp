import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { inspectMvr, compareMvr } from "../src/mvr.ts";

const fixture = "10000000-0000-0000-0000-000000000002";
const layer = "10000000-0000-0000-0000-000000000001";
const scene = (addresses: string, layerMatrix = "", fixtureMatrix = "") => `<GeneralSceneDescription verMajor="1" verMinor="6"><Scene><Layers><Layer uuid="${layer}">${layerMatrix}<ChildList><Fixture uuid="${fixture}" name="Mover">${fixtureMatrix}<FixtureID>101</FixtureID><Addresses>${addresses}</Addresses></Fixture></ChildList></Layer></Layers></Scene></GeneralSceneDescription>`;
const write = (file: string, xml: string) => execFileSync("python3", ["-I", "-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('GeneralSceneDescription.xml',sys.stdin.read()); z.close()", file], { input: xml });

test("review: reordered DMX breaks are unchanged addresses, not a readdressing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mvr-review-"));
  try {
    const first = join(dir, "first.mvr"), second = join(dir, "second.mvr");
    write(first, scene('<Address break="1">1</Address><Address break="2">513</Address>'));
    write(second, scene('<Address break="2">513</Address><Address break="1">1</Address>'));
    const diff = compareMvr(await inspectMvr(first), await inspectMvr(second));
    assert.deepEqual(diff.changed, [], "DMX break number establishes address identity, XML child order does not");
    assert.equal(diff.requiresIdentityReview, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("review: rotated parent transforms fixture translation in millimetres", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mvr-review-"));
  try {
    const file = join(dir, "rotated.mvr");
    write(file, scene("", "<Matrix>{0,1,0}{-1,0,0}{0,0,1}{1000,2000,3000}</Matrix>", "<Matrix>{1,0,0}{0,1,0}{0,0,1}{100,0,0}</Matrix>"));
    const item = (await inspectMvr(file)).objects.find(o => o.uuid === fixture)!;
    assert.deepEqual([item.worldMatrix[3], item.worldMatrix[7], item.worldMatrix[11]], [1000, 2100, 3000]);
    assert.deepEqual(item.worldMatrix.slice(0, 3), [0, -1, 0]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
