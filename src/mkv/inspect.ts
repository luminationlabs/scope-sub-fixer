/**
 * Read-only MKV inspection via `mkvmerge -J`.
 *
 * Two different track identifiers matter and are never conflated here:
 *   - `id`     the mkvmerge track id, used on mkvmerge/mkvextract command lines;
 *   - `number` the Matroska TrackNumber, used inside the container's blocks.
 * Both are carried through to every report.
 *
 * This module also owns the small `spawn` helper and the `DependencyMissingError`
 * used by the other external-tool wrappers (mkvextract, ffmpeg).
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { toolPath } from "../tools/locate.js";

/** A required external program is not installed or not on PATH. */
export class DependencyMissingError extends Error {
  readonly tool: string;
  constructor(tool: string, message?: string) {
    super(message ?? `required dependency "${tool}" was not found on PATH`);
    this.name = "DependencyMissingError";
    this.tool = tool;
  }
}

/** mkvmerge ran but the file could not be identified. */
export class MkvInspectError extends Error {
  readonly file: string;
  readonly detail: string | undefined;
  constructor(message: string, file: string, detail?: string) {
    super(message);
    this.name = "MkvInspectError";
    this.file = file;
    this.detail = detail;
  }
}

export interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Bytes the child wrote to stdout, all of them, whatever `maxStdout` kept. */
  stdoutBytes?: number;
}

export interface SpawnOptions {
  /** Bytes of stdout to keep. Guards against a runaway child. */
  maxStdout?: number;
  cwd?: string;
  /**
   * Aborting it terminates the child; the promise then rejects with
   * `SpawnAbortedError` once the child has gone, so whatever the child was
   * writing is no longer being written when the caller cleans up.
   */
  signal?: AbortSignal;
}

/** The command was stopped through `SpawnOptions.signal`. */
export class SpawnAbortedError extends Error {
  constructor(command: string) {
    super("cancelled");
    this.name = "SpawnAbortedError";
    this.command = command;
  }
  readonly command: string;
}

/**
 * Run a command with no shell, capturing stdout/stderr as UTF-8.
 * A missing executable is reported as `DependencyMissingError` rather than a
 * raw ENOENT so callers can map it onto the documented exit code.
 */
export function spawnCapture(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted === true) {
      reject(new SpawnAbortedError(command));
      return;
    }
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Windows: no console window for each child of a windowless engine. Ignored elsewhere.
      windowsHide: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const onAbort = (): void => {
      // On Windows any signal name ends the child unconditionally (TerminateProcess).
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const max = options.maxStdout ?? 64 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    const decoder = new StringDecoder("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdout.length < max) stdout += decoder.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < max) stderr += chunk;
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      signal?.removeEventListener("abort", onAbort);
      if (err.code === "ENOENT") reject(new DependencyMissingError(command));
      else reject(err);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted === true) reject(new SpawnAbortedError(command));
      else {
        if (stdout.length < max) stdout += decoder.end();
        resolve({ code: code ?? -1, stdout, stderr, stdoutBytes });
      }
    });
  });
}

export interface MkvVideoTrack {
  /** mkvmerge track id (what mkvextract takes). */
  id: number;
  /** Matroska TrackNumber (what block headers carry). */
  number: number;
  codecId: string;
  /** Coded frame size from `pixel_dimensions`. */
  width: number;
  height: number;
  /** From `display_dimensions`, when present. */
  displayWidth: number | undefined;
  displayHeight: number | undefined;
}

export interface MkvSubtitleTrack {
  /** mkvmerge track id. */
  id: number;
  /** Matroska TrackNumber. */
  number: number;
  codecId: string;
  language: string;
  name: string | undefined;
  default: boolean;
  forced: boolean;
  hearingImpaired: boolean;
  /** True for `S_HDMV/PGS`. */
  isPgs: boolean;
}

/** Minimal per-track facts for every track in the file, in container order. */
export interface MkvTrackSummary {
  /** mkvmerge track id. */
  id: number;
  /** Matroska TrackNumber. */
  number: number;
  /** mkvmerge's track type: "video", "audio", "subtitles", "buttons". */
  type: string;
  codecId: string;
}

export interface MkvInfo {
  file: string;
  /** Container duration in milliseconds, when mkvmerge reports one. */
  durationMs: number | undefined;
  title: string | undefined;
  /**
   * The Segment UID (hex): assigned when the file is muxed and kept by
   * `mkvpropedit`, so it tells an edited header from a re-rip or a remux.
   */
  segmentUid?: string;
  video: MkvVideoTrack | undefined;
  subtitleTracks: MkvSubtitleTrack[];
  /**
   * Every track, not just the video and subtitle ones. `fix --method remux`
   * needs the full list to rebuild `--track-order`. Optional so hand-built
   * `MkvInfo` values in tests stay valid.
   */
  tracks?: MkvTrackSummary[];
}

export const PGS_CODEC_ID = "S_HDMV/PGS";

interface RawTrack {
  id?: unknown;
  type?: unknown;
  properties?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBool(value: unknown): boolean {
  return value === true || value === 1;
}

/** Parse an mkvmerge `WxH` dimension string. */
export function parseDimensions(
  value: unknown,
): { width: number; height: number } | undefined {
  const s = asString(value);
  if (!s) return undefined;
  const m = /^(\d+)x(\d+)$/.exec(s.trim());
  if (!m) return undefined;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** Turn the JSON produced by `mkvmerge -J` into an `MkvInfo`. */
export function parseMkvmergeJson(file: string, json: unknown): MkvInfo {
  const root = asRecord(json);
  const container = asRecord(root["container"]);
  const containerProps = asRecord(container["properties"]);
  // mkvmerge reports the container duration in nanoseconds.
  const durationNs = asNumber(containerProps["duration"]);

  const rawTracks = Array.isArray(root["tracks"])
    ? (root["tracks"] as RawTrack[])
    : [];

  let video: MkvVideoTrack | undefined;
  const subtitleTracks: MkvSubtitleTrack[] = [];
  const tracks: MkvTrackSummary[] = [];

  for (const track of rawTracks) {
    const props = asRecord(track.properties);
    const id = asNumber(track.id);
    if (id === undefined) continue;
    const number = asNumber(props["number"]) ?? id + 1;
    const codecId = asString(props["codec_id"]) ?? "";
    tracks.push({
      id,
      number,
      type: typeof track.type === "string" ? track.type : "unknown",
      codecId,
    });

    if (track.type === "video" && video === undefined) {
      const pixel = parseDimensions(props["pixel_dimensions"]);
      const display = parseDimensions(props["display_dimensions"]);
      video = {
        id,
        number,
        codecId,
        width: pixel?.width ?? 0,
        height: pixel?.height ?? 0,
        displayWidth: display?.width,
        displayHeight: display?.height,
      };
    } else if (track.type === "subtitles") {
      const language =
        asString(props["language"]) ?? asString(props["language_ietf"]) ?? "und";
      subtitleTracks.push({
        id,
        number,
        codecId,
        language,
        name: asString(props["track_name"]) ?? asString(props["name"]),
        default: asBool(props["default_track"]),
        forced: asBool(props["forced_track"]),
        hearingImpaired: asBool(props["flag_hearing_impaired"]),
        isPgs: codecId === PGS_CODEC_ID,
      });
    }
  }

  const segmentUid = asString(containerProps["segment_uid"]);
  return {
    file,
    durationMs: durationNs === undefined ? undefined : durationNs / 1e6,
    title: asString(containerProps["title"]),
    ...(segmentUid === undefined ? {} : { segmentUid }),
    video,
    subtitleTracks,
    tracks,
  };
}

export interface InspectOptions {
  /** Override the mkvmerge executable (tests, unusual installs). */
  mkvmergePath?: string;
}

/** Identify an MKV with `mkvmerge -J`. Never writes to the file. */
export async function inspectMkv(
  file: string,
  options: InspectOptions = {},
): Promise<MkvInfo> {
  const exe = options.mkvmergePath ?? toolPath("mkvmerge");
  const result = await spawnCapture(exe, ["-J", file]);

  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    throw new MkvInspectError(
      `mkvmerge produced no usable JSON for ${file}`,
      file,
      result.stderr.trim() || result.stdout.slice(0, 500),
    );
  }

  const root = asRecord(json);
  // mkvmerge exits 1 for warnings and 2 for real errors, but still emits JSON.
  if (result.code >= 2) {
    const errors = Array.isArray(root["errors"]) ? root["errors"] : [];
    throw new MkvInspectError(
      `mkvmerge failed to identify ${file}`,
      file,
      errors.map(String).join("; ") || result.stderr.trim(),
    );
  }
  const container = asRecord(root["container"]);
  if (container["recognized"] === false || container["supported"] === false) {
    throw new MkvInspectError(
      `${file} is not a container mkvmerge can read`,
      file,
      asString(asRecord(container["properties"])["container_type"]),
    );
  }

  return parseMkvmergeJson(file, json);
}
