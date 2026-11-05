/** Independent regressions from cross-review of the new programming tools. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerFocusTools } from "../src/tools/focus.ts";
import { registerWorkspaceTools } from "../src/tools/workspace.ts";
import { startHarness } from "./helpers/tool-harness.ts";

test("camera apply cannot report success when its final read returns no Camera", async () => {
  const h = await startHarness(registerWorkspaceTools);
  const fields = { LOCK: false, SYSTEMLOCKED: false, STRUCTURELOCKED: false, POSX: 0, POSY: 0, POSZ: 0, PAN: 0, TILT: 0, ROLL: 0, FOV: 60 };
  let reads = 0;
  h.fake.on("objects", () => ++reads === 1 ? { total: 1, items: [{ class: "Camera", addr: "camera-1", fields }] } : { total: 0, items: [] });
  h.fake.on("set", args => ({ value: args.value }));
  try {
    const { result, isError } = await h.callJson("gma3_configure_camera", { camera: 1, mode: "update", position: { x: 1, y: 0, z: 0 }, pan: 0, tilt: 0, fov: 60, dry_run: false });
    assert.equal(isError, true);
    assert.equal(result.verification.status, "unavailable");
    assert.notEqual(result.outcome, "succeeded");
  } finally { await h.close(); }
});

test("focus application surfaces an incomplete programmer read as an error", async () => {
  const h = await startHarness(registerFocusTools);
  try {
    h.fake.on("patch.state", () => ({ copyOpen: false }));
    h.fake.on("patch.list", () => ({ total: 1, fixtures: [{ fid: 1, name: "Mover", depth: 0 }] }));
    h.fake.on("objects", () => ({ total: 1, items: [{ class: "Fixture", addr: "Mover", fields: { FID: 1, POSX: 0, POSY: 0, POSZ: 5, ROTX: 0, ROTY: 0, ROTZ: 0, MESHMIRRORX: false } }] }));
    h.fake.on("fixtureAttributes", () => ({ fid: "1", subfixtureIndex: 1, total: 2, attributes: [
      { attribute: "Pan", physicalFrom: -270, physicalTo: 270, physicalUnit: "Angle" },
      { attribute: "Tilt", physicalFrom: -135, physicalTo: 135, physicalUnit: "Angle" },
    ] }));
    h.fake.onCommand(() => "OK");
    // The bridge read itself succeeds, but it explicitly reports incomplete coverage.
    h.fake.on("programmer", () => ({ rows: [], total: 0, count: 0, coverage: { complete: false }, scannedFixtures: [], limitations: ["channel budget reached"] }));
    const result = await h.call("gma3_focus_target", {
      target: { name: "Upstage", position: { x: 0, y: 5, z: 0 } },
      fixtures: [{ fid: 1, reference: { pan: 0, tilt: 0 }, calibration: { convention: "beam_down_tilt_positive_y", pan_zero: 0, tilt_zero: 0, pan_sign: 1, tilt_sign: 1 } }],
      preview: false, exclusive: true,
    });
    assert.equal(result.isError, true, "a focus whose requested values could not be verified must stop callers, even when the bridge read returned successfully");
  } finally { await h.close(); }
});
