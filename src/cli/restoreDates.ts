/**
 * `scope-sub restore-dates <dir>`: put back the modification date of every
 * file the plan repaired at its own path, to the date it had before the first
 * repair. For libraries repaired without `--preserve-dates`, where something
 * (a media server's "recently added") reads meaning into that date.
 *
 * A dry run unless `--execute` is given. Only dates change; see
 * `src/batch/dates.ts` for where the date comes from and which files are left
 * alone.
 */
import { Command } from "commander";
import { restoreDates, type RestoreDatesResult } from "../batch/dates.js";
import { PlanFileError } from "../batch/planFile.js";
import { createLogger, isLogLevel, LOG_LEVELS } from "../scan/log.js";
import { EXIT, type CliIo } from "./scan.js";

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export interface RawRestoreDatesOptions {
  file?: string;
  execute?: boolean;
  logLevel?: string;
}

const day = (ms: number | undefined): string =>
  ms === undefined ? "?" : new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export function formatRestoreDatesReport(run: RestoreDatesResult): string {
  const count = (status: string): number => run.files.filter((f) => f.status === status).length;
  const lines: string[] = [];
  const moved = run.files.filter((f) => f.status === "restored" || f.status === "would-restore");
  if (moved.length > 0) {
    lines.push(run.execute ? "Dates restored:" : "Dates that would be restored (UTC):");
    for (const f of moved) lines.push(`  ${f.relative}: ${day(f.from)} → ${day(f.to)}`);
  }
  const failed = run.files.filter((f) => f.status === "failed");
  if (failed.length > 0) {
    lines.push("Could not be changed:");
    for (const f of failed) lines.push(`  ${f.relative}: ${f.reason ?? ""}`);
  }
  const skipped = run.files.filter((f) => f.status === "skipped");
  if (skipped.length > 0) {
    lines.push("Skipped:");
    for (const f of skipped) lines.push(`  ${f.relative}: ${f.reason ?? ""}`);
  }
  lines.push(
    `${run.files.length} fixed file(s): ` +
      (run.execute ? `${count("restored")} restored` : `${count("would-restore")} to restore`) +
      `, ${count("already")} already at the original date, ${skipped.length} skipped` +
      (failed.length > 0 ? `, ${failed.length} failed` : ""),
  );
  if (!run.execute && moved.length > 0) {
    lines.push("Dry run: no dates were changed. Pass --execute to restore them.");
  }
  return `${lines.join("\n")}\n`;
}

export async function runRestoreDates(
  dir: string,
  raw: RawRestoreDatesOptions,
  io: CliIo = defaultIo,
): Promise<number> {
  const logLevel = raw.logLevel ?? "warn";
  if (!isLogLevel(logLevel)) {
    io.stderr(`invalid --log-level "${logLevel}" (expected one of ${LOG_LEVELS.join(", ")})\n`);
    return EXIT.BAD_ARGS;
  }
  const log = createLogger(logLevel, (line) => io.stderr(`${line}\n`));
  let run: RestoreDatesResult;
  try {
    run = await restoreDates(
      dir,
      {
        execute: raw.execute === true,
        ...(raw.file === undefined ? {} : { file: raw.file }),
      },
      { log },
    );
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof PlanFileError ? EXIT.BAD_ARGS : 1;
  }
  io.stdout(formatRestoreDatesReport(run));
  return run.files.some((f) => f.status === "failed") ? 1 : EXIT.OK;
}

/** Attach the `restore-dates` subcommand to a commander program. */
export function registerRestoreDatesCommand(program: Command, io: CliIo = defaultIo): Command {
  return program
    .command("restore-dates")
    .description(
      "restore the modification date of every file the plan fixed in place to its " +
        "date before the first fix (only dates change)",
    )
    .argument("<dir>", "the plan directory")
    .option("--file <substring>", "only files whose path contains this substring")
    .option("--execute", "change the dates (default: dry run)", false)
    .option(`--log-level <level>`, `one of ${LOG_LEVELS.join("|")}`, "warn")
    .action(async (dir: string, options: RawRestoreDatesOptions) => {
      process.exitCode = await runRestoreDates(dir, options, io);
    });
}
