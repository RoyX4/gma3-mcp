/** Continuous control through documented native FaderMaster ... Fade plus native timecode recording. */
import { z } from "zod";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { asRead, buildResult, commandStep, stepFromError, validationFailure, type OperationResult, type StepResult } from "../results.js";
import { Validator, finiteNumber } from "../validate.js";
import { readTimecode, type TimecodeRead } from "./timecode.js";

interface Point { at: number; value: number }
interface Args { timecode: number; sequence: number; points: Point[]; preview?: boolean; exclusive?: boolean }
const TOLERANCE = 0.5; // Percentage points of the Master fader's documented 0-100 scale.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function recordFaderCurve(ctx: ToolContext, raw: Args): Promise<OperationResult> {
  const op = "record_fader_curve", v = new Validator();
  const no = v.check(() => finiteNumber("timecode", raw.timecode, { integer: true, min: 1, max: 99999 }));
  const sequence = v.check(() => finiteNumber("sequence", raw.sequence, { integer: true, min: 1, max: 99999 }));
  const points: Point[] = [];
  if (!Array.isArray(raw.points) || raw.points.length < 2 || raw.points.length > 32) v.fail("points must contain 2-32 {at,value} entries");
  else raw.points.forEach((point, i) => {
    const at = v.check(() => finiteNumber(`points[${i}].at`, point.at, { min: 0, max: 60 }));
    const value = v.check(() => finiteNumber(`points[${i}].value`, point.value, { min: 0, max: 100 }));
    if (at !== undefined && value !== undefined) points.push({ at, value });
    if (i === 0 && at !== 0) v.fail("the first point must be at 0 seconds relative to the recording start");
    if (i > 0 && at !== undefined && at <= (points[i - 1]?.at ?? Infinity)) v.fail("point times must be strictly increasing");
  });
  const preview = raw.preview !== false;
  if (!preview && raw.exclusive !== true) v.fail("exclusive must be true when applying: this changes a live sequence's master level and records it");
  const target = { timecode: raw.timecode, sequence: raw.sequence };
  if (!v.ok || no === undefined || sequence === undefined) return validationFailure(op, target, v.errors);
  const tm = Math.min(ctx.requestTimeoutMs, 2000), ref = `Sequence ${sequence}`;
  const commands = points.map((p, i) => `FaderMaster ${ref} At ${p.value}${i ? ` Fade ${Math.round((p.at - points[i - 1].at) * 1e6) / 1e6}` : ""}`);
  const body = async () => {
    const steps: StepResult[] = [];
    const samples: Array<{ elapsed: number; segment: number; value: number }> = [];
    let before: TimecodeRead | null;
    const fader = async () => {
      const r = await ctx.bridge.request("getfader", { ref, tokens: ["FaderMaster"] }, tm) as { faders?: { FaderMaster?: { value?: number } } };
      const value = r.faders?.FaderMaster?.value;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) throw new Error("the sequence Master fader is not readable on its native 0-100 scale");
      return value;
    };
    try {
      before = await readTimecode(ctx.bridge, no, tm);
      if (!before || before.recording !== false || before.playing !== false) throw new Error("the timecode show must exist with readable idle playback and recording state");
      if (before.truncated || before.eventCount !== 0) throw new Error("use an empty timecode show: this route refuses to overwrite or replay existing events during recording");
      if (before.settings.Lock === undefined || !["", "No", "Off"].includes(String(before.settings.Lock))) throw new Error("the timecode show is locked or its Lock is unreadable");
      if (String(before.settings.TCSlot) !== "-1") throw new Error("an internal timecode source is required for bounded native fade recording");
      const seq = await ctx.bridge.request("objects", { ref, fields: ["Lock"], asText: false, limit: 2 }, tm) as { total?: number; items?: Array<{ class?: string }> };
      if (seq.total !== 1 || seq.items?.[0]?.class !== "Sequence") throw new Error("sequence identity did not resolve uniquely");
      const initial = await fader();
      steps.push(asRead({ name: "preflight", status: "succeeded", detail: { initialMaster: initial, settings: before.settings } }));
    } catch (err) { return buildResult({ operation: op, target, steps: [asRead(stepFromError("preflight", err))], extra: { preview } }); }
    const plan = { commands: [`Record Timecode ${no}`, ...commands, `Record Off Timecode ${no}`], points, duration: points.at(-1)!.at, scope: "live sequence Master fader; native recording into an empty internal-source timecode show" };
    if (preview) return buildResult({ operation: op, target, steps, summary: "Preview only; no fader or recording changed.", extra: { preview, plan } });
    const startedAt = Date.now();
    const startStep = await commandStep(ctx.bridge, "start_recording", `Record Timecode ${no}`, tm);
    steps.push(startStep);
    let recordingVerified = false, finalValue: number | null = null;
    try {
      const recording = await readTimecode(ctx.bridge, no, tm);
      if (startStep.status !== "succeeded" || recording?.recording !== true) throw new Error("recording start was not confirmed; no fader command sent");
      recordingVerified = true;
      steps.push(asRead({ name: "verify_recording", status: "succeeded", detail: { recording: true } }));
      for (const [i, command] of commands.entries()) {
        if (Date.now() - startedAt > 65000) throw new Error("the bounded recording window expired before all segments finished");
        const dispatch = Date.now();
        const step = await commandStep(ctx.bridge, `segment_${i}`, command, tm); steps.push(step);
        if (step.status !== "succeeded") break; // Never replay an uncertain fade or send later segments.
        const duration = i ? points[i].at - points[i - 1].at : 0;
        const end = dispatch + duration * 1000;
        while (Date.now() < end) await sleep(Math.min(50, end - Date.now()));
        // Read-only settling: native frames can finish after the host's scheduled boundary.
        const settleEnd = Date.now() + 250;
        do {
          finalValue = await fader();
          samples.push({ elapsed: (Date.now() - startedAt) / 1000, segment: i, value: finalValue });
          if (Math.abs(finalValue - points[i].value) <= TOLERANCE) break;
          await sleep(25);
        } while (Date.now() < settleEnd);
        const matched = Math.abs(finalValue - points[i].value) <= TOLERANCE;
        steps.push(asRead({ name: `verify_segment_${i}`, status: matched ? "succeeded" : "failed", op: "getfader", detail: { expected: points[i].value, actual: finalValue, tolerancePercentagePoints: TOLERANCE }, ...(matched ? {} : { error: "native Master fader did not reach the segment endpoint" }) }));
        if (!matched) break;
      }
    } catch (err) { steps.push(asRead(stepFromError("record_curve", err))); }
    finally {
      // A distinct stop is always attempted once after an admitted/uncertain Record, even if observation failed.
      if (startStep.status !== "failed" || recordingVerified) steps.push(await commandStep(ctx.bridge, "stop_recording", `Record Off Timecode ${no}`, tm));
    }
    let after: TimecodeRead | null = null;
    try {
      after = await readTimecode(ctx.bridge, no, tm);
      const settleEnd = Date.now() + 1000;
      while (after?.recording === true && Date.now() < settleEnd) { await sleep(25); after = await readTimecode(ctx.bridge, no, tm); }
      steps.push(asRead({ name: "read_recorded_events", status: "succeeded", op: "timecode.read" }));
    }
    catch (err) { steps.push(asRead(stepFromError("read_recorded_events", err, { op: "timecode.read" }))); }
    const nativeEvents = after?.events ?? [];
    const issues: string[] = [];
    if (after?.recording !== false) issues.push("recording did not read back Off");
    if (!after || after.truncated) issues.push("stored native event readback is incomplete");
    if (!nativeEvents.length) issues.push("no new native timecode events were stored");
    if (!nativeEvents.some(e => e.class && e.class !== "CmdEvent" && e.fields && e.fieldsComplete === true)) issues.push("no complete non-command native event was returned; command events alone cannot establish captured continuous control");
    if (steps.filter(s => s.name.startsWith("verify_segment_") && s.status === "succeeded").length !== points.length) issues.push("not every requested segment endpoint was observed");
    return buildResult({ operation: op, target, steps,
      verification: { status: issues.length ? "mismatched" : "matched", checked: "native recording stopped, all sequence-Master endpoints observed, and complete non-command native events stored", ...(issues.length ? { detail: issues.join("; ") } : {}) },
      warnings: ["This performs live fader changes while recording. AutoStart/AutoStop and playback settings may affect output. Native Fade interpolates each segment; host dispatch and observed endpoint times are reported separately from intended points."],
      extra: { preview, plan, samples, nativeEventsAfter: nativeEvents, recording: after?.recording ?? "unknown", curveVerification: { status: "unavailable", detail: "exact stored curve values/times are preserved as native fields; their version-specific schema has not been qualified, so endpoint/capture verification is not exact curve verification" } },
    });
  };
  return preview ? body() : ctx.mutations.run(body);
}

export const registerTimecodeFaderTool: RegisterTools = (server, ctx) => {
  server.registerTool("gma3_record_fader_curve", {
    title: "Record a piecewise continuous native Master-fader curve",
    description: "Preview by default. For an existing empty internal-source timecode show, use 2-32 points {at:seconds,value:0-100}, starting at 0 and ending within 60 seconds. preview:false and exclusive:true issue native FaderMaster Sequence N At value Fade duration segments while recording, observe each Master endpoint, then stop once. This changes live output. Preserves actual native event classes/fields; zero captured events or command events alone fail verification. Exact stored curve-field/timestamp equivalence remains explicitly unqualified. No uncertain Record or Fade is replayed.",
    inputSchema: { timecode: z.number(), sequence: z.number(), points: z.array(z.object({ at: z.number(), value: z.number() }).strict()), preview: z.boolean().optional(), exclusive: z.boolean().optional() },
  }, async (args) => operation(() => recordFaderCurve(ctx, args)));
};
