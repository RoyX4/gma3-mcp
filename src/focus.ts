/** Calibrated optical model, independent of a fixture's decorative mesh or GDTF defaults. */
export interface Vec3 { x: number; y: number; z: number }
export interface Calibration {
  convention: "beam_down_tilt_positive_y";
  pan_zero: number;
  tilt_zero: number;
  pan_sign: 1 | -1;
  tilt_sign: 1 | -1;
  /** Mount-local displacement from patch origin to the Pan pivot, in metres. */
  pan_pivot?: Vec3;
  /** Pan-rotated displacement from Pan pivot to Tilt pivot, in metres. */
  tilt_pivot?: Vec3;
  /** Head-local displacement from Tilt pivot to optical emitter at zero Tilt, in metres. */
  emitter_offset?: Vec3;
}
export interface Angles { pan: number; tilt: number }
export interface Limits { pan: [number, number]; tilt: [number, number] }
export interface Obstacle { name: string; min: Vec3; max: Vec3 }
export interface FocusSolution extends Angles { distance: number; delta: Angles; candidates: number; emitterPosition: Vec3; rayDirection: Vec3 }
const EPS = 1e-9;
const radians = (degrees: number) => degrees * Math.PI / 180;
const degrees = (angle: number) => angle * 180 / Math.PI;
const rounded = (n: number) => Math.round(n * 1e6) / 1e6 || 0;

function finiteVector(v: Vec3): void {
  if (![v.x, v.y, v.z].every(Number.isFinite)) throw new Error("geometry must contain finite X/Y/Z values");
}

function inverseRotate(v: Vec3, rotation: Vec3): Vec3 {
  let { x, y, z } = v;
  // The live patch uses Rz * Ry * Rx. Invert in reverse application order.
  for (const axis of ["z", "y", "x"] as const) {
    const angle = -radians(rotation[axis]), c = Math.cos(angle), s = Math.sin(angle);
    if (axis === "z") [x, y] = [c * x - s * y, s * x + c * y];
    if (axis === "y") [x, z] = [c * x + s * z, -s * x + c * z];
    if (axis === "x") [y, z] = [c * y - s * z, s * y + c * z];
  }
  return { x, y, z };
}

function equivalents(base: number, range: [number, number]): number[] {
  const [lo, hi] = range;
  const out: number[] = [];
  for (let k = Math.ceil((lo - base - EPS) / 360); k <= Math.floor((hi - base + EPS) / 360); k++) out.push(base + k * 360);
  return out;
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const plus = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const minus = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
function rotate(v: Vec3, rotation: Vec3): Vec3 {
  let { x, y, z } = v;
  for (const axis of ["x", "y", "z"] as const) {
    const a = radians(rotation[axis]), c = Math.cos(a), s = Math.sin(a);
    if (axis === "x") [y, z] = [c * y - s * z, s * y + c * z];
    if (axis === "y") [x, z] = [c * x + s * z, -s * x + c * z];
    if (axis === "z") [x, y] = [c * x - s * y, s * x + c * y];
  }
  return { x, y, z };
}
function validateCalibration(c: Calibration): void {
  if (c.convention !== "beam_down_tilt_positive_y" || ![1, -1].includes(c.pan_sign) || ![1, -1].includes(c.tilt_sign)) throw new Error("unsupported optical calibration");
  if (![c.pan_zero, c.tilt_zero].every(Number.isFinite)) throw new Error("calibration angles must be finite");
  [c.pan_pivot ?? ZERO, c.tilt_pivot ?? ZERO, c.emitter_offset ?? ZERO].forEach(finiteVector);
}

/** Forward kinematics: patch mount -> Pan pivot -> Pan rotation -> Tilt pivot -> Tilt rotation -> emitter. */
export function focusRay(origin: Vec3, rotation: Vec3, c: Calibration, angles: Angles): { emitterPosition: Vec3; rayDirection: Vec3 } {
  [origin, rotation].forEach(finiteVector); validateCalibration(c);
  if (![angles.pan, angles.tilt].every(Number.isFinite)) throw new Error("ray angles must be finite");
  const pan = (angles.pan - c.pan_zero) / c.pan_sign, tilt = (angles.tilt - c.tilt_zero) / c.tilt_sign;
  const head = rotate(c.emitter_offset ?? ZERO, { x: tilt, y: 0, z: 0 });
  const yoke = rotate(plus(c.tilt_pivot ?? ZERO, head), { x: 0, y: 0, z: pan });
  const emitterPosition = plus(origin, rotate(plus(c.pan_pivot ?? ZERO, yoke), rotation));
  const direction = rotate(rotate({ x: 0, y: 0, z: -1 }, { x: tilt, y: 0, z: pan }), rotation);
  [emitterPosition, direction].forEach(finiteVector);
  return { emitterPosition, rayDirection: direction };
}

/** Two revolute axes with calibrated pivot/emitter offsets; all legal forward-facing branches are compared. */
export function solveFocus(origin: Vec3, rotation: Vec3, target: Vec3, c: Calibration, limits: Limits, reference: Angles): FocusSolution {
  [origin, rotation, target].forEach(finiteVector); validateCalibration(c);
  if (![reference.pan, reference.tilt].every(Number.isFinite)) throw new Error("reference angles must be finite");
  for (const [lo, hi] of [limits.pan, limits.tilt]) if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo || hi - lo > 2880) throw new Error("invalid or unsupported physical limits");
  const pivot = c.pan_pivot ?? ZERO, tiltPivot = c.tilt_pivot ?? ZERO, emitter = c.emitter_offset ?? ZERO;
  const world = minus(target, origin);
  if (!Number.isFinite(Math.hypot(world.x, world.y, world.z))) throw new Error("geometry displacement must be finite");
  if (Math.hypot(world.x, world.y, world.z) < EPS && [pivot, tiltPivot, emitter].every(v => Math.hypot(v.x, v.y, v.z) < EPS)) throw new Error("the focus target coincides with the fixture origin");
  const local = minus(inverseRotate(world, rotation), pivot);
  const horizontal = Math.hypot(local.x, local.y), lateral = tiltPivot.x + emitter.x;
  const clamp = (n: number) => Math.min(1, Math.max(-1, n));
  const panModels: number[] = [];
  if (horizontal < EPS) {
    if (Math.abs(lateral) <= EPS) panModels.push((reference.pan - c.pan_zero) / c.pan_sign);
  } else if (Math.abs(lateral) <= horizontal + EPS) {
    const bearing = Math.atan2(local.y, local.x), offset = Math.acos(clamp(lateral / horizontal));
    panModels.push(degrees(bearing - offset), degrees(bearing + offset));
  }
  const choices: Angles[] = [];
  for (const pan of panModels) {
    const p = radians(pan);
    const y = -Math.sin(p) * local.x + Math.cos(p) * local.y - tiltPivot.y, z = local.z - tiltPivot.z;
    const radius = Math.hypot(y, z), tiltModels: number[] = [];
    if (radius < EPS) {
      if (Math.abs(emitter.y) <= EPS) tiltModels.push((reference.tilt - c.tilt_zero) / c.tilt_sign);
    } else if (Math.abs(emitter.y) <= radius + EPS) {
      const bearing = Math.atan2(z, y), offset = Math.acos(clamp(emitter.y / radius));
      tiltModels.push(degrees(bearing + offset), degrees(bearing - offset));
    }
    for (const tilt of tiltModels) {
      const t = radians(tilt), forwardDistance = emitter.z - (-Math.sin(t) * y + Math.cos(t) * z);
      if (forwardDistance <= EPS) continue;
      const physicalPan = c.pan_zero + c.pan_sign * pan, physicalTilt = c.tilt_zero + c.tilt_sign * tilt;
      for (const pv of equivalents(physicalPan, limits.pan)) for (const tv of equivalents(physicalTilt, limits.tilt)) if (!choices.some(v => Math.abs(v.pan - pv) < EPS && Math.abs(v.tilt - tv) < EPS)) choices.push({ pan: pv, tilt: tv });
    }
  }
  if (!choices.length) throw new Error("the target has no legal Pan/Tilt solution within the calibrated geometry and physical limits");
  const distanceFrom = (v: Angles) => Math.hypot(v.pan - reference.pan, v.tilt - reference.tilt);
  choices.sort((a, b) => distanceFrom(a) - distanceFrom(b) || Math.abs(a.pan) - Math.abs(b.pan));
  const best = choices[0], ray = focusRay(origin, rotation, c, best);
  const displacement = minus(target, ray.emitterPosition), distance = Math.hypot(displacement.x, displacement.y, displacement.z);
  const miss = Math.hypot(displacement.x - distance * ray.rayDirection.x, displacement.y - distance * ray.rayDirection.y, displacement.z - distance * ray.rayDirection.z);
  if (!Number.isFinite(distance) || miss > Math.max(1e-7, distance * 1e-9)) throw new Error("calibrated focus solution did not reconstruct the target ray");
  return { pan: rounded(best.pan), tilt: rounded(best.tilt), distance, delta: { pan: rounded(best.pan - reference.pan), tilt: rounded(best.tilt - reference.tilt) }, candidates: choices.length, ...ray };
}

export type TransitionModel = "linear_joint_angles" | "pan_then_tilt";
export interface TransitionOptions { samples: number; rayLength: number; models: TransitionModel[] }
/** A bounded numerical observation of specified paths, never proof of continuous or physical clearance. */
export function sampleFocusTransition(origin: Vec3, rotation: Vec3, c: Calibration, from: Angles, to: Angles, obstacles: Obstacle[], options: TransitionOptions) {
  const { samples, rayLength, models } = options;
  if (!Number.isInteger(samples) || samples < 2 || samples > 256) throw new Error("transition samples must be an integer 2-256");
  if (!Number.isFinite(rayLength) || rayLength <= 0 || rayLength > 10000) throw new Error("transition ray length must be >0 and <=10000 metres");
  if (!models.length || models.length > 2 || new Set(models).size !== models.length || models.some(m => m !== "linear_joint_angles" && m !== "pan_then_tilt")) throw new Error("transition models must be distinct supported paths");
  if (obstacles.length > 64) throw new Error("at most 64 obstacles per transition");
  const hits: Array<{ model: TransitionModel; sample: number; fraction: number; obstacle: string; pan: number; tilt: number }> = [];
  let hitCount = 0;
  for (const model of models) for (let i = 0; i < samples; i++) {
    const u = i / (samples - 1);
    const angles = model === "linear_joint_angles" ? { pan: from.pan + (to.pan - from.pan) * u, tilt: from.tilt + (to.tilt - from.tilt) * u }
      : { pan: from.pan + (to.pan - from.pan) * Math.min(1, 2 * u), tilt: from.tilt + (to.tilt - from.tilt) * Math.max(0, 2 * u - 1) };
    const ray = focusRay(origin, rotation, c, angles);
    const tip = { x: ray.emitterPosition.x + ray.rayDirection.x * rayLength, y: ray.emitterPosition.y + ray.rayDirection.y * rayLength, z: ray.emitterPosition.z + ray.rayDirection.z * rayLength };
    for (const obstacle of obstacles) if (segmentBoxHit(ray.emitterPosition, tip, obstacle)) {
      hitCount++;
      if (hits.length < 32) hits.push({ model, sample: i, fraction: u, obstacle: obstacle.name, ...angles });
    }
  }
  return { models, samplesPerModel: samples, checkedRays: samples * models.length, rayLength, hitCount, hits, hitsTruncated: hitCount > hits.length,
    maxSampleStepDegrees: { pan: Math.abs(to.pan - from.pan) / (samples - 1) * (models.includes("pan_then_tilt") ? 2 : 1), tilt: Math.abs(to.tilt - from.tilt) / (samples - 1) * (models.includes("pan_then_tilt") ? 2 : 1) }, continuousClearanceVerified: false as const };
}

/** Static centre-ray against a stage-space axis-aligned box; contact only at the target is allowed. */
export function segmentBoxHit(origin: Vec3, target: Vec3, box: Obstacle): boolean {
  [origin, target, box.min, box.max].forEach(finiteVector);
  for (const axis of ["x", "y", "z"] as const) if (box.min[axis] > box.max[axis]) throw new Error(`obstacle ${box.name} has reversed bounds`);
  let enter = 0, exit = 1;
  for (const axis of ["x", "y", "z"] as const) {
    const delta = target[axis] - origin[axis];
    if (Math.abs(delta) < EPS) {
      if (origin[axis] < box.min[axis] || origin[axis] > box.max[axis]) return false;
      continue;
    }
    const a = (box.min[axis] - origin[axis]) / delta;
    const b = (box.max[axis] - origin[axis]) / delta;
    enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return false;
  }
  return Math.max(enter, EPS) <= Math.min(exit, 1 - EPS);
}
