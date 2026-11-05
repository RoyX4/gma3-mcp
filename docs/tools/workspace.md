# Camera poses and 2D operator layouts

These tools create real grandMA3 objects through the existing structured bridge. They do not type into a focused window or require arbitrary Lua execution. Cameras belong to the **current user profile**; Layouts belong to the **current data pool**. Neither workflow changes fixture selection, programmer values or playback.

## Read and configure cameras

`gma3_cameras` lists poses, with optional `camera`, `offset` and `limit` (default 100, maximum 500). Numeric values are raw metres/degrees rather than localized display text.

`gma3_configure_camera` previews by default:

```json
{
  "camera":30,
  "name":"Front rig",
  "position":{"x":0,"y":-12,"z":5},
  "pan":0,"tilt":15,"roll":0,"fov":45
}
```

To apply, pass `dry_run:false`. `mode` defaults to `create`, which refuses every occupied Camera slot. `mode:"update"` requires an existing Camera with all lock fields readable and cleared; system cameras are refused. Position is metres, orientation and field of view are degrees. `roll` defaults to zero, so include an intended nonzero roll explicitly when updating. FOV is bounded to 1–179 degrees.

Commands and operations are:

1. Read the target Camera and lock/pose properties.
2. In create mode only, send `Store Camera N "Name" /NoConfirmation` (name omitted when not supplied), then read the created Camera.
3. Send one structured `set` per changed pose/name field: `POSX`, `POSY`, `POSZ`, `PAN`, `TILT`, `ROLL`, `FOV`, `NAME`.
4. Read and compare **every requested final field**, including initially matching fields. The result retains the previous values.

A missing immediate write readback is uncertain and stops later writes. An uncertain write is never retried. Numeric values are checked against raw object properties. The tool does not select the Camera, attach it to a 3D window, confirm visible framing or save the show. Existing View tools handle separate saved window arrangements.

## Bind a 3D window and retain a camera witness

`gma3_bind_camera_view` connects an existing Camera to one explicitly indexed native Window3D. It uses the actual
`View3DSettings.CAMERA` writable Handle property observed on onPC 2.5.1.1, through a fixed internal Lua chunk;
console Lua must be enabled. It never infers a target from keyboard focus or a selected window.

```json
{"screen":1,"window":2,"camera":30,"view":31,"preview":true}
```

The preview reads station/show, current profile and screen configuration, exact window/settings/camera addresses,
the complete camera pose and all persisted settings on that screen. Apply requires `preview:false`,
`exclusive:true`, and the returned `expected_snapshot`. Changed identity, pose or configuration refuses the plan.
The native assignment chunk checks identity and writable property type again immediately before setting the Handle.
Afterward it compares the exact Camera reference and every persisted window setting, allowing only that CAMERA change.
An uncertain assignment is never repeated and is not followed by a View store.

Optional `view` creates a new saved View; every existing slot is refused. The saved contents and Camera reference
are compared with the bound live screen. The assignment and separate View store are not one native transaction:
another client can change settings between them, and final comparison reports observed differences. Partial work
stays for inspection. The result includes station/show/profile scope, camera pose and live/saved configuration hashes.
These are a configuration witness. They do not establish screenshot freshness, renderer output, native occlusion,
physical beam clearance or actual fixture output.

On isolated onPC 2.5.1.1, the native Camera assignment was followed by an exact Edit-role handle resolution to
Camera 9010, then an already-bound no-op and a single create-only Store of View 9011. Full saved/live settings
comparison matched; the Normal programmer was empty and the patch copy closed. The qualifier's subsequent raw save
command opened a rename dialog and received no response. That failed event was retained; recovery cancelled only
the exact owned dialog and checked the original show name, View 9011 and absence of a modal. A separate structured
`gma3_save_show` then verified the current show file and its new size/time (receipt `root-save-1793239728760.json`).
The reusable qualifier now uses that checked, queued save route. The save was verified; camera/View persistence
after another reload remains a separate check.

This qualification exposed a native Handle read distinction: some assigned settings return nil through raw access
but a real handle through the Edit role. View inspection now resolves those exact handles instead of silently
recording an empty field. Unresolvable identities are incomplete. Proven invalid native sentinel handles remain
explicit invalid states; the observed unassigned 3D RenderQuality `<Standard>` state retains its native display and
empty Edit value. Neither is represented as a guessed pool target.

## Build an operator Layout

`gma3_build_layout` creates a new actual **2D Layout pool object**, distinct from fixture selection grids or 3D patch positions:

```json
{
  "layout":30,
  "name":"Show buttons",
  "items":[{"object":"Group 1"},{"object":"Macro 2","label":"Next"}],
  "grid":{"columns":2,"width":100,"height":40,"gap":10}
}
```

Preview is the default. `dry_run:false` applies. Creation is **create-only**: an occupied Layout is refused and no content is deleted. `items` contains 1–200 explicit single-object references: Fixture IDs (including cells), Group, Sequence, Macro, View or Preset pool.number. Ranges, wildcard names and command fragments are refused. Every object is resolved before creating the Layout; duplicate objects are refused.

The grid defaults to four columns, width 100, height 40, gap 10 and origin `(0,0)`. Columns increase X; rows decrease Y. Each item can override `x`, `y`, `width`, `height` and `label`. Explicit positions require both coordinates. Coordinates and dimensions are integers within the Layout's Int16 range; size must be positive. Overlaps are refused unless `allow_overlap:true` is explicitly given.

The tool sends `Store Layout N "Name" /NoConfirmation`, then one `Assign <Object> At Layout N` per item. After each assignment it reads Layout children and verifies that exactly one new element references the intended object's **address**. It resolves and checks that element's index/address and locks before setting `POSX`, `POSY`, `WIDTH`, `HEIGHT` and optional `CUSTOMTEXTTEXT` through structured `set` requests. It never assumes that an assignment landed at the next child number.

Final readback checks all assigned object identities, geometry, custom labels and the requested Layout name. A failure or uncertain result stops subsequent mutations. Already created content stays for inspection, with no retry or automatic deletion. The tool does not execute assigned macros, select groups, open a Layout window, select the Layout or verify visible rendering.

Both workflows use one server mutation-lock span. Another console operator or server can still alter the same objects. A `matched` result covers the specified object properties, not an isolated transaction or rendering/persistence proof.

## Syntax and validation evidence

The installed 2.5 manual's `keyword_camera.html` and `keyword_layout.html` document Camera and Layout object syntax; `layout_elements_edit.html` documents element arrangement and custom text. MA's shipped camera tests use `Store Camera`, `Set ... PosX/PosY/PosZ/Pan/Tilt/FOV`; its Layout tests use `Store Layout`, `Assign <Object> At Layout`, and element `POSX/POSY/WIDTH/HEIGHT` setters.

A read-only query of the existing Rock instance confirmed Camera fields `POSX/POSY/POSZ/PAN/TILT/ROLL/FOV`, system/structure/ordinary locks, and Layout element `OBJECT`, `POSX/POSY/WIDTH/HEIGHT`, `CUSTOMTEXTTEXT` and raw handle identity availability. No camera or Layout was modified during implementation. Automated tests verify default previews, occupied/locked refusal, unknown delivery, coupled setting changes, full reference preflight, overlap/range rejection, object-identity mismatches and silently ignored geometry writes.

For a live qualification, use a disposable show/user profile and unused Camera/Layout slots; compare structured readbacks and a screenshot, save/reopen only when explicitly testing persistence, then remove only the exact test objects. No physical output or existing working show should be needed for that test.
