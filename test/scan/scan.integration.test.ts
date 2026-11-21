/**
 * End-to-end scan against real MKVs built with ffmpeg + mkvmerge, using the
 * real mkvextract-backed PGS source. Skipped when the tools are missing.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanFile, type ScanOptions } from "../../src/scan/scanFile.js";
import { summarize } from "../../src/scan/scanPaths.js";
import { formatJsonReport } from "../../src/report/json.js";
import { formatHumanReport } from "../../src/report/human.js";
import { formatTimestamp } from "../../src/report/format.js";
import { readPgsTracksData } from "../../src/mkv/pgsBlocks.js";
import type { PgsTrackRef } from "../../src/mkv/pgsSource.js";
import type { SupSpec } from "../../src/pgs/fixtures.js";
import {
  hasTool,
  makeLetterboxVideo,
  makeMkv,
  makeTempDir,
  removeDir,
  writeSrt,
  writeSup,
} from "../helpers/scanFixture.js";

const tools = (await hasTool("ffmpeg")) && (await hasTool("mkvmerge")) && (await hasTool("mkvextract"));

/**
 * Four events on a 1920x1080 canvas; the 2.39:1 active area is y=138..941.
 *   0  inside the picture
 *   1  straddling the bottom edge
 *   2  entirely in the bottom bar
 *   3  entirely in the top bar
 */
const SPEC: SupSpec = {
  width: 1920,
  height: 1080,
  events: [
    { ptsMs: 1000, endPtsMs: 1800, objects: [{ x: 860, y: 800, width: 200, height: 60 }] },
    { ptsMs: 2000, endPtsMs: 2800, objects: [{ x: 860, y: 900, width: 200, height: 100 }] },
    { ptsMs: 3000, endPtsMs: 3800, objects: [{ x: 860, y: 980, width: 200, height: 60 }] },
    { ptsMs: 4000, endPtsMs: 4800, objects: [{ x: 860, y: 20, width: 200, height: 60 }] },
  ],
};

describe.skipIf(!tools)("scanFile end to end", () => {
  let dir: string;
  let scopeMkv: string;
  let flatMkv: string;
  let srtMkv: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    const sup = await writeSup(join(dir, "sub.sup"), SPEC);

    const scopeVideo = await makeLetterboxVideo(join(dir, "scope-video.mkv"), {
      activeHeight: 804,
      seconds: 8,
    });
    scopeMkv = await makeMkv(join(dir, "scope.mkv"), scopeVideo, sup);

    const flatVideo = await makeLetterboxVideo(join(dir, "flat-video.mkv"), {
      activeHeight: 1080,
      seconds: 8,
    });
    flatMkv = await makeMkv(join(dir, "flat.mkv"), flatVideo, sup);

    const srt = await writeSrt(join(dir, "sub.srt"));
    srtMkv = await makeMkv(join(dir, "srt.mkv"), flatVideo, null, { extraInputs: [srt] });
  }, 180000);

  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  const manual: ScanOptions = { aspect: 2.39 };

  it("finds the three offending events with a manual aspect", async () => {
    const r = await scanFile(scopeMkv, manual);
    expect(r.status).toBe("NEEDS_FIX");
    expect(r.video).toMatchObject({ width: 1920, height: 1080 });
    expect(r.activeArea).toMatchObject({
      top: 138,
      bottom: 941,
      source: "manual",
      classification: "CONSTANT",
    });

    const track = r.tracks[0]!;
    expect(track.codecId).toBe("S_HDMV/PGS");
    expect(track.language).toBe("eng");
    expect(track.name).toBe("English");
    expect(track.trackId).toBe(1);
    expect(track.trackNumber).toBe(2);
    expect(track.eventCount).toBe(4);
    expect(track.offendingEventCount).toBe(3);
    expect(track.margin).toBe(24);

    expect(track.events.map((e) => formatTimestamp(e.ptsMs))).toEqual([
      "00:00:02.000",
      "00:00:03.000",
      "00:00:04.000",
    ]);
    expect(track.events.map((e) => e.status)).toEqual([
      "PARTIALLY_OUTSIDE",
      "FULLY_OUTSIDE",
      "FULLY_OUTSIDE",
    ]);
    // Active area 138..941 with a 24 px margin allows y 162..917.
    expect(track.events.map((e) => e.proposedDelta)).toEqual([
      { dx: 0, dy: -83 },
      { dx: 0, dy: -123 },
      { dx: 0, dy: 142 },
    ]);
    expect(track.events[0]!.objects[0]!.overflow.bottom).toBe(59);
    expect(track.events[2]!.objects[0]!.overflow.top).toBe(118);
  }, 120000);

  it("reaches the same verdict with auto active-area detection", async () => {
    const r = await scanFile(scopeMkv, { aspect: "auto", samples: 10 });
    expect(r.activeArea).toMatchObject({
      source: "auto",
      classification: "CONSTANT",
      top: 138,
      bottom: 942,
      aspect: 2.39,
    });
    expect(r.status).toBe("NEEDS_FIX");
    const track = r.tracks[0]!;
    expect(track.eventCount).toBe(4);
    expect(track.offendingEventCount).toBe(3);
    expect(track.events.map((e) => e.status)).toEqual([
      "PARTIALLY_OUTSIDE",
      "FULLY_OUTSIDE",
      "FULLY_OUTSIDE",
    ]);
  }, 120000);

  it("finds nothing to fix on a 1.78:1 title, without reading the tracks", async () => {
    // The fast path: the active area is the whole frame, so no event can be
    // outside it and the PGS tracks are never opened. `calls` proves that.
    let calls = 0;
    const counting = async (file: string, refs: readonly PgsTrackRef[]) => {
      calls++;
      const data = await readPgsTracksData(
        file,
        refs.map((r) => r.number),
      );
      return new Map([...data].map(([n, e]) => [n, e.segments]));
    };

    const r = await scanFile(flatMkv, { aspect: 16 / 9 }, { pgsMultiSource: counting });
    expect(calls).toBe(0);
    expect(r.activeArea).toMatchObject({ top: 0, bottom: 1080 });
    expect(r.status).toBe("OK");
    expect(r.notes.join(" ")).toMatch(
      /no letterbox bars detected \(1\.78:1\); PGS tracks not read/,
    );
    const track = r.tracks[0]!;
    expect(track.status).toBe("OK");
    expect(track.eventCount).toBeUndefined();
    expect(track.offendingEventCount).toBe(0);
    expect(track.events).toHaveLength(0);
    // The human report says "not read" rather than pretending it saw zero.
    expect(
      formatHumanReport({ files: [r], summary: summarize([r]), missingPaths: [] }),
    ).toMatch(/events: not read/);

    // --full reads them anyway, and reaches the same verdict the long way.
    const full = await scanFile(
      flatMkv,
      { aspect: 16 / 9, full: true },
      { pgsMultiSource: counting },
    );
    expect(calls).toBe(1);
    expect(full.status).toBe("OK");
    expect(full.tracks[0]!.eventCount).toBe(4);
    expect(full.tracks[0]!.offendingEventCount).toBe(0);
  }, 120000);

  it("reports NO_PGS for an MKV with only an SRT track", async () => {
    const r = await scanFile(srtMkv, manual);
    expect(r.status).toBe("NO_PGS");
    expect(r.tracks).toHaveLength(0);
    expect(r.activeArea).toBeNull();
  }, 120000);

  it("produces identical JSON on two runs", async () => {
    const a = await scanFile(scopeMkv, manual);
    const b = await scanFile(scopeMkv, manual);
    const json = (f: typeof a) =>
      formatJsonReport(
        { files: [f], summary: summarize([f]), missingPaths: [] },
        { aspect: 2.39, showEvents: true },
      );
    expect(json(a)).toBe(json(b));
  }, 120000);

  it("leaves no temporary .sup behind", async () => {
    const scratch = join(dir, "scratch");
    await scanFile(scopeMkv, { ...manual, tempDir: scratch, source: "mkvextract" });
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(scratch)).toEqual([]);
  }, 120000);
});
