import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { FakeBridge, SILENT } from "./helpers/fake-bridge.ts";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobEngine } from "../src/jobs/engine.ts";
import { compileTracking } from "../src/tracking/model.ts";

async function session(fake: FakeBridge, lines: unknown[], extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["scripts/mcp-session.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, GMA3_BRIDGE_PORT: String(fake.port), GMA3_BRIDGE_TIMEOUT_MS: "50", GMA3_SESSION_SOURCE: "1", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", text => stdout += text);
  child.stderr.setEncoding("utf8").on("data", text => stderr += text);
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  child.stdin.end(lines.map(line => JSON.stringify(line)).join("\n") + "\n");
  const code = await completed;
  return { code, stderr, replies: stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
}

test("a session keeps one MCP process and TCP connection for consecutive tool calls", async () => {
  const fake = new FakeBridge().on("ping", () => ({ bridgeVersion: "test", showfile: "Scratch", hostname: "Desk" }));
  await fake.listen();
  try {
    const output = await session(fake, [{ id: 1, tool: "gma3_status" }, { id: 2, tool: "gma3_connection_check", args: { samples: 1 } }]);
    assert.equal(output.code, 0, output.stderr);
    assert.equal(output.replies.length, 2);
    const health = JSON.parse(output.replies[1].result.content[0].text);
    assert.equal(health.transport.connections, 1);
    assert.equal(health.status, "healthy");
    assert.ok(output.replies[1].timing.toolMs >= 0);
    assert.ok(output.replies[1].timing.idleBeforeMs >= 0);
    assert.ok(output.replies[1].timing.mcpConnectMs >= 0);
    assert.deepEqual(fake.requests.map(req => req.op), ["ping", "ping"]);
  } finally { await fake.close(); }
});

test("piped job run drains its stdio server to a durable terminal checkpoint after input EOF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gma3-session-job-")), fake = new FakeBridge();
  let environment = "Normal", stored = false;
  const fields = { Name: "", Tracking: "Yes", Lock: "", StructureLocked: "No", SystemLocked: "No" };
  fake.on("fast.context", () => ({ contextKey: "same", identity: { generation: "g", hostname: "lab", showfile: "Scratch", user: "u", profile: "p" }, identityUncertain: [], environment }));
  fake.on("object", () => ({ class: "DataPool", index: 1 }));
  fake.on("fast.lease", (a) => a.action === "release" ? { released: true } : { token: "lease" });
  fake.on("patch.collections", () => ({ live: ["Stages", "FixtureTypes", "AttributeDefinitions"] }));
  fake.on("patch.fingerprint", () => ({ complete: true, hash: 1, objects: 1 }));
  fake.on("objects", () => ({ total: stored ? 1 : 0, items: stored ? [{ addr: "S900", fields, hasActivePlayback: false }] : [] }));
  fake.on("children", () => ({ items: [] }));
  fake.on("programmer", () => ({ environment, total: 0, coverage: { complete: true }, rows: [], scannedFixtures: [] }));
  fake.on("feedback.read", () => ({ items: [{ name: "previewMode", available: true, value: environment }] }));
  fake.on("cue.content", () => ({ complete: true, sequence: { fields }, cues: stored ? [{ no: 1000, fields: {}, parts: [{ contentJson: '{"byFixtures":true,"truncated":false,"rows":[]}', rawChannelsJson: "{}" }] }] : [], limitations: [] }));
  fake.on("cmd", async (a) => {
    const command = String(a.command);
    if (command === "Preview On") environment = "Preview";
    if (command === "Preview Off") environment = "Normal";
    if (/^Store .*Cue/.test(command)) { await new Promise((r) => setTimeout(r, 100)); stored = true; }
    return { feedback: "OK" };
  });
  await fake.listen();
  try {
    const job = await new JobEngine(directory, {} as any).create(compileTracking({ version: 1, sequence: 900, cues: [{ cue: 1, hold: true }] }), { batchSize: 1 });
    const output = await session(fake, [{ tool: "gma3_programming_job", args: { action: "run", id: job.id, run: true, exclusive: true } }], { GMA3_JOB_DIR: directory, GMA3_BRIDGE_TIMEOUT_MS: "400" });
    assert.equal(output.code, 0, output.stderr + JSON.stringify(output.replies));
    assert.equal(JSON.parse(output.replies[0].result.content[0].text).status, "completed");
    assert.equal(output.replies[0].jobWait.terminalStatus, "completed");
    assert.match(output.stderr, /job_progress/);
    assert.equal(JSON.parse(await readFile(join(directory, `${job.id}.json`), "utf8")).status, "completed");
    assert.equal(fake.commands.filter((c) => /^Store .*Cue/.test(c)).length, 1);
    assert.equal(environment, "Normal");
  } finally { await fake.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a session validates tool timeout before dispatch", async () => {
  const fake = new FakeBridge().on("ping", () => ({ bridgeVersion: "test" }));
  await fake.listen();
  try {
    const output = await session(fake, [{ tool: "gma3_status", timeout_ms: -1 }]);
    assert.equal(output.code, 1);
    assert.match(output.replies[0].error, /timeout_ms/);
    assert.deepEqual(fake.requests, []);
  } finally { await fake.close(); }
});

test("a session applies an explicit whole-tool deadline and stops before the next line", async () => {
  const fake = new FakeBridge().on("ping", () => SILENT).on("cmd", () => ({ feedback: "OK" }));
  await fake.listen();
  try {
    const output = await session(fake, [
      { id: "slow", tool: "gma3_connection_check", timeout_ms: 50, args: { samples: 3, interval_ms: 0, timeout_ms: 500 } },
      { tool: "gma3_command", args: { command: "Go+", via: "bridge" } },
    ]);
    assert.equal(output.code, 1);
    assert.match(output.replies[0].error, /timed out/i);
    assert.equal(output.replies[0].id, "slow");
    assert.equal(output.replies[0].tool, "gma3_connection_check");
    assert.deepEqual(fake.commands, []);
  } finally { await fake.close(); }
});

test("a session stops after an uncertain mutation and does not dispatch the next line", async () => {
  const fake = new FakeBridge().on("cmd", () => SILENT);
  await fake.listen();
  try {
    const output = await session(fake, [
      { tool: "gma3_command", args: { command: "Store Cue 1", via: "bridge" } },
      { tool: "gma3_command", args: { command: "Go+", via: "bridge" } },
    ]);
    assert.equal(output.code, 1, output.stderr);
    assert.equal(output.replies.length, 1);
    assert.equal(output.replies[0].result.isError, true);
    assert.deepEqual(fake.commands, ["Store Cue 1"]);
  } finally { await fake.close(); }
});
