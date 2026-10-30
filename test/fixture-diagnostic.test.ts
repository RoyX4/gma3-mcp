import { test } from "node:test";
import assert from "node:assert/strict";
import { diagnoseFixtureEvidence } from "../src/tools/fixture-diagnostic.ts";

test("fixture diagnostic separates closed shutter, zero grand master and missing grants", () => {
  const result = diagnoseFixtureEvidence({
    output: { channels: [{ attribute: "Shutter1", channelSet: "Closed", universe: 1, patched: true }] },
    masters: { items: [{ name: "Master", fields: { FaderEnabled: "Yes", NormedValue: "0.00" } }] },
    routing: { universes: [{ no: 1, granted: false }] },
  });
  assert.deepEqual(result.map(r => r.code).sort(), ["grand_master_zero", "shutter_closed", "universe_not_granted"]);
});
test("fixture diagnostic never converts unavailable values into zero or an absent grant", () => {
  const result = diagnoseFixtureEvidence({
    output: { channels: [{ attribute: "Dimmer", percent: null, universe: 1, patched: true }] },
    masters: { items: [{ name: "Master", fields: { FaderEnabled: "Yes", NormedValue: "" } }] },
    routing: { universes: [{ no: 1, granted: null }] },
  });
  assert.deepEqual(result, []);
});
test("fixture diagnostic distinguishes observations and possible programmer overrides", () => {
  const result = diagnoseFixtureEvidence({ output: { channels: [{ attribute: "Dimmer", percent: 0, patched: true }] }, programmer: { rows: [{ attribute: "Dimmer", value: 0 }] } });
  assert.equal(result.find(r => r.code === "dimmer_output_zero")?.certainty, "observed");
  assert.equal(result.find(r => r.code === "programmer_override")?.certainty, "possible");
});

test("diagnosis refuses consistent-context claims across programmer environments or uncertain identity", async () => {
  const { startHarness } = await import("./helpers/tool-harness.ts");
  const { registerFixtureDiagnosticTools } = await import("../src/tools/fixture-diagnostic.ts");
  const h = await startHarness(registerFixtureDiagnosticTools);
  try {
    let reads=0;
    h.fake.on("fast.context",()=>({contextKey:"same",environment:++reads%2?"Normal":"Preview",identityUncertain:[]}));
    const changed=await h.callJson("gma3_diagnose_fixture",{fixture:"1"});
    assert.equal(changed.result.coverage.contextMatched,false);
    h.fake.on("fast.context",()=>({contextKey:"same",environment:"Normal",identityUncertain:["showfile"]}));
    assert.equal((await h.callJson("gma3_diagnose_fixture",{fixture:"1"})).result.coverage.contextMatched,false);
  } finally { await h.close(); }
});
