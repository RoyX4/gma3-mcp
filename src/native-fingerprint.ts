/** Lossless normalization of the bridge's explicitly encoded native JSON fields. */
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 2_000_000;
export const NATIVE_CONTENT_FINGERPRINT_VERSION = "native-json-v2" as const;
type Budget = { bytes: number; nodes: number };
type JsonContext = { source?: string };
const parse = JSON.parse as (text: string, reviver: (key: string, value: unknown, context: JsonContext) => unknown) => unknown;
const nativeJson = JSON as unknown as { rawJSON(source: string): object; isRawJSON(value: unknown): boolean };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Compare decimal Lua numeric keys without Number rounding; their original spelling stays in the hash. */
function numericKeyIdentity(key: string): string {
  const parts = key.length <= 128 ? /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d{1,4}))?$/.exec(key) : null;
  if (!parts || !Number.isFinite(Number(key))) throw new Error("Invalid native numeric table key");
  let digits = (parts[2] + (parts[3] ?? "")).replace(/^0+/, "");
  if (!digits) return "0";
  if (Number(key) === 0) throw new Error("Native numeric table key underflows");
  let exponent = BigInt(parts[4] ?? "0") - BigInt(parts[3]?.length ?? 0);
  while (digits.endsWith("0")) { digits = digits.slice(0, -1); exponent++; }
  return `${parts[1]}${digits}e${exponent}`;
}

/** JSON.parse validates grammar; this bounded lexical pass also rejects duplicate object keys. */
function scan(text: string, budget: Budget) {
  budget.bytes += Buffer.byteLength(text);
  if (budget.bytes > MAX_BYTES) throw new Error("Encoded native JSON exceeds byte bound");
  const stack: Array<{ object: boolean; key: boolean; keys: Set<string> }> = [];
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (/\s/.test(char) || char === ":") { i++; continue; }
    if (char === ",") { const top = stack.at(-1); if (top?.object) top.key = true; i++; continue; }
    if (char === "}" || char === "]") { stack.pop(); i++; continue; }
    if (++budget.nodes > MAX_NODES) throw new Error("Encoded native JSON exceeds value bound");
    if (char === "{" || char === "[") {
      stack.push({ object: char === "{", key: char === "{", keys: new Set() });
      if (stack.length > MAX_DEPTH) throw new Error("Encoded native JSON exceeds depth bound");
      i++; continue;
    }
    if (char === '"') {
      const start = i++;
      while (i < text.length) { if (text[i] === "\\") i += 2; else if (text[i++] === '"') break; }
      const top = stack.at(-1);
      if (top?.object && top.key) {
        const key: unknown = JSON.parse(text.slice(start, i));
        if (typeof key !== "string" || top.keys.has(key)) throw new Error("Duplicate encoded native JSON key");
        top.keys.add(key); top.key = false;
      }
      continue;
    }
    while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
  }
}

function parseBoundedNativeJson(text: string, budget: Budget): unknown {
  scan(text, budget);
  return parse(text, (_key, value, context) => {
    if (typeof value !== "number") return value;
    if (!Number.isFinite(value) || typeof context?.source !== "string") throw new Error("Lossless finite native JSON number unavailable");
    // Node24's source/RawJSON preserve integers beyond Number's exact range, without a custom JSON parser.
    return nativeJson.rawJSON(context.source);
  });
}

/** Preserve numeric atoms before recursively projecting a parsed native tree; stringify it into its native wrapper. */
export function parseNativeJson(text: string): unknown {
  return parseBoundedNativeJson(text, { bytes: 0, nodes: 0 });
}
export function isNativeRawJson(value: unknown): boolean { return nativeJson.isRawJSON(value); }

function encoded(text: string, mode: "ordinary" | "raw" | "view", budget: Budget): string {
  const parsed = parseBoundedNativeJson(text, budget);
  const order = (value: unknown, path: Array<string | number> = []): unknown => {
    if (nativeJson.isRawJSON(value)) return value;
    if (Array.isArray(value)) return value.map((item, i) => order(item, [...path, i]));
    if (!record(value)) return value;
    const nativeValue = mode === "raw" || mode === "view" && path.some((key, i) => key === "configuration" && path.slice(i + 1).some((part, j, rest) => part === "properties" && typeof rest[j + 1] === "number" && rest[j + 2] === "value"));
    if (nativeValue && Object.keys(value).length === 1 && Object.hasOwn(value, "entries")) {
      if (!Array.isArray(value.entries)) throw new Error("Native typed table entries are unavailable");
      const keys = new Set<string>();
      const entries = value.entries.map((entry) => {
        if (!record(entry) || Object.keys(entry).length !== 3 || !Object.hasOwn(entry, "value") || typeof entry.keyType !== "string" || !["number", "string"].includes(entry.keyType) || typeof entry.key !== "string") throw new Error("Malformed native typed table entry");
        const key = `${entry.keyType}\0${entry.keyType === "number" ? numericKeyIdentity(entry.key) : entry.key}`;
        if (keys.has(key)) throw new Error("Duplicate native typed table key");
        keys.add(key);
        return { keyType: entry.keyType, key: entry.key, value: order(entry.value, [...path, "entries", entry.key]) };
      });
      entries.sort((a, b) => compare(String(a.keyType), String(b.keyType)) || compare(a.key, b.key));
      return { entries };
    }
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b)).map(([key, item]) => [key, order(item, [...path, key])]));
  };
  return JSON.stringify(order(parsed));
}

/** Only named encoded fields are parsed; ordinary arrays and coincidental entries objects keep their order. */
export function canonicalNativeData(value: unknown): unknown {
  const budget: Budget = { bytes: 0, nodes: 0 };
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) throw new Error("Native content exceeds depth bound");
    if (isNativeRawJson(item)) return item;
    if (Array.isArray(item)) return item.map((entry) => visit(entry, depth + 1));
    if (!record(item)) return item;
    return Object.fromEntries(Object.entries(item).map(([key, entry]) => {
      if (key !== "contentJson" && key !== "rawChannelsJson") return [key, visit(entry, depth + 1)];
      if (typeof entry !== "string") throw new Error(`Encoded native ${key} is not a string`);
      const mode = key === "rawChannelsJson" ? "raw" : ["saved_view", "live_screens"].includes(String(item.kind)) ? "view" : "ordinary";
      return [key, encoded(entry, mode, budget)];
    }));
  };
  return visit(value, 0);
}
