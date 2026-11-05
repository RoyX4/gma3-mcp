import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { startHarness } from "./helpers/tool-harness.ts";
import { cameraBindingCode, registerCameraWitnessTools } from "../src/tools/camera-witness.ts";

async function setup(collateral = false, failed = false, builtin?: {display:string;edit?:string}, childFault?: "pose"|"name"|"unknown"|"reference-cache"|"missing"|"duplicate") {
  const h = await startHarness(registerCameraWitnessTools);
  const identity = { station:"lab",show:"test",profile:"14.19.1",config:"14.19.1.11.1",content:"14.19.1.11.1.1.1",window:"14.19.1.11.1.1.1.2",settings:"14.19.1.11.1.1.1.2.1",camera:"14.19.1.12.30",cameraName:"Witness Camera",previousCamera:"",pose:{POSX:0,POSY:-12,POSZ:5,PAN:0,TILT:10,ROLL:0,FOV:45} };
  let bound = false, saved:any = null;
  const previous = builtin ? `builtin:${builtin.display}` : "";
  const child = () => {
    const target=bound||childFault==="pose"||childFault==="name",name=childFault==="name"?"Wrong camera":target?identity.cameraName:"Front";
    return {class:"Camera",name,properties:[{name:"NAME",nilValue:false,value:name},...Object.entries(identity.pose).map(([name,value])=>({name,nilValue:false,value:name==="POSX"&&childFault==="pose"?123:target?value:value+1})),{name:"UNKNOWN",nilValue:false,value:bound&&childFault==="unknown"?"changed":"preserved"},{name:"UNKNOWN_REFERENCE",nilValue:false,value:{entries:[{keyType:"string",key:"addr",value:"opaque"},{keyType:"string",key:"class",value:"Opaque"},{keyType:"string",key:"childCount",value:bound&&childFault==="reference-cache"?2:1}]}}],children:[]};
  };
  const contents = () => [{screen:1,order:1,configuration:{class:"ViewWidget",name:"FixtureSheet",properties:[],children:[]}}, {screen:1,order:2,configuration:{class:"ViewWidget",name:"Window3D",properties:[{name:"W",value:8}],children:[{class:"View3DSettings",name:"View3DSettings",properties:[{name:"CAMERA",nilValue:!bound&&!builtin,...(bound?{value:{entries:[{keyType:"string",key:"addr",value:identity.camera},{keyType:"string",key:"class",value:"Camera"}]}}:builtin?{value:{entries:[{keyType:"string",key:"handleState",value:"builtin"},{keyType:"string",key:"edit",value:builtin.edit??""},{keyType:"string",key:"display",value:builtin.display}]}}:{})},{name:"AMBIENTINTENSITY",value:collateral&&bound?99:15}],children:childFault==="missing"?[]:childFault==="duplicate"?[child(),child()]:[child()]}]}}];
  h.fake.on("lua", a => {
    const code=String(a.code);
    if (code.includes("local expected=")) {
      if(failed) return {values:[{dispatched:true,uncertain:true,reason:"setter failed"}]};
      bound=true;
      return {values:[{dispatched:true,matched:true,snapshot:{...identity,previousCamera:identity.camera}}]};
    }
    return {values:[{snapshot:{...identity,previousCamera:bound?identity.camera:previous}}]};
  });
  h.fake.on("view.content", a => ({complete:true,nodes:3,contentJson:JSON.stringify(a.ref?saved:contents())}));
  h.fake.on("objects",a=>({total:saved?1:0,items:saved?[{class:"View",addr:"14.19.1.13.31",fields:{ScreenContentMask:1}}]:[]}));
  h.fake.onCommand(c=>{assert.equal(c,'Store View 31 /Screen "1" /NoConfirmation');saved=contents();return "OK";});
  return h;
}
const args={screen:1,window:2,camera:30};
test("camera witness previews exact window/settings/camera identity without assigning or saving", async()=>{
 const h=await setup();try {
  const r=await h.callJson("gma3_bind_camera_view",args);
  assert.equal(r.isError,false,JSON.stringify(r.result));assert.equal(r.result.preview,true);
  assert.match(r.result.expected_snapshot,/^[a-f0-9]{64}$/);
  assert.equal(h.fake.requests.filter(r=>r.op==="lua"&&String(r.args.code).includes("local expected=")).length,0);
  assert.deepEqual(h.fake.commands,[]);
 } finally {await h.close();}
});
test("camera witness checks complete settings and saves a create-only View with matching contents",async()=>{
 const h=await setup();try {
  const p=(await h.callJson("gma3_bind_camera_view",args)).result;
  const r=await h.callJson("gma3_bind_camera_view",{...args,view:31,preview:false,exclusive:true,expected_snapshot:p.expected_snapshot});
  assert.equal(r.isError,false,JSON.stringify(r.result));assert.equal(r.result.verification.status,"matched");
  assert.equal(r.result.witness.savedView,31);assert.equal(r.result.witness.pixelsVerified,false);
  assert.deepEqual(h.fake.commands,['Store View 31 /Screen "1" /NoConfirmation']);
 } finally {await h.close();}
});
test("camera witness refuses stale previews and catches unrelated native settings changes before saving",async()=>{
 const h=await setup(true);try {
  const stale=await h.callJson("gma3_bind_camera_view",{...args,preview:false,exclusive:true,expected_snapshot:"0".repeat(64)});
  assert.equal(stale.isError,true);assert.deepEqual(h.fake.commands,[]);
  const p=(await h.callJson("gma3_bind_camera_view",args)).result;
  const r=await h.callJson("gma3_bind_camera_view",{...args,view:31,preview:false,exclusive:true,expected_snapshot:p.expected_snapshot});
  assert.equal(r.isError,true);assert.equal(r.result.verification.status,"mismatched");assert.deepEqual(h.fake.commands,[]);
 } finally {await h.close();}
});
test("uncertain camera assignment is sent once and never followed by a View store",async()=>{
 const h=await setup(false,true);try {
  const p=(await h.callJson("gma3_bind_camera_view",args)).result;
  const r=await h.callJson("gma3_bind_camera_view",{...args,view:31,preview:false,exclusive:true,expected_snapshot:p.expected_snapshot});
  assert.equal(r.isError,true);assert.equal(r.result.outcome,"unknown");assert.deepEqual(h.fake.commands,[]);
  assert.equal(h.fake.requests.filter(r=>r.op==="lua"&&String(r.args.code).includes("local expected=")).length,1);
 } finally {await h.close();}
});
test("camera witness rejects a wrong coupled Camera pose/name even when that child did not change",async()=>{
 for(const fault of ["pose","name"] as const){
  const h=await setup(false,false,undefined,fault);try{
   const p=(await h.callJson("gma3_bind_camera_view",args)).result;
   const r=await h.callJson("gma3_bind_camera_view",{...args,view:31,preview:false,exclusive:true,expected_snapshot:p.expected_snapshot});
   assert.equal(r.isError,true,JSON.stringify(r.result));assert.equal(r.result.verification.status,"mismatched");assert.deepEqual(h.fake.commands,[]);
  }finally{await h.close();}
 }
});
test("camera witness preserves every unknown child property and refuses ambiguous Camera child coverage",async()=>{
 for(const fault of ["unknown","reference-cache","missing","duplicate"] as const){
  const h=await setup(false,false,undefined,fault);try{
   const p=await h.callJson("gma3_bind_camera_view",args);
   const r=p.isError?p:await h.callJson("gma3_bind_camera_view",{...args,view:31,preview:false,exclusive:true,expected_snapshot:p.result.expected_snapshot});
   assert.equal(r.isError,true,JSON.stringify(r.result));assert.deepEqual(h.fake.commands,[]);
  }finally{await h.close();}
 }
});
test("camera preview fingerprints ignore typed-map order but retain exact large integers",async()=>{
 const h=await setup(false,false,{display:"<Front>"});try{
  const original=h.fake.handlerFor("view.content")!;let reverse=false,large="9007199254740992";
  h.fake.on("view.content",(a,r)=>{const v=original(a,r) as any;const windows=JSON.parse(v.contentJson);if(reverse) windows[1].configuration.children[0].properties[0].value.entries.reverse();return {...v,contentJson:JSON.stringify(windows).replace('"value":15','"value":'+large)};});
  const first=(await h.callJson("gma3_bind_camera_view",args)).result;
  reverse=true;const reordered=(await h.callJson("gma3_bind_camera_view",args)).result;
  assert.equal(reordered.expected_snapshot,first.expected_snapshot);assert.equal(reordered.liveFingerprint,first.liveFingerprint);
  large="9007199254740993";const changed=(await h.callJson("gma3_bind_camera_view",args)).result;
  assert.notEqual(changed.expected_snapshot,first.expected_snapshot);assert.notEqual(changed.liveFingerprint,first.liveFingerprint);
 }finally{await h.close();}
});
test("a proved builtin Front state previews as a semantic marker and binds a real Camera once",async()=>{
 const h=await setup(false,false,{display:"<Front>"});try{
  const preview=await h.callJson("gma3_bind_camera_view",args);
  assert.equal(preview.isError,false,JSON.stringify(preview.result));assert.equal(preview.result.identity.previousCamera,"builtin:<Front>");
  const result=await h.callJson("gma3_bind_camera_view",{...args,preview:false,exclusive:true,expected_snapshot:preview.result.expected_snapshot});
  assert.equal(result.isError,false,JSON.stringify(result.result));assert.equal(result.result.verification.status,"matched");
  const native=result.result.steps.find((step:any)=>step.name==="assign_camera_once");assert.equal(native.kind,"mutation");assert.equal(native.detail.dispatched,true);assert.notEqual(native.detail.alreadyBound,true);
  assert.equal(h.fake.requests.filter(r=>r.op==="lua"&&String(r.args.code).includes("local expected=")).length,1);
 }finally{await h.close();}
});
test("unqualified builtin names and contradictory Edit handles refuse before any assignment",async()=>{
 for(const builtin of [{display:"<Back>"},{display:"<Front>",edit:"#DEAD"}]){
  const h=await setup(false,false,builtin);try{
   const preview=await h.callJson("gma3_bind_camera_view",args);assert.equal(preview.isError,true);
   assert.equal(h.fake.requests.filter(r=>r.op==="lua"&&String(r.args.code).includes("local expected=")).length,0);
  }finally{await h.close();}
 }
});
test("camera assignment and View store hold one server mutation span",async()=>{
 const h=await setup();try {
  const p=(await h.callJson("gma3_bind_camera_view",args)).result;
  const order:string[]=[];let concurrent:Promise<unknown>|undefined;
  const native=h.fake.handlerFor("lua")!;
  h.fake.on("lua",(a,r)=>{const result=native(a,r);if(String(a.code).includes("local expected=")) concurrent=h.ctx.mutations.run(async()=>{order.push("other");});return result;});
  const command=h.fake.handlerFor("cmd")!;
  h.fake.on("cmd",(a,r)=>{order.push("store");return command(a,r);});
  const result=await h.callJson("gma3_bind_camera_view",{...args,view:31,preview:false,exclusive:true,expected_snapshot:p.expected_snapshot});
  await concurrent;
  assert.equal(result.isError,false,JSON.stringify(result.result));
  assert.deepEqual(order,["store","other"]);
 }finally{await h.close();}
});

const lua=["lua5.4","lua54","lua",".test-tools/runtime/usr/bin/lua5.4"].find(bin=>spawnSync(bin,["-v"]).status===0);
test("fixed native camera chunk resolves hidden Edit handles, checks stale identity and does not reassign an existing binding",{skip:lua?false:"Lua interpreter unavailable"},()=>{
 const identity={station:"lab",show:"test",profile:"profile",config:"config",content:"content",window:"window",settings:"settings",camera:"camera",cameraName:"Witness Camera",previousCamera:"",pose:{POSX:0,POSY:-12,POSZ:5,PAN:0,TILT:10,ROLL:0,FOV:45}};
 const chunk=(expected?:typeof identity)=>`assert(load([====[${cameraBindingCode({...args,view:31},expected)}]====]))()`;
 const script=`
Enums={Roles={Edit=2,Display=1}}
local function object(class,address,fields)
 local h=fields or {};h.GetClass=function() return class end;h.Addr=function() return address end
 h.Lock="";h.SystemLocked=false;h.StructureLocked=false;return h
end
local calls,bound,badEdit,mode,rawValue=0,nil,false,"",nil
local camera=object("Camera","camera",{Name="Witness Camera",POSX=0,POSY=-12,POSZ=5,PAN=0,TILT=10,ROLL=0,FOV=45})
local settings=object("View3DSettings","settings",{
 PropertyCount=function() return 1 end,PropertyName=function() return "CAMERA" end,
 PropertyType=function() return "Handle" end,PropertyInfo=function() return {ReadOnly=false} end,
 Get=function(_,key,role) if role==2 then return badEdit and "#DEAD" or bound and "#F" or "" elseif role==1 then return bound and "Cam" or mode end;return rawValue end
})
setmetatable(settings,{__newindex=function(t,key,value) if key=="Camera" then bound=value;calls=calls+1 else rawset(t,key,value) end end})
local window=object("ViewWidget","window",{Name="Window3D",Ptr=function(_,index) assert(index==1);return settings end})
local content=object("ScreenContent","content",{Ptr=function(_,index) assert(index==2);return window end})
local config=object("ScreenConfiguration","config",{ScreenContents={Ptr=function(_,index) assert(index==1);return content end}})
CurrentProfile=function() return object("UserProfile","profile") end
CurrentScreenConfig=function() return config end
GetTopModal=function() return nil end
IsObjectValid=function(h) return h==camera end
StrToHandle=function(text) if text=="#F" then return camera end end
ObjectList=function(ref) if ref=="Camera 30" then return {camera} elseif ref=="View 31" then return {} end;error(ref) end
Root=function() return {MANetSocket={Get=function(_,key) return key=="HostName" and "lab" or "test" end}} end
local preview=${chunk()}
assert(preview.snapshot.previousCamera=="" and calls==0)
local applied=${chunk(identity)}
assert(applied.matched and applied.snapshot.previousCamera=="camera" and calls==1)
local again=${chunk({...identity,previousCamera:"camera"})}
assert(again.alreadyBound and again.dispatched==false and calls==1)
local stale=${chunk(identity)}
assert(stale.dispatched==false and not stale.alreadyBound and calls==1)
bound=nil;mode="<Front>"
local front=${chunk()}
assert(front.snapshot.previousCamera=="builtin:<Front>" and calls==1)
rawValue=camera
local contradictoryRaw=${chunk()}
assert(contradictoryRaw.dispatched==false and calls==1)
rawValue=nil
local frontAssigned=${chunk({...identity,previousCamera:"builtin:<Front>"})}
assert(frontAssigned.dispatched and frontAssigned.matched and frontAssigned.snapshot.previousCamera=="camera" and calls==2)
bound=nil;mode="<Back>"
local unqualified=${chunk()}
assert(unqualified.dispatched==false and calls==2)
mode="<Front>"
badEdit=true
local unknown=${chunk()}
assert(unknown.dispatched==false and unknown.reason:find("cannot resolve") and calls==2)
print("ALL PASSED")
`;
 const result=spawnSync(lua!,["-"],{input:script,encoding:"utf8"});
 assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/ALL PASSED/);
});
