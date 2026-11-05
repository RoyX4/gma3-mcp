# Named focus targets

`gma3_focus_target` turns a named stage coordinate into physical Pan/Tilt values for explicitly calibrated movers. It reads each fixture's current patch position and rotation, checks its physical Pan/Tilt ranges, chooses a legal equivalent angle branch, and can reject a static beam ray that crosses supplied wall boxes.

The target name and coordinates belong to the request. There is no global target registry that could accidentally reuse another show's stage coordinates. Keep recurring targets and fixture calibrations in the show's programming plan.

## Request

```json
{
  "target": {
    "name": "Downstage centre",
    "position": { "x": 0, "y": -3, "z": 1 }
  },
  "fixtures": [
    {
      "fid": 101,
      "calibration": {
        "convention": "beam_down_tilt_positive_y",
        "pan_zero": 0,
        "tilt_zero": 0,
        "pan_sign": 1,
        "tilt_sign": 1
      },
      "reference": { "pan": 20, "tilt": 45 }
    }
  ],
  "preview": true
}
```

The calibration values above illustrate the schema; they are not a universal calibration for a moving light.

| Field | Meaning |
| --- | --- |
| `target.name` | Nonempty label, returned with the plan |
| `target.position` | Stage metres: +X stage left, +Y upstage, +Z up |
| `fixtures` | 1–64 distinct top-level fixture IDs with explicit calibration |
| `calibration.convention` | Must be `beam_down_tilt_positive_y` for this implementation |
| `pan_zero`, `tilt_zero` | Physical console angles at the calibrated model's zero |
| `pan_sign`, `tilt_sign` | `1` or `-1`: map the model's positive rotation to the console's physical angle |
| `reference` | Optional measured physical Pan/Tilt, in degrees, from which equivalent branches are compared |
| `obstacles` | Optional list of up to 64 named axis-aligned boxes `{name,min:{x,y,z},max:{x,y,z}}`, in stage metres |
| `preview` | Defaults to `true`; reads and calculates without programming |
| `exclusive` | Must be `true` when `preview:false` |

Without `reference`, the tool reads the fixture's DMX output and requires one readable physical Pan and Tilt value. If output is unavailable, including a universe without a grant, supply measured reference angles. An unavailable output is never interpreted as zero.

## Optical convention and angle selection

At the calibrated zero angles, the beam points down the fixture's local −Z axis. Increasing the model's Tilt turns the beam toward local +Y. Increasing model Pan rotates this beam around local +Z. The physical commands are:

```text
physical_pan  = pan_zero  + pan_sign  × model_pan
physical_tilt = tilt_zero + tilt_sign × model_tilt
```

The patch applies `Rz × Ry × Rx` to local geometry, as in the existing fixture-placement tool and the qualified Night Shift compiler. The solver inverts that full rotation before calculating angles. It considers equivalent Pan turns and the alternate Pan+180/negative-Tilt solution within the actual fixture limits. It chooses the smallest Euclidean angle change from the sampled or supplied reference. When pointing straight along the rotation axis, it preserves a legal reference Pan rather than choosing an arbitrary zero.

This chooses a nearby mathematical solution. It does not establish a shortest physical travel time or verify the path followed during a fade. A moving fixture's sampled output may change after preflight.

The default optical model places both pivots and the emitter at the patch origin. Optional measured `pan_pivot`, `tilt_pivot`, and `emitter_offset` vectors model a calibrated two-axis head and optical emitter. A fixture's mesh, type name or GDTF file does not by itself establish its optical calibration. Nested fixtures and mirrored meshes are refused because this version does not compose their transform/calibration.

## Preflight and commands

Every requested fixture is checked before any programming command is sent:

1. Read `patch.state`; refuse an open or unreadable patch copy.
2. Read every requested fixture through paged `patch.list`; require a top-level fixture.
3. Read `objects` with raw `FID`, `POSX/Y/Z`, `ROTX/Y/Z`, and `MESHMIRRORX`; verify identity and complete numeric geometry.
4. Read `fixtureAttributes`; require complete metadata and exactly one Angle-valued Pan and Tilt channel with physical ranges.
5. Use the supplied reference or read complete `fixtureOutput` with matching fixture identity and readable physical angles.
6. Solve within physical limits and reject crossings of any supplied wall box.

Preview returns the plan and sends no commands. Apply performs the same preflight within the server's mutation lock, then for each fixture:

```text
ClearSelection
Fixture <fid>
Attribute "Pan" At Absolute Physical <degrees>
Attribute "Tilt" At Absolute Physical <degrees>
```

`ClearSelection` deselects fixtures but retains programmer values. No `ClearAll`, `ClearActive`, store, playback or save command is sent. The final selection is the last fixture attempted. Existing active values on other fixtures remain in the programmer, so storing a cue afterwards still requires an appropriate scope.

Both angles are read back with the shared `verifyProgrammer` reader using an explicit `Fixture <fid>` scope, rather than the current selection. The tool checks the returned fixture ID and patch subfixture index. Verification uses the existing setter's percentage-of-physical-range tolerance and reports that tolerance in the readback details. It verifies programmer angles, not beam position, DMX output, stored preset content or cue content.

Commands stop on the first failure, uncertain reply or verification mismatch. Already applied values remain; nothing is automatically undone or retried. Later fixtures are marked skipped. The lock orders this server's own mutations and cannot exclude another server or a console operator.

## Walls

A supplied box blocks a centre-ray crossing between the solved optical emitter and target. Contact only at the target is allowed, so a target on a wall surface can be focused on. Reversed bounds are invalid. The tool does not load or invent scenery geometry; supply verified stage-space boxes.

These are mathematical static ray tests. Without transition sampling they inspect only the final ray. They do not establish beam width, continuous sweep, photometry, moving scenery, native visualizer shadows or physical movement clearance.

## Verification

Run the focused automated checks:

```sh
node --import tsx --test test/focus.test.ts
```

The tests independently reconstruct world-space rays from solved angles for full XYZ rotations, check axis signs and offsets, alternate branches, wall contact, unreadable output, all-fixture preflight, explicit readback identity, ignored writes and uncertain delivery without replay.

For a future live qualification, use a disposable isolated show with a known top-level mover and empty programmer. Establish its optical calibration and numeric reference, run preview, inspect the planned angles and wall results, then explicitly apply. Compare the programmer's physical Pan/Tilt and the visible beam target from more than one camera. Repeat for a rotated mount and a target requiring the alternate angular branch. Record beam-pivot/emitter approximation separately from programmer readback. Automated checks do not establish a physical calibration.


## Calibrated pivots and emitter

The optional vectors are in metres and default to zero:

- `pan_pivot`: from the patch origin to the Pan pivot, in the fixture mount's unrotated local coordinates.
- `tilt_pivot`: from the Pan pivot to the Tilt pivot, in the coordinate frame that rotates with Pan.
- `emitter_offset`: from the Tilt pivot to the optical aperture at zero Tilt, in the head coordinate frame.

The forward model is `mount × (pan_pivot + Rpan × (tilt_pivot + Rtilt × emitter_offset))` for the emitter;
the ray direction is `mount × Rpan × Rtilt × (0,0,-1)`. The solver handles both offset constraints analytically,
checks all forward-facing legal branches and reconstructs the target ray before returning angles. The result
includes `emitterPosition`, `rayDirection` and aperture-to-target distance. This model assumes orthogonal Pan/Tilt
axes; skewed axes, optical-axis misalignment and mechanical body dimensions require further calibration models.

## Sampled transition checks

Opt in with `transition:{samples:33,ray_length:8,models:["linear_joint_angles","pan_then_tilt"]}`.
The tool checks 2–256 samples per model, including endpoints, against up to 64 supplied boxes. `ray_length` is
metres from the moving emitter, defaults to the final aperture-to-target distance and is bounded at 10,000 metres.

`linear_joint_angles` interpolates Pan and Tilt together. `pan_then_tilt` interpolates Pan first, then Tilt. The
latter follows the command order but is still a mathematical model: fixture motion may overlap, accelerate or
follow its own control behavior. The tool does not claim either model is the actual physical trajectory.

Each result reports the sample count, ray length, maximum angle step between samples, total intersections and
up to 32 hit details. A sampled hit refuses the complete programming request before the first command. A clear
sample set carries `continuousClearanceVerified:false`; a narrow obstacle can lie between samples. The solver
checks its selected nearest branch and does not search for another route around an obstacle. No native occlusion,
fixture-body clearance, beam width or physical safety guarantee is implied. Preview remains the default.

Tests independently construct emitter positions and rays for offsets, full XYZ mounting rotations and reversed
axes, then recover the original angles. A separate case has clear start/final rays with a wall hit midway through
the sampled transition; another verifies refusal before any programmer command.
