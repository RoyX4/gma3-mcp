import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

test("consumer package includes runtime qualification, route examples and helper dependencies", () => {
  const result = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root, encoding: "utf8", timeout: 30_000,
  }));
  const files = new Set<string>(result[0].files.map((file: { path: string }) => file.path));
  for (const file of [
    "dist/index.js", "dist/build-info.json", "deployment.json", "examples/instances.example.json",
    "plugin/gma3_mcp_bridge.xml", "plugin/gma3_mcp_bridge.lua", "plugin/gma3_mcp_hardkeys.lua",
    "plugin/gma3_mcp_feedback.lua", "plugin/gma3_mcp_control.lua", "scripts/mvr-inspect.py",
    "scripts/mcp-instance.mjs", "scripts/mcp-session.mjs", "scripts/mcp-session-jobs.mjs",
    "docs/qualification/2026-10-30.md",
  ]) assert.ok(files.has(file), `consumer package is missing ${file}`);
  for (const file of files) {
    assert.doesNotMatch(file, /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.mcp\.json|node_modules|tasks|outputs|\.test-tools)(?:\/|$)/);
    assert.doesNotMatch(file, /\.(?:show|mvr|gdtf|pyc)$/i, `private/generated data included: ${file}`);
  }
});

test("packing from a clean source checkout builds its executable first", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.prepack, "npm run build");
});
