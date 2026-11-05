import { test } from "node:test";
import assert from "node:assert/strict";
import { captureTools } from "./helpers/tool-harness.ts";
import { registerTrackingTools } from "../src/tools/tracking.ts";
import type { ToolContext } from "../src/tools/context.ts";

const plan = { version: 1, sequence: 401, cues: [
  { cue: "1.000", changes: [{ kind: "value", fixtures: "1", attribute: "Dimmer", value: 40 }] },
  { cue: "2.500", hold: true },
] };
const ctx = { bridge: { request() { throw new Error("tracking plan tools must remain offline"); } } } as unknown as ToolContext;
const tools = captureTools(registerTrackingTools, ctx);
async function call(name: string, args: Record<string, unknown>) {
  const result = await tools.get(name)!.call(args);
  return { error: Boolean(result.isError), body: JSON.parse(result.content.map(c => c.text ?? "").join("\n")) };
}

test("tracking explanation accepts equivalent valid cue number spellings", async () => {
  for (const cue of [1, "1", "1.000", "01.0"]) {
    const result = await call("gma3_explain_tracking_cue", { plan, cue });
    assert.equal(result.error, false, JSON.stringify(result.body));
    assert.equal(result.body.cue, "1");
    assert.equal(result.body.cells[0].state.value, 40);
  }
});

test("tracking comparison canonicalizes both cue references", async () => {
  const result = await call("gma3_compare_tracking_cues", { plan, from: "1.000", to: "02.500" });
  assert.equal(result.error, false, JSON.stringify(result.body));
  assert.equal(result.body.total, 0);
});

test("tracking query tools reject non-cue numeric notation instead of silently selecting another spelling", async () => {
  for (const cue of ["0x1", "1e0", "1.0000"]) {
    const explanation = await call("gma3_explain_tracking_cue", { plan, cue });
    assert.equal(explanation.error, true, `invalid cue reference ${cue} was accepted`);
    const comparison = await call("gma3_compare_tracking_cues", { plan, from: cue, to: "2.5" });
    assert.equal(comparison.error, true, `invalid comparison reference ${cue} was accepted`);
  }
});

test("compact tracking compilation preserves counts while omitting full state", async () => {
  const compact = await call("gma3_compile_tracking", { plan });
  const detailed = await call("gma3_compile_tracking", { plan, detail: true });
  assert.equal(compact.error, false);
  assert.equal(detailed.error, false);
  assert.equal(compact.body.plan, undefined);
  for (const [index, cue] of compact.body.cues.entries()) {
    assert.equal(cue.state, undefined);
    assert.equal(cue.delta, undefined);
    assert.equal(cue.stateCells, detailed.body.cues[index].state.length);
    assert.equal(cue.emittedCells, detailed.body.cues[index].delta.length);
    assert.equal(cue.stateFingerprint, detailed.body.cues[index].stateFingerprint);
  }
});
