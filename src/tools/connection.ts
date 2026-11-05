import { z } from "zod";
import { BridgeError } from "../bridge.js";
import { json, type RegisterTools } from "./context.js";

type Identity = { show: string | null; station: string | null; bridgeVersion: string; software: unknown };
type Sample = { at: string; milliseconds: number; responsive: boolean; tcpConnected: boolean; identity?: Identity; error?: string; dispatched?: boolean };

export const registerConnectionTools: RegisterTools = (server, ctx) => {
  server.registerTool("gma3_connection_check", {
    title: "Check connection stability and instance identity",
    description: "Read-only. Samples ping over this server's persistent bridge connection and separates unreachable, unresponsive, intermittent, wrong-instance and healthy replies. Optional expected_show and expected_station compare exact identity on every sample; identity changes during observation fail. Reports latency and transport counters, never restarts the plugin, loads a show, clears the programmer, enables output or replays a mutation. Cannot determine whether the console process exists from an unavailable bridge. No Lua polling loop needed.",
    inputSchema: {
      samples: z.number().int().min(1).max(10).default(3),
      interval_ms: z.number().int().min(0).max(1000).default(100),
      timeout_ms: z.number().int().min(50).max(4000).default(1000),
      expected_show: z.string().min(1).max(128).optional(),
      expected_station: z.string().min(1).max(128).optional(),
    },
  }, async ({ samples, interval_ms, timeout_ms, expected_show, expected_station }) => {
    const observations: Sample[] = [];
    const problems: string[] = [];
    let first: Identity | undefined;
    for (let i = 0; i < samples; i++) {
      if (i) await new Promise(resolve => setTimeout(resolve, interval_ms));
      const start = performance.now();
      const base = { at: new Date().toISOString() };
      try {
        const ping = await ctx.bridge.request<Record<string, unknown>>("ping", {}, timeout_ms);
        if (!ping || typeof ping !== "object" || typeof ping.bridgeVersion !== "string") throw new Error("ping returned no recognizable grandMA3 bridge identity");
        const identity: Identity = {
          show: typeof ping.showfile === "string" ? ping.showfile : null,
          station: typeof ping.hostname === "string" ? ping.hostname : null,
          bridgeVersion: ping.bridgeVersion,
          software: ping.build ?? null,
        };
        if (expected_show !== undefined && identity.show !== expected_show) problems.push(`expected show ${JSON.stringify(expected_show)}, observed ${JSON.stringify(identity.show)}`);
        if (expected_station !== undefined && identity.station !== expected_station) problems.push(`expected station ${JSON.stringify(expected_station)}, observed ${JSON.stringify(identity.station)}`);
        if (first && (first.show !== identity.show || first.station !== identity.station)) problems.push("the show or station changed during the connection check; inspect the instance before programming");
        first ??= identity;
        observations.push({ ...base, milliseconds: Math.round((performance.now() - start) * 100) / 100, responsive: true, tcpConnected: ctx.bridge.connected, identity });
      } catch (error) {
        observations.push({ ...base, milliseconds: Math.round((performance.now() - start) * 100) / 100, responsive: false, tcpConnected: ctx.bridge.connected, error: error instanceof Error ? error.message : String(error), ...(error instanceof BridgeError ? { dispatched: error.dispatched } : {}) });
      }
    }
    const successful = observations.filter(s => s.responsive).length;
    const status = problems.length ? "wrong_instance" : successful === samples ? "healthy" : successful ? "intermittent" : ctx.bridge.connected ? "unresponsive" : "unavailable";
    const guidance = status === "healthy"
      ? ["These samples confirm replies during this observation window; they do not establish long-term stability or isolate other operators."]
      : status === "wrong_instance"
        ? ["Do not program until the endpoint, network namespace and loaded show match the intended instance. This tool does not switch them."]
        : status === "unavailable"
          ? ["Check the configured endpoint and instance namespace, then whether the imported bridge is running in that console. Unavailable TCP does not prove the app stopped.", "Start the bridge on the configured port only after identifying the intended instance. Never replay a previous mutation whose outcome was unknown."]
          : ["The console may be busy or blocked even while TCP is connected. Inspect dialogs and console state before another programming operation.", "Never replay a mutation after a timeout: it may already have executed. This check sends ping only."];
    return { ...json({ status, samples: observations, problems: [...new Set(problems)], transport: ctx.bridge.diagnostics, consoleProcessObserved: false, guidance }), isError: status !== "healthy" };
  });
  server.registerTool("gma3_reconnect", {
    title: "Reconnect and verify the configured instance",
    description: "Close an idle bridge socket, open one fresh connection and verify exact expected station/show. Refuses while a request, this connection's native asynchronous batch or its writer lease is active; shares the server mutation lock. An unreadable idle check refuses the close. Old plugins that lack these async primitives retain their existing reconnect path. Does not launch/restart the console/plugin, load a show, enable output or replay a previous command. A successful reconnect does not resolve earlier uncertain mutations; inspect native state/checkpoints first.",
    inputSchema: { expected_station: z.string().min(1).max(128), expected_show: z.string().min(1).max(128), timeout_ms: z.number().int().min(50).max(4000).default(2000) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async args => ctx.mutations.run(async () => {
    if (ctx.bridge.diagnostics.pendingRequests) return { ...json({ status: "refused", error: "A bridge request is still pending; reconnect would make its outcome uncertain. Wait for its receipt." }), isError: true };
    const before = ctx.bridge.diagnostics;
    const idleChecks: Record<string, unknown> = { unsupported: [] as string[] };
    if (ctx.bridge.connected) {
      const query = async (op: string, action: string): Promise<Record<string, unknown> | undefined> => {
        try {
          return await ctx.bridge.request<Record<string, unknown>>(op, { action }, args.timeout_ms);
        } catch (err) {
          // A positively identified old protocol cannot own an async primitive it does not implement.
          if (err instanceof BridgeError && err.message.includes(`unknown op '${op}'`)) {
            (idleChecks.unsupported as string[]).push(op);
            return undefined;
          }
          throw err;
        }
      };
      try {
        const batches = await query("fast.batch", "list");
        if (batches !== undefined) {
          if (!batches || typeof batches !== "object" || !Array.isArray(batches.batches) || batches.batches.some(b => !b || typeof b !== "object" || typeof b.id !== "string" || !["running", "succeeded", "failed", "unknown", "cancelled"].includes(b.status))) throw new Error("native batch idle evidence is malformed");
          const running = batches.batches.filter(b => b.status === "running");
          idleChecks.batches = batches.batches.map(b => ({ id: b.id, status: b.status }));
          if (running.length) return { ...json({ status: "refused", error: "This connection has a running native batch. Finish or cancel it and inspect its receipt before reconnecting.", idleChecks, before }), isError: true };
        }
        const lease = await query("fast.lease", "status");
        if (lease !== undefined) {
          if (!lease || typeof lease !== "object" || typeof lease.active !== "boolean" || typeof lease.owned !== "boolean" || (lease.owned && !lease.active)) throw new Error("native writer lease idle evidence is malformed");
          idleChecks.lease = lease;
          if (lease.active && lease.owned) return { ...json({ status: "refused", error: "This connection owns a writer lease. Release it after its work is settled before reconnecting.", idleChecks, before }), isError: true };
        }
      } catch (err) {
        return { ...json({ status: "refused", error: `Could not confirm the native connection is idle; its socket was kept open: ${err instanceof Error ? err.message : String(err)}`, idleChecks, before }), isError: true };
      }
      if (ctx.bridge.diagnostics.pendingRequests) return { ...json({ status: "refused", error: "Another request started during idle checks; the socket was kept open.", idleChecks, before }), isError: true };
    }
    ctx.bridge.close();
    try {
      const ping = await ctx.bridge.request<Record<string, unknown>>("ping", {}, args.timeout_ms);
      const matched = ping.hostname === args.expected_station && ping.showfile === args.expected_show;
      return { ...json({ status: matched ? "verified" : "wrong_instance", expected: { station: args.expected_station, show: args.expected_show }, observed: ping, before, idleChecks, after: ctx.bridge.diagnostics,
        note: "No console command was sent or replayed. Earlier uncertain mutations still require native state inspection before resuming." }), isError: !matched };
    } catch (err) { return { ...json({ status: "unavailable", error: err instanceof Error ? err.message : String(err), before, after: ctx.bridge.diagnostics, replayedMutations: 0 }), isError: true }; }
  }));

};
