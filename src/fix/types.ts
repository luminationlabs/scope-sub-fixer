/** Result shapes produced by `fixFile`. */
import type { ActiveArea } from "../video/activeArea.js";
import type { TrackStatus } from "../scan/types.js";

export type FixMethod = "patch" | "remux";

export interface FixTrackResult {
  /** mkvmerge track id. */
  trackId: number;
  /** Matroska track number. */
  trackNumber: number;
  language: string;
  name: string | undefined;
  status: TrackStatus;
  eventCount: number;
  offendingEventCount: number;
  /** Events whose composition objects were moved. */
  eventsMoved: number;
  /** Display sets that received at least one edit. */
  displaySetsPatched: number;
  /** Byte edits (patch method) or rewritten position fields (remux method). */
  positionFieldsChanged: number;
  /** Bytes whose value actually changed. */
  bytesChanged: number;
  /** True when this track was rewritten in the output (or would be, in a dry run). */
  fixed: boolean;
  /** Matroska content compression, which rules out the patch method. */
  compressed: boolean;
  /** Move-plan skips: events the policy refused to touch, with the reason. */
  skipped: string[];
  notes: string[];
  error: string | undefined;
}

export interface FixTotals {
  tracksFixed: number;
  eventsMoved: number;
  displaySetsPatched: number;
  positionFieldsChanged: number;
  bytesChanged: number;
}

export interface FixResult {
  input: string;
  output: string;
  method: FixMethod;
  dryRun: boolean;
  /** True when an output file was actually produced. */
  wrote: boolean;
  keepOriginalSubtitle: boolean;
  aspect: number | "auto";
  activeArea: ActiveArea | null;
  /** Bytes of the produced output, when one was written. */
  outputBytes: number | undefined;
  inputBytes: number;
  tracks: FixTrackResult[];
  totals: FixTotals;
  notes: string[];
  elapsedMs: number;
}
