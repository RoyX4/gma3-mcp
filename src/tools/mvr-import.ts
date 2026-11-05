import { z } from "zod";
import { inspectMvr } from "../mvr.js";
import { mvrDecisionSchema, planMvrImport, verifyMvrImport } from "../mvr-import.js";
import { readFastContext } from "../fastpath.js";
import { asRead, buildResult, stepFromError, unavailable, validationFailure, type StepResult } from "../results.js";
import { json, operation, type RegisterTools } from "./context.js";
import { exportMvr } from "./mvr.js";
import { registerMvrPositionTools } from "./mvr-positions.js";

const qualification = "Native per-UUID PSR staging/decision/conversion is still under qualification. This tool provides concrete desired decisions and verification; it does not import or commit a patch. Native post-verification may export one new MVR file when explicitly requested.";

export const registerMvrImportTools: RegisterTools = (server, ctx) => {
  registerMvrPositionTools(server,ctx);
  server.registerTool("gma3_mvr_import_plan", {
    title: "Plan UUID-specific MVR import decisions and verify their result",
    description: "Defaults to offline review. Preserve every unmentioned local fixture, omit unmentioned incoming fixtures, and explicitly select local/incoming/omit by UUID with independent DMX patch and inherited transform sources. Verify an observed MVR file, or explicitly native_export:true to create a fresh mapped Drive1 MVR and compare UUID/FID/name/GDTF/mode/DMX/world transforms under an unchanged console context. No native import, PSR selection, deletion, overwrite, or patch commit is performed.",
    inputSchema: {
      action: z.enum(["plan", "verify"]).optional(), before_file: z.string(), incoming_file: z.string(),
      decisions: z.array(mvrDecisionSchema).max(5000), observed_file: z.string().optional(),
      native_export: z.boolean().optional(), exclusive: z.boolean().optional(), mapped_to_drive1_mvr: z.boolean().optional(),
      timeout_ms: z.number().int().min(250).max(60000).optional(),
      offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional(),
    },
  }, async (args) => {
    const target = { before: args.before_file, incoming: args.incoming_file, observed: args.observed_file };
    if (args.action !== "verify" && (args.native_export || args.observed_file)) return operation(async () => validationFailure("mvr_import_plan", target, ["observed_file and native_export require action:verify"]));
    if (args.action === "verify" && !args.observed_file) return operation(async () => validationFailure("mvr_import_verify", target, ["verify requires observed_file; a native export requires a new absent path"]));
    if (args.native_export && (args.exclusive !== true || args.mapped_to_drive1_mvr !== true)) return operation(async () => validationFailure("mvr_import_verify", target, ["native_export requires exclusive:true and mapped_to_drive1_mvr:true"]));
    try {
      const [before, incoming] = await Promise.all([inspectMvr(args.before_file), inspectMvr(args.incoming_file)]);
      const plan = planMvrImport(before, incoming, args.decisions);
      if (args.action !== "verify") {
        const offset = args.offset ?? 0, limit = args.limit ?? 100;
        return json({ nativeApplyQualified: false, qualification, consoleChanged: false, plan: { ...plan, expectedFixtures: plan.expectedFixtures.slice(offset, offset + limit) }, total: plan.expectedFixtures.length, offset, count: plan.expectedFixtures.slice(offset, offset + limit).length, incomplete: offset + limit < plan.expectedFixtures.length });
      }
      return operation(async () => {
        const steps: StepResult[] = [asRead({ name: "inspect_sources", status: "succeeded", detail: { beforeSha256: plan.beforeSha256, incomingSha256: plan.incomingSha256, planFingerprint: plan.fingerprint } })];
        if (!plan.executable) return buildResult({ operation: "mvr_import_verify", target, steps, verification: unavailable(`Decision plan is invalid: ${plan.errors.join("; ")}`), extra: { nativeApplyQualified: false, qualification } });
        try {
          if (args.native_export) {
            const identity = await readFastContext(ctx.bridge, ctx.requestTimeoutMs);
            if (!identity.contextKey || identity.identityUncertain?.length || identity.environment !== "Normal") throw new Error("Fresh native export requires complete generation/show/host/user/profile identity and Normal environment");
            const exported = await exportMvr(ctx, { file: args.observed_file!, dry_run: false, exclusive: true, mapped_to_drive1_mvr: true, timeout_ms: args.timeout_ms });
            steps.push(...exported.steps);
            if (exported.outcome !== "succeeded" || exported.verification.status !== "matched") return buildResult({ operation: "mvr_import_verify", target, steps, verification: unavailable("Fresh native MVR export was not verified; no fixture comparison was accepted"), warnings: exported.warnings, extra: { nativeApplyQualified: false, qualification } });
            const after = await readFastContext(ctx.bridge, ctx.requestTimeoutMs);
            if (after.contextKey !== identity.contextKey || after.identityUncertain?.length || after.environment !== identity.environment) throw new Error("Console context changed during native MVR export; no comparison can certify the requested console");
            steps.push(asRead({ name: "verify_export_context", status: "succeeded", detail: { contextKey: identity.contextKey } }));
          }
          const observed = await inspectMvr(args.observed_file!), verification = verifyMvrImport(plan, observed);
          steps.push(asRead({ name: "compare_observed_fixtures", status: "succeeded", detail: { sha256: observed.archive.sha256, fixtures: observed.objects.filter((o) => o.kind === "Fixture").length } }));
          return buildResult({ operation: "mvr_import_verify", target, steps, verification, extra: { nativeApplyQualified: false, qualification, planFingerprint: plan.fingerprint, observation: { source: args.native_export ? "fresh create-only native MVR export under unchanged console identity" : "caller-supplied file; freshness and console provenance are not established", archive: observed.archive }, consolePatchChanged: false }, warnings: ["Fixture identity and transforms are checked; non-fixture scene objects, rendering, calibration, photometry, and physical output are outside this verification.", ...plan.warnings] });
        } catch (error) {
          steps.push(asRead(stepFromError("verify_observation", error)));
          return buildResult({ operation: "mvr_import_verify", target, steps, verification: unavailable(error instanceof Error ? error.message : String(error)), extra: { nativeApplyQualified: false, qualification } });
        }
      });
    } catch (error) { return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }; }
  });
};
