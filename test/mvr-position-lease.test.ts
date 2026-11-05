import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withMvrWriterLease} from '../src/mvr-position-lease.ts';
import {MutationLock} from '../src/mutations.ts';
import type {ToolContext} from '../src/tools/context.ts';
import {buildResult,asRead} from '../src/results.ts';
test('MVR lease renews on the same token and never reacquires after a failed renewal',async()=>{
 let now=0;const original=Object.getOwnPropertyDescriptor(performance,'now');Object.defineProperty(performance,'now',{configurable:true,value:()=>now});
 try{
  const calls:string[]=[];let fail=false;
  const bridge={request:async(op:string,args:any)=>{calls.push(op==='fast.lease'?args.action:op);if(args.action==='acquire')return{token:'same'};if(args.action==='renew'){assert.equal(args.token,'same');if(fail)throw new Error('expired');}return{released:true};}};
  const ctx={bridge,mutations:new MutationLock(),requestTimeoutMs:1000,luaToolAllowed:true}as unknown as ToolContext;
  const success=()=>buildResult({operation:'test',target:{},steps:[asRead({name:'observed',status:'succeeded'})]});
  await withMvrWriterLease(ctx,'context',async held=>{await held.bridge.request('one');now+=11000;await held.bridge.request('two');return success();});
  assert.deepEqual(calls,['acquire','one','renew','two','release']);calls.length=0;fail=true;
  await withMvrWriterLease(ctx,'context',async held=>{now+=11000;await assert.rejects(held.bridge.request('blocked'),/expired/);await assert.rejects(held.bridge.request('still-blocked'),/expired/);return success();});
  assert.deepEqual(calls,['acquire','renew','release']);
 }finally{if(original)Object.defineProperty(performance,'now',original);else delete(performance as any).now;}
});
