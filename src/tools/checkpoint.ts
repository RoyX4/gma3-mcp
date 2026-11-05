import { z } from "zod";
import { dirname, join } from "node:path";
import { CheckpointStore } from "../checkpoints/store.js";
import { checkpointScopeSchema, observeCheckpoint, compareCheckpoints, validateCheckpoint, type ShowCheckpoint } from "../checkpoints/observer.js";
import { jobDirectory } from "../jobs/runtime.js";
import { json, type RegisterTools } from "./context.js";

const summary = (s: ShowCheckpoint, detail: boolean) => detail ? s : { ...s, sections: s.sections.map(({ data: _, ...section }) => section), timing: { ms: s.timing.ms, requests: s.timing.requests.length } };
export function createCheckpointTools(options: { directory?: string } = {}): RegisterTools {
  return (server, ctx) => {
    const store = new CheckpointStore(options.directory ?? join(dirname(jobDirectory()), "checkpoints"));
    server.registerTool("gma3_show_checkpoint", {
      title: "Capture and compare saved show-state checkpoints",
      description: "Read-only bounded capture of explicitly scoped sequences/presets/saved Views/camera poses plus optional live patch and DMX output settings. Publishes a new immutable private local checkpoint ID; no arbitrary paths, Save, Load, discard, overwrite, programmer, playback, selection or screen change. Compare after an operator-controlled save/reload; allow_generation_change explicitly permits a new bridge generation while host/show/user/profile must match. Exact stored raw hashes protect record integrity; versioned comparison losslessly canonicalizes encoded native JSON object/typed-table presentation order while preserving values, unknown fields and ordinary array order. Malformed, incomplete or unsupported sections never match. Saved View contents require view.content and fail closed if absent. Patch uses bounded native FNV change detection; DMX compares configured routing, not live grants/output. No automatic retry or restore.",
      inputSchema: { action: z.enum(["capture", "compare", "status", "list"]), id: z.string().max(64).optional(), scope: checkpointScopeSchema.optional(), label: z.string().min(1).max(200).optional(), allow_generation_change: z.boolean().optional(), detail: z.boolean().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() },
    }, async (args) => {
      try {
        if (args.action === "list") {
          const ids = (await store.ids()).sort(), offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 20), checkpoints = [];
          for (const id of ids.slice(offset, offset + limit)) { const s = validateCheckpoint(await store.read<ShowCheckpoint>(id), id); checkpoints.push({ id, label: s.label, capturedAt: s.capturedAt, complete: s.complete, fingerprint: s.fingerprint }); }
          return json({ checkpoints, total: ids.length, offset, limit });
        }
        if (args.action === "capture") {
          if (!args.scope) throw new Error("capture requires an explicit checkpoint scope");
          const checkpoint = await observeCheckpoint(ctx, args.scope, args.label ? String(args.label) : undefined);
          checkpoint.id = await store.create(checkpoint);
          const result = json(summary(checkpoint, args.detail === true)); if (!checkpoint.complete) result.isError = true; return result;
        }
        if (!args.id) throw new Error(`${args.action} requires a checkpoint ID`);
        const saved = validateCheckpoint(await store.read<ShowCheckpoint>(String(args.id)), String(args.id));
        if (args.action === "status") return json(summary(saved, args.detail === true));
        const observed = await observeCheckpoint(ctx, saved.scope), compared = compareCheckpoints(saved, observed, args.allow_generation_change === true);
        const result = json({ ...compared, ...(args.detail ? { observed } : {}) }); if (!compared.matched) result.isError = true; return result;
      } catch (err) { return { ...json({ error: err instanceof Error ? err.message : String(err) }), isError: true }; }
    });
  };
}
export const registerCheckpointTools: RegisterTools = createCheckpointTools();
