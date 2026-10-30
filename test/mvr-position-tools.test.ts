import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {startHarness} from './helpers/tool-harness.ts';
import {registerMvrPositionTools} from '../src/tools/mvr-positions.ts';
const uuid='00000000-0000-4000-8000-000000000001';
async function run(options:{uncertain?:boolean;malformed?:boolean;releaseFailure?:boolean;missingPostAsset?:boolean;postFailure?:boolean;stale?:boolean;collateral?:boolean},check:(h:any,args:any,state:any)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'mvr-positions-')),h=await startHarness(registerMvrPositionTools);
 const before=join(dir,'Source.mvr'),incoming=join(dir,'Incoming.mvr'),pre=join(dir,'Pre.mvr'),post=join(dir,'Post.mvr');
 try{
  execFileSync('python3',['-I','-c',`import zipfile,sys
for p,x in [(sys.argv[1],0),(sys.argv[2],250)]:
 with zipfile.ZipFile(p,'x')as z:
  z.writestr('GeneralSceneDescription.xml','<GeneralSceneDescription verMajor="1" verMinor="6"><Scene><Fixture uuid="${uuid}" name="Dimmer"><Matrix>{1,0,0}{0,1,0}{0,0,1}{'+str(x)+',0,0}</Matrix><FixtureID>1</FixtureID><GDTFSpec>type.gdtf</GDTFSpec><GDTFMode>mode</GDTFMode></Fixture></Scene></GeneralSceneDescription>')
  z.writestr('type.gdtf','opaque legacy bytes')`,before,incoming]);
  const identity={hostname:'lab',showfile:'show',user:'Admin',profile:'Default',generation:'generation'};
  const state={writes:0,x:0,exports:0};
  h.fake.on('fast.context',()=>({contextKey:'context',identity,identityUncertain:[],environment:'Normal'}));
  h.fake.on('fast.lease',a=>{if(a.action==='release' && options.releaseFailure)throw new Error('lease release response failed');return a.action==='acquire'?{token:'lease'}:{released:true};});
  h.fake.on('patch.state',()=>({copyOpen:false,atRoot:true,modal:false}));
  h.fake.on('patch.collections',()=>({live:['Stages','FixtureTypes','AttributeDefinitions','DmxCurves']}));
  h.fake.on('patch.fingerprint',a=>({collection:a.collection,hash:1,objects:1,complete:true}));
  h.fake.on('cmd',async()=>{state.exports++;await copyFile(state.exports===1 && !options.stale?before:incoming,state.exports===1?pre:post);if(state.exports===2 && options.missingPostAsset)execFileSync('python3',['-I','-c',`import zipfile,sys
with zipfile.ZipFile(sys.argv[1])as z: xml=z.read('GeneralSceneDescription.xml')
with zipfile.ZipFile(sys.argv[1],'w')as z: z.writestr('GeneralSceneDescription.xml',xml)`,post]);return{feedback:'OK'};});
  h.fake.on('lua',a=>{
   if(String(a.code).includes('local expected=')){
    state.writes++;const property=['POSX','POSY','POSZ'][state.writes-1];if(property==='POSX')state.x=.25;
    return{values:options.malformed?[]:[options.uncertain?{dispatched:true,uncertain:true,reason:'native setter reply uncertain'}:{dispatched:true,uuid,property,value:property==='POSX'?.25:0}]};
   }
   return{values:[{identity,fixtures:[{uuid,fid:1,name:'Dimmer',addr:'fixture',type:'type',mode:'mode',patch:'',x:0,y:0,z:0,rx:0,ry:0,rz:0}]}]};
  });
  h.fake.on('patch.list',()=>({total:1,count:1,offset:0,fixtures:[{fid:1,name:'Dimmer',depth:0}]}));
  h.fake.on('objects',a=>({total:1,items:[{class:'Fixture',name:'Dimmer',fields:a.asText===false?{FID:1,Name:'Dimmer',POSX:state.x,POSY:0,POSZ:0,ROTX:0,ROTY:0,ROTZ:0,MESHMIRRORX:false}:{FID:'1',ROTDIRECT:'0,0,0,1'}}]}));
  h.fake.on('dmx.output',()=>({protocols:{artnet:{out:false,in:false,entries:[]},sacn:{out:false,in:false,entries:[]}},universes:[],totals:{universes:0},stations:[]}));
  h.fake.on('group.read',a=>{if(options.postFailure && state.writes)throw new Error('post-preservation read failed');return{ref:a.ref,name:options.collateral && state.writes?'Changed':'Group',items:[],count:0,truncated:false,unreadable:0};});
  const args={before_file:before,incoming_file:incoming,decisions:[{uuid,source:'local',patch:'local',transform:'incoming'}],exclusive:true,mapped_to_drive1_mvr:true,before_export_file:pre,after_export_file:post,preserve:{data_pool:1,groups:[1]}};
  await check(h,args,state);
 }finally{await h.close();await rm(dir,{recursive:true,force:true});}
}
test('MVR position tool previews offline, then uses guarded placement with fresh exports and scoped preservation',async()=>run({},async(h,args,state)=>{
 const preview=await h.callJson('gma3_apply_mvr_positions',args);assert.equal(preview.result.preview,true);assert.deepEqual(h.fake.requests,[]);
 const applied=await h.callJson('gma3_apply_mvr_positions',{...args,preview:false,expected_plan:preview.result.expected_plan});
 assert.equal(applied.isError,false,JSON.stringify(applied.result));assert.equal(applied.result.verification.status,'matched');assert.equal(state.writes,3);assert.equal(state.exports,2);assert.equal(h.fake.requests.some((r:any)=>r.op==='set'),false);
 assert.ok(h.fake.requests.findIndex((r:any)=>r.op==='lua')<h.fake.requests.findIndex((r:any)=>r.op==='cmd'),'native identity/type/patch/pose must be pinned before the certified before export');
 assert.deepEqual(h.fake.requests.filter((r:any)=>r.op==='fast.lease').map((r:any)=>r.args.action),['acquire','release']);assert.equal(applied.result.writerLease.released,true);
}));
test('lease cleanup uncertainty keeps applied proof, restore and explicit warning',async()=>run({releaseFailure:true},async(h,args,state)=>{
 const preview=await h.callJson('gma3_apply_mvr_positions',args),result=await h.callJson('gma3_apply_mvr_positions',{...args,preview:false,expected_plan:preview.result.expected_plan});
 assert.equal(result.isError,true);assert.equal(result.result.verification.status,'matched');assert.equal(result.result.placementOutcome,'succeeded');assert.equal(result.result.restore[0].position.x,0);assert.equal(result.result.writerLease.uncertain,true);assert.match(result.result.warnings.join(' '),/lease release/i);assert.equal(state.writes,3);
}));
test('malformed setter response after dispatch remains unknown and cannot fall back to generic Set',async()=>run({malformed:true},async(h,args,state)=>{
 const preview=await h.callJson('gma3_apply_mvr_positions',args),result=await h.callJson('gma3_apply_mvr_positions',{...args,preview:false,expected_plan:preview.result.expected_plan});
 assert.equal(result.result.placementOutcome,'unknown');assert.equal(state.writes,1);assert.equal(h.fake.requests.some((r:any)=>r.op==='set'),false);
}));
test('post-write observation failure retains restore and the original placement outcome',async()=>run({postFailure:true},async(h,args,state)=>{
 const preview=await h.callJson('gma3_apply_mvr_positions',args),result=await h.callJson('gma3_apply_mvr_positions',{...args,preview:false,expected_plan:preview.result.expected_plan});
 assert.equal(result.isError,true);assert.equal(result.result.placementOutcome,'succeeded');assert.equal(result.result.restore[0].fid,1);assert.equal(result.result.restore[0].position.x,0);assert.equal(state.writes,3);
}));
test('missing post-export type content is a failed apply even when every position readback matches',async()=>run({missingPostAsset:true},async(h,args,state)=>{
 const preview=await h.callJson('gma3_apply_mvr_positions',args),result=await h.callJson('gma3_apply_mvr_positions',{...args,preview:false,expected_plan:preview.result.expected_plan});
 assert.equal(result.isError,true);assert.equal(result.result.verification.status,'mismatched');assert.equal(result.result.placementOutcome,'succeeded');assert.equal(state.writes,3);
}));
test('fresh before mismatch refuses every position write',async()=>run({stale:true},async(h,args,state)=>{
 const preview=await h.callJson('gma3_apply_mvr_positions',args),result=await h.callJson('gma3_apply_mvr_positions',{...args,preview:false,expected_plan:preview.result.expected_plan});
 assert.equal(result.result.verification.status,'mismatched');assert.equal(state.writes,0);assert.equal(state.exports,1);
}));
test('uncertain setter is never replayed or converted to success by matching fresh post export',async()=>run({uncertain:true},async(h,args,state)=>{
 const preview=await h.callJson('gma3_apply_mvr_positions',args),result=await h.callJson('gma3_apply_mvr_positions',{...args,preview:false,expected_plan:preview.result.expected_plan});
 assert.equal(result.result.outcome,'partial');assert.equal(result.result.placementOutcome,'unknown');assert.equal(result.result.steps.some((s:any)=>s.name==='placement_1.POSX' && s.status==='unknown'),true);assert.equal(state.writes,1);assert.equal(state.exports,2);
}));
test('preservation detects changed explicit group despite matching fixture poses',async()=>run({collateral:true},async(h,args,state)=>{
 const preview=await h.callJson('gma3_apply_mvr_positions',args),result=await h.callJson('gma3_apply_mvr_positions',{...args,preview:false,expected_plan:preview.result.expected_plan});
 assert.equal(result.result.verification.status,'mismatched');assert.equal(state.writes,3);assert.equal(result.result.preservation.groupsMatched,false);
}));
