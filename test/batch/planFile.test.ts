import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, sep, win32 } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PLAN_SCHEMA_VERSION,
  PlanFileError,
  decodePatch,
  decodePatches,
  encodePatch,
  encodePatches,
  fromHex,
  inUseHint,
  nextPatchFileName,
  outputPathFor,
  planPaths,
  readPatchFile,
  readPlan,
  renameRetrying,
  requirePlan,
  storedRelative,
  toHex,
  writePatchFile,
  writePlan,
  type PatchFile,
  type PlanFile,
  type PlanFileEntry,
} from "../../src/batch/planFile.js";
import type { BytePatch } from "../../src/pgs/patch.js";

function entry(overrides: Partial<PlanFileEntry> = {}): PlanFileEntry {
  return {
    input: "/movies/Scope (2024).mkv",
    relative: "Scope (2024).mkv",
    size: 1234,
    mtimeMs: 1700000000000,
    status: "NEEDS_FIX",
    video: { w: 1920, h: 1080 },
    active_area: {
      top: 138,
      bottom: 941,
      left: 0,
      right: 1919,
      aspect: 2.39,
      source: "manual",
      classification: "CONSTANT",
    },
    tracks: [],
    action: "fix",
    method: "patch",
    analyzed: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("patch hex encoding", () => {
  const patches: BytePatch[] = [
    {
      offset: 4096,
      length: 4,
      before: Uint8Array.of(0x03, 0x5c, 0x07, 0x60),
      after: Uint8Array.of(0x03, 0x5c, 0x06, 0xbf),
    },
    {
      offset: 12,
      length: 2,
      before: Uint8Array.of(0x00, 0xff),
      after: Uint8Array.of(0x01, 0x00),
    },
  ];

  it("round-trips bytes through hex", () => {
    const bytes = Uint8Array.of(0, 1, 15, 16, 254, 255);
    expect(toHex(bytes)).toBe("00010f10feff");
    expect([...fromHex(toHex(bytes))]).toEqual([...bytes]);
  });

  it("round-trips a patch exactly", () => {
    const encoded = encodePatch(patches[0]!);
    expect(encoded).toEqual({
      offset: 4096,
      length: 4,
      before: "035c0760",
      after: "035c06bf",
    });
    const decoded = decodePatch(encoded);
    expect(decoded.offset).toBe(4096);
    expect(decoded.length).toBe(4);
    expect([...decoded.before]).toEqual([...patches[0]!.before]);
    expect([...decoded.after]).toEqual([...patches[0]!.after]);
  });

  it("round-trips a whole list and sorts it by offset", () => {
    const decoded = decodePatches(encodePatches(patches));
    expect(decoded.map((p) => p.offset)).toEqual([12, 4096]);
    expect([...decoded[1]!.after]).toEqual([0x03, 0x5c, 0x06, 0xbf]);
  });

  it("rejects malformed hex and a length that disagrees with the bytes", () => {
    expect(() => fromHex("abc")).toThrow(PlanFileError);
    expect(() => fromHex("zz")).toThrow(PlanFileError);
    expect(() =>
      decodePatch({ offset: 0, length: 4, before: "0000", after: "0000" }),
    ).toThrow(/declares length 4/);
    expect(() =>
      decodePatch({ offset: -1, length: 1, before: "00", after: "01" }),
    ).toThrow(/not a file offset/);
  });
});

describe("output path mapping", () => {
  it("puts a flat plan's files straight under the output root", () => {
    expect(outputPathFor(entry(), "/out")).toBe(join("/out", "Scope (2024).mkv"));
  });

  it("mirrors the scanned tree for a recursive plan", () => {
    const e = entry({
      input: "/movies/Action/Scope (2024)/Scope (2024).mkv",
      root: "/movies",
      relative: "Action/Scope (2024)/Scope (2024).mkv",
    });
    expect(outputPathFor(e, "/out")).toBe(
      join("/out", "Action", "Scope (2024)", "Scope (2024).mkv"),
    );
  });

  it("never renames the file itself", () => {
    const e = entry({ relative: "Deep/Nested/Name.mkv" });
    expect(outputPathFor(e, "/out").endsWith(`${sep}Name.mkv`)).toBe(true);
  });
});

describe("relative paths as stored", () => {
  it("are /-separated on every platform", () => {
    // What `relative()` gives on Windows, and what plan.json gets.
    const onWindows = win32.relative(String.raw`D:\Films`, String.raw`D:\Films\Action\Scope (2024).mkv`);
    expect(onWindows).toBe(String.raw`Action\Scope (2024).mkv`);
    expect(storedRelative(onWindows, win32.sep)).toBe("Action/Scope (2024).mkv");
    // POSIX is untouched, a backslash in a name included.
    expect(storedRelative(String.raw`Action/Odd\Name.mkv`, posix.sep)).toBe(String.raw`Action/Odd\Name.mkv`);
  });

  it("map onto Windows paths as stored, and so do patch file names", () => {
    expect(win32.join(String.raw`E:\Out`, "Action/Scope (2024).mkv")).toBe(
      String.raw`E:\Out\Action\Scope (2024).mkv`,
    );
    // An older plan written on Windows with backslashes reads the same there.
    expect(win32.join(String.raw`E:\Out`, String.raw`Action\Scope (2024).mkv`)).toBe(
      String.raw`E:\Out\Action\Scope (2024).mkv`,
    );
    expect(win32.join(String.raw`C:\Plans\lib`, "patches/3.json")).toBe(String.raw`C:\Plans\lib\patches\3.json`);
    expect(win32.basename("patches/3.json")).toBe("3.json");
  });
});

describe("saving plan.json on Windows", () => {
  const busy = () => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });

  it("tries a refused rename again, a bounded number of times", async () => {
    let calls = 0;
    const rename = async () => {
      calls += 1;
      if (calls < 3) throw busy();
    };
    await renameRetrying("a", "b", { platform: "win32", delayMs: 1, rename });
    expect(calls).toBe(3);

    calls = 0;
    const never = async () => {
      calls += 1;
      throw busy();
    };
    await expect(renameRetrying("a", "b", { platform: "win32", delayMs: 1, rename: never })).rejects.toThrow("EPERM");
    expect(calls).toBe(5);
  });

  it("tries once elsewhere, and once for any other error", async () => {
    let calls = 0;
    const never = async () => {
      calls += 1;
      throw busy();
    };
    await expect(renameRetrying("a", "b", { platform: "darwin", delayMs: 1, rename: never })).rejects.toThrow();
    expect(calls).toBe(1);
    calls = 0;
    const missing = async () => {
      calls += 1;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    await expect(renameRetrying("a", "b", { platform: "win32", delayMs: 1, rename: missing })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("says the file is in use, with its path, when it never gives way", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scope-sub-planfile-busy-"));
    try {
      const failing = async () => {
        throw busy();
      };
      const err = await writePlan(dir, { files: [] } as unknown as PlanFile, {
        platform: "win32",
        delayMs: 1,
        rename: failing,
      }).catch((e: unknown) => e);
      expect(String((err as Error).message)).toContain(planPaths(dir).planFile);
      expect(String((err as Error).message)).toContain("in use by another program");
      expect(inUseHint(busy(), "darwin")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("plan directory io", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "scope-sub-planfile-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const plan: PlanFile = {
    schema: PLAN_SCHEMA_VERSION,
    tool: { name: "scope-sub", version: "0.1.0" },
    created: "2026-09-02T00:00:00.000Z",
    updated: "2026-09-02T00:00:00.000Z",
    options: { aspect: 2.39, method: "patch", recursive: false },
    paths: ["/movies"],
    files: [entry({ patchFile: "patches/1.json" })],
  };

  it("returns null for a directory with no plan", async () => {
    expect(await readPlan(join(dir, "empty"))).toBeNull();
    await expect(requirePlan(join(dir, "empty"))).rejects.toThrow(PlanFileError);
  });

  it("writes and reads a plan, atomically (no temp file left behind)", async () => {
    const planDir = join(dir, "p1");
    await writePlan(planDir, plan);
    const back = await requirePlan(planDir);
    expect(back).toEqual(plan);
    const raw = await readFile(planPaths(planDir).planFile, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("writes and reads a patch file", async () => {
    const planDir = join(dir, "p2");
    const patchFile: PatchFile = {
      schema: PLAN_SCHEMA_VERSION,
      tool: { name: "scope-sub", version: "0.1.0" },
      created: "2026-09-02T00:00:00.000Z",
      input: "/movies/Scope (2024).mkv",
      size: 1234,
      mtimeMs: 1700000000000,
      method: "patch",
      tracks: [],
      patches: [{ offset: 8, length: 1, before: "aa", after: "bb" }],
    };
    await writePatchFile(planDir, "patches/1.json", patchFile);
    expect(await readPatchFile(planDir, "patches/1.json")).toEqual(patchFile);
  });

  it("allocates patch file names that are not already taken", async () => {
    const planDir = join(dir, "p3");
    await writePatchFile(planDir, "patches/1.json", {
      schema: PLAN_SCHEMA_VERSION,
      tool: { name: "scope-sub", version: "0.1.0" },
      created: "",
      input: "",
      size: 0,
      mtimeMs: 0,
      method: "patch",
      tracks: [],
      patches: [],
    });
    expect(await nextPatchFileName(planDir, [])).toBe("patches/2.json");
    expect(await nextPatchFileName(planDir, ["patches/2.json"])).toBe("patches/3.json");
  });

  it("refuses a file that is not a plan, and a plan from another schema", async () => {
    const planDir = join(dir, "p4");
    await writePlan(planDir, plan);
    await writeFile(planPaths(planDir).planFile, JSON.stringify({ hello: 1 }), "utf8");
    await expect(requirePlan(planDir)).rejects.toThrow(/not a scope-sub plan file/);

    await writeFile(
      planPaths(planDir).planFile,
      JSON.stringify({ ...plan, schema: 99 }),
      "utf8",
    );
    await expect(requirePlan(planDir)).rejects.toThrow(/plan schema 99/);
  });
});
