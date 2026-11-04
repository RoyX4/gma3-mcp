import { z } from "zod";
import { compactResult } from "../batch.js";
import { planCueRangeImpact, verifyCueRangeEdit, type RangeAttribute, type RangeValue } from "../cue-range-impact.js";
import { nativeContentFingerprint, nativePartIdentity } from "../native-cues.js";
import { readNativeCueContent } from "../native-cue-reader.js";
import { asRead, buildResult, parseConsoleBoolean, unavailable, validationFailure, type Verification } from "../results.js";
import { Validator, attributeName, cueNumber } from "../validate.js";
import { cueRef, readObjects } from "./common.js";
import { operation, type RegisterTools, type ToolContext } from "./context.js";
import { MAX_CUES, MAX_PRESETS_PER_LOOK, batchResult, buildCueBatch, validateCues } from "./cuelists.js";
import { dataPoolShape, inDataPool } from "./datapool.js";
import { MAX_ATTRIBUTES } from "./fixtures.js";
import { fixtureRange } from "./inspection.js";
import { lockState } from "./playback.js";

const cueInput = z.union([z.string(), z.number()]);
const valueInput = z.object({ attribute: z.string(), value: z.number(), unit: z.literal("percent").default("percent"), layer: z.enum(["absolute", "relative"]).optional() }).strict();
const presetInput = z.object({ pool: z.number(), preset: z.union([z.number(), z.string()]) }).strict();
const inputShape = {
  ...dataPoolShape,
  sequence: z.number().int().min(1).max(99999), part: z.number().int().min(0).max(999).default(0),
  cues: z.array(cueInput).min(1).max(MAX_CUES).optional(), from: cueInput.optional(), to: cueInput.optional(), all: z.literal(true).optional(),
  fixtures: z.string().describe("Explicit fixture IDs/ranges, e.g. 101 Thru 112. Specify cells by dotted ID."),
  values: z.array(valueInput).min(1).max(MAX_ATTRIBUTES).optional(),
  presets: z.array(presetInput).min(1).max(MAX_PRESETS_PER_LOOK).optional(),
  intensity: z.number().min(0).max(100).optional().describe("Explicit Dimmer change. Preset Dimmer is excluded unless a Dimmer value is requested."),
  tracking: z.enum(["tracking_forward", "cue_only"]),
  preview: z.boolean().default(true), exclusive: z.boolean().default(false), detail: z.boolean().default(false),
  expected_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Optional fingerprint returned by a previous preview of this same edit."),
};
const schema = z.object(inputShape).strict();
type Input = z.output<typeof schema>;
type Row = Record<string, unknown>;
type PresetProof = { pool: number; preset: number; attributes: RangeAttribute[]; fingerprint: string };
const row = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const rows = (v: unknown): Row[] => Array.isArray(v) ? v.map(row) : [];
const attributeKey = (a: RangeAttribute) => `${a.attribute.toLowerCase()}:${a.layer}`;
const OPERATION = "edit_cue_values";

function resolveCues(input: Input, native: Row): number[] {
  const available = rows(native.cues).flatMap(c => typeof c.no === "number" && Number.isSafeInteger(c.no) && c.no > 0 ? [c.no / 1000] : []);
  if (new Set(available).size !== available.length) throw new Error("Native cue list contains duplicate cue numbers");
  const chosen = input.cues ? input.cues.map(c => Number(cueNumber("cue", c))) : available.filter(c => input.all || c >= Number(input.from) && c <= Number(input.to));
  if (!chosen.length || chosen.length > MAX_CUES) throw new Error(`Select 1–${MAX_CUES} existing cues per edit`);
  const have = new Set(available);
  if (chosen.some(c => !have.has(c))) throw new Error(`Cue(s) ${chosen.filter(c => !have.has(c)).join(", ")} do not exist`);
  return [...chosen].sort((a, b) => a - b);
}

async function fixtureIDs(ctx: ToolContext, fixtures: string): Promise<string[]> {
  const found = await readObjects(ctx.bridge, fixtures, ["FID"], 512);
  if (!found?.total || found.total !== found.items?.length) throw new Error(`Complete fixture resolution is unavailable for ${fixtures}`);
  const ids = found.items.map(item => String(item.fields?.FID ?? ""));
  if (ids.some(id => !/^\d+(?:\.\d+)*$/.test(id)) || new Set(ids).size !== ids.length) throw new Error("Resolved fixture IDs are ambiguous or unavailable");
  return ids;
}

async function presetProofs(ctx: ToolContext, presets: ReturnType<typeof validateCues>[number]["looks"][number]["presets"]): Promise<PresetProof[]> {
  const proofs: PresetProof[] = [];
  for (const preset of presets) {
    const result = await ctx.bridge.request<Row>("preset.read", { ref: preset.ref }, ctx.requestTimeoutMs);
    const content = rows(result.rows);
    if (result.truncated !== false || result.byFixtures !== true || !content.length || content.length !== result.count
      || row(result.pool).no !== preset.pool || typeof result.no !== "number" || !Number.isSafeInteger(result.no) || result.no < 1) {
      throw new Error(`Complete native attribute/layer coverage is unavailable for ${preset.ref}`);
    }
    const attributes = new Map<string, RangeAttribute>();
    for (const channel of content) {
      const attribute = attributeName("preset channel attribute", channel.attribute);
      if (typeof channel.fixture !== "string" || (!channel.hasAbsolute && !channel.hasRelative)) throw new Error(`A native channel of ${preset.ref} is not mapped`);
      for (const layer of ["absolute", "relative"] as const) if (channel[layer === "absolute" ? "hasAbsolute" : "hasRelative"] === true) {
        const entry = { attribute, layer }; attributes.set(attributeKey(entry), entry);
      }
    }
    proofs.push({ pool: preset.pool, preset: result.no, attributes: [...attributes.values()], fingerprint: nativeContentFingerprint(result) });
  }
  return proofs;
}

async function contextKey(ctx: ToolContext): Promise<string> {
  const context = await ctx.bridge.request<Row>("fast.context", {}, ctx.requestTimeoutMs);
  if (context.environment !== "Normal" || typeof context.contextKey !== "string" || !context.contextKey
    || !Array.isArray(context.identityUncertain) || context.identityUncertain.length) throw new Error("A confirmed Normal console context is required");
  return context.contextKey;
}

async function assertUnlocked(ctx: ToolContext, ref: string): Promise<void> {
  const result = await readObjects(ctx.bridge, ref, ["Lock"], 1);
  if (result?.total !== 1 || result.items.length !== 1 || lockState(result.items[0].fields?.Lock) !== false) throw new Error(`${ref} is locked or its lock state is unavailable`);
}

const onlyCue = (native: Row, number: number, sequence = native.sequence): Row => ({ ...native, sequence, cues: rows(native.cues).filter(c => c.no === number) });

export async function editCueValues(unscoped: ToolContext, raw: unknown) {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return validationFailure(OPERATION, {}, parsed.error.issues.map(i => i.message));
  const input = parsed.data;
  const target = { sequence: input.sequence, part: input.part, dataPool: input.data_pool ?? null };
  const v = new Validator();
  const hasRange = input.from !== undefined || input.to !== undefined;
  if ([input.cues !== undefined, hasRange, input.all === true].filter(Boolean).length !== 1) v.fail("Choose a cue list, both range endpoints, or all:true");
  if (hasRange) {
    const from = v.check(() => cueNumber("from", input.from));
    const to = v.check(() => cueNumber("to", input.to));
    if (from !== undefined && to !== undefined && Number(from) > Number(to)) v.fail("from must be no greater than to");
  }
  const explicit = input.cues?.map(c => v.check(() => cueNumber("cue", c)));
  if (explicit && new Set(explicit).size !== explicit.length) v.fail("Duplicate cue targets");
  const fixtures = v.check(() => fixtureRange("fixtures", input.fixtures));
  if (fixtures && !/^Fixture \d+(?:\.\d+)*(?: Thru \d+(?:\.\d+)*)?(?: [+-] \d+(?:\.\d+)*(?: Thru \d+(?:\.\d+)*)?)*$/i.test(fixtures)) v.fail("Fixture ranges require explicit IDs at both endpoints");
  const [validated] = validateCues(v, [{ cue: 1, fixtures, values: input.values, presets: input.presets, intensity: input.intensity }], undefined);
  if (!input.preview && !input.exclusive) v.fail("exclusive:true is required when applying to the console's Preview programmer");
  if (!v.ok || !fixtures || !validated) return validationFailure(OPERATION, target, v.errors);
  const look = validated.looks[0];
  const values: RangeValue[] = look.values.map(x => ({ attribute: x.attribute, layer: x.layer ?? "absolute", value: x.value }));
  if (look.intensity !== undefined) values.push({ attribute: "Dimmer", layer: "absolute", value: look.intensity });
  const ctx = inDataPool(unscoped, input), ref = `Sequence ${input.sequence}`, timeout = ctx.requestTimeoutMs;
  return ctx.mutations.run(async () => {
    let prepared;
    try {
      const identity = await contextKey(ctx);
      const native = await readNativeCueContent(ctx.bridge, ref, timeout, { context: { contextKey: identity, environment: "Normal" } });
      const selected = resolveCues(input, native);
      const selectedNative = new Set(selected.map(c => Math.round(c * 1000)));
      for (const c of rows(native.cues).filter(c => selectedNative.has(c.no as number))) {
        if (!rows(c.parts).some(p => nativePartIdentity(c, p) === input.part)) throw new Error(`Cue ${Number(c.no) / 1000} Part ${input.part} is absent or unreadable`);
      }
      const ids = await fixtureIDs(ctx, fixtures);
      const presets = await presetProofs(ctx, look.presets);
      const hasDimmer = values.some(a => a.attribute.toLowerCase() === "dimmer");
      const permitted = [...presets.flatMap(p => p.attributes).filter(a => hasDimmer || a.attribute.toLowerCase() !== "dimmer"), ...values];
      const attributes = [...new Map(permitted.map(a => [attributeKey(a), { attribute: a.attribute, layer: a.layer }])).values()];
      if (!attributes.length) throw new Error("No scoped attributes remain after protecting Dimmer");
      const filterAttributes = [...new Map(attributes.map(a => [a.attribute.toLowerCase(), a.attribute])).values()];
      if (filterAttributes.length > MAX_ATTRIBUTES) throw new Error("Native preset coverage exceeds the bounded Store filter size");
      const plan = planCueRangeImpact(native, selected, ids, attributes, input.tracking, input.part);
      const fingerprint = nativeContentFingerprint({ identity, native, look, target, tracking: input.tracking, selected, ids, presets });
      if (input.expected_fingerprint && input.expected_fingerprint !== fingerprint) throw new Error("The preview fingerprint no longer matches the selected cue state and edit");
      if (!input.preview) {
        if (!plan.complete) throw new Error(`Native impact is incomplete. ${plan.limitations.join(". ")}`);
        if (input.tracking === "tracking_forward" && parseConsoleBoolean(row(row(native.sequence).fields).Tracking) !== true) throw new Error("Enable sequence Tracking before a tracking-forward edit");
        const preferences = await ctx.bridge.request<Row>("preset.context", {}, timeout);
        const store = row(preferences.preferences);
        if (parseConsoleBoolean(store.StoreLook) !== false || String(store.StoreSource).toLowerCase() !== "programmer"
          || String(store.ChannelFilter).toLowerCase() !== "active" || String(store.TrackingShield).toLowerCase() !== "off") {
          throw new Error("Set Store preferences to Programmer, Active, Look Off and Tracking Shield Off for scoped edits");
        }
        await assertUnlocked(ctx, ref);
        for (const cue of new Set([...selected, ...plan.restorationCandidates])) {
          await assertUnlocked(ctx, cueRef(input.sequence, String(cue)));
          const candidate = rows(native.cues).find(c => c.no === Math.round(cue * 1000));
          const parts = plan.restorationCandidates.includes(cue) && candidate ? rows(candidate.parts).map(p => nativePartIdentity(candidate, p)) : [input.part];
          for (const part of parts) {
            if (part === null) throw new Error(`Part identities are unavailable at Cue ${cue}`);
            await assertUnlocked(ctx, cueRef(input.sequence, String(cue), part));
          }
        }
      }
      if (await contextKey(ctx) !== identity) throw new Error("Console context changed during scope inspection");
      prepared = { identity, native, selected, ids, presets, attributes, filterAttributes, plan, fingerprint };
    } catch (error) {
      return buildResult({ operation: OPERATION, target, steps: [asRead({ name: "inspect_scope", status: "failed", error: String(error) })] });
    }
    const { native, selected, ids, presets, attributes, filterAttributes, plan, fingerprint } = prepared;
    const inspect = asRead({ name: "inspect_scope", status: "succeeded" });
    if (input.preview) return buildResult({ operation: OPERATION, target, steps: [inspect], extra: { preview: true, plan, fingerprint } });
    const built = await buildCueBatch(ctx, {
      sequence: input.sequence, mode: "merge", verify: true, cue_only: input.tracking === "cue_only" ? "on" : "off",
      cues: selected.map(c => ({ cue: String(c), part: input.part, looks: [look], timing: {} })),
      storeScope: { fixtures, attributes: filterAttributes },
      verifyStored: async cue => {
        const number = Math.round(Number(cue.cue) * 1000);
        const actual = await readNativeCueContent(ctx.bridge, cueRef(input.sequence, cue.cue), timeout, { context: { contextKey: prepared.identity, environment: "Preview" } });
        return verifyCueRangeEdit(onlyCue(native, number), onlyCue(actual, number, native.sequence), [Number(cue.cue)], ids, attributes, values, input.part, "tracking_forward", presets);
      },
    });
    built.steps.unshift(inspect);
    let verification: Verification = built.verification;
    if (built.cues.every(c => c.status === "stored") && built.verification.status === "matched") {
      try {
        if (!built.backInNormal || built.normalProgrammer !== "untouched") throw new Error("Normal programmer preservation is unconfirmed");
        const after = await readNativeCueContent(ctx.bridge, ref, timeout, { context: { contextKey: prepared.identity, environment: "Normal" } });
        if (await contextKey(ctx) !== prepared.identity) throw new Error("Console context changed after Store");
        verification = verifyCueRangeEdit(native, after, selected, ids, attributes, values, input.part, input.tracking, presets);
      } catch (error) { verification = unavailable(String(error)); }
      built.steps.push(asRead({ name: "verify_sequence_impact", status: verification.status === "matched" ? "succeeded" : "failed", op: "cue.content", detail: verification, error: verification.detail }));
    }
    return batchResult(OPERATION, target, built, { plan, fingerprint, notVerified: "Final stage output depends on playback arbitration and physical fixtures." }, verification);
  });
}

export const registerCueRangeEditTools: RegisterTools = (server, ctx) => {
  server.registerTool("gma3_edit_cue_values", {
    title: "Change scoped fixture values in existing cues",
    description: "Preview or merge explicit fixture attribute values or checked presets into existing cues and a specified part. Choose tracking_forward or cue_only. The default preview shows scoped channels and possible later cue changes. Applying requires exclusive:true and preview:false. Each scoped Store is verified from native cue content before continuing. Final verification checks protected stored and tracked layers.",
    inputSchema: inputShape,
  }, args => operation(async () => compactResult(await editCueValues(ctx, args), args.detail)));
};
