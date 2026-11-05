/** Colour planning only. The calibration data describes channel control, not measured photometry. */
import type { Expectation } from "./tools/fixtures.js";
import { attributeName } from "./validate.js";

type RGB = readonly [number, number, number];
export const NAMED_COLOURS: Readonly<Record<string, string>> = {
  black: "000000", white: "ffffff", red: "ff0000", lime: "00ff00", green: "008000",
  blue: "0000ff", cyan: "00ffff", aqua: "00ffff", magenta: "ff00ff", fuchsia: "ff00ff",
  yellow: "ffff00", orange: "ffa500", amber: "ffbf00", pink: "ffc0cb", purple: "800080",
  violet: "ee82ee", gold: "ffd700", teal: "008080", navy: "000080", lavender: "e6e6fa",
};
export type ColourRequest = { color?: string; kelvin?: number };
type ProfileBase = { fixture: number | string; zero_attributes?: string[] };
export type ColourProfile = ProfileBase & (
  { mode: "rgb" } |
  { mode: "cmy"; cyan: string; magenta: string; yellow: string } |
  { mode: "wheel"; attribute: string; slots: Array<{ name: string; color: string; percent?: number; dmx8?: number }> } |
  { mode: "cct"; attribute: string; kelvin_at_0: number; kelvin_at_100: number } |
  { mode: "white"; warm: string; cool: string; warm_kelvin: number; cool_kelvin: number }
);
export interface ColourPlan {
  fixture: string;
  mode: "rgb" | "cmy" | "wheel" | "cct" | "white";
  values: Expectation[];
  warnings: string[];
  selectedSlot?: { name: string; color: string; percent?: number; dmx8?: number; distance: number };
}

export function parseColour(input: string): RGB {
  const value = input.trim().toLowerCase();
  let hex = (Object.hasOwn(NAMED_COLOURS, value) ? NAMED_COLOURS[value] : undefined) ?? (/^#[\da-f]{3}$|^#[\da-f]{6}$/i.test(value) ? value.slice(1) : undefined);
  if (!hex) throw new Error(`unsupported colour ${JSON.stringify(input)}; use #RGB, #RRGGBB or one of ${Object.keys(NAMED_COLOURS).join(", ")}`);
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  return [0, 2, 4].map((offset) => parseInt(hex!.slice(offset, offset + 2), 16)) as unknown as RGB;
}

function boundedKelvin(value: number): number {
  if (!Number.isFinite(value) || value < 1000 || value > 20000) throw new Error("kelvin must be between 1000 and 20000");
  return value;
}

function inRange(value: number, a: number, b: number): void {
  boundedKelvin(value); boundedKelvin(a); boundedKelvin(b);
  if (a === b || value < Math.min(a, b) || value > Math.max(a, b)) throw new Error(`requested kelvin is outside the calibrated range ${Math.min(a, b)}..${Math.max(a, b)}`);
}

export function planColour(fixture: string, available: string[], request: ColourRequest, profile?: ColourProfile): ColourPlan {
  if ((request.color !== undefined) === (request.kelvin !== undefined)) throw new Error("exactly one of color or kelvin is required");
  const rgb = request.color === undefined ? undefined : parseColour(request.color);
  const mode = profile?.mode ?? "rgb";
  const present = new Map(available.map((name) => [name.toLowerCase(), name]));
  const values: Expectation[] = [];
  const warnings = ["Channel values are an uncalibrated colour approximation; a programmer match does not prove physical colour output."];
  const add = (name: string, value: number, unit: "percent" | "decimal8" = "percent") => {
    attributeName("attribute", name);
    const actualName = present.get(name.toLowerCase());
    if (!actualName) throw new Error(`Fixture ${fixture}: no supported colour mapping for missing attribute ${name}; use an explicit profile, or address its colour cells explicitly`);
    if (!Number.isFinite(value) || value < 0 || value > (unit === "decimal8" ? 255 : 100) || (unit === "decimal8" && !Number.isInteger(value))) throw new Error(`invalid calibrated ${unit} for ${name}`);
    if (values.some((entry) => entry.attribute.toLowerCase() === actualName.toLowerCase())) throw new Error(`attribute ${name} occurs twice in this colour mapping`);
    values.push({ attribute: actualName, value, unit });
  };
  const plan: ColourPlan = { fixture, mode, values, warnings };
  if (mode === "rgb") {
    if (!rgb) throw new Error("RGB needs color; kelvin requests require an explicit cct or white profile");
    ["ColorRGB_R", "ColorRGB_G", "ColorRGB_B"].forEach((name, i) => add(name, rgb[i] * 100 / 255));
  } else if (profile?.mode === "cmy") {
    if (!rgb) throw new Error("CMY needs color; kelvin requests require an explicit cct or white profile");
    [profile.cyan, profile.magenta, profile.yellow].forEach((name, i) => add(name, (255 - rgb[i]) * 100 / 255));
    warnings.push("CMY uses the caller's explicit subtractive channel mapping. Additive ColorRGB_C/M/Y emitters are never inferred to be CMY filters.");
  } else if (profile?.mode === "wheel") {
    if (!rgb) throw new Error("colour wheels need color, not kelvin");
    if (!profile.slots.length) throw new Error("a wheel profile needs at least one calibrated slot");
    const slots = profile.slots.map((slot) => {
      if ((slot.percent === undefined) === (slot.dmx8 === undefined)) throw new Error("each wheel slot needs exactly one of percent or dmx8");
      const sample = parseColour(slot.color);
      return { ...slot, distance: Math.sqrt(sample.reduce((sum, component, i) => sum + (component - rgb[i]) ** 2, 0)) };
    });
    const slot = slots.reduce((nearest, candidate) => candidate.distance < nearest.distance ? candidate : nearest);
    add(profile.attribute, slot.dmx8 ?? slot.percent!, slot.dmx8 === undefined ? "percent" : "decimal8");
    plan.selectedSlot = slot;
    warnings.push(`Nearest supplied wheel sample: ${slot.name}; RGB distance ${slot.distance.toFixed(2)}. This is an approximation, not a measured colour match.`);
  } else if (profile?.mode === "cct") {
    if (request.kelvin === undefined) throw new Error("a cct profile needs kelvin instead of color");
    inRange(request.kelvin, profile.kelvin_at_0, profile.kelvin_at_100);
    add(profile.attribute, 100 * (request.kelvin - profile.kelvin_at_0) / (profile.kelvin_at_100 - profile.kelvin_at_0));
    warnings.push("CCT percent is linearly interpolated between caller-supplied Kelvin endpoints; nonlinear fixture response is not inferred.");
  } else if (profile?.mode === "white") {
    if (request.kelvin === undefined) throw new Error("a white profile needs kelvin instead of color");
    if (profile.warm_kelvin >= profile.cool_kelvin) throw new Error("white profile warm_kelvin must be lower than cool_kelvin");
    inRange(request.kelvin, profile.warm_kelvin, profile.cool_kelvin);
    const cool = (1 / profile.warm_kelvin - 1 / request.kelvin) / (1 / profile.warm_kelvin - 1 / profile.cool_kelvin);
    add(profile.warm, Math.max(0, Math.min(100, 100 * (1 - cool))));
    add(profile.cool, Math.max(0, Math.min(100, 100 * cool)));
    warnings.push("Warm/cool channels use reciprocal-temperature interpolation at 100% combined level; spectral response and luminous flux need physical calibration.");
  }
  for (const name of profile?.zero_attributes ?? []) add(name, 0);
  const uncontrolled = available.filter((name) => /^(ColorRGB_|CTO$|CTC$|Color\d+$)/i.test(name) && !values.some((v) => v.attribute.toLowerCase() === name.toLowerCase()));
  if (uncontrolled.length) warnings.push(`Other colour attributes are left unchanged: ${uncontrolled.join(", ")}. Their current values may affect output; list intentional zeros in zero_attributes.`);
  return plan;
}
