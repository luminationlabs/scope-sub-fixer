/**
 * The direct reader walks every cluster block by block, so doing it once per
 * PGS track multiplies the cost of a 14-track Blu-ray rip by 14. These tests
 * pin the wiring that makes `scanFile` read all of them in one pass.
 */
import { describe, expect, it, vi } from "vitest";

import { scanFile, type ScanDeps, type ScanOptions } from "../../src/scan/scanFile.js";
import type { MkvInfo, MkvSubtitleTrack } from "../../src/mkv/inspect.js";
import { buildSup, type SupSpec } from "../../src/pgs/fixtures.js";
import { parseSupSegments } from "../../src/pgs/parse.js";
import type { Segment } from "../../src/pgs/types.js";

function pgsTrack(id: number, number: number, language: string): MkvSubtitleTrack {
  return {
    id,
    number,
    codecId: "S_HDMV/PGS",
    language,
    name: language,
    default: id === 1,
    forced: false,
    hearingImpaired: false,
    isPgs: true,
  };
}

const TRACKS = [pgsTrack(1, 3, "eng"), pgsTrack(2, 5, "fra"), pgsTrack(3, 7, "deu")];

const INFO: MkvInfo = {
  file: "/movies/x.mkv",
  durationMs: 60_000,
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
  subtitleTracks: TRACKS,
};

/** `count` events low in the frame, so each track has a distinct event count. */
function segmentsFor(count: number): Segment[] {
  const spec: SupSpec = {
    width: 1920,
    height: 1080,
    events: Array.from({ length: count }, (_, i) => ({
      ptsMs: 1000 + i * 1000,
      endPtsMs: 1500 + i * 1000,
      objects: [{ objectId: 0, x: 400, y: 800, width: 200, height: 60 }],
    })),
  };
  return parseSupSegments(buildSup(spec));
}

const OPTIONS: ScanOptions = { aspect: 2.4 };

function baseDeps(): ScanDeps {
  return { inspect: async () => INFO };
}

describe("scanFile single-pass PGS reading", () => {
  it("asks the multi-track source once for every PGS track", async () => {
    const byNumber = new Map<number, Segment[]>([
      [3, segmentsFor(1)],
      [5, segmentsFor(2)],
      [7, segmentsFor(3)],
    ]);
    const pgsMultiSource = vi.fn(
      async (_file: string, _tracks: readonly { id: number; number: number }[]) =>
        byNumber,
    );

    const result = await scanFile("/movies/x.mkv", OPTIONS, {
      ...baseDeps(),
      pgsMultiSource,
    });

    expect(pgsMultiSource).toHaveBeenCalledTimes(1);
    const [calledFile, calledTracks] = pgsMultiSource.mock.calls[0]!;
    expect(calledFile).toBe("/movies/x.mkv");
    expect(calledTracks).toEqual([
      { id: 1, number: 3 },
      { id: 2, number: 5 },
      { id: 3, number: 7 },
    ]);
    // Each track got its own segments, not another track's.
    expect(result.tracks.map((t) => t.eventCount)).toEqual([1, 2, 3]);
    expect(result.tracks.map((t) => t.trackNumber)).toEqual([3, 5, 7]);
    expect(result.tracks.every((t) => t.status !== "ERROR")).toBe(true);
  });

  it("falls back to one pass per track when the single pass fails", async () => {
    const pgsMultiSource = vi.fn(async () => {
      throw new Error("track number 5 is not S_HDMV/PGS");
    });
    const pgsSource = vi.fn(async (_file: string, track: { number: number }) =>
      segmentsFor(track.number === 3 ? 1 : 2),
    );
    const warnings: string[] = [];

    const result = await scanFile("/movies/x.mkv", OPTIONS, {
      ...baseDeps(),
      pgsMultiSource,
      pgsSource,
      log: {
        error: () => {},
        warn: (m: string) => warnings.push(m),
        info: () => {},
        debug: () => {},
        trace: () => {},
      },
    });

    expect(pgsMultiSource).toHaveBeenCalledTimes(1);
    expect(pgsSource).toHaveBeenCalledTimes(3);
    expect(result.tracks.map((t) => t.eventCount)).toEqual([1, 2, 2]);
    expect(warnings.some((w) => w.includes("single-pass"))).toBe(true);
  });

  it("uses the injected per-track source alone when no multi source is given", async () => {
    const pgsSource = vi.fn(async () => segmentsFor(2));
    await scanFile("/movies/x.mkv", OPTIONS, { ...baseDeps(), pgsSource });
    expect(pgsSource).toHaveBeenCalledTimes(3);
  });

  it("reports a track the single pass did not return", async () => {
    const pgsMultiSource = vi.fn(async () => new Map([[3, segmentsFor(1)]]));
    const result = await scanFile("/movies/x.mkv", OPTIONS, {
      ...baseDeps(),
      pgsMultiSource,
    });
    expect(result.tracks[0]!.status).not.toBe("ERROR");
    expect(result.tracks[1]!.status).toBe("ERROR");
    expect(result.tracks[1]!.error).toMatch(/not returned by the single-pass reader/);
  });
});
