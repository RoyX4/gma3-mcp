import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJobTools } from "../src/tools/jobs.ts";
import { registerTrackingTools } from "../src/tools/tracking.ts";
import { startHarness } from "./helpers/tool-harness.ts";

const plan = { version: 1, sequence: 600, cues: [{ cue: 1, changes: [{ kind: "value", fixtures: "1 Thru 20", attribute: "Dimmer", value: 40 }] }, { cue: 2, hold: true }] };

test("new jobs default to 12 cues while explicit 3/6 and their persisted options remain offline and unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gma3-job-default-batch-"));
  const h = await startHarness(createJobTools({ directory }));
  const many = { ...plan, cues: Array.from({ length: 13 }, (_, i) => ({ cue: i + 1, changes: [{ kind: "value", fixtures: "1", attribute: "Dimmer", value: i + 1 }] })) };
  try {
    const ids: Array<{ id: string; batchSize: number }> = [];
    for (const explicit of [undefined, 3, 6]) {
      const batchSize = explicit ?? 12;
      const prepared = await h.callJson("gma3_programming_job", { action: "prepare", plan: many, ...(explicit === undefined ? {} : { batch_size: explicit }) });
      assert.equal(prepared.isError, false);
      assert.equal(prepared.result.estimates.batchSize, batchSize);
      assert.equal(prepared.result.estimates.totalBatches, Math.ceil(13 / batchSize));
      const stored = JSON.parse(await readFile(join(directory, prepared.result.id + ".json"), "utf8"));
      assert.equal(stored.options.batchSize, batchSize);
      ids.push({ id: prepared.result.id, batchSize });
    }
    const restarted = await startHarness(createJobTools({ directory }));
    try {
      for (const { id, batchSize } of ids) {
        const status = await restarted.callJson("gma3_programming_job", { action: "status", id });
        assert.equal(status.result.status, "prepared");
        assert.equal(status.result.estimates.batchSize, batchSize, "a new default must not rewrite saved job options");
      }
      assert.deepEqual(restarted.fake.requests, []);
    } finally { await restarted.close(); }
    assert.deepEqual(h.fake.requests, []);
  } finally { await h.close(); await rm(directory, { recursive: true, force: true }); }
});

test("tracking tools expose executable delta, provenance and comparisons without touching a bridge", async () => {
  const h = await startHarness(registerTrackingTools);
  try {
    const compiled = await h.callJson("gma3_compile_tracking", { plan });
    assert.equal(compiled.isError, false);
    assert.equal(compiled.result.statistics.holds, 1);
    assert.equal(compiled.result.store.cues[1].hold, true);
    const why = await h.callJson("gma3_explain_tracking_cue", { plan, cue: "2", fixture: "1" });
    assert.equal(why.result.cells.length, 1);
    assert.equal(why.result.cells[0].provenance.cue, "1");
    const diff = await h.callJson("gma3_compare_tracking_cues", { plan, from: "1", to: "2" });
    assert.equal(diff.result.identical, true);
    assert.equal(h.fake.requests.length, 0);
  } finally { await h.close(); }
});

test("job preparation, status, cancel and run:false stay offline and reject unapproved execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gma3-job-tools-"));
  const h = await startHarness(createJobTools({ directory }));
  try {
    const prepared = await h.callJson("gma3_programming_job", { action: "prepare", plan, batch_size: 1 });
    assert.equal(prepared.result.status, "prepared");
    const id = prepared.result.id;
    await h.callJson("gma3_programming_job", { action: "run", id, run: false });
    const refused = await h.callJson("gma3_programming_job", { action: "run", id, run: true });
    assert.equal(refused.isError, true);
    await h.callJson("gma3_programming_job", { action: "cancel", id });
    const status = await h.callJson("gma3_programming_job", { action: "status", id });
    assert.equal(status.result.status, "cancelled");
    assert.equal(h.fake.requests.length, 0);
  } finally { await h.close(); await rm(directory, { recursive: true, force: true }); }
});

test("explicit rebind forbids automatic run and requires an existing qualified safe checkpoint",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"gma3-job-tool-rebind-")),h=await startHarness(createJobTools({directory}));
 try{
  const id=(await h.callJson("gma3_programming_job",{action:"prepare",plan})).result.id;
  for(const args of [{action:"rebind",id},{action:"rebind",id,exclusive:true,run:true},{action:"rebind",id,exclusive:true}]) {
   const r=await h.callJson("gma3_programming_job",args);assert.equal(r.isError,true);
  }
  assert.deepEqual(h.fake.requests,[]);
 }finally{await h.close();await rm(directory,{recursive:true,force:true});}
});
