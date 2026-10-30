import { test } from "node:test";
import assert from "node:assert/strict";
import { startHarness } from "./helpers/tool-harness.ts";
import { registerRecipeTools } from "../src/tools/recipes.ts";

test("phaser recipe steps are inspected, previewed, written once, and compared with untouched sources", async () => {
  const h = await startHarness(registerRecipeTools);
  const values: Record<string, number> = { ValueAbsolute: 100, TransX: 0 };
  let linkSteps = 1;
  const ref = "Preset 1.4.1";
  h.fake.on("children", (a) => {
    if (a.ref === "Preset 1.4") return { items: [{ index: 1, class: "PhaserRecipe", fields: { Name: "Pulse", Enabled: true } }] };
    if (a.ref === `${ref}.1`) return { items: [{ index: 1 }, { index: 2 }] };
    if (a.ref === `${ref}.1.1`) return { items: [{ index: 1, fields: { ...values, LinkSteps: linkSteps, RawValueAbs: values.ValueAbsolute } }] };
    if (a.ref === `${ref}.1.2`) return { items: [{ index: 1, fields: { ValueAbsolute: 0, RawValueAbs: 0, TransX: 0, LinkSteps: linkSteps } }] };
    throw new Error(`unexpected ref ${a.ref}`);
  });
  h.fake.on("set", (a) => { if (a.property === "LinkSteps") linkSteps = Number(a.value); else if (a.ref === `${ref}.1.1.1`) values[String(a.property)] = Number(a.value); return { value: a.value }; });
  h.fake.on("objects", (a) => ({ items: [{ fields: { LinkSteps: linkSteps, RawValueAbs: a.ref === `${ref}.1.1.1` ? values.ValueAbsolute : 0, TransX: a.ref === `${ref}.1.1.1` ? values.TransX : 0 } }] }));
  h.fake.on("cmd", (a) => { const m = String(a.command).match(/^Set (.+) Property "([^"]+)" (.+)$/)!; if (m[2] === "LinkSteps") linkSteps = Number(m[3]); else if (m[1] === `${ref}.1.1.1`) values[m[2]] = Number(m[3]); return { feedback: "OK" }; });
  try {
    const args = { target: { preset: "1.4" }, line: 1, edits: [{ step: 1, source: 1, values: { ValueAbsolute: 75, TransX: 50 } }] };
    const preview = await h.callJson("gma3_edit_recipe_steps", { ...args, preview: true });
    assert.equal(preview.isError, false, JSON.stringify(preview.result));
    assert.equal(values.ValueAbsolute, 100);
    const done = await h.callJson("gma3_edit_recipe_steps", args);
    assert.equal(done.result.verification.status, "matched", JSON.stringify(done.result));
    assert.equal(values.ValueAbsolute, 75);
    assert.equal(h.fake.requests.filter((r) => r.op === "cmd" && String(r.args.command).startsWith(`Set ${ref}.1.1.1 Property`) && !String(r.args.command).includes("LinkSteps")).length, 2);
    const repeat = await h.callJson("gma3_edit_recipe_steps", { ...args, edits: [{ step: 1, source: 1, values: { TransX: 25 } }] });
    assert.equal(repeat.result.verification.status, "matched", "an empty LinkSteps plan must still execute and verify changed source values");
    assert.equal(values.TransX, 25);
  } finally { await h.close(); }
});

test("a phaser source attribute applies across every step and conflicting per-step attributes are refused", async () => {
  const h = await startHarness(registerRecipeTools);
  let attribute: unknown = null;
  let links = 1;
  h.fake.on("children", (a) => {
    if (a.ref === "Preset 1.4") return { items: [{ index: 1, class: "PhaserRecipe", fields: { Enabled: true } }] };
    if (a.ref === "Preset 1.4.1.1") return { items: [{ index: 1 }, { index: 2 }] };
    return { items: [{ index: 1, fields: { Attributes: attribute, ValueAbsolute: 50, LinkSteps: links } }] };
  });
  h.fake.on("objects", (a) => String(a.ref).startsWith("Attribute") ? { items: [{ class: "Attribute", name: "Dimmer" }] } : { items: [{ fields: { LinkSteps: links } }] });
  h.fake.on("set", (a) => { if (a.property === "LinkSteps") links = Number(a.value); return { value: a.value }; });
  h.fake.on("cmd", (a) => { const command = String(a.command); if (command.includes("LinkSteps")) links = Number(command.split(" ").at(-1)); else attribute = { name: "Dimmer", class: "Attribute" }; return { feedback: "OK" }; });
  try {
    const r = await h.callJson("gma3_edit_recipe_steps", { target: { preset: "1.4" }, line: 1, edits: [{ step: 1, source: 1, attribute: "Dimmer" }] });
    assert.equal(r.isError, false, JSON.stringify(r.result));
    assert.equal(r.result.verification.status, "matched");
    const before = h.fake.requests.length;
    const conflict = await h.callJson("gma3_edit_recipe_steps", { target: { preset: "1.4" }, line: 1, edits: [{ step: 1, source: 1, attribute: "Dimmer" }, { step: 2, source: 1, attribute: "Pan" }] });
    assert.equal(conflict.isError, true);
    assert.match(conflict.result.validationErrors.join(), /conflicting attributes/);
    assert.equal(h.fake.requests.length, before);
  } finally { await h.close(); }
});

test("phaser presets are checked and read back by exact reference, and a hard value clears that reference", async () => {
  const h = await startHarness(registerRecipeTools);
  let preset: unknown = null, value = 100;
  h.fake.on("children", a => {
    if (a.ref === "Preset 1.4") return { items: [{ index: 1, class: "PhaserRecipe", fields: { Enabled: true } }] };
    if (a.ref === "Preset 1.4.1.1") return { items: [{ index: 1 }] };
    return { items: [{ index: 1, fields: { Preset: preset, RawValueAbs: value, ValueAbsolute: preset ? "encoded preset" : value, LinkSteps: 0 } }] };
  });
  h.fake.on("objects", a => a.ref === "Preset 1.11" ? { items: [{ class: "Preset", addr: "14.14.1.5.1.11" }] } : { items: [{ fields: { RawValueAbs: value } }] });
  h.fake.on("cmd", a => {
    if (String(a.command).startsWith("Assign Preset")) { preset = { class: "Preset", addr: "14.14.1.5.1.11", name: "On" }; value = 50; }
    else if (String(a.command).includes("ValueAbsolute")) { value = Number(String(a.command).split(" ").at(-1)); preset = null; }
    return { feedback: "OK" };
  });
  try {
    const r = await h.callJson("gma3_edit_recipe_steps", { target: { preset: "1.4" }, line: 1, edits: [{ step: 1, preset: "1.11" }] });
    assert.equal(r.isError, false, JSON.stringify(r.result));
    assert.equal(r.result.after[0].fields.Preset.addr, "14.14.1.5.1.11");
    const hard = await h.callJson("gma3_edit_recipe_steps", { target: { preset: "1.4" }, line: 1, edits: [{ step: 1, values: { ValueAbsolute: 75 } }] });
    assert.equal(hard.isError, false, JSON.stringify(hard.result));
    assert.equal(hard.result.after[0].fields.Preset, null);
    assert.equal(hard.result.after[0].fields.ValueAbsolute, 75);
  } finally { await h.close(); }
});
