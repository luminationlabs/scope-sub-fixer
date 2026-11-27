/**
 * `scope-sub verify` — compare an original MKV against its repaired copy.
 *
 * Read-only on both files. Exit 0 on PASS, 7 on FAIL (PRD §20).
 */
import { Command } from "commander";
import { verifyFile, type VerifyOptions } from "../verify/index.js";
import type { VerifyReport } from "../verify/types.js";
import { DependencyMissingError } from "../mkv/inspect.js";
import { createLogger, isLogLevel, LOG_LEVELS, type LogLevel } from "../scan/log.js";
import { TOOL_NAME, TOOL_VERSION } from "../report/version.js";
import { ArgumentError, parseAspect, parseIntOption, type CliIo } from "./scan.js";

export const VERIFY_EXIT = {
  PASS: 0,
  BAD_ARGS: 2,
  DEPENDENCY_MISSING: 3,
  FAIL: 7,
} as const;

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export interface RawVerifyOptions {
  aspect?: string;
  margin?: string;
  samples?: string;
  tolerance?: string;
  hashStreams?: boolean;
  expectTracks?: string;
  tempDir?: string;
  format?: string;
  logLevel?: string;
}

export function resolveVerifyArgs(raw: RawVerifyOptions): {
  options: VerifyOptions;
  format: "human" | "json";
  logLevel: LogLevel;
} {
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
  let expectTracks: number[] | undefined;
  if (raw.expectTracks !== undefined) {
    expectTracks = [];
    for (const part of raw.expectTracks.split(",")) {
      const text = part.trim();
      if (text === "") continue;
      const n = Number(text);
      if (!Number.isInteger(n) || n < 0) {
        throw new ArgumentError(`invalid --expect-tracks "${part}"`);
      }
      expectTracks.push(n);
    }
  }
  const margin = parseIntOption(raw.margin, "--margin");
  const samples = parseIntOption(raw.samples, "--samples", { min: 1 });
  const tolerance = parseIntOption(raw.tolerance, "--tolerance");

  const options: VerifyOptions = {
    aspect: parseAspect(raw.aspect ?? "auto"),
    ...(raw.hashStreams === undefined ? {} : { hashStreams: raw.hashStreams }),
    ...(expectTracks === undefined ? {} : { expectTracks }),
    ...(margin === undefined ? {} : { margin }),
    ...(samples === undefined ? {} : { samples }),
    ...(tolerance === undefined ? {} : { tolerancePx: tolerance }),
    ...(raw.tempDir === undefined ? {} : { tempDir: raw.tempDir }),
  };
  return { options, format, logLevel };
}

export function formatVerifyReport(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push(report.pass ? "PASS" : "FAIL");
  lines.push(`  original: ${report.original} (${report.originalBytes} bytes)`);
  lines.push(`  fixed:    ${report.fixed} (${report.fixedBytes} bytes)`);
  for (const c of report.checks) {
    lines.push(`  ${c.pass ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
    for (const d of c.differences ?? []) lines.push(`         ${d}`);
  }
  if (report.payloadMode === "byte-identical") {
    lines.push(
      `  payload method: byte diff (${report.differingBytes} byte(s) in ${report.differingByteRanges} range(s))`,
    );
  } else if (report.payloadMode === "stream-hashes") {
    for (let i = 0; i < report.streamHashes.fixed.length; i++) {
      const f = report.streamHashes.fixed[i]!;
      const o = report.streamHashes.original[i];
      lines.push(
        `  ${f.type} track ${f.trackId} ${f.codecId}: ${f.sha256.slice(0, 16)}` +
          (o ? (o.sha256 === f.sha256 ? " (identical)" : " (DIFFERS)") : ""),
      );
    }
  }
  for (const t of report.pgsTracks) {
    if (t.changes.length === 0) continue;
    const sample = t.changes
      .slice(0, 3)
      .map((c) => `${c.ptsMs}ms obj ${c.objectId} (${c.dx}, ${c.dy})`)
      .join("; ");
    lines.push(`  pgs track ${t.fixedTrackId} moves: ${sample}${t.changes.length > 3 ? " ..." : ""}`);
  }
  lines.push(`  ${(report.elapsedMs / 1000).toFixed(1)}s`);
  return `${lines.join("\n")}\n`;
}

export function formatVerifyJson(report: VerifyReport): string {
  return `${JSON.stringify(
    { tool: TOOL_NAME, version: TOOL_VERSION, command: "verify", ...report },
    null,
    2,
  )}\n`;
}

export async function runVerify(
  original: string,
  fixed: string,
  raw: RawVerifyOptions,
  io: CliIo = defaultIo,
): Promise<number> {
  let resolved: ReturnType<typeof resolveVerifyArgs>;
  try {
    resolved = resolveVerifyArgs(raw);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return VERIFY_EXIT.BAD_ARGS;
  }

  const log = createLogger(resolved.logLevel, (line) => io.stderr(`${line}\n`));
  try {
    const report = await verifyFile(original, fixed, resolved.options, { log });
    io.stdout(
      resolved.format === "json" ? formatVerifyJson(report) : formatVerifyReport(report),
    );
    return report.pass ? VERIFY_EXIT.PASS : VERIFY_EXIT.FAIL;
  } catch (err) {
    if (err instanceof DependencyMissingError) {
      io.stderr(`${err.message}\n`);
      return VERIFY_EXIT.DEPENDENCY_MISSING;
    }
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return VERIFY_EXIT.FAIL;
  }
}

/** Attach the `verify` subcommand to a commander program. */
export function registerVerifyCommand(program: Command, io: CliIo = defaultIo): Command {
  return program
    .command("verify")
    .description("compare a fixed MKV with its original")
    .argument("<original>", "the original MKV")
    .argument("<fixed>", "the fixed MKV")
    .option(
      "--aspect <ratio>",
      'picture aspect ratio used to verify, or "auto" to detect it',
      "auto",
    )
    .option("--margin <px>", "distance kept between a moved subtitle and the picture edge")
    .option("--tolerance <px>", "clustering tolerance for the sampled frames (auto aspect only)")
    .option("--samples <n>", "frames sampled for auto aspect detection", "24")
    .option(
      "--hash-streams",
      "extract and SHA-256 every untouched elementary stream (default when the file sizes differ)",
    )
    .option("--no-hash-streams", "never extract and hash elementary streams")
    .option("--expect-tracks <ids>", "mkvmerge track ids in the fixed file that must have moved")
    .option("--temp-dir <path>", "scratch directory for extracted streams")
    .option("--format <human|json>", "report format", "human")
    .option(`--log-level <level>`, `one of ${LOG_LEVELS.join("|")}`, "info")
    .action(async (original: string, fixed: string, options: RawVerifyOptions) => {
      process.exitCode = await runVerify(original, fixed, options, io);
    });
}
