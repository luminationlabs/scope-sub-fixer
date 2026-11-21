import { describe, expect, it } from "vitest";
import {
  DependencyMissingError,
  parseDimensions,
  parseMkvmergeJson,
  SpawnAbortedError,
  spawnCapture,
  inspectMkv,
  PGS_CODEC_ID,
} from "../../src/mkv/inspect.js";

/** Shape of a real `mkvmerge -J` payload, trimmed to what we read. */
const SAMPLE = {
  container: {
    properties: { duration: 7_260_000_000_000, title: "Some Movie" },
    recognized: true,
    supported: true,
    type: "Matroska",
  },
  tracks: [
    {
      id: 0,
      type: "video",
      properties: {
        codec_id: "V_MPEG4/ISO/AVC",
        number: 1,
        pixel_dimensions: "3840x2160",
        display_dimensions: "3840x2160",
      },
    },
    {
      id: 1,
      type: "audio",
      properties: { codec_id: "A_DTS", number: 2 },
    },
    {
      id: 4,
      type: "subtitles",
      properties: {
        codec_id: "S_HDMV/PGS",
        number: 5,
        language: "eng",
        track_name: "English",
        default_track: true,
        forced_track: false,
      },
    },
    {
      id: 5,
      type: "subtitles",
      properties: {
        codec_id: "S_HDMV/PGS",
        number: 6,
        language_ietf: "fr",
        forced_track: true,
        flag_hearing_impaired: true,
      },
    },
    {
      id: 6,
      type: "subtitles",
      properties: { codec_id: "S_TEXT/UTF8", number: 7, language: "eng" },
    },
  ],
};

describe("parseDimensions", () => {
  it("parses WxH", () => {
    expect(parseDimensions("1920x1080")).toEqual({ width: 1920, height: 1080 });
    expect(parseDimensions("bad")).toBeUndefined();
    expect(parseDimensions(undefined)).toBeUndefined();
  });
});

describe("parseMkvmergeJson", () => {
  const info = parseMkvmergeJson("/movies/x.mkv", SAMPLE);

  it("reads container duration and title", () => {
    expect(info.durationMs).toBe(7_260_000);
    expect(info.title).toBe("Some Movie");
  });

  it("reads the video track, keeping both identifiers", () => {
    expect(info.video).toEqual({
      id: 0,
      number: 1,
      codecId: "V_MPEG4/ISO/AVC",
      width: 3840,
      height: 2160,
      displayWidth: 3840,
      displayHeight: 2160,
    });
  });

  it("reads every subtitle track and flags the PGS ones", () => {
    expect(info.subtitleTracks).toHaveLength(3);
    expect(info.subtitleTracks.map((t) => t.isPgs)).toEqual([true, true, false]);
    expect(info.subtitleTracks[0]).toEqual({
      id: 4,
      number: 5,
      codecId: PGS_CODEC_ID,
      language: "eng",
      name: "English",
      default: true,
      forced: false,
      hearingImpaired: false,
      isPgs: true,
    });
  });

  it("falls back to language_ietf and reads the flags", () => {
    const fr = info.subtitleTracks[1]!;
    expect(fr.language).toBe("fr");
    expect(fr.forced).toBe(true);
    expect(fr.hearingImpaired).toBe(true);
    expect(fr.name).toBeUndefined();
  });

  it("survives missing properties", () => {
    const bare = parseMkvmergeJson("/x.mkv", { tracks: [{ id: 0, type: "video" }] });
    expect(bare.video).toMatchObject({ id: 0, number: 1, width: 0, height: 0 });
    expect(bare.durationMs).toBeUndefined();
  });
});

describe("spawnCapture", () => {
  it("reports a missing executable as DependencyMissingError", async () => {
    await expect(spawnCapture("definitely-not-a-real-binary-xyz", [])).rejects.toBeInstanceOf(
      DependencyMissingError,
    );
  });

  it("terminates the child when its signal is aborted", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const running = spawnCapture("node", ["-e", "setTimeout(() => {}, 60000)"], {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await expect(running).rejects.toBeInstanceOf(SpawnAbortedError);
    expect(Date.now() - started).toBeLessThan(10000);

    await expect(
      spawnCapture("node", ["-e", "1"], { signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(SpawnAbortedError);
  });

  it("captures stdout and the exit code", async () => {
    const r = await spawnCapture("node", ["-e", "console.log('hi'); process.exit(3)"]);
    expect(r.stdout.trim()).toBe("hi");
    expect(r.code).toBe(3);
  });
});

describe("inspectMkv", () => {
  it("surfaces a missing mkvmerge as DependencyMissingError", async () => {
    await expect(
      inspectMkv("/nope.mkv", { mkvmergePath: "definitely-not-a-real-binary-xyz" }),
    ).rejects.toBeInstanceOf(DependencyMissingError);
  });
});
