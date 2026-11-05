import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { registerWorkspaceUiTools, workspaceCode } from "../src/tools/workspace-ui.ts";
import { startHarness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

const appearance = (fields: Record<string, unknown> = {}) => ({
  class: "Appearance",
  addr: "14.4.30",
  fields: { LOCK: "", SYSTEMLOCKED: false, STRUCTURELOCKED: false, ...fields },
});

test("appearance preview validates all assignment targets without mutation", async () => {
  const h = await startHarness(registerWorkspaceUiTools);
  try {
    h.fake.on("objects", () => ({ total: 0, items: [] }));
    const { result, isError } = await h.callJson("gma3_configure_appearance", {
      appearance: 30,
      foreground: "#f0a080",
      assign_to: ["Macro 999"],
    });
    assert.equal(isError, true);
    assert.match(JSON.stringify(result), /Macro 999/);
    assert.deepEqual(h.fake.commands, []);
  } finally {
    await h.close();
  }
});

test("creates byte-based appearance colour and verifies assigned object identity", async () => {
  const h = await startHarness(registerWorkspaceUiTools);
  const objects = new Map<string, any>([
    [
      "Macro 2",
      {
        class: "Macro",
        addr: "14.14.1.12.2",
        fields: { LOCK: "", SYSTEMLOCKED: false, STRUCTURELOCKED: false, APPEARANCE: "" },
      },
    ],
  ]);
  try {
    h.fake.on("objects", (a) => ({
      total: objects.has(String(a.ref)) ? 1 : 0,
      items: objects.has(String(a.ref)) ? [objects.get(String(a.ref))] : [],
    }));
    h.fake.onCommand((c) => {
      if (c === 'Store Appearance 30 "Ready" /NoConfirmation')
        objects.set("Appearance 30", appearance({ NAME: "Ready" }));
      else if (c === "Assign Appearance 30 At Macro 2") objects.get("Macro 2").fields.APPEARANCE = { addr: "14.4.30" };
      else throw new Error(c);
      return "OK";
    });
    h.fake.on("set", (a) => {
      const row = objects.get(String(a.ref));
      row.fields[String(a.property)] = a.value;
      return { readOk: true, value: a.value };
    });
    const { result, isError } = await h.callJson("gma3_configure_appearance", {
      appearance: 30,
      name: "Ready",
      foreground: "#FF8000",
      background: "#10182080",
      assign_to: ["Macro 2"],
      dry_run: false,
    });
    assert.equal(isError, false);
    assert.equal(result.verification.status, "matched");
    assert.equal(objects.get("Appearance 30").fields.IMAGEG, 128);
    assert.equal(objects.get("Appearance 30").fields.BACKALPHA, 128);
    assert.equal(h.fake.commands.length, 2);
  } finally {
    await h.close();
  }
});

test("refuses occupied appearance slots and replacing another object's appearance by default", async () => {
  const h = await startHarness(registerWorkspaceUiTools);
  try {
    h.fake.on("objects", (a) => ({
      total: 1,
      items: [
        String(a.ref) === "Appearance 30"
          ? appearance()
          : {
              class: "Macro",
              addr: "1.2",
              fields: { LOCK: "", SYSTEMLOCKED: false, STRUCTURELOCKED: false, APPEARANCE: { addr: "14.4.99" } },
            },
      ],
    }));
    for (const args of [
      { appearance: 30, foreground: "#FF0000" },
      { appearance: 30, mode: "update", assign_to: ["Macro 2"] },
    ])
      assert.equal((await h.call("gma3_configure_appearance", { ...args, dry_run: false })).isError, true);
    assert.deepEqual(h.fake.commands, []);
    assert.equal(
      h.fake.requests.some((r) => r.op === "set"),
      false,
    );
  } finally {
    await h.close();
  }
});

test("appearance writes stop at uncertain delivery and retain unknown status", async () => {
  const h = await startHarness(registerWorkspaceUiTools, { requestTimeoutMs: 100 });
  try {
    h.fake.on("objects", () => ({
      total: 1,
      items: [appearance({ IMAGER: 0, IMAGEG: 0, IMAGEB: 0, IMAGEALPHA: 255 })],
    }));
    h.fake.on("set", () => SILENT);
    const { result, isError } = await h.callJson("gma3_configure_appearance", {
      appearance: 30,
      mode: "update",
      foreground: "#FF8000",
      dry_run: false,
    });
    assert.equal(isError, true);
    assert.equal(result.outcome, "unknown");
    assert.equal(h.fake.requests.filter((r) => r.op === "set").length, 1);
  } finally {
    await h.close();
  }
});

test("appearance apply errors when a successful read returns a different final object identity", async () => {
  const h = await startHarness(registerWorkspaceUiTools);
  let calls = 0;
  try {
    h.fake.on("objects", () => ({
      total: 1,
      items: [
        {
          ...appearance({ IMAGER: 0, IMAGEG: 0, IMAGEB: 0, IMAGEALPHA: 255 }),
          addr: ++calls === 1 ? "14.4.30" : "14.4.31",
        },
      ],
    }));
    const { isError, result } = await h.callJson("gma3_configure_appearance", {
      appearance: 30,
      mode: "update",
      foreground: "#000000",
      dry_run: false,
    });
    assert.equal(isError, true);
    assert.notEqual(result.outcome, "succeeded");
  } finally {
    await h.close();
  }
});

test("does not overwrite a target appearance changed after preflight", async () => {
  const h = await startHarness(registerWorkspaceUiTools);
  let targetReads = 0;
  try {
    h.fake.on("objects", (a) => ({
      total: 1,
      items: [
        a.ref === "Appearance 30"
          ? appearance()
          : {
              class: "Macro",
              addr: "1.2",
              fields: {
                LOCK: "",
                SYSTEMLOCKED: false,
                STRUCTURELOCKED: false,
                APPEARANCE: ++targetReads === 1 ? "" : { addr: "14.4.99" },
              },
            },
      ],
    }));
    h.fake.onCommand(() => "OK");
    const { isError } = await h.callJson("gma3_configure_appearance", {
      appearance: 30,
      mode: "update",
      assign_to: ["Macro 2"],
      dry_run: false,
    });
    assert.equal(isError, true);
    assert.deepEqual(h.fake.commands, []);
  } finally {
    await h.close();
  }
});

const lua = ["lua5.4", "lua54", "lua"].find((bin) => !spawnSync(bin, ["-v"]).error);
const luaTest = { skip: lua ? false : "Lua 5.4+ required for generated workspace guard checks" };
const STUBS = `
local windows={}
local commands={}
local columns,rows=36,20
local content={Addr=function() return "14.19.1.5.1" end,Count=function() return #windows end,Children=function() return windows end}
local config={Addr=function() return "14.19.1.5" end,ScreenContents={Ptr=function(_,i) if i==1 then return content end end}}
function CurrentScreenConfig() return config end
function GetDisplayByIndex(i) if i~=1 then return nil end return {FindRecursive=function() return {Columns=columns,Rows=rows} end} end
function GetTopModal() return nil end
function Root() return {MANetSocket={Get=function(_,key) if key=="HostName" then return "TestStation" end return "Scratch" end}} end
local function add(name,x,y,w,h)
 local index=#windows+1
 windows[index]={Name=name,X=x,Y=y,W=w,H=h,Addr=function() return "14.19.1.5.1."..index end,GetClass=function() return "ViewWidget" end}
end
function Cmd(command)
 commands[#commands+1]=command
 local name,x,y,w,h=command:match('Store ScreenContent 1 "([^"]+)" "X"=(%d+) "Y"=(%d+) "W"=(%d+) "H"=(%d+) /NoConfirmation')
 assert(name,"unexpected command "..command)
 add(name,tonumber(x),tonumber(y),tonumber(w),tonumber(h))
 if raiseAfterWrite then error("runtime failed after creating window") end
 return "OK"
end
`;
function runLua(code: string) {
  const r = spawnSync(lua!, ["-"], { input: STUBS + "\n" + code, encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return r.stdout;
}
function signature() {
  return runLua(
    `local function read() ${workspaceCode({ display: 1 })} end\nlocal r=read();assert(r.snapshot);io.write(r.snapshot.signature)`,
  );
}

test("generated workspace code reads actual grid and creates one checked native window", luaTest, () => {
  runLua(`local function apply() ${workspaceCode({ display: 1, expected_snapshot: signature(), window: { type: "Window3D", x: 0, y: 0, w: 20, h: 20 } })} end
local r=apply();assert(r.dispatched==true);assert(r.feedback=="OK");assert(#commands==1);assert(#windows==1);assert(windows[1].W==20)`);
});

test("generated workspace code refuses stale grid and overlapping existing windows", luaTest, () => {
  for (const setup of ["columns=35", "add('Window3D',0,0,10,10)"])
    runLua(`${setup}\nlocal function apply() ${workspaceCode({ display: 1, expected_snapshot: signature(), window: { type: "Window3D", x: 0, y: 0, w: 20, h: 20 } })} end
local r=apply();assert(r.dispatched==false);assert(#commands==0)`);
});

test("generated workspace code validates screen bounds and native minimum window size", luaTest, () => {
  for (const window of [
    { type: "Window3D", x: 30, y: 0, w: 20, h: 20 },
    { type: "WindowSequenceSheet", x: 0, y: 0, w: 2, h: 3 },
  ])
    runLua(`local function apply() ${workspaceCode({ display: 1, expected_snapshot: signature(), window })} end
local r=apply();assert(r.dispatched==false);assert(#commands==0)`);
});

test("generated workspace code reports runtime exceptions after Cmd as uncertain", luaTest, () => {
  runLua(`raiseAfterWrite=true\nlocal function apply() ${workspaceCode({ display: 1, expected_snapshot: signature(), window: { type: "Window3D", x: 0, y: 0, w: 20, h: 20 } })} end
local r=apply();assert(r.dispatched==true and r.uncertain==true);assert(#commands==1);assert(#windows==1)`);
});

test("workspace preview is read-only and apply requires matching preview signature and exclusive access", async () => {
  const h = await startHarness(registerWorkspaceUiTools);
  const snap = { display: 1, columns: 36, rows: 20, signature: "snapshot-1", windows: [], identity: "test" };
  try {
    h.fake.on("lua", () => ({ values: [{ snapshot: snap }] }));
    const windows = [{ type: "Window3D", x: 0, y: 0, w: 20, h: 20 }];
    const preview = await h.callJson("gma3_build_workspace", { display: 1, windows });
    assert.equal(preview.isError, false);
    assert.equal(preview.result.preview, true);
    assert.equal(preview.result.expected_snapshot, "snapshot-1");
    for (const args of [{ dry_run: false }, { dry_run: false, exclusive: true, expected_snapshot: "stale" }])
      assert.equal((await h.call("gma3_build_workspace", { display: 1, windows, ...args })).isError, true);
    assert.equal(
      h.fake.requests.every((r) => !String(r.args.code).includes("local requested = {")),
      true,
    );
  } finally {
    await h.close();
  }
});

test("workspace runtime exceptions remain unknown and no second creation is sent", async () => {
  const h = await startHarness(registerWorkspaceUiTools);
  let calls = 0;
  try {
    h.fake.on("lua", () => {
      calls++;
      if (calls === 2) throw new Error("runtime exception after mutation");
      return {
        values: [{ snapshot: { display: 1, columns: 36, rows: 20, signature: "s", identity: "test", windows: [] } }],
      };
    });
    const { result, isError } = await h.callJson("gma3_build_workspace", {
      display: 1,
      windows: [
        { type: "Window3D", x: 0, y: 0, w: 20, h: 20 },
        { type: "WindowSequenceSheet", x: 20, y: 0, w: 16, h: 20 },
      ],
      dry_run: false,
      exclusive: true,
      expected_snapshot: "s",
    });
    assert.equal(isError, true);
    assert.equal(result.outcome, "unknown");
    assert.equal(calls, 3);
  } finally {
    await h.close();
  }
});

test("workspace keeps latest actual snapshot after uncertain creation", async () => {
  const h = await startHarness(registerWorkspaceUiTools);
  let calls = 0;
  try {
    h.fake.on("lua", () => {
      calls++;
      if (calls === 2) throw new Error("runtime exception after mutation");
      return {
        values: [
          {
            snapshot: {
              display: 1,
              columns: 36,
              rows: 20,
              signature: calls === 1 ? "s" : "after",
              identity: "test",
              windows: calls === 1 ? [] : [{ address: "1.1", name: "Window3D", x: 0, y: 0, w: 20, h: 20 }],
            },
          },
        ],
      };
    });
    const { result } = await h.callJson("gma3_build_workspace", {
      display: 1,
      windows: [{ type: "Window3D", x: 0, y: 0, w: 20, h: 20 }],
      dry_run: false,
      exclusive: true,
      expected_snapshot: "s",
    });
    assert.equal(result.outcome, "unknown");
    assert.equal(result.snapshot.windows.length, 1);
  } finally {
    await h.close();
  }
});

test("native nil appearance handles require schema plus matching empty display-role evidence", async () => {
  const h = await startHarness(registerWorkspaceUiTools);
  try {
    const target = { class: "Layout", addr: "14.14.1.14.9010", fields: { LOCK: "", SYSTEMLOCKED: false, STRUCTURELOCKED: false } };
    h.fake.on("objects", a => ({ total: a.ref === "Appearance 30" ? 0 : 1, items: a.ref === "Appearance 30" ? [] : [target] }));
    h.fake.on("object", () => ({ class: "Layout", addr: target.addr, schema: [{ name: "APPEARANCE", type: "Handle" }], properties: { APPEARANCE: "" } }));
    const args = { appearance: 30, foreground: "#FF8000", assign_to: ["Layout 9010"] };
    const good = await h.callJson("gma3_configure_appearance", args);
    assert.equal(good.isError, false);
    h.fake.on("object", () => ({ class: "Layout", addr: "changed", schema: [{ name: "APPEARANCE", type: "Handle" }], properties: { APPEARANCE: "" } }));
    assert.equal((await h.callJson("gma3_configure_appearance", args)).isError, true);
    h.fake.on("object", () => ({ class: "Layout", addr: target.addr, schema: [], properties: { APPEARANCE: "" } }));
    assert.equal((await h.callJson("gma3_configure_appearance", args)).isError, true);
    h.fake.on("object", () => ({ class: "Layout", addr: target.addr, schema: [{ name: "APPEARANCE", type: "Handle" }], properties: {} }));
    assert.equal((await h.callJson("gma3_configure_appearance", args)).isError, true);
    assert.deepEqual(h.fake.commands, []);
  } finally { await h.close(); }
});
