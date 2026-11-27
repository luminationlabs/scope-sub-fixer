import { describe, expect, it } from "vitest";
import { describeTrack, parseContainerFacts } from "../../src/verify/container.js";

const JSON_SAMPLE = {
  container: { properties: { duration: 7_200_000_000_000, title: "Ocean's Thirteen" } },
  chapters: [{ num_entries: 24 }],
  attachments: [
    { id: 1, file_name: "cover.jpg", size: 1234, content_type: "image/jpeg" },
  ],
  global_tags: [{ num_entries: 3 }],
  track_tags: [{ track_id: 0, num_entries: 2 }],
  tracks: [
    {
      id: 0,
      type: "video",
      properties: { number: 1, codec_id: "V_MPEGH/ISO/HEVC", language: "und" },
    },
    {
      id: 1,
      type: "audio",
      properties: { number: 2, codec_id: "A_TRUEHD", language: "eng", default_track: true },
    },
    {
      id: 2,
      type: "subtitles",
      properties: {
        number: 3,
        codec_id: "S_HDMV/PGS",
        language: "eng",
        track_name: "English",
        forced_track: true,
        flag_hearing_impaired: true,
      },
    },
  ],
};

describe("parseContainerFacts", () => {
  it("reads duration, title, chapters, attachments and tags", () => {
    const facts = parseContainerFacts("/movies/x.mkv", JSON_SAMPLE);
    expect(facts.durationNs).toBe(7_200_000_000_000);
    expect(facts.title).toBe("Ocean's Thirteen");
    expect(facts.chapterEditions).toEqual([24]);
    expect(facts.attachments).toEqual([
      {
        id: 1,
        fileName: "cover.jpg",
        size: 1234,
        contentType: "image/jpeg",
        description: undefined,
      },
    ]);
    expect(facts.globalTagCount).toBe(3);
    expect(facts.trackTagCounts).toEqual([{ trackId: 0, entries: 2 }]);
  });

  it("reads every track's identity and flags", () => {
    const facts = parseContainerFacts("/movies/x.mkv", JSON_SAMPLE);
    expect(facts.tracks.map((t) => t.type)).toEqual(["video", "audio", "subtitles"]);
    const subs = facts.tracks[2]!;
    expect(subs).toMatchObject({
      id: 2,
      number: 3,
      codecId: "S_HDMV/PGS",
      language: "eng",
      name: "English",
      default: false,
      forced: true,
      hearingImpaired: true,
      enabled: true,
    });
  });

  it("survives an empty or unrecognized document", () => {
    const facts = parseContainerFacts("/movies/x.mkv", {});
    expect(facts.tracks).toEqual([]);
    expect(facts.attachments).toEqual([]);
    expect(facts.durationNs).toBeUndefined();
  });

  it("describes a track compactly", () => {
    const facts = parseContainerFacts("/movies/x.mkv", JSON_SAMPLE);
    expect(describeTrack(facts.tracks[2]!)).toBe(
      '#2 subtitles S_HDMV/PGS eng "English" [forced+hearing-impaired]',
    );
  });
});
