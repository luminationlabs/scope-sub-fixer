/**
 * Payload comparison.
 *
 * Two shapes, chosen by whether the repair changed the file size:
 *
 *   same size    stream both files in parallel and record every differing byte
 *                range. A `--method patch` output must differ ONLY inside PGS
 *                position fields, and this is what proves it — no extraction,
 *                no hashing, one sequential pass over each file.
 *
 *   different    (a remux) there is no byte correspondence, so each elementary
 *                stream is extracted with mkvextract and hashed. Slow on a
 *                17 GB source, hence opt-in.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawnCapture } from "../mkv/inspect.js";
import { toolPath } from "../tools/locate.js";
import type { StreamHash } from "./types.js";

export interface ByteRange {
  start: number;
  /** Exclusive. */
  end: number;
}

export interface ByteDiffResult {
  ranges: ByteRange[];
  differingBytes: number;
  /** True when the range list was capped and is therefore incomplete. */
  truncated: boolean;
}

const CHUNK = 8 * 1024 * 1024;
const MAX_RANGES = 500_000;

async function readExactly(
  fh: Awaited<ReturnType<typeof open>>,
  buf: Buffer,
  position: number,
  length: number,
): Promise<number> {
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return done;
}

/**
 * Byte ranges in which two equal-length files differ. Coalesces adjacent bytes
 * so a rewritten u16 pair shows up as one range.
 */
export async function diffFiles(
  a: string,
  b: string,
  onProgress?: (bytesDone: number, total: number) => void,
): Promise<ByteDiffResult> {
  const size = (await stat(a)).size;
  const bufA = Buffer.allocUnsafe(CHUNK);
  const bufB = Buffer.allocUnsafe(CHUNK);
  const ranges: ByteRange[] = [];
  let differingBytes = 0;
  let truncated = false;

  const fa = await open(a, "r");
  const fb = await open(b, "r");
  try {
    let position = 0;
    while (position < size) {
      const want = Math.min(CHUNK, size - position);
      const gotA = await readExactly(fa, bufA, position, want);
      const gotB = await readExactly(fb, bufB, position, want);
      const n = Math.min(gotA, gotB);
      if (n === 0) break;
      // Buffer.compare on the whole chunk first: identical chunks are the
      // overwhelming majority and this makes them almost free.
      if (bufA.compare(bufB, 0, n, 0, n) !== 0) {
        for (let i = 0; i < n; i++) {
          if (bufA[i] === bufB[i]) continue;
          differingBytes++;
          const at = position + i;
          const last = ranges[ranges.length - 1];
          if (last && last.end === at) last.end = at + 1;
          else if (ranges.length >= MAX_RANGES) truncated = true;
          else ranges.push({ start: at, end: at + 1 });
        }
      }
      position += n;
      onProgress?.(position, size);
      if (truncated) break;
    }
  } finally {
    await fa.close();
    await fb.close();
  }
  return { ranges, differingBytes, truncated };
}

/** SHA-256 of a file, streamed. */
export async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path, { highWaterMark: CHUNK });
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolvePromise());
  });
  return { sha256: hash.digest("hex"), bytes };
}

export interface HashStreamsOptions {
  tempDir: string;
  mkvextractPath?: string;
  onProgress?: (message: string) => void;
  /** Terminates a running mkvextract; the call then rejects. */
  signal?: AbortSignal;
}

export interface TrackToHash {
  id: number;
  type: string;
  codecId: string;
}

/**
 * Extract the requested tracks with mkvextract and hash each one.
 *
 * mkvextract reads the whole MKV per invocation, so extracting one track at a
 * time would mean a full pass over a 17 GB file for every track. Instead the
 * video goes in one call and everything else in a second: two passes total,
 * with peak scratch use bounded by the larger of the two groups.
 */
export async function hashStreams(
  file: string,
  tracks: readonly TrackToHash[],
  options: HashStreamsOptions,
): Promise<StreamHash[]> {
  const exe = options.mkvextractPath ?? toolPath("mkvextract");
  const byId = new Map<number, StreamHash>();
  const groups = [
    tracks.filter((t) => t.type === "video"),
    tracks.filter((t) => t.type !== "video"),
  ].filter((g) => g.length > 0);

  for (const group of groups) {
    const paths = new Map(group.map((t) => [t.id, join(options.tempDir, `t${t.id}.bin`)]));
    options.onProgress?.(
      `extracting track(s) ${group.map((t) => t.id).join(", ")} from ${file}`,
    );
    let r;
    try {
      r = await spawnCapture(
        exe,
        [file, "tracks", ...group.map((t) => `${t.id}:${paths.get(t.id)!}`)],
        options.signal === undefined ? {} : { signal: options.signal },
      );
    } catch (err) {
      // Stopped (or failed to start) part-way: whatever it wrote is no use.
      for (const path of paths.values()) await rm(path, { force: true });
      throw err;
    }
    try {
      if (r.code !== 0) {
        throw new Error(
          `mkvextract failed on ${file}: ${r.stderr.trim() || r.stdout.trim()}`,
        );
      }
      for (const track of group) {
        const path = paths.get(track.id)!;
        options.onProgress?.(`hashing track ${track.id}`);
        const { sha256, bytes } = await hashFile(path);
        byId.set(track.id, {
          trackId: track.id,
          type: track.type,
          codecId: track.codecId,
          bytes,
          sha256,
        });
        await rm(path, { force: true });
      }
    } finally {
      for (const path of paths.values()) await rm(path, { force: true });
    }
  }

  // Keep the caller's order so the two files' lists line up pairwise.
  return tracks.map((t) => byId.get(t.id)!).filter(Boolean);
}
