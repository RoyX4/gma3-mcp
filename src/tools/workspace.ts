/** Cameras live in the user profile; Layout objects live in the current data pool. No programmer changes. */
import { z } from "zod";
import { operation, json, type RegisterTools, type ToolContext } from "./context.js";
import { readObjects, type ObjectSummary } from "./common.js";
import { objectName } from "../validate.js";
import {
  asRead,
  buildResult,
  commandStep,
  compareFields,
  notRequested,
  requestStep,
  stepFromError,
  unavailable,
  validationFailure,
  valuesEqual,
  type OperationResult,
  type StepResult,
  type Verification,
} from "../results.js";
const SLOT = z.number().int().min(1).max(99999);
const coordinate = z.number().int().min(-32768).max(32767);
const dimension = z.number().int().min(1).max(32767);
const LOCKS = ["LOCK", "SYSTEMLOCKED", "STRUCTURELOCKED"];
const CAMERA_FIELDS = [...LOCKS, "NAME", "POSX", "POSY", "POSZ", "PAN", "TILT", "ROLL", "FOV"];
const ELEMENT_FIELDS = ["OBJECT", "POSX", "POSY", "WIDTH", "HEIGHT", "CUSTOMTEXTTEXT", ...LOCKS];
const REF = /^(?:Fixture [1-9]\d*(?:\.[1-9]\d*)*|(?:Group|Sequence|Macro|View) [1-9]\d*|Preset [1-9]\d*\.[1-9]\d*)$/;
const CAVEAT =
  "Mutations are serialized only within this server process; another operator or client can still change the show. Nothing is retried or automatically undone.";
async function inspect(
  ctx: ToolContext,
  steps: StepResult[],
  name: string,
  ref: string,
  fields: string[],
): Promise<ObjectSummary | null> {
  try {
    const r = await readObjects(ctx.bridge, ref, fields, 1, { asText: false });
    const row = r?.items?.[0];
    steps.push(asRead({ name, status: "succeeded", op: "objects", detail: { ref, object: row ?? null } }));
    return row && !row.invalid ? row : null;
  } catch (error) {
    steps.push(asRead(stepFromError(name, error, { op: "objects" })));
    return null;
  }
}
const failed = (steps: StepResult[]) => steps.some((s) => s.status !== "succeeded");
function lockProblem(object: ObjectSummary): string | null {
  for (const property of LOCKS) {
    if (!Object.hasOwn(object.fields ?? {}, property))
      return `${property} could not be read; the object's unlocked state is unknown`;
    if (![false, 0, "", "No", "no", "false", "False", "0"].includes(object.fields![property] as never))
      return `${property} is set; locked objects are not edited`;
  }
  return null;
}
function refuse(
  operation: string,
  target: Record<string, unknown>,
  steps: StepResult[],
  message: string,
): OperationResult {
  return buildResult({
    operation,
    target,
    steps: [...steps, asRead({ name: "preflight", status: "failed", error: message })],
    verification: unavailable("refused before the next mutation"),
    warnings: [CAVEAT],
  });
}
async function setField(
  ctx: ToolContext,
  ref: string,
  property: string,
  value: unknown,
  name: string,
): Promise<StepResult> {
  return requestStep(
    ctx.bridge,
    name,
    "set",
    { ref, property, value },
    (reply) => {
      const r = reply as {
        readOk?: boolean;
        value?: unknown;
      } | null;
      if (r?.readOk === false || r?.value === undefined)
        return {
          name,
          status: "unknown",
          op: "set",
          error: `${property} was sent but its immediate read-back is unavailable`,
          detail: reply,
        };
      return { name, status: "succeeded", op: "set", detail: { ref, property, value: r.value } };
    },
    ctx.requestTimeoutMs,
  );
}
async function setAll(
  ctx: ToolContext,
  steps: StepResult[],
  ref: string,
  values: Record<string, unknown>,
): Promise<boolean> {
  for (const [property, value] of Object.entries(values)) {
    const step = await setField(ctx, ref, property, value, `${ref}.${property}`);
    steps.push(step);
    if (step.status !== "succeeded") return false;
  }
  return true;
}
interface CameraArgs {
  camera: number;
  mode?: "create" | "update";
  name?: string;
  position: {
    x: number;
    y: number;
    z: number;
  };
  pan: number;
  tilt: number;
  roll?: number;
  fov: number;
  dry_run?: boolean;
}
async function configureCamera(ctx: ToolContext, args: CameraArgs): Promise<OperationResult> {
  const operation = "configure_camera",
    ref = `Camera ${args.camera}`,
    target = { camera: args.camera, scope: "current user profile" };
  let name: string | undefined;
  try {
    name = objectName("name", args.name, { optional: true });
  } catch (error) {
    return validationFailure(operation, target, [(error as Error).message]);
  }
  const expected: Record<string, unknown> = {
    POSX: args.position.x,
    POSY: args.position.y,
    POSZ: args.position.z,
    PAN: args.pan,
    TILT: args.tilt,
    ROLL: args.roll ?? 0,
    FOV: args.fov,
    ...(name ? { NAME: name } : {}),
  };
  return ctx.mutations.run(async () => {
    const steps: StepResult[] = [],
      before = await inspect(ctx, steps, "inspect_camera", ref, CAMERA_FIELDS);
    if (failed(steps)) return refuse(operation, target, steps, "Camera state could not be read");
    const create = (args.mode ?? "create") === "create";
    if (create && before)
      return refuse(operation, target, steps, `${ref} already exists; use mode update for an existing unlocked camera`);
    if (!create && (!before || before.class !== "Camera"))
      return refuse(operation, target, steps, `${ref} does not exist as a Camera`);
    if (before) {
      const why = lockProblem(before);
      if (why) return refuse(operation, target, steps, why);
    }
    if (args.dry_run !== false)
      return buildResult({
        operation,
        target,
        steps,
        verification: notRequested(),
        extra: { preview: true, scope: target.scope, expected, previous: before?.fields ?? null },
        warnings: [CAVEAT],
      });
    if (create) {
      steps.push(
        await commandStep(
          ctx.bridge,
          "store_camera",
          `Store ${ref}${name ? ` "${name}"` : ""} /NoConfirmation`,
          ctx.requestTimeoutMs,
        ),
      );
      if (failed(steps))
        return buildResult({
          operation,
          target,
          steps,
          verification: unavailable("camera creation was not confirmed"),
          warnings: [CAVEAT],
        });
      const stored = await inspect(ctx, steps, "check_created_camera", ref, CAMERA_FIELDS);
      if (failed(steps) || stored?.class !== "Camera")
        return refuse(operation, target, steps, "Camera creation did not produce a readable Camera");
      const why = lockProblem(stored);
      if (why) return refuse(operation, target, steps, why);
    }
    const changes = Object.fromEntries(
      Object.entries(expected).filter(([property, value]) => !before || !valuesEqual(value, before.fields?.[property])),
    );
    const sent = await setAll(ctx, steps, ref, changes);
    const after = await inspect(ctx, steps, "read_back_camera", ref, CAMERA_FIELDS);
    const verification = after?.class === "Camera"
      ? compareFields("every requested camera pose field", expected, after.fields ?? {})
      : unavailable("camera pose could not be read back");
    if (verification.status === "unavailable") {
      steps.push(asRead({ name: "verify_camera_pose", status: "failed", op: "objects", error: verification.detail }));
    }
    return buildResult({
      operation,
      target,
      steps,
      verification,
      extra: {
        scope: target.scope,
        previous: before?.fields ?? null,
        resulting: after?.fields ?? null,
        allWritesConfirmed: sent,
      },
      warnings: ["Pose metadata is checked; rendering and which 3D window uses the camera are not verified.", CAVEAT],
    });
  });
}
interface LayoutItem {
  object: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  label?: string;
}
interface LayoutArgs {
  layout: number;
  name?: string;
  items: LayoutItem[];
  grid?: {
    columns?: number;
    width?: number;
    height?: number;
    gap?: number;
    origin_x?: number;
    origin_y?: number;
  };
  dry_run?: boolean;
  allow_overlap?: boolean;
}
interface Placed {
  object: string;
  expected: Record<string, unknown>;
  x: number;
  y: number;
  width: number;
  height: number;
}
function expandLayout(args: LayoutArgs): Placed[] {
  const g = args.grid ?? {},
    columns = g.columns ?? 4,
    width = g.width ?? 100,
    height = g.height ?? 40,
    gap = g.gap ?? 10,
    seen = new Set<string>();
  const placed = args.items.map((item, i) => {
    if (!REF.test(item.object)) throw new Error(`Unsupported or unsafe object reference: ${item.object}`);
    if (seen.has(item.object)) throw new Error(`Duplicate object ${item.object}; one object is allowed once per build`);
    seen.add(item.object);
    if ((item.x === undefined) !== (item.y === undefined))
      throw new Error("An explicit item position requires both x and y");
    const x = item.x ?? (g.origin_x ?? 0) + (i % columns) * (width + gap),
      y = item.y ?? (g.origin_y ?? 0) - Math.floor(i / columns) * (height + gap),
      w = item.width ?? width,
      h = item.height ?? height;
    for (const [key, value] of Object.entries({ x, y, width: w, height: h }))
      if (!Number.isInteger(value) || value < (/width|height/.test(key) ? 1 : -32768) || value > 32767)
        throw new Error(`${item.object} ${key} exceeds the Layout Int16 coordinate/dimension range`);
    const label = item.label === undefined ? undefined : objectName("label", item.label);
    return {
      object: item.object,
      x,
      y,
      width: w,
      height: h,
      expected: { POSX: x, POSY: y, WIDTH: w, HEIGHT: h, ...(label ? { CUSTOMTEXTTEXT: label } : {}) },
    };
  });
  if (!args.allow_overlap)
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i],
          b = placed[j];
        if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height)
          throw new Error(`${a.object} and ${b.object} overlap; change positions or explicitly allow_overlap`);
      }
  return placed;
}
async function children(ctx: ToolContext, steps: StepResult[], ref: string): Promise<ObjectSummary[] | null> {
  try {
    const r = (await ctx.bridge.request(
      "children",
      { ref, fields: ELEMENT_FIELDS, asText: false, limit: 501, offset: 0 },
      ctx.requestTimeoutMs,
    )) as {
      total?: number;
      items?: ObjectSummary[];
    };
    if (!Array.isArray(r.items) || r.total === undefined || r.total !== r.items.length || r.total > 500)
      throw new Error("Layout child coverage is incomplete");
    steps.push(
      asRead({ name: "read_layout_elements", status: "succeeded", op: "children", detail: { count: r.total } }),
    );
    return r.items;
  } catch (error) {
    steps.push(asRead(stepFromError("read_layout_elements", error, { op: "children" })));
    return null;
  }
}
function objectAddress(row: ObjectSummary): unknown {
  const handle = row.fields?.OBJECT;
  return handle && typeof handle === "object"
    ? (
        handle as {
          addr?: unknown;
        }
      ).addr
    : null;
}
async function buildLayout(ctx: ToolContext, args: LayoutArgs): Promise<OperationResult> {
  const operation = "build_layout",
    ref = `Layout ${args.layout}`,
    target = { layout: args.layout, scope: "current data pool" };
  let placed: Placed[], name: string | undefined;
  try {
    placed = expandLayout(args);
    name = objectName("name", args.name, { optional: true });
  } catch (error) {
    return validationFailure(operation, target, [(error as Error).message]);
  }
  return ctx.mutations.run(async () => {
    const steps: StepResult[] = [],
      before = await inspect(ctx, steps, "inspect_layout", ref, [...LOCKS, "NAME"]);
    if (failed(steps)) return refuse(operation, target, steps, "Layout slot could not be read");
    if (before) return refuse(operation, target, steps, `${ref} already exists; layout creation is create-only`);
    const resolved = new Map<string, ObjectSummary>();
    for (const item of placed) {
      const object = await inspect(ctx, steps, `resolve_${item.object}`, item.object, []);
      if (failed(steps) || !object?.addr)
        return refuse(operation, target, steps, `${item.object} does not resolve to a readable unique object`);
      resolved.set(item.object, object);
    }
    if (args.dry_run !== false)
      return buildResult({
        operation,
        target,
        steps,
        verification: notRequested(),
        extra: { preview: true, items: placed },
        warnings: [CAVEAT],
      });
    steps.push(
      await commandStep(
        ctx.bridge,
        "store_layout",
        `Store ${ref}${name ? ` "${name}"` : ""} /NoConfirmation`,
        ctx.requestTimeoutMs,
      ),
    );
    if (failed(steps))
      return buildResult({
        operation,
        target,
        steps,
        verification: unavailable("Layout creation was not confirmed"),
        warnings: [CAVEAT],
      });
    const stored = await inspect(ctx, steps, "check_created_layout", ref, [...LOCKS, "NAME"]);
    if (failed(steps) || stored?.class !== "Layout")
      return refuse(operation, target, steps, "Layout creation did not produce a readable Layout");
    const locked = lockProblem(stored);
    if (locked) return refuse(operation, target, steps, locked);
    const expected = new Map<string, Placed>();
    for (const item of placed) {
      const step = await commandStep(
        ctx.bridge,
        `assign_${item.object}`,
        `Assign ${item.object} At ${ref}`,
        ctx.requestTimeoutMs,
      );
      steps.push(step);
      if (step.status !== "succeeded") break;
      const rows = await children(ctx, steps, ref);
      if (!rows) break;
      const matches = rows.filter((row) => objectAddress(row) === resolved.get(item.object)!.addr);
      if (matches.length !== 1 || !matches[0].addr || rows.length !== expected.size + 1) {
        steps.push(
          asRead({
            name: "check_assignment",
            status: "failed",
            error: `${item.object} did not produce exactly one new assigned Layout element; no geometry was written`,
          }),
        );
        break;
      }
      const row = matches[0],
        elementRef = `${ref}.${row.index ?? rows.indexOf(row) + 1}`;
      // Compare the resolved element address as well; never write an assumed child index.
      const current = await inspect(ctx, steps, "resolve_element_index", elementRef, ELEMENT_FIELDS);
      if (!current || current.addr !== row.addr || objectAddress(current) !== resolved.get(item.object)!.addr) {
        steps.push(
          asRead({
            name: "check_element_identity",
            status: "failed",
            error: "Layout child index or assignment changed",
          }),
        );
        break;
      }
      const lock = lockProblem(current);
      if (lock) {
        steps.push(asRead({ name: "check_element_locks", status: "failed", error: lock }));
        break;
      }
      expected.set(row.addr!, item);
      if (!(await setAll(ctx, steps, elementRef, item.expected))) break;
    }
    const rows = await children(ctx, steps, ref);
    let verification: Verification = unavailable("Layout elements could not be read back");
    if (rows) {
      const problems: string[] = [];
      if (expected.size !== placed.length || rows.length !== placed.length)
        problems.push(
          `expected ${placed.length} complete elements; ${expected.size} were prepared and ${rows.length} exist`,
        );
      for (const [addr, item] of expected) {
        const row = rows.find((r) => r.addr === addr);
        if (!row || objectAddress(row) !== resolved.get(item.object)!.addr) {
          problems.push(`${item.object}: assignment identity changed`);
          continue;
        }
        const compared = compareFields(item.object, item.expected, row.fields ?? {});
        if (compared.status !== "matched") problems.push(compared.detail ?? `${item.object}: geometry mismatch`);
      }
      const label = await inspect(ctx, steps, "read_layout_name", ref, ["NAME"]);
      if (name && label?.fields?.NAME !== name) problems.push("Layout name does not match");
      verification = {
        status: problems.length ? "mismatched" : "matched",
        checked: "all Layout object identities, requested geometry and labels",
        ...(problems.length ? { detail: problems.join("; ") } : {}),
      };
    }
    return buildResult({
      operation,
      target,
      steps,
      verification,
      extra: { items: placed, resulting: rows, scope: target.scope },
      warnings: [
        "Creates a real 2D Layout pool object. It does not open a Layout window or verify its visual rendering. Fixture selection, programmer and playback are untouched.",
        CAVEAT,
      ],
    });
  });
}
export const registerWorkspaceTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_cameras",
    {
      title: "Read camera poses",
      description:
        "READ-ONLY: camera poses in the current user profile, in metres and degrees. Does not select a camera or inspect 3D rendering.",
      inputSchema: {
        camera: SLOT.optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async (args) => {
      try {
        return json(
          await ctx.bridge.request(
            "objects",
            {
              ref: args.camera ? `Camera ${args.camera}` : "Camera Thru",
              fields: CAMERA_FIELDS,
              asText: false,
              offset: args.offset ?? 0,
              limit: args.limit ?? 100,
            },
            ctx.requestTimeoutMs,
          ),
        );
      } catch (error) {
        return { content: [{ type: "text", text: (error as Error).message }], isError: true };
      }
    },
  );
  server.registerTool(
    "gma3_configure_camera",
    {
      title: "Create or update a camera pose",
      description:
        "Dry-run by default. Create a new Camera or explicitly update an existing unlocked Camera in the CURRENT USER PROFILE. Positions in metres, angles/FOV in degrees; compares every requested final pose field. No camera selection, programmer, playback or window changes. No overwrite in create mode; no automatic retry. Rendering is not verified. Serializes only this server's mutations.",
      inputSchema: {
        camera: SLOT,
        mode: z.enum(["create", "update"]).optional(),
        name: z.string().optional(),
        position: z.object({
          x: z.number().min(-100000).max(100000),
          y: z.number().min(-100000).max(100000),
          z: z.number().min(-100000).max(100000),
        }),
        pan: z.number().min(-3600).max(3600),
        tilt: z.number().min(-180).max(180),
        roll: z.number().min(-3600).max(3600).optional(),
        fov: z.number().min(1).max(179),
        dry_run: z.boolean().optional(),
      },
    },
    (args) => operation(() => configureCamera(ctx, args)),
  );
  server.registerTool(
    "gma3_build_layout",
    {
      title: "Build a new 2D operator Layout",
      description:
        "Dry-run by default. Creates an unoccupied Layout pool slot with explicit Fixture/Group/Sequence/Macro/View/Preset objects, grid or explicit Int16 coordinates, sizes and optional labels. Prechecks every reference and overlap, then verifies assigned object identity and all requested geometry. Create-only, stops on failure/uncertainty; never retries or deletes. Does not select fixtures, clear the programmer, play anything or open a window. Serializes only this server's mutations; requires no arbitrary Lua.",
      inputSchema: {
        layout: SLOT,
        name: z.string().optional(),
        items: z
          .array(
            z.object({
              object: z.string(),
              x: coordinate.optional(),
              y: coordinate.optional(),
              width: dimension.optional(),
              height: dimension.optional(),
              label: z.string().optional(),
            }),
          )
          .min(1)
          .max(200),
        grid: z
          .object({
            columns: z.number().int().min(1).max(200).optional(),
            width: dimension.optional(),
            height: dimension.optional(),
            gap: z.number().int().min(0).max(32767).optional(),
            origin_x: coordinate.optional(),
            origin_y: coordinate.optional(),
          })
          .optional(),
        allow_overlap: z.boolean().optional(),
        dry_run: z.boolean().optional(),
      },
    },
    (args) => operation(() => buildLayout(ctx, args)),
  );
};
