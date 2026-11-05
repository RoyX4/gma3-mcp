import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planMvrImport} from '../src/mvr-import.ts';
import {verifyFreshMvrBefore,verifyMvrPositionResult} from '../src/mvr-position-verification.ts';
import type {MvrInventory,MvrObject} from '../src/mvr.ts';
const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const identity=[1,0,0,0,0,1,0,0,0,0,1,0];
function inventory():MvrInventory{
 const common={parent:null,matrix:[...identity],worldMatrix:[...identity],fixtureId:'',gdtfSpec:'',gdtfMode:'',addresses:[],geometryHash:null};
 const layer={...common,uuid:uid(10),kind:'Layer',name:'Fixture Layer'};
 const fixture={...common,matrix:[...identity],worldMatrix:[...identity],uuid:uid(1),kind:'Fixture',name:'One',parent:layer.uuid,fixtureId:'1',gdtfSpec:'type.gdtf',gdtfMode:'mode',addresses:[{break:0,address:1}]};
 return {version:'1.6',archive:{file:'/mapped/test.mvr',bytes:1,sha256:'sha',members:2},objects:[layer,fixture]as MvrObject[],assets:[{name:'type.gdtf',bytes:5,sha256:'same'}],fixtureIdConflicts:{},units:{}};
}
function regenerated(input:MvrInventory){const n=structuredClone(input),old=n.objects[0].uuid;n.objects[0].uuid=uid(11);for(const o of n.objects)if(o.parent===old)o.parent=uid(11);return n;}
test('fresh export compares the proven synthetic layer by exact fixture membership and discloses raw UUIDs',()=>{
 const before=inventory(),actual=regenerated(before),result=verifyFreshMvrBefore(before,actual);
 assert.equal(result.status,'matched',JSON.stringify(result));assert.equal(result.normalizations.length,2);
 const incoming=structuredClone(before);incoming.objects[1].worldMatrix[3]=250;incoming.objects[1].matrix[3]=250;
 const plan=planMvrImport(before,incoming,[{uuid:uid(1),source:'local',patch:'local',transform:'incoming'}]);actual.objects[1].worldMatrix[3]=250;actual.objects[1].matrix[3]=250;
 assert.equal(verifyMvrPositionResult(plan,before,actual).status,'matched');
 actual.objects[1].addresses[0].address=50;assert.equal(verifyMvrPositionResult(plan,before,actual).status,'mismatched');
});
test('regenerated UUID is never normalized for moved/renamed layers, changed memberships or other scene objects',()=>{
 const before=inventory();
 for(const change of [
  (n:MvrInventory)=>{n.objects[0].name='Another';},
  (n:MvrInventory)=>{n.objects[0].matrix[3]=1;},
  (n:MvrInventory)=>{n.objects[1].parent=null;},
  (n:MvrInventory)=>{n.objects.push({...n.objects[0],uuid:uid(12),kind:'SceneObject',name:'Wall',parent:n.objects[0].uuid});},
 ]){const actual=regenerated(before);change(actual);assert.equal(verifyFreshMvrBefore(before,actual).status,'mismatched');}
});
