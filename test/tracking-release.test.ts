import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyReleases } from "../src/tracking/release.ts";
import { startHarness } from "./helpers/tool-harness.ts";

test("stored releases require explicit native release markers and the requested layer's active mask", async () => {
  const h = await startHarness(() => {});
  let activeValue = 2, valueKind: string | undefined = "release", complete = true;
  h.fake.on("programmer", () => ({ coverage: { complete }, total: 1, scannedFixtures: [{ rootFid: "1", fid: "1", subfixtureIndex: 2, attributes: ["Dimmer"] }], rows: [{ subfixtureIndex: 2, attribute: "Dimmer", value: 6600, valueKind, relativeKind: "release", masks: { activeValue }, stepCount: 1 }] }));
  try {
    assert.equal((await verifyReleases(h.bridge, "Fixture 1", [{ attribute: "Dimmer", layer: "absolute" }], 400)).status, "matched");
    activeValue = 4;
    assert.equal((await verifyReleases(h.bridge, "Fixture 1", [{ attribute: "Dimmer", layer: "absolute" }], 400)).status, "mismatched");
    assert.equal((await verifyReleases(h.bridge, "Fixture 1", [{ attribute: "Dimmer", layer: "relative" }], 400)).status, "matched");
    activeValue = 2; valueKind = undefined;
    assert.equal((await verifyReleases(h.bridge, "Fixture 1", [{ attribute: "Dimmer", layer: "absolute" }], 400)).status, "unavailable");
    complete = false;
    assert.equal((await verifyReleases(h.bridge, "Fixture 1", [{ attribute: "Dimmer", layer: "relative" }], 400)).status, "unavailable");
  } finally { await h.close(); }
});
