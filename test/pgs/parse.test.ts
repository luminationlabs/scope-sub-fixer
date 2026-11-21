import { describe, expect, it } from "vitest";
import {
  PgsParseError,
  SEGMENT_TYPE,
  buildSup,
  buildSupSegments,
  msToTicks,
  parseSupSegments,
  reassembleObjects,
  serializeSegment,
  serializeSup,
  ticksToMs,
  type OdsSegment,
  type PcsSegment,
  type PdsSegment,
  type Segment,
  type WdsSegment,
} from "../../src/pgs/index.js";
import { simpleSpec } from "./helpers.js";

/** Wrap a raw payload in a .sup segment header. */
function sup(type: number, payload: number[], pts = 0, dts = 0): Uint8Array {
  const out = new Uint8Array(13 + payload.length);
  const v = new DataView(out.buffer);
  out[0] = 0x50;
  out[1] = 0x47;
  v.setUint32(2, pts, false);
  v.setUint32(6, dts, false);
  out[10] = type;
  v.setUint16(11, payload.length, false);
  out.set(payload, 13);
  return out;
}

describe("parseSupSegments", () => {
  it("parses a PCS with a cropped and a forced object", () => {
    const payload = [
      0x07, 0x80, // video_width 1920
      0x04, 0x38, // video_height 1080
      0x10, // frame_rate
      0x00, 0x2a, // composition_number 42
      0x80, // composition_state epoch start
      0x80, // palette_update_flag true
      0x03, // palette_id
      0x02, // 2 composition objects
      // object 0: forced, not cropped
      0x00, 0x00, 0x01, 0x40, 0x00, 0x64, 0x03, 0x20,
      // object 1: cropped
      0x00, 0x01, 0x00, 0x80, 0x00, 0x0a, 0x00, 0x14,
      0x00, 0x01, 0x00, 0x02, 0x00, 0x30, 0x00, 0x40,
    ];
    const [seg] = parseSupSegments(sup(SEGMENT_TYPE.PCS, payload, 90_000, 45));
    expect(seg?.type).toBe(SEGMENT_TYPE.PCS);
    const pcs = seg as PcsSegment;
    expect(pcs.videoWidth).toBe(1920);
    expect(pcs.videoHeight).toBe(1080);
    expect(pcs.frameRate).toBe(0x10);
    expect(pcs.compositionNumber).toBe(42);
    expect(pcs.compositionState).toBe(0x80);
    expect(pcs.paletteUpdate).toBe(true);
    expect(pcs.paletteId).toBe(3);
    expect(pcs.pts).toBe(90_000);
    expect(pcs.dts).toBe(45);
    expect(pcs.offset).toBe(0);
    expect(pcs.size).toBe(payload.length);
    expect(pcs.objects).toHaveLength(2);
    expect(pcs.objects[0]).toMatchObject({
      objectId: 0,
      windowId: 1,
      forced: true,
      cropped: false,
      x: 100,
      y: 800,
    });
    expect(pcs.objects[1]).toMatchObject({
      objectId: 1,
      windowId: 0,
      forced: false,
      cropped: true,
      x: 10,
      y: 20,
    });
    expect(pcs.objects[1]?.crop).toEqual({
      x: 1,
      y: 2,
      width: 0x30,
      height: 0x40,
    });
  });

  it("parses a WDS with two windows", () => {
    const payload = [
      0x02,
      0x00, 0x00, 0x0a, 0x00, 0x14, 0x01, 0x00, 0x00, 0x40,
      0x01, 0x00, 0x64, 0x02, 0x00, 0x00, 0x80, 0x00, 0x20,
    ];
    const [seg] = parseSupSegments(sup(SEGMENT_TYPE.WDS, payload));
    const wds = seg as WdsSegment;
    expect(wds.windows).toEqual([
      { windowId: 0, x: 10, y: 20, width: 256, height: 64 },
      { windowId: 1, x: 100, y: 512, width: 128, height: 32 },
    ]);
  });

  it("parses a PDS", () => {
    const payload = [
      0x01, 0x02,
      0x00, 0x10, 0x80, 0x80, 0x00,
      0x01, 0xeb, 0x80, 0x80, 0xff,
    ];
    const [seg] = parseSupSegments(sup(SEGMENT_TYPE.PDS, payload));
    const pds = seg as PdsSegment;
    expect(pds.paletteId).toBe(1);
    expect(pds.paletteVersion).toBe(2);
    expect(pds.entries).toEqual([
      { entryId: 0, y: 0x10, cr: 0x80, cb: 0x80, alpha: 0 },
      { entryId: 1, y: 0xeb, cr: 0x80, cb: 0x80, alpha: 0xff },
    ]);
  });

  it("parses a single-fragment ODS", () => {
    const payload = [
      0x00, 0x05, // object_id
      0x01, // version
      0xc0, // first + last
      0x00, 0x00, 0x09, // object_data_length = 4 + 5 RLE bytes
      0x00, 0x04, // width
      0x00, 0x02, // height
      0x01, 0x00, 0x00, 0x02, 0x00,
    ];
    const [seg] = parseSupSegments(sup(SEGMENT_TYPE.ODS, payload));
    const ods = seg as OdsSegment;
    expect(ods.objectId).toBe(5);
    expect(ods.objectVersion).toBe(1);
    expect(ods.isFirst).toBe(true);
    expect(ods.isLast).toBe(true);
    expect(ods.objectDataLength).toBe(9);
    expect(ods.width).toBe(4);
    expect(ods.height).toBe(2);
    expect([...ods.rle]).toEqual([0x01, 0x00, 0x00, 0x02, 0x00]);
  });

  it("parses a continuation ODS without geometry fields", () => {
    // 0x40 is the LAST flag; a fragment without 0x40|0x80 set at all is a
    // middle fragment and equally carries no geometry.
    const payload = [0x00, 0x05, 0x01, 0x40, 0xaa, 0xbb];
    const [seg] = parseSupSegments(sup(SEGMENT_TYPE.ODS, payload));
    const ods = seg as OdsSegment;
    expect(ods.isFirst).toBe(false);
    expect(ods.isLast).toBe(true);
    expect(ods.width).toBeUndefined();
    expect(ods.objectDataLength).toBeUndefined();
    expect([...ods.rle]).toEqual([0xaa, 0xbb]);
  });

  it("parses an END segment", () => {
    const [seg] = parseSupSegments(sup(SEGMENT_TYPE.END, []));
    expect(seg?.type).toBe(SEGMENT_TYPE.END);
    expect(seg?.size).toBe(0);
  });

  it("tracks offsets across a multi-segment stream", () => {
    const bytes = buildSup(simpleSpec());
    const segments = parseSupSegments(bytes);
    let at = 0;
    for (const seg of segments) {
      expect(seg.offset).toBe(at);
      at += 13 + seg.size;
    }
    expect(at).toBe(bytes.length);
  });
});

describe("malformed input", () => {
  it("rejects bad magic with an offset", () => {
    const bytes = buildSup(simpleSpec());
    bytes[0] = 0x58;
    expect(() => parseSupSegments(bytes)).toThrowError(PgsParseError);
    try {
      parseSupSegments(bytes);
    } catch (e) {
      expect(e).toBeInstanceOf(PgsParseError);
      expect((e as PgsParseError).offset).toBe(0);
      expect((e as PgsParseError).message).toMatch(/bad magic/);
    }
  });

  it("rejects a truncated segment header", () => {
    const bytes = buildSup(simpleSpec()).slice(0, 8);
    expect(() => parseSupSegments(bytes)).toThrowError(
      /truncated segment header/,
    );
  });

  it("rejects a size that overruns the input", () => {
    const bytes = buildSup(simpleSpec());
    // Inflate the first segment's size field.
    bytes[11] = 0xff;
    bytes[12] = 0xff;
    try {
      parseSupSegments(bytes);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PgsParseError);
      expect((e as PgsParseError).offset).toBe(0);
      expect((e as PgsParseError).message).toMatch(/overruns end of input/);
    }
  });

  it("rejects a truncated payload", () => {
    // A PCS claiming one object but carrying none of its bytes.
    const payload = [
      0x07, 0x80, 0x04, 0x38, 0x10, 0x00, 0x00, 0x80, 0x00, 0x00, 0x01,
    ];
    expect(() => parseSupSegments(sup(SEGMENT_TYPE.PCS, payload))).toThrowError(
      /truncated payload/,
    );
  });

  it("rejects trailing bytes in a PCS payload", () => {
    const payload = [
      0x07, 0x80, 0x04, 0x38, 0x10, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x99,
    ];
    expect(() => parseSupSegments(sup(SEGMENT_TYPE.PCS, payload))).toThrowError(
      /trailing byte/,
    );
  });

  it("rejects a PDS whose payload is not 2 + 5n", () => {
    expect(() =>
      parseSupSegments(sup(SEGMENT_TYPE.PDS, [0x00, 0x00, 0x01, 0x02])),
    ).toThrowError(/not 2 \+ 5n/);
  });

  it("rejects a non-empty END payload", () => {
    expect(() => parseSupSegments(sup(SEGMENT_TYPE.END, [0x00]))).toThrowError(
      /empty payload/,
    );
  });

  it("rejects an unknown segment type", () => {
    expect(() => parseSupSegments(sup(0x99, []))).toThrowError(
      /unknown segment type 0x99/,
    );
  });
});

describe("timestamps", () => {
  it("round-trips between milliseconds and 90 kHz ticks", () => {
    expect(msToTicks(1000)).toBe(90_000);
    expect(ticksToMs(90_000)).toBe(1000);
    expect(ticksToMs(msToTicks(12_345.6))).toBeCloseTo(12_345.6, 1);
  });
});

describe("round trip", () => {
  const specs: Array<[string, ReturnType<typeof simpleSpec>]> = [
    ["simple single event", simpleSpec()],
    [
      "multi-object, cropped, forced, reused",
      {
        width: 3840,
        height: 2160,
        events: [
          {
            ptsMs: 1000,
            endPtsMs: 3000,
            objects: [
              { objectId: 0, x: 100, y: 1900, width: 64, height: 32 },
              {
                objectId: 1,
                x: 900,
                y: 300,
                width: 48,
                height: 40,
                windowId: 1,
                forced: true,
                crop: { x: 4, y: 4, width: 20, height: 20 },
              },
            ],
          },
          {
            ptsMs: 4000,
            endPtsMs: 5000,
            state: "normal",
            objects: [{ objectId: 0, x: 200, y: 1800, reuse: true }],
          },
        ],
      },
    ],
  ];

  for (const [name, spec] of specs) {
    it(`is byte-identical for ${name}`, () => {
      const bytes = buildSup(spec);
      const segments = parseSupSegments(bytes);
      expect(Buffer.from(serializeSup(segments))).toEqual(Buffer.from(bytes));
    });
  }

  it("re-serializes every individual segment to its original slice", () => {
    const bytes = buildSup(specs[1]![1]);
    const segments: Segment[] = parseSupSegments(bytes);
    expect(segments.length).toBeGreaterThan(5);
    for (const seg of segments) {
      const original = bytes.subarray(seg.offset, seg.offset + 13 + seg.size);
      expect(Buffer.from(serializeSegment(seg))).toEqual(
        Buffer.from(original),
      );
    }
  });

  it("keeps buildSupSegments and parseSupSegments in agreement", () => {
    const spec = specs[1]![1];
    const built = buildSupSegments(spec);
    const parsed = parseSupSegments(serializeSup(built));
    expect(parsed).toHaveLength(built.length);
    for (const [i, seg] of parsed.entries()) {
      expect(seg.offset).toBe(built[i]!.offset);
      expect(seg.size).toBe(built[i]!.size);
      expect(seg.type).toBe(built[i]!.type);
    }
  });
});

describe("ODS fragment flags (0x80 = first, 0x40 = last)", () => {
  // A 4x3 bitmap split across three fragments. Per line the RLE is
  // "1 1 1 1 <end of line>" = 0x01 0x01 0x01 0x01 0x00 0x00, 6 bytes a line,
  // 18 bytes in total, cut 8 / 6 / 4.
  const rle = [
    0x01, 0x01, 0x01, 0x01, 0x00, 0x00,
    0x01, 0x01, 0x01, 0x01, 0x00, 0x00,
    0x01, 0x01, 0x01, 0x01, 0x00, 0x00,
  ];
  const first = [
    0x00, 0x07, // object_id 7
    0x02, // version
    0x80, // FIRST, not last
    0x00, 0x00, 0x16, // object_data_length = 4 + 18
    0x00, 0x04, // width 4
    0x00, 0x03, // height 3
    ...rle.slice(0, 8),
  ];
  const middle = [0x00, 0x07, 0x02, 0x00, ...rle.slice(8, 14)];
  const last = [0x00, 0x07, 0x02, 0x40, ...rle.slice(14)];

  function fragments(): OdsSegment[] {
    const bytes = Buffer.concat([
      Buffer.from(sup(SEGMENT_TYPE.ODS, first)),
      Buffer.from(sup(SEGMENT_TYPE.ODS, middle)),
      Buffer.from(sup(SEGMENT_TYPE.ODS, last)),
    ]);
    return parseSupSegments(new Uint8Array(bytes)) as OdsSegment[];
  }

  it("parses a three-fragment object", () => {
    const ods = fragments();
    expect(ods.map((s) => [s.isFirst, s.isLast])).toEqual([
      [true, false],
      [false, false],
      [false, true],
    ]);
    // Only the first fragment carries the geometry header.
    expect(ods[0]!.width).toBe(4);
    expect(ods[0]!.height).toBe(3);
    expect(ods[0]!.objectDataLength).toBe(22);
    expect(ods[1]!.width).toBeUndefined();
    expect(ods[2]!.width).toBeUndefined();
    expect(ods.map((s) => s.rle.length)).toEqual([8, 6, 4]);
  });

  it("reassembles and decodes the three fragments", () => {
    const { objects, errors } = reassembleObjects(fragments());
    expect(errors).toEqual([]);
    expect(objects).toHaveLength(1);
    expect(objects[0]!.width).toBe(4);
    expect(objects[0]!.height).toBe(3);
    expect(objects[0]!.pixels).toHaveLength(12);
    expect(objects[0]!.warnings).toEqual([]);
  });

  it("round-trips the three fragments byte-for-byte", () => {
    const bytes = new Uint8Array(
      Buffer.concat([
        Buffer.from(sup(SEGMENT_TYPE.ODS, first)),
        Buffer.from(sup(SEGMENT_TYPE.ODS, middle)),
        Buffer.from(sup(SEGMENT_TYPE.ODS, last)),
      ]),
    );
    expect(Buffer.from(serializeSup(parseSupSegments(bytes)))).toEqual(
      Buffer.from(bytes),
    );
  });

  it("does NOT read 0x40 as a first fragment (the old, inverted mapping)", () => {
    // These are the very bytes the old code called a first fragment: flag 0x40
    // followed by the length/width/height header. Under the correct mapping
    // 0x40 is LAST-only, so nothing after the flag byte is geometry — it is
    // all RLE — and on its own the fragment has no first fragment to join.
    const oldStyleFirst = [
      0x00, 0x07,
      0x02,
      0x40, // the old "FIRST"
      0x00, 0x00, 0x16,
      0x00, 0x04,
      0x00, 0x03,
      ...rle.slice(0, 8),
    ];
    const [seg] = parseSupSegments(
      sup(SEGMENT_TYPE.ODS, oldStyleFirst),
    ) as OdsSegment[];
    expect(seg!.isFirst).toBe(false);
    expect(seg!.isLast).toBe(true);
    expect(seg!.width).toBeUndefined();
    expect(seg!.height).toBeUndefined();
    expect(seg!.objectDataLength).toBeUndefined();
    expect(seg!.rle).toHaveLength(15);

    const { objects, errors } = reassembleObjects([seg!]);
    expect(objects).toHaveLength(0);
    expect(errors[0]).toMatch(/has no first fragment/);
  });
});
