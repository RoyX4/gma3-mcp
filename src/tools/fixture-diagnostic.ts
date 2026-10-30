import { z } from "zod";
import { json, type RegisterTools } from "./context.js";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
export interface FixtureFinding { code: string; certainty: "observed" | "possible"; explanation: string; evidence: unknown }

/** Explain only positive evidence. Missing values remain missing, especially grants and DMX. */
export function diagnoseFixtureEvidence(evidence: Record<string, unknown>): FixtureFinding[] {
  const found: FixtureFinding[] = [];
  const add = (code: string, certainty: FixtureFinding["certainty"], explanation: string, item: unknown) => found.push({ code, certainty, explanation, evidence: item });
  const channels = rows(row(evidence.output).channels);
  for (const channel of channels) {
    if (/^dimmer$/i.test(String(channel.attribute)) && finite(channel.percent) === 0) add("dimmer_output_zero", "observed", "The readable Dimmer DMX channel is zero at this observation.", channel);
    if (/shutter/i.test(String(channel.attribute)) && /^(closed|close|shutter\s*closed|blackout)$/i.test(String(channel.channelSet).trim())) add("shutter_closed", "observed", "The fixture profile identifies the current shutter channel set as closed.", channel);
  }
  if (channels.length && channels.every(channel => channel.patched === false)) add("no_patched_output", "observed", "Every returned fixture output channel is unpatched.", channels);
  for (const master of rows(row(evidence.masters).items)) {
    const fields = row(master.fields);
    if (master.name === "Master" && /^(yes|true)$/i.test(String(fields.FaderEnabled)) && finite(fields.NormedValue) === 0) add("grand_master_zero", "observed", "The enabled Grand Master is at zero and suppresses intensity output.", master);
  }
  const universes = new Set(channels.flatMap(channel => typeof channel.universe === "number" ? [channel.universe] : []));
  for (const universe of rows(row(evidence.routing).universes)) {
    if (!universes.has(Number(universe.no))) continue;
    if (universe.granted === false) add("universe_not_granted", "observed", `Universe ${universe.no} has no output grant. Its unavailable DMX values cannot be interpreted as zero.`, universe);
    if (universe.granted === true && Array.isArray(universe.outputs) && !rows(universe.outputs).some(output => output.enabled === true && output.protocolOut === true && output.mode !== "Input")) add("no_network_protocol_output", "observed", `Universe ${universe.no} has no enabled sending Art-Net/sACN route in this observation. MA-Net/device output is a separate route.`, universe);
  }
  for (const value of rows(row(evidence.programmer).rows)) {
    if (value.attribute === "Dimmer" && finite(value.value) === 0) add("programmer_override", "possible", "A zero Dimmer value is present in the sampled programmer. Check Normal/Preview, playback priorities and programmer activation before attributing the final output to it.", value);
  }
  const playback = row(evidence.playback);
  if (playback.hasActivePlayback === false) add("sequence_inactive", "observed", "The explicitly requested sequence has no active playback; a remembered last cue does not prove it is playing.", playback);
  return found;
}

export const registerFixtureDiagnosticTools: RegisterTools = (server, ctx) => {
  server.registerTool("gma3_diagnose_fixture", {
    title: "Explain why a fixture is dark or unexpected",
    description: "READ ONLY: correlate explicit fixture/cell identity and attributes, selection, programmer, DMX output, Grand Master, protocol grants/routes and optional expected playback. Every finding carries observed evidence or is labelled possible. Missing reads never become zero or a guessed shutter state. Does not select, clear, start playback, enable output or change the show. Context is checked before/after; observations are not atomic or a physical fixture test.",
    inputSchema: { fixture: z.string().regex(/^[1-9]\d*(?:\.[1-9]\d*)*$/), sequence: z.number().int().min(1).max(99999).optional(), executor: z.number().int().min(1).max(99999).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async args => {
    const evidence: Record<string, unknown> = {}, unavailable: Record<string, string> = {};
    const read = async (name: string, op: string, payload: Row) => {
      try { evidence[name] = await ctx.bridge.request(op, payload, ctx.requestTimeoutMs); }
      catch (err) { unavailable[name] = err instanceof Error ? err.message : String(err); }
    };
    await read("before", "fast.context", {});
    const ref = `Fixture ${args.fixture}`;
    await Promise.all([
      read("identity", "objects", { ref, fields: ["FID", "Name", "FixtureType", "Patch", "Stage"], asText: false, limit: 1 }),
      read("attributes", "fixtureAttributes", { ref, limit: 2000 }),
      read("selection", "selection.grid", {}),
      read("programmer", "programmer", { scope: "fixtures", fixtures: ref, limit: 5000, maxChannels: 50000 }),
      read("output", "fixtureOutput", { ref, nonzeroOnly: false, limit: 2000 }),
      read("masters", "children", { ref: "ShowData.Masters.Grand", fields: ["Name", "FaderEnabled", "NormedValue"], limit: 30 }),
      ...(args.sequence ? [read("playback", "object", { ref: `Sequence ${args.sequence}`, properties: false })] : []),
      ...(args.executor ? [read("executor", "executor", { number: args.executor })] : []),
    ]);
    const universes = [...new Set(rows(row(evidence.output).channels).flatMap(channel => typeof channel.universe === "number" ? [channel.universe] : []))];
    if (universes.length) await read("routing", "dmx.output", { universes });
    await read("after", "fast.context", {});
    const before = row(evidence.before), after = row(evidence.after), key = before.contextKey;
    const certain = (value: Row) => Array.isArray(value.identityUncertain) && value.identityUncertain.length === 0;
    const contextMatched = typeof key === "string" && key === after.contextKey && certain(before) && certain(after)
      && ["Normal", "Preview"].includes(String(before.environment)) && before.environment === after.environment;
    const findings = diagnoseFixtureEvidence(evidence);
    const coverage = { contextMatched, missingReaders: unavailable,
      programmerComplete: row(row(evidence.programmer).coverage).complete === true,
      outputComplete: typeof row(evidence.output).total === "number" && Number(row(evidence.output).total) === rows(row(evidence.output).channels).length };
    return json({ target: args, findings, coverage, evidence, conclusion: contextMatched
      ? findings.length ? "Observed conditions and possible contributors are listed with their evidence. More than one may apply." : "No supported cause was established from the available evidence. This does not prove the fixture is healthy."
      : "Console identity could not be held stable across the observations; do not treat these as one consistent diagnosis.",
      limitations: ["No fixture power, cabling, address menu, optical calibration or physical light was observed.", "A source-to-output priority winner and every active playback/DMX merger are not inferred from a sampled programmer value."] });
  });
};
