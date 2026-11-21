/**
 * Fabricate the analyzer's own structures without touching a filesystem, so
 * the batch decision table can be exercised as a pure function.
 */
import { classifyEvents, defaultMargin } from "../../src/geometry/classify.js";
import { planMoves } from "../../src/geometry/policy.js";
import type { Bounds } from "../../src/geometry/rect.js";
import { buildDisplaySets, buildEpochs, resolveEvents } from "../../src/pgs/compose.js";
import { buildSup, type SupSpec } from "../../src/pgs/fixtures.js";
import { parseSupSegments } from "../../src/pgs/parse.js";
import type { PgsBlockRecord } from "../../src/mkv/pgsBlocks.js";
import type { MkvSubtitleTrack } from "../../src/mkv/inspect.js";
import type { FileAnalysis, TrackAnalysis } from "../../src/scan/analyze.js";
import type { FileStatus, TrackStatus } from "../../src/scan/types.js";
import { activeAreaFromAspect, type ActiveArea } from "../../src/video/activeArea.js";

export const SCOPE_SPEC: SupSpec = {
  width: 1920,
  height: 1080,
  events: [
    { ptsMs: 1000, endPtsMs: 1800, objects: [{ x: 860, y: 700, width: 200, height: 60 }] },
    { ptsMs: 2000, endPtsMs: 2800, objects: [{ x: 860, y: 900, width: 200, height: 100 }] },
    { ptsMs: 3000, endPtsMs: 3800, objects: [{ x: 860, y: 980, width: 200, height: 60 }] },
    { ptsMs: 4000, endPtsMs: 4800, objects: [{ x: 860, y: 20, width: 200, height: 60 }] },
  ],
};

export const SAFE_SPEC: SupSpec = {
  width: 1920,
  height: 1080,
  events: [
    { ptsMs: 1000, endPtsMs: 1800, objects: [{ x: 860, y: 700, width: 200, height: 60 }] },
    { ptsMs: 2000, endPtsMs: 2800, objects: [{ x: 700, y: 640, width: 400, height: 80 }] },
  ],
};

export function subtitleTrack(overrides: Partial<MkvSubtitleTrack> = {}): MkvSubtitleTrack {
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
    ...overrides,
  };
}

/** A block that covers every offset a fixture's patches could land on. */
export function wholeFileBlock(
  overrides: Partial<PgsBlockRecord> = {},
): PgsBlockRecord {
  return {
    trackNumber: 2,
    timestampMs: 0,
    fileOffset: 0,
    fileLength: 1 << 24,
    clusterOffset: 0,
    clusterHasCrc: false,
    ...overrides,
  };
}

export interface FakeTrackOptions {
  spec?: SupSpec;
  aspect?: number;
  compressed?: boolean;
  blocks?: PgsBlockRecord[];
  status?: TrackStatus;
  error?: string;
  track?: Partial<MkvSubtitleTrack>;
  /** Skip the move plan entirely, as an AMBIGUOUS track would. */
  noPlan?: boolean;
}

/**
 * Run the same steps `analyzeTrack` runs — parse, resolve, classify, plan —
 * over a synthetic .sup, and present the result as a `TrackAnalysis`.
 */
export function fakeTrackAnalysis(options: FakeTrackOptions = {}): TrackAnalysis {
  const spec = options.spec ?? SCOPE_SPEC;
  const aspect = options.aspect ?? 2.39;
  const segments = parseSupSegments(buildSup(spec));
  const displaySets = buildDisplaySets(segments);
  const epochByDisplaySet = new Map<number, number>();
  for (const epoch of buildEpochs(displaySets)) {
    for (const ds of epoch.displaySets) epochByDisplaySet.set(ds.index, epoch.index);
  }
  const events = resolveEvents(displaySets);
  const epochIds = events.map((e) => epochByDisplaySet.get(e.displaySetIndex) ?? e.index);
  const area = activeAreaFromAspect(spec.width, spec.height, aspect);
  const bounds: Bounds = {
    top: area.top,
    bottom: area.bottom,
    left: area.left,
    right: area.right,
  };
  const margin = defaultMargin(spec.height);
  const classified = classifyEvents(events, bounds, { margin });
  const plan = options.noPlan
    ? null
    : planMoves(events, bounds, {
        margin,
        epochIds,
        canvasWidth: spec.width,
        canvasHeight: spec.height,
      });
  const offending = classified.filter((c) => c.needsFix).length;
  const ambiguous = classified.filter((c) => c.status === "AMBIGUOUS").length;
  const touching = classified.filter((c) => c.touchingBoundary).length;

  return {
    track: subtitleTrack(options.track ?? {}),
    status:
      options.status ??
      (offending > 0 ? "NEEDS_FIX" : ambiguous > 0 ? "AMBIGUOUS" : "OK"),
    segments,
    displaySets,
    epochByDisplaySet,
    events,
    epochIds,
    canvasWidth: spec.width,
    canvasHeight: spec.height,
    bounds: options.noPlan ? null : bounds,
    canvasMismatch: false,
    margin,
    classified,
    plan,
    offendingEventCount: offending,
    ambiguousEventCount: ambiguous,
    touchingBoundaryEventCount: touching,
    compressed: options.compressed === true,
    eventsRead: true,
    blocks: options.blocks ?? [wholeFileBlock()],
    notes: [],
    error: options.error,
    errorKind: options.error === undefined ? undefined : "OTHER",
  };
}

export interface FakeFileOptions {
  file?: string;
  status?: FileStatus;
  tracks?: TrackAnalysis[];
  activeArea?: ActiveArea | null;
  notes?: string[];
  error?: string;
}

export function fakeFileAnalysis(options: FakeFileOptions = {}): FileAnalysis {
  const tracks = options.tracks ?? [fakeTrackAnalysis()];
  const active =
    options.activeArea === undefined
      ? activeAreaFromAspect(1920, 1080, 2.39)
      : options.activeArea;
  return {
    file: options.file ?? "/movies/Scope (2024).mkv",
    status:
      options.status ??
      (tracks.some((t) => t.status === "NEEDS_FIX") ? "NEEDS_FIX" : "OK"),
    info: null,
    durationMs: 7200000,
    title: undefined,
    video: {
      width: 1920,
      height: 1080,
      codecId: "V_MPEG4/ISO/AVC",
      displayWidth: undefined,
      displayHeight: undefined,
    },
    activeArea: active,
    tracks,
    notes: options.notes ?? [],
    error: options.error,
    errorKind: options.error === undefined ? undefined : "OTHER",
  };
}
