import type { Gma3Bridge } from "./bridge.js";
import { classifyFeedback, requestStep, type StepResult } from "./results.js";

export const PREVIEW_COMMAND_SERIES = "fast.previewCommands";

export function canGroupStaticLook(fixtures: string, valueCount: number): boolean {
  return fixtures.length <= 1024 && /^Fixture \d+(?:\.\d+)*(?: (?:Thru|[+-]) \d+(?:\.\d+)*)*$/i.test(fixtures)
    && valueCount >= 1 && valueCount <= 14;
}

export async function previewSeriesContext(bridge: Gma3Bridge, timeoutMs: number): Promise<string | undefined> {
  try {
    const state = await bridge.request<Record<string, unknown>>("fast.context", {}, timeoutMs);
    if (state?.previewCommandSeries === 1 && state.environment === "Normal" && typeof state.contextKey === "string"
        && state.contextKey.length > 0 && Array.isArray(state.identityUncertain) && state.identityUncertain.length === 0) return state.contextKey;
  } catch {
    // Capability discovery is read-only. Old bridges retain the existing individual command path.
  }
  return undefined;
}

export function previewSeriesStep(bridge: Gma3Bridge, name: string, contextKey: string, commands: string[], timeoutMs: number): Promise<StepResult> {
  return requestStep(bridge, name, PREVIEW_COMMAND_SERIES, { contextKey, commands }, raw => {
    const result = raw as { status?: unknown; steps?: Array<{ command?: unknown; status?: unknown; feedback?: unknown; error?: unknown }> } | null;
    const steps = result?.steps;
    const invalid = (): StepResult => ({
      name, op: PREVIEW_COMMAND_SERIES, status: "unknown", detail: raw,
      error: "Preview command receipts were incomplete or inconsistent. Inspect the programmer before trying again.",
    });
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > commands.length) return invalid();
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step || step.command !== commands[i] || !["succeeded", "failed", "unknown"].includes(String(step.status))) return invalid();
      if (step.status === "succeeded" && classifyFeedback(step.feedback) !== "ok") return invalid();
      if (i + 1 < steps.length && step.status !== "succeeded") return invalid();
    }
    const last = steps.at(-1)!;
    if (last.status !== result?.status || (last.status === "succeeded" && steps.length !== commands.length)) return invalid();
    const status = last.status as StepResult["status"];
    return {
      name, op: PREVIEW_COMMAND_SERIES, status, detail: { steps },
      ...(status !== "succeeded" ? { error: `${last.command}: ${last.error ?? last.feedback ?? status}` } : {}),
    };
  }, timeoutMs);
}
