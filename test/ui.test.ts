import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { startHarness } from "./helpers/tool-harness.ts";
import { BridgeReplyError, SILENT } from "./helpers/fake-bridge.ts";
import { registerUiTools, uiClickCode } from "../src/tools/ui.ts";

const expected = { address: "19.4.1.2.1.4", class: "Button", name: "Settings", text: "Setup", rect: { x: 0, y: 70, w: 50, h: 50 } };
const click = { display: 1, x: 25, y: 95, expected, exclusive: true };

function findLua(): string | null {
  for (const bin of ["lua5.4", "lua54", "lua"]) {
    const r = spawnSync(bin, ["-v"], { encoding: "utf8" });
    if (r.error) continue;
    const version = `${r.stdout}${r.stderr}`.match(/Lua (\d+)\.(\d+)/);
    if (version && (Number(version[1]) > 5 || Number(version[1]) === 5 && Number(version[2]) >= 4)) return bin;
  }
  return null;
}
const lua = findLua();
const luaTest = { skip: lua ? false : "no Lua 5.4+ interpreter on PATH (install Lua to execute generated UI guards)" };
const UI_STUBS = `
local events={}
local currentName="Settings"
local modal=nil
local rect={x=0,y=70,w=50,h=50}
local h={Addr=function() return "19.4.1.2.1.4" end,GetClass=function() return "Button" end,IsVisible=function() return true end,IsEnabled=function() return true end}
function h:Get(k)
 if k=="AbsRect" then return rect elseif k=="Name" then return currentName
 elseif k=="Text" then return currentName=="Settings" and "Setup" or "Delete show" end
end
function GetDisplayByIndex() return {Get=function() return {x=0,y=0,w=2048,h=1280} end} end
function GetUIObjectAtPosition() return h end
function GetTopModal() return modal end
function Mouse(display,kind)
 events[#events+1]=kind
 if kind=="move" then
  if hover=="target" then currentName="Delete"
  elseif hover=="modal" then modal={}
  elseif hover=="geometry" then rect.x=5 end
 elseif kind=="press" and pressThrows then error("press failed after reaching console") end
end
`;

function runGeneratedClick(setup: string, assertions: string): void {
  const code = setup + "\n" + UI_STUBS + "\nlocal function run()\n" + uiClickCode({ ...click, button: "Left" }) + "\nend\nlocal r=run()\n" + assertions;
  const result = spawnSync(lua!, ["-"], { input: code, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

test("generated Lua refuses a target that changes after mouse hover", luaTest, () => {
  runGeneratedClick('local hover="target"', `
assert(r.clicked==false,"hover changed target but click was reported delivered")
assert(string.find(r.reason,"changed",1,true),r.reason)
assert(table.concat(events,",")=="move","changed target was pressed")
`);
});

test("generated Lua refuses a modal opened by mouse hover", luaTest, () => {
  runGeneratedClick('local hover="modal"', `
assert(r.clicked==false,"hover opened modal but click was reported delivered")
assert(string.find(string.lower(r.reason),"modal",1,true),r.reason)
assert(table.concat(events,",")=="move","modal opened by hover was pressed")
`);
});

test("generated Lua rechecks control geometry after hover", luaTest, () => {
  runGeneratedClick('local hover="geometry"', `
assert(r.clicked==false,"hover moved control but click was reported delivered")
assert(string.find(string.lower(r.reason),"geometry",1,true),r.reason)
assert(table.concat(events,",")=="move","moved control was pressed")
`);
});

test("generated Lua attempts release when pressing raises", luaTest, () => {
  runGeneratedClick('local pressThrows=true', `
assert(r.clicked==false and r.uncertain==true,"press failure was not unknown")
assert(table.concat(events,",")=="move,press,release","release was not attempted after press error")
`);
});

test("generated Lua delivers one press and release when hover leaves identity unchanged", luaTest, () => {
  runGeneratedClick('', `
assert(r.clicked==true,"unchanged control was refused")
assert(table.concat(events,",")=="move,press,release","click was repeated or left pressed")
`);
});

test("UI inspection returns bounded tree and UI coordinate bounds", async () => {
  const h = await startHarness(registerUiTools);
  try {
    h.fake.on("lua", () => ({ values: [{ display: 1, bounds: { x: 0, y: 0, w: 2048, h: 1280 }, nodes: [expected], truncated: true }] }));
    const r = await h.callJson("gma3_ui", { display: 1, max_nodes: 10, max_depth: 3 });
    assert.equal(r.isError, false);
    assert.equal(r.result.bounds.w, 2048);
    assert.equal(r.result.truncated, true);
  } finally { await h.close(); }
});

test("UI tools stay hidden when arbitrary Lua is disabled at the server", async () => {
  const h = await startHarness((server, ctx) => registerUiTools(server, { ...ctx, luaToolAllowed: false }));
  try { assert.equal(h.tools.size, 0); } finally { await h.close(); }
});

test("UI input validation refuses unchecked clicks before dispatch", async () => {
  const h = await startHarness(registerUiTools);
  try {
    for (const args of [{ ...click, exclusive: false }, { ...click, expected: undefined }, { ...click, x: -1 }, { ...click, display: 0 }, { ...click, expected: { ...expected, address: '1; os.exit()' } }]) {
      assert.equal((await h.call("gma3_ui_click", args)).isError, true);
    }
    assert.equal(h.fake.requests.length, 0);
  } finally { await h.close(); }
});

test("UI click delivery is distinct from verifying the button's effect", async () => {
  const h = await startHarness(registerUiTools);
  try {
    h.fake.on("lua", () => ({ values: [{ clicked: true, before: expected, x: 25, y: 95 }] }));
    const r = await h.callJson("gma3_ui_click", click);
    assert.equal(r.isError, false);
    assert.equal(r.result.outcome, "succeeded");
    assert.equal(r.result.verification.status, "unavailable");
    assert.match(r.result.summary, /inspect|read/i);
    assert.equal(h.fake.requests.filter(r => r.op === "lua").length, 1);
  } finally { await h.close(); }
});

test("UI rejects a stale or covered control without claiming a click", async () => {
  const h = await startHarness(registerUiTools);
  try {
    h.fake.on("lua", () => ({ values: [{ clicked: false, reason: "The control at this point changed", before: { ...expected, name: "Delete" } }] }));
    const r = await h.callJson("gma3_ui_click", click);
    assert.equal(r.isError, true);
    assert.equal(r.result.outcome, "failed");
    assert.match(r.result.summary, /changed/);
  } finally { await h.close(); }
});

test("UI reports a partial mouse failure as unknown and never retries", async () => {
  const h = await startHarness(registerUiTools);
  try {
    h.fake.on("lua", () => ({ values: [{ clicked: false, uncertain: true, reason: "release failed" }] }));
    const r = await h.callJson("gma3_ui_click", click);
    assert.equal(r.result.outcome, "unknown");
    assert.equal(r.isError, true);
    assert.equal(h.fake.requests.length, 1);
  } finally { await h.close(); }
});

test("UI dispatched timeout is unknown, bridge refusal is failed, neither is retried", async () => {
  for (const mode of ["timeout", "refused"]) {
    const h = await startHarness(registerUiTools, { requestTimeoutMs: 25 });
    try {
      h.fake.on("lua", () => { if (mode === "timeout") return SILENT; throw new BridgeReplyError("[busy] input owned", "busy"); });
      const r = await h.callJson("gma3_ui_click", click);
      assert.equal(r.result.outcome, mode === "timeout" ? "unknown" : "failed");
      assert.equal(h.fake.requests.length, 1);
    } finally { await h.close(); }
  }
});

test("UI malformed bridge replies fail rather than inventing tree contents", async () => {
  const h = await startHarness(registerUiTools);
  try {
    h.fake.on("lua", () => ({ values: [] }));
    const r = await h.call("gma3_ui", {});
    assert.equal(r.isError, true);
  } finally { await h.close(); }
});

test("UI malformed reply after a click is unknown because the click may have run", async () => {
  const h = await startHarness(registerUiTools);
  try {
    h.fake.on("lua", () => ({ values: [] }));
    const r = await h.callJson("gma3_ui_click", click);
    assert.equal(r.result.outcome, "unknown");
    assert.equal(h.fake.requests.length, 1);
  } finally { await h.close(); }
});

test("UI runtime or budget errors remain unknown because Lua may have already clicked", async () => {
  for (const message of ["Lua execution budget exceeded: ran longer than 100 ms", "mcp:42: attempt to index a nil value"]) {
    const h = await startHarness(registerUiTools);
    try {
      h.fake.on("lua", () => { throw new BridgeReplyError(message); });
      const r = await h.callJson("gma3_ui_click", click);
      assert.equal(r.isError, true);
      assert.equal(r.result.outcome, "unknown");
      assert.match(r.result.summary, /inspect|release/i);
      assert.equal(h.fake.requests.length, 1);
    } finally { await h.close(); }
  }
});

test("UI clear admission and Lua compile refusals fail before a click", async () => {
  for (const message of ['Lua execution is disabled on the console', 'plugin:2767: Lua compile error: unexpected symbol']) {
    const h = await startHarness(registerUiTools);
    try {
      h.fake.on("lua", () => { throw new BridgeReplyError(message); });
      const r = await h.callJson("gma3_ui_click", click);
      assert.equal(r.result.outcome, "failed");
      assert.equal(h.fake.requests.length, 1);
    } finally { await h.close(); }
  }
});
