import { z } from "zod";
import { nativeContentFingerprint } from "../native-cues.js";
import { isNativeRawJson, parseNativeJson } from "../native-fingerprint.js";
import type { Verification } from "../results.js";
import { json, type RegisterTools, type ToolContext } from "./context.js";

export interface ViewContent { complete: true; contentJson: string; metadata?: { screenContentMask?: unknown }; [key: string]: unknown }
/** Keep native numeric lexemes intact through configuration projections and public detail output. */
export function viewContentWindows(content: Pick<ViewContent, "contentJson">): Array<Record<string, any>> {
  const windows = parseNativeJson(content.contentJson);
  if (!Array.isArray(windows)) throw new Error("Native window configuration is malformed");
  return windows;
}
/** Both saved and live configurations use the same explicit native view encoding. */
export function viewContentFingerprint(content: Pick<ViewContent, "contentJson">): string {
  return nativeContentFingerprint({ kind: "live_screens", contentJson: content.contentJson });
}
export async function readViewContent(ctx: ToolContext, target: { ref: string } | { screens: number[] }): Promise<ViewContent> {
  const result = await ctx.bridge.request<Record<string, unknown>>("view.content", target, ctx.requestTimeoutMs);
  if (result.complete !== true || typeof result.contentJson !== "string" || Buffer.byteLength(result.contentJson) > 4 * 1024 * 1024) throw new Error("Complete native window configuration is unavailable; no content match can be claimed");
  viewContentWindows(result as ViewContent);
  return result as ViewContent;
}
const RENDER_EXCLUSIONS = ["automatically generated GridLine names, sizes and visibility", "cached child counts in object references"];
function recalledConfiguration(value: unknown): unknown {
  if (isNativeRawJson(value)) return value;
  if (Array.isArray(value)) return value.map(recalledConfiguration);
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, any>;
  const copy: Record<string, unknown> = Object.fromEntries(Object.entries(item).map(([key, val]) => [key, recalledConfiguration(val)]));
  if (item.class === "GridLine") {
    if (typeof item.name === "string" && /^GridLine \d+$/.test(item.name)) copy.name = "GridLine";
    if (Array.isArray(item.properties)) copy.properties = item.properties.filter((property: any) => !["SIZE", "VISIBLE"].includes(property.name)).map((property: any) => property.name === "NAME" && /^GridLine \d+$/.test(String(property.value)) ? { ...property, value: "GridLine" } : recalledConfiguration(property));
  }
  if (Array.isArray(item.entries) && item.entries.some((entry: any) => entry.key === "addr") && item.entries.some((entry: any) => entry.key === "class")) copy.entries = item.entries.filter((entry: any) => entry.key !== "childCount").map(recalledConfiguration);
  return copy;
}
export function compareViewContent(expected: ViewContent, actual: ViewContent, remapScreen?: number): Verification {
  const windows = viewContentWindows(expected);
  if (remapScreen !== undefined) for (const window of windows) {
    window.screen = remapScreen;
    for (const property of window.configuration?.properties ?? []) if (property.name === "DISPLAY") property.value = typeof property.value === "string" ? String(remapScreen) : remapScreen;
  }
  const observed = viewContentWindows(actual);
  const beforeHash = viewContentFingerprint({ contentJson: JSON.stringify(recalledConfiguration(windows)) }), afterHash = viewContentFingerprint({ contentJson: JSON.stringify(recalledConfiguration(observed)) });
  return { status: beforeHash === afterHash ? "matched" : "mismatched", checked: "actual native window rectangles and persisted nested settings (MA-generated GridLine caches excluded)", expected: { fingerprint: beforeHash, windows: windows.length }, actual: { fingerprint: afterHash, windows: observed.length, excluded: RENDER_EXCLUSIONS },
    ...(beforeHash === afterHash ? {} : { detail: "The observed native window configuration differs from the saved or sampled configuration." }) };
}
export const registerViewContentTools: RegisterTools = (server, ctx) => {
  server.registerTool("gma3_view_contents", {
    title: "Read saved or live window configuration",
    description: "READ ONLY: retrieve actual saved ViewWidget trees, rectangles and nested persisted settings, or current native ScreenContent. Reports complete bounded coverage and a stable content fingerprint. Runtime IDs/GUIDs, engine state and screenshot pixels are excluded. Does not recall, store or change windows. Requires the view.content bridge capability, with no arbitrary Lua tool needed.",
    inputSchema: { view: z.number().int().min(1).max(99999).optional(), screens: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(), detail: z.boolean().default(false) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async args => {
    try {
      if ((args.view === undefined) === (args.screens === undefined)) throw new Error("Choose one saved view or explicit live screens");
      if (args.screens && new Set(args.screens).size !== args.screens.length) throw new Error("screens must be distinct");
      const result = await readViewContent(ctx, args.view === undefined ? { screens: args.screens! } : { ref: `View ${args.view}` });
      const { contentJson, ...metadata } = result;
      const windows = viewContentWindows(result);
      return json({ ...metadata, fingerprint: viewContentFingerprint(result), ...(args.detail ? { windows } : { windowCount: windows.length }) });
    } catch (err) { return { ...json({ error: err instanceof Error ? err.message : String(err) }), isError: true }; }
  });
};
