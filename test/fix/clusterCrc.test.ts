/**
 * Cluster CRC-32 handling.
 *
 * mkvmerge and MakeMKV never write cluster checksums, but the format allows
 * them, and rewriting a byte inside a CRC-protected cluster would silently
 * invalidate it. The reader flags such blocks and `fix --method patch` refuses.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EBML_ID, PGS_CODEC_ID, readPgsTracksData } from "../../src/mkv/pgsBlocks.js";
import { fixFile } from "../../src/fix/fixFile.js";
import type { MkvInfo } from "../../src/mkv/inspect.js";
import {
  buildDisplaySets,
  buildSup,
  displaySetSegments,
  parseSupSegments,
  serializeBlock,
  type SupSpec,
} from "../../src/pgs/index.js";
import {
  blockPayload,
  concat,
  element,
  stringElement,
  uintElement,
} from "../mkv/support.js";

/** One event inside the picture, one in the bottom bar. */
const SPEC: SupSpec = {
  width: 1920,
  height: 1080,
  events: [
    { ptsMs: 1000, objects: [{ objectId: 0, x: 860, y: 700, width: 200, height: 60 }] },
    { ptsMs: 4000, objects: [{ objectId: 0, x: 860, y: 900, width: 200, height: 100 }] },
  ],
};

const sets = buildDisplaySets(parseSupSegments(buildSup(SPEC)));
const payloads = sets.map((ds) => serializeBlock(displaySetSegments(ds)));

const TRACKS = element(
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
        stringElement(EBML_ID.Language, "eng"),
      ]),
    ),
  ]),
);

/** A cluster per display set; `crcClusters` picks which get a CRC-32 child. */
function buildFile(crcClusters: readonly boolean[]): Uint8Array {
  const clusters = payloads.map((payload, i) =>
    element(
      EBML_ID.Cluster,
      concat([
        // CRC-32 is mandated to be the first child of its master element.
        ...(crcClusters[i] ? [element(EBML_ID.CRC32, Uint8Array.of(1, 2, 3, 4))] : []),
        uintElement(EBML_ID.Timecode, i * 4000),
        element(EBML_ID.SimpleBlock, blockPayload(3, 0, 0x80, payload)),
      ]),
    ),
  );
  return concat([
    element(EBML_ID.EBML, uintElement(0x4286, 1)),
    element(
      EBML_ID.Segment,
      concat([
        element(EBML_ID.Info, uintElement(EBML_ID.TimecodeScale, 1_000_000)),
        TRACKS,
        ...clusters,
      ]),
    ),
  ]);
}

function info(file: string): MkvInfo {
  return {
    file,
    durationMs: 10000,
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
    subtitleTracks: [
      {
        id: 1,
        number: 3,
        codecId: PGS_CODEC_ID,
        language: "eng",
        name: undefined,
        default: true,
        forced: false,
        hearingImpaired: false,
        isPgs: true,
      },
    ],
    tracks: [
      { id: 0, number: 1, type: "video", codecId: "V_MPEG4/ISO/AVC" },
      { id: 1, number: 3, type: "subtitles", codecId: PGS_CODEC_ID },
    ],
  };
}

describe("cluster CRC-32", () => {
  let dir: string;
  let plain: string;
  let protectedFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "scope-sub-crc-"));
    plain = join(dir, "plain.mkv");
    protectedFile = join(dir, "crc.mkv");
    writeFileSync(plain, buildFile([false, false]));
    // Only the cluster holding the OFFENDING display set carries a CRC.
    writeFileSync(protectedFile, buildFile([false, true]));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("flags only the blocks inside a CRC-protected cluster", async () => {
    const clean = (await readPgsTracksData(plain, [3])).get(3)!;
    expect(clean.blocks.map((b) => b.clusterHasCrc)).toEqual([false, false]);

    const guarded = (await readPgsTracksData(protectedFile, [3])).get(3)!;
    expect(guarded.blocks.map((b) => b.clusterHasCrc)).toEqual([false, true]);
    // The CRC element must not disturb the absolute offset contract.
    expect(guarded.segments.length).toBe(clean.segments.length);
  });

  it("patches a file whose clusters carry no CRC", async () => {
    const output = join(dir, "plain.fixed.mkv");
    const result = await fixFile(
      plain,
      { aspect: 2.39, output },
      { inspect: async () => info(plain) },
    );
    expect(result.wrote).toBe(true);
    expect(result.totals.eventsMoved).toBe(1);
  });

  it("refuses to patch a block inside a CRC-protected cluster", async () => {
    const output = join(dir, "crc.fixed.mkv");
    await expect(
      fixFile(protectedFile, { aspect: 2.39, output }, { inspect: async () => info(protectedFile) }),
    ).rejects.toMatchObject({ kind: "UNSUPPORTED_MEDIA", exitCode: 4 });
  });
});
