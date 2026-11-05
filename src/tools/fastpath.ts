import { z } from "zod";
import { FAST_BATCH_OPS, validateFastBatch } from "../fastpath.js";
import { json, type RegisterTools, type ToolContext } from "./context.js";
import type { ToolResult } from "../results.js";

const text = z.string().min(1).max(4096);
const attributeNames = z.array(z.string().min(1).max(128).regex(/^[^\x00-\x1f\x7f]+$/)).min(1).max(128);
const ttl = z.number().int().min(100).max(30000);
const step = z.object({
  name: z.string().max(128).optional(),
  op: z.enum(FAST_BATCH_OPS),
  args: z.record(z.string(), z.unknown()),
  expect: z.object({ path: z.string().max(256), value: z.unknown().refine((v) => v !== undefined && v !== null, "expect.value must be non-null") }).optional(),
});
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

export const registerFastpathTools: RegisterTools = (server, ctx: ToolContext) => {
  const request = async (op: string, args: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const result = await ctx.bridge.request<Record<string, unknown>>(op, args, ctx.requestTimeoutMs);
      const out = json(result);
      if (["failed", "unknown", "cancelled"].includes(String(result?.status))) out.isError = true;
      return out;
    } catch (err) {
      return fail(`${err instanceof Error ? err.message : String(err)}. Nothing was retried; a lost mutation reply needs inspection before any new write.`);
    }
  };
  server.registerTool("gma3_fast_context", {
    title: "Read bridge programming context",
    description: "Read the bridge start generation, show, hostname, user/profile and separate programmer environment. contextKey is available only when identity is verified, and changes after any observed identity drift. Preview mode changes leave the show contextKey stable. This is shared console state, not an operator lock.",
    inputSchema: {},
  }, async () => request("fast.context", {}));

  server.registerTool("gma3_writer_lease", {
    title: "Coordinate bridge writers",
    description: "Acquire/renew/release a connection-bound writer lease before programming. Other bridge connections retain reads but their mutations are refused while the lease is active. Acquire requires current gma3_fast_context context_key. TTL 100..30000ms; renew before expiry. Disconnect releases ownership. Operator and unrelated plugins are not excluded. Releasing after context drift is permitted; renewing after drift is refused.",
    inputSchema: { action: z.enum(["acquire", "renew", "release", "status"]), context_key: text.optional(), token: text.optional(), ttl_ms: ttl.optional() },
  }, async (args) => {
    if (args.action === "acquire" && !args.context_key) return fail("context_key is required to acquire a writer lease");
    if (["renew", "release"].includes(args.action) && !args.token) return fail("token is required to renew or release a writer lease");
    return request("fast.lease", { action: args.action, contextKey: args.context_key, token: args.token, ttlMs: args.ttl_ms });
  });

  server.registerTool("gma3_batch", {
    title: "Run bounded bridge steps",
    description: "Queue up to128 single commands/property writes/structured reads in one request; the bridge executes one step per frame globally, checks context and lease before every step, and stops on failure, uncertain command feedback, mismatched expectation or cancellation. Start returns a handle; poll status, or cancel at a safe step boundary. Commands have no semicolons, raw Lua, nested Cmd or Plugin calls. Mutating batches require lease_token. Include read steps with expect {path,value} for verification; accepted command feedback alone does not prove a correct look. Use explicit DataPool targets when needed. Other mutations from the same connection are refused until the batch finishes. No automatic retry, rollback or operator exclusion.",
    inputSchema: { action: z.enum(["start", "status", "cancel", "list"]), context_key: text.optional(), lease_token: text.optional(), id: text.optional(), steps: z.array(step).min(1).max(128).optional() },
  }, async (args) => {
    if (args.action === "start") {
      if (!args.context_key || !args.steps) return fail("start requires context_key and steps");
      const errors = validateFastBatch(args.steps);
      if (args.steps.some((s) => s.op === "cmd" || s.op === "set") && !args.lease_token) errors.push("lease_token is required for a mutating batch");
      if (errors.length) return fail(errors.join("; "));
      return ctx.mutations.run(() => request("fast.batch", { action: "start", contextKey: args.context_key, leaseToken: args.lease_token, steps: args.steps }));
    }
    if (args.action === "list") return request("fast.batch", { action: "list" });
    if (!args.id) return fail("status/cancel requires id");
    return request("fast.batch", { action: args.action, id: args.id });
  });

  server.registerTool("gma3_programmer_snapshot", {
    title: "Capture and page programmer values once",
    description: "Capture one bounded programmer scan and page its frozen rows without rescanning GetProgPhaser. Optional attribute filter skips irrelevant phaser reads. Snapshot and cursor belong to this connection, show/start/user/profile and programmer environment; expire within30s. Captured rows are historical observations (atomic:false), not freshly reread pages or effective output. Captures at most5000rows/4MiB; truncation or channel errors make coverage incomplete. Max4snapshots/connection,16total; release when finished.",
    inputSchema: { action: z.enum(["create", "page", "release"]), context_key: text.optional(), snapshot_id: text.optional(), cursor: text.optional(), scope: z.enum(["all", "selection", "fixtures"]).optional(), fixtures: z.string().min(1).max(4096).optional(), attributes: attributeNames.optional(), max_channels: z.number().int().min(1).max(50000).optional(), limit: z.number().int().min(1).max(5000).optional(), ttl_ms: ttl.optional() },
  }, async (args) => {
    if (args.action === "create" && args.scope === "fixtures" && !args.fixtures) return fail("fixtures is required for fixture scope");
    if (args.action !== "create" && !args.snapshot_id) return fail("snapshot_id is required for page/release");
    if (args.action === "page" && !args.cursor) return fail("cursor is required for page");
    return request("programmer.snapshot", { action: args.action, contextKey: args.context_key, snapshotId: args.snapshot_id, cursor: args.cursor, scope: args.scope, fixtures: args.fixtures, attributes: args.attributes, maxChannels: args.max_channels, limit: args.limit, ttlMs: args.ttl_ms });
  });
};
