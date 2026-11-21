/**
 * The in-place mode end to end, through the protocol, on real MKVs built for
 * the test: fix the original where it is, check that nothing but subtitle
 * position fields changed, put it back and get the very file it started as;
 * then the two ways an interrupted write is finished. Fixtures only.
 */
import { copyFile, mkdir, readdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendApplyLog, readApplyLog } from "../../src/batch/log.js";
import { decodePatches, planPaths, readPatchFile, requirePlan } from "../../src/batch/planFile.js";
import { applyPlan } from "../../src/batch/apply.js";
import { runPlan } from "../../src/batch/plan.js";
import { invertPatches, revertPlan, writePatchesInPlace } from "../../src/batch/revert.js";
import { runDoctor } from "../../src/cli/doctor.js";
import { hashFileChunked } from "../../src/fix/copyPatch.js";
import { scanFile } from "../../src/scan/scanFile.js";
import { NEEDS_COPY_REASON } from "../../src/serve/protocol.js";
import { verifyFile } from "../../src/verify/verifyFile.js";
import { SCOPE_SPEC } from "../batch/support.js";
import {
  hasTool,
  makeLetterboxVideo,
  makeMkv,
  makeTempDir,
  removeDir,
  writeSup,
} from "../helpers/scanFixture.js";
import { startClient, type Client, type Msg } from "./harness.js";

const tools =
  (await hasTool("ffmpeg")) && (await hasTool("mkvmerge")) && (await hasTool("mkvextract"));

const sha = async (path: string): Promise<string> => (await hashFileChunked(path)).sha256;

describe.skipIf(!tools)("fixing the originals in place, through the protocol", () => {
  let dir: string;
  let video: string;
  let scopeSup: string;

  /** A library of its own for one test: a patch title, a compressed one, and a pristine copy of the first. */
  async function library(name: string) {
    const lib = join(dir, `library-${name}`);
    await mkdir(lib, { recursive: true });
    const plain = await makeMkv(join(lib, "Plain (2024).mkv"), video, scopeSup);
    const zlib = await makeMkv(join(lib, "Zlib (2015).mkv"), video, scopeSup, { compression: "zlib" });
    const pristine = join(dir, `pristine-${name}.mkv`);
    await copyFile(plain, pristine);
    return { lib, plain, zlib, pristine, planDir: join(dir, `plan-${name}`), original: await sha(plain) };
  }

  const done = (c: Client, id: number): Promise<Msg> =>
    c.waitFor((m) => m.id === id && (m.result ?? m.error) !== undefined);
  const scan = async (c: Client, lib: string, planDir: string, extra: object = {}): Promise<Msg> =>
    done(c, c.post("plan", { paths: [lib], planDir, remuxFallback: true, ...extra }));
  const view = (plan: Msg, input: string) => plan.result.files.find((f: { input: string }) => f.input === input);

  beforeAll(async () => {
    dir = await makeTempDir();
    video = await makeLetterboxVideo(join(dir, "video.mkv"), { activeHeight: 804, seconds: 8 });
    scopeSup = await writeSup(join(dir, "scope.sup"), SCOPE_SPEC);
  }, 300000);

  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  it("fixes the original, changes only position fields, and puts back the very file it was", async () => {
    const f = await library("roundtrip");
    const c = startClient();
    const planned = await scan(c, f.lib, f.planDir);
    expect(planned.error).toBeUndefined();
    expect(planned.result.undoRecords).toBe(0);
    expect(view(planned, f.plain)).toMatchObject({ action: "fix", method: "patch" });
    expect(view(planned, f.zlib)).toMatchObject({ action: "fix", method: "remux" });
    const listing = (await readdir(f.lib)).sort();

    // A rehearsal changes nothing.
    const dry = await done(c, c.post("apply", { planDir: f.planDir, mode: "in-place", only: [f.plain], dryRun: true }));
    expect(dry.result).toMatchObject({ mode: "in-place", dryRun: true });
    expect(dry.result.files[0].status).toBe("would-apply");
    expect(await sha(f.plain)).toBe(f.original);

    // Both ticked: the patch title is fixed where it is, the compressed one is refused by name.
    const zlibBefore = await sha(f.zlib);
    const applyId = c.post("apply", { planDir: f.planDir, mode: "in-place", only: [f.plain, f.zlib] });
    const applied = await done(c, applyId);
    expect(applied.error).toBeUndefined();
    expect(applied.result).toMatchObject({ mode: "in-place", outputRoot: "", cancelled: false });
    expect(applied.result.summary).toMatchObject({ planned: 2, applied: 1, verified: 1, skipped: 1, failed: 0 });
    const fixed = applied.result.files.find((x: { input: string }) => x.input === f.plain);
    const refused = applied.result.files.find((x: { input: string }) => x.input === f.zlib);
    expect(fixed).toMatchObject({ status: "applied", verified: true, inPlace: true, output: f.plain });
    expect(fixed.checks.join("\n")).toMatch(/wrote and read back \d+ range\(s\) in place/);
    expect(refused).toMatchObject({ status: "skipped", skipKind: "needs-copy", reason: NEEDS_COPY_REASON });
    expect(await sha(f.zlib)).toBe(zlibBefore);
    expect(c.eventsOf(applyId, "apply.file-progress").map((m) => m.data.phase)).toEqual(["in-place"]);
    // No copy, no backup, no temp file: the folder holds what it held.
    expect((await readdir(f.lib)).sort()).toEqual(listing);

    // The original changed — and only in PGS position fields, by `verify`'s own byte diff.
    expect(await sha(f.plain)).not.toBe(f.original);
    const report = await verifyFile(f.pristine, f.plain, { aspect: 2.39 });
    expect(report.checks.filter((x) => !x.pass)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.payloadMode).toBe("byte-identical");
    expect((await scanFile(f.plain, { aspect: 2.39 })).status).toBe("OK");
    const log = await readApplyLog(planPaths(f.planDir).applyLog);
    expect(log.map((e) => e.event)).toEqual(["started", "patched"]);

    // A rescan knows it, does not read the file again, and the plan folder is now precious.
    const rescan = await scan(c, f.lib, f.planDir);
    expect(rescan.result.analyzed).toBe(0);
    expect(rescan.result.undoRecords).toBe(1);
    expect(view(rescan, f.plain).fixed).toMatchObject({ output: f.plain, inPlace: true });
    expect(view(rescan, f.plain).interrupted).toBeUndefined();
    const rebuild = await scan(c, f.lib, f.planDir, { reanalyze: true });
    expect(rebuild.error!.code).toBe("undo-records");
    expect((await requirePlan(f.planDir)).files).toHaveLength(2);

    // A second fix is not a second write.
    const again = await done(c, c.post("apply", { planDir: f.planDir, mode: "in-place", only: [f.plain] }));
    expect(again.result.files[0]).toMatchObject({ status: "skipped", skipKind: "already-done" });

    // Undo: rehearsed, then for real — and the file is the one it started as.
    const wouldRevert = await done(c, c.post("revert", { planDir: f.planDir, only: [f.plain], dryRun: true }));
    expect(wouldRevert.result.files[0].status).toBe("would-revert");
    expect(await sha(f.plain)).not.toBe(f.original);
    const revertId = c.post("revert", { planDir: f.planDir, only: [f.plain, f.zlib] });
    const reverted = await done(c, revertId);
    expect(reverted.error).toBeUndefined();
    expect(reverted.result.summary).toEqual({ asked: 2, reverted: 1, skipped: 1, failed: 0 });
    expect(reverted.result.files.find((x: { input: string }) => x.input === f.plain)).toMatchObject({ status: "reverted" });
    expect(await sha(f.plain)).toBe(f.original);
    expect(c.eventsOf(revertId, "revert.file-done")).toHaveLength(2);

    // Not fixed any more, by the plan's own account; the undo record is still counted.
    const after = await scan(c, f.lib, f.planDir);
    expect(view(after, f.plain).fixed).toBeUndefined();
    expect(after.result.undoRecords).toBe(1);
    const nothing = await done(c, c.post("revert", { planDir: f.planDir, only: [f.plain] }));
    expect(nothing.result.files[0]).toMatchObject({ status: "skipped" });

    // And it can be fixed again.
    const refix = await done(c, c.post("apply", { planDir: f.planDir, mode: "in-place", only: [f.plain] }));
    expect(refix.result.files[0]).toMatchObject({ status: "applied", verified: true });
    await c.close();
  }, 300000);

  it("keeps the file's date through a fix and an undo when asked, waiting once for each", async () => {
    const f = await library("dates");
    // The real engine; only the watch's window is short, so a local disk has one to wait out.
    const c = startClient({ runDoctor, runPlan, applyPlan, revertPlan, dateWatchOptions: { windowMs: 400, pollMs: 25 } });
    const old = new Date("2019-05-06T07:08:09.000Z");
    await utimes(f.plain, old, old);
    await scan(c, f.lib, f.planDir);

    const applyId = c.post("apply", { planDir: f.planDir, mode: "in-place", only: [f.plain], keepDates: true });
    const applied = await done(c, applyId);
    expect(applied.error).toBeUndefined();
    expect(applied.result.files[0]).toMatchObject({ status: "applied", verified: true });
    expect(applied.result.files[0].dateNotKept).toBeUndefined();
    expect(await sha(f.plain)).not.toBe(f.original);
    expect(Math.abs((await stat(f.plain)).mtimeMs - old.getTime())).toBeLessThan(2000);
    const log = await readApplyLog(planPaths(f.planDir).applyLog);
    const started = log.find((e) => e.event === "started");
    expect(Math.abs(started!.keepMtimeMs! - old.getTime())).toBeLessThan(2000);
    expect(c.eventsOf(applyId, "apply.dates").map((m) => m.data)).toEqual([{ files: 1, seconds: 1 }]);

    const revertId = c.post("revert", { planDir: f.planDir, only: [f.plain], keepDates: true });
    const reverted = await done(c, revertId);
    expect(reverted.result.files[0]).toMatchObject({ status: "reverted" });
    expect(await sha(f.plain)).toBe(f.original);
    expect(Math.abs((await stat(f.plain)).mtimeMs - old.getTime())).toBeLessThan(2000);
    expect(c.eventsOf(revertId, "revert.dates")).toHaveLength(1);
    await c.close();
  }, 300000);

  it("a copy-mode request still writes a copy and leaves the original alone", async () => {
    const f = await library("copy");
    const c = startClient();
    await scan(c, f.lib, f.planDir);
    const out = join(dir, "fixed-copy");
    const applied = await done(c, c.post("apply", { planDir: f.planDir, outputRoot: out, only: [f.plain] }));
    expect(applied.result).toMatchObject({ mode: "copy", outputRoot: out });
    expect(applied.result.files[0]).toMatchObject({ status: "applied", verified: true, output: join(out, "Plain (2024).mkv") });
    expect(applied.result.files[0].inPlace).toBeUndefined();
    expect(await sha(f.plain)).toBe(f.original);
    const rescan = await scan(c, f.lib, f.planDir);
    expect(rescan.result.undoRecords).toBe(0);
    expect(view(rescan, f.plain).fixed.inPlace).toBeUndefined();
    // Nothing of the original's to put back.
    const revert = await done(c, c.post("revert", { planDir: f.planDir, only: [f.plain] }));
    expect(revert.result.files[0]).toMatchObject({ status: "skipped", reason: expect.stringMatching(/fixed as a copy/) });
    expect(await sha(join(out, "Plain (2024).mkv"))).not.toBe(f.original);
    await c.close();
  }, 300000);

  /** The state a fix killed mid-write leaves: its `started` record, and half the changes in the file. */
  async function interrupt(f: Awaited<ReturnType<typeof library>>, c: Client): Promise<string> {
    await scan(c, f.lib, f.planDir);
    const entry = (await requirePlan(f.planDir)).files.find((e) => e.input === f.plain)!;
    const patches = decodePatches((await readPatchFile(f.planDir, entry.patchFile!)).patches);
    await appendApplyLog(planPaths(f.planDir).applyLog, {
      time: new Date().toISOString(),
      event: "started",
      input: f.plain,
      output: f.plain,
      method: "patch",
      bytes: entry.size,
      inPlace: true,
    });
    await writePatchesInPlace(f.plain, patches.slice(0, Math.ceil(patches.length / 2)));
    expect(invertPatches(patches)).toHaveLength(patches.length);
    return sha(f.plain);
  }

  it("shows an interrupted fix after a scan, and finishes it", async () => {
    const f = await library("interrupted-finish");
    const c = startClient();
    const half = await interrupt(f, c);
    expect(half).not.toBe(f.original);

    const seen = await scan(c, f.lib, f.planDir);
    expect(seen.error).toBeUndefined();
    const row = view(seen, f.plain);
    expect(row.interrupted).toMatchObject({ doing: "fix" });
    expect(row.fixed).toBeUndefined();
    expect(seen.result.undoRecords).toBe(1);
    // The half-written file was not read as a new title.
    expect(await sha(f.plain)).toBe(half);

    const finished = await done(c, c.post("apply", { planDir: f.planDir, mode: "in-place", only: [f.plain] }));
    expect(finished.result.files[0]).toMatchObject({ status: "applied", verified: true, resumed: "half-written" });
    const report = await verifyFile(f.pristine, f.plain, { aspect: 2.39 });
    expect(report.pass).toBe(true);
    const after = await scan(c, f.lib, f.planDir);
    expect(view(after, f.plain).interrupted).toBeUndefined();
    expect(view(after, f.plain).fixed).toMatchObject({ inPlace: true });
    await c.close();
  }, 300000);

  it("puts an interrupted fix back instead, to the very file it was", async () => {
    const f = await library("interrupted-undo");
    const c = startClient();
    await interrupt(f, c);
    const seen = await scan(c, f.lib, f.planDir);
    expect(view(seen, f.plain).interrupted).toMatchObject({ doing: "fix" });

    const back = await done(c, c.post("revert", { planDir: f.planDir, only: [f.plain] }));
    expect(back.error).toBeUndefined();
    expect(back.result.files[0]).toMatchObject({ status: "reverted" });
    expect(await sha(f.plain)).toBe(f.original);
    const after = await scan(c, f.lib, f.planDir);
    expect(view(after, f.plain).interrupted).toBeUndefined();
    expect(view(after, f.plain).fixed).toBeUndefined();
    await c.close();
  }, 300000);

  it("refuses a file that has changed since the scan rather than write into it", async () => {
    const f = await library("changed");
    const c = startClient();
    await scan(c, f.lib, f.planDir);
    const later = new Date(Date.now() + 60_000);
    await utimes(f.plain, later, later);
    const r = await done(c, c.post("apply", { planDir: f.planDir, mode: "in-place", only: [f.plain] }));
    expect(r.result.files[0]).toMatchObject({ status: "skipped", skipKind: "input-changed", verified: false });
    expect(await sha(f.plain)).toBe(f.original);
    await c.close();
  }, 300000);
});
