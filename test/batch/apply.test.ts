import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyExitCode,
  decideInPlace,
  duplicateOutputs,
  preflightDecision,
  type ApplyFileResult,
} from "../../src/batch/apply.js";
import {
  appendApplyLog,
  completedByInput,
  lastInPlaceWrite,
  lastWriteToInput,
  pendingReplacements,
  readApplyLog,
  revertedByInput,
  shouldSkipForResume,
  type ApplyLogEvent,
} from "../../src/batch/log.js";
import type { PlanFileEntry } from "../../src/batch/planFile.js";

function entry(overrides: Partial<PlanFileEntry> = {}): PlanFileEntry {
  return {
    input: "/movies/Scope (2024).mkv",
    relative: "Scope (2024).mkv",
    size: 1000,
    mtimeMs: 1700000000000,
    status: "NEEDS_FIX",
    video: null,
    active_area: null,
    tracks: [],
    action: "fix",
    method: "patch",
    analyzed: "",
    ...overrides,
  };
}

const unchanged = { exists: true, size: 1000, mtimeMs: 1700000000000 };

describe("pre-flight", () => {
  it("passes an untouched input with a free output path", () => {
    expect(preflightDecision(entry(), unchanged, { exists: false, size: 0 })).toEqual({
      ok: true,
    });
  });

  it("skips a file the plan did not choose to fix", () => {
    const outcome = preflightDecision(
      entry({ action: "skip", reason: "no PGS subtitle tracks" }),
      unchanged,
      null,
    );
    expect(outcome).toEqual({
      ok: false,
      kind: "skip",
      reason: "no PGS subtitle tracks",
    });
  });

  it("skips a missing input", () => {
    const outcome = preflightDecision(entry(), { exists: false, size: 0, mtimeMs: 0 }, null);
    expect(outcome).toMatchObject({ ok: false, kind: "skip" });
  });

  it("skips an input that changed since the plan was built", () => {
    const bySize = preflightDecision(entry(), { ...unchanged, size: 1001 }, null);
    expect(bySize).toMatchObject({ ok: false, kind: "skip" });
    expect((bySize as { reason: string }).reason).toMatch(/the file was modified after the plan/);

    const byTime = preflightDecision(entry(), { ...unchanged, mtimeMs: 1 }, null);
    expect((byTime as { reason: string }).reason).toMatch(/the file was modified after the plan/);
  });

  it("refuses an existing output unless --overwrite-output was given", () => {
    const conflict = preflightDecision(entry(), unchanged, { exists: true, size: 5 });
    expect(conflict).toMatchObject({ ok: false, kind: "conflict" });
    expect(
      preflightDecision(entry(), unchanged, { exists: true, size: 5 }, {
        overwriteOutput: true,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses an output path that is the input itself", () => {
    const outcome = preflightDecision(entry(), unchanged, null, {
      outputIsInput: true,
    });
    expect(outcome).toMatchObject({ ok: false, kind: "conflict" });
    expect((outcome as { reason: string }).reason).toMatch(/output path is the original file/);
  });

  it("refuses when a backup from an earlier run is already in the way", () => {
    const outcome = preflightDecision(entry(), unchanged, null, {
      backupExists: true,
    });
    expect(outcome).toMatchObject({ ok: false, kind: "conflict" });
  });

  it("refuses two planned files that map onto one output path", () => {
    const outcome = preflightDecision(entry(), unchanged, null, {
      duplicateOutput: true,
    });
    expect(outcome).toMatchObject({ ok: false, kind: "conflict" });
  });

  it("skips when the output volume is too full", () => {
    const tight = preflightDecision(entry(), unchanged, null, { freeBytes: 1010 });
    expect(tight).toMatchObject({ ok: false, kind: "skip" });
    expect((tight as { reason: string }).reason).toMatch(/not enough free space/);
    expect(preflightDecision(entry(), unchanged, null, { freeBytes: 5000 })).toEqual({
      ok: true,
    });
  });

  it("lets an in-place resume ignore the mtime, but never the size", () => {
    const touched = { ...unchanged, mtimeMs: 1800000000000 };
    expect(preflightDecision(entry(), touched, null, { ignoreMtime: true })).toEqual({
      ok: true,
    });
    const resized = preflightDecision(entry(), { ...touched, size: 1001 }, null, {
      ignoreMtime: true,
    });
    expect((resized as { reason: string }).reason).toMatch(/the file was modified after the plan/);
  });

  it("finds the output paths claimed twice", () => {
    const duplicates = duplicateOutputs(
      [
        entry({ input: "/a/Movie.mkv", relative: "Movie.mkv" }),
        entry({ input: "/b/Movie.mkv", relative: "Movie.mkv" }),
        entry({ input: "/c/Other.mkv", relative: "Other.mkv" }),
        entry({ input: "/d/Movie.mkv", relative: "Movie.mkv", action: "skip" }),
      ],
      "/out",
    );
    expect([...duplicates]).toEqual([join("/out", "Movie.mkv")]);
  });
});

describe("in-place decision", () => {
  const scan = (fixed: number, original: number, mismatch = 0) => ({
    total: fixed + original + mismatch,
    fixed,
    original,
    mismatch,
    firstMismatch: mismatch > 0 ? 4242 : undefined,
  });
  const check = (s: ReturnType<typeof scan>, resumable = false, size = 1000) => ({
    size,
    expectedSize: 1000,
    scan: s,
    resumable,
  });

  it("writes a file whose every range holds the original bytes", () => {
    expect(decideInPlace(check(scan(0, 5)))).toEqual({ kind: "write", resume: false });
  });

  it("refuses a file of the wrong size", () => {
    const outcome = decideInPlace(check(scan(0, 5), false, 999));
    expect(outcome.kind).toBe("refuse");
    expect((outcome as { reason: string }).reason).toMatch(/not the file the plan describes/);
  });

  it("refuses any range that holds neither state, even on a resume", () => {
    for (const resumable of [false, true]) {
      const outcome = decideInPlace(check(scan(2, 2, 1), resumable));
      expect(outcome.kind).toBe("refuse");
      expect((outcome as { reason: string }).reason).toMatch(/offset 4242/);
    }
  });

  it("finishes a half-patched file only when the log says this tool started it", () => {
    expect(decideInPlace(check(scan(3, 2), true))).toEqual({ kind: "write", resume: true });
    const stranger = decideInPlace(check(scan(3, 2), false));
    expect(stranger.kind).toBe("refuse");
    expect((stranger as { reason: string }).reason).toMatch(/records no in-place run/);
  });

  it("treats a fully patched file the same way: finish ours, refuse anyone else's", () => {
    expect(decideInPlace(check(scan(5, 0), true))).toEqual({ kind: "write", resume: true });
    expect(decideInPlace(check(scan(5, 0), false)).kind).toBe("refuse");
  });

  it("skips a plan that changes nothing in the file", () => {
    expect(decideInPlace(check(scan(0, 0))).kind).toBe("skip");
  });
});

describe("resume", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "scope-sub-log-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const verified: ApplyLogEvent = {
    time: "2026-09-02T00:00:00.000Z",
    event: "verified",
    input: "/movies/a.mkv",
    output: "/out/a.mkv",
    bytes: 1000,
    sha256: "abc",
  };

  it("does not skip a file the log has never seen", () => {
    expect(shouldSkipForResume(undefined, { exists: false, size: 0 })).toEqual({
      skip: false,
    });
  });

  it("skips a verified file whose output is still there at the right size", () => {
    const outcome = shouldSkipForResume(verified, { exists: true, size: 1000 });
    expect(outcome.skip).toBe(true);
    expect(outcome.reason).toMatch(/already applied and verified/);
  });

  it("re-does a verified file whose output has gone or changed size", () => {
    expect(shouldSkipForResume(verified, { exists: false, size: 0 }).skip).toBe(false);
    expect(shouldSkipForResume(verified, { exists: true, size: 12 }).skip).toBe(false);
  });

  it("always skips a replaced file, and says where the backup is", () => {
    const outcome = shouldSkipForResume(
      { ...verified, event: "replaced", backup: "/movies/a.mkv.pre-scopefix" },
      { exists: false, size: 0 },
    );
    expect(outcome.skip).toBe(true);
    expect(outcome.reason).toMatch(/pre-scopefix/);
  });

  it("keeps the last outcome per input and forgets a success a later run undid", () => {
    const index = completedByInput([
      verified,
      { ...verified, input: "/movies/b.mkv" },
      { time: "", event: "failed", input: "/movies/b.mkv", reason: "boom" },
      { time: "", event: "started", input: "/movies/c.mkv" },
    ]);
    expect([...index.keys()]).toEqual(["/movies/a.mkv"]);
  });

  it("lets a failure clear only the completion of the same output", () => {
    const input = "/movies/a.mkv";
    // A refused in-place attempt on the input says nothing about the copy.
    const inPlaceFailed: ApplyLogEvent = { time: "", event: "failed", input, output: input, reason: "refused" };
    expect(completedByInput([verified, inPlaceFailed]).get(input)).toEqual(verified);
    // Nor does a failed copy into another folder.
    const elsewhere: ApplyLogEvent = { time: "", event: "failed", input, output: "/other/a.mkv" };
    expect(completedByInput([verified, elsewhere]).get(input)).toEqual(verified);
    // A failure at the very output does, however the path is spelled.
    const same: ApplyLogEvent = { time: "", event: "failed", input, output: "/out/x/../a.mkv" };
    expect(completedByInput([verified, same]).size).toBe(0);
    // `superseded` still clears everything.
    expect(completedByInput([verified, { time: "", event: "superseded", input }]).size).toBe(0);
  });

  it("skips a verified file only for the output the record names", () => {
    const there = { exists: true, size: 1000 };
    expect(shouldSkipForResume(verified, there, "/out/a.mkv").skip).toBe(true);
    expect(shouldSkipForResume(verified, there, "/out/sub/../a.mkv").skip).toBe(true);
    // A same-sized file at the same relative path in another folder is not it.
    expect(shouldSkipForResume(verified, there, "/elsewhere/a.mkv").skip).toBe(false);
    const { output: _o, ...unnamed } = verified;
    expect(shouldSkipForResume(unnamed, there, "/out/a.mkv").skip).toBe(false);
  });

  it("appends a synced record like any other", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scope-sub-log-"));
    try {
      const path = join(dir, "nested", "apply.log.jsonl");
      const first: ApplyLogEvent = { time: "t1", event: "started", input: "/a.mkv", inPlace: true };
      await appendApplyLog(path, first, { sync: true });
      await appendApplyLog(path, { ...first, event: "patched" });
      await appendApplyLog(path, { ...first, time: "t2" }, { sync: true });
      expect((await readApplyLog(path)).map((e) => `${e.time}:${e.event}`)).toEqual([
        "t1:started",
        "t1:patched",
        "t2:started",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("remembers a swap that was journalled but never finished", () => {
    const backedUp: ApplyLogEvent = {
      time: "",
      event: "backed-up",
      input: "/movies/a.mkv",
      output: "/out/a.mkv",
      backup: "/movies/a.mkv.pre-scopefix",
    };
    // Killed between the two renames: the record stands.
    const pending = pendingReplacements([verified, backedUp]);
    expect(pending.get("/movies/a.mkv")).toEqual(backedUp);

    // The swap finished, or the file failed later: nothing is pending.
    expect(
      pendingReplacements([
        backedUp,
        { ...backedUp, event: "replaced" },
      ]).size,
    ).toBe(0);
    expect(
      pendingReplacements([backedUp, { ...backedUp, event: "failed" }]).size,
    ).toBe(0);
    expect(pendingReplacements([verified]).size).toBe(0);
  });

  it("counts an in-place patch as done, and skips it on a rerun", () => {
    const patched: ApplyLogEvent = {
      time: "",
      event: "patched",
      input: "/movies/a.mkv",
      output: "/movies/a.mkv",
      inPlace: true,
      pgsVerified: true,
    };
    expect(completedByInput([patched]).get("/movies/a.mkv")).toEqual(patched);
    const outcome = shouldSkipForResume(patched, { exists: true, size: 1 });
    expect(outcome).toEqual({ skip: true, reason: "already patched in place by an earlier run" });

    // An in-place revert un-does it; patching again re-does it.
    const reverted: ApplyLogEvent = { time: "", event: "reverted", input: "/movies/a.mkv", output: "/movies/a.mkv" };
    expect(completedByInput([patched, reverted]).size).toBe(0);
    expect(revertedByInput([patched, reverted]).size).toBe(1);
    expect(revertedByInput([patched, reverted, patched]).size).toBe(0);
  });

  it("remembers which inputs this tool last wrote in place", () => {
    const input = "/movies/a.mkv";
    const started: ApplyLogEvent = { time: "", event: "started", input, output: input, inPlace: true };
    const failed: ApplyLogEvent = { time: "", event: "failed", input, output: input, inPlace: true };
    const patched: ApplyLogEvent = { ...started, event: "patched" };
    const revertedHere: ApplyLogEvent = { time: "", event: "reverted", input, output: input };

    // A killed or failed in-place run is remembered, so it can be finished.
    expect(lastInPlaceWrite([started]).has(input)).toBe(true);
    expect(lastInPlaceWrite([started, failed]).has(input)).toBe(true);
    expect(lastInPlaceWrite([started, patched]).get(input)!.event).toBe("patched");
    // So is an in-place revert of the input's own path.
    expect(lastInPlaceWrite([revertedHere]).has(input)).toBe(true);

    // Copy-mode records never touch the input, so they neither set nor clear it.
    const copyStarted: ApplyLogEvent = { time: "", event: "started", input, output: "/out/a.mkv" };
    const copyVerified: ApplyLogEvent = { ...copyStarted, event: "verified" };
    const revertedCopy: ApplyLogEvent = {
      time: "",
      event: "reverted",
      input,
      output: "/out/a.mkv",
      revertedTo: "/undo/a.mkv",
    };
    expect(lastInPlaceWrite([copyStarted, copyVerified, revertedCopy]).size).toBe(0);
    expect(lastInPlaceWrite([patched, copyStarted, copyVerified, revertedCopy]).has(input)).toBe(
      true,
    );
    // A refusal is not a write either.
    expect(
      lastInPlaceWrite([{ time: "", event: "skipped", input, reason: "changed" }]).size,
    ).toBe(0);

    // --replace-original puts another file at the path: whatever was written
    // there in place no longer is.
    const replaced: ApplyLogEvent = { time: "", event: "replaced", input, output: input };
    expect(lastInPlaceWrite([patched, replaced]).size).toBe(0);
  });

  it("remembers every input this plan has written to its own path, for good", () => {
    const input = "/movies/a.mkv";
    const at = (event: ApplyLogEvent["event"], extra: Partial<ApplyLogEvent> = {}): ApplyLogEvent => ({
      time: "",
      event,
      input,
      output: input,
      ...extra,
    });
    // Copy-mode records never touch the input.
    const copy = { output: "/out/a.mkv" };
    expect(lastWriteToInput([at("started", copy), at("verified", copy)]).size).toBe(0);
    expect(
      lastWriteToInput([at("reverted", { output: "/out/a.mkv" })]).size,
    ).toBe(0);
    expect(lastWriteToInput([at("reverted", { revertedTo: "/undo/a.mkv" })]).size).toBe(0);

    // Every write to the input's own path counts — including one that never
    // finished — and nothing afterwards un-counts it.
    expect(lastWriteToInput([at("started", { inPlace: true })]).get(input)!.event).toBe("started");
    expect(
      lastWriteToInput([at("started", { inPlace: true }), at("failed", { inPlace: true })]).get(input)!
        .event,
    ).toBe("started");
    const stamp = { size: 5, mtimeMs: 7 };
    expect(lastWriteToInput([at("patched", { stamp })]).get(input)!.stamp).toEqual(stamp);
    expect(lastWriteToInput([at("backed-up"), at("replaced")]).get(input)!.event).toBe("replaced");
    expect(
      lastWriteToInput([at("patched"), at("reverted"), at("skipped", { reason: "x" })]).get(input)!
        .event,
    ).toBe("reverted");
  });

  it("round-trips through the jsonl file and tolerates a truncated last line", async () => {
    const path = join(dir, "apply.log.jsonl");
    await appendApplyLog(path, verified);
    await appendApplyLog(path, { ...verified, input: "/movies/b.mkv" });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, '{"time":"x","event":"veri', "utf8");

    const events = await readApplyLog(path);
    expect(events).toHaveLength(2);
    expect(events[1]!.input).toBe("/movies/b.mkv");
  });

  it("returns nothing for a log that does not exist yet", async () => {
    expect(await readApplyLog(join(dir, "nope.jsonl"))).toEqual([]);
  });
});

describe("exit codes", () => {
  const file = (over: Partial<ApplyFileResult>): ApplyFileResult => ({
    input: "/a.mkv",
    output: "/out/a.mkv",
    relative: "a.mkv",
    status: "applied",
    reason: undefined,
    failureKind: undefined,
    method: "patch",
    bytesWritten: 0,
    sha256: undefined,
    verified: true,
    replaced: false,
    inPlace: false,
    resuming: false,
    awaitingVerification: false,
    backup: undefined,
    checks: [],
    elapsedMs: 0,
    ...over,
  });

  it("is 0 when nothing failed", () => {
    expect(applyExitCode([file({}), file({ status: "skipped" })])).toBe(0);
  });

  it("is 7 when a verification failed", () => {
    expect(
      applyExitCode([file({ status: "failed", failureKind: "verification" })]),
    ).toBe(7);
  });

  it("is 6 when a repair failed", () => {
    expect(applyExitCode([file({ status: "failed", failureKind: "fix" })])).toBe(6);
  });

  it("prefers 7 over 6", () => {
    expect(
      applyExitCode([
        file({ status: "failed", failureKind: "fix" }),
        file({ status: "failed", failureKind: "verification" }),
      ]),
    ).toBe(7);
  });

  it("is 8 when the only problem was an output conflict", () => {
    expect(applyExitCode([file({ status: "conflict" }), file({})])).toBe(8);
  });
});
