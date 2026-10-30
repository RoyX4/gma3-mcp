import type { FastContext } from "./fastpath.js";

/** Shared checkpoint/recovery identity policy. An unreadable required field is always a difference. */
export function consoleIdentityDifferences(before: FastContext["identity"], after: FastContext["identity"], allowGenerationChange = false): string[] {
  const keys: Array<"hostname" | "showfile" | "user" | "profile" | "generation"> = ["hostname", "showfile", "user", "profile", ...(allowGenerationChange ? [] : ["generation" as const])];
  return keys.filter(key => typeof before[key] !== "string" || !before[key] || before[key] !== after[key]);
}
