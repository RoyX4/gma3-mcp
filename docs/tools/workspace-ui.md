# Appearances and native screen arrangements

`gma3_configure_appearance` creates or edits actual Appearance pool objects and optionally assigns them to existing pool objects. `gma3_build_workspace` creates actual native screen windows in free regions of a display's grid. Both default to preview and preserve fixture selection, programmer values and playback.

## Appearance colours and assignments

```json
{
  "appearance":30,
  "name":"Ready",
  "foreground":"#FF8000",
  "background":"#10182080",
  "assign_to":["Macro 2","Group 1"]
}
```

Colours accept `#RRGGBB` or `#RRGGBBAA`; omitted alpha means 255. They are **appearance bytes**, not fixture colour values. The foreground writes `IMAGER`, `IMAGEG`, `IMAGEB`, `IMAGEALPHA`; background writes `BACKR`, `BACKG`, `BACKB`, `BACKALPHA`. This does not import or replace an image, so an existing image remains when updating its tint.

`mode` defaults to `create`, refusing every occupied slot. `mode:"update"` requires the existing Appearance to be unlocked, with all lock fields readable. A request must include a name, colour or assignment target. Appearances are in the show-wide pool, independent of data pools.

`assign_to` accepts up to 100 distinct explicit Group, Sequence, Macro, View, Camera, Layout, Page or Preset references. Every target and its current appearance identity is read before any mutation. An unreadable assignment is refused; a different existing appearance requires `replace_assignments:true`. Each target's identity, locks and existing assignment are checked again immediately before assignment. A changed target/assignment stops the workflow.

Apply with `dry_run:false`. The tool sends `Store Appearance N "Name" /NoConfirmation` only in create mode, structured `set` requests for requested colour/name changes, and `Assign Appearance N At <Object>` for assignments. It then compares **all requested final fields** and the actual assigned Appearance addresses. Successful reads with an unverifiable or mismatching final identity are explicit failed verification steps and MCP errors. Uncertain writes stop later mutations and are never replayed. Earlier completed changes remain for inspection, with no automatic rollback or deletion.

The native field names and UInt8 ranges were confirmed from the existing Rock Appearance schema. MA's shipped `system_test_appearance_set.lua` exercises the colour byte fields and `system_test_appearance_assign.lua` exercises the assignment commands. These implementation checks did not change a live Appearance.

## Preview a native screen workspace

On a display with available free space:

```json
{
  "display":2,
  "windows":[
    {"type":"Window3D","x":0,"y":0,"w":20,"h":20},
    {"type":"WindowSequenceSheet","x":20,"y":0,"w":16,"h":12},
    {"type":"WindowCommandLine","x":20,"y":12,"w":16,"h":8}
  ]
}
```

The example requires an actual grid at least 36 by 20; the tool reads the current native grid rather than assuming those dimensions. Coordinates are **grid cells**, not screenshot pixels or metres. `display` is 1–7; the display and its native UiScreen must be available. A request contains 1–12 windows. Each rectangle must fit within the observed grid and must not overlap any existing or planned window.

Supported native window types and minimum dimensions are:

| Type | Minimum width by height |
| --- | --- |
| `Window3D` | 4 by 4 |
| `WindowSequenceSheet` | 3 by 4 |
| `WindowCommandLine` | 4 by 4 |
| `WindowFixtureSheet` | 3 by 4 |
| `WindowGroupPool` | 2 by 2 |
| `WindowMacroPool` | 2 by 2 |
| `WindowLayoutView` | 4 by 4 |

The preview returns the actual grid, persistent window types/addresses/rectangles, and `expected_snapshot`. It records the station, show, current screen configuration and every existing window. Occupied space is refused. No existing window is deleted, moved or resized.

## Apply the preview

Repeat the same display/windows with `dry_run:false`, `exclusive:true` and the exact returned `expected_snapshot`. The tool requires console Lua to be enabled and the server to allow that channel. It generates a fixed schema-bound script, accepting no user-provided Lua. Text arguments use decimal byte escapes.

Before every window creation, the script reads the station/show/configuration, actual grid, all existing windows and modal state again **inside the same Lua request**. A stale snapshot, modal, changed grid, occupied rectangle or insufficient minimum size is refused before `Cmd`. The only native command is:

```text
Store ScreenContent <display> "<allowed native window type>" "X"=<x> "Y"=<y> "W"=<w> "H"=<h> /NoConfirmation
```

One window is dispatched per request. A subsequent read-only snapshot verifies that exactly one new persistent window appeared, with the intended type and grid rectangle. The final verification checks every requested new window and preservation of every original window. A failed or uncertain command stops later creation. Runtime exceptions after dispatch remain unknown; the latest observable screen state is still returned without retrying the command. Already created windows remain for inspection, with no automatic cleanup.

The command and grid properties are supported by MA's shipped `add_window.uixml` and `system_test_helping_functions_ui.lua`, and by the recorded Night Shift native workspace workflow. The new fixed read-only snapshot also ran successfully through the Rock connector: Display 1 reported a **36 by 20** grid and six persistent native windows. No new live windows were created in that check.

## Verification scope and persistence

Both tools serialize this server's mutations only; `exclusive:true` requires coordination with other operators/clients. Final readback proves the specified native object properties. It does not prove pixel rendering, subjective readability, saved-show persistence or a specific Sequence Sheet/3D camera linkage.

Use the camera tool to create a pose and the existing saved View tools to capture an accepted arrangement. `gma3_build_workspace` deliberately does not clear a display, replace a View or save the show. Reworking an occupied screen requires a separately reviewed move/resize workflow; this tool can safely append windows in free regions or populate an empty display.

Automated checks use the existing fake bridge plus an actual Lua 5.4+ interpreter for the generated guard code. They cover native grid reads, stale snapshots, overlap/minimum/bounds checks, runtime failure after a creation, unknown delivery without replay, changed appearance assignments and final identity verification. Live mutation qualification should use an unused display region or disposable screen profile, with screenshots and a separate save/reopen check when persistence is required.
