/**
 * Bounded fixture selections.
 *
 * grandMA3 rejected a 9,273-character `Fixture a + b + …` selection (530 fixtures, Night Shift console, 2026-10) and
 * accepted a 5,663-character one. The parser's exact limit is not known, so a selection command is kept within the
 * bounds that Night Shift's authorer used natively: at most 128 entries and 4,096 characters.
 *
 * A selection inside the bounds is returned unchanged, character for character. Only a selection over them is
 * rewritten, in two exact steps:
 *   1. compact: three or more consecutive ascending fixture ids become one range (`Fixture 1 + 2 + 3` -> `Fixture 1
 *      Thru 3`). The set and the selection order are the same; sub-fixture ids (`501.1`) and other keywords are kept.
 *   2. split: when the compact form is still over the bounds, it is cut into several selections, each within them.
 *      A split selection is never sent as consecutive select commands: grandMA3 adds a second `Fixture …` to the
 *      selection only while the selected fixtures have no active values and replaces it otherwise. Callers instead
 *      run their whole per-selection work (ClearSelection, select, values, read-back) once per part.
 * A selection that uses `-` (removal) is never split, because a removal can refer to an earlier part.
 */
export const MAX_SELECTION_ENTRIES = 128;
export const MAX_SELECTION_CHARACTERS = 4096;

interface Entry {
  keyword: string;
  from: string;
  to?: string;
}

const KEYWORDS = new Map(["fixture", "group", "channel", "subfixture"].map((k) => [k, k[0].toUpperCase() + k.slice(1)]));
const ID = /^\d+(?:\.\d+)*$/;

function entryCount(selection: string): number {
  return selection.split(" ").filter((t) => t === "+" || t === "-").length + 1;
}

function withinBounds(selection: string): boolean {
  return selection.length <= MAX_SELECTION_CHARACTERS && entryCount(selection) <= MAX_SELECTION_ENTRIES;
}

/**
 * The entries of `Keyword id [Thru id] (+ [Keyword] id [Thru id])*`, each with the keyword it inherits (grandMA3
 * keeps the last keyword: in `Group 3 + 4`, 4 is a group). Null for anything else, including `-` and open ranges.
 */
function parse(selection: string): Entry[] | null {
  const tokens = selection.trim().split(/\s+/);
  const entries: Entry[] = [];
  let keyword: string | undefined;
  let i = 0;
  while (i < tokens.length) {
    if (entries.length) {
      if (tokens[i] !== "+") return null;
      i++;
    }
    const named = KEYWORDS.get(tokens[i]?.toLowerCase());
    if (named) {
      keyword = named;
      i++;
    }
    if (!keyword || !ID.test(tokens[i] ?? "")) return null;
    const entry: Entry = { keyword, from: tokens[i++] };
    if (tokens[i]?.toLowerCase() === "thru") {
      if (!ID.test(tokens[i + 1] ?? "")) return null;
      entry.to = tokens[i + 1];
      i += 2;
    }
    entries.push(entry);
  }
  return entries.length ? entries : null;
}

const plainId = (e: Entry): number | null => (e.keyword === "Fixture" && e.to === undefined && /^\d+$/.test(e.from) ? Number(e.from) : null);

/** Runs of three or more consecutive ascending plain fixture ids become one `a Thru b` entry, in place. */
function compact(entries: Entry[]): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < entries.length; ) {
    let j = i;
    const first = plainId(entries[i]);
    if (first !== null) while (j + 1 < entries.length && plainId(entries[j + 1]) === first + (j + 1 - i)) j++;
    if (j - i >= 2) out.push({ keyword: "Fixture", from: entries[i].from, to: entries[j].from });
    else for (let k = i; k <= j; k++) out.push(entries[k]);
    i = j + 1;
  }
  return out;
}

function render(entries: Entry[]): string {
  return entries
    .map((e, i) => `${i === 0 || entries[i - 1].keyword !== e.keyword ? `${e.keyword} ` : ""}${e.from}${e.to === undefined ? "" : ` Thru ${e.to}`}`)
    .join(" + ");
}

/**
 * The same selection, shorter when it is over the bounds (consecutive ids as ranges), otherwise unchanged. For a
 * caller that must send one command; the result may still be over the bounds.
 */
export function compactSelection(selection: string): string {
  if (withinBounds(selection)) return selection;
  const entries = parse(selection);
  return entries ? render(compact(entries)) : selection;
}

/**
 * The selection as one or more selections, each within the bounds. One part means it fits (unchanged when it was
 * within the bounds, compacted otherwise); several parts must each get their own ClearSelection and per-selection
 * work. An error when it is over the bounds and cannot be split exactly.
 */
export function boundSelection(selection: string): { parts: string[] } | { error: string } {
  if (withinBounds(selection)) return { parts: [selection] };
  const entries = parse(selection);
  if (!entries) {
    return {
      error: `the selection is ${selection.length} characters and ${entryCount(selection)} entries, over the ${MAX_SELECTION_CHARACTERS}-character / ${MAX_SELECTION_ENTRIES}-entry bound for one grandMA3 command, and it cannot be split exactly${/(^| )-( |$)/.test(selection) ? " because it removes fixtures with -" : ""}; list the fixtures as ids and Thru ranges joined by +, or store them as a Group and select that`,
    };
  }
  const compacted = compact(entries);
  const whole = render(compacted);
  if (withinBounds(whole)) return { parts: [whole] };
  const parts: Entry[][] = [];
  let part: Entry[] = [];
  for (const entry of compacted) {
    if (part.length && (part.length === MAX_SELECTION_ENTRIES || render([...part, entry]).length > MAX_SELECTION_CHARACTERS)) {
      parts.push(part);
      part = [];
    }
    part.push(entry);
  }
  if (part.length) parts.push(part);
  return { parts: parts.map(render) };
}
