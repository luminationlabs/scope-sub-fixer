/**
 * End-to-end `fix` and `verify` against real MKVs built with ffmpeg +
 * mkvmerge. Skipped when the tools are missing.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixError, fixFile } from "../../src/fix/fixFile.js";
import { SCOPE_FIXED_SUFFIX } from "../../src/fix/remux.js";
import { scanFile } from "../../src/scan/scanFile.js";
import { verifyFile } from "../../src/verify/verifyFile.js";
import { readContainerFacts } from "../../src/verify/container.js";
import { diffFiles } from "../../src/verify/streams.js";
import { analyzeFile } from "../../src/scan/analyze.js";
import { positionFields } from "../../src/fix/patchPlan.js";
import { BLOCK_HEADER_SIZE } from "../../src/pgs/patch.js";
import type { SupSpec } from "../../src/pgs/fixtures.js";
import {
  hasTool,
  makeLetterboxVideo,
  makeMkv,
  makeTempDir,
  removeDir,
  writeSup,
} from "../helpers/scanFixture.js";

const tools =
  (await hasTool("ffmpeg")) && (await hasTool("mkvmerge")) && (await hasTool("mkvextract"));

/**
 * The 2.39:1 active area of a 1920x1080 frame is y=138..941.
 *   0  inside the picture — must not move
 *   1  straddling the bottom edge
 *   2  entirely in the bottom bar
 *   3  entirely in the top bar
 */
const SPEC: SupSpec = {
  width: 1920,
  height: 1080,
  events: [
    { ptsMs: 1000, endPtsMs: 1800, objects: [{ x: 860, y: 700, width: 200, height: 60 }] },
    { ptsMs: 2000, endPtsMs: 2800, objects: [{ x: 860, y: 900, width: 200, height: 100 }] },
    { ptsMs: 3000, endPtsMs: 3800, objects: [{ x: 860, y: 980, width: 200, height: 60 }] },
    { ptsMs: 4000, endPtsMs: 4800, objects: [{ x: 860, y: 20, width: 200, height: 60 }] },
  ],
};

const ASPECT = 2.39;

describe.skipIf(!tools)("fix and verify end to end", () => {
  let dir: string;
  let scopeMkv: string;
  let zlibMkv: string;

  beforeAll(async () => {
    dir = await makeTempDir();
    const sup = await writeSup(join(dir, "sub.sup"), SPEC);
    const video = await makeLetterboxVideo(join(dir, "video.mkv"), {
      activeHeight: 804,
      seconds: 8,
    });
    scopeMkv = await makeMkv(join(dir, "scope.mkv"), video, sup, {
      trackName: "English",
      forced: false,
      globalArgs: ["--title", "Scope Fixture"],
    });
    zlibMkv = await makeMkv(join(dir, "scope-zlib.mkv"), video, sup, {
      compression: "zlib",
      trackName: "English",
    });
  }, 180000);

  afterAll(async () => {
    if (dir) await removeDir(dir);
  });

  it("patches in place, leaving a byte copy apart from the position fields", async () => {
    const output = join(dir, "patched.mkv");
    const result = await fixFile(scopeMkv, { aspect: ASPECT, output });

    expect(result.wrote).toBe(true);
    expect(result.method).toBe("patch");
    expect(result.totals.tracksFixed).toBe(1);
    // Three of four events are outside; the fourth stays put.
    expect(result.totals.eventsMoved).toBe(3);
    expect(result.outputBytes).toBe(result.inputBytes);

    // The output differs from the input only inside PGS position fields.
    const diff = await diffFiles(scopeMkv, output);
    expect(diff.truncated).toBe(false);
    const fixedAnalysis = await analyzeFile(output, { aspect: ASPECT });
    const fields = positionFields(fixedAnalysis.tracks[0]!.segments, BLOCK_HEADER_SIZE);
    for (const range of diff.ranges) {
      const inside = fields.some(
        (f) => range.start >= f.offset && range.end <= f.offset + f.length,
      );
      expect(inside, `bytes ${range.start}..${range.end} are outside every position field`).toBe(
        true,
      );
    }
    // Every moved display set rewrites one PCS object field and one WDS field.
    expect(diff.ranges.length).toBeGreaterThanOrEqual(6);

    // Re-scanning the output finds nothing left to fix.
    const rescan = await scanFile(output, { aspect: ASPECT });
    expect(rescan.status).toBe("OK");
    expect(rescan.tracks[0]!.offendingEventCount).toBe(0);
    expect(rescan.tracks[0]!.eventCount).toBe(4);

    const report = await verifyFile(scopeMkv, output, { aspect: ASPECT });
    const failed = report.checks.filter((c) => !c.pass);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.payloadMode).toBe("byte-identical");
    expect(report.pgsTracks[0]!.changedEventCount).toBe(3);
    expect(report.pgsTracks[0]!.stillOutsideCount).toBe(0);
  }, 180000);

  it("writes nothing on a dry run", async () => {
    const output = join(dir, "never-written.mkv");
    const result = await fixFile(scopeMkv, { aspect: ASPECT, output, dryRun: true });
    expect(result.wrote).toBe(false);
    expect(result.totals.eventsMoved).toBe(3);
    await expect(stat(output)).rejects.toThrow();
  }, 60000);

  it("remuxes the corrected track back into its original position", async () => {
    const output = join(dir, "remuxed.mkv");
    const result = await fixFile(scopeMkv, {
      aspect: ASPECT,
      output,
      method: "remux",
    });
    expect(result.wrote).toBe(true);
    expect(result.totals.eventsMoved).toBe(3);

    const before = await readContainerFacts(scopeMkv);
    const after = await readContainerFacts(output);
    expect(after.tracks.map((t) => t.type)).toEqual(before.tracks.map((t) => t.type));
    const sub = after.tracks.find((t) => t.type === "subtitles")!;
    const originalSub = before.tracks.find((t) => t.type === "subtitles")!;
    expect(sub.language).toBe(originalSub.language);
    expect(sub.name).toBe(originalSub.name);
    expect(sub.default).toBe(originalSub.default);
    expect(sub.forced).toBe(originalSub.forced);
    expect(after.title).toBe(before.title);

    const report = await verifyFile(scopeMkv, output, {
      aspect: ASPECT,
      hashStreams: true,
    });
    const failed = report.checks.filter((c) => !c.pass);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.payloadMode).toBe("stream-hashes");
    // Video hashes match; the corrected subtitle track was excluded from them.
    expect(report.streamHashes.fixed.length).toBeGreaterThan(0);
    expect(report.pgsTracks[0]!.changedEventCount).toBe(3);
  }, 180000);

  it("appends a [scope-fixed] track with --keep-original-subtitle", async () => {
    const output = join(dir, "ab.mkv");
    await fixFile(scopeMkv, {
      aspect: ASPECT,
      output,
      method: "remux",
      keepOriginalSubtitle: true,
    });

    const after = await readContainerFacts(output);
    const subs = after.tracks.filter((t) => t.type === "subtitles");
    expect(subs).toHaveLength(2);
    expect(subs[0]!.name).toBe("English");
    expect(subs[0]!.default).toBe(true);
    expect(subs[1]!.name).toBe(`English ${SCOPE_FIXED_SUFFIX}`);
    expect(subs[1]!.default).toBe(false);
    expect(subs[1]!.language).toBe("eng");

    const report = await verifyFile(scopeMkv, output, {
      aspect: ASPECT,
      hashStreams: true,
      expectTracks: [subs[1]!.id],
    });
    const failed = report.checks.filter((c) => !c.pass);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(report.pass).toBe(true);
    // The original track is untouched, the appended one carries every move.
    const original = report.pgsTracks.find((t) => !t.appended)!;
    const appended = report.pgsTracks.find((t) => t.appended)!;
    expect(original.changedEventCount).toBe(0);
    expect(appended.changedEventCount).toBe(3);
  }, 180000);

  it("refuses to patch a zlib-compressed track but remuxes it happily", async () => {
    const patchOut = join(dir, "zlib-patched.mkv");
    await expect(fixFile(zlibMkv, { aspect: ASPECT, output: patchOut })).rejects.toMatchObject({
      kind: "UNSUPPORTED_MEDIA",
      exitCode: 4,
    });
    await expect(stat(patchOut)).rejects.toThrow();

    const remuxOut = join(dir, "zlib-remuxed.mkv");
    const result = await fixFile(zlibMkv, {
      aspect: ASPECT,
      output: remuxOut,
      method: "remux",
    });
    expect(result.wrote).toBe(true);
    expect(result.totals.eventsMoved).toBe(3);
    const rescan = await scanFile(remuxOut, { aspect: ASPECT });
    expect(rescan.tracks[0]!.offendingEventCount).toBe(0);
  }, 180000);

  it("refuses to overwrite an existing output and never touches the input", async () => {
    const before = await readFile(scopeMkv);
    const output = join(dir, "patched.mkv");
    await expect(fixFile(scopeMkv, { aspect: ASPECT, output })).rejects.toBeInstanceOf(FixError);
    expect(Buffer.compare(before, await readFile(scopeMkv))).toBe(0);
  }, 60000);
});
