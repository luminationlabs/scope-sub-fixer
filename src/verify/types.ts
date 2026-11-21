/** Result shapes produced by `verifyFile` (PRD §15). */

export interface VerifyCheck {
  /** Short stable name, e.g. "duration", "attachments", "pgs track 4". */
  name: string;
  pass: boolean;
  /** One line the operator can read. */
  detail: string;
  /** Everything that did not match, when the check failed. */
  differences?: string[];
}

export interface PgsPositionChange {
  eventIndex: number;
  ptsMs: number;
  objectId: number;
  windowId: number;
  dx: number;
  dy: number;
  /** True when the moved object now sits entirely inside the active area. */
  insideActiveArea: boolean;
}

export interface PgsTrackComparison {
  originalTrackId: number;
  fixedTrackId: number;
  language: string;
  name: string | undefined;
  /** The fixed track is an extra one appended by --keep-original-subtitle. */
  appended: boolean;
  eventCount: number;
  /** Events whose composition objects sit somewhere new. */
  changedEventCount: number;
  changes: PgsPositionChange[];
  /**
   * Events in the FIXED track still classified as needing a fix — whether or
   * not the fixer touched them.
   */
  stillOutsideCount: number;
  /**
   * How many the original's own move policy refused, and so how many are
   * expected to still be outside. More than this is a failure.
   */
  expectedStillOutsideCount: number;
  /** The events still outside, for the report. Capped at `maxChanges`. */
  stillOutside: { eventIndex: number; ptsMs: number }[];
  problems: string[];
}

export type PayloadMode = "byte-identical" | "stream-hashes" | "skipped";

export interface StreamHash {
  trackId: number;
  type: string;
  codecId: string;
  bytes: number;
  sha256: string;
}

export interface VerifyReport {
  original: string;
  fixed: string;
  pass: boolean;
  originalBytes: number;
  fixedBytes: number;
  payloadMode: PayloadMode;
  checks: VerifyCheck[];
  pgsTracks: PgsTrackComparison[];
  /** Byte ranges that differ between two same-size files. */
  differingByteRanges: number;
  differingBytes: number;
  streamHashes: { original: StreamHash[]; fixed: StreamHash[] };
  elapsedMs: number;
}
