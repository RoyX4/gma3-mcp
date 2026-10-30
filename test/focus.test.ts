import { test } from "node:test";
import assert from "node:assert/strict";
import { solveFocus, segmentBoxHit, type Calibration } from "../src/focus.ts";
import { registerFocusTools } from "../src/tools/focus.ts";
import { startHarness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

const origin = { x: 0, y: 0, z: 5 };
const rotation = { x: 0, y: 0, z: 0 };
const calibration: Calibration = { convention: "beam_down_tilt_positive_y", pan_zero: 0, tilt_zero: 0, pan_sign: 1, tilt_sign: 1 };
const limits = { pan: [-270, 270] as [number, number], tilt: [-135, 135] as [number, number] };
const solve = (target: typeof origin, reference = { pan: 0, tilt: 0 }, c = calibration, r = rotation, l = limits) => solveFocus(origin, r, target, c, l, reference);
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

test("focus solves the calibrated beam model and retains Pan at the vertical singularity", () => {
  let got = solve({ x: 0, y: 5, z: 0 }); near(got.pan, 0); near(got.tilt, 45);
  got = solve({ x: -5, y: 0, z: 0 }); near(got.pan, 90); near(got.tilt, 45);
  got = solve({ x: 0, y: 0, z: 0 }, { pan: 67, tilt: 0 }); near(got.pan, 67); near(got.tilt, 0);
});

test("focus transforms the world target through the full live patch rotation", () => {
  const got = solve({ x: -5, y: 0, z: 0 }, { pan: 0, tilt: 0 }, calibration, { x: 0, y: 0, z: 90 });
  near(got.pan, 0); near(got.tilt, 45);
});

test("focus picks the nearby equivalent Pan and the legal negative Tilt branch", () => {
  const angle = 170 * Math.PI / 180;
  const got = solve({ x: Math.sin(angle) * 5, y: Math.cos(angle) * 5, z: 0 }, { pan: 170, tilt: 45 });
  near(got.pan, 190);
  const negative = solve({ x: 0, y: 5, z: 0 }, { pan: 180, tilt: -45 }, calibration, rotation, { pan: [-270, 270], tilt: [-100, 0] });
  near(negative.pan, 180); near(negative.tilt, -45);
});

test("focus calibration offsets and reversed axes change physical commands", () => {
  const got = solve({ x: -5, y: 0, z: 0 }, { pan: 0, tilt: 0 }, { ...calibration, pan_zero: 10, tilt_zero: 20, pan_sign: -1, tilt_sign: -1 });
  near(got.pan, -80); near(got.tilt, -25);
});

test("focus refuses a coincident target, nonfinite geometry and an unreachable target", () => {
  assert.throws(() => solve(origin), /coincides/);
  assert.throws(() => solve({ x: NaN, y: 0, z: 0 }), /finite/);
  assert.throws(() => solve({ x: 0, y: 5, z: 0 }, { pan: 0, tilt: 0 }, calibration, rotation, { pan: [-5, 5], tilt: [-5, 5] }), /no legal/);
});

test("wall intersection catches a crossing and an origin inside a wall, but allows a target on its surface", () => {
  const wall = { name: "wall", min: { x: -1, y: 2, z: 0 }, max: { x: 1, y: 3, z: 6 } };
  assert.equal(segmentBoxHit(origin, { x: 0, y: 5, z: 0 }, wall), true);
  assert.equal(segmentBoxHit(origin, { x: 5, y: 5, z: 0 }, wall), false);
  assert.equal(segmentBoxHit(origin, { x: 0, y: 2, z: 3 }, wall), false);
  assert.equal(segmentBoxHit({ x: 0, y: 2.5, z: 5 }, { x: 0, y: 5, z: 0 }, wall), true);
});

async function setup(options: { silentPan?: boolean; ignoreTilt?: boolean; nested?: boolean; missingTilt?: boolean } = {}) {
  const h = await startHarness(registerFocusTools, { requestTimeoutMs: 35 });
  let selected = 1;
  const values: Record<string, number> = { Pan: 0, Tilt: 0 };
  h.fake.on("patch.state", () => ({ copyOpen: false }));
  h.fake.on("patch.list", () => ({ total: 1, fixtures: [{ fid: 1, name: "Mover", depth: options.nested ? 1 : 0 }] }));
  h.fake.on("objects", () => ({ total: 1, items: [{ class: "Fixture", addr: "1.1", fields: { FID: 1, POSX: 0, POSY: 0, POSZ: 5, ROTX: 0, ROTY: 0, ROTZ: 0, MESHMIRRORX: false } }] }));
  h.fake.on("fixtureAttributes", () => ({ fid: "1", subfixtureIndex: 1, subfixtureCount: 1, total: options.missingTilt ? 1 : 2, attributes: [{ attribute: "Pan", physicalFrom: -270, physicalTo: 270, physicalUnit: "Angle" }, ...options.missingTilt ? [] : [{ attribute: "Tilt", physicalFrom: -135, physicalTo: 135, physicalUnit: "Angle" }]] }));
  h.fake.on("fixtureOutput", () => ({ fid: "1", total: 2, channels: [{ attribute: "Pan", physical: 0 }, { attribute: "Tilt", physical: 0 }] }));
  h.fake.onCommand((cmd) => {
    const m = /^Attribute "(Pan|Tilt)" At Absolute Physical (-?[\d.]+)$/.exec(cmd);
    if (m && !(m[1] === "Tilt" && options.ignoreTilt)) values[m[1]] = Number(m[2]);
    if (m?.[1] === "Pan" && options.silentPan) return SILENT;
    if (/^Fixture /.test(cmd)) selected = Number(cmd.slice(8));
    return "OK";
  });
  h.fake.on("programmer", () => ({ total: 2, count: 2, coverage: { complete: true }, scannedFixtures: [{ fid: String(selected), name: "Mover", subfixtureIndex: selected, attributes: ["Pan", "Tilt"] }], rows: ["Pan", "Tilt"].map(a => ({ fid: String(selected), subfixtureIndex: selected, attribute: a, value: (values[a] + (a === "Pan" ? 270 : 135)) / (a === "Pan" ? 540 : 270) * 100, physicalFrom: a === "Pan" ? -270 : -135, physicalTo: a === "Pan" ? 270 : 135, stepCount: 1, readout: "Physical" })) }));
  return h;
}
const request = { target: { name: "Upstage centre", position: { x: 0, y: 5, z: 0 } }, fixtures: [{ fid: 1, calibration }] };

test("focus preview is the default, reads actual placement, and sends no programming commands", async () => {
  const h = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_focus_target", request);
    assert.equal(isError, false, JSON.stringify(result));
    assert.equal(result.preview, true); near(result.plan[0].tilt, 45);
    assert.equal(result.plan[0].referenceSource, "dmx_output");
    assert.deepEqual(h.fake.commands, []);
  } finally { await h.close(); }
});

test("focus apply selects explicitly, writes physical angles, then verifies both programmer values", async () => {
  const h = await setup();
  try {
    const { result, isError } = await h.callJson("gma3_focus_target", { ...request, preview: false, exclusive: true });
    assert.equal(isError, false, JSON.stringify(result));
    assert.equal(result.verification.status, "matched");
    assert.deepEqual(h.fake.commands, ["ClearSelection", "Fixture 1", 'Attribute "Pan" At Absolute Physical 0', 'Attribute "Tilt" At Absolute Physical 45']);
    assert.ok(h.fake.requests.some(r => r.op === "programmer"));
    assert.equal(h.fake.commands.includes("ClearAll"), false);
  } finally { await h.close(); }
});

test("focus refuses unavailable/missing axes or nested geometry before any programming", async () => {
  for (const options of [{ missingTilt: true }, { nested: true }]) {
    const h = await setup(options);
    try {
      const { isError } = await h.callJson("gma3_focus_target", { ...request, preview: false, exclusive: true });
      assert.equal(isError, true); assert.deepEqual(h.fake.commands, []);
    } finally { await h.close(); }
  }
});

test("focus blocks a wall crossing and refuses duplicate fixtures before programming", async () => {
  const h = await setup();
  try {
    const wall = { name: "Solid wall", min: { x: -1, y: 2, z: 0 }, max: { x: 1, y: 3, z: 6 } };
    assert.equal((await h.callJson("gma3_focus_target", { ...request, obstacles: [wall], preview: false, exclusive: true })).isError, true);
    assert.equal((await h.callJson("gma3_focus_target", { ...request, fixtures: [...request.fixtures, ...request.fixtures] })).isError, true);
    assert.deepEqual(h.fake.commands, []);
  } finally { await h.close(); }
});

test("focus does not replay an uncertain Pan write and stops before Tilt", async () => {
  const h = await setup({ silentPan: true });
  try {
    const { result, isError } = await h.callJson("gma3_focus_target", { ...request, preview: false, exclusive: true });
    assert.equal(isError, true); assert.ok(["unknown", "partial"].includes(result.outcome));
    assert.equal(h.fake.commands.filter(c => c.includes('"Pan"')).length, 1);
    assert.equal(h.fake.commands.some(c => c.includes('"Tilt"')), false);
  } finally { await h.close(); }
});

test("focus reports a silently ignored Tilt write as mismatched", async () => {
  const h = await setup({ ignoreTilt: true });
  try {
    const { result, isError } = await h.callJson("gma3_focus_target", { ...request, preview: false, exclusive: true });
    assert.equal(isError, true); assert.equal(result.verification.status, "mismatched");
  } finally { await h.close(); }
});


test("focus requires explicit reference angles when output is unavailable, and rejects out-of-range references", async () => {
  const h = await setup();
  try {
    h.fake.on("fixtureOutput", () => ({ fid: "1", total: 2, channels: [{ attribute: "Pan" }, { attribute: "Tilt" }] }));
    assert.equal((await h.callJson("gma3_focus_target", request)).isError, true);
    const referenced = { ...request, fixtures: [{ ...request.fixtures[0], reference: { pan: 0, tilt: 0 } }] };
    assert.equal((await h.callJson("gma3_focus_target", referenced)).isError, false);
    const bad = { ...request, fixtures: [{ ...request.fixtures[0], reference: { pan: 1000, tilt: 0 } }] };
    assert.equal((await h.callJson("gma3_focus_target", bad)).isError, true);
    assert.deepEqual(h.fake.commands, []);
  } finally { await h.close(); }
});

test("focus rejects a wrong output identity and reversed wall bounds", async () => {
  const h = await setup();
  try {
    h.fake.on("fixtureOutput", () => ({ fid: "99", total: 2, channels: [{ attribute: "Pan", physical: 0 }, { attribute: "Tilt", physical: 0 }] }));
    assert.equal((await h.callJson("gma3_focus_target", request)).isError, true);
    h.fake.requests.length = 0;
    assert.equal((await h.callJson("gma3_focus_target", { ...request, obstacles: [{ name: "bad", min: { x: 1, y: 0, z: 0 }, max: { x: 0, y: 1, z: 1 } }] })).isError, true);
    assert.equal(h.fake.requests.length, 0);
  } finally { await h.close(); }
});


test("focus solves back to independently reconstructed world rays with full XYZ rotations", () => {
  const forward = (pan: number, tilt: number, rotation: typeof origin, c: Calibration) => {
    const p = (pan - c.pan_zero) / c.pan_sign * Math.PI / 180;
    const t = (tilt - c.tilt_zero) / c.tilt_sign * Math.PI / 180;
    let x = -Math.sin(p) * Math.sin(t), y = Math.cos(p) * Math.sin(t), z = -Math.cos(t);
    for (const axis of ["x", "y", "z"] as const) {
      const a = rotation[axis] * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
      if (axis === "x") [y, z] = [cos * y - sin * z, sin * y + cos * z];
      if (axis === "y") [x, z] = [cos * x + sin * z, -sin * x + cos * z];
      if (axis === "z") [x, y] = [cos * x - sin * y, sin * x + cos * y];
    }
    return [x, y, z];
  };
  for (const r of [{ x: 30, y: 100, z: -40 }, { x: 180, y: 0, z: 87 }, { x: -72, y: -23, z: 14 }]) {
    for (const c of [calibration, { ...calibration, pan_zero: 21, tilt_zero: -10, pan_sign: -1 as const, tilt_sign: -1 as const }]) {
      const target = { x: 4, y: -8, z: 0 };
      const got = solve(target, { pan: 160, tilt: 25 }, c, r, { pan: [-720, 720], tilt: [-360, 360] });
      const ray = forward(got.pan, got.tilt, r, c);
      const length = Math.hypot(target.x - origin.x, target.y - origin.y, target.z - origin.z);
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(ray[i] - ([target.x - origin.x, target.y - origin.y, target.z - origin.z][i] / length)) < 1e-7);
    }
  }
});

test("focus preflights the complete fixture list before selecting the first fixture", async () => {
  const h = await setup();
  try {
    const { isError } = await h.callJson("gma3_focus_target", { ...request, fixtures: [...request.fixtures, { ...request.fixtures[0], fid: 2 }], preview: false, exclusive: true });
    assert.equal(isError, true); assert.deepEqual(h.fake.commands, []);
  } finally { await h.close(); }
});

test("focus verifies explicit fixture scope and rejects a wrong programmer identity", async () => {
  const h = await setup();
  try {
    const original = h.fake.handlerFor("programmer")!;
    h.fake.on("programmer", async (args, req) => {
      assert.equal(args.scope, "fixtures"); assert.equal(args.fixtures, "Fixture 1");
      const data = await original(args, req) as { rows: Array<Record<string, unknown>> };
      return { ...data, rows: data.rows.map(row => ({ ...row, fid: "99" })) };
    });
    const { result, isError } = await h.callJson("gma3_focus_target", { ...request, preview: false, exclusive: true });
    assert.equal(isError, true); assert.equal(result.verification.status, "mismatched");
  } finally { await h.close(); }
});

test("focus includes calibrated pan pivot, tilt pivot and rotating emitter displacement", async () => {
  const c: Calibration = { ...calibration, pan_pivot: { x: 0.4, y: 0.2, z: -0.1 }, tilt_pivot: { x: 0.08, y: 0.3, z: -0.2 }, emitter_offset: { x: 0.03, y: 0.04, z: -0.45 } };
  const p = 30 * Math.PI / 180, t = 40 * Math.PI / 180;
  // Independent forward construction: mount rotation is zero; rotate emitter about Tilt, then about Pan.
  const head = { x: 0.08 + 0.03, y: 0.3 + Math.cos(t) * 0.04 + Math.sin(t) * 0.45, z: -0.2 + Math.sin(t) * 0.04 - Math.cos(t) * 0.45 };
  const emitter = { x: 0.4 + Math.cos(p) * head.x - Math.sin(p) * head.y, y: 0.2 + Math.sin(p) * head.x + Math.cos(p) * head.y, z: 5 - 0.1 + head.z };
  const direction = { x: -Math.sin(p) * Math.sin(t), y: Math.cos(p) * Math.sin(t), z: -Math.cos(t) };
  const target = { x: emitter.x + 7 * direction.x, y: emitter.y + 7 * direction.y, z: emitter.z + 7 * direction.z };
  const got = solve(target, { pan: 30, tilt: 40 }, c);
  near(got.pan, 30); near(got.tilt, 40); near(got.distance, 7);
  for (const axis of ["x", "y", "z"] as const) near(got.emitterPosition[axis], emitter[axis]);
});

test("transition ray sampling catches a wall between clear start and final rays without claiming continuous clearance", async () => {
  const { sampleFocusTransition } = await import("../src/focus.ts");
  const wall = { name: "mid-sweep wall", min: { x: -0.2, y: 2.8, z: 1.5 }, max: { x: 0.2, y: 3.2, z: 2.5 } };
  const result = sampleFocusTransition(origin, rotation, calibration, { pan: -90, tilt: 45 }, { pan: 90, tilt: 45 }, [wall], { samples: 9, rayLength: 8, models: ["linear_joint_angles"] });
  assert.equal(result.checkedRays, 9);
  assert.ok(result.hits.some((h) => h.sample === 4 && h.obstacle === wall.name));
  assert.equal(result.continuousClearanceVerified, false);
  assert.throws(() => sampleFocusTransition(origin, rotation, calibration, { pan: 0, tilt: 0 }, { pan: 90, tilt: 45 }, [], { samples: 10000, rayLength: 8, models: ["linear_joint_angles"] }), /samples/);
});

test("focus preview exposes calibrated emitter geometry and sampled transition limits", async () => {
  const h = await setup();
  try {
    const r = await h.callJson("gma3_focus_target", { ...request, fixtures: [{ fid: 1, calibration: { ...calibration, pan_pivot: { x: 0.4, y: 0, z: 0 } }, reference: { pan: 0, tilt: 0 } }], transition: { samples: 5 } });
    assert.equal(r.isError, false, JSON.stringify(r.result));
    assert.equal(r.result.plan[0].emitterPosition.x, 0.4);
    assert.equal(r.result.plan[0].transition.checkedRays, 10);
    assert.equal(r.result.plan[0].transition.continuousClearanceVerified, false);
    assert.deepEqual(h.fake.commands, []);
  } finally { await h.close(); }
});

test("focus refuses a sampled transition crossing even when the final ray is clear", async () => {
  const h = await setup();
  try {
    h.fake.on("fixtureAttributes", () => ({ fid: "1", subfixtureIndex: 1, total: 2, attributes: [{ attribute: "Pan", physicalFrom: -270, physicalTo: 270, physicalUnit: "Angle" }, { attribute: "Tilt", physicalFrom: 0, physicalTo: 135, physicalUnit: "Angle" }] }));
    const r = await h.callJson("gma3_focus_target", { ...request, target: { name: "Left", position: { x: -5, y: 0, z: 0 } }, fixtures: [{ fid: 1, calibration, reference: { pan: -90, tilt: 45 } }], obstacles: [{ name: "mid-sweep wall", min: { x: -0.2, y: 2.8, z: 1.5 }, max: { x: 0.2, y: 3.2, z: 2.5 } }], transition: { samples: 9, ray_length: 8, models: ["linear_joint_angles"] }, preview: false, exclusive: true });
    assert.equal(r.isError, true, JSON.stringify(r.result));
    assert.match(JSON.stringify(r.result.steps), /sampled transition/);
    assert.deepEqual(h.fake.commands, []);
  } finally { await h.close(); }
});

test("offset focus reconstructs independent world rays across mount rotations and reversed axes", () => {
  const rot = (v: typeof origin, r: typeof rotation) => {
    let { x, y, z } = v;
    for (const axis of ["x", "y", "z"] as const) {
      const a = r[axis] * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      if (axis === "x") [y, z] = [c*y-s*z, s*y+c*z];
      if (axis === "y") [x, z] = [c*x+s*z, -s*x+c*z];
      if (axis === "z") [x, y] = [c*x-s*y, s*x+c*y];
    }
    return { x, y, z };
  };
  for (const mount of [{ x: 30, y: -70, z: 12 }, { x: -110, y: 8, z: 160 }]) for (const sign of [1, -1] as const) for (const pan of [-200, 30, 170]) for (const tilt of [-90, -30, 45, 100]) {
    const c: Calibration = { ...calibration, pan_zero: 10, tilt_zero: -20, pan_sign: sign, tilt_sign: sign, pan_pivot: { x: .4, y: -.2, z: .1 }, tilt_pivot: { x: .08, y: .3, z: -.2 }, emitter_offset: { x: .03, y: .04, z: -.45 } };
    const head = rot(c.emitter_offset!, { x: tilt, y: 0, z: 0 });
    const yoke = rot({ x: .08 + head.x, y: .3 + head.y, z: -.2 + head.z }, { x: 0, y: 0, z: pan });
    const relative = rot({ x: .4 + yoke.x, y: -.2 + yoke.y, z: .1 + yoke.z }, mount);
    const emitter = { x: relative.x, y: relative.y, z: 5 + relative.z };
    const direction = rot(rot({ x: 0, y: 0, z: -1 }, { x: tilt, y: 0, z: pan }), mount);
    const target = { x: emitter.x + 7 * direction.x, y: emitter.y + 7 * direction.y, z: emitter.z + 7 * direction.z };
    const reference = { pan: 10 + sign * pan, tilt: -20 + sign * tilt };
    const got = solve(target, reference, c, mount, { pan: [-720, 720], tilt: [-360, 360] });
    near(got.pan, reference.pan); near(got.tilt, reference.tilt); near(got.distance, 7);
    for (const axis of ["x", "y", "z"] as const) near(got.emitterPosition[axis], emitter[axis]);
  }
});
