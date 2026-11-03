/** Compare compiler-owned intent with actual stored/tracked native channels, after Store. */
import type { Compilation, Cell } from "./tracking/model.js";
import { reconstructNativeCues, type EffectiveNativeCell } from "./native-cues.js";
import type { Verification } from "./results.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const key = (cell: Pick<Cell, "fixture" | "attribute" | "layer">) => `${cell.fixture}\0${cell.attribute.toLowerCase()}\0${cell.layer}`;
const close = (a: unknown, b: number, tolerance = 0.05) => typeof a === "number" && Number.isFinite(a) && Math.abs(a - b) <= tolerance;

export function verifyNativeOwnedState(compilation: Compilation, native: unknown): Verification {
  const reconstruction = reconstructNativeCues(native);
  const checked = "compiler-owned channel layers in actual native cue-part data after Store, including tracked inheritance";
  if (!reconstruction.complete) return { status: "unavailable", checked, detail: reconstruction.limitations.join("; ") };
  const authored = reconstruction.cues.filter(cue => cue.no > 0), through = Math.max(0, ...authored.map(cue => cue.no));
  if (!authored.length && compilation.cues.length) return {status: "unavailable", checked, detail: "No authored native cue exists to compare; an empty sequence is not verification of the plan."};
  const problems: string[] = [], unsupported: string[] = [];
  let comparisons = 0;
  const numbers = new Set(compilation.cues.map(cue => Math.round(Number(cue.cue) * 1000)));
  for (const cue of authored) if (!numbers.has(cue.no)) problems.push(`Unexpected native cue ${cue.no / 1000} exists in the owned sequence.`);
  for (const wanted of compilation.cues.filter(cue => Math.round(Number(cue.cue) * 1000) <= through)) {
    const actual = authored.find(cue => cue.no === Math.round(Number(wanted.cue) * 1000));
    if (!actual) { problems.push(`Native cue ${wanted.cue} is missing.`); continue; }
    const values = new Map(actual.effective.map(cell => [key(cell), cell]));
    const ownedKeys = new Set(wanted.state.map(key));
    const checks = [...wanted.state, ...wanted.delta.filter(cell => cell.state.kind === "release" && !ownedKeys.has(key(cell)))];
    for (const cell of checks) {
      const got = values.get(key(cell)), where = `Cue ${wanted.cue} Fixture ${cell.fixture} ${cell.attribute} ${cell.layer}`;
      if (!got) { problems.push(`${where}: no native stored or inherited layer.`); continue; }
      const result = compareCell(cell, got);
      comparisons++;
      if (result.mismatch) problems.push(`${where}: ${result.mismatch}`);
      if (result.unavailable) unsupported.push(`${where}: ${result.unavailable}`);
    }
  }
  return { status: problems.length ? "mismatched" : unsupported.length ? "unavailable" : "matched", checked,
    expected: { throughCue: through / 1000, ownedLayerComparisons: comparisons },
    actual: { cues: authored.length, problems, unsupported },
    ...(problems.length || unsupported.length ? { detail: [...problems, ...unsupported].join("; ") } : {}) };
}

function compareCell(cell: Cell, actual: EffectiveNativeCell): { mismatch?: string; unavailable?: string } {
  const state = cell.state;
  if (state.kind === "release") return (actual.value === "release" || Array.isArray(actual.value) && actual.value.length > 0 && actual.value.every(value => value === "release")) ? {} : { mismatch: "expected the entire layer to be released, which is distinct from zero or a phaser with some released steps." };
  if (state.kind === "off" || state.kind === "value") {
    const expected = state.kind === "off" ? 0 : state.value;
    const unit = state.kind === "off" ? "percent" : state.unit;
    if (unit !== "percent" && unit !== "percent_fine") return { unavailable: `native ${unit} conversion requires the exact channel-function range; no percent guess is made.` };
    return close(actual.value, expected) ? {} : { mismatch: `${JSON.stringify(actual.value)} was read, expected ${expected} percent.` };
  }
  if (state.kind === "preset") {
    const link = record(actual.stored[cell.layer === "absolute" ? "absPreset" : "relPreset"]);
    if (link.valid === false) return { mismatch: "stored preset source is invalid." };
    return link.pool === state.pool && link.no === state.preset ? {} : { mismatch: `stored preset reference differs from Preset ${state.pool}.${state.preset} or is unreadable.` };
  }
  const definition = state.phaser, steps = Array.isArray(definition.steps) ? definition.steps : [];
  if ((definition.unit ?? "percent") !== "percent") return { unavailable: "physical phaser steps require native channel-function calibration." };
  const nativeSteps = Array.isArray(actual.stored.steps) ? actual.stored.steps.map(record) : [];
  if (nativeSteps.length !== steps.length) return { mismatch: `${nativeSteps.length} steps stored, expected ${steps.length}.` };
  for (const [i, value] of steps.entries()) {
    const step = record(value), attributes = record(step.values);
    const sources = Object.entries(attributes).filter(([attribute]) => attribute.trim().toLowerCase() === cell.attribute.toLowerCase());
    if (sources.length > 1) return { unavailable: `step ${i + 1} has ambiguous case-equivalent attribute names.` };
    const source = sources[0]?.[1];
    const expected = typeof source === "number" ? cell.layer === "absolute" ? source : undefined : record(source)[cell.layer];
    if (typeof expected === "number" && !close(nativeSteps[i][cell.layer], expected)) return { mismatch: `step ${i + 1} ${cell.layer} is ${JSON.stringify(nativeSteps[i][cell.layer])}, expected ${expected}.` };
    for (const [input, native, fallback] of [["width", "width", 100], ["transition", "trans", 100], ["accel", "accel", 0], ["decel", "decel", 0]] as const) {
      const want = step[input] ?? fallback, got = nativeSteps[i][native] ?? fallback;
      if (typeof want !== "number" || !close(got, want, 0.1)) return { mismatch: `step ${i + 1} ${input} differs from the intended timing.` };
    }
  }
  const layers = record(definition.phaser);
  if (typeof layers.speed_bpm === "number" && (typeof actual.stored.speed !== "number" || !close(actual.stored.speed * 60, layers.speed_bpm))) return { mismatch: "stored phaser speed differs from requested BPM or is unreadable." };
  if (typeof layers.measure === "number" && (typeof actual.stored.measure !== "number" || !close(actual.stored.measure / 100, layers.measure))) return { mismatch: "stored phaser measure differs or is unreadable." };
  if (typeof layers.speed_master === "number" && (typeof actual.stored.speedMaster !== "number" || actual.stored.speedMaster + 1 !== layers.speed_master)) return { mismatch: "stored phaser speed master differs or is unreadable." };
  if (layers.phase !== undefined || layers.repeat !== undefined) return { unavailable: "distributed native phase/repetition requires selection-grid qualification; step values and timing were compared." };
  return {};
}
