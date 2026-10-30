import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { registerViewTools } from "../src/tools/views.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

interface View { name: string; mask: number; addr: string }
let h: Harness;
let views: Map<number, View>;
let buttons: Map<string, unknown>;
let ignoreStore = false;
let ignoreAssign = false;
let unreadable = new Set<string>();
const viewRow = (n: number, v: View) => ({ class: "View", index: n, addr: v.addr, name: v.name, fields: { Name: v.name, ScreenContentMask: v.mask, Lock: "" } });
const assigned = (n: number) => ({ class: "View", index: n, addr: views.get(n)!.addr, name: views.get(n)!.name });

before(async () => { h = await startHarness(registerViewTools, { requestTimeoutMs: 150 }); });
after(async () => { await h.close(); });
beforeEach(() => {
  h.fake.reset();
  views = new Map([[13, { name: "MVR Fixtures", mask: 1, addr: "14.19.1.4.13" }]]);
  buttons = new Map();
  ignoreStore = ignoreAssign = false;
  unreadable = new Set();
  h.fake.on("objects", (a) => {
    const ref = String(a.ref);
    if (unreadable.has(ref)) throw new Error("read failed");
    const m = ref.match(/^View (\d+)$/);
    const all = m ? (views.has(Number(m[1])) ? [[Number(m[1]), views.get(Number(m[1]))!] as const] : []) : ref === "View Thru" ? [...views] : null;
    if (all) {
      const offset = Number(a.offset ?? 0), limit = Number(a.limit ?? 100);
      return { total: all.length, offset, count: Math.max(0, Math.min(limit, all.length - offset)), items: all.slice(offset, offset + limit).map(([n, v]) => viewRow(n, v)) };
    }
    if (/^ViewButton \d+\.\d+$/.test(ref)) {
      const value = buttons.get(ref);
      return { total: value === undefined ? 0 : 1, offset: 0, items: value === undefined ? [] : [{ class: "ViewButton", fields: value === "missing-property" ? {} : { Object: value, Name: "button" } }] };
    }
    throw new Error(`unexpected reference: ${ref}`);
  });
  h.fake.on("cmd", (a) => {
    const c = String(a.command);
    let m: RegExpMatchArray | null;
    if ((m = c.match(/^Store View (\d+)(?: "([^"]+)")? \/Screen "([1-7](?:,[1-7])*)" \/NoConfirmation$/))) {
      if (!ignoreStore) views.set(Number(m[1]), { name: m[2] ?? `View ${m[1]}`, mask: m[3].split(",").reduce((v, n) => v | (1 << (Number(n) - 1)), 0), addr: `14.19.1.4.${m[1]}` });
      return { feedback: "OK" };
    }
    if ((m = c.match(/^Assign View (\d+) At (ViewButton \d+\.\d+)$/))) {
      if (!ignoreAssign) buttons.set(m[2], assigned(Number(m[1])));
      return { feedback: "OK" };
    }
    if (/^View \d+ \/Screen "[1-7]"$/.test(c)) return { feedback: "OK" };
    throw new Error(`unexpected command: ${c}`);
  });
});

test("registers four focused tools and lists views read-only with pagination", async () => {
  assert.deepEqual([...h.tools.keys()], ["gma3_views", "gma3_store_view", "gma3_recall_view", "gma3_assign_view_button"]);
  views.set(14, { name: "Stage", mask: 2, addr: "14.19.1.4.14" });
  const { result, isError } = await h.callJson("gma3_views", { offset: 1, limit: 1 });
  assert.equal(isError, false);
  assert.equal(result.total, 2);
  assert.equal(result.items[0].name, "Stage");
  assert.equal(result.scope, "current user profile");
  assert.deepEqual(h.fake.commands, []);
});

test("stores only a new view with explicit screens and verifies metadata", async () => {
  const { result, isError } = await h.callJson("gma3_store_view", { verify_contents: false, view: 9001, screens: [1, 3], name: "Hidden stage" });
  assert.equal(isError, false);
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "matched");
  assert.equal(views.get(9001)?.mask, 5);
  assert.equal(views.get(9001)?.name, "Hidden stage");
  assert.match(result.verification.checked, /metadata/i);
  assert.match(result.warnings.join(" "), /window.*not.*compared/i);
  assert.deepEqual(h.fake.commands, ['Store View 9001 "Hidden stage" /Screen "1,3" /NoConfirmation']);
});

test("refuses to overwrite an existing view", async () => {
  const { result, isError } = await h.callJson("gma3_store_view", { verify_contents: false, view: 13, screens: [1] });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.match(JSON.stringify(result), /already exists/i);
  assert.deepEqual(h.fake.commands, []);
  assert.equal(views.get(13)?.name, "MVR Fixtures");
});

test("refuses an unreadable store target before mutation", async () => {
  unreadable.add("View 9001");
  const { result, isError } = await h.callJson("gma3_store_view", { verify_contents: false, view: 9001, screens: [1] });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(h.fake.commands, []);
});

test("validates view numbers, names and nonempty unique screens before requests", async () => {
  for (const args of [{ view: 0, screens: [1] }, { view: 1.5, screens: [1] }, { view: 9001, screens: [] }, { view: 9001, screens: [1, 1] }, { view: 9001, screens: [8] }, { view: 9001, screens: [1], name: 'bad";Go' }]) {
    assert.equal((await h.call("gma3_store_view", args)).isError, true);
  }
  assert.deepEqual(h.fake.requests, []);
});

test("detects an accepted store command that did not create the view", async () => {
  ignoreStore = true;
  const { result, isError } = await h.callJson("gma3_store_view", { verify_contents: false, view: 9001, screens: [1] });
  assert.equal(isError, true);
  assert.equal(result.verification.status, "mismatched");
});

test("recall checks existence and reports accepted command without claiming layout verification", async () => {
  const { result, isError } = await h.callJson("gma3_recall_view", { verify_contents: false, view: 13, screen: 1 });
  assert.equal(isError, false);
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.verification.status, "unavailable");
  assert.match(result.verification.detail, /layout/i);
  assert.deepEqual(h.fake.commands, ['View 13 /Screen "1"']);
});

test("recall refuses a missing view and requires a destination screen", async () => {
  assert.equal((await h.call("gma3_recall_view", { view: 9001, screen: 1 })).isError, true);
  assert.equal((await h.call("gma3_recall_view", { view: 13 })).isError, true);
  assert.deepEqual(h.fake.commands, []);
});

test("recall warns that a multi-screen view keeps its stored screens", async () => {
  views.get(13)!.mask = 3;
  const { result } = await h.callJson("gma3_recall_view", { verify_contents: false, view: 13, screen: 3 });
  assert.match(result.warnings.join(" "), /multiple.*stored screens/i);
});

test("assigns a view to an empty button and verifies address identity", async () => {
  const { result, isError } = await h.callJson("gma3_assign_view_button", { view: 13, screen: 1, button: 8 });
  assert.equal(isError, false);
  assert.equal(result.verification.status, "matched");
  assert.equal((buttons.get("ViewButton 1.8") as any).addr, views.get(13)?.addr);
  assert.deepEqual(h.fake.commands, ["Assign View 13 At ViewButton 1.8"]);
});

test("does not overwrite an occupied button without replace even for duplicate names", async () => {
  buttons.set("ViewButton 1.8", { class: "View", name: "MVR Fixtures", index: 14, addr: "14.19.1.4.14" });
  const { result, isError } = await h.callJson("gma3_assign_view_button", { view: 13, screen: 1, button: 8 });
  assert.equal(isError, true);
  assert.match(JSON.stringify(result), /replace: true/i);
  assert.deepEqual(h.fake.commands, []);
});

test("explicit replacement reports previous assignment and reads the result back", async () => {
  buttons.set("ViewButton 1.8", { class: "Macro", index: 7, addr: "14.13.1.6.7", name: "Old action" });
  const { result, isError } = await h.callJson("gma3_assign_view_button", { view: 13, screen: 1, button: 8, replace: true });
  assert.equal(isError, false);
  assert.equal(result.previous.object.class, "Macro");
  assert.equal(result.verification.status, "matched");
  assert.deepEqual(h.fake.commands, ["Assign View 13 At ViewButton 1.8"]);
});

test("already assigned identity is a read-only no-op", async () => {
  buttons.set("ViewButton 1.8", assigned(13));
  const { result, isError } = await h.callJson("gma3_assign_view_button", { view: 13, screen: 1, button: 8 });
  assert.equal(isError, false);
  assert.equal(result.noop, true);
  assert.equal(result.verification.status, "matched");
  assert.deepEqual(h.fake.commands, []);
});

test("refuses an unreadable or missing assignment property even with replacement", async () => {
  buttons.set("ViewButton 1.8", "missing-property");
  let res = await h.callJson("gma3_assign_view_button", { view: 13, screen: 1, button: 8, replace: true });
  assert.equal(res.isError, true);
  unreadable.add("ViewButton 1.8");
  res = await h.callJson("gma3_assign_view_button", { view: 13, screen: 1, button: 8, replace: true });
  assert.equal(res.isError, true);
  assert.deepEqual(h.fake.commands, []);
});

test("detects a silently ignored assignment", async () => {
  ignoreAssign = true;
  const { result, isError } = await h.callJson("gma3_assign_view_button", { view: 13, screen: 1, button: 8 });
  assert.equal(isError, true);
  assert.equal(result.verification.status, "mismatched");
});

test("uncertain command delivery is never retried", async () => {
  h.fake.on("cmd", () => SILENT);
  const { result, isError } = await h.callJson("gma3_assign_view_button", { view: 13, screen: 1, button: 8 });
  assert.equal(isError, true);
  assert.equal(result.outcome, "unknown");
  assert.equal(h.fake.commands.length, 1);
});

test("shared mutation lock serializes concurrent creates of the same slot", async () => {
  const results = await Promise.all([h.callJson("gma3_store_view", { verify_contents: false, view: 9001, screens: [1] }), h.callJson("gma3_store_view", { verify_contents: false, view: 9001, screens: [1] })]);
  assert.deepEqual(results.map((r) => r.result.outcome), ["succeeded", "failed"]);
  assert.equal(h.fake.commands.length, 1);
});

test("a stored view with the wrong screen mask fails metadata verification", async () => {
  const store = h.fake.handlerFor("cmd")!;
  h.fake.on("cmd", async (args, req) => {
    const result = await store(args, req);
    views.get(9001)!.mask = 2;
    return result;
  });
  const { result, isError } = await h.callJson("gma3_store_view", { verify_contents: false, view: 9001, screens: [1] });
  assert.equal(isError, true);
  assert.equal(result.verification.status, "mismatched");
  assert.match(result.verification.detail, /ScreenContentMask/);
});

test("store delivery remains unknown even if readback finds matching metadata", async () => {
  h.fake.on("cmd", () => {
    views.set(9001, { name: "View 9001", mask: 1, addr: "14.19.1.4.9001" });
    return SILENT;
  });
  const { result, isError } = await h.callJson("gma3_store_view", { verify_contents: false, view: 9001, screens: [1] });
  assert.equal(isError, true);
  assert.equal(result.outcome, "unknown");
  assert.equal(result.verification.status, "matched");
  assert.equal(h.fake.commands.length, 1);
});

test("assignment readback failure is partial and cannot claim verification", async () => {
  const assign = h.fake.handlerFor("cmd")!;
  h.fake.on("cmd", async (args, req) => {
    const result = await assign(args, req);
    unreadable.add("ViewButton 1.8");
    return result;
  });
  const { result, isError } = await h.callJson("gma3_assign_view_button", { view: 13, screen: 1, button: 8 });
  assert.equal(isError, true);
  assert.equal(result.outcome, "partial");
  assert.equal(result.verification.status, "unavailable");
  assert.equal(h.fake.commands.length, 1);
});

test("console rejection stays failed and is never replayed", async () => {
  h.fake.on("cmd", () => ({ feedback: "Illegal object" }));
  const { result, isError } = await h.callJson("gma3_recall_view", { verify_contents: false, view: 13, screen: 1 });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.equal(h.fake.commands.length, 1);
});
