/** Local extension: bounded console UI observation and identity-checked mouse clicks.
 * Uses the console's documented UI API through the already opted-in Lua channel.
 * A delivered click never claims its application effect was verified.
 */
import { z } from "zod";
import { BridgeError, BridgeUnreachableError } from "../bridge.js";
import { stepFromError, toToolResult, unavailable, type OperationResult } from "../results.js";
import { json, type RegisterTools, type ToolContext } from "./context.js";

// Decimal byte escapes preserve Unicode and cannot terminate a Lua string.
function luaValue(value: unknown): string {
  if (typeof value === "string") return '"' + [...Buffer.from(value)].map(b => "\\" + String(b).padStart(3, "0")).join("") + '"';
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (value && typeof value === "object" && !Array.isArray(value)) return "{" + Object.entries(value).map(([k, v]) => `[${luaValue(k)}]=${luaValue(v)}`).join(",") + "}";
  throw new Error("Unsupported UI argument");
}

const READERS = `
local function get(h,k) local ok,v=pcall(function() return h:Get(k) end); if ok then return v end end
local function info(h)
 if not h then return nil end
 local r=get(h,"AbsRect")
 local row={address=h:Addr(),class=h:GetClass(),name=tostring(get(h,"Name") or ""),text=tostring(get(h,"Text") or "")}
 if type(r)=="table" then row.rect={x=r.x,y=r.y,w=r.w,h=r.h} end
 local ok,v=pcall(function() return h:IsVisible() end); if ok then row.visible=v end
 local ok,v=pcall(function() return h:IsEnabled() end); if ok then row.enabled=v end
 return row
end
local d=GetDisplayByIndex(a.display); assert(d,"Display does not exist")
local bounds=d:Get("AbsRect"); assert(type(bounds)=="table","Display bounds unavailable")
local function inBounds(x,y) return x>=bounds.x and y>=bounds.y and x<bounds.x+bounds.w and y<bounds.y+bounds.h end
`;

export function uiReadCode(args: Record<string, unknown>): string {
  return `local a=${luaValue(args)}\n${READERS}
if a.point then
 assert(inBounds(a.point.x,a.point.y),"Point is outside the display's UI coordinate bounds")
 return {display=a.display,bounds=bounds,point=a.point,target=info(GetUIObjectAtPosition(a.display,a.point)) or false}
end
local nodes,visited,truncated,depthLimited={},0,false,false
local needle=a.filter and string.lower(a.filter) or nil
local function walk(h,depth)
 if visited>=a.max_nodes then truncated=true; return end
 visited=visited+1
 local row=info(h); row.depth=depth
 if not needle or string.find(string.lower(row.name.." "..row.class.." "..row.text),needle,1,true) then nodes[#nodes+1]=row end
 local children=h:UIChildren() or {}
 if depth>=a.max_depth then if #children>0 then depthLimited=true end; return end
 for _,c in ipairs(children) do if visited>=a.max_nodes then truncated=true; break end; walk(c,depth+1) end
end
walk(d,0)
return {display=a.display,bounds=bounds,nodes=nodes,visited=visited,truncated=truncated,depth_limited=depthLimited}
`;
}

export function uiClickCode(args: Record<string, unknown>): string {
  return `local a=${luaValue(args)}\n${READERS}
local function checkedTarget()
local ok,modal=pcall(GetTopModal)
if not ok then return nil,"Modal state unavailable; nothing clicked" end
if modal then return nil,"A modal dialog is open; use gma3_dialog to read and answer it" end
bounds=d:Get("AbsRect")
if type(bounds)~="table" then return nil,"Display bounds unavailable" end
if not inBounds(a.x,a.y) then return nil,"Point is outside display UI bounds" end
local h=GetUIObjectAtPosition(a.display,{x=a.x,y=a.y})
local before=info(h)
if not before then return nil,"No UI object at this point" end
for _,k in ipairs({"address","class","name","text"}) do
 if before[k]~=a.expected[k] then return nil,"The control at this point changed ("..k..")",before end
end
if not before.rect then return nil,"Control geometry unavailable",before end
for _,k in ipairs({"x","y","w","h"}) do
 if before.rect[k]~=a.expected.rect[k] then return nil,"Control geometry changed",before end
end
if before.visible~=true or before.enabled~=true then return nil,"Control is not known visible and enabled",before end
return before
end
local before,reason,observed=checkedTarget()
if not before then return {clicked=false,reason=reason,before=observed} end
local moved,moveError=pcall(Mouse,a.display,"move",a.x,a.y)
if not moved then return {clicked=false,reason=tostring(moveError),before=before} end
-- Moving can open a hover menu or modal. Recheck the resulting target before pressing.
before,reason,observed=checkedTarget()
if not before then return {clicked=false,reason=reason,before=observed} end
local pressed,pressError=pcall(Mouse,a.display,"press",a.button)
-- Best effort: an aborted or budget-exhausted Lua chunk can prevent reaching release.
local released,releaseError=pcall(Mouse,a.display,"release",a.button)
if not pressed or not released then
 return {clicked=false,uncertain=true,reason="Mouse delivery uncertain; inspect UI and mouse state before another click",press_error=not pressed and tostring(pressError) or nil,release_error=not released and tostring(releaseError) or nil,release_attempted=true,release_succeeded=released,before=before}
end
return {clicked=true,before=before,display=a.display,x=a.x,y=a.y,button=a.button}
`;
}

class UiReplyError extends Error {}

function refusedBeforeExecution(err: unknown): boolean {
  if (err instanceof BridgeUnreachableError) return true;
  if (!(err instanceof BridgeError) || err.dispatched) return false;
  if (err.code === "busy") return true;
  const firstLine = err.message.split("\n", 1)[0];
  return /^Lua execution is disabled on the console\b/i.test(firstLine)
    || /^(?:.*?:\d+:\s*)?Lua compile error:/i.test(firstLine);
}

async function luaResult(ctx: ToolContext, code: string): Promise<Record<string, unknown>> {
  const r = await ctx.bridge.request("lua", { code }, ctx.requestTimeoutMs) as { values?: unknown[] };
  const value = r?.values?.[0];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UiReplyError("Malformed UI bridge reply");
  return value as Record<string, unknown>;
}

const coordinate = z.number().int().min(0).max(16384);
const rect = z.object({ x: z.number().finite(), y: z.number().finite(), w: z.number().positive().finite(), h: z.number().positive().finite() });
const expectedShape = z.object({ address: z.string().regex(/^\d+(?:\.\d+)*$/), class: z.string().min(1).max(128), name: z.string().max(256), text: z.string().max(2048), rect });

export const registerUiTools: RegisterTools = (server, ctx) => {
  if (!ctx.luaToolAllowed) return;
  server.registerTool("gma3_ui", {
    title: "Inspect grandMA3 on-screen controls",
    description: "Read a bounded live UI tree, or identify the object at point {x,y}. Requires console Lua enabled. Coordinates are grandMA3 UI units, NOT physical screenshot pixels: use bounds and the screenshot dimensions to convert. Returns addresses, class, name, text, visibility, enabled state and rectangles; truncation is explicit. Read point immediately before gma3_ui_click. This reads only the console UI, without showing its window.",
    inputSchema: { display: z.number().int().min(1).max(6).default(1), point: z.object({ x: coordinate, y: coordinate }).optional(), max_nodes: z.number().int().min(1).max(1500).default(500), max_depth: z.number().int().min(0).max(16).default(10), filter: z.string().max(128).optional() },
  }, async args => {
    try {
      const result = await ctx.mutations.run(() => luaResult(ctx, uiReadCode(args)));
      if (result.nodes && !Array.isArray(result.nodes) && Object.keys(result.nodes as object).length === 0) result.nodes = [];
      return json(result);
    } catch (err) { return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true }; }
  });
  server.registerTool("gma3_ui_click", {
    title: "Click an identified grandMA3 UI control",
    description: "Fallback only for UI without a structured show tool. Supply x/y in console UI units and expected copied from gma3_ui point.target (address, class, name, text, rect). Rechecks modal state, bounds and target identity both before and after moving the internal cursor; refuses changed, moved, disabled, hidden or covered controls. Refuses modal dialogs; use gma3_dialog. Requires Lua enabled and exclusive:true. Uses grandMA3's internal Mouse API, so the desktop cursor and focus are untouched. Never retries. Release is best effort: an aborted Lua chunk can skip it. Runtime/budget errors are unknown; inspect UI and mouse state before another click. A delivered click does not prove the button's effect: inspect the UI/show state afterwards.",
    inputSchema: { display: z.number().int().min(1).max(6).default(1), x: coordinate, y: coordinate, expected: expectedShape, button: z.enum(["Left", "Right", "Middle"]).default("Left"), exclusive: z.literal(true) },
  }, async args => ctx.mutations.run(async () => {
    let result: OperationResult;
    try {
      const clicked = await luaResult(ctx, uiClickCode(args));
      if (typeof clicked.clicked !== "boolean") throw new UiReplyError("Malformed click bridge reply");
      const outcome = clicked.clicked ? "succeeded" : clicked.uncertain ? "unknown" : "failed";
      result = { operation: "ui_click", target: { display: args.display, x: args.x, y: args.y, expected: args.expected }, outcome, verification: unavailable("Mouse delivery is not the control's application effect; inspect UI or show data afterwards"), steps: [{ name: "checked_click", op: "lua", status: outcome, detail: clicked }], summary: clicked.clicked ? "Click delivered once; inspect UI or show data to verify the effect." : String(clicked.reason ?? "Click refused"), click: clicked };
    } catch (err) {
      const step = stepFromError("checked_click", err, { op: "lua" });
      if (!refusedBeforeExecution(err)) step.status = "unknown";
      const summary = step.status === "unknown"
        ? `${step.error ?? "Click outcome unavailable"}. The click may have run and release is unverified; inspect UI and mouse state before another click.`
        : step.error ?? "Click refused before execution";
      result = { operation: "ui_click", target: { display: args.display, x: args.x, y: args.y }, outcome: step.status === "unknown" ? "unknown" : "failed", verification: unavailable("No verified reply; inspect before retrying"), steps: [step], summary };
    }
    return toToolResult(result);
  }));
};
