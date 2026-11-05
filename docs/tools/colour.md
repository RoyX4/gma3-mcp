# Fixture aware colour

`gma3_set_fixture_color` plans one colour request across explicitly listed fixture or cell IDs. It discovers each fixture's actual attributes before choosing its channel mapping. `preview` defaults to `true`, so a first call returns the plan without changing selection or programmer values. No arbitrary Lua is required.

```json
{"fixtures":[101,102],"color":"#ffbf00"}
```

Set `preview:false` to apply a reviewed plan. Every target is checked again during the application call; a preview is not a transaction token.

## Inputs and supported mappings

`fixtures` is a unique list of 1–64 explicit IDs, including cell IDs such as `"501.3"`. A group or the current selection is not accepted. Choose exactly one of `color` and `kelvin`.

`color` accepts `#RGB`, `#RRGGBB`, or these bounded names: black, white, red, lime, green, blue, cyan, aqua, magenta, fuchsia, yellow, orange, amber, pink, purple, violet, gold, teal, navy and lavender. CSS names use their CSS sRGB values; amber is explicitly `#ffbf00`. Black writes zero colour components, not a dimmer blackout.

Without a profile the tool uses actual `ColorRGB_R`, `ColorRGB_G` and `ColorRGB_B` channels, with each 8-bit sRGB component scaled to 0–100 percent. It does not linearize sRGB or infer a fixture's spectral response. MA's additive `ColorRGB_C/M/Y` emitter attributes are not interpreted as subtractive CMY filters. A native CMY fixture exposing virtual RGB can use the RGB route; a fixture exposing actual subtractive channels needs an explicit profile.

`profiles` gives a mapping for particular fixtures in the same request. IDs must belong to `fixtures`; duplicate profiles are refused. These modes are available:

| Mode | Profile fields | Planning rule |
| --- | --- | --- |
| `rgb` | `fixture`, `mode` | Actual `ColorRGB_R/G/B`, as above |
| `cmy` | `cyan`, `magenta`, `yellow` | Caller identifies the actual subtractive attribute names; values are `100 − RGB%` |
| `wheel` | `attribute`, `slots` | Each slot supplies `name`, a sampled `color`, and exactly one of `dmx8` or `percent`; nearest sample is selected by RGB Euclidean distance, with ties preserving supplied order |
| `cct` | `attribute`, `kelvin_at_0`, `kelvin_at_100` | Requested `kelvin` is linearly interpolated between calibrated percent endpoints; endpoints may ascend or descend |
| `white` | `warm`, `cool`, `warm_kelvin`, `cool_kelvin` | Requested `kelvin` is interpolated in reciprocal temperature between calibrated warm/cool emitters at 100 percent combined level |

Temperature input and endpoints are 1000–20000 K. Out-of-range requests and identical endpoints are refused. White profiles require `warm_kelvin < cool_kelvin`. Temperature profiles require `kelvin`; colour profiles require `color`. Temperature and white interpolation describe a control approximation, not measured emitted colour or flux.

All profile modes accept `zero_attributes`, an explicit list of discovered attributes to set to zero alongside the colour channels. Other colour channels, such as a white emitter or CTO filter, remain unchanged and are named in a warning. Their values can affect the beam; there is no implicit resetting of extra emitters or filters.

For example, a mixed RGB and explicitly mapped CMY group:

```json
{"fixtures":[101,102],"color":"amber","profiles":[{"fixture":102,"mode":"cmy","cyan":"Cyan","magenta":"Magenta","yellow":"Yellow"}],"preview":true}
```

A calibrated wheel slot uses an exact DMX byte without assuming that its channel-function range spans the whole DMX channel:

```json
{"fixtures":[103],"color":"red","profiles":[{"fixture":103,"mode":"wheel","attribute":"Color1","slots":[{"name":"Red","color":"red","dmx8":104},{"name":"Blue","color":"blue","dmx8":32}]}]}
```

## Console operations and verification

Before any mutation the tool reads `fixtureAttributes` for every target, with a 500-attribute limit. Missing or incomplete metadata, a missing mapped attribute, unsupported colour routing or an invalid calibration refuses the entire call. A compound fixture whose parent lacks colour attributes must be addressed through explicit colour-cell IDs. There is no guessed cell expansion.

On application, each fixture is handled in order:

1. Send `ClearSelection`.
2. Send `Fixture <id>`.
3. Send one `Attribute "<name>" At Absolute Percent <value>` per planned channel. A wheel slot with `dmx8` uses `At Absolute Decimal8 <value>` instead.
4. Read the programmer with the explicit fixture scope and compare every requested channel before starting the next fixture. The read-back patch index must match the preflight fixture/cell identity; matching values on a foreign cell cannot satisfy verification. Percent comparison uses the existing 0.5 percent-of-range tolerance. Decimal8 comparison uses raw DMX bits; it does not compare a wheel value against its channel-function percentage.

The call changes selection and programmer values. It never sends `ClearAll`, clears existing values, changes dimmer intensity or stores presets/cues. The last programmed fixture remains selected. Every request has a step result. A failure, uncertain dispatch, incomplete read or mismatched value stops the rest; previous changes stay in place. No command is automatically retried or sent over OSC.

Mutations are serialized with this server's existing lock across preflight, application and read-back. Another server or console operator can still change show state. A programmer match verifies requested channel values, not physical colour output, visualizer output, optical calibration, or unrelated channels the console may activate as part of an activation group.

## Validation

Run `node --import tsx --test test/colour.test.ts`. The focused suite covers mixed RGB/CMY preflight, slot approximation, calibrated temperatures, explicit cells, incomplete metadata, untouched extra emitters, programmer mismatch and uncertain delivery. The target-scope regression checks that a changed operator selection cannot replace the explicitly requested fixture read.

Live procedure, on a disposable show only: compare the preview with fixture metadata, apply to one RGB fixture, one documented CMY fixture and one calibrated colour-wheel fixture, then inspect each programmer channel independently. Repeat with an explicit cell and a calibrated white fixture. Confirm selection changes, Normal/Preview environment choice, and unrelated values before/after. Physical colour matching needs separate optical measurements. No live mutation was performed while authoring this tool.
