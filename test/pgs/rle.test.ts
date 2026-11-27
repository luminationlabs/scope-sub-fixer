import { describe, expect, it } from "vitest";
import { decodeRle, encodeRle } from "../../src/pgs/index.js";

describe("decodeRle", () => {
  it("decodes single literal pixels", () => {
    // 3 literals then end-of-line, twice.
    const data = Uint8Array.of(
      0x01, 0x02, 0x03, 0x00, 0x00,
      0x04, 0x05, 0x06, 0x00, 0x00,
    );
    const r = decodeRle(data, 3, 2);
    expect([...r.pixels]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.warnings).toEqual([]);
  });

  it("decodes a short zero run (0x00 form)", () => {
    // 4 transparent pixels, then a literal, then EOL.
    const data = Uint8Array.of(0x00, 0x04, 0x07, 0x00, 0x00);
    const r = decodeRle(data, 5, 1);
    expect([...r.pixels]).toEqual([0, 0, 0, 0, 7]);
    expect(r.warnings).toEqual([]);
  });

  it("decodes a long zero run (0x40 form)", () => {
    // ((0x01 & 0x3F) << 8) | 0x2C = 300 transparent pixels.
    const data = Uint8Array.of(0x00, 0x41, 0x2c, 0x09, 0x00, 0x00);
    const r = decodeRle(data, 301, 1);
    expect(r.pixels.subarray(0, 300).every((v) => v === 0)).toBe(true);
    expect(r.pixels[300]).toBe(9);
    expect(r.warnings).toEqual([]);
  });

  it("decodes a short coloured run (0x80 form)", () => {
    // 5 pixels of index 0x2A.
    const data = Uint8Array.of(0x00, 0x85, 0x2a, 0x00, 0x00);
    const r = decodeRle(data, 5, 1);
    expect([...r.pixels]).toEqual([0x2a, 0x2a, 0x2a, 0x2a, 0x2a]);
    expect(r.warnings).toEqual([]);
  });

  it("decodes a long coloured run (0xC0 form)", () => {
    // ((0x02 & 0x3F) << 8) | 0x00 = 512 pixels of index 0x11.
    const data = Uint8Array.of(0x00, 0xc2, 0x00, 0x11, 0x00, 0x00);
    const r = decodeRle(data, 512, 1);
    expect(r.pixels.every((v) => v === 0x11)).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("treats 0x00 0x00 as end of line and starts the next row", () => {
    const data = Uint8Array.of(0x00, 0x00, 0x01, 0x00, 0x00);
    const r = decodeRle(data, 1, 2);
    expect([...r.pixels]).toEqual([0, 1]);
    // The first line ended one pixel short.
    expect(r.warnings.some((w) => /line 0 ended/.test(w))).toBe(true);
  });

  it("clips an over-long line and warns instead of throwing", () => {
    const data = Uint8Array.of(0x00, 0x8a, 0x03, 0x00, 0x00); // 10 pixels into a width of 4
    const r = decodeRle(data, 4, 1);
    expect([...r.pixels]).toEqual([3, 3, 3, 3]);
    expect(r.warnings.some((w) => /clipped/.test(w))).toBe(true);
  });

  it("pads missing lines and warns", () => {
    const data = Uint8Array.of(0x01, 0x00, 0x00);
    const r = decodeRle(data, 1, 3);
    expect([...r.pixels]).toEqual([1, 0, 0]);
    expect(r.warnings.some((w) => /only 1 of 3 line/.test(w))).toBe(true);
  });

  it("warns on data that ends mid-run", () => {
    const data = Uint8Array.of(0x00, 0xc2); // 0xC0 form missing its operands
    const r = decodeRle(data, 4, 1);
    expect(r.warnings.some((w) => /ended mid-run/.test(w))).toBe(true);
  });
});

describe("encodeRle", () => {
  it("round-trips a transparent bitmap", () => {
    const pixels = new Uint8Array(40 * 10);
    const r = decodeRle(encodeRle(pixels, 40, 10), 40, 10);
    expect([...r.pixels]).toEqual([...pixels]);
    expect(r.warnings).toEqual([]);
  });

  it("round-trips a bitmap with margins and runs of every length", () => {
    const width = 300;
    const height = 5;
    const pixels = new Uint8Array(width * height);
    for (let x = 10; x < 290; x++) pixels[1 * width + x] = 1;
    pixels[2 * width + 0] = 2;
    pixels[2 * width + 1] = 3;
    for (let x = 0; x < width; x++) pixels[3 * width + x] = 4;
    const r = decodeRle(encodeRle(pixels, width, height), width, height);
    expect([...r.pixels]).toEqual([...pixels]);
    expect(r.warnings).toEqual([]);
  });

  it("round-trips runs longer than the 0x3F short form", () => {
    const width = 5000;
    const pixels = new Uint8Array(width);
    pixels.fill(7, 100, 4900);
    const r = decodeRle(encodeRle(pixels, width, 1), width, 1);
    expect([...r.pixels]).toEqual([...pixels]);
    expect(r.warnings).toEqual([]);
  });

  it("round-trips a checkerboard of single-pixel runs", () => {
    const width = 33;
    const height = 7;
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        pixels[y * width + x] = (x + y) % 2 === 0 ? 1 : 2;
      }
    }
    const r = decodeRle(encodeRle(pixels, width, height), width, height);
    expect([...r.pixels]).toEqual([...pixels]);
    expect(r.warnings).toEqual([]);
  });
});
