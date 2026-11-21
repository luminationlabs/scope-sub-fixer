/**
 * Fallback `PgsTrackSource`: shell out to `mkvextract` to write the track to a
 * temporary .sup, parse it, then delete the temporary file.
 *
 * `mkvextract ... tracks` only ever reads the source MKV, so this stays inside
 * the read-only contract of `scan` (PRD §11.2).
 */
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSupSegments } from "../pgs/parse.js";
import type { Segment } from "../pgs/types.js";
import { DependencyMissingError, spawnCapture } from "./inspect.js";
import { toolPath } from "../tools/locate.js";
import type { PgsTrackRef, PgsTrackSource } from "./pgsSource.js";

/** mkvextract ran but produced nothing usable. */
export class MkvExtractError extends Error {
  readonly file: string;
  readonly detail: string | undefined;
  constructor(message: string, file: string, detail?: string) {
    super(message);
    this.name = "MkvExtractError";
    this.file = file;
    this.detail = detail;
  }
}

export interface ExtractOptions {
  /** Scratch directory for the temporary .sup. Defaults to the OS temp dir. */
  tempDir?: string;
  /** Leave the extracted .sup behind (for debugging). */
  keepTemp?: boolean;
  /** Override the mkvextract executable. */
  mkvextractPath?: string;
  /** Called with the path of every temporary file created. */
  onTempFile?: (path: string) => void;
}

/**
 * Extract one PGS track to a temp .sup and return its parsed segments.
 * The temporary file is removed unless `keepTemp` is set.
 */
export async function extractPgsTrack(
  file: string,
  track: PgsTrackRef,
  options: ExtractOptions = {},
): Promise<Segment[]> {
  const exe = options.mkvextractPath ?? toolPath("mkvextract");
  const base = options.tempDir ?? tmpdir();
  if (options.tempDir) await mkdir(options.tempDir, { recursive: true });
  const dir = await mkdtemp(join(base, "scope-sub-"));
  const out = join(dir, `track-${track.id}.sup`);

  try {
    const result = await spawnCapture(exe, [file, "tracks", `${track.id}:${out}`]);
    options.onTempFile?.(out);
    if (result.code !== 0) {
      throw new MkvExtractError(
        `mkvextract failed on track ${track.id} (mkvmerge track id) of ${file}`,
        file,
        result.stderr.trim() || result.stdout.trim(),
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await readFile(out);
    } catch {
      throw new MkvExtractError(
        `mkvextract wrote no output for track ${track.id} (mkvmerge track id)`,
        file,
        result.stdout.trim(),
      );
    }
    return parseSupSegments(bytes);
  } finally {
    if (!options.keepTemp) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Build a `PgsTrackSource` bound to a set of extraction options. */
export function createMkvextractSource(options: ExtractOptions = {}): PgsTrackSource {
  return (file, track) => extractPgsTrack(file, track, options);
}

/** The default mkvextract-backed source. */
export const extractPgsTrackWithMkvextract: PgsTrackSource =
  createMkvextractSource();

export { DependencyMissingError };
