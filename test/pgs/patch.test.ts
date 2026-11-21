import { describe, expect, it } from "vitest";
import {
  BLOCK_HEADER_SIZE,
  PgsParseError,
  SEGMENT_TYPE,
  applyBytePatches,
  applyPositionDelta,
  buildDisplaySets,
  buildSup,
  displaySetSegments,
  parseBlockSegments,
  parseSupSegments,
  resolveEvents,
  serializeBlock,
  serializeSup,
  shiftDisplaySet,
  type PcsSegment,
  type SupSpec,
  type WdsSegment,
} from "../../src/pgs/index.js";

const spec: SupSpec = {
  width: 1920,
  height: 1080,
  events: [
    {
      ptsMs: 1000,
      endPtsMs: 3000,
      objects: [
        {
          objectId: 0,
          x: 500,
          y: 950,
          width: 200,
          height: 100,
          opaqueRect: { x: 10, y: 10, w: 100, h: 50 },
        },
        {
          objectId: 1,
          x: 1200,
          y: 940,
          width: 80,
          height: 60,
          windowId: 1,
        },
      ],
    },
  ],
};

describe("shiftDisplaySet", () => {
  it("moves composition objects and their windows", () => {
    const bytes = buildSup(spec);
    const sets = buildDisplaySets(parseSupSegments(bytes));
    const { segments, patches } = shiftDisplaySet(sets[0]!, 0, -150);

    const pcs = segments.find(
      (s): s is PcsSegment => s.type === SEGMENT_TYPE.PCS,
    )!;
    expect(pcs.objects.map((o) => [o.x, o.y])).toEqual([
      [500, 800],
      [1200, 790],
    ]);

    const wds = segments.find(
      (s): s is WdsSegment => s.type === SEGMENT_TYPE.WDS,
    )!;
    expect(wds.windows.map((w) => [w.windowId, w.x, w.y])).toEqual([
      [0, 500, 800],
      [1, 1200, 790],
    ]);

    // Two objects in the PCS plus two windows in the WDS.
    expect(patches).toHaveLength(4);
    expect(patches.every((p) => p.length === 4)).toBe(true);
    expect(patches.map((p) => p.offset)).toEqual(
      [...patches].map((p) => p.offset).sort((a, b) => a - b),
    );
  });

  it("keeps every segment the same size", () => {
    const bytes = buildSup(spec);
    const sets = buildDisplaySets(parseSupSegments(bytes));
    const { segments } = shiftDisplaySet(sets[0]!, -20, -150);
    const original = displaySetSegments(sets[0]!);
    expect(segments.map((s) => s.size)).toEqual(original.map((s) => s.size));
    expect(serializeSup(segments)).toHaveLength(
      serializeSup(original).length,
    );
  });

  it("produces patches that reproduce the serialized output", () => {
    const bytes = buildSup(spec);
    const allSegments = parseSupSegments(bytes);
    const sets = buildDisplaySets(allSegments);
    const { segments, patches } = shiftDisplaySet(sets[0]!, 5, -150);

    // Re-serializing the whole stream with the shifted display set spliced in
    // must equal the original bytes with the patches applied.
    const shiftedById = new Map(segments.map((s) => [s.offset, s]));
    const merged = allSegments.map((s) => shiftedById.get(s.offset) ?? s);
    expect(Buffer.from(serializeSup(merged))).toEqual(
      Buffer.from(applyBytePatches(bytes, patches)),
    );
  });

  it("moves the visible rect by exactly the delta", () => {
    const bytes = buildSup(spec);
    const allSegments = parseSupSegments(bytes);
    const sets = buildDisplaySets(allSegments);
    const before = resolveEvents(sets)[0]!;

    const { patches } = shiftDisplaySet(sets[0]!, 0, -150);
    const patched = applyBytePatches(bytes, patches);
    const after = resolveEvents(buildDisplaySets(parseSupSegments(patched)))[0]!;

    for (const [i, obj] of after.objects.entries()) {
      const wasVisible = before.objects[i]!.visibleRect!;
      expect(obj.visibleRect).toEqual({
        ...wasVisible,
        y: wasVisible.y - 150,
      });
    }
  });

  it("refuses to move a coordinate out of the u16 range", () => {
    const bytes = buildSup(spec);
    const sets = buildDisplaySets(parseSupSegments(bytes));
    expect(() => shiftDisplaySet(sets[0]!, 0, -2000)).toThrowError(
      PgsParseError,
    );
    expect(() => shiftDisplaySet(sets[0]!, 0, -2000)).toThrowError(
      /outside the u16 range/,
    );
  });
});

describe("applyPositionDelta", () => {
  it("moves only the ids it is given", () => {
    const bytes = buildSup(spec);
    const segments = parseSupSegments(bytes);
    const { segments: out, patches } = applyPositionDelta(segments, {
      objectDeltas: new Map([[1, { dx: -10, dy: -40 }]]),
    });
    const pcs = out.find((s): s is PcsSegment => s.type === SEGMENT_TYPE.PCS)!;
    expect(pcs.objects.map((o) => [o.x, o.y])).toEqual([
      [500, 950],
      [1190, 900],
    ]);
    const wds = out.find((s): s is WdsSegment => s.type === SEGMENT_TYPE.WDS)!;
    expect(wds.windows.map((w) => [w.x, w.y])).toEqual([
      [500, 950],
      [1200, 940],
    ]);
    expect(patches).toHaveLength(1);
    expect([...patches[0]!.before]).toEqual([0x04, 0xb0, 0x03, 0xac]); // 1200, 940
    expect([...patches[0]!.after]).toEqual([0x04, 0xa6, 0x03, 0x84]); // 1190, 900
  });

  it("emits no patches for zero deltas", () => {
    const segments = parseSupSegments(buildSup(spec));
    const { segments: out, patches } = applyPositionDelta(segments, {
      objectDeltas: new Map([[0, { dx: 0, dy: 0 }]]),
      windowDeltas: new Map([[0, { dx: 0, dy: 0 }]]),
    });
    expect(patches).toEqual([]);
    expect(out).toEqual(segments);
  });

  it("computes correct offsets past a cropped composition object", () => {
    const croppedSpec: SupSpec = {
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          objects: [
            {
              objectId: 0,
              x: 100,
              y: 900,
              width: 60,
              height: 40,
              crop: { x: 2, y: 2, width: 30, height: 20 },
            },
            { objectId: 1, x: 700, y: 900, width: 60, height: 40 },
          ],
        },
      ],
    };
    const bytes = buildSup(croppedSpec);
    const segments = parseSupSegments(bytes);
    const { patches } = applyPositionDelta(segments, {
      objectDeltas: new Map([[1, { dx: 1, dy: 2 }]]),
    });
    expect(patches).toHaveLength(1);
    const patched = applyBytePatches(bytes, patches);
    const pcs = parseSupSegments(patched).find(
      (s): s is PcsSegment => s.type === SEGMENT_TYPE.PCS,
    )!;
    expect(pcs.objects[0]).toMatchObject({ x: 100, y: 900, cropped: true });
    expect(pcs.objects[1]).toMatchObject({ x: 701, y: 902 });
  });

  it("patches Matroska block bytes with the 3-byte header size", () => {
    const supSegments = parseSupSegments(buildSup(spec));
    const blockBytes = serializeBlock(supSegments);
    const blockSegments = parseBlockSegments(blockBytes, 1000);
    const { segments, patches } = applyPositionDelta(
      blockSegments,
      { objectDeltas: new Map([[0, { dx: 0, dy: -100 }]]) },
      { headerSize: BLOCK_HEADER_SIZE },
    );
    const patched = applyBytePatches(blockBytes, patches);
    expect(Buffer.from(patched)).toEqual(Buffer.from(serializeBlock(segments)));
    const pcs = parseBlockSegments(patched, 1000).find(
      (s): s is PcsSegment => s.type === SEGMENT_TYPE.PCS,
    )!;
    expect(pcs.objects[0]).toMatchObject({ x: 500, y: 850 });
  });

  it("rejects patches whose precondition does not hold", () => {
    const bytes = buildSup(spec);
    const segments = parseSupSegments(bytes);
    const { patches } = applyPositionDelta(segments, {
      objectDeltas: new Map([[0, { dx: 0, dy: -100 }]]),
    });
    const tampered = bytes.slice();
    tampered[patches[0]!.offset] = tampered[patches[0]!.offset]! ^ 0xff;
    expect(() => applyBytePatches(tampered, patches)).toThrowError(
      /precondition failed/,
    );
  });
});

describe("displaySetSegments", () => {
  it("returns the display set's segments in stream order", () => {
    const bytes = buildSup(spec);
    const sets = buildDisplaySets(parseSupSegments(bytes));
    const segs = displaySetSegments(sets[0]!);
    expect(segs.map((s) => s.type)).toEqual([
      SEGMENT_TYPE.PCS,
      SEGMENT_TYPE.WDS,
      SEGMENT_TYPE.PDS,
      SEGMENT_TYPE.ODS,
      SEGMENT_TYPE.ODS,
      SEGMENT_TYPE.END,
    ]);
    expect(Buffer.from(serializeSup(segs))).toEqual(
      Buffer.from(bytes.subarray(0, segs[segs.length - 1]!.offset + 13)),
    );
  });
});
