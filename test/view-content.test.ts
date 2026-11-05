import { test } from "node:test";
import assert from "node:assert/strict";
import { registerViewTools } from "../src/tools/views.ts";
import { compareViewContent, registerViewContentTools } from "../src/tools/view-content.ts";
import { startHarness } from "./helpers/tool-harness.ts";

const content = (selected = "Yes", screen = 1) => ({ complete: true as const, metadata: { screenContentMask: 1 }, contentJson: JSON.stringify([{ screen, configuration: { class: "ViewWidget", properties: [{ name: "DISPLAY", value: screen }], children: [{ class: "FixtureSheetSettings", properties: [{ name: "SELECTEDONLY", value: selected }] }] } }]) });
test("view comparison detects nested saved setting drift and remaps a single screen", () => {
  assert.equal(compareViewContent(content(), content("No")).status, "mismatched");
  assert.equal(compareViewContent(content(), content("Yes", 2), 2).status, "matched");
});
test("View recall verifies actual nested configuration, not accepted dispatch", async () => {
  const h = await startHarness(registerViewTools);
  h.fake.on("objects", () => ({ total: 1, items: [{ class: "View", addr: "view-1", fields: { Name: "Lab", ScreenContentMask: 1, Lock: "" } }] }));
  h.fake.on("view.content", args => args.ref ? content() : content("No"));
  h.fake.on("cmd", () => ({ feedback: "OK" }));
  try {
    const result = await h.callJson("gma3_recall_view", { view: 1, screen: 1 });
    assert.equal(result.isError, true);
    assert.equal(result.result.verification.status, "mismatched");
    assert.equal(h.fake.commands.length, 1);
  } finally { await h.close(); }
});
test("View store refuses incomplete native content before creating a slot", async () => {
  const h = await startHarness(registerViewTools);
  h.fake.on("objects", () => ({ total: 0, items: [] }));
  h.fake.on("view.content", () => ({ complete: false }));
  try {
    const result = await h.callJson("gma3_store_view", { view: 1, screens: [1] });
    assert.equal(result.isError, true);
    assert.equal(h.fake.commands.length, 0);
  } finally { await h.close(); }
});


test("View recall compares settings while excluding MA-generated GridLine caches", () => {
  const make = (name: string, size: unknown) => ({ complete: true as const, contentJson: JSON.stringify([{ screen: 1, configuration: { class: "ViewWidget", properties: [], children: [{ class: "GridLine", name, properties: [{ name: "NAME", value: name }, { name: "SIZE", value: size }, { name: "VISIBLE", value: size === "" ? "" : true }] }] } }]) });
  assert.equal(compareViewContent(make("GridLine 1", ""), make("GridLine 2", 140)).status, "matched");
});

const typed = (reverse=false, large="9007199254740992") => ({complete:true as const,kind:"live_screens",contentJson:'[{"screen":1,"configuration":{"class":"ViewWidget","properties":[{"name":"OPAQUE","value":{"entries":'+JSON.stringify((reverse?[{keyType:"string",key:"z",value:1},{keyType:"string",key:"a",value:2}]:[{keyType:"string",key:"a",value:2},{keyType:"string",key:"z",value:1}]))+'}},{"name":"UNKNOWN_INT64","value":'+large+'}],"children":[]}}]'});
test("view comparison distinguishes adjacent integers beyond Number precision",()=>{
 assert.equal(compareViewContent(typed(),typed(false,"9007199254740993")).status,"mismatched");
});
test("view comparison canonicalizes only native typed-map ordering and preserves exact int64 values",()=>{
 assert.equal(compareViewContent(typed(),typed(true)).status,"matched");
 assert.equal(compareViewContent(typed(),typed(false,"9007199254740993")).status,"mismatched");
 const a=typed(),b=typed();a.contentJson=a.contentJson.replace('"children":[]','"unknown":{"entries":[1,2]},"children":[]');b.contentJson=b.contentJson.replace('"children":[]','"unknown":{"entries":[2,1]},"children":[]');
 assert.equal(compareViewContent(a,b).status,"mismatched");
});
test("public view fingerprints are typed-order stable and lossless across int64 changes",async()=>{
 const h=await startHarness(registerViewContentTools);let value=typed();h.fake.on("view.content",()=>value);
 try{
  const first=await h.callJson("gma3_view_contents",{screens:[1],detail:true});
  assert.match(first.text,/9007199254740992/);
  value=typed(true);const reordered=await h.callJson("gma3_view_contents",{screens:[1]});assert.equal(first.result.fingerprint,reordered.result.fingerprint);
  value=typed(false,"9007199254740993");const changed=await h.callJson("gma3_view_contents",{screens:[1],detail:true});assert.notEqual(first.result.fingerprint,changed.result.fingerprint);assert.match(changed.text,/9007199254740993/);
 }finally{await h.close();}
});
