/**
 * Build a small pretend movie library for trying the app: ten tiny MKVs, made
 * with the test suite's own fixture helpers (synthetic video and subtitles; no
 * real disc material), covering every verdict the app shows.
 *
 *   bun scripts/make-fixtures.ts <dir> [seconds of video per title]
 *
 * Writes <dir>/Movies/<Title>/<Title>.mkv and prints that folder. Needs ffmpeg
 * and mkvmerge. The files are a few KB each, so everything is instant; set
 * `SHOWCASE=1` for the titles the screenshots use, and
 * `BIG=1` to give the scope titles a lossless film-grain picture instead
 * (about 70 MB per second of video), which makes the scan and the copy slow
 * enough to watch. Run with bun because it runs the TypeScript helpers as they are.
 */
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeLetterboxVideo, makeMkv, writeSup } from "../../test/helpers/scanFixture.ts";
import { SCOPE_SPEC, SAFE_SPEC } from "../../test/batch/support.ts";
const root = process.argv[2];
if (!root) {
  console.error("usage: bun scripts/make-fixtures.ts <dir> [seconds of video per title]");
  process.exit(2);
}
const seconds = Number(process.argv[3] ?? "8");
const lib = join(root, "Movies");
await mkdir(lib, { recursive: true });
const big = (process.env["BIG"] ?? "") !== "";
let scopeVideo: string;
if (big) {
  // Noise does not compress, so a lossless encode of it is as large as video gets.
  scopeVideo = join(root, "scope-video.mkv");
  execFileSync("ffmpeg", [
    "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi",
    "-i", `color=c=0x808080:s=1920x804:d=${seconds}:r=24,noise=alls=100:allf=t+u`,
    "-vf", "pad=1920:1080:0:138", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0",
    "-pix_fmt", "yuv420p", scopeVideo,
  ]);
} else {
  scopeVideo = await makeLetterboxVideo(join(root, "scope-video.mkv"), { activeHeight: 804, seconds });
}
const flatVideo = await makeLetterboxVideo(join(root, "flat-video.mkv"), { activeHeight: 1080, seconds });
const scopeSup = await writeSup(join(root, "scope.sup"), SCOPE_SPEC);
const safeSup = await writeSup(join(root, "safe.sup"), SAFE_SPEC);
// SHOWCASE=1: the titles the screenshots use instead. Real films, each given
// a verdict typical of its Blu-ray; the files are as synthetic as ever.
const showcase: [string, string, string | null, object][] = [
  ["1917 (2019)", scopeVideo, safeSup, {}],
  ["Edge of Tomorrow (2014)", scopeVideo, scopeSup, {}],
  ["Galaxy Quest (1999)", scopeVideo, safeSup, {}],
  ["Ghostbusters (1984)", scopeVideo, scopeSup, {}],
  ["Guardians of the Galaxy (2014)", scopeVideo, scopeSup, {}],
  ["Harry Potter and the Philosopher's Stone (2001)", scopeVideo, scopeSup, {}],
  ["La La Land (2016)", scopeVideo, scopeSup, {}],
  ["Ocean's Eleven (2001)", scopeVideo, scopeSup, {}],
  ["The Hunt for Red October (1990)", scopeVideo, safeSup, {}],
  ["The Incredibles (2004)", scopeVideo, scopeSup, {}],
];
const everyVerdict: [string, string, string | null, object][] = [
  ["Blade Runner 2049 (2017)", scopeVideo, scopeSup, {}],
  ["Dune (2021)", scopeVideo, scopeSup, {}],
  ["Heat (1995)", scopeVideo, safeSup, {}],
  ["Lawrence of Arabia (1962)", scopeVideo, scopeSup, {}],
  ["Mad Max Fury Road (2015)", scopeVideo, scopeSup, { compression: "zlib" }],
  ["Paddington 2 (2017)", flatVideo, safeSup, {}],
  ["Sicario (2015)", scopeVideo, scopeSup, {}],
  ["The Apartment (1960)", scopeVideo, null, {}],
  ["The Grand Budapest Hotel (2014)", flatVideo, scopeSup, {}],
  ["The Revenant (2015)", scopeVideo, safeSup, {}],
];
const titles = (process.env["SHOWCASE"] ?? "") !== "" ? showcase : everyVerdict;
for (const [name, video, sup, opts] of titles) {
  await mkdir(join(lib, name), { recursive: true });
  await makeMkv(join(lib, name, `${name}.mkv`), video, sup, opts);
}
console.log(lib);
