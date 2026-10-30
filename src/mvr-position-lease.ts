/** Same cooperative lease lifecycle as queued cue jobs; never reacquire after loss. */
import type {Gma3Bridge} from './bridge.js';
import type {ToolContext} from './tools/context.js';
import {outcomeOf,type OperationResult,type StepResult} from './results.js';
export async function withMvrWriterLease(ctx:ToolContext,contextKey:string,work:(leased:ToolContext)=>Promise<OperationResult>):Promise<OperationResult>{
 const raw=ctx.bridge;
 const lease=await raw.request<{token?:string}>('fast.lease',{action:'acquire',contextKey,ttlMs:30000},ctx.requestTimeoutMs);
 if(typeof lease.token!=='string' || !lease.token)throw new Error('A complete writer lease token was not issued; no position writes were attempted');
 let renewed=performance.now(),lost:unknown;
 const leased=Object.create(raw) as Gma3Bridge;
 leased.request=async function<T=unknown>(op:string,args:Record<string,unknown>={},timeoutMs?:number):Promise<T>{
  if(lost)throw lost;
  if(performance.now()-renewed>10000){
   try{await raw.request('fast.lease',{action:'renew',token:lease.token,ttlMs:30000},ctx.requestTimeoutMs);renewed=performance.now();}
   catch(error){lost=error;throw error;}
  }
  return raw.request<T>(op,args,timeoutMs);
 };
 let result:OperationResult|undefined,primary:unknown,releaseError:unknown;
 try{result=await work({...ctx,bridge:leased});}catch(error){primary=error;}
 try{await raw.request('fast.lease',{action:'release',token:lease.token},ctx.requestTimeoutMs);}catch(error){releaseError=error;}
 if(primary){
  const error=primary instanceof Error?primary:new Error(String(primary));
  if(releaseError)error.message+='; writer lease release was not confirmed: '+String(releaseError);
  throw Object.assign(error,{mvrWriterLease:{released:!releaseError,uncertain:!!releaseError,cooperativeOnly:true}});
 }
 if(!result)throw new Error('MVR writer produced no operation receipt');
 if(!releaseError)return{...result,writerLease:{released:true,cooperativeOnly:true}};
 const detail='Writer lease release was not confirmed: '+String(releaseError)+'. The lease expires or is released on disconnect; it was not reacquired.';
 const step:StepResult={name:'release_writer_lease',kind:'read',status:'unknown',op:'fast.lease',error:detail};
 const steps=[...result.steps,step];
 return{...result,steps,outcome:outcomeOf(steps),summary:result.summary+' '+detail,warnings:[...(result.warnings??[]),detail],writerLease:{released:false,uncertain:true,cooperativeOnly:true}};
}
