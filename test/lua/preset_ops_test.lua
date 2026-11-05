-- Regression harness for the bridge's SB-03 preset reads (preset.read, preset.context) under stock Lua (5.4 or
-- newer).
--
-- Presets are modelled with userdata handles and GetPresetData tables shaped as onPC 2.5.1 returns them
-- (by_fixtures[<fid>][<attribute>] = { [1] = step, preset_store_mode, ui_channel_index, fade, delay, dict_flags,
-- abs_preset }), Get("Dependencies") as { { key = <handle>, content_crc, name_crc } }, and a deleted source as a
-- handle IsObjectValid reports invalid.
--
-- Run from the repository root:   lua test/lua/preset_ops_test.lua

local here = (arg and arg[0] or ""):match("^(.*)[/\\]") or "."
package.path = here .. "/?.lua;" .. package.path
local pluginPath = here .. "/../../plugin/gma3_mcp_bridge.lua"

package.preload["socket"] = function()
  return { gettime = function() return os.clock() end, bind = function() return nil, "stub: no bind" end }
end
Echo = function() end
ErrEcho = Echo; Printf = Echo; ErrPrintf = Echo
GetPath = function() return nil end
Enums = { PathType = { Temp = 1 }, Roles = { Display = 1, Edit = 2 }, VirtualKeyCode = {}, KeyboardCodes = {} }
Keyboard = function() end
CurrentProfile = function() return { name = "Default", KeyboardShortCuts = { Get = function() return "true" end, Count = function() return 0 end } } end
GetDisplayByIndex = function() return nil end
BuildDetails = function() return {} end
Root = function() return { Get = function() return false end, VirtualKeys = { Count = function() return 0 end }, MANetSocket = { Get = function() return nil end }, maNetSocket = {} } end
CurrentUser = function() return nil end

-------------------------------------------------------------------------------
-- Fake handles
-------------------------------------------------------------------------------

local registry = setmetatable({}, { __mode = "k" })
local fileMeta = getmetatable(io.stdout)
local handleMeta = { __gc = fileMeta and fileMeta.__gc, __close = fileMeta and fileMeta.__close, __name = "FakeHandle" }
local methods = {}
handleMeta.__index = function(u, key)
  local def = registry[u]
  if not def then return nil end
  if methods[key] then return methods[key] end
  if key == "name" then return def.name end
  if key == "no" then return def.no end
  return def.props[tostring(key):lower()]
end
function methods.Get(u, name, role)
  local v = registry[u].props[tostring(name):lower()]
  if type(v) == "function" then return v(role) end
  return v
end
function methods.GetClass(u) return registry[u].class end
function methods.Addr(u) return registry[u].addr or ("addr:" .. tostring(registry[u].name)) end
function methods.Parent(u) return registry[u].parent end
function methods.Children(u) return registry[u].children or {} end
function methods.AddrNative(u) return "native:" .. tostring(registry[u].name) end

local function H(def)
  local u = io.tmpfile()
  debug.setmetatable(u, handleMeta)
  local lowered = {}
  for k, v in pairs(def.props or {}) do lowered[tostring(k):lower()] = v end
  def.props = lowered
  registry[u] = def
  return u
end


local fixtures = H({ name = "Fixtures", class = "Fixtures" })
local f401 = H({ name = "Par 1", class = "Fixture", no = 1, parent = fixtures, props = { FID = 401, FixtureType = "6 Mega Hex Par" } })
local f402 = H({ name = "Par 2", class = "Fixture", no = 2, parent = fixtures, props = { FID = 402, FixtureType = "6 Mega Hex Par" } })
local f501 = H({ name = "Wash 1", class = "Fixture", no = 3, parent = fixtures, props = { FID = 501, FixtureType = "5 Wall Washer" } })
local c2 = H({ name = "[Instance3]", class = "SubFixture", no = 2, parent = f501, props = {} })
local bySf = { [63] = f401, [64] = f402, [12] = c2 }
local uiToSf = { [320] = 63, [321] = 63, [330] = 64, [700] = 12 }
GetSubfixture = function(i) return bySf[i] end
GetUIChannel = function(ui) local sf = uiToSf[ui]; return sf and { sf_index = sf, ui_index = ui } or nil end

local colorPool = H({ name = "Color", class = "Presets", no = 4, props = { PresetMode = "Universal", InputFilter = "" } })
local allPool = H({ name = "All 3", class = "Presets", no = 23, props = { PresetMode = "Selective", InputFilter = "" } })
local source = H({ name = "Red", class = "Preset", no = 902, parent = colorPool, addr = "14.14.1.5.4.902", props = { StoredData = "Global", PresetMode = "Global", FeatureGroup = "Color", Lock = "", MaxDepth = 0, References = "1073744458:1,1073744578:1" } })
local deleted = H({ name = "Gone", class = "Preset", no = 904, parent = colorPool, addr = "14.14.1.5.4.904", props = {} })
local invalid = { [deleted] = true }
IsObjectValid = function(h) return not invalid[h] end

local function step(v) return { absolute = v, absolute_value = math.floor(v / 100 * 16777216), channel_function = 0, mask_individual = 2 } end
local function chan(ui, pm, v, extra)
  local c = { step(v), ui_channel_index = ui, preset_store_mode = pm, selective = pm == 1, mask_cooked = 0, dict_flags = { has_absolute = 1, has_relative = 0 } }
  for k, x in pairs(extra or {}) do c[k] = x end
  return c
end
local embeddedData = { count = 4, by_fixtures = {
  ["401"] = { ColorRGB_R = chan(320, 1, 100, { abs_preset = source }), Dimmer = chan(321, 1, 50, { fade = 3.0 }) },
  ["402"] = { ColorRGB_R = chan(330, 2, 0, { delay = 1.0 }) },
  ["501.2"] = { ColorRGB_R = { { absolute = 10, trans = 0, width = 50 }, { absolute = 90, accel = -100, decel = 20, accel_type = 2, integrated = source }, ui_channel_index = 700, preset_store_mode = 3, speed = 2.0, phase = 90, measure = 400, speed_master = 1, dict_flags = { has_absolute = 1, has_relative = 1 } } },
} }
local embedded = H({ name = "Look", class = "Preset", no = 3, parent = allPool, addr = "14.14.1.5.23.3", props = {
  StoredData = "Selective/Global", PresetMode = "Selective", FeatureGroup = "", Lock = "UL", MaxDepth = 0, HasAnyMAtricksData = "No",
  Dependencies = { { key = source, content_crc = 1920816742600600000, name_crc = -3 }, { key = deleted, content_crc = 7, name_crc = 8 } },
} })
local unreadable = H({ name = "Bad", class = "Preset", no = 5, parent = allPool, props = {} })
local part = H({ name = "Part 0", class = "Part", no = 0, props = {} })
local presetData = { [embedded] = embeddedData, [source] = { by_fixtures = {} }, [part] = { by_fixtures = { ["401"] = { ColorRGB_R = chan(320, 0, 100, { mask_cooked = 511 }), Dimmer = chan(321, 0, 70) } } } }
GetPresetData = function(h) return presetData[h] end
local seq = H({ name = "Seq", class = "Sequence", no = 1, props = {} })
local objects = { ["Preset 23.3"] = embedded, ["Preset 4.902"] = source, ["Preset 23.5"] = unreadable, ["Sequence 9 Cue 1 Part 0"] = part, ["Sequence 1"] = seq, ["Preset 4"] = colorPool, ["Preset 23"] = allPool }
ObjectList = function(ref) if ref:find("%.%-") then return nil end; local h = objects[ref]; if not h then for _, candidate in pairs(objects) do if methods.Addr(candidate) == ref then h = candidate; break end end end; return h and { h } or nil end

local prefs = H({ name = "StorePreferences", class = "StorePreferences", props = { StoreMode = "Ask", StoreSource = "Programmer", ChannelFilter = "Active", StoreLook = "No", PresetMode = "Default", PresetInputFilter = "Yes", StoreEmbedded = "No", StoreMAtricks = "Yes", KeepActivation = "No" } })
local profileWithPrefs = { name = "Default", StorePreferences = prefs, KeyboardShortCuts = { Get = function() return "true" end, Count = function() return 0 end } }

-------------------------------------------------------------------------------
-- Load the plugin
-------------------------------------------------------------------------------

local signals = {}
local pluginHandle = { name = "gma3_mcp_bridge", Count = function() return 1 end, Ptr = function(_, i) return i == 1 and { name = "gma3_mcp_bridge", Get = function() return false end } or nil end }
local componentHandle = { name = "gma3_mcp_bridge", Parent = function() return pluginHandle end }
local chunk = assert(loadfile(pluginPath))
chunk("gma3_mcp_bridge", "gma3_mcp_bridge", signals, componentHandle)
local state = _G.__gma3_mcp_bridge
local json = require("json")
CurrentProfile = function() return profileWithPrefs end

local failures, passes = 0, 0
local function check(name, cond, detail)
  if cond then passes = passes + 1; print("PASS " .. name)
  else failures = failures + 1; print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or "")) end
end
local function J(v) local ok, s = pcall(json.encode, v); return ok and s or tostring(v) end
local defaultClient = { id = 1 }
local function request(op, args, client)
  local line = json.encode({ id = "t", op = op, args = args or {} })
  local co = coroutine.create(function() return state._handleLine(client or defaultClient, line) end)
  local ok, res = coroutine.resume(co)
  while ok and coroutine.status(co) == "suspended" do ok, res = coroutine.resume(co) end
  assert(ok, res)
  return json.decode(res)
end

local r = request("ping")
check("ping reports bridge 0.30.0", r.ok and r.result.bridgeVersion == "0.51.0", J(r))

r = request("preset.read", { ref = "Preset 23.3" })
local res = r.ok and r.result or {}
local rows = res.rows or {}
local function row(fixture, attr) for _, x in ipairs(rows) do if x.fixture == fixture and x.attribute == attr then return x end end end
check("preset.read: summary fields in the edit role", r.ok and res.storedData == "Selective/Global" and res.presetMode == "Selective" and res.lock == "UL" and res.pool.no == 23 and res.pool.name == "All 3" and res.no == 3, J(res))
check("preset.read: one row per fixture and attribute, sorted by subfixture index", #rows == 4 and rows[1].fixture == "501.2" and rows[2].attribute == "ColorRGB_R" and rows[3].attribute == "Dimmer" and rows[4].fixture == "402", J(rows))
local r401 = row("401", "ColorRGB_R")
check("preset.read: mode, value, subfixture and fixture type", r401 and r401.mode == "selective" and r401.value == 100 and r401.sfIndex == 63 and r401.fixtureType == "6 Mega Hex Par" and r401.hasAbsolute == true, J(r401))
check("preset.read: an embedded value names its source preset", r401 and r401.absPreset and r401.absPreset.valid == true and r401.absPreset.addr == "14.14.1.5.4.902" and r401.absPreset.no == 902 and r401.absPreset.pool == 4, J(r401))
check("preset.read: fade and delay layers", row("401", "Dimmer").fade == 3.0 and row("402", "ColorRGB_R").delay == 1.0 and row("402", "ColorRGB_R").mode == "global", J(rows))
local cell = row("501.2", "ColorRGB_R")
check("preset.read: a cell's fixture type comes from its fixture; multi-step rows list steps", cell and cell.fixtureType == "5 Wall Washer" and cell.mode == "universal" and cell.value == nil and #cell.steps == 2 and cell.steps[2].absolute == 90 and cell.hasRelative == true, J(cell))
check("preset.read: phaser steps carry their layers and integrated preset; the row its phaser layers", cell and cell.steps[1].trans == 0 and cell.steps[1].width == 50 and cell.steps[2].accel == -100 and cell.steps[2].decel == 20 and cell.steps[2].accelType == 2 and cell.steps[2].integrated and cell.steps[2].integrated.no == 902 and cell.steps[1].integrated == nil and cell.speed == 2.0 and cell.phase == 90 and cell.measure == 400 and cell.speedMaster == 1, J(cell))
check("preset.read: dependencies with validity and checksum, a deleted source invalid", #res.dependencies == 2 and res.dependencies[1].valid == true and res.dependencies[1].addr == "14.14.1.5.4.902" and res.dependencies[1].contentCrc ~= nil and res.dependencies[2].valid == false and res.dependenciesReadable == true, J(res.dependencies))

r = request("preset.read", { ref = "Preset 23.3", typesFor = { 63, 12, 99 } })
check("preset.read: typesFor gives the fixture type of any subfixture, the same way rows do", r.ok and r.result.types["63"] == "6 Mega Hex Par" and r.result.types["12"] == "5 Wall Washer" and r.result.types["99"] == nil, J(r.result.types))

r = request("preset.read", { ref = "Preset 4.902" })
check("preset.read: references are counted, an empty preset has an empty rows array", r.ok and r.result.referencedBy == 2 and r.result.count == 0 and J(r):find('"rows":%[%]') ~= nil and J(r):find('"dependencies":%[%]') ~= nil, J(r))
r = request("preset.read", { ref = "Preset 23.5" })
check("preset.read: unreadable preset data is an error, never an empty preset", r.ok == false and r.code == "unreadable", J(r))
r = request("preset.read", { ref = "Sequence 9 Cue 1 Part 0" })
local pr = r.ok and r.result.rows or {}
check("preset.read: a cue part is read like a preset, rows say what was cooked", r.ok and r.result.class == "Part" and #pr == 2 and pr[1].attribute == "ColorRGB_R" and pr[1].cooked == true and pr[2].attribute == "Dimmer" and pr[2].cooked == false, J(r))
check("preset.read: a preset's rows are not cooked unless the channel says so", row("401", "ColorRGB_R").cooked == false, J(rows))
r = request("preset.read", { ref = "Sequence 1" })
check("preset.read: a non-preset is refused", r.ok == false and r.code == "not-preset", J(r))

r = request("preset.context", { pool = 4 })
check("preset.context: store preferences and the pool's defaults", r.ok and r.result.preferencesReadable == true and r.result.preferences.StoreMode == "Ask" and r.result.preferences.StoreEmbedded == "No" and r.result.pool.exists == true and r.result.pool.presetMode == "Universal" and r.result.pool.name == "Color", J(r))
r = request("preset.context", { pool = 99 })
check("preset.context: a missing pool", r.ok and r.result.pool.exists == false and r.result.pool.no == 99, J(r))
r = request("preset.context", {})
check("preset.context: no pool, preferences only", r.ok and r.result.pool == nil and r.result.preferences.KeepActivation == "No", J(r))

-- Native cue content preserves every raw channel field, including release/block flags.
local cue = H({ name = "First", class = "Cue", no = 1000, parent = seq, children = { part }, props = { Tracking = "Yes", CueFade = "0" } })
registry[seq].children = { cue }
registry[part].parent = cue
presetData[part].count = 2
presetData[part].by_fixtures["401"].Dimmer.dict_flags.blocked = 1
r = request("cue.content", { ref = "Sequence 1" })
check("cue.content: complete native cue parts and raw flags", r.ok and r.result.complete == true and #r.result.cues == 1 and #r.result.cues[1].parts == 1 and json.decode(r.result.cues[1].parts[1].contentJson).rows[2].dictFlags.blocked == 1 and r.result.cues[1].parts[1].rawChannelsJson ~= nil, J(r))
presetData[part].count = 3
r = request("cue.content", { ref = "Sequence 1" })
check("cue.content: unmapped native channels prevent complete assertion", r.ok and r.result.complete == false, J(r))
presetData[part].count = 2
presetData[part].by_fixtures["401"].Dimmer[1].absolute = "release"
objects["Sequence 1 Cue 1"] = cue
r = request("cue.content", { ref = "Sequence 1 Cue 1" })
check("cue.content: release remains a release value", r.ok and r.result.complete == true and json.decode(r.result.cues[1].parts[1].contentJson).rows[2].value == "release", J(r))

presetData[part].by_fixtures["401"].Dimmer[1].absolute=6600
presetData[part].by_fixtures["401"].Dimmer[1].abs_release=true
r=request("preset.read",{ref="Sequence 9 Cue 1 Part 0"})
check("preset.read: native abs_release flag identifies release without guessing the number",r.ok and r.result.rows[2].valueKind=="release" and r.result.rows[2].value==6600,J(r))
registry[part].addr="14.14.1.7.9.-1.0"
r=request("cue.content",{ref="Sequence 1"})
check("cue.content: native negative cue-part database addresses need no re-resolution",r.ok and r.result.complete==true and json.decode(r.result.cues[1].parts[1].contentJson).count==2,J(r))

-- Frozen cue pages cover large lists without rescanning or mixing later edits into the capture.
local previousRoot, previousUser, previousEnvironment = Root, CurrentUser, CurrentEnvironment
Root = function() return { MANetSocket = { Get = function() return "Paged Lab" end }, maNetSocket = { hostname = "Paged Station" } } end
CurrentUser = function() return {name="Admin"} end
CurrentEnvironment = function() return {name="Normal"} end
local function internalCue(name, no, addr)
  local p = H({name="Part 0",class="Part",addr=addr..".0"})
  presetData[p] = {count=0,by_fixtures={}}
  return H({name=name,no=no,class="Cue",addr=addr,children={p}})
end
local internalSeq = H({name="Internals",class="Sequence",addr="INTERNAL",children={
  internalCue("OffCue",nil,"INTERNAL.0"), internalCue("CueZero",0,"INTERNAL.1000")
}})
objects["Sequence 6"] = internalSeq
local internalRead = request("cue.content",{action="create",ref="Sequence 6"})
check("cue.content: recognized internal main parts need no native Part property",
  internalRead.ok and internalRead.result.complete and internalRead.result.cues[1].parts[1].no==0
  and internalRead.result.cues[2].parts[1].no==0,J(internalRead))
request("cue.content",{action="release",snapshotId=internalRead.result.snapshotId})
local pagedParts, pagedCues = {}, {}
for i=1,503 do
  -- Native Part numbers can differ from address slots; the handle's no is absent.
  local p=H({name="Paged Part",class="Part",addr="PAGED.C"..i..".1",props={Part=i==201 and 2 or 0}})
  pagedParts[i]=p; presetData[p]={count=0,by_fixtures={}}
  pagedCues[i]=H({name="Paged "..i,class="Cue",no=i*1000,addr="PAGED.C"..i,children={p},props={AllowDuplicates="Yes"}})
end
local pagedSeq=H({name="Paged",class="Sequence",no=5,addr="PAGED",children=pagedCues,props={Tracking="Yes"}})
objects["Sequence 5"]=pagedSeq
local nativeReads=0
GetPresetData=function(h) nativeReads=nativeReads+1; return presetData[h] end
local caps=request("cue.content",{action="capabilities"})
check("cue.content: declares bounded frozen paging capability",caps.ok and caps.result.protocol=="gma3-cue-snapshot-v1" and caps.result.maxCueObjects==10002 and caps.result.maxPageCues==200,J(caps))
local captured=request("cue.content",{action="create",ref="Sequence 5",limit=200,ttlMs=60000})
local cs=captured.ok and captured.result or {}
check("cue.content: captures all503 objects but replies with200",captured.ok and cs.complete and cs.frozen and cs.atomic==false and cs.total==503 and #cs.cues==200 and #cs.cueOrder==503 and cs.cues[1].fields.AllowDuplicates=="Yes",J(captured))
local readsAtCapture=nativeReads
check("cue.content: normalized and raw data use one native observation per part",readsAtCapture==503,tostring(readsAtCapture))
presetData[pagedParts[201]]={count=999,by_fixtures={}}
local nextPage=request("cue.content",{action="page",snapshotId=cs.snapshotId,cursor=cs.nextCursor,limit=200})
check("cue.content: later edit cannot mix into frozen pages or trigger native rescan",nextPage.ok and nextPage.result.offset==200 and #nextPage.result.cues==200 and json.decode(nextPage.result.cues[1].parts[1].contentJson).count==0 and nativeReads==readsAtCapture,J(nextPage):sub(1,1200))
check("cue.content: raw Part property supplies the native part number instead of the address slot",nextPage.ok and nextPage.result.cues[1].parts[1].no==2)
local foreign=request("cue.content",{action="page",snapshotId=cs.snapshotId,cursor=cs.nextCursor,limit=200},{id=2})
check("cue.content: frozen snapshots belong to one client",not foreign.ok and foreign.code=="snapshot-unavailable",J(foreign))
local tail=request("cue.content",{action="page",snapshotId=cs.snapshotId,cursor=nextPage.ok and nextPage.result.nextCursor,limit=200})
check("cue.content: final page covers remaining103 without rescan",tail.ok and tail.result.offset==400 and #tail.result.cues==103 and tail.result.nextCursor==nil and nativeReads==readsAtCapture,J(tail))
check("cue.content: invalid cursor and limit are rejected",not request("cue.content",{action="page",snapshotId=cs.snapshotId,cursor="foreign/200"}).ok and not request("cue.content",{action="create",ref="Sequence 5",limit=201}).ok)
check("cue.content: snapshot release is confirmed",request("cue.content",{action="release",snapshotId=cs.snapshotId}).result.released==true)
check("cue.content: released snapshot cannot be reused",not request("cue.content",{action="page",snapshotId=cs.snapshotId,cursor=cs.nextCursor}).ok)
Root, CurrentUser, CurrentEnvironment = previousRoot, previousUser, previousEnvironment

function methods.PropertyCount(u) local n=0; for _ in pairs(registry[u].props) do n=n+1 end; return n end
function methods.PropertyName(u,i) local names={}; for k in pairs(registry[u].props) do names[#names+1]=k:upper() end; table.sort(names); return names[i+1] end
function methods.PropertyInfo() return {ReadOnly=false} end
local settings = H({name="FixtureSheetSettings",class="FixtureSheetSettings",props={SelectedOnly="Yes",GUID="volatile-settings"}})
local widget = H({name="WindowFixtureSheet",class="ViewWidget",props={Name="WindowFixtureSheet",X=0,Y=0,W=10,H=8,Display=1,GUID="volatile-window"},children={settings}})
local view = H({name="Native View",class="View",props={Name="Native View",ScreenContentMask=1},children={widget}})
objects["View 9001"]=view
r = request("view.content", {ref="View 9001"})
local vc = r.ok and r.result or {}
check("view.content: saved settings and rectangles are read without volatile IDs", r.ok and vc.complete==true and type(vc.contentJson)=="string" and vc.contentJson:find('SELECTEDONLY') and not vc.contentJson:find('volatile'),J(r))
registry[settings].props.selectedonly="No"
local changed=request("view.content",{ref="View 9001"})
check("view.content: changing a nested saved window setting changes content", changed.ok and changed.result.contentJson~=vc.contentJson,J(changed))

registry[widget].addr="14.19.1.4.9001.1"
registry[settings].addr="14.19.1.4.9001.1.1"
registry[settings].props.owner=widget
local twinSettings=H({name="FixtureSheetSettings",class="FixtureSheetSettings",addr="14.19.1.11.1.1.1.1.1",props={SelectedOnly="No"}})
local twin=H({name="WindowFixtureSheet",class="ViewWidget",addr="14.19.1.11.1.1.1.1",props={Name="WindowFixtureSheet",X=0,Y=0,W=10,H=8,Display=1},children={twinSettings}})
registry[twinSettings].props.owner=twin
objects["View 9002"]=H({name="Twin",class="View",props={ScreenContentMask=1},children={twin}})
local selfReference=request("view.content",{ref="View 9001"})
local twinReference=request("view.content",{ref="View 9002"})
check("view.content: a self-window handle normalizes across saved/live address roots",selfReference.ok and twinReference.ok and selfReference.result.complete and twinReference.result.complete and selfReference.result.contentJson==twinReference.result.contentJson,J(selfReference))

function methods.Count(u) return #(registry[u].children or {}) end
local referenced=H({name="Referenced Sequence",class="Sequence",addr="14.14.1.7.500",children={}})
registry[settings].props.target=referenced
local handleBefore=request("view.content",{ref="View 9001"})
registry[referenced].children={H({name="Auto cache",class="Transient",props={}})}
local handleAfter=request("view.content",{ref="View 9001"})
check("view.content: reference-target runtime childCount cannot change saved configuration identity",handleBefore.ok and handleAfter.ok and handleBefore.result.complete and handleAfter.result.complete and handleBefore.result.contentJson==handleAfter.result.contentJson,J({before=handleBefore.result and handleBefore.result.complete,after=handleAfter.result and handleAfter.result.complete}))
registry[settings].props.target=nil

local opaque=io.tmpfile()
registry[settings].props.opaque=opaque
r=request("view.content",{ref="View 9001"})
check("view.content: unsupported native userdata never becomes complete empty handle metadata",r.ok and r.result.complete==false,J(r))
registry[settings].props.opaque=nil
registry[settings].props.keyed={[opaque]="value"}
r=request("view.content",{ref="View 9001"})
check("view.content: pointer-valued table keys cannot be a complete stable configuration",r.ok and r.result.complete==false,J(r))
registry[settings].props.keyed=nil
registry[settings].props.enabled=false
r=request("view.content",{ref="View 9001"})
check("view.content: false remains a real saved value",r.ok and r.result.complete and r.result.contentJson:find('"value":false')~=nil,J(r))
registry[settings].props.enabled=nil

local actionType=io.tmpfile();debug.setmetatable(actionType,{__tostring=function() return "Action" end})
function methods.PropertyType(u,i) local name=methods.PropertyName(u,i);return name=="ACTION" and actionType or "String" end
registry[settings].props.action=opaque
r=request("view.content",{ref="View 9001"})
check("view.content: userdata Action property type is skipped before reading its value",r.ok and r.result.complete and not r.result.contentJson:find('"name":"ACTION"'),J(r))
registry[settings].props.action=nil

local realPropertyCount=methods.PropertyCount
function methods.PropertyCount(u) if u==settings then error("enumeration failed") end;return realPropertyCount(u) end
r=request("view.content",{ref="View 9001"})
check("view.content: failed property enumeration is explicitly incomplete",r.ok and r.result.complete==false,J(r))
local propertyNameCalls=0
local realPropertyName=methods.PropertyName
function methods.PropertyCount(u) if u==settings then return 1000000 end;return realPropertyCount(u) end
function methods.PropertyName(u,i) propertyNameCalls=propertyNameCalls+1;if u==settings then return "Property"..i end;return realPropertyName(u,i) end
r=request("view.content",{ref="View 9001"})
check("view.content: oversized schema is bounded before enumerating a million names",r.ok and r.result.complete==false and propertyNameCalls<100,J({ok=r.ok,complete=r.result and r.result.complete,propertyNameCalls=propertyNameCalls}))
methods.PropertyCount,methods.PropertyName=realPropertyCount,realPropertyName

-- Native View3DSettings CAMERA has a nil raw Get/property accessor even while its Edit role holds a real handle.
local typedPropertyType=methods.PropertyType
function methods.PropertyType(u,i) local name=methods.PropertyName(u,i);return (name=="CAMERA" or name=="PREFERENCEHANDLE" or name=="RENDERQUALITY") and "Handle" or typedPropertyType(u,i) end
local camera=H({name="Witness Camera",class="Camera",addr="14.19.1.3.9010",props={}})
local editCamera,displayCamera="#40000B66","Witness Camera"
StrToHandle=function(text) if text=="#40000B66" then return camera end end
registry[settings].props.camera=function(role) if role==Enums.Roles.Edit then return editCamera elseif role==Enums.Roles.Display then return displayCamera end end
r=request("view.content",{ref="View 9001"})
check("view.content: nil raw writable Handle resolves its Edit-role reference exactly",r.ok and r.result.complete and r.result.contentJson:find('14.19.1.3.9010',1,true),J(r))
editCamera,displayCamera="#DEAD","Unresolved Camera"
r=request("view.content",{ref="View 9001"})
check("view.content: unresolved nonempty Edit Handle is incomplete rather than empty",r.ok and r.result.complete==false,J(r))
editCamera,displayCamera=nil,"Visible Camera"
r=request("view.content",{ref="View 9001"})
check("view.content: visible Handle with no readable Edit identity is incomplete",r.ok and r.result.complete==false,J(r))
editCamera,displayCamera="", ""
r=request("view.content",{ref="View 9001"})
check("view.content: empty Edit and Display roles establish an empty Handle",r.ok and r.result.complete,J(r))
editCamera,displayCamera="#00000000", ""
r=request("view.content",{ref="View 9001"})
check("view.content: null Edit handle plus empty Display establishes an empty Handle",r.ok and r.result.complete,J(r))
registry[settings].props.camera=nil
local invalidSentinel=io.tmpfile();invalid[invalidSentinel]=true
StrToHandle=function(text) if text=="#FFFFFFFFFFFFFFFF" then return invalidSentinel elseif text=="#40000B66" then return camera end end
registry[settings].props.preferencehandle=function(role) if role==Enums.Roles.Edit then return "#FFFFFFFFFFFFFFFF" elseif role==Enums.Roles.Display then return "" end end
r=request("view.content",{ref="View 9001"})
check("view.content: proven invalid native sentinel is retained explicitly, not treated as an empty target",r.ok and r.result.complete and r.result.contentJson:find('invalid',1,true) and r.result.contentJson:find('#FFFFFFFFFFFFFFFF',1,true),J(r))
registry[settings].props.preferencehandle=nil
registry[settings].class="View3DSettings"
registry[settings].props.renderquality=function(role) if role==Enums.Roles.Edit then return "" elseif role==Enums.Roles.Display then return "<Standard>" end end
r=request("view.content",{ref="View 9001"})
check("view.content: observed unassigned 3D render quality retains its native selection display state",r.ok and r.result.complete and r.result.contentJson:find('unassigned',1,true) and r.result.contentJson:find('<Standard>',1,true),J(r))
registry[settings].props.renderquality=function(role) if role==Enums.Roles.Edit then return "" elseif role==Enums.Roles.Display then return "<Unknown>" end end
r=request("view.content",{ref="View 9001"})
check("view.content: unqualified same-class unassigned RenderQuality labels fail closed",r.ok and r.result.complete==false,J(r))
registry[settings].props.renderquality=function(role) if role==Enums.Roles.Edit then return "" elseif role==Enums.Roles.Display then return "<Standard>" end end
registry[settings].class="FixtureSheetSettings"
r=request("view.content",{ref="View 9001"})
check("view.content: unqualified default-display Handle semantics fail closed on other object classes",r.ok and r.result.complete==false,J(r))
registry[settings].props.renderquality=nil
registry[settings].class="View3DSettings"
editCamera,displayCamera="", "<Front>"
registry[settings].props.camera=function(role) if role==Enums.Roles.Edit then return editCamera elseif role==Enums.Roles.Display then return displayCamera end end
r=request("view.content",{ref="View 9001"})
local builtinCamera
if r.ok and r.result.contentJson then
  local content=json.decode(r.result.contentJson)
  for _,property in ipairs(content[1].configuration.children[1].properties) do
    if property.name=="CAMERA" then builtinCamera=property.value end
  end
end
local builtinFields={}
for _,entry in ipairs(builtinCamera and builtinCamera.entries or {}) do builtinFields[entry.key]=entry.value end
check("view.content: observed builtin Front camera retains exact display/edit mode without a pool identity",r.ok and r.result.complete and builtinCamera and #builtinCamera.entries==3 and builtinFields.handleState=="builtin" and builtinFields.edit=="" and builtinFields.display=="<Front>" and builtinFields.addr==nil,J(r))
displayCamera="<Unknown>"
r=request("view.content",{ref="View 9001"})
check("view.content: unqualified builtin Camera display labels fail closed",r.ok and r.result.complete==false,J(r))
displayCamera="<Front>"
editCamera="#DEAD"
r=request("view.content",{ref="View 9001"})
check("view.content: builtin Camera label cannot conceal an unresolved explicit Edit handle",r.ok and r.result.complete==false,J(r))
editCamera=""
registry[settings].class="FixtureSheetSettings"
r=request("view.content",{ref="View 9001"})
check("view.content: builtin Camera roles are qualified only on View3DSettings",r.ok and r.result.complete==false,J(r))
registry[settings].props.camera=nil
methods.PropertyType=typedPropertyType

print(string.format("%d passed, %d failed", passes, failures))
if failures > 0 then print("FAILED"); os.exit(1) end
print("ALL PASSED")
