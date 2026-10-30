import type { Gma3Bridge } from "./bridge.js";

/** Fresh environment-only guards; full programmer proof remains the caller's responsibility. */
export function createEnvironmentReader(
  bridge: Gma3Bridge,
  timeoutMs: number,
  fallback: () => Promise<string | null | undefined>,
  warn: (message: string) => void = () => {},
): () => Promise<{ environment: string | null; op: "feedback.read" | "programmer" }> {
  let useFeedback = true;
  return async () => {
    if (useFeedback) {
      let reason = "previewMode feedback was unavailable or malformed";
      try {
        const data = await bridge.request<{ items?: Array<{ name?: string; available?: boolean; value?: unknown }> }>(
          "feedback.read", { readers: ["previewMode"] }, Math.min(timeoutMs, 1000),
        );
        const item = Array.isArray(data?.items) ? data.items.find((row) => row?.name === "previewMode") : undefined;
        if (item?.available === true && (item.value === "Normal" || item.value === "Preview")) return { environment: item.value, op: "feedback.read" };
      } catch (error) { reason = error instanceof Error ? error.message : String(error); }
      useFeedback = false;
      warn(`Environment-only feedback unavailable (${reason}); complete programmer reads are used for the remaining environment guards in this call.`);
    }
    return { environment: (await fallback()) ?? null, op: "programmer" };
  };
}
