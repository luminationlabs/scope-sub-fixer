/**
 * Tools chosen by hand: `configure`, what it does to the environment the tool
 * search reads, and what `doctor` says when a choice does not hold a working
 * tool. The "tools" are stub scripts; nothing real is run.
 */
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDoctor, TEST_FRAME_BYTES, type DoctorReport, type ToolRunner } from "../../src/cli/doctor.js";
import { doctorProblems, doctorResult, METHODS } from "../../src/serve/protocol.js";
import { parseConfigureParams, RequestError, type EngineDeps } from "../../src/serve/server.js";
import { applyChoices, choiceProblems, mkvtoolnixSearchDir } from "../../src/serve/tools.js";
import { locateTool, type ToolEnv } from "../../src/tools/locate.js";
import { startClient } from "./harness.js";

// POSIX-only: the stubs are named the POSIX way (no `.exe`) and "not a program"
// is the missing execute bit, which Windows does not have. The Windows search
// itself is covered with a fake file system in test/tools/locate.test.ts.
const posixOnly = describe.skipIf(process.platform === "win32");

let dir: string;
/** A folder with both MKVToolNix programs. */
let mkvDir: string;
/** A Mac app bundle with them inside. */
let bundle: string;
/** A folder with only mkvmerge. */
let halfDir: string;
let ffmpeg: string;
let notAProgram: string;
/** Where the "automatic search" finds its own copies. */
let pathDir: string;

async function stub(path: string, mode = 0o755): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, mode);
  return path;
}

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "scope-sub-tools-")));
  mkvDir = join(dir, "mkv");
  await stub(join(mkvDir, "mkvmerge"));
  await stub(join(mkvDir, "mkvextract"));
  bundle = join(dir, "MKVToolNix-97.0.app");
  await stub(join(bundle, "Contents", "MacOS", "mkvmerge"));
  await stub(join(bundle, "Contents", "MacOS", "mkvextract"));
  halfDir = join(dir, "half");
  await stub(join(halfDir, "mkvmerge"));
  ffmpeg = await stub(join(dir, "builds", "ffmpeg"));
  notAProgram = await stub(join(dir, "notes.txt"), 0o644);
  pathDir = join(dir, "onpath");
  for (const name of ["mkvmerge", "mkvextract", "ffmpeg"]) await stub(join(pathDir, name));
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Every stub "runs": answers its version, and ffmpeg decodes the test frame. */
const runs: ToolRunner = async (exe, args) =>
  args.includes("lavfi")
    ? { code: 0, stdout: "", stderr: "", stdoutBytes: TEST_FRAME_BYTES }
    : { code: 0, stdout: `${exe} version 1\n`, stderr: "" };

const doctor = (env: ToolEnv, run: ToolRunner = runs): Promise<DoctorReport> =>
  runDoctor({ env, run, tempDir: dir, nodeVersion: "v24.0.0" });

posixOnly("mkvtoolnixSearchDir", () => {
  it("takes the folder, the program inside it, or the Mac app, as the same folder", () => {
    expect(mkvtoolnixSearchDir(mkvDir)).toBe(mkvDir);
    expect(mkvtoolnixSearchDir(join(mkvDir, "mkvmerge"))).toBe(mkvDir);
    expect(mkvtoolnixSearchDir(bundle)).toBe(join(bundle, "Contents", "MacOS"));
  });
  it("leaves anything else as it is, to be found wanting", () => {
    expect(mkvtoolnixSearchDir(join(dir, "nowhere"))).toBe(join(dir, "nowhere"));
    expect(mkvtoolnixSearchDir(join(dir, "builds"))).toBe(join(dir, "builds"));
  });
});

posixOnly("applyChoices", () => {
  it("sets the overrides the tool search reads, and clears the ones not chosen", () => {
    const env: ToolEnv = { PATH: "", SCOPE_SUB_FFMPEG: "/left/over" };
    applyChoices(env, { mkvtoolnixDir: bundle });
    expect(env["SCOPE_SUB_MKVTOOLNIX_DIR"]).toBe(join(bundle, "Contents", "MacOS"));
    expect(env["SCOPE_SUB_FFMPEG"]).toBeUndefined();
    expect(locateTool("mkvextract", env, [])).toMatchObject({ origin: "env" });
    applyChoices(env, { ffmpeg });
    expect(env["SCOPE_SUB_MKVTOOLNIX_DIR"]).toBeUndefined();
    expect(locateTool("ffmpeg", env, [])).toEqual({ tool: "ffmpeg", path: ffmpeg, origin: "env" });
  });
});

posixOnly("what doctor says about a choice", () => {
  it("nothing, when the chosen tools are the ones in use and they work", async () => {
    const env: ToolEnv = { PATH: "" };
    const chosen = { mkvtoolnixDir: mkvDir, ffmpeg };
    applyChoices(env, chosen);
    const report = await doctor(env);
    expect(choiceProblems(report, chosen)).toEqual([]);
    const result = doctorResult(report, chosen);
    expect(result.ok).toBe(true);
    expect(result.chosen).toEqual(chosen);
    expect(report.tools.every((t) => t.origin === "env")).toBe(true);
  });

  it("names the program a chosen folder lacks — even when the search found it elsewhere", async () => {
    const env: ToolEnv = { PATH: pathDir };
    const chosen = { mkvtoolnixDir: halfDir };
    applyChoices(env, chosen);
    const report = await doctor(env);
    // The search fell back to the copy on PATH, so the report alone is fine…
    expect(report.ok).toBe(true);
    // …and the choice is still reported, not passed over.
    const result = doctorResult(report, chosen);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ locate: "mkvtoolnix", what: "mkvextract" });
    expect(result.problems[0]!.message).toBe(
      `The selected MKVToolNix folder (${halfDir}) does not contain mkvextract.`,
    );
    expect(result.problems[0]!.fix).toMatch(/both mkvmerge and mkvextract/);
  });

  it("says one thing, in the user's terms, about a folder that holds neither", async () => {
    const env: ToolEnv = { PATH: "" };
    const chosen = { mkvtoolnixDir: join(dir, "builds") };
    applyChoices(env, chosen);
    const problems = doctorProblems(await doctor(env), chosen);
    const mkv = problems.filter((p) => p.locate === "mkvtoolnix");
    expect(mkv).toHaveLength(1);
    expect(mkv[0]!.message).toMatch(/^The selected MKVToolNix folder \(.*\) does not contain mkvmerge or mkvextract\.$/);
    expect(problems.some((p) => /was not found/.test(p.message) && p.locate === "mkvtoolnix")).toBe(false);
  });

  it("reports a chosen file that is missing, or not a program", async () => {
    for (const bad of [join(dir, "gone", "ffmpeg"), notAProgram]) {
      const env: ToolEnv = { PATH: pathDir };
      const chosen = { ffmpeg: bad };
      applyChoices(env, chosen);
      const result = doctorResult(await doctor(env), chosen);
      expect(result.ok).toBe(false);
      expect(result.problems).toHaveLength(1);
      expect(result.problems[0]).toMatchObject({ locate: "ffmpeg", what: "ffmpeg" });
      expect(result.problems[0]!.message).toBe(`The selected FFmpeg (${bad}) was not found or is not an executable.`);
      expect(result.problems[0]!.fix).toMatch(/ffmpeg\.exe on Windows/);
    }
  });

  it("reports a chosen program that will not run, and one that cannot read video frames", async () => {
    const env: ToolEnv = { PATH: "" };
    const chosen = { mkvtoolnixDir: mkvDir, ffmpeg };
    applyChoices(env, chosen);
    const failing: ToolRunner = async (exe, args) =>
      exe === ffmpeg ? { code: 126, stdout: "", stderr: "" } : runs(exe, args);
    const wontRun = doctorResult(await doctor(env, failing), chosen);
    expect(wontRun.ok).toBe(false);
    expect(wontRun.problems.map((p) => p.message).join("\n")).toMatch(/^The selected FFmpeg \(.*\) could not be run \(/);

    const throwing: ToolRunner = async (exe, args) => {
      if (exe.startsWith(mkvDir)) throw new Error("spawn EACCES");
      return runs(exe, args);
    };
    const crashed = doctorResult(await doctor(env, throwing), chosen);
    expect(crashed.problems.map((p) => p.message).join("\n")).toMatch(
      /mkvmerge in the selected MKVToolNix folder .* could not be run \(spawn EACCES\)/,
    );

    const noLavfi: ToolRunner = async (exe, args) =>
      args.includes("lavfi")
        ? { code: 1, stdout: "", stderr: "Unknown input format: 'lavfi'\n", stdoutBytes: 0 }
        : runs(exe, args);
    const noFrames = doctorResult(await doctor(env, noLavfi), chosen);
    expect(noFrames.ok).toBe(false);
    expect(noFrames.problems).toHaveLength(1);
    expect(noFrames.problems[0]).toMatchObject({ locate: "ffmpeg", what: "frames" });
    expect(noFrames.problems[0]!.message).toBe(
      `The selected FFmpeg (${ffmpeg}) cannot decode video ` +
        "(this ffmpeg could not decode a test frame: Unknown input format: 'lavfi').",
    );
  });

  it("offers choosing by hand beside a tool that simply was not found", async () => {
    const problems = doctorProblems(await doctor({ PATH: "" }));
    // Whatever this machine has in the extra directories, the shape holds.
    for (const p of problems.filter((x) => x.what !== "temp" && x.what !== "runtime")) {
      expect(["mkvtoolnix", "ffmpeg"]).toContain(p.locate);
    }
  });
});

posixOnly("configure", () => {
  it("is announced, and its params are checked", () => {
    expect(METHODS).toContain("configure");
    expect(parseConfigureParams({ tools: {} })).toEqual({});
    expect(parseConfigureParams({ tools: { mkvtoolnixDir: "/a", ffmpeg: null } })).toEqual({ mkvtoolnixDir: "/a" });
    for (const bad of [undefined, {}, { tools: "x" }, { tools: { ffmpeg: 3 } }, { tools: { mkvtoolnixDir: " " } }]) {
      expect(() => parseConfigureParams(bad)).toThrow(RequestError);
    }
  });

  const engine = (env: ToolEnv, overrides: Partial<EngineDeps> = {}): EngineDeps => ({
    runDoctor: (options) => runDoctor({ ...options, run: runs, tempDir: dir, nodeVersion: "v24.0.0" }),
    runPlan: (() => {
      throw new Error("not expected");
    }) as unknown as EngineDeps["runPlan"],
    applyPlan: (() => {
      throw new Error("not expected");
    }) as unknown as EngineDeps["applyPlan"],
    env,
    ...overrides,
  });

  it("makes every later doctor use the chosen tools, replaces the choice whole, and clears it", async () => {
    const env: ToolEnv = { PATH: pathDir };
    const c = startClient(engine(env));

    const before = await c.request("doctor");
    expect(before.result.chosen).toEqual({});
    expect(before.result.report.tools.map((t: { origin: string }) => t.origin)).toEqual(["path", "path", "path"]);

    const set = await c.request("configure", { tools: { mkvtoolnixDir: bundle, ffmpeg } });
    expect(set.result).toEqual({ tools: { mkvtoolnixDir: bundle, ffmpeg } });
    const after = await c.request("doctor");
    expect(after.result.ok).toBe(true);
    expect(after.result.chosen).toEqual({ mkvtoolnixDir: bundle, ffmpeg });
    expect(after.result.report.tools.map((t: { path: string }) => t.path)).toEqual([
      join(bundle, "Contents", "MacOS", "mkvmerge"),
      join(bundle, "Contents", "MacOS", "mkvextract"),
      ffmpeg,
    ]);

    // Each call is the whole choice: leaving ffmpeg out goes back to the search for it.
    await c.request("configure", { tools: { mkvtoolnixDir: mkvDir } });
    const mixed = await c.request("doctor");
    expect(mixed.result.report.tools.map((t: { origin: string }) => t.origin)).toEqual(["env", "env", "path"]);

    await c.request("configure", { tools: { mkvtoolnixDir: null } });
    const cleared = await c.request("doctor");
    expect(cleared.result.chosen).toEqual({});
    expect(cleared.result.report.tools.map((t: { origin: string }) => t.origin)).toEqual(["path", "path", "path"]);
    expect(env["SCOPE_SUB_MKVTOOLNIX_DIR"]).toBeUndefined();
    await c.close();
  });

  it("reports a bad choice through doctor instead of refusing or ignoring it", async () => {
    const env: ToolEnv = { PATH: pathDir };
    const c = startClient(engine(env));
    const set = await c.request("configure", { tools: { ffmpeg: join(dir, "nowhere", "ffmpeg.exe") } });
    expect(set.error).toBeUndefined();
    const r = await c.request("doctor");
    expect(r.result.ok).toBe(false);
    expect(r.result.problems).toHaveLength(1);
    expect(r.result.problems[0].locate).toBe("ffmpeg");
    expect((await c.request("configure", { tools: { ffmpeg: 7 } })).error!.code).toBe("bad-request");
    await c.close();
  });

  it("answers each doctor about the choice it was asked under, even with a configure right behind it", async () => {
    const env: ToolEnv = { PATH: pathDir };
    const c = startClient(engine(env));
    // All four lines are in the pipe before the first is read.
    c.post("configure", { tools: { mkvtoolnixDir: halfDir } });
    const first = c.post("doctor");
    c.post("configure", { tools: {} });
    const second = c.post("doctor");
    const a = await c.waitFor((m) => m.id === first && m.result !== undefined);
    const b = await c.waitFor((m) => m.id === second && m.result !== undefined);
    expect(a.result.chosen).toEqual({ mkvtoolnixDir: halfDir });
    expect(a.result.ok).toBe(false);
    expect(a.result.report.tools.map((t: { origin: string }) => t.origin)).toEqual(["env", "path", "path"]);
    expect(b.result.chosen).toEqual({});
    expect(b.result.ok).toBe(true);
    await c.close();
  });

  it("is refused while a scan or a fix is running", async () => {
    const env: ToolEnv = { PATH: pathDir };
    let release: () => void = () => undefined;
    // Resolved when the scan is really running: a fixed pause was a race
    // the scan lost on a loaded machine.
    let entered: () => void = () => undefined;
    const running = new Promise<void>((r) => (entered = r));
    const c = startClient(
      engine(env, {
        runPlan: (async () => {
          entered();
          await new Promise<void>((r) => (release = r));
          return { dir: "/nonexistent-plan-dir-for-test", plan: { files: [] }, notFound: [], missingPaths: [], unreadable: [] };
        }) as unknown as EngineDeps["runPlan"],
      }),
    );
    const job = c.post("plan", { paths: ["/nonexistent-lib"], planDir: "/nonexistent-plan-dir-for-test" });
    await running;
    const refused = await c.request("configure", { tools: { ffmpeg } });
    expect(refused.error!.code).toBe("busy");
    expect(env["SCOPE_SUB_FFMPEG"]).toBeUndefined();
    release();
    await c.waitFor((m) => m.id === job && (m.result ?? m.error) !== undefined);
    expect((await c.request("configure", { tools: { ffmpeg } })).error).toBeUndefined();
    expect(env["SCOPE_SUB_FFMPEG"]).toBe(ffmpeg);
    await c.close();
  });
});
