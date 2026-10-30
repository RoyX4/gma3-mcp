/** Fixed native UUID guards for the qualified position-only writer. */
import type { FastContext } from './fastpath.js';
export interface NativeMvrFixture {
 uuid:string; fid:number; name:string; addr:string; type:string; mode:string; patch:string;
 x:number;y:number;z:number;rx:number;ry:number;rz:number;
}
export interface NativeMvrSnapshot { identity:{hostname:string;showfile:string;user:string;profile:string;generation:string}; fixtures:NativeMvrFixture[] }
export function luaValue(value:unknown):string {
 if(typeof value==='string')return '"'+Array.from(Buffer.from(value,'utf8'),byte=>'\\'+String(byte).padStart(3,'0')).join('')+'"';
 if(typeof value==='number' && Number.isFinite(value))return String(value);
 if(Array.isArray(value))return '{'+value.map(luaValue).join(',')+'}';
 if(value && typeof value==='object')return '{'+Object.entries(value).map(([k,v])=>`[${luaValue(k)}]=${luaValue(v)}`).join(',')+'}';
 throw new Error('Unsupported native position argument');
}
const snapshotCode=`local function snapshot()
 assert(CurrentEnvironment().name=='Normal' and not GetTopModal(),'Normal without a modal is required')
 local sd=ShowData();assert(Patch():Addr()==sd.LivePatch:Addr() and sd.Patch:Count()==0 and CmdObj():Get('Destination',Enums.Roles.Display)=='Root','Patch state changed')
 assert(sd.LivePatch.Stages:Count()==1,'Only one native stage is qualified')
 local socket=Root().ManetSocket
 local out={identity={hostname=socket.hostname,showfile=socket.showfile,user=CurrentUser().name,profile=CurrentProfile().name,generation=__gma3_mcp_bridge.fastGeneration},fixtures={}}
 local handles,seen={},{}
 for _,h in ipairs(sd.LivePatch.Stages:Ptr(1).Fixtures:Children())do
  assert(h:GetClass()=='Fixture','Non-fixture native top-level object')
  local hex=h:Get('GUID',Enums.Roles.Display);assert(type(hex)=='string','Unreadable Fixture UUID');hex=hex:gsub('%s+',''):lower();assert(#hex==32 and not hex:find('[^0-9a-f]'),'Invalid Fixture UUID')
  local uuid=hex:sub(1,8)..'-'..hex:sub(9,12)..'-'..hex:sub(13,16)..'-'..hex:sub(17,20)..'-'..hex:sub(21)
  local fid=h:Get('FID');assert(type(fid)=='number' and fid>=1 and fid%1==0 and not seen[fid] and not handles[uuid],'Ambiguous UUID/FID')
  seen[fid]=true;handles[uuid]=h
  local ft=h:Get('FixtureType');local mode=h:Get('ModeDirect');assert(IsObjectValid(ft) and ft:GetClass()=='FixtureType' and IsObjectValid(mode) and mode:GetClass()=='DMXMode','Unreadable native type/mode')
  local r={uuid=uuid,fid=fid,name=h.name,addr=h:Addr(),type=ft:Addr(),mode=mode:Addr(),patch=h:Get('Patch',Enums.Roles.Display)}
  for key,property in pairs({x='POSX',y='POSY',z='POSZ',rx='ROTX',ry='ROTY',rz='ROTZ'})do local n=h:Get(property);assert(type(n)=='number' and n==n and math.abs(n)<1e10,'Unreadable native pose');r[key]=n end
  assert(type(r.name)=='string' and type(r.patch)=='string','Unreadable fixture fields')
  out.fixtures[#out.fixtures+1]=r
 end
 assert(#out.fixtures>=1 and #out.fixtures<=256,'Native fixture bounds exceeded')
 table.sort(out.fixtures,function(a,b)return a.uuid<b.uuid end)
 return out,handles
end
`;
export function nativeMvrSnapshotCode():string{return snapshotCode+'local result=snapshot();return result';}
/** Native read and Set share one non-yielding chunk. A failed/lost setter is never retried. */
export function nativeMvrSetCode(expected:NativeMvrSnapshot,uuid:string,property:string,value:number):string {
 if(!['POSX','POSY','POSZ'].includes(property) || !Number.isFinite(value))throw new Error('Only finite position properties are qualified');
 return snapshotCode+`local expected=${luaValue(expected)}
local ok,actual,handles=pcall(snapshot)
if not ok then return {dispatched=false,reason=tostring(actual)} end
for key,value in pairs(expected.identity)do if actual.identity[key]~=value then return {dispatched=false,reason='Console identity changed: '..key} end end
if #actual.fixtures~=#expected.fixtures then return {dispatched=false,reason='Native fixture count changed'} end
for i,row in ipairs(expected.fixtures)do
 local got=actual.fixtures[i]
 for key,value in pairs(row)do
  if type(value)=='number' then if type(got[key])~='number' or math.abs(got[key]-value)>1e-8 then return {dispatched=false,reason='Native fixture pose/FID changed: '..row.uuid..'/'..key} end
  elseif got[key]~=value then return {dispatched=false,reason='Native fixture identity/type/patch changed: '..row.uuid..'/'..key} end
 end
end
local h=handles[${luaValue(uuid)}];if not h then return {dispatched=false,reason='Exact UUID absent'} end
local sent,why=pcall(h.Set,h,${luaValue(property)},${luaValue(String(value))})
if not sent then return {dispatched=true,uncertain=true,reason=tostring(why)} end
local read,stored=pcall(h.Get,h,${luaValue(property)})
if not read or type(stored)~='number' or math.abs(stored-${value})>1e-8 then return {dispatched=true,uncertain=true,reason='Native position readback differs'} end
return {dispatched=true,value=stored,uuid=${luaValue(uuid)},property=${luaValue(property)}}`;
}
export function checkNativeMvrSnapshot(raw:unknown,context:FastContext):NativeMvrSnapshot {
 const value=raw as NativeMvrSnapshot;
 if(!value?.identity || !Array.isArray(value.fixtures) || value.fixtures.length<1 || value.fixtures.length>256)throw new Error('Complete native fixture snapshot unavailable');
 for(const key of ['hostname','showfile','user','profile','generation']as const)if(value.identity[key]!==context.identity[key] || typeof value.identity[key]!=='string')throw new Error(`Native context differs: ${key}`);
 const uuids=new Set<string>(),fids=new Set<number>();
 for(const row of value.fixtures){
  if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(row.uuid) || uuids.has(row.uuid) || !Number.isSafeInteger(row.fid) || row.fid<1 || fids.has(row.fid))throw new Error('Native UUID/FID bijection unavailable');
  if(['name','addr','type','mode','patch'].some(k=>typeof row[k as keyof NativeMvrFixture]!=='string') || ['x','y','z','rx','ry','rz'].some(k=>!Number.isFinite(row[k as keyof NativeMvrFixture])))throw new Error('Native fixture snapshot incomplete');
  uuids.add(row.uuid);fids.add(row.fid);
 }
 return value;
}
