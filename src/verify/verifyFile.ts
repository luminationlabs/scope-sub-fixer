/**
 * `scope-sub verify` — prove that a repaired MKV differs from its original in
 * exactly the intended way and in no other (PRD §15).
 *
 * Both files go through the same analyzer the scanner and fixer use, so the
 * PGS comparison is apples to apples, and the payload comparison picks the
 * cheapest sound method available: a byte diff when the repair was an in-place
 * patch, elementary-stream hashes when it was a remux.
 */
import { isUsableArea } from "../video/activeArea.js";
import { rm, stat } from "node:fs/promises";
import { analyzeFile, type FileAnalysis, type TrackAnalysis } from "../scan/analyze.js";
import { silentLogger, type Logger } from "../scan/log.js";
import { positionFields, type PositionField } from "../fix/patchPlan.js";
import { BLOCK_HEADER_SIZE } from "../pgs/patch.js";
import { SCOPE_FIXED_SUFFIX, makeTempDir } from "../fix/remux.js";
import {
  describeTrack,
  readContainerFacts,
  type ContainerFacts,
  type ContainerTrack,
} from "./container.js";
import { diffFiles, hashStreams, type ByteRange } from "./streams.js";
import { comparePgsTracks } from "./pgs.js";
import type {
  PayloadMode,
  StreamHash,
  VerifyCheck,
  VerifyReport,
  PgsTrackComparison,
} from "./types.js";

export interface VerifyOptions {
  /** Aspect used to re-derive the active area; "auto" samples frames. */
  aspect?: number | "auto";
  margin?: number;
  samples?: number;
  tolerancePx?: number;
  /**
   * Extract and hash every video/audio/untouched-subtitle stream. Defaults to
   * on when the two files differ in size (a remux), off when they do not.
   */
  hashStreams?: boolean;
  /** mkvmerge track ids in the FIXED file that are expected to have moved. */
  expectTracks?: readonly number[];
  tempDir?: string;
}

export interface VerifyDeps {
  log?: Logger;
  mkvmergePath?: string;
  mkvextractPath?: string;
  /** Stops the analysis of either file and the stream extraction; the verification then throws. */
  signal?: AbortSignal;
}

/**
 * Tolerance on the container duration, in nanoseconds.
 *
 * A remux recomputes the duration from the last block it wrote and routinely
 * lands a few milliseconds away; PRD §13 calls that class of container-level
 * difference acceptable. Real truncation is orders of magnitude larger.
 */
const DURATION_TOLERANCE_NS = 100_000_000;

function check(name: string, pass: boolean, detail: string, differences?: string[]): VerifyCheck {
  return differences && differences.length > 0
    ? { name, pass, detail, differences }
    : { name, pass, detail };
}

function containerChecks(a: ContainerFacts, b: ContainerFacts): VerifyCheck[] {
  const checks: VerifyCheck[] = [];

  const da = a.durationNs ?? 0;
  const db = b.durationNs ?? 0;
  checks.push(
    check(
      "duration",
      Math.abs(da - db) <= DURATION_TOLERANCE_NS,
      `${(da / 1e9).toFixed(3)}s → ${(db / 1e9).toFixed(3)}s (${((db - da) / 1e6).toFixed(1)} ms)`,
    ),
  );

  checks.push(
    check(
      "title",
      (a.title ?? "") === (b.title ?? ""),
      a.title === undefined && b.title === undefined
        ? "no title in either file"
        : `"${a.title ?? ""}" → "${b.title ?? ""}"`,
    ),
  );

  const chaptersEqual =
    a.chapterEditions.length === b.chapterEditions.length &&
    a.chapterEditions.every((n, i) => n === b.chapterEditions[i]);
  checks.push(
    check(
      "chapters",
      chaptersEqual,
      a.chapterEditions.length === 0
        ? "no chapters in either file"
        : `${a.chapterEditions.join("+")} entries → ${b.chapterEditions.join("+")}`,
    ),
  );

  const key = (x: { fileName: string; size: number; contentType: string }): string =>
    `${x.fileName} (${x.size} bytes, ${x.contentType})`;
  const aAtt = a.attachments.map(key).sort();
  const bAtt = b.attachments.map(key).sort();
  const attachmentsEqual = aAtt.length === bAtt.length && aAtt.every((x, i) => x === bAtt[i]);
  checks.push(
    check(
      "attachments",
      attachmentsEqual,
      `${aAtt.length} → ${bAtt.length}`,
      attachmentsEqual ? [] : [`original: ${aAtt.join("; ")}`, `fixed: ${bAtt.join("; ")}`],
    ),
  );

  const tagsEqual = a.globalTagCount === b.globalTagCount;
  checks.push(
    check(
      "tags",
      tagsEqual,
      `${a.globalTagCount} global tag entr(ies) → ${b.globalTagCount}` +
        ` (track tags ${a.trackTagCounts.length} → ${b.trackTagCounts.length})`,
    ),
  );

  return checks;
}

function sameTrackMetadata(a: ContainerTrack, b: ContainerTrack): boolean {
  return (
    a.type === b.type &&
    a.codecId === b.codecId &&
    a.language === b.language &&
    (a.name ?? "") === (b.name ?? "") &&
    a.default === b.default &&
    a.forced === b.forced &&
    a.enabled === b.enabled &&
    a.hearingImpaired === b.hearingImpaired &&
    a.visualImpaired === b.visualImpaired &&
    a.commentary === b.commentary &&
    a.original === b.original
  );
}

function trackListCheck(a: ContainerFacts, b: ContainerFacts): VerifyCheck {
  const differences: string[] = [];
  const shared = Math.min(a.tracks.length, b.tracks.length);
  for (let i = 0; i < shared; i++) {
    const x = a.tracks[i]!;
    const y = b.tracks[i]!;
    if (!sameTrackMetadata(x, y)) {
      differences.push(`${describeTrack(x)} → ${describeTrack(y)}`);
    }
  }
  // Extra tracks are only acceptable as the A/B mode's appended copies.
  for (let i = shared; i < b.tracks.length; i++) {
    const extra = b.tracks[i]!;
    if (!(extra.name ?? "").includes(SCOPE_FIXED_SUFFIX)) {
      differences.push(`unexpected extra track ${describeTrack(extra)}`);
    }
  }
  for (let i = shared; i < a.tracks.length; i++) {
    differences.push(`track missing from the fixed file: ${describeTrack(a.tracks[i]!)}`);
  }
  const appended = Math.max(0, b.tracks.length - a.tracks.length);
  return check(
    "tracks",
    differences.length === 0,
    `${a.tracks.length} track(s)` +
      (appended > 0 ? `, ${appended} appended [scope-fixed] track(s)` : ", same order and flags"),
    differences,
  );
}

/** All position fields in a file's PGS tracks, sorted by offset. */
function allPositionFields(analysis: FileAnalysis): PositionField[] {
  const fields: PositionField[] = [];
  for (const t of analysis.tracks) {
    if (t.compressed || t.blocks.length === 0) continue;
    fields.push(...positionFields(t.segments, BLOCK_HEADER_SIZE));
  }
  return fields.sort((a, b) => a.offset - b.offset);
}

function rangeInsideAnyField(range: ByteRange, fields: readonly PositionField[]): boolean {
  let lo = 0;
  let hi = fields.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = fields[mid]!;
    if (range.start < f.offset) hi = mid - 1;
    else if (range.start >= f.offset + f.length) lo = mid + 1;
    else return range.end <= f.offset + f.length;
  }
  return false;
}

/** Position fields of one track that overlap a differing byte range. */
function changedFieldCount(
  track: TrackAnalysis,
  ranges: readonly ByteRange[],
): number {
  if (track.compressed || track.blocks.length === 0) return 0;
  const fields = positionFields(track.segments, BLOCK_HEADER_SIZE);
  // Both lists are sorted by offset, so one merge pass suffices; a nested loop
  // would be quadratic and a feature film has tens of thousands of each.
  let n = 0;
  let i = 0;
  for (const f of fields) {
    const end = f.offset + f.length;
    while (i < ranges.length && ranges[i]!.end <= f.offset) i++;
    if (i < ranges.length && ranges[i]!.start < end) n++;
  }
  return n;
}

interface PgsPairing {
  original: TrackAnalysis;
  fixed: TrackAnalysis;
  appended: boolean;
}

/**
 * Pair the PGS tracks of the two files. In replace mode they line up
 * positionally; in A/B mode the fixed file carries extra `[scope-fixed]`
 * tracks, which are matched back to the original they were derived from.
 */
export function pairPgsTracks(
  original: FileAnalysis,
  fixed: FileAnalysis,
): { pairs: PgsPairing[]; unmatched: TrackAnalysis[] } {
  const pairs: PgsPairing[] = [];
  const unmatched: TrackAnalysis[] = [];
  const shared = Math.min(original.tracks.length, fixed.tracks.length);
  for (let i = 0; i < shared; i++) {
    pairs.push({
      original: original.tracks[i]!,
      fixed: fixed.tracks[i]!,
      appended: false,
    });
  }
  for (let i = shared; i < fixed.tracks.length; i++) {
    const extra = fixed.tracks[i]!;
    const base = (extra.track.name ?? "").replace(SCOPE_FIXED_SUFFIX, "").trim();
    const source =
      original.tracks.find(
        (t) => (t.track.name ?? t.track.language) === base && t.track.language === extra.track.language,
      ) ?? original.tracks.find((t) => t.track.language === extra.track.language);
    if (source) pairs.push({ original: source, fixed: extra, appended: true });
    else unmatched.push(extra);
  }
  return { pairs, unmatched };
}

function tracksToHash(facts: ContainerFacts, skipTrackIds: ReadonlySet<number>) {
  return facts.tracks
    .filter((t) => !skipTrackIds.has(t.id))
    .filter((t) => t.type === "video" || t.type === "audio" || t.type === "subtitles")
    .map((t) => ({ id: t.id, type: t.type, codecId: t.codecId }));
}

/** Compare an original MKV against its repaired copy. */
export async function verifyFile(
  originalPath: string,
  fixedPath: string,
  options: VerifyOptions = {},
  deps: VerifyDeps = {},
): Promise<VerifyReport> {
  const started = Date.now();
  const log = deps.log ?? silentLogger;
  const aspect = options.aspect ?? "auto";

  const [originalBytes, fixedBytes] = await Promise.all([
    stat(originalPath).then((s) => s.size),
    stat(fixedPath).then((s) => s.size),
  ]);

  log.info("reading container metadata");
  const [factsA, factsB] = await Promise.all([
    readContainerFacts(originalPath, deps.mkvmergePath),
    readContainerFacts(fixedPath, deps.mkvmergePath),
  ]);

  const checks: VerifyCheck[] = [...containerChecks(factsA, factsB), trackListCheck(factsA, factsB)];

  log.info("analyzing PGS in both files");
  const scanOptions = {
    aspect,
    ...(options.margin === undefined ? {} : { margin: options.margin }),
    ...(options.samples === undefined ? {} : { samples: options.samples }),
    ...(options.tolerancePx === undefined ? {} : { tolerancePx: options.tolerancePx }),
  };
  // With a signal, both reads can be abandoned: between two picture samples,
  // or at the next block. An abandoned analysis is an error result, not a
  // verdict, so it must never reach the comparison below.
  const signal = deps.signal;
  const stopIfAborted = (): void => {
    if (signal?.aborted === true) throw new Error("cancelled");
  };
  const analysisDeps =
    signal === undefined
      ? { log: silentLogger }
      : { log: silentLogger, signal, onReadProgress: stopIfAborted };
  stopIfAborted();
  const analysisA = await analyzeFile(originalPath, scanOptions, analysisDeps);
  stopIfAborted();
  const analysisB = await analyzeFile(fixedPath, scanOptions, analysisDeps);
  stopIfAborted();

  // Each file's picture area is detected on its own. When the original has
  // one to judge by and the fixed file comes out without (a changing picture
  // on the borderline, sampled at other frames), the comparison below would
  // find nothing outside in the fixed file because nothing was judged: that
  // must fail, not pass unchecked.
  const areaA = analysisA.activeArea;
  const areaB = analysisB.activeArea;
  if (areaA !== null && areaB !== null && isUsableArea(areaA) && !isUsableArea(areaB)) {
    checks.push(
      check(
        "active area",
        false,
        `the picture area of the fixed file could not be determined (${areaB.classification}), ` +
          `though the original's was y=${areaA.top}..${areaA.bottom} (${areaA.classification}): ` +
          "its subtitles could not be verified against the picture",
      ),
    );
  }

  const { pairs, unmatched } = pairPgsTracks(analysisA, analysisB);
  const pgsTracks: PgsTrackComparison[] = pairs.map((p) =>
    comparePgsTracks(p.original, p.fixed, {
      appended: p.appended,
      // A/B mode: this original was copied through untouched and its repaired
      // twin is a pairing of its own, so nothing here was meant to move.
      preserved:
        !p.appended && pairs.some((q) => q.appended && q.original === p.original),
    }),
  );
  for (const t of unmatched) {
    checks.push(
      check(
        `pgs track ${t.track.id}`,
        false,
        "extra PGS track in the fixed file with no counterpart in the original",
      ),
    );
  }
  for (const c of pgsTracks) {
    const label = `pgs track ${c.fixedTrackId}`;
    const unexpected = c.stillOutsideCount - c.expectedStillOutsideCount;
    const outside =
      c.stillOutsideCount === 0
        ? ", all inside the active area"
        : `, ${c.stillOutsideCount} event(s) still outside the active area` +
          (unexpected > 0
            ? ` (${c.expectedStillOutsideCount} refused by the move policy, ` +
              `${unexpected} unaccounted for)`
            : " (all refused by the move policy: " +
              c.stillOutside
                .slice(0, 5)
                .map((e) => `event ${e.eventIndex} at ${e.ptsMs} ms`)
                .join(", ") +
              (c.stillOutside.length > 5 ? ", …" : "") +
              ")");
    const detail =
      (c.changedEventCount === 0
        ? `${c.eventCount} events, unchanged`
        : `${c.changedEventCount} of ${c.eventCount} events repositioned` +
          (c.appended ? " (appended [scope-fixed] track)" : "")) + outside;
    checks.push(check(label, c.problems.length === 0 && unexpected <= 0, detail, c.problems));
  }

  // --- payload ------------------------------------------------------------
  const sameSize = originalBytes === fixedBytes;
  const doHash = options.hashStreams ?? !sameSize;
  let payloadMode: PayloadMode = "skipped";
  let differingByteRanges = 0;
  let differingBytes = 0;
  const streamHashes: { original: StreamHash[]; fixed: StreamHash[] } = {
    original: [],
    fixed: [],
  };

  if (sameSize && !doHash) {
    payloadMode = "byte-identical";
    log.info(`byte-diffing ${originalBytes} bytes`);
    let lastPercent = -1;
    const diff = await diffFiles(originalPath, fixedPath, (done, total) => {
      const percent = Math.floor((done / total) * 10) * 10;
      if (percent !== lastPercent) {
        lastPercent = percent;
        log.info(`  diff ${percent}%`);
      }
    });
    differingByteRanges = diff.ranges.length;
    differingBytes = diff.differingBytes;

    const fields = allPositionFields(analysisB);
    const stray = diff.ranges.filter((r) => !rangeInsideAnyField(r, fields));
    const compressedTracks = analysisB.tracks.filter((t) => t.compressed).map((t) => t.track.id);
    checks.push(
      check(
        "payload",
        stray.length === 0 && !diff.truncated && compressedTracks.length === 0,
        diff.truncated
          ? "too many differing byte ranges to enumerate"
          : `${diff.differingBytes} byte(s) differ in ${diff.ranges.length} range(s), ` +
            `all inside PGS position fields`,
        [
          ...(compressedTracks.length > 0
            ? [
                `fixed PGS track(s) ${compressedTracks.join(", ")} are Matroska-compressed, ` +
                  "so byte offsets cannot be attributed to position fields",
              ]
            : []),
          ...stray
            .slice(0, 20)
            .map((r) => `bytes ${r.start}..${r.end} are outside every PGS position field`),
          ...(stray.length > 20 ? [`... and ${stray.length - 20} more`] : []),
        ],
      ),
    );

    for (const c of pgsTracks) {
      const t = analysisB.tracks.find((x) => x.track.id === c.fixedTrackId);
      if (t) {
        const n = changedFieldCount(t, diff.ranges);
        checks.push(
          check(
            `pgs track ${c.fixedTrackId} bytes`,
            true,
            `${n} position field(s) rewritten in the container`,
          ),
        );
      }
    }
  } else if (doHash) {
    payloadMode = "stream-hashes";
    const tempDir = await makeTempDir(options.tempDir);
    try {
      // Hash only the streams that must be identical on both sides: skip the
      // tracks that were replaced in place, and skip the A/B mode's appended
      // copies (which have no counterpart in the original at all).
      const replaced = pgsTracks.filter((c) => !c.appended && c.changedEventCount > 0);
      const skipOriginal = new Set(replaced.map((c) => c.originalTrackId));
      const skipFixed = new Set([
        ...replaced.map((c) => c.fixedTrackId),
        ...pgsTracks.filter((c) => c.appended).map((c) => c.fixedTrackId),
        ...factsB.tracks.slice(factsA.tracks.length).map((t) => t.id),
      ]);

      streamHashes.original = await hashStreams(
        originalPath,
        tracksToHash(factsA, skipOriginal),
        {
          tempDir,
          ...(deps.mkvextractPath === undefined ? {} : { mkvextractPath: deps.mkvextractPath }),
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
          onProgress: (m) => log.info(m),
        },
      );
      streamHashes.fixed = await hashStreams(fixedPath, tracksToHash(factsB, skipFixed), {
        tempDir,
        ...(deps.mkvextractPath === undefined ? {} : { mkvextractPath: deps.mkvextractPath }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        onProgress: (m) => log.info(m),
      });

      const differences: string[] = [];
      const n = Math.min(streamHashes.original.length, streamHashes.fixed.length);
      for (let i = 0; i < n; i++) {
        const x = streamHashes.original[i]!;
        const y = streamHashes.fixed[i]!;
        if (x.sha256 !== y.sha256) {
          differences.push(
            `${x.type} track ${x.trackId} (${x.codecId}): ${x.sha256.slice(0, 16)} → ${y.sha256.slice(0, 16)}`,
          );
        }
      }
      if (streamHashes.original.length !== streamHashes.fixed.length) {
        differences.push(
          `${streamHashes.original.length} untouched stream(s) in the original, ${streamHashes.fixed.length} in the fixed file`,
        );
      }
      checks.push(
        check(
          "payload",
          differences.length === 0,
          `${n} elementary stream(s) hashed, ${n - differences.length} identical`,
          differences,
        ),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  } else {
    checks.push(
      check(
        "payload",
        false,
        "file sizes differ and --hash-streams was disabled, so payloads were not compared",
      ),
    );
  }

  // --- expectations -------------------------------------------------------
  if (options.expectTracks !== undefined) {
    const expected = new Set(options.expectTracks);
    const actual = new Set(
      pgsTracks.filter((c) => c.changedEventCount > 0).map((c) => c.fixedTrackId),
    );
    const missing = [...expected].filter((id) => !actual.has(id));
    const extra = [...actual].filter((id) => !expected.has(id));
    checks.push(
      check(
        "expected tracks",
        missing.length === 0 && extra.length === 0,
        `expected changes on track(s) ${[...expected].join(", ") || "none"}`,
        [
          ...missing.map((id) => `track ${id} was expected to change but did not`),
          ...extra.map((id) => `track ${id} changed but was not expected to`),
        ],
      ),
    );
  }

  return {
    original: originalPath,
    fixed: fixedPath,
    pass: checks.every((c) => c.pass),
    originalBytes,
    fixedBytes,
    payloadMode,
    checks,
    pgsTracks,
    differingByteRanges,
    differingBytes,
    streamHashes,
    elapsedMs: Date.now() - started,
  };
}
