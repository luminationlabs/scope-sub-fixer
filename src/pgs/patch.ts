import { PgsParseError } from "./errors.js";
import { serializeSegmentPayload } from "./serialize.js";
import {
  SEGMENT_TYPE,
  type DisplaySet,
  type PcsSegment,
  type Segment,
  type WdsSegment,
} from "./types.js";

/** The 13-byte .sup segment header; MKV block segments use 3. */
export const SUP_HEADER_SIZE = 13;
export const BLOCK_HEADER_SIZE = 3;

export interface PositionDelta {
  dx: number;
  dy: number;
}

export interface PositionDeltas {
  /** Keyed by composition object id. */
  objectDeltas?: Map<number, PositionDelta>;
  /** Keyed by window id. */
  windowDeltas?: Map<number, PositionDelta>;
}

/** A minimal byte edit against the buffer the segments were parsed from. */
export interface BytePatch {
  offset: number;
  length: number;
  before: Uint8Array;
  after: Uint8Array;
}

export interface PatchResult {
  segments: Segment[];
  patches: BytePatch[];
}

export interface ApplyOptions {
  /**
   * Bytes between a segment's `offset` and its payload. 13 for .sup input
   * (the default), 3 for segments parsed out of a Matroska block.
   */
  headerSize?: number;
}

function u16(value: number, what: string, offset: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new PgsParseError(
      `${what} would become ${value}, outside the u16 range`,
      offset,
    );
  }
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function shiftPcs(
  seg: PcsSegment,
  deltas: Map<number, PositionDelta>,
  payloadOffset: number,
  patches: BytePatch[],
): PcsSegment {
  // PCS fixed header before the object list.
  let at = payloadOffset + 11;
  const objects = seg.objects.map((o) => {
    const fieldOffset = at + 4; // object_id u16 + window_id u8 + flags u8
    at += o.cropped ? 16 : 8;
    const d = deltas.get(o.objectId);
    if (!d || (d.dx === 0 && d.dy === 0)) return o;
    const x = o.x + d.dx;
    const y = o.y + d.dy;
    patches.push({
      offset: fieldOffset,
      length: 4,
      before: Uint8Array.of(
        (o.x >>> 8) & 0xff,
        o.x & 0xff,
        (o.y >>> 8) & 0xff,
        o.y & 0xff,
      ),
      after: Uint8Array.of(
        ...u16(x, `object ${o.objectId} x`, fieldOffset),
        ...u16(y, `object ${o.objectId} y`, fieldOffset + 2),
      ),
    });
    return { ...o, x, y };
  });
  return { ...seg, objects };
}

function shiftWds(
  seg: WdsSegment,
  deltas: Map<number, PositionDelta>,
  payloadOffset: number,
  patches: BytePatch[],
): WdsSegment {
  let at = payloadOffset + 1; // number_of_windows u8
  const windows = seg.windows.map((w) => {
    const fieldOffset = at + 1; // window_id u8
    at += 9;
    const d = deltas.get(w.windowId);
    if (!d || (d.dx === 0 && d.dy === 0)) return w;
    const x = w.x + d.dx;
    const y = w.y + d.dy;
    patches.push({
      offset: fieldOffset,
      length: 4,
      before: Uint8Array.of(
        (w.x >>> 8) & 0xff,
        w.x & 0xff,
        (w.y >>> 8) & 0xff,
        w.y & 0xff,
      ),
      after: Uint8Array.of(
        ...u16(x, `window ${w.windowId} x`, fieldOffset),
        ...u16(y, `window ${w.windowId} y`, fieldOffset + 2),
      ),
    });
    return { ...w, x, y };
  });
  return { ...seg, windows };
}

/**
 * Offset PCS object positions and WDS window positions by per-id deltas.
 * Returns a new segment array plus the byte-level edits that would produce the
 * same result against the original buffer. Segment sizes never change.
 */
export function applyPositionDelta(
  segments: Segment[],
  deltas: PositionDeltas,
  options: ApplyOptions = {},
): PatchResult {
  const headerSize = options.headerSize ?? SUP_HEADER_SIZE;
  const objectDeltas = deltas.objectDeltas ?? new Map();
  const windowDeltas = deltas.windowDeltas ?? new Map();
  const patches: BytePatch[] = [];

  const out = segments.map((seg): Segment => {
    const payloadOffset = seg.offset + headerSize;
    let next: Segment = seg;
    if (seg.type === SEGMENT_TYPE.PCS && objectDeltas.size > 0) {
      next = shiftPcs(seg, objectDeltas, payloadOffset, patches);
    } else if (seg.type === SEGMENT_TYPE.WDS && windowDeltas.size > 0) {
      next = shiftWds(seg, windowDeltas, payloadOffset, patches);
    }
    if (next !== seg) {
      const size = serializeSegmentPayload(next).length;
      if (size !== seg.size) {
        throw new PgsParseError(
          `position patch changed segment size from ${seg.size} to ${size}`,
          seg.offset,
        );
      }
    }
    return next;
  });

  patches.sort((a, b) => a.offset - b.offset);
  return { segments: out, patches };
}

/** The segments of a display set in original stream order. */
export function displaySetSegments(ds: DisplaySet): Segment[] {
  const segs: Segment[] = [ds.pcs, ...ds.pds, ...ds.ods];
  if (ds.wds) segs.push(ds.wds);
  if (ds.end) segs.push(ds.end);
  return segs.sort((a, b) => a.offset - b.offset);
}

/**
 * Move every composition object, and every window they sit in, by (dx, dy).
 * Deciding which display sets deserve moving is somebody else's job.
 */
export function shiftDisplaySet(
  ds: DisplaySet,
  dx: number,
  dy: number,
  options: ApplyOptions = {},
): PatchResult {
  const delta: PositionDelta = { dx, dy };
  const objectDeltas = new Map<number, PositionDelta>();
  const windowDeltas = new Map<number, PositionDelta>();
  for (const o of ds.pcs.objects) {
    objectDeltas.set(o.objectId, delta);
    windowDeltas.set(o.windowId, delta);
  }
  return applyPositionDelta(
    displaySetSegments(ds),
    { objectDeltas, windowDeltas },
    options,
  );
}

/** Apply byte patches to a copy of the original buffer. */
export function applyBytePatches(
  bytes: Uint8Array,
  patches: BytePatch[],
): Uint8Array {
  const out = bytes.slice();
  for (const p of patches) {
    if (p.offset + p.length > out.length) {
      throw new PgsParseError("patch extends past end of buffer", p.offset);
    }
    for (let i = 0; i < p.length; i++) {
      if (out[p.offset + i] !== p.before[i]) {
        throw new PgsParseError(
          `patch precondition failed at byte ${p.offset + i}`,
          p.offset,
        );
      }
    }
    out.set(p.after, p.offset);
  }
  return out;
}
