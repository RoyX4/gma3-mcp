#!/usr/bin/env node
// One explicit named route, one maintained release, no app launch and no mutation replay.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseInstanceProfile, namespaceReceipt, verifyInsideNamespace, instanceProfileDigest } from "../dist/instances.js";

const root = path.resolve(import.meta.dirname, "..");
const [configPath, name, mode = "session", inside] = process.argv.slice(2);
if (!configPath || !name || !path.isAbsolute(configPath) || !["session", "mcp"].includes(mode) || (inside && inside !== "--inside")) {
  throw new Error("Usage: mcp-instance.mjs /absolute/instances.json name [session|mcp]");
}
const profile = parseInstanceProfile(JSON.parse(readFileSync(configPath, "utf8")), name);
const digest = instanceProfileDigest(profile), receipt = namespaceReceipt(profile);
const environment = { ...process.env, GMA3_INSTANCE_NAME: name, GMA3_INSTANCE_PROFILE_DIGEST: digest };
let command = process.execPath, args;
if (receipt && inside !== "--inside") {
  command = "/usr/bin/nsenter";
  args = ["--target", String(receipt.pid), "--user", "--net", "--preserve-credentials", process.execPath, fileURLToPath(import.meta.url), configPath, name, mode, "--inside"];
} else {
  if (inside && process.env.GMA3_INSTANCE_PROFILE_DIGEST !== digest) throw new Error("Instance profile changed during namespace entry");
  verifyInsideNamespace(profile);
  for (const key of ["GMA3_BRIDGE_HOST", "GMA3_BRIDGE_PORT", "GMA3_EXPECTED_STATION", "GMA3_EXPECTED_SHOWS", "GMA3_INSTALL_DIR", "GMA3_LOCAL_UI_HELPER", "GMA3_SESSION_SOURCE"]) delete environment[key];
  Object.assign(environment, { GMA3_BRIDGE_HOST: profile.host, GMA3_BRIDGE_PORT: String(profile.port), GMA3_EXPECTED_STATION: profile.station, GMA3_EXPECTED_SHOWS: JSON.stringify(profile.shows), GMA3_SESSION_SOURCE: "0", GMA3_OSC_DISABLED: "1",
    ...(profile.install_dir ? { GMA3_INSTALL_DIR: profile.install_dir } : {}), ...(profile.local_ui_helper ? { GMA3_LOCAL_UI_HELPER: profile.local_ui_helper } : {}) });
  args = [path.join(root, mode === "mcp" ? "dist/index.js" : "scripts/mcp-session.mjs")];
}
const child = spawn(command, args, { cwd: root, env: environment, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
