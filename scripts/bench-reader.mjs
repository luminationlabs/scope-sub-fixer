#!/usr/bin/env node
/**
 * Repeatable measurement of the direct MKV PGS reader.
 *
 * Walks a real MKV with each requested read strategy and prints wall time,
 * bytes transferred and read() count, so a default can be chosen with numbers
 * instead of intuition.
 *
 *   pnpm build
 *   node scripts/bench-reader.mjs "<file.mkv>" [options]
 *
 * Options:
 *   --strategies a,b,c   default: minimal,adaptive,balanced,sequential
 *   --tracks 3,4         Matroska track numbers; default: every PGS track
 *   --first N            use only the first N PGS tracks
 *   --mode single|per-track|both   default: single (one pass for all tracks)
 *   --repeat N           runs per strategy (default 1); the last run is warm
 *   --timeout SEC        abort a run that exceeds this (default 480)
 *   --json               also dump the raw rows as JSON
 *
 * Reads are read-only; nothing is written to the media file.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

const { readPgsTracksData } = await import(
  new URL("../dist/mkv/pgsBlocks.js", import.meta.url)
);
const { READ_STRATEGIES } = await import(
  new URL("../dist/mkv/ebml.js", import.meta.url)
);

function parseArgs(argv) {
  const out = {
    file: undefined,
    strategies: ["minimal", "adaptive", "balanced", "sequential"],
    tracks: undefined,
    first: undefined,
    mode: "single",
    repeat: 1,
    timeout: 480,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--strategies") out.strategies = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--tracks") out.tracks = argv[++i].split(",").map((s) => Number(s.trim()));
    else if (a === "--first") out.first = Number(argv[++i]);
    else if (a === "--mode") out.mode = argv[++i];
    else if (a === "--repeat") out.repeat = Number(argv[++i]);
    else if (a === "--timeout") out.timeout = Number(argv[++i]);
    else if (a === "--json") out.json = true;
    else if (!a.startsWith("--")) out.file = a;
    else throw new Error(`unknown option ${a}`);
  }
  if (!out.file) throw new Error("usage: bench-reader.mjs <file.mkv> [options]");
  return out;
}

function pgsTracks(file) {
  const json = execFileSync("mkvmerge", ["-J", file], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).toString("utf8");
  return JSON.parse(json)
    .tracks.filter((t) => t.properties.codec_id === "S_HDMV/PGS")
    .map((t) => ({ id: t.id, number: t.properties.number, language: t.properties.language }));
}

const MB = 1024 * 1024;
const fmtBytes = (n) => `${(n / MB).toFixed(1)} MB`;
const fmtSecs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const fmtCount = (n) => n.toLocaleString("en-US");

class Timeout extends Error {
  constructor(message, progress) {
    super(message);
    this.progress = progress;
  }
}

/**
 * Abort a walk that is clearly going to blow the budget, recording how far it
 * got so the full cost can be extrapolated instead of waited out.
 */
function guard(startedAt, timeoutMs) {
  return (p) => {
    if (performance.now() - startedAt > timeoutMs) {
      const elapsed = performance.now() - startedAt;
      throw new Timeout(`aborted after ${fmtSecs(elapsed)}`, { ...p, elapsed });
    }
  };
}

async function runOnce({ file, strategy, tracks, mode, timeoutMs }) {
  const started = performance.now();
  const check = guard(started, timeoutMs);
  const options = { strategy, onProgress: check };
  let stats;
  let blocks = 0;
  let segments = 0;
  if (mode === "single") {
    const data = await readPgsTracksData(file, tracks.map((t) => t.number), options);
    for (const entry of data.values()) {
      blocks += entry.blocks.length;
      segments += entry.segments.length;
      stats = entry.stats;
    }
  } else {
    let bytesRead = 0;
    let readCalls = 0;
    let seeks = 0;
    let bytesSkipped = 0;
    let fileSize = 0;
    for (const track of tracks) {
      const entry = (await readPgsTracksData(file, [track.number], options)).get(
        track.number,
      );
      blocks += entry.blocks.length;
      segments += entry.segments.length;
      bytesRead += entry.stats.bytesRead;
      readCalls += entry.stats.readCalls;
      seeks += entry.stats.seeks;
      bytesSkipped += entry.stats.bytesSkipped;
      fileSize = entry.stats.fileSize;
    }
    stats = {
      fileSize,
      bytesRead,
      readCalls,
      seeks,
      bytesSkipped,
      readRatio: fileSize ? bytesRead / fileSize : 0,
      strategy,
    };
  }
  return { ms: performance.now() - started, stats, blocks, segments };
}

const args = parseArgs(process.argv.slice(2));
const size = statSync(args.file).size;
let tracks = pgsTracks(args.file);
if (args.tracks) tracks = tracks.filter((t) => args.tracks.includes(t.number));
if (args.first) tracks = tracks.slice(0, args.first);
if (tracks.length === 0) throw new Error("no PGS tracks selected");

console.log(`file      ${args.file}`);
console.log(`size      ${fmtBytes(size)} (${fmtCount(size)} bytes)`);
console.log(`tracks    ${tracks.length} PGS: ${tracks.map((t) => t.number).join(", ")}`);
console.log(`mode      ${args.mode}   timeout ${args.timeout}s   repeat ${args.repeat}`);
console.log("");

const header = [
  "strategy".padEnd(12),
  "mode".padEnd(10),
  "wall".padStart(8),
  "bytesRead".padStart(12),
  "ratio".padStart(7),
  "readCalls".padStart(11),
  "seeks".padStart(11),
  "blocks".padStart(8),
].join(" ");
console.log(header);
console.log("-".repeat(header.length));

const rows = [];
const modes = args.mode === "both" ? ["single", "per-track"] : [args.mode];
for (const mode of modes) {
  for (const name of args.strategies) {
    if (!(name in READ_STRATEGIES)) throw new Error(`unknown strategy ${name}`);
    for (let run = 0; run < args.repeat; run++) {
      let row;
      try {
        const r = await runOnce({
          file: args.file,
          strategy: name,
          tracks,
          mode,
          timeoutMs: args.timeout * 1000,
        });
        row = {
          strategy: name,
          mode,
          run,
          ms: r.ms,
          ...r.stats,
          blocks: r.blocks,
          segments: r.segments,
        };
      } catch (err) {
        if (!(err instanceof Timeout)) throw err;
        const p = err.progress ?? {};
        const done = p.fileSize ? p.position / p.fileSize : 0;
        row = {
          strategy: name,
          mode,
          run,
          aborted: err.message,
          reachedPercent: done * 100,
          elapsedMs: p.elapsed,
          projectedMs: done > 0 ? p.elapsed / done : undefined,
          ...(p.stats ?? {}),
        };
      }
      rows.push(row);
      console.log(
        row.aborted
          ? [
              name.padEnd(12),
              mode.padEnd(10),
              "ABORT".padStart(8),
              fmtBytes(row.bytesRead ?? 0).padStart(12),
              `${((row.readRatio ?? 0) * 100).toFixed(1)}%`.padStart(7),
              fmtCount(row.readCalls ?? 0).padStart(11),
              fmtCount(row.seeks ?? 0).padStart(11),
              fmtCount(row.blocks ?? 0).padStart(8),
              ` | reached ${row.reachedPercent.toFixed(1)}% in ${fmtSecs(row.elapsedMs)}` +
                (row.projectedMs ? ` -> full run ~${fmtSecs(row.projectedMs)}` : ""),
            ].join(" ")
          : [
              name.padEnd(12),
              mode.padEnd(10),
              fmtSecs(row.ms).padStart(8),
              fmtBytes(row.bytesRead).padStart(12),
              `${(row.readRatio * 100).toFixed(1)}%`.padStart(7),
              fmtCount(row.readCalls).padStart(11),
              fmtCount(row.seeks).padStart(11),
              fmtCount(row.blocks).padStart(8),
            ].join(" "),
      );
    }
  }
}

if (args.json) console.log("\n" + JSON.stringify(rows, null, 2));
