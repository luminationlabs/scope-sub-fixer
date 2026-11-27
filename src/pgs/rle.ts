/**
 * PGS object bitmap RLE.
 *
 * Per line, read byte C:
 *   C != 0                       -> one pixel of palette index C
 *   C == 0, then L:
 *     L == 0                     -> end of line
 *     (L & 0xC0) == 0x00         -> (L & 0x3F) pixels of index 0
 *     (L & 0xC0) == 0x40         -> ((L & 0x3F) << 8 | next) pixels of index 0
 *     (L & 0xC0) == 0x80         -> (L & 0x3F) pixels of index `next`
 *     (L & 0xC0) == 0xC0         -> ((L & 0x3F) << 8 | next) pixels of index `next2`
 */

export interface RleDecodeResult {
  width: number;
  height: number;
  /** width * height palette indices, row-major. */
  pixels: Uint8Array;
  /** Non-fatal issues: short/long lines, missing lines, truncated data. */
  warnings: string[];
}

/**
 * Decode RLE data into a width * height index bitmap.
 *
 * Deliberately tolerant: over-long lines are clipped, short lines are padded
 * with index 0, and truncated input stops decoding. Each case is recorded as a
 * warning instead of throwing, because a single bad object should not sink a
 * whole scan.
 */
export function decodeRle(
  data: Uint8Array,
  width: number,
  height: number,
): RleDecodeResult {
  const pixels = new Uint8Array(width * height);
  const warnings: string[] = [];
  let pos = 0;
  let y = 0;
  let x = 0;
  let clipped = 0;
  let truncated = false;

  const put = (index: number, count: number): void => {
    if (y >= height) {
      clipped += count;
      return;
    }
    let n = count;
    if (x + n > width) {
      clipped += x + n - width;
      n = Math.max(0, width - x);
    }
    if (index !== 0 && n > 0) pixels.fill(index, y * width + x, y * width + x + n);
    x += n;
  };

  while (pos < data.length) {
    const c = data[pos++]!;
    if (c !== 0) {
      put(c, 1);
      continue;
    }
    if (pos >= data.length) {
      truncated = true;
      break;
    }
    const l = data[pos++]!;
    if (l === 0) {
      // End of line.
      if (y < height && x < width) {
        warnings.push(`line ${y} ended ${width - x} pixel(s) short; padded`);
      }
      y++;
      x = 0;
      continue;
    }
    const mode = l & 0xc0;
    const low = l & 0x3f;
    if (mode === 0x00) {
      put(0, low);
    } else if (mode === 0x40) {
      if (pos >= data.length) {
        truncated = true;
        break;
      }
      put(0, (low << 8) | data[pos++]!);
    } else if (mode === 0x80) {
      if (pos >= data.length) {
        truncated = true;
        break;
      }
      put(data[pos++]!, low);
    } else {
      if (pos + 1 >= data.length) {
        truncated = true;
        break;
      }
      const count = (low << 8) | data[pos++]!;
      put(data[pos++]!, count);
    }
  }

  if (truncated) warnings.push("RLE data ended mid-run; remaining pixels padded");
  if (clipped > 0) {
    warnings.push(`${clipped} pixel(s) beyond the ${width}x${height} bitmap were clipped`);
  }
  if (y < height) {
    warnings.push(`only ${y} of ${height} line(s) decoded; remainder padded`);
  } else if (y > height) {
    warnings.push(`${y} line(s) decoded for a ${height}-line bitmap`);
  }

  return { width, height, pixels, warnings };
}

/**
 * Encode an index bitmap to PGS RLE. Straightforward run-length coding: correct
 * and compact enough for fixtures, not tuned for size.
 */
export function encodeRle(
  pixels: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const out: number[] = [];

  const emitRun = (index: number, count: number): void => {
    let left = count;
    while (left > 0) {
      if (index !== 0 && left < 3) {
        // Short coloured runs are cheaper as literals.
        for (let i = 0; i < left; i++) out.push(index);
        left = 0;
        break;
      }
      const n = Math.min(left, 0x3fff);
      if (index === 0) {
        if (n <= 0x3f) out.push(0x00, n);
        else out.push(0x00, 0x40 | (n >> 8), n & 0xff);
      } else {
        if (n <= 0x3f) out.push(0x00, 0x80 | n, index);
        else out.push(0x00, 0xc0 | (n >> 8), n & 0xff, index);
      }
      left -= n;
    }
  };

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let x = 0;
    while (x < width) {
      const v = pixels[row + x]!;
      let run = 1;
      while (x + run < width && pixels[row + x + run] === v) run++;
      emitRun(v, run);
      x += run;
    }
    out.push(0x00, 0x00); // end of line
  }

  return Uint8Array.from(out);
}
