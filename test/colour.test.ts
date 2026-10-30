import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { parseColour, planColour } from "../src/colour.ts";
import { registerColourTools } from "../src/tools/colour.ts";
import { startHarness, type Harness } from "./helpers/tool-harness.ts";
import { SILENT } from "./helpers/fake-bridge.ts";

let h: Harness;
let selected: string;
let channels: Record<string, string[]>;
let values: Record<string, Record<string, number>>;
before(async () => { h = await startHarness(registerColourTools, { requestTimeoutMs: 60 }); });
after(async () => { await h.close(); });
beforeEach(() => {
  selected = "";
  channels = { "1": ["ColorRGB_R", "ColorRGB_G", "ColorRGB_B"], "2": ["Cyan", "Magenta", "Yellow"], "3": ["Color1"], "4": ["CTC"], "5": ["ColorRGB_WW", "ColorRGB_CW"] };
  values = {};
  h.fake.reset();
  h.fake.on("fixtureAttributes", (args) => {
    const id = String(args.ref).replace(/^Fixture /, "");
    if (!channels[id]) throw new Error("fixture not found");
    return { fid: id.split(".")[0], subfixtureIndex: Number(id.split(".").join("")), name: `Fixture ${id}`, total: channels[id].length, count: channels[id].length, offset: 0, subfixtureCount: 0, subfixtures: [], attributes: channels[id].map((attribute) => ({ attribute })) };
  });
  h.fake.onCommand((command) => {
    if (command === "ClearSelection") selected = "";
    else if (/^Fixture /.test(command)) selected = command.slice(8);
    else {
      const match = command.match(/^Attribute "([\w]+)" At Absolute Percent ([\d.]+)$/);
      if (!match) throw new Error(`unexpected command ${command}`);
      values[selected] = { ...values[selected], [match[1]]: Number(match[2]) };
    }
    return "OK";
  });
  h.fake.on("programmer", () => {
    const rows = Object.entries(values[selected] ?? {}).map(([attribute, value]) => ({ fixture: `Fixture ${selected}`, fid: selected, subfixtureIndex: Number(selected.split(".").join("")), attribute, value, stepCount: 1, physicalFrom: 0, physicalTo: 1, readout: "Percent" }));
    return { rows, total: rows.length, count: rows.length, offset: 0, scannedFixtures: [{ fid: selected, name: `Fixture ${selected}`, subfixtureIndex: Number(selected.split(".").join("")), attributes: channels[selected] }], coverage: { complete: true }, fixturesTruncated: false, limitations: [] };
  });
});

test("hex and bounded named colours have explicit sRGB channel values", () => {
  assert.deepEqual(parseColour("#f80"), [255, 136, 0]);
  assert.deepEqual(parseColour("AMBER"), [255, 191, 0]);
  assert.throws(() => parseColour("probably a nice blue"), /supported|colour/i);
  assert.throws(() => parseColour("#ff000080"), /supported|colour/i);
  assert.throws(() => parseColour("constructor"), /supported|colour/i);
  assert.throws(() => parseColour("__proto__"), /supported|colour/i);
});

test("CMY mapping inverts the requested RGB only through explicit subtractive calibration", () => {
  const plan = planColour("2", channels["2"], { color: "red" }, { fixture: "2", mode: "cmy", cyan: "Cyan", magenta: "Magenta", yellow: "Yellow" });
  assert.deepEqual(plan.values, [{ attribute: "Cyan", value: 0, unit: "percent" }, { attribute: "Magenta", value: 100, unit: "percent" }, { attribute: "Yellow", value: 100, unit: "percent" }]);
  assert.throws(() => planColour("2", ["ColorRGB_C", "ColorRGB_M", "ColorRGB_Y"], { color: "red" }), /no supported|mapping/i);
});

test("wheel matching uses caller-supplied slot samples and reports approximation", () => {
  const plan = planColour("3", channels["3"], { color: "orange" }, { fixture: "3", mode: "wheel", attribute: "Color1", slots: [{ name: "Red", color: "red", percent: 10 }, { name: "Blue", color: "blue", percent: 40 }] });
  assert.equal(plan.selectedSlot?.name, "Red");
  assert.equal(plan.values[0].value, 10);
  assert.match(plan.warnings.join(" "), /approx|nearest/i);
});

test("CCT and tunable white require calibrated attributes and reject out-of-range requests", () => {
  const profile = { fixture: "4", mode: "cct" as const, attribute: "CTC", kelvin_at_0: 6500, kelvin_at_100: 2700 };
  assert.equal(planColour("4", channels["4"], { kelvin: 4600 }, profile).values[0].value, 50);
  assert.throws(() => planColour("4", channels["4"], { kelvin: 8000 }, profile), /range/i);
  const white = planColour("5", channels["5"], { kelvin: 4000 }, { fixture: "5", mode: "white", warm: "ColorRGB_WW", cool: "ColorRGB_CW", warm_kelvin: 2700, cool_kelvin: 6500 });
  assert.equal(Math.round(white.values.reduce((n, x) => n + x.value, 0)), 100);
  assert.throws(() => planColour("5", channels["5"], { color: "red" }, { fixture: "5", mode: "white", warm: "ColorRGB_WW", cool: "ColorRGB_CW", warm_kelvin: 2700, cool_kelvin: 6500 }), /kelvin/i);
});

test("dry-run defaults to true and plans a heterogeneous RGB and calibrated CMY rig without any mutation", async () => {
  const { result, isError } = await h.callJson("gma3_set_fixture_color", { fixtures: [1, 2], color: "red", profiles: [{ fixture: 2, mode: "cmy", cyan: "Cyan", magenta: "Magenta", yellow: "Yellow" }] });
  assert.equal(isError, false);
  assert.equal(result.preview, true);
  assert.equal(result.plan.length, 2);
  assert.equal(result.plan[0].mode, "rgb");
  assert.equal(result.plan[1].mode, "cmy");
  assert.deepEqual(h.fake.commands, []);
});

test("all targets are preflighted and unsupported fixture prevents every write", async () => {
  const { result, isError } = await h.callJson("gma3_set_fixture_color", { fixtures: [1, 3], color: "red", preview: false });
  assert.equal(isError, true);
  assert.equal(result.outcome, "failed");
  assert.match(result.summary, /preflight|unsupported|mapping/i);
  assert.deepEqual(h.fake.commands, []);
});

test("apply uses explicit Percent commands and verifies each fixture independently", async () => {
  const { result, isError } = await h.callJson("gma3_set_fixture_color", { fixtures: [1, 2], color: "red", profiles: [{ fixture: 2, mode: "cmy", cyan: "Cyan", magenta: "Magenta", yellow: "Yellow" }], preview: false });
  assert.equal(isError, false);
  assert.equal(result.verification.status, "matched");
  assert.deepEqual(h.fake.commands, ["ClearSelection", "Fixture 1", 'Attribute "ColorRGB_R" At Absolute Percent 100', 'Attribute "ColorRGB_G" At Absolute Percent 0', 'Attribute "ColorRGB_B" At Absolute Percent 0', "ClearSelection", "Fixture 2", 'Attribute "Cyan" At Absolute Percent 0', 'Attribute "Magenta" At Absolute Percent 100', 'Attribute "Yellow" At Absolute Percent 100']);
  assert.equal(h.fake.requests.filter((r) => r.op === "programmer").length, 2);
});

test("mismatched programmer values stop the batch before selecting a later fixture", async () => {
  h.fake.on("programmer", () => ({ rows: [], total: 0, count: 0, scannedFixtures: [{ fid: "1", subfixtureIndex: 1, attributes: channels["1"] }], coverage: { complete: true } }));
  const { result, isError } = await h.callJson("gma3_set_fixture_color", { fixtures: [1, 2], color: "red", profiles: [{ fixture: 2, mode: "cmy", cyan: "Cyan", magenta: "Magenta", yellow: "Yellow" }], preview: false });
  assert.equal(isError, true);
  assert.equal(result.verification.status, "mismatched");
  assert.equal(h.fake.commands.includes("Fixture 2"), false);
});

test("read-back targets the explicit fixture instead of an operator's changed selection", async () => {
  const reader = h.fake.handlerFor("programmer")!;
  h.fake.on("programmer", (args, req) => {
    assert.equal(args.scope, "fixtures", "the current selection may have changed after dispatch");
    assert.equal(args.fixtures, "Fixture 1");
    return reader(args, req);
  });
  const { result, isError } = await h.callJson("gma3_set_fixture_color", { fixtures: [1], color: "red", preview: false });
  assert.equal(isError, false, result.summary);
  assert.equal(result.verification.status, "matched");
});

test("calibrated wheel Decimal8 read-back compares raw DMX across channel-function ranges", async () => {
  const cmd = h.fake.handlerFor("cmd")!;
  h.fake.on("cmd", (args, req) => String(args.command).includes("Decimal8") ? { feedback: "OK" } : cmd(args, req));
  h.fake.on("programmer", (args) => {
    assert.equal(args.fixtures, "Fixture 3");
    return { rows: [{ fid: "3", fixture: "Fixture 3", subfixtureIndex: 3, attribute: "Color1", value: 81.8898, valueRaw: 0x686868, stepCount: 1, channelFunction: "Color1" }], total: 1, count: 1, scannedFixtures: [{ fid: "3", subfixtureIndex: 3, attributes: ["Color1"] }], coverage: { complete: true } };
  });
  const { result, isError } = await h.callJson("gma3_set_fixture_color", { fixtures: [3], color: "red", profiles: [{ fixture: 3, mode: "wheel", attribute: "Color1", slots: [{ name: "Red", color: "red", dmx8: 104 }] }], preview: false });
  assert.equal(isError, false, result.summary);
  assert.equal(result.verification.status, "matched");
  assert.ok(h.fake.commands.includes('Attribute "Color1" At Absolute Decimal8 104'));
});

test("explicit colour-cell IDs are preflighted, selected and read back without guessing the parent", async () => {
  channels["1.2"] = channels["1"];
  const reader = h.fake.handlerFor("programmer")!;
  h.fake.on("programmer", (args, req) => {
    assert.equal(args.fixtures, "Fixture 1.2");
    return reader(args, req);
  });
  const { result, isError } = await h.callJson("gma3_set_fixture_color", { fixtures: ["1.2"], color: "blue", preview: false });
  assert.equal(isError, false, result.summary);
  assert.ok(h.fake.commands.includes("Fixture 1.2"));
});

test("extra emitter channels stay unchanged unless explicitly included as zeros", async () => {
  channels["1"].push("ColorRGB_W");
  const preview = await h.callJson("gma3_set_fixture_color", { fixtures: [1], color: "red" });
  assert.match(preview.result.warnings.join(" "), /ColorRGB_W.*unchanged|unchanged.*ColorRGB_W/);
  const { result, isError } = await h.callJson("gma3_set_fixture_color", { fixtures: [1], color: "red", profiles: [{ fixture: 1, mode: "rgb", zero_attributes: ["ColorRGB_W"] }], preview: false });
  assert.equal(isError, false, result.summary);
  assert.ok(h.fake.commands.includes('Attribute "ColorRGB_W" At Absolute Percent 0'));
});

test("a buggy bridge returning matching values for the wrong cell cannot report a match", async () => {
  const reader = h.fake.handlerFor("programmer")!;
  h.fake.on("programmer", async (args, req) => {
    const result = await reader(args, req) as { rows: Array<Record<string, unknown>>; scannedFixtures: Array<Record<string, unknown>> };
    return { ...result, rows: result.rows.map((row) => ({ ...row, fid: "1", subfixtureIndex: 99 })), scannedFixtures: result.scannedFixtures.map((row) => ({ ...row, fid: "1", subfixtureIndex: 99 })) };
  });
  const { result, isError } = await h.callJson("gma3_set_fixture_color", { fixtures: [1], color: "red", preview: false });
  assert.equal(isError, true);
  assert.notEqual(result.verification.status, "matched");
});

test("a lost reply stops subsequent channels and never retries", async () => {
  const old = h.fake.handlerFor("cmd")!;
  h.fake.on("cmd", (args, req) => String(args.command).includes("ColorRGB_R") ? SILENT : old(args, req));
  const { result, isError } = await h.callJson("gma3_set_fixture_color", { fixtures: [1], color: "red", preview: false });
  assert.equal(isError, true);
  assert.ok(["partial", "unknown"].includes(result.outcome));
  assert.equal(h.fake.commands.filter((c) => c.includes("ColorRGB_R")).length, 1);
  assert.equal(h.fake.commands.some((c) => c.includes("ColorRGB_G")), false);
});

test("duplicate targets, stray profiles and injected attributes fail before bridge use", async () => {
  for (const args of [
    { fixtures: [1, "1"], color: "red" },
    { fixtures: [1], color: "red", profiles: [{ fixture: 2, mode: "cmy", cyan: "Cyan", magenta: "Magenta", yellow: "Yellow" }] },
    { fixtures: [2], color: "red", profiles: [{ fixture: 2, mode: "cmy", cyan: 'Cyan"; ClearAll', magenta: "Magenta", yellow: "Yellow" }] },
    { fixtures: [1], color: "red", kelvin: 4000 },
  ]) {
    h.fake.requests.length = 0;
    assert.equal((await h.call("gma3_set_fixture_color", args)).isError, true);
    assert.equal(h.fake.requests.length, 0);
  }
});

test("truncated fixture metadata refuses mutation", async () => {
  h.fake.on("fixtureAttributes", () => ({ fid: "1", total: 501, count: 3, attributes: channels["1"].map((attribute) => ({ attribute })) }));
  assert.equal((await h.call("gma3_set_fixture_color", { fixtures: [1], color: "red", preview: false })).isError, true);
  assert.deepEqual(h.fake.commands, []);
});

test("compound fixtures with unaddressed colour cells are refused instead of inferring parent support", async () => {
  h.fake.on("fixtureAttributes", () => ({ fid: "1", total: 0, attributes: [], subfixtureCount: 20, subfixtures: [{ fid: "1.1" }] }));
  const { result } = await h.callJson("gma3_set_fixture_color", { fixtures: [1], color: "red", preview: false });
  assert.equal(result.outcome, "failed");
  assert.match(JSON.stringify(result), /cell|subfixture/i);
  assert.deepEqual(h.fake.commands, []);
});
