/**
 * `scope-sub doctor` — is this machine able to run the other six commands?
 *
 * Everything it reports is a precondition some later command silently depends
 * on: the Node version, the three external binaries (found through
 * `src/tools/locate.ts`, so it reports the very binary a real run would spawn),
 * that this ffmpeg can decode a frame the way `--aspect auto` measures one, and
 * a writable scratch directory with room in it. Read-only: it starts each tool
 * with a version flag, has ffmpeg decode one synthetic frame, and writes one
 * probe file into the temp directory.
 *
 * Exit 0 when everything checks out, 3 when anything required is missing
 * (PRD §20's dependency code).
 */
import { mkdtemp, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { spawnCapture, type SpawnResult } from "../mkv/inspect.js";
import { TOOL_NAME, TOOL_VERSION } from "../report/version.js";
import {
  locateTool,
  TOOL_NAMES,
  type ToolEnv,
  type ToolName,
  type ToolOrigin,
} from "../tools/locate.js";
import { ArgumentError, type CliIo } from "./scan.js";

export const DOCTOR_EXIT = {
  OK: 0,
  BAD_ARGS: 2,
  DEPENDENCY_MISSING: 3,
} as const;

/**
 * Lowest Node release the tool runs on: 22.12, which is what the one runtime
 * dependency (commander 15) needs. Kept in step with `package.json`
 * `engines.node` by `test/cli/doctor.test.ts`.
 */
export const REQUIRED_NODE_MAJOR = 22;
export const REQUIRED_NODE_MINOR = 12;
export const REQUIRED_NODE = `${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}`;

/** The flag each tool is asked for its version with. */
const VERSION_ARGS: Record<ToolName, string[]> = {
  mkvmerge: ["--version"],
  mkvextract: ["--version"],
  ffmpeg: ["-version"],
};

export interface ToolCheck {
  tool: ToolName;
  found: boolean;
  /** The executable a real run would spawn, when one was found. */
  path: string | undefined;
  origin: ToolOrigin | undefined;
  /** First line of the tool's version output, trimmed. */
  version: string | undefined;
  error: string | undefined;
}

export interface DoctorReport {
  tool: { name: string; version: string };
  ok: boolean;
  node: { version: string; major: number; requiredMajor: number; required: string; ok: boolean };
  tools: ToolCheck[];
  /** ffmpeg decoded a test frame as the picture measurement asks for one. */
  frames: { ok: boolean; detail: string };
  tempDir: {
    path: string;
    writable: boolean;
    freeBytes: number | undefined;
    totalBytes: number | undefined;
    error: string | undefined;
  };
}

/** Runs one external program. Injectable so the tests never spawn anything. */
export type ToolRunner = (exe: string, args: string[]) => Promise<SpawnResult>;

const defaultRunner: ToolRunner = (exe, args) =>
  spawnCapture(exe, args, { maxStdout: 1 << 20 });

export interface DoctorOptions {
  env?: ToolEnv;
  run?: ToolRunner;
  /** Scratch directory to probe. Defaults to the OS temp directory. */
  tempDir?: string;
  nodeVersion?: string;
}

/** `mkvmerge v92.0 ('Everglow') 64-bit` / `ffmpeg version 7.1 Copyright …`. */
export function parseVersionLine(output: string): string | undefined {
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (line === undefined) return undefined;
  // ffmpeg appends its copyright banner to the same line.
  return line.split(" Copyright ")[0]!.trim();
}

/** Size of the synthetic test frame: small, and not square, so a swap shows. */
const TEST_FRAME_W = 64;
const TEST_FRAME_H = 36;
/** One 16-bit grey frame of that size, which is what the sampler expects. */
export const TEST_FRAME_BYTES = TEST_FRAME_W * TEST_FRAME_H * 2;

/**
 * The frame sampler's command (`frameArgs` in `src/video/activeArea.ts`), with
 * a generated grey picture from ffmpeg's `lavfi` input in place of a film:
 * the same input options, the same `format=gray16le` → `rawvideo` output.
 */
export const TEST_FRAME_ARGS: readonly string[] = [
  "-nostdin",
  "-hide_banner",
  "-loglevel",
  "error",
  "-ss",
  "0",
  "-color_range",
  "tv",
  "-noautorotate",
  "-f",
  "lavfi",
  "-i",
  `color=c=gray:s=${TEST_FRAME_W}x${TEST_FRAME_H}:d=1`,
  "-map",
  "0:v:0",
  "-frames:v",
  "1",
  "-vf",
  "format=gray16le",
  "-f",
  "rawvideo",
  "-",
];

export function parseNodeMajor(version: string): number {
  const m = /^v?(\d+)\./.exec(version.trim());
  return m ? Number(m[1]) : 0;
}

/** Whether a `process.version` string is at or above the required release. */
export function nodeVersionOk(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]);
  return major > REQUIRED_NODE_MAJOR || (major === REQUIRED_NODE_MAJOR && Number(m[2]) >= REQUIRED_NODE_MINOR);
}

async function checkTool(
  tool: ToolName,
  env: ToolEnv,
  run: ToolRunner,
): Promise<ToolCheck> {
  const located = locateTool(tool, env);
  if (located === undefined) {
    return {
      tool,
      found: false,
      path: undefined,
      origin: undefined,
      version: undefined,
      error: "not found on PATH or in any of the extra search directories",
    };
  }
  try {
    const r = await run(located.path, VERSION_ARGS[tool]);
    const version = parseVersionLine(`${r.stdout}\n${r.stderr}`);
    return {
      tool,
      found: true,
      path: located.path,
      origin: located.origin,
      version,
      error:
        r.code === 0
          ? undefined
          : `${tool} ${VERSION_ARGS[tool].join(" ")} exited ${r.code}`,
    };
  } catch (err) {
    return {
      tool,
      found: false,
      path: located.path,
      origin: located.origin,
      version: undefined,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkFrames(
  ffmpeg: ToolCheck,
  run: ToolRunner,
): Promise<{ ok: boolean; detail: string }> {
  if (!ffmpeg.found || ffmpeg.path === undefined) {
    return { ok: false, detail: "ffmpeg not available" };
  }
  const failed = (reason: string) => ({
    ok: false,
    detail: `this ffmpeg could not decode a test frame: ${reason}`,
  });
  try {
    const r = await run(ffmpeg.path, [...TEST_FRAME_ARGS]);
    const bytes = r.stdoutBytes ?? Buffer.byteLength(r.stdout);
    if (r.code === 0 && bytes === TEST_FRAME_BYTES) {
      return { ok: true, detail: "decodes a frame for measuring" };
    }
    const said = r.stderr.trim().split("\n").at(-1) ?? "";
    if (said !== "") return failed(said);
    if (r.code !== 0) return failed(`exit ${r.code}`);
    return failed(`${bytes} bytes, not ${TEST_FRAME_BYTES}`);
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

async function checkTempDir(path: string): Promise<DoctorReport["tempDir"]> {
  let writable = false;
  let error: string | undefined;
  try {
    const dir = await mkdtemp(join(path, "scope-sub-doctor-"));
    try {
      await writeFile(join(dir, "probe"), "scope-sub");
      writable = true;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  let freeBytes: number | undefined;
  let totalBytes: number | undefined;
  try {
    const fs = await statfs(path);
    freeBytes = Number(fs.bavail) * Number(fs.bsize);
    totalBytes = Number(fs.blocks) * Number(fs.bsize);
  } catch {
    // statfs is unavailable on some platforms; the space line is then omitted.
  }

  return { path, writable, freeBytes, totalBytes, error };
}

/** Run every check. Never throws: every failure lands in the report. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const run = options.run ?? defaultRunner;
  const nodeVersion = options.nodeVersion ?? process.version;
  const major = parseNodeMajor(nodeVersion);

  const tools: ToolCheck[] = [];
  for (const tool of TOOL_NAMES) tools.push(await checkTool(tool, env, run));
  const ffmpeg = tools.find((t) => t.tool === "ffmpeg")!;
  const frames = await checkFrames(ffmpeg, run);
  const tempDir = await checkTempDir(options.tempDir ?? tmpdir());

  const nodeOk = nodeVersionOk(nodeVersion);
  const ok =
    nodeOk &&
    tools.every((t) => t.found && t.error === undefined) &&
    frames.ok &&
    tempDir.writable;

  return {
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    ok,
    node: { version: nodeVersion, major, requiredMajor: REQUIRED_NODE_MAJOR, required: REQUIRED_NODE, ok: nodeOk },
    tools,
    frames,
    tempDir,
  };
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function line(status: boolean, label: string, detail: string): string {
  return `${status ? "ok  " : "FAIL"}  ${label.padEnd(12)}${detail}`;
}

export function formatDoctorReport(report: DoctorReport): string {
  const out: string[] = [`${report.tool.name} ${report.tool.version} — environment check`, ""];

  out.push(
    line(
      report.node.ok,
      "node",
      `${report.node.version} (requires >= ${report.node.required})`,
    ),
  );

  for (const t of report.tools) {
    const detail = t.found
      ? `${t.version ?? "version unknown"}\n${" ".repeat(18)}${t.path}${t.origin === "path" ? "" : ` (via ${t.origin === "env" ? "environment override" : "extra search path"})`}`
      : (t.error ?? "not found");
    out.push(line(t.found && t.error === undefined, t.tool, detail));
  }

  out.push(line(report.frames.ok, "frames", report.frames.detail));

  const temp = report.tempDir;
  const space =
    temp.freeBytes === undefined || temp.totalBytes === undefined
      ? "free space unknown"
      : `${gib(temp.freeBytes)} free of ${gib(temp.totalBytes)}`;
  out.push(
    line(
      temp.writable,
      "temp dir",
      temp.writable ? `${temp.path} — ${space}` : `${temp.path} — ${temp.error ?? "not writable"}`,
    ),
  );

  out.push("");
  out.push(
    report.ok
      ? "All checks passed."
      : "A required component is missing or not working; see the FAIL lines above.",
  );
  out.push("");
  return out.join("\n");
}

export function formatDoctorJson(report: DoctorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export interface RawDoctorOptions {
  format?: string;
  tempDir?: string;
}

export async function runDoctorCommand(
  raw: RawDoctorOptions,
  io: CliIo = defaultIo,
  options: DoctorOptions = {},
): Promise<number> {
  const format = raw.format ?? "human";
  if (format !== "human" && format !== "json") {
    io.stderr(
      `${new ArgumentError(`invalid --format "${format}" (expected human or json)`).message}\n`,
    );
    return DOCTOR_EXIT.BAD_ARGS;
  }

  const report = await runDoctor({
    ...options,
    ...(raw.tempDir === undefined ? {} : { tempDir: raw.tempDir }),
  });
  io.stdout(format === "json" ? formatDoctorJson(report) : formatDoctorReport(report));
  return report.ok ? DOCTOR_EXIT.OK : DOCTOR_EXIT.DEPENDENCY_MISSING;
}

/** Attach the `doctor` subcommand to a commander program. */
export function registerDoctorCommand(program: Command, io: CliIo = defaultIo): Command {
  return program
    .command("doctor")
    .description("check Node, mkvmerge, mkvextract, ffmpeg and the scratch directory")
    .option("--format <human|json>", "report format", "human")
    .option("--temp-dir <path>", "scratch directory to probe instead of the OS temp dir")
    .action(async (options: RawDoctorOptions) => {
      process.exitCode = await runDoctorCommand(options, io);
    });
}
