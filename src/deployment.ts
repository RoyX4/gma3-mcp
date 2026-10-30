import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const components = ["bridge", "hardkeys", "feedback", "control"] as const;
const pluginFiles = [...components.map(component => `gma3_mcp_${component}.lua`), "gma3_mcp_bridge.xml"];
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const text = z.string().trim().min(1);
const manifestSchema = z.object({
  schemaVersion: z.literal(1), serverSourceHash: text,
  pluginSources: z.record(z.string(), text), release: z.unknown().optional(),
  runtimeQualification: z.object({
    luaVersion: text, softwareVersion: text,
    fingerprints: z.object({bridge:text,hardkeys:text,feedback:text,control:text}).passthrough(),
  }).passthrough(),
}).passthrough();
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const knownText = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

export function pluginSourceHashes(root: string): Record<string, string> {
  return Object.fromEntries(pluginFiles.map(name => [name, sha(readFileSync(join(root, "plugin", name)))]));
}

/** Evidence availability is separate from equality: unknown values can never qualify or prove a change. */
export function deploymentStatus(root: string, ping: unknown, serverSourceHash?: string | null) {
  const response = record(ping), modules = record(response.modules);
  const fingerprints: Record<string, string | null> = {bridge:knownText(record(response.plugin).fingerprint)};
  for (const component of components.filter(c => c !== "bridge")) fingerprints[component] = knownText(record(modules[component]).fingerprint);
  const observed = {luaVersion:knownText(response.luaVersion),softwareVersion:knownText(record(response.build).version),fingerprints};
  let source: Record<string, string>;
  try {source = pluginSourceHashes(root);}
  catch (error) {return {state:"unverified",observed,reason:`Local plugin source could not be hashed: ${error instanceof Error ? error.message : String(error)}`};}
  let input: unknown;
  try {input = JSON.parse(readFileSync(join(root,"deployment.json"),"utf8"));}
  catch (error) {
    const missing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
    return {state:missing ? "observed_unqualified":"unverified",source,observed,reason:missing ? "Runtime fingerprints are observed separately from the Node build. No native qualification manifest is installed for comparison." : `Deployment manifest could not be read or parsed: ${error instanceof Error ? error.message : String(error)}`};
  }
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success || !pluginFiles.every(name => parsed.data?.pluginSources[name])) return {state:"unverified",source,observed,reason:"Deployment manifest is incomplete or unsupported; nonempty versions, all source hashes and all runtime fingerprints are required."};
  const manifest = parsed.data, expected = manifest.runtimeQualification;
  const runningHash = knownText(serverSourceHash);
  const sourceMatched = Object.entries(source).every(([name,hash]) => manifest.pluginSources[name] === hash);
  const serverMatched = runningHash === null ? null : runningHash === manifest.serverSourceHash;
  const platformMatched = observed.luaVersion === null || observed.softwareVersion === null ? null : observed.luaVersion === expected.luaVersion && observed.softwareVersion === expected.softwareVersion;
  const runtimeMatched = components.some(c => observed.fingerprints[c] === null) ? null : components.every(c => observed.fingerprints[c] === expected.fingerprints[c]);
  const unavailable = [ ...(serverMatched === null ? ["running server source hash"] : []), ...(platformMatched === null ? ["native Lua/software version"] : []), ...(runtimeMatched === null ? ["imported component fingerprint"] : []) ];
  const state = !sourceMatched || serverMatched === false ? "source_changed" : unavailable.length ? "unverified" : platformMatched === false ? "unqualified_platform" : runtimeMatched ? "matches_qualification" : "runtime_differs";
  return {state,release:manifest.release,sourceMatched,serverMatched,platformMatched,runtimeMatched,source,observed,
    ...(unavailable.length ? {unavailable,reason:`Qualification cannot be established without ${unavailable.join(", ")}.`} : {}),
    note:"Runtime identities hash the actual imported Lua bytecode. They are VM-specific non-cryptographic change detectors, distinct from source SHA-256 and Node build status."};
}
