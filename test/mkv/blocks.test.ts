/**
 * Unit tests for the Matroska pieces that do not need ffmpeg/mkvmerge:
 * lacing, track parsing, and a handmade MKV with unknown-size Segment and
 * Cluster elements (what mkvmerge writes when it streams its output).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  EBML_ID,
  MkvTrackCodecError,
  MkvTrackNotFoundError,
  PGS_CODEC_ID,
  UnsupportedCompressionError,
  UnsupportedLacingError,
  parseTracks,
  readPgsBlocks,
  readPgsTracksData,
  splitLacedFrames,
} from "../../src/mkv/pgsBlocks.js";
import type {
  PgsBlock,
  PgsTrackData,
  ReadPgsBlocksOptions,
} from "../../src/mkv/pgsBlocks.js";
import {
  buildDisplaySets,
  buildSup,
  displaySetSegments,
  parseSupSegments,
  resolveEvents,
  serializeBlock,
  type SupSpec,
} from "../../src/pgs/index.js";
import {
  blockPayload,
  concat,
  idBytes,
  element,
  stringElement,
  uintElement,
  unknownSizeElement,
  vint,
} from "./support.js";

function sizes(frames: { data: Uint8Array; offset: number }[]): number[] {
  return frames.map((f) => f.data.length);
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

describe("splitLacedFrames", () => {
  const body = Uint8Array.from({ length: 12 }, (_, i) => i);

  it("returns the whole payload when the block is unlaced", () => {
    const frames = splitLacedFrames(body, 0, 0);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.offset).toBe(0);
    expect(frames[0]!.data).toEqual(body);
  });

  it("decodes Xiph lacing", () => {
    // 3 frames of 3, 4 and (implicitly) 5 bytes.
    const laced = concat([Uint8Array.of(2, 3, 4), body]);
    const frames = splitLacedFrames(laced, 1, 0);
    expect(sizes(frames)).toEqual([3, 4, 5]);
    expect(frames.map((f) => f.offset)).toEqual([3, 6, 10]);
  });

  it("decodes Xiph 255-continuation sizes", () => {
    const big = new Uint8Array(300 + 5);
    const laced = concat([Uint8Array.of(1, 255, 45), big]);
    expect(sizes(splitLacedFrames(laced, 1, 0))).toEqual([300, 5]);
  });

  it("decodes fixed-size lacing", () => {
    const laced = concat([Uint8Array.of(2), body]);
    expect(sizes(splitLacedFrames(laced, 2, 0))).toEqual([4, 4, 4]);
  });

  it("decodes EBML lacing with signed deltas", () => {
    // 3 frames: first 3 bytes, then +1 => 4, remainder => 5.
    const laced = concat([
      Uint8Array.of(2),
      vint(3),
      Uint8Array.of(0xc0), // signed vint for +1
      body,
    ]);
    expect(sizes(splitLacedFrames(laced, 3, 0))).toEqual([3, 4, 5]);
  });

  it("handles a single-frame lace in every mode", () => {
    for (const [mode, laced] of [
      [1, concat([Uint8Array.of(0), body])],
      [2, concat([Uint8Array.of(0), body])],
      [3, concat([Uint8Array.of(0), body])],
    ] as const) {
      const frames = splitLacedFrames(laced, mode, 0);
      expect(sizes(frames)).toEqual([body.length]);
      expect(frames[0]!.offset).toBe(1);
    }
  });

  it("throws UnsupportedLacingError when the sizes do not add up", () => {
    const laced = concat([Uint8Array.of(2, 20, 20), body]);
    expect(() => splitLacedFrames(laced, 1, 42)).toThrow(UnsupportedLacingError);
    const uneven = concat([Uint8Array.of(4), body]);
    expect(() => splitLacedFrames(uneven, 2, 42)).toThrow(/fixed lacing/);
  });
});

describe("parseTracks", () => {
  const tracks = concat([
    element(
      EBML_ID.TrackEntry,
      concat([
        uintElement(EBML_ID.TrackNumber, 1),
        uintElement(EBML_ID.TrackType, 1),
        stringElement(EBML_ID.CodecID, "V_MPEG4/ISO/AVC"),
      ]),
    ),
    element(
      EBML_ID.TrackEntry,
      concat([
        uintElement(EBML_ID.TrackNumber, 3),
        uintElement(EBML_ID.TrackType, 17),
        stringElement(EBML_ID.CodecID, PGS_CODEC_ID),
        stringElement(EBML_ID.Language, "eng"),
        element(
          EBML_ID.ContentEncodings,
          element(
            EBML_ID.ContentEncoding,
            element(
              EBML_ID.ContentCompression,
              uintElement(EBML_ID.ContentCompAlgo, 0),
            ),
          ),
        ),
      ]),
    ),
  ]);

  it("reads track numbers, codecs, languages and compression", () => {
    const parsed = parseTracks(tracks);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.codecId).toBe("V_MPEG4/ISO/AVC");
    expect(parsed[0]!.compression).toBeUndefined();
    expect(parsed[1]!.trackNumber).toBe(3);
    expect(parsed[1]!.codecId).toBe(PGS_CODEC_ID);
    expect(parsed[1]!.language).toBe("eng");
    expect(parsed[1]!.compression).toEqual({ algorithm: 0 });
  });

  it("rejects encrypted tracks", () => {
    const encrypted = element(
      EBML_ID.TrackEntry,
      concat([
        uintElement(EBML_ID.TrackNumber, 3),
        stringElement(EBML_ID.CodecID, PGS_CODEC_ID),
        element(
          EBML_ID.ContentEncodings,
          element(
            EBML_ID.ContentEncoding,
            element(EBML_ID.ContentEncryption, new Uint8Array(0)),
          ),
        ),
      ]),
    );
    expect(() => parseTracks(encrypted)).toThrow(UnsupportedCompressionError);
  });
});

/** A two-event .sup, split into one block payload per display set. */
function displaySetBlocks(spec: SupSpec): { payloads: Uint8Array[]; ptsMs: number[] } {
  const segments = parseSupSegments(buildSup(spec));
  const sets = buildDisplaySets(segments);
  return {
    payloads: sets.map((ds) => serializeBlock(displaySetSegments(ds))),
    ptsMs: sets.map((ds) => ds.ptsMs),
  };
}

describe("readPgsBlocks on handmade Matroska", () => {
  let dir: string;
  const spec: SupSpec = {
    width: 1920,
    height: 1080,
    events: [
      { ptsMs: 1000, objects: [{ objectId: 0, x: 10, y: 900, width: 80, height: 40 }] },
      { ptsMs: 4000, objects: [{ objectId: 0, x: 20, y: 910, width: 80, height: 40 }] },
    ],
  };
  const { payloads, ptsMs } = displaySetBlocks(spec);
  const videoFiller = new Uint8Array(120_000).fill(0x5a);

  function tracksElement(compressed = false): Uint8Array {
    const encodings = compressed
      ? element(
          EBML_ID.ContentEncodings,
          element(
            EBML_ID.ContentEncoding,
            element(
              EBML_ID.ContentCompression,
              uintElement(EBML_ID.ContentCompAlgo, 0),
            ),
          ),
        )
      : new Uint8Array(0);
    return element(
      EBML_ID.Tracks,
      concat([
        element(
          EBML_ID.TrackEntry,
          concat([
            uintElement(EBML_ID.TrackNumber, 1),
            uintElement(EBML_ID.TrackType, 1),
            stringElement(EBML_ID.CodecID, "V_MPEG4/ISO/AVC"),
          ]),
        ),
        element(
          EBML_ID.TrackEntry,
          concat([
            uintElement(EBML_ID.TrackNumber, 3),
            uintElement(EBML_ID.TrackType, 17),
            stringElement(EBML_ID.CodecID, PGS_CODEC_ID),
            encodings,
          ]),
        ),
      ]),
    );
  }

  /**
   * Segment and Cluster both use the unknown-size encoding, the first PGS
   * block is a SimpleBlock and the second sits in a BlockGroup with a
   * BlockDuration, and both clusters are padded with video blocks that must be
   * skipped rather than read.
   */
  function buildFile(
    options: {
      compressed?: boolean;
      timecodeScale?: number;
      /**
       * Tracks after the clusters, as MakeMKV 1.9 wrote it: found through the
       * SeekHead ("indexed"), not listed there ("unlisted"), listed at the
       * wrong place ("misplaced") or beyond the file ("past-end"), listed only
       * in a second SeekHead the first points at ("second-index"), or with
       * Info after the clusters as well ("info-last").
       */
      tracksLast?:
        | "indexed"
        | "unlisted"
        | "misplaced"
        | "past-end"
        | "second-index"
        | "info-last"
        /** Tracks first; Info after the clusters and in no index. */
        | "info-late-unlisted"
        /** Tracks first, no Info at all; the index lists a SeekHead and an Info where there is only junk. */
        | "bad-hints"
        /** The usual order, with an Info that claims 32 MiB. */
        | "huge-info";
    } = {},
  ): Uint8Array {
    const scale = options.timecodeScale ?? 1_000_000;
    const tick = 1_000_000 / scale; // ticks per millisecond
    const frame = (payload: Uint8Array): Uint8Array =>
      options.compressed
        ? new Uint8Array(deflateSync(Buffer.from(payload)))
        : payload;

    // A cluster of unknown size runs to the end of the file, so a file with
    // anything after its clusters has sized ones.
    const clusterElement = options.tracksLast ? element : unknownSizeElement;
    const cluster1 = clusterElement(
      EBML_ID.Cluster,
      concat([
        uintElement(EBML_ID.Timecode, 0),
        element(EBML_ID.SimpleBlock, blockPayload(1, 0, 0x80, videoFiller)),
        element(
          EBML_ID.SimpleBlock,
          blockPayload(3, ptsMs[0]! * tick, 0x80, frame(payloads[0]!)),
        ),
        element(EBML_ID.SimpleBlock, blockPayload(1, 40, 0, videoFiller)),
      ]),
    );
    const cluster2 = clusterElement(
      EBML_ID.Cluster,
      concat([
        uintElement(EBML_ID.Timecode, 2000 * tick),
        element(EBML_ID.SimpleBlock, blockPayload(1, 0, 0x80, videoFiller)),
        element(
          EBML_ID.BlockGroup,
          concat([
            element(
              EBML_ID.Block,
              blockPayload(3, (ptsMs[1]! - 2000) * tick, 0, frame(payloads[1]!)),
            ),
            uintElement(EBML_ID.BlockDuration, 1000 * tick),
          ]),
        ),
        element(EBML_ID.SimpleBlock, blockPayload(1, 40, 0, videoFiller)),
      ]),
    );

    if (options.tracksLast) {
      const kind = options.tracksLast;
      const info = element(EBML_ID.Info, uintElement(EBML_ID.TimecodeScale, scale));
      const chapters = element(0x1043a770, new Uint8Array(900).fill(0));
      const tracks = tracksElement(options.compressed ?? false);
      // Each SeekPosition is a fixed 8 bytes, so no element's length depends
      // on the positions written into it afterwards.
      const at = { tracks: new Uint8Array(8), info: new Uint8Array(8), second: new Uint8Array(8) };
      const seek = (id: number, position: Uint8Array): Uint8Array =>
        element(EBML_ID.Seek, concat([element(EBML_ID.SeekID, idBytes(id)), element(EBML_ID.SeekPosition, position)]));
      // The first index: an entry for something else first, then what this
      // layout lists up front.
      const first = (): Uint8Array =>
        element(
          EBML_ID.SeekHead,
          concat([
            seek(0x1043a770, new Uint8Array(8)),
            ...(kind === "second-index" ? [seek(EBML_ID.SeekHead, at.second)] : []),
            ...(kind === "unlisted" || kind === "second-index" ? [] : [seek(EBML_ID.Tracks, at.tracks)]),
            ...(kind === "info-last" ? [seek(EBML_ID.Info, at.info)] : []),
          ]),
        );
      const second = (): Uint8Array => element(EBML_ID.SeekHead, seek(EBML_ID.Tracks, at.tracks));
      const wrap = (children: Uint8Array[]): Uint8Array =>
        concat([
          element(EBML_ID.EBML, stringElement(0x4282, "matroska")),
          element(EBML_ID.Segment, concat(children)),
        ]);
      const cues = element(EBML_ID.Cues, new Uint8Array(64).fill(0));
      if (kind === "info-late-unlisted") {
        return wrap([element(EBML_ID.SeekHead, seek(0x1043a770, new Uint8Array(8))), tracks, chapters, cluster1, cluster2, info, cues]);
      }
      if (kind === "bad-hints") {
        // Both entries point into the Chapters element's zero bytes: no
        // element starts there.
        const junk = new Uint8Array(8);
        const hints = (): Uint8Array =>
          element(EBML_ID.SeekHead, concat([seek(EBML_ID.SeekHead, junk), seek(EBML_ID.Info, junk)]));
        new DataView(junk.buffer).setBigUint64(0, BigInt(hints().length + tracks.length + 100));
        return wrap([hints(), tracks, chapters, cluster1, cluster2, cues]);
      }
      if (kind === "huge-info") {
        // ID, then an 8-byte size of 32 MiB, then two bytes: the size is a lie.
        const lying = concat([idBytes(EBML_ID.Info), Uint8Array.of(0x01, 0, 0, 0, 0x02, 0, 0, 0), Uint8Array.of(0, 0)]);
        return wrap([element(EBML_ID.SeekHead, seek(0x1043a770, new Uint8Array(8))), lying, tracks, cluster1, cluster2, cues]);
      }
      const head = kind === "info-last" ? [first(), chapters] : [first(), info, chapters];
      const tail =
        kind === "info-last" ? [tracks, info] : kind === "second-index" ? [tracks, second()] : [tracks];
      const parts = (): Uint8Array[] => [...head.slice(0, 0), first(), ...head.slice(1), cluster1, cluster2, ...tail.map((t, i) => (kind === "second-index" && i === 1 ? second() : t)), element(EBML_ID.Cues, new Uint8Array(64).fill(0))];
      // SeekPosition counts from the start of the Segment's data.
      const offsetOf = (index: number): number => parts().slice(0, index).reduce((n, part) => n + part.length, 0);
      const firstCount = head.length + 2;
      const put = (target: Uint8Array, value: number): void => new DataView(target.buffer).setBigUint64(0, BigInt(value));
      const total = parts().reduce((n, part) => n + part.length, 0);
      put(at.tracks, kind === "misplaced" ? first().length : kind === "past-end" ? total + 4096 : offsetOf(firstCount));
      if (kind === "info-last") put(at.info, offsetOf(firstCount + 1));
      if (kind === "second-index") put(at.second, offsetOf(firstCount + 1));
      return concat([
        element(EBML_ID.EBML, stringElement(0x4282, "matroska")),
        element(EBML_ID.Segment, concat(parts())),
      ]);
    }

    return concat([
      element(EBML_ID.EBML, stringElement(0x4282, "matroska")),
      unknownSizeElement(
        EBML_ID.Segment,
        concat([
          element(EBML_ID.SeekHead, new Uint8Array(64).fill(0)),
          element(EBML_ID.Info, uintElement(EBML_ID.TimecodeScale, scale)),
          tracksElement(options.compressed ?? false),
          cluster1,
          cluster2,
          element(EBML_ID.Cues, new Uint8Array(2048).fill(0)),
          element(EBML_ID.Tags, new Uint8Array(512).fill(0)),
        ]),
      ),
    ]);
  }

  function write(name: string, bytes: Uint8Array): string {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return path;
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "scope-sub-mkvsynth-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads with the documented default strategy when none is given", async () => {
    const path = write("default-strategy.mkv", buildFile());
    expect((await trackData(path, 3)).stats.strategy).toBe("sequential");
  });

  it("walks unknown-size Segment and Cluster elements", async () => {
    const path = write("unknown.mkv", buildFile());
    const data = await trackData(path, 3);
    expect(data.blocks).toHaveLength(2);
    expect(data.blocks.map((b) => b.timestampMs)).toEqual(ptsMs);
    expect(data.blocks[0]!.clusterOffset).toBeLessThan(data.blocks[1]!.clusterOffset);

    const blocks = await trackBlocks(path, 3);
    expect(blocks.map((b) => b.blockKind)).toEqual(["SimpleBlock", "BlockGroup"]);
    expect(blocks[0]!.duration).toBeUndefined();
    expect(blocks[1]!.duration).toBe(1000);
    expect(resolveEvents(buildDisplaySets(data.segments))).toHaveLength(2);
  });

  it("finds Tracks through the SeekHead when the file keeps it after its clusters", async () => {
    // The layout of a MakeMKV 1.9 rip: SeekHead, Info, Chapters, clusters, Tracks.
    // Offsets are the file's own, as for any other layout — patches rely on
    // it — whichever way the file is read, and when the trip to Tracks and
    // back leaves the read buffer (the small chunk size).
    const check = async (name: string, bytes: Uint8Array): Promise<void> => {
      const path = write(name, bytes);
      for (const strategy of ["sequential", "adaptive", "minimal"] as const) {
        for (const maxChunkSize of [undefined, 1024]) {
          const options = { strategy, ...(maxChunkSize === undefined ? {} : { maxChunkSize }) };
          const blocks = await trackBlocks(path, 3, options);
          expect(blocks.map((b) => b.timestampMs)).toEqual(ptsMs);
          for (const [i, block] of blocks.entries()) {
            const onDisk = bytes.subarray(block.fileOffset, block.fileOffset + block.fileLength);
            expect(Buffer.from(onDisk).equals(Buffer.from(payloads[i]!))).toBe(true);
            expect([...bytes.subarray(block.clusterOffset, block.clusterOffset + 4)]).toEqual([0x1f, 0x43, 0xb6, 0x75]);
          }
        }
      }
      expect(resolveEvents(buildDisplaySets((await trackData(path, 3)).segments))).toHaveLength(2);
    };
    await check("tracks-last.mkv", buildFile({ tracksLast: "indexed" }));
    // The first index only points at a second one, which lists Tracks.
    await check("tracks-second-index.mkv", buildFile({ tracksLast: "second-index" }));
    // Info after the clusters too: its scale must be in hand before the first
    // block is timed, or every time would be silently doubled here.
    await check("tracks-info-last.mkv", buildFile({ tracksLast: "info-last", timecodeScale: 500_000 }));
    await check("tracks-last-scaled.mkv", buildFile({ tracksLast: "indexed", timecodeScale: 500_000 }));
  });

  it("refuses a file whose clusters come first when its index cannot say where Tracks is", async () => {
    const refusal = (kind: "unlisted" | "misplaced" | "past-end") =>
      trackData(write(`tracks-${kind}.mkv`, buildFile({ tracksLast: kind })), 3);
    await expect(refusal("unlisted")).rejects.toThrow(/index does not say where Tracks is/);
    await expect(refusal("misplaced")).rejects.toThrow(/index points at something else/);
    await expect(refusal("past-end")).rejects.toThrow(/index puts Tracks beyond the end of the file's data/);
  });

  it("takes the index as a hint: what it gets wrong does not stop a file that is in order", async () => {
    // Tracks in its place, no Info anywhere, and index entries pointing at
    // bytes that are no element: read as if the index said nothing.
    const path = write("bad-hints.mkv", buildFile({ tracksLast: "bad-hints" }));
    for (const strategy of ["sequential", "adaptive", "minimal"] as const) {
      const blocks = await trackBlocks(path, 3, { strategy, maxChunkSize: 1024 });
      expect(blocks.map((b) => b.timestampMs)).toEqual(ptsMs);
    }
  });

  it("refuses blocks it would have to time before knowing the scale, and a header of impossible size", async () => {
    // Info after the clusters, in no index, with the default scale: nothing
    // was mistimed, so the file reads.
    const same = write("info-late-same.mkv", buildFile({ tracksLast: "info-late-unlisted" }));
    expect((await trackData(same, 3)).blocks.map((b) => b.timestampMs)).toEqual(ptsMs);
    // With another scale every block was timed wrongly by then: refused, not
    // reported at double the time.
    const other = write("info-late-other.mkv", buildFile({ tracksLast: "info-late-unlisted", timecodeScale: 500_000 }));
    await expect(trackData(other, 3)).rejects.toThrow(/Info element comes after its clusters/);
    await expect(trackData(write("huge-info.mkv", buildFile({ tracksLast: "huge-info" })), 3)).rejects.toThrow(
      /Info element claims 33554432 bytes/,
    );
  });

  it("puts the block payloads exactly where fileOffset says", async () => {
    const bytes = buildFile();
    const path = write("offsets.mkv", bytes);
    for (const block of await trackBlocks(path, 3)) {
      const slice = bytes.subarray(
        block.fileOffset,
        block.fileOffset + block.fileLength,
      );
      expect(Buffer.compare(Buffer.from(slice), Buffer.from(block.payload))).toBe(0);
    }
  });

  it("skips the video blocks instead of reading them", async () => {
    const bytes = buildFile();
    const path = write("skip.mkv", bytes);
    const data = await trackData(path, 3, { strategy: "adaptive" });
    expect(data.stats.fileSize).toBe(bytes.length);
    expect(data.stats.bytesSkipped).toBeGreaterThan(4 * videoFiller.length * 0.9);
    expect(data.stats.readRatio).toBeLessThan(0.05);
  });

  it("scales timestamps by a non-default TimecodeScale", async () => {
    const path = write("scaled.mkv", buildFile({ timecodeScale: 100_000 }));
    const data = await trackData(path, 3);
    expect(data.timecodeScale).toBe(100_000);
    expect(data.blocks.map((b) => b.timestampMs)).toEqual(ptsMs);
    expect((await trackBlocks(path, 3))[1]!.duration).toBe(1000);
  });

  it("inflates zlib-compressed frames", async () => {
    const path = write("zlib.mkv", buildFile({ compressed: true }));
    const data = await trackData(path, 3);
    expect(data.compressed).toBe(true);
    const blocks = await trackBlocks(path, 3);
    expect(Buffer.compare(Buffer.from(blocks[0]!.payload), Buffer.from(payloads[0]!))).toBe(0);
  });

  it("reports missing and mistyped tracks", async () => {
    const path = write("errors.mkv", buildFile());
    await expect(trackData(path, 7)).rejects.toThrow(MkvTrackNotFoundError);
    await expect(trackData(path, 1)).rejects.toThrow(MkvTrackCodecError);
  });

  it("rejects files that are not Matroska", async () => {
    const path = write("junk.bin", Uint8Array.from(Buffer.from("not an mkv at all")));
    await expect(trackData(path, 3)).rejects.toThrow(/EBML|Matroska|vint/i);
  });
});
