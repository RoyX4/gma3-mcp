# selection-bounds-20261117

Release of [RoyX4/gma3-mcp#2](https://github.com/RoyX4/gma3-mcp/pull/2) on top of `merge-all-20261105`.

## What changed

The Node server keeps each fixture selection command within 4,096 characters. A look over the bound is compacted
(a repeated keyword dropped, consecutive ascending ids as `a Thru b`) and, if it still does not fit, built in parts:
each part gets its own `ClearSelection`, its share of the selection, the look's whole content and its own read-back.
`gma3_edit_cue_values` builds every part. Nothing new is refused. See `docs/tools/cuelists.md` ("Large selections").

The bridge plugin is unchanged: every file in `plugin/` is byte-identical to `merge-all-20261105`, so its native
qualification ([merge-all-2026-11-05.md](merge-all-2026-11-05.md): imported fingerprints, range edits, Block/Unblock,
Break, Tracking Distance, timed parts, pool usage, patch fingerprints) carries over unchanged.

## What was verified, and how

| Check | Result |
| --- | --- |
| `npm test` on the merged tip | 1,481 tests, 1,457 pass, 0 fail, 24 skipped (no Lua interpreter on PATH; no Lua changed) |
| CI on the PR | `test (24)` passed on both runs |
| `test/selection-batches.test.ts` | 11 tests: unchanged within the bound, compaction, splitting by characters, the exact bound, sub-fixture and unsafe ids, `-` and open ranges left whole |
| Fake console, `gma3_store_cues` | a 530-fixture, 4,245-character look is built in two parts; all 530 fixtures stored with every value, one store |
| Fake console, `gma3_edit_cue_values` | the same selection edits all 530 fixtures in both cues (red without the fix) |
| Independent review | two passes; the first found a partial edit in `gma3_edit_cue_values` (fixed), the second checked 3,000 random over-bound selections with 0 mismatches |

## Not verified natively

- The console's real selection length limit (somewhere between 5,663 accepted and 9,273 rejected characters).
- A split look on a console. The pattern (one `ClearSelection`, selection part and full look content per part) is the
  one Night Shift's authorer ran natively, but this server's version has not been run against grandMA3.
- `Fixture 1 Thru 3` selecting the same fixtures in the same order as `Fixture 1 + 2 + 3` (standard grandMA3
  behaviour, not captured here).
- `gma3_edit_cue_values` still sends its Store filter as one command; past the console's limit the Store is rejected
  and nothing is stored.
