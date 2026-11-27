/**
 * Regression tests for the ways a kept plan directory could lose an undo
 * record, a verdict or a title: interrupted runs, a share that drops, a
 * restored backup, a copy elsewhere, an output folder that cannot be made.
 * Real MKVs built with ffmpeg + mkvmerge; skipped when the tools are missing.
 */
import { execFile } from "node:child_process";
import { renameSync } from "node:fs";
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPlan } from "../../src/batch/apply.js";
import { appendApplyLog, readApplyLog } from "../../src/batch/log.js";
import { runPlan } from "../../src/batch/plan.js";
import { decodePatches, planPaths, readPatchFile, requirePlan } from "../../src/batch/planFile.js";
import { revertPlan, writePatchesInPlace } from "../../src/batch/revert.js";
import { hashFileChunked, partialPathFor } from "../../src/fix/copyPatch.js";
import { formatPlanJson, formatPlanReport } from "../../src/cli/plan.js";
import { runReview } from "../../src/cli/review.js";
import { scanFile } from "../../src/scan/scanFile.js";
import {
  hasTool,
  makeLetterboxVideo,
  makeMkv,
  makeTempDir,
  removeDir,
  writeSup,
} from "../helpers/scanFixture.js";
import { SCOPE_SPEC, SAFE_SPEC } from "./support.js";

const tools =
  (await hasTool("ffmpeg")) && (await hasTool("mkvmerge")) && (await hasTool("mkvextract"));
const propedit = tools && (await hasTool("mkvpropedit"));

const ASPECT = 2.39;
const OPTIONS = { aspect: ASPECT, method: "patch" as const, recursive: true };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function io() {
  const out: string[] = [];
  return {
    text: () => out.join(""),
    io: { stdout: (t: string) => out.push(t), stderr: () => undefined },
  };
}

describe.skipIf(!tools)("a kept plan directory survives what goes wrong around it", () => {
  let dir: string;
  let library: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    library = join(dir, "library");
    await mkdir(join(library, "sub"), { recursive: true });
    const video = await makeLetterboxVideo(join(dir, "video.mkv"), {
      activeHeight: 804,
      seconds: 8,
    });
    // Another length, so a "re-rip" of a title is another size.
    await makeLetterboxVideo(join(dir, "video2.mkv"), { activeHeight: 804, seconds: 12 });
    const scopeSup = await writeSup(join(dir, "scope.sup"), SCOPE_SPEC);
    const safeSup = await writeSup(join(dir, "safe.sup"), SAFE_SPEC);
    await makeMkv(join(library, "A Scope.mkv"), video, scopeSup);
    await makeMkv(join(library, "B Safe.mkv"), video, safeSup);
    await makeMkv(join(library, "sub", "C Scope.mkv"), video, scopeSup);
  }, 300000);

  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  /** A fresh copy of the library and a plan of it. */
  async function fixture(name: string) {
    const lib = join(dir, `lib-${name}`);
    await cp(library, lib, { recursive: true });
    const plan = join(dir, `plan-${name}`);
    const run = await runPlan([lib], plan, OPTIONS);
    const a = join(lib, "A Scope.mkv");
    const c = join(lib, "sub", "C Scope.mkv");
    const entryOf = (input: string) => run.plan.files.find((f) => f.input === input)!;
    return { lib, plan, a, b: join(lib, "B Safe.mkv"), c, entryA: entryOf(a), entryC: entryOf(c) };
  }

  /** Replace `path` with a different mux of the same title: another size, still needs fixing. */
  async function reRip(path: string): Promise<void> {
    await makeMkv(path, join(dir, "video2.mkv"), join(dir, "scope.sup"));
  }

  // --- patch file names -----------------------------------------------------

  it("does not hand a superseded entry's patch file name to the run after an interrupted one", async () => {
    const f = await fixture("superseded-killed");
    expect((await applyPlan(f.plan, { inPlace: true, execute: true, only: [f.a] })).exitCode).toBe(0);
    const oldName = f.entryA.patchFile!;
    const oldBytes = await readFile(join(f.plan, oldName));
    await reRip(f.a);

    // Interrupted while the new file is being analyzed: a cancel here, and a
    // kill leaves the same thing — `superseded` in the log, the old entry in
    // plan.json.
    const stop = new AbortController();
    const cut = await runPlan([f.lib], f.plan, OPTIONS, {
      signal: stop.signal,
      onProgress: (p) => {
        if (p.type === "file-progress" && p.file === f.a) stop.abort();
      },
    });
    expect(cut.cancelled).toBe(true);
    expect((await readApplyLog(planPaths(f.plan).applyLog)).at(-1)).toMatchObject({
      event: "superseded",
      input: f.a,
    });
    expect((await requirePlan(f.plan)).files.find((e) => e.input === f.a)!.patchFile).toBe(oldName);

    const next = await runPlan([f.lib], f.plan, OPTIONS);
    const entry = next.plan.files.find((e) => e.input === f.a)!;
    expect(entry.action).toBe("fix");
    expect(entry.patchFile).not.toBe(oldName);
    expect(entry.notes!.join(" ")).toContain(oldName);
    expect(await readFile(join(f.plan, oldName))).toEqual(oldBytes);

    // And it stays that way: the note survives, the old file is never reused.
    const settled = await runPlan([f.lib], f.plan, OPTIONS);
    expect(settled.analyzed).toBe(0);
    expect(await readFile(join(f.plan, oldName))).toEqual(oldBytes);
  }, 300000);

  it("keeps the patch file of a copy verified elsewhere when its input is replaced", async () => {
    const f = await fixture("copy-rerip");
    const out = join(dir, "out-copy-rerip");
    expect((await applyPlan(f.plan, { outputRoot: out, execute: true, only: [f.a] })).exitCode).toBe(0);
    const oldName = f.entryA.patchFile!;
    const oldBytes = await readFile(join(f.plan, oldName));
    await reRip(f.a);

    const run = await runPlan([f.lib], f.plan, OPTIONS);
    expect(run.analyzedFiles).toEqual([f.a]);
    const entry = run.plan.files.find((e) => e.input === f.a)!;
    expect(entry.patchFile).toBeDefined();
    expect(entry.patchFile).not.toBe(oldName);
    expect(entry.notes!.join(" ")).toContain(oldName);
    // The copy's undo record is exactly what it was.
    expect(await readFile(join(f.plan, oldName))).toEqual(oldBytes);
  }, 300000);

  it("still reuses a patch file name for a title the apply log has never mentioned", async () => {
    const f = await fixture("reuse-name");
    await reRip(f.a);
    const run = await runPlan([f.lib], f.plan, OPTIONS);
    expect(run.plan.files.find((e) => e.input === f.a)!.patchFile).toBe(f.entryA.patchFile);
    expect((await readdir(planPaths(f.plan).patchDir)).sort()).toEqual(["1.json", "2.json"]);
  }, 300000);

  // --- a title that cannot be read ------------------------------------------

  it("keeps every verdict when the library vanishes mid-run, and says which titles it could not read", async () => {
    const f = await fixture("vanish");
    const before = await requirePlan(f.plan);
    const gone = `${f.lib}.gone`;

    // The share drops after the directory was listed: every file fails.
    const run = await runPlan([f.lib], f.plan, OPTIONS, {
      onProgress: (p) => {
        if (p.type === "targets") renameSync(f.lib, gone);
      },
    });
    await rename(gone, f.lib);
    expect(run.unreadable.sort()).toEqual([f.a, f.b, f.c].sort());
    expect(run.analyzedFiles).toEqual([]);
    const strip = (files: typeof before.files) => files.map(({ root: _r, ...e }) => e);
    expect(strip(run.plan.files)).toEqual(strip(before.files));
    expect(formatPlanReport(run)).toMatch(/3 file\(s\) could not be analyzed/);
    expect(JSON.parse(formatPlanJson(run)).unreadable).toHaveLength(3);

    // Back again: nothing has to be read a second time.
    const back = await runPlan([f.lib], f.plan, OPTIONS);
    expect(back).toMatchObject({ analyzed: 0, reused: 3, unreadable: [] });
  }, 300000);

  it("keeps a title's verdict when its changed file cannot be analyzed, but gives a new one an ERROR entry", async () => {
    const f = await fixture("unreadable");
    await writeFile(f.b, "not a matroska file");
    const fresh = join(f.lib, "Z New.mkv");
    await writeFile(fresh, "not a matroska file either");

    const run = await runPlan([f.lib], f.plan, OPTIONS);
    expect(run.unreadable).toEqual([f.b]);
    expect(run.plan.files.find((e) => e.input === f.b)).toMatchObject({ status: "OK", action: "skip" });
    expect(run.analyzedFiles).toEqual([fresh]);
    expect(run.plan.files.find((e) => e.input === fresh)).toMatchObject({ status: "ERROR" });
  }, 300000);

  it("review exits non-zero when a title could not be checked, known or new", async () => {
    const known = await fixture("review-unreadable");
    await writeFile(known.b, "not a matroska file");
    const a = io();
    const codeKnown = await runReview(
      [known.lib],
      { plan: known.plan, recursive: true, aspect: "2.39", logLevel: "error" },
      a.io,
      async () => "n",
    );
    expect(codeKnown).not.toBe(0);
    expect(a.text()).toMatch(/B Safe\.mkv: could not be read; previous result kept/);
    expect(a.text()).toMatch(/1 title could not be scanned/);

    const fresh = await fixture("review-error");
    await writeFile(join(fresh.lib, "Z New.mkv"), "not a matroska file");
    const b = io();
    const codeNew = await runReview(
      [fresh.lib],
      { plan: fresh.plan, recursive: true, aspect: "2.39", logLevel: "error" },
      b.io,
      async () => "n",
    );
    expect(codeNew).not.toBe(0);
    expect(b.text()).toMatch(/Z New\.mkv: could not be scanned/);

    // A clean library still exits 0 when every question is answered no.
    const clean = await fixture("review-clean");
    const c = io();
    expect(
      await runReview(
        [clean.lib],
        { plan: clean.plan, recursive: true, aspect: "2.39", logLevel: "error" },
        c.io,
        async () => "n",
      ),
    ).toBe(0);
  }, 300000);

  // --- a plan.json that cannot be written -----------------------------------

  it("stops every worker and rejects once when plan.json cannot be saved", async () => {
    const lib = join(dir, "lib-save");
    await cp(library, lib, { recursive: true });
    const plan = join(dir, "plan-save");
    // writeJsonAtomic writes plan.json.tmp-<pid> first: a directory in its way
    // makes every save from then on fail.
    const blocker = join(plan, `plan.json.tmp-${process.pid}`);
    let started = 0;
    const failure = await runPlan([lib], plan, { ...OPTIONS, jobs: 2 }, {
      onProgress: (p) => {
        if (p.type === "file-start" && started++ === 0) void mkdir(blocker);
      },
    }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);

    // Nothing is still running: the plan directory does not change any more.
    const snapshot = async () => (await readdir(plan, { recursive: true })).sort();
    const at = await snapshot();
    await new Promise((r) => setTimeout(r, 600));
    expect(await snapshot()).toEqual(at);

    // With the obstacle gone the next run simply carries on.
    await rm(blocker, { recursive: true });
    const next = await runPlan([lib], plan, OPTIONS);
    expect(next.plan.files).toHaveLength(3);
    expect(next.plan.files.every((e) => e.status !== "ERROR")).toBe(true);
  }, 300000);

  // --- a repaired title restored from a backup -------------------------------

  it("notices the unrepaired file put back with its original date, with or without kept dates", async () => {
    // What most ways of restoring do — Finder, Time Machine, `rsync -t`,
    // Windows' copy: the file comes back with the date it always had, which
    // is the date the plan recorded before it fixed it. Size and date say
    // "untouched"; one patched range read from the file says otherwise.
    for (const preserveDates of [false, true]) {
      const f = await fixture(`restored-dated-${preserveDates}`);
      const before = await stat(f.a);
      const backup = join(dir, `restored-dated-${preserveDates}.mkv`);
      await copyFile(f.a, backup);
      const applied = await applyPlan(f.plan, { inPlace: true, execute: true, only: [f.a], preserveDates });
      expect(applied.exitCode).toBe(0);

      // Still fixed: the probe agrees, is kept on the entry, and nothing is reported.
      const still = await runPlan([f.lib], f.plan, OPTIONS);
      expect(still.restored).toEqual([]);
      expect(still.keptChanged).toEqual([]);
      const entry = still.plan.files.find((e) => e.input === f.a)!;
      expect(entry.probe).toMatchObject({ patchFile: entry.patchFile });

      await copyFile(backup, f.a);
      await utimes(f.a, before.atime, before.mtime);
      const run = await runPlan([f.lib], f.plan, OPTIONS);
      expect(run.restored).toEqual([f.a]);
      expect(run.analyzed).toBe(0);
      expect((await readApplyLog(planPaths(f.plan).applyLog)).at(-1)).toMatchObject({ event: "reverted", input: f.a });
      // And it can be fixed again.
      const again = await applyPlan(f.plan, { inPlace: true, execute: true, only: [f.a], preserveDates });
      expect(again.summary).toMatchObject({ applied: 1, failed: 0 });
    }
  }, 300000);

  it("makes a repaired title fixable again once the unrepaired file is put back at the same size", async () => {
    const f = await fixture("restored");
    const backup = join(dir, "restored-backup.mkv");
    await copyFile(f.a, backup);
    expect((await applyPlan(f.plan, { inPlace: true, execute: true, only: [f.a] })).exitCode).toBe(0);
    const fixedHash = (await hashFileChunked(f.a)).sha256;
    // Not in the same millisecond as the repair: timestamps within 1 ms of
    // each other are the same stamp (`sameMtime`), and a tiny fixture is
    // repaired and restored that fast.
    await new Promise((r) => setTimeout(r, 20));
    await copyFile(backup, f.a);
    // A restore that dates the file "now", as a plain copy does on macOS and
    // Linux. Windows' copy keeps the source's date, and a file put back with
    // its original date is not seen by its stamp: see the handoff notes.
    const now = new Date();
    await utimes(f.a, now, now);

    const run = await runPlan([f.lib], f.plan, OPTIONS);
    expect(run.restored).toEqual([f.a]);
    expect(run.keptChanged).toEqual([]);
    expect(run.analyzed).toBe(0);
    expect((await readApplyLog(planPaths(f.plan).applyLog)).at(-1)).toMatchObject({
      event: "reverted",
      input: f.a,
    });
    expect(formatPlanReport(run)).toMatch(/contain the original bytes again/);

    // Nothing to put back, and revert says so rather than refusing.
    const undo = await revertPlan(f.plan, { inPlace: true, execute: true });
    expect(undo.exitCode).toBe(0);
    expect(undo.files.find((r) => r.input === f.a)!.status).toBe("skipped");

    const again = await applyPlan(f.plan, { inPlace: true, execute: true, only: [f.a] });
    expect(again.files[0]).toMatchObject({ status: "applied", verified: true });
    expect((await hashFileChunked(f.a)).sha256).toBe(fixedHash);
    expect((await scanFile(f.a, { aspect: ASPECT })).status).toBe("OK");

    // Settled: the next check has nothing to say about it.
    const settled = await runPlan([f.lib], f.plan, OPTIONS);
    expect(settled).toMatchObject({ analyzed: 0, restored: [], keptChanged: [] });
  }, 300000);

  it("revert --in-place records a restored title as no longer repaired, so apply offers it again", async () => {
    const f = await fixture("restored-revert");
    const backup = join(dir, "restored-revert-backup.mkv");
    await copyFile(f.a, backup);
    expect((await applyPlan(f.plan, { inPlace: true, execute: true, only: [f.a] })).exitCode).toBe(0);
    await copyFile(backup, f.a);

    // Before: apply calls it done.
    const stuck = await applyPlan(f.plan, { inPlace: true, only: [f.a] });
    expect(stuck.files[0]).toMatchObject({ status: "skipped" });

    const undo = await revertPlan(f.plan, { inPlace: true, execute: true });
    const result = undo.files.find((r) => r.input === f.a)!;
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/already original/);
    expect(undo.exitCode).toBe(0);

    const offered = await applyPlan(f.plan, { inPlace: true, only: [f.a] });
    expect(offered.files[0]).toMatchObject({ status: "would-apply" });
  }, 300000);

  // --- an adopted entry whose repair is a copy elsewhere ---------------------

  it.skipIf(!propedit)(
    "patches an adopted title in place though its repair so far is a copy elsewhere, and still reverts both",
    async () => {
      const f = await fixture("adopt-copy");
      const out = join(dir, "out-adopt-copy");
      expect((await applyPlan(f.plan, { outputRoot: out, execute: true, only: [f.a] })).exitCode).toBe(0);
      const copy = join(out, "A Scope.mkv");
      const copyFixedHash = (await hashFileChunked(copy)).sha256;

      // The input's headers are edited (another size) and its mtime put back.
      const before = await stat(f.a);
      const note = join(dir, "adopt-copy-note.txt");
      await writeFile(note, "x".repeat(4000));
      await promisify(execFile)("mkvpropedit", [
        f.a,
        "--attachment-mime-type",
        "text/plain",
        "--attachment-name",
        "note.txt",
        "--add-attachment",
        note,
      ]);
      await utimes(f.a, before.atime, before.mtime);
      const editedHash = (await hashFileChunked(f.a)).sha256;
      expect((await stat(f.a)).size).not.toBe(before.size);

      const run = await runPlan([f.lib], f.plan, OPTIONS);
      expect(run.adopted).toEqual([f.a]);

      // The copy still reverts (as a copy of the original it was made from)...
      const undoCopy = await revertPlan(f.plan, { outputRoot: join(dir, "undo-adopt-copy") });
      expect(undoCopy.files.find((r) => r.input === f.a)!.status).toBe("would-revert");

      // ...and the file is fixable in place.
      const fixed = await applyPlan(f.plan, { inPlace: true, execute: true, only: [f.a] });
      expect(fixed.files[0]).toMatchObject({ status: "applied", verified: true });
      expect((await scanFile(f.a, { aspect: ASPECT })).status).toBe("OK");

      // The input now holds the repair, and reverting puts its own bytes back.
      const undo = await revertPlan(f.plan, { inPlace: true, execute: true });
      expect(undo.files.find((r) => r.input === f.a)!.status).toBe("reverted");
      expect((await hashFileChunked(f.a)).sha256).toBe(editedHash);
      expect((await hashFileChunked(copy)).sha256).toBe(copyFixedHash);
    },
    300000,
  );

  // --- apply: outputs --------------------------------------------------------

  it("does not call a same-sized file in another output folder verified", async () => {
    const f = await fixture("other-output");
    const x = join(dir, "out-x");
    const y = join(dir, "out-y");
    expect((await applyPlan(f.plan, { outputRoot: x, execute: true })).summary.verified).toBe(2);

    // Another folder holding files of the same names and sizes: the originals.
    await cp(f.lib, y, { recursive: true });
    const run = await applyPlan(f.plan, { outputRoot: y, execute: true });
    expect(run.files.map((r) => r.status)).toEqual(["conflict", "conflict"]);
    expect(run.summary.verified).toBe(0);
    // The files there were not touched, and the copies in X still count.
    expect((await scanFile(join(y, "A Scope.mkv"), { aspect: ASPECT })).status).toBe("NEEDS_FIX");
    const again = await applyPlan(f.plan, { outputRoot: x, execute: true });
    expect(again.files.map((r) => r.status)).toEqual(["skipped", "skipped"]);
  }, 300000);

  it("fails one title whose output folder cannot be made and carries on with the rest", async () => {
    const f = await fixture("blocked-folder");
    const out = join(dir, "out-blocked");
    await mkdir(out, { recursive: true });
    // `sub` has to be a directory for sub/C Scope.mkv; a file is in its way.
    await writeFile(join(out, "sub"), "in the way");

    const run = await applyPlan(f.plan, { outputRoot: out, execute: true });
    const byRelative = new Map(run.files.map((r) => [r.relative, r]));
    expect(byRelative.get("A Scope.mkv")).toMatchObject({ status: "applied", verified: true });
    // Stored relative paths use "/" on every platform.
    expect(byRelative.get("sub/C Scope.mkv")).toMatchObject({ status: "failed" });
    expect(run.exitCode).toBe(6);
    expect(await readFile(join(out, "sub"), "utf8")).toBe("in the way");
  }, 300000);

  it("never removes somebody else's <output>.partial, only its own leftovers", async () => {
    const f = await fixture("partial");
    const out = join(dir, "out-partial");
    await mkdir(out, { recursive: true });
    const output = join(out, "A Scope.mkv");
    // Not ours: another name, which the tool never writes.
    await writeFile(`${output}.partial`, "somebody's download");
    // Ours by name: a leftover of a killed run.
    await writeFile(partialPathFor(output), "half a copy");

    const run = await applyPlan(f.plan, { outputRoot: out, execute: true, only: [f.a] });
    expect(run.files[0]).toMatchObject({ status: "applied", verified: true });
    expect(await readFile(`${output}.partial`, "utf8")).toBe("somebody's download");
    expect(await exists(partialPathFor(output))).toBe(false);
  }, 300000);

  it("stops at once and leaves no output when cancelled during the read-back or the PGS check", async () => {
    const f = await fixture("cancel-late");
    for (const phase of ["read-back", "verify"] as const) {
      const out = join(dir, `out-cancel-${phase}`);
      const stop = new AbortController();
      const run = await applyPlan(
        f.plan,
        { outputRoot: out, execute: true },
        {
          signal: stop.signal,
          onProgress: (p) => {
            if (p.type === "file-progress" && p.phase === phase) stop.abort();
          },
        },
      );
      expect(run.cancelled, phase).toBe(true);
      expect(run.files, phase).toHaveLength(1);
      expect(run.files[0], phase).toMatchObject({ status: "failed", reason: "cancelled", verified: false });
      const left = (await readdir(out, { recursive: true })).filter((n) => /Scope/.test(n));
      expect(left, phase).toEqual([]);
    }
    // Nothing of it counts as done: an ordinary run applies both.
    const done = await applyPlan(f.plan, { outputRoot: join(dir, "out-cancel-done"), execute: true });
    expect(done.summary).toMatchObject({ applied: 2, verified: 2, failed: 0 });
  }, 300000);

  it("undoes a --replace-original swap that cannot be made, leaving no stranded copy", async () => {
    const f = await fixture("swap-fails");
    const out = join(dir, "out-swap-fails");
    const backup = `${f.a}.pre-scopefix`;
    const originalHash = (await hashFileChunked(f.a)).sha256;

    // A backup appears after the pre-flight, while the copy is being checked.
    const { verifyPatchedOutput } = await import("../../src/batch/apply.js");
    const run = await applyPlan(
      f.plan,
      { outputRoot: out, execute: true, replaceOriginal: true, only: [f.a] },
      {
        verifyOutput: async (output, patchFile) => {
          await writeFile(backup, "someone else's backup");
          return verifyPatchedOutput(output, patchFile);
        },
      },
    );
    expect(run.files[0]).toMatchObject({ status: "failed", replaced: false });
    expect(run.files[0]!.reason).toMatch(/could not be moved aside/);
    expect((await hashFileChunked(f.a)).sha256).toBe(originalHash);
    expect(await readFile(backup, "utf8")).toBe("someone else's backup");
    expect(await exists(join(out, "A Scope.mkv"))).toBe(false);

    // With the obstacle gone, the same command simply works.
    await rm(backup);
    const next = await applyPlan(f.plan, {
      outputRoot: out,
      execute: true,
      replaceOriginal: true,
      only: [f.a],
    });
    expect(next.files[0]).toMatchObject({ status: "applied", replaced: true });
    expect((await scanFile(f.a, { aspect: ASPECT })).status).toBe("OK");
  }, 300000);

  // --- plan: an unfinished in-place write ------------------------------------

  it("says so in plan when an in-place write was started and never finished", async () => {
    const f = await fixture("unfinished");
    const patches = decodePatches((await readPatchFile(f.plan, f.entryA.patchFile!)).patches);
    await appendApplyLog(
      planPaths(f.plan).applyLog,
      {
        time: new Date().toISOString(),
        event: "started",
        input: f.a,
        output: f.a,
        method: "patch",
        inPlace: true,
      },
      { sync: true },
    );
    await writePatchesInPlace(f.a, patches.slice(0, Math.floor(patches.length / 2)));

    const run = await runPlan([f.lib], f.plan, OPTIONS);
    expect(run.unfinished).toEqual([f.a]);
    expect(run.analyzed).toBe(0);
    expect(formatPlanReport(run)).toMatch(/unfinished in-place write/);

    // Finished, it is no longer mentioned.
    expect((await applyPlan(f.plan, { inPlace: true, execute: true, only: [f.a] })).exitCode).toBe(0);
    expect((await runPlan([f.lib], f.plan, OPTIONS)).unfinished).toEqual([]);
  }, 300000);
});
