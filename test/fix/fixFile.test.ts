import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixError, fixFile, type FixOptions } from "../../src/fix/fixFile.js";
import type { MkvInfo, MkvSubtitleTrack } from "../../src/mkv/inspect.js";
import { buildSup, type SupSpec } from "../../src/pgs/fixtures.js";
import { parseSupSegments } from "../../src/pgs/parse.js";

let dir: string;
let input: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "scope-sub-fix-unit-"));
  input = join(dir, "in.mkv");
  // The bytes never matter: every reader is injected.
  await writeFile(input, Buffer.alloc(1024));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

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
    file: input,
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
    tracks: [
      { id: 0, number: 1, type: "video", codecId: "V_MPEG4/ISO/AVC" },
      { id: 1, number: 2, type: "subtitles", codecId: "S_HDMV/PGS" },
    ],
  };
}

/** One event in the bottom bar, so a fix is always planned. */
const OFFENDING: SupSpec = {
  width: 1920,
  height: 1080,
  events: [
    { ptsMs: 1000, endPtsMs: 3000, objects: [{ x: 860, y: 900, width: 200, height: 100 }] },
  ],
};

const SAFE: SupSpec = {
  width: 1920,
  height: 1080,
  events: [
    { ptsMs: 1000, endPtsMs: 3000, objects: [{ x: 860, y: 700, width: 200, height: 60 }] },
  ],
};

function deps(spec: SupSpec) {
  return {
    inspect: async () => info(),
    pgsSource: async () => parseSupSegments(buildSup(spec)),
  };
}

function options(over: Partial<FixOptions> = {}): FixOptions {
  return { aspect: 2.39, output: join(dir, "out.mkv"), ...over };
}

async function expectFixError(
  promise: Promise<unknown>,
): Promise<FixError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(FixError);
    return err as FixError;
  }
  throw new Error("expected a FixError");
}

describe("fixFile refusals", () => {
  it("refuses to write the output over the input", async () => {
    const err = await expectFixError(
      fixFile(input, options({ output: input }), deps(OFFENDING)),
    );
    expect(err.kind).toBe("OUTPUT_CONFLICT");
    expect(err.exitCode).toBe(8);
  });

  it("refuses an existing output without --overwrite-output", async () => {
    const output = join(dir, "existing.mkv");
    await writeFile(output, "x");
    const err = await expectFixError(fixFile(input, options({ output }), deps(OFFENDING)));
    expect(err.kind).toBe("OUTPUT_CONFLICT");
    expect(err.exitCode).toBe(8);
    expect(err.detail).toContain("--overwrite-output");
  });

  it("allows an existing output with --overwrite-output (dry run writes nothing)", async () => {
    const output = join(dir, "existing2.mkv");
    await writeFile(output, "x");
    const result = await fixFile(
      input,
      options({ output, overwriteOutput: true, dryRun: true, method: "remux" }),
      deps(OFFENDING),
    );
    expect(result.wrote).toBe(false);
  });

  it("refuses a missing input", async () => {
    const err = await expectFixError(
      fixFile(join(dir, "nope.mkv"), options(), deps(OFFENDING)),
    );
    expect(err.kind).toBe("BAD_ARGS");
    expect(err.exitCode).toBe(2);
  });

  it("refuses to patch a track read without the direct block reader", async () => {
    // An injected `pgsSource` yields segments whose offsets are not file
    // offsets; the patch method must notice rather than corrupt the copy.
    const err = await expectFixError(fixFile(input, options(), deps(OFFENDING)));
    expect(err.kind).toBe("UNSUPPORTED_MEDIA");
    expect(err.exitCode).toBe(4);
    expect(err.message).toContain("direct block reader");
  });

  it("reports nothing to do when no event needs moving", async () => {
    const result = await fixFile(input, options(), deps(SAFE));
    expect(result.wrote).toBe(false);
    expect(result.totals.tracksFixed).toBe(0);
    expect(result.notes.join(" ")).toContain("no PGS events need moving");
  });

  it("counts the planned moves in a remux dry run without touching the disk", async () => {
    const result = await fixFile(
      input,
      options({ method: "remux", dryRun: true }),
      deps(OFFENDING),
    );
    expect(result.wrote).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.totals.tracksFixed).toBe(1);
    expect(result.totals.eventsMoved).toBe(1);
    expect(result.totals.displaySetsPatched).toBe(1);
    expect(result.outputBytes).toBeUndefined();
  });

  it("refuses a --temp-dir inside the source directory (PRD §12.5)", async () => {
    const err = await expectFixError(
      fixFile(input, options({ method: "remux", tempDir: dir }), deps(OFFENDING)),
    );
    expect(err.kind).toBe("BAD_ARGS");
    expect(err.message).toContain("inside the source directory");
  });

  it("only analyzes the tracks named by --track", async () => {
    const twoTracks: MkvInfo = {
      ...info(),
      subtitleTracks: [pgsTrack({ id: 1, number: 2 }), pgsTrack({ id: 2, number: 3 })],
    };
    const result = await fixFile(
      input,
      options({ trackIds: [2], method: "remux", dryRun: true }),
      { inspect: async () => twoTracks, pgsSource: async () => parseSupSegments(buildSup(OFFENDING)) },
    );
    expect(result.tracks.map((t) => t.trackId)).toEqual([2]);
  });
});
