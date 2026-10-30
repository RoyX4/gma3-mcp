import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerWorkspaceTools } from "../src/tools/workspace.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";
let h: Harness;
let objects: Map<string, any>;
let ignoreField = "";
const pose = { position: { x: 0, y: -12, z: 5 }, pan: 0, tilt: 15, fov: 45 };
const entry = (ref: string, fields: Record<string, unknown> = {}) => ({
  class: ref.split(" ")[0],
  addr: ref,
  fields: { LOCK: "", SYSTEMLOCKED: false, STRUCTURELOCKED: false, ...fields },
});
before(async () => {
  h = await startHarness(registerWorkspaceTools, { requestTimeoutMs: 100 });
});
after(async () => {
  await h.close();
});
beforeEach(() => {
  h.fake.reset();
  objects = new Map([
    ["Group 1", entry("Group 1")],
    ["Macro 2", entry("Macro 2")],
  ]);
  ignoreField = "";
  h.fake.on("objects", (a) => {
    const obj = objects.get(String(a.ref));
    return { total: obj ? 1 : 0, count: obj ? 1 : 0, offset: 0, items: obj ? [obj] : [] };
  });
  h.fake.on("children", (a) => {
    const children = [...objects].filter(([ref]) => ref.startsWith(String(a.ref) + ".")).map(([, obj]) => obj);
    return { total: children.length, count: children.length, offset: 0, items: children };
  });
  h.fake.onCommand((c) => {
    let m = c.match(/^Store (Camera|Layout) (\d+)(?: "([^"]+)")? \/NoConfirmation$/);
    if (m) {
      const ref = `${m[1]} ${m[2]}`;
      objects.set(ref, entry(ref, { NAME: m[3] ?? m[1] }));
      return "OK";
    }
    m = c.match(/^Assign (.+) At (Layout \d+)$/);
    if (m) {
      const count = [...objects.keys()].filter((ref) => ref.startsWith(m![2] + ".")).length;
      const ref = `${m[2]}.${count + 1}`;
      objects.set(ref, {
        class: "Element",
        addr: ref,
        index: count + 1,
        fields: {
          OBJECT: { addr: objects.get(m[1]).addr },
          POSX: 0,
          POSY: 0,
          WIDTH: 10,
          HEIGHT: 10,
          LOCK: "",
          SYSTEMLOCKED: false,
          STRUCTURELOCKED: false,
        },
      });
      return "OK";
    }
    throw new Error(`unexpected command: ${c}`);
  });
  h.fake.on("set", (a) => {
    const obj = objects.get(String(a.ref));
    assert.ok(obj, `Missing ${a.ref}`);
    if (a.property !== ignoreField) obj.fields[String(a.property)] = a.value;
    return { value: obj.fields[String(a.property)], readOk: true };
  });
});
test("camera configuration defaults to dry-run", async () => {
  const { result, isError } = await h.callJson("gma3_configure_camera", { camera: 30, name: "Front rig", ...pose });
  assert.equal(isError, false);
  assert.equal(result.preview, true);
  assert.deepEqual(h.fake.commands, []);
  assert.equal(
    h.fake.requests.some((r) => r.op === "set"),
    false,
  );
});
test("creates a camera pose in metres and degrees and verifies every requested field", async () => {
  const { result, isError } = await h.callJson("gma3_configure_camera", {
    camera: 30,
    name: "Front rig",
    ...pose,
    dry_run: false,
  });
  assert.equal(isError, false);
  assert.equal(result.verification.status, "matched");
  assert.equal(objects.get("Camera 30").fields.POSY, -12);
  assert.deepEqual(h.fake.commands, ['Store Camera 30 "Front rig" /NoConfirmation']);
  assert.equal(result.scope, "current user profile");
});
test("camera create refuses an occupied slot and update refuses system cameras", async () => {
  objects.set("Camera 30", entry("Camera 30", { SYSTEMLOCKED: true }));
  for (const mode of ["create", "update"])
    assert.equal((await h.call("gma3_configure_camera", { camera: 30, mode, ...pose, dry_run: false })).isError, true);
  assert.deepEqual(h.fake.commands, []);
  assert.equal(
    h.fake.requests.some((r) => r.op === "set"),
    false,
  );
});
test("camera update checks unchanged requested values after coupled setters", async () => {
  objects.set("Camera 30", entry("Camera 30", { POSX: 0, POSY: -12, POSZ: 5, PAN: 0, TILT: 15, FOV: 45 }));
  const original = h.fake.handlerFor("set")!;
  h.fake.on("set", (a, r) => {
    if (a.property === "FOV") objects.get("Camera 30").fields.POSX = 999;
    return original(a, r);
  });
  const { result, isError } = await h.callJson("gma3_configure_camera", {
    camera: 30,
    mode: "update",
    ...pose,
    fov: 50,
    dry_run: false,
  });
  assert.equal(isError, true);
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.verification.detail, /POSX/);
});
test("camera stops after an uncertain write and never retries", async () => {
  h.fake.on("set", () => SILENT);
  const { result, isError } = await h.callJson("gma3_configure_camera", { camera: 30, ...pose, dry_run: false });
  assert.equal(isError, true);
  assert.ok(result.steps.some((s: any) => s.status === "unknown"));
  assert.equal(h.fake.requests.filter((r) => r.op === "set").length, 1);
});
test("builds an actual new Layout with verified object identity and grid positions", async () => {
  const { result, isError } = await h.callJson("gma3_build_layout", {
    layout: 30,
    name: "Show buttons",
    items: [{ object: "Group 1" }, { object: "Macro 2", label: "Next" }],
    grid: { columns: 2, width: 100, height: 40, gap: 10 },
    dry_run: false,
  });
  assert.equal(isError, false);
  assert.equal(result.verification.status, "matched");
  assert.equal(objects.get("Layout 30.2").fields.POSX, 110);
  assert.equal(objects.get("Layout 30.2").fields.CUSTOMTEXTTEXT, "Next");
  assert.equal(objects.get("Layout 30.1").fields.OBJECT.addr, "Group 1");
  assert.equal(
    h.fake.commands.some((c) => /Clear|Select|Go\+/.test(c)),
    false,
  );
});
test("Layout dry-run validates every reference without creating anything", async () => {
  const { result, isError } = await h.callJson("gma3_build_layout", {
    layout: 30,
    items: [{ object: "Group 1" }, { object: "Macro 999" }],
  });
  assert.equal(isError, true);
  assert.match(JSON.stringify(result), /Macro 999/);
  assert.deepEqual(h.fake.commands, []);
});
test("refuses occupied Layouts and duplicate objects without deleting content", async () => {
  objects.set("Layout 30", entry("Layout 30"));
  for (const args of [
    { layout: 30, items: [{ object: "Group 1" }] },
    { layout: 31, items: [{ object: "Group 1" }, { object: "Group 1" }] },
  ])
    assert.equal((await h.call("gma3_build_layout", { ...args, dry_run: false })).isError, true);
  assert.deepEqual(h.fake.commands, []);
});
test("rejects unsafe references, Int16 overflow and overlapping explicit elements before writes", async () => {
  for (const items of [
    [{ object: "Group 1; Go+ Sequence 1" }],
    [{ object: "Group 1", x: 40000, y: 0 }],
    [
      { object: "Group 1", x: 0, y: 0 },
      { object: "Macro 2", x: 0, y: 0 },
    ],
  ])
    assert.equal((await h.call("gma3_build_layout", { layout: 30, items, dry_run: false })).isError, true);
  assert.deepEqual(h.fake.commands, []);
});
test("detects silently ignored Layout geometry writes", async () => {
  ignoreField = "WIDTH";
  const { result, isError } = await h.callJson("gma3_build_layout", {
    layout: 30,
    items: [{ object: "Group 1" }],
    dry_run: false,
  });
  assert.equal(isError, true);
  assert.equal(result.verification.status, "mismatched");
});
test("stops before setting geometry when the Layout assignment points elsewhere", async () => {
  h.fake.onCommand((c) => {
    if (c.startsWith("Store")) objects.set("Layout 30", entry("Layout 30"));
    else
      objects.set("Layout 30.1", {
        class: "Element",
        addr: "Layout 30.1",
        index: 1,
        fields: { OBJECT: { addr: "Macro 2" }, LOCK: "" },
      });
    return "OK";
  });
  const { isError } = await h.callJson("gma3_build_layout", {
    layout: 30,
    items: [{ object: "Group 1" }],
    dry_run: false,
  });
  assert.equal(isError, true);
  assert.equal(
    h.fake.requests.some((r) => r.op === "set"),
    false,
  );
});
