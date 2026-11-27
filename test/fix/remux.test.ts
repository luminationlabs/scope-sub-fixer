import { describe, expect, it } from "vitest";
import { buildRemuxArgs, type SourceTrackRef } from "../../src/fix/remux.js";

/** A typical Blu-ray rip: video, two audio tracks, three PGS subtitle tracks. */
const SOURCE: SourceTrackRef[] = [
  { id: 0, type: "video" },
  { id: 1, type: "audio" },
  { id: 2, type: "audio" },
  { id: 3, type: "subtitles" },
  { id: 4, type: "subtitles" },
  { id: 5, type: "subtitles" },
];

const ENGLISH = {
  sourceTrackId: 4,
  supPath: "/tmp/scope/track-4.fixed.sup",
  language: "eng",
  name: "English",
  default: true,
  forced: false,
  hearingImpaired: false,
};

describe("buildRemuxArgs", () => {
  it("replaces one subtitle track in place", () => {
    expect(
      buildRemuxArgs({
        input: "/movies/in.mkv",
        output: "/movies/out.mkv",
        sourceTracks: SOURCE,
        corrected: [ENGLISH],
        keepOriginal: false,
      }),
    ).toMatchInlineSnapshot(`
      [
        "--output",
        "/movies/out.mkv",
        "--subtitle-tracks",
        "3,5",
        "/movies/in.mkv",
        "--language",
        "0:eng",
        "--track-name",
        "0:English",
        "--default-track-flag",
        "0:1",
        "--forced-display-flag",
        "0:0",
        "--hearing-impaired-flag",
        "0:0",
        "--compression",
        "0:none",
        "/tmp/scope/track-4.fixed.sup",
        "--track-order",
        "0:0,0:1,0:2,0:3,1:0,0:5",
      ]
    `);
  });

  it("appends a [scope-fixed] track and keeps every original (PRD §31)", () => {
    expect(
      buildRemuxArgs({
        input: "/movies/in.mkv",
        output: "/movies/ab.mkv",
        sourceTracks: SOURCE,
        corrected: [ENGLISH],
        keepOriginal: true,
      }),
    ).toMatchInlineSnapshot(`
      [
        "--output",
        "/movies/ab.mkv",
        "/movies/in.mkv",
        "--language",
        "0:eng",
        "--track-name",
        "0:English [scope-fixed]",
        "--default-track-flag",
        "0:0",
        "--forced-display-flag",
        "0:0",
        "--hearing-impaired-flag",
        "0:0",
        "--compression",
        "0:none",
        "/tmp/scope/track-4.fixed.sup",
        "--track-order",
        "0:0,0:1,0:2,0:3,0:4,0:5,1:0",
      ]
    `);
  });

  it("drops all subtitles when every subtitle track is corrected", () => {
    const args = buildRemuxArgs({
      input: "/movies/in.mkv",
      output: "/movies/out.mkv",
      sourceTracks: [
        { id: 0, type: "video" },
        { id: 1, type: "subtitles" },
      ],
      corrected: [{ ...ENGLISH, sourceTrackId: 1 }],
      keepOriginal: false,
    });
    expect(args).toContain("--no-subtitles");
    expect(args).not.toContain("--subtitle-tracks");
    expect(args.at(-1)).toBe("0:0,1:0");
  });

  it("names an unnamed A/B track after its language", () => {
    const args = buildRemuxArgs({
      input: "/movies/in.mkv",
      output: "/movies/ab.mkv",
      sourceTracks: SOURCE,
      corrected: [{ ...ENGLISH, name: undefined }],
      keepOriginal: true,
    });
    expect(args[args.indexOf("--track-name") + 1]).toBe("0:eng [scope-fixed]");
  });

  it("carries forced and hearing-impaired flags onto the corrected track", () => {
    const args = buildRemuxArgs({
      input: "/movies/in.mkv",
      output: "/movies/out.mkv",
      sourceTracks: SOURCE,
      corrected: [{ ...ENGLISH, forced: true, hearingImpaired: true, default: false }],
      keepOriginal: false,
    });
    expect(args[args.indexOf("--forced-display-flag") + 1]).toBe("0:1");
    expect(args[args.indexOf("--hearing-impaired-flag") + 1]).toBe("0:1");
    expect(args[args.indexOf("--default-track-flag") + 1]).toBe("0:0");
  });

  it("keeps two corrected tracks in their original positions", () => {
    const args = buildRemuxArgs({
      input: "/movies/in.mkv",
      output: "/movies/out.mkv",
      sourceTracks: SOURCE,
      corrected: [
        ENGLISH,
        { ...ENGLISH, sourceTrackId: 3, language: "fra", name: "Français", default: false },
      ],
      keepOriginal: false,
    });
    expect(args[args.indexOf("--subtitle-tracks") + 1]).toBe("5");
    expect(args.at(-1)).toBe("0:0,0:1,0:2,2:0,1:0,0:5");
  });

  it("leaves a track mkvmerge does not mux out of --track-order", () => {
    // A button track: mkvmerge will not copy it, and naming it in
    // --track-order makes it refuse the whole command line.
    const args = buildRemuxArgs({
      input: "/movies/in.mkv",
      output: "/movies/out.mkv",
      sourceTracks: [...SOURCE, { id: 6, type: "other" }],
      corrected: [ENGLISH],
      keepOriginal: false,
    });
    const order = args[args.indexOf("--track-order") + 1]!;
    expect(order).toBe("0:0,0:1,0:2,0:3,1:0,0:5");
    expect(order).not.toContain("0:6");
  });
});
