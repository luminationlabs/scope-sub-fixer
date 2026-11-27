import { PgsParseError } from "./errors.js";
import {
  SEGMENT_TYPE,
  SEQUENCE_FLAG,
  type CompositionObject,
  type EndSegment,
  type OdsSegment,
  type PaletteEntry,
  type PcsSegment,
  type PdsSegment,
  type Segment,
  type WdsSegment,
  type WindowDefinition,
} from "./types.js";

/** 90 kHz ticks per millisecond. */
export const PTS_TICKS_PER_MS = 90;

export function ticksToMs(ticks: number): number {
  return ticks / PTS_TICKS_PER_MS;
}

export function msToTicks(ms: number): number {
  return Math.round(ms * PTS_TICKS_PER_MS);
}

/**
 * Big-endian cursor over a payload. `base` is the absolute offset of byte 0 so
 * that errors can report a position within the whole input.
 */
class Reader {
  private pos = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly base: number,
  ) {}

  get offset(): number {
    return this.base + this.pos;
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  private need(n: number, what: string): void {
    if (this.remaining < n) {
      throw new PgsParseError(
        `truncated payload: need ${n} byte(s) for ${what}, ${this.remaining} left`,
        this.offset,
      );
    }
  }

  u8(what = "u8"): number {
    this.need(1, what);
    return this.bytes[this.pos++]!;
  }

  u16(what = "u16"): number {
    this.need(2, what);
    const v = (this.bytes[this.pos]! << 8) | this.bytes[this.pos + 1]!;
    this.pos += 2;
    return v;
  }

  u24(what = "u24"): number {
    this.need(3, what);
    const v =
      (this.bytes[this.pos]! << 16) |
      (this.bytes[this.pos + 1]! << 8) |
      this.bytes[this.pos + 2]!;
    this.pos += 3;
    return v;
  }

  rest(): Uint8Array {
    const out = this.bytes.slice(this.pos);
    this.pos = this.bytes.length;
    return out;
  }

  expectEnd(what: string): void {
    if (this.remaining !== 0) {
      throw new PgsParseError(
        `${what}: ${this.remaining} unexpected trailing byte(s) in payload`,
        this.offset,
      );
    }
  }
}

function parsePcs(
  payload: Uint8Array,
  base: number,
  pts: number,
  dts: number,
  offset: number,
  size: number,
): PcsSegment {
  const r = new Reader(payload, base);
  const videoWidth = r.u16("video_width");
  const videoHeight = r.u16("video_height");
  const frameRate = r.u8("frame_rate");
  const compositionNumber = r.u16("composition_number");
  const compositionState = r.u8("composition_state");
  const paletteUpdateFlag = r.u8("palette_update_flag");
  const paletteId = r.u8("palette_id");
  const objectCount = r.u8("number_of_composition_objects");

  const objects: CompositionObject[] = [];
  for (let i = 0; i < objectCount; i++) {
    const objectId = r.u16("object_id");
    const windowId = r.u8("window_id");
    const flags = r.u8("object flags");
    const x = r.u16("object_horizontal_position");
    const y = r.u16("object_vertical_position");
    const cropped = (flags & 0x80) !== 0;
    const forced = (flags & 0x40) !== 0;
    const obj: CompositionObject = {
      objectId,
      windowId,
      flags,
      cropped,
      forced,
      x,
      y,
    };
    if (cropped) {
      obj.crop = {
        x: r.u16("crop_x"),
        y: r.u16("crop_y"),
        width: r.u16("crop_width"),
        height: r.u16("crop_height"),
      };
    }
    objects.push(obj);
  }
  r.expectEnd("PCS");

  return {
    type: SEGMENT_TYPE.PCS,
    pts,
    dts,
    offset,
    size,
    videoWidth,
    videoHeight,
    frameRate,
    compositionNumber,
    compositionState,
    paletteUpdateFlag,
    paletteUpdate: (paletteUpdateFlag & 0x80) !== 0,
    paletteId,
    objects,
  };
}

function parseWds(
  payload: Uint8Array,
  base: number,
  pts: number,
  dts: number,
  offset: number,
  size: number,
): WdsSegment {
  const r = new Reader(payload, base);
  const count = r.u8("number_of_windows");
  const windows: WindowDefinition[] = [];
  for (let i = 0; i < count; i++) {
    windows.push({
      windowId: r.u8("window_id"),
      x: r.u16("window x"),
      y: r.u16("window y"),
      width: r.u16("window width"),
      height: r.u16("window height"),
    });
  }
  r.expectEnd("WDS");
  return { type: SEGMENT_TYPE.WDS, pts, dts, offset, size, windows };
}

function parsePds(
  payload: Uint8Array,
  base: number,
  pts: number,
  dts: number,
  offset: number,
  size: number,
): PdsSegment {
  const r = new Reader(payload, base);
  const paletteId = r.u8("palette_id");
  const paletteVersion = r.u8("palette_version");
  if ((payload.length - 2) % 5 !== 0) {
    throw new PgsParseError(
      `PDS payload of ${payload.length} bytes is not 2 + 5n`,
      offset,
    );
  }
  const entries: PaletteEntry[] = [];
  const count = (payload.length - 2) / 5;
  for (let i = 0; i < count; i++) {
    entries.push({
      entryId: r.u8("entry_id"),
      y: r.u8("Y"),
      cr: r.u8("Cr"),
      cb: r.u8("Cb"),
      alpha: r.u8("alpha"),
    });
  }
  r.expectEnd("PDS");
  return {
    type: SEGMENT_TYPE.PDS,
    pts,
    dts,
    offset,
    size,
    paletteId,
    paletteVersion,
    entries,
  };
}

function parseOds(
  payload: Uint8Array,
  base: number,
  pts: number,
  dts: number,
  offset: number,
  size: number,
): OdsSegment {
  const r = new Reader(payload, base);
  const objectId = r.u16("object_id");
  const objectVersion = r.u8("object_version");
  const sequenceFlag = r.u8("last_in_sequence_flag");
  const isFirst = (sequenceFlag & SEQUENCE_FLAG.FIRST) !== 0;
  const isLast = (sequenceFlag & SEQUENCE_FLAG.LAST) !== 0;

  const seg: OdsSegment = {
    type: SEGMENT_TYPE.ODS,
    pts,
    dts,
    offset,
    size,
    objectId,
    objectVersion,
    sequenceFlag,
    isFirst,
    isLast,
    rle: new Uint8Array(0),
  };

  if (isFirst) {
    // Only the first fragment carries the length/geometry header.
    seg.objectDataLength = r.u24("object_data_length");
    seg.width = r.u16("object width");
    seg.height = r.u16("object height");
  }
  seg.rle = r.rest();
  return seg;
}

function parseEnd(
  payload: Uint8Array,
  pts: number,
  dts: number,
  offset: number,
  size: number,
): EndSegment {
  if (payload.length !== 0) {
    throw new PgsParseError(
      `END segment must have an empty payload, got ${payload.length} byte(s)`,
      offset,
    );
  }
  return { type: SEGMENT_TYPE.END, pts, dts, offset, size };
}

/** Decode one segment payload once the header has been read. */
export function parseSegmentPayload(
  segmentType: number,
  payload: Uint8Array,
  payloadOffset: number,
  pts: number,
  dts: number,
  headerOffset: number,
): Segment {
  const size = payload.length;
  switch (segmentType) {
    case SEGMENT_TYPE.PCS:
      return parsePcs(payload, payloadOffset, pts, dts, headerOffset, size);
    case SEGMENT_TYPE.WDS:
      return parseWds(payload, payloadOffset, pts, dts, headerOffset, size);
    case SEGMENT_TYPE.PDS:
      return parsePds(payload, payloadOffset, pts, dts, headerOffset, size);
    case SEGMENT_TYPE.ODS:
      return parseOds(payload, payloadOffset, pts, dts, headerOffset, size);
    case SEGMENT_TYPE.END:
      return parseEnd(payload, pts, dts, headerOffset, size);
    default:
      throw new PgsParseError(
        `unknown segment type 0x${segmentType.toString(16).padStart(2, "0")}`,
        headerOffset,
      );
  }
}

const SUP_HEADER_SIZE = 13;

/** Parse a standalone .sup byte stream (13-byte "PG" headers). */
export function parseSupSegments(bytes: Uint8Array): Segment[] {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  const segments: Segment[] = [];
  let pos = 0;

  while (pos < bytes.length) {
    if (bytes.length - pos < SUP_HEADER_SIZE) {
      throw new PgsParseError(
        `truncated segment header: ${bytes.length - pos} byte(s) left, need ${SUP_HEADER_SIZE}`,
        pos,
      );
    }
    if (bytes[pos] !== 0x50 || bytes[pos + 1] !== 0x47) {
      throw new PgsParseError(
        `bad magic: expected "PG" (0x5047), got 0x${((bytes[pos]! << 8) | bytes[pos + 1]!).toString(16).padStart(4, "0")}`,
        pos,
      );
    }
    const pts = view.getUint32(pos + 2, false);
    const dts = view.getUint32(pos + 6, false);
    const segmentType = bytes[pos + 10]!;
    const size = view.getUint16(pos + 11, false);
    const payloadStart = pos + SUP_HEADER_SIZE;
    if (payloadStart + size > bytes.length) {
      throw new PgsParseError(
        `segment size ${size} overruns end of input by ${payloadStart + size - bytes.length} byte(s)`,
        pos,
      );
    }
    const payload = bytes.subarray(payloadStart, payloadStart + size);
    segments.push(
      parseSegmentPayload(segmentType, payload, payloadStart, pts, dts, pos),
    );
    pos = payloadStart + size;
  }

  return segments;
}

/**
 * Parse the payload of one Matroska block for an S_HDMV/PGS track. The 13-byte
 * .sup header is absent there: each segment is type u8 | size u16be | payload,
 * and the block's own timestamp supplies the PTS for every segment in it.
 */
export function parseBlockSegments(
  payload: Uint8Array,
  ptsMs: number,
): Segment[] {
  const pts = msToTicks(ptsMs);
  const segments: Segment[] = [];
  let pos = 0;

  while (pos < payload.length) {
    if (payload.length - pos < 3) {
      throw new PgsParseError(
        `truncated block segment header: ${payload.length - pos} byte(s) left, need 3`,
        pos,
      );
    }
    const segmentType = payload[pos]!;
    const size = (payload[pos + 1]! << 8) | payload[pos + 2]!;
    const payloadStart = pos + 3;
    if (payloadStart + size > payload.length) {
      throw new PgsParseError(
        `segment size ${size} overruns end of block by ${payloadStart + size - payload.length} byte(s)`,
        pos,
      );
    }
    const body = payload.subarray(payloadStart, payloadStart + size);
    segments.push(
      parseSegmentPayload(segmentType, body, payloadStart, pts, 0, pos),
    );
    pos = payloadStart + size;
  }

  return segments;
}
