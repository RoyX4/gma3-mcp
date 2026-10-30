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
const inactive = (value: unknown) => value === undefined || value === null || value === false || value === 0 || ["", "no", "none", "off", "0", "false", "#ffffffffffffffff"].includes(String(value).toLowerCase());

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
  for (const value of array(native.cues)) {
    const cue = object(value), cueFields = object(cue.fields);
    const no = cue.no === undefined || cue.no === null || cue.no === "" ? NaN : Number(cue.no);
    // MA's special OffCue has no numeric No and applies on sequence Off, not in the cue chain.
    if (!Number.isFinite(no) && cue.name === "OffCue") continue;
    if (!Number.isFinite(no)) { limitations.add("A cue has no readable native cue number."); continue; }
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
    const hard: RecordValue[] = [], seen = new Set<string>();
    for (const partValue of array(cue.parts)) {
      const part = object(partValue), partFields = object(part.fields);
      const distance = partFields.TrackingDistance ?? cueFields.TrackingDistance;
      let until: number | undefined;
      if (!inactive(distance)) {
        if (/^\d+(?:\.\d{1,3})?$/.test(String(distance).trim())) {
          until = Math.round(Number(distance) * 1000);
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
        hard.push({ ...row, part: part.no });
        for (const layer of ["absolute", "relative"] as const) {
          if (row[layer === "absolute" ? "hasAbsolute" : "hasRelative"] !== true) continue;
          const key = `${row.fixture}\0${row.attribute}\0${layer}`;
          if (seen.has(key)) limitations.add(`Cue ${no} stores the same channel layer in multiple parts; precedence is not inferred.`);
          seen.add(key);
          const steps = array(row.steps);
          const storedValue = steps.length ? steps.map(s => object(s)[layer === "absolute" ? "absoluteKind" : "relativeKind"] === "release" ? "release" : object(s)[layer] ?? null) : row[layer === "absolute" ? "valueKind" : "relativeKind"] === "release" ? "release" : row[layer === "absolute" ? "value" : "relative"];
          if (storedValue === undefined) limitations.add(`Cue ${no} ${row.fixture} ${row.attribute} has an unreadable ${layer} value.`);
          const cell = { fixture: row.fixture, attribute: row.attribute, layer, sourceCue: no, sourcePart: part.no, value: storedValue ?? null, stored: row };
          state.set(key, until === undefined ? [{ cell }] : [...(state.get(key) ?? []), { cell, until }]);
        }
      }
    }
    result.push({ no, name: cue.name, hard, effective: [...state.values()].map(history => ({ ...history[history.length - 1].cell })).sort((a, b) => a.fixture.localeCompare(b.fixture, undefined, { numeric: true }) || a.attribute.localeCompare(b.attribute) || a.layer.localeCompare(b.layer)) });
  }
  return { complete: limitations.size === 0, scope: "sequence-owned stored absolute/relative channel layers, including phaser steps and preset links; numeric part tracking-distance endpoints and cue Release are applied; future edit protection and playback arbitration are outside scope; omitted channels and playback defaults are not invented", limitations: [...limitations], cues: result };
}
