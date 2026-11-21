/**
 * The no-letterbox fast path: when the active area is the whole coded frame
 * there is nowhere outside it for a subtitle to be, so the PGS tracks are not
 * read at all. That read is a full sequential pass over the file, so the test
 * that matters is that the source is never *invoked*, not merely that the
 * verdict is OK.
 */
import { describe, expect, it } from "vitest";
import { coversFullFrame } from "../../src/scan/analyze.js";
import { decideAction } from "../../src/batch/plan.js";
import { analyzeFile } from "../../src/scan/analyze.js";
import { scanFile, type ScanDeps } from "../../src/scan/scanFile.js";
import type { MkvInfo, MkvSubtitleTrack } from "../../src/mkv/inspect.js";
import { buildSup, type SupSpec } from "../../src/pgs/fixtures.js";
import { parseSupSegments } from "../../src/pgs/parse.js";
import type { ActiveArea } from "../../src/video/activeArea.js";

function pgsTrack(over: Partial<MkvSubtitleTrack> = {}): MkvSubtitleTrack {
  return {
    id: 1,
    number: 2,
    codecId: "S_HDMV/PGS",
    language: "eng",
    name: "English",
    default: true,
    forced: false,
    hearingImpaired: false,
    isPgs: true,
    ...over,
  };
}

function info(): MkvInfo {
  return {
    file: "/movies/x.mkv",
    durationMs: 60000,
    title: undefined,
    video: {
      id: 0,
      number: 1,
      codecId: "V_MPEG4/ISO/AVC",
      width: 1920,
      height: 1080,
      displayWidth: 1920,
      displayHeight: 1080,
    },
    subtitleTracks: [pgsTrack(), pgsTrack({ id: 2, number: 3, name: "Commentary" })],
  };
}

/** The second event sits in a 1.85:1 bottom bar, but inside a full 16:9 frame. */
const SPEC: SupSpec = {
  width: 1920,
  height: 1080,
  events: [
    { ptsMs: 1000, endPtsMs: 3000, objects: [{ x: 860, y: 700, width: 200, height: 60 }] },
    { ptsMs: 4000, endPtsMs: 6000, objects: [{ x: 860, y: 1010, width: 200, height: 60 }] },
  ],
};

/** A source that records every call, so "never read" is directly observable. */
function countingDeps(): ScanDeps & { calls: () => number } {
  let calls = 0;
  return {
    inspect: async () => info(),
    pgsSource: async () => {
      calls++;
      return parseSupSegments(buildSup(SPEC));
    },
    calls: () => calls,
  };
}

function area(over: Partial<ActiveArea>): ActiveArea {
  return {
    frameWidth: 1920,
    frameHeight: 1080,
    top: 0,
    bottom: 1080,
    left: 0,
    right: 1920,
    aspect: 1.78,
    source: "auto",
    classification: "CONSTANT",
    notes: [],
    ...over,
  };
}

describe("coversFullFrame", () => {
  it("is true only for a CONSTANT area spanning the whole frame", () => {
    expect(coversFullFrame(area({}))).toBe(true);
    expect(coversFullFrame(area({ top: 21, bottom: 1059, aspect: 1.85 }))).toBe(false);
    expect(coversFullFrame(area({ left: 240, right: 1680 }))).toBe(false);
    // "we could not tell" and "it changes" also report the whole frame, and
    // neither of them means there are no bars.
    expect(coversFullFrame(area({ classification: "UNKNOWN" }))).toBe(false);
    expect(coversFullFrame(area({ classification: "MIXED_ASPECT_RATIO" }))).toBe(false);
    expect(coversFullFrame(null)).toBe(false);
  });
});

describe("the no-letterbox fast path", () => {
  it("never reads the PGS tracks of a 16:9 title", async () => {
    const deps = countingDeps();
    const r = await scanFile("/movies/x.mkv", { aspect: 16 / 9 }, deps);

    expect(deps.calls()).toBe(0);
    expect(r.status).toBe("OK");
    expect(r.notes.join(" ")).toMatch(
      /no letterbox bars detected \(1\.78:1\); PGS tracks not read/,
    );
    // Both tracks are reported, as OK, with an unknown rather than zero count.
    expect(r.tracks).toHaveLength(2);
    for (const track of r.tracks) {
      expect(track.status).toBe("OK");
      expect(track.eventCount).toBeUndefined();
      expect(track.offendingEventCount).toBe(0);
      expect(track.notes.join(" ")).toMatch(/not read/);
    }
  });

  it("still reads a 1.85:1 title, whose ~20 px bars can hide a subtitle", async () => {
    const deps = countingDeps();
    const r = await scanFile("/movies/x.mkv", { aspect: 1.85 }, deps);

    expect(deps.calls()).toBe(2);
    expect(r.activeArea).toMatchObject({ top: 21, bottom: 1059 });
    expect(r.status).toBe("NEEDS_FIX");
    expect(r.tracks[0]!.eventCount).toBe(2);
  });

  it("reads a full-frame title anyway under --full", async () => {
    const deps = countingDeps();
    const r = await scanFile("/movies/x.mkv", { aspect: 16 / 9, full: true }, deps);

    expect(deps.calls()).toBe(2);
    expect(r.status).toBe("OK");
    expect(r.tracks[0]!.eventCount).toBe(2);
    expect(r.notes.join(" ")).not.toMatch(/not read/);
  });

  it("reads the tracks when detection reports the full frame but is UNKNOWN", async () => {
    const deps = countingDeps();
    const r = await scanFile("/movies/x.mkv", { aspect: "auto" }, {
      ...deps,
      detectActiveArea: async () => area({ classification: "UNKNOWN" }),
    });

    expect(deps.calls()).toBe(2);
    expect(r.status).toBe("AMBIGUOUS");
  });

  it("plans a fast-path file as a skip, saying the tracks were not read", async () => {
    const analysis = await analyzeFile("/movies/x.mkv", { aspect: 16 / 9 }, countingDeps());
    const decision = decideAction(analysis, "patch");

    expect(decision.action).toBe("skip");
    expect(decision.reason).toMatch(/no letterbox bars detected/);
    expect(decision.reason).toMatch(/PGS tracks not read/);
  });
});
