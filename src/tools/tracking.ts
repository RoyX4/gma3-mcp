import { z } from "zod";
import { compileTracking, compareCues, explainCue, serializePlan, trackingPlanSchema, type Compilation } from "../tracking/model.js";
import { engineFor } from "../jobs/runtime.js";
import { json, type RegisterTools, type ToolContext } from "./context.js";

async function compilation(ctx: ToolContext, args: Record<string, unknown>): Promise<Compilation> {
  if (Boolean(args.plan) === Boolean(args.job_id)) throw new Error("give exactly one of plan or job_id");
  return args.plan ? compileTracking(args.plan) : (await engineFor(ctx).status(String(args.job_id))).compilation;
}
const source = { plan: trackingPlanSchema.optional(), job_id: z.string().max(64).optional() };
const safe = async (fn: () => Promise<unknown>) => {
  try { return json(await fn()); } catch (err) { return { ...json({ error: err instanceof Error ? err.message : String(err) }), isError: true }; }
};
export const registerTrackingTools: RegisterTools = (server, ctx) => {
  server.registerTool("gma3_compile_tracking", {
    title: "Compile desired cues into tracking deltas",
    description: "Offline compiler for a complete owned cue chain with explicit fixture IDs: inheritance, explicit zero Dimmer/off, release, separate absolute/relative layers, covered preset references, carried/restarted phasers, static blocks, holds and cue-only restoration. Returns provenance and stable state fingerprints plus the exact gma3_store_cues payload and blocking lint. Compilation performs no console work. Omitted attributes inherit. A release relinquishes sequence control and is never converted to zero. Native arbitrary cue data and live output are separate evidence.",
    inputSchema: { plan: trackingPlanSchema, detail: z.boolean().optional(), include_serialized: z.boolean().optional() },
  }, (args) => safe(async () => {
    const r = compileTracking(args.plan);
    return { ...r, ...(args.detail === true ? {} : { cues: r.cues.map(({ state: _, delta: __, ...c }) => ({ ...c, stateCells: r.cues.find((x) => x.cue === c.cue)!.state.length, emittedCells: r.cues.find((x) => x.cue === c.cue)!.delta.length })), plan: undefined }), ...(args.include_serialized ? { serializedPlan: serializePlan(r.plan) } : {}) };
  }));
  server.registerTool("gma3_explain_tracking_cue", {
    title: "Explain a compiler-owned cue and its inherited values",
    description: "Shows each owned fixture/attribute/layer state, the cue and change that introduced it, whether it inherits and whether this cue emits a delta. Reads desired plan or durable job intent; does not claim arbitrary native stored cue or output reconstruction. A manual edit invalidates native job checkpoints; desired provenance is not rewritten from guesses.",
    inputSchema: { ...source, cue: z.union([z.string(), z.number()]), fixture: z.string().optional(), attribute: z.string().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(2000).optional() },
  }, (args) => safe(async () => {
    const r = explainCue(await compilation(ctx, args), String(args.cue));
    const cells = r.cells.filter((c) => (!args.fixture || c.fixture === args.fixture) && (!args.attribute || c.attribute.toLowerCase() === String(args.attribute).toLowerCase()));
    const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 200);
    return { ...r, cells: cells.slice(offset, offset + limit), total: cells.length, offset, limit };
  }));
  server.registerTool("gma3_compare_tracking_cues", {
    title: "Compare two compiler-owned effective cue states",
    description: "Offline comparison of effective owned fixture/attribute/layer states, retaining zero, release, presets, phasers and relative values. Equal states can have different timing or provenance; only state differences are reported. Native existing cue reconstruction is handled separately.",
    inputSchema: { ...source, from: z.union([z.string(), z.number()]), to: z.union([z.string(), z.number()]), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(2000).optional() },
  }, (args) => safe(async () => {
    const r = compareCues(await compilation(ctx, args), String(args.from), String(args.to)), offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 200);
    return { ...r, changes: r.changes.slice(offset, offset + limit), total: r.changes.length, offset, limit };
  }));
  server.registerTool("gma3_lint_tracking", {
    title: "Lint an owned tracking cue plan before programming",
    description: "Offline checks for unsupported release/layer behavior, phase-sensitive blocks, look limits and declared preset coverage, plus estimated assignments removed through tracking. No console connection or mutation.",
    inputSchema: { plan: trackingPlanSchema },
  }, (args) => safe(async () => { const r = compileTracking(args.plan); return { executable: r.executable, planFingerprint: r.planFingerprint, lint: r.lint, statistics: r.statistics, limitations: r.limitations }; }));
};
