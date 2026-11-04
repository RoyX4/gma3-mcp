/** Conservative sequence-owned impact, separate from winning stage output. */
import { nativeContentFingerprint, nativePartIdentity, parseNativeTrackingDistance, reconstructNativeCues, type EffectiveNativeCell } from "./native-cues.js";
import { parseConsoleBoolean, type Verification } from "./results.js";

type Row = Record<string, unknown>;
const obj = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
export interface RangeAttribute { attribute: string; layer: "absolute" | "relative" }
export interface RangeValue extends RangeAttribute { value: number }
export type RangeTracking = "tracking_forward" | "cue_only";
export const matchesFixture = (fixture: string, ids: string[]) => ids.some(id => fixture === id || fixture.startsWith(id + "."));
const scoped = (cell: Pick<EffectiveNativeCell, "fixture" | "attribute" | "layer">, ids: string[], attributes: RangeAttribute[]) =>
  matchesFixture(cell.fixture, ids) && attributes.some(a => a.attribute.toLowerCase() === cell.attribute.toLowerCase() && a.layer === cell.layer);
const key = (cell: Pick<EffectiveNativeCell, "fixture" | "attribute" | "layer">) => `${cell.fixture}\0${cell.attribute.toLowerCase()}\0${cell.layer}`;
const activeBreak = (value: unknown) => value !== undefined && value !== null && !["", "#ffffffffffffffff", "none", "no", "false", "0"].includes(String(value).toLowerCase());

export function planCueRangeImpact(native: unknown, selected: number[], fixtures: string[], attributes: RangeAttribute[], tracking: RangeTracking, part: number) {
  const reconstructed = reconstructNativeCues(native), cues = reconstructed.cues.filter(c => c.no > 0);
  const selectedNative = new Set(selected.map(c => Math.round(c * 1000))), affected = new Set<number>(), restorations = new Set<number>();
  const limitations = new Set(reconstructed.limitations), rawCues = new Map(list(obj(native).cues).map(v => [obj(v).no, obj(v)]));
  const candidates = new Set(fixtures.flatMap(fixture => attributes.map(attribute => key({ fixture, ...attribute }))));
  for (const cue of cues) for (const cell of cue.effective) if (scoped(cell, fixtures, attributes)) candidates.add(key(cell));
  const active = new Map<string, number>();
  const trackingEnabled = parseConsoleBoolean(obj(obj(obj(native).sequence).fields).Tracking) === true;
  for (const number of selectedNative) if (!rawCues.has(number)) limitations.add(`Requested Cue ${number / 1000} is missing.`);
  for (const [index, cue] of cues.entries()) {
    const raw = rawCues.get(cue.no) ?? {}, fields = obj(raw.fields);
    const parts = new Map(list(raw.parts).map(obj).map(p => [nativePartIdentity(raw, p), p]));
    const chosen = selectedNative.has(cue.no);
    if (parseConsoleBoolean(fields.Release) === true) active.clear();
    for (const [channel, until] of active) if (until < cue.no) active.delete(channel);
    if (tracking === "tracking_forward" && active.size && activeBreak(fields.Break)) limitations.add(`Cue ${cue.no / 1000} has native Break protection with unqualified filter/world impact.`);
    const otherParts = new Map<string, number>();
    for (const hard of cue.hard) for (const layer of ["absolute", "relative"] as const) {
      if (hard[layer === "absolute" ? "hasAbsolute" : "hasRelative"] !== true) continue;
      const channel = key({ fixture: String(hard.fixture), attribute: String(hard.attribute), layer });
      const distance = parseNativeTrackingDistance(obj(parts.get(Number(hard.part))?.fields).TrackingDistance ?? fields.TrackingDistance);
      // A temporary override can expire and reveal the edited predecessor again. Keep that
      // channel among the conservative candidates until a permanent stored value takes over.
      if (!distance) active.delete(channel);
      if (chosen && hard.part !== part && candidates.has(channel)) otherParts.set(channel, Math.max(otherParts.get(channel) ?? 0, Number(hard.part)));
    }
    if (!chosen) {
      if (tracking === "tracking_forward" && active.size) affected.add(cue.no / 1000);
      continue;
    }
    const target = parts.get(part);
    if (!target) { limitations.add(`Cue ${cue.no / 1000} Part ${part} is missing.`); continue; }
    if (otherParts.size && parseConsoleBoolean(fields.AllowDuplicates) !== true) limitations.add(`Cue ${cue.no / 1000} already stores a requested layer in another part. AllowDuplicates is required to preserve that part.`);
    if (tracking === "cue_only") {
      if (cues[index + 1]) restorations.add(cues[index + 1].no / 1000);
      continue;
    }
    if (!trackingEnabled) continue;
    const distance = parseNativeTrackingDistance(obj(target.fields).TrackingDistance ?? fields.TrackingDistance);
    const until = distance ? distance.relative ? cue.no + distance.milli : distance.milli : Infinity;
    for (const channel of candidates) if ((otherParts.get(channel) ?? -1) <= part) active.set(channel, Math.max(active.get(channel) ?? -Infinity, until));
  }
  return { complete: reconstructed.complete && limitations.size === 0, selectedCues: selected, part, tracking,
    fixtures, attributes, preservesIntensity: !attributes.some(a => a.attribute.toLowerCase() === "dimmer"),
    potentialLaterCues: tracking === "tracking_forward" ? [...affected].sort((a, b) => a - b) : [],
    restorationCandidates: [...restorations].sort((a, b) => a - b), limitations: [...limitations],
    scope: "Sequence-owned inheritance only. Tracking-forward lists possible later cue changes until independent stored data. Cue-only intends to preserve later looks by native restoration; exact multipart restoration placement is verified after Store, not invented here." };
}

function layerData(cell: EffectiveNativeCell): unknown {
  const row = cell.stored, absolute = cell.layer === "absolute";
  return { fixture: cell.fixture, attribute: cell.attribute.toLowerCase(), layer: cell.layer, sourceCue: cell.sourceCue,
    sourcePart: cell.sourcePart, value: cell.value, raw: absolute ? row.valueRaw : undefined,
    kind: row[absolute ? "valueKind" : "relativeKind"], preset: row[absolute ? "absPreset" : "relPreset"], fade: row.fade, delay: row.delay,
    speed: row.speed, measure: row.measure, speedMaster: row.speedMaster, phase: row.phase, mode: row.mode, cooked: row.cooked,
    steps: list(row.steps).map(v => { const step = obj(v); return { value: step[absolute ? "absolute" : "relative"], kind: step[absolute ? "absoluteKind" : "relativeKind"],
      accel: step.accel, decel: step.decel, accelType: step.accelType, decelType: step.decelType, trans: step.trans, width: step.width, integrated: step.integrated }; }) };
}
function hardLayers(native: unknown): Array<{ cue: number; part: number; cell: EffectiveNativeCell }> {
  const out: ReturnType<typeof hardLayers> = [];
  for (const c of list(obj(native).cues).map(obj)) for (const p of list(c.parts).map(obj)) {
    const part = nativePartIdentity(c, p);
    if (part === null) continue;
    let rows: unknown[];
    try { rows = list(obj(JSON.parse(String(p.contentJson))).rows); } catch { continue; }
    for (const r of rows.map(obj)) for (const layer of ["absolute", "relative"] as const) {
      if (r[layer === "absolute" ? "hasAbsolute" : "hasRelative"] !== true) continue;
      const steps = list(r.steps), value = steps.length ? steps.map(v => obj(v)[layer]) : r[layer === "absolute" ? "value" : "relative"];
      out.push({ cue: c.no as number, part, cell: { fixture: String(r.fixture), attribute: String(r.attribute), layer, sourceCue: c.no as number, sourcePart: part, value, stored: r } });
    }
  }
  return out;
}

export function verifyCueRangeEdit(before: unknown, after: unknown, selected: number[], fixtures: string[], attributes: RangeAttribute[], values: RangeValue[], part: number,
  tracking: RangeTracking = "tracking_forward", presets: Array<{ pool: number; preset: number; attributes: RangeAttribute[] }> = []): Verification {
  const original = reconstructNativeCues(before), actual = reconstructNativeCues(after);
  const checked = "Requested native cue-part values/preset links and unchanged unrequested stored/inherited channel layers";
  if (!original.complete || !actual.complete) return { status: "unavailable", checked, detail: [...original.limitations, ...actual.limitations].join("; ") };
  const problems: string[] = [], selectedNative = new Set(selected.map(n => Math.round(n * 1000)));
  const plan = planCueRangeImpact(before, selected, fixtures, attributes, tracking, part);
  const restorationNative = new Set(plan.restorationCandidates.map(n => Math.round(n * 1000)));
  const allowsHard = (c: number, p: number, cell: EffectiveNativeCell) => scoped(cell, fixtures, attributes)
    && (selectedNative.has(c) && p === part || tracking === "cue_only" && restorationNative.has(c));
  const beforeHard = hardLayers(before), afterHard = hardLayers(after);
  const protectedHard = (entries: ReturnType<typeof hardLayers>) => entries.filter(x => !allowsHard(x.cue, x.part, x.cell))
    .map(x => ({ cue: x.cue, part: x.part, data: layerData(x.cell) }));
  if (nativeContentFingerprint(protectedHard(beforeHard)) !== nativeContentFingerprint(protectedHard(afterHard))) problems.push("An unrequested stored channel/layer changed, was removed, or acquired a new block.");
  const protectedEffective = (cues: typeof actual.cues) => cues.map(c => ({ cue: c.no, cells: c.effective.filter(cell => !scoped(cell, fixtures, attributes)).map(layerData) }));
  if (nativeContentFingerprint(protectedEffective(original.cues)) !== nativeContentFingerprint(protectedEffective(actual.cues))) problems.push("An unrequested inherited channel/layer or its tracking source changed.");
  if (tracking === "cue_only") {
    const cueOnlyValues = (cues: typeof actual.cues) => cues.filter(c => !selectedNative.has(c.no)).map(c => ({ cue: c.no,
      cells: c.effective.filter(cell => scoped(cell, fixtures, attributes) && cell.value !== "release" && !(Array.isArray(cell.value) && cell.value.every(x => x === "release")))
        .map(cell => ({ channel: key(cell), value: Array.isArray(cell.value) ? cell.value : typeof cell.value === "number" ? Math.round(cell.value * 10000) / 10000 : cell.value })) }));
    if (nativeContentFingerprint(cueOnlyValues(original.cues)) !== nativeContentFingerprint(cueOnlyValues(actual.cues))) problems.push("Cue Only did not preserve the requested layers' effective values outside the selected cues.");
  }
  for (const cue of selectedNative) for (const fixture of fixtures) {
    const rows = afterHard.filter(x => x.cue === cue && x.part === part && matchesFixture(x.cell.fixture, [fixture]));
    for (const wanted of values) {
      const found = rows.filter(x => x.cell.attribute.toLowerCase() === wanted.attribute.toLowerCase() && x.cell.layer === wanted.layer);
      if (!found.length || found.some(x => typeof x.cell.value !== "number" || !Number.isFinite(x.cell.value) || Math.abs(x.cell.value - wanted.value) > 0.0001)) problems.push(`Cue ${cue / 1000} Part ${part} Fixture ${fixture} ${wanted.attribute} ${wanted.layer} did not store ${wanted.value} percent.`);
    }
    for (const wanted of presets) for (const a of wanted.attributes) {
      if (!attributes.some(s => s.attribute.toLowerCase() === a.attribute.toLowerCase() && s.layer === a.layer)) continue;
      // A later explicit value replaces that preset's link for the same layer.
      if (values.some(v => v.attribute.toLowerCase() === a.attribute.toLowerCase() && v.layer === a.layer)) continue;
      const later = presets.slice(presets.indexOf(wanted) + 1).some(p => p.attributes.some(b => b.attribute.toLowerCase() === a.attribute.toLowerCase() && b.layer === a.layer));
      if (later) continue;
      const found = rows.filter(x => x.cell.attribute.toLowerCase() === a.attribute.toLowerCase() && x.cell.layer === a.layer);
      if (!found.length || found.some(x => { const link = obj(x.cell.stored[a.layer === "absolute" ? "absPreset" : "relPreset"]); return link.valid === false || link.pool !== wanted.pool || link.no !== wanted.preset; })) problems.push(`Cue ${cue / 1000} Part ${part} Fixture ${fixture} ${a.attribute} does not retain Preset ${wanted.pool}.${wanted.preset}.`);
    }
  }
  return { status: problems.length ? "mismatched" : "matched", checked, expected: { selected, part, fixtures, attributes, values },
    actual: { selectedNativeCues: selectedNative.size, protectedStoredLayers: protectedHard(afterHard).length }, ...(problems.length ? { detail: problems.join("; ") } : {}) };
}
