/**
 * `scope-sub fix` — repair one MKV into a second file.
 *
 * The source is only ever read: the output is a separate path, the input is
 * never deleted, and temp files live outside the source directory (PRD §12.5).
 */
import { Command } from "commander";
import { FIX_EXIT, FixError, fixFile, type FixOptions } from "../fix/index.js";
import type { FixMethod, FixResult, FixTrackResult } from "../fix/types.js";
import { RemuxError } from "../fix/remux.js";
import { PatchVerifyError } from "../fix/patchFile.js";
import { DependencyMissingError } from "../mkv/inspect.js";
import { createLogger, isLogLevel, LOG_LEVELS, type LogLevel } from "../scan/log.js";
import { formatBytes } from "../report/format.js";
import { TOOL_NAME, TOOL_VERSION } from "../report/version.js";
import {
  ArgumentError,
  parseAspect,
  parseIntOption,
  type CliIo,
} from "./scan.js";

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export interface RawFixOptions {
  output?: string;
  aspect?: string;
  track?: string[];
  method?: string;
  keepOriginalSubtitle?: boolean;
  dryRun?: boolean;
  overwriteOutput?: boolean;
  margin?: string;
  samples?: string;
  tolerance?: string;
  tempDir?: string;
  keepTemp?: boolean;
  logLevel?: string;
  format?: string;
}

function parseMethod(value: string | undefined): FixMethod {
  const v = (value ?? "patch").trim().toLowerCase();
  if (v === "patch" || v === "remux") return v;
  throw new ArgumentError(`invalid --method "${value}" (expected patch or remux)`);
}

function parseTrackIds(values: readonly string[] | undefined): number[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  const ids: number[] = [];
  for (const raw of values) {
    for (const part of raw.split(",")) {
      const text = part.trim();
      if (text === "") continue;
      const n = Number(text);
      if (!Number.isInteger(n) || n < 0) {
        throw new ArgumentError(
          `invalid --track "${part}" (expected an mkvmerge track id)`,
        );
      }
      ids.push(n);
    }
  }
  return ids.length > 0 ? ids : undefined;
}

export function resolveFixArgs(
  input: string,
  raw: RawFixOptions,
): { options: FixOptions; format: "human" | "json"; logLevel: LogLevel } {
  if (raw.output === undefined && raw.dryRun !== true) {
    throw new ArgumentError("--output is required unless --dry-run is given");
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
  const margin = parseIntOption(raw.margin, "--margin");
  const samples = parseIntOption(raw.samples, "--samples", { min: 1 });
  const tolerance = parseIntOption(raw.tolerance, "--tolerance");
  const trackIds = parseTrackIds(raw.track);

  const options: FixOptions = {
    // With --dry-run and no --output nothing is ever written; the placeholder
    // only has to differ from the input so the "same path" refusal cannot fire.
    output: raw.output ?? `${input}.scopefix.mkv`,
    aspect: parseAspect(raw.aspect ?? "auto"),
    method: parseMethod(raw.method),
    keepOriginalSubtitle: raw.keepOriginalSubtitle === true,
    dryRun: raw.dryRun === true,
    overwriteOutput: raw.overwriteOutput === true,
    keepTemp: raw.keepTemp === true,
    ...(margin === undefined ? {} : { margin }),
    ...(samples === undefined ? {} : { samples }),
    ...(tolerance === undefined ? {} : { tolerancePx: tolerance }),
    ...(raw.tempDir === undefined ? {} : { tempDir: raw.tempDir }),
    ...(trackIds === undefined ? {} : { trackIds }),
  };
  return { options, format, logLevel };
}

function trackLine(t: FixTrackResult): string {
  const label = `track ${t.trackId} (${t.language}${t.name ? `, ${t.name}` : ""})`;
  if (!t.fixed) {
    const why =
      t.error ?? (t.offendingEventCount > 0 ? "no move could be planned" : "unchanged");
    return `  ${label}: ${why}`;
  }
  return (
    `  ${label}: ${t.eventsMoved} event(s) moved, ` +
    `${t.displaySetsPatched} display set(s), ` +
    `${t.positionFieldsChanged} position field(s), ${t.bytesChanged} byte(s) changed`
  );
}

export interface FixReportOptions {
  /** False when --dry-run ran without --output, so the path is a placeholder. */
  outputGiven?: boolean;
}

export function formatFixReport(
  result: FixResult,
  options: FixReportOptions = {},
): string {
  const lines: string[] = [];
  lines.push(`${result.dryRun ? "DRY RUN " : ""}${result.method} fix`);
  lines.push(`  input:  ${result.input} (${formatBytes(result.inputBytes)})`);
  lines.push(
    options.outputGiven === false
      ? "  output: (none given; --dry-run)"
      : `  output: ${result.output}` +
          (result.outputBytes === undefined
            ? result.dryRun
              ? " (not written: dry run)"
              : " (not written)"
            : ` (${formatBytes(result.outputBytes)})`),
  );
  if (result.activeArea) {
    const a = result.activeArea;
    lines.push(
      `  active area: y=${a.top}..${a.bottom} (${a.aspect}:1, ${a.source}, ${a.classification})`,
    );
  }
  if (result.keepOriginalSubtitle) {
    lines.push("  A/B mode: original subtitle tracks kept, corrected tracks appended");
  }
  for (const t of result.tracks) lines.push(trackLine(t));
  for (const t of result.tracks) {
    for (const reason of t.skipped) {
      lines.push(`  track ${t.trackId} skipped: ${reason}`);
    }
  }
  for (const note of result.notes) lines.push(`  note: ${note}`);
  lines.push(
    `  totals: ${result.totals.tracksFixed} track(s), ` +
      `${result.totals.eventsMoved} event(s), ` +
      `${result.totals.displaySetsPatched} display set(s), ` +
      `${result.totals.bytesChanged} byte(s) changed in ${(result.elapsedMs / 1000).toFixed(1)}s`,
  );
  return `${lines.join("\n")}\n`;
}

export function formatFixJson(result: FixResult): string {
  return `${JSON.stringify(
    {
      tool: TOOL_NAME,
      version: TOOL_VERSION,
      command: "fix",
      ...result,
      tracks: result.tracks,
    },
    null,
    2,
  )}\n`;
}

/** Run a fix and print its report. Returns the process exit code. */
export async function runFix(
  input: string,
  raw: RawFixOptions,
  io: CliIo = defaultIo,
): Promise<number> {
  let resolved: ReturnType<typeof resolveFixArgs>;
  try {
    resolved = resolveFixArgs(input, raw);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return FIX_EXIT.BAD_ARGS;
  }

  const log = createLogger(resolved.logLevel, (line) => io.stderr(`${line}\n`));

  try {
    const result = await fixFile(input, resolved.options, { log });
    io.stdout(
      resolved.format === "json"
        ? formatFixJson(result)
        : formatFixReport(result, { outputGiven: raw.output !== undefined }),
    );
    return FIX_EXIT.OK;
  } catch (err) {
    if (err instanceof FixError) {
      io.stderr(`${err.message}\n`);
      if (err.detail) io.stderr(`  ${err.detail}\n`);
      return err.exitCode;
    }
    if (err instanceof DependencyMissingError) {
      io.stderr(`${err.message}\n`);
      return FIX_EXIT.DEPENDENCY_MISSING;
    }
    if (err instanceof RemuxError) {
      io.stderr(`${err.message}\n${err.detail}\n`);
      return FIX_EXIT.REMUX_FAILURE;
    }
    if (err instanceof PatchVerifyError) {
      io.stderr(`${err.message}\n`);
      return FIX_EXIT.VALIDATION_FAILURE;
    }
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return FIX_EXIT.UNSUPPORTED_MEDIA;
  }
}

/** Attach the `fix` subcommand to a commander program. */
export function registerFixCommand(program: Command, io: CliIo = defaultIo): Command {
  return program
    .command("fix")
    .description("move PGS subtitles that are outside the picture into it, writing a new MKV")
    .argument("<input>", "the MKV to fix (never modified)")
    .option("-o, --output <path>", "destination MKV (required unless --dry-run)")
    .option(
      "--aspect <ratio>",
      'picture aspect ratio (e.g. 2.39, 2.39:1, 16:9), or "auto" to detect it',
      "auto",
    )
    .option(
      "--track <id...>",
      "only fix these mkvmerge track ids (default: every PGS track)",
    )
    .option(
      "--method <patch|remux>",
      "patch rewrites position fields in a byte copy; remux rebuilds the file with mkvmerge",
      "patch",
    )
    .option(
      "--keep-original-subtitle",
      "A/B mode: keep the original tracks and append the corrected ones (needs --method remux)",
      false,
    )
    .option("--dry-run", "report the plan and write nothing", false)
    .option("--overwrite-output", "replace an existing output file", false)
    .option("--margin <px>", "distance kept between a moved subtitle and the picture edge (default: 24 px at 1080)")
    .option("--tolerance <px>", "clustering tolerance for the sampled frames (auto aspect only)")
    .option("--samples <n>", "frames sampled for auto aspect detection", "24")
    .option("--temp-dir <path>", "scratch directory (must be outside the source directory)")
    .option("--keep-temp", "keep the corrected .sup files", false)
    .option("--format <human|json>", "report format", "human")
    .option(`--log-level <level>`, `one of ${LOG_LEVELS.join("|")}`, "info")
    .action(async (input: string, options: RawFixOptions) => {
      process.exitCode = await runFix(input, options, io);
    });
}
