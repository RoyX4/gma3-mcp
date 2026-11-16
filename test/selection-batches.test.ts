import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SELECTION_CHARACTERS, MAX_SELECTION_ENTRIES, boundSelection, compactSelection } from "../src/selection-batches.ts";
import { Validator, fixtureSelection } from "../src/validate.ts";
import { fixtureRange } from "../src/tools/inspection.ts";
import { validateLooks } from "../src/tools/cuelists.ts";

/** Ids of a selection as grandMA3 would read them (ranges expanded, keyword carried), in order. */
function idsOf(selection: string): string[] {
  const out: string[] = [];
  let keyword = "";
  for (const entry of selection.split(" + ")) {
    const m = entry.match(/^(?:(Fixture|Group|Channel|Subfixture) )?(\S+)(?: Thru (\S+))?$/);
    assert(m, `unexpected entry ${entry}`);
    if (m[1]) keyword = m[1];
    if (m[3] === undefined) out.push(`${keyword} ${m[2]}`);
    else for (let i = Number(m[2]); i <= Number(m[3]); i++) out.push(`${keyword} ${i}`);
  }
  return out;
}

const entries = (s: string) => s.split(" + ").length;
const within = (s: string) => s.length <= MAX_SELECTION_CHARACTERS && entries(s) <= MAX_SELECTION_ENTRIES;
/** 530 fixtures with gaps (odd ids), so no run collapses: the Night Shift look's size. */
const odd530 = Array.from({ length: 530 }, (_, i) => String(1001 + 2 * i));

test("a selection within the bounds is returned unchanged, character for character", () => {
  for (const s of ["Fixture 1", "Fixture 1 + 2 + 3 + 4", "Fixture 101 Thru 110 - 105", "Group 5 + Fixture 3", `Fixture ${odd530.slice(0, 128).join(" + ")}`]) {
    assert.deepEqual(boundSelection(s), { parts: [s] });
    assert.equal(compactSelection(s), s);
  }
});

test("530 consecutive ids over the bound become one range (same set, same order)", () => {
  const s = `Fixture ${Array.from({ length: 530 }, (_, i) => i + 1).join(" + ")}`;
  assert.equal(compactSelection(s), "Fixture 1 Thru 530");
  assert.deepEqual(boundSelection(s), { parts: ["Fixture 1 Thru 530"] });
});

test("530 ids with gaps split into parts that each fit, and together select the same fixtures in order", () => {
  const s = `Fixture ${odd530.join(" + ")}`;
  const r = boundSelection(s);
  assert("parts" in r);
  assert.equal(r.parts.length, Math.ceil(530 / MAX_SELECTION_ENTRIES));
  for (const part of r.parts) {
    assert(within(part), `${part.length} characters, ${entries(part)} entries`);
    assert.match(part, /^Fixture \d/, "every part names its keyword");
  }
  assert.deepEqual(r.parts.flatMap(idsOf), idsOf(s));
});

test("the Night Shift shape (530 entries, sub-fixture ids, over 4,096 characters) splits into parts within both bounds", () => {
  // 530 cells of compound fixtures: sub-fixture ids never collapse, so splitting is the only way to fit.
  const ids = Array.from({ length: 530 }, (_, i) => `${2001 + i}.${(i % 3) + 1}`);
  const s = `Fixture ${ids.join(" + ")}`;
  assert(s.length > 4096);
  const r = boundSelection(s);
  assert("parts" in r);
  assert(r.parts.length >= 2);
  for (const part of r.parts) assert(within(part));
  assert.deepEqual(r.parts.flatMap(idsOf), idsOf(s), "sub-fixture ids are never collapsed into ranges");
});

test("the bounds: 128 entries fit, 129 split; 4,096 characters fit, 4,097 do not", () => {
  const at = `Fixture ${odd530.slice(0, 128).join(" + ")}`;
  assert.deepEqual(boundSelection(at), { parts: [at] });
  const over = `Fixture ${odd530.slice(0, 129).join(" + ")}`;
  const r = boundSelection(over);
  assert("parts" in r);
  assert.deepEqual(r.parts.map(entries), [128, 1]);

  // Pad one entry's id with leading digits so the whole selection is exactly 4,096 characters, then one more.
  const base = `Fixture ${odd530.slice(0, 100).join(" + ")}`;
  const pad = (n: number) => `${base} + ${"9".repeat(n)}`;
  const exact = pad(MAX_SELECTION_CHARACTERS - base.length - 3);
  assert.equal(exact.length, MAX_SELECTION_CHARACTERS);
  assert.deepEqual(boundSelection(exact), { parts: [exact] });
  const plusOne = pad(MAX_SELECTION_CHARACTERS - base.length - 2);
  assert.equal(plusOne.length, MAX_SELECTION_CHARACTERS + 1);
  const split = boundSelection(plusOne);
  assert("parts" in split);
  assert.equal(split.parts.length, 2);
  for (const part of split.parts) assert(within(part));
});

test("only ascending runs of three or more plain fixture ids collapse; groups and sub-ids keep their keyword", () => {
  const filler = odd530.slice(0, 130).join(" + ");
  const s = `Fixture 5 + 6 + 9 + 8 + 7 + 20 + 21 + 22 + 23 + 501.1 + 501.2 + 501.3 + Group 1 + 2 + 3 + 4 + Fixture ${filler}`;
  const compacted = compactSelection(s);
  assert.match(compacted, /^Fixture 5 \+ 6 \+ 9 \+ 8 \+ 7 \+ 20 Thru 23 \+ 501\.1 \+ 501\.2 \+ 501\.3 \+ Group 1 \+ 2 \+ 3 \+ 4 \+ Fixture 1001 /);
  const r = boundSelection(s);
  assert("parts" in r);
  assert.deepEqual(r.parts.flatMap(idsOf), idsOf(compacted));
  assert(r.parts.slice(1).every((p) => /^(Fixture|Group) \d/.test(p)), "a part that starts mid-list repeats the keyword it inherits");
});

test("an over-bound selection that removes fixtures with - is refused, not split", () => {
  const s = `Fixture ${odd530.join(" + ")} - 1001`;
  const r = boundSelection(s);
  assert("error" in r);
  assert.match(r.error, /removes fixtures with -/);
  assert.equal(compactSelection(s), s, "one-command callers send it as given; the console decides");
});

test("fixtureSelection and fixtureRange compact an over-bound list and leave a short one as it was", () => {
  const long = Array.from({ length: 300 }, (_, i) => i + 1).join(" + ");
  assert.equal(fixtureSelection("fixtures", long), "Fixture 1 Thru 300");
  assert.equal(fixtureRange("fixtures", long), "Fixture 1 Thru 300");
  assert.equal(fixtureSelection("fixtures", "1 + 2 + 3"), "Fixture 1 + 2 + 3");
  assert.equal(fixtureRange("fixtures", "1 + 2 + 3"), "Fixture 1 + 2 + 3");
});

test("validateLooks splits an over-bound look into parts with the same content, and refuses an over-bound phaser look", () => {
  const v = new Validator();
  const looks = validateLooks(v, { fixtures: odd530.join(" + "), intensity: 70, presets: [{ pool: 4, preset: 1 }] }, "cue", undefined);
  assert.equal(v.errors.length, 0, v.errors.join("; "));
  assert.equal(looks.length, 5);
  assert.deepEqual(looks.map((l) => l.selectionPart), [1, 2, 3, 4, 5].map((index) => ({ index, of: 5 })));
  for (const l of looks) {
    assert.equal(l.intensity, 70);
    assert.deepEqual(l.presets.map((p) => p.ref), ["Preset 4.1"]);
  }
  assert.deepEqual(looks.flatMap((l) => idsOf(l.fixtures)), odd530.map((id) => `Fixture ${id}`));

  const short = validateLooks(new Validator(), { fixtures: "101 + 102", intensity: 70 }, "cue", undefined);
  assert.equal(short.length, 1);
  assert.equal(short[0].selectionPart, undefined);
  assert.equal(short[0].fixtures, "Fixture 101 + 102");

  const p = new Validator();
  const phaser = { steps: [{ values: { ColorRGB_R: 100 } }, { values: { ColorRGB_R: 0 } }], phaser: { speed_bpm: 120 } };
  assert.deepEqual(validateLooks(p, { fixtures: odd530.join(" + "), phaser }, "cue", undefined), []);
  assert.match(p.errors.join("; "), /phaser look's selection must fit one command/);
});
