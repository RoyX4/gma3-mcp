import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FakeBridge, SILENT } from "./helpers/fake-bridge.ts";

const root = path.resolve(import.meta.dirname, "..");
async function statusAt(port: number) {
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  Object.assign(env, { GMA3_BRIDGE_HOST: "127.0.0.1", GMA3_BRIDGE_PORT: String(port), GMA3_OSC_DISABLED: "1", GMA3_ALLOW_LUA: "0" });
  delete env.GMA3_EXPECTED_STATION;
  delete env.GMA3_EXPECTED_SHOWS;
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/index.ts"], cwd: root, env, stderr: "pipe" });
  const client = new Client({ name: "registered-status-regression", version: "1.0.0" });
  try {
    await client.connect(transport);
    const response = await client.callTool({ name: "gma3_status", arguments: {} });
    assert.equal(response.isError, undefined);
    return JSON.parse(response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"));
  } finally { await client.close(); }
}

test("registered status distinguishes a connected TCP ping timeout from a socket disconnect", async () => {
  const fake = new FakeBridge();
  const port = await fake.listen();
  fake.on("ping", () => SILENT);
  try {
    const result = await statusAt(port);
    assert.equal(result.connection.tcpConnected, true);
    assert.equal(result.connection.connections, 1);
    assert.equal(result.connection.disconnects, 0);
    assert.equal(result.connection.timeouts, 1);
    assert.equal(result.bridge.connected, false, "legacy connected still means a ping replied");
    assert.equal(result.bridge.tcpConnected, true);
    assert.equal(result.bridge.responsive, false);
    assert.equal(result.bridge.state, "unresponsive");
    assert.match(result.bridge.error, /timeout after 4000ms waiting for 'ping'/);
    assert.match(result.bridge.hint, /long console operation|busy console/i);
    assert.doesNotMatch(result.bridge.hint, /run: Plugin|start Plugin|gma3_start_bridge/);
    assert.deepEqual(fake.requests.map((request) => request.op), ["ping"], "status never restarts or probes by mutating the console");
  } finally { await fake.close(); }
});

test("registered status reports refused TCP separately and keeps the instance and plugin recovery guidance", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const result = await statusAt(port);
  assert.equal(result.bridge.connected, false);
  assert.equal(result.bridge.tcpConnected, false);
  assert.equal(result.bridge.responsive, false);
  assert.equal(result.bridge.state, "disconnected");
  assert.equal(result.connection.connections, 0);
  assert.match(result.bridge.error, /cannot connect/);
  assert.match(result.bridge.hint, /instance\/network namespace/);
  assert.match(result.bridge.hint, /Plugin "gma3_mcp_bridge"/);
});

test("registered status reports both TCP connectivity and a successful ping", async () => {
  const fake = new FakeBridge();
  const port = await fake.listen();
  fake.on("ping", () => ({ hostname: "lab", port, showfile: "show" }));
  try {
    const result = await statusAt(port);
    assert.equal(result.bridge.connected, true);
    assert.equal(result.bridge.tcpConnected, true);
    assert.equal(result.bridge.responsive, true);
    assert.equal(result.bridge.state, "responsive");
    assert.equal(result.bridge.showfile, "show");
    assert.equal(result.connection.connections, 1);
    assert.equal(result.connection.timeouts, 0);
  } finally { await fake.close(); }
});
