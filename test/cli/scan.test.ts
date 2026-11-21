import { describe, expect, it, vi } from "vitest";
import {
  ArgumentError,
  EXIT,
  exitCodeFor,
  parseAspect,
  parseIntOption,
  resolveScanArgs,
  runScan,
} from "../../src/cli/scan.js";
import { buildProgram, main } from "../../src/cli/main.js";
import type { FileScanResult, ScanRunResult } from "../../src/scan/types.js";

function file(over: Partial<FileScanResult> = {}): FileScanResult {
  return {
    file: "/movies/x.mkv",
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

function run(files: FileScanResult[], missingPaths: string[] = []): ScanRunResult {
  return {
    files,
    summary: {
      scanned: files.length,
      withPgs: 0,
      needFix: 0,
      safe: 0,
      mixedOrAmbiguous: 0,
      errors: 0,
    },
    missingPaths,
  };
}

describe("parseAspect", () => {
  it("accepts decimals, ratios and auto", () => {
    expect(parseAspect("2.39")).toBe(2.39);
    expect(parseAspect("2.39:1")).toBe(2.39);
    expect(parseAspect("16:9")).toBeCloseTo(1.7778);
    expect(parseAspect("AUTO")).toBe("auto");
  });

  it("rejects nonsense", () => {
    expect(() => parseAspect("wide")).toThrow(ArgumentError);
    expect(() => parseAspect("0")).toThrow(ArgumentError);
    expect(() => parseAspect("2.39:0")).toThrow(ArgumentError);
  });
});

describe("parseIntOption", () => {
  it("parses integers and enforces a minimum", () => {
    expect(parseIntOption("4", "--jobs", { min: 1 })).toBe(4);
    expect(parseIntOption(undefined, "--jobs")).toBeUndefined();
    expect(() => parseIntOption("0", "--jobs", { min: 1 })).toThrow(ArgumentError);
    expect(() => parseIntOption("2.5", "--jobs")).toThrow(ArgumentError);
  });
});

describe("resolveScanArgs", () => {
  it("defaults to auto aspect, human format and info logging", () => {
    const a = resolveScanArgs({});
    expect(a.scan.aspect).toBe("auto");
    expect(a.format).toBe("human");
    expect(a.logLevel).toBe("info");
    expect(a.maxEvents).toBe(10);
    expect(a.scan.margin).toBeUndefined();
  });

  it("passes the numeric options through", () => {
    const a = resolveScanArgs({
      aspect: "2.39",
      jobs: "4",
      margin: "16",
      samples: "12",
      tolerance: "6",
      maxEvents: "3",
      tempDir: "/scratch",
      keepTemp: true,
      recursive: true,
      showEvents: true,
      format: "json",
      logLevel: "debug",
      failIfNeeded: true,
    });
    expect(a.scan).toMatchObject({
      aspect: 2.39,
      jobs: 4,
      margin: 16,
      samples: 12,
      tolerancePx: 6,
      tempDir: "/scratch",
      keepTemp: true,
      recursive: true,
    });
    expect(a).toMatchObject({
      format: "json",
      showEvents: true,
      maxEvents: 3,
      logLevel: "debug",
      failIfNeeded: true,
      marginOverride: 16,
    });
  });

  it("rejects a bad format or log level", () => {
    expect(() => resolveScanArgs({ format: "yaml" })).toThrow(ArgumentError);
    expect(() => resolveScanArgs({ logLevel: "loud" })).toThrow(ArgumentError);
  });
});

describe("exitCodeFor (PRD §20)", () => {
  it("is 0 when nothing needs fixing", () => {
    expect(exitCodeFor(run([file()]), true)).toBe(EXIT.OK);
  });

  it("is 0 for needed fixes unless --fail-if-needed", () => {
    const r = run([file({ status: "NEEDS_FIX" })]);
    expect(exitCodeFor(r, false)).toBe(EXIT.OK);
    expect(exitCodeFor(r, true)).toBe(EXIT.NEEDS_FIX);
  });

  it("is 2 when a path did not exist", () => {
    expect(exitCodeFor(run([], ["/nope"]), false)).toBe(EXIT.BAD_ARGS);
  });

  it("is 3 when a dependency is missing", () => {
    const r = run([file({ status: "ERROR", errorKind: "DEPENDENCY_MISSING" })]);
    expect(exitCodeFor(r, false)).toBe(EXIT.DEPENDENCY_MISSING);
  });

  it("is 5 only when every file failed to parse", () => {
    const failed = file({ status: "ERROR", errorKind: "PGS_PARSE" });
    expect(exitCodeFor(run([failed]), false)).toBe(EXIT.PGS_PARSE_ERROR);
    expect(exitCodeFor(run([failed, file()]), false)).toBe(EXIT.OK);
  });

  it("is 4 when every file failed for another reason", () => {
    const failed = file({ status: "ERROR", errorKind: "INSPECT" });
    expect(exitCodeFor(run([failed]), false)).toBe(EXIT.UNSUPPORTED_MEDIA);
  });
});

describe("runScan argument handling", () => {
  it("exits 2 with no paths", async () => {
    const stderr: string[] = [];
    const code = await runScan([], {}, { stdout: () => {}, stderr: (t) => stderr.push(t) });
    expect(code).toBe(EXIT.BAD_ARGS);
    expect(stderr.join("")).toMatch(/no paths given/);
  });

  it("exits 2 on a bad aspect", async () => {
    const stderr: string[] = [];
    const code = await runScan(
      ["/x.mkv"],
      { aspect: "wide" },
      { stdout: () => {}, stderr: (t) => stderr.push(t) },
    );
    expect(code).toBe(EXIT.BAD_ARGS);
    expect(stderr.join("")).toMatch(/invalid --aspect/);
  });

  it("exits 2 for a path that does not exist", async () => {
    const out: string[] = [];
    const code = await runScan(
      ["/definitely/not/here"],
      { aspect: "2.39", logLevel: "error" },
      { stdout: (t) => out.push(t), stderr: () => {} },
    );
    expect(code).toBe(EXIT.BAD_ARGS);
    expect(out.join("")).toMatch(/path not found/);
  });
});

describe("CLI program", () => {
  it("registers scan and leaves room for more subcommands", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toContain("scan");
  });

  it("prints help and exits 0", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await main(["scan", "--help"])).toBe(EXIT.OK);
      const text = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).toContain("--aspect");
      expect(text).toContain("--show-events");
    } finally {
      spy.mockRestore();
    }
  });

  it("exits 2 for an unknown option", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["scan", "--nope", "/x.mkv"])).toBe(EXIT.BAD_ARGS);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
