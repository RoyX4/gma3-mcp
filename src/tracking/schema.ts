import { z } from "zod";
import { attributeName, cueNumber, objectName, Validator } from "../validate.js";
import { ATTRIBUTE_UNIT_NAMES } from "../tools/fixtures.js";
import { validateLooks } from "../tools/cuelists.js";

const target = { fixtures: z.string().min(1), note: z.string().max(1024).optional() };
const layer = z.enum(["absolute", "relative"]).default("absolute");
const attribute = z.string().min(1).transform((a) => attributeName("attribute", a));
const value = z.object({ ...target, kind: z.literal("value"), attribute, layer, value: z.number().finite(), unit: z.enum(ATTRIBUTE_UNIT_NAMES).default("percent") }).strict();
const off = z.object({ ...target, kind: z.literal("off"), attribute, layer }).strict();
const release = z.object({ ...target, kind: z.literal("release"), attribute, layer }).strict();
const preset = z.object({ ...target, kind: z.literal("preset"), pool: z.number().int().min(1).max(9999), preset: z.number().int().min(1).max(99999), attributes: z.array(attribute).min(1).max(64) }).strict();
const phaser = z.object({ ...target, kind: z.literal("phaser"), phaser: z.record(z.string(), z.unknown()), restart: z.boolean().default(false) }).strict();
export const changeSchema = z.discriminatedUnion("kind", [value, off, release, preset, phaser]);
export const trackingPlanSchema = z.object({
  version: z.literal(1),
  sequence: z.number().int().min(1).max(99999),
  data_pool: z.number().int().min(1).max(9999).optional(),
  sequence_name: z.string().optional(),
  cues: z.array(z.object({
    cue: z.union([z.number(), z.string()]).transform((n) => cueNumber("cue", n)!),
    name: z.string().optional(),
    mode: z.enum(["tracking", "cue_only", "block"]).default("tracking"),
    hold: z.boolean().default(false),
    changes: z.array(changeSchema).max(2000).default([]),
    fade: z.number().finite().min(0).max(86400).optional(),
    delay: z.number().finite().min(0).max(86400).optional(),
    out_fade: z.number().finite().min(0).max(86400).optional(),
    out_delay: z.number().finite().min(0).max(86400).optional(),
    trigger: z.enum(["go", "time", "follow", "sound", "bpm"]).optional(),
    time: z.number().finite().min(0).max(86400).optional(),
  }).strict()).min(1).max(10000),
}).strict();
export type TrackingPlan = z.infer<typeof trackingPlanSchema>;
export type Change = z.infer<typeof changeSchema>;

/** Deliberately does not resolve Groups or changing selections into guessed fixture identities. */
export function fixtureIds(expression: string): string[] {
  const text = expression.trim().replace(/^fixtures?\s+/i, "");
  const ids = new Set<string>();
  for (const part of text.split(/\s*\+\s*/)) {
    const single = /^(\d+)(?:\.(\d+))?$/.exec(part.trim());
    const range = /^(\d+)\s+(?:thru|through)\s+(\d+)$/i.exec(part.trim());
    if (single) {
      if (Number(single[1]) < 1 || Number(single[1]) > 999999 || (single[2] !== undefined && Number(single[2]) < 1)) throw new Error("invalid explicit fixture ID");
      ids.add(`${Number(single[1])}${single[2] ? `.${Number(single[2])}` : ""}`);
    } else if (range) {
      const from = Number(range[1]), to = Number(range[2]);
      if (from < 1 || to < from || to > 999999 || to - from > 10000) throw new Error("invalid explicit fixture range (maximum 10001 fixtures)");
      for (let n = from; n <= to; n++) ids.add(String(n));
    } else throw new Error("tracking plans require explicit fixture IDs/ranges joined by +; Groups and selections can change and must be resolved first");
    if (ids.size > 10000) throw new Error("at most 10000 explicit fixtures in one change");
  }
  return [...ids].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export function parsePlan(raw: unknown): TrackingPlan {
  const plan = trackingPlanSchema.parse(raw);
  if (plan.sequence_name !== undefined) plan.sequence_name = objectName("sequence_name", plan.sequence_name);
  let previous = -1, cells = 0;
  for (const cue of plan.cues) {
    if (Number(cue.cue) <= previous) throw new Error("cues must have unique ascending cue numbers (playback order)");
    previous = Number(cue.cue);
    if (cue.name !== undefined) cue.name = objectName("name", cue.name);
    if (cue.hold && (cue.changes.length || cue.mode !== "tracking")) throw new Error(`cue ${cue.cue}: hold requires no changes and tracking mode`);
    if (!cue.hold && !cue.changes.length && cue.mode !== "block") throw new Error(`cue ${cue.cue}: an empty cue requires hold:true`);
    if ((cue.trigger === "time" || cue.trigger === "follow") && cue.time === undefined) throw new Error(`cue ${cue.cue}: timed trigger requires time`);
    if (cue.time !== undefined && cue.trigger !== "time" && cue.trigger !== "follow") throw new Error(`cue ${cue.cue}: time requires time/follow trigger`);
    for (const change of cue.changes) {
      const fixtures = fixtureIds(change.fixtures);
      change.fixtures = fixtures.join(" + ");
      if (change.kind === "off" && change.attribute.toLowerCase() !== "dimmer") throw new Error("off means explicit zero Dimmer; use a value or release for other attributes");
      if (change.kind === "off" && change.layer !== "absolute") throw new Error("off requires absolute zero Dimmer; relative zero is a value and does not turn a fixture off");
      if (change.kind === "value") {
        const signed = change.layer === "relative";
        if (signed && change.unit !== "percent" && change.unit !== "physical") throw new Error("relative values require explicit percent or physical units for verified execution");
        if ((change.unit === "percent" || change.unit === "percent_fine") && (change.value > 100 || change.value < (signed ? -100 : 0))) throw new Error("percent values must be 0..100 (relative -100..100)");
        const bits = /^decimal(8|16|24)$/.exec(change.unit);
        if (bits && (!Number.isInteger(change.value) || change.value < 0 || change.value > 2 ** Number(bits[1]) - 1)) throw new Error("decimal value is outside its integer range");
      }
      if (change.kind === "phaser") {
        const v = new Validator();
        validateLooks(v, { fixtures: change.fixtures, phaser: change.phaser }, "phaser", undefined);
        if (!v.ok) throw new Error(v.errors.join("; "));
      }
      if (change.kind === "preset" && new Set(change.attributes.map((a) => a.toLowerCase())).size !== change.attributes.length) throw new Error("preset coverage contains duplicate attributes");
      cells += fixtures.length * (change.kind === "preset" ? change.attributes.length : change.kind === "phaser" ? phaserAttributes(change.phaser).length : 1);
      if (cells > 200000) throw new Error("plan exceeds 200000 explicit assignments");
    }
  }
  return plan;
}

export function phaserAttributes(phaser: Record<string, unknown>): string[] {
  const attrs = new Set<string>();
  for (const step of phaser.steps as Array<{ values: Record<string, unknown> }>) for (const key of Object.keys(step.values)) attrs.add(attributeName("phaser attribute", key));
  return [...attrs].sort();
}
