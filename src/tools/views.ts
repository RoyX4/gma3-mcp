/**
 * Saved views and view-button assignments in the CURRENT USER PROFILE (not the data pool).
 * Uses native view.content plus objects/cmd; arbitrary Lua execution is not required.
 * Syntax: bundled 2.5.1 manual keyword_view, keyword_viewbutton, ok_screen, wvm_store_recall.
 * Read-only onPC 2.5.1.1 inspection confirmed View metadata and ViewButton.Object handle summaries.
 * Strict default verification compares the saved and recalled native window configuration.
 */
import { z } from "zod";
import { readViewContent, compareViewContent, type ViewContent } from "./view-content.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import { readObjects, type ObjectSummary } from "./common.js";
import {
  asRead, buildResult, commandStep, compareFields, stepFromError, unavailable, validationFailure,
  type OperationResult, type StepResult, type Verification,
} from "../results.js";
import { objectName, Validator } from "../validate.js";

const VIEW_FIELDS = ["Name", "ScreenContentMask", "RequestedW", "RequestedH", "Lock"];
const viewNumber = z.number().int().min(1).max(99999);
const screenNumber = z.number().int().min(1).max(7);
const viewShape = { view: viewNumber.describe("Saved View pool number in the current user profile.") };
const SCOPE = "current user profile";

interface Inspected { step: StepResult; item: ObjectSummary | null }

async function inspect(ctx: ToolContext, name: string, ref: string, fields: string[]): Promise<Inspected> {
  try {
    const result = await readObjects(ctx.bridge, ref, fields, 1, { asText: false });
    const item = result?.items?.[0];
    const valid = item && !item.invalid ? item : null;
    return { step: asRead({ name, status: "succeeded", op: "objects", detail: { ref, object: valid } }), item: valid };
  } catch (err) {
    return { step: asRead(stepFromError(name, err, { op: "objects", detail: { ref } })), item: null };
  }
}

function refusal(step: StepResult, error: string): StepResult {
  return { ...step, status: "failed", error };
}

async function inspectView(ctx: ToolContext, view: number): Promise<Inspected> {
  const found = await inspect(ctx, "check_view", `View ${view}`, VIEW_FIELDS);
  if (found.step.status !== "succeeded") return found;
  if (!found.item || found.item.class !== "View") found.step = refusal(found.step, `View ${view} does not exist or did not resolve to a View`);
  else if (!found.item.addr) found.step = refusal(found.step, `View ${view} has no readable identity address`);
  return found;
}

function stopped(operation: string, target: Record<string, unknown>, steps: StepResult[]): OperationResult {
  return buildResult({ operation, target, steps, verification: unavailable("the request stopped before mutation") });
}

interface StoreArgs { view: number; screens: number[]; name?: string; verify_contents?: boolean }

export async function storeView(ctx: ToolContext, args: StoreArgs): Promise<OperationResult> {
  const op = "store_view";
  const target = { view: args.view, screens: args.screens, scope: SCOPE };
  const validator = new Validator();
  const name = validator.check(() => objectName("name", args.name, { optional: true }));
  if (new Set(args.screens).size !== args.screens.length) validator.fail("screens must be unique");
  if (!validator.ok) return validationFailure(op, target, validator.errors);
  return ctx.mutations.run(async () => {
    const before = await inspect(ctx, "check_slot", `View ${args.view}`, VIEW_FIELDS);
    if (before.step.status !== "succeeded") return stopped(op, target, [before.step]);
    if (before.item) return stopped(op, target, [refusal(before.step, `View ${args.view} already exists; store_view is create-only and will not overwrite it`)]);
    const steps: StepResult[] = [before.step];
    let sampled: ViewContent | undefined;
    if (args.verify_contents !== false) {
      try {
        sampled = await readViewContent(ctx, { screens: args.screens });
        steps.push(asRead({ name: "sample_live_windows", status: "succeeded", op: "view.content", detail: { nodes: sampled.nodes } }));
      } catch (err) { return stopped(op, target, [...steps, asRead({ ...stepFromError("sample_live_windows", err), status: "failed" })]); }
    }
    const command = `Store View ${args.view}${name === undefined ? "" : ` "${name}"`} /Screen "${args.screens.join(",")}" /NoConfirmation`;
    const sent = await commandStep(ctx.bridge, "store", command, ctx.requestTimeoutMs);
    const after = await inspect(ctx, "read_back", `View ${args.view}`, VIEW_FIELDS);
    steps.push(sent, after.step);
    const mask = args.screens.reduce((value, screen) => value | (1 << (screen - 1)), 0);
    let verification: Verification;
    if (after.step.status !== "succeeded") verification = unavailable("stored view metadata could not be read back");
    else if (!after.item || after.item.class !== "View") verification = { status: "mismatched", checked: "stored View metadata", expected: { exists: true, ScreenContentMask: mask }, actual: after.item, detail: "the stored View does not exist" };
    else verification = compareFields("stored View metadata (name and stored screen mask)", { ScreenContentMask: mask, ...(name === undefined ? {} : { Name: name }) }, after.item.fields);
    if (sampled && after.item && verification.status === "matched") {
      try {
        const saved = await readViewContent(ctx, { ref: `View ${args.view}` });
        steps.push(asRead({ name: "read_saved_windows", status: "succeeded", op: "view.content", detail: { nodes: saved.nodes } }));
        verification = compareViewContent(sampled, saved);
      } catch (err) {
        steps.push(asRead(stepFromError("read_saved_windows", err)));
        verification = unavailable("Saved native window configuration could not be read back.");
      }
    }
    return buildResult({ operation: op, target, steps, verification,
      warnings: [args.verify_contents === false ? "The saved window contents were not compared; verification covers View metadata only." : "Native persisted window settings and rectangles are compared; rendering/pixels are a separate observation.", "Another operator or client can still change the current profile or windows during this workflow."], extra: { resulting: after.item } });
  });
}

async function recallView(ctx: ToolContext, args: { view: number; screen: number; verify_contents?: boolean }): Promise<OperationResult> {
  return ctx.mutations.run(async () => {
    const target = { ...args, scope: SCOPE };
    const found = await inspectView(ctx, args.view);
    if (found.step.status !== "succeeded") return stopped("recall_view", target, [found.step]);
    const steps: StepResult[] = [found.step];
    const mask = Number(found.item?.fields?.ScreenContentMask);
    const multiple = Number.isInteger(mask) && mask > 0 && (mask & (mask - 1)) !== 0;
    let saved: ViewContent | undefined;
    if (args.verify_contents !== false) {
      if (!Number.isInteger(mask) || mask < 1 || mask > 127) return stopped("recall_view", target, [...steps, { name: "screen_mask", kind: "read", status: "failed", error: "Saved screen mask is unreadable." }]);
      try {
        saved = await readViewContent(ctx, { ref: `View ${args.view}` });
        steps.push(asRead({ name: "read_saved_windows", status: "succeeded", op: "view.content", detail: { nodes: saved.nodes } }));
      } catch (err) { return stopped("recall_view", target, [...steps, asRead({ ...stepFromError("read_saved_windows", err), status: "failed" })]); }
    }
    const sent = await commandStep(ctx.bridge, "recall", `View ${args.view} /Screen "${args.screen}"`, ctx.requestTimeoutMs);
    steps.push(sent);
    let verification = unavailable("Native window layout verification was not requested; only command feedback was observed.", "recalled window layout");
    if (saved && sent.status !== "failed") {
      await new Promise(resolve => setTimeout(resolve, 60));
      const screens = multiple ? [1, 2, 3, 4, 5, 6, 7].filter(screen => (mask & (1 << (screen - 1))) !== 0) : [args.screen];
      try {
        const actual = await readViewContent(ctx, { screens });
        steps.push(asRead({ name: "read_recalled_windows", status: "succeeded", op: "view.content", detail: { nodes: actual.nodes } }));
        verification = compareViewContent(saved, actual, multiple ? undefined : args.screen);
      } catch (err) { steps.push(asRead(stepFromError("read_recalled_windows", err))); verification = unavailable("Recalled native window configuration could not be read back."); }
    }
    return buildResult({ operation: "recall_view", target, steps, verification,
      warnings: [...(multiple ? ["This View stores multiple screens and recalls on its stored screens regardless of requested destination."] : []), "Native configuration is checked; screenshot rendering and physical display freshness are not proved by this comparison."] });
  });
}

interface ButtonState { empty: boolean; object: ObjectSummary | null }

function buttonState(item: ObjectSummary | null): ButtonState {
  if (!item) return { empty: true, object: null };
  if (item.class !== "ViewButton") throw new Error("the reference did not resolve to a ViewButton");
  if (!Object.hasOwn(item.fields ?? {}, "Object")) throw new Error("ViewButton.Object is unavailable; refusing to infer an empty assignment");
  const value = item.fields!.Object;
  if (value === null || value === "") return { empty: true, object: null };
  if (typeof value === "string") return { empty: false, object: { name: value } };
  if (value && typeof value === "object" && ["addr", "name", "class", "index"].some((key) => Object.hasOwn(value, key))) return { empty: false, object: value as ObjectSummary };
  throw new Error("ViewButton.Object is unreadable; refusing to infer an empty assignment");
}

const sameView = (assigned: ObjectSummary | null, view: ObjectSummary): boolean =>
  assigned?.class === "View" && typeof assigned.addr === "string" && assigned.addr === view.addr;

async function assignViewButton(ctx: ToolContext, args: { view: number; screen: number; button: number; replace?: boolean }): Promise<OperationResult> {
  return ctx.mutations.run(async () => {
    const op = "assign_view_button";
    const target = { view: args.view, screen: args.screen, button: args.button, scope: SCOPE };
    const ref = `ViewButton ${args.screen}.${args.button}`;
    const found = await inspectView(ctx, args.view);
    if (found.step.status !== "succeeded") return stopped(op, target, [found.step]);
    const before = await inspect(ctx, "inspect_button", ref, ["Object", "Name", "Lock"]);
    const steps = [found.step, before.step];
    if (before.step.status !== "succeeded") return stopped(op, target, steps);
    let previous: ButtonState;
    try { previous = buttonState(before.item); }
    catch (err) { return stopped(op, target, [found.step, refusal(before.step, (err as Error).message)]); }
    const view = found.item!;
    const noop = sameView(previous.object, view);
    if (!previous.empty && !noop && !args.replace) return buildResult({
      operation: op, target,
      steps: [...steps, { name: "assign", status: "failed", error: `${ref} already holds another object; pass replace: true to replace it. Nothing was sent.` }],
      verification: unavailable("the assignment was refused before mutation"), extra: { previous },
    });
    if (!noop) steps.push(await commandStep(ctx.bridge, "assign", `Assign View ${args.view} At ${ref}`, ctx.requestTimeoutMs));
    const after = await inspect(ctx, "read_back", ref, ["Object", "Name"]);
    steps.push(after.step);
    let resulting: ButtonState | null = null;
    let verification = unavailable("ViewButton assignment could not be read back", "assigned View identity address");
    if (after.step.status === "succeeded") {
      try {
        resulting = buttonState(after.item);
        verification = {
          status: sameView(resulting.object, view) ? "matched" : "mismatched",
          checked: "assigned View identity address", expected: { class: "View", addr: view.addr }, actual: resulting.object,
        };
      } catch (err) { verification = unavailable((err as Error).message, "assigned View identity address"); }
    }
    return buildResult({
      operation: op, target, steps, verification, extra: { previous, resulting, noop },
      warnings: !previous.empty && !noop ? ["The previous ViewButton assignment was replaced. Another operator or client can still change it during this workflow."] : [],
    });
  });
}

export const registerViewTools: RegisterTools = (server, ctx) => {
  server.registerTool("gma3_views", {
    title: "Read saved views",
    description: "READ-ONLY: list saved Views in the current user profile, or one View, with screen mask and dimensions. Does not inspect the live window arrangement. View objects are scoped to the user profile, not a data pool.",
    inputSchema: { view: viewNumber.optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() },
  }, async (args) => {
    try {
      const result = await ctx.bridge.request("objects", { ref: args.view === undefined ? "View Thru" : `View ${args.view}`, fields: VIEW_FIELDS, asText: false, offset: args.offset ?? 0, limit: args.limit ?? 100 }, ctx.requestTimeoutMs);
      return json({ scope: SCOPE, ...(result as Record<string, unknown>) });
    } catch (err) { return { content: [{ type: "text", text: (err as Error).message }], isError: true }; }
  });
  server.registerTool("gma3_store_view", {
    title: "Create a saved view from explicit screens",
    description: "CREATES a new View only, refusing any existing slot. Stores current window arrangements for screens 1..7 with /Screen and no confirmation dialog. Optional name is validated before dispatch. By default compares actual saved native window rectangles and nested persisted settings with a pre-store snapshot, plus metadata; verify_contents:false explicitly requests metadata-only verification. Never retries; mutations from this server are serialized, not isolated from other clients or the operator.",
    inputSchema: { ...viewShape, screens: z.array(screenNumber).min(1).max(7), name: z.string().optional(), verify_contents: z.boolean().default(true) },
  }, async (args) => operation(() => storeView(ctx, args)));
  server.registerTool("gma3_recall_view", {
    title: "Recall a saved view to an explicit screen",
    description: "CHANGES the grandMA3 window arrangement by recalling an existing View with /Screen. By default reads actual saved and recalled native window configuration and compares rectangles and nested persisted settings; verify_contents:false explicitly opts out. A View storing multiple screens always recalls on its stored screens. Does not unhide the Linux app window. Never retries.",
    inputSchema: { ...viewShape, screen: screenNumber, verify_contents: z.boolean().default(true) },
  }, async (args) => operation(() => recallView(ctx, args)));
  server.registerTool("gma3_assign_view_button", {
    title: "Assign a saved view to a view button",
    description: "ASSIGNS an existing View to ViewButton screen.button. Checks the prior assignment; an occupied different object requires replace:true. An already identical address is a read-only no-op. Reads Object as a handle and compares View class and identity address, never just its name. Does not recall or label the View. Never retries; mutations from this server are serialized, not isolated from other clients or the operator.",
    inputSchema: { ...viewShape, screen: screenNumber, button: viewNumber.describe("View button number on the explicit screen."), replace: z.boolean().optional() },
  }, async (args) => operation(() => assignViewButton(ctx, args)));
};
