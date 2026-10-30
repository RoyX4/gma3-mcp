import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {inspectMvr,compareMvr,mvrAssetIdentity} from '../src/mvr.ts';

async function archives(run:(directory:string)=>Promise<void>) {
 const dir=await mkdtemp(join(tmpdir(),'gma3-gdtf-content-'));
 try {
  execFileSync('python3',['-I','-c',String.raw`
import sys,io,zipfile,stat,struct
from pathlib import Path
base=Path(sys.argv[1])
scene='<GeneralSceneDescription verMajor="1" verMinor="6"><Scene><Layers><Layer uuid="00000000-0000-4000-8000-000000000001" name="Stage"><ChildList><Fixture uuid="00000000-0000-4000-8000-000000000002" name="Dimmer"><FixtureID>1</FixtureID><GDTFSpec>type.gdtf</GDTFSpec><GDTFMode>Dimmer</GDTFMode></Fixture></ChildList></Layer></Layers></Scene></GeneralSceneDescription>'
def package(name,entries,date=(2020,1,1,0,0,0),compress=zipfile.ZIP_STORED):
 out=io.BytesIO()
 with zipfile.ZipFile(out,'w',compression=compress)as z:
  for filename,content,symlink in entries:
   info=zipfile.ZipInfo(filename,date_time=date);info.compress_type=compress
   if symlink:info.create_system=3;info.external_attr=(stat.S_IFLNK|0o777)<<16
   z.writestr(info,content)
 payload=out.getvalue()
 if name=='encrypted':
  data=bytearray(payload);a=data.index(b'PK\x03\x04');b=data.index(b'PK\x01\x02');struct.pack_into('<H',data,a+6,1);struct.pack_into('<H',data,b+8,1);payload=bytes(data)
 if name=='oversized':
  data=bytearray(payload);b=data.index(b'PK\x01\x02');struct.pack_into('<I',data,b+24,128*1024*1024+1);payload=bytes(data)
 with zipfile.ZipFile(base/(name+'.mvr'),'w',compression=zipfile.ZIP_DEFLATED)as z:z.writestr('GeneralSceneDescription.xml',scene);z.writestr('type.gdtf',payload)
package('a',[('description.xml','<GDTF><FixtureType Name="Dimmer"/></GDTF>',False),('models/model.bin','same-model',False),('models/','',False)])
package('b',[('models/model.bin','same-model',False),('description.xml','<GDTF><FixtureType Name="Dimmer"/></GDTF>',False)],(2024,5,6,7,8,10),zipfile.ZIP_DEFLATED)
package('changed',[('description.xml','<GDTF><FixtureType Name="Changed"/></GDTF>',False),('models/model.bin','same-model',False)])
for name,entries in [('traversal',[('../outside','x',False)]),('duplicate',[('description.xml','a',False),('DESCRIPTION.XML','b',False)]),('symlink',[('description.xml','target',True)]),('encrypted',[('description.xml','same',False)]),('oversized',[('description.xml','small',False)])]:package(name,entries)
`,dir],{stdio:'pipe'});
  await run(dir);
 } finally {await rm(dir,{recursive:true,force:true});}
}

test('GDTF member identity ignores ZIP timestamps, order, compression and directory entries but detects changed bytes',async()=>{
 await archives(async dir=>{
  const [a,b,changed]=await Promise.all(['a','b','changed'].map(name=>inspectMvr(join(dir,name+'.mvr'))));
  assert.notEqual(a.assets[0].sha256,b.assets[0].sha256);
  assert.equal(a.assets[0].contentHashKind,'zip-members-sha256-v1');
  assert.match(a.assets[0].contentSha256!,/^[a-f0-9]{64}$/);
  assert.equal(a.assets[0].contentSha256,b.assets[0].contentSha256);
  assert.notEqual(a.assets[0].contentSha256,changed.assets[0].contentSha256);
  assert.equal(mvrAssetIdentity(a.assets[0]),mvrAssetIdentity(b.assets[0]));
  assert.deepEqual(compareMvr(a,b).assets.changed,[]);
  assert.deepEqual(compareMvr(a,b).assets.containerChanged,['type.gdtf']);
  assert.deepEqual(compareMvr(a,changed).assets.changed,['type.gdtf']);
 });
});
test('unsafe nested GDTF archives fail before a semantic identity is accepted',async()=>{
 await archives(async dir=>{
  for(const name of ['traversal','duplicate','symlink','encrypted','oversized']) await assert.rejects(()=>inspectMvr(join(dir,name+'.mvr')),undefined,name);
 });
});

test('semantic asset identities require the declared algorithm and complete SHA, preserving legacy raw identity',()=>{
 const opaque={name:'old.gdtf',bytes:4,sha256:'raw-byte-identity'};
 assert.equal(mvrAssetIdentity(opaque),'raw-byte-identity');
 assert.throws(()=>mvrAssetIdentity({...opaque,contentHashKind:'zip-members-sha256-v1'}),/incomplete/);
 assert.throws(()=>mvrAssetIdentity({...opaque,contentHashKind:'zip-members-sha256-v1',contentSha256:'not-a-hash'}),/incomplete/);
});
