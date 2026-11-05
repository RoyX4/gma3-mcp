/** Recording uses native Record/Record Off and IsRecording(), demonstrated by MA's shipped TimecodeRecord tests. */
import { z } from "zod";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { buildResult, asRead, commandStep, stepFromError, validationFailure, type OperationResult, type StepResult } from "../results.js";
import { Validator, finiteNumber } from "../validate.js";
import { readTimecode, type TimecodeRead } from "./timecode.js";

interface RecordArgs { timecode: number; action: "capture" | "start" | "stop"; duration_seconds?: number; preview?: boolean }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function recordTimecode(ctx: ToolContext, raw: RecordArgs): Promise<OperationResult> {
  const op = "timecode_record";
  const v = new Validator();
  const no = v.check(() => finiteNumber("timecode", raw.timecode, { integer: true, min: 1, max: 99999 }));
  if (!["capture", "start", "stop"].includes(raw.action)) v.fail("action must be capture, start or stop");
  const duration = v.check(() => finiteNumber("duration_seconds", raw.duration_seconds ?? 5, { min: 0.1, max: 60 }));
  if (raw.duration_seconds !== undefined && raw.action !== "capture") v.fail("duration_seconds is for capture only");
  const target = { timecode: raw.timecode, action: raw.action };
  if (!v.ok || no === undefined || duration === undefined) return validationFailure(op, target, v.errors);
  const body = async () => {
    const steps: StepResult[] = [];
    let before: TimecodeRead | null;
    try {
      before = await readTimecode(ctx.bridge, no, ctx.requestTimeoutMs);
      if (!before) throw new Error(`Timecode ${no} does not exist`);
      if (typeof before.recording !== "boolean") throw new Error("the native recording state is unavailable; update the bridge before recording");
      if (raw.action !== "stop" && (before.settings.Lock === undefined || !["", "No", "Off"].includes(String(before.settings.Lock)))) throw new Error("the timecode show is locked or its Lock state is unreadable");
      if (raw.action !== "stop" && before.recording) throw new Error("the timecode show is already recording; stop that recording explicitly first");
      steps.push(asRead({ name: "read_recording", status: "succeeded", op: "timecode.read", detail: { recording: before.recording, events: before.eventCount } }));
    } catch (err) {
      steps.push(asRead(stepFromError("read_recording", err, { op: "timecode.read" })));
      return buildResult({ operation: op, target, steps, summary: "Recording was not changed; preflight failed." });
    }
    const commands = raw.action === "capture" ? [`Record Timecode ${no}`, `Record Off Timecode ${no}`] : [raw.action === "start" ? `Record Timecode ${no}` : `Record Off Timecode ${no}`];
    if (raw.preview) return buildResult({ operation: op, target, steps, summary: "Preview only; recording was not changed.", extra: { preview: true, commands, duration_seconds: raw.action === "capture" ? duration : null } });
    let last = before;
    const readState = async (name: string) => {
      try {
        const show = await readTimecode(ctx.bridge, no, ctx.requestTimeoutMs);
        if (!show || typeof show.recording !== "boolean") throw new Error("recording state could not be read back");
        last = show;
        steps.push(asRead({ name, status: "succeeded", op: "timecode.read", detail: { recording: show.recording, events: show.eventCount } }));
        return show;
      } catch (err) { steps.push(asRead(stepFromError(name, err, { op: "timecode.read" }))); return null; }
    };
    const startStep = await commandStep(ctx.bridge, raw.action === "stop" ? "stop_recording" : "start_recording", commands[0], ctx.requestTimeoutMs);
    steps.push(startStep);
    let actual = await readState("read_after_command");
    const expectedAfterCommand = raw.action !== "stop";
    const commandSettleEnd = Date.now() + 1000;
    while (actual && actual.recording !== expectedAfterCommand && Date.now() < commandSettleEnd) {
      await sleep(25); actual = await readState("read_command_settled");
    }
    const started = actual?.recording === true && raw.action !== "stop";
    if (raw.action === "capture" && (started || startStep.status !== "failed")) {
      const end = Date.now() + (started ? duration * 1000 : 0);
      // A single timed capture, never a retry of Record. If observation fails, still send its one distinct stop.
      while (Date.now() < end) await sleep(Math.min(50, end - Date.now()));
      steps.push(await commandStep(ctx.bridge, "stop_recording", commands[1], ctx.requestTimeoutMs));
      actual = await readState("read_stopped");
      const settleEnd = Date.now() + 1000;
      while (actual?.recording === true && Date.now() < settleEnd) {
        await sleep(25);
        actual = await readState("read_stop_settled");
      }
    }
    const wanted = raw.action === "start";
    const matched = actual?.recording === wanted && (raw.action !== "capture" || started);
    return buildResult({ operation: op, target, steps,
      verification: actual ? { status: matched ? "matched" : "mismatched", checked: `native recording state ${wanted ? "On" : "Off"}${raw.action === "capture" ? " after a verified recording interval" : ""}`, actual: actual.recording } : { status: "unavailable", detail: "recording state could not be read back; inspect the console before another recording" },
      extra: { recording: actual?.recording ?? "unknown", recordingStarted: started, eventsBefore: before.eventCount, eventsAfter: actual?.eventCount ?? null, eventCountChange: actual ? actual.eventCount - before.eventCount : null, truncated: last.truncated,
        qualification: "Record, Record Off and IsRecording are demonstrated in MA's bundled 2.5.1 system tests; captured event contents are native readback, not a prediction of what the operator performed." },
    });
  };
  return raw.preview ? body() : ctx.mutations.run(body);
}

export const registerTimecodeRecordTool: RegisterTools = (server, ctx) => {
  server.registerTool("gma3_timecode_record", {
    title: "Capture, start or stop native timecode recording",
    description: "Record actual executor operations into an existing unlocked timecode show. capture records for duration_seconds (0.1-60, default 5) and stops once; start leaves recording active until an explicit stop. Preview reads state and returns commands only. Never replays an uncertain Record. Reports native IsRecording and event counts; receiving no events is reported as zero, not fabricated capture. Track Rec and PlaybackAndRecord settings determine what the console records.",
    inputSchema: { timecode: z.number(), action: z.enum(["capture", "start", "stop"]), duration_seconds: z.number().optional(), preview: z.boolean().optional() },
  }, async (args) => operation(() => recordTimecode(ctx, args)));
};
