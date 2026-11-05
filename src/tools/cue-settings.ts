/** Native metadata edits. These never store the programmer or trigger playback. */
import { z } from "zod";
import { parseNativeTrackingDistance } from "../native-cues.js";
import { cueNumber, objectName } from "../validate.js";
import { asRead, buildResult, commandStep, compareFields, notRequested, requestStep, stepFromError, timeToSeconds, unavailable,
  validationFailure, type StepResult, type Verification } from "../results.js";
import { readFields, cueRef, sequenceRef } from "./common.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import { dataPoolShape, inDataPool } from "./datapool.js";
import { lockState } from "./playback.js";
import { checkCommandVariables, cueCommand } from "./cuelists.js";
import { cueBreakSchema, readCueBreak, resolveCueBreak, sameCueBreak, type BreakPlan } from "./cue-break.js";
import { readCueContextKey } from "./cue-tracking-actions.js";

const cueNo = z.union([z.number(), z.string()]).transform((v, ctx) => {
  try { return cueNumber("cue", v)!; } catch (err) { ctx.addIssue({ code: "custom", message: String(err) }); return z.NEVER; }
});
const endpoint = z.union([cueNo, z.object({ delta: cueNo }).strict(), z.literal("none")]);
const seconds = z.number().finite().min(0).max(3600);
const cueShape = {
  release: z.enum(["default", "yes"]).optional().describe("yes explicitly releases tracked values here; default clears the explicit flag. First-cue behavior can still inherit ReleaseFirstCue."),
  assert: z.enum(["none", "assert", "x_assert"]).optional(),
  break: cueBreakSchema.optional().describe("A World or confirmed static Filter that protects this cue from subsequent tracking edits. null clears."),
  allow_duplicates: z.boolean().optional(),
  mib_preference: z.enum(["never", "worst", "bad", "normal", "good", "best"]).optional(),
  note: z.string().max(1024).transform(v => v.trim()).optional(),
  trigger_sound: z.enum(["All", "Bass", "Mid", "High", "Band1", "Band2", "Band3", "Band4", "Band5", "Band6", "Band7", "InvAll", "InvBass", "InvMid", "InvHigh", "InvBand1", "InvBand2", "InvBand3", "InvBand4", "InvBand5", "InvBand6", "InvBand7"]).optional(),
};
const partShape = {
  name: z.string().optional(),
  tracking_distance: endpoint.optional().describe("Inclusive ending cue number or {delta: number} measured from the starting cue number. none clears it."),
  command: z.string().optional().describe("Stored command text; setting it does not execute it. Empty string clears."),
  command_enabled: z.boolean().optional(),
  command_delay: seconds.optional(),
  transition: z.enum(["linear", "slow", "slow_plus", "fast", "fast_plus", "s_curve", "swing_minus", "swing", "swing_plus"]).optional(),
  mib_mode: z.enum(["default", "none", "defined", "early", "upon_go", "late"]).optional(),
  mib_target: cueNo.optional().describe("Explicit target cue for mib_mode:defined; supply both together."),
  mib_fade: z.union([seconds, z.literal("default")]).optional(),
  mib_delay: z.union([seconds, z.literal("default")]).optional(),
  mib_multistep: z.enum(["paused", "running"]).optional(),
};
const targetShape = { ...dataPoolShape, sequence: z.number().int().min(1).max(99999), cue: cueNo, part: z.number().int().min(0).max(999).default(0) };
const configureShape = { ...targetShape, cue_settings: z.object(cueShape).strict().optional(), part_settings: z.object(partShape).strict().optional(), preview: z.boolean().default(false) };
const configureSchema = z.object(configureShape).strict().superRefine((v, ctx) => {
  if (!Object.keys(v.cue_settings ?? {}).length && !Object.keys(v.part_settings ?? {}).length) ctx.addIssue({ code: "custom", message: "At least one cue_settings or part_settings field is required" });
  const p = v.part_settings;
  if ((p?.mib_mode === "defined") !== (p?.mib_target !== undefined)) ctx.addIssue({ code: "custom", message: "mib_mode:defined and mib_target must be provided together" });
  if (p?.command?.trim() === "" && p.command_enabled !== undefined) ctx.addIssue({ code: "custom", message: "Clearing Command makes CommandEnabled unavailable; clear the command without an enabled setting" });
  if (p?.mib_mode === "none" && [p.mib_fade, p.mib_delay, p.mib_multistep].some(x => x !== undefined)) ctx.addIssue({ code: "custom", message: "MIB mode none makes its subordinate settings unavailable; configure timing/multistep while MIB is enabled, then disable separately" });
  try { if (p?.name !== undefined) objectName("name", p.name); if (p?.command !== undefined) cueCommand("command", p.command); }
  catch (err) { ctx.addIssue({ code: "custom", message: String(err) }); }
});

type Def = { property: string; values?: Record<string, string>; time?: boolean; clear?: boolean };
const CUE_DEFS: Record<string, Def> = {
  release: { property: "Release", values: { default: "", yes: "Yes" } },
  assert: { property: "Assert", values: { none: "", assert: "Assert", x_assert: "X-Assert" } },
  allow_duplicates: { property: "AllowDuplicates", values: { true: "Yes", false: "" } },
  mib_preference: { property: "MIBPreference", values: { never: "Never", worst: "Worst", bad: "Bad", normal: "Normal", good: "Good", best: "Best" } },
  note: { property: "Note" }, trigger_sound: { property: "TrigSound" },
};
const PART_DEFS: Record<string, Def> = {
  name: { property: "Name" }, tracking_distance: { property: "TrackingDistance", clear: true },
  command: { property: "Command" }, command_enabled: { property: "CommandEnabled" }, command_delay: { property: "CommandDelay", time: true },
  transition: { property: "Transition", values: { linear: "Linear", slow: "Slow", slow_plus: "Slow+", fast: "Fast", fast_plus: "Fast+", s_curve: "SCurve", swing_minus: "Swing-", swing: "Swing", swing_plus: "Swing+" } },
  mib_mode: { property: "MibMode", values: { default: "Default", none: "None", defined: "Defined", early: "Early", upon_go: "UponGo", late: "Late" } },
  mib_target: { property: "MibTarget" }, mib_fade: { property: "MibFade", time: true }, mib_delay: { property: "MibDelay", time: true },
  mib_multistep: { property: "MibMultistep", values: { paused: "Paused", running: "Running" } },
};
const sequenceFields = ["Lock", "Tracking", "ReleaseFirstCue", "CueCommand", "SequMIB", "SequMIBMode"];
const cueFields = ["Lock", "No", "Break", "TrigType", "TrigTime", ...Object.values(CUE_DEFS).map(d => d.property)];
const partFields = ["Lock", "Part", "CueInFade", "CueInDelay", "CueOutFade", "CueOutDelay", "SnapDelay", "Duration", ...Object.values(PART_DEFS).map(d => d.property)];
const notes = ["Properties are read in the native Edit role. Empty Release is the explicit default; ReleaseFirstCue can still supply the first cue's effective release.",
  "Stored settings are separate from resulting playback. Sequence CueCommand/MIB policies can override part settings. No Store, Goto, Go, Load or programmer change is performed.",
  "Break assignments protect future edits. Duration remains read-only. Missing properties stay unavailable."];
const defined = (fields: string[], raw: Record<string, unknown>) => Object.fromEntries(fields.map(k => [k, raw[k] ?? null]));

async function settings(ctx: ToolContext, target: z.infer<z.ZodObject<typeof targetShape>>) {
  // Sequential, bounded reads avoid concurrent requests to the console. No cue hard-data scan is needed.
  const seq = await readFields(ctx.bridge, sequenceRef(target.sequence), sequenceFields);
  const cue = await readFields(ctx.bridge, cueRef(target.sequence, target.cue), cueFields);
  const part = await readFields(ctx.bridge, cueRef(target.sequence, target.cue, target.part), partFields);
  if (!seq || !cue || !part) throw new Error("Sequence, cue or part does not exist; no objects are created by a settings edit");
  return { sequenceSettings: defined(sequenceFields, seq), cueSettings: defined(cueFields, cue), partSettings: defined(partFields, part) };
}

interface Change { ref: string; property: string; value: unknown; time?: boolean }
function changes(ref: string, values: Record<string, unknown> | undefined, defs: Record<string, Def>): Change[] {
  return Object.entries(values ?? {}).map(([key, input]) => {
    const d = defs[key];
    if (key === "tracking_distance" && typeof input === "object" && input !== null) {
      return { ref, property: d.property, value: `Δ+${(input as { delta: string }).delta}` };
    }
    const value = d.values ? d.values[String(input)] : typeof input === "boolean" ? input ? "Yes" : "No" : d.clear && input === "none" ? "" : d.time && input === "default" ? "Default" : key === "name" ? objectName("name", input)! : key === "command" ? cueCommand("command", input)! : input;
    return { ref, property: d.property, value, time: d.time };
  });
}
function compare(change: Change, actual: unknown): Verification {
  if (change.property === "TrackingDistance" && change.value !== "") {
    const expected = parseNativeTrackingDistance(change.value);
    const observed = parseNativeTrackingDistance(actual);
    const matches = expected !== null && observed !== null && expected.relative === observed.relative && expected.milli === observed.milli;
    return { status: matches ? "matched" : "mismatched", expected: change.value, actual,
      ...(matches ? {} : { detail: "TrackingDistance mode or numeric value differs from the request" }) };
  }
  if (["Name", "Note", "Command"].includes(change.property)) return {
    status: typeof actual === "string" && actual === change.value ? "matched" : "mismatched",
    checked: `${change.ref}.${change.property} (exact text)`, expected: change.value, actual,
    ...(actual !== change.value ? { detail: `${change.property}: exact text differs from the requested value` } : {}),
  };
  return compareFields(`${change.ref}.${change.property}`, { [change.property]: change.value }, { [change.property]: actual },
    change.time && typeof change.value === "number" ? { normalize: { [change.property]: timeToSeconds } } : {});
}
function actualFrom(state: Awaited<ReturnType<typeof settings>>, change: Change): unknown {
  return (change.ref.includes(" Part ") ? state.partSettings : state.cueSettings)[change.property];
}

export async function configureCue(ctx: ToolContext, raw: unknown) {
  const parsed = configureSchema.safeParse(raw);
  if (!parsed.success) return validationFailure("configure_cue", {}, parsed.error.issues.map(i => i.message));
  const args = parsed.data, target = { sequence: args.sequence, cue: args.cue, part: args.part };
  ctx = inDataPool(ctx, args);
  const cue = cueRef(args.sequence, args.cue);
  const { break: breakRequest, ...cueSettings } = args.cue_settings ?? {};
  const distance = args.part_settings?.tracking_distance;
  const guarded = breakRequest !== undefined || typeof distance === "object";
  const plan = [...changes(cue, cueSettings, CUE_DEFS), ...changes(cueRef(args.sequence, args.cue, args.part), args.part_settings, PART_DEFS)];
  return ctx.mutations.run(async () => {
    const steps: StepResult[] = [];
    let before: Awaited<ReturnType<typeof settings>>;
    let identity: string | undefined;
    let breakPlan: BreakPlan | undefined;
    let breakBefore: Awaited<ReturnType<typeof readCueBreak>> = null;
    const confirmContext = async () => {
      if (identity !== undefined && await readCueContextKey(ctx) !== identity) throw new Error("Console context changed during the cue edit");
    };
    try {
      if (guarded) identity = await readCueContextKey(ctx);
      before = await settings(ctx, args);
      for (const [owner, values] of Object.entries(before)) {
        if (lockState(values.Lock) !== false) throw new Error(`${owner} is locked or its lock state is unavailable; no settings changed`);
      }
      if (breakRequest !== undefined) {
        breakPlan = await resolveCueBreak(ctx, cue, breakRequest);
        breakBefore = await readCueBreak(ctx, cue, before.cueSettings.Break);
      }
      await confirmContext();
      steps.push(asRead({ name: "read_settings", status: "succeeded", op: "objects" }));
    } catch (err) {
      steps.push(asRead(stepFromError("read_settings", err)));
      return buildResult({ operation: "configure_cue", target, steps, verification: unavailable(String(err)), extra: { notes } });
    }
    if (args.preview) return buildResult({ operation: "configure_cue", target, steps, verification: notRequested(), extra: { preview: true, before, plan, ...(breakPlan ? { breakPlan, breakBefore } : {}), notes } });
    if (args.part_settings?.command !== undefined) {
      const check = await checkCommandVariables(ctx.bridge, [{ label: "part command", command: args.part_settings.command }], ctx.requestTimeoutMs);
      steps.push(check);
      if (check.status !== "succeeded") return buildResult({ operation: "configure_cue", target, steps });
    }
    if (breakPlan && !sameCueBreak(breakBefore, breakPlan.expected)) {
      try {
        await confirmContext();
        const step = await commandStep(ctx.bridge, "set_Break", breakPlan.command, ctx.requestTimeoutMs);
        steps.push(step);
        if (step.status === "succeeded") {
          const actual = await readCueBreak(ctx, cue);
          await confirmContext();
          const matched = sameCueBreak(actual, breakPlan.expected);
          steps.push(asRead({ name: "verify_Break", status: matched ? "succeeded" : "failed", op: "objects",
            detail: { expected: breakPlan.expected, actual }, ...(matched ? {} : { error: "The exact native Break handle differs" }) }));
        }
      } catch (error) { steps.push(asRead(stepFromError("verify_Break", error))); }
    }
    for (const change of plan) {
      if (steps.some(step => step.status !== "succeeded")) break;
      if (compare(change, actualFrom(before, change)).status === "matched") continue;
      try { await confirmContext(); }
      catch (error) { steps.push(asRead(stepFromError("check_context", error))); break; }
      const step = await requestStep(ctx.bridge, `set_${change.property}`, "set", { ref: change.ref, property: change.property, value: change.value }, result => {
        const r = result as { value?: unknown; readOk?: boolean } | null;
        if (!r || r.readOk === false) return { name: `set_${change.property}`, op: "set", status: "unknown", detail: result,
          error: "Set was dispatched but its readback is unavailable; the setting may have changed. Not retried." };
        const verification = compare(change, r?.value);
        return { name: `set_${change.property}`, op: "set", status: verification.status === "matched" ? "succeeded" : "failed", detail: result,
          ...(verification.status !== "matched" ? { error: "Requested setting was not confirmed by the setter readback" } : {}) };
      }, ctx.requestTimeoutMs);
      steps.push(step);
      if (step.status !== "succeeded") break;
    }
    let verification: Verification;
    let after: Awaited<ReturnType<typeof settings>> | undefined;
    let breakAfter: Awaited<ReturnType<typeof readCueBreak>> | undefined;
    try {
      await confirmContext();
      after = await settings(ctx, args);
      const checks = plan.map(c => compare(c, actualFrom(after!, c)));
      if (breakPlan) {
        breakAfter = await readCueBreak(ctx, cue, after.cueSettings.Break);
        const matched = sameCueBreak(breakAfter, breakPlan.expected);
        checks.push({ status: matched ? "matched" : "mismatched", ...(matched ? {} : { detail: "The exact native Break handle differs" }) });
      }
      await confirmContext();
      verification = { status: checks.every(v => v.status === "matched") ? "matched" : "mismatched", checked: "All requested final cue and part settings, including initially unchanged fields", expected: plan,
        actual: after, ...(checks.some(v => v.status !== "matched") ? { detail: checks.filter(v => v.status !== "matched").map(v => v.detail).join("; ") } : {}) };
    } catch (err) { verification = unavailable(String(err), "Final requested settings"); }
    return buildResult({ operation: "configure_cue", target, steps, verification, extra: { before, after, ...(breakPlan ? { breakBefore, breakExpected: breakPlan.expected, breakAfter } : {}), notes } });
  });
}

export const registerCueSettingsTools: RegisterTools = (server, ctx) => {
  server.registerTool("gma3_cue_settings", { title: "Read cue and part settings", description: "Read native Sequence policy, Cue flags/trigger and Part timing/command/MIB settings without loading or playing the cue. Keeps explicit Release separate from inherited ReleaseFirstCue; missing values remain null.",
    inputSchema: targetShape, annotations: { readOnlyHint: true, destructiveHint: false } }, async raw => {
    const parsed = z.object(targetShape).safeParse(raw);
    if (!parsed.success) return { isError: true, content: [{ type: "text", text: parsed.error.message }] };
    try { return json({ target: parsed.data, ...await settings(inDataPool(ctx, parsed.data), parsed.data), notes }); }
    catch (err) { return { isError: true, content: [{ type: "text", text: String(err) }] }; }
  });
  server.registerTool("gma3_configure_cue", { title: "Configure an existing cue or part", description: "Change only requested native cue/part settings on an existing explicit sequence/cue/part. Includes Release/Assert, Break World/static Filter assignment, MIB preference, duplicates, notes, sound band, part name, absolute or delta tracking distance, command settings, transition and MIB. preview:true only reads. Refuses locked/unknown-lock sequences. Always checks setter replies and all requested final fields, stops after first failed/uncertain write, never retries. Use existing timing/trigger tools for fade/delay/trigger and configure_sequence for Tracking on/off.", inputSchema: configureShape }, args => operation(() => configureCue(ctx, args)));
};
