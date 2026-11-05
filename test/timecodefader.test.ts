import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/tool-harness.ts";
import { registerTimecodeTools } from "../src/tools/timecode.ts";

async function setup(ignoreEvents = false) {
  const h = await startHarness(registerTimecodeTools);
  let recording = false, value = 0;
  const events: Array<Record<string, unknown>> = [];
  h.fake.on("timecode.read", () => ({ no: 4, recording, playing: false, settings: { Lock: "", TCSlot: "-1", Cursor: "0.00" }, groups: [], tracks: [], ranges: [], subtracks: [], events, eventCount: events.length, truncated: false }));
  h.fake.on("objects", () => ({ items: [{ class: "Sequence", index: 8 }], total: 1 }));
  h.fake.on("getfader", () => ({ faders: { FaderMaster: { value } } }));
  h.fake.on("cmd", (a) => {
    const c = String(a.command);
    if (c === "Record Timecode 4") recording = true;
    if (c === "Record Off Timecode 4") recording = false;
    if (c.startsWith("FaderMaster Sequence 8 At ")) {
      value = Number(c.split(" At ")[1].split(" ")[0]);
      if (recording && !ignoreEvents) events.push({ class: "FaderEvent", fields: { NativeValue: value }, fieldsComplete: true, group: 1, track: 1, range: 1, subtrack: 1, index: events.length + 1, raw: events.length * 16777216 / 10 });
    }
    return { feedback: "OK" };
  });
  return h;
}
const args = { timecode: 4, sequence: 8, points: [{ at: 0, value: 0 }, { at: .1, value: 80 }] };

test("fader-curve preview is the default and emits no Record or Fader command", async () => {
  const h = await setup();
  try {
    const r = await h.callJson("gma3_record_fader_curve", args);
    assert.equal(r.isError, false, JSON.stringify(r.result));
    assert.equal(r.result.preview, true);
    assert.match(r.result.plan.commands.join(), /FaderMaster Sequence 8 At 80 Fade 0.1/);
    assert.equal(h.fake.requests.filter((r) => r.op === "cmd").length, 0);
  } finally { await h.close(); }
});

test("fader curve uses native fades while recording, reads actual stored native events and stops once", async () => {
  const h = await setup();
  try {
    const r = await h.callJson("gma3_record_fader_curve", { ...args, preview: false, exclusive: true });
    assert.equal(r.isError, false, JSON.stringify(r.result));
    assert.equal(r.result.verification.status, "matched");
    assert.equal(r.result.curveVerification.status, "unavailable");
    assert.equal(r.result.nativeEventsAfter.length, 2);
    assert.equal(h.fake.requests.filter((r) => r.op === "cmd" && r.args.command === "Record Off Timecode 4").length, 1);
  } finally { await h.close(); }
});

test("a moved fader without stored native events is never reported as a recorded curve", async () => {
  const h = await setup(true);
  try {
    const r = await h.callJson("gma3_record_fader_curve", { ...args, preview: false, exclusive: true });
    assert.equal(r.isError, true);
    assert.equal(r.result.verification.status, "mismatched");
    assert.match(r.result.verification.detail, /no new native timecode events/);
  } finally { await h.close(); }
});

test("a silent native fade is never replayed and recording cleanup still stops once", async () => {
  const h = await startHarness(registerTimecodeTools, { requestTimeoutMs: 30 });
  const { SILENT } = await import("./helpers/fake-bridge.ts");
  let recording = false;
  const commands: string[] = [];
  h.fake.on("timecode.read", () => ({ no: 4, recording, playing: false, settings: { Lock: "", TCSlot: "-1" }, groups: [], tracks: [], ranges: [], subtracks: [], events: [], eventCount: 0, truncated: false }));
  h.fake.on("objects", () => ({ items: [{ class: "Sequence" }], total: 1 }));
  h.fake.on("getfader", () => ({ faders: { FaderMaster: { value: 0 } } }));
  h.fake.on("cmd", (a) => {
    const c = String(a.command); commands.push(c);
    if (c.startsWith("Record")) recording = c === "Record Timecode 4";
    if (c.startsWith("FaderMaster")) return SILENT;
    return { feedback: "OK" };
  });
  try {
    const r = await h.callJson("gma3_record_fader_curve", { ...args, preview: false, exclusive: true });
    assert.equal(r.isError, true);
    assert.equal(commands.filter(c => c.startsWith("FaderMaster")).length, 1);
    assert.equal(commands.filter(c => c === "Record Off Timecode 4").length, 1);
    assert.equal(recording, false);
  } finally { await h.close(); }
});
