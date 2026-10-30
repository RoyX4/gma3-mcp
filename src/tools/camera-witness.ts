/** Bind an explicitly identified native 3D window to a Camera; retain a scoped configuration witness. */
import { z } from "zod";
import { nativeContentFingerprint } from "../native-cues.js";
import { HeldLock } from "../mutations.js";
import { asRead, buildResult, notRequested, stepFromError, unavailable, type OperationResult, type StepResult, type Verification } from "../results.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { compareViewContent, readViewContent, viewContentFingerprint, viewContentWindows, type ViewContent } from "./view-content.js";
import { storeView } from "./views.js";

interface Args { screen:number; window:number; camera:number; view?:number; preview?:boolean; exclusive?:boolean; expected_snapshot?:string }
interface Snapshot { station:string; show:string; profile:string; config:string; content:string; window:string; settings:string; camera:string; cameraName:string; previousCamera:string; pose:Record<string,number> }
const POSE=["POSX","POSY","POSZ","PAN","TILT","ROLL","FOV"];
const BUILTIN_FRONT="builtin:<Front>";
function luaValue(value:unknown):string {
  if(typeof value==="string") return '"'+Array.from(Buffer.from(value,"utf8"),byte=>'\\'+String(byte).padStart(3,"0")).join("")+'"';
  if(typeof value==="number" && Number.isFinite(value)) return String(value);
  if(value && typeof value==="object" && !Array.isArray(value)) return "{"+Object.entries(value).map(([key,v])=>`[${luaValue(key)}]=${luaValue(v)}`).join(",")+"}";
  throw new Error("Unsupported fixed camera argument");
}
/** The writable Handle property was observed on native View3DSettings, not inferred from the focused UI window. */
export function cameraBindingCode(args:Pick<Args,"screen"|"window"|"camera"|"view">, expected?:Snapshot):string {
  return `local a=${luaValue(args)}
local function addr(h) if h==nil then return "" end; return h:Addr() end
local function cameraRef(settings)
 local h=settings.Camera
 if h~=nil then assert(IsObjectValid(h) and h:GetClass()=="Camera","Invalid raw CAMERA reference");return addr(h) end
 local edit,display=settings:Get("Camera",Enums.Roles.Edit),settings:Get("Camera",Enums.Roles.Display)
 local empty=edit==nil or edit=="" or (type(edit)=="string" and edit:match("^#0+$"))
 if empty and (display==nil or display=="") then return "" end
 -- Qualified View3DSettings default mode, not an absent camera or a pool address.
 if edit=="" and display=="<Front>" and settings:Get("Camera")==nil then return ${luaValue(BUILTIN_FRONT)} end
 assert(type(edit)=="string" and edit:match("^#%x+$") and not empty,"CAMERA Edit identity is unreadable")
 h=StrToHandle(edit);assert(h and IsObjectValid(h) and h:GetClass()=="Camera","CAMERA Edit reference cannot resolve to a valid Camera")
 return addr(h)
end
local function unlocked(h)
 for _,key in ipairs({"Lock","SystemLocked","StructureLocked"}) do
  local v=h[key]; assert(v==false or v==0 or v=="" or v=="No","Object locked or lock state unreadable: "..key)
 end
end
local function snapshot()
 assert(not GetTopModal(),"A modal dialog is open")
 local profile=assert(CurrentProfile(),"Profile unavailable")
 local config=assert(CurrentScreenConfig(),"Screen configuration unavailable")
 local content=assert(config.ScreenContents:Ptr(a.screen),"Screen content unavailable")
 local window=assert(content:Ptr(a.window),"Explicit window unavailable")
 assert(window:GetClass()=="ViewWidget" and window.Name=="Window3D","Explicit window is not Window3D")
 local settings=assert(window:Ptr(1),"3D settings unavailable")
 assert(settings:GetClass()=="View3DSettings","Explicit window has unexpected settings class")
 unlocked(settings)
 local writable=false
 for i=0,settings:PropertyCount()-1 do
  if settings:PropertyName(i):upper()=="CAMERA" then
   local info=settings:PropertyInfo(i);writable=settings:PropertyType(i)=="Handle" and info.ReadOnly==false
  end
 end
 assert(writable,"Native CAMERA property is not a writable Handle")
 local found=ObjectList("Camera "..a.camera)
 assert(found and #found==1 and found[1]:GetClass()=="Camera","Exact Camera unavailable")
 local camera=found[1];unlocked(camera)
 local cameraName=camera.Name;assert(type(cameraName)=="string" and cameraName~="","Camera name unreadable")
 local pose={}
 for _,key in ipairs({"POSX","POSY","POSZ","PAN","TILT","ROLL","FOV"}) do
  local n=tonumber(camera[key]);assert(n and n==n and math.abs(n)~=math.huge,"Camera pose unreadable: "..key);pose[key]=n
 end
 local socket=Root().MANetSocket
 local station,show=socket:Get("HostName"),socket:Get("ShowFile")
 assert(type(station)=="string" and station~="" and type(show)=="string" and show~="","Station/show unavailable")
 return {station=station,show=show,profile=addr(profile),config=addr(config),content=addr(content),window=addr(window),settings=addr(settings),camera=addr(camera),cameraName=cameraName,previousCamera=cameraRef(settings),pose=pose},settings,camera
end
local ok,before,settings,camera=pcall(snapshot)
if not ok then return {dispatched=false,reason=tostring(before)} end
${expected ? `local expected=${luaValue(expected)}
for key,value in pairs(expected) do
 if key=="pose" then for field,n in pairs(value) do if before.pose[field]~=n then return {dispatched=false,reason="Camera pose changed; preview again"} end end
 elseif before[key]~=value then return {dispatched=false,reason="Native identity or camera reference changed; preview again"} end
end
if a.view then local views=ObjectList("View "..a.view);if views and #views>0 then return {dispatched=false,reason="Requested View already exists"} end end
if before.previousCamera==before.camera then return {dispatched=false,matched=true,alreadyBound=true,snapshot=before} end
local sent,why=pcall(function() settings.Camera=camera end)
if not sent then return {dispatched=true,uncertain=true,reason=tostring(why)} end
local read,after=pcall(snapshot)
if not read then return {dispatched=true,uncertain=true,reason=tostring(after)} end
return {dispatched=true,matched=after.previousCamera==before.camera,snapshot=after}` : "return {snapshot=before}"}
`;
}
function checkedSnapshot(raw:unknown):Snapshot {
 const s=raw as Snapshot;
 if(!s || ["station","show","profile","config","content","window","settings","camera","cameraName"].some(k=>typeof s[k as keyof Snapshot]!=="string" || !s[k as keyof Snapshot]) || typeof s.previousCamera!=="string" || !s.pose || POSE.some(k=>!Number.isFinite(s.pose[k]))) throw new Error("Complete native camera/window identity, name and pose are unavailable");
 return s;
}
async function bindingSnapshot(ctx:ToolContext,args:Args,expected?:Snapshot):Promise<{snapshot?:Snapshot;dispatched?:boolean;matched?:boolean;uncertain?:boolean;alreadyBound?:boolean;reason?:string}> {
 const reply=await ctx.bridge.request<{values?:any[]}>("lua",{code:cameraBindingCode({screen:args.screen,window:args.window,camera:args.camera,...(args.view?{view:args.view}:{})},expected)},ctx.requestTimeoutMs);
 const result=reply?.values?.[0];if(!result || typeof result!=="object") throw new Error("Native camera binding reply is malformed");
 if(result.snapshot) result.snapshot=checkedSnapshot(result.snapshot);
 return result;
}
function settingsIn(windows:Array<Record<string,any>>,args:Args):any {
 const window=windows.filter(w=>JSON.stringify(w.screen)===String(args.screen))[args.window-1];
 if(!window || window.configuration?.name!=="Window3D" || window.configuration?.class!=="ViewWidget") throw new Error("Complete configuration does not identify the explicit Window3D");
 const settings=window.configuration.children?.[0];
 if(settings?.class!=="View3DSettings" || !Array.isArray(settings.properties) || settings.properties.filter((p:any)=>p.name==="CAMERA").length!==1) throw new Error("Complete native View3DSettings CAMERA field is unavailable");
 return settings;
}
function settingsOf(content:ViewContent,args:Args):any { return settingsIn(viewContentWindows(content),args); }
function cameraAddress(content:ViewContent,args:Args):string {
 const property=settingsOf(content,args).properties.find((p:any)=>p.name==="CAMERA");
 if(property.nilValue===true) return "";
 const entries=property.value?.entries;
 if(!Array.isArray(entries)) throw new Error("Native CAMERA reference is unreadable");
 if(entries.some((entry:any)=>entry.key==="handleState")) {
  const names=new Set(["handleState","edit","display"]),values=new Map<string,unknown>();
  for(const entry of entries) {
   if(!entry || typeof entry!=="object" || Object.keys(entry).length!==3 || entry.keyType!=="string" || !names.has(entry.key) || values.has(entry.key)) throw new Error("Native builtin CAMERA representation is malformed");
   values.set(entry.key,entry.value);
  }
  if(property.nilValue===false && values.size===3 && values.get("handleState")==="builtin" && values.get("edit")==="" && values.get("display")==="<Front>") return BUILTIN_FRONT;
  throw new Error("Native builtin CAMERA mode is unqualified");
 }
 const address=entries.find((entry:any)=>entry.key==="addr")?.value;
 if(typeof address!=="string" || !address) throw new Error("Native CAMERA reference has no exact address");
 return address;
}
function cameraChild(settings:any):any {
 const child=settings.children?.[0];
 if(!Array.isArray(settings.children) || settings.children.length!==1 || child?.class!=="Camera" || typeof child.name!=="string" || !Array.isArray(child.children) || child.children.length!==0 || !Array.isArray(child.properties)) throw new Error("Exact single embedded Camera child is unavailable");
 for(const key of ["NAME",...POSE]) {
  const fields=child.properties.filter((p:any)=>p.name===key);
  if(fields.length!==1 || fields[0].nilValue!==false || (key==="NAME"?typeof fields[0].value!=="string":!Number.isFinite(Number(JSON.stringify(fields[0].value))))) throw new Error("Complete embedded Camera field is unavailable: "+key);
 }
 return child;
}
function coupledCameraMatches(content:ViewContent,args:Args,snapshot:Snapshot):boolean {
 const child=cameraChild(settingsOf(content,args));
 return child.name===snapshot.cameraName && child.properties.find((p:any)=>p.name==="NAME").value===snapshot.cameraName && POSE.every(key=>Number(JSON.stringify(child.properties.find((p:any)=>p.name===key).value))===snapshot.pose[key]);
}
/** Mask only the declared, separately verified reference/name/pose values; retain metadata and unknown fields. */
function withoutCoupledCamera(content:ViewContent,args:Args):ViewContent {
 const windows=viewContentWindows(content),node=settingsIn(windows,args),child=cameraChild(node);
 const reference=node.properties.find((p:any)=>p.name==="CAMERA");
 reference.value="intended Camera reference";reference.nilValue=false;
 child.name="intended Camera name";
 for(const field of child.properties) if(field.name==="NAME" || POSE.includes(field.name)) field.value="intended Camera "+field.name;
 return {...content,contentJson:JSON.stringify(windows)};
}
async function bind(ctx:ToolContext,args:Args):Promise<OperationResult> {
 const op="bind_camera_view",target={screen:args.screen,window:args.window,camera:args.camera,scope:"current user profile"};
 let resulting:ViewContent|undefined, snapshot:Snapshot|undefined;
 const result=await ctx.mutations.run(async()=>{
  const steps:StepResult[]=[];
  try {
   const native=await bindingSnapshot(ctx,args);
   if(!native.snapshot) throw new Error(native.reason??"Native snapshot unavailable");
   snapshot=native.snapshot;
   const before=await readViewContent(ctx,{screens:[args.screen]});
   if(cameraAddress(before,args)!==snapshot.previousCamera) throw new Error("Native settings/reference reads disagree; preview again");
   cameraChild(settingsOf(before,args));
   const fingerprint=nativeContentFingerprint({identity:snapshot,configuration:{kind:"live_screens",contentJson:before.contentJson}});
   steps.push(asRead({name:"inspect_explicit_camera_window",status:"succeeded",op:"lua",detail:snapshot}));
   if(args.preview!==false) return buildResult({operation:op,target,steps,verification:notRequested(),extra:{preview:true,expected_snapshot:fingerprint,identity:snapshot,liveFingerprint:viewContentFingerprint(before),plannedChanges:{reference:snapshot.camera,cameraChild:{name:snapshot.cameraName,pose:snapshot.pose}},plannedView:args.view??null}});
   if(args.exclusive!==true || args.expected_snapshot!==fingerprint) throw new Error("Apply requires exclusive:true and the unchanged expected_snapshot from preview");
   let applied;
   try { applied=await bindingSnapshot(ctx,args,snapshot); }
   catch(err) { steps.push(stepFromError("assign_camera_once",err,{op:"lua"}));return buildResult({operation:op,target,steps,verification:unavailable("Assignment delivery or readback is unknown; no retry or View store was attempted")}); }
   const postIdentity=applied.snapshot?nativeContentFingerprint({...applied.snapshot,previousCamera:snapshot.previousCamera}):null;
   const status=applied.uncertain?"unknown":(applied.dispatched===true || applied.alreadyBound===true) && applied.matched && postIdentity===nativeContentFingerprint(snapshot)?"succeeded":"failed";
   steps.push({name:"assign_camera_once",kind:applied.alreadyBound?"read":"mutation",status,op:"lua",detail:applied,...(status!=="succeeded"?{error:applied.reason??"Native camera assignment did not match"}:{})});
   if(status!=="succeeded") return buildResult({operation:op,target,steps,verification:unavailable("Native assignment was not confirmed")});
   resulting=await readViewContent(ctx,{screens:[args.screen]});
   const preserved=viewContentFingerprint(withoutCoupledCamera(before,args))===viewContentFingerprint(withoutCoupledCamera(resulting,args));
   const matched=cameraAddress(resulting,args)===snapshot.camera && coupledCameraMatches(resulting,args,snapshot) && preserved;
   const verification:Verification={status:matched?"matched":"mismatched",checked:"exact Camera reference, embedded Camera name/seven pose values and every other persisted explicit-screen setting",...(matched?{}:{detail:"The Camera reference or coupled name/pose differs, or unrelated window settings changed"})};
   return buildResult({operation:op,target,steps,verification,extra:{preview:false,identity:snapshot}});
  } catch(err) {steps.push(asRead({...stepFromError("camera_witness",err),status:"failed"}));return buildResult({operation:op,target,steps,verification:unavailable("Complete camera witness unavailable")});}
 });
 if(args.preview!==false || result.verification.status!=="matched" || !resulting || !snapshot) return result;
 let verification=result.verification;const steps=[...result.steps];let saved:ViewContent|undefined;
 if(args.view!==undefined) {
  const stored=await storeView(ctx,{view:args.view,screens:[args.screen]});steps.push(...stored.steps.map(s=>({...s,name:`view_${s.name}`})));
  if(stored.outcome!=="succeeded" || stored.verification.status!=="matched") verification=stored.verification.status==="matched"?unavailable("View store failed after camera binding"):stored.verification;
  else try {saved=await readViewContent(ctx,{ref:`View ${args.view}`});verification=compareViewContent(resulting,saved);if(cameraAddress(saved,args)!==snapshot.camera) verification={status:"mismatched",checked:"saved View camera binding",detail:"Saved View does not reference the exact Camera"};}
  catch(err) {steps.push(asRead(stepFromError("read_saved_camera_witness",err)));verification=unavailable("Saved camera witness could not be read");}
 }
 return buildResult({operation:op,target,steps,verification,warnings:["Configuration references, embedded Camera name and pose are verified. Pixels, renderer freshness, occlusion, physical output and physical clearance are not verified.","Another operator or client can change windows between reads or the separate create-only View store; final comparison reports observed differences. Nothing is retried or automatically undone."],extra:{preview:false,witness:{station:snapshot.station,show:snapshot.show,profile:snapshot.profile,window:snapshot.window,settings:snapshot.settings,camera:snapshot.camera,cameraName:snapshot.cameraName,pose:snapshot.pose,savedView:args.view??null,liveFingerprint:viewContentFingerprint(resulting),savedFingerprint:saved?viewContentFingerprint(saved):null,pixelsVerified:false,physicalOutputVerified:false}}});
}
export const registerCameraWitnessTools:RegisterTools=(server,ctx)=>{
 server.registerTool("gma3_bind_camera_view",{
  title:"Bind an exact 3D window to a Camera and save a configuration witness",
  description:"Preview by default. Inspects one explicit native screen/window index, View3DSettings CAMERA Handle and exact Camera pose. The proved nil-Raw/empty-Edit/Front-display default is represented as builtin:<Front>, never a guessed pool address; other unreadable builtin modes refuse. Apply requires exclusive:true and unchanged expected_snapshot; rechecks native identities/pose/reference in the assignment chunk and sends the typed Handle assignment once. Declares and verifies the native coupled embedded Camera name/POSX/POSY/POSZ/PAN/TILT/ROLL/FOV update against the exact target camera. Preserves every other persisted window setting and unknown Camera child field. Optional view creates a new saved View (never overwrites) and checks full saved settings/reference. Does not select a focused window, record, play or change the programmer. Witness hashes cover configuration, not screenshot pixels, renderer freshness, native occlusion or physical safety. Requires console Lua enabled and view.content support.",
  inputSchema:{screen:z.number().int().min(1).max(7),window:z.number().int().min(1).max(50),camera:z.number().int().min(1).max(99999),view:z.number().int().min(1).max(99999).optional(),preview:z.boolean().default(true),exclusive:z.boolean().optional(),expected_snapshot:z.string().regex(/^[a-f0-9]{64}$/).optional()},
 },args=>operation(()=>ctx.mutations.run(()=>bind({...ctx,mutations:new HeldLock()},args))));
};
