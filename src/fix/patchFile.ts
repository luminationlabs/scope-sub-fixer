/**
 * Reading patch sites back out of a file, and the error both sides of a repair
 * raise when a file is not what the plan said it was.
 *
 * A PGS position rewrite never changes a segment's size, so the corrected file
 * is the input byte-for-byte with a few dozen u16 fields rewritten. That is by
 * far the safest repair available: the container, the video, the audio and
 * every untouched track are literally the same bytes.
 *
 * The sequence is deliberately paranoid:
 *   1. read the `before` bytes of every patch out of the INPUT and check them;
 *   2. stream input → output, patching the bytes on the way (`copyPatch.ts`);
 *   3. re-open the output and read every patched range back.
 */
import { open, type FileHandle } from "node:fs/promises";
import type { BytePatch } from "../pgs/patch.js";

/** A patch's `before` bytes did not match what is actually in the file. */
export class PatchVerifyError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} (at file offset ${offset} / 0x${offset.toString(16)})`);
    this.name = "PatchVerifyError";
  }
}

/** Patches close together are read in one go rather than one pread each. */
const READ_GROUP_GAP = 64 * 1024;

interface Group {
  start: number;
  end: number;
  patches: BytePatch[];
}

function groupPatches(patches: readonly BytePatch[]): Group[] {
  const sorted = [...patches].sort((a, b) => a.offset - b.offset);
  const groups: Group[] = [];
  for (const p of sorted) {
    const last = groups[groups.length - 1];
    if (last && p.offset - last.end <= READ_GROUP_GAP) {
      last.end = Math.max(last.end, p.offset + p.length);
      last.patches.push(p);
    } else {
      groups.push({ start: p.offset, end: p.offset + p.length, patches: [p] });
    }
  }
  return groups;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

async function readAt(
  fh: FileHandle,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const buf = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, offset + done);
    if (bytesRead === 0) {
      throw new PatchVerifyError(
        `unexpected end of file: wanted ${length} byte(s), got ${done}`,
        offset,
      );
    }
    done += bytesRead;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** Check that every patch's `before` (or `after`) bytes are present in `file`. */
export async function verifyPatchBytes(
  file: string,
  patches: readonly BytePatch[],
  side: "before" | "after",
): Promise<void> {
  if (patches.length === 0) return;
  const fh = await open(file, "r");
  try {
    for (const group of groupPatches(patches)) {
      const window = await readAt(fh, group.start, group.end - group.start);
      for (const p of group.patches) {
        const actual = window.subarray(
          p.offset - group.start,
          p.offset - group.start + p.length,
        );
        const expected = side === "before" ? p.before : p.after;
        if (!sameBytes(actual, expected)) {
          throw new PatchVerifyError(
            `expected ${side} bytes ${hex(expected)} but found ${hex(actual)}`,
            p.offset,
          );
        }
      }
    }
  } finally {
    await fh.close();
  }
}
