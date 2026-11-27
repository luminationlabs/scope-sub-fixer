import { describe, expect, it } from "vitest";
import { applyPlanToDisplaySets, positionFields, rewriteSegments } from "../../src/fix/patchPlan.js";
import { planMoves } from "../../src/geometry/policy.js";
import { buildDisplaySets, buildEpochs, resolveEvents } from "../../src/pgs/compose.js";
import { buildSup, type SupSpec } from "../../src/pgs/fixtures.js";
import { parseSupSegments } from "../../src/pgs/parse.js";
import { applyBytePatches, SUP_HEADER_SIZE } from "../../src/pgs/patch.js";
import { serializeSup } from "../../src/pgs/serialize.js";
import { SEGMENT_TYPE } from "../../src/pgs/types.js";
import type { Bounds } from "../../src/geometry/rect.js";

/** The active picture of a 2.39:1 image inside a 1920x1080 frame. */
const ACTIVE: Bounds = { top: 138, bottom: 942, left: 0, right: 1920 };

function analyze(spec: SupSpec) {
  const bytes = buildSup(spec);
  const segments = parseSupSegments(bytes);
  const displaySets = buildDisplaySets(segments);
  const epochByDisplaySet = new Map<number, number>();
  for (const epoch of buildEpochs(displaySets)) {
    for (const ds of epoch.displaySets) epochByDisplaySet.set(ds.index, epoch.index);
  }
  const events = resolveEvents(displaySets);
  const epochIds = events.map((e) => epochByDisplaySet.get(e.displaySetIndex) ?? e.index);
  const plan = planMoves(events, ACTIVE, {
    margin: 0,
    epochIds,
    canvasWidth: spec.width,
    canvasHeight: spec.height,
  });
  return { bytes, segments, displaySets, epochByDisplaySet, events, plan };
}

describe("applyPlanToDisplaySets", () => {
  it("patches the PCS and the WDS of a single offending display set", () => {
    const a = analyze({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          endPtsMs: 3000,
          objects: [{ x: 860, y: 900, width: 200, height: 100 }],
        },
      ],
    });
    expect(a.plan.entries).toHaveLength(1);

    const applied = applyPlanToDisplaySets(
      a.displaySets,
      a.epochByDisplaySet,
      a.plan,
      SUP_HEADER_SIZE,
    );
    // One PCS object field plus one WDS window field.
    expect(applied.patches).toHaveLength(2);
    expect(applied.eventsMoved).toBe(1);
    expect(applied.displaySetsTouched).toBe(1);

    const patched = parseSupSegments(applyBytePatches(a.bytes, applied.patches));
    const pcs = patched.find((s) => s.type === SEGMENT_TYPE.PCS)!;
    const wds = patched.find((s) => s.type === SEGMENT_TYPE.WDS)!;
    // The visible bottom was 1000, the active bottom 942: everything moves -58.
    expect(pcs.objects[0]!.y).toBe(900 - 58);
    expect(wds.windows[0]!.y).toBe(900 - 58);
    expect(pcs.objects[0]!.x).toBe(860);
  });

  it("moves a normal-case display set that carries no WDS of its own", () => {
    const a = analyze({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          state: "epochStart",
          objects: [{ objectId: 0, x: 860, y: 900, width: 200, height: 100 }],
        },
        {
          // Same epoch, no WDS and no PDS: only the PCS carries a position.
          ptsMs: 3000,
          endPtsMs: 5000,
          state: "normal",
          objects: [{ objectId: 0, x: 860, y: 900, width: 200, height: 100, reuse: true }],
        },
      ],
    });
    const applied = applyPlanToDisplaySets(
      a.displaySets,
      a.epochByDisplaySet,
      a.plan,
      SUP_HEADER_SIZE,
    );
    expect(applied.eventsMoved).toBe(2);

    const patched = parseSupSegments(applyBytePatches(a.bytes, applied.patches));
    const pcsSegments = patched.filter((s) => s.type === SEGMENT_TYPE.PCS);
    const withObjects = pcsSegments.filter((s) => s.objects.length > 0);
    expect(withObjects).toHaveLength(2);
    for (const pcs of withObjects) expect(pcs.objects[0]!.y).toBe(842);
    // Only one WDS exists in the epoch and it moved with them.
    const wds = patched.filter((s) => s.type === SEGMENT_TYPE.WDS);
    expect(wds).toHaveLength(1);
    expect(wds[0]!.windows[0]!.y).toBe(842);
  });

  it("moves only the offending window of a two-window epoch", () => {
    const a = analyze({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          endPtsMs: 3000,
          objects: [
            { objectId: 0, windowId: 0, x: 100, y: 200, width: 200, height: 60 },
            { objectId: 1, windowId: 1, x: 860, y: 900, width: 200, height: 100 },
          ],
          windows: [
            { windowId: 0, x: 100, y: 200, width: 200, height: 60 },
            { windowId: 1, x: 860, y: 900, width: 200, height: 100 },
          ],
        },
      ],
    });
    const applied = applyPlanToDisplaySets(
      a.displaySets,
      a.epochByDisplaySet,
      a.plan,
      SUP_HEADER_SIZE,
    );
    const patched = parseSupSegments(applyBytePatches(a.bytes, applied.patches));
    const pcs = patched.find((s) => s.type === SEGMENT_TYPE.PCS)!;
    const wds = patched.find((s) => s.type === SEGMENT_TYPE.WDS)!;
    expect(pcs.objects[0]!.y).toBe(200);
    expect(pcs.objects[1]!.y).toBe(842);
    expect(wds.windows[0]!.y).toBe(200);
    expect(wds.windows[1]!.y).toBe(842);
  });

  it("plans nothing when every event is already inside", () => {
    const a = analyze({
      width: 1920,
      height: 1080,
      events: [
        { ptsMs: 1000, endPtsMs: 3000, objects: [{ x: 860, y: 800, width: 200, height: 60 }] },
      ],
    });
    const applied = applyPlanToDisplaySets(
      a.displaySets,
      a.epochByDisplaySet,
      a.plan,
      SUP_HEADER_SIZE,
    );
    expect(applied.patches).toHaveLength(0);
    expect(applied.displaySetsTouched).toBe(0);
  });

  it("keeps the .sup byte-identical apart from the position fields", () => {
    const a = analyze({
      width: 1920,
      height: 1080,
      events: [
        { ptsMs: 1000, endPtsMs: 3000, objects: [{ x: 860, y: 900, width: 200, height: 100 }] },
      ],
    });
    const applied = applyPlanToDisplaySets(
      a.displaySets,
      a.epochByDisplaySet,
      a.plan,
      SUP_HEADER_SIZE,
    );
    const viaSegments = serializeSup(rewriteSegments(a.segments, applied));
    const viaPatches = applyBytePatches(a.bytes, applied.patches);
    expect(Buffer.from(viaSegments)).toEqual(Buffer.from(viaPatches));
    expect(viaSegments.length).toBe(a.bytes.length);
  });
});

describe("positionFields", () => {
  it("locates every composition-object and window position", () => {
    const a = analyze({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          endPtsMs: 3000,
          objects: [
            { objectId: 0, windowId: 0, x: 100, y: 200, width: 200, height: 60 },
            { objectId: 1, windowId: 1, x: 860, y: 900, width: 200, height: 100 },
          ],
          windows: [
            { windowId: 0, x: 100, y: 200, width: 200, height: 60 },
            { windowId: 1, x: 860, y: 900, width: 200, height: 100 },
          ],
        },
      ],
    });
    const fields = positionFields(a.segments, SUP_HEADER_SIZE);
    // Two objects + two windows, plus the clearing display set's (empty) PCS.
    expect(fields.filter((f) => f.kind === "object")).toHaveLength(2);
    expect(fields.filter((f) => f.kind === "window")).toHaveLength(2);
    for (const f of fields) {
      const view = new DataView(a.bytes.buffer, a.bytes.byteOffset);
      expect(view.getUint16(f.offset)).toBe(f.x);
      expect(view.getUint16(f.offset + 2)).toBe(f.y);
    }
  });
});
