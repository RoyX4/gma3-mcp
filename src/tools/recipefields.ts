/** Recipe property vocabulary grounded in the bundled 2.5 system tests and Recipe Editor manual. */
import { ValidationError, finiteNumber, objectNumber } from "../validate.js";

export type RecipeFilter = { kind: "filter" | "world"; number: number };
export const RECIPE_TIMING_FIELDS = ["FadeFromX", "FadeToX", "FadeFromY", "FadeToY", "FadeFromZ", "FadeToZ", "DelayFromX", "DelayToX", "DelayFromY", "DelayToY", "DelayFromZ", "DelayToZ", "SpeedFromX", "SpeedToX", "SpeedFromY", "SpeedToY", "SpeedFromZ", "SpeedToZ", "PhaseFromX", "PhaseToX", "PhaseFromY", "PhaseToY", "PhaseFromZ", "PhaseToZ"] as const;
export type RecipeTiming = Partial<Record<(typeof RECIPE_TIMING_FIELDS)[number], number | null>>;

export function parseRecipeFilter(raw: unknown): RecipeFilter | null | undefined {
  if (raw === undefined || raw === null) return raw;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("filter must be {kind: filter|world, number} or null", "filter");
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "kind" && k !== "number") || (o.kind !== "filter" && o.kind !== "world")) throw new ValidationError("filter must be {kind: filter|world, number}", "filter");
  return { kind: o.kind, number: objectNumber("filter.number", o.number, { max: 9999 })! };
}

export function parseRecipeTiming(raw: unknown): RecipeTiming | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0) throw new ValidationError("timing must be a non-empty object of recipe timing properties", "timing");
  const out: RecipeTiming = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(RECIPE_TIMING_FIELDS as readonly string[]).includes(key)) throw new ValidationError(`unknown recipe timing property ${key}`, "timing");
    const field = key as keyof RecipeTiming;
    const phase = key.startsWith("Phase");
    out[field] = value === null ? null : finiteNumber(`timing.${key}`, value, { min: phase ? -36000 : 0, max: phase ? 36000 : key.startsWith("Speed") ? 36000 : 918000 })!;
  }
  return out;
}

export function recipeProperty(value: unknown): number | null | string {
  if (value === undefined || value === null || value === "" || String(value).toLowerCase() === "none") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(String(value));
  return Number.isFinite(n) ? n : String(value);
}
