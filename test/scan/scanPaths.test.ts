import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectMkvFiles, isMkvPath, scanPaths, summarize } from "../../src/scan/scanPaths.js";
import type { FileScanResult } from "../../src/scan/types.js";
import { makeTempDir, removeDir } from "../helpers/scanFixture.js";

function file(over: Partial<FileScanResult>): FileScanResult {
  return {
    file: "/x.mkv",
    status: "OK",
    durationMs: undefined,
    title: undefined,
    video: null,
    activeArea: null,
    tracks: [],
    notes: [],
    error: undefined,
    errorKind: undefined,
    ...over,
  };
}

describe("isMkvPath", () => {
  it("matches .mkv case-insensitively", () => {
    expect(isMkvPath("/a/b.mkv")).toBe(true);
    expect(isMkvPath("/a/B.MKV")).toBe(true);
    expect(isMkvPath("/a/b.mp4")).toBe(false);
  });
});

describe("collectMkvFiles", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    await mkdir(join(dir, "sub"), { recursive: true });
    await mkdir(join(dir, ".hidden"), { recursive: true });
    await writeFile(join(dir, "b.mkv"), "");
    await writeFile(join(dir, "a.mkv"), "");
    await writeFile(join(dir, "notes.txt"), "");
    await writeFile(join(dir, "sub", "c.mkv"), "");
    await writeFile(join(dir, ".hidden", "d.mkv"), "");
  });

  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  it("lists .mkv files in a directory, sorted, non-recursively by default", async () => {
    const { files, missing } = await collectMkvFiles([dir]);
    expect(files).toEqual([join(dir, "a.mkv"), join(dir, "b.mkv")]);
    expect(missing).toEqual([]);
  });

  it("descends when recursive and skips dot directories", async () => {
    const { files } = await collectMkvFiles([dir], true);
    expect(files).toEqual([
      join(dir, "a.mkv"),
      join(dir, "b.mkv"),
      join(dir, "sub", "c.mkv"),
    ]);
  });

  it("accepts explicit files and skips non-mkv ones", async () => {
    const { files } = await collectMkvFiles([
      join(dir, "a.mkv"),
      join(dir, "notes.txt"),
    ]);
    expect(files).toEqual([join(dir, "a.mkv")]);
  });

  it("de-duplicates repeated inputs", async () => {
    const { files } = await collectMkvFiles([join(dir, "a.mkv"), join(dir, "a.mkv")]);
    expect(files).toEqual([join(dir, "a.mkv")]);
  });

  it("records missing paths instead of throwing", async () => {
    const { files, missing } = await collectMkvFiles([join(dir, "nope")]);
    expect(files).toEqual([]);
    expect(missing).toEqual([join(dir, "nope")]);
  });
});

describe("summarize", () => {
  it("counts each status the way PRD §11.5 does", () => {
    const s = summarize([
      file({ status: "OK", tracks: [{} as never] }),
      file({ status: "NO_PGS" }),
      file({ status: "NEEDS_FIX", tracks: [{} as never] }),
      file({ status: "MIXED_ASPECT_RATIO", tracks: [{} as never] }),
      file({ status: "AMBIGUOUS", tracks: [{} as never] }),
      file({ status: "ERROR" }),
    ]);
    expect(s).toEqual({
      scanned: 6,
      withPgs: 4,
      needFix: 1,
      safe: 2,
      mixedOrAmbiguous: 2,
      errors: 1,
    });
  });
});

describe("scanPaths", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    await writeFile(join(dir, "a.mkv"), "");
    await writeFile(join(dir, "b.mkv"), "");
  });

  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  it("scans every file and keeps going past failures", async () => {
    const seen: string[] = [];
    const run = await scanPaths(
      [dir],
      { aspect: 2.39, jobs: 2 },
      {
        inspect: async (f) => {
          seen.push(f);
          throw new Error("boom");
        },
      },
    );
    expect(run.files).toHaveLength(2);
    expect(run.files.every((f) => f.status === "ERROR")).toBe(true);
    expect(run.summary.errors).toBe(2);
    expect(seen).toHaveLength(2);
  });

  it("reports missing inputs", async () => {
    const run = await scanPaths([join(dir, "nope")], { aspect: 2.39 }, {});
    expect(run.missingPaths).toHaveLength(1);
    expect(run.files).toHaveLength(0);
  });

  it("returns files in a stable order", async () => {
    const opts = { aspect: 2.39 as const, jobs: 4 };
    const deps = { inspect: async () => { throw new Error("x"); } };
    const a = await scanPaths([dir], opts, deps);
    const b = await scanPaths([dir], opts, deps);
    expect(a.files.map((f) => f.file)).toEqual(b.files.map((f) => f.file));
  });
});
