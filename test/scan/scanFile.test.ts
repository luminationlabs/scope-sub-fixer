import { describe, expect, it } from "vitest";
import { scanFile, type ScanDeps, type ScanOptions } from "../../src/scan/scanFile.js";
import type { MkvInfo, MkvSubtitleTrack } from "../../src/mkv/inspect.js";
import { DependencyMissingError } from "../../src/mkv/inspect.js";
import { PgsParseError } from "../../src/pgs/errors.js";
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

function info(over: Partial<MkvInfo> = {}): MkvInfo {
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
    subtitleTracks: [pgsTrack()],
    ...over,
  };
}

function depsFor(mkv: MkvInfo, spec: SupSpec | null, extra: Partial<ScanDeps> = {}): ScanDeps {
  return {
    inspect: async () => mkv,
    pgsSource: async () => (spec ? parseSupSegments(buildSup(spec)) : []),
    ...extra,
  };
}

const OPTIONS: ScanOptions = { aspect: 2.39 };

/** One event inside the picture, one straddling the bottom bar. */
const MIXED_SPEC: SupSpec = {
  width: 1920,
  height: 1080,
  events: [
    { ptsMs: 1000, endPtsMs: 3000, objects: [{ x: 860, y: 800, width: 200, height: 60 }] },
    { ptsMs: 4000, endPtsMs: 6000, objects: [{ x: 860, y: 900, width: 200, height: 100 }] },
  ],
};

describe("scanFile", () => {
  it("reports NO_PGS when there are no PGS tracks", async () => {
    const mkv = info({
      subtitleTracks: [pgsTrack({ codecId: "S_TEXT/UTF8", isPgs: false })],
    });
    const r = await scanFile("/movies/x.mkv", OPTIONS, depsFor(mkv, null));
    expect(r.status).toBe("NO_PGS");
    expect(r.tracks).toHaveLength(0);
    expect(r.notes.join(" ")).toMatch(/no PGS subtitle tracks/);
    // No active area work is done for a file we are going to skip.
    expect(r.activeArea).toBeNull();
  });

  it("reports OK when every event sits inside the active area", async () => {
    const spec: SupSpec = {
      width: 1920,
      height: 1080,
      events: [{ ptsMs: 1000, objects: [{ x: 860, y: 700, width: 200, height: 60 }] }],
    };
    const r = await scanFile("/movies/x.mkv", OPTIONS, depsFor(info(), spec));
    expect(r.status).toBe("OK");
    expect(r.tracks[0]!.status).toBe("OK");
    expect(r.tracks[0]!.eventCount).toBe(1);
    expect(r.tracks[0]!.offendingEventCount).toBe(0);
    expect(r.tracks[0]!.events).toHaveLength(0);
  });

  it("reports NEEDS_FIX with the offending event and a proposed delta", async () => {
    const r = await scanFile("/movies/x.mkv", OPTIONS, depsFor(info(), MIXED_SPEC));
    expect(r.status).toBe("NEEDS_FIX");
    const track = r.tracks[0]!;
    expect(track.status).toBe("NEEDS_FIX");
    expect(track.eventCount).toBe(2);
    expect(track.offendingEventCount).toBe(1);
    expect(track.margin).toBe(24);
    const event = track.events[0]!;
    expect(event.ptsMs).toBe(4000);
    expect(event.status).toBe("PARTIALLY_OUTSIDE");
    // 1000 - 941 = 59 px overflow, plus the 24 px default margin.
    expect(event.objects[0]!.overflow.bottom).toBe(59);
    expect(event.proposedDelta).toEqual({ dx: 0, dy: -83 });
  });

  it("honours a margin override", async () => {
    const r = await scanFile(
      "/movies/x.mkv",
      { ...OPTIONS, margin: 0 },
      depsFor(info(), MIXED_SPEC),
    );
    expect(r.tracks[0]!.margin).toBe(0);
    expect(r.tracks[0]!.events[0]!.proposedDelta).toEqual({ dx: 0, dy: -59 });
  });

  it("keeps both track identifiers and the track flags", async () => {
    const mkv = info({
      subtitleTracks: [pgsTrack({ id: 4, number: 5, name: "English SDH", hearingImpaired: true })],
    });
    const r = await scanFile("/movies/x.mkv", OPTIONS, depsFor(mkv, MIXED_SPEC));
    expect(r.tracks[0]).toMatchObject({
      trackId: 4,
      trackNumber: 5,
      name: "English SDH",
      hearingImpaired: true,
      language: "eng",
    });
  });

  it("reports an empty track as OK with a note", async () => {
    const r = await scanFile(
      "/movies/x.mkv",
      OPTIONS,
      depsFor(info(), { width: 1920, height: 1080, events: [] }),
    );
    expect(r.tracks[0]!.status).toBe("OK");
    expect(r.tracks[0]!.eventCount).toBe(0);
    expect(r.tracks[0]!.notes.join(" ")).toMatch(/no subtitle events/);
  });

  it("scales a 1080p PGS canvas onto 2160p video", async () => {
    const mkv = info({
      video: {
        id: 0,
        number: 1,
        codecId: "V_MPEG4/ISO/AVC",
        width: 3840,
        height: 2160,
        displayWidth: 3840,
        displayHeight: 2160,
      },
    });
    const r = await scanFile("/movies/x.mkv", OPTIONS, depsFor(mkv, MIXED_SPEC));
    const track = r.tracks[0]!;
    expect(track.canvasWidth).toBe(1920);
    // 3840x2160 at 2.39 is y=276..1883; halved onto the 1080-high canvas.
    expect(track.activeOnCanvas).toEqual({ top: 138, bottom: 942, left: 0, right: 1920 });
    expect(track.notes.join(" ")).toMatch(/scaled onto the 1920x1080 PGS canvas/);
    expect(track.status).toBe("NEEDS_FIX");
  });

  it("is AMBIGUOUS when the PGS canvas does not match the video shape", async () => {
    const spec: SupSpec = { ...MIXED_SPEC, width: 1920, height: 1440 };
    const r = await scanFile("/movies/x.mkv", OPTIONS, depsFor(info(), spec));
    expect(r.status).toBe("AMBIGUOUS");
    expect(r.tracks[0]!.status).toBe("AMBIGUOUS");
    expect(r.tracks[0]!.canvasMismatch).toBe(true);
    expect(r.tracks[0]!.events).toHaveLength(0);
    expect(r.tracks[0]!.notes.join(" ")).toMatch(/does not.*match/);
  });

  it("is AMBIGUOUS when the track declares more than one PGS canvas", async () => {
    // Two epochs authored against different canvases: there is no single
    // coordinate system to map the active area onto, so nothing may move.
    const hd = parseSupSegments(buildSup(MIXED_SPEC));
    const sd = parseSupSegments(
      buildSup({ ...MIXED_SPEC, width: 1280, height: 720 }),
    );
    const r = await scanFile("/movies/x.mkv", OPTIONS, {
      inspect: async () => info(),
      pgsSource: async () => [...hd, ...sd],
    });
    expect(r.status).toBe("AMBIGUOUS");
    expect(r.tracks[0]!.status).toBe("AMBIGUOUS");
    expect(r.tracks[0]!.notes.join(" ")).toMatch(
      /more than one PGS canvas \(1920x1080, 1280x720\)/,
    );
    // Both epochs' events (two each) are ambiguous, none is proposed for a move.
    expect(r.tracks[0]!.ambiguousEventCount).toBe(4);
    expect(r.tracks[0]!.offendingEventCount).toBe(0);
    expect(r.tracks[0]!.activeOnCanvas).toBeNull();
  });

  it("reports MIXED_ASPECT_RATIO and proposes nothing", async () => {
    const mixed: ActiveArea = {
      frameWidth: 1920,
      frameHeight: 1080,
      top: 0,
      bottom: 1080,
      left: 0,
      right: 1920,
      aspect: 1.78,
      source: "auto",
      classification: "MIXED_ASPECT_RATIO",
      notes: ["active area changes"],
    };
    const r = await scanFile(
      "/movies/x.mkv",
      { aspect: "auto" },
      depsFor(info(), MIXED_SPEC, { detectActiveArea: async () => mixed }),
    );
    expect(r.status).toBe("MIXED_ASPECT_RATIO");
    expect(r.tracks[0]!.status).toBe("AMBIGUOUS");
    expect(r.tracks[0]!.ambiguousEventCount).toBe(2);
    expect(r.tracks[0]!.events).toHaveLength(0);
  });

  it("judges a film with clear, repeated shapes by the narrowest, and proposes moves", async () => {
    const narrowest: ActiveArea = {
      frameWidth: 1920,
      frameHeight: 1080,
      top: 138,
      bottom: 942,
      left: 0,
      right: 1920,
      aspect: 2.39,
      source: "auto",
      classification: "MIXED_NARROWEST",
      notes: ["aspect ratio varies between scenes"],
    };
    const r = await scanFile(
      "/movies/x.mkv",
      { aspect: "auto" },
      depsFor(info(), MIXED_SPEC, { detectActiveArea: async () => narrowest }),
    );
    expect(r.status).toBe("NEEDS_FIX");
    expect(r.tracks[0]!.status).toBe("NEEDS_FIX");
    expect(r.tracks[0]!.offendingEventCount).toBe(1);
    expect(r.tracks[0]!.events[0]!.proposedDelta).toBeDefined();
  });

  it("records a track-level extraction failure without failing the file scan", async () => {
    const mkv = info({ subtitleTracks: [pgsTrack({ id: 1 }), pgsTrack({ id: 2, number: 3 })] });
    let calls = 0;
    const deps: ScanDeps = {
      inspect: async () => mkv,
      pgsSource: async () => {
        if (calls++ === 0) throw new PgsParseError("bad segment", 42);
        return parseSupSegments(buildSup(MIXED_SPEC));
      },
    };
    const r = await scanFile("/movies/x.mkv", OPTIONS, deps);
    expect(r.tracks[0]!.status).toBe("ERROR");
    expect(r.tracks[0]!.errorKind).toBe("PGS_PARSE");
    expect(r.tracks[1]!.status).toBe("NEEDS_FIX");
    expect(r.status).toBe("NEEDS_FIX");
  });

  it("returns ERROR when inspection fails", async () => {
    const r = await scanFile("/movies/x.mkv", OPTIONS, {
      inspect: async () => {
        throw new DependencyMissingError("mkvmerge");
      },
    });
    expect(r.status).toBe("ERROR");
    expect(r.errorKind).toBe("DEPENDENCY_MISSING");
  });

  it("produces identical results across two runs", async () => {
    const a = await scanFile("/movies/x.mkv", OPTIONS, depsFor(info(), MIXED_SPEC));
    const b = await scanFile("/movies/x.mkv", OPTIONS, depsFor(info(), MIXED_SPEC));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
