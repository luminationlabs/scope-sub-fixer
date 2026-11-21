/**
 * `scope-sub apply` — execute a reviewed plan (PRD §17.3).
 *
 * Dry run unless `--execute` is given, and even then the inputs are only read:
 * outputs go under `--output-root`, and the original is replaced only if
 * `--replace-original` asks for it, after the new file has been verified.
 * `--dangerously-in-place` is the exception, and says so in its name: it
 * writes the planned bytes into the inputs themselves, with no copy and no
 * backup, leaving the plan directory as the only undo record.
 */
import { Command } from "commander";
import {
  APPLY_EXIT,
  ApplyError,
  applyPlan,
  type ApplyOptions,
  type ApplyRunResult,
} from "../batch/apply.js";
import { PlanFileError } from "../batch/planFile.js";
import { DependencyMissingError } from "../mkv/inspect.js";
import { createLogger, isLogLevel, LOG_LEVELS, type LogLevel } from "../scan/log.js";
import { formatBytes } from "../report/format.js";
import { TOOL_NAME, TOOL_VERSION } from "../report/version.js";
import { ArgumentError, parseIntOption, type CliIo } from "./scan.js";

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export interface RawApplyOptions {
  outputRoot?: string;
  execute?: boolean;
  dangerouslyInPlace?: boolean;
  skipVerify?: boolean;
  preserveDates?: boolean;
  jobs?: string;
  replaceOriginal?: boolean;
  backupSuffix?: string;
  overwriteOutput?: boolean;
  stopOnError?: boolean;
  format?: string;
  logLevel?: string;
}

export function resolveApplyArgs(raw: RawApplyOptions): {
  options: ApplyOptions;
  format: "human" | "json";
  logLevel: LogLevel;
} {
  const inPlace = raw.dangerouslyInPlace === true;
  if (inPlace) {
    if (raw.outputRoot !== undefined) {
      throw new ArgumentError(
        "--dangerously-in-place modifies the original files; it does not take --output-root",
      );
    }
    if (raw.replaceOriginal === true) {
      throw new ArgumentError(
        "--dangerously-in-place and --replace-original cannot be combined; pass one",
      );
    }
    if (raw.overwriteOutput === true) {
      throw new ArgumentError(
        "--overwrite-output does not apply to --dangerously-in-place (no output files are written)",
      );
    }
  } else {
    if (raw.outputRoot === undefined || raw.outputRoot.trim() === "") {
      throw new ArgumentError(
        "--output-root <dir> is required (or --dangerously-in-place, to modify the " +
          "original files)",
      );
    }
    if (raw.skipVerify === true) {
      throw new ArgumentError(
        "--skip-verify only applies to --dangerously-in-place; a copy is always verified",
      );
    }
    if (raw.preserveDates === true) {
      throw new ArgumentError(
        "--preserve-dates only applies to --dangerously-in-place; a copy is a new file",
      );
    }
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
  const jobs = parseIntOption(raw.jobs, "--jobs", { min: 1 });
  if (raw.backupSuffix !== undefined && !raw.backupSuffix.startsWith(".")) {
    throw new ArgumentError(
      `invalid --backup-suffix "${raw.backupSuffix}" (it should start with a dot)`,
    );
  }
  if (raw.replaceOriginal === true && raw.execute !== true) {
    throw new ArgumentError("--replace-original requires --execute");
  }

  return {
    options: {
      ...(raw.outputRoot === undefined ? {} : { outputRoot: raw.outputRoot }),
      execute: raw.execute === true,
      ...(inPlace ? { inPlace: true, skipVerify: raw.skipVerify === true } : {}),
      ...(inPlace && raw.preserveDates === true ? { preserveDates: true } : {}),
      replaceOriginal: raw.replaceOriginal === true,
      overwriteOutput: raw.overwriteOutput === true,
      stopOnError: raw.stopOnError === true,
      ...(jobs === undefined ? {} : { jobs }),
      ...(raw.backupSuffix === undefined ? {} : { backupSuffix: raw.backupSuffix }),
    },
    format,
    logLevel,
  };
}

export function formatApplyReport(run: ApplyRunResult): string {
  const lines: string[] = [];
  const where = run.inPlace
    ? "in place (--dangerously-in-place: no copies, no backups)"
    : `→ ${run.outputRoot}`;
  lines.push(
    run.execute
      ? `applied plan ${run.dir} ${where}`
      : `DRY RUN of plan ${run.dir} ${where} (nothing was written; pass --execute)`,
  );
  lines.push("");
  for (const f of run.files) {
    const label =
      f.status === "would-apply"
        ? "would fix"
        : f.status === "applied"
          ? f.inPlace
            ? "patched "
            : f.replaced
              ? "replaced"
              : "applied "
          : f.status === "skipped"
            ? "skipped "
            : f.status === "conflict"
              ? "CONFLICT"
              : "FAILED  ";
    lines.push(`${label}  ${f.relative}`);
    if ((f.status === "would-apply" || f.status === "applied") && !f.inPlace) {
      lines.push(`          → ${f.output}`);
    }
    for (const check of f.checks) lines.push(`          ${check}`);
    if (f.reason) lines.push(`          ${f.reason}`);
    if (f.sha256) lines.push(`          sha256 ${f.sha256}`);
    if (f.elapsedMs > 0 && run.execute) {
      lines.push(`          ${(f.elapsedMs / 1000).toFixed(1)}s`);
    }
  }
  if (run.files.length === 0) lines.push("(the plan has no files to fix)");

  const s = run.summary;
  lines.push("");
  lines.push(
    `${run.execute ? "applied" : "would apply"}: ${s.applied}   verified: ${s.verified}   ` +
      `skipped: ${s.skipped}   failed: ${s.failed}   conflicts: ${s.conflicts}`,
  );
  lines.push(
    `bytes written: ${formatBytes(s.bytesWritten)} in ${(run.elapsedMs / 1000).toFixed(1)}s`,
  );
  if (!run.execute && s.applied > 0) {
    lines.push("");
    lines.push("Dry run: nothing was written. Pass --execute to apply.");
  }
  if (run.inPlace && run.execute && s.applied > 0) {
    lines.push("");
    lines.push(
      `No backups were made. ${run.dir} holds the undo data for these files ` +
        "(scope-sub revert <plan> --in-place --execute). Keep it.",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function formatApplyJson(run: ApplyRunResult): string {
  return `${JSON.stringify(
    { tool: TOOL_NAME, version: TOOL_VERSION, command: "apply", ...run },
    null,
    2,
  )}\n`;
}

export async function runApply(
  dir: string,
  raw: RawApplyOptions,
  io: CliIo = defaultIo,
): Promise<number> {
  let resolved: ReturnType<typeof resolveApplyArgs>;
  try {
    resolved = resolveApplyArgs(raw);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return APPLY_EXIT.BAD_ARGS;
  }

  const log = createLogger(resolved.logLevel, (line) => io.stderr(`${line}\n`));
  try {
    const run = await applyPlan(dir, resolved.options, { log });
    io.stdout(
      resolved.format === "json" ? formatApplyJson(run) : formatApplyReport(run),
    );
    return run.exitCode;
  } catch (err) {
    if (err instanceof ApplyError) {
      io.stderr(`${err.message}\n`);
      return err.exitCode;
    }
    if (err instanceof PlanFileError) {
      io.stderr(`${err.message}\n`);
      return APPLY_EXIT.BAD_ARGS;
    }
    if (err instanceof DependencyMissingError) {
      io.stderr(`${err.message}\n`);
      return APPLY_EXIT.DEPENDENCY_MISSING;
    }
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return APPLY_EXIT.FIX_FAILURE;
  }
}

/** Attach the `apply` subcommand to a commander program. */
export function registerApplyCommand(program: Command, io: CliIo = defaultIo): Command {
  return program
    .command("apply")
    .description("apply a plan: write a fixed copy of each planned file under --output-root")
    .argument("<dir>", "the plan directory written by `plan`")
    .option(
      "--output-root <dir>",
      "directory the fixed copies are written to (required unless --dangerously-in-place)",
    )
    .option("--execute", "write changes (default: dry run)", false)
    .option(
      "--dangerously-in-place",
      "modify each original file directly: no copy, no backup; the plan directory is " +
        "the only undo data (patch method only)",
      false,
    )
    .option(
      "--skip-verify",
      "with --dangerously-in-place: skip PGS verification after writing (saves a full read per file)",
      false,
    )
    .option(
      "--jobs <n>",
      "files processed in parallel (each is a full copy; 1 is usually best)",
      "1",
    )
    .option(
      "--replace-original",
      "after verification, rename the original aside and move the fixed file into its place",
      false,
    )
    .option(
      "--preserve-dates",
      "with --dangerously-in-place: restore each file's modification date after writing",
      false,
    )
    .option("--backup-suffix <suffix>", "suffix for the kept original", ".pre-scopefix")
    .option("--overwrite-output", "replace files already present under --output-root", false)
    .option("--stop-on-error", "stop at the first failure instead of continuing", false)
    .option("--format <human|json>", "report format", "human")
    .option(`--log-level <level>`, `one of ${LOG_LEVELS.join("|")}`, "info")
    .action(async (dir: string, options: RawApplyOptions) => {
      process.exitCode = await runApply(dir, options, io);
    });
}
