import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const lua = ["lua5.4", "lua54", "lua"].find((bin) => !spawnSync(bin, ["-v"]).error);
test("bounded batch, writer lease, filtered reads and stable snapshot Lua harness", { skip: !lua && "Lua interpreter unavailable" }, () => {
  const r = spawnSync(lua!, ["test/lua/fastpath_test.lua"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ALL PASSED/);
});
