import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute, extname } from "node:path";
import { promisify } from "node:util";
export interface MvrObject {
  uuid: string;
  kind: string;
  name: string;
  parent: string | null;
  matrix: number[];
  worldMatrix: number[];
  fixtureId: string;
  gdtfSpec: string;
  gdtfMode: string;
  addresses: Array<{
    break: number;
    address: number;
  }>;
  geometryHash: string | null;
}
export interface MvrAsset {
  name: string;
  bytes: number;
  /** SHA-256 of the exact compressed asset file, including container metadata. */
  sha256: string;
  /** Present only when every bounded nested GDTF ZIP member was safely read. */
  contentHashKind?: "zip-members-sha256-v1";
  contentSha256?: string;
  contentHashUnavailable?: string;
}
/** Content identity for inspected GDTF packages; legacy/opaque assets retain exact raw identity. */
export function mvrAssetIdentity(asset: MvrAsset): string {
  if (asset.contentHashKind === "zip-members-sha256-v1") {
    if (typeof asset.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.contentSha256)) throw new Error("GDTF semantic asset identity is incomplete");
    return asset.contentSha256;
  }
  return asset.sha256;
}
export interface MvrInventory {
  version: string;
  archive: {
    file: string;
    bytes: number;
    sha256: string;
    members: number;
  };
  objects: MvrObject[];
  assets: MvrAsset[];
  fixtureIdConflicts: Record<string, string[]>;
  units: Record<string, string>;
}
const run = promisify(execFile);
/** Python's stdlib parses the archive and XML; no shell, ZIP extraction or console requests. */
export async function inspectMvr(file: string): Promise<MvrInventory> {
  if (!isAbsolute(file) || extname(file).toLowerCase() !== ".mvr")
    throw new Error("file must be an absolute path to a .mvr file");
  const python = process.env.GMA3_MVR_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
  if (!python || /[\x00\r\n]/.test(python)) throw new Error("GMA3_MVR_PYTHON must name one Python 3 executable");
  try {
    const { stdout } = await run(
      python,
      ["-I", fileURLToPath(new URL("../scripts/mvr-inspect.py", import.meta.url)), file],
      {
        timeout: 15000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
    );
    return JSON.parse(stdout) as MvrInventory;
  } catch (error) {
    const err = error as Error & {
      code?: string;
      stderr?: string;
    };
    throw new Error(
      err.code === "ENOENT"
        ? "Local MVR inspection requires Python 3; set GMA3_MVR_PYTHON to its executable path"
        : err.stderr?.trim() || err.message,
    );
  }
}
const same = (a: unknown, b: unknown): boolean => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-6;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
  return JSON.stringify(a) === JSON.stringify(b);
};
/** Identity is UUID, never name or fixture number. Differences are a review plan, not an import. */
export function compareMvr(before: MvrInventory, after: MvrInventory) {
  const old = new Map(before.objects.map((o) => [o.uuid, o])),
    next = new Map(after.objects.map((o) => [o.uuid, o]));
  const added = after.objects.filter((o) => !old.has(o.uuid)),
    removed = before.objects.filter((o) => !next.has(o.uuid));
  const changed = after.objects.flatMap((o) => {
    const prior = old.get(o.uuid);
    if (!prior) return [];
    const fields = (Object.keys(o) as Array<keyof MvrObject>).filter((k) => k !== "uuid" && !same(prior[k], o[k]));
    return fields.length ? [{ uuid: o.uuid, name: o.name, kind: o.kind, fields, before: prior, after: o }] : [];
  });
  const oldAssets = new Map(before.assets.map((a) => [a.name, a])),
    newAssets = new Map(after.assets.map((a) => [a.name, a]));
  const assets = {
    added: after.assets.filter((a) => !oldAssets.has(a.name)).map((a) => a.name),
    removed: before.assets.filter((a) => !newAssets.has(a.name)).map((a) => a.name),
    changed: after.assets
      .filter((a) => oldAssets.has(a.name) && mvrAssetIdentity(oldAssets.get(a.name)!) !== mvrAssetIdentity(a))
      .map((a) => a.name),
    containerChanged: after.assets.filter((a) => oldAssets.has(a.name) && oldAssets.get(a.name)!.sha256 !== a.sha256).map((a) => a.name),
  };
  return {
    added,
    removed,
    changed,
    assets,
    unchanged: after.objects.length - added.length - changed.length,
    requiresIdentityReview:
      removed.length > 0 ||
      changed.some((o) =>
        o.fields.some((k) => ["fixtureId", "gdtfSpec", "gdtfMode", "kind", "addresses"].includes(k)),
      ) ||
      Object.keys(after.fixtureIdConflicts).length > 0,
    fixtureIdConflicts: after.fixtureIdConflicts,
  };
}
