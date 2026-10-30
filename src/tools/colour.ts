/** Fixture-aware colour routed through actual attribute discovery and checked programmer values. */
import { z } from "zod";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { ATTRIBUTE_UNITS, attributeCommand, verifyProgrammer } from "./fixtures.js";
import { planColour, parseColour, NAMED_COLOURS, type ColourPlan, type ColourProfile, type ColourRequest } from "../colour.js";
import { buildResult, commandStep, notRequested, stepFromError, unavailable, validationFailure, type OperationResult, type StepResult, type Verification } from "../results.js";

const fixture = z.union([z.number().int().min(1).max(99999), z.string().regex(/^[1-9]\d{0,4}(?:\.[1-9]\d{0,3}){0,4}$/)]).transform(String);
const attribute = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).max(100);
const kelvin = z.number().min(1000).max(20000);
const profileBase = { fixture, zero_attributes: z.array(attribute).max(32).optional() };
const profile = z.discriminatedUnion("mode", [
  z.object({ ...profileBase, mode: z.literal("rgb") }),
  z.object({ ...profileBase, mode: z.literal("cmy"), cyan: attribute, magenta: attribute, yellow: attribute }),
  z.object({ ...profileBase, mode: z.literal("wheel"), attribute, slots: z.array(z.object({ name: z.string().min(1).max(100), color: z.string().min(1).max(40), percent: z.number().min(0).max(100).optional(), dmx8: z.number().int().min(0).max(255).optional() })).min(1).max(128) }),
  z.object({ ...profileBase, mode: z.literal("cct"), attribute, kelvin_at_0: kelvin, kelvin_at_100: kelvin }),
  z.object({ ...profileBase, mode: z.literal("white"), warm: attribute, cool: attribute, warm_kelvin: kelvin, cool_kelvin: kelvin }),
]);
interface Args extends ColourRequest { fixtures: string[]; profiles?: ColourProfile[]; preview?: boolean }
interface Metadata { attributes?: Array<{ attribute?: string | null }>; total?: number; count?: number; offset?: number; subfixtureCount?: number; subfixtureIndex?: number }

function validate(args: Args): string[] {
  const errors: string[] = [];
  if (new Set(args.fixtures).size !== args.fixtures.length) errors.push("fixtures must be unique");
  if ((args.color !== undefined) === (args.kelvin !== undefined)) errors.push("exactly one of color or kelvin is required");
  if (args.color !== undefined) { try { parseColour(args.color); } catch (err) { errors.push((err as Error).message); } }
  const seen = new Set<string>();
  for (const p of args.profiles ?? []) {
    const id = String(p.fixture);
    if (!args.fixtures.includes(id)) errors.push(`profile ${id} is not in fixtures`);
    if (seen.has(id)) errors.push(`profile ${id} is duplicated`);
    seen.add(id);
    if (p.mode === "wheel") for (const slot of p.slots) {
      if ((slot.percent === undefined) === (slot.dmx8 === undefined)) errors.push("each wheel slot needs exactly one of percent or dmx8");
      try { parseColour(slot.color); } catch (err) { errors.push((err as Error).message); }
    }
  }
  return errors;
}

async function applyColour(ctx: ToolContext, args: Args): Promise<OperationResult> {
  const op = "set_fixture_color";
  const target = { fixtures: args.fixtures, ...(args.color === undefined ? { kelvin: args.kelvin } : { color: args.color }) };
  const errors = validate(args);
  if (errors.length) return validationFailure(op, target, errors);
  const preview = args.preview !== false;
  const run = async () => {
    const steps: StepResult[] = [];
    const plans: ColourPlan[] = [];
    const identities = new Map<string, number>();
    const preflightErrors: string[] = [];
    for (const id of args.fixtures) {
      try {
        const data = await ctx.bridge.request<Metadata>("fixtureAttributes", { ref: `Fixture ${id}`, limit: 500, offset: 0 }, ctx.requestTimeoutMs);
        steps.push({ name: `attributes_${id}`, kind: "read", status: "succeeded", op: "fixtureAttributes", detail: data });
        const names = (data.attributes ?? []).map((a) => a.attribute).filter((a): a is string => typeof a === "string");
        if (typeof data.total !== "number" || data.total !== names.length || (data.offset ?? 0) !== 0) throw new Error(`Fixture ${id}: incomplete attribute metadata; refusing an unverified colour route`);
        if (data.subfixtureCount && !names.length) throw new Error(`Fixture ${id}: colour lives on its cells/subfixtures; give explicit colour-cell IDs`);
        if (!preview && (!Number.isInteger(data.subfixtureIndex) || data.subfixtureIndex! < 0)) throw new Error(`Fixture ${id}: patch identity is unavailable; cannot verify the requested fixture/cell`);
        if (typeof data.subfixtureIndex === "number") identities.set(id, data.subfixtureIndex);
        plans.push(planColour(id, names, args, args.profiles?.find((p) => String(p.fixture) === id)));
      } catch (err) {
        const error = `Fixture ${id}: ${(err as Error).message}`;
        preflightErrors.push(error);
        steps.push({ ...stepFromError(`preflight_${id}`, err, { op: "fixtureAttributes" }), kind: "read", error });
      }
    }
    if (preflightErrors.length) return buildResult({ operation: op, target, steps, verification: unavailable("preflight refused; no selection or programmer values changed"), summary: `Colour preflight failed: ${preflightErrors.join("; ")}`, extra: { preview, plan: plans, preflightErrors } });
    const warnings = [...new Set(plans.flatMap((p) => p.warnings))];
    if (preview) return buildResult({ operation: op, target, steps, verification: notRequested(), summary: `Planned colour for ${plans.length} fixture(s); preview only, nothing sent.`, warnings, extra: { preview: true, plan: plans } });
    const verified: Array<{ fixture: string; verification: Verification }> = [];
    let verification: Verification = unavailable("no fixture was programmed");
    for (const plan of plans) {
      const commands = ["ClearSelection", `Fixture ${plan.fixture}`, ...plan.values.map((v) => attributeCommand(v.attribute, v.value, ATTRIBUTE_UNITS[v.unit as keyof typeof ATTRIBUTE_UNITS].keyword))];
      for (let index = 0; index < commands.length; index++) {
        const sent = await commandStep(ctx.bridge, `fixture_${plan.fixture}_${index}`, commands[index], ctx.requestTimeoutMs);
        steps.push(sent);
        if (sent.status !== "succeeded") return buildResult({ operation: op, target, steps, verification: unavailable("stopped after failed or uncertain dispatch; inspect the last fixture before another mutation"), warnings, extra: { preview: false, plan: plans, verified } });
      }
      const read = await verifyProgrammer(ctx.bridge, plan.values, steps, warnings, `Fixture ${plan.fixture}`);
      verification = read.verification;
      if (verification.status === "matched") {
        const rows = (verification.actual as { rows?: Array<{ attribute?: string; subfixtureIndex?: number }> })?.rows ?? [];
        const expectedIndex = identities.get(plan.fixture);
        const requestedRows = rows.filter((row) => plan.values.some((value) => value.attribute.toLowerCase() === row.attribute?.toLowerCase()));
        if (requestedRows.some((row) => row.subfixtureIndex !== expectedIndex) || plan.values.some((value) => !requestedRows.some((row) => row.subfixtureIndex === expectedIndex && row.attribute?.toLowerCase() === value.attribute.toLowerCase()))) {
          verification = unavailable(`Fixture ${plan.fixture}: programmer rows did not match preflight patch identity ${expectedIndex}; address colour cells explicitly when a parent scan includes multiple cells`, "fixture/cell identity and requested colour values");
        }
      }
      verified.push({ fixture: plan.fixture, verification });
      if (verification.status !== "matched") {
        steps.push({ name: `verify_colour_${plan.fixture}`, kind: "read", status: "failed", op: "programmer", error: verification.detail ?? `colour verification ${verification.status}` });
        return buildResult({ operation: op, target, steps, verification, warnings, extra: { preview: false, plan: plans, verified } });
      }
    }
    return buildResult({ operation: op, target, steps, verification: { status: "matched", checked: "requested programmer colour channel values for every fixture", actual: verified }, warnings, extra: { preview: false, plan: plans, verified } });
  };
  return preview ? run() : ctx.mutations.run(run);
}

export const registerColourTools: RegisterTools = (server, ctx) => {
  server.registerTool("gma3_set_fixture_color", {
    title: "Plan or apply fixture-aware colour",
    description: "Discover every explicit fixture's attributes, then plan named/#RGB/#RRGGBB colour through RGB, explicit subtractive CMY or calibrated wheel slots; kelvin needs explicit CCT or warm/cool white calibration. " +
      "preview defaults true (read-only). preview:false preflights ALL targets, then ClearSelection, Fixture ID and Attribute At Absolute Percent (or calibrated wheel Decimal8) commands for each target, verifying its programmer values before continuing. " +
      "Changes selection, never clears existing programmer values; unlisted colour channels stay unchanged. No retries or OSC. The lock orders this server only. Compound fixtures lacking parent colour need explicit cell IDs. " +
      "Reports approximation and calibration limits; matched means programmer channels, not measured beam colour. Named colours: " + Object.keys(NAMED_COLOURS).join(", ") + ".",
    inputSchema: {
      fixtures: z.array(fixture).min(1).max(64).describe("Explicit fixture/cell IDs; no implicit current selection or group expansion."),
      color: z.string().min(1).max(40).optional().describe("#RGB, #RRGGBB or supported colour name; mutually exclusive with kelvin."),
      kelvin: kelvin.optional().describe("Target 1000..20000 K; requires per-fixture cct or white calibration."),
      profiles: z.array(profile).max(64).optional().describe("Explicit channel calibration by fixture. CMY is never inferred from additive ColorRGB_C/M/Y attributes. zero_attributes explicitly zeros listed extra channels."),
      preview: z.boolean().optional().describe("Default true: plan without changing selection or programmer. Set false to apply."),
    },
  }, (args) => operation(() => applyColour(ctx, args)));
};
