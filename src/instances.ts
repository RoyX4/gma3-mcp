/** Named routes share one server build; a profile never launches or replaces a console. */
import { z } from "zod";
import { isAbsolute } from "node:path";
import { readFileSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";

const absolute = z.string().refine(isAbsolute, "requires an absolute path");
const profile = z.object({
  station: z.string().min(1).max(128), shows: z.array(z.string().min(1).max(128)).min(1).max(100),
  host: z.literal("127.0.0.1").default("127.0.0.1"), port: z.number().int().min(1).max(65535),
  namespace: z.object({ receipt: absolute, runner: absolute, prefix: absolute }).strict().optional(),
  install_dir: absolute.optional(), local_ui_helper: absolute.optional(),
}).strict();
const configuration = z.object({ schemaVersion: z.literal(1), instances: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), profile) }).strict();
export type InstanceProfile = z.infer<typeof profile>;
export function parseInstanceProfile(input: unknown, name: string): InstanceProfile {
  const config = configuration.parse(input);
  const selected = config.instances[name];
  if (!selected) throw new Error(`Unknown instance ${JSON.stringify(name)}; choose one of ${Object.keys(config.instances).join(", ")}`);
  return selected;
}
export const instanceProfileDigest = (input: InstanceProfile) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
export function namespaceReceipt(input: InstanceProfile) {
  if (!input.namespace) return null;
  const receipt = z.object({ pid: z.number().int().positive(), networkNamespace: z.string().regex(/^net:\[\d+\]$/), prefix: absolute }).passthrough().parse(JSON.parse(readFileSync(input.namespace.receipt, "utf8")));
  if (receipt.prefix !== input.namespace.prefix) throw new Error("Namespace receipt prefix does not match the selected instance");
  const argv = readFileSync(`/proc/${receipt.pid}/cmdline`).toString().split("\0");
  if (!argv.includes(input.namespace.runner)) throw new Error("Namespace receipt PID no longer belongs to the configured instance runner");
  return receipt;
}
export function verifyInsideNamespace(input: InstanceProfile): void {
  const receipt = namespaceReceipt(input);
  if (receipt && readlinkSync("/proc/self/ns/net") !== receipt.networkNamespace) throw new Error("Wrong network namespace; refusing to connect");
}
