import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DependencyMissingError,
  MkvExtractError,
  createMkvextractSource,
  extractPgsTrack,
  extractPgsTrackWithMkvextract,
} from "../../src/mkv/extract.js";
import { SEGMENT_TYPE } from "../../src/pgs/types.js";
import type { SupSpec } from "../../src/pgs/fixtures.js";
import {
  hasTool,
  makeLetterboxVideo,
  makeMkv,
  makeTempDir,
  removeDir,
  writeSup,
} from "../helpers/scanFixture.js";

const SPEC: SupSpec = {
  width: 1920,
  height: 1080,
  events: [
    { ptsMs: 1000, endPtsMs: 2000, objects: [{ x: 860, y: 900, width: 200, height: 100 }] },
  ],
};

describe("extract errors", () => {
  it("reports a missing mkvextract as DependencyMissingError", async () => {
    await expect(
      extractPgsTrack("/nope.mkv", { id: 1, number: 2 }, {
        mkvextractPath: "definitely-not-a-real-binary-xyz",
      }),
    ).rejects.toBeInstanceOf(DependencyMissingError);
  });

  it("exports a ready-made source function", () => {
    expect(typeof extractPgsTrackWithMkvextract).toBe("function");
  });
});

const tools = (await hasTool("ffmpeg")) && (await hasTool("mkvmerge")) && (await hasTool("mkvextract"));

describe.skipIf(!tools)("extractPgsTrack against a real MKV", () => {
  let dir: string;
  let mkv: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    const video = await makeLetterboxVideo(join(dir, "v.mkv"), { seconds: 3 });
    const sup = await writeSup(join(dir, "s.sup"), SPEC);
    mkv = await makeMkv(join(dir, "out.mkv"), video, sup);
  }, 180000);

  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  it("returns parsed segments and removes the temp file", async () => {
    const scratch = join(dir, "scratch");
    const segments = await extractPgsTrack(mkv, { id: 1, number: 2 }, { tempDir: scratch });
    expect(segments.filter((s) => s.type === SEGMENT_TYPE.PCS).length).toBe(2);
    expect(await readdir(scratch)).toEqual([]);
  }, 120000);

  it("keeps the temp file with keepTemp", async () => {
    const scratch = join(dir, "kept");
    const seen: string[] = [];
    const source = createMkvextractSource({
      tempDir: scratch,
      keepTemp: true,
      onTempFile: (p) => seen.push(p),
    });
    await source(mkv, { id: 1, number: 2 });
    expect(seen).toHaveLength(1);
    expect((await readdir(scratch)).length).toBe(1);
  }, 120000);

  it("fails with MkvExtractError for a track that is not there", async () => {
    await expect(
      extractPgsTrack(mkv, { id: 99, number: 99 }, { tempDir: join(dir, "bad") }),
    ).rejects.toBeInstanceOf(MkvExtractError);
  }, 120000);
});
