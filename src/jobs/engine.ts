import { randomUUID } from "node:crypto";
import type { OperationResult, Verification } from "../results.js";
import { compileTracking, fingerprint, type Compilation, type StoreCue } from "../tracking/model.js";
import { Journal } from "./journal.js";
import type { FastContext } from "../fastpath.js";
import { consoleIdentityDifferences } from "../context-identity.js";
import { NATIVE_CONTENT_FINGERPRINT_VERSION } from "../native-fingerprint.js";

export interface RouteIdentity { networkNamespace?: string; bootId?: string; instanceProfileDigest?: string }
export interface Observation { contextKey: string; identity?: FastContext["identity"]; endpoint?: string; workHost?: string; route?: RouteIdentity; environment: string; contentFingerprintVersion?: typeof NATIVE_CONTENT_FINGERPRINT_VERSION; contentFingerprint: string; legacyContentFingerprint?: string; dependencyFingerprint?: string; dataPool?: number; semanticVerification?: Verification; complete: boolean; detail?: unknown; requests?: RequestTiming[]; rebindSafety?: { normalReadable: boolean; noOwnedWork: boolean; detail?: unknown } }
export interface RequestTiming { op: string; kind: "read" | "mutation" | "coordination"; ms: number; status: "succeeded" | "failed"; phase?: string }
export interface LiveProgress { phase: string; op: string; completedRequests: number; requestState: "running" | "succeeded" | "failed"; lastRequestMs?: number }
export interface ExecutionTiming { toolMs: number; requests: RequestTiming[] }
export interface JobExecutor {
  observe(compilation: Compilation, expectedCues?: number): Promise<Observation>;
  /** Only native reads and local coordination: no command, programmer change, lease acquisition or replay. */
  observeRebind?(compilation: Compilation, expectedCues: number): Promise<Observation>;
  execute(payload: Compilation["store"], expectedContext: string, progress?: (progress: LiveProgress) => void): Promise<{ result: OperationResult; timing: ExecutionTiming }>;
}
export interface JobOptions { batchSize: number; maxBatchesPerRun?: number; expectedContext?: string }
export interface Receipt { index: number; cues: string[]; startedAt: string; completedAt: string; result: OperationResult; timing: ExecutionTiming; verified: boolean; nativeVerification?: Verification }
export interface RebindReceipt {
  at: string; reason: string; before: { contextKey: string; identity: FastContext["identity"]; endpoint: string; workHost: string; route: RouteIdentity };
  after: { contextKey: string; identity: FastContext["identity"]; endpoint: string; workHost: string; route: RouteIdentity };
  contentFingerprintVersion: typeof NATIVE_CONTENT_FINGERPRINT_VERSION; contentFingerprint: string; dependencyFingerprint: string; dataPool: number; complete: true; consoleReadOnly: true; resumed: false;
  safety: NonNullable<Observation["rebindSafety"]>; requests: RequestTiming[];
}
export interface Job {
  version: 1; id: string; createdAt: string; updatedAt: string;
  status: "prepared" | "running" | "completed" | "cancelled" | "paused" | "blocked" | "failed" | "uncertain";
  compilation: Compilation; options: JobOptions; receipts: Receipt[];
  progress: { verifiedCues: number; totalCues: number; batches: number; nextCue: string | null };
  checkpoint?: Observation; contextKey?: string; boundDataPool?: number; inFlight?: { index: number; cues: string[]; payloadFingerprint: string; progress?: LiveProgress };
  cancelRequested: boolean; error?: string;
  rebindings?: RebindReceipt[];
  timing: { totalMs: number; observeMs: number; executeMs: number; requests: number; readRequests: number; mutationRequests: number; coordinationRequests: number; byOp: Record<string, { count: number; ms: number; failures: number }>; byPhase: Record<string, { count: number; ms: number }> };
}
const iso = () => new Date().toISOString();
const clone = <T>(v: T): T => structuredClone(v);

/** Server-side work survives the caller's request timeout. Only verified batches become resumable checkpoints. */
export class JobEngine {
  private journal: Journal;
  private active = new Map<string, { job: Job; promise: Promise<void> }>();
  private volatileFailures = new Map<string, Job>();
  constructor(directory: string, private executor: JobExecutor) { this.journal = new Journal(directory); }
  async create(compilation: Compilation, options: JobOptions): Promise<Job> {
    if (!compilation.executable) throw new Error("tracking plan has blocking lint; fix it before preparing a job");
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100) throw new Error("batchSize must be 1..100");
    if (options.maxBatchesPerRun !== undefined && (!Number.isInteger(options.maxBatchesPerRun) || options.maxBatchesPerRun < 1 || options.maxBatchesPerRun > 10000)) throw new Error("maxBatchesPerRun must be 1..10000");
    const job: Job = {
      version: 1, id: randomUUID(), createdAt: iso(), updatedAt: iso(), status: "prepared", compilation: clone(compilation), options: clone(options), receipts: [], cancelRequested: false,
      progress: { verifiedCues: 0, totalCues: compilation.cues.length, batches: 0, nextCue: compilation.cues[0].cue },
      timing: { totalMs: 0, observeMs: 0, executeMs: 0, requests: 0, readRequests: 0, mutationRequests: 0, coordinationRequests: 0, byOp: {}, byPhase: {} },
    };
    await this.save(job); return clone(job);
  }
  private async read(id: string): Promise<Job> {
    if (this.active.has(id)) return this.active.get(id)!.job;
    if (this.volatileFailures.has(id)) return this.volatileFailures.get(id)!;
    const job = await this.journal.read<Job>(id);
    if (job.version !== 1 || job.id !== id || !job.compilation || !Array.isArray(job.receipts)) throw new Error("invalid job journal schema");
    const fresh = compileTracking(job.compilation.plan);
    if (fresh.planFingerprint !== job.compilation.planFingerprint || fingerprint(fresh.store) !== fingerprint(job.compilation.store)) throw new Error("job plan fingerprint integrity check failed; nothing was sent");
    if ((job.status === "running" || job.inFlight) && !(await this.journal.hasLiveClaim(id))) {
      job.status = "uncertain"; job.error = "server stopped with an in-flight batch; inspect native cue content and receipts. It will never be replayed automatically.";
      await this.save(job);
    }
    return job;
  }
  async status(id: string): Promise<Job> {
    let job = await this.read(id);
    const active = this.active.get(id);
    // Native work can finish before the final journal fsync and claim release.
    // Keep terminal status private until that entire owned lifetime settles.
    if (active && job.status !== "running") {
      await active.promise;
      job = await this.read(id);
    }
    // Another process can read a terminal journal while its worker still owns
    // the final cleanup. Resumable/successful states stay running until release.
    if (["completed", "paused", "cancelled"].includes(job.status) && await this.journal.hasLiveClaim(id)) return { ...clone(job), status: "running" };
    return clone(job);
  }
  async list(offset = 0, limit = 20): Promise<Array<Pick<Job, "id" | "status" | "progress" | "updatedAt" | "error">>> {
    const ids = await this.journal.ids(), out = [];
    for (const id of ids.sort().slice(offset, offset + limit)) {
      const j = await this.status(id); out.push({ id, status: j.status, progress: j.progress, updatedAt: j.updatedAt, ...(j.error ? { error: j.error } : {}) });
    }
    return out;
  }
  async start(id: string, run: boolean, resume = false): Promise<Job> {
    const job = await this.read(id);
    if (!run || this.active.has(id) || job.status === "completed") return this.status(id);
    if (this.volatileFailures.has(id)) throw new Error("journal persistence failed during this run; inspect native content and the retained process-memory receipts before any further programming");
    if (job.checkpoint?.complete === false) throw new Error("invalidated or incomplete checkpoint cannot resume; prepare a new reviewed plan");
    if (job.status === "running") throw new Error("job is running in another server process; use status or cancel there");
    if (job.status === "uncertain" || job.inFlight) throw new Error("uncertain batch cannot resume: inspect native content; never replay an uncertain mutation");
    if (job.status !== "prepared" && !resume) throw new Error("use action resume with run:true to continue an interrupted job");
    if (job.status === "failed") throw new Error("a failed batch may contain uncheckpointed mutations; prepare a new reviewed plan after inspection");
    if(await this.journal.hasRebindGate()) throw new Error("a read-only rebind recovery owns this journal directory; wait before starting work");
    const release = await this.journal.claim(id);
    try {
      if(await this.journal.hasRebindGate()) throw new Error("rebind recovery began before the writer claim; no programming was sent");
      const latest = await this.journal.read<Job>(id);
      if (latest.updatedAt !== job.updatedAt || latest.status !== job.status) throw new Error("job changed before its writer claim was acquired; read status before retrying");
      await this.journal.cancellation(id, false);
      job.status = "running"; job.cancelRequested = false; delete job.error;
      await this.save(job);
    } catch (err) { await release(); throw err; }
    // Install active state before the first await inside drive can be observed by another tool call.
    const entry = { job, promise: Promise.resolve() };
    this.active.set(id, entry);
    entry.promise = this.drive(job).catch(async (err: unknown) => {
      job.status = job.inFlight ? "uncertain" : "blocked";
      job.error = err instanceof Error ? err.message : String(err);
      await this.save(job);
    }).finally(async () => {
      try { await release(); }
      catch (err) { job.status = "uncertain"; job.error = `writer claim could not be released: ${err instanceof Error ? err.message : String(err)}`; await this.save(job); }
    }).catch((err: unknown) => {
      // Disk failure can prevent every subsequent journal write. Keep the receipt inspectable in this process,
      // stop the run, and resolve the background promise rather than crashing the MCP server unobserved.
      job.status = job.inFlight || job.receipts.length ? "uncertain" : "blocked";
      job.error = `journal persistence failed; process-memory receipts only: ${err instanceof Error ? err.message : String(err)}`;
      this.volatileFailures.set(id, job);
    }).finally(() => { this.active.delete(id); });
    return clone(job);
  }
  async wait(id: string): Promise<void> { await this.active.get(id)?.promise; }
  /** Explicitly adopt a new plugin generation only after unchanged complete native content is proved. */
  async rebind(id: string, reason = "operator explicitly requests recovery after a verified reload"): Promise<Job> {
    if(typeof reason!=="string" || !reason.trim() || reason.length>1024) throw new Error("rebind reason must contain 1..1024 characters");
    if (this.active.size || this.volatileFailures.size) throw new Error("owned or unpersisted work is active; rebind requires an idle engine");
    const job = await this.read(id);
    if (!["paused", "cancelled", "blocked"].includes(job.status) || job.inFlight) throw new Error("only a safe paused/cancelled/blocked checkpoint can rebind; uncertain, failed or in-flight work is never adopted");
    const before = job.checkpoint;
    if (before?.complete !== true || before.environment !== "Normal" || !before.identity || !before.contextKey || before.contextKey !== job.contextKey || !before.contentFingerprint || !before.dependencyFingerprint || typeof before.endpoint!=="string" || !before.endpoint || typeof before.workHost!=="string" || !before.workHost || typeof before.identity.generation!=="string" || !before.identity.generation || before.semanticVerification?.status === "mismatched") throw new Error("rebind requires a complete checkpoint with saved structured identity, work host, endpoint and dependencies; legacy or invalidated checkpoints cannot be adopted");
    if (before.contentFingerprintVersion !== NATIVE_CONTENT_FINGERPRINT_VERSION) throw new Error("legacy or unknown content fingerprint version cannot rebind across generations; no complete canonical baseline is available. Only same-generation resume with an exact full raw hash may migrate a legacy checkpoint");
    if (!Number.isInteger(before.dataPool) || before.dataPool!<1 || before.dataPool!>9999 || before.dataPool !== job.boundDataPool) throw new Error("checkpoint data pool is unavailable or differs from the bound pool");
    if (!validRoute(before.route)) throw new Error("checkpoint has no qualified network namespace/boot or instance-profile route identity; rebind refused");
    if (job.rebindings!==undefined && !Array.isArray(job.rebindings)) throw new Error("invalid rebind receipt journal");
    if ((job.rebindings?.length ?? 0) >= 64) throw new Error("job has reached its bounded rebind receipt limit");
    const checkpointed = job.compilation.store.cues.slice(0, job.progress.verifiedCues);
    if (job.receipts.length !== job.progress.batches || fingerprint(job.receipts.flatMap(r => r.cues)) !== fingerprint(checkpointed.map(c => c.cue)) || job.receipts.some(r => !r.verified || r.result.outcome !== "succeeded" || r.result.normalProgrammer !== "untouched" || r.nativeVerification?.status === "mismatched" || r.result.steps.some(s => s.kind !== "read" && s.status === "unknown")) || checkpointed.some(c => !job.receipts.some(r => receiptVerified(r.result, c)))) throw new Error("unverified or unknown mutation receipts cannot rebind");
    if (!this.executor.observeRebind) throw new Error("this executor cannot provide read-only recovery safety proof");
    if ((await this.journal.claimIds()).length) throw new Error("another owned writer claim exists; claims are never stolen for rebind");
    const original = fingerprint(job), release = await this.journal.claim(id);
    let releaseGate:(()=>Promise<void>)|undefined;
    try {
      releaseGate=await this.journal.claimRebindGate();
      if ((await this.journal.claimIds()).some(other => other !== id)) throw new Error("another owned writer claim appeared; no recovery was adopted");
      const cancelledBefore=await this.journal.cancellation(id);
      const observation = await this.executor.observeRebind(job.compilation, job.progress.verifiedCues);
      if (observation.complete !== true || observation.environment !== "Normal" || !observation.contextKey || typeof observation.identity?.generation!=="string" || !observation.identity.generation || observation.rebindSafety?.normalReadable !== true || observation.rebindSafety.noOwnedWork !== true || observation.semanticVerification?.status === "mismatched") throw new Error("complete native content, readable Normal and no owned console work are required for rebind");
      if (consoleIdentityDifferences(before.identity, observation.identity, true).length || before.endpoint !== observation.endpoint || before.workHost !== observation.workHost) throw new Error("work host, console endpoint, station, show, user or profile changed; rebind refused");
      if (!validRoute(observation.route) || fingerprint(before.route)!==fingerprint(observation.route)) throw new Error("network namespace, boot or instance-profile route changed/unavailable; rebind refused");
      if (before.identity.generation === observation.identity.generation || before.contextKey === observation.contextKey) throw new Error("rebind requires a new plugin generation; normal resume remains strict");
      if (observation.contentFingerprintVersion !== NATIVE_CONTENT_FINGERPRINT_VERSION || before.contentFingerprint !== observation.contentFingerprint || before.dependencyFingerprint !== observation.dependencyFingerprint || observation.dataPool !== job.boundDataPool) throw new Error("native content, dependencies or data pool changed; rebind refused");
      const latest = await this.journal.read<Job>(id);
      if (fingerprint(latest) !== original || (await this.journal.claimIds()).some(other => other !== id) || await this.journal.cancellation(id)!==cancelledBefore) throw new Error("journal, cancellation or another owned writer changed during rebind; no recovery was adopted");
      const proof: RebindReceipt = { at: iso(), reason, before: { contextKey: before.contextKey, identity: clone(before.identity), endpoint: before.endpoint, workHost: before.workHost, route:clone(before.route) }, after: { contextKey: observation.contextKey, identity: clone(observation.identity), endpoint: observation.endpoint!, workHost: observation.workHost!, route:clone(observation.route) }, contentFingerprintVersion: NATIVE_CONTENT_FINGERPRINT_VERSION, contentFingerprint: observation.contentFingerprint, dependencyFingerprint: observation.dependencyFingerprint!, dataPool: observation.dataPool!, complete: true, consoleReadOnly: true, resumed: false, safety: clone(observation.rebindSafety), requests: clone(observation.requests ?? []) };
      job.rebindings = [...(job.rebindings ?? []), proof];
      job.checkpoint = clone(observation); job.contextKey = observation.contextKey;
      if (job.status === "blocked") job.status = "paused";
      delete job.error;
      this.recordRequests(job, observation.requests ?? []);
      await this.save(job);
      return clone(job);
    } finally { try {await release();} finally {await releaseGate?.();} }
  }
  async cancel(id: string): Promise<Job> {
    const job = await this.read(id);
    await this.journal.cancellation(id, true);
    job.cancelRequested = true;
    if (!this.active.has(id) && await this.journal.hasLiveClaim(id)) return { ...await this.status(id), cancelRequested: true };
    if (!this.active.has(id) && job.status !== "completed" && job.status !== "uncertain" && job.status !== "failed") job.status = "cancelled";
    await this.save(job); return this.status(id);
  }
  async invalidate(id: string, reason: string): Promise<Job> {
    if (this.active.has(id)) throw new Error("cancel the running job and wait for its safe point before invalidating it");
    if(await this.journal.hasLiveClaim(id)) throw new Error("an owned writer/rebind claim is active; wait before invalidating it");
    const job = await this.read(id);
    job.status = "blocked"; job.error = `manual invalidation: ${reason}`;
    // Keep an explicit unusable checkpoint, so resume cannot bypass an operator's invalidation.
    job.checkpoint = { contextKey: job.contextKey ?? "", environment: "Normal", contentFingerprint: "invalidated", complete: false };
    await this.save(job); return clone(job);
  }
  private async observe(job: Job): Promise<Observation> {
    const start = performance.now();
    try { const observation = await this.executor.observe(job.compilation, job.progress.verifiedCues); this.recordRequests(job, observation.requests ?? []); return observation; }
    finally { job.timing.observeMs += performance.now() - start; }
  }
  private async drive(job: Job): Promise<void> {
    const began = performance.now(); let batches = 0;
    try {
      while (job.progress.verifiedCues < job.progress.totalCues) {
        if (job.cancelRequested || await this.journal.cancellation(job.id)) { job.cancelRequested = true; job.status = "cancelled"; return; }
        if (job.options.maxBatchesPerRun !== undefined && batches >= job.options.maxBatchesPerRun) { job.status = "paused"; return; }
        const observation = await this.observe(job);
        if (observation.contentFingerprintVersion !== undefined && observation.contentFingerprintVersion !== NATIVE_CONTENT_FINGERPRINT_VERSION) throw new Error("unknown native content fingerprint version; no next batch was sent");
        if (!observation.complete || !observation.contentFingerprint || observation.environment !== "Normal") throw new Error("complete native content fingerprint in Normal is required at a safe point; no next batch was sent");
        if (observation.semanticVerification?.status === "mismatched") throw new Error(`native stored state differs from owned intent: ${observation.semanticVerification.detail}`);
        const expectedContext = job.contextKey ?? job.options.expectedContext;
        if (expectedContext && observation.contextKey !== expectedContext) throw new Error("console/show/user/profile/generation changed; no next batch was sent");
        if (job.checkpoint && (!job.checkpoint.complete || !sameContentFingerprint(job.checkpoint, observation))) throw new Error("native sequence content changed or the checkpoint was invalidated; recompile the desired plan before more programming");
        if (job.progress.verifiedCues === 0 && Number((observation.detail as { existingCueCount?: number } | undefined)?.existingCueCount ?? 0) > 0) throw new Error("a new compiler-owned chain requires an absent or empty sequence; existing native cues are not silently adopted");
        job.contextKey = observation.contextKey;
        if (job.boundDataPool !== undefined && observation.dataPool !== job.boundDataPool) throw new Error("data pool changed since this job was bound; no next batch was sent");
        if (observation.dataPool !== undefined) job.boundDataPool = observation.dataPool;
        const cues = job.compilation.store.cues.slice(job.progress.verifiedCues, job.progress.verifiedCues + job.options.batchSize);
        const payload = { ...job.compilation.store, ...(job.boundDataPool !== undefined ? { data_pool: job.boundDataPool } : {}), cues };
        // Sequence settings are applied after each batch, so an interrupted build never runs with Tracking disabled.
        const startedAt = iso(), index = job.receipts.length;
        job.inFlight = { index, cues: cues.map((c) => c.cue), payloadFingerprint: fingerprint(payload) };
        await this.save(job); // Durable intent BEFORE the executor may mutate the console.
        if (job.cancelRequested) { delete job.inFlight; job.status = "cancelled"; return; }
        const { result, timing } = await this.executor.execute(payload, job.contextKey, (progress) => { if (job.inFlight) job.inFlight.progress = progress; });
        this.addTiming(job, timing);
        const verified = result.outcome === "succeeded" && result.verification.status === "matched" && result.normalProgrammer === "untouched" && cues.every((c) => receiptVerified(result, c));
        job.receipts.push({ index, cues: cues.map((c) => c.cue), startedAt, completedAt: iso(), result, timing, verified });
        const unknown = result.outcome === "unknown" || result.steps.some((s) => s.kind !== "read" && s.status === "unknown");
        if (!verified) {
          job.status = unknown ? "uncertain" : "failed";
          job.error = unknown ? "a mutation may have executed; this batch will never be replayed" : "batch did not produce complete verified receipts; inspect it before preparing further work";
          if (!unknown) delete job.inFlight;
          return;
        }
        job.progress.verifiedCues += cues.length; job.progress.batches++; batches++;
        job.progress.nextCue = job.compilation.cues[job.progress.verifiedCues]?.cue ?? null;
        // Keep inFlight until the post-store native content fingerprint has durably landed.
        job.checkpoint = await this.observe(job);
        job.receipts.at(-1)!.nativeVerification = job.checkpoint.semanticVerification;
        if (!job.checkpoint.complete || job.checkpoint.contextKey !== job.contextKey || job.checkpoint.environment !== "Normal" || job.checkpoint.semanticVerification?.status === "mismatched" || (observation.dependencyFingerprint !== undefined && job.checkpoint.dependencyFingerprint !== observation.dependencyFingerprint)) {
          job.status = "uncertain"; job.error = `stored receipts exist but the native post-batch checkpoint was unavailable, drifted or mismatched; inspect before continuing${job.checkpoint.semanticVerification?.detail ? `: ${job.checkpoint.semanticVerification.detail}` : ""}`; return;
        }
        delete job.inFlight;
        await this.save(job);
      }
      job.status = "completed";
    } finally { job.timing.totalMs += performance.now() - began; await this.save(job); }
  }
  private addTiming(job: Job, timing: ExecutionTiming) {
    job.timing.executeMs += timing.toolMs;
    this.recordRequests(job, timing.requests);
  }
  private recordRequests(job: Job, requests: RequestTiming[]) {
    for (const request of requests) {
      job.timing.requests++; job.timing[request.kind === "read" ? "readRequests" : request.kind === "coordination" ? "coordinationRequests" : "mutationRequests"]++;
      const byOp = job.timing.byOp[request.op] ?? { count: 0, ms: 0, failures: 0 };
      byOp.count++; byOp.ms += request.ms; if (request.status === "failed") byOp.failures++;
      job.timing.byOp[request.op] = byOp;
      const phase = request.phase ?? request.kind, byPhase = job.timing.byPhase[phase] ?? { count: 0, ms: 0 };
      byPhase.count++; byPhase.ms += request.ms; job.timing.byPhase[phase] = byPhase;
    }
  }
  private async save(job: Job) { job.updatedAt = iso(); await this.journal.write(job.id, job); }
}
/** A legacy journal has only its raw digest: never infer a canonical baseline from owned values. */
function sameContentFingerprint(before: Observation, after: Observation): boolean {
  if (before.contentFingerprintVersion === NATIVE_CONTENT_FINGERPRINT_VERSION) return after.contentFingerprintVersion === NATIVE_CONTENT_FINGERPRINT_VERSION && before.contentFingerprint === after.contentFingerprint;
  if (before.contentFingerprintVersion !== undefined) return false;
  const raw = after.contentFingerprintVersion === NATIVE_CONTENT_FINGERPRINT_VERSION ? after.legacyContentFingerprint : after.contentFingerprintVersion === undefined ? after.contentFingerprint : undefined;
  return typeof raw === "string" && before.contentFingerprint === raw;
}
function receiptVerified(result: OperationResult, cue: StoreCue): boolean {
  return Array.isArray(result.cues) && result.cues.some((r: any) => String(r.cue) === cue.cue && r.status === "stored" && r.verification?.status === "matched");
}
function validRoute(route:RouteIdentity|undefined):route is RouteIdentity {
  if(!route || typeof route!=="object" || Array.isArray(route) || Object.keys(route).some(key=>!["networkNamespace","bootId","instanceProfileDigest"].includes(key))) return false;
  const namespace=route.networkNamespace,boot=route.bootId,digest=route.instanceProfileDigest;
  if(namespace!==undefined && (typeof namespace!=="string" || !/^net:\[\d+\]$/.test(namespace))) return false;
  if(boot!==undefined && (typeof boot!=="string" || !/^[a-f0-9-]{36}$/i.test(boot))) return false;
  if((namespace && !boot) || (boot && !namespace)) return false;
  if(digest!==undefined && (typeof digest!=="string" || !/^[a-f0-9]{64}$/i.test(digest))) return false;
  return !!((namespace && boot) || digest);
}
