import { test } from "node:test";
import assert from "node:assert/strict";
import { dependencySnapshot } from "../src/jobs/dependencies.ts";
import { compileTracking } from "../src/tracking/model.ts";
import type { ToolContext } from "../src/tools/context.ts";

const address = (preset: number) => `13.13.1.4.${preset}`;
const plan = (count: number) => compileTracking({
  version: 1, sequence: 500,
  cues: Array.from({ length: count }, (_, index) => ({
    cue: index + 1,
    changes: [{ kind: "preset", fixtures: "1", pool: 4, preset: index + 1, attributes: ["Dimmer"] }],
  })),
});

function harness(dependencies: (preset: number) => number[] = () => []) {
  const reads: string[] = [];
  const ctx = {
    requestTimeoutMs: 100,
    bridge: {
      async request(op: string, args: Record<string, unknown>) {
        if (op === "patch.collections") return { live: ["Stages", "FixtureTypes", "AttributeDefinitions"] };
        if (op === "patch.fingerprint") return { complete: true, hash: 1, objects: 1 };
        assert.equal(op, "preset.read");
        const ref = String(args.ref), preset = Number(ref.split(".").at(-1));
        reads.push(ref);
        return {
          addr: address(preset), rows: [], truncated: false, dependenciesReadable: true,
          dependencies: dependencies(preset).map((index) => ({ addr: address(index), valid: true })),
        };
      },
    },
  } as unknown as ToolContext;
  return { ctx, reads };
}

test("the 64-preset graph bound counts definitions rather than native address aliases", async () => {
  const h = harness(), compilation = plan(64);
  assert.equal(compilation.executable, true);
  const snapshot = await dependencySnapshot(h.ctx, compilation);
  assert.equal(snapshot.complete, true, snapshot.limitations.join("; "));
  assert.equal(snapshot.presetReads, 64);
  assert.equal(h.reads.length, 64);
});

test("a 65th distinct preset still refuses a complete dependency checkpoint", async () => {
  const h = harness(), snapshot = await dependencySnapshot(h.ctx, plan(65));
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.presetReads, 64);
  assert.equal(h.reads.length, 64);
  assert.match(snapshot.limitations.join("; "), /exceeds 64 presets/);
});

test("native addresses deduplicate embedded aliases and cycles without extra reads", async () => {
  const h = harness((preset) => preset === 1 ? [2, 2] : [1]);
  const snapshot = await dependencySnapshot(h.ctx, plan(2));
  assert.equal(snapshot.complete, true, snapshot.limitations.join("; "));
  assert.equal(snapshot.presetReads, 2);
  assert.deepEqual(h.reads, ["Preset 4.1", "Preset 4.2"]);
});

test("four embedded levels remain supported and a fifth level remains incomplete", async () => {
  for (const last of [5, 6]) {
    const h = harness((preset) => preset < last ? [preset + 1] : []);
    const snapshot = await dependencySnapshot(h.ctx, plan(1));
    assert.equal(snapshot.complete, last === 5);
    assert.equal(snapshot.presetReads, 5);
    if (last === 6) assert.match(snapshot.limitations.join("; "), /four embedded levels/);
  }
});
