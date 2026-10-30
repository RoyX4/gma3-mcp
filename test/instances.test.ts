import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInstanceProfile } from "../src/instances.ts";

test("named profiles require exact station, show allowlist and loopback endpoint", () => {
  const input = { schemaVersion: 1, instances: { lab: { station: "Lab", shows: ["Test"], port: 9803 } } };
  assert.equal(parseInstanceProfile(input, "lab").host, "127.0.0.1");
  assert.throws(() => parseInstanceProfile(input, "wrong"), /Unknown instance/);
  assert.throws(() => parseInstanceProfile({ ...input, instances: { lab: { ...input.instances.lab, host: "0.0.0.0" } } }, "lab"));
  assert.throws(() => parseInstanceProfile({ ...input, instances: { lab: { ...input.instances.lab, shows: [] } } }, "lab"));
});
