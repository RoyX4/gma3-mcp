import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInPreview } from "../src/tools/cuelists.ts";
import { commandStep } from "../src/results.ts";
import { startHarness } from "./helpers/tool-harness.ts";

async function run(options: { feedback?: "supported" | "old" | "malformed"; incompletePreview?: boolean; leavePreview?: boolean } = {}) {
  const h = await startHarness(() => {});
  let environment = "Normal", feedbackReads = 0;
  h.fake.on("cmd", args => {
    if (args.command === "Preview On") environment = "Preview";
    if (args.command === "Preview Off") environment = "Normal";
    return { feedback: "OK" };
  });
  h.fake.on("programmer", () => ({
    environment, total: 0, offset: 0, rows: [], scannedFixtures: [], fixturesTruncated: false,
    coverage: { complete: !(options.incompletePreview && environment === "Preview") },
  }));
  h.fake.on("feedback.read", () => {
    feedbackReads++;
    if (options.feedback === "old") throw new Error("unknown op 'feedback.read'");
    if (options.leavePreview && feedbackReads === 2) environment = "Normal";
    return { items: [{ name: "previewMode", available: true, value: options.feedback === "malformed" ? "Unknown" : environment }] };
  });
  try {
    const result = await buildInPreview(h.ctx, { verify: true, noun: "cues", items: Array.from({ length: 4 }, (_, index) => ({
      prefix: `cue ${index + 1}: `, looks: [],
      store: [{ name: `store_${index + 1}`, run: () => commandStep(h.bridge, `store_${index + 1}`, `Store Sequence 999 Cue ${index + 1} /NoConfirmation`) }],
    })) });
    return { result, requests: [...h.fake.requests], commands: [...h.fake.commands], environment };
  } finally { await h.close(); }
}

test("cue environment guards retain only three required whole-programmer scans for four cues", async () => {
  const data = await run();
  assert.equal(data.result.normalProgrammer, "untouched");
  assert.ok(data.result.items.every(item => item.status === "stored"));
  assert.equal(data.requests.filter(req => req.op === "programmer" && req.args.scope === "all").length, 3, "Normal before/after plus complete empty Preview proof remain");
  assert.equal(data.requests.filter(req => req.op === "feedback.read").length, 6, "start, three between-cue guards, cleanup, and return-to-Normal");
});

test("old feedback capability falls back to complete programmer scans without losing correctness", async () => {
  const data = await run({ feedback: "old" });
  assert.equal(data.result.normalProgrammer, "untouched");
  assert.ok(data.result.items.every(item => item.status === "stored"));
  assert.equal(data.requests.filter(req => req.op === "programmer" && req.args.scope === "all").length, 9);
});

test("malformed feedback is never guessed to be Normal or Preview", async () => {
  const data = await run({ feedback: "malformed" });
  assert.equal(data.result.normalProgrammer, "untouched");
  assert.ok(data.result.items.every(item => item.status === "stored"));
  assert.equal(data.requests.filter(req => req.op === "programmer" && req.args.scope === "all").length, 9);
});

test("fast environment feedback cannot replace proof that Preview is empty", async () => {
  const data = await run({ incompletePreview: true });
  assert.equal(data.commands.some(command => command.startsWith("Store")), false);
  assert.equal(data.commands.includes("ClearAll"), false);
  assert.equal(data.result.normalProgrammer, "untouched");
});

test("leaving Preview between cues stops before any clear or second store in Normal", async () => {
  const data = await run({ leavePreview: true });
  assert.equal(data.commands.filter(command => command.startsWith("Store")).length, 1);
  assert.equal(data.commands.includes("ClearAll"), false);
  assert.equal(data.result.items[1].status, "failed");
});
