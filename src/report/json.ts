/**
 * Machine-readable scan report. The core shape is PRD §11.6, extended with the
 * fields the analyzer actually knows: both track identifiers, statuses, the
 * active-area provenance, per-object geometry and the proposed deltas.
 *
 * Nothing time- or environment-dependent goes in, so two runs over the same
 * input produce byte-identical JSON.
 */
import type { Rect } from "../geometry/rect.js";
import type {
  FileScanResult,
  ScanEventReport,
  ScanRunResult,
  TrackScanResult,
} from "../scan/types.js";
import type { ActiveArea } from "../video/activeArea.js";
import { formatTimestamp } from "./format.js";
import { TOOL_NAME, TOOL_VERSION } from "./version.js";

export interface JsonReportOptions {
  aspect: number | "auto";
  /** Include every reported event rather than the first `maxEvents`. */
  showEvents?: boolean;
  maxEvents?: number;
  marginOverride?: number | undefined;
}

function rectJson(r: Rect) {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function activeAreaJson(active: ActiveArea | null) {
  if (!active) return null;
  return {
    source: active.source,
    classification: active.classification,
    target_aspect_ratio: active.aspect,
    top: active.top,
    bottom: active.bottom,
    left: active.left,
    right: active.right,
    active_rect: rectJson({
      x: active.left,
      y: active.top,
      width: active.right - active.left,
      height: active.bottom - active.top,
    }),
    tolerance_px: active.tolerancePx ?? null,
    sample_count: active.samples?.length ?? null,
    usable_sample_count: active.samples?.filter((s) => s.used).length ?? null,
    clusters:
      active.clusters?.map((c) => ({
        top: c.top,
        bottom: c.bottom,
        count: c.count,
        timestamps: c.timestampsMs.map(formatTimestamp),
        timestamps_ms: c.timestampsMs,
      })) ?? null,
    pillarbox: active.pillarbox ?? null,
    // How the edges were picked: what most samples showed (`modal`) against
    // what was used (`chosen`), plus every distinct edge and its agreement.
    estimate: active.estimate
      ? {
          modal: active.estimate.modal,
          chosen: active.estimate.chosen,
          tops: active.estimate.tops,
          bottoms: active.estimate.bottoms,
        }
      : null,
    notes: active.notes,
  };
}

function eventJson(event: ScanEventReport) {
  return {
    event_index: event.eventIndex,
    display_set_index: event.displaySetIndex,
    composition_number: event.compositionNumber,
    timestamp: formatTimestamp(event.ptsMs),
    pts_ms: event.ptsMs,
    end_pts_ms: event.endPtsMs ?? null,
    forced: event.forced,
    status: event.status,
    proposed_offset: event.proposedDelta
      ? { x: event.proposedDelta.dx, y: event.proposedDelta.dy }
      : null,
    reasons: event.reasons,
    notes: event.notes,
    objects: event.objects.map((o) => ({
      object_id: o.objectId,
      window_id: o.windowId,
      cropped: o.cropped,
      status: o.status,
      original_rect: rectJson(o.objectRect),
      visible_rect: o.visibleRect ? rectJson(o.visibleRect) : null,
      overflow: o.overflow,
      outside_area_percent: o.outsideAreaPercent,
      proposed_offset: o.proposedDelta
        ? { x: o.proposedDelta.dx, y: o.proposedDelta.dy }
        : null,
      moved_for_consistency: o.movedForConsistency,
      notes: o.notes,
    })),
  };
}

function trackJson(track: TrackScanResult, options: JsonReportOptions) {
  const limit = options.showEvents ? track.events.length : (options.maxEvents ?? 10);
  const events = track.events.slice(0, limit);
  return {
    track_id: track.trackId,
    mkvmerge_track_id: track.trackId,
    matroska_track_number: track.trackNumber,
    codec: track.codecId,
    language: track.language,
    name: track.name ?? null,
    default: track.default,
    forced: track.forced,
    hearing_impaired: track.hearingImpaired,
    status: track.status,
    event_count: track.eventCount ?? null,
    offending_event_count: track.offendingEventCount,
    ambiguous_event_count: track.ambiguousEventCount,
    // Informational: inside the active area, within the margin of an edge.
    // Never part of offending_event_count and never moved (PRD §10.3).
    touching_boundary_event_count: track.touchingBoundaryEventCount,
    canvas: {
      width: track.canvasWidth ?? null,
      height: track.canvasHeight ?? null,
      mismatch: track.canvasMismatch,
    },
    active_on_canvas: track.activeOnCanvas,
    margin_px: track.margin,
    events: events.map(eventJson),
    events_truncated: track.events.length > events.length,
    reported_event_count: track.events.length,
    notes: track.notes,
    error: track.error ?? null,
    error_kind: track.errorKind ?? null,
  };
}

export function fileJson(file: FileScanResult, options: JsonReportOptions) {
  return {
    file: file.file,
    status: file.status,
    title: file.title ?? null,
    duration_ms: file.durationMs ?? null,
    video: file.video
      ? {
          width: file.video.width,
          height: file.video.height,
          codec_id: file.video.codecId,
          display_width: file.video.displayWidth ?? null,
          display_height: file.video.displayHeight ?? null,
        }
      : null,
    active_area: activeAreaJson(file.activeArea),
    subtitle_tracks: file.tracks.map((t) => trackJson(t, options)),
    notes: file.notes,
    error: file.error ?? null,
    error_kind: file.errorKind ?? null,
  };
}

export function buildJsonReport(run: ScanRunResult, options: JsonReportOptions) {
  return {
    tool: { name: TOOL_NAME, version: TOOL_VERSION },
    options: {
      aspect: options.aspect,
      margin_px: options.marginOverride ?? null,
      max_events: options.showEvents ? null : (options.maxEvents ?? 10),
    },
    files: run.files.map((f) => fileJson(f, options)),
    summary: {
      scanned: run.summary.scanned,
      with_pgs: run.summary.withPgs,
      need_repair: run.summary.needFix,
      already_safe: run.summary.safe,
      mixed_or_ambiguous: run.summary.mixedOrAmbiguous,
      errors: run.summary.errors,
    },
    missing_paths: run.missingPaths,
  };
}

export function formatJsonReport(
  run: ScanRunResult,
  options: JsonReportOptions,
): string {
  return JSON.stringify(buildJsonReport(run, options), null, 2) + "\n";
}
