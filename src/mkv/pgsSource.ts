/**
 * How the scanner gets PGS segments out of an MKV.
 *
 * There are two implementations of this one interface: the mkvextract
 * fallback in `extract.ts`, and (later) a direct Matroska block reader. The
 * scanner only ever sees the function type, so either can be injected.
 */
import type { Segment } from "../pgs/types.js";

export interface PgsTrackRef {
  /** mkvmerge track id — what `mkvextract tracks <id>:...` expects. */
  id: number;
  /** Matroska TrackNumber — what block headers carry. */
  number: number;
}

export type PgsTrackSource = (
  file: string,
  track: PgsTrackRef,
) => Promise<Segment[]>;
