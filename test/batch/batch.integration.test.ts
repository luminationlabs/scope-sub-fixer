/**
 * End-to-end `plan` → `plan-show` → `apply` against real MKVs built with
 * ffmpeg + mkvmerge. Skipped when the tools are missing.
 */
import {
  access,
  appendFile,
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPlan, STAGING_DIR } from "../../src/batch/apply.js";
import { appendApplyLog, readApplyLog } from "../../src/batch/log.js";
import { runPlan } from "../../src/batch/plan.js";
import {
  decodePatches,
  planPaths,
  readPatchFile,
  requirePlan,
} from "../../src/batch/planFile.js";
import { revertPlan, writePatchesInPlace } from "../../src/batch/revert.js";
import { copyWithPatches, hashFileChunked, partialPathFor } from "../../src/fix/copyPatch.js";
import { runApply } from "../../src/cli/apply.js";
import { runRevert } from "../../src/cli/revert.js";
import { runReview } from "../../src/cli/review.js";
import { runPlanCommand } from "../../src/cli/plan.js";
import { runPlanShow } from "../../src/cli/planShow.js";
import { inspectMkv } from "../../src/mkv/inspect.js";
import { PgsParseError } from "../../src/pgs/errors.js";
import { scanFile } from "../../src/scan/scanFile.js";
import { verifyFile } from "../../src/verify/verifyFile.js";
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

/**
 * Edit an MKV's headers the way a tagging tool does: attach a small file with
 * `mkvpropedit` (no cluster moves) and, unless told not to, put the mtime back.
 */
async function editHeaders(file: string, scratch: string, keepMtime = true): Promise<void> {
  const before = await stat(file);
  const note = join(scratch, `note-${Date.now()}.txt`);
  await writeFile(note, "x".repeat(4000));
  await promisify(execFile)("mkvpropedit", [
    file,
    "--attachment-mime-type",
    "text/plain",
    "--attachment-name",
    "note.txt",
    "--add-attachment",
    note,
  ]);
  if (keepMtime) await utimes(file, before.atime, before.mtime);
  expect((await stat(file)).size).not.toBe(before.size);
}

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    text: () => out.join(""),
    io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
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

describe.skipIf(!tools)("plan, plan-show and apply end to end", () => {
  let dir: string;
  let library: string;
  let planDir: string;
  let outputRoot: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    library = join(dir, "library");
    planDir = join(dir, "plan1");
    outputRoot = join(dir, "out");
    await mkdir(library, { recursive: true });

    const video = await makeLetterboxVideo(join(dir, "video.mkv"), {
      activeHeight: 804,
      seconds: 8,
    });
    const scopeSup = await writeSup(join(dir, "scope.sup"), SCOPE_SPEC);
    const safeSup = await writeSup(join(dir, "safe.sup"), SAFE_SPEC);

    // (a) needs fixing, (b) already safe, (c) no PGS at all, (d) zlib-compressed.
    await makeMkv(join(library, "Scope (2024).mkv"), video, scopeSup, {
      trackName: "English",
    });
    await makeMkv(join(library, "Safe (2019).mkv"), video, safeSup, {
      trackName: "English",
    });
    await makeMkv(join(library, "NoSubs (2010).mkv"), video, null);
    await makeMkv(join(library, "Zlib (2015).mkv"), video, scopeSup, {
      trackName: "English",
      compression: "zlib",
    });
  }, 300000);

  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  it("plans the directory, choosing exactly the file that can be repaired", async () => {
    const run = await runPlan([library], planDir, { aspect: ASPECT, method: "patch" });

    expect(run.plan.files).toHaveLength(4);
    const byName = new Map(run.plan.files.map((f) => [f.relative, f]));

    const scope = byName.get("Scope (2024).mkv")!;
    expect(scope.status).toBe("NEEDS_FIX");
    expect(scope.action).toBe("fix");
    expect(scope.patchFile).toBeDefined();
    expect(scope.patch_summary!.events_moved).toBe(3);
    expect(scope.patch_summary!.position_fields).toBeGreaterThan(0);
    expect(scope.tracks[0]!.action).toBe("fix");

    const safe = byName.get("Safe (2019).mkv")!;
    expect(safe.status).toBe("OK");
    expect(safe.action).toBe("skip");

    const noSubs = byName.get("NoSubs (2010).mkv")!;
    expect(noSubs.status).toBe("NO_PGS");
    expect(noSubs.action).toBe("skip");

    const zlib = byName.get("Zlib (2015).mkv")!;
    expect(zlib.status).toBe("NEEDS_FIX");
    expect(zlib.action).toBe("skip");
    expect(zlib.reason).toMatch(/compression/);
    expect(zlib.compressed).toBe(true);

    // The plan is on disk and reads back identically.
    expect(await requirePlan(planDir)).toEqual(run.plan);
    expect(await exists(join(planDir, scope.patchFile!))).toBe(true);
  }, 300000);

  it("re-uses unchanged entries on a second plan run", async () => {
    const run = await runPlan([library], planDir, { aspect: ASPECT, method: "patch" });
    expect(run.reused).toBe(4);
    expect(run.analyzed).toBe(0);
  }, 120000);

  it("carries every reusable entry in plan.json from the first save on", async () => {
    // A rerun that finds one new file, sorting first. While that file is being
    // analyzed — before any old entry has been reached — plan.json must still
    // hold every old entry: a Ctrl-C there once emptied a 974-entry plan.
    const libraryK = join(dir, "library-killed");
    await cp(library, libraryK, { recursive: true });
    const planK = join(dir, "plan-killed");
    const first = await runPlan([libraryK], planK, { aspect: ASPECT, method: "patch" });
    expect(first.analyzed).toBe(4);

    await cp(join(library, "Safe (2019).mkv"), join(libraryK, "A New One (2026).mkv"));
    const onDiskDuringAnalysis: number[] = [];
    const inspect = async (file: string) => {
      const raw = JSON.parse(await readFile(planPaths(planK).planFile, "utf8")) as {
        files: { input: string }[];
      };
      onDiskDuringAnalysis.push(raw.files.length);
      return inspectMkv(file);
    };
    const again = await runPlan(
      [libraryK],
      planK,
      { aspect: ASPECT, method: "patch" },
      { inspect },
    );
    expect(again.analyzed).toBe(1);
    expect(again.reused).toBe(4);
    expect(onDiskDuringAnalysis).toEqual([4]);
    expect(again.plan.files).toHaveLength(5);
  }, 300000);

  it("keeps its entries when a flat plan is rerun with --recursive", async () => {
    // Flat first, then a title turns up in a subdirectory and the operator adds
    // -r. Only the new file is analyzed; the four flat entries are reused and
    // the plan's recorded options and output paths follow the new run.
    const libraryR = join(dir, "library-recursive");
    await cp(library, libraryR, { recursive: true });
    const planR = join(dir, "plan-recursive");

    const flat = await runPlan([libraryR], planR, { aspect: ASPECT, method: "patch" });
    expect(flat.analyzed).toBe(4);
    expect(flat.plan.options.recursive).toBe(false);

    const sub = join(libraryR, "Drama", "Nested (2022)");
    await mkdir(sub, { recursive: true });
    await cp(join(library, "Safe (2019).mkv"), join(sub, "Nested (2022).mkv"));

    const deep = await runPlan([libraryR], planR, {
      aspect: ASPECT,
      method: "patch",
      recursive: true,
    });
    expect(deep.reused).toBe(4);
    expect(deep.analyzed).toBe(1);
    expect(deep.plan.options.recursive).toBe(true);
    const relatives = deep.plan.files.map((f) => f.relative).sort();
    expect(relatives).toEqual([
      "Drama/Nested (2022)/Nested (2022).mkv",
      "NoSubs (2010).mkv",
      "Safe (2019).mkv",
      "Scope (2024).mkv",
      "Zlib (2015).mkv",
    ]);
    const scope = deep.plan.files.find((f) => f.relative === "Scope (2024).mkv")!;
    expect(scope.root).toBe(libraryR);
    expect(scope.action).toBe("fix");
    expect(await exists(join(planR, scope.patchFile!))).toBe(true);
    expect(await requirePlan(planR)).toEqual(deep.plan);
  }, 300000);

  it("refuses to replace a plan built by an older scope-sub unless told to", async () => {
    // Its own plan directory: a re-analysis hands out fresh patches/<n>.json
    // names, which would move the file the plan-show test looks for.
    const staleDir = join(dir, "plan-stale");
    const first = await runPlan([library], staleDir, { aspect: ASPECT, method: "patch" });
    expect(first.analyzed).toBe(4);

    // Same size, same mtime, same options — only the build differs.
    const planJson = planPaths(staleDir).planFile;
    const raw = JSON.parse(await readFile(planJson, "utf8")) as {
      tool: { name: string; version: string; rules?: number };
    };
    // A plan that does not record its rules generation.
    raw.tool.version = "0.1.0";
    delete raw.tool.rules;
    await writeFile(planJson, JSON.stringify(raw, null, 2));
    const before = await readFile(planJson, "utf8");

    // Refused, and the plan on disk is untouched: it may be someone's undo record.
    await expect(
      runPlan([library], staleDir, { aspect: ASPECT, method: "patch" }),
    ).rejects.toThrow(/built by scope-sub 0\.1\.0, which did not record which rules it used.*--reanalyze/);
    expect(await readFile(planJson, "utf8")).toBe(before);

    const again = await runPlan([library], staleDir, {
      aspect: ASPECT,
      method: "patch",
      reanalyze: true,
    });
    expect(again.reused).toBe(0);
    expect(again.analyzed).toBe(4);

    // And a run by this build reuses everything again.
    const third = await runPlan([library], staleDir, { aspect: ASPECT, method: "patch" });
    expect(third.reused).toBe(4);
    expect(third.analyzed).toBe(0);
  }, 300000);

  it("refuses to replace a plan built with different options, naming them", async () => {
    const optDir = join(dir, "plan-options");
    await runPlan([library], optDir, { aspect: ASPECT, method: "patch" });
    const planJson = planPaths(optDir).planFile;
    const before = await readFile(planJson, "utf8");

    await expect(
      runPlan([library], optDir, { aspect: "auto", method: "remux", margin: 12 }),
    ).rejects.toThrow(
      /with aspect 2\.39 \(this run: auto\), margin unset \(this run: 12\), method patch \(this run: remux\).*4 entries.*--reanalyze/,
    );
    expect(await readFile(planJson, "utf8")).toBe(before);

    // The CLI turns the refusal into a bad-arguments exit and leaves the plan alone.
    const out = io();
    expect(
      await runPlanCommand([library], { plan: optDir, aspect: "auto" }, out.io),
    ).toBe(2);
    expect(out.err.join("")).toContain("--reanalyze");
    expect(await readFile(planJson, "utf8")).toBe(before);
  }, 300000);

  it("shows the plan as a table and as per-file detail", async () => {
    const table = io();
    expect(await runPlanShow(planDir, {}, table.io)).toBe(0);
    expect(table.text()).toContain("Scope (2024).mkv");
    expect(table.text()).toContain("NEEDS_FIX");
    expect(table.text()).toMatch(/planned fixes: 1 file\(s\), 1 track\(s\), 3 event\(s\)/);

    const onlyFix = io();
    await runPlanShow(planDir, { only: "fix" }, onlyFix.io);
    expect(onlyFix.text()).not.toContain("Safe (2019).mkv");

    const detail = io();
    await runPlanShow(planDir, { file: "Scope" }, detail.io);
    expect(detail.text()).toContain("patch file: patches/1.json");
    expect(detail.text()).toMatch(/object 0 \(window 0\)\s+dx=0 dy=-\d+/);
  }, 120000);

  it("writes nothing at all on a dry run", async () => {
    const run = await applyPlan(planDir, { outputRoot });
    expect(run.execute).toBe(false);
    expect(run.files).toHaveLength(1);
    expect(run.files[0]!.status).toBe("would-apply");
    expect(run.exitCode).toBe(0);
    expect(await exists(outputRoot)).toBe(false);
    expect(await readApplyLog(planPaths(planDir).applyLog)).toEqual([]);
  }, 120000);

  it("applies, verifies and logs the one repairable file", async () => {
    const run = await applyPlan(planDir, { outputRoot, execute: true });
    expect(run.exitCode).toBe(0);
    expect(run.summary).toMatchObject({ applied: 1, verified: 1, failed: 0, conflicts: 0 });

    const output = join(outputRoot, "Scope (2024).mkv");
    expect(await exists(output)).toBe(true);
    expect(await readdir(outputRoot)).toEqual(["Scope (2024).mkv"]);
    // No partial left behind, and the file is untouched.
    expect(await exists(partialPathFor(output))).toBe(false);

    const input = join(library, "Scope (2024).mkv");
    expect((await stat(output)).size).toBe((await stat(input)).size);

    const events = await readApplyLog(planPaths(planDir).applyLog);
    expect(events.map((e) => e.event)).toEqual(["started", "verified"]);
    expect(events[1]!.sha256).toBe(run.files[0]!.sha256);
    expect(events[1]!.output).toBe(output);

    // The repaired file passes `verify` against its original and re-scans clean.
    const report = await verifyFile(input, output, { aspect: ASPECT });
    expect(report.checks.filter((c) => !c.pass)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.payloadMode).toBe("byte-identical");

    const rescan = await scanFile(output, { aspect: ASPECT });
    expect(rescan.status).toBe("OK");
    expect(rescan.tracks[0]!.offendingEventCount).toBe(0);
  }, 300000);

  it("skips the finished file when it is run again", async () => {
    const run = await applyPlan(planDir, { outputRoot, execute: true });
    expect(run.summary).toMatchObject({ applied: 0, skipped: 1, failed: 0 });
    expect(run.files[0]!.reason).toMatch(/already applied and verified/);
    // Nothing new was written to the log beyond the resume decision.
    const events = await readApplyLog(planPaths(planDir).applyLog);
    expect(events.filter((e) => e.event === "verified")).toHaveLength(1);
  }, 120000);

  it("refuses an existing output when the log does not vouch for it", async () => {
    const fresh = join(dir, "plan-conflict");
    await runPlan([join(library, "Scope (2024).mkv")], fresh, {
      aspect: ASPECT,
      method: "patch",
    });
    const run = await applyPlan(fresh, { outputRoot, execute: true });
    expect(run.files[0]!.status).toBe("conflict");
    expect(run.files[0]!.reason).toMatch(/already exists/);
    expect(run.exitCode).toBe(8);
  }, 300000);

  it("skips a file whose input changed after the plan was built", async () => {
    const library2 = join(dir, "library2");
    await cp(library, library2, { recursive: true });
    const plan2 = join(dir, "plan2");
    await runPlan([library2], plan2, { aspect: ASPECT, method: "patch" });

    await appendFile(join(library2, "Scope (2024).mkv"), Buffer.alloc(16));

    const run = await applyPlan(plan2, {
      outputRoot: join(dir, "out2"),
      execute: true,
    });
    expect(run.files[0]!.status).toBe("skipped");
    expect(run.files[0]!.reason).toMatch(/the file was modified after the plan was built/);
    expect(await exists(join(dir, "out2", "Scope (2024).mkv"))).toBe(false);
  }, 300000);

  it("swaps the repaired file in and keeps the original with --replace-original", async () => {
    const library3 = join(dir, "library3");
    await cp(library, library3, { recursive: true });
    const plan3 = join(dir, "plan3");
    const out3 = join(dir, "out3");
    await runPlan([library3], plan3, { aspect: ASPECT, method: "patch" });

    const original = join(library3, "Scope (2024).mkv");
    const originalSize = (await stat(original)).size;

    const run = await applyPlan(plan3, {
      outputRoot: out3,
      execute: true,
      replaceOriginal: true,
      backupSuffix: ".pre-scopefix",
    });
    expect(run.exitCode).toBe(0);
    expect(run.files[0]!.replaced).toBe(true);

    const backup = `${original}.pre-scopefix`;
    expect(await exists(backup)).toBe(true);
    expect(await exists(original)).toBe(true);
    // The repaired file was moved onto the original path, so the output is gone.
    expect(await exists(join(out3, "Scope (2024).mkv"))).toBe(false);
    expect((await stat(original)).size).toBe(originalSize);

    // The file Kodi now sees is clean, and the backup is the untouched original.
    expect((await scanFile(original, { aspect: ASPECT })).status).toBe("OK");
    expect((await scanFile(backup, { aspect: ASPECT })).status).toBe("NEEDS_FIX");

    const events = await readApplyLog(planPaths(plan3).applyLog);
    expect(events.map((e) => e.event)).toEqual([
      "started",
      "verified",
      "backed-up",
      "replaced",
    ]);

    // A rerun leaves the swapped file alone.
    const again = await applyPlan(plan3, {
      outputRoot: out3,
      execute: true,
      replaceOriginal: true,
    });
    expect(again.files[0]!.status).toBe("skipped");
    expect(again.files[0]!.reason).toMatch(/original was replaced/);
  }, 300000);

  it("stages inside --output-root when the output path is the original file", async () => {
    // The swap-in workflow: --output-root IS the library. The computed output
    // path is the input, so the copy goes to a staging directory beside it —
    // same filesystem, so the final rename is still atomic.
    const library5 = join(dir, "library5");
    await cp(library, library5, { recursive: true });
    const plan5 = join(dir, "plan5");
    await runPlan([library5], plan5, { aspect: ASPECT, method: "patch" });

    const original = join(library5, "Scope (2024).mkv");
    const originalSize = (await stat(original)).size;

    const run = await applyPlan(plan5, {
      outputRoot: library5,
      execute: true,
      replaceOriginal: true,
      backupSuffix: ".pre-scopefix",
    });

    expect(run.exitCode).toBe(0);
    expect(run.files[0]!.status).toBe("applied");
    expect(run.files[0]!.replaced).toBe(true);
    expect(run.files[0]!.checks.join(" ")).toMatch(/staged in .*\.scopefix-staging/);
    expect(run.files[0]!.output).toBe(
      join(library5, STAGING_DIR, "Scope (2024).mkv"),
    );

    // The library now holds the repaired file, the backup, and no staging dir.
    const backup = `${original}.pre-scopefix`;
    expect(await exists(backup)).toBe(true);
    expect((await stat(original)).size).toBe(originalSize);
    expect(await exists(join(library5, STAGING_DIR))).toBe(false);
    expect((await scanFile(original, { aspect: ASPECT })).status).toBe("OK");
    expect((await scanFile(backup, { aspect: ASPECT })).status).toBe("NEEDS_FIX");
  }, 300000);

  it("deletes the output when the verification itself throws", async () => {
    const library6 = join(dir, "library6");
    await cp(library, library6, { recursive: true });
    const plan6 = join(dir, "plan6");
    const out6 = join(dir, "out6");
    await runPlan([library6], plan6, { aspect: ASPECT, method: "patch" });

    const run = await applyPlan(
      plan6,
      { outputRoot: out6, execute: true },
      {
        verifyOutput: () => {
          throw new PgsParseError("segment size runs past the block", 4096);
        },
      },
    );

    expect(run.files[0]!.status).toBe("failed");
    expect(run.files[0]!.failureKind).toBe("verification");
    expect(run.files[0]!.reason).toMatch(/segment size runs past the block/);
    expect(run.exitCode).toBe(7);
    // Nothing is left at the output path, or beside it.
    expect(await exists(join(out6, "Scope (2024).mkv"))).toBe(false);
    expect(await exists(partialPathFor(join(out6, "Scope (2024).mkv")))).toBe(false);
    // ...and the file is untouched.
    expect((await scanFile(join(library6, "Scope (2024).mkv"), { aspect: ASPECT })).status).toBe(
      "NEEDS_FIX",
    );
    const events = await readApplyLog(planPaths(plan6).applyLog);
    expect(events.map((e) => e.event)).toEqual(["started", "failed"]);
  }, 300000);

  it("finishes a swap a killed run left half done", async () => {
    const library7 = join(dir, "library7");
    await cp(library, library7, { recursive: true });
    const plan7 = join(dir, "plan7");
    const out7 = join(dir, "out7");
    await runPlan([library7], plan7, { aspect: ASPECT, method: "patch" });

    // Write the repaired file, then reproduce the state a run killed between
    // the two renames leaves behind: the original moved aside, nothing in its
    // place, and a `backed-up` record in the log.
    const first = await applyPlan(plan7, { outputRoot: out7, execute: true });
    expect(first.exitCode).toBe(0);
    const original = join(library7, "Scope (2024).mkv");
    const output = join(out7, "Scope (2024).mkv");
    const backup = `${original}.pre-scopefix`;
    const repairedBytes = await readFile(output);
    await rename(original, backup);
    await writeFile(
      planPaths(plan7).applyLog,
      [
        JSON.stringify({
          time: new Date().toISOString(),
          event: "backed-up",
          input: original,
          output,
          method: "patch",
          backup,
          bytes: repairedBytes.length,
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const resumed = await applyPlan(plan7, {
      outputRoot: out7,
      execute: true,
      replaceOriginal: true,
      backupSuffix: ".pre-scopefix",
    });

    expect(resumed.exitCode).toBe(0);
    expect(resumed.files[0]!.status).toBe("applied");
    expect(resumed.files[0]!.replaced).toBe(true);
    expect(resumed.files[0]!.checks.join(" ")).toMatch(/interrupted swap/);
    // The repaired file is where the original was, and the backup is intact.
    expect(await exists(output)).toBe(false);
    expect(await readFile(original)).toEqual(repairedBytes);
    expect((await scanFile(backup, { aspect: ASPECT })).status).toBe("NEEDS_FIX");
    const events = await readApplyLog(planPaths(plan7).applyLog);
    expect(events.at(-1)!.event).toBe("replaced");
  }, 300000);

  it("records a file that throws while planning, and still plans the rest", async () => {
    const plan8 = join(dir, "plan8");
    await mkdir(plan8, { recursive: true });
    // A plain file where the patches directory belongs: writing the patch file
    // for the one repairable title fails, and only that title.
    await writeFile(join(plan8, "patches"), "not a directory", "utf8");

    const run = await runPlan([library], plan8, { aspect: ASPECT, method: "patch" });

    expect(run.plan.files).toHaveLength(4);
    const scope = run.plan.files.find((f) => f.relative === "Scope (2024).mkv")!;
    expect(scope.status).toBe("ERROR");
    expect(scope.action).toBe("skip");
    expect(scope.reason).toBeTruthy();
    expect(scope.patchFile).toBeUndefined();
    // The other three were analyzed normally.
    expect(run.summary.byStatus["NO_PGS"]).toBe(1);
    expect(run.summary.byStatus["OK"]).toBe(1);
    expect(run.summary.fix).toBe(0);
    // ...and the plan on disk says the same thing.
    const written = await requirePlan(plan8);
    expect(written.files.find((f) => f.relative === "Scope (2024).mkv")!.status).toBe(
      "ERROR",
    );
  }, 300000);

  it("reverts an applied repair, as a copy and then in place", async () => {
    const library9 = join(dir, "library9");
    await cp(library, library9, { recursive: true });
    const plan9 = join(dir, "plan9");
    const out9 = join(dir, "out9");
    const undo9 = join(dir, "undo9");
    await runPlan([library9], plan9, { aspect: ASPECT, method: "patch" });

    const input = join(library9, "Scope (2024).mkv");
    const output = join(out9, "Scope (2024).mkv");
    const originalHash = (await hashFileChunked(input)).sha256;

    expect((await applyPlan(plan9, { outputRoot: out9, execute: true })).exitCode).toBe(0);
    const fixedHash = (await hashFileChunked(output)).sha256;
    expect(fixedHash).not.toBe(originalHash);

    // A dry run writes nothing, here as everywhere.
    const dry = await revertPlan(plan9, { outputRoot: undo9 });
    expect(dry.files[0]!.status).toBe("would-revert");
    expect(await exists(undo9)).toBe(false);

    // --output-root: the reverted copy is byte-identical to the original input.
    const copied = await revertPlan(plan9, { outputRoot: undo9, execute: true });
    expect(copied.exitCode).toBe(0);
    expect(copied.files[0]!.status).toBe("reverted");
    expect((await hashFileChunked(join(undo9, "Scope (2024).mkv"))).sha256).toBe(
      originalHash,
    );
    // The repaired file itself is untouched, and still counts as applied.
    expect((await hashFileChunked(output)).sha256).toBe(fixedHash);
    expect(
      (await applyPlan(plan9, { outputRoot: out9, execute: true })).files[0]!.status,
    ).toBe("skipped");

    // --in-place: the repaired file becomes the original again, without a copy.
    const inPlace = await revertPlan(plan9, { inPlace: true, execute: true });
    expect(inPlace.exitCode).toBe(0);
    expect(inPlace.files[0]!.status).toBe("reverted");
    expect(inPlace.files[0]!.patches).toBeGreaterThan(0);
    expect((await hashFileChunked(output)).sha256).toBe(originalHash);

    const events = await readApplyLog(planPaths(plan9).applyLog);
    const reverts = events.filter((e) => e.event === "reverted");
    expect(reverts).toHaveLength(2);
    expect(reverts[0]!.revertedTo).toBe(join(undo9, "Scope (2024).mkv"));
    expect(reverts[1]).toMatchObject({ event: "reverted", input, output });
    expect(reverts[1]!.revertedTo).toBeUndefined();

    // The in-place revert un-applied the file, so `apply` does it over — and
    // over the file it reverted, without needing --overwrite-output.
    const reapplied = await applyPlan(plan9, { outputRoot: out9, execute: true });
    expect(reapplied.files[0]!.status).toBe("applied");
    expect(reapplied.files[0]!.checks.join(" ")).toMatch(/was reverted to the original/);
    expect((await hashFileChunked(output)).sha256).toBe(fixedHash);
  }, 300000);

  it("reverts one file from an explicit patch file, and refuses a changed one", async () => {
    const library10 = join(dir, "library10");
    await cp(library, library10, { recursive: true });
    const plan10 = join(dir, "plan10");
    const out10 = join(dir, "out10");
    await runPlan([library10], plan10, { aspect: ASPECT, method: "patch" });
    await applyPlan(plan10, { outputRoot: out10, execute: true });

    const output = join(out10, "Scope (2024).mkv");
    const patchFile = join(plan10, "patches", "1.json");
    const originalHash = (await hashFileChunked(join(library10, "Scope (2024).mkv")))
      .sha256;

    const undone = join(dir, "undo10.mkv");
    const copy = io();
    expect(
      await runRevert(
        undefined,
        { patchFile, target: output, output: undone, execute: true, logLevel: "error" },
        copy.io,
      ),
    ).toBe(0);
    expect((await hashFileChunked(undone)).sha256).toBe(originalHash);
    expect(copy.text()).toMatch(/reverted/);

    // Reverting the reverted copy is a no-op, not a second inversion.
    const twice = io();
    expect(
      await runRevert(
        undefined,
        { patchFile, target: undone, inPlace: true, execute: true, logLevel: "error" },
        twice.io,
      ),
    ).toBe(0);
    expect(twice.text()).toMatch(/already original/);
    expect((await hashFileChunked(undone)).sha256).toBe(originalHash);

    // A file whose patched bytes are something else entirely is refused (7),
    // and nothing is written to it.
    const tampered = join(dir, "tampered10.mkv");
    await cp(output, tampered);
    const offset = (
      JSON.parse(await readFile(patchFile, "utf8")) as { patches: { offset: number }[] }
    ).patches[0]!.offset;
    const handle = await open(tampered, "r+");
    await handle.write(Buffer.from([0xee]), 0, 1, offset);
    await handle.close();
    const before = (await hashFileChunked(tampered)).sha256;

    const refused = io();
    expect(
      await runRevert(
        undefined,
        { patchFile, target: tampered, inPlace: true, execute: true, logLevel: "error" },
        refused.io,
      ),
    ).toBe(7);
    expect(refused.text()).toMatch(/neither the fixed nor the original bytes/);
    expect((await hashFileChunked(tampered)).sha256).toBe(before);
  }, 300000);

  /** A fresh copy of the library and a plan of it, for one in-place test. */
  async function inPlaceFixture(name: string) {
    const lib = join(dir, `library-${name}`);
    await cp(library, lib, { recursive: true });
    const plan = join(dir, `plan-${name}`);
    await runPlan([lib], plan, { aspect: ASPECT, method: "patch" });
    const input = join(lib, "Scope (2024).mkv");
    const entry = (await requirePlan(plan)).files.find((f) => f.action === "fix")!;
    const patches = decodePatches((await readPatchFile(plan, entry.patchFile!)).patches);
    // What the copy mode writes, byte for byte, through its own writer: the
    // reference every in-place result is held to.
    const reference = join(dir, `reference-${name}.mkv`);
    await copyWithPatches(input, reference, patches, { expectedSize: entry.size });
    return {
      lib,
      plan,
      input,
      entry,
      patches,
      originalHash: (await hashFileChunked(input)).sha256,
      fixedHash: (await hashFileChunked(reference)).sha256,
    };
  }

  it("patches in place: a dry run writes nothing, and the result is the copy mode's, byte for byte", async () => {
    const f = await inPlaceFixture("inplace");
    const listing = (await readdir(f.lib)).sort();

    const dry = await applyPlan(f.plan, { inPlace: true });
    expect(dry.exitCode).toBe(0);
    expect(dry.inPlace).toBe(true);
    expect(dry.outputRoot).toBeUndefined();
    expect(dry.files[0]!.status).toBe("would-apply");
    expect(dry.files[0]!.checks.join(" ")).toMatch(/hold the original bytes the plan recorded/);
    expect((await hashFileChunked(f.input)).sha256).toBe(f.originalHash);
    expect(await readApplyLog(planPaths(f.plan).applyLog)).toEqual([]);

    const run = await applyPlan(f.plan, { inPlace: true, execute: true });
    expect(run.exitCode).toBe(0);
    expect(run.files[0]).toMatchObject({
      status: "applied",
      inPlace: true,
      verified: true,
      replaced: false,
      output: f.input,
    });
    // Same bytes the copy mode would have produced, in the same file, and
    // nothing new beside it: no copy, no backup, no staging directory.
    expect((await hashFileChunked(f.input)).sha256).toBe(f.fixedHash);
    expect((await readdir(f.lib)).sort()).toEqual(listing);
    expect((await scanFile(f.input, { aspect: ASPECT })).status).toBe("OK");

    const events = await readApplyLog(planPaths(f.plan).applyLog);
    expect(events.map((e) => e.event)).toEqual(["started", "patched"]);
    expect(events[1]).toMatchObject({ inPlace: true, pgsVerified: true, output: f.input });

    // A rerun leaves it alone.
    const again = await applyPlan(f.plan, { inPlace: true, execute: true });
    expect(again.files[0]!.status).toBe("skipped");
    expect(again.files[0]!.reason).toMatch(/already patched in place/);

    // The plan directory undoes it in place — and, since the log says this tool
    // wrote the file, the changed mtime does not stop it being patched again.
    const reverted = await revertPlan(f.plan, { inPlace: true, execute: true });
    expect(reverted.files[0]!.status).toBe("reverted");
    expect((await hashFileChunked(f.input)).sha256).toBe(f.originalHash);
    const reapplied = await applyPlan(f.plan, { inPlace: true, execute: true });
    expect(reapplied.files[0]!.status).toBe("applied");
    expect((await hashFileChunked(f.input)).sha256).toBe(f.fixedHash);
  }, 300000);

  it("finishes an in-place run that was killed mid-write, and refuses the same state from anyone else", async () => {
    const f = await inPlaceFixture("killed");
    const half = f.patches.slice(0, Math.ceil(f.patches.length / 2));
    await writePatchesInPlace(f.input, half);
    const halfHash = (await hashFileChunked(f.input)).sha256;
    // Put the plan's stamp back (in seconds: a Date would drop the sub-ms
    // part the plan recorded), so only the byte scan can tell.
    await utimes(f.input, new Date(), f.entry.mtimeMs / 1000);

    // Half patched with no record of an in-place run: refused, untouched.
    const refused = await applyPlan(f.plan, { inPlace: true, execute: true });
    expect(refused.exitCode).toBe(7);
    expect(refused.files[0]!.status).toBe("failed");
    expect(refused.files[0]!.reason).toMatch(/records no in-place run/);
    expect((await hashFileChunked(f.input)).sha256).toBe(halfHash);

    // The same state after a `started` record (the kill): finished.
    await appendApplyLog(planPaths(f.plan).applyLog, {
      time: new Date().toISOString(),
      event: "started",
      input: f.input,
      output: f.input,
      method: "patch",
      inPlace: true,
    });
    await utimes(f.input, new Date(), new Date()); // the write moved the mtime
    const resumed = await applyPlan(f.plan, { inPlace: true, execute: true });
    expect(resumed.exitCode).toBe(0);
    expect(resumed.files[0]!.status).toBe("applied");
    expect(resumed.files[0]!.checks.join(" ")).toMatch(/interrupted in-place run; finishing it/);
    expect((await hashFileChunked(f.input)).sha256).toBe(f.fixedHash);
  }, 300000);

  it("refuses a file whose patched ranges are something else, writing nothing", async () => {
    const f = await inPlaceFixture("tampered");
    const handle = await open(f.input, "r+");
    await handle.write(Buffer.from([0xee, 0xee, 0xee, 0xee]), 0, 4, f.patches[0]!.offset);
    await handle.close();
    await utimes(f.input, new Date(), f.entry.mtimeMs / 1000);
    const before = (await hashFileChunked(f.input)).sha256;

    const run = await applyPlan(f.plan, { inPlace: true, execute: true });
    expect(run.exitCode).toBe(7);
    expect(run.files[0]!.reason).toMatch(/neither the original nor the fixed bytes/);
    expect((await hashFileChunked(f.input)).sha256).toBe(before);
    const events = await readApplyLog(planPaths(f.plan).applyLog);
    expect(events.map((e) => e.event)).toEqual(["failed"]);
  }, 300000);

  it("puts the original bytes back when the in-place result does not verify", async () => {
    const f = await inPlaceFixture("unverified");
    const run = await applyPlan(
      f.plan,
      { inPlace: true, execute: true },
      { verifyOutput: async () => ({ ok: false, checks: [], problems: ["track 0: boom"] }) },
    );
    expect(run.exitCode).toBe(7);
    expect(run.files[0]).toMatchObject({ status: "failed", failureKind: "verification" });
    expect(run.files[0]!.reason).toMatch(/boom; the original bytes were restored/);
    expect((await hashFileChunked(f.input)).sha256).toBe(f.originalHash);
    const events = await readApplyLog(planPaths(f.plan).applyLog);
    expect(events.map((e) => e.event)).toEqual(["started", "reverted", "failed"]);

    // With a verification that passes, the same plan goes through.
    const retried = await applyPlan(f.plan, { inPlace: true, execute: true });
    expect(retried.files[0]!.status).toBe("applied");
    expect((await hashFileChunked(f.input)).sha256).toBe(f.fixedHash);
  }, 300000);

  it("drives --dangerously-in-place through the CLI, and refuses it with the copy-mode flags", async () => {
    const f = await inPlaceFixture("cli");

    const dry = io();
    expect(
      await runApply(f.plan, { dangerouslyInPlace: true, logLevel: "error" }, dry.io),
    ).toBe(0);
    expect(dry.text()).toMatch(/DRY RUN of plan .* in place \(--dangerously-in-place/);
    expect(dry.text()).toMatch(/no copy, no backup/);
    expect((await hashFileChunked(f.input)).sha256).toBe(f.originalHash);

    for (const bad of [
      { dangerouslyInPlace: true, outputRoot: join(dir, "out-cli") },
      { dangerouslyInPlace: true, replaceOriginal: true, execute: true },
      { dangerouslyInPlace: true, overwriteOutput: true },
      { outputRoot: join(dir, "out-cli"), skipVerify: true },
      {},
    ]) {
      const refused = io();
      expect(await runApply(f.plan, { ...bad, logLevel: "error" }, refused.io)).toBe(2);
    }
    expect(await exists(join(dir, "out-cli"))).toBe(false);

    const executed = io();
    expect(
      await runApply(
        f.plan,
        { dangerouslyInPlace: true, skipVerify: true, execute: true, logLevel: "error" },
        executed.io,
      ),
    ).toBe(0);
    expect(executed.text()).toMatch(/patched\s+Scope \(2024\)\.mkv/);
    expect(executed.text()).toMatch(/PGS not verified \(--skip-verify\)/);
    expect(executed.text()).toMatch(/No backups were made/);
    expect((await hashFileChunked(f.input)).sha256).toBe(f.fixedHash);
    const events = await readApplyLog(planPaths(f.plan).applyLog);
    expect(events.at(-1)).toMatchObject({ event: "patched", pgsVerified: false });
  }, 300000);

  it("re-plans without re-analyzing what it patched, and keeps that undo record even when the file changes", async () => {
    const f = await inPlaceFixture("replan");
    expect((await applyPlan(f.plan, { inPlace: true, execute: true })).exitCode).toBe(0);
    const patched = (await readApplyLog(planPaths(f.plan).applyLog)).at(-1)!;
    const now = await stat(f.input);
    expect(patched.stamp).toEqual({ size: now.size, mtimeMs: now.mtimeMs });
    const patchPath = join(f.plan, f.entry.patchFile!);
    const patchBytes = await readFile(patchPath);

    // Its mtime moved, but the log says this plan moved it: nothing re-analyzed,
    // the fix entry and its patch file untouched, and revert still finds it.
    const again = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(again.analyzed).toBe(0);
    expect(again.analyzedFiles).toEqual([]);
    expect(again.keptChanged).toEqual([]);
    expect(again.plan.files.find((e) => e.input === f.input)).toMatchObject({
      action: "fix",
      patchFile: f.entry.patchFile,
    });
    expect(await readFile(patchPath)).toEqual(patchBytes);
    expect((await revertPlan(f.plan, { inPlace: true })).files[0]!.status).toBe("would-revert");

    // Something else touches it without disturbing a patched byte (a header
    // edit that fits in place): kept, its new stamp taken, and quiet from then on.
    await utimes(f.input, new Date(), new Date(Date.now() + 60_000));
    await cp(join(library, "Safe (2019).mkv"), join(f.lib, "New Arrival (2026).mkv"));
    const touched = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(touched).toMatchObject({ adopted: [f.input], keptChanged: [], superseded: [] });
    expect(touched.analyzedFiles).toEqual([join(f.lib, "New Arrival (2026).mkv")]);
    expect(touched.plan.files.find((e) => e.input === f.input)).toMatchObject({
      action: "fix",
      patchFile: f.entry.patchFile,
      mtimeMs: (await stat(f.input)).mtimeMs,
    });
    expect(await readFile(patchPath)).toEqual(patchBytes);
    const quiet = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(quiet).toMatchObject({ adopted: [], keptChanged: [], analyzed: 0 });
    expect((await revertPlan(f.plan, { inPlace: true })).files[0]!.status).toBe("would-revert");

    // Something else changes a patched byte: still kept, never re-analyzed, but
    // reported — on every run, since the undo record no longer fits.
    const handle = await open(f.input, "r+");
    try {
      const p = f.patches.find((x) => !x.before.every((b, i) => b === x.after[i]))!;
      await handle.write(Buffer.alloc(p.length, 0xee), 0, p.length, p.offset);
    } finally {
      await handle.close();
    }
    for (let n = 0; n < 2; n++) {
      const changed = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
      expect(changed).toMatchObject({ adopted: [], keptChanged: [f.input], analyzed: 0 });
      expect(changed.plan.files.find((e) => e.input === f.input)!.action).toBe("fix");
      expect(await readFile(patchPath)).toEqual(patchBytes);
    }
  }, 300000);

  it("reviews a library: asks about each title that needs fixing, fixes only the yeses, and asks again about the noes", async () => {
    const lib = join(dir, "library-review");
    await cp(library, lib, { recursive: true });
    await cp(join(library, "Scope (2024).mkv"), join(lib, "Scope Two (2025).mkv"));
    const plan = join(dir, "plan-review");
    const one = join(lib, "Scope (2024).mkv");
    const two = join(lib, "Scope Two (2025).mkv");
    const originalHash = (await hashFileChunked(two)).sha256;

    const answering = (...answers: string[]) => {
      const asked: string[] = [];
      return {
        asked,
        ask: async (q: string) => {
          asked.push(q);
          return answers.shift() ?? null;
        },
      };
    };
    const raw = { plan, aspect: "2.39", logLevel: "error" };

    // First look: four new titles described, two questions, one yes.
    const first = answering("y", "n");
    const out1 = io();
    expect(await runReview([lib], raw, out1.io, first.ask)).toBe(0);
    expect(out1.text()).toMatch(/5 titles: 0 unchanged, 5 new or changed/);
    expect(out1.text()).toMatch(/Safe \(2019\)\.mkv: no changes needed/);
    expect(out1.text()).toMatch(/NoSubs \(2010\)\.mkv: no changes needed \(no PGS subtitles\)/);
    expect(out1.text()).toMatch(/Zlib \(2015\)\.mkv: cannot be fixed/);
    expect(out1.text()).toMatch(/Scope \(2024\)\.mkv: needs fixing: 1 track, 3 subtitles/);
    expect(first.asked).toHaveLength(2);
    expect(first.asked[0]).toMatch(/^Fix "Scope \(2024\)\.mkv" in place\?.*\[y\/n\] $/);
    expect(first.asked[1]).toMatch(/^Fix "Scope Two \(2025\)\.mkv" in place\?/);
    expect(out1.text()).toMatch(/patched\s+Scope \(2024\)\.mkv/);
    expect((await scanFile(one, { aspect: ASPECT })).status).toBe("OK");
    expect((await hashFileChunked(two)).sha256).toBe(originalHash);

    // Second look: nothing new, and the declined title is asked about again —
    // after a stray empty line (an Enter typed during the check), which is not
    // taken as an answer.
    const second = answering("", "n");
    const out2 = io();
    expect(await runReview([lib], raw, out2.io, second.ask)).toBe(0);
    expect(out2.text()).toMatch(/5 titles: 5 unchanged, 0 new or changed/);
    expect(second.asked).toHaveLength(2);
    expect(second.asked[0]).toMatch(/Scope Two \(2025\)\.mkv" in place\? \(.*previously declined\)/);
    expect(second.asked[1]).toBe(second.asked[0]);
    expect(out2.text()).toMatch(/No files were modified/);

    // Third: yes to it. Fourth: nothing left to ask.
    expect(await runReview([lib], raw, io().io, answering("y").ask)).toBe(0);
    expect((await scanFile(two, { aspect: ASPECT })).status).toBe("OK");
    const fourth = answering();
    const out4 = io();
    expect(await runReview([lib], raw, out4.io, fourth.ask)).toBe(0);
    expect(fourth.asked).toEqual([]);
    expect(out4.text()).toMatch(/Nothing needs fixing/);

    // One plan directory is the undo record for both.
    const undo = await revertPlan(plan, { inPlace: true });
    expect(undo.files.filter((f) => f.status === "would-revert").map((f) => f.relative)).toEqual([
      "Scope (2024).mkv",
      "Scope Two (2025).mkv",
    ]);
  }, 300000);

  it("never forgets an entry: an empty library (an unmounted share) or a subset keeps the rest", async () => {
    const f = await inPlaceFixture("forget");
    expect((await applyPlan(f.plan, { inPlace: true, execute: true })).exitCode).toBe(0);
    const before = (await requirePlan(f.plan)).files;
    expect(before).toHaveLength(4);

    const empty = join(dir, "empty-mount-point");
    await mkdir(empty, { recursive: true });
    const run = await runPlan([empty], f.plan, { aspect: ASPECT, method: "patch" });
    expect(run.notFound.sort()).toEqual(before.map((e) => e.input).sort());
    expect((await requirePlan(f.plan)).files).toEqual(before);

    const one = await runPlan([join(f.lib, "Safe (2019).mkv")], f.plan, {
      aspect: ASPECT,
      method: "patch",
    });
    expect(one.notFound).toHaveLength(3);
    const after = await requirePlan(f.plan);
    expect(after.files.map((e) => e.input).sort()).toEqual(before.map((e) => e.input).sort());
    expect(after.files.find((e) => e.input === f.input)).toMatchObject({
      action: "fix",
      patchFile: f.entry.patchFile,
    });
    // ...and the undo still works.
    expect((await revertPlan(f.plan, { inPlace: true })).files[0]!.status).toBe("would-revert");

    // review refuses to go on when it finds nothing at all.
    const out = io();
    expect(
      await runReview([empty], { plan: f.plan, aspect: "2.39", logLevel: "error" }, out.io, async () => null),
    ).toBe(2);
    expect(out.text()).toMatch(/No titles found .* Check that the library is mounted\./);
  }, 300000);

  it("asks to finish a fix that was written but never checked, rather than calling it declined", async () => {
    const f = await inPlaceFixture("unverified-review");
    // A fix killed during verification: `started`, every byte written, no `patched`.
    await appendApplyLog(planPaths(f.plan).applyLog, {
      time: new Date().toISOString(),
      event: "started",
      input: f.input,
      output: f.input,
      method: "patch",
      inPlace: true,
    });
    await writePatchesInPlace(f.input, f.patches);
    expect((await hashFileChunked(f.input)).sha256).toBe(f.fixedHash);

    const dry = await applyPlan(f.plan, { inPlace: true });
    expect(dry.files[0]).toMatchObject({
      status: "would-apply",
      resuming: false,
      awaitingVerification: true,
    });

    const raw = { plan: f.plan, aspect: "2.39", logLevel: "error" };
    const asked: string[] = [];
    const answer = (a: string) => async (q: string) => {
      asked.push(q);
      return a;
    };
    const no = io();
    expect(await runReview([f.lib], raw, no.io, answer("n"))).toBe(6);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^Finish fixing "Scope \(2024\)\.mkv"\? A previous fix was written but not verified\./);
    expect(no.text()).toMatch(/WARNING: "Scope \(2024\)\.mkv" is modified but was not verified/);

    const yes = io();
    expect(await runReview([f.lib], raw, yes.io, answer("y"))).toBe(0);
    expect((await hashFileChunked(f.input)).sha256).toBe(f.fixedHash);
    expect((await readApplyLog(planPaths(f.plan).applyLog)).at(-1)).toMatchObject({
      event: "patched",
      input: f.input,
    });
    // Settled: nothing left to ask.
    const again = io();
    expect(await runReview([f.lib], raw, again.io, async () => null)).toBe(0);
    expect(asked).toHaveLength(2);
  }, 300000);

  it("patches in place after a copy-mode run: a copy elsewhere is not the input repaired", async () => {
    const f = await inPlaceFixture("copy-then-inplace");
    expect(
      (await applyPlan(f.plan, { outputRoot: join(dir, "out-copy-then"), execute: true })).exitCode,
    ).toBe(0);
    const run = await applyPlan(f.plan, { inPlace: true, execute: true });
    expect(run.files[0]!.status).toBe("applied");
    expect((await hashFileChunked(f.input)).sha256).toBe(f.fixedHash);
  }, 300000);

  it("finishes an interrupted in-place revert — by revert, or by apply the other way", async () => {
    for (const finishWith of ["revert", "apply"] as const) {
      const f = await inPlaceFixture(`killed-revert-${finishWith}`);
      expect((await applyPlan(f.plan, { inPlace: true, execute: true })).exitCode).toBe(0);
      // A revert killed half way: its `started` record, then only some bytes back.
      await appendApplyLog(planPaths(f.plan).applyLog, {
        time: new Date().toISOString(),
        event: "started",
        input: f.input,
        output: f.input,
        method: "patch",
        inPlace: true,
        reason: "revert",
      });
      const inverse = f.patches.map((p) => ({ ...p, before: p.after, after: p.before }));
      await writePatchesInPlace(f.input, inverse.slice(0, Math.ceil(inverse.length / 2)));

      if (finishWith === "revert") {
        const run = await revertPlan(f.plan, { inPlace: true, execute: true });
        expect(run.files[0]!.status).toBe("reverted");
        expect(run.files[0]!.checks.join(" ")).toMatch(/interrupted in-place write; finishing it/);
        expect((await hashFileChunked(f.input)).sha256).toBe(f.originalHash);
      } else {
        const run = await applyPlan(f.plan, { inPlace: true, execute: true });
        expect(run.files[0]!.status).toBe("applied");
        expect(run.files[0]!.resuming).toBe(true);
        expect((await hashFileChunked(f.input)).sha256).toBe(f.fixedHash);
      }
    }
  }, 300000);

  it("checks a re-rip afresh, keeping the undo record of the file it replaced", async () => {
    const f = await inPlaceFixture("re-rip");
    expect((await applyPlan(f.plan, { inPlace: true, execute: true })).exitCode).toBe(0);
    const oldPatch = join(f.plan, f.entry.patchFile!);
    const oldPatchBytes = await readFile(oldPatch);

    // A new rip of the same title: needs fixing too, and is another size.
    await makeMkv(f.input, join(dir, "video.mkv"), join(dir, "scope.sup"), {
      trackName: "English (new rip)",
    });
    expect((await stat(f.input)).size).not.toBe(f.entry.size);

    const run = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(run.superseded).toEqual([f.input]);
    expect(run.analyzedFiles).toEqual([f.input]);
    const entry = run.plan.files.find((e) => e.input === f.input)!;
    expect(entry.action).toBe("fix");
    expect(entry.patchFile).not.toBe(f.entry.patchFile);
    expect(entry.notes!.join(" ")).toMatch(new RegExp(`undo data is ${f.entry.patchFile}`));
    expect(await readFile(oldPatch)).toEqual(oldPatchBytes);
    const log = await readApplyLog(planPaths(f.plan).applyLog);
    expect(log.at(-1)).toMatchObject({ event: "superseded", input: f.input });

    // The new rip is fixable in place like any new title, then settles.
    const fixed = await applyPlan(f.plan, { inPlace: true, execute: true });
    expect(fixed.files[0]!.status).toBe("applied");
    expect((await scanFile(f.input, { aspect: ASPECT })).status).toBe("OK");
    const settled = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(settled.analyzed).toBe(0);
    expect(settled.superseded).toEqual([]);
  }, 300000);

  it.skipIf(!propedit)("keeps a title whose headers alone were edited, without reading it again", async () => {
    const f = await inPlaceFixture("headers-skip");
    const safe = join(f.lib, "Safe (2019).mkv");
    const was = (await requirePlan(f.plan)).files.find((e) => e.input === safe)!;
    await editHeaders(safe, dir);
    const now = await stat(safe);
    // Put back the way a network share keeps it: rounded, not exact.
    expect(Math.abs(now.mtimeMs - was.mtimeMs)).toBeLessThan(1000);

    const run = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(run.adopted).toEqual([safe]);
    expect(run.analyzed).toBe(0);
    const entry = run.plan.files.find((e) => e.input === safe)!;
    expect(entry).toMatchObject({
      status: was.status,
      action: "skip",
      size: now.size,
      mtimeMs: now.mtimeMs,
    });
    expect(entry.analyzed).toBe(was.analyzed);
    expect(entry.segment_uid).toMatch(/^[0-9a-f]{32}$/i);
    expect(entry.notes!.join(" ")).toMatch(/header edits only, media unchanged/);

    // Settled: the next run has nothing to adopt, and a second edit leaves one note.
    const settled = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(settled).toMatchObject({ adopted: [], analyzed: 0 });
    await editHeaders(safe, dir);
    const twice = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(twice.adopted).toEqual([safe]);
    const notes = twice.plan.files.find((e) => e.input === safe)!.notes!;
    expect(notes.filter((n) => n.startsWith("header edits only"))).toHaveLength(1);

    // An edit that moves the mtime too is a changed file: checked afresh.
    await new Promise((r) => setTimeout(r, 1100));
    await editHeaders(safe, dir, false);
    const moved = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(moved.adopted).toEqual([]);
    expect(moved.analyzedFiles).toEqual([safe]);
  }, 300000);

  it.skipIf(!propedit)("keeps a planned fix through a header edit, and can still apply it", async () => {
    const f = await inPlaceFixture("headers-planned");
    await editHeaders(f.input, dir);
    const run = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(run.adopted).toEqual([f.input]);
    expect(run.analyzed).toBe(0);
    const size = (await stat(f.input)).size;
    expect((await readPatchFile(f.plan, f.entry.patchFile!)).size).toBe(size);
    expect((await readPatchFile(f.plan, f.entry.patchFile!)).patches).toEqual(
      (await readPatchFile(join(dir, "plan-headers-skip"), f.entry.patchFile!)).patches,
    );

    const fixed = await applyPlan(f.plan, { inPlace: true, execute: true });
    expect(fixed.files[0]!.status).toBe("applied");
    expect((await scanFile(f.input, { aspect: ASPECT })).status).toBe("OK");
  }, 300000);

  it.skipIf(!propedit)("keeps a repaired title and its undo record through a header edit", async () => {
    const f = await inPlaceFixture("headers-repaired");
    expect((await applyPlan(f.plan, { inPlace: true, execute: true })).exitCode).toBe(0);
    await editHeaders(f.input, dir);
    const size = (await stat(f.input)).size;

    const run = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(run).toMatchObject({ adopted: [f.input], superseded: [], keptChanged: [], analyzed: 0 });
    const entry = run.plan.files.find((e) => e.input === f.input)!;
    expect(entry).toMatchObject({ action: "fix", patchFile: f.entry.patchFile, size });
    expect((await readPatchFile(f.plan, f.entry.patchFile!)).size).toBe(size);
    const log = await readApplyLog(planPaths(f.plan).applyLog);
    expect(log.map((e) => e.event)).not.toContain("superseded");

    // Quiet from then on, not offered for fixing again, and still revertible.
    const settled = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(settled).toMatchObject({ adopted: [], superseded: [], keptChanged: [], analyzed: 0 });
    expect((await applyPlan(f.plan, { inPlace: true })).files.map((x) => x.status)).not.toContain(
      "would-apply",
    );
    const reverted = await revertPlan(f.plan, { inPlace: true, execute: true });
    expect(reverted.files[0]!.status).toBe("reverted");
    expect((await scanFile(f.input, { aspect: ASPECT })).status).toBe("NEEDS_FIX");
  }, 300000);

  it.skipIf(!propedit)("keeps a repaired title through a track's flags, name and language being edited", async () => {
    const f = await inPlaceFixture("headers-flags");
    expect((await applyPlan(f.plan, { inPlace: true, execute: true })).exitCode).toBe(0);
    const before = await stat(f.input);
    await new Promise((r) => setTimeout(r, 1100));
    await promisify(execFile)("mkvpropedit", [
      f.input,
      "--edit",
      "track:s1",
      "--set",
      "flag-forced=1",
      "--set",
      "language=fre",
      "--set",
      "name=A much longer name than the track had when it was planned and repaired",
    ]);
    const after = await stat(f.input);
    expect(after.mtimeMs).not.toBe(before.mtimeMs);

    const run = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(run).toMatchObject({ adopted: [f.input], superseded: [], keptChanged: [], analyzed: 0 });
    expect((await readPatchFile(f.plan, f.entry.patchFile!)).size).toBe(after.size);
    const settled = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(settled).toMatchObject({ adopted: [], superseded: [], keptChanged: [], analyzed: 0 });
    const reverted = await revertPlan(f.plan, { inPlace: true, execute: true });
    expect(reverted.files[0]!.status).toBe("reverted");
  }, 300000);

  it.skipIf(!propedit)("does not keep a repaired title whose bytes are back to the original", async () => {
    const f = await inPlaceFixture("headers-restored");
    const backup = join(dir, "restored-backup.mkv");
    await cp(f.input, backup);
    expect((await applyPlan(f.plan, { inPlace: true, execute: true })).exitCode).toBe(0);

    // The unrepaired file is put back and then tagged: every range reads
    // "original", which is not what the log says this plan left there.
    await cp(backup, f.input);
    await editHeaders(f.input, dir);
    const run = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(run.adopted).toEqual([]);
    expect(run.superseded).toEqual([f.input]);
    expect(run.plan.files.find((e) => e.input === f.input)!.action).toBe("fix");
    // So it is offered for fixing again rather than skipped as done.
    expect((await applyPlan(f.plan, { inPlace: true })).files[0]!.status).toBe("would-apply");
  }, 300000);

  it.skipIf(!propedit)("leaves the patch file's size alone when the repair is a copy elsewhere", async () => {
    const f = await inPlaceFixture("headers-copy");
    const out = join(dir, "out-headers-copy");
    expect((await applyPlan(f.plan, { outputRoot: out, execute: true })).exitCode).toBe(0);
    const copySize = (await stat(join(out, "Scope (2024).mkv"))).size;

    await editHeaders(f.input, dir);
    const run = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(run).toMatchObject({ adopted: [f.input], analyzed: 0 });
    expect((await readPatchFile(f.plan, f.entry.patchFile!)).size).toBe(copySize);
    // The copy is still what the patch file describes: revert can undo it.
    expect((await revertPlan(f.plan, { inPlace: true })).files[0]!.status).toBe("would-revert");
  }, 300000);

  it.skipIf(!propedit)("still treats a repaired title as replaced when its patched bytes are gone", async () => {
    const f = await inPlaceFixture("headers-clobbered");
    expect((await applyPlan(f.plan, { inPlace: true, execute: true })).exitCode).toBe(0);
    await editHeaders(f.input, dir);
    const handle = await open(f.input, "r+");
    try {
      const p = f.patches.find((x) => !x.before.every((b, i) => b === x.after[i]))!;
      await handle.write(Buffer.alloc(p.length, 0xee), 0, p.length, p.offset);
    } finally {
      await handle.close();
    }
    const run = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch" });
    expect(run.adopted).toEqual([]);
    expect(run.superseded).toEqual([f.input]);
  }, 300000);

  it("keeps the entries it repaired through --reanalyze", async () => {
    const f = await inPlaceFixture("reanalyze");
    expect((await applyPlan(f.plan, { inPlace: true, execute: true })).exitCode).toBe(0);
    const run = await runPlan([f.lib], f.plan, { aspect: ASPECT, method: "patch", reanalyze: true });
    expect(run.analyzed).toBe(3);
    expect(run.analyzedFiles).not.toContain(f.input);
    expect(run.plan.files.find((e) => e.input === f.input)).toMatchObject({
      action: "fix",
      patchFile: f.entry.patchFile,
    });
    expect((await revertPlan(f.plan, { inPlace: true })).files[0]!.status).toBe("would-revert");
  }, 300000);

  it("copies again after an in-place revert, though the input's mtime has moved", async () => {
    const f = await inPlaceFixture("revert-then-copy");
    expect((await applyPlan(f.plan, { inPlace: true, execute: true })).exitCode).toBe(0);
    expect((await revertPlan(f.plan, { inPlace: true, execute: true })).exitCode).toBe(0);
    const out = join(dir, "out-revert-then-copy");
    const run = await applyPlan(f.plan, { outputRoot: out, execute: true });
    expect(run.files[0]!.status).toBe("applied");
    expect((await hashFileChunked(join(out, "Scope (2024).mkv"))).sha256).toBe(f.fixedHash);
  }, 300000);

  it("reviews a half-patched file as one to finish, and says so when it is left that way", async () => {
    const f = await inPlaceFixture("review-half");
    const raw = { plan: f.plan, aspect: "2.39", logLevel: "error" };
    // Settle the library first (so only the half-patched file is asked about).
    expect(await runReview([f.lib], raw, io().io, async () => "n")).toBe(0);
    await appendApplyLog(planPaths(f.plan).applyLog, {
      time: new Date().toISOString(),
      event: "started",
      input: f.input,
      output: f.input,
      method: "patch",
      inPlace: true,
    });
    await writePatchesInPlace(f.input, f.patches.slice(0, Math.ceil(f.patches.length / 2)));

    const asked: string[] = [];
    const declined = io();
    expect(
      await runReview([f.lib], raw, declined.io, async (q) => {
        asked.push(q);
        return "n";
      }),
    ).toBe(6);
    expect(asked[0]).toMatch(/^Finish fixing "Scope \(2024\)\.mkv"\? A previous fix was interrupted/);
    expect(declined.text()).toMatch(/WARNING: "Scope \(2024\)\.mkv" is still partially modified/);

    expect(await runReview([f.lib], raw, io().io, async () => "y")).toBe(0);
    expect((await hashFileChunked(f.input)).sha256).toBe(f.fixedHash);
  }, 300000);

  it("drives the whole thing through the CLI, with the documented exit codes", async () => {
    const planDir4 = join(dir, "plan4");
    const out4 = join(dir, "out4");

    const planned = io();
    expect(
      await runPlanCommand(
        [library],
        { plan: planDir4, aspect: "2.39", logLevel: "error" },
        planned.io,
      ),
    ).toBe(0);
    expect(planned.text()).toMatch(/planned fixes: 1 file\(s\)/);

    const dry = io();
    expect(
      await runApply(planDir4, { outputRoot: out4, logLevel: "error" }, dry.io),
    ).toBe(0);
    expect(dry.text()).toContain("DRY RUN");
    expect(await exists(out4)).toBe(false);

    const executed = io();
    expect(
      await runApply(
        planDir4,
        { outputRoot: out4, execute: true, logLevel: "error" },
        executed.io,
      ),
    ).toBe(0);
    expect(executed.text()).toMatch(/applied\s+Scope \(2024\)\.mkv/);
    expect(await exists(join(out4, "Scope (2024).mkv"))).toBe(true);

    // --replace-original without --execute is a bad-argument refusal.
    const refused = io();
    expect(
      await runApply(
        planDir4,
        { outputRoot: out4, replaceOriginal: true },
        refused.io,
      ),
    ).toBe(2);
    expect(refused.err.join("")).toMatch(/--replace-original/);
  }, 300000);
});
