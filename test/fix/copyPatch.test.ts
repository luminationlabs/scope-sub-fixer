import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CopyAbortedError,
  copyWithPatches,
  hashFileChunked,
  partialPathFor,
} from "../../src/fix/copyPatch.js";
import { PatchVerifyError } from "../../src/fix/patchFile.js";
import type { BytePatch } from "../../src/pgs/patch.js";

function patch(offset: number, before: number[], after: number[]): BytePatch {
  return {
    offset,
    length: before.length,
    before: Uint8Array.from(before),
    after: Uint8Array.from(after),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("copyWithPatches", () => {
  let dir: string;
  let input: string;
  const size = 1000;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "scope-sub-copy-"));
    input = join(dir, "input.bin");
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i++) bytes[i] = i % 251;
    await writeFile(input, bytes);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stops at an aborted signal and removes the partial output", async () => {
    const output = join(dir, "aborted.bin");
    const controller = new AbortController();
    let chunks = 0;
    await expect(
      copyWithPatches(input, output, [], {
        chunkSize: 64,
        signal: controller.signal,
        onProgress: () => {
          if (++chunks === 3) controller.abort();
        },
      }),
    ).rejects.toBeInstanceOf(CopyAbortedError);
    expect(chunks).toBe(3);
    expect(await exists(output)).toBe(false);
  });

  it("writes nothing at all for a signal aborted before it starts", async () => {
    const output = join(dir, "never.bin");
    await expect(
      copyWithPatches(input, output, [], { signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(CopyAbortedError);
    expect(await exists(output)).toBe(false);
  });

  it("copies byte for byte when there is nothing to patch", async () => {
    const output = join(dir, "plain.bin");
    const result = await copyWithPatches(input, output, [], { chunkSize: 64 });
    expect(result.bytesWritten).toBe(size);
    expect(result.bytesChanged).toBe(0);
    expect(await readFile(output)).toEqual(await readFile(input));
    expect(result.sha256).toBe((await hashFileChunked(output, 64)).sha256);
  });

  it("applies patches and hashes exactly what it wrote", async () => {
    const output = join(dir, "patched.bin");
    const p = patch(10, [10, 11], [0xaa, 0xbb]);
    const result = await copyWithPatches(input, output, [p], { chunkSize: 64 });
    const written = await readFile(output);
    expect(written[10]).toBe(0xaa);
    expect(written[11]).toBe(0xbb);
    expect(result.bytesChanged).toBe(2);
    expect(result.patchesApplied).toBe(1);
    expect(result.sha256).toBe(createHash("sha256").update(written).digest("hex"));
  });

  it("applies a patch that straddles a chunk boundary", async () => {
    const output = join(dir, "straddle.bin");
    // Chunks are 64 bytes, so this 4-byte patch spans the 64/128 boundary.
    const p = patch(126, [126, 127, 128 % 251, 129 % 251], [1, 2, 3, 4]);
    const result = await copyWithPatches(input, output, [p], { chunkSize: 64 });
    const written = await readFile(output);
    expect([...written.subarray(124, 132)]).toEqual([124, 125, 1, 2, 3, 4, 130, 131]);
    expect(result.patchesApplied).toBe(1);
    expect(result.bytesChanged).toBe(4);
    expect(result.sha256).toBe((await hashFileChunked(output, 7)).sha256);
  });

  it("applies several patches, including two in one chunk and one at the end", async () => {
    const output = join(dir, "many.bin");
    const patches = [
      patch(0, [0], [9]),
      patch(63, [63, 64 % 251], [7, 7]),
      patch(70, [70], [8]),
      patch(size - 1, [(size - 1) % 251], [5]),
    ];
    const result = await copyWithPatches(input, output, patches, { chunkSize: 64 });
    const written = await readFile(output);
    expect(written[0]).toBe(9);
    expect([written[63], written[64]]).toEqual([7, 7]);
    expect(written[70]).toBe(8);
    expect(written[size - 1]).toBe(5);
    expect(result.patchesApplied).toBe(4);
  });

  it("aborts and removes the partial output when a `before` byte does not match", async () => {
    // The mismatch is at byte 500 — chunk 8 of 64 bytes — so the first patch
    // has been applied and ~500 bytes are already on disk when it is found.
    // Nothing may survive that: a full-size, half-patched file is exactly what
    // must never be left where a repaired one belongs (this is the copier both
    // `fix --method patch` and `apply` use).
    const output = join(dir, "mismatch.bin");
    const patches = [patch(4, [4], [0xff]), patch(500, [0x00], [0x11])];
    await expect(
      copyWithPatches(input, output, patches, { chunkSize: 64 }),
    ).rejects.toThrow(PatchVerifyError);
    expect(await exists(output)).toBe(false);
  });

  it("removes the partial output when the mismatch is in the last chunk", async () => {
    const output = join(dir, "late-mismatch.bin");
    const patches = [
      patch(4, [4], [0xff]),
      patch(500, [500 % 251], [0x22]),
      patch(size - 2, [0x00, 0x00], [0x33, 0x33]),
    ];
    await expect(
      copyWithPatches(input, output, patches, { chunkSize: 64 }),
    ).rejects.toThrow(PatchVerifyError);
    expect(await exists(output)).toBe(false);
  });

  it("refuses when the file is not the size the plan recorded", async () => {
    const output = join(dir, "size.bin");
    await expect(
      copyWithPatches(input, output, [], { chunkSize: 64, expectedSize: size + 1 }),
    ).rejects.toThrow(/plan recorded/);
    expect(await exists(output)).toBe(false);
  });

  it("refuses a patch that runs past the end of the input", async () => {
    const output = join(dir, "past-end.bin");
    await expect(
      copyWithPatches(input, output, [patch(size - 1, [0, 0], [1, 1])], {
        chunkSize: 64,
      }),
    ).rejects.toThrow(/but the file is only/);
    expect(await exists(output)).toBe(false);
  });

  it("stops hashing between two chunks when its signal is aborted", async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(hashFileChunked(input, 64, stop.signal)).rejects.toBeInstanceOf(CopyAbortedError);
    // A signal that never fires changes nothing.
    const quiet = new AbortController();
    expect(await hashFileChunked(input, 64, quiet.signal)).toEqual(await hashFileChunked(input, 64));
  });

  it("names its partial files so that nobody else's can be mistaken for one", () => {
    expect(partialPathFor("/out/a.mkv")).toBe("/out/a.mkv.scope-sub-partial");
    expect(partialPathFor("/out/a.mkv")).not.toBe("/out/a.mkv.partial");
  });

  it("hashes a file the same way regardless of chunk size", async () => {
    const a = await hashFileChunked(input, 3);
    const b = await hashFileChunked(input, 1024 * 1024);
    expect(a).toEqual(b);
    expect(a.bytes).toBe(size);
  });
});
