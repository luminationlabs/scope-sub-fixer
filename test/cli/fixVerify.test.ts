import { describe, expect, it } from "vitest";
import { resolveFixArgs, runFix } from "../../src/cli/fix.js";
import { resolveVerifyArgs, runVerify } from "../../src/cli/verify.js";
import { buildProgram } from "../../src/cli/main.js";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
  };
}

describe("fix argument resolution", () => {
  it("requires --output unless --dry-run is given", () => {
    expect(() => resolveFixArgs("/movies/in.mkv", {})).toThrow(/--output is required/);
    expect(resolveFixArgs("/movies/in.mkv", { dryRun: true }).options.dryRun).toBe(true);
  });

  it("parses aspect, method and track ids", () => {
    const { options } = resolveFixArgs("/movies/in.mkv", {
      output: "/movies/out.mkv",
      aspect: "2.39:1",
      method: "remux",
      track: ["4", "5,6"],
    });
    expect(options.aspect).toBeCloseTo(2.39);
    expect(options.method).toBe("remux");
    expect(options.trackIds).toEqual([4, 5, 6]);
  });

  it("rejects a bad method and a bad track id", () => {
    expect(() =>
      resolveFixArgs("/in.mkv", { output: "/out.mkv", method: "magic" }),
    ).toThrow(/--method/);
    expect(() =>
      resolveFixArgs("/in.mkv", { output: "/out.mkv", track: ["x"] }),
    ).toThrow(/--track/);
  });

  it("maps a bad argument onto exit code 2", async () => {
    const { io: sink, err } = io();
    expect(
      await runFix("/movies/in.mkv", { output: "/tmp/out.mkv", format: "yaml" }, sink),
    ).toBe(2);
    expect(err.join("")).toContain("--format");
  });

  it("maps a missing input onto exit code 2", async () => {
    const { io: sink } = io();
    expect(
      await runFix("/definitely/not/here.mkv", { output: "/tmp/out.mkv" }, sink),
    ).toBe(2);
  });
});

describe("verify argument resolution", () => {
  it("parses expected track ids", () => {
    const { options } = resolveVerifyArgs({ expectTracks: "4, 5" });
    expect(options.expectTracks).toEqual([4, 5]);
  });

  it("defaults the aspect to auto", () => {
    expect(resolveVerifyArgs({}).options.aspect).toBe("auto");
  });

  it("rejects a bad expected track list", () => {
    expect(() => resolveVerifyArgs({ expectTracks: "four" })).toThrow(/--expect-tracks/);
  });

  it("maps bad arguments onto exit code 2", async () => {
    const { io: sink } = io();
    expect(await runVerify("/a.mkv", "/b.mkv", { format: "xml" }, sink)).toBe(2);
  });
});

describe("the program", () => {
  it("registers the single-file and the batch commands", () => {
    expect(buildProgram().commands.map((c) => c.name()).sort()).toEqual([
      "apply",
      "doctor",
      "fix",
      "plan",
      "plan-show",
      "remargin",
      "restore-dates",
      "revert",
      "review",
      "scan",
      "serve",
      "verify",
    ]);
  });
});
