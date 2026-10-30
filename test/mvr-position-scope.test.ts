import {test} from 'node:test';
import assert from 'node:assert/strict';
import {qualifyMvrPositions} from '../src/mvr-positions.ts';
import type {MvrInventory,MvrObject} from '../src/mvr.ts';
const uid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const identity=[1,0,0,0,0,1,0,0,0,0,1,0];
function fixture(n:number):MvrObject{return {uuid:uid(n),kind:'Fixture',name:`Fixture ${n}`,parent:null,matrix:[...identity],worldMatrix:[...identity],fixtureId:String(n),gdtfSpec:'dimmer.gdtf',gdtfMode:'Mode 0',addresses:[{break:1,address:n}],geometryHash:null};}
function inventory():MvrInventory{return {version:'1.6',archive:{file:'/mapped/Before.mvr',bytes:100,sha256:'before',members:2},objects:[fixture(1),fixture(2)],assets:[{name:'dimmer.gdtf',bytes:3,sha256:'same-type'}],fixtureIdConflicts:{},units:{}};}
const decision=[{uuid:uid(1),source:'local' as const,patch:'local' as const,transform:'incoming' as const}];
test('position-only apply scope keeps a distracting patch and another fixture transform local',()=>{
 const before=inventory(),incoming=structuredClone(before);incoming.archive.sha256='incoming';
 incoming.objects[0].worldMatrix[3]=250;incoming.objects[0].matrix[3]=250;incoming.objects[0].addresses[0].address=50;
 incoming.objects[1].worldMatrix[3]=500;incoming.objects[1].matrix[3]=500;
 const scope=qualifyMvrPositions(before,incoming,decision);
 assert.equal(scope.executable,true);assert.equal(scope.targets.length,1);
 assert.deepEqual(scope.targets[0],{uuid:uid(1),fid:'1',before:[0,0,0],incoming:[.25,0,0]});
 assert.equal(scope.plan.expectedFixtures[0].addresses[0].address,1);
 assert.equal(scope.plan.expectedFixtures[1].worldMatrix[3],0);
});
test('position-only scope refuses unqualified identity/type/rotation/scene cases and empty work',()=>{
 const before=inventory();
 for(const mutate of [
  (n:MvrInventory)=>{n.objects.push(fixture(3));},
  (n:MvrInventory)=>{n.objects[0].fixtureId='3';},
  (n:MvrInventory)=>{n.assets[0].sha256='other';},
  (n:MvrInventory)=>{n.objects[0].worldMatrix[0]=0;},
  (n:MvrInventory)=>{n.objects.push({...fixture(3),kind:'SceneObject',fixtureId:'',gdtfSpec:'',gdtfMode:''});},
 ]){const incoming=structuredClone(before);incoming.objects[0].worldMatrix[3]=250;mutate(incoming);assert.equal(qualifyMvrPositions(before,incoming,decision).executable,false);}
 assert.equal(qualifyMvrPositions(before,structuredClone(before),decision).executable,false);
 const incoming=structuredClone(before);incoming.objects[0].worldMatrix[3]=250;
 assert.equal(qualifyMvrPositions(before,incoming,[{...decision[0],source:'incoming'}]).executable,false);
});

test('unchanged scenery transforms are allowed unless they are a selected fixture ancestor',()=>{
 const before=inventory();const scenery={...fixture(3),kind:'SceneObject',fixtureId:'',gdtfSpec:'',gdtfMode:''};scenery.matrix[3]=1000;scenery.worldMatrix[3]=1000;before.objects.push(scenery);
 const incoming=structuredClone(before);incoming.objects[0].worldMatrix[3]=250;incoming.objects[0].matrix[3]=250;
 assert.equal(qualifyMvrPositions(before,incoming,decision).executable,true);
 before.objects[0].parent=scenery.uuid;incoming.objects[0].parent=scenery.uuid;
 assert.equal(qualifyMvrPositions(before,incoming,decision).executable,false);
});
test('position scope rejects indirect fixture ancestors and out-of-range translations before export',()=>{
 const before=inventory(),group={...fixture(3),kind:'GroupObject',fixtureId:'',gdtfSpec:'',gdtfMode:'',parent:uid(2)};
 before.objects.push(group);before.objects[0].parent=group.uuid;
 const incoming=structuredClone(before);incoming.objects[0].worldMatrix[3]=250;
 assert.equal(qualifyMvrPositions(before,incoming,decision).executable,false);
 const plain=inventory(),huge=structuredClone(plain);huge.objects[0].worldMatrix[3]=1e300;
 assert.equal(qualifyMvrPositions(plain,huge,decision).executable,false);
});
