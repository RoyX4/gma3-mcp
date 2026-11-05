import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploymentStatus, pluginSourceHashes } from "../src/deployment.ts";

test("deployment distinguishes imported bytecode identity, source files and platform qualification", () => {
  const root = mkdtempSync(join(tmpdir(), "gma3-deployment-")); mkdirSync(join(root, "plugin"));
  for (const name of ["bridge.lua", "hardkeys.lua", "feedback.lua", "control.lua", "bridge.xml"]) writeFileSync(join(root, "plugin", `gma3_mcp_${name}`), name);
  const ping = { luaVersion: "Lua 5.5", build: { version: "2.5.1.1" }, plugin: { fingerprint: "bridge-native" }, modules: { hardkeys: { fingerprint: "keys" }, feedback: { fingerprint: "feedback" }, control: { fingerprint: "control" } } };
  try {
    assert.equal(deploymentStatus(root, ping, "server").state, "observed_unqualified");
    writeFileSync(join(root, "deployment.json"), JSON.stringify({ schemaVersion: 1, serverSourceHash: "server", pluginSources: pluginSourceHashes(root), runtimeQualification: { luaVersion: "Lua 5.5", softwareVersion: "2.5.1.1", fingerprints: { bridge: "bridge-native", hardkeys: "keys", feedback: "feedback", control: "control" } } }));
    assert.equal(deploymentStatus(root, ping, "server").state, "matches_qualification");
    assert.equal(deploymentStatus(root, { ...ping, plugin: { fingerprint: "older-import" } }, "server").state, "runtime_differs");
    assert.equal(deploymentStatus(root, { ...ping, luaVersion: "Lua 5.4" }, "server").state, "unqualified_platform");
    writeFileSync(join(root, "plugin", "gma3_mcp_bridge.lua"), "changed source");
    assert.equal(deploymentStatus(root, ping, "server").state, "source_changed");
  } finally { rmSync(root, { recursive: true }); }
});

test("valid JSON with an invalid manifest shape never throws or qualifies", () => {
  const root = mkdtempSync(join(tmpdir(), "gma3-deployment-invalid-")); mkdirSync(join(root, "plugin"));
  for (const name of ["bridge.lua", "hardkeys.lua", "feedback.lua", "control.lua", "bridge.xml"]) writeFileSync(join(root,"plugin",`gma3_mcp_${name}`),name);
  const ping={luaVersion:"Lua 5.5",build:{version:"2.5.1.1"},plugin:{fingerprint:"b"},modules:{hardkeys:{fingerprint:"h"},feedback:{fingerprint:"f"},control:{fingerprint:"c"}}};
  try {
    for (const value of [null,[],false,"manifest",{schemaVersion:1,runtimeQualification:null}]) {
      writeFileSync(join(root,"deployment.json"),JSON.stringify(value));
      assert.doesNotThrow(()=>deploymentStatus(root,ping,"server"));
      assert.equal(deploymentStatus(root,ping,"server").state,"unverified");
    }
  } finally {rmSync(root,{recursive:true});}
});

test("missing running hash is unavailable evidence and missing platform metadata cannot qualify", () => {
  const root = mkdtempSync(join(tmpdir(), "gma3-deployment-evidence-")); mkdirSync(join(root, "plugin"));
  for (const name of ["bridge.lua", "hardkeys.lua", "feedback.lua", "control.lua", "bridge.xml"]) writeFileSync(join(root,"plugin",`gma3_mcp_${name}`),name);
  const ping={luaVersion:"Lua 5.5",build:{version:"2.5.1.1"},plugin:{fingerprint:"b"},modules:{hardkeys:{fingerprint:"h"},feedback:{fingerprint:"f"},control:{fingerprint:"c"}}};
  const manifest={schemaVersion:1,serverSourceHash:"server",pluginSources:pluginSourceHashes(root),runtimeQualification:{luaVersion:"Lua 5.5",softwareVersion:"2.5.1.1",fingerprints:{bridge:"b",hardkeys:"h",feedback:"f",control:"c"}}};
  try {
    writeFileSync(join(root,"deployment.json"),JSON.stringify(manifest));
    const unknownHash=deploymentStatus(root,ping,undefined);
    assert.equal(unknownHash.state,"unverified");
    assert.equal(unknownHash.serverMatched,null);
    assert.equal(deploymentStatus(root,{...ping,luaVersion:undefined,build:{}},"server").state,"unverified");
    writeFileSync(join(root,"deployment.json"),JSON.stringify({...manifest,runtimeQualification:{...manifest.runtimeQualification,luaVersion:null,softwareVersion:null}}));
    assert.equal(deploymentStatus(root,{...ping,luaVersion:null,build:{}},"server").state,"unverified");
    assert.doesNotThrow(()=>deploymentStatus(root,null as any,"server"));
  } finally {rmSync(root,{recursive:true});}
});
