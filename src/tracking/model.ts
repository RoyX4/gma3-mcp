import { createHash } from "node:crypto";
import { MAX_LOOKS } from "../tools/cuelists.js";
import { parsePlan, fixtureIds, phaserAttributes, type TrackingPlan, type Change } from "./schema.js";
export { parsePlan, trackingPlanSchema } from "./schema.js";
export type { TrackingPlan } from "./schema.js";

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const fingerprint = (value: unknown): string => createHash("sha256").update(stableJson(value)).digest("hex");
export const serializePlan = (plan: TrackingPlan): string => stableJson(parsePlan(plan));
export type CellState =
  | { kind: "value"; value: number; unit: string }
  | { kind: "off" }
  | { kind: "release" }
  | { kind: "preset"; pool: number; preset: number; attributes: string[] }
  | { kind: "phaser"; phaser: Record<string, unknown> };
export interface Cell {
  fixture: string; attribute: string; layer: "absolute" | "relative"; state: CellState;
  provenance: { cue: string; change: number; note?: string; reason: "changed" | "cue_only_restore" | "block" };
}
export interface CompiledCue {
  cue: string; state: Cell[]; delta: Cell[]; stateFingerprint: string; deltaFingerprint: string;
  mode: "tracking" | "cue_only" | "block"; hold: boolean;
}
export interface Lint { severity: "error" | "warning"; cue?: string; code: string; message: string }
export interface StoreCue { cue: string; hold?: true; looks: Array<Record<string, any>>; [key: string]: unknown }
export interface Compilation {
  version: 1; plan: TrackingPlan; planFingerprint: string; cues: CompiledCue[]; lint: Lint[]; executable: boolean;
  store: { sequence: number; data_pool?: number; sequence_name?: string; mode: "create"; exclusive: true; verify: true; sequence_settings: { tracking: true }; cues: StoreCue[] };
  statistics: { cues: number; requestedAssignments: number; emittedAssignments: number; eliminatedAssignments: number; looks: number; holds: number; minimumStoreRequests: number };
  limitations: string[];
}
const key = (c: Pick<Cell, "fixture" | "attribute" | "layer">) => `${c.fixture}|${c.attribute.toLowerCase()}|${c.layer}`;
const equal = (a: Cell | undefined, b: Cell | undefined) => a && b ? fingerprint(a.state) === fingerprint(b.state) : a === b;
const sorted = (cells: Iterable<Cell>) => [...cells].sort((a, b) => key(a).localeCompare(key(b), "en", { numeric: true }));
const stateFingerprint = (cells: Cell[]) => fingerprint(cells.map(({ provenance: _, ...c }) => ({ ...c, attribute: c.attribute.toLowerCase() })));

function cellsOf(change: Change, cue: string, index: number): Cell[] {
  const attrs = change.kind === "preset" ? change.attributes : change.kind === "phaser" ? phaserAttributes(change.phaser) : [change.attribute];
  const state: CellState = change.kind === "value" ? { kind: change.kind, value: change.value, unit: change.unit }
    : change.kind === "preset" ? { kind: change.kind, pool: change.pool, preset: change.preset, attributes: [...change.attributes].sort() }
    : change.kind === "phaser" ? { kind: change.kind, phaser: change.phaser } : { kind: change.kind };
  return fixtureIds(change.fixtures).flatMap((fixture) => attrs.flatMap((attribute) => {
    const layers = change.kind === "phaser" ? phaserLayers(change.phaser, attribute) : ["layer" in change ? change.layer : "absolute"];
    return layers.map((layer) => ({ fixture, attribute, layer: layer as Cell["layer"], state, provenance: { cue, change: index, ...(change.note ? { note: change.note } : {}), reason: "changed" as const } }));
  }));
}

function phaserLayers(phaser: Record<string, unknown>, attribute: string): Array<Cell["layer"]> {
  const found = new Set<Cell["layer"]>();
  for (const step of phaser.steps as Array<{ values: Record<string, number | { absolute?: number; relative?: number }> }>) {
    const value = step.values[attribute];
    if (typeof value === "number" || value?.absolute !== undefined) found.add("absolute");
    if (typeof value === "object" && value.relative !== undefined) found.add("relative");
  }
  return [...found];
}

/** A recall acts on its whole declared coverage. Re-emit inherited overrides it would otherwise clobber. */
function closeActions(delta: Map<string, Cell>, desired: Map<string, Cell>, lint: Lint[], cue: string) {
  const seen = new Set<string>();
  for (const cell of delta.values()) {
    const s = cell.state;
    if (s.kind !== "preset" && s.kind !== "phaser") continue;
    const action = `${cell.fixture}|${fingerprint(s)}`;
    if (seen.has(action)) continue;
    seen.add(action);
    const attrs = s.kind === "preset" ? s.attributes : phaserAttributes(s.phaser);
    for (const attribute of attrs) for (const layer of s.kind === "preset" ? ["absolute" as const] : phaserLayers(s.phaser, attribute)) {
      const k = key({ fixture: cell.fixture, attribute, layer }), wanted = desired.get(k);
      if (!wanted) {
        lint.push({ severity: "error", cue, code: "unowned_action_coverage", message: `${s.kind} recall reaches ${cell.fixture} ${attribute} ${layer} outside the desired state.` });
        continue;
      }
      if (s.kind === "phaser" && fingerprint(wanted.state) !== fingerprint(s)) lint.push({ severity: "error", cue, code: "partial_phaser_override", message: `A full phaser recall would overwrite ${cell.fixture} ${attribute} ${layer}; split the definition before execution.` });
      delta.set(k, wanted);
    }
  }
}

/** A recall must precede every other preset whose desired cell its coverage would overwrite. */
export function presetRecallOrder(cells: Cell[]): Array<{ pool: number; preset: number }> | null {
  const actions = new Map<string, Extract<CellState, { kind: "preset" }>>();
  const absolute = new Map(cells.filter((cell) => cell.layer === "absolute").map((cell) => [cell.attribute.toLowerCase(), cell]));
  for (const cell of cells) if (cell.state.kind === "preset") actions.set(fingerprint(cell.state), cell.state);
  const outgoing = new Map([...actions.keys()].map((id) => [id, new Set<string>()]));
  const incoming = new Map([...actions.keys()].map((id) => [id, 0]));
  for (const [id, state] of actions) for (const attribute of state.attributes) {
    const wanted = absolute.get(attribute.toLowerCase());
    if (wanted?.state.kind !== "preset") continue;
    const after = fingerprint(wanted.state);
    if (after === id || outgoing.get(id)!.has(after)) continue;
    outgoing.get(id)!.add(after);
    incoming.set(after, incoming.get(after)! + 1);
  }
  const ready = [...actions.keys()].filter((id) => incoming.get(id) === 0), ordered: string[] = [];
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index]; ordered.push(id);
    for (const after of outgoing.get(id)!) {
      incoming.set(after, incoming.get(after)! - 1);
      if (incoming.get(after) === 0) ready.push(after);
    }
  }
  if (ordered.length !== actions.size) return null;
  return ordered.map((id) => { const { pool, preset } = actions.get(id)!; return { pool, preset }; });
}

function looksOf(delta: Cell[], lint: Lint[], cue: string): Array<Record<string, any>> {
  const perFixture = new Map<string, Record<string, any>>();
  const fixtureCells = new Map<string, Cell[]>();
  for (const cell of delta) {
    const look = perFixture.get(cell.fixture) ?? { fixtures: cell.fixture, values: [], presets: [], releases: [] };
    const cells = fixtureCells.get(cell.fixture) ?? []; cells.push(cell); fixtureCells.set(cell.fixture, cells);
    const s = cell.state;
    if (s.kind === "value" || s.kind === "off") look.values.push({ attribute: cell.attribute, value: s.kind === "off" ? 0 : s.value, unit: s.kind === "off" ? "percent" : s.unit, layer: cell.layer });
    if (s.kind === "release") {
      look.releases.push({ attribute: cell.attribute, layer: cell.layer });
    }
    if (s.kind === "phaser") {
      const attrs = phaserAttributes(s.phaser);
      if (delta.some((other) => other.fixture === cell.fixture && attrs.some((a) => a.toLowerCase() === other.attribute.toLowerCase()) && (other.state.kind === "value" || other.state.kind === "off"))) lint.push({ severity: "error", cue, code: "mixed_static_phaser_layers", message: "The verified store tool cannot combine a static layer and a phaser layer of the same attribute in one look; author a combined phaser definition." });
      if (look.phaser && fingerprint(look.phaser) !== fingerprint(s.phaser)) lint.push({ severity: "error", cue, code: "multiple_phasers", message: "Several phaser definitions for one fixture cannot fit one verified look; split their fixture coverage or author one combined definition." });
      look.phaser = s.phaser;
    }
    perFixture.set(cell.fixture, look);
  }
  const groups = new Map<string, Record<string, any>>();
  for (const look of perFixture.values()) {
    const presets = presetRecallOrder(fixtureCells.get(look.fixtures)!);
    if (presets === null) lint.push({ severity: "error", cue, code: "conflicting_preset_order", message: `Overlapping preset coverage on Fixture ${look.fixtures} cannot realize the desired state in any recall order.` });
    else look.presets = presets;
    if (!look.values.length) delete look.values;
    if (!look.presets.length) delete look.presets;
    if (!look.releases.length) delete look.releases;
    const { fixtures, ...content } = look;
    const k = fingerprint(content), old = groups.get(k);
    if (old) old.fixtures += ` + ${fixtures}`;
    else groups.set(k, { fixtures, ...content });
  }
  if (groups.size > MAX_LOOKS) lint.push({ severity: "error", cue, code: "too_many_looks", message: `${groups.size} distinct looks exceed the verified store tool's ${MAX_LOOKS}-look cue limit.` });
  return [...groups.values()];
}

/** Recompile the complete owned cue chain. No existing native cue is reconstructed or guessed. */
export function compileTracking(raw: unknown): Compilation {
  const plan = parsePlan(raw), lint: Lint[] = [], cues: CompiledCue[] = [], storeCues: StoreCue[] = [];
  let tracked = new Map<string, Cell>(), previous = new Map<string, Cell>(), requestedAssignments = 0, materializedCells = 0;
  for (const cue of plan.cues) {
    const desired = new Map(tracked), force = new Set<string>();
    cue.changes.forEach((change, i) => {
      for (const cell of cellsOf(change, cue.cue, i)) {
        requestedAssignments++;
        const k = key(cell);
        if (!equal(desired.get(k), cell)) desired.set(k, cell);
        if (change.kind === "phaser" && change.restart) { desired.set(k, cell); force.add(k); }
      }
      if (change.kind === "preset") lint.push({ severity: "warning", cue: cue.cue, code: "preset_coverage", message: `Preset ${change.pool}.${change.preset} coverage is declared intent; verify its native coverage and dependencies before programming. A preset may activate sibling attributes.` });
    });
    const delta = new Map<string, Cell>();
    for (const [k, cell] of desired) {
      if (!equal(previous.get(k), cell) || force.has(k) || cue.mode === "block") delta.set(k, { ...cell, ...(cue.mode === "block" ? { provenance: { ...cell.provenance, reason: "block" as const } } : {}) });
      if (cue.mode === "block" && cell.state.kind === "phaser" && !force.has(k)) lint.push({ severity: "error", cue: cue.cue, code: "phaser_block_carry", message: "Materializing a carried phaser can restart it. Explicitly restart it or use a qualified native block operation." });
    }
    // A cue-only addition must be explicitly released at the next cue; omission would track it forever.
    for (const [k, cell] of previous) if (!desired.has(k)) delta.set(k, { ...cell, state: { kind: "release" }, provenance: { cue: cue.cue, change: -1, reason: "cue_only_restore" } });
    closeActions(delta, desired, lint, cue.cue);
    const state = sorted(desired.values()), changes = sorted(delta.values());
    materializedCells += state.length;
    if (materializedCells > 1000000) throw new Error("effective state materialization exceeds 1000000 cells; reduce the owned plan scope before compiling");
    const looks = looksOf(changes, lint, cue.cue);
    const { changes: _, mode: __, hold: ___, ...metadata } = cue;
    storeCues.push({ ...metadata, ...(looks.length ? { looks } : { hold: true as const, looks: [] }) });
    cues.push({ cue: cue.cue, state, delta: changes, stateFingerprint: stateFingerprint(state), deltaFingerprint: stateFingerprint(changes), mode: cue.mode, hold: cue.hold });
    if (cue.mode !== "cue_only") tracked = desired;
    previous = desired;
  }
  const emittedAssignments = cues.reduce((n, c) => n + c.delta.length, 0);
  return {
    version: 1, plan, planFingerprint: fingerprint(plan), cues, lint, executable: !lint.some((l) => l.severity === "error"),
    store: { sequence: plan.sequence, ...(plan.data_pool ? { data_pool: plan.data_pool } : {}), ...(plan.sequence_name ? { sequence_name: plan.sequence_name } : {}), mode: "create", exclusive: true, verify: true, sequence_settings: { tracking: true }, cues: storeCues },
    statistics: { cues: cues.length, requestedAssignments, emittedAssignments, eliminatedAssignments: Math.max(0, requestedAssignments - emittedAssignments), looks: storeCues.reduce((n, c) => n + c.looks.length, 0), holds: storeCues.filter((c) => c.hold).length, minimumStoreRequests: cues.length },
    limitations: ["Effective state describes this complete compiler-owned cue chain, not arbitrary existing cue data or live output.", "Release relinquishes this sequence's control; zero Dimmer is an explicit off value. Omission inherits.", "Phaser carry preserves the definition by omitting it; phase continuity and native restart behavior need console qualification.", "Pre-store programmer checks and native cue metadata receipts do not independently prove stored hard values after Store."]
  };
}

export function explainCue(compilation: Compilation, cue: string) {
  const found = compilation.cues.find((c) => Number(c.cue) === Number(cue));
  if (!found) throw new Error(`cue ${cue} is not in this compiler-owned plan`);
  const emitted = new Set(found.delta.map(key));
  return { cue: found.cue, stateFingerprint: found.stateFingerprint, mode: found.mode, cells: found.state.map((c) => ({ ...c, inherited: c.provenance.cue !== found.cue, emitted: emitted.has(key(c)) })), lint: compilation.lint.filter((l) => l.cue === found.cue), source: "compiler-owned desired state", limitations: compilation.limitations };
}
export function compareCues(compilation: Compilation, from: string, to: string) {
  const a = explainCue(compilation, from), b = explainCue(compilation, to);
  const before = new Map(a.cells.map((c) => [key(c), c])), after = new Map(b.cells.map((c) => [key(c), c]));
  const changes = [...new Set([...before.keys(), ...after.keys()])].filter((k) => !equal(before.get(k), after.get(k))).map((k) => ({ key: k, before: before.get(k) ?? null, after: after.get(k) ?? null }));
  return { from: a.cue, to: b.cue, changes, identical: changes.length === 0, source: "compiler-owned desired state" };
}
