/**
 * `scope-sub revert` — put an applied repair back.
 *
 * A dry run unless `--execute`, exactly like `apply`, and it refuses any file
 * whose bytes are not the ones the plan says it wrote.
 */
import { Command } from "commander";
import { APPLY_EXIT } from "../batch/apply.js";
import {
  RevertError,
  revertPatchFileTarget,
  revertPlan,
  type RevertOptions,
  type RevertRunResult,
} from "../batch/revert.js";
import { PlanFileError } from "../batch/planFile.js";
import { createLogger, isLogLevel, LOG_LEVELS, type LogLevel } from "../scan/log.js";
import { formatBytes } from "../report/format.js";
import { TOOL_NAME, TOOL_VERSION } from "../report/version.js";
import { ArgumentError, type CliIo } from "./scan.js";

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export interface RawRevertOptions {
  file?: string;
  inPlace?: boolean;
  preserveDates?: boolean;
  outputRoot?: string;
  output?: string;
  patchFile?: string;
  target?: string;
  execute?: boolean;
  overwriteOutput?: boolean;
  format?: string;
  logLevel?: string;
}

export interface ResolvedRevertArgs {
  options: RevertOptions;
  /** Set for the single-file mode, where there is no plan directory. */
  patchFile: string | undefined;
  target: string | undefined;
  format: "human" | "json";
  logLevel: LogLevel;
}

/**
 * Validate the two shapes this command has: a plan directory, or an explicit
 * patch file plus the repaired file it describes. Mixing them is refused rather
 * than resolved by precedence — the two name different files to write.
 */
export function resolveRevertArgs(
  dir: string | undefined,
  raw: RawRevertOptions,
): ResolvedRevertArgs {
  const single = raw.patchFile !== undefined || raw.target !== undefined;
  if (dir !== undefined && single) {
    throw new ArgumentError(
      "pass either a plan directory or --patch-file with --target, not both",
    );
  }
  if (dir === undefined && !single) {
    throw new ArgumentError(
      "pass a plan directory, or --patch-file <patches.json> --target <fixed.mkv>",
    );
  }
  if (single && (raw.patchFile === undefined || raw.target === undefined)) {
    throw new ArgumentError("--patch-file and --target go together");
  }
  if (raw.preserveDates === true && raw.inPlace !== true) {
    throw new ArgumentError("--preserve-dates only applies to --in-place; a copy is a new file");
  }
  if (raw.outputRoot !== undefined && raw.output !== undefined) {
    throw new ArgumentError("--output-root is for a plan directory, --output for --target");
  }
  if (dir !== undefined && raw.output !== undefined) {
    throw new ArgumentError("a plan directory writes many files: use --output-root <dir>");
  }
  if (single && raw.outputRoot !== undefined) {
    throw new ArgumentError("--target writes one file: use --output <out.mkv>");
  }

  const format = raw.format ?? "human";
  if (format !== "human" && format !== "json") {
    throw new ArgumentError(`invalid --format "${format}" (expected human or json)`);
  }
  const logLevel = raw.logLevel ?? "info";
  if (!isLogLevel(logLevel)) {
    throw new ArgumentError(
      `invalid --log-level "${logLevel}" (expected one of ${LOG_LEVELS.join(", ")})`,
    );
  }

  return {
    options: {
      execute: raw.execute === true,
      inPlace: raw.inPlace === true,
      ...(raw.preserveDates === true ? { preserveDates: true } : {}),
      overwriteOutput: raw.overwriteOutput === true,
      ...(raw.file === undefined ? {} : { file: raw.file }),
      ...(raw.outputRoot === undefined ? {} : { outputRoot: raw.outputRoot }),
      ...(raw.output === undefined ? {} : { output: raw.output }),
    },
    patchFile: raw.patchFile,
    target: raw.target,
    format,
    logLevel,
  };
}

export function formatRevertReport(run: RevertRunResult): string {
  const where = run.inPlace ? "in place" : `→ ${run.outputRoot ?? "the given output"}`;
  const lines: string[] = [
    run.execute
      ? `reverted ${run.dir ?? "one file"} ${where}`
      : `DRY RUN of reverting ${run.dir ?? "one file"} ${where} ` +
        "(nothing was written; pass --execute)",
    "",
  ];
  for (const f of run.files) {
    const label =
      f.status === "would-revert"
        ? "would revert"
        : f.status === "reverted"
          ? "reverted    "
          : f.status === "skipped"
            ? "skipped     "
            : "REFUSED     ";
    lines.push(`${label}  ${f.relative}`);
    if (f.status === "reverted" || f.status === "would-revert") {
      lines.push(`              ${f.inPlace ? f.target : `→ ${f.output}`}`);
    }
    for (const check of f.checks) lines.push(`              ${check}`);
    if (f.reason) lines.push(`              ${f.reason}`);
    if (f.sha256) lines.push(`              sha256 ${f.sha256}`);
  }
  if (run.files.length === 0) lines.push("(nothing in this plan has been applied)");

  const s = run.summary;
  lines.push("");
  lines.push(
    `${run.execute ? "reverted" : "would revert"}: ${s.reverted}   ` +
      `skipped: ${s.skipped}   refused: ${s.failed}`,
  );
  lines.push(
    `bytes written: ${formatBytes(s.bytesWritten)} in ${(run.elapsedMs / 1000).toFixed(1)}s`,
  );
  if (!run.execute && s.reverted > 0) {
    lines.push("");
    lines.push("Dry run: nothing was written. Pass --execute to revert.");
  }
  return `${lines.join("\n")}\n`;
}

export function formatRevertJson(run: RevertRunResult): string {
  return `${JSON.stringify(
    { tool: TOOL_NAME, version: TOOL_VERSION, command: "revert", ...run },
    null,
    2,
  )}\n`;
}

export async function runRevert(
  dir: string | undefined,
  raw: RawRevertOptions,
  io: CliIo = defaultIo,
): Promise<number> {
  let args: ResolvedRevertArgs;
  try {
    args = resolveRevertArgs(dir, raw);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return APPLY_EXIT.BAD_ARGS;
  }

  const log = createLogger(args.logLevel, (line) => io.stderr(`${line}\n`));
  try {
    const run =
      dir === undefined
        ? await revertPatchFileTarget(
            { ...args.options, patchFile: args.patchFile!, target: args.target! },
            { log },
          )
        : await revertPlan(dir, args.options, { log });
    io.stdout(args.format === "json" ? formatRevertJson(run) : formatRevertReport(run));
    return run.exitCode;
  } catch (err) {
    if (err instanceof RevertError) {
      io.stderr(`${err.message}\n`);
      return err.exitCode;
    }
    if (err instanceof PlanFileError) {
      io.stderr(`${err.message}\n`);
      return APPLY_EXIT.BAD_ARGS;
    }
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return APPLY_EXIT.FIX_FAILURE;
  }
}

/** Attach the `revert` subcommand to a commander program. */
export function registerRevertCommand(program: Command, io: CliIo = defaultIo): Command {
  return program
    .command("revert")
    .description(
      "undo a fix: write the original bytes recorded in the plan back to the fixed file",
    )
    .argument("[dir]", "the plan directory whose fixes are reverted")
    .option("--file <substring>", "only files whose path contains this substring")
    .option(
      "--in-place",
      "write the original bytes into the fixed file directly (a few KB, not a full copy)",
      false,
    )
    .option(
      "--preserve-dates",
      "with --in-place: restore each file's modification date after writing",
      false,
    )
    .option("--output-root <dir>", "write reverted copies under this directory instead")
    .option("--patch-file <path>", "revert one file from this patches/<n>.json")
    .option("--target <path>", "the fixed file that --patch-file describes")
    .option("--output <path>", "with --patch-file: write the reverted copy here")
    .option("--execute", "write changes (default: dry run)", false)
    .option("--overwrite-output", "replace an existing reverted copy", false)
    .option("--format <human|json>", "report format", "human")
    .option(`--log-level <level>`, `one of ${LOG_LEVELS.join("|")}`, "info")
    .action(async (dir: string | undefined, options: RawRevertOptions) => {
      process.exitCode = await runRevert(dir, options, io);
    });
}
