import { z } from "zod";
import type { ToolContext } from "../tools/context.js";
import { inDataPool } from "../tools/datapool.js";
import { readFastContext, type FastContext } from "../fastpath.js";
import { timedBridge, resolveDataPool } from "../jobs/runtime.js";
import { patchSnapshot } from "../jobs/dependencies.js";
import type { RequestTiming } from "../jobs/engine.js";
import { fingerprint } from "../tracking/model.js";
import { consoleIdentityDifferences } from "../context-identity.js";
import { nativeContentFingerprint } from "../native-cues.js";
import { NATIVE_CONTENT_FINGERPRINT_VERSION } from "../native-fingerprint.js";

const slot = z.number().int().min(1).max(99999);
export const checkpointScopeSchema = z.object({
  sequences: z.array(slot).max(32).default([]),
  presets: z.array(z.object({ pool: z.number().int().min(1).max(9999), preset: slot }).strict()).max(64).default([]),
  views: z.array(slot).max(16).default([]), cameras: z.array(slot).max(32).default([]),
  data_pool: z.number().int().min(1).max(9999).optional(),
  include_patch: z.boolean().default(true), include_dmx_output: z.boolean().default(true),
}).strict();
export type CheckpointScope = z.infer<typeof checkpointScopeSchema>;
export interface Section { name: string; source: string; complete: boolean; hash: string; data: unknown; limitations: string[] }
export interface ShowCheckpoint {
  version: 1; id?: string; label?: string; capturedAt: string; scope: CheckpointScope; identity: FastContext["identity"]; contextKey: string;
  complete: boolean; fingerprint: string; sections: Section[]; timing: { ms: number; requests: RequestTiming[] }; limitations: string[];
}
const cameraFields = ["NAME", "POSX", "POSY", "POSZ", "PAN", "TILT", "ROLL", "FOV", "LOCK", "SYSTEMLOCKED", "STRUCTURELOCKED"];
function unique(scope: CheckpointScope) {
  for (const key of ["sequences", "views", "cameras"] as const) if (new Set(scope[key]).size !== scope[key].length) throw new Error(`duplicate ${key} checkpoint targets`);
  if (new Set(scope.presets.map((p) => `${p.pool}.${p.preset}`)).size !== scope.presets.length) throw new Error("duplicate preset checkpoint targets");
  if (!scope.sequences.length && !scope.presets.length && !scope.views.length && !scope.cameras.length && !scope.include_patch && !scope.include_dmx_output) throw new Error("checkpoint scope is empty");
}
export async function observeCheckpoint(ctx: ToolContext, input: unknown, label?: string): Promise<ShowCheckpoint> {
  const scope = checkpointScopeSchema.parse(input); unique(scope);
  const began = performance.now(), requests: RequestTiming[] = [], bridge = timedBridge(ctx.bridge, requests, ctx.requestTimeoutMs);
  const before = await readFastContext(bridge, ctx.requestTimeoutMs);
  if (!before.contextKey || before.identityUncertain?.length || before.environment !== "Normal") throw new Error("a complete stable console identity in Normal is required for a checkpoint");
  if ((scope.sequences.length || scope.presets.length) && scope.data_pool === undefined) scope.data_pool = await resolveDataPool(bridge, undefined, ctx.requestTimeoutMs);
  const scoped = inDataPool({ ...ctx, bridge }, scope), sections: Section[] = [];
  const section = async (name: string, source: string, read: () => Promise<{ data: unknown; complete: boolean; limitations?: string[] }>) => {
    try {
      const r = await read(), limitations = [...(r.limitations ?? [])];
      let complete = r.complete;
      try { nativeContentFingerprint(r.data); }
      catch (error) { complete = false; limitations.push(`Native encoded data is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
      // Stored hashes remain exact raw-record integrity checks, including for old records.
      sections.push({ name, source, data: r.data, complete, limitations, hash: fingerprint(r.data) });
    }
    catch (err) { const limitations = [err instanceof Error ? err.message : String(err)]; sections.push({ name, source, complete: false, data: null, hash: fingerprint(null), limitations }); }
  };
  for (const no of scope.sequences) await section(`sequence:${no}`, "native cue.content, all parts and encoded raw stored channel data", async () => {
    const data = await scoped.bridge.request<Record<string, unknown>>("cue.content", { ref: `Sequence ${no}` }, ctx.requestTimeoutMs);
    return { data, complete: data.complete === true && Array.isArray(data.cues), limitations: Array.isArray(data.limitations) ? data.limitations.map(String) : [] };
  });
  for (const preset of scope.presets) await section(`preset:${preset.pool}.${preset.preset}`, "native preset.read normalized values, steps, layers and references", async () => {
    const result = await scoped.bridge.request<Record<string, unknown>>("preset.read", { ref: `Preset ${preset.pool}.${preset.preset}` }, ctx.requestTimeoutMs);
    const { referencedBy: _, ...data } = result;
    return { data, complete: result.truncated === false && Array.isArray(result.rows) && result.dependenciesReadable === true && Array.isArray(result.dependencies), limitations: ["Normalized preset data is compared; dynamic reference counts are excluded."] };
  });
  for (const no of scope.views) await section(`view:${no}`, "native saved View content, not current-screen metadata", async () => {
    const data = await bridge.request<Record<string, unknown>>("view.content", { ref: `View ${no}` }, ctx.requestTimeoutMs);
    return { data, complete: data.complete === true, limitations: Array.isArray(data.limitations) ? data.limitations.map(String) : [] };
  });
  for (const no of scope.cameras) await section(`camera:${no}`, "saved current-profile camera pose/FOV/name/locks", async () => {
    const result = await bridge.request<{ items?: Array<{ fields?: Record<string, unknown>; class?: string }> }>("objects", { ref: `Camera ${no}`, fields: cameraFields, asText: false, limit: 2 }, ctx.requestTimeoutMs);
    const fields = result.items?.[0]?.fields ?? {};
    const missing = cameraFields.filter((p) => fields[p] === undefined || fields[p] === null);
    return { data: fields, complete: result.items?.length === 1 && result.items[0].class === "Camera" && !missing.length, limitations: [...missing.map((p) => `camera ${p} is unreadable`), "Saved pose fields only; rendering and current viewport selection are not compared."] };
  });
  if (scope.include_patch) await section("live_patch", "native patch.fingerprint for every enumerated live collection", async () => {
    const r = await patchSnapshot({ ...ctx, bridge });
    return { data: r.patch, complete: r.complete, limitations: [...r.limitations, "Native FNV fingerprints detect changes in the bounded persisted patch scope; derived UI/RT channels and documented volatile properties are excluded."] };
  });
  if (scope.include_dmx_output) await section("dmx_output_settings", "configured Art-Net/sACN entries, all universe settings and station routing", async () => {
    const r = await bridge.request<Record<string, any>>("dmx.output", { all: true }, ctx.requestTimeoutMs);
    const protocols = r.protocols ?? {}, universes = Array.isArray(r.universes) ? r.universes : [];
    const data = { protocols, universes: universes.map((u: Record<string, unknown>) => Object.fromEntries(["no", "name", "request", "portOut", "portIn", "portRdm", "mergeMode"].map((key) => [key, u[key]]))), stations: r.stations };
    const complete = ["artnet", "sacn"].every((p) => typeof protocols[p]?.out === "boolean" && typeof protocols[p]?.in === "boolean" && Array.isArray(protocols[p]?.entries)) && universes.length <= 1024 && universes.length === r.totals?.universes && universes.every((u: Record<string, unknown>) => ["no", "request", "portOut", "portIn", "portRdm", "mergeMode"].every((p) => u[p] !== undefined && u[p] !== null)) && Array.isArray(r.stations);
    return { data, complete, limitations: ["Configured routing only. Runtime hardware grants, fixture output values, parked/tester counts and packet delivery are excluded."] };
  });
  const after = await readFastContext(bridge, ctx.requestTimeoutMs);
  if (after.contextKey !== before.contextKey || after.identityUncertain?.length || after.environment !== "Normal") throw new Error("console context changed while the checkpoint was being captured; no checkpoint was published");
  return { version: 1, ...(label ? { label } : {}), capturedAt: new Date().toISOString(), scope, identity: before.identity, contextKey: before.contextKey, complete: sections.every((s) => s.complete), fingerprint: fingerprint(sections.map((s) => ({ name: s.name, hash: s.hash, complete: s.complete }))), sections, timing: { ms: performance.now() - began, requests }, limitations: ["Read-only capture; no show Save/Load, programmer, selection, output or screen mutation.", "Coverage completeness is scoped, not atomic exclusion from a console operator. Capture only while the show is stable."] };
}

export function compareCheckpoints(before: ShowCheckpoint, after: ShowCheckpoint, allowGenerationChange = false) {
  const contextDifferences = consoleIdentityDifferences(before.identity, after.identity, allowGenerationChange);
  const old = new Map(before.sections.map((s) => [s.name, s]));
  const sections = after.sections.map((section) => {
    const previous = old.get(section.name), limitations = [...section.limitations];
    let beforeComparisonHash: string | null = null, afterComparisonHash: string | null = null;
    try { if (previous) beforeComparisonHash = nativeContentFingerprint(previous.data); }
    catch (error) { limitations.push(`Saved native encoded data is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    try { afterComparisonHash = nativeContentFingerprint(section.data); }
    catch (error) { limitations.push(`Observed native encoded data is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    const complete = section.complete && previous?.complete === true && beforeComparisonHash !== null && afterComparisonHash !== null;
    return { name: section.name, complete, beforeHash: previous?.hash ?? null, afterHash: section.hash, beforeComparisonHash, afterComparisonHash,
      matched: complete && beforeComparisonHash === afterComparisonHash, limitations };
  });
  const complete = before.complete && after.complete && !contextDifferences.length && before.sections.length === after.sections.length && sections.every((section) => section.complete);
  return { baseline: before.id, comparisonFingerprintVersion: NATIVE_CONTENT_FINGERPRINT_VERSION, complete, matched: complete && sections.every((s) => s.matched), contextDifferences, generationChanged: before.identity.generation !== after.identity.generation, sections, scope: before.scope, observedAt: after.capturedAt, timing: after.timing };
}

export function validateCheckpoint(checkpoint: ShowCheckpoint, id: string): ShowCheckpoint {
  if (checkpoint.version !== 1 || checkpoint.id !== id || !Array.isArray(checkpoint.sections) || !checkpoint.identity) throw new Error("invalid checkpoint record");
  checkpointScopeSchema.parse(checkpoint.scope);
  for (const section of checkpoint.sections) {
    if (typeof section.name !== "string" || typeof section.complete !== "boolean" || fingerprint(section.data) !== section.hash) throw new Error("checkpoint section fingerprint integrity check failed");
  }
  if (fingerprint(checkpoint.sections.map((s) => ({ name: s.name, hash: s.hash, complete: s.complete }))) !== checkpoint.fingerprint) throw new Error("checkpoint fingerprint integrity check failed");
  return checkpoint;
}
