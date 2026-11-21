import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  DOCTOR_EXIT,
  formatDoctorReport,
  parseNodeMajor,
  parseVersionLine,
  REQUIRED_NODE,
  REQUIRED_NODE_MAJOR,
  REQUIRED_NODE_MINOR,
  runDoctor,
  runDoctorCommand,
  type DoctorOptions,
  type ToolRunner,
  TEST_FRAME_ARGS,
  TEST_FRAME_BYTES,
} from "../../src/cli/doctor.js";
import type { CliIo } from "../../src/cli/scan.js";
import { hasTool } from "../helpers/scanFixture.js";

/** A PATH directory holding executable stubs. Nothing is ever spawned. */
async function stubBinDir(names: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scope-sub-doctor-"));
  for (const name of names) {
    // Named as the search expects them on this platform (`ffmpeg.exe` on Windows).
    const file = join(dir, process.platform === "win32" ? `${name}.exe` : name);
    await writeFile(file, "#!/bin/sh\nexit 0\n");
    await chmod(file, 0o755);
  }
  return dir;
}

const OK_OUTPUT: Record<string, string> = {
  mkvmerge: "mkvmerge v92.0 ('Everglow') 64-bit\n",
  mkvextract: "mkvextract v92.0 ('Everglow') 64-bit\n",
  ffmpeg: "ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers\n",
};

/** What ffmpeg writes for the test frame: one 64x36 16-bit grey frame. */
const isFrameTest = (args: readonly string[]): boolean => args.includes("lavfi");

/** A runner that answers as a healthy install would. */
const healthyRunner: ToolRunner = async (exe, args) => {
  if (isFrameTest(args)) {
    return { code: 0, stdout: "\uFFFD".repeat(TEST_FRAME_BYTES), stderr: "", stdoutBytes: TEST_FRAME_BYTES };
  }
  const name = basename(exe).replace(/\.exe$/i, "");
  return { code: 0, stdout: OK_OUTPUT[name] ?? "", stderr: "" };
};

async function healthyOptions(overrides: DoctorOptions = {}): Promise<DoctorOptions> {
  const bin = await stubBinDir(["mkvmerge", "mkvextract", "ffmpeg"]);
  return {
    env: { PATH: bin },
    run: healthyRunner,
    nodeVersion: `v${REQUIRED_NODE}.0`,
    ...overrides,
  };
}

describe("parseVersionLine", () => {
  it("takes the first non-empty line", () => {
    expect(parseVersionLine("\n\nmkvmerge v92.0 ('Everglow') 64-bit\n\n")).toBe(
      "mkvmerge v92.0 ('Everglow') 64-bit",
    );
  });

  it("drops ffmpeg's copyright banner", () => {
    expect(parseVersionLine(OK_OUTPUT["ffmpeg"]!)).toBe("ffmpeg version 7.1.1");
  });

  it("is undefined for empty output", () => {
    expect(parseVersionLine("   \n\n")).toBeUndefined();
  });
});

describe("TEST_FRAME_ARGS", () => {
  it("asks for one frame in the sampler's own output shape", () => {
    const args = TEST_FRAME_ARGS.join(" ");
    expect(args).toContain("-color_range tv -noautorotate -f lavfi -i color=c=gray:s=64x36:d=1");
    expect(args).toContain("-frames:v 1 -vf format=gray16le -f rawvideo -");
    expect(TEST_FRAME_BYTES).toBe(64 * 36 * 2);
  });
});

describe("parseNodeMajor", () => {
  it("reads the major from a process.version string", () => {
    expect(parseNodeMajor("v24.16.0")).toBe(24);
    expect(parseNodeMajor("22.11.0")).toBe(22);
    expect(parseNodeMajor("garbage")).toBe(0);
  });
});

describe("runDoctor", () => {
  it("passes when every tool is on the stubbed PATH", async () => {
    const report = await runDoctor(await healthyOptions());
    expect(report.ok).toBe(true);
    expect(report.node.ok).toBe(true);
    expect(report.tools.map((t) => t.tool)).toEqual(["mkvmerge", "mkvextract", "ffmpeg"]);
    expect(report.tools.every((t) => t.found && t.origin === "path")).toBe(true);
    expect(report.tools[0]!.version).toBe("mkvmerge v92.0 ('Everglow') 64-bit");
    expect(report.frames).toEqual({ ok: true, detail: "decodes a frame for measuring" });
    expect(report.tempDir.writable).toBe(true);
  });

  it("reports a missing tool without failing the others", async () => {
    const bin = await stubBinDir(["mkvmerge", "ffmpeg"]);
    const report = await runDoctor({
      env: { PATH: bin },
      run: healthyRunner,
      nodeVersion: "v24.0.0",
    });
    // mkvextract may still exist in one of the extra search directories on a
    // developer machine, so assert on the report as a whole only when it does not.
    const extract = report.tools.find((t) => t.tool === "mkvextract")!;
    if (!extract.found) {
      expect(report.ok).toBe(false);
      expect(extract.error).toMatch(/not found/);
    }
    expect(report.tools.find((t) => t.tool === "mkvmerge")!.found).toBe(true);
  });

  it("fails when the Node version is below the engines floor", async () => {
    const report = await runDoctor(
      await healthyOptions({ nodeVersion: `v${REQUIRED_NODE_MAJOR - 1}.0.0` }),
    );
    expect(report.node.ok).toBe(false);
    expect(report.ok).toBe(false);
  });

  it("fails on an earlier minor of the required major, and passes on a later major", async () => {
    const early = await runDoctor(
      await healthyOptions({ nodeVersion: `v${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR - 1}.0` }),
    );
    expect(early.node.ok).toBe(false);
    const later = await runDoctor(
      await healthyOptions({ nodeVersion: `v${REQUIRED_NODE_MAJOR + 2}.0.0` }),
    );
    expect(later.node.ok).toBe(true);
  });

  it("fails, saying why, when ffmpeg cannot decode the test frame", async () => {
    // A build without the lavfi input: ffmpeg exits 1 and says so.
    const run: ToolRunner = async (exe, args) =>
      isFrameTest(args)
        ? { code: 1, stdout: "", stderr: "[in#0] Unknown input format: 'lavfi'\n", stdoutBytes: 0 }
        : healthyRunner(exe, args);
    const report = await runDoctor(await healthyOptions({ run }));
    expect(report.frames).toEqual({
      ok: false,
      detail: "this ffmpeg could not decode a test frame: [in#0] Unknown input format: 'lavfi'",
    });
    expect(report.ok).toBe(false);
  });

  it("fails when the frame is not the size asked for", async () => {
    const run: ToolRunner = async (exe, args) =>
      isFrameTest(args)
        ? { code: 0, stdout: "x".repeat(64 * 36), stderr: "", stdoutBytes: 64 * 36 }
        : healthyRunner(exe, args);
    const report = await runDoctor(await healthyOptions({ run }));
    expect(report.frames.ok).toBe(false);
    expect(report.frames.detail).toMatch(/2304 bytes, not 4608/);
    expect(report.ok).toBe(false);
  });

  it("fails rather than throws when the frame test cannot be started", async () => {
    const run: ToolRunner = async (exe, args) => {
      if (isFrameTest(args)) throw new Error("spawn EACCES");
      return healthyRunner(exe, args);
    };
    const report = await runDoctor(await healthyOptions({ run }));
    expect(report.frames).toEqual({ ok: false, detail: "this ffmpeg could not decode a test frame: spawn EACCES" });
    expect(report.ok).toBe(false);
  });

  it("fails when a tool exits non-zero", async () => {
    const run: ToolRunner = async (exe, args) =>
      /mkvmerge(\.exe)?$/.test(exe)
        ? { code: 2, stdout: "", stderr: "boom" }
        : healthyRunner(exe, args);
    const report = await runDoctor(await healthyOptions({ run }));
    expect(report.tools[0]!.error).toMatch(/exited 2/);
    expect(report.ok).toBe(false);
  });

  it("reports an unwritable temp directory instead of throwing", async () => {
    const report = await runDoctor(
      await healthyOptions({ tempDir: "/nonexistent-scope-sub-doctor" }),
    );
    expect(report.tempDir.writable).toBe(false);
    expect(report.tempDir.error).toBeTruthy();
    expect(report.ok).toBe(false);
  });

  it("reports free space for a real temp directory", async () => {
    const report = await runDoctor(await healthyOptions());
    expect(report.tempDir.freeBytes).toBeGreaterThan(0);
    expect(report.tempDir.totalBytes).toBeGreaterThan(0);
  });

  it("honours SCOPE_SUB_MKVTOOLNIX_DIR and SCOPE_SUB_FFMPEG", async () => {
    const mkvDir = await stubBinDir(["mkvmerge", "mkvextract"]);
    const ffDir = await stubBinDir(["ffmpeg"]);
    const report = await runDoctor({
      env: {
        PATH: "/nonexistent-scope-sub",
        SCOPE_SUB_MKVTOOLNIX_DIR: mkvDir,
        // Without `.exe` on Windows too: the override accepts both.
        SCOPE_SUB_FFMPEG: join(ffDir, "ffmpeg"),
      },
      run: healthyRunner,
      nodeVersion: "v24.0.0",
    });
    expect(report.ok).toBe(true);
    expect(report.tools.every((t) => t.origin === "env")).toBe(true);
  });
});

describe.skipIf(!(await hasTool("ffmpeg")))("the frame test against the installed ffmpeg", () => {
  it("decodes the test frame, one whole 16-bit grey frame", async () => {
    // The whole environment: on Windows the search also reads Path, PATHEXT
    // and the Program Files variables.
    const report = await runDoctor({ env: process.env });
    expect(report.frames).toEqual({ ok: true, detail: "decodes a frame for measuring" });
  });
});

describe("formatDoctorReport", () => {
  it("prints one line per check and a verdict", async () => {
    const text = formatDoctorReport(await runDoctor(await healthyOptions()));
    for (const label of ["node", "mkvmerge", "mkvextract", "ffmpeg", "frames", "temp dir"]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("All checks passed.");
    expect(text).not.toContain("FAIL");
  });

  it("marks failures", async () => {
    const text = formatDoctorReport(
      await runDoctor(await healthyOptions({ nodeVersion: "v18.0.0" })),
    );
    expect(text).toMatch(/FAIL\s+node/);
  });
});

describe("runDoctorCommand", () => {
  function captureIo(): { io: CliIo; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { stdout: (t) => out.push(t), stderr: (t) => err.push(t) }, out, err };
  }

  it("exits 0 and prints a human report when healthy", async () => {
    const { io, out } = captureIo();
    const code = await runDoctorCommand({}, io, await healthyOptions());
    expect(code).toBe(DOCTOR_EXIT.OK);
    expect(out.join("")).toContain("All checks passed.");
  });

  it("exits 3 when something required is missing", async () => {
    const { io } = captureIo();
    const code = await runDoctorCommand(
      {},
      io,
      await healthyOptions({ nodeVersion: "v18.0.0" }),
    );
    expect(code).toBe(DOCTOR_EXIT.DEPENDENCY_MISSING);
  });

  it("emits parseable JSON with --format json", async () => {
    const { io, out } = captureIo();
    const code = await runDoctorCommand({ format: "json" }, io, await healthyOptions());
    expect(code).toBe(DOCTOR_EXIT.OK);
    const parsed = JSON.parse(out.join(""));
    expect(parsed.ok).toBe(true);
    expect(parsed.tools).toHaveLength(3);
    expect(parsed.tool.name).toBe("scope-sub");
  });

  it("rejects an unknown --format with exit 2", async () => {
    const { io, err } = captureIo();
    const code = await runDoctorCommand({ format: "yaml" }, io, await healthyOptions());
    expect(code).toBe(DOCTOR_EXIT.BAD_ARGS);
    expect(err.join("")).toMatch(/invalid --format/);
  });
});

describe("REQUIRED_NODE", () => {
  it("matches package.json engines.node", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(pkg.engines.node).toBe(`>=${REQUIRED_NODE}`);
  });
});
