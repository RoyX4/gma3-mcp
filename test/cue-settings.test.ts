import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCueSettingsTools } from "../src/tools/cue-settings.ts";
import { startHarness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

async function fixture(options: { locked?: unknown; ignore?: string; coupled?: boolean } = {}) {
  const h = await startHarness(registerCueSettingsTools);
  const seq: Record<string, unknown> = { Lock: options.locked ?? "", Tracking: "Yes", ReleaseFirstCue: "Yes", CueCommand: "Enabled", SequMIB: "Enabled" };
  const cue: Record<string, unknown> = { Lock: "", No: "3", Release: "", Assert: "", AllowDuplicates: "", MIBPreference: "Normal", Note: "" };
  const part: Record<string, unknown> = { Lock: "", Part: "0", Name: "old", TrackingDistance: "", Command: "", CommandEnabled: null, CommandDelay: "0.00", Transition: "Linear", MibMode: null, MibTarget: null, MibFade: null, MibDelay: null, MibMultistep: null };
  const row = (ref: unknown) => String(ref).includes(" Part ") ? part : String(ref).includes(" Cue ") ? cue : seq;
  h.fake.on("objects", a => ({ total: 1, count: 1, offset: 0, items: [{ fields: Object.fromEntries((a.fields as string[]).map(k => [k, row(a.ref)[k]])) }] }));
  h.fake.on("set", a => {
    if (a.property !== options.ignore) row(a.ref)[String(a.property)] = a.value;
    if (options.coupled && a.property === "Command") part.CommandEnabled = "Yes";
    return { value: row(a.ref)[String(a.property)], readOk: true };
  });
  return { ...h, seq, cue, part };
}

test("settings inspection keeps explicit Release separate from sequence first-cue policy", async t => {
  const h = await fixture(); t.after(() => h.close());
  const r = await h.callJson("gma3_cue_settings", { sequence: 9020, cue: 3 });
  assert.equal(r.isError, false); assert.equal(r.result.cueSettings.Release, "");
  assert.equal(r.result.sequenceSettings.ReleaseFirstCue, "Yes");
  assert.equal(r.result.partSettings.MibMode, null);
  assert.equal(h.fake.requests.some(r => r.op === "set"), false);
});
test("one metadata edit writes correct Cue/Part owners without Store or playback", async t => {
  const h = await fixture(); t.after(() => h.close());
  const r = await h.callJson("gma3_configure_cue", { sequence: 9020, cue: 3, part: 2,
    cue_settings: { release: "yes", assert: "x_assert", allow_duplicates: true, mib_preference: "good" },
    part_settings: { name: "Act two", tracking_distance: 4.5, command: "Echo Hi", command_enabled: false, command_delay: 1.5, transition: "s_curve" } });
  assert.equal(r.isError, false, r.text); assert.equal(r.result.verification.status, "matched");
  assert.equal(h.cue.Release, "Yes"); assert.equal(h.cue.Assert, "X-Assert");
  assert.equal(h.part.Name, "Act two"); assert.equal(h.part.TrackingDistance, "4.5");
  assert.equal(h.part.CommandEnabled, "No");
  const writes = h.fake.requests.filter(r => r.op === "set");
  assert(writes.filter(r => ["Release", "Assert", "AllowDuplicates", "MIBPreference"].includes(String(r.args.property))).every(r => r.args.ref === "Sequence 9020 Cue 3"));
  assert(writes.filter(r => r.args.property === "Command").every(r => r.args.ref === "Sequence 9020 Cue 3 Part 2"));
  assert.equal(h.fake.commands.length, 0);
});
test("preview reads but never sets, and locked or unknown-lock sequence refuses", async t => {
  const h = await fixture(); t.after(() => h.close());
  const r = await h.callJson("gma3_configure_cue", { sequence: 1, cue: 3, cue_settings: { assert: "assert" }, preview: true });
  assert.equal(r.result.preview, true); assert.equal(h.fake.requests.some(r => r.op === "set"), false);
  for (const lock of ["UL", null]) {
    h.seq.Lock = lock;
    const refused = await h.callJson("gma3_configure_cue", { sequence: 1, cue: 3, cue_settings: { release: "yes" } });
    assert.equal(refused.isError, true); assert.equal(h.fake.requests.some(r => r.op === "set"), false);
  }
});
test("final comparison checks all requested fields after coupled setters", async t => {
  const h = await fixture({ coupled: true }); t.after(() => h.close());
  h.part.CommandEnabled = "No";
  const r = await h.callJson("gma3_configure_cue", { sequence: 1, cue: 3, part_settings: { command_enabled: false, command: "Echo changed" } });
  assert.equal(r.isError, true); assert.equal(r.result.verification.status, "mismatched");
});
test("ignored setter stops later properties and reports failed verification", async t => {
  const h = await fixture({ ignore: "Release" }); t.after(() => h.close());
  const r = await h.callJson("gma3_configure_cue", { sequence: 1, cue: 3, cue_settings: { release: "yes", assert: "assert" } });
  assert.equal(r.isError, true); assert.equal(h.cue.Assert, "");
  assert.equal(h.fake.requests.filter(r => r.op === "set").length, 1);
});
test("clear choices do not send invented Release No or duration edits", async t => {
  const h = await fixture(); t.after(() => h.close()); h.cue.Release = "Yes"; h.part.TrackingDistance = "4";
  const r = await h.callJson("gma3_configure_cue", { sequence: 1, cue: 3, cue_settings: { release: "default", assert: "none" }, part_settings: { tracking_distance: "none" } });
  assert.equal(r.isError, false, r.text); assert.equal(h.cue.Release, ""); assert.equal(h.part.TrackingDistance, "");
  const count = h.fake.requests.length;
  for (const bad of [{ part_settings: { duration: 1 } }, { cue_settings: { release: false } }, { part_settings: { tracking_distance: "Delta 3" } }, {}]) {
    assert.equal((await h.callJson("gma3_configure_cue", { sequence: 1, cue: 3, ...bad })).isError, true);
    assert.equal(h.fake.requests.length, count);
  }
});
test("native Yes-only AllowDuplicates clears with empty text, never No", async t => {
  const h = await fixture(); t.after(() => h.close()); h.cue.AllowDuplicates = "Yes";
  h.fake.on("set", a => {
    if (a.property === "AllowDuplicates" && a.value === "") h.cue.AllowDuplicates = "";
    return { readOk: true, value: h.cue.AllowDuplicates };
  });
  const r = await h.callJson("gma3_configure_cue", { sequence: 1, cue: 3, cue_settings: { allow_duplicates: false } });
  assert.equal(r.isError, false, r.text); assert.equal(h.cue.AllowDuplicates, "");
});
test("cue and part own locks or unreadable locks prevent any setters", async t => {
  const h = await fixture(); t.after(() => h.close());
  for (const owner of [h.cue, h.part]) {
    for (const value of ["UL", null]) {
      owner.Lock = value;
      const r = await h.callJson("gma3_configure_cue", { sequence: 1, cue: 3, cue_settings: { assert: "assert" } });
      assert.equal(r.isError, true); assert.equal(h.fake.requests.some(r => r.op === "set"), false);
    }
    owner.Lock = "";
  }
});
test("a dispatched timeout is not retried and blocks remaining writes", async t => {
  const h = await fixture(); t.after(() => h.close());
  h.fake.on("set", () => SILENT);
  const r = await h.callJson("gma3_configure_cue", { sequence: 1, cue: 3, cue_settings: { release: "yes", assert: "assert" } });
  assert.equal(r.isError, true); assert.equal(r.result.outcome, "unknown");
  assert.equal(h.fake.requests.filter(r => r.op === "set").length, 1);
});
test("case-only Name Note and Command edits are written and compared exactly", async t => {
  const h = await fixture(); t.after(() => h.close());
  h.part.Name = "opening"; h.part.Command = 'Echo "Warm"'; h.cue.Note = "Act One";
  const r = await h.callJson("gma3_configure_cue", { sequence: 1, cue: 3,
    cue_settings: { note: "ACT ONE" }, part_settings: { name: "Opening", command: 'Echo "warm"' } });
  assert.equal(r.isError, false, r.text);
  assert.equal(h.part.Name, "Opening"); assert.equal(h.cue.Note, "ACT ONE"); assert.equal(h.part.Command, 'Echo "warm"');
  assert.equal(h.fake.requests.filter(r => r.op === "set").length, 3);
});
test("acknowledged Set with unreadable reply stays unknown when final observation fails", async t => {
  const h = await fixture(); t.after(() => h.close());
  h.fake.on("set", a => {
    h.cue[String(a.property)] = a.value;
    h.fake.on("objects", () => { throw new Error("read unavailable"); });
    return { readOk: false, readError: "native getter failed" };
  });
  const r = await h.callJson("gma3_configure_cue", { sequence: 1, cue: 3, cue_settings: { release: "yes", assert: "assert" } });
  assert.equal(r.isError, true); assert.equal(r.result.outcome, "unknown");
  assert.equal(r.result.verification.status, "unavailable"); assert.equal(h.cue.Release, "Yes");
  assert.equal(h.fake.requests.filter(r => r.op === "set").length, 1);
});
test("inapplicable coupled command/MIB requests refuse before any console work", async t => {
  const h = await fixture(); t.after(() => h.close());
  for (const part_settings of [{ command: "", command_enabled: false }, { mib_mode: "none", mib_fade: "default" }, { mib_mode: "none", mib_multistep: "paused" }, { mib_mode: "defined" }, { mib_target: 2 }]) {
    assert.equal((await h.callJson("gma3_configure_cue", { sequence: 1, cue: 3, part_settings })).isError, true);
    assert.equal(h.fake.requests.length, 0);
  }
});

test("relative Tracking Distance uses the native delta token and checks its mode on readback", async t => {
  const h = await fixture(); t.after(() => h.close());
  h.fake.on("fast.context", () => ({ contextKey: "same", environment: "Normal", identityUncertain: [] }));
  h.fake.on("set", args => {
    assert.equal(args.ref, "Sequence 1 Cue 3 Part 2");
    assert.equal(args.property, "TrackingDistance"); assert.equal(args.value, "Δ+2.5");
    h.part.TrackingDistance = "Δ +2.5";
    return { value: "Δ +2.5", readOk: true };
  });
  const args = { sequence: 1, cue: 3, part: 2, part_settings: { tracking_distance: { delta: 2.5 } } };
  const accepted = await h.callJson("gma3_configure_cue", args);
  assert.equal(accepted.isError, false, accepted.text); assert.equal(accepted.result.verification.status, "matched");
  h.part.TrackingDistance = "";
  h.fake.on("set", () => { h.part.TrackingDistance = "2.5"; return { value: "2.5", readOk: true }; });
  const absolute = await h.callJson("gma3_configure_cue", args);
  assert.equal(absolute.isError, true); assert.equal(absolute.result.verification.status, "mismatched");
});

async function breakFixture() {
  const h = await fixture();
  const targets = { World: { class: "World", addr: "14.1.1", name: "All" }, Filter: { class: "Filter", addr: "14.2.1", name: "All" } };
  let assigned: (typeof targets)[keyof typeof targets] | null = null;
  let dynamic = "No";
  const before = h.fake.handlerFor("objects")!;
  h.fake.on("fast.context", () => ({ contextKey: "same", environment: "Normal", identityUncertain: [] }));
  h.fake.on("objects", (a, req) => {
    if (a.ref === "World 1" || a.ref === "Filter 1") {
      const kind = String(a.ref).split(" ")[0] as keyof typeof targets;
      return { total: 1, count: 1, items: [{ ...targets[kind], fields: { HasDynamicFilterRules: dynamic } }] };
    }
    if (a.asText === false && String(a.ref).includes(" Cue ") && (a.fields as string[]).includes("Break")) {
      return { total: 1, count: 1, items: [{ fields: assigned ? { Break: assigned } : {} }] };
    }
    return before(a, req);
  });
  h.cue.Break = "#FFFFFFFFFFFFFFFF";
  h.fake.onCommand(command => {
    if (command.startsWith("Assign World")) assigned = targets.World;
    else if (command.startsWith("Assign Filter")) assigned = targets.Filter;
    else if (command === 'Set Sequence 1 Cue 3 Property "Break" ""') assigned = null;
    else return "Illegal command";
    h.cue.Break = assigned?.name ?? "#FFFFFFFFFFFFFFFF";
    return "OK";
  });
  return { ...h, setDynamic: (value: string) => { dynamic = value; }, getAssigned: () => assigned };
}

test("Break uses the exact World/static Filter handle and can clear the native assignment", async t => {
  const h = await breakFixture(); t.after(() => h.close());
  for (const target of [{ kind: "world", number: 1 }, { kind: "filter", number: 1 }, null]) {
    const r = await h.callJson("gma3_configure_cue", { sequence: 1, cue: 3, cue_settings: { break: target } });
    assert.equal(r.isError, false, r.text);
    assert.equal(h.getAssigned()?.class.toLowerCase() ?? null, target?.kind ?? null);
  }
  assert.deepEqual(h.fake.commands, ["Assign World 1 At Sequence 1 Cue 3", "Assign Filter 1 At Sequence 1 Cue 3", 'Set Sequence 1 Cue 3 Property "Break" ""']);
});

test("dynamic and unreadable Filter policies refuse all requested setters", async t => {
  const h = await breakFixture(); t.after(() => h.close());
  for (const policy of ["Yes", ""]) {
    h.setDynamic(policy);
    const r = await h.callJson("gma3_configure_cue", { sequence: 1, cue: 3, cue_settings: { release: "yes", break: { kind: "filter", number: 1 } } });
    assert.equal(r.isError, true); assert.equal(h.cue.Release, "");
    assert(!h.fake.requests.some(request => ["cmd", "set"].includes(request.op)));
  }
});

test("an ignored Break with the same displayed name fails the exact handle check", async t => {
  const h = await breakFixture(); t.after(() => h.close());
  const args = { sequence: 1, cue: 3 };
  assert.equal((await h.callJson("gma3_configure_cue", { ...args, cue_settings: { break: { kind: "world", number: 1 } } })).isError, false);
  h.fake.onCommand(() => "OK");
  const r = await h.callJson("gma3_configure_cue", { ...args, cue_settings: { break: { kind: "filter", number: 1 }, release: "yes" } });
  assert.equal(r.isError, true); assert.equal(r.result.verification.status, "mismatched");
  assert.equal(h.cue.Release, "");
});
