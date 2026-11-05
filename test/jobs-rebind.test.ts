import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobEngine, type JobExecutor, type Observation } from "../src/jobs/engine.ts";
import { compileTracking } from "../src/tracking/model.ts";

const compilation=()=>compileTracking({version:1,sequence:500,cues:[1,2].map(cue=>({cue,changes:[{kind:"value",fixtures:"1",attribute:"Dimmer",value:cue*10}]}))});
const observation=(generation="old",extra:Record<string,unknown>={}):Observation=>({contextKey:`context-${generation}`,identity:{generation,hostname:"lab",showfile:"Lab.show",user:"user",profile:"profile"},endpoint:"127.0.0.1:9803",workHost:"workstation",route:{networkNamespace:"net:[123]",bootId:"12345678-1234-1234-1234-123456789012"},environment:"Normal",contentFingerprintVersion:"native-json-v2",contentFingerprint:"native-content",dependencyFingerprint:"native-dependencies",dataPool:1,complete:true,rebindSafety:{normalReadable:true,noOwnedWork:true,detail:{source:"native reads"}},...extra} as Observation);
async function setup(initial:Observation=observation()) {
 const directory=await mkdtemp(join(tmpdir(),"gma3-rebind-"));let current=initial,writes=0;
 const executor:JobExecutor={observe:async()=>structuredClone(current),observeRebind:async()=>structuredClone(current),execute:async payload=>{writes++;return {result:{operation:"store_cues",target:{},outcome:"succeeded",verification:{status:"matched"},normalProgrammer:"untouched",summary:"stored",steps:[{name:"Store",kind:"mutation",status:"succeeded"}],cues:payload.cues.map(c=>({cue:c.cue,status:"stored",verification:{status:"matched"}}))},timing:{toolMs:1,requests:[]}} as any;}};
 const engine=new JobEngine(directory,executor),job=await engine.create(compilation(),{batchSize:1,maxBatchesPerRun:1});
 await engine.start(job.id,true);await engine.wait(job.id);
 return {directory,engine,executor,id:job.id,set:(value:Observation)=>{current=value;},writes:()=>writes,close:()=>rm(directory,{recursive:true,force:true})};
}
test("explicit rebind durably changes only generation/context after complete identical native proof and does not run work",async()=>{
 const h=await setup();try {
  h.set(observation("new"));
  await h.engine.start(h.id,true,true);await h.engine.wait(h.id);
  assert.equal((await h.engine.status(h.id)).status,"blocked");assert.equal(h.writes(),1);
  const rebound=await h.engine.rebind(h.id);
  assert.equal(rebound.status,"paused");assert.equal(rebound.contextKey,"context-new");assert.equal(h.writes(),1);
  assert.equal(rebound.rebindings?.[0].before.contextKey,"context-old");
  assert.equal(rebound.rebindings?.[0].after.contextKey,"context-new");
  assert.equal(rebound.rebindings?.[0].contentFingerprint,"native-content");
  assert.equal(rebound.rebindings?.[0].dependencyFingerprint,"native-dependencies");
  const restarted=new JobEngine(h.directory,h.executor);
  assert.equal((await restarted.status(h.id)).rebindings?.length,1);
  await restarted.start(h.id,true,true);await restarted.wait(h.id);
  assert.equal((await restarted.status(h.id)).status,"completed");assert.equal(h.writes(),2);
 }finally{await h.close();}
});
test("rebind refuses changed identity, endpoint, data pool, native content/dependencies, incomplete reads and owned console work",async()=>{
 const changed=[
  observation("new",{identity:{...observation("new").identity,showfile:"Other.show"}}),
  observation("new",{identity:{...observation("new").identity,profile:"Other"}}),
  observation("new",{identity:{...observation("new").identity,hostname:"Other"}}),
  observation("new",{identity:{...observation("new").identity,user:"Other"}}),
  observation("new",{endpoint:"127.0.0.1:9801"}),observation("new",{workHost:"other-workstation"}),observation("new",{dataPool:2}),observation("new",{route:{networkNamespace:"net:[456]",bootId:"12345678-1234-1234-1234-123456789012"}}),observation("new",{route:undefined}),observation("new",{route:{networkNamespace:"net:[123]",bootId:"22345678-1234-1234-1234-123456789012"}}),
  observation("new",{contentFingerprint:"changed"}),observation("new",{dependencyFingerprint:"changed"}),
  observation("new",{complete:false}),observation("new",{dependencyFingerprint:undefined}),
  observation("new",{environment:"Preview"}),observation("new",{rebindSafety:{normalReadable:false,noOwnedWork:true}}),
  observation("new",{rebindSafety:{normalReadable:true,noOwnedWork:false}}),observation("new",{identity:undefined}),
 ];
 for(const value of changed){const h=await setup();try {
  h.set(value);const before=await readFile(join(h.directory,`${h.id}.json`),"utf8");
  await assert.rejects(()=>h.engine.rebind(h.id));
  assert.equal(await readFile(join(h.directory,`${h.id}.json`),"utf8"),before);assert.equal(h.writes(),1);
 }finally{await h.close();}}
});
test("rebind never adopts invalidated, failed, inflight, unknown or legacy identity-free checkpoints",async()=>{
 for(const defect of ["inFlight","unknown","failed","invalidated","legacy"]){const h=await setup();try{
  const path=join(h.directory,`${h.id}.json`),job=JSON.parse(await readFile(path,"utf8"));
  if(defect==="inFlight") job.inFlight={index:1,cues:["2"],payloadFingerprint:"x"};
  if(defect==="unknown") job.receipts[0].result.steps.push({name:"uncertain",status:"unknown",kind:"mutation"});
  if(defect==="failed") job.status="failed";
  if(defect==="invalidated") job.checkpoint.complete=false;
  if(defect==="legacy") delete job.checkpoint.identity;
  await writeFile(path,JSON.stringify(job));h.set(observation("new"));
  await assert.rejects(()=>h.engine.rebind(h.id));assert.equal(h.writes(),1);
 }finally{await h.close();}}
});
test("another durable writer claim prevents rebind before console observations",async()=>{
 const h=await setup();try{
  const other=await h.engine.create(compilation(),{batchSize:1});
  await writeFile(join(h.directory,`${other.id}.lock`),JSON.stringify({pid:process.pid,token:"other"}));
  h.set(observation("new"));
  await assert.rejects(()=>h.engine.rebind(h.id),/owned|claim|running|writer/i);assert.equal(h.writes(),1);
 }finally{await h.close();}
});
test("rebind blocks a competing process from starting another job during recovery reads",async()=>{
 const h=await setup();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
 try{
  const other=await h.engine.create(compilation(),{batchSize:1,maxBatchesPerRun:1});h.set(observation("new"));
  h.executor.observeRebind=async()=>{entered();await gate;return observation("new");};
  const rebound=h.engine.rebind(h.id);await started;
  const competing=new JobEngine(h.directory,h.executor);
  try {await assert.rejects(()=>competing.start(other.id,true),/rebind|recovery|claim/i);}finally{release();await rebound;await competing.wait(other.id);}
  assert.equal(h.writes(),1);
 }finally{release();await h.close();}
});
test("a journal edit during recovery reads cannot be overwritten by a successful rebind",async()=>{
 const h=await setup();try{
  h.executor.observeRebind=async()=>{const path=join(h.directory,`${h.id}.json`);const job=JSON.parse(await readFile(path,"utf8"));job.error="operator changed journal";await writeFile(path,JSON.stringify(job));return observation("new");};
  await assert.rejects(()=>h.engine.rebind(h.id),/journal|changed/i);
  assert.equal((await h.engine.status(h.id)).error,"operator changed journal");assert.equal(h.writes(),1);
 }finally{await h.close();}
});
test("cancellation during read-only recovery stops adoption without losing the cancel marker",async()=>{
 const h=await setup();try{
  h.executor.observeRebind=async()=>{await h.engine.cancel(h.id);return observation("new");};
  await assert.rejects(()=>h.engine.rebind(h.id),/cancellation|changed/i);
  assert.equal((await h.engine.status(h.id)).contextKey,"context-old");
  assert.equal((await readFile(join(h.directory,`${h.id}.cancel`))).byteLength,0);
  assert.equal(h.writes(),1);
 }finally{await h.close();}
});


test("legacy opaque checkpoints cannot rebind even if current canonical content happens to match", async () => {
 const h = await setup({ ...observation(), contentFingerprintVersion: undefined });
 try {
  h.set(observation("new"));
  const before = await readFile(join(h.directory, `${h.id}.json`), "utf8");
  await assert.rejects(() => h.engine.rebind(h.id), /legacy|fingerprint version/i);
  assert.equal(await readFile(join(h.directory, `${h.id}.json`), "utf8"), before);
  assert.equal(h.writes(), 1);
 } finally { await h.close(); }
});

test("same-generation legacy resume migrates only on an exact complete raw hash match", async () => {
 for (const matches of [true, false]) {
  const h = await setup({ ...observation(), contentFingerprintVersion: undefined, contentFingerprint: "legacy-raw" });
  try {
   h.set(observation("old", { contentFingerprint: "canonical", legacyContentFingerprint: matches ? "legacy-raw" : "different-raw" }));
   await h.engine.start(h.id, true, true); await h.engine.wait(h.id);
   const finished = await h.engine.status(h.id);
   assert.equal(finished.status, matches ? "completed" : "blocked");
   assert.equal(h.writes(), matches ? 2 : 1);
   if (matches) assert.equal(finished.checkpoint?.contentFingerprintVersion, "native-json-v2");
  } finally { await h.close(); }
 }
});
