/** Optional Linux/Wine app-only observation. Disabled unless a local helper is configured. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { crc32 } from "node:zlib";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolContext } from "./context.js";

const MAX_PNG_BYTES = 6 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 9 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 10_000;
const MAX_SIDE = 16_384;
const MAX_PIXELS = 16_777_216;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Test seam; production always executes a fixed Python interpreter without a shell. */
export type LocalUiRunner = (helperPath: string, args: readonly string[]) => Promise<string>;

const runHelper: LocalUiRunner = (helperPath, args) => new Promise((resolve, reject) => {
  execFile("/usr/bin/python3", [helperPath, ...args], {
    encoding: "utf8", timeout: HELPER_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, killSignal: "SIGKILL",
  }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

const runningState = z.object({
  running: z.literal(true), host_id: z.string().regex(/^0x[0-9a-f]+$/i), main_id: z.string().regex(/^0x[0-9a-f]+$/i),
  hidden: z.boolean(), fullscreen: z.boolean(), normal: z.boolean(),
});
const stoppedState = z.object({
  running: z.literal(false), hidden: z.literal(false), host_id: z.null(), main_id: z.null(),
});
const windowState = z.union([runningState, stoppedState]);
const dimension = z.number().int().min(1).max(MAX_SIDE);
const screenshot = z.object({
  data: z.string(), width: dimension, height: dimension,
  native_width: dimension, native_height: dimension, window: runningState,
});

function parseOutput(output: string): unknown {
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) throw new Error("Local UI helper output exceeded its bound");
  const value: unknown = JSON.parse(output);
  if (value && typeof value === "object" && "error" in value) {
    throw new Error(String((value as { error: unknown }).error).slice(0, 500));
  }
  return value;
}

function checkedScreenshot(output: string, maxWidth: number) {
  const value = screenshot.parse(parseOutput(output));
  if (value.width > maxWidth || value.width > value.native_width || value.height > value.native_height ||
      value.width * value.height > MAX_PIXELS || value.native_width * value.native_height > 4 * MAX_PIXELS) {
    throw new Error("Screenshot dimensions exceeded their bound");
  }
  const expectedWidth = Math.min(value.native_width, maxWidth);
  const expectedHeight = Math.max(1, Math.round(value.native_height * expectedWidth / value.native_width));
  if (value.width !== expectedWidth || value.height !== expectedHeight) throw new Error("Screenshot dimensions do not preserve the native window aspect ratio");
  if (value.data.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) {
    throw new Error("Screenshot has invalid or oversized base64 PNG data");
  }
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.length < 33 || bytes.length > MAX_PNG_BYTES || bytes.toString("base64") !== value.data ||
      !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.readUInt32BE(16) !== value.width || bytes.readUInt32BE(20) !== value.height) {
    throw new Error("Screenshot is not a bounded PNG with matching IHDR dimensions");
  }
  let offset = 8, imageData = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw new Error("Screenshot PNG contains a truncated chunk");
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(kind) || (kind === "IHDR" && offset !== 8) ||
        crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) {
      throw new Error("Screenshot PNG contains an invalid chunk or checksum");
    }
    imageData ||= kind === "IDAT" && length > 0;
    offset += length + 12;
    if (kind === "IEND") {
      ended = length === 0 && offset === bytes.length;
      break;
    }
  }
  if (!imageData || !ended) throw new Error("Screenshot PNG is incomplete");
  return value;
}

function failure(error: unknown, mutation = false): CallToolResult {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({
      error: message, outcome: mutation ? "unknown" : "failed", verification: "unavailable",
      ...(mutation ? { note: "Window action may have happened. Inspect status before another change. No retry was attempted." } : {}),
    }) }],
  };
}

/** Portable default: no local tools. Only the operator-configured absolute helper is executable. */
export function registerLocalUiTools(server: McpServer, ctx: ToolContext, helperPath?: string, runner: LocalUiRunner = runHelper): void {
  if (!helperPath) return;
  if (!isAbsolute(helperPath)) throw new Error("GMA3_LOCAL_UI_HELPER must be an absolute path");

  server.registerTool("gma3_screenshot", {
    title: "Observe the grandMA3 window",
    description: "Capture only the validated local grandMA3 main window as a PNG, including while minimized. Does not capture the desktop, change focus, show the window, or write a screenshot file. Hidden windows may expose the compositor's last rendered frame; combine with console state inspection. Optional local Linux/Wine capability.",
    inputSchema: { max_width: z.number().int().min(256).max(3072).default(1536).describe("Maximum PNG width in pixels; preserves aspect ratio and never enlarges") },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ max_width }): Promise<CallToolResult> => {
    try {
      const captureStartedAt = new Date().toISOString();
      const value = checkedScreenshot(await runner(helperPath, ["screenshot", "--max-width", String(max_width)]), max_width);
      const provenance = { captureStartedAt, captureCompletedAt: new Date().toISOString(), pngSha256: createHash("sha256").update(Buffer.from(value.data, "base64")).digest("hex"), renderFreshness: "unverified",
        windowIdentity: { host: value.window.host_id, main: value.window.main_id },
        note: value.window.hidden ? "A hidden/minimized window can expose its last rendered frame. Capture time is not a render timestamp." : "The window was observed visible; no native rendered-frame counter or causal pixel witness was available." };
      const { data, ...metadata } = value;
      return { content: [
        { type: "image", mimeType: "image/png", data },
        { type: "text", text: JSON.stringify({ ...metadata, provenance, source: "validated grandMA3 main window", note: "Pixels are an observation, not confirmation of console commands." }) },
      ] };
    } catch (error) { return failure(error); }
  });

  server.registerTool("gma3_window", {
    title: "Read, hide or show the grandMA3 window",
    description: "Read local grandMA3 window state or minimize/restore the existing validated Wine desktop. Keeps the same app session running; never launches a second app or operates on another window. Changes share this server's mutation lock and are never retried. A show request may change focus. Optional local Linux/Wine capability.",
    inputSchema: { action: z.enum(["status", "hide", "show", "toggle"]).default("status") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ action }): Promise<CallToolResult> => {
    const request = async (): Promise<CallToolResult> => {
      try {
        const window = windowState.parse(parseOutput(await runner(helperPath, ["window", action])));
        if (action !== "status" && (!window.running ||
            (action === "hide" && !window.hidden) ||
            (action === "show" && (window.hidden || !window.normal || !window.fullscreen)) ||
            (action === "toggle" && !window.hidden && (!window.normal || !window.fullscreen)))) {
          throw new Error("Window helper did not confirm the requested state");
        }
        return { content: [{ type: "text", text: JSON.stringify({ action, window, outcome: "succeeded", verification: "matched" }) }] };
      } catch (error) { return failure(error, action !== "status"); }
    };
    return action === "status" ? request() : ctx.mutations.run(request);
  });
}
