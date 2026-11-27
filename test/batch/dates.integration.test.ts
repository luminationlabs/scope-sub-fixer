/**
 * File dates and in-place writes: the date moves by default, `preserveDates`
 * keeps it, and `restoreDates` puts back the one the plan recorded before its
 * first write.
 */
import { appendFile, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPlan } from "../../src/batch/apply.js";
import { dateToKeep, DateWatch, keepDate, restoreDates, settleDates } from "../../src/batch/dates.js";
import { readApplyLog, type ApplyLogEvent } from "../../src/batch/log.js";
import { runPlan } from "../../src/batch/plan.js";
import { planPaths, requirePlan, type PlanFile } from "../../src/batch/planFile.js";
import { revertPlan } from "../../src/batch/revert.js";
import { runRemargin } from "../../src/cli/remargin.js";
import {
  hasTool,
  makeLetterboxVideo,
  makeMkv,
  makeTempDir,
  removeDir,
  writeSup,
} from "../helpers/scanFixture.js";
import { SCOPE_SPEC } from "./support.js";

const tools =
  (await hasTool("ffmpeg")) && (await hasTool("mkvmerge")) && (await hasTool("mkvextract"));

const ASPECT = 2.39;
/** 19 Jan 2015, a whole second: any filesystem stores it exactly. */
const OLD = Date.UTC(2015, 0, 19, 3, 15, 42);
const mtime = async (path: string): Promise<number> => (await stat(path)).mtimeMs;
const near = (a: number, b: number): boolean => Math.abs(a - b) < 2;

describe.skipIf(!tools)("file dates and in-place writes", () => {
  let dir: string;
  let library: string;
  let plan: string;
  let a: string;
  let b: string;
  let c: string;
  let d: string;
  const io = { stdout: () => undefined, stderr: () => undefined };

  beforeAll(async () => {
    dir = await makeTempDir();
    library = join(dir, "lib");
    plan = join(dir, "plan");
    await mkdir(library, { recursive: true });
    const video = await makeLetterboxVideo(join(dir, "video.mkv"), { activeHeight: 804, seconds: 8 });
    const sup = await writeSup(join(dir, "scope.sup"), SCOPE_SPEC);
    a = join(library, "A (2001).mkv");
    b = join(library, "B (2002).mkv");
    c = join(library, "C (2003).mkv");
    d = join(library, "D (2004).mkv");
    for (const file of [a, b, c, d]) {
      await makeMkv(file, video, sup, { trackName: "English" });
      await utimes(file, OLD / 1000, OLD / 1000);
    }
    // A plan made under another default: margin 8, recorded as "the default".
    await runPlan([library], plan, { aspect: ASPECT, method: "patch", margin: 8 });
    const path = join(plan, "plan.json");
    const raw = JSON.parse(await readFile(path, "utf8")) as PlanFile;
    delete raw.options.margin;
    await writeFile(path, JSON.stringify(raw));
  }, 300000);

  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  it("moves the date by default", async () => {
    const run = await applyPlan(plan, { inPlace: true, execute: true, only: [a] });
    expect(run.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(await mtime(a)).toBeGreaterThan(OLD + 1000);
  }, 120000);

  it("keeps the date with preserveDates, and plan still finds the file unchanged", async () => {
    const run = await applyPlan(plan, {
      inPlace: true,
      execute: true,
      only: [b],
      preserveDates: true,
    });
    expect(run.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(near(await mtime(b), OLD)).toBe(true);
    expect(run.files[0]?.checks.join("\n")).toContain("preserved the file's date");

    const log = (await readApplyLog(planPaths(plan).applyLog)).filter((e) => e.input === b);
    expect(log.find((e) => e.event === "started")?.keepMtimeMs).toBeCloseTo(OLD, -1);
    expect(near(log.find((e) => e.event === "patched")?.stamp?.mtimeMs ?? 0, OLD)).toBe(true);

    const again = await runPlan([library], plan, { aspect: ASPECT, method: "patch" });
    expect(again.keptChanged).toEqual([]);
    expect(again.adopted).toEqual([]);
    expect(again.analyzedFiles).toEqual([]);
  }, 120000);

  it("keeps the date through a revert and a second repair", async () => {
    const back = await revertPlan(plan, {
      inPlace: true,
      execute: true,
      only: [b],
      preserveDates: true,
    });
    expect(back.summary).toMatchObject({ reverted: 1, failed: 0 });
    expect(near(await mtime(b), OLD)).toBe(true);
    const run = await applyPlan(plan, {
      inPlace: true,
      execute: true,
      only: [b],
      preserveDates: true,
    });
    expect(run.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(near(await mtime(b), OLD)).toBe(true);
  }, 120000);

  it("puts the kept date back when a share re-stamps the file after each write", async () => {
    const restamp = async (): Promise<void> => {
      const now = Date.now() / 1000;
      await utimes(b, now, now);
    };
    const lastRecord = async (event: string): Promise<ApplyLogEvent | undefined> =>
      (await readApplyLog(planPaths(plan).applyLog)).filter((e) => e.input === b && e.event === event).at(-1);

    // A revert nobody watches (no window), as a run killed after it leaves
    // things: the share dates the write, and the file has lost its date.
    const back = await revertPlan(
      plan,
      { inPlace: true, execute: true, only: [b], preserveDates: true },
      { dateWatch: new DateWatch({ windowMs: 0 }) },
    );
    expect(back.summary).toMatchObject({ reverted: 1, failed: 0 });
    expect((await lastRecord("reverted"))?.keepMtimeMs).toBeCloseTo(OLD, -1);
    await restamp();
    expect(near(await mtime(b), OLD)).toBe(false);

    // The repair finds the file at the share's date for the revert and still
    // keeps the original: the revert's record says which date was meant.
    // The watch is the caller's: the run adds to it and does not wait.
    const watch = new DateWatch({ windowMs: 60_000, pollMs: 25 });
    const run = await applyPlan(
      plan,
      { inPlace: true, execute: true, only: [b], preserveDates: true },
      { dateWatch: watch },
    );
    expect(run.summary).toMatchObject({ applied: 1, failed: 0 });
    expect((await lastRecord("patched"))?.keepMtimeMs).toBeCloseTo(OLD, -1);
    expect(near((await lastRecord("patched"))?.stamp?.mtimeMs ?? 0, OLD)).toBe(true);
    // The share dates the repair's write too; the watch, polling in the
    // background long before its window ends, puts the date back.
    await restamp();
    await new Promise((r) => setTimeout(r, 300));
    expect(near(await mtime(b), OLD)).toBe(true);
    const stop = new AbortController();
    stop.abort();
    await watch.settle(stop.signal);
    expect(near(await mtime(b), OLD)).toBe(true);
  }, 120000);

  it("finishes an interrupted write with the date that write promised", async () => {
    // As a killed run leaves it: a `started` record, and a file whose date is
    // already the interrupted write's.
    await appendFile(
      planPaths(plan).applyLog,
      `${JSON.stringify({
        time: new Date().toISOString(),
        event: "started",
        input: c,
        output: c,
        method: "patch",
        inPlace: true,
        keepMtimeMs: OLD,
      })}\n`,
    );
    const now = Date.now() / 1000;
    await utimes(c, now, now);
    const run = await applyPlan(plan, {
      inPlace: true,
      execute: true,
      only: [c],
      preserveDates: true,
    });
    expect(run.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(near(await mtime(c), OLD)).toBe(true);
  }, 120000);

  it("does not honour the promise of a write that never touched the file", async () => {
    // `started` (promising OLD), then the write failed on open. The file's
    // date, set since by something else, is older than that record.
    const other = Date.UTC(2018, 4, 5);
    await utimes(d, other / 1000, other / 1000);
    const log = planPaths(plan).applyLog;
    const base = { input: d, output: d, method: "patch", inPlace: true };
    await appendFile(
      log,
      `${JSON.stringify({ ...base, time: new Date().toISOString(), event: "started", keepMtimeMs: OLD })}\n` +
        `${JSON.stringify({ ...base, time: new Date().toISOString(), event: "failed", reason: "x" })}\n`,
    );
    const run = await applyPlan(plan, {
      inPlace: true,
      execute: true,
      only: [d],
      preserveDates: true,
    });
    expect(run.summary).toMatchObject({ applied: 1, failed: 0 });
    expect(near(await mtime(d), other)).toBe(true);
    // Put back for the tests below, which expect D unwritten and untouched.
    const back = await revertPlan(plan, { inPlace: true, execute: true, only: [d], preserveDates: true });
    expect(back.summary).toMatchObject({ reverted: 1, failed: 0 });
    await utimes(d, OLD / 1000, OLD / 1000);
  }, 120000);

  it("restores nothing on a dry run, and says what it would", async () => {
    const before = await mtime(a);
    const run = await restoreDates(plan);
    const row = run.files.find((f) => f.input === a);
    expect(row).toMatchObject({ status: "would-restore", to: OLD });
    expect(run.files.find((f) => f.input === b)?.status).toBe("already");
    // At the date the plan recorded for it: nothing to put back.
    expect(run.files.find((f) => f.input === d)?.status).toBe("already");
    expect(await mtime(a)).toBe(before);
  });

  it("leaves alone a file whose date something else has changed since", async () => {
    const mine = await stat(a);
    const other = Date.UTC(2020, 5, 1) / 1000;
    await utimes(a, other, other);
    const run = await restoreDates(plan, { execute: true, file: "A (2001)" });
    expect(run.files).toHaveLength(1);
    expect(run.files[0]).toMatchObject({ status: "skipped" });
    expect(run.files[0]?.reason).toContain("something else has modified it");
    expect(near(await mtime(a), other * 1000)).toBe(true);
    await utimes(a, mine.atimeMs / 1000, mine.mtimeMs / 1000);
  });

  it("restores the original date after a repair was redone, and plan finds it unchanged", async () => {
    // Redone without preserveDates: two more writes, a second patch file made
    // from the put-back file, whose date is not the original.
    const code = await runRemargin(
      [library],
      { plan, aspect: String(ASPECT), execute: true, logLevel: "error" },
      io,
    );
    expect(code).toBe(0);
    expect(await mtime(a)).toBeGreaterThan(OLD + 1000);

    const run = await restoreDates(plan, { execute: true });
    expect(run.files.find((f) => f.input === a)).toMatchObject({ status: "restored", to: OLD });
    expect(run.files.some((f) => f.status === "failed")).toBe(false);
    for (const file of [a, b, c]) expect(near(await mtime(file), OLD)).toBe(true);
    const entry = (await requirePlan(plan)).files.find((f) => f.input === a);
    expect(near(entry?.mtimeMs ?? 0, OLD)).toBe(true);

    const again = await runPlan([library], plan, { aspect: ASPECT, method: "patch" });
    expect(again.keptChanged).toEqual([]);
    expect(again.adopted).toEqual([]);
    expect(again.analyzedFiles).toEqual([]);

    const twice = await restoreDates(plan, { execute: true });
    expect(twice.files.every((f) => f.status === "already")).toBe(true);
  }, 300000);

  it("still reverts to the original bytes afterwards", async () => {
    const back = await revertPlan(plan, { inPlace: true, execute: true, preserveDates: true });
    expect(back.summary.failed).toBe(0);
    expect(back.summary.reverted).toBeGreaterThanOrEqual(3);
    for (const file of [a, b, c]) expect(near(await mtime(file), OLD)).toBe(true);
  }, 120000);
});

describe.skipIf(!tools)("restoreDates and a title analyzed twice before its first write", () => {
  let dir: string;
  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  it("takes the date of the analysis the write used, not an earlier one", async () => {
    dir = await makeTempDir();
    const library = join(dir, "lib");
    const plan = join(dir, "plan");
    await mkdir(library, { recursive: true });
    const video = await makeLetterboxVideo(join(dir, "video.mkv"), { activeHeight: 804, seconds: 8 });
    const sup = await writeSup(join(dir, "scope.sup"), SCOPE_SPEC);
    const file = join(library, "E (2005).mkv");
    await makeMkv(file, video, sup, { trackName: "English" });
    await utimes(file, OLD / 1000, OLD / 1000);
    await runPlan([library], plan, { aspect: ASPECT, method: "patch" });

    // The file's date changes; an in-place attempt is refused and logged, so
    // the next plan analyzes it again under a new patch file name.
    const later = Date.UTC(2018, 4, 5);
    await utimes(file, later / 1000, later / 1000);
    const refused = await applyPlan(plan, { inPlace: true, execute: true });
    expect(refused.summary.applied).toBe(0);
    await runPlan([library], plan, { aspect: ASPECT, method: "patch" });
    const applied = await applyPlan(plan, { inPlace: true, execute: true });
    expect(applied.summary).toMatchObject({ applied: 1, failed: 0 });

    const run = await restoreDates(plan, { execute: true });
    expect(run.files).toHaveLength(1);
    expect(run.files[0]).toMatchObject({ status: "restored", to: later });
    expect(near(await mtime(file), later)).toBe(true);
  }, 300000);
});

describe("settleDates and a share that re-stamps a file after a write", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await makeTempDir();
  });
  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  it("sets the date again when it is replaced inside the window", async () => {
    const file = join(dir, "f.bin");
    await writeFile(file, "x");
    expect(await keepDate(file, OLD)).toBeUndefined();
    // What the share does: some time after the write, the date becomes "now".
    const restamp = setTimeout(() => {
      const now = Date.now() / 1000;
      void utimes(file, now, now);
    }, 150);
    const problems = await settleDates([{ path: file, mtimeMs: OLD, writtenAt: Date.now() }], {
      windowMs: 700,
      pollMs: 40,
    });
    clearTimeout(restamp);
    expect(problems).toEqual([]);
    expect(near(await mtime(file), OLD)).toBe(true);
  });

  it("does not wait when the window has already passed, or there is none", async () => {
    const file = join(dir, "g.bin");
    await writeFile(file, "x");
    const started = Date.now();
    await settleDates([{ path: file, mtimeMs: OLD, writtenAt: Date.now() - 10_000 }], { windowMs: 5_000 });
    expect(near(await mtime(file), OLD)).toBe(true);
    const now = Date.now() / 1000;
    await utimes(file, now, now);
    await settleDates([{ path: file, mtimeMs: OLD, writtenAt: Date.now() }], { windowMs: 0 });
    expect(Date.now() - started).toBeLessThan(1000);
    // No window, no watch: the file is left as it was found.
    expect(near(await mtime(file), OLD)).toBe(false);
  });

  it("watches a file added twice for the later date, and reports a watch cut short", async () => {
    const file = join(dir, "h.bin");
    await writeFile(file, "x");
    const LATER = OLD + 86_400_000;
    const watch = new DateWatch({ windowMs: 60_000, pollMs: 20 });
    watch.add(file, OLD);
    watch.add(file, LATER);
    await new Promise((r) => setTimeout(r, 100));
    expect(near(await mtime(file), LATER)).toBe(true);
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 50);
    const problems = await watch.settle(stop.signal);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.problem).toContain("cancelled before");
    expect(near(await mtime(file), LATER)).toBe(true);
    // Nothing left over: a second settle has nothing to wait for or report.
    expect(await watch.settle()).toEqual([]);
  });

  it("reports a date that could not be set at once, unless the watch sets it after all", async () => {
    const file = join(dir, "n.bin");
    await writeFile(file, "x");
    // No window (a local disk): nothing is watched, the problem is still told.
    const local = new DateWatch({ windowMs: 0 });
    local.add(file, OLD, Date.now(), "not permitted");
    expect(await local.settle()).toEqual([{ path: file, problem: "not permitted" }]);
    local.add(file, OLD, Date.now(), "not permitted");
    local.add(file, OLD);
    expect(await local.settle()).toEqual([]);
    // With a window the watch tries again, and its success is the answer.
    const share = new DateWatch({ windowMs: 150, pollMs: 20 });
    share.add(file, OLD, Date.now(), "not permitted");
    expect(await share.settle()).toEqual([]);
    expect(near(await mtime(file), OLD)).toBe(true);
  });

  it("reports a file that is gone rather than throwing", async () => {
    const problems = await settleDates(
      [{ path: join(dir, "missing.bin"), mtimeMs: OLD, writtenAt: Date.now() }],
      { windowMs: 100, pollMs: 20 },
    );
    expect(problems).toHaveLength(1);
  });
});

describe("dateToKeep", () => {
  const at = Date.UTC(2026, 10, 22, 12, 0, 0);
  const rec = (event: string, extra: object = {}) =>
    ({ time: new Date(at).toISOString(), event, input: "/m/a.mkv", ...extra }) as ApplyLogEvent;

  it("is the file's own date when the last write kept none", () => {
    expect(dateToKeep(undefined, 5)).toBe(5);
    expect(dateToKeep(rec("patched"), at)).toBe(at);
  });

  it("is the kept date when the file now carries that write's own stamp", () => {
    const patched = rec("patched", { keepMtimeMs: OLD, durationMs: 300_000 });
    expect(dateToKeep(patched, at - 200_000)).toBe(OLD);
    expect(dateToKeep(rec("reverted", { keepMtimeMs: OLD, durationMs: 20_000 }), at + 2_000)).toBe(OLD);
  });

  it("is the file's own date when it is neither: older, or changed by something else since", () => {
    const patched = rec("patched", { keepMtimeMs: OLD, durationMs: 300_000 });
    const edited = at + 5 * 24 * 3600 * 1000;
    expect(dateToKeep(patched, edited)).toBe(edited);
    const older = Date.UTC(2018, 4, 5);
    expect(dateToKeep(patched, older)).toBe(older);
    expect(dateToKeep(rec("started", { keepMtimeMs: OLD }), older)).toBe(older);
    expect(dateToKeep(rec("started", { keepMtimeMs: OLD }), at + 60_000)).toBe(OLD);
  });
});
