/**
 * The real frame sampler (ffmpeg) against generated video. Skipped when ffmpeg is not
 * installed. Everything happens in a temp directory.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { detectActiveArea } from "../../src/video/activeArea.js";
import {
  hasTool,
  makeLetterboxVideo,
  makeMixedAspectVideo,
  makeTempDir,
  removeDir,
  run,
} from "../helpers/scanFixture.js";

const ffmpeg = await hasTool("ffmpeg");

describe.skipIf(!ffmpeg)("detectActiveArea against real video", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await makeTempDir();
  }, 120000);

  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  it("finds the 2.39:1 bars of a letterboxed 1080p clip", async () => {
    const file = join(dir, "scope.mkv");
    await makeLetterboxVideo(file, { activeHeight: 804, seconds: 6 });
    const area = await detectActiveArea(file, {
      durationMs: 6000,
      frameW: 1920,
      frameH: 1080,
      samples: 10,
    });
    expect(area.classification).toBe("CONSTANT");
    expect(area.top).toBe(138);
    expect(area.bottom).toBe(942);
    expect(area.aspect).toBe(2.39);
    expect(area.samples!.filter((s) => s.used).length).toBeGreaterThanOrEqual(8);
  }, 120000);

  it("finds the bars of a 10-bit clip, whose black is not 8-bit black", async () => {
    const file = join(dir, "scope10.mkv");
    await makeLetterboxVideo(file, { activeHeight: 804, seconds: 6, pixFmt: "yuv420p10le" });
    const area = await detectActiveArea(file, {
      durationMs: 6000,
      frameW: 1920,
      frameH: 1080,
      samples: 10,
    });
    expect(area.classification).toBe("CONSTANT");
    expect(area.top).toBe(138);
    expect(area.bottom).toBe(942);
  }, 120000);

  it("finds no bars on a 1.78:1 clip", async () => {
    const file = join(dir, "flat.mkv");
    await makeLetterboxVideo(file, { activeHeight: 1080, seconds: 6 });
    const area = await detectActiveArea(file, {
      durationMs: 6000,
      frameW: 1920,
      frameH: 1080,
      samples: 10,
    });
    expect(area.classification).toBe("CONSTANT");
    expect(area.top).toBe(0);
    expect(area.bottom).toBe(1080);
    expect(area.aspect).toBe(1.78);
  }, 120000);

  it("judges a title that alternates between scope and full frame by its scope shape", async () => {
    const file = join(dir, "mixed.mkv");
    await makeMixedAspectVideo(
      file,
      { activeHeight: 804, seconds: 4 },
      { activeHeight: 1080, seconds: 2 },
    );
    const area = await detectActiveArea(file, {
      durationMs: 6000,
      frameW: 1920,
      frameH: 1080,
      samples: 12,
    });
    expect(area.classification).toBe("MIXED_NARROWEST");
    expect(area.top).toBe(138);
    expect(area.bottom).toBe(942);
    expect(area.clusters!.length).toBeGreaterThanOrEqual(2);
    // Each cluster reports where it was seen.
    for (const c of area.clusters!) expect(c.timestampsMs.length).toBeGreaterThan(0);
  }, 120000);

  it("finds the bars of a file whose container claims full-range video", async () => {
    // Disc video re-tagged by a remuxing tool: the pixels are limited range,
    // the tag says otherwise. Taken at its word the bars are not black.
    const source = join(dir, "scope.mkv");
    const file = join(dir, "scope-pc.mkv");
    const r = await run("ffmpeg", ["-nostdin", "-y", "-loglevel", "error", "-i", source, "-c", "copy", "-color_range", "pc", file]);
    expect(r.code).toBe(0);
    const area = await detectActiveArea(file, { durationMs: 6000, frameW: 1920, frameH: 1080, samples: 10 });
    expect(area.classification).toBe("CONSTANT");
    expect({ top: area.top, bottom: area.bottom }).toEqual({ top: 138, bottom: 942 });
  }, 120000);

  it("refuses to measure a frame that is not the size the file says, instead of calling it black", async () => {
    const file = join(dir, "scope.mkv");
    await expect(
      detectActiveArea(file, { durationMs: 6000, frameW: 1280, frameH: 720, samples: 4 }),
    ).rejects.toThrow(/could not be sampled: the frame at .* is not 1280x720/);
  }, 120000);

  it("fails, not 'no picture', for a file ffmpeg cannot read", async () => {
    await expect(
      detectActiveArea(join(dir, "missing.mkv"), { durationMs: 6000, frameW: 1920, frameH: 1080, samples: 4 }),
    ).rejects.toThrow(/could not be sampled: ffmpeg gave no frame/);
  }, 120000);
});
