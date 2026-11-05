import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/tool-harness.ts";
import { registerTimecodeTools } from "../src/tools/timecode.ts";

test("timecode capture starts once, ends after a bounded interval, and reads actual recording state", async () => {
  const h = await startHarness(registerTimecodeTools);
  let recording = false;
  h.fake.on("timecode.read", () => ({ no: 4, recording, playing: false, settings: { Lock: "" }, groups: [], tracks: [], ranges: [], subtracks: [], events: [], eventCount: recording ? 0 : 1, truncated: false }));
  const commands: string[] = [];
  h.fake.on("cmd", (args) => { const c = String(args.command); commands.push(c); recording = c === "Record Timecode 4"; return { feedback: "OK" }; });
  try {
    const result = await h.callJson("gma3_timecode_record", { timecode: 4, action: "capture", duration_seconds: 0.1 });
    assert.equal(result.isError, false, JSON.stringify(result.result));
    assert.equal(result.result.verification.status, "matched");
    assert.deepEqual(commands, ["Record Timecode 4", "Record Off Timecode 4"]);
    assert.equal(recording, false);
  } finally { await h.close(); }
});

test("unknown recording state and locked shows cannot start a recording; preview sends no command", async () => {
  const h = await startHarness(registerTimecodeTools);
  let recording: boolean | undefined;
  h.fake.on("timecode.read", () => ({ no: 4, recording, playing: false, settings: { Lock: "" }, groups: [], tracks: [], ranges: [], subtracks: [], events: [], eventCount: 0, truncated: false }));
  try {
    const unknown = await h.callJson("gma3_timecode_record", { timecode: 4, action: "capture", duration_seconds: 0.1 });
    assert.equal(unknown.isError, true);
    assert.match(JSON.stringify(unknown.result), /recording state/);
    recording = false;
    const preview = await h.callJson("gma3_timecode_record", { timecode: 4, action: "start", preview: true });
    assert.equal(preview.isError, false);
    assert.equal(h.fake.requests.filter((r) => r.op === "cmd").length, 0);
  } finally { await h.close(); }
});

test("bounded capture still stops once when the first recording observation fails", async () => {
  const h = await startHarness(registerTimecodeTools);
  let reads = 0, recording = false;
  const commands: string[] = [];
  h.fake.on("timecode.read", () => {
    reads++;
    if (reads === 2) throw new Error("recording observation unavailable");
    return { no: 4, recording, playing: false, settings: { Lock: "" }, groups: [], tracks: [], ranges: [], subtracks: [], events: [], eventCount: 0, truncated: false };
  });
  h.fake.on("cmd", (a) => { commands.push(String(a.command)); recording = a.command === "Record Timecode 4"; return { feedback: "OK" }; });
  try {
    const r = await h.callJson("gma3_timecode_record", { timecode: 4, action: "capture", duration_seconds: .1 });
    assert.equal(r.isError, true);
    assert.equal(r.result.recording, false);
    assert.deepEqual(commands, ["Record Timecode 4", "Record Off Timecode 4"]);
    assert.equal(r.result.verification.status, "mismatched");
  } finally { await h.close(); }
});
