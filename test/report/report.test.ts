import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { formatCount, formatRect, formatTimestamp } from "../../src/report/format.js";
import { formatHumanReport, formatSummary } from "../../src/report/human.js";
import { buildJsonReport, formatJsonReport } from "../../src/report/json.js";
import { TOOL_NAME, TOOL_VERSION } from "../../src/report/version.js";
import { scanFile } from "../../src/scan/scanFile.js";
import { summarize } from "../../src/scan/scanPaths.js";
import type { MkvInfo } from "../../src/mkv/inspect.js";
import { buildSup, type SupSpec } from "../../src/pgs/fixtures.js";
import { parseSupSegments } from "../../src/pgs/parse.js";
import type { ScanRunResult } from "../../src/scan/types.js";

const SPEC: SupSpec = {
  width: 1920,
  height: 1080,
  events: [
    { ptsMs: 764382, endPtsMs: 766000, objects: [{ x: 860, y: 800, width: 200, height: 60 }] },
    { ptsMs: 3797091, endPtsMs: 3799000, objects: [{ x: 860, y: 900, width: 200, height: 100 }] },
  ],
};

const INFO: MkvInfo = {
  file: "/movies/Movie Name (2024).mkv",
  durationMs: 7_260_000,
  title: "Movie Name",
  video: {
    id: 0,
    number: 1,
    codecId: "V_MPEG4/ISO/AVC",
    width: 1920,
    height: 1080,
    displayWidth: 1920,
    displayHeight: 1080,
  },
  subtitleTracks: [
    {
      id: 4,
      number: 5,
      codecId: "S_HDMV/PGS",
      language: "eng",
      name: "English",
      default: true,
      forced: false,
      hearingImpaired: false,
      isPgs: true,
    },
  ],
};

async function sampleRun(): Promise<ScanRunResult> {
  const file = await scanFile(
    "/movies/Movie Name (2024).mkv",
    { aspect: 2.39 },
    {
      inspect: async () => INFO,
      pgsSource: async () => parseSupSegments(buildSup(SPEC)),
    },
  );
  return { files: [file], summary: summarize([file]), missingPaths: [] };
}

describe("format helpers", () => {
  it("formats timestamps as HH:MM:SS.mmm", () => {
    expect(formatTimestamp(0)).toBe("00:00:00.000");
    expect(formatTimestamp(764382)).toBe("00:12:44.382");
    expect(formatTimestamp(3797091)).toBe("01:03:17.091");
    expect(formatTimestamp(-5)).toBe("00:00:00.000");
  });

  it("groups thousands without depending on the locale", () => {
    expect(formatCount(1204)).toBe("1,204");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  it("formats rectangles the way the PRD does", () => {
    expect(formatRect({ x: 1022, y: 1888, width: 1795, height: 156 })).toBe(
      "x=1022 y=1888 w=1795 h=156",
    );
  });
});

describe("human report", () => {
  it("prints the file, active area, track identity and status", async () => {
    const text = formatHumanReport(await sampleRun());
    expect(text).toContain("/movies/Movie Name (2024).mkv");
    expect(text).toContain("Video: 1920x1080");
    expect(text).toContain("Active area: y=138..941 (2.39:1, manual aspect, CONSTANT)");
    expect(text).toContain(
      'PGS track 4 (matroska track number 5)  eng  "English"  [default]',
    );
    expect(text).toContain("Status: NEEDS_FIX");
    expect(text).toContain("1 offending events of 2");
  });

  it("lists offending events only with --show-events", async () => {
    const run = await sampleRun();
    expect(formatHumanReport(run)).not.toContain("01:03:17.091");
    const shown = formatHumanReport(run, { showEvents: true });
    expect(shown).toContain("01:03:17.091  composition 2");
    expect(shown).toContain("original: x=860 y=900 w=200 h=100");
    expect(shown).toContain("overflow: bottom 59 px");
    expect(shown).toContain("proposed: dx=0 dy=-83 (y 900 -> 817)");
  });

  it("caps the event list at --max-events", async () => {
    const run = await sampleRun();
    const text = formatHumanReport(run, { showEvents: true, maxEvents: 0 });
    expect(text).toContain("1 more (use --max-events)");
  });

  it("prints the PRD §11.5 summary block", () => {
    const lines = formatSummary({
      scanned: 57,
      withPgs: 53,
      needFix: 19,
      safe: 34,
      mixedOrAmbiguous: 2,
      errors: 0,
    });
    expect(lines[0]).toMatch(/^Scanned:\s+57$/);
    expect(lines[4]).toMatch(/^Mixed\/ambiguous:\s+2$/);
    expect(lines).toHaveLength(6);
  });

  it("says so when nothing was found", () => {
    const empty: ScanRunResult = {
      files: [],
      summary: summarize([]),
      missingPaths: [],
    };
    expect(formatHumanReport(empty)).toContain("No .mkv files found.");
  });
});

describe("JSON report", () => {
  it("matches the PRD §11.6 shape and adds both track identifiers", async () => {
    const json = buildJsonReport(await sampleRun(), { aspect: 2.39, showEvents: true });
    expect(json.tool).toEqual({ name: TOOL_NAME, version: TOOL_VERSION });
    const file = json.files[0]!;
    expect(file.status).toBe("NEEDS_FIX");
    expect(file.video).toMatchObject({ width: 1920, height: 1080 });
    expect(file.active_area).toMatchObject({
      target_aspect_ratio: 2.39,
      active_rect: { x: 0, y: 138, width: 1920, height: 803 },
      source: "manual",
    });
    const track = file.subtitle_tracks[0]!;
    expect(track.mkvmerge_track_id).toBe(4);
    expect(track.matroska_track_number).toBe(5);
    expect(track.codec).toBe("S_HDMV/PGS");
    expect(track.event_count).toBe(2);
    expect(track.offending_event_count).toBe(1);
    const event = track.events[0]!;
    expect(event.timestamp).toBe("01:03:17.091");
    expect(event.pts_ms).toBe(3797091);
    expect(event.proposed_offset).toEqual({ x: 0, y: -83 });
    expect(event.objects[0]!.overflow).toEqual({ top: 0, bottom: 59, left: 0, right: 0 });
    expect(event.objects[0]!.original_rect).toEqual({
      x: 860,
      y: 900,
      width: 200,
      height: 100,
    });
  });

  it("truncates to max_events unless --show-events", async () => {
    const json = buildJsonReport(await sampleRun(), { aspect: 2.39, maxEvents: 0 });
    const track = json.files[0]!.subtitle_tracks[0]!;
    expect(track.events).toHaveLength(0);
    expect(track.events_truncated).toBe(true);
    expect(track.reported_event_count).toBe(1);
  });

  it("is byte-identical across two runs", async () => {
    const a = formatJsonReport(await sampleRun(), { aspect: 2.39, showEvents: true });
    const b = formatJsonReport(await sampleRun(), { aspect: 2.39, showEvents: true });
    expect(a).toBe(b);
  });

  it("carries the run summary", async () => {
    const json = buildJsonReport(await sampleRun(), { aspect: 2.39 });
    expect(json.summary).toEqual({
      scanned: 1,
      with_pgs: 1,
      need_repair: 1,
      already_safe: 0,
      mixed_or_ambiguous: 0,
      errors: 0,
    });
  });
});

describe("tool version", () => {
  it("matches package.json", async () => {
    const pkg = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { name: string; version: string };
    expect(TOOL_VERSION).toBe(pkg.version);
    expect(TOOL_NAME).toBe(pkg.name);
  });
});
