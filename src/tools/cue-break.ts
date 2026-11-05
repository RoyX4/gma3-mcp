import { z } from "zod";
import { readFields, readObjects } from "./common.js";
import type { ToolContext } from "./context.js";

export const cueBreakSchema = z.object({ kind: z.enum(["world", "filter"]), number: z.number().int().min(1).max(99999) }).strict().nullable();
type Request = z.infer<typeof cueBreakSchema>;
type Handle = { class: "World" | "Filter"; addr: string; name?: string };
export type BreakPlan = { expected: Handle | null; command: string; cue: string };
const clearEdit = "#FFFFFFFFFFFFFFFF";

function handle(raw: unknown): Handle | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { class: kind, addr, name } = raw as Record<string, unknown>;
  if ((kind !== "World" && kind !== "Filter") || typeof addr !== "string" || !addr) return null;
  return { class: kind, addr, ...(typeof name === "string" ? { name } : {}) };
}

export function sameCueBreak(a: Handle | null, b: Handle | null): boolean {
  return a === null || b === null ? a === b : a.class === b.class && a.addr === b.addr;
}

export async function readCueBreak(ctx: ToolContext, cue: string, knownEdit?: unknown): Promise<Handle | null> {
  const fields = await readFields(ctx.bridge, cue, ["Break"], { asText: false });
  if (!fields) throw new Error("Cue Break handle is unavailable");
  const current = handle(fields.Break);
  if (current) return current;
  const edit = knownEdit ?? (await readFields(ctx.bridge, cue, ["Break"]))?.Break;
  if (fields.Break === undefined && edit === clearEdit) return null;
  throw new Error("Cue Break handle or cleared marker is unavailable");
}

export async function resolveCueBreak(ctx: ToolContext, cue: string, request: Request): Promise<BreakPlan> {
  if (request === null) return { expected: null, cue, command: `Set ${cue} Property "Break" ""` };
  const kind = request.kind === "world" ? "World" : "Filter";
  const ref = `${kind} ${request.number}`;
  const result = await readObjects(ctx.bridge, ref, kind === "Filter" ? ["HasDynamicFilterRules"] : [], 1);
  const resolved = result?.items[0];
  const expected = handle(resolved);
  if (result?.total !== 1 || !resolved || resolved.invalid || !expected || expected.class !== kind) throw new Error(`${ref} must resolve to one ${kind} with a readable native address`);
  if (kind === "Filter" && String(resolved.fields?.HasDynamicFilterRules).trim().toLowerCase() !== "no") {
    throw new Error(`${ref} must be confirmed static by HasDynamicFilterRules = No`);
  }
  return { expected, cue, command: `Assign ${ref} At ${cue}` };
}
