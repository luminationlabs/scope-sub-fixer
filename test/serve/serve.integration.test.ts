/**
 * The engine protocol against real MKVs built with ffmpeg + mkvmerge: plan with
 * progress, cancellation, and a fix into a copy. Skipped when the tools are
 * missing.
 */
import { access, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPlan, type ApplyProgress } from "../../src/batch/apply.js";
import { readApplyLog } from "../../src/batch/log.js";
import { runPlan, type PlanProgress } from "../../src/batch/plan.js";
import { planPaths, requirePlan } from "../../src/batch/planFile.js";
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
import { SCOPE_SPEC, SAFE_SPEC } from "../batch/support.js";
import { startClient } from "./harness.js";
import { tempEnvVars } from "../../src/cli/serve.js";

const tools =
  (await hasTool("ffmpeg")) && (await hasTool("mkvmerge")) && (await hasTool("mkvextract"));

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!tools)("the engine protocol, end to end", () => {
  let dir: string;
  let library: string;
  let scope: string;
  let other: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    library = join(dir, "library");
    await mkdir(join(library, "Scope (2024)"), { recursive: true });
    const video = await makeLetterboxVideo(join(dir, "video.mkv"), { activeHeight: 804, seconds: 8 });
    const scopeSup = await writeSup(join(dir, "scope.sup"), SCOPE_SPEC);
    const safeSup = await writeSup(join(dir, "safe.sup"), SAFE_SPEC);
    scope = await makeMkv(join(library, "Scope (2024)", "Scope (2024).mkv"), video, scopeSup);
    other = await makeMkv(join(library, "Another Scope (2020).mkv"), video, scopeSup);
    await makeMkv(join(library, "Safe (2019).mkv"), video, safeSup);
  }, 300000);

  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  it("runPlan reports every file's start and finish, and the read in between", async () => {
    const events: PlanProgress[] = [];
    const run = await runPlan(
      [library],
      join(dir, "plan-progress"),
      { aspect: 2.39, recursive: true },
      { onProgress: (p) => events.push(p) },
    );
    expect(run.cancelled).toBeUndefined();
    expect(events[0]!.type).toBe("targets");
    expect(events[0]!.type === "targets" && events[0]!.targets).toHaveLength(3);
    expect(events.filter((e) => e.type === "file-start")).toHaveLength(3);
    const done = events.filter((e) => e.type === "file-done");
    expect(done).toHaveLength(3);
    expect(done.every((e) => e.type === "file-done" && e.analyzed)).toBe(true);
    const progress = events.filter((e) => e.type === "file-progress");
    expect(progress.length).toBeGreaterThan(0);
    const last = progress[progress.length - 1]!;
    expect(last.type === "file-progress" && last.position).toBe(
      last.type === "file-progress" ? last.fileSize : -1,
    );

    // A second run reads nothing, and says so.
    const again: PlanProgress[] = [];
    await runPlan(
      [library],
      join(dir, "plan-progress"),
      { aspect: 2.39, recursive: true },
      { onProgress: (p) => again.push(p) },
    );
    const reused = again.filter((e) => e.type === "file-done");
    expect(reused).toHaveLength(3);
    expect(reused.every((e) => e.type === "file-done" && !e.analyzed)).toBe(true);
    expect(again.some((e) => e.type === "file-progress")).toBe(false);
  }, 120000);

  it("a cancelled runPlan keeps what it finished and can be resumed", async () => {
    const planDir = join(dir, "plan-cancel");
    const controller = new AbortController();
    let done = 0;
    const run = await runPlan(
      [library],
      planDir,
      { aspect: 2.39, recursive: true },
      {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.type === "file-done" && ++done === 1) controller.abort();
        },
      },
    );
    expect(run.cancelled).toBe(true);
    expect(run.plan.files).toHaveLength(1);
    expect((await requirePlan(planDir)).files).toHaveLength(1);

    const resumed = await runPlan([library], planDir, { aspect: 2.39, recursive: true });
    expect(resumed.cancelled).toBeUndefined();
    expect(resumed.reused).toBe(1);
    expect(resumed.analyzed).toBe(2);
    expect(resumed.plan.files).toHaveLength(3);
  }, 120000);

  it("a runPlan cancelled in the middle of a read records no verdict for that file", async () => {
    const planDir = join(dir, "plan-cancel-mid");
    const controller = new AbortController();
    const run = await runPlan(
      [scope],
      planDir,
      { aspect: 2.39 },
      {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.type === "file-progress") controller.abort();
        },
      },
    );
    expect(run.cancelled).toBe(true);
    // Not an ERROR entry: nothing at all, so the next run reads it.
    expect(run.plan.files).toHaveLength(0);
    const resumed = await runPlan([scope], planDir, { aspect: 2.39 });
    expect(resumed.plan.files[0]!.status).toBe("NEEDS_FIX");
  }, 120000);

  it("a runPlan cancelled while the picture is being sampled records no verdict either", async () => {
    const planDir = join(dir, "plan-cancel-sampling");
    const controller = new AbortController();
    const started = Date.now();
    const run = await runPlan(
      [scope],
      planDir,
      { aspect: "auto" },
      {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.type === "file-start") controller.abort();
        },
      },
    );
    expect(run.cancelled).toBe(true);
    expect(run.plan.files).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(5000);
    const resumed = await runPlan([scope], planDir, { aspect: "auto" });
    expect(resumed.plan.files[0]!.status).toBe("NEEDS_FIX");
  }, 120000);

  it("applyPlan reports its phases, and a cancelled copy leaves nothing behind", async () => {
    const planDir = join(dir, "plan-apply");
    await runPlan([library], planDir, { aspect: 2.39, recursive: true });

    // Cancel during the first file's copy.
    const cancelRoot = join(dir, "out-cancelled");
    const controller = new AbortController();
    const cancelled = await applyPlan(
      planDir,
      { outputRoot: cancelRoot, execute: true, chunkSize: 4096 },
      {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.type === "file-progress" && p.phase === "copy") controller.abort();
        },
      },
    );
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.files).toHaveLength(1);
    expect(cancelled.files[0]!.status).toBe("failed");
    expect(cancelled.files[0]!.reason).toBe("cancelled");
    const left = (await exists(cancelRoot)) ? await readdir(cancelRoot, { recursive: true }) : [];
    expect(left.filter((n) => n.endsWith(".mkv") || n.endsWith(".scope-sub-partial"))).toEqual([]);

    // The same plan then applies cleanly: a cancelled file is not "done".
    const events: ApplyProgress[] = [];
    const outputRoot = join(dir, "out-progress");
    const run = await applyPlan(
      planDir,
      { outputRoot, execute: true, chunkSize: 4096 },
      { onProgress: (p) => events.push(p) },
    );
    expect(run.cancelled).toBeUndefined();
    expect(run.summary.applied).toBe(2);
    expect(run.summary.verified).toBe(2);
    expect(events.filter((e) => e.type === "file-start")).toHaveLength(2);
    expect(events.filter((e) => e.type === "file-done")).toHaveLength(2);
    for (const input of [scope, other]) {
      const phases = events
        .filter((e) => e.type === "file-progress" && e.input === input)
        .map((e) => (e.type === "file-progress" ? e.phase : ""));
      expect(phases[0]).toBe("copy");
      expect(phases.slice(-2)).toEqual(["read-back", "verify"]);
      const copies = events.filter(
        (e) => e.type === "file-progress" && e.input === input && e.phase === "copy",
      );
      const lastCopy = copies[copies.length - 1]!;
      expect(lastCopy.type === "file-progress" && lastCopy.done).toBe((await stat(input)).size);
    }
  }, 120000);

  it("serves scan → fix into a copy, with the originals untouched", async () => {
    const planDir = join(dir, "plan-serve");
    const outputRoot = join(dir, "fixed");
    const before = await readFile(scope);
    const c = startClient();

    const doctor = await c.request("doctor");
    expect(doctor.result.ok).toBe(true);
    expect(doctor.result.problems).toEqual([]);

    const planId = c.post("plan", { paths: [library], planDir });
    const planned = await c.waitFor((m) => m.id === planId && (m.result ?? m.error) !== undefined);
    expect(planned.error).toBeUndefined();
    expect(planned.result.cancelled).toBe(false);
    expect(planned.result.summary).toMatchObject({ files: 3, fix: 2, skip: 1 });
    expect(c.eventsOf(planId, "plan.targets")[0]!.data.total).toBe(3);
    expect(c.eventsOf(planId, "plan.file-done")).toHaveLength(3);
    const nested = planned.result.files.find((f: { input: string }) => f.input === scope);
    expect(nested).toMatchObject({
      // Stored relative paths use "/" on every platform.
      relative: "Scope (2024)/Scope (2024).mkv",
      title: "Scope (2024)",
      status: "NEEDS_FIX",
      action: "fix",
      eventsOutside: 3,
      eventsToMove: 3,
    });
    expect(nested.fixed).toBeUndefined();

    // The library is not an output folder, and neither is anything inside it.
    for (const bad of [library, join(library, "fixed")]) {
      const refused = await c.request("apply", { planDir, outputRoot: bad, only: [scope] });
      expect(refused.error!.code).toBe("unsafe-output");
    }
    const none = await c.request("apply", { planDir, outputRoot, only: [join(library, "Safe (2019).mkv")] });
    expect(none.error!.code).toBe("bad-request");

    // A rehearsal writes nothing.
    const rehearsal = await c.request("apply", { planDir, outputRoot, only: [scope], dryRun: true });
    expect(rehearsal.result.files[0].status).toBe("would-apply");
    expect(await exists(join(outputRoot, "Scope (2024)", "Scope (2024).mkv"))).toBe(false);

    // Only the ticked title is fixed.
    const applyId = c.post("apply", { planDir, outputRoot, only: [scope] });
    const applied = await c.waitFor((m) => m.id === applyId && (m.result ?? m.error) !== undefined);
    expect(applied.error).toBeUndefined();
    expect(applied.result.files).toHaveLength(1);
    const file = applied.result.files[0];
    const output = join(outputRoot, "Scope (2024)", "Scope (2024).mkv");
    expect(file).toMatchObject({ input: scope, output, status: "applied", verified: true });
    expect(file.checks.join("\n")).toMatch(/sha256 matches/);
    expect(c.eventsOf(applyId, "apply.file-start")).toHaveLength(1);
    expect(c.eventsOf(applyId, "apply.file-progress").map((m) => m.data.phase)).toContain("verify");
    expect(c.eventsOf(applyId, "apply.file-done")[0]!.data.file.verified).toBe(true);

    // The original is byte-identical; the copy scans clean.
    expect(Buffer.compare(await readFile(scope), before)).toBe(0);
    expect((await scanFile(output, { aspect: 2.39 })).status).toBe("OK");
    expect(await exists(join(outputRoot, "Another Scope (2020).mkv"))).toBe(false);
    const log = await readApplyLog(planPaths(planDir).applyLog);
    expect(log.some((e) => e.event === "verified" && e.input === scope)).toBe(true);

    // A rescan reuses every verdict and now knows that title has a fixed copy.
    const rescan = await c.request("plan", { paths: [library], planDir });
    expect(rescan.result.analyzed).toBe(0);
    const fixed = rescan.result.files.find((f: { input: string }) => f.input === scope);
    expect(fixed.fixed.output).toBe(output);

    // Unless the copy has gone: the log still says verified, the folder does not.
    await rm(output);
    const after = await c.request("plan", { paths: [library], planDir });
    expect(after.result.files.find((f: { input: string }) => f.input === scope).fixed).toBeUndefined();

    await c.close();
  }, 180000);
});

describe.skipIf(!tools)("the remux fallback, end to end", () => {
  let dir: string;
  let library: string;
  let zlib: string;
  let plain: string;
  let scratch: string;
  let savedTmp: (readonly [string, string | undefined])[] = [];

  beforeAll(async () => {
    dir = await makeTempDir();
    library = join(dir, "library");
    scratch = join(dir, "scratch");
    await mkdir(library, { recursive: true });
    await mkdir(scratch, { recursive: true });
    const video = await makeLetterboxVideo(join(dir, "video.mkv"), { activeHeight: 804, seconds: 8 });
    const scopeSup = await writeSup(join(dir, "scope.sup"), SCOPE_SPEC);
    zlib = await makeMkv(join(library, "Zlib (2015).mkv"), video, scopeSup, { compression: "zlib" });
    plain = await makeMkv(join(library, "Plain (2024).mkv"), video, scopeSup);
    // Every temp file the engine makes lands where the tests can see it.
    savedTmp = tempEnvVars().map((name) => [name, process.env[name]] as const);
    for (const name of tempEnvVars()) process.env[name] = scratch;
    expect(tmpdir()).toBe(scratch);
  }, 300000);

  afterAll(async () => {
    for (const [name, value] of savedTmp) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (dir) await removeDir(dir);
  });

  it("without it, the compressed title is a skip, as it always was", async () => {
    const run = await runPlan([library], join(dir, "plan-plain"), { aspect: 2.39 });
    const entry = run.plan.files.find((f) => f.input === zlib)!;
    expect(entry).toMatchObject({ action: "skip", method: "patch", compressed: true });
    expect(run.plan.options.remuxFallback).toBeUndefined();
  }, 120000);

  it("plans only the compressed title for remux, and refuses to mix plans", async () => {
    const planDir = join(dir, "plan-fallback");
    const run = await runPlan([library], planDir, { aspect: 2.39, remuxFallback: true });
    expect(run.plan.options).toMatchObject({ method: "patch", remuxFallback: true });
    expect(run.plan.files.find((f) => f.input === plain)).toMatchObject({ action: "fix", method: "patch" });
    const entry = run.plan.files.find((f) => f.input === zlib)!;
    expect(entry).toMatchObject({ action: "fix", method: "remux", status: "NEEDS_FIX" });
    expect(entry.patch_summary!.events_moved).toBe(3);
    expect(entry.notes!.join(" ")).toMatch(/planned for remux: .*compression/);

    await expect(runPlan([library], planDir, { aspect: 2.39 })).rejects.toThrow(/remux fallback/);
    await expect(
      runPlan([library], join(dir, "plan-plain"), { aspect: 2.39, remuxFallback: true }),
    ).rejects.toThrow(/remux fallback/);
    const again = await runPlan([library], planDir, { aspect: 2.39, remuxFallback: true });
    expect(again.reused).toBe(2);
  }, 120000);

  it("a remux cancelled at each stage leaves no output and no temp files", async () => {
    const planDir = join(dir, "plan-fallback");
    for (const stage of ["analyze", "extract", "rebuild", "verify"] as const) {
      const outputRoot = join(dir, `out-cancel-${stage}`);
      const controller = new AbortController();
      const phases: string[] = [];
      const run = await applyPlan(
        planDir,
        { outputRoot, execute: true, only: [zlib] },
        {
          signal: controller.signal,
          onProgress: (p) => {
            if (p.type !== "file-progress") return;
            phases.push(p.phase);
            if (p.phase === stage) controller.abort();
          },
        },
      );
      expect(run.cancelled).toBe(true);
      expect(phases[phases.length - 1]).toBe(stage);
      expect(run.files[0]).toMatchObject({ status: "failed", reason: "cancelled", verified: false });
      const left = (await exists(outputRoot)) ? await readdir(outputRoot, { recursive: true }) : [];
      expect(left).toEqual([]);
      expect(await readdir(scratch)).toEqual([]);
    }
  }, 180000);

  it("serves a scan and a fix of the compressed title, verified against the original", async () => {
    const planDir = join(dir, "plan-serve");
    const outputRoot = join(dir, "fixed");
    const before = await readFile(zlib);
    const c = startClient();

    const planned = await c.request("plan", { paths: [library], planDir, remuxFallback: true });
    expect(planned.error).toBeUndefined();
    const view = planned.result.files.find((f: { input: string }) => f.input === zlib);
    expect(view).toMatchObject({ action: "fix", method: "remux", eventsOutside: 3, eventsToMove: 3 });
    expect(planned.result.files.find((f: { input: string }) => f.input === plain).method).toBe("patch");

    // A plan directory made without the fallback is refused, not silently mixed.
    const other = await c.request("plan", { paths: [library], planDir: join(dir, "plan-plain"), remuxFallback: true });
    expect(other.error!.code).toBe("plan-file");

    const applyId = c.post("apply", { planDir, outputRoot, only: [zlib, plain] });
    const applied = await c.waitFor((m) => m.id === applyId && (m.result ?? m.error) !== undefined);
    expect(applied.error).toBeUndefined();
    expect(applied.result.summary).toMatchObject({ applied: 2, verified: 2, failed: 0 });
    const phasesOf = (input: string): string[] =>
      c
        .eventsOf(applyId, "apply.file-progress")
        .filter((m) => m.data.input === input)
        .map((m) => m.data.phase as string)
        .filter((p, i, all) => p !== all[i - 1]);
    expect(phasesOf(zlib)).toEqual(["analyze", "extract", "rebuild", "verify"]);
    expect(phasesOf(plain)).toEqual(["copy", "read-back", "verify"]);

    const output = join(outputRoot, "Zlib (2015).mkv");
    const file = applied.result.files.find((f: { input: string }) => f.input === zlib);
    expect(file).toMatchObject({ output, status: "applied", verified: true });
    expect(file.checks.join("\n")).toMatch(/verified against the original \(stream-hashes\)/);

    // The original is untouched; the rebuilt copy passes the engine's own
    // verify on the stream-hash path, and scans clean.
    expect(Buffer.compare(await readFile(zlib), before)).toBe(0);
    expect((await stat(output)).size).not.toBe(before.length);
    const report = await verifyFile(zlib, output, { aspect: 2.39, hashStreams: true });
    expect(report.pass).toBe(true);
    expect(report.payloadMode).toBe("stream-hashes");
    expect((await scanFile(output, { aspect: 2.39 })).status).toBe("OK");
    expect(await readdir(scratch)).toEqual([]);
    expect((await readdir(outputRoot)).sort()).toEqual(["Plain (2024).mkv", "Zlib (2015).mkv"]);

    await c.close();
  }, 180000);
});
