/**
 * Streaming copy-with-patches: the one way both `fix --method patch` and
 * `apply` put a repaired file on disk.
 *
 * One pass. The bytes are read, the patched ranges are rewritten as they go
 * past, the result is hashed and written — so the copy and the edit cost the
 * same I/O as the copy alone, and the hash proves what was written.
 *
 * The contract is paranoid on purpose: every patch's `before` bytes must be
 * present exactly where the plan said they would be, or the file is abandoned
 * and the partial output deleted. That last part is why this is the only copier
 * left: a mid-copy refusal must never leave a full-size, half-patched file
 * looking like a result. Patches are applied per chunk and a patch may straddle
 * a chunk boundary, so each one is handled as the overlap between its range and
 * the chunk in hand.
 */
import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { PatchVerifyError } from "./patchFile.js";
import type { BytePatch } from "../pgs/patch.js";

/** Large enough that a 40 GB copy is not syscall-bound. */
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

export interface CopyWithPatchesOptions {
  /** Bytes per read/write. Injectable so tests can straddle a boundary. */
  chunkSize?: number;
  /** Called with (bytesCopied, totalBytes) after each chunk. */
  onProgress?: (copied: number, total: number) => void;
  /** Expected input size; a mismatch aborts before anything is written. */
  expectedSize?: number;
  /**
   * Checked before every chunk. An aborted copy fails like any other: it
   * throws (`CopyAbortedError`) and the partial output is removed.
   */
  signal?: AbortSignal;
}

/** The copy was stopped through `CopyWithPatchesOptions.signal`. */
export class CopyAbortedError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CopyAbortedError";
  }
}

export interface CopyWithPatchesResult {
  bytesWritten: number;
  bytesChanged: number;
  patchesApplied: number;
  /** SHA-256 of the bytes this function wrote. */
  sha256: string;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Copy `input` to `output`, applying `patches` to the stream as it passes.
 *
 * On any failure the partial output is removed, so a killed or failed file
 * never leaves something that looks like a result.
 */
export async function copyWithPatches(
  input: string,
  output: string,
  patches: readonly BytePatch[],
  options: CopyWithPatchesOptions = {},
): Promise<CopyWithPatchesResult> {
  const chunkSize = Math.max(1, Math.floor(options.chunkSize ?? DEFAULT_CHUNK_SIZE));
  const sorted = [...patches].sort((a, b) => a.offset - b.offset);
  const hash = createHash("sha256");

  const inputHandle = await open(input, "r");
  let outputHandle;
  try {
    const size = (await inputHandle.stat()).size;
    if (options.expectedSize !== undefined && options.expectedSize !== size) {
      throw new PatchVerifyError(
        `the file is ${size} bytes but the plan recorded ${options.expectedSize}`,
        0,
      );
    }
    const last = sorted[sorted.length - 1];
    if (last && last.offset + last.length > size) {
      throw new PatchVerifyError(
        `a patch ends at ${last.offset + last.length} but the file is only ${size} bytes`,
        last.offset,
      );
    }

    outputHandle = await open(output, "w");
    const buffer = Buffer.allocUnsafe(chunkSize);
    let position = 0;
    let cursor = 0;
    let bytesChanged = 0;
    let patchesApplied = 0;

    while (position < size) {
      if (options.signal?.aborted === true) throw new CopyAbortedError();
      const { bytesRead } = await inputHandle.read(buffer, 0, chunkSize, position);
      if (bytesRead === 0) {
        throw new PatchVerifyError(
          `unexpected end of file at ${position} of ${size} bytes`,
          position,
        );
      }
      const chunkStart = position;
      const chunkEnd = position + bytesRead;
      const view = new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);

      // Patches whose range overlaps this chunk. One may reach into the next
      // chunk, in which case `cursor` stays put and it is picked up again.
      for (let i = cursor; i < sorted.length; i++) {
        const p = sorted[i]!;
        if (p.offset >= chunkEnd) break;
        const from = Math.max(p.offset, chunkStart);
        const to = Math.min(p.offset + p.length, chunkEnd);
        if (to <= from) continue;
        const inChunk = from - chunkStart;
        const inPatch = from - p.offset;
        for (let k = 0; k < to - from; k++) {
          const actual = view[inChunk + k]!;
          const before = p.before[inPatch + k]!;
          if (actual !== before) {
            throw new PatchVerifyError(
              `expected before bytes ${hex(p.before)} but found ` +
                `0x${actual.toString(16).padStart(2, "0")} at byte ${inPatch + k}`,
              p.offset,
            );
          }
          const after = p.after[inPatch + k]!;
          view[inChunk + k] = after;
          if (after !== before) bytesChanged++;
        }
        if (p.offset + p.length <= chunkEnd) {
          patchesApplied++;
          if (i === cursor) cursor++;
        }
      }

      hash.update(view);
      await outputHandle.write(buffer, 0, bytesRead, chunkStart);
      position = chunkEnd;
      options.onProgress?.(position, size);
    }

    if (patchesApplied !== sorted.length) {
      throw new PatchVerifyError(
        `${sorted.length - patchesApplied} patch(es) were never reached in a ${size}-byte file`,
        sorted[patchesApplied]?.offset ?? 0,
      );
    }

    await outputHandle.sync();
    return {
      bytesWritten: position,
      bytesChanged,
      patchesApplied,
      sha256: hash.digest("hex"),
    };
  } catch (err) {
    await rm(output, { force: true });
    throw err;
  } finally {
    await inputHandle.close();
    await outputHandle?.close();
  }
}

/**
 * Where a file is written before it is renamed to `output`. The name is the
 * tool's own, so removing a leftover one can never remove somebody else's
 * file.
 */
export function partialPathFor(output: string): string {
  return `${output}.scope-sub-partial`;
}

/**
 * SHA-256 of a file, read back in the same chunk size the copy used. With a
 * `signal`, an abort between two chunks throws `CopyAbortedError`.
 */
export async function hashFileChunked(
  path: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  signal?: AbortSignal,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.floor(chunkSize)));
    let bytes = 0;
    for (;;) {
      if (signal?.aborted === true) throw new CopyAbortedError();
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, bytes);
      if (bytesRead === 0) break;
      hash.update(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
      bytes += bytesRead;
    }
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    await handle.close();
  }
}
