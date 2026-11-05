-- Native API calls are counted; paging must not rescan and filtering must skip irrelevant phasers.
package.path = "test/lua/?.lua;" .. package.path
local clock = 100
package.preload.socket = function() return { gettime = function() return clock end, bind = function() return nil end } end
Echo = function() end; ErrEcho = Echo; Printf = Echo; ErrPrintf = Echo
GetPath = function() return nil end
Enums = { PathType = { Temp = 1 }, Roles = { Display = 1, Edit = 2 }, VirtualKeyCode = {}, KeyboardCodes = {} }
BuildDetails = function() return {} end
local show, profile, environment = "Lab.show", "Default", "Normal"
Root = function() return { MANetSocket = { Get = function() return show end }, maNetSocket = { hostname = "Lab" } } end
CurrentUser = function() return { name = "LabUser" } end
CurrentProfile = function() return { name = profile } end
CurrentEnvironment = function() return { name = environment } end
local handles = setmetatable({}, { __mode = "k" })
local meta = { __index = function(h,k) return handles[h][k] end }
local function H(t) local h = io.tmpfile(); debug.setmetatable(h, meta); handles[h] = t; return h end
local sf = H({ name = "Fixture", FID = 1 })
local attrs = { H({ name = "Dimmer" }), H({ name = "Pan" }), H({ name = "Tilt" }) }
GetSubfixtureCount = function() return 1 end
GetSubfixture = function() return sf end
GetUIChannels = function() return { 1,2,3 } end
GetAttributeByUIChannel = function(i) return attrs[i] end
local phaserCalls = 0
GetProgPhaser = function(i) phaserCalls = phaserCalls + 1; return { mask_active_value = 1, { absolute = i * 10 } } end
local commands, feedback = {}, "Ok"
Cmd = function(s) commands[#commands+1] = s; return feedback end
local signals = {}
assert(loadfile("plugin/gma3_mcp_bridge.lua"))("bridge", "bridge", signals, {})
local state = _G.__gma3_mcp_bridge
local json = require("json")
local a, b = { id = 1 }, { id = 2 }
local function req(op,args,client)
  local co = coroutine.create(function() return state._handleLine(client or a, json.encode({id="t",op=op,args=args or {}})) end)
  local ok,r = coroutine.resume(co)
  while ok and coroutine.status(co) == "suspended" do ok,r=coroutine.resume(co) end
  assert(ok,r); return json.decode(r)
end
local checks = 0
local function check(name,condition,detail) checks=checks+1; assert(condition, name .. ": " .. json.encode(detail or {})) end
for _,name in ipairs({"gma3_mcp_feedback","gma3_mcp_hardkeys","gma3_mcp_control"}) do
  local module=assert(loadfile("plugin/"..name..".lua"))("bridge",name,signals,{})
  check("component exports its actual imported fingerprint: "..name,type(module.RUNTIME_FINGERPRINT)=="string" and module.RUNTIME_FINGERPRINT:find("lua%-bytecode%-adler32:")~=nil)
end
local r=req("programmer",{attributes={"Pan"},maxChannels=50000})
check("filter skips native phasers",r.ok and phaserCalls==1 and r.result.total==1,r)
check("filter explicitly scopes completeness",r.result.filter and r.result.filter.attributes[1]=="Pan" and r.result.coverage.complete==true,r)
r=req("fast.context")
check("runtime context available",r.ok and r.result.contextKey and r.result.identity.generation,r)
local contextKey=r.result.contextKey
local normalKey=contextKey
environment="Preview"
check("environment does not change show identity",req("fast.context").result.contextKey==normalKey)
environment="Normal"
local ping=req("ping").result
check("actual imported bridge has runtime fingerprint",ping.plugin and ping.plugin.fingerprint and ping.plugin.generation,ping)
r=req("fast.lease",{action="acquire",contextKey=contextKey,ttlMs=1000})
check("writer acquired",r.ok and r.result.token,r)
local token=r.result.token
check("another writer refused",not req("cmd",{command="ClearAll"},b).ok)
check("reads remain allowed",req("programmer",{attributes={"Pan"}},b).ok)
check("raw Lua batch refused",not req("fast.batch",{action="start",contextKey=contextKey,leaseToken=token,steps={{op="lua",args={code="1"}}}}).ok)
check("semicolon command refused",not req("fast.batch",{action="start",contextKey=contextKey,leaseToken=token,steps={{op="cmd",args={command="ClearAll; Store Sequence 1"}}}}).ok)
check("Lua command refused",not req("fast.batch",{action="start",contextKey=contextKey,leaseToken=token,steps={{op="cmd",args={command="Lua 'x=1'"}}}}).ok)
r=req("fast.batch",{action="start",contextKey=contextKey,leaseToken=token,steps={{op="cmd",args={command="ClearAll"}},{op="cmd",args={command="Store Sequence 1"}}}})
check("batch queues without dispatch or terminal outcome",r.ok and #commands==0 and r.result.outcome==nil,r)
local id=r.result.id
check("same-connection mutations cannot interleave a running batch",not req("cmd",{command="Store Sequence 999"}).ok and #commands==0)
state._serviceFastpath(); check("one step per service frame",#commands==1)
req("fast.batch",{action="cancel",id=id})
state._serviceFastpath()
r=req("fast.batch",{action="status",id=id})
check("cancel at boundary reports partial work and skips remaining",r.ok and r.result.status=="cancelled" and r.result.outcome=="partial" and #commands==1 and r.result.steps[2].status=="skipped",r)
check("retained batch diagnosis remains bound to its own connection",not req("fast.batch",{action="status",id=id},b).ok and not req("fast.batch",{action="cancel",id=id},b).ok)
feedback="new unfamiliar response"
r=req("fast.batch",{action="start",contextKey=contextKey,leaseToken=token,steps={{op="cmd",args={command="ClearAll"}},{op="cmd",args={command="Store Sequence 2"}}}})
id=r.result.id; state._serviceFastpath(); state._serviceFastpath()
r=req("fast.batch",{action="status",id=id})
check("unknown feedback stops without replay",r.ok and r.result.status=="unknown" and #commands==2 and r.result.steps[2].status=="skipped",r)
check("lost start handle is discoverable without replay",#req("fast.batch",{action="list"}).result.batches==2)
feedback="Ok"
r=req("fast.batch",{action="start",contextKey=contextKey,leaseToken=token,steps={{op="cmd",args={command="ClearAll"}},{op="cmd",args={command="Store Sequence 3"}}}})
id=r.result.id; profile="Other"; state._serviceFastpath()
r=req("fast.batch",{action="status",id=id})
check("context drift stops before mutation",r.ok and r.result.status=="failed" and #commands==2,r)
profile="Default"
check("returning to an old profile never revives a stale guard",req("fast.context").result.contextKey~=contextKey)
clock=102
check("expired lease releases other writers",req("cmd",{command="ClearAll"},b).ok)
local before=phaserCalls
r=req("programmer.snapshot",{action="create",limit=1,maxChannels=50000})
check("snapshot scans once",r.ok and phaserCalls-before==3 and r.result.nextCursor,r)
local sid,cursor=r.result.snapshotId,r.result.nextCursor
before=phaserCalls
r=req("programmer.snapshot",{action="page",snapshotId=sid,cursor=cursor,limit=1})
check("cursor page never rescans",r.ok and phaserCalls==before and r.result.offset==1 and r.result.count==1,r)
check("snapshot is connection bound",not req("programmer.snapshot",{action="page",snapshotId=sid,cursor=cursor},b).ok)
check("malformed cursor refused",not req("programmer.snapshot",{action="page",snapshotId=sid,cursor=cursor.."junk"}).ok)
environment="Preview"
check("snapshot invalidates on environment drift",not req("programmer.snapshot",{action="page",snapshotId=sid,cursor=cursor}).ok)
environment="Normal"
check("channel budget is hard within fixture",req("programmer",{maxChannels=1}).result.coverage.scannedChannels==1)
check("empty filter refused",not req("programmer",{attributes={}}).ok)
local currentKey=req("fast.context").result.contextKey
r=req("fast.batch",{action="start",contextKey=currentKey,steps={{op="programmer",args={attributes={"Pan"}},expect={path="total",value=0}},{op="programmer",args={}}}})
id=r.result.id; state._serviceFastpath()
r=req("fast.batch",{action="status",id=id})
check("read expectation mismatch stops later reads",r.ok and r.result.status=="failed" and r.result.steps[2].status=="skipped",r)
r=req("fast.batch",{action="start",contextKey=currentKey,steps={{op="programmer",args={attributes={"Pan"}}}}})
id=r.result.id; state._serviceFastpath()
r=req("fast.batch",{action="status",id=id})
check("batch envelope preserves native nested phaser steps",r.ok and r.result.steps[1].detail.rows[1].steps[1].absolute==20,r)
local nativeOps
for i=1,100 do
  local name,value=debug.getupvalue(state._handleLine,i)
  if name=="ops" then nativeOps=value;break end
end
assert(nativeOps,"test must find the real dispatcher operation table")
local nativeView=nativeOps["view.content"]
nativeOps["view.content"]=function() return {complete=false,limitations={"native configuration unreadable"}} end
r=req("fast.batch",{action="start",contextKey=currentKey,steps={{op="view.content",args={ref="View 1"}},{op="programmer",args={}}}})
id=r.result.id;state._serviceFastpath();r=req("fast.batch",{action="status",id=id})
check("explicitly incomplete native content stops the batch",r.ok and r.result.status=="failed" and r.result.steps[2].status=="skipped",r)
nativeOps["view.content"]=function() return {complete=true,content={a={b={c={d={e={f={value=1}}}}}}}} end
r=req("fast.batch",{action="start",contextKey=currentKey,steps={{op="view.content",args={ref="View 1"}},{op="programmer",args={}}}})
id=r.result.id;state._serviceFastpath();r=req("fast.batch",{action="status",id=id})
check("serialization depth loss is incomplete evidence rather than success",r.ok and r.result.status=="failed" and r.result.steps[2].status=="skipped",r)
nativeOps["view.content"]=nativeView
r=req("programmer.snapshot",{action="create",ttlMs=100,limit=1})
sid,cursor=r.result.snapshotId,r.result.nextCursor; clock=103
check("snapshot expiry refuses old rows",not req("programmer.snapshot",{action="page",snapshotId=sid,cursor=cursor}).ok)
r=req("fast.lease",{action="acquire",contextKey=currentKey,ttlMs=10000})
token=r.result.token
local nativeSet=nativeOps.set
nativeOps.set=function() return {readOk=true,value=false} end
r=req("fast.batch",{action="start",contextKey=currentKey,leaseToken=token,steps={{op="set",args={ref="Sequence 1",property="Test",value=""}}}})
id=r.result.id;state._serviceFastpath();r=req("fast.batch",{action="status",id=id})
check("false property readback cannot match requested empty text",r.ok and r.result.status=="failed",r)
r=req("fast.batch",{action="start",contextKey=currentKey,leaseToken=token,steps={{op="set",args={ref="Sequence 1",property="Test",value=false}}}})
id=r.result.id;state._serviceFastpath();r=req("fast.batch",{action="status",id=id})
check("false property readback is preserved as a boolean",r.ok and r.result.status=="succeeded",r)
nativeOps.set=nativeSet
local nativeCmd=nativeOps.cmd
local deadHandle=io.tmpfile()
debug.setmetatable(deadHandle,{__index=function() error("expired native handle") end})
nativeOps.cmd=function(args) commands[#commands+1]=args.command;return {feedback="Ok",handle=deadHandle} end
local beforeBadReceipt=#commands
r=req("fast.batch",{action="start",contextKey=currentKey,leaseToken=token,steps={{op="cmd",args={command="Store Sequence 8"}},{op="cmd",args={command="Store Sequence 9"}}}})
id=r.result.id
local serviceOk=pcall(state._serviceFastpath)
check("expired handle receipt cannot crash the bridge service",serviceOk)
state._serviceFastpath();r=req("fast.batch",{action="status",id=id})
check("receipt failure is retained as unknown and cannot replay a dispatched command",r.ok and r.result.status=="unknown" and #commands==beforeBadReceipt+1 and r.result.steps[2].status=="skipped",r)
local badSummary=H({name="Malformed native metadata",GetClass=function() return function() end end,Addr=function() return "1.2.3" end})
nativeOps.cmd=function(args) commands[#commands+1]=args.command;return {feedback="Ok",handle=badSummary} end
local beforeBadEncoding=#commands
r=req("fast.batch",{action="start",contextKey=currentKey,leaseToken=token,steps={{op="cmd",args={command="Store Sequence 10"}},{op="cmd",args={command="Store Sequence 11"}}}})
id=r.result.id;state._serviceFastpath();state._serviceFastpath();r=req("fast.batch",{action="status",id=id})
check("strict encoding failure retains unknown receipt instead of a successful fallback",r.ok and r.result.status=="unknown" and #commands==beforeBadEncoding+1 and r.result.steps[2].status=="skipped" and r.result.steps[1].serializationLoss.processingError==true,r)
nativeOps.cmd=nativeCmd
r=req("fast.batch",{action="start",contextKey=currentKey,leaseToken=token,steps={{op="cmd",args={command="ClearAll"}}}})
local beforeDisconnect=#commands
a.sock={close=function() end}; state.clients={a}; state._closeClient(1,"test-disconnect"); state._serviceFastpath()
check("disconnect releases lease and discards pending batch",#commands==beforeDisconnect and req("cmd",{command="ClearAll"},b).ok)
local oldFingerprint=req("ping").result.plugin.fingerprint
local oldHandleLine=state._handleLine
local oldContext=req("fast.context").result.contextKey
local f=assert(io.open("plugin/gma3_mcp_bridge.lua","r")); local source=f:read("*a");f:close()
source=source:gsub('local DEFAULT_PORT = 9800','local DEFAULT_PORT = 9805')
assert(load(source,"changed-import"))("bridge","bridge",{}, {})
local changed=req("ping").result
check("fingerprint detects different imported bytes with the same version",changed.bridgeVersion==ping.bridgeVersion and changed.plugin.fingerprint~=oldFingerprint,changed)
local oldPing=json.decode(oldHandleLine(a,json.encode({id="old",op="ping",args={}})))
local oldIdentity=json.decode(oldHandleLine(a,json.encode({id="old",op="fast.context",args={}})))
check("new import cannot relabel an older running handler",oldPing.result.plugin.fingerprint==oldFingerprint and oldIdentity.result.contextKey==oldContext,oldPing)
check("private fastpath table is never callable over the wire",not req("_fastpath").ok)
print(tostring(checks) .. " checks ALL PASSED")
