import { z } from "zod";
import { solveFocus, segmentBoxHit, sampleFocusTransition, type Vec3, type Calibration, type Angles, type Limits } from "../focus.js";
import { asRead, buildResult, commandStep, notRequested, stepFromError, unavailable, validationFailure, type StepResult, type Verification } from "../results.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { listFids } from "./patch.js";
import { attributeCommand, verifyProgrammer } from "./fixtures.js";

const vector = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict();
const angles = z.object({ pan: z.number().finite().min(-1440).max(1440), tilt: z.number().finite().min(-1440).max(1440) }).strict();
const label = z.string().trim().min(1).max(128).refine(s => !/[\u0000-\u001f]/.test(s), "control characters are not allowed");
const calibration = z.object({
  convention: z.literal("beam_down_tilt_positive_y"),
  pan_zero: z.number().finite().min(-720).max(720), tilt_zero: z.number().finite().min(-720).max(720),
  pan_sign: z.union([z.literal(1), z.literal(-1)]), tilt_sign: z.union([z.literal(1), z.literal(-1)]),
  pan_pivot: vector.optional().describe("Mount-local metres from patch origin to Pan pivot."),
  tilt_pivot: vector.optional().describe("Pan-rotated metres from Pan pivot to Tilt pivot."),
  emitter_offset: vector.optional().describe("Head-local metres from Tilt pivot to emitter at zero Tilt."),
}).strict();
const shape = {
  target: z.object({ name: label, position: vector }).strict().describe("Named stage target in metres: +X stage left, +Y upstage, +Z up."),
  fixtures: z.array(z.object({ fid: z.number().int().min(1).max(99999999), calibration, reference: angles.optional() }).strict()).min(1).max(64)
    .describe("Explicit calibration for every mover. reference is the physical Pan/Tilt from which to choose the nearest equivalent angles; otherwise readable DMX output is used."),
  obstacles: z.array(z.object({ name: label, min: vector, max: vector }).strict()).max(64).optional().describe("Axis-aligned solid wall boxes in the same stage coordinates. A centre-ray crossing refuses the whole request."),
  transition: z.object({ samples: z.number().int().min(2).max(256).optional(), ray_length: z.number().finite().positive().max(10000).optional(), models: z.array(z.enum(["linear_joint_angles", "pan_then_tilt"])).min(1).max(2).optional() }).strict().optional().describe("Opt-in sampled centre-ray checks from reference angles to the planned angles; no continuous or physical-clearance proof."),
  preview: z.boolean().optional().describe("Default true: read, solve and report without selecting or changing values."),
  exclusive: z.boolean().optional().describe("Required true to apply. The process lock cannot exclude another client/operator."),
};
type Args = { target: { name: string; position: Vec3 }; fixtures: Array<{ fid: number; calibration: Calibration; reference?: Angles }>; obstacles?: Array<{ name: string; min: Vec3; max: Vec3 }>; transition?: { samples?: number; ray_length?: number; models?: Array<"linear_joint_angles" | "pan_then_tilt"> }; preview?: boolean; exclusive?: boolean };
interface Plan extends Angles { fid: number; subfixtureIndex: number; position: Vec3; rotation: Vec3; reference: Angles; referenceSource: string; limits: Limits; distance: number; delta: Angles; candidates: number; emitterPosition: Vec3; rayDirection: Vec3; transition?: ReturnType<typeof sampleFocusTransition> }
const LIMITATIONS = [
  "The supplied optical calibration must be established for this fixture and mounting. GDTF/mesh geometry does not establish optical zero or axis signs. Optional calibrated pan_pivot, tilt_pivot and emitter_offset values define the two-axis kinematic chain; omitted offsets are zero.",
  "Geometry checks cover the final centre-ray and, when requested, bounded samples of specified angle interpolation models against supplied boxes. They do not establish beam-width, continuous sweep, photometry, native shadows, moving-body or physical safety clearance.",
  "Angles are verified in the programmer, not as physical beam position. Nearest means the smallest Euclidean angle change from the sampled/supplied reference, not a guaranteed shortest or obstacle-free movement. This server's mutation lock does not exclude another client or operator.",
];
const number = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} is not a readable finite number`);
  return value;
};

async function makePlan(ctx: ToolContext, args: Args, steps: StepResult[]): Promise<Plan[]> {
  const t = ctx.requestTimeoutMs;
  const state = await ctx.bridge.request<{ copyOpen?: boolean }>("patch.state", {}, t);
  steps.push(asRead({ name: "check_patch", status: "succeeded", op: "patch.state", detail: state }));
  if (state.copyOpen !== false) throw new Error("patch copy is open or its state is unreadable; focus refused");
  const fids = await listFids(ctx.bridge, args.fixtures.map(f => f.fid), t);
  steps.push(asRead({ name: "read_patch", status: "succeeded", op: "patch.list", detail: { fids: [...fids.keys()] } }));
  const plans: Plan[] = [];
  for (const input of args.fixtures) {
    const ref = `Fixture ${input.fid}`, row = fids.get(input.fid);
    if (!row || row.depth !== 0) throw new Error(`${ref} is missing or nested; only top-level fixture geometry is supported`);
    const object = await ctx.bridge.request<{ total?: number; items?: Array<{ class?: string; fields?: Record<string, unknown> }> }>("objects", { ref, fields: ["FID", "POSX", "POSY", "POSZ", "ROTX", "ROTY", "ROTZ", "MESHMIRRORX"], asText: false, limit: 2 }, t);
    steps.push(asRead({ name: `read_geometry_${input.fid}`, status: "succeeded", op: "objects", detail: object }));
    const item = object.items?.[0], f = item?.fields;
    if (object.total !== 1 || item?.class !== "Fixture" || !f || Number(f.FID) !== input.fid) throw new Error(`${ref} geometry did not resolve to the requested fixture`);
    if (![false, 0, "0", "No", ""].includes(f.MESHMIRRORX as never)) throw new Error(`${ref} has mirrored or unreadable mesh state; this calibration path does not support it`);
    const position = { x: number(f.POSX, `${ref}.POSX`), y: number(f.POSY, `${ref}.POSY`), z: number(f.POSZ, `${ref}.POSZ`) };
    const rotation = { x: number(f.ROTX, `${ref}.ROTX`), y: number(f.ROTY, `${ref}.ROTY`), z: number(f.ROTZ, `${ref}.ROTZ`) };
    const attr = await ctx.bridge.request<{ total?: number; fid?: string; subfixtureIndex?: number; attributes?: Array<{ attribute?: string; physicalFrom?: number; physicalTo?: number; physicalUnit?: string }> }>("fixtureAttributes", { ref, limit: 500, offset: 0 }, t);
    steps.push(asRead({ name: `read_attributes_${input.fid}`, status: "succeeded", op: "fixtureAttributes", detail: attr }));
    if (!Array.isArray(attr.attributes) || attr.total !== attr.attributes.length || String(attr.fid) !== String(input.fid)) throw new Error(`${ref} attribute coverage or identity is incomplete`);
    const subfixtureIndex = number(attr.subfixtureIndex, `${ref} patch index`);
    if (!Number.isInteger(subfixtureIndex) || subfixtureIndex < 0) throw new Error(`${ref} patch index is invalid`);
    const limits = {} as Limits;
    for (const axis of ["pan", "tilt"] as const) {
      const rows = attr.attributes.filter(a => a.attribute?.toLowerCase() === axis);
      if (rows.length !== 1 || rows[0].physicalUnit !== "Angle") throw new Error(`${ref} must have exactly one ${axis} channel with known Angle units`);
      const from = number(rows[0].physicalFrom, `${axis}.physicalFrom`), to = number(rows[0].physicalTo, `${axis}.physicalTo`);
      limits[axis] = [Math.min(from, to), Math.max(from, to)];
    }
    let reference = input.reference, referenceSource = "explicit";
    if (!reference) {
      const output = await ctx.bridge.request<{ fid?: string; total?: number; channels?: Array<{ attribute?: string; physical?: number }> }>("fixtureOutput", { ref, nonzeroOnly: false, limit: 2000, offset: 0 }, t);
      steps.push(asRead({ name: `read_reference_${input.fid}`, status: "succeeded", op: "fixtureOutput", detail: output }));
      if (!Array.isArray(output.channels) || output.total !== output.channels.length || String(output.fid) !== String(input.fid)) throw new Error(`${ref} output coverage or identity is incomplete; supply a measured reference`);
      const get = (axis: string) => {
        const rows = output.channels!.filter(a => a.attribute === axis);
        if (rows.length !== 1) throw new Error(`${ref} ${axis} output is ambiguous; supply a measured reference`);
        return number(rows[0].physical, `${ref} ${axis} output (or supply a measured reference)`);
      };
      reference = { pan: get("Pan"), tilt: get("Tilt") }; referenceSource = "dmx_output";
    }
    for (const axis of ["pan", "tilt"] as const) if (reference[axis] < limits[axis][0] || reference[axis] > limits[axis][1]) throw new Error(`${ref} reference ${axis} is outside its physical range`);
    const solution = solveFocus(position, rotation, args.target.position, input.calibration, limits, reference);
    for (const obstacle of args.obstacles ?? []) if (segmentBoxHit(solution.emitterPosition, args.target.position, obstacle)) throw new Error(`${ref} centre-ray crosses obstacle ${obstacle.name}`);
    let transition: ReturnType<typeof sampleFocusTransition> | undefined;
    if (args.transition) {
      transition = sampleFocusTransition(position, rotation, input.calibration, reference, solution, args.obstacles ?? [], { samples: args.transition.samples ?? 33, rayLength: args.transition.ray_length ?? solution.distance, models: args.transition.models ?? ["linear_joint_angles", "pan_then_tilt"] });
      steps.push(asRead({ name: `sample_transition_${input.fid}`, status: transition.hitCount ? "failed" : "succeeded", detail: transition, ...(transition.hitCount ? { error: `${ref} sampled transition ray crosses ${transition.hits.map(h => h.obstacle).filter((n, i, a) => a.indexOf(n) === i).join(", ")}` } : {}) }));
      if (transition.hitCount) throw new Error(`${ref} sampled transition intersects a supplied obstacle; no programming command sent`);
    }
    plans.push({ ...(transition ? { transition } : {}), fid: input.fid, subfixtureIndex, position, rotation, reference, referenceSource, limits, ...solution });
  }
  return plans;
}

async function focusTarget(ctx: ToolContext, args: Args) {
  const op = "focus_target", target = { name: args.target.name, position: args.target.position, fids: args.fixtures.map(f => f.fid) };
  const preview = args.preview !== false;
  const errors: string[] = [];
  if (new Set(target.fids).size !== target.fids.length) errors.push("fixtures must not contain duplicate FIDs");
  if (!preview && args.exclusive !== true) errors.push("exclusive must be true to apply focus values");
  for (const obstacle of args.obstacles ?? []) for (const axis of ["x", "y", "z"] as const) if (obstacle.min[axis] > obstacle.max[axis]) errors.push(`obstacle ${obstacle.name} has reversed ${axis} bounds`);
  if (errors.length) return validationFailure(op, target, errors);
  const run = async () => {
    const steps: StepResult[] = [], results: Array<{ fid: number; verification: Verification }> = [];
    const warnings = [...LIMITATIONS];
    let plans: Plan[];
    try { plans = await makePlan(ctx, args, steps); }
    catch (err) {
      steps.push(asRead({ ...stepFromError("preflight", err), status: "failed" }));
      return buildResult({ operation: op, target, steps, verification: unavailable("focus preflight failed; no programming command sent"), warnings, extra: { preview } });
    }
    if (preview) return buildResult({ operation: op, target, steps, verification: notRequested(), warnings, extra: { preview, plan: plans }, summary: "Focus preview only; no selection or programmer values changed." });
    let failed = false;
    for (const p of plans) {
      if (failed) { steps.push({ name: `focus_${p.fid}`, status: "skipped", error: "an earlier fixture failed or had an uncertain outcome" }); continue; }
      const commands = ["ClearSelection", `Fixture ${p.fid}`, attributeCommand("Pan", p.pan, "Physical"), attributeCommand("Tilt", p.tilt, "Physical")];
      for (let i = 0; i < commands.length; i++) {
        const step = await commandStep(ctx.bridge, `focus_${p.fid}_${["clear_selection", "select", "pan", "tilt"][i]}`, commands[i], ctx.requestTimeoutMs);
        steps.push(step);
        if (step.status !== "succeeded") { failed = true; break; }
      }
      if (failed) continue;
      const verified = await verifyProgrammer(ctx.bridge, [{ attribute: "Pan", value: p.pan, unit: "physical" }, { attribute: "Tilt", value: p.tilt, unit: "physical" }], steps, warnings, `Fixture ${p.fid}`);
      const observed = verified.verification.actual as { rows?: Array<{ attribute?: string; fid?: string; subfixtureIndex?: number }> } | undefined;
      if (verified.verification.status === "matched" && !["Pan", "Tilt"].every(axis => observed?.rows?.some(row => row.attribute === axis && String(row.fid) === String(p.fid) && row.subfixtureIndex === p.subfixtureIndex))) {
        verified.verification = { status: "mismatched", checked: `programmer identity of Fixture ${p.fid}`, detail: "the readback did not establish both axes on the original fixture identity", actual: observed };
      }
      results.push({ fid: p.fid, verification: verified.verification });
      if (verified.verification.status !== "matched") {
        failed = true;
        steps.push(asRead({ name: `verify_focus_${p.fid}`, status: "failed", op: "programmer", error: verified.verification.detail ?? `focus verification ${verified.verification.status}` }));
      }
    }
    const mismatch = results.find(r => r.verification.status === "mismatched");
    const verification: Verification = mismatch?.verification ?? (results.length === plans.length && results.every(r => r.verification.status === "matched") ? { status: "matched", checked: "Pan/Tilt programmer values for every requested fixture, using the existing setter range tolerance" } : unavailable("not every requested fixture was applied and verified; inspect steps before continuing"));
    return buildResult({ operation: op, target, steps, verification, warnings, extra: { preview, plan: plans, fixtures: results, selectionChangeAttempted: steps.some(s => s.command === "ClearSelection"), programmerChangeAttempted: steps.some(s => /^Attribute /.test(s.command ?? "")) } });
  };
  return preview ? run() : ctx.mutations.run(run);
}

export const registerFocusTools: RegisterTools = (server, ctx) => {
  server.registerTool("gma3_focus_target", {
    title: "Focus calibrated movers on a named stage target",
    description: "Solve physical Pan/Tilt from live top-level fixture position/rotation and an explicitly calibrated optical model. Preview is the default and sends no commands. Apply requires preview:false and exclusive:true, preflights every fixture, then ClearSelection, Fixture N, and Pan/Tilt At Absolute Physical per fixture; the selection changes, existing programmer values stay. Reads both programmer values back using the existing setter tolerance. Uses an explicit reference or readable DMX angles to choose the nearest equivalent branch. Refuses nested/mirrored geometry, missing axes, incomplete metadata and static centre-ray crossings of supplied wall boxes. Calibrated pivot/emitter offsets are supported; optional transition samples check two explicit interpolation models and report their sampling bounds. No physical beam position or continuous movement clearance is verified. Mutations are serialized within this server only; nothing is retried.",
    inputSchema: shape,
  }, args => operation(() => focusTarget(ctx, args)));
};
