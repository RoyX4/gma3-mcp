import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/tool-harness.ts";
import { registerLocalUiTools, type LocalUiRunner } from "../src/tools/localui.ts";

const HELPER = "/opt/grandma3/local-ui.py";
const state = { running: true, host_id: "0x123", main_id: "0x456", hidden: true, fullscreen: true, normal: false };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const image = () => ({ data: png, width: 1, height: 1, native_width: 1, native_height: 1, window: { ...state } });
const text = (result: any) => result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

async function harness(runner: LocalUiRunner, helper: string | undefined = HELPER) {
  return startHarness((server, ctx) => registerLocalUiTools(server, ctx, helper, runner));
}

test("local UI tools are absent unless an absolute helper is configured", async () => {
  const h = await startHarness((server, ctx) => registerLocalUiTools(server, ctx));
  try { assert.equal(h.tools.size, 0); } finally { await h.close(); }
  assert.throws(() => registerLocalUiTools({} as any, {} as any, "./local-ui.py"), /absolute/);
});

test("screenshot returns real MCP PNG content and hidden window metadata without changing it", async () => {
  const requests: unknown[] = [];
  const h = await harness(async (path, args) => { requests.push([path, args]); return JSON.stringify(image()); });
  try {
    const result = await h.call("gma3_screenshot", {}) as any;
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content[0], { type: "image", mimeType: "image/png", data: png });
    const metadata = JSON.parse(text(result));
    assert.equal(metadata.width, 1);
    assert.equal(metadata.window.hidden, true);
    assert.equal(metadata.data, undefined, "PNG bytes appear only in image content");
    assert.equal(metadata.provenance.renderFreshness, "unverified");
    assert.match(metadata.provenance.pngSha256, /^[0-9a-f]{64}$/);
    assert.ok(Date.parse(metadata.provenance.captureCompletedAt) >= Date.parse(metadata.provenance.captureStartedAt));
    assert.deepEqual(requests, [[HELPER, ["screenshot", "--max-width", "1536"]]]);
    assert.equal(h.fake.requests.length, 0, "no console or focus operation is issued");
  } finally { await h.close(); }
});

test("invalid screenshot bounds and window actions are refused before helper dispatch", async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; return "{}"; });
  try {
    for (const max_width of [255, 3073, 256.5, "1024"]) assert.equal((await h.call("gma3_screenshot", { max_width })).isError, true);
    assert.equal((await h.call("gma3_window", { action: "close" })).isError, true);
    assert.equal(calls, 0);
  } finally { await h.close(); }
});

test("status reports a stopped app without creating a session or acquiring the mutation lock", async () => {
  const stopped = { running: false, hidden: false, host_id: null, main_id: null };
  const h = await harness(async (_path, args) => { assert.deepEqual(args, ["window", "status"]); return JSON.stringify(stopped); });
  try {
    h.ctx.mutations.run = async () => { throw new Error("status must not take the mutation lock"); };
    const result = await h.call("gma3_window", {});
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(text(result)).window, stopped);
  } finally { await h.close(); }
});

test("window changes run under the existing mutation lock and are checked against their requested state", async () => {
  const calls: string[][] = [];
  const h = await harness(async (_path, args) => {
    assert.equal(h.ctx.mutations.busy, true);
    calls.push([...args]);
    return JSON.stringify({ ...state, hidden: false, normal: true });
  });
  try {
    const result = await h.call("gma3_window", { action: "show" });
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(text(result)).outcome, "succeeded");
    assert.deepEqual(calls, [["window", "show"]]);
    const mismatch = await h.call("gma3_window", { action: "hide" });
    assert.equal(mismatch.isError, true);
    assert.match(text(mismatch), /not confirm|requested state/i);
    assert.equal(calls.length, 2, "a mismatch is never retried");
  } finally { await h.close(); }
});

test("timeouts are reported once and a window mutation remains uncertain", async () => {
  let calls = 0;
  const h = await harness(async () => { calls++; throw Object.assign(new Error("helper timed out"), { code: "ETIMEDOUT" }); });
  try {
    const result = await h.call("gma3_window", { action: "toggle" });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(text(result)).outcome, "unknown");
    assert.match(text(result), /No retry|not retried/i);
    assert.equal(calls, 1);
    const screenshot = await h.call("gma3_screenshot", {});
    assert.equal(screenshot.isError, true);
    assert.equal(calls, 2, "each tool dispatched just once");
  } finally { await h.close(); }
});

test("malformed screenshot results never become MCP images", async () => {
  const badHeader = Buffer.from(png, "base64"); badHeader[0] = 0;
  const badChecksum = Buffer.from(png, "base64"); badChecksum[45] ^= 1;
  const cases = [
    "not json", JSON.stringify({ error: "No application pixels" }),
    JSON.stringify({ ...image(), data: "%%%" }),
    JSON.stringify({ ...image(), data: badHeader.toString("base64") }),
    JSON.stringify({ ...image(), data: Buffer.from(png, "base64").subarray(0, 33).toString("base64") }),
    JSON.stringify({ ...image(), data: badChecksum.toString("base64") }),
    JSON.stringify({ ...image(), width: 2 }),
    JSON.stringify({ ...image(), native_width: 0 }),
    JSON.stringify({ ...image(), window: { ...state, main_id: "other app" } }),
    JSON.stringify({ ...image(), window: { ...state, hidden: "yes" } }),
    JSON.stringify({ ...image(), window: { ...state, running: false } }),
    JSON.stringify({ ...image(), data: Buffer.alloc(6 * 1024 * 1024 + 1).toString("base64") }),
    " ".repeat(9 * 1024 * 1024 + 1),
  ];
  let index = 0;
  const h = await harness(async () => cases[index++]);
  try {
    for (const _value of cases) {
      const result = await h.call("gma3_screenshot", {}) as any;
      assert.equal(result.isError, true, `case ${index}`);
      assert.equal(result.content.some((c: any) => c.type === "image"), false, `case ${index}`);
    }
    assert.equal(index, cases.length);
  } finally { await h.close(); }
});

test("malformed window state cannot be reported as a verified change", async () => {
  const h = await harness(async () => JSON.stringify({ ...state, fullscreen: "true" }));
  try {
    const result = await h.call("gma3_window", { action: "show" });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(text(result)).outcome, "unknown");
  } finally { await h.close(); }
});

test("a toggle must confirm either hidden or restored fullscreen state", async () => {
  const h = await harness(async () => JSON.stringify({ ...state, hidden: false, normal: false }));
  try {
    const result = await h.call("gma3_window", { action: "toggle" });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(text(result)).outcome, "unknown");
  } finally { await h.close(); }
});
