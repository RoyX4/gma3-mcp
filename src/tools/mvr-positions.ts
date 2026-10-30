/** Stable-identity MVR translation revisions, applied through the existing placement engine. */
import {z} from 'zod';
import {dirname,resolve} from 'node:path';
import {inspectMvr} from '../mvr.js';
import {mvrDecisionSchema} from '../mvr-import.js';
import {qualifyMvrPositions} from '../mvr-positions.js';
import {verifyFreshMvrBefore,verifyMvrPositionResult} from '../mvr-position-verification.js';
import {checkNativeMvrSnapshot,nativeMvrSnapshotCode,nativeMvrSetCode,type NativeMvrSnapshot} from '../mvr-position-native.js';
import {readFastContext} from '../fastpath.js';
import {BridgeError,BridgeUnreachableError} from '../bridge.js';
import {HeldLock} from '../mutations.js';
import {nativeContentFingerprint} from '../native-cues.js';
import {observeCheckpoint,compareCheckpoints} from '../checkpoints/observer.js';
import {patchSnapshot} from '../jobs/dependencies.js';
import {withMvrWriterLease} from '../mvr-position-lease.js';
import {asRead,buildResult,notRequested,stepFromError,unavailable,type OperationResult,type StepResult} from '../results.js';
import {operation,type RegisterTools,type ToolContext} from './context.js';
import {exportMvr} from './mvr.js';
import {placeFixtures,type PlacementPropertyWriter} from './positions.js';
import {inDataPool} from './datapool.js';

const preserveSchema=z.object({sequences:z.array(z.number().int().min(1).max(99999)).max(32).default([]),presets:z.array(z.object({pool:z.number().int().min(1).max(9999),preset:z.number().int().min(1).max(99999)}).strict()).max(64).default([]),groups:z.array(z.number().int().min(1).max(99999)).max(64).default([]),data_pool:z.number().int().min(1).max(9999)}).strict();
const schema={before_file:z.string(),incoming_file:z.string(),decisions:z.array(mvrDecisionSchema).max(256),preview:z.boolean().default(true),expected_plan:z.string().regex(/^[a-f0-9]{64}$/).optional(),exclusive:z.boolean().optional(),mapped_to_drive1_mvr:z.boolean().optional(),before_export_file:z.string().optional(),after_export_file:z.string().optional(),preserve:preserveSchema.optional()};
type Args={before_file:string;incoming_file:string;decisions:z.infer<typeof mvrDecisionSchema>[];preview?:boolean;expected_plan?:string;exclusive?:boolean;mapped_to_drive1_mvr?:boolean;before_export_file?:string;after_export_file?:string;preserve?:z.infer<typeof preserveSchema>};
async function groups(ctx:ToolContext,args:Args){
 const rows:unknown[]=[];
 for(const group of args.preserve?.groups??[]){
  const row=await inDataPool(ctx,{data_pool:args.preserve!.data_pool}).bridge.request<Record<string,unknown>>('group.read',{ref:`Group ${group}`},ctx.requestTimeoutMs);
  if(row.truncated!==false || row.unreadable!==0 || !Array.isArray(row.items) || row.count!==row.items.length)throw new Error(`Complete Group ${group} preservation data unavailable`);
  rows.push(row);
 }
 return {rows,hash:nativeContentFingerprint(rows)};
}
function valueOf(raw:unknown):any {const first=(raw as {values?:unknown[]})?.values?.[0];if(!first || typeof first!=='object')throw new Error('Native position response unavailable');return first;}
export async function applyMvrPositions(ctx:ToolContext,args:Args):Promise<OperationResult>{
 const op='apply_mvr_positions',target={before:args.before_file,incoming:args.incoming_file};
 const steps:StepResult[]=[];
 let placement:OperationResult|undefined;
 try{
  const before=await inspectMvr(args.before_file),incoming=await inspectMvr(args.incoming_file),scope=qualifyMvrPositions(before,incoming,args.decisions);
  steps.push(asRead({name:'inspect_position_scope',status:'succeeded',detail:{scope:scope.scope,planFingerprint:scope.plan.fingerprint,errors:scope.errors}}));
  if(!scope.executable)throw new Error(scope.errors.join('; '));
  if(args.preview!==false)return buildResult({operation:op,target,steps,verification:notRequested(),extra:{preview:true,consoleChanged:false,expected_plan:scope.plan.fingerprint,targets:scope.targets,scope:scope.scope,rawSources:{before:before.archive,incoming:incoming.archive},rawAssets:{before:before.assets,incoming:incoming.assets},preservation:args.preserve??null}});
  if(args.exclusive!==true || args.mapped_to_drive1_mvr!==true || args.expected_plan!==scope.plan.fingerprint || !args.before_export_file || !args.after_export_file)throw new Error('Apply requires exclusive:true, mapped_to_drive1_mvr:true, unchanged expected_plan, and two new before_export_file/after_export_file paths');
  if(!ctx.luaToolAllowed)throw new Error('The fixed atomic UUID position writer requires console Lua enabled');
  if(resolve(args.before_export_file)===resolve(args.after_export_file) || dirname(resolve(args.before_export_file))!==dirname(resolve(args.after_export_file)))throw new Error('Fresh before/after outputs require distinct paths in the same explicitly mapped MVR folder');
  return await ctx.mutations.run(async()=>{
   const context=await readFastContext(ctx.bridge,ctx.requestTimeoutMs);
   if(!context.contextKey || context.identityUncertain?.length || context.environment!=='Normal')throw new Error('Complete Normal console identity required');
   return withMvrWriterLease({...ctx,mutations:new HeldLock()},context.contextKey,async held=>{
   const ensureContext=async()=>{const current=await readFastContext(held.bridge,ctx.requestTimeoutMs);if(current.contextKey!==context.contextKey || current.identityUncertain?.length || current.environment!=='Normal')throw new Error('Console context changed; nothing further was dispatched');};
   // Pin native type/mode/patch/rotation before the before-export witness. A later
   // native change must be refused by the write guard, never adopted as its baseline.
   const native=checkNativeMvrSnapshot(valueOf(await held.bridge.request('lua',{code:nativeMvrSnapshotCode()},ctx.requestTimeoutMs)),context);
   const exported=await exportMvr(held,{file:args.before_export_file!,dry_run:false,exclusive:true,mapped_to_drive1_mvr:true});steps.push(...exported.steps.map(s=>({...s,name:'before_'+s.name})));
   if(exported.outcome!=='succeeded' || exported.verification.status!=='matched')return buildResult({operation:op,target,steps,verification:unavailable('Fresh before export failed; no position writes attempted')});
   await ensureContext();
   const observedBefore=await inspectMvr(args.before_export_file!),matches=verifyFreshMvrBefore(before,observedBefore);
   steps.push(asRead({name:'compare_fresh_before',status:matches.status==='matched'?'succeeded':'failed',detail:matches}));
   if(matches.status!=='matched')return buildResult({operation:op,target,steps,verification:matches,extra:{positionWritesAttempted:false}});
   const sourceFixtures=before.objects.filter(o=>o.kind==='Fixture');
   if(sourceFixtures.length!==native.fixtures.length)throw new Error('Fresh native complete fixture set differs from MVR');
   for(const fixture of sourceFixtures){const row=native.fixtures.find(r=>r.uuid===fixture.uuid);if(!row || String(row.fid)!==fixture.fixtureId || row.name!==fixture.name || [row.x,row.y,row.z].some((n,i)=>Math.abs(n-fixture.worldMatrix[i*4+3]/1000)>1e-8))throw new Error(`Native UUID/FID/pose differs for ${fixture.uuid}`);}
   const preservationScope={sequences:args.preserve?.sequences??[],presets:args.preserve?.presets??[],views:[],cameras:[],...(args.preserve?{data_pool:args.preserve.data_pool}:{}),include_patch:false,include_dmx_output:true};
   const checkpointBefore=await observeCheckpoint(held,preservationScope,'MVR positions before'),groupsBefore=await groups(held,args),patchBefore=await patchSnapshot(held);
   if(!checkpointBefore.complete)throw new Error('Complete requested programming/output preservation checkpoint unavailable');
   if(!patchBefore.complete)throw new Error('Complete native shared patch-collection preservation witness unavailable');
   const expected:NativeMvrSnapshot=structuredClone(native),selected=new Map(scope.targets.map(t=>[Number(t.fid),t]));
   const write:PlacementPropertyWriter=async({fid,property,value,timeoutMs})=>{
    const planned=selected.get(fid);if(!planned || !['POSX','POSY','POSZ'].includes(property) || typeof value!=='number')throw new BridgeError('Unplanned MVR placement write refused','lua',false);
    const axis=property.slice(3).toLowerCase() as 'x'|'y'|'z',index=['x','y','z'].indexOf(axis);
    if(Math.abs(value-planned.incoming[index])>0.0000051)throw new BridgeError('Placement value differs from MVR plan','lua',false);
    await ensureContext();
    let result:any;
    try{result=valueOf(await held.bridge.request('lua',{code:nativeMvrSetCode(expected,planned.uuid,property,value)},timeoutMs));}
    catch(error){if(error instanceof BridgeUnreachableError)throw error;throw new BridgeError(error instanceof Error?error.message:String(error),'lua',true);}
    if(result.dispatched===false)throw new BridgeError(result.reason??'Atomic UUID guard refused the write','lua',false);
    if(result.dispatched!==true || result.uncertain || result.uuid!==planned.uuid || result.property!==property || typeof result.value!=='number' || Math.abs(result.value-value)>1e-8)throw new BridgeError(result.reason??'UUID position write was not confirmed','lua',true);
    expected.fixtures.find(r=>r.uuid===planned.uuid)![axis]=result.value;
    return result;
   };
   const placed=await placeFixtures(held,{unit:'m',placements:scope.targets.map(t=>({fid:Number(t.fid),position:{x:t.incoming[0],y:t.incoming[1],z:t.incoming[2]}}))},write);
   placement=placed;
   steps.push(...placed.steps.map(s=>({...s,name:'placement_'+s.name})));
   // Observe even partial/uncertain delivery; the original mutation outcome remains authoritative.
   await ensureContext();
   const post=await exportMvr(held,{file:args.after_export_file!,dry_run:false,exclusive:true,mapped_to_drive1_mvr:true});steps.push(...post.steps.map(s=>({...s,name:'after_'+s.name})));
   const checkpointAfter=await observeCheckpoint(held,preservationScope,'MVR positions after'),groupsAfter=await groups(held,args),patchAfter=await patchSnapshot(held),preservation=compareCheckpoints(checkpointBefore,checkpointAfter),groupsMatched=groupsBefore.hash===groupsAfter.hash;
   const sharedPatch=(p:typeof patchBefore)=>p.patch.filter((r:any)=>r.collection!=='Stages');
   const sharedPatchMatched=patchAfter.complete && nativeContentFingerprint(sharedPatch(patchBefore))===nativeContentFingerprint(sharedPatch(patchAfter));
   await ensureContext();
   const verification=post.outcome==='succeeded' && post.verification.status==='matched'?verifyMvrPositionResult(scope.plan,before,await inspectMvr(args.after_export_file!)):unavailable('Fresh post export could not be certified');
   if(!preservation.matched || !groupsMatched || !sharedPatchMatched){verification.status='mismatched';verification.detail=[verification.detail,'Requested programming, configured output or shared native patch-collection preservation differed'].filter(Boolean).join('; ');}
   steps.push(asRead({name:'compare_fresh_post',status:verification.status==='matched'?'succeeded':'failed',detail:verification,...(verification.status!=='matched'?{error:verification.detail??'Complete post-export proof unavailable'}:{})}));
   steps.push(asRead({name:'compare_requested_preservation',status:preservation.matched && groupsMatched && sharedPatchMatched?'succeeded':'failed',detail:{preservation,groupsMatched,sharedPatchMatched,before:patchBefore,after:patchAfter}}));
   return buildResult({operation:op,target,steps,verification,extra:{preview:false,scope:scope.scope,planFingerprint:scope.plan.fingerprint,restore:placed.restore,placementOutcome:placed.outcome,rawSources:{before:before.archive,incoming:incoming.archive,freshBefore:observedBefore.archive},rawAssets:{before:before.assets,incoming:incoming.assets,freshBefore:observedBefore.assets},beforeNormalization:matches.normalizations,preservation:{checkpoint:preservation,groupsMatched,sharedPatchMatched,targets:args.preserve??null},observedFiles:{before:args.before_export_file,after:args.after_export_file}},warnings:['Only the complete inspected MVR fields and explicitly requested programming targets are compared; unknown XML extensions and unrequested show programming are outside this proof.','Direct live fixture positions have no Oops undo; restore lists previous positions. Unknown or partial writes are observed and never replayed or automatically undone.','MA synthetic Fixture Layer UUID and GDTF ZIP metadata normalization are reported explicitly; fixture UUID identity remains strict.']});
   });
  });
 }catch(error){steps.push(asRead({...stepFromError('mvr_positions',error),status:'failed'}));return buildResult({operation:op,target,steps,verification:unavailable(error instanceof Error?error.message:String(error)),extra:{...(placement?{restore:placement.restore,placementOutcome:placement.outcome,placementReceipt:placement}:{}),...(error && typeof error==='object' && 'mvrWriterLease'in error?{writerLease:error.mvrWriterLease}:{}),observedFiles:{before:args.before_export_file??null,after:args.after_export_file??null}}});}
}
export const registerMvrPositionTools:RegisterTools=(server,ctx)=>{
 server.registerTool('gma3_apply_mvr_positions',{title:'Apply selected MVR positions by persistent fixture UUID',description:'Preview by default. Narrow stable UUID/FID/name/type/mode/geometry revisions: selected incoming world translations only; retain local DMX and all unmentioned fixture positions. No PSR conversion, add/remove, renumber, rotation, type or scene changes. Apply requires unchanged expected_plan, exclusive:true, explicit Drive1 filesystem mapping and two new export paths. Fresh before/post MVRs, atomic UUID/context/pose guards on every native Set, existing placement readback, configured-output preservation and optional explicit cue/preset/group preservation. Refuses uncertain source/parent/asset identity. Requires console Lua. Does not save the show. See detailed normalization and scope limitations in result.',inputSchema:schema},args=>operation(()=>applyMvrPositions(ctx,args)));
};
