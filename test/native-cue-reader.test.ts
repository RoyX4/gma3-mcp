import { test } from "node:test";
import assert from "node:assert/strict";
import { readNativeCueContent, requireNativeCuePaging } from "../src/native-cue-reader.ts";
import { nativeContentFingerprint } from "../src/native-cues.ts";
import { startHarness } from "./helpers/tool-harness.ts";

const cue = (i: number) => ({ addr: `S1.C${i}`, no: i * 1000, fields: {}, parts: [{ addr: `S1.C${i}.P0`, no: 0, fields: {}, contentJson: '{"rows":[],"byFixtures":true}', rawChannelsJson: '{"entries":[]}' }] });
const data = (n = 503) => ({ ref: "Sequence 1", source: "GetPresetData(CuePart,false,true)", complete: true, sequence: { addr: "S1", fields: { Tracking: "Yes" } }, cues: Array.from({ length: n }, (_, i) => cue(i)), limitations: [] });
function page(all: ReturnType<typeof data>, offset: number, limit = 200) {
  const rows = all.cues.slice(offset, offset + limit);
  return { ...all, protocol: "gma3-cue-snapshot-v1", cues: rows, snapshotId: "snapshot:1", contextKey: "context:1", environment: "Normal", frozen: true, atomic: false,
    capturedAt: 10, expiresAt: 70, total: all.cues.length, capturedCount: all.cues.length, offset, count: rows.length,
    ...(offset === 0 ? { cueOrder: all.cues.map(c => c.addr) } : {}), nextCursor: offset + rows.length < all.cues.length ? `snapshot:1/${offset + rows.length}` : null };
}

test("assembles more than500 frozen cues without volatile paging metadata in the fingerprint", async t => {
  const h = await startHarness(() => {}); t.after(() => h.close());
  const all = data();
  h.fake.on("cue.content", a => a.action === "release" ? { released: true } : page(all, a.action === "create" ? 0 : Number(String(a.cursor).split("/").at(-1))));
  const result = await readNativeCueContent(h.bridge, "Sequence 1", 400);
  assert.deepEqual(result, all);
  assert.equal(nativeContentFingerprint(result), nativeContentFingerprint(all));
  assert.equal(h.fake.requests.filter(r => r.args.action === "page").length, 2);
  assert.equal(h.fake.requests.at(-1)?.args.action, "release");
  assert.equal(h.fake.commands.length, 0);
});

test("legacy complete single reads remain compatible while incomplete data never becomes complete", async t => {
  const h = await startHarness(() => {}); t.after(() => h.close());
  const all = data(2); h.fake.on("cue.content", () => all);
  assert.deepEqual(await readNativeCueContent(h.bridge, "Sequence 1", 400), all);
  all.complete = false;
  assert.equal((await readNativeCueContent(h.bridge, "Sequence 1", 400)).complete, false);
  h.fake.on("cue.content", () => data(501));
  await assert.rejects(() => readNativeCueContent(h.bridge, "Sequence 1", 400), /legacy.*500/i);
});

test("changed snapshot, context, sequence metadata, missing pages or reordered members refuse", async t => {
  const h = await startHarness(() => {}); t.after(() => h.close()); const all = data();
  const variants = [
    (p: any) => { p.snapshotId = "another"; }, (p: any) => { p.contextKey = "changed"; },
    (p: any) => { p.sequence.fields.Tracking = "No"; }, (p: any) => { p.offset++; },
    (p: any) => { p.cues.pop(); p.count--; }, (p: any) => { p.nextCursor = "snapshot:1/400"; },
    (p: any) => { [p.cues[0], p.cues[1]] = [p.cues[1], p.cues[0]]; },
    (p: any) => { p.cues[0] = p.cues[1]; }, (p: any) => { p.total--; }, (p: any) => { p.complete = false; },
  ];
  for (const mutate of variants) {
    let released = false;
    h.fake.on("cue.content", a => {
      if (a.action === "release") { released = true; return { released: true }; }
      const p = structuredClone(page(all, a.action === "create" ? 0 : Number(String(a.cursor).split("/").at(-1))));
      if (a.action === "page") mutate(p);
      return p;
    });
    await assert.rejects(() => readNativeCueContent(h.bridge, "Sequence 1", 400), /snapshot|page|order|metadata|coverage|count/i);
    assert.equal(released, true);
  }
});

test("false source coverage stays false in a valid frozen snapshot", async t => {
  const h = await startHarness(() => {}); t.after(() => h.close()); const all = data(); all.complete = false;
  h.fake.on("cue.content", a => a.action === "release" ? { released: true } : page(all, a.action === "create" ? 0 : Number(String(a.cursor).split("/").at(-1))));
  assert.equal((await readNativeCueContent(h.bridge, "Sequence 1", 400)).complete, false);
});

test("short byte-bounded pages still cover the entire frozen order", async t => {
  const h = await startHarness(() => {}); t.after(() => h.close()); const all = data();
  h.fake.on("cue.content", a => a.action === "release" ? { released: true } : page(all, a.action === "create" ? 0 : Number(String(a.cursor).split("/").at(-1)), 73));
  assert.deepEqual(await readNativeCueContent(h.bridge, "Sequence 1", 400), all);
});

test("a frozen page must belong to the caller's expected identity and environment", async t => {
  const h = await startHarness(() => {}); t.after(() => h.close());
  h.fake.on("cue.content", a => a.action === "release" ? { released: true } : page(data(2), 0));
  for (const context of [{ contextKey: "context:2", environment: "Normal" }, { contextKey: "context:1", environment: "Preview" }]) {
    await assert.rejects(() => readNativeCueContent(h.bridge, "Sequence 1", 400, { context }), /expected.*context/i);
    assert.equal(h.fake.requests.at(-1)?.args.action, "release");
  }
});

test("expired snapshots and failed release are surfaced without retry", async t => {
  const h = await startHarness(() => {}); t.after(() => h.close());
  h.fake.on("cue.content", a => {
    if (a.action === "create") return page(data(), 0);
    throw new Error(a.action === "release" ? "release unavailable" : "snapshot expired");
  });
  await assert.rejects(() => readNativeCueContent(h.bridge, "Sequence 1", 400), /snapshot expired.*release unavailable/);
  assert.deepEqual(h.fake.requests.map(r => r.args.action), ["create", "page", "release"]);
});

test("paging limits, malformed membership and bad cursor refuse", async t => {
  const h = await startHarness(() => {}); t.after(() => h.close());
  for (const mutate of [(p: any) => { p.total = 10003; p.capturedCount = 10003; }, (p: any) => { p.cueOrder[1] = p.cueOrder[0]; }, (p: any) => { p.cueOrder.pop(); }, (p: any) => { p.nextCursor = "foreign/200"; }]) {
    h.fake.on("cue.content", a => {
      if (a.action === "release") return { released: true };
      const p = page(data(), 0); mutate(p); return p;
    });
    await assert.rejects(() => readNativeCueContent(h.bridge, "Sequence 1", 400));
  }
});

test("large plans require explicit maintained paging capability before programming", async t => {
  const h = await startHarness(() => {}); t.after(() => h.close());
  for (const reply of [{}, { protocol: "old" }, { protocol: "gma3-cue-snapshot-v1", maxCueObjects: 500 }]) {
    h.fake.on("cue.content", () => reply);
    await assert.rejects(() => requireNativeCuePaging(h.bridge, 503, 400), /paging|snapshot/i);
  }
  h.fake.on("cue.content", () => ({ protocol: "gma3-cue-snapshot-v1", frozen: true, maxCueObjects: 10002, maxPageCues: 200 }));
  await requireNativeCuePaging(h.bridge, 10002, 400);
  assert(h.fake.requests.every(r => r.op === "cue.content" && r.args.action === "capabilities"));
  assert.equal(h.fake.commands.length, 0);
});
