/** Fast, create-only native FaderSubTrack/FaderEvent authoring. No recording, playback or live fader commands. */
import { z } from "zod";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { asRead, buildResult, notRequested, requestStep, stepFromError, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";
import { Validator, ValidationError, finiteNumber } from "../validate.js";
import { MAX_SECONDS, parseTime, fromRaw, fpsOf, readTimecode, type Fps, type TimecodeRead } from "./timecode.js";

interface CurveEvent { raw: number; seconds: number; value: number; fadeSeconds: number; order: number }
interface Args { timecode: number; sequence: number; events: Array<{ at: unknown; value: number; fade_seconds?: number }>; fps?: number; preview?: boolean }
export function parseFaderEvents(raw: unknown, fps?: Fps): CurveEvent[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 512) throw new ValidationError("events must contain 1-512 fader events", "events");
  return raw.map((e, order) => {
    if (!e || typeof e !== "object" || Object.keys(e).some(k => !["at", "value", "fade_seconds"].includes(k))) throw new ValidationError(`events[${order}] must be {at,value,fade_seconds?}`, "events");
    const time = parseTime(`events[${order}].at`, e.at, fps);
    const value = finiteNumber(`events[${order}].value`, e.value, { integer: true, min: 0, max: 100 })!;
    const fadeSeconds = finiteNumber(`events[${order}].fade_seconds`, e.fade_seconds ?? 0, { min: 0, max: MAX_SECONDS })!;
    if (time.seconds + fadeSeconds > MAX_SECONDS) throw new ValidationError(`events[${order}] fade ends beyond the timecode duration bound`, "events");
    return { ...time, seconds: fromRaw(time.raw), value, fadeSeconds, order };
  }).sort((a,b) => a.raw - b.raw || a.order - b.order);
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve,ms));

export async function buildFaderTimecode(ctx: ToolContext, raw: Args): Promise<OperationResult> {
  const op = "build_fader_timecode", v = new Validator();
  const no = v.check(() => finiteNumber("timecode", raw.timecode, { integer: true, min: 1, max: 99999 }));
  const seq = v.check(() => finiteNumber("sequence", raw.sequence, { integer: true, min: 1, max: 99999 }));
  const fps = v.check(() => fpsOf("fps", raw.fps));
  const events = v.check(() => parseFaderEvents(raw.events, fps));
  const target = { timecode: raw.timecode, sequence: raw.sequence }, preview = raw.preview !== false;
  if (!v.ok || no === undefined || seq === undefined || !events) return validationFailure(op,target,v.errors);
  const tm = ctx.requestTimeoutMs, bridge = ctx.bridge;
  const body = async (): Promise<OperationResult> => {
    const steps: StepResult[] = [];
    let sequenceAddr: string;
    try {
      const state = await bridge.request("patch.state",{},tm) as {atRoot?:boolean;copyOpen?:boolean;modal?:unknown};
      if (state.atRoot !== true || state.copyOpen !== false || state.modal !== false) throw new Error("the command line must be at Root with a closed patch copy and no modal");
      if (await readTimecode(bridge,no,tm,{eventFields:false})) throw new Error(`Timecode ${no} exists; this tool creates only and never overwrites or appends`);
      const r = await bridge.request("objects",{ref:`Sequence ${seq}`,fields:["No"],asText:false,limit:2},tm) as { total?: number; items?: Array<{class?:string;addr?:string;index?:number;fields?:Record<string,unknown>}> };
      const item = r.items?.[0];
      if (r.total !== 1 || item?.class !== "Sequence" || Number(item.fields?.No ?? item.index) !== seq || typeof item.addr !== "string") throw new Error("the exact sequence target could not be established");
      sequenceAddr = item.addr;
      steps.push(asRead({name:"preflight",status:"succeeded",detail:{absentTimecode:no,sequenceAddr}}));
    } catch (error) { return buildResult({operation:op,target,steps:[asRead(stepFromError("preflight",error))],extra:{preview}}); }
    if (preview) return buildResult({operation:op,target,steps,verification:notRequested(),summary:"Preview only; no timecode, playback or fader changed.",extra:{preview,createOnly:true,events,sequenceAddr}});
    let createdAddr: string | null = null, after: TimecodeRead | null = null;
    const request = async (name:string,action:string,args:Record<string,unknown>) => {
      const step = await requestStep(bridge,name,action,args,undefined,tm); steps.push(step);
      if (step.status !== "succeeded") throw new Error(`${name} was not confirmed; nothing was retried`);
      return step.detail as any;
    };
    const wait = async (check:(r:TimecodeRead)=>boolean) => {
      const end = Date.now()+3000;
      do {
        const r = await readTimecode(bridge,no,tm,{eventFields:false});
        if (r?.addr !== createdAddr) throw new Error("timecode identity changed after creation; no further write sent");
        if (r && check(r)) return r;
        await sleep(25);
      } while (Date.now()<end);
      throw new Error("native timecode structure did not settle; no structural action was retried");
    };
    try {
      const created = await request("create_timecode","timecode.create",{timecode:no,sequence:seq,expectedTargetAddr:sequenceAddr});
      if (created?.created !== true || typeof created.addr !== "string") throw new Error("native create did not establish ownership of the new timecode");
      createdAddr = created.addr;
      await wait(r => r.groups.length === 0 && r.eventCount === 0);
      await request("create_group","timecode.edit",{timecode:no,action:"add_group",expectedTimecodeAddr:createdAddr});
      await wait(r => r.groups.length === 1 && r.tracks.length === 1 && r.ranges.length === 1);
      await request("assign_target","timecode.edit",{timecode:no,action:"set_target",group:1,track:1,target:`Sequence ${seq}`,expectedTimecodeAddr:createdAddr,expectedTargetAddr:sequenceAddr});
      await wait(r => r.tracks[0]?.target?.addr === sequenceAddr);
      await request("append_fader_events","timecode.edit",{timecode:no,action:"add_fader_events",group:1,track:1,range:1,expectedTimecodeAddr:createdAddr,expectedTargetAddr:sequenceAddr,events:events.map(e=>({raw:e.raw,value:e.value,fadeSeconds:e.fadeSeconds}))});
    } catch (error) { steps.push(asRead(stepFromError("authoring_stopped",error))); }
    let verification: Verification;
    try {
      after = await readTimecode(bridge,no,tm,{eventFields:false});
      if (!after || after.addr !== createdAddr || after.truncated) throw new Error("the owned timecode could not be read completely");
      const problems: string[] = [];
      if (after.groups.length !== 1 || after.tracks.length !== 1 || after.ranges.length !== 1 || after.subtracks.length !== 1 || after.subtracks[0].class !== "FaderSubTrack" || after.subtracks[0].faderToken !== "Master") problems.push("unexpected track structure");
      if (after.tracks[0]?.target?.addr !== sequenceAddr) problems.push("target differs");
      if (after.playing !== false || after.recording !== false) problems.push("timecode is not confirmed idle");
      if (after.events.length !== events.length || after.eventCount !== events.length) problems.push("event count differs");
      for (const [i,want] of events.entries()) {
        const got = after.events[i];
        if (!got || got.class !== "FaderEvent" || got.token !== "FaderMaster") { problems.push(`event ${i+1} is not a Master fader event`); continue; }
        if (got.raw !== want.raw) problems.push(`event ${i+1} raw time differs`);
        if (got.faderValue !== want.value) problems.push(`event ${i+1} value differs (${got.faderValue}, expected ${want.value})`);
        if (typeof got.fadeOverrideSeconds !== "number" || Math.abs(got.fadeOverrideSeconds-want.fadeSeconds)>1e-8) problems.push(`event ${i+1} fade differs`);
      }
      verification = {status:problems.length ? "mismatched":"matched",checked:"the owned timecode's complete structure, exact target, raw event times, native percentage values and fade seconds; idle playback and recording",...(problems.length?{detail:problems.slice(0,20).join("; ")}:{})};
      steps.push(asRead({name:"read_back",status:"succeeded",op:"timecode.read"}));
    } catch (error) { verification={status:"unavailable",detail:String(error)};steps.push(asRead(stepFromError("read_back",error))); }
    return buildResult({operation:op,target,steps,verification,extra:{preview,createOnly:true,createdAddr,events,actualEvents:after?.events.map(e=>({...e,seconds:typeof e.raw==="number"?fromRaw(e.raw):null}))??null,played:false,recorded:false,liveFaderCommandSent:false},warnings:["Only integer Master-fader levels0-100 are accepted. FadeOverride starts a native fade when its event executes; event timestamps are fade start times, not implicit curve endpoint times. Stored data verification does not establish physical playback timing or output.",...(verification.status!=="matched"?["The created timecode remains for inspection; an uncertain or partial create is never replayed or overwritten."]:[])]});
  };
  return preview?body():ctx.mutations.run(body);
}

export const registerTimecodeCurveTool: RegisterTools = (server,ctx) => {
  server.registerTool("gma3_build_fader_timecode",{
    title:"Create a timecode show with exact native continuous fader events",
    description:"Preview by default. Creates one new timecode only (refuses an existing number), targets one exact Sequence and stores1-512 Master FaderEvents. Events {at,value,fade_seconds?}: value is integer percentage0-100; fade_seconds is a native fade starting when that event fires. All input is checked before creation; typed native numeric setters avoid display-unit conversion. Reads exact raw times, levels, fade durations and the whole new structure back. Never records, plays or changes a live fader; no uncertain action is retried. Requires the bridge's timecode.create/add_fader_events support.",
    inputSchema:{timecode:z.number(),sequence:z.number(),events:z.array(z.object({at:z.union([z.number(),z.string(),z.object({frames:z.number(),fps:z.number()})]),value:z.number(),fade_seconds:z.number().optional()}).strict()),fps:z.number().optional(),preview:z.boolean().optional()},
  },async args=>operation(()=>buildFaderTimecode(ctx,args)));
};
