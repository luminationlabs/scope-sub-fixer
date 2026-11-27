/**
 * The `--method remux` path (PRD §12.3 Prototype B): extract, transform, remux.
 *
 * mkvmerge copies the title, chapters, attachments, tags and every untouched
 * track from the source, so all this has to get right is the subtitle track
 * set, the flags on the corrected track, and the track order.
 *
 * `buildRemuxArgs` is a pure function so the argv can be unit-tested; nothing
 * in it touches the filesystem.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnCapture } from "../mkv/inspect.js";
import { toolPath } from "../tools/locate.js";

/** Suffix appended to the corrected track's name in `--keep-original-subtitle` mode. */
export const SCOPE_FIXED_SUFFIX = "[scope-fixed]";

/**
 * mkvmerge's track types. "other" covers buttons and anything a future
 * MKVToolNix reports that mkvmerge will not mux into the output — such a track
 * must not appear in `--track-order`, which may only name tracks that are
 * actually being copied.
 */
export type SourceTrackType = "video" | "audio" | "subtitles" | "other";

const MUXED_TYPES: ReadonlySet<SourceTrackType> = new Set<SourceTrackType>([
  "video",
  "audio",
  "subtitles",
]);

export interface SourceTrackRef {
  /** mkvmerge track id. */
  id: number;
  type: SourceTrackType;
}

export interface CorrectedTrackSpec {
  /** mkvmerge id of the track in the SOURCE this .sup replaces or shadows. */
  sourceTrackId: number;
  supPath: string;
  language: string;
  name: string | undefined;
  default: boolean;
  forced: boolean;
  hearingImpaired: boolean;
}

export interface RemuxArgsOptions {
  input: string;
  output: string;
  /** Every track in the source, in container order. */
  sourceTracks: readonly SourceTrackRef[];
  corrected: readonly CorrectedTrackSpec[];
  /** PRD §31: keep the originals and append the corrected tracks instead. */
  keepOriginal: boolean;
}

function bool(value: boolean): string {
  return value ? "1" : "0";
}

/**
 * Build the mkvmerge command line.
 *
 * Replace mode drops only the subtitle tracks being corrected (`-s` lists the
 * survivors, `-S` when there are none) and re-inserts each corrected track at
 * its original position via `--track-order`. Keep-original mode copies every
 * source track untouched and appends the corrected ones, non-default, with a
 * `[scope-fixed]` name so they are obvious in a player's track menu.
 *
 * `--track-order` lists only video, audio and subtitle tracks: naming a track
 * mkvmerge is not muxing (a button track, say) makes it refuse the whole
 * command line.
 */
export function buildRemuxArgs(options: RemuxArgsOptions): string[] {
  const { input, output, sourceTracks, corrected, keepOriginal } = options;
  const correctedBySource = new Map(corrected.map((c) => [c.sourceTrackId, c]));
  const subtitleIds = sourceTracks.filter((t) => t.type === "subtitles").map((t) => t.id);

  const args = ["--output", output];

  if (!keepOriginal) {
    const kept = subtitleIds.filter((id) => !correctedBySource.has(id));
    if (kept.length === 0) args.push("--no-subtitles");
    else args.push("--subtitle-tracks", kept.join(","));
  }
  args.push(input);

  // Each corrected .sup becomes its own input file, carrying exactly one track
  // with mkvmerge id 0.
  corrected.forEach((c) => {
    const name = keepOriginal
      ? `${c.name ?? c.language} ${SCOPE_FIXED_SUFFIX}`
      : c.name;
    args.push("--language", `0:${c.language}`);
    if (name !== undefined) args.push("--track-name", `0:${name}`);
    args.push("--default-track-flag", `0:${bool(keepOriginal ? false : c.default)}`);
    args.push("--forced-display-flag", `0:${bool(c.forced)}`);
    args.push("--hearing-impaired-flag", `0:${bool(c.hearingImpaired)}`);
    // Keep the output PGS byte-addressable so it can be patched and verified.
    args.push("--compression", "0:none");
    args.push(c.supPath);
  });

  // File 0 is the source; corrected .sup files are 1..n in the order above.
  const fileIdBySource = new Map<number, number>();
  corrected.forEach((c, i) => fileIdBySource.set(c.sourceTrackId, i + 1));

  const order: string[] = [];
  for (const t of sourceTracks) {
    if (!MUXED_TYPES.has(t.type)) continue;
    const fileId = fileIdBySource.get(t.id);
    if (fileId !== undefined && !keepOriginal) order.push(`${fileId}:0`);
    else order.push(`0:${t.id}`);
  }
  if (keepOriginal) {
    for (const c of corrected) order.push(`${fileIdBySource.get(c.sourceTrackId)!}:0`);
  }
  args.push("--track-order", order.join(","));

  return args;
}

/** mkvmerge or mkvextract exited with an error. Maps onto exit code 6. */
export class RemuxError extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = "RemuxError";
  }
}

/** Extract one track to `outPath` with mkvextract. */
export async function extractTrackToFile(
  input: string,
  trackId: number,
  outPath: string,
  exe = toolPath("mkvextract"),
  signal?: AbortSignal,
): Promise<string> {
  const r = await spawnCapture(
    exe,
    [input, "tracks", `${trackId}:${outPath}`],
    signal === undefined ? {} : { signal },
  );
  if (r.code !== 0) {
    throw new RemuxError(
      `mkvextract failed on track ${trackId} of ${input}`,
      r.stderr.trim() || r.stdout.trim(),
    );
  }
  return outPath;
}

export async function runMkvmerge(
  args: string[],
  exe = toolPath("mkvmerge"),
  signal?: AbortSignal,
): Promise<string> {
  const r = await spawnCapture(exe, args, signal === undefined ? {} : { signal });
  // mkvmerge exits 1 for warnings, which are routine (e.g. no cues for subs).
  if (r.code > 1) {
    throw new RemuxError(
      `mkvmerge failed (exit ${r.code})`,
      r.stderr.trim() || r.stdout.trim(),
    );
  }
  return r.stdout;
}

export async function writeSupFile(path: string, bytes: Uint8Array): Promise<string> {
  await writeFile(path, bytes);
  return path;
}

/**
 * A scratch directory for the corrected .sup files. Always outside the source
 * directory (PRD §12.5); removed unless `keep` is set.
 */
export async function makeTempDir(base?: string): Promise<string> {
  const root = base === undefined ? tmpdir() : resolve(base);
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, "scope-sub-fix-"));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
