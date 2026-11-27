import { PgsParseError } from "./errors.js";
import { SEGMENT_TYPE, type Segment } from "./types.js";

/** Growable big-endian byte writer. */
class Writer {
  private buf = new Uint8Array(256);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
  }

  u16(v: number): void {
    this.ensure(2);
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }

  u24(v: number): void {
    this.ensure(3);
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }

  u32(v: number): void {
    this.ensure(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  take(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** Serialize just the payload of a segment (no 13-byte header). */
export function serializeSegmentPayload(seg: Segment): Uint8Array {
  const w = new Writer();
  switch (seg.type) {
    case SEGMENT_TYPE.PCS: {
      w.u16(seg.videoWidth);
      w.u16(seg.videoHeight);
      w.u8(seg.frameRate);
      w.u16(seg.compositionNumber);
      w.u8(seg.compositionState);
      w.u8(seg.paletteUpdateFlag);
      w.u8(seg.paletteId);
      w.u8(seg.objects.length);
      for (const o of seg.objects) {
        w.u16(o.objectId);
        w.u8(o.windowId);
        w.u8(o.flags);
        w.u16(o.x);
        w.u16(o.y);
        if (o.cropped) {
          if (!o.crop) {
            throw new PgsParseError(
              `composition object ${o.objectId} is flagged cropped but has no crop rect`,
              seg.offset,
            );
          }
          w.u16(o.crop.x);
          w.u16(o.crop.y);
          w.u16(o.crop.width);
          w.u16(o.crop.height);
        }
      }
      break;
    }
    case SEGMENT_TYPE.WDS: {
      w.u8(seg.windows.length);
      for (const win of seg.windows) {
        w.u8(win.windowId);
        w.u16(win.x);
        w.u16(win.y);
        w.u16(win.width);
        w.u16(win.height);
      }
      break;
    }
    case SEGMENT_TYPE.PDS: {
      w.u8(seg.paletteId);
      w.u8(seg.paletteVersion);
      for (const e of seg.entries) {
        w.u8(e.entryId);
        w.u8(e.y);
        w.u8(e.cr);
        w.u8(e.cb);
        w.u8(e.alpha);
      }
      break;
    }
    case SEGMENT_TYPE.ODS: {
      w.u16(seg.objectId);
      w.u8(seg.objectVersion);
      w.u8(seg.sequenceFlag);
      if (seg.isFirst) {
        if (
          seg.objectDataLength === undefined ||
          seg.width === undefined ||
          seg.height === undefined
        ) {
          throw new PgsParseError(
            `ODS ${seg.objectId} first fragment is missing length/width/height`,
            seg.offset,
          );
        }
        w.u24(seg.objectDataLength);
        w.u16(seg.width);
        w.u16(seg.height);
      }
      w.bytes(seg.rle);
      break;
    }
    case SEGMENT_TYPE.END:
      break;
  }
  return w.take();
}

/** Serialize one segment including its 13-byte .sup header. */
export function serializeSegment(seg: Segment): Uint8Array {
  const payload = serializeSegmentPayload(seg);
  if (payload.length > 0xffff) {
    throw new PgsParseError(
      `segment payload of ${payload.length} bytes exceeds the u16 size field`,
      seg.offset,
    );
  }
  const w = new Writer();
  w.u8(0x50); // 'P'
  w.u8(0x47); // 'G'
  w.u32(seg.pts >>> 0);
  w.u32(seg.dts >>> 0);
  w.u8(seg.type);
  w.u16(payload.length);
  w.bytes(payload);
  return w.take();
}

/** Serialize a segment in the header-less Matroska block form. */
export function serializeBlockSegment(seg: Segment): Uint8Array {
  const payload = serializeSegmentPayload(seg);
  const w = new Writer();
  w.u8(seg.type);
  w.u16(payload.length);
  w.bytes(payload);
  return w.take();
}

/** Serialize a whole segment list back into a .sup byte stream. */
export function serializeSup(segments: Segment[]): Uint8Array {
  const parts = segments.map(serializeSegment);
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Serialize a display set's segments into one Matroska block payload. */
export function serializeBlock(segments: Segment[]): Uint8Array {
  const parts = segments.map(serializeBlockSegment);
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
