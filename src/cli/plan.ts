/**
 * `scope-sub plan` — analyze a library and write a plan directory (PRD §17.2).
 *
 * Read-only, exactly like `scan`: the only thing written is the plan directory
 * the operator names.
 */
import { Command } from "commander";
import { PlanFileError } from "../batch/planFile.js";
import { runPlan, PLAN_STATUS_ORDER, type PlanRunResult } from "../batch/plan.js";
import type { FixMethod } from "../fix/types.js";
import { createLogger, LOG_LEVELS } from "../scan/log.js";
import { TOOL_NAME, TOOL_VERSION } from "../report/version.js";
import {
  ArgumentError,
  EXIT,
  resolveScanArgs,
  type CliIo,
  type RawScanOptions,
} from "./scan.js";

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export interface RawPlanOptions extends RawScanOptions {
  plan?: string;
  method?: string;
  reanalyze?: boolean;
}

export function parseMethod(value: string | undefined): FixMethod {
  const v = (value ?? "patch").trim().toLowerCase();
  if (v === "patch" || v === "remux") return v;
  throw new ArgumentError(`invalid --method "${value}" (expected patch or remux)`);
}

/** "1 entry", "3 unchanged entries". */
function entries(n: number, qualifier = ""): string {
  return `${n} ${qualifier}${n === 1 ? "entry" : "entries"}`;
}

export function formatPlanReport(run: PlanRunResult): string {
  const s = run.summary;
  const rows: [string, number][] = [
    ["Planned:", s.files],
    ["To fix:", s.fix],
    ["Skipped:", s.skip],
  ];
  for (const status of PLAN_STATUS_ORDER) {
    const n = s.byStatus[status] ?? 0;
    if (n > 0) rows.push([`  ${status}:`, n]);
  }
  const labelWidth = Math.max(...rows.map((r) => r[0].length));
  const lines = [`Plan written to ${run.dir}`, ""];
  for (const [label, value] of rows) {
    lines.push(`${label.padEnd(labelWidth)}  ${String(value).padStart(5)}`);
  }
  lines.push("");
  lines.push(
    `planned fixes: ${s.fix} file(s), ${s.tracks} track(s), ${s.eventsMoved} event(s)`,
  );
  if (s.fix > 0) {
    lines.push(
      `  ${s.positionFields} position field(s), ${s.bytesChanged} byte(s) will change`,
    );
  }
  lines.push(
    `analyzed ${run.analyzed}, reused ${entries(run.reused, "unchanged ")} in ` +
      `${(run.elapsedMs / 1000).toFixed(1)}s`,
  );
  if (run.notFound.length > 0) {
    lines.push(
      `kept ${entries(run.notFound.length)} for files not found ` +
        "(moved, deleted or not mounted)",
    );
  }
  if (run.adopted.length > 0) {
    lines.push(
      `kept ${entries(run.adopted.length)} for files with header edits only ` +
        "(media unchanged); recorded size updated",
    );
  }
  if (run.superseded.length > 0) {
    lines.push(
      `${run.superseded.length} fixed file(s) were replaced by different files and ` +
        "reanalyzed; previous undo data kept",
    );
  }
  if (run.restored.length > 0) {
    lines.push(
      `${run.restored.length} fixed file(s) contain the original bytes again (possibly restored ` +
        "from a backup); recorded in the log, and apply will fix them again",
    );
  }
  if (run.unfinished.length > 0) {
    lines.push(
      `${run.unfinished.length} file(s) have an unfinished in-place write and may be ` +
        "partially modified; finish with apply --dangerously-in-place or revert --in-place:",
    );
    for (const file of run.unfinished) lines.push(`  ${file}`);
  }
  if (run.unreadable.length > 0) {
    lines.push(
      `${run.unreadable.length} file(s) could not be analyzed; entries kept unchanged:`,
    );
    for (const file of run.unreadable) lines.push(`  ${file}`);
  }
  if (run.keptChanged.length > 0) {
    lines.push(
      `kept ${entries(run.keptChanged.length)} for files modified since this plan wrote them ` +
        "(undo data may no longer match; see warnings above)",
    );
  }
  lines.push("");
  lines.push(`next: ${TOOL_NAME} plan-show ${run.dir}`);
  lines.push(`then: ${TOOL_NAME} apply ${run.dir} --output-root <dir>   (dry run)`);
  return `${lines.join("\n")}\n`;
}

export function formatPlanJson(run: PlanRunResult): string {
  return `${JSON.stringify(
    {
      tool: TOOL_NAME,
      version: TOOL_VERSION,
      command: "plan",
      dir: run.dir,
      analyzed: run.analyzed,
      analyzedFiles: run.analyzedFiles,
      reused: run.reused,
      keptChanged: run.keptChanged,
      notFound: run.notFound,
      superseded: run.superseded,
      adopted: run.adopted,
      unreadable: run.unreadable,
      restored: run.restored,
      unfinished: run.unfinished,
      missingPaths: run.missingPaths,
      elapsedMs: run.elapsedMs,
      summary: run.summary,
      plan: run.plan,
    },
    null,
    2,
  )}\n`;
}

export async function runPlanCommand(
  paths: readonly string[],
  raw: RawPlanOptions,
  io: CliIo = defaultIo,
): Promise<number> {
  let args: ReturnType<typeof resolveScanArgs>;
  let method: FixMethod;
  try {
    args = resolveScanArgs(raw);
    method = parseMethod(raw.method);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.BAD_ARGS;
  }
  if (paths.length === 0) {
    io.stderr("no paths given; pass one or more files or directories\n");
    return EXIT.BAD_ARGS;
  }
  if (raw.plan === undefined || raw.plan.trim() === "") {
    io.stderr("--plan <dir> is required: it is where the plan is written\n");
    return EXIT.BAD_ARGS;
  }

  const log = createLogger(args.logLevel, (line) => io.stderr(`${line}\n`));
  let run: PlanRunResult;
  try {
    run = await runPlan(
      paths,
      raw.plan,
      {
        ...args.scan,
        method,
        ...(raw.reanalyze === true ? { reanalyze: true } : {}),
      },
      { log },
    );
  } catch (err) {
    if (err instanceof PlanFileError) {
      io.stderr(`${err.message}\n`);
      return EXIT.BAD_ARGS;
    }
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.UNSUPPORTED_MEDIA;
  }

  io.stdout(args.format === "json" ? formatPlanJson(run) : formatPlanReport(run));

  if (run.missingPaths.length > 0) return EXIT.BAD_ARGS;
  if (run.plan.files.length > 0 && run.plan.files.every((f) => f.status === "ERROR")) {
    return EXIT.UNSUPPORTED_MEDIA;
  }
  return EXIT.OK;
}

/** Attach the `plan` subcommand to a commander program. */
export function registerPlanCommand(program: Command, io: CliIo = defaultIo): Command {
  return program
    .command("plan")
    .description("analyze files or directories and write a plan directory for review")
    .argument("<paths...>", "MKV files or directories to plan")
    .requiredOption("--plan <dir>", "plan directory to create or update")
    .option(
      "--aspect <ratio>",
      'picture aspect ratio (e.g. 2.39, 2.39:1, 16:9), or "auto" to detect it',
      "auto",
    )
    .option("-r, --recursive", "descend into subdirectories (mirrors the tree on apply)", false)
    .option(
      "--method <patch|remux>",
      "fix method the plan is built for; patch is byte-minimal, remux rebuilds the file",
      "patch",
    )
    .option("--margin <px>", "distance kept between a moved subtitle and the picture edge (default: 24 px at 1080)")
    .option("--jobs <n>", "files analyzed in parallel", "1")
    .option("--reanalyze", "ignore any existing plan entries and analyze everything", false)
    .option("--tolerance <px>", "clustering tolerance for the sampled frames (auto aspect only)")
    .option("--samples <n>", "frames sampled for auto aspect detection", "24")
    .option(
      "--source <direct|mkvextract>",
      "PGS reader: the direct block reader, or mkvextract into a temp .sup",
      "direct",
    )
    .option(
      "--read-strategy <auto|minimal|adaptive|balanced|sequential>",
      "direct reader buffering: auto (the default) streams the whole file, which is fastest everywhere; adaptive/minimal transfer ~3% but take longer",
      "auto",
    )
    .option("--temp-dir <path>", "scratch directory for extracted .sup files")
    .option(
      "--no-fast-path",
      "read the PGS tracks even when the title has no letterbox bars (they are skipped by default: nothing can be outside a full frame)",
    )
    .option("--format <human|json>", "report format", "human")
    .option(`--log-level <level>`, `one of ${LOG_LEVELS.join("|")}`, "info")
    .action(async (paths: string[], options: RawPlanOptions) => {
      process.exitCode = await runPlanCommand(paths, options, io);
    });
}
