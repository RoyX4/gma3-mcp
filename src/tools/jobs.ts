import { z } from "zod";
import { JobEngine, type Job, type JobExecutor } from "../jobs/engine.js";
import { consoleExecutor, engineFor } from "../jobs/runtime.js";
import { compileTracking, trackingPlanSchema } from "../tracking/model.js";
import { json, type RegisterTools } from "./context.js";

export function summarizeJob(job: Job, detail = false): unknown {
  if (detail) return job;
  return { id: job.id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt, progress: job.progress, cancelRequested: job.cancelRequested,
    ...(job.error ? { error: job.error } : {}), ...(job.inFlight ? { inFlight: job.inFlight } : {}), boundDataPool: job.boundDataPool, checkpoint: job.checkpoint ? { contextKey: job.checkpoint.contextKey, contentFingerprint: job.checkpoint.contentFingerprint, complete: job.checkpoint.complete, storedSemanticVerification: job.checkpoint.semanticVerification } : null,
    rebindings:job.rebindings??[],
    planFingerprint: job.compilation.planFingerprint, estimates: { ...job.compilation.statistics, batchSize: job.options.batchSize, totalBatches: Math.ceil(job.progress.totalCues / job.options.batchSize), remainingCues: job.progress.totalCues - job.progress.verifiedCues, note: "Work counts are estimates; no unmeasured wall-clock completion time is promised." },
    timing: job.timing, receipts: job.receipts.map((r) => ({ index: r.index, cues: r.cues, verified: r.verified, nativeVerification: r.nativeVerification, startedAt: r.startedAt, completedAt: r.completedAt, outcome: r.result.outcome, verification: r.result.verification, summary: r.result.summary, toolMs: r.timing.toolMs, requests: r.timing.requests.length })),
    safePoint: "Cancellation is cooperative between complete verified cue batches; the active batch is allowed to clean up Preview first. Unknown or interrupted mutations are never replayed.",
  };
}
export function createJobTools(options: { directory?: string; executor?: JobExecutor } = {}): RegisterTools {
  return (server, ctx) => {
    const engine = options.directory ? new JobEngine(options.directory, options.executor ?? consoleExecutor(ctx)) : engineFor(ctx);
    server.registerTool("gma3_programming_job", {
      title: "Prepare and run durable cue programming jobs",
      description: "Prepare a tracking-owned cue plan offline, then run:true with exclusive:true starts server-side work and returns promptly. Poll status for verified receipts, timing and durable checkpoints. Cancel stops between batches after Preview cleanup. Resume strictly pins console/show/user/profile/generation. Explicit rebind (exclusive:true, no run:true) only reads the console and updates the local journal after a new generation on the same work host/endpoint/station/show/user/profile has complete identical native content/dependencies and idle ownership/Normal proof; it never starts work or replays uncertain/failed mutations. Legacy identity-free checkpoints cannot rebind. Existing populated sequences are refused for new plans. Invalidate after manual edits. Journals are private local JSON (GMA3_JOB_DIR overrides directory).",
      inputSchema: {
        action: z.enum(["prepare", "run", "resume", "rebind", "status", "list", "cancel", "invalidate"]),
        id: z.string().max(64).optional(), plan: trackingPlanSchema.optional(), run: z.boolean().optional(), exclusive: z.boolean().optional(),
        batch_size: z.number().int().min(1).max(100).optional().describe("Cues per verified Preview batch; default 12. Lower gives quicker cancellation checkpoints, higher amortizes preflight scans."),
        max_batches_per_run: z.number().int().min(1).max(10000).optional(), expected_context_key: z.string().max(4096).optional(),
        reason: z.string().min(1).max(1024).optional(), detail: z.boolean().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional(),
      },
    }, async (args) => {
      try {
        const action = String(args.action);
        if (action === "list") return json({ jobs: await engine.list(Number(args.offset ?? 0), Number(args.limit ?? 20)), offset: args.offset ?? 0, limit: args.limit ?? 20 });
        if (action === "prepare") {
          if (!args.plan) throw new Error("prepare requires a complete desired tracking plan");
          if (args.run === true) throw new Error("prepare is offline; use the returned job id with action run, run:true and exclusive:true");
          const job = await engine.create(compileTracking(args.plan), { batchSize: Number(args.batch_size ?? 12), ...(args.max_batches_per_run ? { maxBatchesPerRun: Number(args.max_batches_per_run) } : {}), ...(args.expected_context_key ? { expectedContext: String(args.expected_context_key) } : {}) });
          return json(summarizeJob(job, args.detail === true));
        }
        if (!args.id) throw new Error(`${action} requires a job id`);
        const id = String(args.id);
        if ((action === "run" || action === "resume") && args.run === true && args.exclusive !== true) throw new Error("exclusive:true is required before running: nobody else may program this console during the job; a bridge lease does not lock out the operator");
        if(action==="rebind" && (args.run===true || args.exclusive!==true)) throw new Error("rebind requires exclusive:true and forbids run:true; it only reads the console and journals proof, never resumes work");
        const job = action === "cancel" ? await engine.cancel(id)
          : action === "invalidate" ? await engine.invalidate(id, args.reason ? String(args.reason) : "operator reports manual changes")
          : action === "rebind" ? await engine.rebind(id,args.reason?String(args.reason):undefined)
          : action === "run" || action === "resume" ? await engine.start(id, args.run === true, action === "resume") : await engine.status(id);
        const result = json(summarizeJob(job, args.detail === true));
        if (["failed", "uncertain", "blocked"].includes(job.status)) result.isError = true;
        return result;
      } catch (err) { return { ...json({ error: err instanceof Error ? err.message : String(err) }), isError: true }; }
    });
  };
}
export const registerJobTools: RegisterTools = createJobTools();
