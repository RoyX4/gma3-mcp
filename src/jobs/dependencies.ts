import type { ToolContext } from "../tools/context.js";
import type { Compilation } from "../tracking/model.js";
import { fingerprint } from "../tracking/model.js";

/** Read dependencies only at batch boundaries; never multiply these whole-patch reads by cue/attribute count. */
export async function dependencySnapshot(ctx: ToolContext, compilation: Compilation) {
  const patchRead = await patchSnapshot(ctx);
  const limitations = [...patchRead.limitations], patch = patchRead.patch, presets: unknown[] = [];
  const names = patchRead.names;
  const pending: Array<{ ref: string; depth: number }> = [...new Set(compilation.plan.cues.flatMap((c) => c.changes.filter((x) => x.kind === "preset").map((x) => `Preset ${x.pool}.${x.preset}`)))].map((ref) => ({ ref, depth: 0 }));
  const seen = new Set<string>();
  while (pending.length) {
    const { ref, depth } = pending.shift()!;
    if (seen.has(ref)) continue;
    if (seen.size >= 64 || depth > 4) { limitations.push("preset dependency graph exceeds 64 presets or four embedded levels"); break; }
    seen.add(ref);
    const result = await ctx.bridge.request<Record<string, unknown>>("preset.read", { ref }, ctx.requestTimeoutMs);
    if (typeof result.addr === "string") seen.add(result.addr);
    if (result.truncated !== false || !Array.isArray(result.rows) || result.dependenciesReadable !== true || !Array.isArray(result.dependencies)) limitations.push(`${ref} native preset data/dependencies are incomplete`);
    const { referencedBy: _, ...definition } = result;
    presets.push({ ref, definition });
    for (const value of Array.isArray(result.dependencies) ? result.dependencies : []) {
      const dep = value as Record<string, unknown>;
      if (dep.valid !== true || typeof dep.addr !== "string") { limitations.push(`${ref} has an invalid or unmapped embedded preset dependency`); continue; }
      pending.push({ ref: dep.addr, depth: depth + 1 });
    }
  }
  return { complete: limitations.length === 0, fingerprint: fingerprint({ patch, presets }), scope: "all enumerated native live patch collections (recursive fixture types and attribute definitions), and declared preset references plus embedded dependencies", limitations, patchCollections: names.length, presetReads: presets.length };
}

export async function patchSnapshot(ctx: ToolContext) {
  const limitations: string[] = [], patch: unknown[] = [];
  const collections = await ctx.bridge.request<{ live?: unknown[] }>("patch.collections", {}, ctx.requestTimeoutMs);
  const names = Array.isArray(collections.live) ? collections.live.filter((n): n is string => typeof n === "string").sort() : [];
  if (!names.length || names.length > 64 || names.length !== new Set(names).size || ["Stages", "FixtureTypes", "AttributeDefinitions"].some((n) => !names.includes(n))) limitations.push("complete native live patch collection inventory is unavailable");
  for (const collection of names.slice(0, 64)) {
    const result = await ctx.bridge.request<Record<string, unknown>>("patch.fingerprint", { side: "live", collection }, ctx.requestTimeoutMs);
    if (result.complete !== true || result.hash === undefined || typeof result.objects !== "number") limitations.push(`patch ${collection} fingerprint is incomplete`);
    // ms is observation timing, not patch content. Native FNV is best-effort change detection, not cryptographic data attestation.
    patch.push({ collection, hash: result.hash, objects: result.objects, complete: result.complete });
  }
  return { names, patch, limitations, complete: limitations.length === 0 };
}
