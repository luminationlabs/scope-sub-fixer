/**
 * Helpers for every test that needs a real MKV: build tiny ones from lavfi
 * video plus a synthetic .sup, entirely inside a temp directory, and ask
 * mkvmerge what ended up in them.
 *
 * Nothing here ever touches real media, and every helper is async — the tests
 * that use them are async anyway, and one shape beats two.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSup, type SupSpec } from "../../src/pgs/fixtures.js";
import { buildDisplaySets, buildEpochs, resolveEvents } from "../../src/pgs/compose.js";
import { parseSupSegments } from "../../src/pgs/parse.js";
import type { PgsEvent } from "../../src/pgs/types.js";
import { isToolName, toolPath } from "../../src/tools/locate.js";

/** Build a .sup from a spec and resolve it the way the scanner does. */
export function eventsFromSpec(spec: SupSpec): {
  events: PgsEvent[];
  epochIds: number[];
} {
  const displaySets = buildDisplaySets(parseSupSegments(buildSup(spec)));
  const epochByDisplaySet = new Map<number, number>();
  for (const epoch of buildEpochs(displaySets)) {
    for (const ds of epoch.displaySets) epochByDisplaySet.set(ds.index, epoch.index);
  }
  const events = resolveEvents(displaySets);
  return {
    events,
    epochIds: events.map((e) => epochByDisplaySet.get(e.displaySetIndex) ?? e.index),
  };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a program. The three tools resolve through `src/tools/locate.ts`, as in
 * a real run, so the fixtures use the very binary the code under test would
 * (and find `ffmpeg.exe` on Windows).
 */
export function run(command: string, args: string[]): Promise<RunResult> {
  const exe = isToolName(command) ? toolPath(command) : command;
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const toolCache = new Map<string, boolean>();

/**
 * True when the tool responds to a version query. Used to skip integration
 * tests. ffmpeg wants `-version`; MKVToolNix wants `--version`.
 */
export async function hasTool(tool: string): Promise<boolean> {
  const cached = toolCache.get(tool);
  if (cached !== undefined) return cached;
  let ok = false;
  for (const flag of ["--version", "-version"]) {
    try {
      const r = await run(tool, [flag]);
      if (r.code === 0) {
        ok = true;
        break;
      }
    } catch {
      break;
    }
  }
  toolCache.set(tool, ok);
  return ok;
}

export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "scope-sub-test-"));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export interface LetterboxVideoSpec {
  width?: number;
  height?: number;
  /** Height of the picture inside the frame; the rest becomes black bars. */
  activeHeight?: number;
  seconds?: number;
  fps?: number;
  /** Pixel format; `yuv420p10le` makes a 10-bit clip, as UHD discs are. */
  pixFmt?: string;
}

function padFilter(spec: Required<LetterboxVideoSpec>): string {
  const top = Math.floor((spec.height - spec.activeHeight) / 2);
  return `pad=${spec.width}:${spec.height}:0:${top}`;
}

function fill(spec: LetterboxVideoSpec): Required<LetterboxVideoSpec> {
  return {
    width: spec.width ?? 1920,
    height: spec.height ?? 1080,
    activeHeight: spec.activeHeight ?? 804,
    seconds: spec.seconds ?? 6,
    fps: spec.fps ?? 24,
    pixFmt: spec.pixFmt ?? "yuv420p",
  };
}

/** A grey picture padded into black letterbox bars, encoded H.264 ultrafast. */
export async function makeLetterboxVideo(
  path: string,
  spec: LetterboxVideoSpec = {},
): Promise<string> {
  const s = fill(spec);
  const r = await run("ffmpeg", [
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x808080:s=${s.width}x${s.activeHeight}:d=${s.seconds}:r=${s.fps}`,
    "-vf",
    padFilter(s),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    s.pixFmt,
    path,
  ]);
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return path;
}

/** Two differently letterboxed halves concatenated, i.e. a mixed-aspect title. */
export async function makeMixedAspectVideo(
  path: string,
  first: LetterboxVideoSpec,
  second: LetterboxVideoSpec,
): Promise<string> {
  const a = fill(first);
  const b = fill(second);
  const r = await run("ffmpeg", [
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x808080:s=${a.width}x${a.activeHeight}:d=${a.seconds}:r=${a.fps}`,
    "-f",
    "lavfi",
    "-i",
    `color=c=0x808080:s=${b.width}x${b.activeHeight}:d=${b.seconds}:r=${b.fps}`,
    "-filter_complex",
    `[0:v]${padFilter(a)}[a];[1:v]${padFilter(b)}[b];[a][b]concat=n=2:v=1:a=0[v]`,
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return path;
}

export async function writeSup(path: string, spec: SupSpec): Promise<string> {
  await writeFile(path, buildSup(spec));
  return path;
}

export interface MuxOptions {
  language?: string;
  trackName?: string;
  /**
   * Matroska content compression for the .sup track. mkvmerge's own default is
   * "zlib"; the fixtures use "none" because the absolute-offset contract the
   * patch method relies on only holds for uncompressed tracks.
   */
  compression?: "none" | "zlib";
  default?: boolean;
  forced?: boolean;
  hearingImpaired?: boolean;
  /** Extra input files appended verbatim (e.g. an .srt). */
  extraInputs?: string[];
  /** Extra mkvmerge arguments appended before the inputs (e.g. --title). */
  globalArgs?: string[];
}

/** Mux a video file and an optional .sup into one MKV with mkvmerge. */
export async function makeMkv(
  outPath: string,
  videoPath: string,
  supPath: string | null,
  options: MuxOptions = {},
): Promise<string> {
  const args = ["-q", "-o", outPath, ...(options.globalArgs ?? []), videoPath];
  if (supPath) {
    args.push(
      "--language",
      `0:${options.language ?? "eng"}`,
      "--track-name",
      `0:${options.trackName ?? "English"}`,
      "--compression",
      `0:${options.compression ?? "none"}`,
      "--default-track-flag",
      `0:${options.default === false ? 0 : 1}`,
      "--forced-display-flag",
      `0:${options.forced ? 1 : 0}`,
      "--hearing-impaired-flag",
      `0:${options.hearingImpaired ? 1 : 0}`,
      supPath,
    );
  }
  args.push(...(options.extraInputs ?? []));
  const r = await run("mkvmerge", args);
  // mkvmerge exits 1 for warnings, which are harmless here.
  if (r.code > 1) throw new Error(`mkvmerge failed: ${r.stdout}\n${r.stderr}`);
  return outPath;
}

export async function writeSrt(path: string): Promise<string> {
  await writeFile(path, "1\n00:00:01,000 --> 00:00:02,000\nhello\n\n", "utf8");
  return path;
}

// --- whole-file fixtures (video + audio + PGS), for the Matroska reader ------

export interface MkvFixtureSub {
  /** Raw .sup bytes, e.g. from `buildSup()`. */
  sup: Uint8Array;
  /** ISO 639-2 code handed to `mkvmerge --language`. Defaults to "eng". */
  language?: string;
}

export interface MkvFixtureSpec {
  width: number;
  height: number;
  durationSec: number;
  /** The first PGS track. */
  supBytes?: Uint8Array;
  /** Further PGS tracks, appended after the first. */
  extraSubs?: MkvFixtureSub[];
  /**
   * "color" (default) gives a black frame that compresses to nothing;
   * "testsrc2" gives noisy frames so the video blocks are big enough to make
   * the read-savings measurable.
   */
  video?: "color" | "testsrc2";
  /** Frame rate of the generated video. Defaults to 25. */
  fps?: number;
  /** x264 `-crf`. Lower means bigger blocks. Defaults to 23 (0 for testsrc2). */
  crf?: number;
  /**
   * Matroska content compression for the subtitle tracks. mkvmerge's own
   * default is "zlib"; the fixtures default to "none" because the absolute
   * offset contract only holds for uncompressed tracks.
   */
  compression?: "none" | "zlib";
  /** File name inside `dir`. Defaults to "fixture.mkv". */
  name?: string;
}

export interface MkvIdentifiedTrack {
  /** mkvmerge's 0-based track id (what `mkvextract tracks` takes). */
  id: number;
  /** The Matroska TrackNumber (what `readPgsBlocks` takes). */
  number: number;
  type: string;
  codecId: string;
  language: string;
}

/**
 * Generate an MKV with a real video track, a real audio track and one PGS
 * track per .sup, and return its path. The structure is exactly what the reader
 * meets in the wild (SimpleBlocks, lacing on the audio, SeekHead/Cues/Tags
 * around the clusters) without shipping any disc material.
 */
export async function buildTestMkv(
  dir: string,
  spec: MkvFixtureSpec,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const fps = spec.fps ?? 25;
  const source = spec.video ?? "color";
  const crf = spec.crf ?? (source === "testsrc2" ? 0 : 23);
  const size = `${spec.width}x${spec.height}`;
  const videoInput =
    source === "testsrc2"
      ? `testsrc2=s=${size}:r=${fps}:d=${spec.durationSec}`
      : `color=c=black:s=${size}:r=${fps}:d=${spec.durationSec}`;

  const avPath = join(dir, "av.mkv");
  const encoded = await run("ffmpeg", [
    "-nostdin",
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    videoInput,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo",
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    avPath,
  ]);
  if (encoded.code !== 0) throw new Error(`ffmpeg failed: ${encoded.stderr}`);

  const subs: MkvFixtureSub[] = [];
  if (spec.supBytes) subs.push({ sup: spec.supBytes, language: "eng" });
  for (const extra of spec.extraSubs ?? []) subs.push(extra);

  const outPath = join(dir, spec.name ?? "fixture.mkv");
  const args = ["-o", outPath, "--quiet", avPath];
  const compression = spec.compression ?? "none";
  for (const [i, sub] of subs.entries()) {
    const supPath = join(dir, `sub${i}.sup`);
    await writeFile(supPath, sub.sup);
    args.push(
      "--language",
      `0:${sub.language ?? "eng"}`,
      "--compression",
      `0:${compression}`,
      supPath,
    );
  }
  const muxed = await run("mkvmerge", args);
  // mkvmerge exits 1 for warnings, which are harmless here.
  if (muxed.code > 1) throw new Error(`mkvmerge failed: ${muxed.stdout}\n${muxed.stderr}`);
  return outPath;
}

/** `mkvmerge -J` track list, with the Matroska track numbers. */
export async function identifyMkv(path: string): Promise<MkvIdentifiedTrack[]> {
  const r = await run("mkvmerge", ["-J", path]);
  if (r.code > 1) throw new Error(`mkvmerge -J failed: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout) as {
    tracks: Array<{
      id: number;
      type: string;
      properties: { number: number; codec_id: string; language?: string };
    }>;
  };
  return parsed.tracks.map((t) => ({
    id: t.id,
    number: t.properties.number,
    type: t.type,
    codecId: t.properties.codec_id,
    language: t.properties.language ?? "und",
  }));
}

/** Run `mkvextract tracks` for one track id and return the written path. */
export async function extractTrack(
  path: string,
  trackId: number,
  outPath: string,
): Promise<string> {
  const r = await run("mkvextract", ["tracks", path, `${trackId}:${outPath}`]);
  if (r.code > 1) throw new Error(`mkvextract failed: ${r.stderr}`);
  return outPath;
}
