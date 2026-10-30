import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobEngine, type JobExecutor } from "../src/jobs/engine.ts";
import { compileTracking } from "../src/tracking/model.ts";

const compiled = () => compileTracking({ version: 1, sequence: 500, cues: [1, 2, 3].map((cue) => ({ cue, changes: [{ kind: "value", fixtures: "1", attribute: "Dimmer", value: cue * 10 }] })) });
const receipt = (cues: any[]) => ({ operation: "store_cues", target: {}, outcome: "succeeded", verification: { status: "matched" }, steps: [{ name: "store", status: "succeeded", kind: "mutation", op: "cmd" }], summary: "stored", normalProgrammer: "untouched", cues: cues.map((c) => ({ cue: c.cue, status: "stored", verification: { status: "matched" } })) } as any);
async function setup(executor: JobExecutor) {
  const directory = await mkdtemp(join(tmpdir(), "gma3-jobs-"));
  const engine = new JobEngine(directory, executor);
  return { directory, engine, close: () => rm(directory, { recursive: true, force: true }) };
}
const observed = (extra = {}) => ({ contextKey: "same-show-user-generation", environment: "Normal", contentFingerprint: "empty", complete: true, ...extra });

test("preparation and run:false perform no console work, and checkpoints survive a new engine", async () => {
  let calls = 0, state = 0;
  const executor: JobExecutor = { observe: async () => { calls++; return observed({ contentFingerprint: String(state) }); }, execute: async (payload) => { calls++; state++; return { result: receipt(payload.cues), timing: { toolMs: 2, requests: [{ op: "cmd", kind: "mutation", ms: 1, status: "succeeded" }] } }; } };
  const h = await setup(executor);
  try {
    const job = await h.engine.create(compiled(), { batchSize: 1 });
    await h.engine.start(job.id, false);
    assert.equal(calls, 0);
    await h.engine.start(job.id, true);
    await h.engine.wait(job.id);
    const done = await new JobEngine(h.directory, executor).status(job.id);
    assert.equal(done.status, "completed");
    assert.equal(done.receipts.length, 3);
    assert.equal(done.progress.verifiedCues, 3);
    assert.equal(done.timing.requests, 3);
    assert.equal(done.checkpoint?.contentFingerprint, "3");
  } finally { await h.close(); }
});

test("cooperative cancellation stops between batches and resumes only remaining verified work", async () => {
  let state = 0, unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const seen: string[] = [];
  const h = await setup({ observe: async () => observed({ contentFingerprint: String(state) }), execute: async (p) => { seen.push(p.cues[0].cue); if (seen.length === 1) await gate; state++; return { result: receipt(p.cues), timing: { toolMs: 1, requests: [] } }; } });
  try {
    const job = await h.engine.create(compiled(), { batchSize: 1 });
    await h.engine.start(job.id, true);
    while (!seen.length) await new Promise((r) => setTimeout(r, 1));
    await h.engine.cancel(job.id);
    unblock();
    await h.engine.wait(job.id);
    assert.equal((await h.engine.status(job.id)).status, "cancelled");
    assert.deepEqual(seen, ["1"]);
    await h.engine.start(job.id, true, true);
    await h.engine.wait(job.id);
    assert.deepEqual(seen, ["1", "2", "3"]);
    assert.equal((await h.engine.status(job.id)).status, "completed");
  } finally { await h.close(); }
});

test("a dispatched unknown mutation is never replayed, even after restart", async () => {
  let writes = 0;
  const executor: JobExecutor = { observe: async () => observed(), execute: async () => { writes++; return { result: { ...receipt([]), outcome: "unknown", steps: [{ name: "store", op: "cmd", status: "unknown" }] }, timing: { toolMs: 1, requests: [] } }; } };
  const h = await setup(executor);
  try {
    const job = await h.engine.create(compiled(), { batchSize: 1 });
    await h.engine.start(job.id, true); await h.engine.wait(job.id);
    assert.equal((await h.engine.status(job.id)).status, "uncertain");
    const restarted = new JobEngine(h.directory, executor);
    await assert.rejects(() => restarted.start(job.id, true, true), /uncertain|inspect/i);
    assert.equal(writes, 1);
  } finally { await h.close(); }
});

test("resume refuses a changed show, manual content edit, or incomplete content observation", async () => {
  for (const changed of [observed({ contextKey: "different-show" }), observed({ contentFingerprint: "operator-edited" }), observed({ complete: false })]) {
    let observation = observed(), writes = 0;
    const h = await setup({ observe: async () => observation, execute: async (p) => { writes++; return { result: receipt(p.cues), timing: { toolMs: 1, requests: [] } }; } });
    try {
      const job = await h.engine.create(compiled(), { batchSize: 1, maxBatchesPerRun: 1 });
      await h.engine.start(job.id, true); await h.engine.wait(job.id);
      assert.equal((await h.engine.status(job.id)).status, "paused");
      observation = changed;
      await h.engine.start(job.id, true, true); await h.engine.wait(job.id);
      assert.equal((await h.engine.status(job.id)).status, "blocked");
      assert.equal(writes, 1);
    } finally { await h.close(); }
  }
});

test("restart turns persisted in-flight work uncertain and rejects journal tampering", async () => {
  const h = await setup({ observe: async () => observed(), execute: async (p) => ({ result: receipt(p.cues), timing: { toolMs: 1, requests: [] } }) });
  try {
    const job = await h.engine.create(compiled(), { batchSize: 1 });
    const path = join(h.directory, `${job.id}.json`), journal = JSON.parse(await readFile(path, "utf8"));
    journal.status = "running"; journal.inFlight = { index: 0, cues: ["1"] };
    await writeFile(path, JSON.stringify(journal));
    assert.equal((await new JobEngine(h.directory, {} as any).status(job.id)).status, "uncertain");
    journal.compilation.plan.sequence = 999;
    await writeFile(path, JSON.stringify(journal));
    await assert.rejects(() => h.engine.status(job.id), /fingerprint|integrity/i);
  } finally { await h.close(); }
});

test("two server processes cannot run the same prepared job and external cancellation reaches its safe point", async () => {
  let unblock!: () => void, writes = 0;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const executor: JobExecutor = { observe: async () => observed(), execute: async (p) => { writes++; await gate; return { result: receipt(p.cues), timing: { toolMs: 1, requests: [] } }; } };
  const h = await setup(executor);
  try {
    const job = await h.engine.create(compiled(), { batchSize: 1 });
    await h.engine.start(job.id, true);
    while (!writes) await new Promise((r) => setTimeout(r, 1));
    const other = new JobEngine(h.directory, executor);
    assert.equal((await other.status(job.id)).status, "running");
    await assert.rejects(() => other.start(job.id, true, true), /running|claim/);
    await other.cancel(job.id); unblock(); await h.engine.wait(job.id);
    assert.equal((await other.status(job.id)).status, "cancelled");
    assert.equal(writes, 1);
  } finally { await h.close(); }
});

test("a newly prepared chain refuses an already populated native sequence", async () => {
  let writes = 0;
  const h = await setup({ observe: async () => observed({ detail: { existingCueCount: 3 } }), execute: async (p) => { writes++; return { result: receipt(p.cues), timing: { toolMs: 1, requests: [] } }; } });
  try {
    const job = await h.engine.create(compiled(), { batchSize: 1 });
    await h.engine.start(job.id, true); await h.engine.wait(job.id);
    assert.equal((await h.engine.status(job.id)).status, "blocked");
    assert.equal(writes, 0);
  } finally { await h.close(); }
});

test("a completed job's manual invalidation cannot be bypassed by resuming an empty remainder", async () => {
  const h = await setup({ observe: async () => observed(), execute: async (p) => ({ result: receipt(p.cues), timing: { toolMs: 1, requests: [] } }) });
  try {
    const job = await h.engine.create(compiled(), { batchSize: 3 });
    await h.engine.start(job.id, true); await h.engine.wait(job.id);
    await h.engine.invalidate(job.id, "operator edited a stored cue");
    await assert.rejects(() => h.engine.start(job.id, true, true), /invalidated|checkpoint/);
    assert.equal((await h.engine.status(job.id)).status, "blocked");
  } finally { await h.close(); }
});

test("native post-Store mismatch stops all further batches and is never checkpointed as success", async () => {
  let writes = 0;
  const h = await setup({ observe: async (_p, expectedCues) => observed(expectedCues ? { semanticVerification: { status: "mismatched", detail: "native hard Dimmer is 90, desired 10" } } : {}), execute: async (p) => { writes++; return { result: receipt(p.cues), timing: { toolMs: 1, requests: [] } }; } });
  try {
    const job = await h.engine.create(compiled(), { batchSize: 1 });
    await h.engine.start(job.id, true); await h.engine.wait(job.id);
    assert.equal((await h.engine.status(job.id)).status, "uncertain");
    assert.equal(writes, 1);
  } finally { await h.close(); }
});

test("a journal failure after mutation stays inspectable and never rejects an unobserved background promise", async () => {
  let directory = "";
  const h = await setup({ observe: async () => observed(), execute: async (p) => {
    await rename(directory, `${directory}-saved`); await writeFile(directory, "storage unavailable");
    return { result: receipt(p.cues), timing: { toolMs: 1, requests: [] } };
  } }); directory = h.directory;
  try {
    const job = await h.engine.create(compiled(), { batchSize: 3 });
    await h.engine.start(job.id, true); await h.engine.wait(job.id);
    const status = await h.engine.status(job.id);
    assert.equal(status.status, "uncertain");
    assert.match(status.error ?? "", /journal|persist|storage/i);
    await assert.rejects(() => h.engine.start(job.id, true, true), /journal|persist|uncertain/i);
  } finally {
    await rm(directory, { force: true });
    await rename(`${directory}-saved`, directory).catch(() => {});
    await h.close();
  }
});

test("terminal status is published only after its durable journal write and writer-claim cleanup settle", async () => {
  for (const phase of ["write", "release"] as const) {
    const h = await setup({ observe: async () => observed(), execute: async p => ({ result: receipt(p.cues), timing: { toolMs: 1, requests: [] } }) });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const journal = (h.engine as any).journal;
    try {
      if (phase === "write") {
        const write = journal.write.bind(journal);
        journal.write = async (id: string, value: any) => {
          if (value.status === "completed") { entered(); await gate; }
          await write(id, value);
        };
      } else {
        const claim = journal.claim.bind(journal);
        journal.claim = async (id: string) => {
          const cleanup = await claim(id);
          return async () => { entered(); await gate; await cleanup(); };
        };
      }
      const job = await h.engine.create(compiled(), { batchSize: 3 });
      await h.engine.start(job.id, true);
      await reached;
      const published = {status: false, list: false, start: false};
      const status = h.engine.status(job.id).then(value => { published.status = true; return value; });
      const list = h.engine.list().then(value => { published.list = true; return value; });
      const start = h.engine.start(job.id, false).then(value => { published.start = true; return value; });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(published, {status:false,list:false,start:false}, `terminal status escaped before ${phase} settled`);
      assert.equal((await new JobEngine(h.directory, {} as any).status(job.id)).status, "running", "another process must not publish completed while its writer claim is live");
      release();
      assert.equal((await status).status, "completed");
      assert.equal((await list)[0].status, "completed");
      assert.equal((await start).status, "completed");
      assert.equal(JSON.parse(await readFile(join(h.directory, `${job.id}.json`), "utf8")).status, "completed");
      await assert.rejects(() => readFile(join(h.directory, `${job.id}.lock`)), { code: "ENOENT" });
    } finally {
      release();
      const jobs = await journal.ids();
      for (const id of jobs) await h.engine.wait(id);
      await h.close();
    }
  }
});

test("writer-claim cleanup failure publishes uncertainty instead of a completed job", async () => {
  let writes = 0;
  const h = await setup({ observe: async () => observed(), execute: async p => { writes++; return { result: receipt(p.cues), timing: { toolMs: 1, requests: [] } }; } });
  const journal = (h.engine as any).journal, claim = journal.claim.bind(journal);
  journal.claim = async (id: string) => { await claim(id); return async () => { throw new Error("injected claim cleanup failure"); }; };
  try {
    const job = await h.engine.create(compiled(), { batchSize: 3 });
    await h.engine.start(job.id, true);
    await h.engine.wait(job.id);
    const status = await h.engine.status(job.id);
    assert.equal(status.status, "uncertain");
    assert.match(status.error ?? "", /claim could not be released.*injected claim cleanup failure/);
    assert.equal(JSON.parse(await readFile(join(h.directory, `${job.id}.json`), "utf8")).status, "uncertain");
    assert.equal(typeof JSON.parse(await readFile(join(h.directory, `${job.id}.lock`), "utf8")).token, "string");
    await assert.rejects(() => h.engine.start(job.id, true, true), /uncertain|inspect/i);
    assert.equal(writes, 1);
  } finally { await h.close(); }
});
