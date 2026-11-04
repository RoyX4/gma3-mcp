import { z } from "zod";
import { readNativeCueContent } from "../native-cue-reader.js";
import { nativeContentFingerprint, nativePartIdentity, reconstructNativeCues, type EffectiveNativeCell } from "../native-cues.js";
import { asRead, buildResult, commandStep, notRequested, stepFromError, unavailable, validationFailure, type StepResult, type Verification } from "../results.js";
import { attributeName, cueNumber } from "../validate.js";
import { cueRef, readFields, sequenceRef } from "./common.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { dataPoolShape, inDataPool } from "./datapool.js";
import { expandFixtures } from "./groups.js";
import { lockState } from "./playback.js";

type Row = Record<string, unknown>;
type Layer = EffectiveNativeCell["layer"];
type Action = "block" | "unblock";
const VALUE_EPSILON = 0.0001;
const MAX_COMMANDS = 100;
const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const shape = {
  ...dataPoolShape,
  sequence: z.number().int().min(1).max(99999),
  cues: z.array(z.union([z.number(), z.string()])).min(1).max(100),
  part: z.literal(0).optional().describe("The verified native action targets the main part. Defaults to Part 0."),
  fixtures: z.array(z.union([z.number(), z.string()])).min(1).max(200).describe('Explicit IDs or ranges, e.g. ["1 Thru 4", "201.2"].'),
  attributes: z.array(z.string()).min(1).max(32),
  action: z.enum(["block", "unblock"]),
  preview: z.boolean().default(false),
};
const schema = z.object(shape).strict();
type Scope = { cue: string; number: number; attribute: string; fixtures: string[] };
type Plan = Scope & { command: string; changes: Array<{ fixture: string; layer: Layer; value: number }>; beforeHash: string };
type Observation = { native: Row; reconstruction: ReturnType<typeof reconstructNativeCues> };

function contains(scope: Scope, value: { fixture?: unknown; attribute?: unknown }): boolean {
  return typeof value.fixture === "string" && typeof value.attribute === "string"
    && value.attribute.toLowerCase() === scope.attribute.toLowerCase()
    && scope.fixtures.some(id => value.fixture === id || (value.fixture as string).startsWith(`${id}.`));
}
const cellKey = (fixture: string, layer: Layer) => `${fixture}\0${layer}`;
const hasLayer = (value: Row, layer: Layer) => value[layer === "absolute" ? "hasAbsolute" : "hasRelative"] === true;
const marked = (value: Row, layer: Layer) => [1, true].includes(row(value.dictFlags)[layer === "absolute" ? "blocked" : "blocked_rel"] as number | boolean);
const close = (a: unknown, b: unknown) => typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < VALUE_EPSILON;

function staticNumber(stored: Row, layer: Layer): number {
  const value = stored[layer === "absolute" ? "value" : "relative"];
  if (typeof value !== "number" || !Number.isFinite(value) || stored.stepCount !== 1
      || stored.absPreset || stored.relPreset || stored.cooked === true
      || rows(stored.steps).some(step => step.integratedPreset)) {
    throw new Error(`Fixture ${stored.fixture} ${stored.attribute} requires a readable static numeric layer without preset, cooked or phaser data`);
  }
  return value;
}

function findMain(native: Row, number: number) {
  const cue = rows(native.cues).find(item => Number(item.no) === number);
  const part = cue && rows(cue.parts).find(item => nativePartIdentity(cue, item) === 0);
  if (!cue || !part) throw new Error(`Cue ${number / 1000} and its existing main part must be readable`);
  return { cue, part, content: row(JSON.parse(String(part.contentJson))) };
}

function hardValues(observation: Observation, scope: Scope) {
  const cue = observation.reconstruction.cues.find(item => item.no === scope.number);
  if (!cue) throw new Error(`Cue ${scope.cue} does not exist`);
  const out = new Map<string, { fixture: string; layer: Layer; value: number; blocked: boolean }>();
  for (const stored of cue.hard.filter(item => contains(scope, item))) {
    if (stored.part !== 0) throw new Error(`Cue ${scope.cue} contains a scoped channel in Part ${stored.part}. Use a main-part scope with unambiguous ownership.`);
    for (const layer of ["absolute", "relative"] as const) {
      if (!hasLayer(stored, layer)) continue;
      const fixture = stored.fixture as string;
      const key = cellKey(fixture, layer);
      if (out.has(key)) throw new Error(`Cue ${scope.cue} has duplicate scoped hard layers`);
      out.set(key, { fixture, layer, value: staticNumber(stored, layer), blocked: marked(stored, layer) });
    }
  }
  return out;
}

function compareValues(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => compareValues(v, b[i]));
  if (Array.isArray(a) && a.length === 1) return compareValues(a[0], b);
  if (Array.isArray(b) && b.length === 1) return compareValues(a, b[0]);
  return a === b || close(a, b);
}

function sameEffective(before: Observation["reconstruction"], after: Observation["reconstruction"]): boolean {
  return before.cues.length === after.cues.length && before.cues.every((cue, i) => {
    const other = after.cues[i];
    return cue.no === other.no && cue.effective.length === other.effective.length && cue.effective.every((cell, j) => {
      const next = other.effective[j];
      return cell.fixture === next.fixture && cell.attribute === next.attribute && cell.layer === next.layer && compareValues(cell.value, next.value);
    });
  });
}

function preservedHash(native: Row, scope: Scope): string {
  // Unchanged parts retain their full encoded native content. The changed part retains metadata and every unscoped normalized channel.
  return nativeContentFingerprint({ sequence: native.sequence, cues: rows(native.cues).map(cue => ({ ...cue,
    parts: rows(cue.parts).map(part => {
      if (Number(cue.no) !== scope.number || nativePartIdentity(cue, part) !== 0) return part;
      const { rawChannelsJson: _raw, contentJson: _content, ...metadata } = part;
      const unscoped = rows(row(JSON.parse(String(part.contentJson))).rows).filter(channel => !contains(scope, channel));
      return { ...metadata, unscoped };
    }) })) });
}

function simulated(observation: Observation, scope: Scope, action: Action, changes: Plan["changes"]) {
  const native = structuredClone(observation.native);
  const { part, content } = findMain(native, scope.number);
  const stored = rows(content.rows);
  for (const { fixture, layer, value } of changes) {
    let existing = stored.find(item => item.fixture === fixture && String(item.attribute).toLowerCase() === scope.attribute.toLowerCase());
    if (!existing) { existing = { fixture, attribute: scope.attribute, stepCount: 1 }; stored.push(existing); }
    existing[layer === "absolute" ? "hasAbsolute" : "hasRelative"] = action === "block";
    existing[layer === "absolute" ? "value" : "relative"] = value;
  }
  part.contentJson = JSON.stringify({ ...content, rows: stored.filter(item => hasLayer(item, "absolute") || hasLayer(item, "relative")) });
  return reconstructNativeCues(native);
}

function prepare(observation: Observation, scope: Scope, action: Action, sequence: number): Plan {
  findMain(observation.native, scope.number);
  const index = observation.reconstruction.cues.findIndex(c => c.no === scope.number);
  if (index < 0) throw new Error(`Cue ${scope.cue} does not exist`);
  const hard = hardValues(observation, scope);
  const current = observation.reconstruction.cues[index].effective.filter(cell => contains(scope, cell));
  const previous = observation.reconstruction.cues[index - 1]?.effective.filter(cell => contains(scope, cell)) ?? [];
  const nativeScope = { ...scope, attribute: current[0]?.attribute ?? scope.attribute };
  const changes: Plan["changes"] = [];
  if (action === "block") {
    for (const cell of current) {
      if (cell.sourcePart !== 0) throw new Error(`Cue ${scope.cue} inherits a scoped value from a nonzero part. Native Block ownership is ambiguous for that scope.`);
      const value = staticNumber(cell.stored, cell.layer);
      if (!hard.has(cellKey(cell.fixture, cell.layer))) changes.push({ fixture: cell.fixture, layer: cell.layer, value });
    }
  } else {
    for (const entry of hard.values()) {
      if (!entry.blocked) continue;
      const inherited = previous.find(cell => cell.fixture === entry.fixture && cell.layer === entry.layer);
      if (inherited && close(staticNumber(inherited.stored, inherited.layer), entry.value)) changes.push(entry);
    }
  }
  const after = simulated(observation, nativeScope, action, changes);
  if (!after.complete || !sameEffective(observation.reconstruction, after)) throw new Error(`Cue ${scope.cue} ${scope.attribute} would change an effective value. Inspect its tracking distances and cue-part ownership.`);
  const keyword = action === "block" ? "Block" : "Unblock";
  const command = `${keyword} ${cueRef(sequence, scope.cue)} If Fixture ${scope.fixtures.join(" + ")} Attribute "${nativeScope.attribute}" EndIf`;
  return { ...nativeScope, command, changes, beforeHash: preservedHash(observation.native, nativeScope) };
}

function verify(before: Observation, after: Observation, plan: Plan, action: Action): Verification {
  const checked = "native hard layers and unchanged sequence-owned effective values";
  const mismatch = (detail: string): Verification => ({ status: "mismatched", checked, detail });
  if (preservedHash(after.native, plan) !== plan.beforeHash) return mismatch("Native content or metadata changed outside the requested scope");
  if (!sameEffective(before.reconstruction, after.reconstruction)) return mismatch("Sequence-owned effective values changed");
  const old = hardValues(before, plan), actual = hardValues(after, plan);
  const expected = new Map(old);
  for (const change of plan.changes) {
    const key = cellKey(change.fixture, change.layer);
    if (action === "block") expected.set(key, { ...change, blocked: true });
    else expected.delete(key);
  }
  if (expected.size !== actual.size || [...expected].some(([key, wanted]) => {
    const observed = actual.get(key);
    return !observed || !close(wanted.value, observed.value) || wanted.blocked !== observed.blocked;
  })) return mismatch("The requested blocked or unblocked hard layers were not confirmed");
  return { status: "matched", checked, actual: { changedLayers: plan.changes.length } };
}

export async function readCueContextKey(ctx: ToolContext): Promise<string> {
  const value = await ctx.bridge.request<Row>("fast.context", {}, ctx.requestTimeoutMs);
  if (typeof value.contextKey !== "string" || !value.contextKey || !Array.isArray(value.identityUncertain) || value.identityUncertain.length
      || !["Normal", "Preview"].includes(String(value.environment))) throw new Error("Console identity or programmer environment is unavailable");
  return JSON.stringify([value.contextKey, value.environment]);
}

async function observe(ctx: ToolContext, sequence: number, expectedContext: string): Promise<Observation> {
  if (await readCueContextKey(ctx) !== expectedContext) throw new Error("Console context changed before native read");
  const native = await readNativeCueContent(ctx.bridge, sequenceRef(sequence), ctx.requestTimeoutMs);
  if (await readCueContextKey(ctx) !== expectedContext) throw new Error("Console context changed during native read");
  const reconstruction = reconstructNativeCues(native);
  if (native.complete !== true || !reconstruction.complete) throw new Error(`Complete native tracking data is required: ${reconstruction.limitations.join("; ")}`);
  if (!/^(yes|on|true)$/i.test(String(row(row(native.sequence).fields).Tracking))) throw new Error("Sequence Tracking must be enabled");
  return { native, reconstruction };
}

export async function cueTrackingAction(ctx: ToolContext, raw: unknown) {
  const operation = "cue_tracking_action";
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return validationFailure(operation, {}, parsed.error.issues.map(issue => issue.message));
  const args = parsed.data;
  let cues: string[], fixtures: string[], attributes: string[];
  try {
    cues = args.cues.map((cue, i) => cueNumber(`cues[${i}]`, cue)!);
    fixtures = args.fixtures.flatMap((fixture, i) => expandFixtures(`fixtures[${i}]`, fixture));
    attributes = args.attributes.map((attribute, i) => attributeName(`attributes[${i}]`, attribute));
    if (fixtures.length > 200 || cues.length * attributes.length > MAX_COMMANDS) throw new Error("Use at most 200 fixture IDs and 100 cue/attribute action combinations per call");
    if (new Set(cues).size !== cues.length || new Set(fixtures).size !== fixtures.length || new Set(attributes.map(a => a.toLowerCase())).size !== attributes.length) throw new Error("Cue, fixture and attribute scopes must be unique");
  } catch (error) { return validationFailure(operation, {}, [String(error)]); }
  const target = { sequence: args.sequence, cues, part: 0, fixtures, attributes, action: args.action };
  ctx = inDataPool(ctx, args);
  return ctx.mutations.run(async () => {
    const steps: StepResult[] = [];
    let identity: string, before: Observation, plans: Plan[];
    try {
      identity = await readCueContextKey(ctx);
      const refs = [sequenceRef(args.sequence), ...cues.flatMap(cue => [cueRef(args.sequence, cue), cueRef(args.sequence, cue, 0)])];
      for (const ref of refs) if (lockState((await readFields(ctx.bridge, ref, ["Lock"]))?.Lock) !== false) throw new Error(`${ref} is missing, locked or unreadable`);
      before = await observe(ctx, args.sequence, identity);
      plans = cues.flatMap(cue => attributes.map(attribute => prepare(before, { cue, number: Math.round(Number(cue) * 1000), attribute, fixtures }, args.action, args.sequence)));
      steps.push(asRead({ name: "preflight", status: "succeeded", detail: { checkedCues: cues.length } }));
    } catch (error) {
      steps.push(asRead(stepFromError("preflight", error)));
      return buildResult({ operation, target, steps, verification: unavailable(String(error)) });
    }
    if (args.preview) return buildResult({ operation, target, steps, verification: notRequested(), extra: { preview: true, plan: plans.map(({ command, changes }) => ({ command, changes })) } });
    let verification: Verification = { status: "matched", checked: "complete native state, no scoped layers require a change" };
    for (const item of plans) {
      if (item.changes.length === 0) continue;
      try {
        if (await readCueContextKey(ctx) !== identity) throw new Error("Console context changed before action");
        const current = prepare(before, item, args.action, args.sequence);
        const step = await commandStep(ctx.bridge, `${args.action} cue ${item.cue} ${item.attribute}`, current.command, ctx.requestTimeoutMs);
        steps.push(step);
        if (step.status !== "succeeded") { verification = unavailable(step.error ?? "Action was not confirmed"); break; }
        const after = await observe(ctx, args.sequence, identity);
        verification = verify(before, after, current, args.action);
        steps.push(asRead({ name: `verify cue ${item.cue} ${item.attribute}`, status: verification.status === "matched" ? "succeeded" : "failed", detail: verification }));
        if (verification.status !== "matched") break;
        before = after;
      } catch (error) {
        steps.push(asRead(stepFromError(`verify cue ${item.cue} ${item.attribute}`, error)));
        verification = unavailable(String(error));
        break;
      }
    }
    return buildResult({ operation, target, steps, verification });
  });
}

export const registerCueTrackingActionTools: RegisterTools = (server, ctx) => {
  server.registerTool("gma3_cue_tracking_action", {
    title: "Block or unblock scoped cue tracking",
    description: "Apply the native Block or Unblock command to explicit existing cues, fixture IDs and attributes. Supports verified static main-part layers. Preview reads the exact scope and projected changes. Apply verifies stored hard data, effective sequence values and the unscoped data after each command. Stops after the first failure or uncertain result.",
    inputSchema: shape,
  }, args => operation(() => cueTrackingAction(ctx, args)));
};
