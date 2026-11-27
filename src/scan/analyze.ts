/**
 * The shared "inspect → active area → read tracks → events → classify → plan"
 * pipeline.
 *
 * `scan` turns the result into a report; `fix` turns the same result into byte
 * patches or a corrected .sup. Keeping one pipeline is what guarantees the
 * promise in PRD §12: the fixer never moves anything the scanner would not
 * have reported.
 *
 * Nothing here writes to the source file. The only side effect possible is a
 * temporary .sup written by the injected `PgsTrackSource`.
 */
import { classifyEvents, defaultMargin, type ClassifiedEvent } from "../geometry/classify.js";
import { scaleActiveAreaToCanvas } from "../geometry/canvas.js";
import { planMoves, type MovePlan } from "../geometry/policy.js";
import type { Bounds } from "../geometry/rect.js";
import { buildDisplaySets, buildEpochs, resolveEvents } from "../pgs/compose.js";
import { PgsParseError } from "../pgs/errors.js";
import type { DisplaySet, PgsEvent, Segment } from "../pgs/types.js";
import { MkvExtractError, createMkvextractSource } from "../mkv/extract.js";
import {
  DependencyMissingError,
  MkvInspectError,
  inspectMkv,
  type MkvInfo,
  type MkvSubtitleTrack,
} from "../mkv/inspect.js";
import type { PgsTrackRef, PgsTrackSource } from "../mkv/pgsSource.js";
import {
  readPgsTracksData,
  type PgsBlockRecord,
  type PgsMultiTrackSource,
} from "../mkv/pgsBlocks.js";
import { isNetworkPath, type ReadStrategyName } from "../mkv/ebml.js";
import {
  activeAreaFromAspect,
  detectActiveArea,
  isUsableArea,
  type ActiveArea,
  type DetectActiveAreaOptions,
} from "../video/activeArea.js";
import { silentLogger, type Logger } from "./log.js";
import type {
  FileStatus,
  ScanErrorKind,
  ScanVideoInfo,
  TrackStatus,
} from "./types.js";

export interface ScanOptions {
  /** Target aspect ratio, or "auto" to measure it from sampled frames. */
  aspect: number | "auto";
  /** Safe margin override, in canvas pixels. Defaults to 24 px at 1080. */
  margin?: number;
  /** Frames to sample for auto detection. */
  samples?: number;
  /** Clustering tolerance for auto detection, in pixels. */
  tolerancePx?: number;
  /** Files scanned concurrently by `scanPaths`. */
  jobs?: number;
  recursive?: boolean;
  tempDir?: string;
  keepTemp?: boolean;
  /** How PGS blocks are read. "direct" walks the container; "mkvextract" shells out to a temp .sup. */
  source?: "direct" | "mkvextract";
  /**
   * Buffering strategy for the direct reader. Omitted, `DEFAULT_READ_STRATEGY`
   * applies: the whole file is read sequentially, which measured fastest on
   * every transport. `adaptive`/`minimal` transfer ~3% of the bytes but take
   * longer, so they are for when bandwidth, not time, is the constraint.
   */
  readStrategy?: ReadStrategyName;
  /** Only analyze these mkvmerge track ids (all PGS tracks by default). */
  trackIds?: readonly number[];
  /**
   * Read the PGS tracks even when the active area covers the whole frame, where
   * nothing can be outside it. Off by default: that read is a full pass over a
   * 20-60 GB file to prove something the geometry already proved.
   */
  full?: boolean;
}

export interface ScanDeps {
  inspect?: (file: string) => Promise<MkvInfo>;
  pgsSource?: PgsTrackSource;
  /**
   * Reads every PGS track in one pass. Preferred over `pgsSource` for the
   * direct reader: a cluster walk costs one read per block, so doing it once
   * per track multiplies the cost of a 14-track Blu-ray rip by 14.
   */
  pgsMultiSource?: PgsMultiTrackSource;
  detectActiveArea?: (
    file: string,
    options: DetectActiveAreaOptions,
  ) => Promise<ActiveArea>;
  log?: Logger;
  /**
   * Called as the direct reader walks the file (once per PGS block, so often:
   * throttle on the receiving side). Not called for the fast path, an injected
   * source or `mkvextract`. Throwing from it stops the read, which the
   * analysis then reports like any other read failure.
   */
  onReadProgress?: (position: number, fileSize: number) => void;
  /**
   * Stops the active-area sampling between ffmpeg runs. The analysis then
   * reports an error like any other; the caller knows it asked.
   */
  signal?: AbortSignal;
}

/** Everything the analyzer learned about one PGS track. */
export interface TrackAnalysis {
  track: MkvSubtitleTrack;
  status: TrackStatus;
  /** Segments in stream order. Offsets are absolute in the MKV for the direct reader. */
  segments: Segment[];
  displaySets: DisplaySet[];
  /** Epoch index per display-set index, for every display set (events or not). */
  epochByDisplaySet: Map<number, number>;
  events: PgsEvent[];
  /** Epoch index per event, aligned with `events`. */
  epochIds: number[];
  canvasWidth: number | undefined;
  canvasHeight: number | undefined;
  /** Active area in canvas coordinates, when it could be mapped. */
  bounds: Bounds | null;
  canvasMismatch: boolean;
  margin: number;
  classified: ClassifiedEvent[];
  plan: MovePlan | null;
  offendingEventCount: number;
  ambiguousEventCount: number;
  /**
   * Informational (PRD §10.3): events inside the active area but within
   * `margin` px of an edge. Never repaired, only counted.
   */
  touchingBoundaryEventCount: number;
  /** True when the track carries Matroska content compression (offsets are not file bytes). */
  compressed: boolean;
  /**
   * False when the track was never opened — the no-letterbox fast path. Every
   * count below is then meaningless rather than zero, and reports say so.
   */
  eventsRead: boolean;
  /** Blocks backing the segments, payload-free; empty for an mkvextract read. */
  blocks: PgsBlockRecord[];
  notes: string[];
  error: string | undefined;
  errorKind: ScanErrorKind | undefined;
}

export interface FileAnalysis {
  file: string;
  status: FileStatus;
  info: MkvInfo | null;
  durationMs: number | undefined;
  title: string | undefined;
  video: ScanVideoInfo | null;
  activeArea: ActiveArea | null;
  tracks: TrackAnalysis[];
  notes: string[];
  error: string | undefined;
  errorKind: ScanErrorKind | undefined;
}

/** Segments plus the container-level facts only the direct reader knows. */
interface TrackBytes {
  segments: Segment[];
  compressed: boolean;
  blocks: PgsBlockRecord[];
}

type TrackBytesSource = (
  file: string,
  track: PgsTrackRef,
) => Promise<TrackBytes>;

export function errorKindOf(err: unknown): ScanErrorKind {
  if (err instanceof DependencyMissingError) return "DEPENDENCY_MISSING";
  if (err instanceof PgsParseError) return "PGS_PARSE";
  if (err instanceof MkvExtractError) return "EXTRACT";
  if (err instanceof MkvInspectError) return "INSPECT";
  return "OTHER";
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyTrackAnalysis(track: MkvSubtitleTrack, margin: number): TrackAnalysis {
  return {
    track,
    status: "OK",
    segments: [],
    displaySets: [],
    epochByDisplaySet: new Map(),
    events: [],
    epochIds: [],
    canvasWidth: undefined,
    canvasHeight: undefined,
    bounds: null,
    canvasMismatch: false,
    margin,
    classified: [],
    plan: null,
    offendingEventCount: 0,
    ambiguousEventCount: 0,
    touchingBoundaryEventCount: 0,
    compressed: false,
    eventsRead: true,
    blocks: [],
    notes: [],
    error: undefined,
    errorKind: undefined,
  };
}

async function analyzeTrack(
  file: string,
  track: MkvSubtitleTrack,
  active: ActiveArea | null,
  options: ScanOptions,
  source: TrackBytesSource,
  log: Logger,
): Promise<TrackAnalysis> {
  const result = emptyTrackAnalysis(track, options.margin ?? 0);

  try {
    const bytes = await source(file, { id: track.id, number: track.number });
    result.segments = bytes.segments;
    result.compressed = bytes.compressed;
    result.blocks = bytes.blocks;
    const displaySets = buildDisplaySets(bytes.segments);
    result.displaySets = displaySets;
    for (const epoch of buildEpochs(displaySets)) {
      for (const ds of epoch.displaySets) {
        result.epochByDisplaySet.set(ds.index, epoch.index);
      }
    }
    result.events = resolveEvents(displaySets);
    result.epochIds = result.events.map(
      (e) => result.epochByDisplaySet.get(e.displaySetIndex) ?? e.index,
    );
    const first = displaySets[0];
    result.canvasWidth = result.events[0]?.videoWidth ?? first?.pcs.videoWidth;
    result.canvasHeight = result.events[0]?.videoHeight ?? first?.pcs.videoHeight;
  } catch (err) {
    log.warn(`track ${track.id} (mkvmerge track id): ${messageOf(err)}`);
    result.status = "ERROR";
    result.error = messageOf(err);
    result.errorKind = errorKindOf(err);
    return result;
  }

  const events = result.events;
  log.info(
    `PGS track ${track.id} (matroska track number ${track.number}): ${events.length} events`,
  );

  if (events.length === 0) {
    result.notes.push("track contains no subtitle events");
    return result;
  }

  // Every PCS in a track declares the video size the positions are relative to.
  // They are supposed to agree; if they do not, there is no single canvas to map
  // the active area onto, so nothing here can be trusted to move correctly.
  const canvases = [
    ...new Set(
      result.displaySets.map((ds) => `${ds.pcs.videoWidth}x${ds.pcs.videoHeight}`),
    ),
  ];
  if (canvases.length > 1) {
    const message =
      `the track declares more than one PGS canvas (${canvases.join(", ")}); ` +
      "no moves proposed";
    result.status = "AMBIGUOUS";
    result.ambiguousEventCount = events.length;
    result.notes.push(message);
    log.warn(`track ${track.id}: ${message}`);
    return result;
  }

  if (!active || !isUsableArea(active)) {
    result.status = "AMBIGUOUS";
    result.notes.push(
      `active area is ${active?.classification ?? "UNKNOWN"}; no moves proposed`,
    );
    result.ambiguousEventCount = events.length;
    return result;
  }

  const scaled = scaleActiveAreaToCanvas(
    active,
    result.canvasWidth ?? 0,
    result.canvasHeight ?? 0,
  );
  const margin = options.margin ?? defaultMargin(result.canvasHeight ?? 1080);
  result.margin = margin;

  if (scaled.status === "CANVAS_MISMATCH") {
    result.status = "AMBIGUOUS";
    result.canvasMismatch = true;
    result.ambiguousEventCount = events.length;
    result.notes.push(scaled.message);
    log.warn(`track ${track.id}: ${scaled.message}`);
    return result;
  }

  const bounds: Bounds = {
    top: scaled.top,
    bottom: scaled.bottom,
    left: scaled.left,
    right: scaled.right,
  };
  result.bounds = bounds;
  if (!scaled.identity) {
    result.notes.push(
      `active area scaled onto the ${result.canvasWidth}x${result.canvasHeight} PGS canvas`,
    );
  }

  result.classified = classifyEvents(events, bounds, { margin });
  result.plan = planMoves(events, bounds, {
    margin,
    epochIds: result.epochIds,
    ...(result.canvasWidth === undefined ? {} : { canvasWidth: result.canvasWidth }),
    ...(result.canvasHeight === undefined ? {} : { canvasHeight: result.canvasHeight }),
  });

  for (const c of result.classified) {
    if (c.needsFix) result.offendingEventCount++;
    if (c.status === "AMBIGUOUS") result.ambiguousEventCount++;
    if (c.touchingBoundary) result.touchingBoundaryEventCount++;
  }

  result.status =
    result.offendingEventCount > 0
      ? "NEEDS_FIX"
      : result.ambiguousEventCount > 0
        ? "AMBIGUOUS"
        : "OK";

  if (result.offendingEventCount > 0) {
    const firstOffender = result.classified.find(
      (c) => c.needsFix && c.status !== "AMBIGUOUS",
    );
    log.warn(
      `${result.offendingEventCount} of ${events.length} events extend outside the active area` +
        (firstOffender ? ` (earliest at ${firstOffender.ptsMs} ms)` : ""),
    );
  }

  return result;
}

/**
 * Offending events the move policy refused — the ones expected to still be
 * outside the active area after a repair.
 *
 * One definition, three readers: `plan` records it as `expected_offending_after`,
 * `apply` checks its finished output against it, and `verify` recomputes it from
 * the original so it needs no plan. All of them count exactly the events
 * `classifyEvent` marked `needsFix`, so a change to that rule (PRD §10.3: real
 * overflow only) moves all three together.
 *
 * An event drawn in two windows may be moved in one and refused in the other:
 * it has a plan entry and is still outside afterwards. So an event counts as
 * refused when any object of it that is outside is not among the ones its
 * entry moves — not merely when it has no entry.
 */
export function refusedOffendingCount(analysis: TrackAnalysis): number {
  const moved = new Map(
    (analysis.plan?.entries ?? []).map((e) => [e.eventIndex, e.objectDeltas] as const),
  );
  let n = 0;
  for (const c of analysis.classified) {
    if (!c.needsFix) continue;
    const deltas = moved.get(c.index);
    if (
      deltas === undefined ||
      c.objects.some(
        (o) =>
          // `classifyEvent`'s own test for "overflowing".
          (o.overflow.top > 0 || o.overflow.bottom > 0 || o.overflow.left > 0 || o.overflow.right > 0) &&
          !deltas.has(o.objectId),
      )
    ) {
      n++;
    }
  }
  return n;
}

async function resolveActiveArea(
  file: string,
  info: MkvInfo,
  options: ScanOptions,
  deps: ScanDeps,
  log: Logger,
): Promise<ActiveArea | null> {
  const video = info.video;
  if (!video || video.width <= 0 || video.height <= 0) return null;
  if (options.aspect !== "auto") {
    return activeAreaFromAspect(video.width, video.height, options.aspect);
  }
  const detect = deps.detectActiveArea ?? detectActiveArea;
  log.debug(`sampling ${options.samples ?? 24} frames for the picture area`);
  return detect(file, {
    durationMs: info.durationMs ?? 0,
    frameW: video.width,
    frameH: video.height,
    ...(options.samples === undefined ? {} : { samples: options.samples }),
    ...(options.tolerancePx === undefined ? {} : { tolerancePx: options.tolerancePx }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });
}

/**
 * True when the resolved active area is the whole coded frame: a 16:9 title
 * with no letterbox bars at all.
 *
 * This is the one geometry in which the PGS tracks need not be read. A subtitle
 * lives on a canvas mapped onto the frame, so if the active area *is* the frame
 * there is nowhere outside it to be — no event can offend, whatever the bytes
 * say. Anything narrower (a 1.85:1 title has ~20 px bars) must still be read.
 * The classification must be CONSTANT: `UNKNOWN` and `MIXED_ASPECT_RATIO` also
 * report the full frame, and both mean "we do not know", not "there are no bars".
 */
export function coversFullFrame(active: ActiveArea | null): boolean {
  if (!active || active.classification !== "CONSTANT") return false;
  return (
    active.top === 0 &&
    active.bottom === active.frameHeight &&
    active.left === 0 &&
    active.right === active.frameWidth
  );
}

export function fileStatusFrom(
  tracks: readonly { status: TrackStatus }[],
  active: ActiveArea | null,
): FileStatus {
  if (tracks.length === 0) return "NO_PGS";
  if (tracks.every((t) => t.status === "ERROR")) return "ERROR";
  if (active?.classification === "MIXED_ASPECT_RATIO") return "MIXED_ASPECT_RATIO";
  if (tracks.some((t) => t.status === "NEEDS_FIX")) return "NEEDS_FIX";
  if (tracks.some((t) => t.status === "AMBIGUOUS" || t.status === "ERROR")) {
    return "AMBIGUOUS";
  }
  return "OK";
}

/** Wrap a segments-only source so the rest of the pipeline sees `TrackBytes`. */
function fromSegments(source: PgsTrackSource): TrackBytesSource {
  return async (file, track) => ({
    segments: await source(file, track),
    compressed: false,
    blocks: [],
  });
}

/**
 * Run the analysis pipeline over one MKV. Never throws for per-file problems;
 * they land in the result.
 */
export async function analyzeFile(
  file: string,
  options: ScanOptions,
  deps: ScanDeps = {},
): Promise<FileAnalysis> {
  const log = deps.log ?? silentLogger;
  const readerOptions =
    options.readStrategy === undefined ? {} : { strategy: options.readStrategy };
  const perTrackSource: TrackBytesSource = deps.pgsSource
    ? fromSegments(deps.pgsSource)
    : options.source === "mkvextract"
      ? fromSegments(
          createMkvextractSource({
            ...(options.tempDir === undefined ? {} : { tempDir: options.tempDir }),
            ...(options.keepTemp === undefined ? {} : { keepTemp: options.keepTemp }),
          }),
        )
      : async (f, t) => {
          const data = await readPgsTracksData(f, [t.number], readerOptions);
          const entry = data.get(t.number)!;
          return {
            segments: entry.segments,
            compressed: entry.compressed,
            blocks: entry.blocks,
          };
        };
  // One cluster walk for every PGS track, unless the caller pinned a per-track
  // source or asked for mkvextract.
  const useMultiSource =
    deps.pgsMultiSource !== undefined ||
    !(deps.pgsSource || options.source === "mkvextract");

  const empty: FileAnalysis = {
    file,
    status: "OK",
    info: null,
    durationMs: undefined,
    title: undefined,
    video: null,
    activeArea: null,
    tracks: [],
    notes: [],
    error: undefined,
    errorKind: undefined,
  };

  log.info(file);

  let info: MkvInfo;
  try {
    info = await (deps.inspect ?? inspectMkv)(file);
  } catch (err) {
    log.error(`${file}: ${messageOf(err)}`);
    return {
      ...empty,
      status: "ERROR",
      error: messageOf(err),
      errorKind: errorKindOf(err),
    };
  }

  const video = info.video
    ? {
        width: info.video.width,
        height: info.video.height,
        codecId: info.video.codecId,
        displayWidth: info.video.displayWidth,
        displayHeight: info.video.displayHeight,
      }
    : null;
  if (video) log.info(`Video: ${video.width}x${video.height}`);

  const allPgsTracks = info.subtitleTracks.filter((t) => t.isPgs);
  const wanted = options.trackIds;
  const pgsTracks =
    wanted === undefined
      ? allPgsTracks
      : allPgsTracks.filter((t) => wanted.includes(t.id));
  const result: FileAnalysis = {
    ...empty,
    info,
    durationMs: info.durationMs,
    title: info.title,
    video,
  };

  if (pgsTracks.length === 0) {
    result.status = "NO_PGS";
    result.notes.push(
      info.subtitleTracks.length === 0
        ? "no subtitle tracks"
        : `no PGS subtitle tracks (${info.subtitleTracks.length} other subtitle tracks)`,
    );
    log.info(`${file}: no PGS subtitle tracks`);
    return result;
  }

  if (!video) {
    result.status = "AMBIGUOUS";
    result.notes.push("no video track; the active area cannot be determined");
  }

  let active: ActiveArea | null = null;
  try {
    active = await resolveActiveArea(file, info, options, deps, log);
  } catch (err) {
    log.error(`${file}: active-area detection failed: ${messageOf(err)}`);
    return {
      ...result,
      status: "ERROR",
      error: messageOf(err),
      errorKind: errorKindOf(err),
    };
  }
  result.activeArea = active;
  if (active) {
    log.info(
      `Active area: y=${active.top}..${active.bottom} (${active.aspect}:1, ${active.source}, ${active.classification})`,
    );
  }

  // The fast path: no bars, so nothing can be outside the picture. Reading the
  // PGS tracks means a full sequential pass over tens of gigabytes to confirm
  // what the geometry has already settled, so it is skipped unless asked for.
  if (coversFullFrame(active) && options.full !== true) {
    const margin = options.margin ?? defaultMargin(video?.height ?? 1080);
    for (const track of pgsTracks) {
      const t = emptyTrackAnalysis(track, margin);
      t.eventsRead = false;
      t.notes.push("not read: the active area is the whole frame");
      result.tracks.push(t);
    }
    result.notes.push(
      `no letterbox bars detected (${active!.aspect}:1); PGS tracks not read` +
        " (pass --full to read them anyway)",
    );
    result.status = fileStatusFrom(result.tracks, active);
    log.info(`${file}: no letterbox bars; ${pgsTracks.length} PGS track(s) not read`);
    return result;
  }

  // Read every PGS track in one pass, then hand each track its own segments.
  let source = perTrackSource;
  if (useMultiSource) {
    if (options.readStrategy === undefined && isNetworkPath(file)) {
      // Streaming is by far the fastest option even over a share, but it does
      // pull the whole file across; say so, since the alternative is a flag.
      log.info(
        "reading from a network share: the whole file is streamed; " +
          "--read-strategy adaptive transfers ~3% instead, but much more slowly",
      );
    }
    const refs: PgsTrackRef[] = pgsTracks.map((t) => ({ id: t.id, number: t.number }));
    try {
      const byTrack = new Map<number, TrackBytes>();
      if (deps.pgsMultiSource) {
        for (const [number, segments] of await deps.pgsMultiSource(file, refs)) {
          byTrack.set(number, { segments, compressed: false, blocks: [] });
        }
      } else {
        const onReadProgress = deps.onReadProgress;
        const data = await readPgsTracksData(
          file,
          refs.map((r) => r.number),
          onReadProgress === undefined
            ? readerOptions
            : {
                ...readerOptions,
                onProgress: (p) => onReadProgress(p.position, p.fileSize),
              },
        );
        for (const [number, entry] of data) {
          byTrack.set(number, {
            segments: entry.segments,
            compressed: entry.compressed,
            blocks: entry.blocks,
          });
        }
      }
      source = async (_file, track) => {
        const bytes = byTrack.get(track.number);
        if (!bytes) {
          throw new Error(
            `track number ${track.number} was not returned by the single-pass reader`,
          );
        }
        return bytes;
      };
    } catch (err) {
      // One bad track must not cost the whole file: fall back to per-track.
      log.warn(
        `${file}: single-pass PGS read failed (${messageOf(err)}); reading one track at a time`,
      );
    }
  }

  for (const track of pgsTracks) {
    result.tracks.push(
      await analyzeTrack(file, track, active, options, source, log),
    );
  }

  result.status = fileStatusFrom(result.tracks, active);
  return result;
}
