/**
 * The read-only analyzer (PRD §11): inspect an MKV, work out the active
 * picture area, and classify every PGS event against it.
 *
 * The work itself lives in `analyze.ts`, which `fix` shares; this module only
 * shapes the analysis into the report structures.
 */
import type { ClassifiedEvent } from "../geometry/classify.js";
import type { MovePlan, MovePlanEntry } from "../geometry/policy.js";
import type { PositionDelta } from "../pgs/patch.js";
import type { PgsEvent } from "../pgs/types.js";
import {
  analyzeFile,
  type FileAnalysis,
  type ScanDeps,
  type ScanOptions,
  type TrackAnalysis,
} from "./analyze.js";
import type {
  FileScanResult,
  ScanEventObjectReport,
  ScanEventReport,
  TrackScanResult,
} from "./types.js";

export type { ScanDeps, ScanOptions };

/** Largest-magnitude vertical move planned for an event, for reporting. */
function representativeDelta(entry: MovePlanEntry | undefined): PositionDelta | null {
  if (!entry) return null;
  let best: PositionDelta | null = null;
  for (const d of entry.objectDeltas.values()) {
    if (!best || Math.abs(d.dy) > Math.abs(best.dy)) best = d;
  }
  return best;
}

function buildEventReport(
  event: PgsEvent,
  classified: ClassifiedEvent,
  entry: MovePlanEntry | undefined,
  skipReasons: string[],
): ScanEventReport {
  const objects: ScanEventObjectReport[] = classified.objects.map((o) => {
    const detail = entry?.objects.find((d) => d.objectId === o.objectId);
    return {
      objectId: o.objectId,
      windowId: o.windowId,
      cropped: o.cropped,
      status: o.status,
      objectRect: o.objectRect,
      visibleRect: o.visibleRect,
      overflow: o.overflow,
      outsideAreaPercent: o.outsideAreaPercent,
      proposedDelta: detail ? detail.delta : null,
      movedForConsistency: detail?.movedForConsistency ?? false,
      notes: o.notes,
    };
  });

  return {
    eventIndex: classified.index,
    displaySetIndex: classified.displaySetIndex,
    compositionNumber: classified.compositionNumber,
    ptsMs: classified.ptsMs,
    endPtsMs: classified.endPtsMs,
    forced: event.forced,
    status: classified.status,
    objects,
    proposedDelta: representativeDelta(entry),
    reasons: [...(entry?.reasons ?? []), ...skipReasons],
    notes: classified.notes,
  };
}

/** Index a plan's entries and skip reasons by event index. */
function indexPlan(plan: MovePlan | null): {
  entryByEvent: Map<number, MovePlanEntry>;
  skipsByEvent: Map<number, string[]>;
} {
  const entryByEvent = new Map<number, MovePlanEntry>();
  const skipsByEvent = new Map<number, string[]>();
  for (const e of plan?.entries ?? []) entryByEvent.set(e.eventIndex, e);
  for (const s of plan?.skipped ?? []) {
    const list = skipsByEvent.get(s.eventIndex) ?? [];
    list.push(s.reason);
    skipsByEvent.set(s.eventIndex, list);
  }
  return { entryByEvent, skipsByEvent };
}

export function toTrackScanResult(analysis: TrackAnalysis): TrackScanResult {
  const t = analysis.track;
  const result: TrackScanResult = {
    trackId: t.id,
    trackNumber: t.number,
    codecId: t.codecId,
    language: t.language,
    name: t.name,
    default: t.default,
    forced: t.forced,
    hearingImpaired: t.hearingImpaired,
    status: analysis.status,
    eventCount: analysis.eventsRead ? analysis.events.length : undefined,
    offendingEventCount: analysis.offendingEventCount,
    ambiguousEventCount: analysis.ambiguousEventCount,
    touchingBoundaryEventCount: analysis.touchingBoundaryEventCount,
    canvasWidth: analysis.canvasWidth,
    canvasHeight: analysis.canvasHeight,
    activeOnCanvas: analysis.bounds,
    canvasMismatch: analysis.canvasMismatch,
    margin: analysis.margin,
    events: [],
    notes: analysis.notes,
    error: analysis.error,
    errorKind: analysis.errorKind,
  };
  if (analysis.status === "ERROR") {
    result.eventCount = 0;
    return result;
  }

  const { entryByEvent, skipsByEvent } = indexPlan(analysis.plan);
  for (let i = 0; i < analysis.classified.length; i++) {
    const c = analysis.classified[i]!;
    const entry = entryByEvent.get(c.index);
    // Report anything the operator would want to look at: offending events,
    // ambiguous ones, and any event a window move drags along.
    if (!c.needsFix && c.status !== "AMBIGUOUS" && !entry) continue;
    result.events.push(
      buildEventReport(analysis.events[i]!, c, entry, skipsByEvent.get(c.index) ?? []),
    );
  }
  return result;
}

export function toFileScanResult(analysis: FileAnalysis): FileScanResult {
  return {
    file: analysis.file,
    status: analysis.status,
    durationMs: analysis.durationMs,
    title: analysis.title,
    video: analysis.video,
    activeArea: analysis.activeArea,
    tracks: analysis.tracks.map(toTrackScanResult),
    notes: analysis.notes,
    error: analysis.error,
    errorKind: analysis.errorKind,
  };
}

/** Scan a single MKV. Never throws for per-file problems; they land in the result. */
export async function scanFile(
  file: string,
  options: ScanOptions,
  deps: ScanDeps = {},
): Promise<FileScanResult> {
  return toFileScanResult(await analyzeFile(file, options, deps));
}
