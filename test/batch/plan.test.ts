import { refusedOffendingCount } from "../../src/scan/analyze.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPatchFile,
  buildPlanEntry,
  collectPlanTargets,
  decideAction,
  decideWithFallback,
  mediaMismatch,
  needsAreaRecheck,
  probeFixedFile,
  MIXED_NARROWEST_NOTE,
  AREA_RECHECKS,
  areaRecheckReason,
  type AreaRecheck,
  planMismatch,
  REMUX_FALLBACK_NOTE,
  summarizePlan,
  type PlanTarget,
} from "../../src/batch/plan.js";
import { ACTIVE_AREA_RULES, PLAN_RULES_VERSION, sameMtime, type PlanFile, type PlanFileEntry } from "../../src/batch/planFile.js";
import { TOOL_NAME, TOOL_VERSION } from "../../src/report/version.js";
import type { MkvInfo } from "../../src/mkv/inspect.js";
import { activeAreaFromAspect } from "../../src/video/activeArea.js";
import {
  SAFE_SPEC,
  fakeFileAnalysis,
  fakeTrackAnalysis,
  subtitleTrack,
  wholeFileBlock,
} from "./support.js";

const STAMP = { size: 4096, mtimeMs: 1700000000000 };

function target(overrides: Partial<PlanTarget> = {}): PlanTarget {
  return { file: "/movies/Scope (2024).mkv", relative: "Scope (2024).mkv", ...overrides };
}

describe("refusedOffendingCount", () => {
  it("counts a subtitle moved in one window and refused in the other as left outside", () => {
    // Side by side: a full-height window whose object moves inside it, and a
    // window whose object is taller than the picture and is refused.
    const track = fakeTrackAnalysis({
      spec: {
        width: 1920,
        height: 1080,
        events: [
          {
            ptsMs: 1000,
            windows: [
              { windowId: 0, x: 0, y: 0, width: 960, height: 1080 },
              { windowId: 1, x: 1000, y: 100, width: 600, height: 980 },
            ],
            objects: [
              { objectId: 0, windowId: 0, x: 100, y: 960, width: 400, height: 60 },
              { objectId: 1, windowId: 1, x: 1050, y: 150, width: 400, height: 900 },
            ],
          },
          // An ordinary one, wholly fixed: not counted.
          { ptsMs: 5000, objects: [{ objectId: 0, x: 700, y: 960, width: 400, height: 60 }] },
        ],
      },
    });
    expect(track.plan!.entries.map((e) => [...e.objectDeltas.keys()])).toEqual([[0], [0]]);
    expect(track.plan!.skipped).toHaveLength(1);
    expect(refusedOffendingCount(track)).toBe(1);
  });
});

describe("the action decision table", () => {
  it("fixes a NEEDS_FIX file with a constant active area", () => {
    const decision = decideAction(fakeFileAnalysis(), "patch");
    expect(decision.action).toBe("fix");
    expect(decision.reason).toBeUndefined();
    expect(decision.tracks[0]!.action).toBe("fix");
    expect(decision.tracks[0]!.application!.patches.length).toBeGreaterThan(0);
  });

  it("fixes a film judged by the narrowest of its repeated shapes, and says so", () => {
    const area = {
      ...activeAreaFromAspect(1920, 1080, 2.39),
      source: "auto" as const,
      classification: "MIXED_NARROWEST" as const,
      notes: [`${MIXED_NARROWEST_NOTE}: y=138..942 (13x), y=0..1080 (11x). Judged by the narrowest recurring picture area`],
    };
    const decision = decideAction(fakeFileAnalysis({ activeArea: area }), "patch");
    expect(decision.action).toBe("fix");
    expect(decision.tracks[0]!.application!.patches.length).toBeGreaterThan(0);
    expect(decision.notes.join("\n")).toContain(MIXED_NARROWEST_NOTE);
    // No shape to judge by: left alone, as ever.
    const mixed = { ...area, classification: "MIXED_ASPECT_RATIO" as const };
    const left = decideAction(fakeFileAnalysis({ activeArea: mixed, status: "MIXED_ASPECT_RATIO" }), "patch");
    expect(left.action).toBe("skip");
    expect(left.reason).toMatch(/variable aspect ratio/);
  });

  it("skips a file with no PGS tracks", () => {
    const decision = decideAction(
      fakeFileAnalysis({ status: "NO_PGS", tracks: [], notes: ["no subtitle tracks"] }),
      "patch",
    );
    expect(decision.action).toBe("skip");
    expect(decision.reason).toBe("no subtitle tracks");
  });

  it("skips a file with nothing outside the active area", () => {
    const decision = decideAction(
      fakeFileAnalysis({ tracks: [fakeTrackAnalysis({ spec: SAFE_SPEC })] }),
      "patch",
    );
    expect(decision.action).toBe("skip");
    expect(decision.reason).toMatch(/no subtitle events outside/);
  });

  it("skips a mixed-aspect title", () => {
    const decision = decideAction(
      fakeFileAnalysis({ status: "MIXED_ASPECT_RATIO" }),
      "patch",
    );
    expect(decision.action).toBe("skip");
    expect(decision.reason).toMatch(/variable aspect ratio/);
  });

  it("skips when the active area is not constant", () => {
    const area = { ...activeAreaFromAspect(1920, 1080, 2.39), classification: "UNKNOWN" as const };
    const decision = decideAction(fakeFileAnalysis({ activeArea: area }), "patch");
    expect(decision.action).toBe("skip");
    expect(decision.reason).toMatch(/active picture area is UNKNOWN/);
  });

  it("skips when there is no active area at all", () => {
    const decision = decideAction(fakeFileAnalysis({ activeArea: null }), "patch");
    expect(decision.action).toBe("skip");
    expect(decision.reason).toMatch(/could not be determined/);
  });

  it("skips an ambiguous file, quoting the track's note", () => {
    const track = fakeTrackAnalysis({ noPlan: true, status: "AMBIGUOUS" });
    track.notes.push("active area is UNKNOWN; no moves proposed");
    const decision = decideAction(
      fakeFileAnalysis({ status: "AMBIGUOUS", tracks: [track] }),
      "patch",
    );
    expect(decision.action).toBe("skip");
    expect(decision.reason).toMatch(/no moves proposed/);
  });

  it("skips an errored file with the error as the reason", () => {
    const decision = decideAction(
      fakeFileAnalysis({ status: "ERROR", error: "mkvmerge exited 2" }),
      "patch",
    );
    expect(decision.action).toBe("skip");
    expect(decision.reason).toBe("mkvmerge exited 2");
  });

  it("skips a Matroska-compressed track under --method patch, but not under remux", () => {
    const analysis = fakeFileAnalysis({ tracks: [fakeTrackAnalysis({ compressed: true })] });
    const patched = decideAction(analysis, "patch");
    expect(patched.action).toBe("skip");
    expect(patched.reason).toMatch(/content compression.*remux/s);

    const remuxed = decideAction(analysis, "remux");
    expect(remuxed.action).toBe("fix");
  });

  it("skips a track whose cluster carries a CRC-32", () => {
    const decision = decideAction(
      fakeFileAnalysis({
        tracks: [fakeTrackAnalysis({ blocks: [wholeFileBlock({ clusterHasCrc: true })] })],
      }),
      "patch",
    );
    expect(decision.action).toBe("skip");
    expect(decision.reason).toMatch(/CRC-32/);
  });

  it("skips a track that was not read with the direct block reader", () => {
    const decision = decideAction(
      fakeFileAnalysis({ tracks: [fakeTrackAnalysis({ blocks: [] })] }),
      "patch",
    );
    expect(decision.action).toBe("skip");
    expect(decision.reason).toMatch(/direct block reader/);
  });

  it("skips a patch that falls outside every known block", () => {
    const decision = decideAction(
      fakeFileAnalysis({
        tracks: [fakeTrackAnalysis({ blocks: [wholeFileBlock({ fileLength: 4 })] })],
      }),
      "patch",
    );
    expect(decision.action).toBe("skip");
    expect(decision.reason).toMatch(/outside every known PGS block/);
  });

  it("skips a track whose move policy refused every offending event", () => {
    const track = fakeTrackAnalysis();
    track.plan = { margin: track.margin, entries: [], skipped: [], windowDeltasByEpoch: new Map() };
    const decision = decideAction(fakeFileAnalysis({ tracks: [track] }), "patch");
    expect(decision.action).toBe("skip");
    expect(decision.reason).toMatch(/move policy refused/);
  });

  it("fixes the good tracks of a file and notes the one it skipped", () => {
    const good = fakeTrackAnalysis({ track: { id: 1, number: 2 } });
    const bad = fakeTrackAnalysis({
      track: { id: 2, number: 3 },
      noPlan: true,
      status: "AMBIGUOUS",
    });
    bad.notes.push("canvas 1280x720 does not match the video");
    const decision = decideAction(
      fakeFileAnalysis({ status: "NEEDS_FIX", tracks: [good, bad] }),
      "patch",
    );
    expect(decision.action).toBe("fix");
    expect(decision.tracks.map((t) => t.action)).toEqual(["fix", "skip"]);
    expect(decision.notes.join(" ")).toMatch(/track 2 skipped: canvas 1280x720/);
  });

  it("skips an errored track", () => {
    const decision = decideAction(
      fakeFileAnalysis({
        status: "NEEDS_FIX",
        tracks: [fakeTrackAnalysis({ status: "ERROR", error: "PGS parse error at 12" })],
      }),
      "patch",
    );
    expect(decision.action).toBe("skip");
    expect(decision.reason).toMatch(/PGS parse error/);
  });
});

describe("the per-title remux fallback", () => {
  const plain = () => fakeTrackAnalysis({ track: { id: 1, number: 2 } });
  const zlib = () => fakeTrackAnalysis({ compressed: true, track: { id: 2, number: 3 } });
  const crc = () =>
    fakeTrackAnalysis({ blocks: [wholeFileBlock({ clusterHasCrc: true })], track: { id: 3, number: 4 } });

  it("leaves a title patching can repair as a patch", () => {
    const r = decideWithFallback(fakeFileAnalysis({ tracks: [plain()] }), "patch", true);
    expect(r.method).toBe("patch");
    expect(r.decision.action).toBe("fix");
    expect(r.decision.notes.join(" ")).not.toContain(REMUX_FALLBACK_NOTE);
  });

  it("does nothing unless it was asked for", () => {
    const r = decideWithFallback(fakeFileAnalysis({ tracks: [zlib()] }), "patch", false);
    expect(r.method).toBe("patch");
    expect(r.decision.action).toBe("skip");
    expect(r.decision.reason).toMatch(/compression/);
  });

  it("plans a compressed title for remux, and says why", () => {
    const r = decideWithFallback(fakeFileAnalysis({ tracks: [zlib()] }), "patch", true);
    expect(r.method).toBe("remux");
    expect(r.decision.action).toBe("fix");
    expect(r.decision.tracks[0]!.action).toBe("fix");
    expect(r.decision.notes.join(" ")).toMatch(new RegExp(`${REMUX_FALLBACK_NOTE}: .*compression`));
  });

  it("plans a title whose clusters carry a CRC-32 for remux", () => {
    const r = decideWithFallback(fakeFileAnalysis({ tracks: [crc()] }), "patch", true);
    expect(r.method).toBe("remux");
    expect(r.decision.notes.join(" ")).toMatch(/CRC-32/);
  });

  it("prefers remux when patching could only repair some of the tracks", () => {
    const analysis = fakeFileAnalysis({ tracks: [plain(), zlib()] });
    expect(decideAction(analysis, "patch").tracks.map((t) => t.action)).toEqual(["fix", "skip"]);
    const r = decideWithFallback(analysis, "patch", true);
    expect(r.method).toBe("remux");
    expect(r.decision.tracks.map((t) => t.action)).toEqual(["fix", "fix"]);
  });

  it("does not turn a title nothing can repair into a fix", () => {
    const safe = fakeFileAnalysis({ tracks: [fakeTrackAnalysis({ spec: SAFE_SPEC, compressed: true })] });
    expect(decideWithFallback(safe, "patch", true)).toMatchObject({ method: "patch", decision: { action: "skip" } });
    const mixed = fakeFileAnalysis({ status: "MIXED_ASPECT_RATIO", tracks: [zlib()] });
    expect(decideWithFallback(mixed, "patch", true)).toMatchObject({ method: "patch", decision: { action: "skip" } });
  });

  it("is not consulted for a remux plan", () => {
    const r = decideWithFallback(fakeFileAnalysis({ tracks: [zlib()] }), "remux", true);
    expect(r.method).toBe("remux");
    expect(r.decision.notes.join(" ")).not.toContain(REMUX_FALLBACK_NOTE);
  });

  it("records the entry's own method, with no byte patches for a remux", () => {
    const analysis = fakeFileAnalysis({ tracks: [zlib()] });
    const { decision, method } = decideWithFallback(analysis, "patch", true);
    const entry = buildPlanEntry(analysis, decision, { target: target(), stamp: STAMP, method, patchFile: "patches/1.json" });
    expect(entry).toMatchObject({ action: "fix", method: "remux", compressed: true });
    expect(entry.patch_summary!.events_moved).toBe(3);
    const patchFile = buildPatchFile(analysis, decision, STAMP, method);
    expect(patchFile.method).toBe("remux");
    expect(patchFile.patches).toEqual([]);
    expect(patchFile.tracks).toHaveLength(1);
  });
});

describe("planMismatch and the tool that wrote the plan", () => {
  const plan = (tool: PlanFile["tool"]): PlanFile => ({
    schema: 1,
    tool,
    created: "",
    updated: "",
    options: { aspect: "auto", method: "patch", recursive: true },
    paths: [],
    files: [],
  });
  const mismatch = (tool: PlanFile["tool"]) => planMismatch(plan(tool), { aspect: "auto" }, "patch");

  it("extends a plan across releases and a rename while the rules are the same", () => {
    expect(mismatch({ name: "scope-sub", version: "9.9.9", rules: PLAN_RULES_VERSION })).toBeNull();
    expect(mismatch({ name: "another-name", version: "1.0.0", rules: PLAN_RULES_VERSION })).toBeNull();
  });

  it("refuses a plan made under other rules, or one that does not say", () => {
    expect(mismatch({ name: "scope-sub", version: "0.1.0" })).toMatch(/by scope-sub 0\.1\.0/);
    expect(mismatch({ name: "scope-sub", version: TOOL_VERSION })).toMatch(/by scope-sub/);
    expect(
      mismatch({ name: "scope-sub", version: TOOL_VERSION, rules: PLAN_RULES_VERSION + 1 }),
    ).toMatch(/by scope-sub/);
  });
});

describe("sameMtime", () => {
  it("treats stamps within a millisecond as one (Node keeps the fraction, bun does not)", () => {
    expect(sameMtime(1700000000123.456, 1700000000123)).toBe(true);
    expect(sameMtime(1700000000123.456, 1700000000124)).toBe(true);
    expect(sameMtime(1700000000123, 1700000000123)).toBe(true);
    // A restored mtime, truncated: one whole millisecond off.
    expect(sameMtime(1700000000123, 1700000000124)).toBe(true);
    expect(sameMtime(1700000000123.456, 1700000000125)).toBe(false);
    expect(sameMtime(1700000000123, 1700000000125)).toBe(false);
  });
});

describe("planMismatch and the remux fallback", () => {
  const plan = (options: Partial<PlanFile["options"]> = {}): PlanFile => ({
    schema: 1,
    tool: { name: TOOL_NAME, version: TOOL_VERSION, rules: PLAN_RULES_VERSION },
    created: "",
    updated: "",
    options: { aspect: "auto", method: "patch", recursive: true, ...options },
    paths: [],
    files: [],
  });

  it("keeps extending a plan built before the option existed", () => {
    expect(planMismatch(plan(), { aspect: "auto" }, "patch")).toBeNull();
    expect(planMismatch(plan(), { aspect: "auto", remuxFallback: false }, "patch")).toBeNull();
  });

  it("refuses to mix verdicts made with and without it", () => {
    expect(planMismatch(plan(), { aspect: "auto", remuxFallback: true }, "patch")).toMatch(
      /without the remux fallback \(this run: with\)/,
    );
    expect(planMismatch(plan({ remuxFallback: true }), { aspect: "auto" }, "patch")).toMatch(
      /with the remux fallback \(this run: without\)/,
    );
    expect(planMismatch(plan({ remuxFallback: true }), { aspect: "auto", remuxFallback: true }, "patch")).toBeNull();
  });
});

describe("plan entries and patch files", () => {
  it("summarizes a fixed file and points at its patch file", () => {
    const analysis = fakeFileAnalysis();
    const decision = decideAction(analysis, "patch");
    const entry = buildPlanEntry(analysis, decision, {
      target: target(),
      stamp: STAMP,
      method: "patch",
      patchFile: "patches/1.json",
    });
    expect(entry.action).toBe("fix");
    expect(entry.patchFile).toBe("patches/1.json");
    expect(entry.size).toBe(STAMP.size);
    expect(entry.mtimeMs).toBe(STAMP.mtimeMs);
    expect(entry.patch_summary!.tracks).toBe(1);
    expect(entry.patch_summary!.events_moved).toBe(3);
    expect(entry.patch_summary!.position_fields).toBeGreaterThan(0);
    expect(entry.patch_summary!.bytes_changed).toBeGreaterThan(0);
    expect(entry.tracks[0]!.mkvmerge_id).toBe(1);
    expect(entry.tracks[0]!.matroska_number).toBe(2);
    expect(entry.active_area!.classification).toBe("CONSTANT");
  });

  it("carries no patch summary for a skipped file", () => {
    const analysis = fakeFileAnalysis({ tracks: [fakeTrackAnalysis({ spec: SAFE_SPEC })] });
    const entry = buildPlanEntry(analysis, decideAction(analysis, "patch"), {
      target: target(),
      stamp: STAMP,
      method: "patch",
    });
    expect(entry.action).toBe("skip");
    expect(entry.patch_summary).toBeUndefined();
    expect(entry.patchFile).toBeUndefined();
  });

  it("writes every byte edit, the moves and a positionless fingerprint", () => {
    const analysis = fakeFileAnalysis();
    const decision = decideAction(analysis, "patch");
    const patchFile = buildPatchFile(analysis, decision, STAMP, "patch");
    expect(patchFile.patches.length).toBeGreaterThan(0);
    for (const p of patchFile.patches) {
      expect(p.before).toMatch(/^[0-9a-f]+$/);
      expect(p.before.length).toBe(p.length * 2);
      expect(p.before).not.toBe(p.after);
    }
    // Sorted by offset, as `apply` streams them.
    const offsets = patchFile.patches.map((p) => p.offset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);

    const track = patchFile.tracks[0]!;
    expect(track.moves.length).toBeGreaterThan(0);
    expect(track.moves[0]!.dy).not.toBe(0);
    expect(track.expected_offending_after).toBe(0);
    expect(track.fingerprint.eventCount).toBe(4);
    expect(track.fingerprint.bitmapHash).toMatch(/^[0-9a-f]{64}$/);
    expect(track.active_on_canvas.bottom).toBe(941);
  });

  it("stores no byte edits for a remux plan", () => {
    const analysis = fakeFileAnalysis({ tracks: [fakeTrackAnalysis({ compressed: true })] });
    const decision = decideAction(analysis, "remux");
    const patchFile = buildPatchFile(analysis, decision, STAMP, "remux");
    expect(patchFile.patches).toEqual([]);
    expect(patchFile.tracks[0]!.moves.length).toBeGreaterThan(0);
  });
});

describe("mediaMismatch", () => {
  const analysis = fakeFileAnalysis();
  const entry = buildPlanEntry(analysis, decideAction(analysis, "patch"), {
    target: target(),
    stamp: STAMP,
    method: "patch",
    patchFile: "patches/1.json",
  });
  const info = (overrides: Partial<MkvInfo> = {}): MkvInfo => ({
    file: entry.input,
    durationMs: 1000,
    title: undefined,
    video: {
      id: 0,
      number: 1,
      codecId: "V_MPEG4/ISO/AVC",
      width: entry.video!.w,
      height: entry.video!.h,
      displayWidth: undefined,
      displayHeight: undefined,
    },
    subtitleTracks: entry.tracks.map((t) =>
      subtitleTrack({ id: t.mkvmerge_id, number: t.matroska_number, language: t.language }),
    ),
    ...overrides,
  });

  it("accepts the container the entry was planned from, with or without a Segment UID on record", () => {
    expect(mediaMismatch(entry, info())).toBeNull();
    expect(mediaMismatch(entry, info({ segmentUid: "ab12" }))).toBeNull();
    expect(mediaMismatch({ ...entry, segment_uid: "AB12" }, info({ segmentUid: "ab12" }))).toBeNull();
    // Non-PGS subtitle tracks were never in the entry.
    const srt = subtitleTrack({ id: 9, number: 10, codecId: "S_TEXT/UTF8", isPgs: false });
    expect(mediaMismatch(entry, info({ subtitleTracks: [...info().subtitleTracks, srt] }))).toBeNull();
  });

  it("names what differs", () => {
    expect(mediaMismatch({ ...entry, segment_uid: "ab12" }, info({ segmentUid: "cd34" }))).toMatch(
      /Segment UID/,
    );
    expect(mediaMismatch(entry, info({ video: undefined }))).toMatch(/video/);
    expect(mediaMismatch(entry, info({ video: { ...info().video!, height: 800 } }))).toMatch(/x800/);
    expect(mediaMismatch(entry, info({ subtitleTracks: [] }))).toMatch(/0 PGS track/);
    // An entry that lists only what it fixes: more tracks are fine when asked,
    // a listed one missing never is.
    const more = [...info().subtitleTracks, subtitleTrack({ id: 5, number: 6, language: "spa" })];
    expect(mediaMismatch(entry, info({ subtitleTracks: more }))).toMatch(/2 PGS track/);
    expect(mediaMismatch(entry, info({ subtitleTracks: more }), { listedTracksOnly: true })).toBeNull();
    expect(
      mediaMismatch(entry, info({ subtitleTracks: more.slice(1) }), { listedTracksOnly: true }),
    ).toMatch(/PGS track 1 differs/);
    expect(
      mediaMismatch(entry, info({ subtitleTracks: [subtitleTrack({ id: 1, number: 2, language: "fre" })] })),
    ).toMatch(/PGS track 1 differs/);
  });
});

describe("summarizePlan", () => {
  it("counts actions, statuses and totals", () => {
    const base: PlanFileEntry = {
      input: "/a.mkv",
      relative: "a.mkv",
      size: 1,
      mtimeMs: 1,
      status: "NEEDS_FIX",
      video: null,
      active_area: null,
      tracks: [],
      action: "fix",
      method: "patch",
      analyzed: "",
      patch_summary: {
        tracks: 2,
        events_moved: 10,
        display_sets: 10,
        position_fields: 20,
        bytes_changed: 40,
      },
    };
    const { patch_summary: _omit, ...noSummary } = base;
    const summary = summarizePlan([
      base,
      { ...noSummary, input: "/b.mkv", action: "skip", status: "OK" },
      { ...noSummary, input: "/c.mkv", action: "skip", status: "NO_PGS" },
    ]);
    expect(summary).toMatchObject({
      files: 3,
      fix: 1,
      skip: 2,
      tracks: 2,
      eventsMoved: 10,
      positionFields: 20,
      bytesChanged: 40,
    });
    expect(summary.byStatus).toEqual({ NEEDS_FIX: 1, OK: 1, NO_PGS: 1 });
  });
});

describe("collectPlanTargets", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "scope-sub-targets-"));
    await mkdir(join(dir, "lib", "Action", "Scope (2024)"), { recursive: true });
    await writeFile(join(dir, "lib", "Flat (2001).mkv"), "x");
    await writeFile(join(dir, "lib", "Action", "Scope (2024)", "Scope (2024).mkv"), "x");
    await writeFile(join(dir, "lib", "notes.txt"), "x");
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("maps a flat directory scan onto basenames", async () => {
    const { targets, missing } = await collectPlanTargets([join(dir, "lib")], false);
    expect(missing).toEqual([]);
    expect(targets.map((t) => t.relative)).toEqual(["Flat (2001).mkv"]);
    expect(targets[0]!.root).toBe(join(dir, "lib"));
  });

  it("mirrors the tree for a recursive scan", async () => {
    const { targets } = await collectPlanTargets([join(dir, "lib")], true);
    expect(targets.map((t) => t.relative).sort()).toEqual([
      "Action/Scope (2024)/Scope (2024).mkv",
      "Flat (2001).mkv",
    ]);
  });

  it("takes explicit files flat, and reports what is missing", async () => {
    const { targets, missing } = await collectPlanTargets(
      [join(dir, "lib", "Action", "Scope (2024)", "Scope (2024).mkv"), "/nope/gone.mkv"],
      true,
    );
    expect(targets.map((t) => t.relative)).toEqual(["Scope (2024).mkv"]);
    expect(targets[0]!.root).toBeUndefined();
    expect(missing).toEqual(["/nope/gone.mkv"]);
  });

  it("ignores non-MKV files and de-duplicates", async () => {
    const { targets } = await collectPlanTargets(
      [join(dir, "lib"), join(dir, "lib", "Flat (2001).mkv"), join(dir, "lib", "notes.txt")],
      false,
    );
    expect(targets).toHaveLength(1);
  });
});

describe("needsAreaRecheck: verdicts an older generation could not get right", () => {
  const entry = (over: Partial<PlanFileEntry> = {}): PlanFileEntry => ({
    input: "/m/a.mkv",
    relative: "a.mkv",
    size: 1,
    mtimeMs: 1,
    status: "MIXED_ASPECT_RATIO",
    video: { w: 1920, h: 1080 },
    active_area: null,
    tracks: [],
    action: "skip",
    method: "patch",
    analyzed: "2026-09-01T00:00:00.000Z",
    ...over,
  });
  const older = ACTIVE_AREA_RULES - 1;

  it("has no rules yet, so every entry stands", () => {
    expect(AREA_RECHECKS).toEqual([]);
    expect(needsAreaRecheck(entry())).toBe(false);
    expect(needsAreaRecheck(entry({ area_rules: older }))).toBe(false);
    expect(needsAreaRecheck(entry({ status: "OK", area_rules: ACTIVE_AREA_RULES }))).toBe(false);
  });

  it("applies a rule only to an unwritten skip entry from an older generation", () => {
    const seen: number[] = [];
    const rule: AreaRecheck = (e, rules) => {
      seen.push(rules);
      return e.status === "MIXED_ASPECT_RATIO" ? "picture detection has improved since" : undefined;
    };
    AREA_RECHECKS.push(rule);
    try {
      expect(areaRecheckReason(entry({ area_rules: older }))).toBe("picture detection has improved since");
      expect(seen).toEqual([older]);
      // The rule's own condition decides among the older entries.
      expect(needsAreaRecheck(entry({ area_rules: older, status: "OK" }))).toBe(false);
      // The current generation, or a repair on record: it stands.
      expect(needsAreaRecheck(entry({ area_rules: ACTIVE_AREA_RULES }))).toBe(false);
      expect(needsAreaRecheck(entry())).toBe(false);
      expect(needsAreaRecheck(entry({ area_rules: older, patchFile: "patches/1.json" }))).toBe(false);
      expect(
        needsAreaRecheck(entry({ area_rules: older, action: "fix", status: "NEEDS_FIX", patchFile: "patches/1.json" })),
      ).toBe(false);
    } finally {
      AREA_RECHECKS.splice(AREA_RECHECKS.indexOf(rule), 1);
    }
  });
});

describe("probeFixedFile: one read that says whether a file still holds its fix", () => {
  it("takes a range the fix changes, and answers fixed, not-fixed or unknown", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "scope-sub-probe-"));
    try {
      await mkdir(join(dir, "patches"));
      // The first range is the same before and after: it says nothing.
      const patchFile = {
        schema: 1, tool: { name: "scope-sub", version: "0", rules: PLAN_RULES_VERSION }, created: "", input: "/m/a.mkv",
        size: 8, mtimeMs: 1, method: "patch", tracks: [],
        patches: [
          { offset: 0, length: 2, before: "aaaa", after: "aaaa" },
          { offset: 4, length: 2, before: "0102", after: "0a0b" },
        ],
      };
      await writeFile(join(dir, "patches", "1.json"), JSON.stringify(patchFile));
      const file = join(dir, "a.bin");
      const entry = { patchFile: "patches/1.json" } as PlanFileEntry;

      await writeFile(file, Buffer.from("aaaa00000a0b0000", "hex"));
      expect(await probeFixedFile(dir, entry, file)).toBe("fixed");
      expect(entry.probe).toEqual({ patchFile: "patches/1.json", offset: 4, before: "0102", after: "0a0b" });

      await writeFile(file, Buffer.from("aaaa000001020000", "hex"));
      expect(await probeFixedFile(dir, entry, file)).toBe("not-fixed");
      // Shorter than the range: not the fixed file either.
      await writeFile(file, Buffer.from("aaaa", "hex"));
      expect(await probeFixedFile(dir, entry, file)).toBe("not-fixed");

      // Nothing to ask with: no patch file, no changing range, no file.
      expect(await probeFixedFile(dir, {} as PlanFileEntry, file)).toBe("unknown");
      expect(await probeFixedFile(dir, entry, join(dir, "gone.bin"))).toBe("unknown");
      patchFile.patches.pop();
      await writeFile(join(dir, "patches", "2.json"), JSON.stringify(patchFile));
      expect(await probeFixedFile(dir, { patchFile: "patches/2.json" } as PlanFileEntry, file)).toBe("unknown");
      // A probe from another patch file is not used.
      const moved = { patchFile: "patches/2.json", probe: entry.probe } as PlanFileEntry;
      expect(await probeFixedFile(dir, moved, file)).toBe("unknown");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
