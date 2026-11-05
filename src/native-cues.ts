/** Native stored channels and conservative, explicitly scoped tracking reconstruction. */
import { createHash } from "node:crypto";
import { canonicalNativeData, isNativeRawJson } from "./native-fingerprint.js";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export function nativeContentFingerprint(value: unknown): string {
  const ordered = (item: unknown): unknown => isNativeRawJson(item) ? item : Array.isArray(item) ? item.map(ordered) : item !== null && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, ordered(val)])) : item;
  return createHash("sha256").update(JSON.stringify(ordered(canonicalNativeData(value)))).digest("hex");
}
export interface EffectiveNativeCell {
  fixture: string; attribute: string; layer: "absolute" | "relative"; sourceCue: number;
  sourcePart: unknown; value: unknown; stored: RecordValue;
}
export interface NativeReconstruction {
  complete: boolean; scope: string; limitations: string[];
  cues: Array<{ no: number; name: unknown; hard: RecordValue[]; effective: EffectiveNativeCell[] }>;
}
const MAX_EFFECTIVE_CELLS = 1_000_000;
const fixtureOrder = new Intl.Collator(undefined, { numeric: true });
const inactive = (value: unknown) => value === undefined || value === null || value === false || value === 0 || ["", "no", "none", "off", "0", "false", "#ffffffffffffffff"].includes(String(value).toLowerCase());
const partNumber = (value: unknown): number | null => {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 999 ? number : null;
};

/** Older 2.5.1 bridges omit Part.no. Only the verified singleton main-part address can be recovered. */
export function nativePartIdentity(cue: RecordValue, part: RecordValue): number | null {
  if (Object.hasOwn(part, "no")) return partNumber(part.no);
  const explicit = object(part.fields).Part;
  if (explicit !== undefined) return partNumber(explicit);
  if (typeof cue.addr !== "string" || !/^\d+(?:\.\d+)+(?:\.-1)?$/.test(cue.addr) || typeof part.addr !== "string") return null;
  return Array.isArray(cue.parts) && cue.parts.length === 1 && part.addr === `${cue.addr}.0` ? 0 : null;
}

/** MA 2.5.1 Edit/native strings distinguish absolute endpoints from the qualified Unicode delta mode. */
export function parseNativeTrackingDistance(value: unknown): { relative: boolean; milli: number } | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = /^(?:(Δ)\s*\+\s*)?(\d{1,5}(?:\.\d{1,3})?)$/u.exec(String(value).trim());
  if (!match) return null;
  const milli = Math.round(Number(match[2]) * 1000);
  return Number.isSafeInteger(milli) && milli > 0 ? { relative: match[1] !== undefined, milli } : null;
}

/** This reconstructs sequence-owned stored channel layers, not final output across playbacks. */
export function reconstructNativeCues(input: unknown): NativeReconstruction {
  const native = object(input), sequence = object(native.sequence), fields = object(sequence.fields);
  const limitations = new Set<string>();
  if (native.complete !== true) limitations.add("Native content coverage is incomplete.");
  const tracking = fields.Tracking;
  const enabled = tracking === true || /^(yes|on|true)$/i.test(String(tracking));
  const disabled = tracking === false || /^(no|off|false)$/i.test(String(tracking));
  if (!enabled && !disabled) limitations.add("Sequence Tracking is unreadable; effective inheritance cannot be established.");
  type Entry = { cell: EffectiveNativeCell; until?: number };
  let state = new Map<string, Entry[]>();
  const result: NativeReconstruction["cues"] = [];
  let materializedCells = 0;
  let lastCue = -1;
  for (const value of array(native.cues)) {
    const cue = object(value), cueFields = object(cue.fields);
    const no = typeof cue.no === "number" || (typeof cue.no === "string" && /^\d{1,8}$/.test(cue.no)) ? Number(cue.no) : NaN;
    // MA's special OffCue has no numeric No and applies on sequence Off, not in the cue chain.
    if (!Number.isFinite(no) && cue.name === "OffCue") continue;
    if (!Number.isSafeInteger(no) || no < 0 || no > 99999999) { limitations.add("A cue has no readable native cue number."); continue; }
    if (no <= lastCue) { limitations.add("Native cue numbers are duplicated or out of order."); continue; }
    lastCue = no;
    if (disabled || /^(yes|on|true)$/i.test(String(cueFields.Release))) state = new Map();
    else if (!inactive(cueFields.Release)) limitations.add(`Cue ${no} has an unreadable Release setting.`);
    // Distances are inclusive cue-number endpoints. Expired temporary values restore
    // the most recent predecessor whose own distance has not already expired.
    for (const [key, history] of state) {
      const valid = history.filter(entry => entry.until === undefined || entry.until >= no);
      if (valid.length) state.set(key, valid); else state.delete(key);
    }
    // Break and Shield protect later edits by adding actual stored data. Assert
    // affects playback arbitration, not this sequence's owned channel inheritance.
    const hard: RecordValue[] = [], seen = new Map<string, number | undefined>();
    const allowDuplicates = /^(yes|on|true)$/i.test(String(cueFields.AllowDuplicates)) || cueFields.AllowDuplicates === true;
    const parts = array(cue.parts).map(object).sort((a, b) => (nativePartIdentity(cue, a) ?? Infinity) - (nativePartIdentity(cue, b) ?? Infinity));
    const seenParts = new Set<number>();
    for (const partValue of parts) {
      const part = object(partValue), partFields = object(part.fields);
      const partNo = nativePartIdentity(cue, part);
      if (partNo === null || seenParts.has(partNo)) { limitations.add(`Cue ${no} has an unreadable or duplicate part number.`); continue; }
      seenParts.add(partNo);
      const distance = partFields.TrackingDistance ?? cueFields.TrackingDistance;
      let until: number | undefined;
      if (!inactive(distance)) {
        const parsed = parseNativeTrackingDistance(distance);
        if (parsed) {
          until = parsed.relative ? no + parsed.milli : parsed.milli;
          if (until < no || !Number.isSafeInteger(until)) limitations.add(`Cue ${no} part ${part.no} has an invalid tracking-distance endpoint.`);
        } else limitations.add(`Cue ${no} part ${part.no} uses an unqualified tracking-distance format: ${String(distance)}.`);
      }
      let content: RecordValue;
      try { content = object(JSON.parse(String(part.contentJson))); }
      catch { limitations.add(`Cue ${no} has unreadable encoded part content.`); continue; }
      if (content.byFixtures !== true || content.truncated !== false || !Array.isArray(content.rows)) {
        limitations.add(`Cue ${no} part ${part.no} has incomplete normalized channels.`); continue;
      }
      for (const rowValue of content.rows) {
        const row = object(rowValue);
        if (typeof row.fixture !== "string" || typeof row.attribute !== "string") { limitations.add(`Cue ${no} has an unmapped channel.`); continue; }
        hard.push({ ...row, part: partNo });
        for (const layer of ["absolute", "relative"] as const) {
          if (row[layer === "absolute" ? "hasAbsolute" : "hasRelative"] !== true) continue;
          const key = `${row.fixture}\0${row.attribute}\0${layer}`;
          if (seen.has(key) && !allowDuplicates) limitations.add(`Cue ${no} stores the same channel layer in multiple parts without confirmed AllowDuplicates.`);
          if (seen.has(key) && (until !== undefined || seen.get(key) !== undefined)) limitations.add(`Cue ${no} combines duplicate part layers with tracking distances; expiry precedence is not qualified.`);
          seen.set(key, until);
          const steps = array(row.steps);
          const storedValue = steps.length ? steps.map(s => object(s)[layer === "absolute" ? "absoluteKind" : "relativeKind"] === "release" ? "release" : object(s)[layer] ?? null) : row[layer === "absolute" ? "valueKind" : "relativeKind"] === "release" ? "release" : row[layer === "absolute" ? "value" : "relative"];
          if (storedValue === undefined) limitations.add(`Cue ${no} ${row.fixture} ${row.attribute} has an unreadable ${layer} value.`);
          const cell = { fixture: row.fixture, attribute: row.attribute, layer, sourceCue: no, sourcePart: partNo, value: storedValue ?? null, stored: row };
          state.set(key, until === undefined ? [{ cell }] : [...(state.get(key) ?? []), { cell, until }]);
        }
      }
    }
    if (state.size > MAX_EFFECTIVE_CELLS - materializedCells) {
      limitations.add(`Effective cue data exceeds ${MAX_EFFECTIVE_CELLS} materialized cells. Narrow the sequence scope.`);
      break;
    }
    materializedCells += state.size;
    result.push({ no, name: cue.name, hard, effective: [...state.values()].map(history => ({ ...history[history.length - 1].cell })).sort((a, b) => fixtureOrder.compare(a.fixture, b.fixture) || a.attribute.localeCompare(b.attribute) || a.layer.localeCompare(b.layer)) });
  }
  return { complete: limitations.size === 0, scope: "sequence-owned stored absolute/relative channel layers, including phaser steps and preset links; qualified absolute and delta tracking distances, cue Release and confirmed highest-part precedence are applied; future edit protection and playback arbitration are outside scope; omitted channels and playback defaults are not invented", limitations: [...limitations], cues: result };
}
