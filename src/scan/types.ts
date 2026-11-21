/** Result shapes produced by `scanFile` / `scanPaths`. */
import type { Bounds, Overflow, Rect } from "../geometry/rect.js";
import type { EventStatus } from "../geometry/classify.js";
import type { PositionDelta } from "../pgs/patch.js";
import type { ActiveArea } from "../video/activeArea.js";

export type FileStatus =
  | "NO_PGS"
  | "OK"
  | "NEEDS_FIX"
  | "MIXED_ASPECT_RATIO"
  | "AMBIGUOUS"
  | "ERROR";

export type TrackStatus = "OK" | "NEEDS_FIX" | "AMBIGUOUS" | "ERROR";

export type ScanErrorKind =
  | "DEPENDENCY_MISSING"
  | "NOT_FOUND"
  | "INSPECT"
  | "EXTRACT"
  | "PGS_PARSE"
  | "OTHER";

export interface ScanEventObjectReport {
  objectId: number;
  windowId: number;
  cropped: boolean;
  status: EventStatus;
  objectRect: Rect;
  visibleRect: Rect | null;
  overflow: Overflow;
  outsideAreaPercent: number;
  /** The move this object would receive, in canvas pixels. */
  proposedDelta: PositionDelta | null;
  movedForConsistency: boolean;
  notes: string[];
}

export interface ScanEventReport {
  eventIndex: number;
  displaySetIndex: number;
  compositionNumber: number;
  ptsMs: number;
  endPtsMs: number | undefined;
  forced: boolean;
  status: EventStatus;
  objects: ScanEventObjectReport[];
  /** Representative delta for the event (the largest vertical move planned). */
  proposedDelta: PositionDelta | null;
  reasons: string[];
  notes: string[];
}

export interface TrackScanResult {
  /** mkvmerge track id. */
  trackId: number;
  /** Matroska track number. */
  trackNumber: number;
  codecId: string;
  language: string;
  name: string | undefined;
  default: boolean;
  forced: boolean;
  hearingImpaired: boolean;
  status: TrackStatus;
  /** Undefined when the track was not read at all (the no-letterbox fast path). */
  eventCount: number | undefined;
  offendingEventCount: number;
  ambiguousEventCount: number;
  /**
   * Informational only: events inside the active area but within `margin` px of
   * an edge. Never counted as offending and never moved (PRD §10.3).
   */
  touchingBoundaryEventCount: number;
  /** PGS canvas declared by the stream, when known. */
  canvasWidth: number | undefined;
  canvasHeight: number | undefined;
  /** Active area mapped into canvas coordinates, when that was possible. */
  activeOnCanvas: Bounds | null;
  canvasMismatch: boolean;
  margin: number;
  /** Events needing a fix, plus any ambiguous ones, in stream order. */
  events: ScanEventReport[];
  notes: string[];
  error: string | undefined;
  errorKind: ScanErrorKind | undefined;
}

export interface ScanVideoInfo {
  width: number;
  height: number;
  codecId: string;
  displayWidth: number | undefined;
  displayHeight: number | undefined;
}

export interface FileScanResult {
  file: string;
  status: FileStatus;
  durationMs: number | undefined;
  title: string | undefined;
  video: ScanVideoInfo | null;
  activeArea: ActiveArea | null;
  tracks: TrackScanResult[];
  notes: string[];
  error: string | undefined;
  errorKind: ScanErrorKind | undefined;
}

export interface ScanSummary {
  scanned: number;
  withPgs: number;
  needFix: number;
  safe: number;
  mixedOrAmbiguous: number;
  errors: number;
}

export interface ScanRunResult {
  files: FileScanResult[];
  summary: ScanSummary;
  /** Inputs that did not resolve to a readable path. */
  missingPaths: string[];
}
