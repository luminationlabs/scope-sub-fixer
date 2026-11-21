/**
 * `remargin`: titles a plan repaired with one margin are put back, analyzed
 * again and repaired again with another — and still revert to the original.
 */
import { createHash } from "node:crypto";
import { appendFile, chmod, copyFile, mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPlan } from "../../src/batch/apply.js";
import { redoIsDue, repairIsStale, runPlan } from "../../src/batch/plan.js";
import {
  PLACEMENT_RULES,
  readPatchFile,
  requirePlan,
  type PatchFile,
  type PlanFile,
  type PlanFileEntry,
} from "../../src/batch/planFile.js";
import { revertPlan } from "../../src/batch/revert.js";
import { runRemargin, surveyRemargin } from "../../src/cli/remargin.js";
import { verifyFile } from "../../src/verify/verifyFile.js";
import { activeAreaFromAspect } from "../../src/video/activeArea.js";
import {
  hasTool,
  makeLetterboxVideo,
  makeMkv,
  makeTempDir,
  removeDir,
  writeSup,
} from "../helpers/scanFixture.js";
import { SAFE_SPEC, SCOPE_SPEC } from "../batch/support.js";

const tools =
  (await hasTool("ffmpeg")) && (await hasTool("mkvmerge")) && (await hasTool("mkvextract"));

const ASPECT = 2.39;
const sha = async (path: string): Promise<string> =>
  createHash("sha256").update(await readFile(path)).digest("hex");

describe.skipIf(!tools)("remargin", () => {
  let dir: string;
  let library: string;
  let plan: string;
  let a: string;
  let b: string;
  let pristineA: string;
  let pristineB: string;
  const out: string[] = [];
  const io = { stdout: (t: string) => void out.push(t), stderr: () => undefined };
  const run = (execute: boolean): Promise<number> =>
    runRemargin([library], { plan, aspect: String(ASPECT), execute, logLevel: "error" }, io);

  beforeAll(async () => {
    dir = await makeTempDir();
    library = join(dir, "lib");
    plan = join(dir, "plan");
    await mkdir(library, { recursive: true });
    const video = await makeLetterboxVideo(join(dir, "video.mkv"), { activeHeight: 804, seconds: 8 });
    const scopeSup = await writeSup(join(dir, "scope.sup"), SCOPE_SPEC);
    const safeSup = await writeSup(join(dir, "safe.sup"), SAFE_SPEC);
    a = join(library, "A (2001).mkv");
    b = join(library, "B (2002).mkv");
    await makeMkv(a, video, scopeSup, { trackName: "English" });
    await makeMkv(b, video, scopeSup, { trackName: "English" });
    await makeMkv(join(library, "Safe (2003).mkv"), video, safeSup, { trackName: "English" });
    pristineA = join(dir, "A.pristine.mkv");
    pristineB = join(dir, "B.pristine.mkv");
    await copyFile(a, pristineA);
    await copyFile(b, pristineB);

    // A plan made under another default: margin 8, recorded as "the default".
    await runPlan([library], plan, { aspect: ASPECT, method: "patch", margin: 8 });
    const path = join(plan, "plan.json");
    const raw = JSON.parse(await readFile(path, "utf8")) as PlanFile;
    delete raw.options.margin;
    await writeFile(path, JSON.stringify(raw));
    // A is repaired in place; B is planned and left alone.
    const applied = await applyPlan(plan, { inPlace: true, execute: true, only: [a] });
    expect(applied.summary).toMatchObject({ applied: 1, failed: 0 });
  }, 300000);

  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  it("changes nothing on a dry run, and says what it would do", async () => {
    const before = await sha(a);
    expect(await run(false)).toBe(0);
    expect(await sha(a)).toBe(before);
    const text = out.join("");
    expect(text).toMatch(/1 title fixed in place/);
    expect(text).toMatch(/A \(2001\)\.mkv/);
    expect(text).toMatch(/1 title planned but not fixed/);
    expect(text).toMatch(/Dry run: no files were modified/);
  }, 120000);

  it("redoes the repaired title with the new margin, replans the unrepaired one, and keeps the old undo record", async () => {
    const oldPatch = (await requirePlan(plan)).files.find((f) => f.input === a)!.patchFile!;
    out.length = 0;
    expect(await run(true)).toBe(0);
    expect(out.join("")).toMatch(/1 title fixed again/);

    const after = await requirePlan(plan);
    const entryA = after.files.find((f) => f.input === a)!;
    const entryB = after.files.find((f) => f.input === b)!;
    expect(entryA.action).toBe("fix");
    expect(entryA.patchFile).not.toBe(oldPatch);
    expect(await readdir(join(plan, "patches"))).toContain(oldPatch.replace("patches/", ""));
    expect((await readPatchFile(plan, entryA.patchFile!)).tracks[0]!.margin).toBe(24);
    expect((await readPatchFile(plan, entryB.patchFile!)).tracks[0]!.margin).toBe(24);

    // A is repaired, differing from the original only in position fields, and
    // by more than before; B was never touched.
    const report = await verifyFile(pristineA, a, { aspect: ASPECT });
    expect(report.pass).toBe(true);
    expect(await sha(b)).toBe(await sha(pristineB));
    const oldMoves = (await readPatchFile(plan, oldPatch)).tracks[0]!.moves;
    const newMoves = (await readPatchFile(plan, entryA.patchFile!)).tracks[0]!.moves;
    expect(JSON.stringify(newMoves)).not.toBe(JSON.stringify(oldMoves));
  }, 300000);

  it("finishes a run that was stopped after putting a title back", async () => {
    // A second plan, repaired with margin 8, then only the first step done.
    const plan2 = join(dir, "plan2");
    const lib2 = join(dir, "lib2");
    await mkdir(lib2, { recursive: true });
    const c = join(lib2, "C (2004).mkv");
    await copyFile(pristineA, c);
    await runPlan([lib2], plan2, { aspect: ASPECT, method: "patch", margin: 8 });
    const path = join(plan2, "plan.json");
    const raw = JSON.parse(await readFile(path, "utf8")) as PlanFile;
    delete raw.options.margin;
    await writeFile(path, JSON.stringify(raw));
    await applyPlan(plan2, { inPlace: true, execute: true, only: [c] });
    await revertPlan(plan2, { inPlace: true, execute: true, only: [c] });
    expect(await sha(c)).toBe(await sha(pristineA));

    const code = await runRemargin([lib2], { plan: plan2, aspect: String(ASPECT), execute: true, logLevel: "error" }, io);
    expect(code).toBe(0);
    const entry = (await requirePlan(plan2)).files[0]!;
    expect((await readPatchFile(plan2, entry.patchFile!)).tracks[0]!.margin).toBe(24);
    expect((await verifyFile(pristineA, c, { aspect: ASPECT })).pass).toBe(true);
    expect(await sha(c)).not.toBe(await sha(pristineA));
  }, 300000);

  /** A fresh library and plan with one title repaired in place at margin 8. */
  const oldPlan = async (name: string, aspect: number | "auto" = ASPECT): Promise<{ lib: string; plan: string; file: string }> => {
    const lib = join(dir, `${name}-lib`);
    const planDir = join(dir, `${name}-plan`);
    await mkdir(join(lib, "Sub"), { recursive: true });
    const file = join(lib, "Sub", "D (2005).mkv");
    await copyFile(pristineA, file);
    await runPlan([lib], planDir, { aspect, method: "patch", margin: 8, recursive: true });
    const path = join(planDir, "plan.json");
    const raw = JSON.parse(await readFile(path, "utf8")) as PlanFile;
    delete raw.options.margin;
    await writeFile(path, JSON.stringify(raw));
    const applied = await applyPlan(planDir, { inPlace: true, execute: true, only: [file] });
    expect(applied.summary).toMatchObject({ applied: 1, failed: 0 });
    return { lib, plan: planDir, file };
  };

  it("refuses before touching a file when the run could not extend the plan or reach the title", async () => {
    const f = await oldPlan("refuse");
    const repaired = await sha(f.file);
    // Another margin than the plan's: the plan would refuse the analysis.
    expect(
      await runRemargin([f.lib], { plan: f.plan, aspect: String(ASPECT), margin: "30", recursive: true, execute: true, logLevel: "error" }, io),
    ).toBe(2);
    expect(await sha(f.file)).toBe(repaired);
    // Without --recursive the title in a subfolder is not reached: left alone, and said.
    out.length = 0;
    expect(
      await runRemargin([f.lib], { plan: f.plan, aspect: String(ASPECT), execute: true, logLevel: "error" }, io),
    ).not.toBe(0);
    expect(out.join("")).toMatch(/not found under/);
    expect(await sha(f.file)).toBe(repaired);
  }, 300000);

  it("redoes a title whose timestamp moved after it was put back", async () => {
    const f = await oldPlan("touched");
    await revertPlan(f.plan, { inPlace: true, execute: true, only: [f.file] });
    const info = await stat(f.file);
    await utimes(f.file, info.atime, new Date(info.mtimeMs + 5000));
    expect(
      await runRemargin([f.lib], { plan: f.plan, aspect: String(ASPECT), recursive: true, execute: true, logLevel: "error" }, io),
    ).toBe(0);
    const entry = (await requirePlan(f.plan)).files.find((e) => e.input === f.file)!;
    expect((await readPatchFile(f.plan, entry.patchFile!)).tracks[0]!.margin).toBe(24);
    expect((await verifyFile(pristineA, f.file, { aspect: ASPECT })).pass).toBe(true);
    expect(await sha(f.file)).not.toBe(await sha(pristineA));
  }, 300000);

  it("keeps the repair the plan has when the new analysis would not repair the title", async () => {
    const f = await oldPlan("worse", "auto");
    const before = (await requirePlan(f.plan)).files.find((e) => e.input === f.file)!;
    await revertPlan(f.plan, { inPlace: true, execute: true, only: [f.file] });
    // The picture is measured as full-frame this time: nothing to repair.
    const again = await runPlan(
      [f.lib],
      f.plan,
      { aspect: "auto", method: "patch", recursive: true, remargin: true },
      { detectActiveArea: async () => activeAreaFromAspect(1920, 1080, 16 / 9) },
    );
    expect(again.remargined).toEqual([]);
    expect(again.remarginKept.map((k) => k.input)).toEqual([f.file]);
    const entry = again.plan.files.find((e) => e.input === f.file)!;
    expect(entry.action).toBe("fix");
    expect(entry.patchFile).toBe(before.patchFile);
    expect(entry.redo_tried).toMatchObject({ margin: null, rules: PLACEMENT_RULES });
    // Stopped here, the title is put back and not repaired: the next run must
    // still pick it up, to write its old repair back.
    const stopped = await surveyRemargin(f.plan, again.plan, undefined);
    expect(stopped.repaired.map((e) => e.input)).toEqual([f.file]);
    // …so the title can still be repaired, as it was.
    const applied = await applyPlan(f.plan, { inPlace: true, execute: true, only: [f.file] });
    expect(applied.summary).toMatchObject({ applied: 1, failed: 0 });
    expect((await verifyFile(pristineA, f.file, { aspect: ASPECT, margin: 8 })).pass).toBe(true);
    // Tried and kept: the same redo is not tried again, another margin is.
    const after = await requirePlan(f.plan);
    expect((await surveyRemargin(f.plan, after, undefined)).repaired).toEqual([]);
    expect((await surveyRemargin(f.plan, after, 16)).repaired.map((e) => e.input)).toEqual([f.file]);
  }, 300000);

  it("finishes a title an earlier run had analyzed again and not yet repaired", async () => {
    const f = await oldPlan("half");
    await revertPlan(f.plan, { inPlace: true, execute: true, only: [f.file] });
    await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch", recursive: true, remargin: true });
    expect(await sha(f.file)).toBe(await sha(pristineA));
    out.length = 0;
    expect(
      await runRemargin([f.lib], { plan: f.plan, aspect: String(ASPECT), recursive: true, execute: true, logLevel: "error" }, io),
    ).toBe(0);
    expect(out.join("")).toMatch(/1 title fixed again/);
    expect((await verifyFile(pristineA, f.file, { aspect: ASPECT })).pass).toBe(true);
    expect(await sha(f.file)).not.toBe(await sha(pristineA));
  }, 300000);

  it("finishes an interrupted in-place write first, then redoes the title", async () => {
    const f = await oldPlan("open");
    // As a run killed right after its last byte leaves the log: started, no finish.
    await appendFile(
      join(f.plan, "apply.log.jsonl"),
      `${JSON.stringify({ time: new Date().toISOString(), event: "started", input: f.file, output: f.file, method: "patch", inPlace: true })}\n`,
    );
    out.length = 0;
    expect(
      await runRemargin([f.lib], { plan: f.plan, aspect: String(ASPECT), recursive: true, execute: true, logLevel: "error" }, io),
    ).toBe(0);
    expect(out.join("")).toMatch(/Finishing 1 interrupted write/);
    const entry = (await requirePlan(f.plan)).files.find((e) => e.input === f.file)!;
    expect((await readPatchFile(f.plan, entry.patchFile!)).tracks[0]!.margin).toBe(24);
    expect((await verifyFile(pristineA, f.file, { aspect: ASPECT })).pass).toBe(true);
  }, 300000);

  // The failing mkvmerge is a shell script, which Windows cannot run.
  it.skipIf(process.platform === "win32")("says a title was kept, not redone, when it could not be analyzed again", async () => {
    const f = await oldPlan("unreadable");
    const repaired = await sha(f.file);
    // An mkvmerge that answers --version and fails everything else, as a
    // share that hiccups during the header read would make it.
    const bin = join(dir, "broken-tools");
    await mkdir(bin, { recursive: true });
    const { locateTool, clearToolCache } = await import("../../src/tools/locate.js");
    const real = locateTool("mkvmerge")!.path;
    const realExtract = locateTool("mkvextract")!.path;
    await writeFile(
      join(bin, "mkvmerge"),
      `#!/bin/sh\ncase "$1" in --version|-V) exec "${real}" "$@";; esac\necho "simulated failure" >&2\nexit 2\n`,
    );
    await writeFile(join(bin, "mkvextract"), `#!/bin/sh\nexec "${realExtract}" "$@"\n`);
    await chmod(join(bin, "mkvmerge"), 0o755);
    await chmod(join(bin, "mkvextract"), 0o755);
    const before = process.env["SCOPE_SUB_MKVTOOLNIX_DIR"];
    process.env["SCOPE_SUB_MKVTOOLNIX_DIR"] = bin;
    clearToolCache();
    out.length = 0;
    let code: number;
    try {
      code = await runRemargin(
        [f.lib],
        { plan: f.plan, aspect: String(ASPECT), recursive: true, execute: true, logLevel: "error" },
        io,
      );
    } finally {
      if (before === undefined) delete process.env["SCOPE_SUB_MKVTOOLNIX_DIR"];
      else process.env["SCOPE_SUB_MKVTOOLNIX_DIR"] = before;
      clearToolCache();
    }
    const text = out.join("");
    expect(code, text).not.toBe(0);
    expect(text).not.toMatch(/1 title fixed again/);
    // Whatever it could do, the title is not left unrepaired and not half done.
    const entry = (await requirePlan(f.plan)).files.find((e) => e.input === f.file)!;
    expect((await readPatchFile(f.plan, entry.patchFile!)).tracks[0]!.margin).toBe(8);
    const state = await sha(f.file);
    expect([repaired, await sha(pristineA)]).toContain(state);
    if (state === repaired) expect(text).toMatch(/fixed as before|kept as before/);
    else expect(text).toMatch(/NOT fixed again/);
  }, 300000);

  it("has nothing left to redo, and the redone title still reverts to the original", async () => {
    out.length = 0;
    expect(await run(true)).toBe(0);
    expect(out.join("")).toMatch(/Nothing to redo/);

    const reverted = await revertPlan(plan, { inPlace: true, execute: true, only: [a] });
    expect(reverted.summary).toMatchObject({ failed: 0 });
    expect(await sha(a)).toBe(await sha(pristineA));

    // Put back on purpose: it is the owner's to leave that way.
    out.length = 0;
    expect(await run(true)).toBe(0);
    expect(out.join("")).toMatch(/Nothing to redo/);
    expect(await sha(a)).toBe(await sha(pristineA));
  }, 300000);
});

describe("repairIsStale", () => {
  const file = (margin: number, left: number, rules?: number): PatchFile =>
    ({
      ...(rules === undefined ? {} : { placement_rules: rules }),
      tracks: [{ margin, canvas: { width: 1920, height: 1080 }, expected_offending_after: left }],
    }) as unknown as PatchFile;

  it("is a repair made with another margin", () => {
    expect(repairIsStale(file(8, 0), undefined)).toBe(true);
    expect(repairIsStale(file(24, 0), undefined)).toBe(false);
    expect(repairIsStale(file(24, 0), 8)).toBe(true);
  });

  it("is a repair that left subtitles outside under older placement rules, once", () => {
    const older = PLACEMENT_RULES - 1;
    expect(repairIsStale(file(24, 3, older), undefined)).toBe(true);
    // Nothing left outside: nothing for newer rules to move.
    expect(repairIsStale(file(24, 0, older), undefined)).toBe(false);
    // Made under the current rules and still some outside: nothing more to try.
    expect(repairIsStale(file(24, 3, PLACEMENT_RULES), undefined)).toBe(false);
    // A patch file without the field is generation 1.
    expect(repairIsStale(file(24, 3), undefined)).toBe(PLACEMENT_RULES > 1);
  });

  it("is due once for each margin and placement generation", () => {
    const entry = (tried?: { margin: number | null; rules: number }): PlanFileEntry =>
      ({
        tracks: [{ action: "fix" }],
        ...(tried === undefined ? {} : { redo_tried: { ...tried, at: "" } }),
      }) as unknown as PlanFileEntry;
    expect(redoIsDue(entry(), file(8, 0, PLACEMENT_RULES), undefined)).toBe(true);
    expect(redoIsDue(entry(), file(24, 0, PLACEMENT_RULES), undefined)).toBe(false);
    // Tried with this margin under these rules and kept: not again.
    expect(redoIsDue(entry({ margin: null, rules: PLACEMENT_RULES }), file(8, 0, PLACEMENT_RULES), undefined)).toBe(false);
    // Another margin asked for, or newer rules since the try: due again.
    expect(redoIsDue(entry({ margin: null, rules: PLACEMENT_RULES }), file(8, 0, PLACEMENT_RULES), 12)).toBe(true);
    expect(redoIsDue(entry({ margin: null, rules: PLACEMENT_RULES - 1 }), file(8, 0, PLACEMENT_RULES), undefined)).toBe(true);
  });
});

