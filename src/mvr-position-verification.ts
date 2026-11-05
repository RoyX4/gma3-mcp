/** Fresh-export comparison with only the export metadata differences qualified on MA 2.5.1.1. */
import {mvrAssetIdentity,type MvrInventory,type MvrObject} from './mvr.js';
import {planMvrImport,verifyMvrImport,type MvrImportPlan} from './mvr-import.js';
import {nativeContentFingerprint} from './native-cues.js';
import type {Verification} from './results.js';
const identity=[1,0,0,0,0,1,0,0,0,0,1,0];
const same=(a:unknown,b:unknown)=>nativeContentFingerprint(a)===nativeContentFingerprint(b);
export function nativeExportScene(inventory:MvrInventory){
 const fixtures=inventory.objects.filter(o=>o.kind==='Fixture');
 const layers=inventory.objects.filter(o=>o.kind==='Layer' && o.name==='Fixture Layer' && o.parent===null && same(o.matrix,identity) && same(o.worldMatrix,identity) && fixtures.length>0 && fixtures.every(f=>f.parent===o.uuid) && inventory.objects.filter(c=>c.parent===o.uuid).length===fixtures.length);
 if(layers.length>1)throw new Error('Ambiguous generated Fixture Layer');
 const layer=layers[0],alias='ma-export-root-fixture-layer';
 return {
  objects:inventory.objects.map(o=>({...o,uuid:layer && o.uuid===layer.uuid?alias:o.uuid,parent:layer && o.parent===layer.uuid?alias:o.parent})).sort((a,b)=>a.uuid.localeCompare(b.uuid)),
  normalizations:layer?[{kind:'MA 2.5.1.1 regenerated export layer UUID',rawUuid:layer.uuid,alias,children:fixtures.map(f=>f.uuid).sort(),conditions:'single root identity Layer named Fixture Layer; direct children are exactly every fixture UUID, no other children'}]:[],
 };
}
export function mvrAssetManifest(inventory:MvrInventory){return inventory.assets.map(asset=>({name:asset.name,identity:mvrAssetIdentity(asset)})).sort((a,b)=>a.name.localeCompare(b.name));}
export function verifyMvrPositionResult(plan:MvrImportPlan,before:MvrInventory,actual:MvrInventory):Verification & {normalizations:unknown[]} {
 const fixtureCheck=verifyMvrImport(plan,actual),wanted=nativeExportScene(before),observed=nativeExportScene(actual);
 const scenePreserved=same(wanted.objects.filter(o=>o.kind!=='Fixture'),observed.objects.filter(o=>o.kind!=='Fixture'));
 const assetsPreserved=same(mvrAssetManifest(before),mvrAssetManifest(actual));
 const expectedParents=new Map(wanted.objects.filter(o=>o.kind==='Fixture').map(o=>[o.uuid,o.parent]));
 const fixtureParentsPreserved=observed.objects.filter(o=>o.kind==='Fixture').every(o=>expectedParents.get(o.uuid)===o.parent);
 const expectedTypes=new Map(plan.expectedFixtures.map(o=>[o.uuid,o.gdtfSpec]));
 const fixtureTypeNamesPreserved=observed.objects.filter(o=>o.kind==='Fixture').every(o=>expectedTypes.get(o.uuid)===o.gdtfSpec);
 const problems=[...(fixtureCheck.status!=='matched'?[fixtureCheck.detail??'Fixture verification unavailable']:[]),...(!scenePreserved?['Inspected nonfixture scene/geometry/hierarchy differs']:[]),...(!assetsPreserved?['Embedded asset content differs']:[]),...(!fixtureParentsPreserved?['Fixture parent membership differs']:[]),...(!fixtureTypeNamesPreserved?['Fixture GDTF specification differs']:[])];
 const knownMismatch=fixtureCheck.status==='mismatched' || !scenePreserved || !assetsPreserved || !fixtureParentsPreserved || !fixtureTypeNamesPreserved;
 return {status:knownMismatch?'mismatched':fixtureCheck.status==='matched'?'matched':'unavailable',checked:'complete inspected fixture UUID/FID/name/type/mode/DMX/world/geometry, parent memberships, nonfixture scene and embedded asset content; qualified export metadata normalization only',actual:{fixtureCheck,scenePreserved,assetsPreserved,fixtureParentsPreserved,fixtureTypeNamesPreserved,rawAssets:actual.assets},normalizations:[...wanted.normalizations.map(n=>({source:'before',...n})),...observed.normalizations.map(n=>({source:'observed',...n}))],...(problems.length?{detail:problems.join('; ')}:{})};
}
export function verifyFreshMvrBefore(before:MvrInventory,actual:MvrInventory){return verifyMvrPositionResult(planMvrImport(before,before,[]),before,actual);}
