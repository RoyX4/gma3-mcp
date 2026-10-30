import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/tool-harness.ts";
import { BridgeReplyError } from "./helpers/fake-bridge.ts";
import { registerTimecodeTools } from "../src/tools/timecode.ts";

async function setup(corrupt = false) {
  const h = await startHarness(registerTimecodeTools);
  let show: any = null;
  h.fake.on("patch.state",()=>({atRoot:true,copyOpen:false,modal:false}));
  h.fake.on("timecode.read", () => { if (!show) throw new BridgeReplyError("[not-found] no timecode"); return structuredClone(show); });
  h.fake.on("objects", () => ({ total: 1, items: [{ class: "Sequence", index: 8, addr: "14.14.1.7.8", fields: { No: 8 } }] }));
  h.fake.on("timecode.create", () => {
    assert.equal(show, null, "native create must never overwrite");
    show = { no: 9015, addr: "14.14.1.15.9015", recording: false, playing: false, settings: {}, groups: [], tracks: [], ranges: [], subtracks: [], events: [], eventCount: 0, truncated: false };
    return { created: true, addr: show.addr };
  });
  h.fake.on("timecode.edit", (a) => {
    assert.equal(a.expectedTimecodeAddr, show.addr);
    if (a.action === "add_group") { show.groups = [{ group: 1 }]; show.tracks = [{ group: 1, track: 1 }]; show.ranges = [{ group: 1, track: 1, range: 1 }]; return { groups: 1 }; }
    if (a.action === "set_target") { show.tracks[0].target = { class: "Sequence", no: 8, addr: "14.14.1.7.8" }; return { target: show.tracks[0].target }; }
    assert.equal(a.action, "add_fader_events");
    assert.equal(a.expectedTargetAddr, "14.14.1.7.8");
    show.subtracks = [{ group: 1, track: 1, range: 1, subtrack: 1, class: "FaderSubTrack", faderToken: "Master" }];
    show.events = (a.events as any[]).map((e, i) => ({ group: 1, track: 1, range: 1, subtrack: 1, index: i + 1, class: "FaderEvent", raw: e.raw, token: "FaderMaster", faderValue: e.value + (corrupt && i === 3 ? -1 : 0), fadeOverrideSeconds: e.fadeSeconds }));
    show.eventCount = show.events.length;
    return { added: show.events };
  });
  return h;
}
const args = { timecode: 9015, sequence: 8, events: [{ at: 0, value: 0 }, { at: 1, value: 25, fade_seconds: .5 }, { at: 2, value: 50 }, { at: 3, value: 100 }] };

test("direct fader authoring previews without Store, Record, playback or any native mutation", async () => {
  const h = await setup();
  try {
    const r = await h.callJson("gma3_build_fader_timecode", args);
    assert.equal(r.isError, false, JSON.stringify(r.result));
    assert.equal(r.result.preview, true);
    assert.deepEqual(r.result.events.map((e: any) => e.value), [0,25,50,100]);
    assert.equal(h.fake.requests.filter(r => r.op === "timecode.create" || r.op === "timecode.edit" || r.op === "cmd").length, 0);
  } finally { await h.close(); }
});

test("direct fader events use exact raw times, numeric levels and fades, and refuse existing shows", async () => {
  const h = await setup();
  try {
    const r = await h.callJson("gma3_build_fader_timecode", { ...args, preview: false });
    assert.equal(r.isError, false, JSON.stringify(r.result));
    assert.equal(r.result.verification.status, "matched");
    assert.deepEqual(r.result.events.map((e: any) => e.value), [0,25,50,100]);
    const append = h.fake.requests.find(r => r.op === "timecode.edit" && r.args.action === "add_fader_events")!;
    assert.equal((append.args.events as any[])[1].raw, 16777216);
    assert.equal((append.args.events as any[])[1].fadeSeconds, .5);
    const again = await h.callJson("gma3_build_fader_timecode", { ...args, preview: false });
    assert.equal(again.isError, true);
    assert.equal(h.fake.requests.filter(r => r.op === "timecode.create").length, 1);
    assert.equal(h.fake.requests.filter(r => r.op === "cmd" || r.op === "setfader").length, 0);
  } finally { await h.close(); }
});

test("a native curve that silently changed 100 to99 fails exact stored event verification", async () => {
  const h = await setup(true);
  try {
    const r = await h.callJson("gma3_build_fader_timecode", { ...args, preview: false });
    assert.equal(r.isError, true);
    assert.equal(r.result.verification.status, "mismatched");
    assert.match(r.result.verification.detail, /value/);
    assert.equal(h.fake.requests.filter(r => r.op === "timecode.edit" && r.args.action === "add_fader_events").length, 1);
  } finally { await h.close(); }
});
