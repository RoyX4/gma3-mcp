#!/usr/bin/env node
// JSON-lines client: one MCP server and bridge session for an entire ordered workflow.
import { createInterface } from "node:readline";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { waitForProgrammingJob } from "./mcp-session-jobs.mjs";

const root = path.resolve(import.meta.dirname, "..");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
// Start buffering the iterator before waiting for server initialization; piped input can arrive immediately.
const lines = input[Symbol.asyncIterator]();
const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && (key.startsWith("GMA3_") || ["PATH", "HOME", "LANG", "LC_ALL", "DISPLAY", "XAUTHORITY"].includes(key))));
const fromSource = process.env.GMA3_SESSION_SOURCE === "1";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: fromSource ? ["--import", "tsx", path.join(root, "src/index.ts")] : [path.join(root, "dist/index.js")],
  cwd: root,
  env: environment,
  stderr: "inherit",
});
const client = new Client({ name: "gma3-persistent-session", version: "1.0.0" });
const write = value => process.stdout.write(JSON.stringify(value) + "\n");
const roundedMs = value => Math.round(value * 100) / 100;
let active;
let toolStarted = 0;
let mcpConnectMs = 0;
let idleBeforeMs = 0;
try {
  const connecting = performance.now();
  await client.connect(transport);
  mcpConnectMs = roundedMs(performance.now() - connecting);
  let previousFinished = performance.now();
  for await (const line of { [Symbol.asyncIterator]: () => lines }) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("A session request exceeds 1 MiB");
    const request = JSON.parse(line);
    if (!request || typeof request !== "object" || typeof request.tool !== "string" || !/^gma3_[a-z0-9_]+$/.test(request.tool)) throw new Error("Each line requires {tool: 'gma3_...', args?: {...}, id?: ...}");
    const args = request.args ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("args must be an object");
    const timeout = request.timeout_ms ?? 60000;
    if (!Number.isInteger(timeout) || timeout < 50 || timeout > 600000) throw new Error("timeout_ms must be an integer in 50..600000 (default 60000)");
    active = { ...(request.id === undefined ? {} : { id: request.id }), tool: request.tool };
    idleBeforeMs = roundedMs(performance.now() - previousFinished);
    toolStarted = performance.now();
    const initial = await client.callTool({ name: request.tool, arguments: args }, undefined, { timeout });
    const waited = await waitForProgrammingJob(client, { ...request, args }, initial, {
      onProgress: state => process.stderr.write(JSON.stringify({ event: "job_progress", id: state.id, status: state.status, progress: state.progress, inFlight: state.inFlight, ...(state.error ? { error: state.error } : {}) }) + "\n"),
    });
    const result = waited.result;
    write({ ...active, timing: { mcpConnectMs, idleBeforeMs, toolMs: roundedMs(performance.now() - toolStarted) }, ...(waited.jobWait ? { jobWait: waited.jobWait } : {}), result });
    active = undefined;
    previousFinished = performance.now();
    if (result.isError) {
      process.exitCode = 1;
      break; // Never continue a workflow past a failed or uncertain tool result.
    }
  }
} catch (error) {
  write({ ...active, ...(active ? { timing: { mcpConnectMs, idleBeforeMs, toolMs: roundedMs(performance.now() - toolStarted) } } : {}), error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  input.close();
  await client.close();
}
