import { z } from "zod";
import { basename, dirname, extname, isAbsolute } from "node:path";
import { lstat, readdir, stat } from "node:fs/promises";
import { inspectMvr, compareMvr } from "../mvr.js";
import { json, operation, type RegisterTools, type ToolContext } from "./context.js";
import {
  asRead,
  buildResult,
  commandStep,
  notRequested,
  stepFromError,
  unavailable,
  validationFailure,
  type OperationResult,
  type StepResult,
} from "../results.js";
const page = {
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
};
const importBoundary =
  "This is a read-only revision plan. grandMA3 MVR import uses Partial Show Read (PSR); review UUID/FID/type/address changes there and verify the resulting patch. No import or deletion is performed by these tools.";
const limitations = [
  "Focused MVR inventory, not full schema or GLB/GDTF validation",
  "No console patch comparison or visual/photometric verification",
  "Transforms are millimetres in MVR coordinates; this does not establish fixture Pan/Tilt calibration",
];
const fail = (error: unknown) => ({
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
  isError: true,
});
interface ExportArgs {
  file: string;
  dry_run?: boolean;
  exclusive?: boolean;
  mapped_to_drive1_mvr?: boolean;
  timeout_ms?: number;
}
export async function exportMvr(ctx: ToolContext, args: ExportArgs): Promise<OperationResult> {
  const op = "export_mvr",
    target = { file: args.file, drive: 1, scope: "entire patch" };
  const filename = basename(args.file),
    name = filename.slice(0, -4);
  if (!isAbsolute(args.file) || extname(args.file) !== ".mvr" || !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,95}$/.test(name))
    return validationFailure(op, target, [
      "file must be an absolute .mvr path with a simple ASCII filename (letters, numbers, spaces, underscores and hyphens)",
    ]);
  if (args.dry_run === false && (args.exclusive !== true || args.mapped_to_drive1_mvr !== true))
    return validationFailure(op, target, [
      "Applying requires exclusive:true and mapped_to_drive1_mvr:true: the local directory must be the same folder the selected console uses for Drive 1 MVR exports",
    ]);
  return ctx.mutations.run(async () => {
    const steps: StepResult[] = [];
    try {
      const directory = dirname(args.file);
      if (!(await stat(directory)).isDirectory()) throw new Error("Output parent must be an existing directory");
      if ((await readdir(directory)).some((n) => n.toLowerCase() === filename.toLowerCase()))
        throw new Error("Output already exists (case-insensitive check); overwrite is not offered");
      steps.push(asRead({ name: "check_output_absent", status: "succeeded", detail: { directory, filename } }));
      const state = (await ctx.bridge.request("patch.state", {}, ctx.requestTimeoutMs)) as {
        atRoot?: boolean;
        copyOpen?: boolean;
        modal?: unknown;
      };
      if (state.atRoot !== true || state.copyOpen !== false || state.modal !== false)
        throw new Error("Export requires a closed patch copy, Root command destination, and no modal dialog");
      steps.push(asRead({ name: "check_patch_state", status: "succeeded", op: "patch.state", detail: state }));
    } catch (error) {
      steps.push(asRead(stepFromError("preflight", error)));
      return buildResult({ operation: op, target, steps, verification: unavailable("export refused before dispatch") });
    }
    const command = `Export Stage /File "${name}" If Drive 1 /MVR`;
    if (args.dry_run !== false)
      return buildResult({
        operation: op,
        target,
        steps,
        verification: notRequested(),
        extra: {
          preview: true,
          command,
          requiresMapping: "file's parent directory must map to this console's Drive 1 MVR folder",
        },
      });
    // Recheck local absence at the last point before dispatch; no /Overwrite or automatic dialog answer.
    if ((await readdir(dirname(args.file))).some((n) => n.toLowerCase() === filename.toLowerCase()))
      return validationFailure(op, target, ["Output appeared during preflight; nothing was sent"]);
    const sent = await commandStep(ctx.bridge, "export", command, ctx.requestTimeoutMs);
    steps.push(sent);
    if (sent.status === "failed")
      return buildResult({
        operation: op,
        target,
        steps,
        verification: unavailable("the console rejected export"),
        extra: { file: null },
      });
    const deadline = Date.now() + (args.timeout_ms ?? 10000);
    let previous = "",
      observed: Awaited<ReturnType<typeof inspectMvr>> | null = null,
      lastError = "";
    while (Date.now() < deadline) {
      try {
        const info = await lstat(args.file);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Output is not a regular MVR file");
        const signature = `${info.size}/${info.mtimeMs}`;
        if (info.size > 0 && signature === previous) {
          observed = await inspectMvr(args.file);
          break;
        }
        previous = signature;
      } catch (error) {
        const err = error as Error & {
          code?: string;
        };
        if (err.code !== "ENOENT") lastError = err.message;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const verification = observed
      ? {
          status: "matched" as const,
          checked: "previously absent output appeared, stabilized, and parsed as an MVR archive",
          actual: { bytes: observed.archive.bytes, sha256: observed.archive.sha256, objects: observed.objects.length },
        }
      : unavailable(lastError || "No complete new MVR file was observed in the explicitly mapped local path");
    steps.push(
      asRead({
        name: "observe_output",
        status: observed ? "succeeded" : "failed",
        ...(observed ? { detail: verification.actual } : { error: verification.detail }),
      }),
    );
    return buildResult({
      operation: op,
      target,
      steps,
      verification,
      extra: {
        file: observed
          ? {
              archive: observed.archive,
              version: observed.version,
              objectCount: observed.objects.length,
              fixtureIdConflicts: observed.fixtureIdConflicts,
            }
          : null,
      },
      warnings: [
        "Filename mapping is supplied by the caller; no Wine or remote filesystem path is guessed.",
        "No saved-show operation, programmer change, import, overwrite, or dialog confirmation is performed.",
        "An unknown dispatch remains unknown even when a new file is observed. Never replay it automatically.",
      ],
    });
  });
}
export const registerMvrTools: RegisterTools = (server, ctx) => {
  server.registerTool(
    "gma3_inspect_mvr",
    {
      title: "Inspect a local MVR archive",
      description:
        "READ-ONLY, local file: inventory a bounded .mvr ZIP without extracting it or contacting the console. Returns scene UUIDs, FIDs, GDTF modes, DMX addresses, local/inherited transforms in millimetres, asset hashes and duplicate FIDs. Python 3 stdlib required (GMA3_MVR_PYTHON overrides executable). Does not import, program, select fixtures or change the show. Paged objects; assets summarized.",
      inputSchema: { file: z.string(), ...page },
    },
    async (args) => {
      try {
        const inventory = await inspectMvr(args.file),
          offset = args.offset ?? 0,
          limit = args.limit ?? 100;
        const { objects, assets, ...metadata } = inventory;
        return json({
          ...metadata,
          objects: objects.slice(offset, offset + limit),
          total: objects.length,
          offset,
          count: objects.slice(offset, offset + limit).length,
          incomplete: offset + limit < objects.length,
          assetCount: assets.length,
          consoleChanged: false,
          importBoundary,
          limitations,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
  server.registerTool(
    "gma3_compare_mvr",
    {
      title: "Compare MVR revisions by UUID",
      description:
        "READ-ONLY, local files: compare two bounded MVR archives using persistent UUIDs. Lists additions/removals, renamed/retyped/readdressed/moved objects, parent transforms, changed embedded assets and FID conflicts. Never matches by name or renumbers fixtures. A PSR import review plan only; no console import or delete. Python 3 required. Paged change records, complete counts.",
      inputSchema: { before: z.string(), after: z.string(), ...page },
    },
    async (args) => {
      try {
        // Sequential inspections keep the bounded decompression memory footprint predictable.
        const before = await inspectMvr(args.before),
          after = await inspectMvr(args.after),
          diff = compareMvr(before, after);
        const { added, removed, changed, ...rest } = diff,
          offset = args.offset ?? 0,
          limit = args.limit ?? 100;
        const changes = [
          ...added.map((object) => ({ change: "added", object })),
          ...removed.map((object) => ({ change: "removed", object })),
          ...changed.map((object) => ({ change: "changed", ...object })),
        ];
        return json({
          ...rest,
          before: before.archive,
          after: after.archive,
          summary: { added: added.length, removed: removed.length, changed: changed.length, unchanged: diff.unchanged },
          changes: changes.slice(offset, offset + limit),
          total: changes.length,
          offset,
          count: changes.slice(offset, offset + limit).length,
          incomplete: offset + limit < changes.length,
          consoleChanged: false,
          importBoundary,
          limitations,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
  server.registerTool(
    "gma3_export_mvr",
    {
      title: "Export the entire patch as a new MVR file",
      description:
        "Dry-run by default. Sends the documented Export Stage /File name If Drive 1 /MVR once. Applying requires exclusive:true and mapped_to_drive1_mvr:true plus an absolute local output file in the caller-supplied filesystem view of that console's Drive 1 MVR folder. Refuses any existing target; never overwrites, answers dialogs, retries, saves the show, selects fixtures or clears programmer values. Requires Root, closed patch and no modal. Verification matches only after an absent file appears, stabilizes and parses as a real MVR; unknown dispatch is preserved. Python 3 needed for verification. Lock orders this server only.",
      inputSchema: {
        file: z.string(),
        dry_run: z.boolean().optional(),
        exclusive: z.boolean().optional(),
        mapped_to_drive1_mvr: z.boolean().optional(),
        timeout_ms: z.number().int().min(300).max(30000).optional(),
      },
    },
    (args) => operation(() => exportMvr(ctx, args)),
  );
};
