import { z } from "zod";
import { nativeContentFingerprint, reconstructNativeCues } from "../native-cues.js";
import { json, type RegisterTools } from "./context.js";

export const registerNativeCueTools: RegisterTools = (server, ctx) => {
  server.registerTool("gma3_native_cue_data", {
    title: "Read actual stored cue channels",
    description: "READ ONLY: read a sequence's actual hard cue-part channels through GetPresetData, including absolute/relative steps, preset links, native flags and raw content fingerprints. Conservatively reconstruct sequence-owned tracked layers with source cue/part. Numeric part tracking-distance endpoints and cue Release are reconstructed; unknown distance formats or incomplete data prevent a complete claim. Break/Shield future edit protection and Assert playback arbitration are outside this stored-layer scope. Final output arbitration, live fades and physical light are outside this read. Does not select, Go, load or change cues.",
    inputSchema: { sequence: z.number().int().min(1).max(99999), data_pool: z.number().int().min(1).max(99999).optional(), include_raw: z.boolean().default(false) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async args => {
    try {
      const ref = `${args.data_pool === undefined ? "" : `DataPool ${args.data_pool} `}Sequence ${args.sequence}`;
      const before = await ctx.bridge.request<Record<string, unknown>>("fast.context", {}, ctx.requestTimeoutMs);
      const native = await ctx.bridge.request<Record<string, unknown>>("cue.content", { ref }, ctx.requestTimeoutMs);
      const after = await ctx.bridge.request<Record<string, unknown>>("fast.context", {}, ctx.requestTimeoutMs);
      const certain = (value: Record<string, unknown>) => Array.isArray(value.identityUncertain) && value.identityUncertain.length === 0;
      const contextMatched = typeof before.contextKey === "string" && before.contextKey === after.contextKey && certain(before) && certain(after)
        && ["Normal", "Preview"].includes(String(before.environment)) && before.environment === after.environment;
      if (!contextMatched) native.complete = false;
      const reconstruction = reconstructNativeCues(native);
      return json({ target: { sequence: args.sequence, dataPool: args.data_pool ?? null }, nativeComplete: native.complete === true, contextMatched, fingerprint: nativeContentFingerprint(native), reconstruction,
        ...(args.include_raw ? { native } : {}), notes: ["Stored cue data is not final fixture output. Native state can change between reads; this is a checked observation, not an atomic console transaction."] });
    } catch (err) {
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  });
};
