/** Frozen native cue paging. No command, property write, or retry is performed. */
import type { Gma3Bridge } from "./bridge.js";
import { nativeContentFingerprint } from "./native-cues.js";

const PROTOCOL = "gma3-cue-snapshot-v1";
const PAGE_SIZE = 200;
export const MAX_NATIVE_CUE_OBJECTS = 10002;
const MAX_BYTES = 32 * 1024 * 1024;
const PAGING_FIELDS = new Set(["protocol", "snapshotId", "contextKey", "environment", "frozen", "atomic", "capturedAt", "expiresAt", "total", "capturedCount", "offset", "count", "nextCursor", "cueOrder"]);
type Row = Record<string, unknown>;
interface ReadOptions {
  requirePaging?: boolean;
  context?: { contextKey: string; environment?: string };
}
const record = (v: unknown): v is Row => v !== null && typeof v === "object" && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const metadata = (page: Row): Row => Object.fromEntries(Object.entries(page).filter(([key]) => key !== "cues" && !PAGING_FIELDS.has(key)));

/** Older bridges cannot safely begin a job that will exceed their complete native scan. */
export async function requireNativeCuePaging(bridge: Gma3Bridge, requiredObjects: number, timeoutMs: number): Promise<void> {
  if (!Number.isSafeInteger(requiredObjects) || requiredObjects < 0 || requiredObjects > MAX_NATIVE_CUE_OBJECTS) throw new Error("Native cue snapshot object limit exceeded");
  let value: unknown;
  try { value = await bridge.request("cue.content", { action: "capabilities" }, timeoutMs); }
  catch (error) { throw new Error(`Native cue paging is required before this large job can start: ${String(error)}`); }
  if (!record(value) || value.protocol !== PROTOCOL || value.frozen !== true || !integer(value.maxCueObjects) || value.maxCueObjects < requiredObjects
    || !integer(value.maxPageCues) || value.maxPageCues < PAGE_SIZE) throw new Error("Maintained native cue snapshot paging capability is required before this large job can start");
}

/** Assemble original semantic native data; snapshot IDs, cursors and timestamps never alter its fingerprint. */
export async function readNativeCueContent(bridge: Gma3Bridge, ref: string, timeoutMs: number, options: ReadOptions = {}): Promise<Row> {
  const first = await bridge.request<unknown>("cue.content", { ref, action: "create", limit: PAGE_SIZE, ttlMs: 60000, maxCaptureMs: 15000 }, timeoutMs);
  if (!record(first)) throw new Error("Native cue content is not an object");
  if (first.snapshotId === undefined) {
    if (options.requirePaging) throw new Error("Native cue snapshot paging is required for this large checkpoint");
    if (Object.keys(first).some(key => PAGING_FIELDS.has(key))) throw new Error("Malformed native cue snapshot response");
    if (Array.isArray(first.cues) && first.cues.length > 500) throw new Error("Legacy native cue content exceeds the maintained 500-object limit; upgrade the bridge for paging");
    return Array.isArray(first.cues) ? first : { ...first, complete: false, limitations: [...(Array.isArray(first.limitations) ? first.limitations : []), "Native cue list is unavailable"] };
  }
  const snapshotId = first.snapshotId;
  if (!text(snapshotId)) throw new Error("Native cue snapshot identity is unavailable");
  let result: Row | undefined, failure: unknown;
  try {
    const total = first.total, order = first.cueOrder, context = first.contextKey, environment = first.environment;
    if (first.protocol !== PROTOCOL || first.frozen !== true || first.atomic !== false || !text(context) || !["Normal", "Preview"].includes(String(environment))) throw new Error("Native cue snapshot protocol/context is unavailable");
    if (options.context && (context !== options.context.contextKey || options.context.environment !== undefined && environment !== options.context.environment)) {
      throw new Error("Native cue snapshot does not match the expected console context or environment");
    }
    if (!integer(total) || total < 0 || total > MAX_NATIVE_CUE_OBJECTS || first.capturedCount !== total) throw new Error("Native cue snapshot total exceeds coverage bounds");
    if (!Array.isArray(order) || order.length !== total || !order.every(text) || new Set(order).size !== total) throw new Error("Native cue snapshot membership/order is invalid");
    if (typeof first.complete !== "boolean" || !Array.isArray(first.limitations)) throw new Error("Native cue snapshot source coverage is unavailable");
    const meta = metadata(first), metaHash = nativeContentFingerprint(meta), cues: unknown[] = [], seen = new Set<string>();
    let page = first, bytes = Buffer.byteLength(JSON.stringify(meta)), offset = 0;
    while (true) {
      if (page.protocol !== PROTOCOL || page.snapshotId !== snapshotId || page.contextKey !== context || page.environment !== environment || page.frozen !== true || page.atomic !== false
        || page.total !== total || page.capturedCount !== total || page.capturedAt !== first.capturedAt || page.expiresAt !== first.expiresAt) throw new Error("Native cue snapshot identity or coverage changed between pages");
      if (nativeContentFingerprint(metadata(page)) !== metaHash) throw new Error("Native cue snapshot metadata changed between pages");
      if (page.cueOrder !== undefined && JSON.stringify(page.cueOrder) !== JSON.stringify(order)) throw new Error("Native cue snapshot membership/order changed between pages");
      const count = page.count, remaining = total - offset;
      if (page.offset !== offset || !integer(count) || count < (remaining > 0 ? 1 : 0) || count > Math.min(PAGE_SIZE, remaining)
        || !Array.isArray(page.cues) || page.cues.length !== count) throw new Error("Native cue page count/offset does not cover the expected range");
      for (let i = 0; i < page.cues.length; i++) {
        const cue = page.cues[i];
        if (!record(cue) || cue.addr !== order[offset + i] || !Array.isArray(cue.parts) || seen.has(String(cue.addr))) throw new Error("Native cue page contains missing, duplicate or reordered members");
        seen.add(String(cue.addr)); cues.push(cue);
      }
      bytes += Buffer.byteLength(JSON.stringify(page.cues));
      if (bytes > MAX_BYTES) throw new Error("Native cue snapshot byte budget exceeded");
      offset += count;
      const next = offset < total ? `${snapshotId}/${offset}` : null;
      if ((page.nextCursor ?? null) !== next) throw new Error("Native cue page cursor does not match its covered range");
      if (next === null) break;
      const value = await bridge.request<unknown>("cue.content", { action: "page", snapshotId, cursor: next, limit: PAGE_SIZE }, timeoutMs);
      if (!record(value)) throw new Error("Native cue page is unavailable");
      page = value;
    }
    result = { ...meta, cues };
  } catch (error) { failure = error; }
  try {
    const released = await bridge.request<{ released?: unknown }>("cue.content", { action: "release", snapshotId }, timeoutMs);
    if (released?.released !== true) throw new Error("Native cue snapshot release was not confirmed");
  } catch (error) { failure = new Error(`${failure ? String(failure) + "; " : ""}Native cue snapshot release failed: ${String(error)}`); }
  if (failure) throw failure;
  return result!;
}
