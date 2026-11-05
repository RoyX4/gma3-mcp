import { z } from "zod";
import { BridgeError, BridgeUnreachableError } from "../bridge.js";
import {
  asRead,
  buildResult,
  classifyFeedback,
  commandStep,
  compareFields,
  notRequested,
  requestStep,
  stepFromError,
  unavailable,
  validationFailure,
  valuesEqual,
  type OperationResult,
  type StepResult,
  type Verification,
} from "../results.js";
import { objectName } from "../validate.js";
import { readObjects, type ObjectSummary } from "./common.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";

const LOCKS = ["LOCK", "SYSTEMLOCKED", "STRUCTURELOCKED"];
const ASSIGNABLE = /^(?:(?:Group|Sequence|Macro|View|Camera|Layout|Page) [1-9]\d*|Preset [1-9]\d*\.[1-9]\d*)$/;
const COLOUR = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const CAVEAT =
  "This server serializes its own mutations; another client or operator can still change the same objects. No mutation is retried or automatically undone.";

function appearanceIdentity(value: unknown): unknown {
  if (value === "" || value === null) return "empty";
  return value && typeof value === "object" ? (value as { addr?: unknown }).addr : undefined;
}

function lockProblem(row: ObjectSummary): string | null {
  const clear: unknown[] = [false, 0, "", "No", "no", "False", "false", "0"];
  for (const key of LOCKS) {
    if (!Object.hasOwn(row.fields ?? {}, key)) return `${key} could not be read`;
    if (!clear.includes(row.fields![key])) return `${key} is set`;
  }
  return null;
}

async function inspect(
  ctx: ToolContext,
  steps: StepResult[],
  ref: string,
  fields: string[],
): Promise<ObjectSummary | null> {
  try {
    const result = await readObjects(ctx.bridge, ref, fields, 1, { asText: false });
    let row = result?.items?.[0];
    // A native empty Handle reads nil in Raw role and is omitted from JSON.
    // Accept empty only when a fresh schema/display observation proves it on
    // this exact object; missing/unreadable properties still refuse assignment.
    if (row?.addr && fields.includes("APPEARANCE") && !Object.hasOwn(row.fields ?? {}, "APPEARANCE")) {
      const display = await ctx.bridge.request<{addr?: string; class?: string; schema?: Array<{name?: string; type?: string}>; properties?: Record<string, unknown>}>("object", {ref, schema: true, asText: true}, ctx.requestTimeoutMs);
      if (display.addr === row.addr && display.class === row.class && display.schema?.some(p => p.name === "APPEARANCE" && p.type === "Handle") && display.properties?.APPEARANCE === "") row = {...row, fields: {...row.fields, APPEARANCE: ""}};
    }
    if (result && result.total > 1) throw new Error(`${ref} resolved to several objects`);
    steps.push(asRead({ name: `inspect_${ref}`, status: "succeeded", op: "objects", detail: { object: row ?? null } }));
    return row && !row.invalid ? row : null;
  } catch (error) {
    steps.push(asRead(stepFromError(`inspect_${ref}`, error, { op: "objects" })));
    return null;
  }
}

function rgba(value: string, prefix: "IMAGE" | "BACK"): Record<string, number> {
  const hex = value.slice(1).padEnd(8, "F");
  return Object.fromEntries(
    ["R", "G", "B", "ALPHA"].map((key, i) => [prefix + key, parseInt(hex.slice(i * 2, i * 2 + 2), 16)]),
  );
}

interface AppearanceArgs {
  appearance: number;
  mode?: "create" | "update";
  name?: string;
  foreground?: string;
  background?: string;
  assign_to?: string[];
  replace_assignments?: boolean;
  dry_run?: boolean;
}

async function configureAppearance(ctx: ToolContext, args: AppearanceArgs): Promise<OperationResult> {
  const op = "configure_appearance";
  const ref = `Appearance ${args.appearance}`;
  const target = { appearance: args.appearance, scope: "show-wide appearance pool" };
  let name: string | undefined;
  try {
    name = objectName("name", args.name, { optional: true });
  } catch (error) {
    return validationFailure(op, target, [(error as Error).message]);
  }
  const assignments = args.assign_to ?? [];
  if (new Set(assignments).size !== assignments.length || assignments.some((r) => !ASSIGNABLE.test(r))) {
    return validationFailure(op, target, ["assign_to requires distinct explicit supported pool-object references"]);
  }
  const expected = {
    ...(name ? { NAME: name } : {}),
    ...(args.foreground ? rgba(args.foreground, "IMAGE") : {}),
    ...(args.background ? rgba(args.background, "BACK") : {}),
  };
  if (!Object.keys(expected).length && !assignments.length)
    return validationFailure(op, target, ["Supply a name, foreground/background RGBA colour, or assignment target"]);
  return ctx.mutations.run(async () => {
    const steps: StepResult[] = [];
    const fields = [...LOCKS, ...Object.keys(expected)];
    const before = await inspect(ctx, steps, ref, fields);
    const refuse = (reason: string) =>
      buildResult({
        operation: op,
        target,
        steps: [...steps, asRead({ name: "preflight", status: "failed", error: reason })],
        verification: unavailable("refused before the next mutation"),
      });
    if (steps.some((s) => s.status !== "succeeded")) return refuse("Appearance state could not be read");
    const create = (args.mode ?? "create") === "create";
    if (create && before) return refuse(`${ref} already exists; use mode update deliberately`);
    if (!create && (!before || before.class !== "Appearance")) return refuse(`${ref} is not an existing Appearance`);
    if (before) {
      const why = lockProblem(before);
      if (why) return refuse(why);
    }
    const targets = new Map<string, ObjectSummary>();
    for (const assignment of assignments) {
      const row = await inspect(ctx, steps, assignment, [...LOCKS, "APPEARANCE"]);
      if (!row?.addr) return refuse(`${assignment} could not be resolved`);
      const why = lockProblem(row);
      if (why) return refuse(`${assignment}: ${why}`);
      if (!Object.hasOwn(row.fields ?? {}, "APPEARANCE"))
        return refuse(`${assignment}: appearance assignment is unreadable`);
      const current = row.fields!.APPEARANCE;
      const currentAddr = current && typeof current === "object" ? (current as { addr?: unknown }).addr : null;
      const empty = current === "" || current === null;
      if (!empty && currentAddr !== before?.addr && !args.replace_assignments)
        return refuse(`${assignment} already has another appearance; replacing it requires replace_assignments:true`);
      if (!empty && !currentAddr) return refuse(`${assignment}: existing appearance identity is unreadable`);
      targets.set(assignment, row);
    }
    if (args.dry_run !== false)
      return buildResult({
        operation: op,
        target,
        steps,
        verification: notRequested(),
        extra: { preview: true, expected, assign_to: assignments, previous: before?.fields ?? null },
      });
    let appearance = before;
    if (create) {
      const store = await commandStep(
        ctx.bridge,
        "store_appearance",
        `Store ${ref}${name ? ` "${name}"` : ""} /NoConfirmation`,
        ctx.requestTimeoutMs,
      );
      steps.push(store);
      if (store.status !== "succeeded")
        return buildResult({
          operation: op,
          target,
          steps,
          verification: unavailable("Appearance creation was not confirmed"),
        });
      appearance = await inspect(ctx, steps, ref, fields);
      if (appearance?.class !== "Appearance" || !appearance.addr)
        return refuse("Created Appearance identity is unavailable");
      const why = lockProblem(appearance);
      if (why) return refuse(why);
    }
    let stopped = false;
    for (const [property, value] of Object.entries(expected)) {
      if (valuesEqual(value, before?.fields?.[property])) continue;
      const step = await requestStep(
        ctx.bridge,
        property,
        "set",
        { ref, property, value },
        (reply) => {
          const row = reply as { value?: unknown; readOk?: boolean };
          if (row?.readOk === false || row?.value === undefined)
            return { name: property, status: "unknown", op: "set", error: "Appearance write readback is unavailable" };
          return {
            name: property,
            status: valuesEqual(value, row.value) ? "succeeded" : "failed",
            op: "set",
            detail: row,
            ...(!valuesEqual(value, row.value) ? { error: "Appearance write did not match" } : {}),
          };
        },
        ctx.requestTimeoutMs,
      );
      steps.push(step);
      if (step.status !== "succeeded") {
        stopped = true;
        break;
      }
    }
    if (!stopped)
      for (const [assignment, prior] of targets) {
        const current = await inspect(ctx, steps, assignment, [...LOCKS, "APPEARANCE"]);
        if (
          !current ||
          current.addr !== prior.addr ||
          lockProblem(current) ||
          appearanceIdentity(current.fields?.APPEARANCE) !== appearanceIdentity(prior.fields?.APPEARANCE)
        ) {
          steps.push(
            asRead({
              name: "check_assignment_identity",
              status: "failed",
              error: `${assignment} changed identity, lock state or appearance assignment`,
            }),
          );
          break;
        }
        const step = await commandStep(
          ctx.bridge,
          `assign_${assignment}`,
          `Assign ${ref} At ${assignment}`,
          ctx.requestTimeoutMs,
        );
        steps.push(step);
        if (step.status !== "succeeded") break;
      }
    const after = await inspect(ctx, steps, ref, fields);
    let verification: Verification =
      after && after.addr === appearance?.addr
        ? compareFields("all requested appearance fields", expected, after.fields ?? {})
        : unavailable("Appearance identity/fields could not be read back");
    const problems: string[] =
      verification.status === "mismatched" ? [verification.detail ?? "Appearance fields mismatch"] : [];
    for (const [assignment, prior] of targets) {
      const row = await inspect(ctx, steps, assignment, ["APPEARANCE"]);
      const handle = row?.fields?.APPEARANCE as { addr?: unknown } | null;
      if (!row || row.addr !== prior.addr || handle?.addr !== appearance?.addr)
        problems.push(`${assignment}: assigned appearance identity does not match`);
    }
    if (problems.length)
      verification = {
        status: "mismatched",
        checked: "appearance fields and assignment identities",
        detail: problems.join("; "),
      };
    steps.push(
      asRead({
        name: "verify_appearance",
        status: verification.status === "matched" ? "succeeded" : "failed",
        ...(verification.status === "matched"
          ? {}
          : { error: verification.detail ?? "Appearance final state could not be verified" }),
      }),
    );
    return buildResult({
      operation: op,
      target,
      steps,
      verification,
      extra: { previous: before?.fields ?? null, resulting: after?.fields ?? null, assign_to: assignments },
      warnings: [
        "Appearance byte colours and assignments are verified; visible rendering and show-file persistence are not.",
        CAVEAT,
      ],
    });
  });
}

const WINDOW_TYPES = [
  "Window3D",
  "WindowSequenceSheet",
  "WindowCommandLine",
  "WindowFixtureSheet",
  "WindowGroupPool",
  "WindowMacroPool",
  "WindowLayoutView",
] as const;
type WindowType = (typeof WINDOW_TYPES)[number];
interface WindowPlan {
  type: WindowType;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface WindowRow {
  address: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Snapshot {
  display: number;
  columns: number;
  rows: number;
  signature: string;
  identity: string;
  windows: WindowRow[];
}
interface WorkspaceArgs {
  display?: number;
  windows: WindowPlan[];
  dry_run?: boolean;
  exclusive?: boolean;
  expected_snapshot?: string;
}
const MINIMUM: Record<WindowType, [number, number]> = {
  Window3D: [4, 4],
  WindowSequenceSheet: [3, 4],
  WindowCommandLine: [4, 4],
  WindowFixtureSheet: [3, 4],
  WindowGroupPool: [2, 2],
  WindowMacroPool: [2, 2],
  WindowLayoutView: [4, 4],
};

function luaValue(value: unknown): string {
  if (typeof value === "string")
    return '"' + [...Buffer.from(value)].map((b) => "\\" + String(b).padStart(3, "0")).join("") + '"';
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  if (value && typeof value === "object" && !Array.isArray(value))
    return (
      "{" +
      Object.entries(value)
        .map(([k, v]) => `[${luaValue(k)}]=${luaValue(v)}`)
        .join(",") +
      "}"
    );
  throw new Error("Unsupported workspace argument");
}

/** Fixed schema, byte-escaped arguments. A creation request checks the preview snapshot inside the same Lua chunk. */
export function workspaceCode(args: { display: number; expected_snapshot?: string; window?: WindowPlan }): string {
  return `local a=${luaValue(args)}
local function snapshot()
 local modal=GetTopModal(); assert(not modal,"A modal dialog is open")
 local d=assert(GetDisplayByIndex(a.display),"Display is unavailable")
 local ui=assert(d:FindRecursive("UiScreen","UiScreen"),"Native UI grid is unavailable")
 local columns,rows=tonumber(ui.Columns),tonumber(ui.Rows)
 assert(columns and rows and columns>0 and rows>0,"Native grid size is unreadable")
 local config=assert(CurrentScreenConfig(),"Screen configuration is unavailable")
 local content=assert(config.ScreenContents:Ptr(a.display),"Screen content is unavailable")
 local children=content:Children(); assert(#children<=50,"Screen has more than 50 windows")
 local root=Root().MANetSocket
 local hostname,showfile=root:Get("HostName"),root:Get("ShowFile")
 assert(type(hostname)=="string" and hostname~="" and type(showfile)=="string" and showfile~="","Station/show identity is unreadable")
 local identity=table.concat({hostname,showfile,config:Addr(),content:Addr(),columns,rows},"|")
 local windows,parts={}, {identity}
 for _,w in ipairs(children) do
  local row={address=w:Addr(),name=tostring(w.Name),x=tonumber(w.X),y=tonumber(w.Y),w=tonumber(w.W),h=tonumber(w.H)}
  assert(row.x and row.y and row.w and row.h,"Window grid coordinates are unreadable")
  windows[#windows+1]=row
  parts[#parts+1]=table.concat({row.address,row.name,row.x,row.y,row.w,row.h},"|")
 end
 setmetatable(windows,{__jsontype="array"})
 return {display=a.display,columns=columns,rows=rows,identity=identity,windows=windows,signature=table.concat(parts,"\\n")}
end
local ok,before=pcall(snapshot)
if not ok then return {dispatched=false,reason=tostring(before)} end
if not a.window then return {snapshot=before} end
if before.signature~=a.expected_snapshot then return {dispatched=false,reason="Screen identity, grid or existing windows changed; preview again",snapshot=before} end
local requested=a.window
local minima={Window3D={4,4},WindowSequenceSheet={3,4},WindowCommandLine={4,4},WindowFixtureSheet={3,4},WindowGroupPool={2,2},WindowMacroPool={2,2},WindowLayoutView={4,4}}
local minimum=minima[requested.type]
if not minimum or requested.x<0 or requested.y<0 or requested.w<minimum[1] or requested.h<minimum[2] or requested.x+requested.w>before.columns or requested.y+requested.h>before.rows then
 return {dispatched=false,reason="Window exceeds the native grid or its minimum size",snapshot=before}
end
for _,old in ipairs(before.windows) do
 if requested.x<old.x+old.w and old.x<requested.x+requested.w and requested.y<old.y+old.h and old.y<requested.y+requested.h then
  return {dispatched=false,reason="Window overlaps existing screen content",snapshot=before}
 end
end
local command=string.format('Store ScreenContent %d "%s" "X"=%d "Y"=%d "W"=%d "H"=%d /NoConfirmation',a.display,requested.type,requested.x,requested.y,requested.w,requested.h)
local delivered,feedback=pcall(Cmd,command)
return {dispatched=true,uncertain=not delivered,feedback=tostring(feedback),command=command}
`;
}

async function readSnapshot(ctx: ToolContext, display: number, steps: StepResult[]): Promise<Snapshot | null> {
  try {
    const reply = (await ctx.bridge.request("lua", { code: workspaceCode({ display }) }, ctx.requestTimeoutMs)) as {
      values?: Array<{ snapshot?: Snapshot; reason?: string }>;
    };
    const result = reply?.values?.[0];
    const snapshot = result?.snapshot;
    if (
      !snapshot ||
      !Number.isInteger(snapshot.columns) ||
      !Number.isInteger(snapshot.rows) ||
      snapshot.columns < 1 ||
      snapshot.rows < 1 ||
      !Array.isArray(snapshot.windows) ||
      snapshot.windows.length > 50 ||
      typeof snapshot.signature !== "string" ||
      !snapshot.signature ||
      typeof snapshot.identity !== "string" ||
      !snapshot.identity ||
      snapshot.windows.some(
        (row) =>
          typeof row.address !== "string" ||
          !row.address ||
          typeof row.name !== "string" ||
          [row.x, row.y, row.w, row.h].some((v) => !Number.isFinite(v)),
      ) ||
      new Set(snapshot.windows.map((row) => row.address)).size !== snapshot.windows.length
    )
      throw new Error(result?.reason ?? "Malformed screen snapshot");
    steps.push(asRead({ name: "read_workspace", status: "succeeded", op: "lua", detail: snapshot }));
    return snapshot;
  } catch (error) {
    steps.push(asRead(stepFromError("read_workspace", error, { op: "lua" })));
    return null;
  }
}

function overlap(a: Pick<WindowRow, "x" | "y" | "w" | "h">, b: Pick<WindowRow, "x" | "y" | "w" | "h">): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function planProblem(snapshot: Snapshot, windows: WindowPlan[]): string | null {
  for (const [i, window] of windows.entries()) {
    const [w, h] = MINIMUM[window.type];
    if (window.w < w || window.h < h || window.x + window.w > snapshot.columns || window.y + window.h > snapshot.rows)
      return `${window.type} is outside the actual ${snapshot.columns} by ${snapshot.rows} grid or below its native minimum`;
    if (
      snapshot.windows.some((old) => overlap(old, window)) ||
      windows.slice(0, i).some((other) => overlap(other, window))
    )
      return `${window.type} overlaps an existing or planned window; no windows will be deleted or resized`;
  }
  return null;
}

function knownLuaRefusal(error: unknown): boolean {
  return (
    error instanceof BridgeUnreachableError ||
    (error instanceof BridgeError &&
      !error.dispatched &&
      (error.code === "busy" || /Lua execution is disabled|Lua compile error/i.test(error.message)))
  );
}

async function buildWorkspace(ctx: ToolContext, args: WorkspaceArgs): Promise<OperationResult> {
  const operation = "build_workspace";
  const display = args.display ?? 1;
  const target = { display, scope: "current user profile screen configuration" };
  if (args.dry_run === false && (args.exclusive !== true || !args.expected_snapshot))
    return validationFailure(operation, target, [
      "Applying requires exclusive:true and expected_snapshot copied from this tool's preview",
    ]);
  return ctx.mutations.run(async () => {
    const steps: StepResult[] = [];
    const before = await readSnapshot(ctx, display, steps);
    const finish = (verification: Verification, extra: Record<string, unknown> = {}) =>
      buildResult({ operation, target, steps, verification, extra, warnings: [CAVEAT] });
    if (!before) return finish(unavailable("Screen state could not be read"));
    const problem = planProblem(before, args.windows);
    if (problem || (args.dry_run === false && args.expected_snapshot !== before.signature)) {
      steps.push(
        asRead({ name: "preflight", status: "failed", error: problem ?? "Preview snapshot changed; preview again" }),
      );
      return finish(unavailable("Nothing was created"), { snapshot: before });
    }
    if (args.dry_run !== false)
      return finish(notRequested(), {
        preview: true,
        snapshot: before,
        expected_snapshot: before.signature,
        planned: args.windows,
      });
    let current = before;
    const created: Array<{ address: string; plan: WindowPlan }> = [];
    for (const window of args.windows) {
      let sent: StepResult;
      try {
        const reply = (await ctx.bridge.request(
          "lua",
          { code: workspaceCode({ display, expected_snapshot: current.signature, window }) },
          ctx.requestTimeoutMs,
        )) as {
          values?: Array<{
            dispatched?: boolean;
            uncertain?: boolean;
            reason?: string;
            feedback?: unknown;
            command?: string;
          }>;
        };
        const result = reply?.values?.[0];
        if (!result || typeof result.dispatched !== "boolean") throw new Error("Malformed window-creation reply");
        const feedback = classifyFeedback(result.feedback);
        sent = {
          name: `create_${window.type}`,
          op: "lua",
          status: !result.dispatched
            ? "failed"
            : result.uncertain || feedback === "unknown"
              ? "unknown"
              : feedback === "ok"
                ? "succeeded"
                : "failed",
          command: result.command,
          detail: result,
          ...(!result.dispatched ? { error: result.reason ?? "Window creation refused" } : {}),
        };
      } catch (error) {
        sent = stepFromError(`create_${window.type}`, error, { op: "lua" });
        if (!knownLuaRefusal(error)) sent.status = "unknown";
      }
      steps.push(sent);
      const observed = await readSnapshot(ctx, display, steps);
      if (sent.status !== "succeeded" || !observed) {
        if (observed) current = observed;
        break;
      }
      const added = observed.windows.filter((row) => !current.windows.some((old) => old.address === row.address));
      if (
        observed.identity !== before.identity ||
        added.length !== 1 ||
        observed.windows.length !== current.windows.length + 1 ||
        added[0].name !== window.type ||
        ["x", "y", "w", "h"].some((key) => added[0][key as keyof WindowRow] !== window[key as keyof WindowPlan])
      ) {
        steps.push(
          asRead({
            name: "check_created_window",
            status: "failed",
            error: "The native window identity/type/grid rectangle did not match",
          }),
        );
        current = observed;
        break;
      }
      created.push({ address: added[0].address, plan: window });
      current = observed;
    }
    const problems: string[] = [];
    if (created.length !== args.windows.length)
      problems.push(`Only ${created.length} of ${args.windows.length} requested windows were confirmed`);
    for (const old of before.windows) {
      const row = current.windows.find((w) => w.address === old.address);
      if (!row || JSON.stringify(row) !== JSON.stringify(old)) problems.push(`Existing window ${old.address} changed`);
    }
    for (const item of created) {
      const row = current.windows.find((w) => w.address === item.address);
      if (
        !row ||
        row.name !== item.plan.type ||
        ["x", "y", "w", "h"].some((key) => row[key as keyof WindowRow] !== item.plan[key as keyof WindowPlan])
      )
        problems.push(`Created window ${item.address} changed`);
    }
    steps.push(
      asRead({
        name: "verify_workspace",
        status: problems.length ? "failed" : "succeeded",
        ...(problems.length ? { error: problems.join("; ") } : {}),
      }),
    );
    return finish(
      {
        status: problems.length ? "mismatched" : "matched",
        checked: "all requested native window types/grid rectangles and preservation of existing windows",
        ...(problems.length ? { detail: problems.join("; ") } : {}),
      },
      { snapshot: current, created, savedView: false },
    );
  });
}

export const registerWorkspaceUiTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_configure_appearance",
    {
      title: "Create or update an appearance and checked assignments",
      description:
        "Dry-run by default. Create an unoccupied show-wide Appearance or explicitly update an unlocked one, using #RRGGBB or #RRGGBBAA foreground/background byte colours. Optional explicit pool-object assignments are prechecked; replacing an existing different appearance requires replace_assignments:true. Checks all requested fields and assignment identities. No fixture selection, programmer, playback, media import or show save. No Lua required, no retries; serializes this server only.",
      inputSchema: {
        appearance: z.number().int().min(1).max(99999),
        mode: z.enum(["create", "update"]).optional(),
        name: z.string().optional(),
        foreground: z.string().regex(COLOUR).optional(),
        background: z.string().regex(COLOUR).optional(),
        assign_to: z.array(z.string()).max(100).optional(),
        replace_assignments: z.boolean().optional(),
        dry_run: z.boolean().optional(),
      },
    },
    (args) => operation(() => configureAppearance(ctx, args)),
  );
  if (!ctx.luaToolAllowed) return;
  server.registerTool(
    "gma3_build_workspace",
    {
      title: "Build checked native screen windows in free grid space",
      description:
        "Dry-run by default. Reads the actual native screen grid and preserves every existing window. Creates only supported fixed-schema ScreenContent windows in free, nonoverlapping rectangles; never deletes/resizes existing windows or clears a screen. Apply requires exclusive:true and expected_snapshot from preview; rechecks identity/grid/all existing windows inside every creation request. Requires console Lua enabled; no user Lua accepted. Reads back each new native type/grid rectangle and existing-window preservation. Does not save a View, select fixtures, clear programmer, start playback or claim pixel rendering verified. Stops on unknown delivery and never retries.",
      inputSchema: {
        display: z.number().int().min(1).max(7).optional(),
        windows: z
          .array(
            z.object({
              type: z.enum(WINDOW_TYPES),
              x: z.number().int().min(0).max(200),
              y: z.number().int().min(0).max(200),
              w: z.number().int().min(1).max(200),
              h: z.number().int().min(1).max(200),
            }),
          )
          .min(1)
          .max(12),
        dry_run: z.boolean().optional(),
        exclusive: z.boolean().optional(),
        expected_snapshot: z.string().min(1).max(32768).optional(),
      },
    },
    (args) => operation(() => buildWorkspace(ctx, args)),
  );
};
