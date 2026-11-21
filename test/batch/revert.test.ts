/**
 * `revert` without a filesystem where possible: the inverse patch, the state a
 * file's bytes are in, and the table of refusals are all pure. The two writers
 * need real bytes, so they get a temp file each.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyPatchBytes,
  decideRevert,
  invertPatches,
  repairedPathFor,
  revertExitCode,
  RevertError,
  scanPatchState,
  writePatchesInPlace,
  type PatchStateScan,
  type RevertFileResult,
} from "../../src/batch/revert.js";
import {
  completedByInput,
  revertedByInput,
  type ApplyLogEvent,
} from "../../src/batch/log.js";
import { preflightDecision } from "../../src/batch/apply.js";
import type { BytePatch } from "../../src/pgs/patch.js";
import type { PlanFileEntry } from "../../src/batch/planFile.js";

function patch(offset: number, before: number[], after: number[]): BytePatch {
  return {
    offset,
    length: before.length,
    before: Uint8Array.from(before),
    after: Uint8Array.from(after),
  };
}

function scan(over: Partial<PatchStateScan> = {}): PatchStateScan {
  return { total: 4, fixed: 4, original: 0, mismatch: 0, firstMismatch: undefined, ...over };
}

describe("invertPatches", () => {
  it("swaps before and after, and sorts by offset", () => {
    const inverse = invertPatches([
      patch(40, [0x03, 0xa0], [0x02, 0x10]),
      patch(8, [0x00, 0x64], [0x00, 0x20]),
    ]);
    expect(inverse.map((p) => p.offset)).toEqual([8, 40]);
    expect([...inverse[0]!.before]).toEqual([0x00, 0x20]);
    expect([...inverse[0]!.after]).toEqual([0x00, 0x64]);
    expect(inverse[0]!.length).toBe(2);
  });

  it("is its own inverse", () => {
    const original = [patch(8, [1, 2], [3, 4]), patch(16, [5], [6])];
    expect(invertPatches(invertPatches(original))).toEqual(original);
  });
});

describe("classifyPatchBytes", () => {
  const p = patch(0, [0x00, 0x64], [0x00, 0x20]);

  it("recognises the repaired bytes, the original bytes and neither", () => {
    expect(classifyPatchBytes(Uint8Array.from([0x00, 0x20]), p)).toBe("fixed");
    expect(classifyPatchBytes(Uint8Array.from([0x00, 0x64]), p)).toBe("original");
    expect(classifyPatchBytes(Uint8Array.from([0x00, 0x99]), p)).toBe("mismatch");
  });

  it("calls a no-op patch fixed rather than ambiguous", () => {
    const same = patch(0, [7, 7], [7, 7]);
    expect(classifyPatchBytes(Uint8Array.from([7, 7]), same)).toBe("fixed");
  });
});

describe("decideRevert", () => {
  it("reverts a file that is exactly the repaired one", () => {
    expect(decideRevert({ size: 1000, expectedSize: 1000, scan: scan() })).toEqual({
      kind: "revert",
    });
  });

  it("refuses a file that is not there", () => {
    const d = decideRevert({ size: undefined, expectedSize: 1000, scan: scan() });
    expect(d.kind).toBe("refuse");
  });

  it("refuses a file of the wrong size without looking at bytes", () => {
    const d = decideRevert({ size: 1024, expectedSize: 1000, scan: scan() });
    expect(d).toMatchObject({ kind: "refuse" });
    expect(d.kind === "refuse" && d.reason).toMatch(/1024 bytes but the fixed file was 1000/);
  });

  it("refuses a file whose patched bytes are something else entirely", () => {
    const d = decideRevert({
      size: 1000,
      expectedSize: 1000,
      scan: scan({ fixed: 2, mismatch: 2, firstMismatch: 4096 }),
    });
    expect(d).toMatchObject({ kind: "refuse" });
    expect(d.kind === "refuse" && d.reason).toMatch(/first at offset 4096/);
  });

  it("skips a file that already holds the original bytes", () => {
    const d = decideRevert({
      size: 1000,
      expectedSize: 1000,
      scan: scan({ fixed: 0, original: 4 }),
    });
    expect(d).toMatchObject({ kind: "already-original" });
  });

  it("refuses a half-reverted file rather than finishing it blindly", () => {
    const d = decideRevert({
      size: 1000,
      expectedSize: 1000,
      scan: scan({ fixed: 3, original: 1 }),
    });
    expect(d).toMatchObject({ kind: "refuse" });
    expect(d.kind === "refuse" && d.reason).toMatch(/interrupted/);
    expect(d.kind === "refuse" && d.reason).toMatch(/revert <plan> --in-place/);
  });

  it("finishes a half-reverted file when the log shows the write that was interrupted", () => {
    expect(
      decideRevert({
        size: 1000,
        expectedSize: 1000,
        scan: scan({ fixed: 3, original: 1 }),
        resumable: true,
      }),
    ).toEqual({ kind: "revert" });
    // Bytes that are neither state are refused whatever the log says.
    expect(
      decideRevert({
        size: 1000,
        expectedSize: 1000,
        scan: scan({ fixed: 2, original: 1, mismatch: 1 }),
        resumable: true,
      }).kind,
    ).toBe("refuse");
  });
});

describe("repairedPathFor", () => {
  const entry = { input: "/movies/a.mkv", relative: "a.mkv" } as PlanFileEntry;

  it("uses the output a `verified` record names", () => {
    const record: ApplyLogEvent = {
      time: "",
      event: "verified",
      input: entry.input,
      output: "/out/a.mkv",
    };
    expect(repairedPathFor(entry, record)).toBe("/out/a.mkv");
  });

  it("uses the input's own path for a `replaced` record", () => {
    const record: ApplyLogEvent = {
      time: "",
      event: "replaced",
      input: entry.input,
      output: entry.input,
      backup: "/movies/a.mkv.pre-scopefix",
    };
    expect(repairedPathFor(entry, record)).toBe("/movies/a.mkv");
  });
});

describe("the log after a revert", () => {
  const verified: ApplyLogEvent = {
    time: "1",
    event: "verified",
    input: "/movies/a.mkv",
    output: "/out/a.mkv",
    bytes: 1000,
  };

  it("treats an in-place revert as not applied, so apply may do it again", () => {
    const reverted: ApplyLogEvent = {
      time: "2",
      event: "reverted",
      input: "/movies/a.mkv",
      output: "/out/a.mkv",
    };
    expect(completedByInput([verified, reverted]).has("/movies/a.mkv")).toBe(false);
    expect(revertedByInput([verified, reverted]).get("/movies/a.mkv")).toBe(reverted);
  });

  it("leaves the repair applied when the revert only wrote a copy elsewhere", () => {
    const copied: ApplyLogEvent = {
      time: "2",
      event: "reverted",
      input: "/movies/a.mkv",
      output: "/out/a.mkv",
      revertedTo: "/undo/a.mkv",
    };
    expect(completedByInput([verified, copied]).get("/movies/a.mkv")).toBe(verified);
    expect(revertedByInput([verified, copied]).size).toBe(0);
  });

  it("forgets the revert once the file has been applied again", () => {
    const reverted: ApplyLogEvent = {
      time: "2",
      event: "reverted",
      input: "/movies/a.mkv",
      output: "/out/a.mkv",
    };
    const again: ApplyLogEvent = { ...verified, time: "3" };
    expect(completedByInput([verified, reverted, again]).get("/movies/a.mkv")).toBe(again);
    expect(revertedByInput([verified, reverted, again]).size).toBe(0);
  });
});

describe("pre-flight over a reverted output", () => {
  const entry: PlanFileEntry = {
    input: "/movies/a.mkv",
    relative: "a.mkv",
    size: 1000,
    mtimeMs: 1700000000000,
    status: "NEEDS_FIX",
    video: null,
    active_area: null,
    tracks: [],
    action: "fix",
    method: "patch",
    analyzed: "",
  };
  const input = { exists: true, size: 1000, mtimeMs: 1700000000000 };
  const output = { exists: true, size: 1000 };

  it("refuses an existing output that nothing vouches for", () => {
    expect(preflightDecision(entry, input, output)).toMatchObject({
      ok: false,
      kind: "conflict",
    });
  });

  it("re-applies over an output this plan wrote and then reverted in place", () => {
    expect(
      preflightDecision(entry, input, output, { outputWasReverted: true }),
    ).toEqual({ ok: true });
  });
});

describe("revertExitCode", () => {
  const file = (over: Partial<RevertFileResult>): RevertFileResult =>
    ({ status: "reverted", validation: false, ...over }) as RevertFileResult;

  it("is 0 when everything reverted or was already original", () => {
    expect(revertExitCode([file({}), file({ status: "skipped" })])).toBe(0);
  });

  it("is 7 when a file was not what the plan described", () => {
    expect(revertExitCode([file({ status: "failed", validation: true })])).toBe(7);
  });

  it("is 6 for a failure that is not a validation failure", () => {
    expect(revertExitCode([file({ status: "failed" })])).toBe(6);
  });
});

describe("writePatchesInPlace", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "scope-sub-revert-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes only the patched bytes and reads them back", async () => {
    const path = join(dir, "file.bin");
    const original = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
    await writeFile(path, original);

    const patches = [patch(2, [2, 3], [0xaa, 0xbb]), patch(6, [6], [0xcc])];
    const written = await writePatchesInPlace(path, patches);
    expect(written).toEqual({ patchesWritten: 2, bytesChanged: 3 });
    expect([...(await readFile(path))]).toEqual([0, 1, 0xaa, 0xbb, 4, 5, 0xcc, 7]);

    // The state scan now sees the "after" bytes, and putting them back is the
    // inverse of what was just done.
    expect(await scanPatchState(path, patches)).toMatchObject({ total: 2, fixed: 2 });
    await writePatchesInPlace(path, invertPatches(patches));
    expect(await readFile(path)).toEqual(original);
  });

  it("reports the path when the file cannot be opened for writing", async () => {
    await expect(
      writePatchesInPlace(join(dir, "missing.bin"), [patch(0, [1], [2])]),
    ).rejects.toThrow(RevertError);
    await expect(
      writePatchesInPlace(join(dir, "missing.bin"), [patch(0, [1], [2])]),
    ).rejects.toThrow(/missing\.bin could not be opened for writing/);
  });
});

describe("scanPatchState", () => {
  let dir: string;
  let path: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "scope-sub-revert-scan-"));
    path = join(dir, "file.bin");
    await writeFile(path, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("classifies each range and remembers the first mismatch", async () => {
    const result = await scanPatchState(path, [
      patch(0, [0xff], [0]), // holds the "after" byte: fixed
      patch(1, [1], [0xff]), // holds the "before" byte: original
      patch(2, [0x11], [0x22]), // neither
      patch(3, [0x11], [0x22]), // neither
    ]);
    expect(result).toEqual({
      total: 4,
      fixed: 1,
      original: 1,
      mismatch: 2,
      firstMismatch: 2,
    });
  });

  it("counts a range that runs past the end of the file as a mismatch", async () => {
    expect(await scanPatchState(path, [patch(7, [0, 0], [1, 1])])).toMatchObject({
      mismatch: 1,
      firstMismatch: 7,
    });
  });
});
