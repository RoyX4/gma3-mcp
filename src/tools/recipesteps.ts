/** Nested PhaserRecipe value-source edits. Paths and properties are demonstrated in MA's bundled PhaserRecipeBasic tests. */
import { z } from "zod";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { asRead, buildResult, commandStep, requestStep, runSteps, stepFromError, validationFailure, type OperationResult, type StepResult } from "../results.js";
import { ValidationError, Validator, finiteNumber } from "../validate.js";
import { lineRef, parseTarget, readLines, setReplyMatches, type Target } from "./recipes.js";
import { recipeProperty } from "./recipefields.js";
import { presetId } from "./presets.js";

const VALUE_FIELDS = ["ValueAbsolute", "ValueRelative", "TransX", "TransY", "TransZ", "WidthX", "WidthY", "WidthZ", "AccelX", "AccelY", "AccelZ", "DecelX", "DecelY", "DecelZ"] as const;
const SOURCE_FIELDS = ["Attributes", "Filter", "Preset", "Shape", "LinkSteps", ...VALUE_FIELDS];
const READ_FIELDS = [...SOURCE_FIELDS, "RawValueAbs", "RawValueRel"];
interface Source { step: number; source: number; fields: Record<string, unknown> }
interface Listing { total?: number; offset?: number; count?: number; items?: Array<{ index?: number; fields?: Record<string, unknown> }> }
interface StepEdit { step: number; source?: number; attribute?: string; preset?: string; values?: Record<string, number | null> }
interface Args { target: unknown; line: number; edits: StepEdit[]; link_steps?: boolean; preview?: boolean }
const complete = (r: Listing) => typeof r.total !== "number" || (r.offset ?? 0) + (r.count ?? r.items?.length ?? 0) >= r.total;
const normalize = (fields: Record<string, unknown>) => Object.fromEntries(SOURCE_FIELDS.map((key) => [key, ["Attributes", "Filter", "Preset", "Shape"].includes(key) ? fields[key] ?? null : recipeProperty(key === "ValueAbsolute" && "RawValueAbs" in fields ? fields.RawValueAbs : key === "ValueRelative" && "RawValueRel" in fields ? fields.RawValueRel : fields[key])]));

export async function readRecipeSteps(ctx: ToolContext, target: Target, line: number): Promise<Source[]> {
  const ref = lineRef(target, line);
  const steps = await ctx.bridge.request("children", { ref: `${ref}.1`, fields: [], asText: false, limit: 256 }, ctx.requestTimeoutMs) as Listing;
  if (!complete(steps)) throw new Error("phaser recipe step inventory is incomplete (maximum 256)");
  const out: Source[] = [];
  for (const [i, step] of (steps.items ?? []).entries()) {
    const n = step.index ?? i + 1;
    const sources = await ctx.bridge.request("children", { ref: `${ref}.1.${n}`, fields: READ_FIELDS, asText: false, limit: 64 }, ctx.requestTimeoutMs) as Listing;
    if (!complete(sources)) throw new Error(`step ${n} value-source inventory is incomplete (maximum 64)`);
    for (const [j, source] of (sources.items ?? []).entries()) out.push({ step: n, source: source.index ?? j + 1, fields: normalize(source.fields ?? {}) });
    if (out.length > 1024) throw new Error("phaser recipe exceeds the 1024-source inspection bound");
  }
  return out;
}

export async function editRecipeSteps(ctx: ToolContext, raw: Args): Promise<OperationResult> {
  const operationName = "edit_recipe_steps";
  const v = new Validator();
  const target = v.check(() => parseTarget(raw.target));
  const line = v.check(() => finiteNumber("line", raw.line, { integer: true, min: 1, max: 1000 }));
  const edits: Array<{ step: number; source: number; attribute?: string; preset?: string; values: Record<string, number | null> }> = [];
  const seen = new Set<string>();
  const sourceAttributes = new Map<number, string>();
  if (!Array.isArray(raw.edits) || !raw.edits.length || raw.edits.length > 64) v.fail("edits must contain 1-64 phaser step/source edits");
  else raw.edits.forEach((edit, i) => {
    const step = v.check(() => finiteNumber(`edits[${i}].step`, edit.step, { integer: true, min: 1, max: 256 }));
    const source = v.check(() => finiteNumber(`edits[${i}].source`, edit.source ?? 1, { integer: true, min: 1, max: 64 }));
    const key = `${step}.${source}`;
    if (seen.has(key)) v.fail(`step/source ${key} appears twice`);
    seen.add(key);
    if (edit.attribute !== undefined && !/^[A-Za-z][A-Za-z0-9_]*$/.test(edit.attribute)) v.fail(`edits[${i}].attribute must be an attribute name`);
    if (edit.attribute && source !== undefined) {
      if (sourceAttributes.has(source) && sourceAttributes.get(source) !== edit.attribute) v.fail(`source ${source} has conflicting attributes; native source attributes apply to all steps`);
      sourceAttributes.set(source, edit.attribute);
    }
    const values: Record<string, number | null> = {};
    if (edit.values !== undefined && (!edit.values || typeof edit.values !== "object" || Array.isArray(edit.values))) v.fail(`edits[${i}].values must be an object`);
    else for (const [property, value] of Object.entries(edit.values ?? {})) {
      if (!(VALUE_FIELDS as readonly string[]).includes(property)) { v.fail(`unsupported phaser source property ${property}`); continue; }
      const n = value === null ? null : v.check(() => finiteNumber(`edits[${i}].values.${property}`, value, { min: property.startsWith("Value") ? -36000 : 0, max: 36000 }));
      if (n !== undefined) values[property] = n;
    }
    let preset: string | undefined;
    if (edit.preset !== undefined) {
      const p = v.check(() => presetId(`edits[${i}].preset`, edit.preset));
      if (p) preset = `${p.pool}.${p.number}`;
      if ("ValueAbsolute" in values || "ValueRelative" in values) v.fail(`edits[${i}]: preset and hard values cannot be combined`);
    }
    if (!edit.attribute && !preset && !Object.keys(values).length) v.fail(`edits[${i}] changes nothing`);
    if (step !== undefined && source !== undefined) edits.push({ step, source, values, ...(preset ? { preset } : {}), ...(edit.attribute ? { attribute: edit.attribute } : {}) });
  });
  const resultTarget = { target: raw.target, line: raw.line };
  if (!v.ok || !target || line === undefined) return validationFailure(operationName, resultTarget, v.errors);
  const ref = lineRef(target, line);
  const body = async () => {
    const steps: StepResult[] = [];
    let before: Source[];
    const presetAddresses = new Map<string, string>();
    try {
      const lines = await readLines(ctx.bridge, target, ctx.requestTimeoutMs);
      if (lines?.find((l) => l.line === line)?.class !== "PhaserRecipe") throw new Error(`line ${line} must be an existing PhaserRecipe`);
      before = await readRecipeSteps(ctx, target, line);
      for (const e of edits) {
        if (!before.some((s) => s.step === e.step && s.source === e.source)) throw new Error(`step ${e.step} source ${e.source} does not exist`);
        if (e.preset) {
          const found = await ctx.bridge.request("objects", { ref: `Preset ${e.preset}`, fields: [], limit: 2 }, ctx.requestTimeoutMs) as Listing & { items?: Array<{ class?: string; addr?: string }> };
          const p = found.items?.[0];
          if (found.items?.length !== 1 || p?.class !== "Preset" || typeof p.addr !== "string") throw new Error(`Preset ${e.preset} does not resolve to exactly one preset`);
          presetAddresses.set(`${e.step}.${e.source}`, p.addr);
        }
        if (e.attribute) {
          const found = await ctx.bridge.request("objects", { ref: `Attribute "${e.attribute}"`, fields: [], limit: 1 }, ctx.requestTimeoutMs) as Listing;
          if (!found.items?.length) throw new Error(`Attribute ${e.attribute} does not exist`);
        }
      }
      steps.push(asRead({ name: "inspect_sources", status: "succeeded", op: "children", detail: { sources: before.length } }));
    } catch (err) { return buildResult({ operation: operationName, target: resultTarget, steps: [asRead(stepFromError("inspect_sources", err, { op: "children" }))] }); }
    const intended = { linkSteps: raw.link_steps ?? false, edits, paths: edits.map((e) => `${ref}.1.${e.step}.${e.source}`) };
    if (raw.preview) return buildResult({ operation: operationName, target: resultTarget, steps, summary: "Preview only; no phaser recipe was changed.", extra: { preview: true, before, intended } });
    const writeSource = async (name: string, sourceRef: string, property: string, expected: number | null): Promise<StepResult> => {
      try {
        const command = `Set ${sourceRef} Property "${property}" ${expected === null ? "None" : expected}`;
        const result = await commandStep(ctx.bridge, name, command, ctx.requestTimeoutMs);
        if (result.status !== "succeeded") return result;
        const readProperty = property === "ValueAbsolute" ? "RawValueAbs" : property === "ValueRelative" ? "RawValueRel" : property;
        const raw = await ctx.bridge.request("objects", { ref: sourceRef, fields: [readProperty], asText: false, limit: 1 }, ctx.requestTimeoutMs) as Listing;
        if (raw.items?.length !== 1) throw new Error("source canonical readback did not resolve uniquely");
        const actual = recipeProperty(raw.items[0].fields?.[readProperty]);
        return { ...result, status: actual === expected ? "succeeded" : "failed", detail: { property: readProperty, actual, expected }, ...(actual === expected ? {} : { error: `source ${readProperty} did not match` }) };
      } catch (err) { return stepFromError(name, err, { op: "set" }); }
    };
    // LinkSteps is a writable UInt8 on the nested value source. The recipe-level command setter forwards it,
    // while handle:Set on the recipe can silently do nothing; address and verify every declared source instead.
    const links = await runSteps(before.filter(s => s.fields.LinkSteps !== (intended.linkSteps ? 1 : 0)).map(s => ({ name: `set_link_steps_${s.step}_${s.source}`, run: () => writeSource(`set_link_steps_${s.step}_${s.source}`, `${ref}.1.${s.step}.${s.source}`, "LinkSteps", intended.linkSteps ? 1 : 0) })));
    steps.push(...links.steps);
    if (links.steps.length > 0 && links.outcome !== "succeeded") return buildResult({ operation: operationName, target: resultTarget, steps, extra: { before, intended } });
    const assignedAttributes = new Set<number>();
    const planned = edits.flatMap((e) => {
      const sourceRef = `${ref}.1.${e.step}.${e.source}`;
      const attribute = e.attribute && !assignedAttributes.has(e.source) ? e.attribute : undefined;
      if (attribute) assignedAttributes.add(e.source);
      return [
        ...(attribute ? [{ name: `attribute_${e.step}_${e.source}`, run: () => commandStep(ctx.bridge, `attribute_${e.step}_${e.source}`, `Assign Attribute "${attribute}" At ${sourceRef}`, ctx.requestTimeoutMs) }] : []),
        ...(e.preset && (before.find(s => s.step === e.step && s.source === e.source)?.fields.Preset as { addr?: string } | null)?.addr !== presetAddresses.get(`${e.step}.${e.source}`) ? [{ name: `preset_${e.step}_${e.source}`, run: () => commandStep(ctx.bridge, `preset_${e.step}_${e.source}`, `Assign Preset ${e.preset} At ${sourceRef}`, ctx.requestTimeoutMs) }] : []),
        ...Object.entries(e.values).map(([property, value]) => ({ name: `set_${e.step}_${e.source}_${property}`, run: () => writeSource(`set_${e.step}_${e.source}_${property}`, sourceRef, property, value) })),
      ];
    });
    const execution = await runSteps(planned); steps.push(...execution.steps);
    try {
      const after = await readRecipeSteps(ctx, target, line);
      const problems: string[] = [];
      if (after.length !== before.length) problems.push("value-source count changed");
      for (const source of before) {
        const current = after.find((s) => s.step === source.step && s.source === source.source);
        if (!current) { problems.push(`step ${source.step} source ${source.source} disappeared`); continue; }
        const edit = edits.find((e) => e.step === source.step && e.source === source.source);
        for (const field of SOURCE_FIELDS) {
          if (field === "Attributes" && sourceAttributes.has(source.source)) {
            const h = current.fields.Attributes as { name?: string } | null;
            if (h?.name !== sourceAttributes.get(source.source)) problems.push(`step ${source.step} source ${source.source} attribute did not match`);
            continue;
          }
          if (edit?.preset && field === "Preset") {
            if ((current.fields.Preset as { addr?: string } | null)?.addr !== presetAddresses.get(`${source.step}.${source.source}`)) problems.push(`step ${source.step} source ${source.source} preset differs`);
            continue;
          }
          // Preset content determines its own absolute/relative values. Verify the actual reference, report values,
          // and leave fixture/attribute coverage to the native cook instead of inventing a numeric prediction.
          if (edit?.preset && (field === "ValueAbsolute" || field === "ValueRelative")) continue;
          const wanted = field === "LinkSteps" ? (intended.linkSteps ? 1 : 0) : field === "Preset" && edit && "ValueAbsolute" in edit.values ? null : edit && field in edit.values ? edit.values[field] : source.fields[field];
          if (JSON.stringify(current.fields[field]) !== JSON.stringify(wanted)) problems.push(`step ${source.step} source ${source.source} ${field} differs`);
        }
      }
      steps.push(asRead({ name: "read_back_sources", status: "succeeded", op: "children" }));
      return buildResult({ operation: operationName, target: resultTarget, steps, verification: { status: problems.length ? "mismatched" : "matched", checked: "all requested source values, source-wide attributes and exact preset references, and untouched inspected source fields", ...(problems.length ? { detail: problems.slice(0, 20).join("; ") } : {}) }, extra: { before, after, intended } });
    } catch (err) { steps.push(asRead(stepFromError("read_back_sources", err, { op: "children" }))); return buildResult({ operation: operationName, target: resultTarget, steps, verification: { status: "unavailable", detail: "phaser source readback failed; no write was retried" }, extra: { before, intended } }); }
  };
  return raw.preview ? body() : ctx.mutations.run(body);
}

export const registerRecipeStepTool: RegisterTools = (server, ctx) => {
  server.registerTool("gma3_edit_recipe_steps", {
    title: "Edit the nested steps and value sources of a phaser recipe",
    description: "Change 1-64 existing step/source objects in a PhaserRecipe of a preset or cue part. Reads the complete bounded tree first; checks attributes (a source attribute applies to all its steps); preview sends no mutation. Disables LinkSteps by default for independent writes (link_steps:true preserves linked edits, which readback may report as collateral differences). preset assigns a checked Preset reference to the step/source; hard absolute edits clear it. values supports ValueAbsolute/ValueRelative and Trans/Width/Accel/Decel X/Y/Z; null clears a value. Each write is read back, followed by all source fields and untouched sources. Existing Shape references and gma3_edit_recipe create the phaser; this tool edits its resulting sources. MA's bundled PhaserRecipeBasic tests document these nested native paths.",
    inputSchema: { target: z.object({ preset: z.string().optional(), sequence: z.number().optional(), cue: z.union([z.number(), z.string()]).optional(), part: z.number().optional() }), line: z.number(), edits: z.array(z.object({ step: z.number(), source: z.number().optional(), attribute: z.string().optional(), preset: z.string().optional().describe("Preset N.M for this source/step; mutually exclusive with hard absolute/relative values."), values: z.record(z.string(), z.number().nullable()).optional() }).strict()), link_steps: z.boolean().optional(), preview: z.boolean().optional() },
  }, async (args) => operation(() => editRecipeSteps(ctx, args)));
};
