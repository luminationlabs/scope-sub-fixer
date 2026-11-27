import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BLOCK_HEADER_SIZE,
  buildDisplaySets,
  buildSup,
  parseSupSegments,
  resolveEvents,
  serializeBlock,
  serializeBlockSegment,
  SEGMENT_TYPE,
  type PgsEvent,
  type Segment,
  type SupSpec,
} from "../../src/pgs/index.js";
import {
  MkvTrackCodecError,
  MkvTrackNotFoundError,
  UnsupportedCompressionError,
  readPgsBlocks,
  readPgsTracksData,
} from "../../src/mkv/pgsBlocks.js";
import type {
  PgsBlock,
  PgsTrackData,
  ReadPgsBlocksOptions,
} from "../../src/mkv/pgsBlocks.js";
import {
  buildTestMkv,
  extractTrack,
  hasTool,
  identifyMkv,
} from "../helpers/scanFixture.js";

const WIDTH = 1920;
const HEIGHT = 1080;

/** 20 events, one of them big enough to force a fragmented (>64 KB) object. */
function mainSpec(): SupSpec {
  const events = [];
  for (let i = 0; i < 20; i++) {
    const big = i === 7;
    events.push({
      ptsMs: 1000 + i * 700,
      endPtsMs: 1000 + i * 700 + 500,
      objects: big
        ? [
            {
              objectId: 0,
              x: 60,
              y: 940,
              width: 900,
              height: 100,
              noise: true,
            },
          ]
        : [
            {
              objectId: 0,
              x: 400 + i * 10,
              y: 900 + (i % 5) * 20,
              width: 300,
              height: 60,
              opaqueRect: { x: 10, y: 8, w: 260, h: 40 },
            },
          ],
    });
  }
  return { width: WIDTH, height: HEIGHT, events };
}

/** A second, clearly different PGS track. */
function altSpec(): SupSpec {
  return {
    width: WIDTH,
    height: HEIGHT,
    events: [0, 1, 2, 3, 4].map((i) => ({
      ptsMs: 2000 + i * 1500,
      endPtsMs: 2000 + i * 1500 + 900,
      objects: [
        { objectId: 0, x: 111 + i, y: 222 + i, width: 120, height: 40 },
      ],
    })),
  };
}

function eventShape(events: PgsEvent[]): unknown[] {
  return events.map((e) => ({
    ptsMs: e.ptsMs,
    endPtsMs: e.endPtsMs,
    videoWidth: e.videoWidth,
    videoHeight: e.videoHeight,
    objects: e.objects.map((o) => ({
      objectId: o.objectId,
      windowId: o.windowId,
      objectRect: o.objectRect,
      visibleRect: o.visibleRect,
      window: o.window,
    })),
  }));
}

/** One track out of the one-pass reader. */
async function trackData(
  file: string,
  number: number,
  options: ReadPgsBlocksOptions = {},
): Promise<PgsTrackData> {
  return (await readPgsTracksData(file, [number], options)).get(number)!;
}

/** The blocks with their payloads, straight from the streaming reader. */
async function trackBlocks(
  file: string,
  number: number,
  options: ReadPgsBlocksOptions = {},
): Promise<PgsBlock[]> {
  const blocks: PgsBlock[] = [];
  for await (const block of readPgsBlocks(file, number, options)) blocks.push(block);
  return blocks;
}

async function pgsTrackNumbers(path: string): Promise<number[]> {
  return (await identifyMkv(path))
    .filter((t) => t.codecId === "S_HDMV/PGS")
    .map((t) => t.number);
}

const canBuildMkv = (await hasTool("ffmpeg")) && (await hasTool("mkvmerge"));
const hasMkvextract = await hasTool("mkvextract");

describe.skipIf(!canBuildMkv)("readPgsBlocks", () => {
  let dir: string;
  let mkvPath: string;
  let bigMkvPath: string;
  let zlibMkvPath: string;
  let mainSup: Uint8Array;
  let altSup: Uint8Array;
  let mainSegments: Segment[];
  let mainTrackNumber: number;
  let altTrackNumber: number;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "scope-sub-mkv-"));
    mainSup = buildSup(mainSpec());
    altSup = buildSup(altSpec());
    mainSegments = parseSupSegments(mainSup);

    mkvPath = await buildTestMkv(join(dir, "main"), {
      width: 640,
      height: 360,
      durationSec: 16,
      supBytes: mainSup,
      extraSubs: [{ sup: altSup, language: "fre" }],
      name: "main.mkv",
    });
    const numbers = await pgsTrackNumbers(mkvPath);
    mainTrackNumber = numbers[0]!;
    altTrackNumber = numbers[1]!;

    // Noisy, lossless video so the video blocks dominate the file: this is the
    // case the skipping reader exists for.
    bigMkvPath = await buildTestMkv(join(dir, "big"), {
      width: 1280,
      height: 720,
      durationSec: 16,
      video: "testsrc2",
      crf: 0,
      supBytes: mainSup,
      name: "big.mkv",
    });

    // mkvmerge's own default for subtitles: zlib content compression.
    zlibMkvPath = await buildTestMkv(join(dir, "zlib"), {
      width: 320,
      height: 180,
      durationSec: 16,
      supBytes: mainSup,
      compression: "zlib",
      name: "zlib.mkv",
    });
  }, 300_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds a fixture whose largest object really is fragmented", () => {
    const fragments = mainSegments.filter(
      (s) => s.type === SEGMENT_TYPE.ODS && s.isFirst && !s.isLast,
    );
    expect(fragments.length).toBeGreaterThan(0);
  });

  it("yields one block per display set, with the fixture's timestamps", async () => {
    const supDisplaySets = buildDisplaySets(mainSegments);
    const blocks = [];
    for await (const block of readPgsBlocks(mkvPath, mainTrackNumber)) {
      blocks.push(block);
    }
    // mkvmerge writes the clearing display sets too, so the counts match 1:1.
    expect(blocks.length).toBe(supDisplaySets.length);
    for (const [i, block] of blocks.entries()) {
      expect(block.trackNumber).toBe(mainTrackNumber);
      expect(block.blockKind).toBe("SimpleBlock");
      expect(block.compressed).toBe(false);
      // MKV stores millisecond timestamps.
      expect(Math.abs(block.timestampMs - supDisplaySets[i]!.ptsMs)).toBeLessThanOrEqual(1);
    }
  });

  it("reproduces the .sup byte for byte", async () => {
    const blocks = await trackBlocks(mkvPath, mainTrackNumber);
    const fromBlocks = Buffer.concat(blocks.map((b) => Buffer.from(b.payload)));
    expect(Buffer.compare(fromBlocks, Buffer.from(serializeBlock(mainSegments)))).toBe(0);

    const data = await trackData(mkvPath, mainTrackNumber);
    expect(data.segments.length).toBe(mainSegments.length);
    for (const [i, seg] of data.segments.entries()) {
      const expected = serializeBlockSegment(mainSegments[i]!);
      expect(Buffer.compare(Buffer.from(serializeBlockSegment(seg)), Buffer.from(expected))).toBe(0);
    }
  });

  it("resolves identical events to the .sup it was built from", async () => {
    const { segments } = await trackData(mkvPath, mainTrackNumber);
    const fromMkv = resolveEvents(buildDisplaySets(segments));
    const fromSup = resolveEvents(buildDisplaySets(mainSegments));
    expect(fromMkv.length).toBe(20);
    expect(eventShape(fromMkv)).toEqual(eventShape(fromSup));
  });

  it("gives each segment an absolute offset into the MKV", async () => {
    const { segments } = await trackData(mkvPath, mainTrackNumber);
    const raw = readFileSync(mkvPath);
    for (const seg of segments) {
      const slice = raw.subarray(seg.offset, seg.offset + BLOCK_HEADER_SIZE + seg.size);
      expect(Buffer.compare(slice, Buffer.from(serializeBlockSegment(seg)))).toBe(0);
    }
    // Offsets are strictly increasing and land inside the file.
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.offset).toBeGreaterThan(segments[i - 1]!.offset);
    }
    expect(segments[0]!.offset).toBeGreaterThan(0);
    expect(segments.at(-1)!.offset).toBeLessThan(raw.length);
  });

  it.skipIf(!hasMkvextract)("agrees with mkvextract", async () => {
    const tracks = (await identifyMkv(mkvPath)).filter(
      (t) => t.codecId === "S_HDMV/PGS",
    );
    const extracted = await extractTrack(
      mkvPath,
      tracks[0]!.id,
      join(dir, "extracted.sup"),
    );
    const extractedSegments = parseSupSegments(readFileSync(extracted));
    const data = await trackData(mkvPath, mainTrackNumber);

    expect(data.segments.length).toBe(extractedSegments.length);
    for (const [i, seg] of data.segments.entries()) {
      const other = extractedSegments[i]!;
      // mkvextract re-adds the 13-byte "PG" header; the payloads must match.
      expect(
        Buffer.compare(
          Buffer.from(serializeBlockSegment(seg)),
          Buffer.from(serializeBlockSegment(other)),
        ),
      ).toBe(0);
      // …and so must the timestamps, at millisecond precision.
      expect(Math.abs(seg.pts - other.pts) / 90).toBeLessThanOrEqual(1);
    }
  });

  it("selects a PGS track by its Matroska track number", async () => {
    const both = await readPgsTracksData(mkvPath, [mainTrackNumber, altTrackNumber]);
    const first = both.get(mainTrackNumber)!.segments;
    const second = both.get(altTrackNumber)!.segments;
    expect(mainTrackNumber).not.toBe(altTrackNumber);
    expect(resolveEvents(buildDisplaySets(first)).length).toBe(20);
    expect(resolveEvents(buildDisplaySets(second)).length).toBe(5);
    expect(
      Buffer.compare(
        Buffer.from(serializeBlock(first)),
        Buffer.from(serializeBlock(parseSupSegments(mainSup))),
      ),
    ).toBe(0);
    expect(
      Buffer.compare(
        Buffer.from(serializeBlock(second)),
        Buffer.from(serializeBlock(parseSupSegments(altSup))),
      ),
    ).toBe(0);
  });

  it("reads a small fraction of a video-heavy file", async () => {
    const data = await trackData(bigMkvPath, mainTrackNumber, {
      strategy: "adaptive",
    });
    const fileSize = readFileSync(bigMkvPath).length;
    const subtitleBytes = data.blocks.reduce((n, b) => n + b.fileLength, 0);
    // Sanity: the file really is dominated by video.
    expect(fileSize).toBeGreaterThan(subtitleBytes * 4);
    expect(data.stats.fileSize).toBe(fileSize);
    // eslint-disable-next-line no-console
    console.log(
      `bytesRead ${data.stats.bytesRead} / ${fileSize} = ${(data.stats.readRatio * 100).toFixed(1)}% ` +
        `(${data.stats.readCalls} reads, ${data.stats.bytesSkipped} bytes skipped)`,
    );
    expect(data.stats.readRatio).toBeLessThan(0.5);
    // Measured at ~1.8% on a 27 MB lossless fixture; the loose bound above is
    // the contract, this one guards against the skipping quietly regressing.
    expect(data.stats.readRatio).toBeLessThan(0.25);
    // The subtitle payload itself is of course read in full.
    expect(data.stats.bytesRead).toBeGreaterThan(subtitleBytes);
    expect(resolveEvents(buildDisplaySets(data.segments)).length).toBe(20);
  });

  it("inflates a zlib-compressed subtitle track", async () => {
    const data = await trackData(zlibMkvPath, mainTrackNumber);
    expect(data.compressed).toBe(true);
    expect(
      Buffer.compare(
        Buffer.from(serializeBlock(data.segments)),
        Buffer.from(serializeBlock(mainSegments)),
      ),
    ).toBe(0);
    // Compressed frames are smaller in the file than the payload they decode to.
    const blocks = await trackBlocks(zlibMkvPath, mainTrackNumber);
    const stored = blocks.reduce((n, b) => n + b.fileLength, 0);
    const decoded = blocks.reduce((n, b) => n + b.payload.length, 0);
    expect(stored).toBeLessThan(decoded);
  });

  it("refuses a compressed track when byte-addressable offsets are required", async () => {
    await expect(
      trackData(zlibMkvPath, mainTrackNumber, { requireByteAddressable: true }),
    ).rejects.toThrow(UnsupportedCompressionError);
    // The uncompressed fixture is fine.
    await expect(
      trackData(mkvPath, mainTrackNumber, { requireByteAddressable: true }),
    ).resolves.toBeDefined();
  });

  it("reports progress and final stats", async () => {
    const progress: number[] = [];
    let finalRatio = -1;
    const data = await trackData(mkvPath, mainTrackNumber, {
      onProgress: (p) => progress.push(p.blocks),
      onStats: (s) => {
        finalRatio = s.readRatio;
      },
    });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(data.blocks.length);
    expect(finalRatio).toBeGreaterThan(0);
    expect(data.timecodeScale).toBe(1_000_000);
  });

  it("rejects unknown track numbers and non-PGS tracks", async () => {
    await expect(trackData(mkvPath, 99)).rejects.toThrow(MkvTrackNotFoundError);
    const video = (await identifyMkv(mkvPath)).find((t) => t.type === "video")!;
    await expect(trackData(mkvPath, video.number)).rejects.toThrow(
      MkvTrackCodecError,
    );
  });

  it("trades bytes for round trips across strategies", async () => {
    const frugal = await trackData(bigMkvPath, mainTrackNumber, {
      strategy: "adaptive",
    });
    const streaming = await trackData(bigMkvPath, mainTrackNumber, {
      strategy: "sequential",
    });
    // Same segments either way.
    expect(
      Buffer.compare(
        Buffer.from(serializeBlock(frugal.segments)),
        Buffer.from(serializeBlock(streaming.segments)),
      ),
    ).toBe(0);
    // Streaming transfers far more but needs an order of magnitude fewer reads.
    expect(streaming.stats.bytesRead).toBeGreaterThan(frugal.stats.bytesRead * 5);
    expect(streaming.stats.readCalls * 5).toBeLessThan(frugal.stats.readCalls);
    expect(streaming.stats.seeks).toBe(0);
    expect(frugal.stats.strategy).toBe("adaptive");
    expect(streaming.stats.strategy).toBe("sequential");
  });

  it("reads every PGS track in a single pass", async () => {
    const single = await readPgsTracksData(
      mkvPath,
      [mainTrackNumber, altTrackNumber],
      { strategy: "adaptive" },
    );
    expect([...single.keys()]).toEqual([mainTrackNumber, altTrackNumber]);

    const first = await trackData(mkvPath, mainTrackNumber, {
      strategy: "adaptive",
    });
    const second = await trackData(mkvPath, altTrackNumber, {
      strategy: "adaptive",
    });

    // Identical output to two separate passes...
    for (const [number, separate] of [
      [mainTrackNumber, first],
      [altTrackNumber, second],
    ] as const) {
      const combined = single.get(number)!;
      expect(combined.trackNumber).toBe(number);
      expect(combined.blocks.map((b) => b.fileOffset)).toEqual(
        separate.blocks.map((b) => b.fileOffset),
      );
      expect(
        Buffer.compare(
          Buffer.from(serializeBlock(combined.segments)),
          Buffer.from(serializeBlock(separate.segments)),
        ),
      ).toBe(0);
      expect(combined.segments.map((seg) => seg.offset)).toEqual(
        separate.segments.map((seg) => seg.offset),
      );
    }

    // ...for the cost of one walk instead of two.
    const shared = single.get(mainTrackNumber)!.stats;
    expect(single.get(altTrackNumber)!.stats).toEqual(shared);
    expect(shared.readCalls).toBeLessThan(
      first.stats.readCalls + second.stats.readCalls,
    );
    expect(shared.bytesRead).toBeLessThan(
      first.stats.bytesRead + second.stats.bytesRead,
    );
  });

  it("returns a map keyed by Matroska track number", async () => {
    const map = await readPgsTracksData(mkvPath, [mainTrackNumber, altTrackNumber]);
    expect(
      resolveEvents(buildDisplaySets(map.get(mainTrackNumber)!.segments)).length,
    ).toBe(20);
    expect(
      resolveEvents(buildDisplaySets(map.get(altTrackNumber)!.segments)).length,
    ).toBe(5);
  });

  it("rejects a multi-track request naming a non-PGS or missing track", async () => {
    const video = (await identifyMkv(mkvPath)).find((t) => t.type === "video")!;
    await expect(
      readPgsTracksData(mkvPath, [mainTrackNumber, video.number]),
    ).rejects.toThrow(MkvTrackCodecError);
    await expect(
      readPgsTracksData(mkvPath, [mainTrackNumber, 99]),
    ).rejects.toThrow(MkvTrackNotFoundError);
  });
});
