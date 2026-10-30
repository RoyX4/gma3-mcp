import { test } from "node:test";
import assert from "node:assert/strict";
import { observeRebind } from "../src/jobs/rebind.ts";
import { compileTracking } from "../src/tracking/model.ts";
import { startHarness } from "./helpers/tool-harness.ts";

const context={contextKey:"new-context",environment:"Normal",identityUncertain:[],identity:{generation:"new",hostname:"lab",showfile:"Lab.show",user:"user",profile:"profile"}};
const plan=compileTracking({version:1,sequence:500,data_pool:1,cues:[{cue:1,hold:true}]});
async function setup() {
 const h=await startHarness(()=>{});
 h.fake.on("fast.context",()=>context).on("fast.lease",()=>({active:false,owned:false}));
 h.fake.on("input.status",()=>({status:{sessions:{},holds:[],capacity:{used:0},unresolved:0,retained:0,quarantined:0,interactions:{}},unresolvedFromPreviousRun:[]}));
 h.fake.on("control.status",()=>({sessions:{},unresolved:[],unresolvedFromPreviousRun:[]}));
 h.fake.on("fast.batch",()=>({batches:[]}));
 h.fake.on("patch.state",()=>({atRoot:true,copyOpen:false,modal:false}));
 h.fake.on("programmer",()=>({environment:"Normal",coverage:{complete:true},total:2,fixturesTruncated:false}));
 h.fake.on("objects",()=>({items:[]}));
 h.fake.on("patch.collections",()=>({live:["Stages","FixtureTypes","AttributeDefinitions"]}));
 h.fake.on("patch.fingerprint",()=>({complete:true,hash:"native",objects:1}));
 return h;
}
test("native rebind proof reads full dependency/content checkpoints and Normal without any console mutation or lease acquisition",async()=>{
 const h=await setup();try{
  const result=await observeRebind(h.ctx,plan,0);
  assert.equal(result.complete,true);assert.deepEqual(result.identity,context.identity);
  assert.equal(result.endpoint,h.bridge.description);assert.equal(typeof result.workHost,"string");
  assert.equal(result.rebindSafety?.normalReadable,true);assert.equal(result.rebindSafety?.noOwnedWork,true);
  assert.equal(h.fake.requests.filter(r=>r.op==="programmer").length,2);
  assert.equal(h.fake.requests.some(r=>["cmd","set","lua"].includes(r.op)),false);
  assert.equal(h.fake.requests.filter(r=>r.op==="fast.lease").every(r=>r.args.action==="status"),true);
  assert.equal(h.fake.requests.filter(r=>r.op==="fast.batch").every(r=>r.args.action==="list"),true);
 }finally{await h.close();}
});
test("native rebind proof refuses owned writer/input/control/batch work, patch copies and unreadable Normal",async()=>{
 const defects:[string,any][]=[
  ["fast.lease",{active:true,owned:false}], ["fast.lease",{active:false,owned:true}], ["fast.lease",{active:false}], ["input.status",{status:{sessions:{owner:{}},holds:[]},unresolvedFromPreviousRun:[]}],
  ["control.status",{sessions:{owner:{gestures:1}},unresolved:[],unresolvedFromPreviousRun:[]}],
  ["fast.batch",{batches:[{status:"running"}]}], ["patch.state",{atRoot:true,copyOpen:true,modal:false}],
  ["programmer",{environment:"Normal",coverage:{complete:false},total:0}],
  ["programmer",{environment:"Preview",coverage:{complete:true},total:0}],
 ];
 for(const [op,reply] of defects){const h=await setup();try{
  h.fake.on(op,()=>reply);await assert.rejects(()=>observeRebind(h.ctx,plan,0),/rebind|Normal|owned/i);
  assert.deepEqual(h.fake.commands,[]);
 }finally{await h.close();}}
});
test("new ownership or context drift at the end of recovery never publishes a safe proof",async()=>{
 for(const drift of ["owner","context"]){const h=await setup();try{
  let n=0;
  if(drift==="owner") h.fake.on("fast.lease",()=>({active:n++>0,owned:false}));
  else h.fake.on("fast.context",()=>({...context,contextKey:++n>=4?"changed":"new-context"}));
  await assert.rejects(()=>observeRebind(h.ctx,plan,0));assert.deepEqual(h.fake.commands,[]);
 }finally{await h.close();}}
});

test("native rebind refuses malformed or unknown batch status instead of treating it as idle",async()=>{
 for(const batch of [{},null,{id:"batch",status:"future-status"},{id:"batch",status:["succeeded"]},{id:"",status:"succeeded"},{status:"succeeded"}]){
  const h=await setup();try{
   h.fake.on("fast.batch",()=>({batches:[batch]}));
   await assert.rejects(()=>observeRebind(h.ctx,plan,0),/rebind|owned/i);
   assert.equal(h.fake.requests.some(r=>["cmd","set","lua"].includes(r.op)),false);
  }finally{await h.close();}
 }
 for(const status of ["succeeded","failed","unknown","cancelled"]){
  const h=await setup();try{
   h.fake.on("fast.batch",()=>({batches:[{id:"retained-batch",status}]}));
   assert.equal((await observeRebind(h.ctx,plan,0)).rebindSafety?.noOwnedWork,true);
  }finally{await h.close();}
 }
});
