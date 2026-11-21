/** Tiny EBML writers, so the reader can be tested against handmade bytes. */

/** Encode a data vint using the shortest representation that fits. */
export function vint(value: number): Uint8Array {
  for (let length = 1; length <= 8; length++) {
    const max = 2 ** (7 * length) - 1;
    if (value < max) {
      const out = new Uint8Array(length);
      let v = value;
      for (let i = length - 1; i >= 0; i--) {
        out[i] = v % 256;
        v = Math.floor(v / 256);
      }
      out[0]! |= 0x80 >> (length - 1);
      return out;
    }
  }
  throw new Error(`vint too large: ${value}`);
}

/** The 8-byte "unknown size" encoding mkvmerge uses for streamed output. */
export const UNKNOWN_SIZE = Uint8Array.of(
  0x01,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
  0xff,
);

export function idBytes(id: number): Uint8Array {
  const bytes: number[] = [];
  let v = id;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Uint8Array.from(bytes);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One element with an explicit size. */
export function element(id: number, payload: Uint8Array): Uint8Array {
  return concat([idBytes(id), vint(payload.length), payload]);
}

/** One element with the unknown-size encoding; the payload just follows. */
export function unknownSizeElement(id: number, payload: Uint8Array): Uint8Array {
  return concat([idBytes(id), UNKNOWN_SIZE, payload]);
}

/** An unsigned-integer element payload, big-endian, minimum width. */
export function uintBytes(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v % 256);
    v = Math.floor(v / 256);
  } while (v > 0);
  return Uint8Array.from(bytes);
}

export function uintElement(id: number, value: number): Uint8Array {
  return element(id, uintBytes(value));
}

export function stringElement(id: number, value: string): Uint8Array {
  return element(id, Uint8Array.from(Buffer.from(value, "utf8")));
}

/** A SimpleBlock / Block payload: track vint, int16 relative timecode, flags. */
export function blockPayload(
  trackNumber: number,
  relativeTimecode: number,
  flags: number,
  data: Uint8Array,
): Uint8Array {
  const rel = new Uint8Array(2);
  new DataView(rel.buffer).setInt16(0, relativeTimecode, false);
  return concat([vint(trackNumber), rel, Uint8Array.of(flags), data]);
}
