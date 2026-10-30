import type { Gma3Bridge } from "../bridge.js";
import { unavailable, type Verification } from "../results.js";
export interface ReleaseSpec { attribute: string; layer: "absolute" | "relative" }

/** Native 2.5.1.1 qualification: activeValue bit2=absolute, bit4=relative; native abs_release/rel_release flags
 * are projected to valueKind/relativeKind. Numeric 6600 is retained as raw data and is never guessed as release here. */
export async function verifyReleases(bridge: Gma3Bridge, fixtures: string, releases: ReleaseSpec[], timeoutMs: number): Promise<Verification> {
  const checked = `active stored-release intent on ${fixtures}: ${releases.map((r) => `${r.attribute} ${r.layer}`).join(", ")}`;
  try {
    const scan = await bridge.request<Record<string, any>>("programmer", { scope: "fixtures", fixtures, attributes: [...new Set(releases.map((r) => r.attribute))], limit: 5000, maxChannels: 50000 }, timeoutMs);
    if (scan.coverage?.complete !== true || scan.fixturesTruncated || !Array.isArray(scan.rows) || !Array.isArray(scan.scannedFixtures) || scan.total !== scan.rows.length) return unavailable("complete native fixture/attribute coverage is required for release verification", checked);
    const problems: string[] = [], unknown: string[] = [];
    const roots = new Set<string>(scan.scannedFixtures.map((f: any) => String(f.rootFid ?? f.fid ?? f.subfixtureIndex)));
    if (!roots.size) return unavailable("release target has no readable fixtures", checked);
    for (const release of releases) for (const root of roots) {
      const targets = scan.scannedFixtures.filter((f: any) => String(f.rootFid ?? f.fid ?? f.subfixtureIndex) === root && Array.isArray(f.attributes) && f.attributes.some((a: string) => a.toLowerCase() === release.attribute.toLowerCase()));
      if (!targets.length) { problems.push(`Fixture ${root} has no readable ${release.attribute} on itself or its cells`); continue; }
      for (const target of targets) {
        const row = scan.rows.find((r: any) => r.subfixtureIndex === target.subfixtureIndex && String(r.attribute).toLowerCase() === release.attribute.toLowerCase());
        const where = `Fixture ${root} subfixture ${target.subfixtureIndex} ${release.attribute} ${release.layer}`;
        if (!row) { problems.push(`${where}: release is missing`); continue; }
        if (typeof row.masks?.activeValue !== "number") { unknown.push(`${where}: active layer mask is unreadable`); continue; }
        const bit = release.layer === "absolute" ? 2 : 4;
        if ((row.masks.activeValue & bit) !== bit) { problems.push(`${where}: the requested layer is inactive (an old value is not proof)`); continue; }
        const kind = row[release.layer === "absolute" ? "valueKind" : "relativeKind"] ?? row.steps?.[0]?.[release.layer === "absolute" ? "absoluteKind" : "relativeKind"];
        if (kind === undefined) { unknown.push(`${where}: native release marker is unavailable; numeric special values are not guessed`); continue; }
        if (kind !== "release" || row.stepCount !== 1) problems.push(`${where}: native release marker/one-step state did not match`);
      }
    }
    if (problems.length) return { status: "mismatched", checked, detail: problems.join("; ") };
    if (unknown.length) return unavailable(unknown.join("; "), checked);
    return { status: "matched", checked };
  } catch (err) { return unavailable(err instanceof Error ? err.message : String(err), checked); }
}
