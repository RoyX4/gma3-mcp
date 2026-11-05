import { homedir, hostname } from "node:os";
import { readlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Gma3Bridge } from "../bridge.js";
import { readFastContext } from "../fastpath.js";
import { HeldLock } from "../mutations.js";
import { fingerprint, type Compilation } from "../tracking/model.js";
import { exists } from "../tools/common.js";
import { inDataPool } from "../tools/datapool.js";
import { storeCues } from "../tools/cuelists.js";
import type { ToolContext } from "../tools/context.js";
import type { JobExecutor, RequestTiming, Observation, LiveProgress, RouteIdentity } from "./engine.js";
import { JobEngine } from "./engine.js";
import { dependencySnapshot } from "./dependencies.js";
import { verifyNativeOwnedState } from "../native-cue-verification.js";
import type { Verification } from "../results.js";
import { observeRebind } from "./rebind.js";
import { nativeContentFingerprint } from "../native-cues.js";
import { NATIVE_CONTENT_FINGERPRINT_VERSION } from "../native-fingerprint.js";
import { readNativeCueContent, requireNativeCuePaging } from "../native-cue-reader.js";

const engines = new WeakMap<ToolContext, JobEngine>();
// Older bridges cap a complete scan at 500 native objects, including internal cues.
const LEGACY_CUE_OBJECT_LIMIT = 500;
const INTERNAL_CUE_ALLOWANCE = 2;
function routeIdentity():RouteIdentity {
  const route:RouteIdentity={};
  if(process.platform==="linux") {
    try {route.networkNamespace=readlinkSync("/proc/self/ns/net");route.bootId=readFileSync("/proc/sys/kernel/random/boot_id","utf8").trim();}
    catch { /* Missing route evidence blocks explicit rebind; ordinary strict-generation jobs remain usable. */ }
  }
  if(process.env.GMA3_INSTANCE_PROFILE_DIGEST) route.instanceProfileDigest=process.env.GMA3_INSTANCE_PROFILE_DIGEST;
  return route;
}
export function jobDirectory(): string { return process.env.GMA3_JOB_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "gma3-mcp", "jobs"); }
export function engineFor(ctx: ToolContext): JobEngine {
  let engine = engines.get(ctx);
  if (!engine) { engine = new JobEngine(jobDirectory(), consoleExecutor(ctx)); engines.set(ctx, engine); }
  return engine;
}

/** Exact native sequence data is mandatory. Metadata-only hashes never stand in for hard cue values. */
export async function observeSequence(ctx: ToolContext, compilation: Compilation, expectedCues = 0): Promise<Observation> {
  const requests: RequestTiming[] = [], timed = timedBridge(ctx.bridge, requests, ctx.requestTimeoutMs);
  const requiresPaging = compilation.cues.length + INTERNAL_CUE_ALLOWANCE > LEGACY_CUE_OBJECT_LIMIT;
  if (requiresPaging) await requireNativeCuePaging(timed, compilation.cues.length + INTERNAL_CUE_ALLOWANCE, ctx.requestTimeoutMs);
  const route=routeIdentity();
  const before = await readFastContext(timed, ctx.requestTimeoutMs);
  if (!before.contextKey || before.identityUncertain?.length) throw new Error("console identity is incomplete; generation, show, host, user and profile are required");
  const dataPool = await resolveDataPool(timed, compilation.plan.data_pool, ctx.requestTimeoutMs);
  const scoped = inDataPool({ ...ctx, bridge: timed }, { data_pool: dataPool }), ref = `Sequence ${compilation.plan.sequence}`;
  const existence = await exists(scoped.bridge, ref);
  if (existence.exists === "unknown") throw new Error(`sequence existence is unknown: ${existence.error}`);
  let content: unknown = { exists: false }, complete = true, existingCueCount = 0;
  if (existence.exists) {
    const result = await readNativeCueContent(scoped.bridge, ref, ctx.requestTimeoutMs, {
      requirePaging: requiresPaging,
      context: { contextKey: before.contextKey, environment: before.environment },
    });
    complete = result.complete === true;
    content = result;
    existingCueCount = Array.isArray(result.cues) ? result.cues.filter((c: any) => Number(c.no) > 0).length : 0;
    if (!Array.isArray(result.cues)) complete = false;
  }
  let semanticVerification: Verification | undefined;
  if (expectedCues > 0) {
    semanticVerification = verifyNativeOwnedState(compilation, content);
    const numbers = new Set(((content as { cues?: Array<{ no?: number }> }).cues ?? []).map((c) => Number(c.no)));
    const missing = compilation.cues.slice(0, expectedCues).filter((c) => !numbers.has(Math.round(Number(c.cue) * 1000)));
    if (missing.length) semanticVerification = { status: "mismatched", checked: "every checkpointed owned cue exists in native stored content", detail: `native cue(s) ${missing.map((c) => c.cue).join(", ")} are missing` };
  }
  const dependencies = await dependencySnapshot(scoped, compilation);
  const after = await readFastContext(timed, ctx.requestTimeoutMs);
  if (after.contextKey !== before.contextKey || after.identityUncertain?.length || after.environment !== before.environment) throw new Error("console context changed during the native sequence checkpoint; nothing further was sent");
  if(fingerprint(route)!==fingerprint(routeIdentity())) throw new Error("instance/network route changed during the native sequence checkpoint");
  return { contextKey: before.contextKey, identity: before.identity, endpoint: ctx.bridge.description, workHost: hostname(), route, dataPool, environment: before.environment ?? "unknown", contentFingerprintVersion: NATIVE_CONTENT_FINGERPRINT_VERSION, contentFingerprint: nativeContentFingerprint({ dataPool, content, dependencies: dependencies.fingerprint }), legacyContentFingerprint: fingerprint({ dataPool, content, dependencies: dependencies.fingerprint }), dependencyFingerprint: dependencies.fingerprint, ...(semanticVerification ? { semanticVerification } : {}), complete: complete && dependencies.complete, detail: { existingCueCount, source: existence.exists ? "native cue.content with full raw native data" : "confirmed absent sequence", dependencies }, requests };
}

export async function resolveDataPool(bridge: Gma3Bridge, explicit: number | undefined, timeoutMs: number): Promise<number> {
  if (explicit !== undefined) return explicit;
  const current = await bridge.request<{ class?: string; index?: number; addr?: string; parent?: {class?: string; addr?: string} }>("object", { ref: "DataPool", properties: false }, timeoutMs);
  const nativePool = current.class === "Pool" && current.parent?.class === "DataPools"
    && typeof current.parent.addr === "string" && current.addr === `${current.parent.addr}.${current.index}`;
  if ((current.class !== "DataPool" && !nativePool) || !Number.isInteger(current.index) || current.index! < 1 || current.index! > 9999) throw new Error("current DataPool identity is unreadable; supply an explicit data_pool");
  return current.index!;
}

export function consoleExecutor(ctx: ToolContext): JobExecutor {
  return {
    observe: (compilation, expectedCues) => observeSequence(ctx, compilation, expectedCues),
    observeRebind: (compilation, expectedCues) => ctx.mutations.run(()=>observeRebind(ctx,compilation,expectedCues)),
    execute: (payload, expectedContext, progress) => ctx.mutations.run(async () => {
      const start = performance.now(), requests: RequestTiming[] = [];
      const raw = timedBridge(ctx.bridge, requests, ctx.requestTimeoutMs, progress);
      const identity = await readFastContext(raw, ctx.requestTimeoutMs);
      if (identity.contextKey !== expectedContext || identity.environment !== "Normal" || identity.identityUncertain?.length) throw new Error("context drift before batch acquisition; no programming was sent");
      const lease = await raw.request<{ token?: string }>("fast.lease", { action: "acquire", contextKey: expectedContext, ttlMs: 30000 }, ctx.requestTimeoutMs);
      if (!lease.token) throw new Error("bridge did not issue a writer lease; no programming was sent");
      let renewed = performance.now();
      const leased = Object.create(raw) as Gma3Bridge;
      leased.request = async function <T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
        if (performance.now() - renewed > 10000) {
          await raw.request("fast.lease", { action: "renew", token: lease.token, ttlMs: 30000 }, ctx.requestTimeoutMs);
          renewed = performance.now();
        }
        return raw.request<T>(op, args, timeoutMs);
      };
      let result: Awaited<ReturnType<typeof storeCues>> | undefined;
      try {
        result = await storeCues(inDataPool({ ...ctx, bridge: leased, mutations: new HeldLock() }, payload), payload as unknown as Record<string, unknown>);
      } finally {
        try { await raw.request("fast.lease", { action: "release", token: lease.token }, ctx.requestTimeoutMs); }
        catch (err) {
          if (result) (result.warnings ??= []).push(`Writer lease release failed: ${err instanceof Error ? err.message : String(err)}. It expires or is released on disconnect.`);
          else throw err;
        }
      }
      return { result, timing: { toolMs: performance.now() - start, requests } };
    }),
  };
}

/** Preserve every actual bridge request, including scoped reads and independent verification reads. */
export function timedBridge(base: Gma3Bridge, requests: RequestTiming[], defaultTimeout: number, progress?: (progress: LiveProgress) => void): Gma3Bridge {
  const bridge = Object.create(base) as Gma3Bridge;
  bridge.request = async function <T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const began = performance.now(), kind = op === "cmd" || op === "set" ? "mutation" : op === "fast.lease" ? "coordination" : "read";
    const phase = requestPhase(op, args);
    progress?.({ phase, op, completedRequests: requests.length, requestState: "running" });
    let status: RequestTiming["status"] = "succeeded";
    try { return await base.request<T>(op, args, timeoutMs ?? defaultTimeout); }
    catch (err) { status = "failed"; throw err; }
    finally {
      const ms = performance.now() - began;
      requests.push({ op, kind, status, ms, phase });
      progress?.({ phase, op, completedRequests: requests.length, requestState: status, lastRequestMs: ms });
    }
  };
  return bridge;
}
function requestPhase(op: string, args: Record<string, unknown>): string {
  if (op === "fast.context" || op === "fast.lease") return "context_and_lease";
  if (op === "cue.content") return "native_checkpoint";
  if (op === "patch.collections" || op === "patch.fingerprint" || op === "preset.read") return "dependency_checkpoint";
  if (op === "programmer" || op === "programmer.snapshot") return "programmer_verification";
  if (op === "set") return "metadata";
  if (op !== "cmd") return "preflight_and_readback";
  const command = String(args.command ?? "");
  if (/^Preview Off$/i.test(command)) return "preview_cleanup";
  if (/^Preview On$/i.test(command)) return "preview_entry";
  if (/^Store\b.*\bCue\b/i.test(command)) return "store";
  return "build_look";
}
