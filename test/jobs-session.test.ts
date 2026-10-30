import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForProgrammingJob } from "../scripts/mcp-session-jobs.mjs";
const result = (status: string, extra = {}) => ({ content: [{ type: "text", text: JSON.stringify({ id: "job-id", status, progress: { verifiedCues: status === "completed" ? 3 : 0, totalCues: 3 }, ...extra }) }] });
test("the CLI keeps its MCP server alive until an asynchronously started job reaches a terminal checkpoint", async () => {
  const calls: any[] = [], progress: any[] = [];
  const client = { callTool: async (call: any) => { calls.push(call); return calls.length === 1 ? result("running", { inFlight: { progress: { phase: "store" } } }) : result("completed"); } };
  const waited = await waitForProgrammingJob(client, { tool: "gma3_programming_job", args: { action: "run", id: "job-id", run: true, exclusive: true } }, result("running"), { delayMs: 0, onProgress: (r: any) => progress.push(r) });
  assert.equal(waited.jobWait.polls, 2);
  assert.equal(JSON.parse(waited.result.content[0].text).status, "completed");
  assert.deepEqual(calls.map((c) => c.arguments), [{ action: "status", id: "job-id" }, { action: "status", id: "job-id" }]);
  assert.equal(progress.at(-1).status, "completed");
});
test("CLI job draining retains uncertain results and never resends run or resume mutations", async () => {
  const uncertain = { ...result("uncertain"), isError: true }, calls: any[] = [];
  const waited = await waitForProgrammingJob({ callTool: async (c: any) => { calls.push(c); return uncertain; } }, { tool: "gma3_programming_job", args: { action: "resume", id: "job-id", run: true } }, result("running"), { delayMs: 0 });
  assert.equal(waited.result.isError, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.action, "status");
});
test("offline run:false, unrelated tools and already terminal jobs do not start polling", async () => {
  let calls = 0;
  const client = { callTool: async () => { calls++; throw new Error("should not poll"); } };
  for (const request of [{ tool: "gma3_programming_job", args: { action: "run", run: false } }, { tool: "gma3_status", args: {} }]) await waitForProgrammingJob(client, request, result("running"));
  await waitForProgrammingJob(client, { tool: "gma3_programming_job", args: { action: "run", run: true } }, result("completed"));
  assert.equal(calls, 0);
});
