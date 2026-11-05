import type { Gma3Bridge } from "./bridge.js";

export const FAST_BATCH_OPS = ["cmd", "set", "object", "children", "objects", "getfader", "fixtureAttributes", "programmer", "fixtureOutput", "cueContents", "cue.content", "view.content", "feedback.read", "feedback.context", "group.read", "selection.grid", "preset.read", "timecode.read"] as const;
export interface FastContext {
  identity: { generation: string; hostname?: string; showfile?: string; user?: string; profile?: string; epoch?: number };
  contextKey?: string;
  identityUncertain: string[];
  environment?: string;
  observedAt: number;
  atomic: false;
}
export interface FastBatchStep {
  name?: string;
  op: (typeof FAST_BATCH_OPS)[number];
  args: Record<string, unknown>;
  expect?: { path: string; value: unknown };
}

/** Refuse a batch before any bridge request; Lua enforces these bounds again at the trust boundary. */
export function validateFastBatch(steps: FastBatchStep[]): string[] {
  const errors: string[] = [];
  if (steps.length < 1 || steps.length > 128) errors.push("steps must contain 1..128 entries");
  if (Buffer.byteLength(JSON.stringify(steps), "utf8") > 128 * 1024) errors.push("steps exceed 128 KiB");
  for (const [i, step] of steps.entries()) {
    if (!FAST_BATCH_OPS.includes(step.op)) errors.push(`steps[${i}].op is unsupported`);
    if (step.op === "cmd") {
      const command = step.args.command;
      if (typeof command !== "string" || !command || Buffer.byteLength(command, "utf8") > 8192 || /[;\x00-\x1f\x7f]/.test(command)) {
        errors.push(`steps[${i}] needs one bounded command without semicolons or control characters`);
      } else {
        const plain = command.replace(/"[^"]*"|'[^']*'/g, "");
        if (/\b(lua|cmd|plugin)\b/i.test(plain)) errors.push(`steps[${i}] cannot execute Lua, nested Cmd or Plugin`);
      }
    }
    if (step.op === "set" && (typeof step.args.ref !== "string" || typeof step.args.property !== "string" || !["string", "number", "boolean"].includes(typeof step.args.value))) {
      errors.push(`steps[${i}] set needs ref, property and a primitive value`);
    }
  }
  return errors;
}

export async function readFastContext(bridge: Gma3Bridge, timeoutMs?: number): Promise<FastContext> {
  return bridge.request<FastContext>("fast.context", {}, timeoutMs);
}
