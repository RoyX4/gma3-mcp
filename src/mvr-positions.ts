/** Qualified apply boundary for stable-identity MVR position revisions. */
import type {MvrInventory,MvrObject} from './mvr.js';
import {planMvrImport,type MvrDecision,type MvrImportPlan} from './mvr-import.js';
import {nativeContentFingerprint} from './native-cues.js';
import {mvrAssetManifest} from './mvr-position-verification.js';

export interface MvrPositionTarget {uuid:string;fid:string;before:[number,number,number];incoming:[number,number,number]}
export interface MvrPositionScope {executable:boolean;errors:string[];targets:MvrPositionTarget[];plan:MvrImportPlan;scope:string}
const identity=[1,0,0,0,0,1,0,0,0,0,1,0];
const same=(a:unknown,b:unknown)=>nativeContentFingerprint(a)===nativeContentFingerprint(b);
const fixtures=(inventory:MvrInventory)=>new Map(inventory.objects.filter(o=>o.kind==='Fixture').map(o=>[o.uuid,o]));
const position=(f:MvrObject):[number,number,number]=>[f.worldMatrix[3]/1000,f.worldMatrix[7]/1000,f.worldMatrix[11]/1000];

/** Additional native PSR cases stay refused until their independent qualification exists. */
export function qualifyMvrPositions(before:MvrInventory,incoming:MvrInventory,decisions:unknown):MvrPositionScope {
 const plan=planMvrImport(before,incoming,decisions),errors=[...plan.errors],targets:MvrPositionTarget[]=[];
 const current=fixtures(before),next=fixtures(incoming);
 if(!current.size || current.size>256 || current.size!==next.size || [...current.keys()].some(uid=>!next.has(uid))) errors.push('Position apply requires the same complete set of 1-256 fixture UUIDs; add/remove is unqualified.');
 if(!same(mvrAssetManifest(before),mvrAssetManifest(incoming))) errors.push('Changed embedded GDTF/mesh assets are outside position-only application.');
 const scene=(inventory:MvrInventory)=>inventory.objects.filter(o=>o.kind!=='Fixture').sort((a,b)=>a.uuid.localeCompare(b.uuid));
 if(!same(scene(before),scene(incoming))) errors.push('Non-fixture scene changes are outside position-only application.');
 const objects=new Map(before.objects.map(item=>[item.uuid,item]));
 for(const fixture of current.values()){
  const seen=new Set<string>();let parent=fixture.parent;
  while(parent){const item=objects.get(parent);if(!item || seen.has(parent)){errors.push(`${fixture.uuid}: fixture ancestor is absent or cyclic.`);break;}seen.add(parent);if(item.kind==='Fixture')errors.push(`${fixture.uuid}: nested fixture ancestry is unqualified.`);if(!same(item.matrix,identity))errors.push(`Fixture ancestor ${item.uuid} has an unqualified nonidentity transform.`);parent=item.parent;}
 }
 for(const [uid,old]of current){
  const proposed=next.get(uid);if(!proposed)continue;
  for(const key of ['fixtureId','name','gdtfSpec','gdtfMode','parent','geometryHash']as const) if(!same(old[key],proposed[key])) errors.push(`${uid}: changing ${key} is outside stable-identity position application.`);
  if(!/^[1-9]\d*$/.test(old.fixtureId) || !Number.isSafeInteger(Number(old.fixtureId)) || Number(old.fixtureId)>99999999 || before.fixtureIdConflicts[old.fixtureId] || incoming.fixtureIdConflicts[old.fixtureId]) errors.push(`${uid}: unique source FIDs in 1-99999999 are required.`);
  if(old.parent && current.has(old.parent)) errors.push(`${uid}: nested fixture transforms are unqualified.`);
 }
 for(const decision of plan.decisions as MvrDecision[]){
  if(decision.source!=='local' || (decision.patch!==undefined && decision.patch!=='local')) errors.push(`${decision.uuid}: this apply route retains local identity/type/patch; use review-only planning for other decisions.`);
  if(decision.transform!=='incoming')continue;
  const old=current.get(decision.uuid),proposed=next.get(decision.uuid);
  if(!old || !proposed)continue;
  if(position(proposed).some(n=>!Number.isFinite(n) || Math.abs(n)>100000))errors.push(`${decision.uuid}: incoming positions must be finite and within the qualified placement range of +/-100000 metres.`);
  if(old.worldMatrix.length!==12 || proposed.worldMatrix.length!==12 || old.worldMatrix.some((n,i)=>!Number.isFinite(n) || !Number.isFinite(proposed.worldMatrix[i]) || i%4!==3 && Math.abs(n-proposed.worldMatrix[i])>1e-8)) errors.push(`${decision.uuid}: basis/rotation/scale changes are outside position-only application.`);
  if(!position(old).every((n,i)=>Math.abs(n-position(proposed)[i])<1e-8)) targets.push({uuid:decision.uuid,fid:old.fixtureId,before:position(old),incoming:position(proposed)});
 }
 if(!targets.length) errors.push('No changed incoming position was explicitly selected; a no-op does not run PSR conversion.');
 return {executable:errors.length===0,errors:[...new Set(errors)],targets,plan,scope:'stable UUID/FID/name/type/mode/geometry, unchanged nonfixture scene and assets; explicitly selected incoming positions, retaining local DMX patch and all unmentioned local fixtures'};
}
