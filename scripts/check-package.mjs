#!/usr/bin/env node
// Offline consumer smoke. Run after npm run build; requires npm, tar and Python 3 on PATH.
// Only installed dependencies are shared with the checkout. Runtime code/data comes from the tarball.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const required = [
  "dist/index.js", "dist/build-info.json", "dist/deployment.js", "dist/mvr.js",
  "deployment.json", "examples/instances.example.json",
  "plugin/gma3_mcp_bridge.xml", "plugin/gma3_mcp_bridge.lua", "plugin/gma3_mcp_hardkeys.lua",
  "plugin/gma3_mcp_feedback.lua", "plugin/gma3_mcp_control.lua", "scripts/mvr-inspect.py",
  "scripts/mcp-instance.mjs", "scripts/mcp-session.mjs", "scripts/mcp-session-jobs.mjs",
  "docs/qualification/2026-10-30.md",
];
const criticalTools = [
  "gma3_status", "gma3_command", "gma3_lua", "gma3_connection_check", "gma3_reconnect",
  "gma3_compile_tracking", "gma3_programming_job", "gma3_native_cue_data",
  "gma3_batch", "gma3_programmer_snapshot", "gma3_inspect_mvr", "gma3_compare_mvr",
];
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
  value !== undefined && !key.startsWith("GMA3_") && !key.startsWith("TSX_") &&
  !["NODE_OPTIONS", "NODE_PATH"].includes(key)));
const temporary = await mkdtemp(path.join(tmpdir(), "gma3-package-smoke-"));
const tcp = createServer(socket => { bridgeConnections += 1; socket.destroy(); });
const udp = createSocket("udp4");
const trapErrors = [];
let bridgeConnections = 0, oscPackets = 0;
let tcpListening = false, udpListening = false;
let client, transport, result;
tcp.on("error", error => trapErrors.push(error.message));
udp.on("error", error => trapErrors.push(error.message));
udp.on("message", () => { oscPackets += 1; });

async function withTimeout(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

try {
  const environment = {
    ...cleanEnv,
    XDG_STATE_HOME: path.join(temporary, "state"),
    npm_config_cache: path.join(temporary, "npm-cache"),
    npm_config_offline: "true", npm_config_ignore_scripts: "true",
  };
  const npmCli = process.env.npm_execpath;
  const packed = await run(npmCli ? process.execPath : "npm", [
    ...(npmCli ? [npmCli] : []), "pack", "--offline", "--ignore-scripts", "--workspaces=false",
    "--json", "--pack-destination", temporary,
  ], { cwd: root, env: environment, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  const packages = JSON.parse(packed.stdout);
  assert.equal(packages.length, 1, "npm pack must produce one local package");
  const pack = packages[0];
  assert.equal(path.basename(pack.filename), pack.filename, "unexpected package filename");
  const files = new Set(pack.files.map(file => file.path));
  for (const name of required) assert.ok(files.has(name), `tarball is missing ${name}; run npm run build first`);
  for (const name of files) {
    assert.ok(!path.posix.isAbsolute(name) && !name.split("/").includes(".."), `unsafe package path: ${name}`);
    assert.doesNotMatch(name, /(?:^|\/)(?:node_modules|tasks|outputs|\.test-tools|\.git)(?:\/|$)/);
    assert.doesNotMatch(name, /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.mcp\.json)$/);
    assert.doesNotMatch(name, /\.(?:show|mvr|gdtf|pyc)$/i, `private/generated data in package: ${name}`);
  }
  const archive = path.join(temporary, pack.filename);
  const listing = await run("tar", ["-tzf", archive], { env: environment, timeout: 30_000 });
  for (const name of listing.stdout.trim().split("\n")) {
    assert.ok(name.startsWith("package/") && !name.split("/").includes(".."), `unsafe archive path: ${name}`);
  }
  const extracted = path.join(temporary, "extracted");
  await mkdir(extracted);
  await run("tar", ["-xzf", archive, "-C", extracted], { env: environment, timeout: 30_000 });
  const packageRoot = path.join(extracted, "package");
  await symlink(await realpath(path.join(root, "node_modules")), path.join(packageRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir");
  const json = async name => JSON.parse(await readFile(path.join(packageRoot, name), "utf8"));
  const manifest = await json("deployment.json"), stamp = await json("dist/build-info.json");
  assert.match(stamp.sourceHash, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(stamp.builtAt)), "packaged build timestamp is invalid");
  const checkoutStamp = JSON.parse(await readFile(path.join(root, "dist/build-info.json"), "utf8"));
  assert.deepEqual(stamp, checkoutStamp, "tarball build stamp must equal the supplied compiled build");
  const deployment = await import(pathToFileURL(path.join(packageRoot, "dist/deployment.js")).href);
  assert.deepEqual(deployment.pluginSourceHashes(packageRoot), manifest.pluginSources,
    "packaged Lua/XML bytes must match the retained qualification manifest");
  const qualification = manifest.runtimeQualification;
  const synthetic = deployment.deploymentStatus(packageRoot, {
    luaVersion: qualification.luaVersion, build: { version: qualification.softwareVersion },
    plugin: { fingerprint: qualification.fingerprints.bridge },
    modules: Object.fromEntries(["hardkeys", "feedback", "control"].map(name =>
      [name, { fingerprint: qualification.fingerprints[name] }])),
  }, stamp.sourceHash);
  assert.equal(synthetic.sourceMatched, true);
  assert.equal(synthetic.state, stamp.sourceHash === manifest.serverSourceHash ? "matches_qualification" : "source_changed");

  const tcpReady = once(tcp, "listening");
  tcp.listen(0, "127.0.0.1"); await tcpReady; tcpListening = true;
  const udpReady = once(udp, "listening");
  udp.bind(0, "127.0.0.1"); await udpReady; udpListening = true;
  const serverEnv = {
    ...environment,
    GMA3_BRIDGE_HOST: "127.0.0.1", GMA3_BRIDGE_PORT: String(tcp.address().port),
    GMA3_OSC_HOST: "127.0.0.1", GMA3_OSC_PORT: String(udp.address().port), GMA3_OSC_DISABLED: "1",
    GMA3_JOB_DIR: path.join(temporary, "jobs"),
    GMA3_HELP_DIR: path.join(temporary, "no-manual"), GMA3_INSTALL_DIR: path.join(temporary, "no-console"),
  };
  transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(packageRoot, "dist/index.js")],
    cwd: packageRoot, env: serverEnv, stderr: "pipe",
  });
  // Consume stderr so a startup diagnostic cannot block a child on an unread pipe.
  transport.stderr?.on("data", () => {});
  client = new Client({ name: "gma3-package-smoke", version: "1.0.0" });
  await withTimeout(client.connect(transport), 15_000, "packaged MCP initialization");
  const names = [], cursors = new Set();
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 15_000 });
    names.push(...page.tools.map(tool => tool.name));
    cursor = page.nextCursor;
    if (cursor) {
      assert.ok(!cursors.has(cursor), "tool listing repeated a cursor");
      cursors.add(cursor);
    }
  } while (cursor);
  assert.equal(names.length, 152, "packaged server tool inventory changed");
  for (const name of ["gma3_cue_settings", "gma3_configure_cue", "gma3_edit_cue_values", "gma3_cue_tracking_action"]) {
    assert.ok(names.includes(name), `missing cue workflow tool ${name}`);
  }
  assert.equal(new Set(names).size, names.length, "packaged server has duplicate tool names");
  for (const name of criticalTools) assert.ok(names.includes(name), `missing critical tool ${name}`);
  await client.close(); client = undefined;
  await transport.close(); transport = undefined;

  const fixtureId = "00000000-0000-4000-8000-000000000001";
  const xml = `<?xml version="1.0"?><GeneralSceneDescription verMajor="1" verMinor="6"><Scene><Layers><Layer uuid="00000000-0000-4000-8000-000000000002" name="Smoke"><ChildList><Fixture uuid="${fixtureId}" name="Synthetic"><Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,6000}</Matrix><FixtureID>101</FixtureID><GDTFSpec>synthetic.gdtf</GDTFSpec><GDTFMode>Mode 1</GDTFMode><Addresses><Address break="0">513</Address></Addresses></Fixture></ChildList></Layer></Layers></Scene></GeneralSceneDescription>`;
  const mvrFile = path.join(temporary, "synthetic.mvr");
  const python = process.platform === "win32" ? "python" : "python3";
  await run(python, ["-I", "-c",
    "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as archive:\n archive.writestr('GeneralSceneDescription.xml', sys.argv[2])\n archive.writestr('synthetic.gdtf', 'package smoke fixture')",
    mvrFile, xml], { env: environment, timeout: 15_000 });
  const mvrSmoke = `const { inspectMvr } = await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, "dist/mvr.js")).href)}); process.stdout.write(JSON.stringify(await inspectMvr(${JSON.stringify(mvrFile)})));`;
  const inspected = await run(process.execPath, ["--input-type=module", "--eval", mvrSmoke], {
    cwd: packageRoot, env: environment, timeout: 20_000, maxBuffer: 1024 * 1024,
  });
  const inventory = JSON.parse(inspected.stdout);
  assert.equal(inventory.version, "1.6"); assert.equal(inventory.objects.length, 2);
  const fixture = inventory.objects.find(object => object.uuid === fixtureId);
  assert.equal(fixture?.fixtureId, "101"); assert.equal(fixture?.addresses[0].address, 513);
  assert.equal(fixture?.worldMatrix[11], 6000);
  assert.match(inventory.archive.sha256, /^[a-f0-9]{64}$/);
  assert.equal(bridgeConnections, 0, "offline discovery attempted to contact a bridge");
  assert.equal(oscPackets, 0, "offline discovery sent OSC packets");
  assert.deepEqual(trapErrors, [], "offline traffic traps reported errors");
  result = {
    ok: true, package: pack.filename, files: files.size, tools: names.length,
    bridgeConnections, oscPackets, sourceHash: stamp.sourceHash,
    pluginSourcesMatched: true, syntheticDeploymentState: synthetic.state,
    mvrInspection: "synthetic archive passed", nativeQualificationPerformed: false,
  };
} finally {
  const cleanupErrors = [];
  for (const close of [
    () => client?.close(), () => transport?.close(),
    () => tcpListening ? new Promise((resolve, reject) => tcp.close(error => error ? reject(error) : resolve())) : undefined,
    () => udpListening ? new Promise(resolve => udp.close(resolve)) : undefined,
  ]) {
    try { await withTimeout(Promise.resolve().then(close), 10_000, "package smoke cleanup"); }
    catch (error) { cleanupErrors.push(error); }
  }
  try { await rm(temporary, { recursive: true, force: true }); }
  catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "package smoke cleanup failed");
}
console.log(JSON.stringify(result));
