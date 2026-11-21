/**
 * `scope-sub scan` — the read-only analyzer.
 *
 * The only processes it ever starts are `mkvmerge -J`, `mkvextract ... tracks`
 * and `ffmpeg ... -f null -`; none of them modify the source media (PRD §11.2).
 */
import { Command } from "commander";
import { READ_STRATEGIES, isReadStrategyName, type ReadStrategyName } from "../mkv/ebml.js";
import { scanPaths, type ScanOptions } from "../scan/index.js";
import { createLogger, isLogLevel, LOG_LEVELS, type LogLevel } from "../scan/log.js";
import { formatHumanReport } from "../report/human.js";
import { formatJsonReport } from "../report/json.js";
import type { ScanRunResult } from "../scan/types.js";

/** Invalid command-line input. Maps onto exit code 2. */
export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgumentError";
  }
}

export const EXIT = {
  OK: 0,
  NEEDS_FIX: 1,
  BAD_ARGS: 2,
  DEPENDENCY_MISSING: 3,
  UNSUPPORTED_MEDIA: 4,
  PGS_PARSE_ERROR: 5,
} as const;

export interface RawScanOptions {
  aspect?: string;
  format?: string;
  recursive?: boolean;
  jobs?: string;
  margin?: string;
  tolerance?: string;
  samples?: string;
  maxEvents?: string;
  showEvents?: boolean;
  tempDir?: string;
  keepTemp?: boolean;
  source?: string;
  readStrategy?: string;
  logLevel?: string;
  failIfNeeded?: boolean;
  /** `scan --full`: read the PGS tracks even with no letterbox bars. */
  full?: boolean;
  /** `plan --no-fast-path`: commander's negated form of the same thing. */
  fastPath?: boolean;
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function parseReadStrategy(value: string | undefined): ReadStrategyName | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "auto") return undefined;
  if (!isReadStrategyName(v)) {
    throw new ArgumentError(
      `invalid --read-strategy "${value}" (expected auto or one of ${Object.keys(READ_STRATEGIES).join(", ")})`,
    );
  }
  return v;
}

function parseSource(value: string | undefined): "direct" | "mkvextract" {
  const v = (value ?? "direct").trim().toLowerCase();
  if (v === "direct" || v === "mkvextract") return v;
  throw new ArgumentError(`invalid --source "${value}" (expected direct or mkvextract)`);
}

/** Accepts `2.39`, `2.39:1`, `16:9` or `auto`. */
export function parseAspect(value: string): number | "auto" {
  const v = value.trim().toLowerCase();
  if (v === "auto") return "auto";
  const ratio = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(v);
  if (ratio) {
    const w = Number(ratio[1]);
    const h = Number(ratio[2]);
    if (!(w > 0) || !(h > 0)) throw new ArgumentError(`invalid --aspect "${value}"`);
    return w / h;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ArgumentError(`invalid --aspect "${value}" (expected a ratio or "auto")`);
  }
  return n;
}

export function parseIntOption(
  value: string | undefined,
  name: string,
  { min = 0 }: { min?: number } = {},
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new ArgumentError(`invalid ${name} "${value}" (expected an integer >= ${min})`);
  }
  return n;
}

export interface ResolvedScanArgs {
  scan: ScanOptions;
  format: "human" | "json";
  showEvents: boolean;
  maxEvents: number;
  logLevel: LogLevel;
  failIfNeeded: boolean;
  marginOverride: number | undefined;
}

/** Validate and normalize the raw commander options. Throws `ArgumentError`. */
export function resolveScanArgs(raw: RawScanOptions): ResolvedScanArgs {
  const aspect = parseAspect(raw.aspect ?? "auto");
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
  const jobs = parseIntOption(raw.jobs, "--jobs", { min: 1 });
  const samples = parseIntOption(raw.samples, "--samples", { min: 1 });
  const tolerance = parseIntOption(raw.tolerance, "--tolerance");
  const maxEvents = parseIntOption(raw.maxEvents, "--max-events");
  const readStrategy = parseReadStrategy(raw.readStrategy);

  const scan: ScanOptions = {
    aspect,
    recursive: raw.recursive === true,
    keepTemp: raw.keepTemp === true,
    ...(margin === undefined ? {} : { margin }),
    ...(jobs === undefined ? {} : { jobs }),
    ...(samples === undefined ? {} : { samples }),
    ...(tolerance === undefined ? {} : { tolerancePx: tolerance }),
    ...(raw.tempDir === undefined ? {} : { tempDir: raw.tempDir }),
    source: parseSource(raw.source),
    ...(readStrategy === undefined ? {} : { readStrategy }),
    ...(raw.full === true || raw.fastPath === false ? { full: true } : {}),
  };

  return {
    scan,
    format,
    showEvents: raw.showEvents === true,
    maxEvents: maxEvents ?? 10,
    logLevel,
    failIfNeeded: raw.failIfNeeded === true,
    marginOverride: margin,
  };
}

/** Map a completed run onto the exit codes of PRD §20. */
export function exitCodeFor(run: ScanRunResult, failIfNeeded: boolean): number {
  if (run.missingPaths.length > 0) return EXIT.BAD_ARGS;

  const dependencyMissing =
    run.files.some((f) => f.errorKind === "DEPENDENCY_MISSING") ||
    run.files.some((f) => f.tracks.some((t) => t.errorKind === "DEPENDENCY_MISSING"));
  if (dependencyMissing) return EXIT.DEPENDENCY_MISSING;

  const allFailed =
    run.files.length > 0 && run.files.every((f) => f.status === "ERROR");
  if (allFailed) {
    const allParseErrors = run.files.every(
      (f) =>
        f.errorKind === "PGS_PARSE" ||
        (f.tracks.length > 0 && f.tracks.every((t) => t.errorKind === "PGS_PARSE")),
    );
    if (allParseErrors) return EXIT.PGS_PARSE_ERROR;
    return EXIT.UNSUPPORTED_MEDIA;
  }

  if (failIfNeeded && run.files.some((f) => f.status === "NEEDS_FIX")) {
    return EXIT.NEEDS_FIX;
  }
  return EXIT.OK;
}

/** Run a scan and print its report. Returns the process exit code. */
export async function runScan(
  paths: readonly string[],
  raw: RawScanOptions,
  io: CliIo = defaultIo,
): Promise<number> {
  let args: ResolvedScanArgs;
  try {
    args = resolveScanArgs(raw);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.BAD_ARGS;
  }
  if (paths.length === 0) {
    io.stderr("no paths given; pass one or more files or directories\n");
    return EXIT.BAD_ARGS;
  }

  const log = createLogger(args.logLevel, (line) => io.stderr(`${line}\n`));
  const run = await scanPaths(paths, args.scan, { log });

  if (args.format === "json") {
    io.stdout(
      formatJsonReport(run, {
        aspect: args.scan.aspect,
        showEvents: args.showEvents,
        maxEvents: args.maxEvents,
        marginOverride: args.marginOverride,
      }),
    );
  } else {
    io.stdout(
      formatHumanReport(run, {
        showEvents: args.showEvents,
        maxEvents: args.maxEvents,
      }),
    );
  }

  return exitCodeFor(run, args.failIfNeeded);
}

/** Attach the `scan` subcommand to a commander program. */
export function registerScanCommand(program: Command, io: CliIo = defaultIo): Command {
  return program
    .command("scan")
    .description("analyze MKVs for PGS subtitles outside the active picture area")
    .argument("<paths...>", "MKV files or directories to scan")
    .option(
      "--aspect <ratio>",
      'picture aspect ratio (e.g. 2.39, 2.39:1, 16:9), or "auto" to detect it',
      "auto",
    )
    .option("-r, --recursive", "descend into subdirectories", false)
    .option("--jobs <n>", "files analyzed in parallel", "2")
    .option("--format <human|json>", "report format", "human")
    .option("--show-events", "list offending events", false)
    .option("--max-events <n>", "events listed per track", "10")
    .option("--margin <px>", "distance kept between a moved subtitle and the picture edge (default: 24 px at 1080)")
    .option("--tolerance <px>", "clustering tolerance for the sampled frames (auto aspect only)")
    .option("--samples <n>", "frames sampled for auto aspect detection", "24")
    .option("--source <direct|mkvextract>", "PGS reader: the direct block reader, or mkvextract into a temp .sup", "direct")
    .option(
      "--read-strategy <auto|minimal|adaptive|balanced|sequential>",
      "direct reader buffering: auto (the default) streams the whole file, which is fastest everywhere; adaptive/minimal transfer ~3% but take longer",
      "auto",
    )
    .option("--temp-dir <path>", "scratch directory for extracted .sup files")
    .option("--keep-temp", "keep extracted .sup files", false)
    .option(
      "--full",
      "read the PGS tracks even when the title has no letterbox bars (nothing can be outside a full frame, so they are skipped by default)",
      false,
    )
    .option(`--log-level <level>`, `one of ${LOG_LEVELS.join("|")}`, "info")
    .option("--fail-if-needed", "exit 1 when something needs fixing", false)
    .action(async (paths: string[], options: RawScanOptions) => {
      process.exitCode = await runScan(paths, options, io);
    });
}
