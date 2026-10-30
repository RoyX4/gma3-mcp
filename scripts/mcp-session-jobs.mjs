const states = new Set(["prepared", "running", "completed", "cancelled", "paused", "blocked", "failed", "uncertain"]);
function jobState(result) {
  const text = result?.content?.filter(item => item.type === "text").map(item => item.text).join("\n");
  try {
    const state = JSON.parse(text);
    return state && typeof state.id === "string" && states.has(state.status) ? state : undefined;
  } catch { return undefined; }
}

/** A piped CLI owns the stdio server lifetime: EOF must not terminate its still-running programming job. */
export async function waitForProgrammingJob(client, request, initial, options = {}) {
  if (request.tool !== "gma3_programming_job" || request.args?.run !== true || !["run", "resume"].includes(request.args?.action) || initial.isError) return { result: initial };
  let state = jobState(initial), result = initial;
  if (!state || state.status !== "running") return { result };
  const id = state.id, began = performance.now(), delayMs = options.delayMs ?? 1000;
  let polls = 0, lastProgress = "", readTimeouts = 0;
  const progress = value => {
    const key = JSON.stringify([value.status, value.progress, value.inFlight?.progress?.phase, value.inFlight?.progress?.completedRequests, value.readTimeouts]);
    if (key !== lastProgress) { lastProgress = key; options.onProgress?.(value); }
  };
  progress(state);
  while (state.status === "running") {
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    try {
      result = await client.callTool({ name: "gma3_programming_job", arguments: { action: "status", id } }, undefined, { timeout: Math.max(1000, request.timeout_ms ?? 60000) });
      polls++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A status timeout is a read failure. Retrying that read is safe; run/resume is never replayed.
      if (/timed?\s*out|timeout/i.test(message)) { readTimeouts++; progress({ id, status: "running", readTimeouts, error: `status read timed out; waiting without replay: ${message}` }); continue; }
      throw new Error(`Job ${id} lost its server connection while running: ${message}. Inspect its durable journal before further programming; never replay the start request.`);
    }
    const observed = jobState(result);
    if (!observed || observed.id !== id) throw new Error(`Job ${id} returned an unreadable status. Inspect its durable journal; no start request was replayed.`);
    state = observed; progress(state);
  }
  return { result, jobWait: { id, polls, readTimeouts, ms: Math.round((performance.now() - began) * 100) / 100, terminalStatus: state.status } };
}
