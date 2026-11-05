import { readFastContext } from "../fastpath.js";
import type { ToolContext } from "../tools/context.js";
import type { Compilation } from "../tracking/model.js";
import type { Observation, RequestTiming } from "./engine.js";
import { observeSequence, timedBridge } from "./runtime.js";

const collection = (value:unknown):value is Record<string,unknown> => value !== null && typeof value === "object";
const empty = (value:unknown) => collection(value) && Object.keys(value).length === 0;

/** Read every supported ownership route. Disabled modules must still provide their empty status schemas. */
async function safety(ctx:ToolContext) {
  const request = <T=Record<string,any>>(op:string,args:Record<string,unknown>={}) => ctx.bridge.request<T>(op,args,ctx.requestTimeoutMs);
  const lease=await request("fast.lease",{action:"status"});
  const input=await request("input.status"), control=await request("control.status");
  const batches=await request("fast.batch",{action:"list"}), patch=await request("patch.state");
  const normal=await request("programmer",{scope:"all",limit:1,maxChannels:50000});
  const status=input.status;
  const inputIdle=collection(status) && empty(status.sessions) && empty(status.holds)
    && collection(status.capacity) && status.capacity.used===0 && status.unresolved===0 && status.retained===0 && status.quarantined===0
    && !status.busy && !status.activeInteraction && !status.modeChange && !status.exclusiveHold
    && collection(status.interactions) && Object.values(status.interactions).every((v:any)=>v?.state!=="open")
    && (!status.sequence || (collection(status.sequence) && status.sequence.state!=="running")) && empty(input.unresolvedFromPreviousRun);
  const controlIdle=empty(control.sessions) && empty(control.unresolved) && empty(control.unresolvedFromPreviousRun) && !control.busy;
  const batchesIdle=Array.isArray(batches.batches) && batches.batches.every((batch:any)=>collection(batch) && !Array.isArray(batch)
    && typeof batch.id === "string" && batch.id.length > 0 && typeof batch.status === "string" && ["succeeded","failed","unknown","cancelled"].includes(batch.status));
  const patchIdle=patch.atRoot===true && patch.copyOpen===false && patch.modal===false;
  const normalReadable=normal.environment==="Normal" && normal.coverage?.complete===true && normal.fixturesTruncated!==true && Number.isInteger(normal.total) && normal.total>=0;
  const noOwnedWork=lease.active===false && lease.owned===false && inputIdle && controlIdle && batchesIdle && patchIdle;
  if(!normalReadable || !noOwnedWork) throw new Error("rebind requires complete readable Normal, closed patch/no modal, and no bridge writer/input/control/batch ownership");
  return {normalReadable:true,noOwnedWork:true,normalValues:normal.total,patchClosed:true,writerLeaseActive:false,inputIdle:true,controlIdle:true,connectionBatchesIdle:true};
}

/** A read-only proof, with fresh ownership/Normal checks at both ends of the full native fingerprint read. */
export async function observeRebind(ctx:ToolContext,compilation:Compilation,expectedCues:number):Promise<Observation> {
  const requests:RequestTiming[]=[],bridge=timedBridge(ctx.bridge,requests,ctx.requestTimeoutMs),scoped={...ctx,bridge};
  const before=await readFastContext(bridge,ctx.requestTimeoutMs);
  if(!before.contextKey || before.environment!=="Normal" || before.identityUncertain?.length) throw new Error("complete stable identity in Normal is required for rebind");
  const start=await safety(scoped);
  const observed=await observeSequence(scoped,compilation,expectedCues);
  const end=await safety(scoped);
  const after=await readFastContext(bridge,ctx.requestTimeoutMs);
  if(after.contextKey!==before.contextKey || observed.contextKey!==before.contextKey || after.environment!=="Normal" || after.identityUncertain?.length) throw new Error("console context changed during recovery proof; no rebind was adopted");
  return {...observed,requests,rebindSafety:{normalReadable:true,noOwnedWork:true,detail:{before:start,after:end,scope:"fresh native sequence/dependency fingerprints, complete Normal coverage and bridge-reported ownership; no console mutation",atomic:false,limitation:"The console operator and unrelated plugins are not locked out by these read-only observations."}}};
}
