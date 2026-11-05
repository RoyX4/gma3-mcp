import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";
import { registerConnectionTools } from "../src/tools/connection.ts";

const identity = { bridgeVersion: "0.44.0", showfile: "Scratch", hostname: "TestDesk", build: { version: "2.5.1.1" } };
test("health samples share one persistent connection and never send programming commands", async () => {
  const h = await startHarness(registerConnectionTools);
  h.fake.on("ping", () => identity);
  try {
    const { result, isError } = await h.callJson("gma3_connection_check", { samples: 3, interval_ms: 0, expected_show: "Scratch", expected_station: "TestDesk" });
    assert.equal(isError, false);
    assert.equal(result.status, "healthy");
    assert.equal(result.transport.connections, 1);
    assert.equal(result.samples.length, 3);
    assert.deepEqual(h.fake.requests.map(r => r.op), ["ping", "ping", "ping"]);
  } finally { await h.close(); }
});
test("health reports an open but unanswered socket without restarting or replaying", async () => {
  const h = await startHarness(registerConnectionTools);
  h.fake.on("ping", () => SILENT);
  try {
    const { result, isError } = await h.callJson("gma3_connection_check", { samples: 1, timeout_ms: 50 });
    assert.equal(isError, true);
    assert.equal(result.status, "unresponsive");
    assert.equal(result.transport.tcpConnected, true);
    assert.equal(h.fake.requests.length, 1);
    assert.match(result.guidance.join(" "), /never|do not/i);
  } finally { await h.close(); }
});
test("health refuses to treat another show or station as the intended instance", async () => {
  const h = await startHarness(registerConnectionTools);
  h.fake.on("ping", () => identity);
  try {
    const { result, isError } = await h.callJson("gma3_connection_check", { samples: 1, expected_show: "Theatre", expected_station: "PrivateDesk" });
    assert.equal(isError, true);
    assert.equal(result.status, "wrong_instance");
    assert.match(result.problems.join(" "), /Scratch/);
    assert.match(result.problems.join(" "), /TestDesk/);
  } finally { await h.close(); }
});
test("intermittent replies and show changes remain visible instead of trusting the last successful ping", async () => {
  const h = await startHarness(registerConnectionTools);
  let count = 0;
  h.fake.on("ping", () => ++count === 1 ? SILENT : { ...identity, showfile: count === 2 ? "Scratch" : "Changed" });
  try {
    const { result, isError } = await h.callJson("gma3_connection_check", { samples: 3, interval_ms: 0, timeout_ms: 50 });
    assert.equal(isError, true);
    assert.equal(result.status, "wrong_instance");
    assert.equal(result.samples[0].responsive, false);
    assert.equal(result.samples[2].responsive, true);
    assert.match(result.problems.join(" "), /changed/i);
  } finally { await h.close(); }
});
test("a closed bridge is unavailable, not evidence that the console application stopped", async () => {
  const h = await startHarness(registerConnectionTools);
  await h.fake.close();
  try {
    const { result, isError } = await h.callJson("gma3_connection_check", { samples: 1, timeout_ms: 50 });
    assert.equal(isError, true);
    assert.equal(result.status, "unavailable");
    assert.equal(result.transport.tcpConnected, false);
    assert.equal(result.consoleProcessObserved, false);
  } finally { h.bridge.close(); }
});
