import { z } from "zod";
import {mvrAssetIdentity,type MvrInventory,type MvrObject} from "./mvr.js";
import { nativeContentFingerprint } from "./native-cues.js";
import type { Verification } from "./results.js";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform((v) => v.toLowerCase());
export const mvrDecisionSchema = z.object({ uuid, source: z.enum(["local", "incoming", "omit"]), patch: z.enum(["local", "incoming"]).optional(), transform: z.enum(["local", "incoming"]).optional() }).strict();
export type MvrDecision = z.infer<typeof mvrDecisionSchema>;
export interface MvrImportPlan {
  version: 1; beforeSha256: string; incomingSha256: string; fingerprint: string; decisions: MvrDecision[];
  expectedFixtures: Array<MvrObject & { typeAssetSha256?: string; typeAssetHashKind?: string; typeSource: "local" | "incoming" }>;
  added: string[]; removed: string[]; changed: Array<{ uuid: string; fields: string[] }>;
  executable: boolean; errors: string[]; warnings: string[];
}
const id = (fixture: MvrObject) => fixture.uuid.toLowerCase();
const asset = (inventory: MvrInventory, name: string) => inventory.assets.find((a) => a.name.toLowerCase() === name.toLowerCase());
const fixtures = (inventory: MvrInventory) => new Map(inventory.objects.filter((o) => o.kind === "Fixture").map((o) => [id(o), o]));
const equal = (a: unknown, b: unknown) => nativeContentFingerprint(a) === nativeContentFingerprint(b);

/** Concrete per-UUID desired result. No native PSR mutation or guessed grid selection is performed here. */
export function planMvrImport(before: MvrInventory, incoming: MvrInventory, rawDecisions: unknown): MvrImportPlan {
  const decisions = z.array(mvrDecisionSchema).max(5000).parse(rawDecisions), local = fixtures(before), next = fixtures(incoming);
  const selected = new Map<string, MvrDecision>();
  for (const decision of decisions) {
    if (selected.has(decision.uuid)) throw new Error(`duplicate UUID decision ${decision.uuid}`);
    if (!local.has(decision.uuid) && !next.has(decision.uuid)) throw new Error(`UUID ${decision.uuid} is absent from both inspected MVR inventories`);
    if (decision.source === "omit" && (decision.patch || decision.transform)) throw new Error(`omitted UUID ${decision.uuid} cannot choose patch or transform`);
    selected.set(decision.uuid, decision);
  }
  const expectedFixtures: MvrImportPlan["expectedFixtures"] = [], errors: string[] = [], warnings: string[] = [];
  for (const key of [...new Set([...local.keys(), ...next.keys()])].sort()) {
    const decision = selected.get(key) ?? { uuid: key, source: local.has(key) ? "local" as const : "omit" as const };
    if (decision.source === "omit") continue;
    const get = (source: "local" | "incoming", property: string) => {
      const found = (source === "local" ? local : next).get(key);
      if (!found) throw new Error(`UUID ${key}: no ${source} fixture exists for ${property}`);
      return found;
    };
    const base = get(decision.source, "identity/type"), patch = get(decision.patch ?? decision.source, "patch"), transform = get(decision.transform ?? decision.source, "transform");
    const typeAsset=asset(decision.source === "local" ? before : incoming, base.gdtfSpec);
    const typeAssetSha256=typeAsset?mvrAssetIdentity(typeAsset):undefined;
    if (decision.source === "incoming" && (!base.gdtfSpec || !typeAssetSha256)) errors.push(`UUID ${key}: incoming type has no inspected embedded GDTF asset; unresolved fixture types are not silently imported`);
    if (decision.source === "incoming" && !base.gdtfMode.trim()) errors.push(`UUID ${key}: incoming type has no explicit GDTF mode; a native default is not guessed`);
    if (new Set(patch.addresses.map((address) => address.break)).size !== patch.addresses.length) errors.push(`UUID ${key}: selected DMX patch contains more than one address for the same break`);
    if (!typeAssetSha256) warnings.push(`UUID ${key}: MVR does not independently prove the selected local native fixture type; native type read-back is required`);
    expectedFixtures.push({ ...base, uuid: key, addresses: structuredClone(patch.addresses), matrix: [...transform.matrix], worldMatrix: [...transform.worldMatrix], ...(typeAssetSha256 ? { typeAssetSha256,typeAssetHashKind:typeAsset?.contentHashKind??"raw-sha256" } : {}), typeSource: decision.source });
  }
  const fids = new Map<string, string>();
  for (const fixture of expectedFixtures) {
    if (!fixture.fixtureId) { errors.push(`UUID ${fixture.uuid}: expected fixture has no FID`); continue; }
    const duplicate = fids.get(fixture.fixtureId);
    if (duplicate) errors.push(`FID ${fixture.fixtureId} would belong to UUIDs ${duplicate} and ${fixture.uuid}`);
    fids.set(fixture.fixtureId, fixture.uuid);
  }
  const expected = new Map(expectedFixtures.map((f) => [f.uuid, f]));
  const added = [...expected.keys()].filter((key) => !local.has(key)), removed = [...local.keys()].filter((key) => !expected.has(key));
  const changed = expectedFixtures.flatMap((fixture) => {
    const previous = local.get(fixture.uuid);
    if (!previous) return [];
    const fields = (["fixtureId", "name", "gdtfSpec", "gdtfMode", "addresses", "worldMatrix", "geometryHash"] as const).filter((key) => !equal(previous[key], fixture[key]));
    return fields.length ? [{ uuid: fixture.uuid, fields }] : [];
  });
  const payload = { version: 1 as const, beforeSha256: before.archive.sha256, incomingSha256: incoming.archive.sha256, decisions: [...decisions].sort((a, b) => a.uuid.localeCompare(b.uuid)), expectedFixtures, added, removed, changed, executable: errors.length === 0, errors, warnings };
  return { ...payload, fingerprint: nativeContentFingerprint(payload) };
}

/** Use a freshly observed native MVR export, never a historical plan, as the supplied actual inventory. */
export function verifyMvrImport(plan: MvrImportPlan, actual: MvrInventory): Verification {
  if (!plan.executable) return { status: "unavailable", checked: "MVR import decision validity", detail: `The decision plan is invalid: ${plan.errors.join("; ")}` };
  const observed = fixtures(actual), wanted = new Set(plan.expectedFixtures.map((f) => f.uuid));
  const problems: string[] = [], unavailable: string[] = [];
  for (const key of observed.keys()) if (!wanted.has(key)) problems.push(`unexpected fixture UUID ${key}`);
  for (const expected of plan.expectedFixtures) {
    const got = observed.get(expected.uuid);
    if (!got) { problems.push(`missing fixture UUID ${expected.uuid}`); continue; }
    for (const key of ["fixtureId", "name", "gdtfMode"] as const) if (got[key] !== expected[key]) problems.push(`${expected.uuid}: ${key} ${JSON.stringify(got[key])}, expected ${JSON.stringify(expected[key])}`);
    if (got.geometryHash !== expected.geometryHash) problems.push(`${expected.uuid}: attached fixture geometry references differ`);
    if (!equal([...got.addresses].sort((a, b) => a.break - b.break), [...expected.addresses].sort((a, b) => a.break - b.break))) problems.push(`${expected.uuid}: DMX break/address mapping differs`);
    if (got.worldMatrix.length !== 12 || expected.worldMatrix.length !== 12 || got.worldMatrix.some((n, i) => !Number.isFinite(n) || Math.abs(n - expected.worldMatrix[i]) > (i % 4 === 3 ? 0.01 : 0.000001))) problems.push(`${expected.uuid}: inherited world transform differs (0.01 mm translation / 0.000001 basis tolerance)`);
    const observedAsset=asset(actual,got.gdtfSpec);
    const actualAsset=observedAsset?(expected.typeAssetHashKind==="zip-members-sha256-v1"?mvrAssetIdentity(observedAsset):observedAsset.sha256):undefined;
    if (!expected.gdtfMode) unavailable.push(`${expected.uuid}: expected GDTF mode is unavailable`);
    if (!expected.typeAssetSha256 || !actualAsset) unavailable.push(`${expected.uuid}: embedded GDTF identity is unavailable; native type/mode proof is required`);
    else if (actualAsset !== expected.typeAssetSha256) problems.push(`${expected.uuid}: GDTF asset identity differs`);
  }
  return { status: problems.length ? "mismatched" : unavailable.length ? "unavailable" : "matched", checked: "observed MVR fixture UUIDs, FIDs/names, GDTF identity/mode, DMX break addresses, geometry references and inherited world transforms", expected: { fixtures: plan.expectedFixtures.length, removed: plan.removed }, actual: { fixtures: observed.size, problems, unavailable }, ...(problems.length || unavailable.length ? { detail: [...problems, ...unavailable].join("; ") } : {}) };
}
