import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {nativeMvrSetCode,type NativeMvrSnapshot} from '../src/mvr-position-native.ts';
const lua=['lua5.4','lua54','lua','.test-tools/runtime/usr/bin/lua5.4'].find(bin=>spawnSync(bin,['-v']).status===0);
const fixture={uuid:'00000000-0000-4000-8000-000000000001',fid:1,name:'One',addr:'fixture',type:'type',mode:'mode',patch:'1.001',x:0,y:0,z:0,rx:0,ry:0,rz:0};
const before:NativeMvrSnapshot={identity:{hostname:'lab',showfile:'show',user:'Admin',profile:'Default',generation:'generation'},fixtures:[fixture]};
test('atomic position chunk refuses UUID/FID/context/pose changes and reports uncertain native Set without retry',{skip:lua?false:'Lua unavailable'},()=>{
 const chunk=(snapshot=before,property='POSX',value=.25)=>`assert(load([====[${nativeMvrSetCode(snapshot,fixture.uuid,property,value)}]====]))()`;
 const next=structuredClone(before);next.fixtures[0].x=.25;
 const script=`
 Enums={Roles={Display=1}};__gma3_mcp_bridge={fastGeneration='generation'}
 local fields={FID=1,GUID='00000000000040008000000000000001',POSX=0,POSY=0,POSZ=0,ROTX=0,ROTY=0,ROTZ=0,Patch='1.001'}
 local writes,fail=0,false
 local ft={GetClass=function()return'FixtureType'end,Addr=function()return'type'end}
 local mode={GetClass=function()return'DMXMode'end,Addr=function()return'mode'end}
 local h={name='One',Addr=function()return'fixture'end,GetClass=function()return'Fixture'end,Get=function(_,k)if k=='FixtureType'then return ft elseif k=='ModeDirect'then return mode end;return fields[k]end,Set=function(_,k,v)writes=writes+1;if fail then error('unknown native failure')end;fields[k]=tonumber(v)end}
 local live={Addr=function()return'live'end,Stages={Count=function()return 1 end,Ptr=function()return{Fixtures={Children=function()return{h}end}}end}}
 local sd={LivePatch=live,Patch={Count=function()return 0 end}}
 ShowData=function()return sd end;Patch=function()return live end;IsObjectValid=function()return true end
 CmdObj=function()return{Get=function()return'Root'end}end;CurrentEnvironment=function()return{name='Normal'}end;GetTopModal=function()return nil end
 local socket={hostname='lab',showfile='show'};Root=function()return{ManetSocket=socket}end
 CurrentUser=function()return{name='Admin'}end;CurrentProfile=function()return{name='Default'}end
 fields.FID=2;local r=${chunk()};assert(not r.dispatched and writes==0);fields.FID=1
 fields.GUID='00000000000040008000000000000002';r=${chunk()};assert(not r.dispatched and writes==0);fields.GUID='00000000000040008000000000000001'
 fields.POSY=1;r=${chunk()};assert(not r.dispatched and writes==0);fields.POSY=0
 socket.showfile='other';r=${chunk()};assert(not r.dispatched and writes==0);socket.showfile='show'
 r=${chunk()};assert(r.dispatched and r.value==.25 and fields.POSX==.25 and writes==1)
 r=${chunk()};assert(not r.dispatched and writes==1,'stale own position must refuse')
 r=${chunk(next,'POSY',.5)};assert(r.dispatched and r.value==.5 and fields.POSY==.5 and writes==2,'advanced own position permits next axis')
 fields.POSY=0;fail=true;r=${chunk(next,'POSY',.5)};assert(r.dispatched and r.uncertain and writes==3)
 print('ALL PASSED')`;
 const result=spawnSync(lua!,['-'],{input:script,encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/ALL PASSED/);
});
