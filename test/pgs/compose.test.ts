import { describe, expect, it } from "vitest";
import {
  SEGMENT_TYPE,
  buildDisplaySets,
  buildEpochs,
  buildSup,
  buildSupSegments,
  parseBlockSegments,
  parseSupSegments,
  reassembleObjects,
  fillSizesAndOffsets,
  resolveEvents,
  serializeBlock,
  serializeSup,
  type OdsSegment,
  type SupSpec,
} from "../../src/pgs/index.js";
import { MIN_VISIBLE_ALPHA } from "../../src/pgs/compose.js";
import { simpleSpec } from "./helpers.js";

function eventsFor(spec: SupSpec) {
  return resolveEvents(buildDisplaySets(parseSupSegments(buildSup(spec))));
}

describe("buildDisplaySets", () => {
  it("groups a PCS through its END segment", () => {
    const sets = buildDisplaySets(parseSupSegments(buildSup(simpleSpec())));
    expect(sets).toHaveLength(2); // the event plus its clearing set
    const [first, clear] = sets;
    expect(first?.pcs.objects).toHaveLength(1);
    expect(first?.wds?.windows).toHaveLength(1);
    expect(first?.pds).toHaveLength(1);
    expect(first?.ods).toHaveLength(1);
    expect(first?.end?.type).toBe(SEGMENT_TYPE.END);
    expect(first?.ptsMs).toBe(1000);
    expect(clear?.pcs.objects).toHaveLength(0);
    expect(clear?.ptsMs).toBe(3000);
    expect(clear?.index).toBe(1);
  });

  it("ignores segments that precede the first PCS", () => {
    const segments = parseSupSegments(buildSup(simpleSpec()));
    const stray = segments.find((s) => s.type === SEGMENT_TYPE.PDS)!;
    const sets = buildDisplaySets([stray, ...segments]);
    expect(sets).toHaveLength(2);
    expect(sets[0]?.pds).toHaveLength(1);
  });
});

describe("buildEpochs", () => {
  it("starts a new epoch at each epoch-start PCS", () => {
    const spec: SupSpec = {
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          endPtsMs: 2000,
          objects: [{ objectId: 0, x: 10, y: 900, width: 16, height: 8 }],
        },
        {
          ptsMs: 3000,
          state: "acquisitionPoint",
          objects: [{ objectId: 0, x: 20, y: 900, width: 16, height: 8 }],
        },
        {
          ptsMs: 4000,
          endPtsMs: 5000,
          state: "epochStart",
          objects: [{ objectId: 0, x: 30, y: 900, width: 16, height: 8 }],
        },
      ],
    };
    const sets = buildDisplaySets(parseSupSegments(buildSup(spec)));
    const epochs = buildEpochs(sets);
    expect(epochs).toHaveLength(2);
    // event 1 + its clear + the acquisition-point set
    expect(epochs[0]?.displaySets).toHaveLength(3);
    expect(epochs[0]?.startDisplaySetIndex).toBe(0);
    expect(epochs[1]?.displaySets).toHaveLength(2);
    expect(epochs[1]?.startDisplaySetIndex).toBe(3);
  });

  it("wraps leading display sets in an implicit epoch", () => {
    const sets = buildDisplaySets(parseSupSegments(buildSup(simpleSpec())));
    sets[0]!.pcs = { ...sets[0]!.pcs, compositionState: 0x00 };
    const epochs = buildEpochs(sets);
    expect(epochs).toHaveLength(1);
    expect(epochs[0]?.displaySets).toHaveLength(2);
  });
});

describe("resolveEvents", () => {
  it("reports geometry, timing and the forced flag", () => {
    const events = eventsFor({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 12_500,
          endPtsMs: 15_000,
          objects: [
            { objectId: 0, x: 860, y: 950, width: 200, height: 60, forced: true },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.index).toBe(0);
    expect(ev.displaySetIndex).toBe(0);
    expect(ev.offset).toBe(0);
    expect(ev.compositionNumber).toBe(0);
    expect(ev.pts90k).toBe(12_500 * 90);
    expect(ev.ptsMs).toBe(12_500);
    expect(ev.endPtsMs).toBe(15_000);
    expect(ev.videoWidth).toBe(1920);
    expect(ev.videoHeight).toBe(1080);
    expect(ev.forced).toBe(true);
    expect(ev.errors).toEqual([]);
    expect(ev.objects[0]).toMatchObject({
      objectId: 0,
      windowId: 0,
      x: 860,
      y: 950,
      width: 200,
      height: 60,
      cropped: false,
    });
    expect(ev.objects[0]?.window).toEqual({
      x: 860,
      y: 950,
      width: 200,
      height: 60,
    });
    expect(ev.objects[0]?.objectRect).toEqual({
      x: 860,
      y: 950,
      width: 200,
      height: 60,
    });
  });

  it("leaves endPtsMs undefined for the last display set", () => {
    const events = eventsFor({
      width: 1920,
      height: 1080,
      events: [
        { ptsMs: 1000, objects: [{ x: 0, y: 0, width: 8, height: 8 }] },
      ],
    });
    expect(events[0]?.endPtsMs).toBeUndefined();
  });

  it("does not treat a screen-clearing display set as an event", () => {
    const events = eventsFor(simpleSpec());
    expect(events).toHaveLength(1);
    expect(events[0]?.endPtsMs).toBe(3000);
  });

  it("resolves multiple objects in one composition", () => {
    const events = eventsFor({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          endPtsMs: 2000,
          objects: [
            { objectId: 0, x: 100, y: 900, width: 40, height: 20, windowId: 0 },
            { objectId: 1, x: 800, y: 100, width: 60, height: 30, windowId: 1 },
          ],
        },
      ],
    });
    const ev = events[0]!;
    expect(ev.objects).toHaveLength(2);
    expect(ev.objects.map((o) => o.objectId)).toEqual([0, 1]);
    expect(ev.objects[0]?.window).toEqual({
      x: 100,
      y: 900,
      width: 40,
      height: 20,
    });
    expect(ev.objects[1]?.window).toEqual({
      x: 800,
      y: 100,
      width: 60,
      height: 30,
    });
    expect(ev.forced).toBe(false);
  });
});

describe("visibleRect", () => {
  it("tightens to the opaque pixels when the object has transparent margins", () => {
    const events = eventsFor({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          endPtsMs: 2000,
          objects: [
            {
              objectId: 0,
              x: 500,
              y: 900,
              width: 200,
              height: 100,
              opaqueRect: { x: 20, y: 30, w: 60, h: 40 },
            },
          ],
        },
      ],
    });
    expect(events[0]?.objects[0]?.visibleRect).toEqual({
      x: 520,
      y: 930,
      width: 60,
      height: 40,
    });
    // The declared object rect stays the full canvas.
    expect(events[0]?.objects[0]?.objectRect).toEqual({
      x: 500,
      y: 900,
      width: 200,
      height: 100,
    });
  });

  it("returns null for a fully transparent object", () => {
    const events = eventsFor({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          endPtsMs: 2000,
          objects: [
            {
              objectId: 0,
              x: 500,
              y: 900,
              width: 64,
              height: 32,
              opaqueRect: { x: 0, y: 0, w: 0, h: 0 },
            },
          ],
        },
      ],
    });
    expect(events[0]?.objects[0]?.visibleRect).toBeNull();
  });

  it("ignores a near-transparent fill, as in a full-frame object around the text", () => {
    // Avatar (2009): the whole 1920x1080 canvas at alpha ~1, the text opaque.
    const fullFrame = (fillAlpha: number) =>
      eventsFor({
        width: 1920,
        height: 1080,
        palette: [
          { entryId: 0, y: 16, cr: 128, cb: 128, alpha: fillAlpha },
          { entryId: 1, y: 235, cr: 128, cb: 128, alpha: 255 },
        ],
        events: [
          {
            ptsMs: 1000,
            endPtsMs: 2000,
            objects: [
              {
                objectId: 0,
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
                opaqueRect: { x: 630, y: 820, w: 660, h: 80 },
              },
            ],
          },
        ],
      })[0]?.objects[0]?.visibleRect;
    const text = { x: 630, y: 820, width: 660, height: 80 };
    expect(fullFrame(1)).toEqual(text);
    expect(fullFrame(MIN_VISIBLE_ALPHA - 1)).toEqual(text);
    // At the threshold the fill is drawn, and so is the whole frame.
    expect(fullFrame(MIN_VISIBLE_ALPHA)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it("returns null when every opaque index has alpha 0", () => {
    const events = eventsFor({
      width: 1920,
      height: 1080,
      palette: [
        { entryId: 0, y: 16, cr: 128, cb: 128, alpha: 0 },
        { entryId: 1, y: 235, cr: 128, cb: 128, alpha: 0 },
      ],
      events: [
        {
          ptsMs: 1000,
          endPtsMs: 2000,
          objects: [{ objectId: 0, x: 10, y: 20, width: 32, height: 16 }],
        },
      ],
    });
    expect(events[0]?.objects[0]?.visibleRect).toBeNull();
  });

  it("measures a cropped object against its crop rect", () => {
    const events = eventsFor({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          endPtsMs: 2000,
          objects: [
            {
              objectId: 0,
              x: 400,
              y: 800,
              width: 100,
              height: 100,
              // Opaque from (10,10) to (89,89) in object space.
              opaqueRect: { x: 10, y: 10, w: 80, h: 80 },
              // Crop keeps object rows/cols 20..69.
              crop: { x: 20, y: 20, width: 50, height: 50 },
            },
          ],
        },
      ],
    });
    const obj = events[0]!.objects[0]!;
    expect(obj.cropped).toBe(true);
    // Rendered size comes from the crop rect.
    expect(obj.width).toBe(50);
    expect(obj.height).toBe(50);
    expect(obj.objectRect).toEqual({ x: 400, y: 800, width: 50, height: 50 });
    // Every pixel inside the crop window is opaque here.
    expect(obj.visibleRect).toEqual({
      x: 400,
      y: 800,
      width: 50,
      height: 50,
    });
  });

  it("offsets a cropped object's visible rect when the crop includes margin", () => {
    const events = eventsFor({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          endPtsMs: 2000,
          objects: [
            {
              objectId: 0,
              x: 400,
              y: 800,
              width: 100,
              height: 100,
              opaqueRect: { x: 40, y: 50, w: 10, h: 10 },
              crop: { x: 30, y: 30, width: 60, height: 60 },
            },
          ],
        },
      ],
    });
    expect(events[0]?.objects[0]?.visibleRect).toEqual({
      x: 400 + (40 - 30),
      y: 800 + (50 - 30),
      width: 10,
      height: 10,
    });
  });
});

describe("epoch semantics", () => {
  it("resolves a normal display set against objects from the epoch start", () => {
    const events = eventsFor({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          objects: [
            {
              objectId: 7,
              x: 100,
              y: 900,
              width: 40,
              height: 20,
              windowId: 3,
              opaqueRect: { x: 5, y: 5, w: 10, h: 10 },
            },
          ],
        },
        {
          ptsMs: 2000,
          endPtsMs: 3000,
          state: "normal",
          objects: [
            { objectId: 7, x: 500, y: 400, windowId: 3, reuse: true },
          ],
        },
      ],
    });
    expect(events).toHaveLength(2);
    const later = events[1]!;
    expect(later.errors).toEqual([]);
    expect(later.objects[0]?.width).toBe(40);
    expect(later.objects[0]?.height).toBe(20);
    // The window persists from the epoch-start WDS.
    expect(later.objects[0]?.window).toEqual({
      x: 100,
      y: 900,
      width: 40,
      height: 20,
    });
    expect(later.objects[0]?.visibleRect).toEqual({
      x: 505,
      y: 405,
      width: 10,
      height: 10,
    });
  });

  it("records an error when a normal set references an undefined object", () => {
    const events = eventsFor({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          state: "normal",
          objects: [{ objectId: 9, x: 10, y: 20, reuse: true }],
        },
      ],
    });
    const ev = events[0]!;
    expect(ev.errors).toContain("object 9 referenced but never defined");
    expect(ev.errors).toContain("window 0 referenced but never defined");
    expect(ev.objects[0]?.visibleRect).toBeNull();
    expect(ev.objects[0]?.window).toBeNull();
  });

  it("drops epoch state at the next epoch start", () => {
    const events = eventsFor({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          objects: [{ objectId: 4, x: 0, y: 0, width: 16, height: 16 }],
        },
        {
          ptsMs: 2000,
          state: "epochStart",
          objects: [{ objectId: 5, x: 0, y: 0, width: 16, height: 16 }],
        },
        {
          ptsMs: 3000,
          state: "normal",
          objects: [{ objectId: 4, x: 0, y: 0, reuse: true }],
        },
      ],
    });
    expect(events[2]?.errors).toContain("object 4 referenced but never defined");
  });

  it("records an error for a palette that is never defined", () => {
    const events = eventsFor({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          paletteId: 2,
          emitPalette: false,
          objects: [{ objectId: 0, x: 0, y: 0, width: 16, height: 16 }],
        },
      ],
    });
    expect(events[0]?.errors).toContain(
      "palette 2 referenced but never defined",
    );
    expect(events[0]?.objects[0]?.visibleRect).toBeNull();
  });

  it("replaces the palette on every PDS, the way ffmpeg's decoder does", () => {
    const segments = buildSupSegments({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          objects: [{ objectId: 0, x: 40, y: 900, width: 16, height: 16 }],
        },
        {
          ptsMs: 2000,
          state: "normal",
          emitPalette: true,
          objects: [{ objectId: 0, x: 40, y: 900, reuse: true }],
        },
      ],
    });
    // The second display set's PDS lists an entry the bitmap does not use and
    // omits the one it does. pgssubdec clears the palette before applying a
    // PDS, so the omitted index is transparent from here on — a merging
    // decoder would keep it opaque and see the object.
    const pdsSegments = segments.filter((s) => s.type === SEGMENT_TYPE.PDS);
    expect(pdsSegments).toHaveLength(2);
    const update = pdsSegments[1]!;
    update.entries = [{ entryId: 5, y: 235, cr: 128, cb: 128, alpha: 255 }];
    update.paletteVersion = 1;

    const events = resolveEvents(
      buildDisplaySets(fillSizesAndOffsets(segments)),
    );
    expect(events).toHaveLength(2);
    expect(events[0]?.objects[0]?.visibleRect).toEqual({
      x: 40,
      y: 900,
      width: 16,
      height: 16,
    });
    expect(events[1]?.objects[0]?.visibleRect).toBeNull();
  });
});

describe("ODS fragmentation", () => {
  // Noise defeats run-length compression, so the RLE is far over 64 KB.
  const spec: SupSpec = {
    width: 1920,
    height: 1080,
    events: [
      {
        ptsMs: 1000,
        endPtsMs: 4000,
        objects: [
          { objectId: 0, x: 10, y: 600, width: 1900, height: 400, noise: true },
        ],
      },
    ],
  };

  it("splits a large object across several ODS segments", () => {
    const segments = parseSupSegments(buildSup(spec));
    const ods = segments.filter(
      (s): s is OdsSegment => s.type === SEGMENT_TYPE.ODS,
    );
    expect(ods.length).toBeGreaterThan(1);
    expect(ods.every((s) => s.size <= 0xffff)).toBe(true);
    expect(ods[0]?.isFirst).toBe(true);
    expect(ods[0]?.isLast).toBe(false);
    expect(ods[0]?.width).toBe(1900);
    expect(ods[0]?.height).toBe(400);
    expect(ods.at(-1)?.isLast).toBe(true);
    // Only the first fragment carries geometry.
    for (const seg of ods.slice(1)) {
      expect(seg.isFirst).toBe(false);
      expect(seg.width).toBeUndefined();
    }
    // object_data_length covers width + height + every RLE byte.
    const totalRle = ods.reduce((n, s) => n + s.rle.length, 0);
    expect(ods[0]?.objectDataLength).toBe(4 + totalRle);
  });

  it("reassembles and decodes the fragmented object", () => {
    const sets = buildDisplaySets(parseSupSegments(buildSup(spec)));
    const { objects, errors } = reassembleObjects(sets[0]!.ods);
    expect(errors).toEqual([]);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.width).toBe(1900);
    expect(objects[0]?.height).toBe(400);
    expect(objects[0]?.pixels).toHaveLength(1900 * 400);
    expect(objects[0]?.warnings).toEqual([]);
    // The checkerboard survives reassembly.
    expect(objects[0]?.pixels[0]).toBe(1);
    expect(objects[0]?.pixels[1]).toBe(2);
    expect(objects[0]?.pixels[1900]).toBe(2);
  });

  it("gives the fragmented object the full visible rect", () => {
    const events = eventsFor(spec);
    expect(events[0]?.objects[0]?.visibleRect).toEqual({
      x: 10,
      y: 600,
      width: 1900,
      height: 400,
    });
  });

  it("round-trips a fragmented stream byte-for-byte", () => {
    const bytes = buildSup(spec);
    const segments = parseSupSegments(bytes);
    // `equals`, not `toEqual`: a deep comparison of two large buffers is slow
    // enough to time out when the machine is busy with the integration tests.
    expect(Buffer.from(serializeSup(segments)).equals(Buffer.from(bytes))).toBe(true);
  }, 30000);
});

describe("reassembleObjects", () => {
  it("reports a continuation fragment with no first fragment", () => {
    const sets = buildDisplaySets(
      parseSupSegments(
        buildSup({
          width: 1920,
          height: 1080,
          events: [
            {
              ptsMs: 1000,
              objects: [
                { objectId: 0, x: 0, y: 0, width: 900, height: 400, noise: true },
              ],
            },
          ],
        }),
      ),
    );
    const ods = sets[0]!.ods;
    expect(ods.length).toBeGreaterThan(1);
    const { errors } = reassembleObjects(ods.slice(1));
    expect(errors[0]).toMatch(/has no first fragment/);
  });

  it("reports an unterminated fragment sequence", () => {
    const sets = buildDisplaySets(
      parseSupSegments(
        buildSup({
          width: 1920,
          height: 1080,
          events: [
            {
              ptsMs: 1000,
              objects: [
                { objectId: 0, x: 0, y: 0, width: 900, height: 400, noise: true },
              ],
            },
          ],
        }),
      ),
    );
    const { errors } = reassembleObjects(sets[0]!.ods.slice(0, 1));
    expect(errors[0]).toMatch(/never terminated/);
  });
});

describe("parseBlockSegments", () => {
  it("matches parseSupSegments for the same display set", () => {
    const spec: SupSpec = {
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 2500,
          objects: [
            {
              objectId: 0,
              x: 300,
              y: 940,
              width: 120,
              height: 48,
              forced: true,
              opaqueRect: { x: 4, y: 4, w: 20, h: 12 },
            },
          ],
        },
      ],
    };
    const supBytes = buildSup(spec);
    const supSegments = parseSupSegments(supBytes);
    const blockBytes = serializeBlock(supSegments);
    const blockSegments = parseBlockSegments(blockBytes, 2500);

    expect(blockSegments).toHaveLength(supSegments.length);
    for (const [i, seg] of blockSegments.entries()) {
      const original = supSegments[i]!;
      expect(seg.type).toBe(original.type);
      expect(seg.size).toBe(original.size);
      expect(seg.pts).toBe(original.pts);
      // Offsets differ (no 13-byte headers) but everything else must match.
      const { offset: _a, dts: _b, ...rest } = seg;
      const { offset: _c, dts: _d, ...originalRest } = original;
      expect(rest).toEqual(originalRest);
    }

    const supEvents = resolveEvents(buildDisplaySets(supSegments));
    const blockEvents = resolveEvents(buildDisplaySets(blockSegments));
    expect(blockEvents).toHaveLength(1);
    expect(blockEvents[0]?.objects[0]?.visibleRect).toEqual(
      supEvents[0]?.objects[0]?.visibleRect,
    );
    expect(blockEvents[0]?.ptsMs).toBe(2500);
    expect(blockEvents[0]?.forced).toBe(true);
  });

  it("rejects a truncated block", () => {
    const bytes = serializeBlock(parseSupSegments(buildSup(simpleSpec())));
    expect(() => parseBlockSegments(bytes.slice(0, 5), 0)).toThrowError(
      /overruns end of block/,
    );
  });
});
