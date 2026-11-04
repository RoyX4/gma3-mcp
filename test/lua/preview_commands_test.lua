package.path = "test/lua/?.lua;" .. package.path
package.preload.socket = function() return { gettime = function() return 100 end, bind = function() return nil end } end
Echo = function() end; ErrEcho = Echo; Printf = Echo; ErrPrintf = Echo
GetPath = function() return nil end
Enums = { PathType = { Temp = 1 }, Roles = { Display = 1, Edit = 2 } }
BuildDetails = function() return {} end
local environment, show = "Preview", "Lab"
Root = function() return { MANetSocket = { Get = function() return show end }, maNetSocket = { hostname = "Lab" } } end
CurrentUser = function() return { name = "Admin" } end
CurrentProfile = function() return { name = "Default" } end
CurrentEnvironment = function() return { name = environment } end
local seen, failAt, leaveAt = {}, nil, nil
Cmd = function(text)
  seen[#seen + 1] = text
  if #seen == leaveAt then environment = "Normal" end
  return #seen == failAt and "unfamiliar feedback" or "OK"
end
assert(loadfile("plugin/gma3_mcp_bridge.lua"))("bridge", "bridge", {}, {})
local json = require("json")
local state, client = _G.__gma3_mcp_bridge, { id = 1 }
local function request(op, args)
  local co = coroutine.create(function() return state._handleLine(client, json.encode({ id = "probe", op = op, args = args or {} })) end)
  local ok, reply = coroutine.resume(co)
  while ok and coroutine.status(co) == "suspended" do ok, reply = coroutine.resume(co) end
  assert(ok, reply)
  return json.decode(reply)
end
local ctx = request("fast.context").result
assert(ctx.previewCommandSeries == 1)
local commands = { "ClearSelection", "Fixture 201", "At 40", 'Attribute "Pan" At Absolute Percent 30' }
local function run(input) return request("fast.previewCommands", { contextKey = ctx.contextKey, commands = input }) end
local r = run(commands)
assert(r.ok and r.result.status == "succeeded" and #r.result.steps == 4 and #seen == 4)
seen = {}
r = run({ "ClearSelection", "Fixture 201", "At 30", "Store Sequence 1" })
assert(not r.ok and #seen == 0, "reject all before executing an invalid series")
environment = "Normal"
assert(not run(commands).ok and #seen == 0, "reject Normal")
environment = "Preview"; failAt = 2
r = run(commands)
assert(r.ok and r.result.status == "unknown" and #seen == 2, "stop on unknown feedback")
seen = {}; failAt = nil; leaveAt = 2
r = run(commands)
assert(r.ok and r.result.status == "failed" and #seen == 2, "stop when Preview changes mid-series")
seen = {}; environment = "Preview"; show = "Other"
assert(not run(commands).ok and #seen == 0, "refuse stale show identity")
print("preview command series passed")
