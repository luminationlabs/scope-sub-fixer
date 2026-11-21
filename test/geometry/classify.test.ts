import { describe, expect, it } from "vitest";
import {
  classifyEvent,
  classifyEvents,
  defaultMargin,
  worstStatus,
} from "../../src/geometry/classify.js";
import type { Bounds } from "../../src/geometry/rect.js";
import { eventsFromSpec } from "../helpers/scanFixture.js";

const ACTIVE: Bounds = { top: 138, bottom: 941, left: 0, right: 1920 };

function oneEvent(objects: Parameters<typeof eventsFromSpec>[0]["events"][number]["objects"]) {
  return eventsFromSpec({
    width: 1920,
    height: 1080,
    events: [{ ptsMs: 1000, endPtsMs: 3000, objects }],
  }).events[0]!;
}

describe("defaultMargin", () => {
  it("is 24 px on a 1080-high canvas and scales with height", () => {
    expect(defaultMargin(1080)).toBe(24);
    expect(defaultMargin(2160)).toBe(48);
    expect(defaultMargin(720)).toBe(16);
  });
});

describe("classifyEvent", () => {
  it("marks a subtitle inside the active area SAFE", () => {
    const e = oneEvent([{ objectId: 0, x: 800, y: 800, width: 200, height: 60 }]);
    const c = classifyEvent(e, ACTIVE, { margin: 0 });
    expect(c.status).toBe("SAFE");
    expect(c.needsFix).toBe(false);
  });

  it("marks a subtitle straddling the bottom PARTIALLY_OUTSIDE", () => {
    const e = oneEvent([{ objectId: 0, x: 800, y: 900, width: 200, height: 100 }]);
    const c = classifyEvent(e, ACTIVE, { margin: 0 });
    expect(c.status).toBe("PARTIALLY_OUTSIDE");
    expect(c.needsFix).toBe(true);
    expect(c.objects[0]!.overflow.bottom).toBe(59);
  });

  it("marks a subtitle wholly in the bottom bar FULLY_OUTSIDE", () => {
    const e = oneEvent([{ objectId: 0, x: 800, y: 980, width: 200, height: 60 }]);
    const c = classifyEvent(e, ACTIVE, { margin: 0 });
    expect(c.status).toBe("FULLY_OUTSIDE");
    expect(c.objects[0]!.outsideAreaPercent).toBe(100);
  });

  it("marks a subtitle in the top bar FULLY_OUTSIDE", () => {
    const e = oneEvent([{ objectId: 0, x: 800, y: 20, width: 200, height: 60 }]);
    const c = classifyEvent(e, ACTIVE, { margin: 0 });
    expect(c.status).toBe("FULLY_OUTSIDE");
    expect(c.objects[0]!.overflow.top).toBe(118);
  });

  it("is SAFE exactly on the boundary with margin 0", () => {
    const e = oneEvent([{ objectId: 0, x: 800, y: 881, width: 200, height: 60 }]);
    expect(classifyEvent(e, ACTIVE, { margin: 0 }).status).toBe("SAFE");
  });

  it("is TOUCHING_BOUNDARY inside the margin, and that does NOT need a fix", () => {
    // PRD §10.3: the margin never moves a subtitle that is already inside.
    const e = oneEvent([{ objectId: 0, x: 800, y: 881, width: 200, height: 60 }]);
    const c = classifyEvent(e, ACTIVE, { margin: 8 });
    expect(c.status).toBe("TOUCHING_BOUNDARY");
    expect(c.needsFix).toBe(false);
    expect(c.touchingBoundary).toBe(true);
  });

  it("needs a fix for one pixel of real overflow, whatever the margin", () => {
    const e = oneEvent([{ objectId: 0, x: 800, y: 882, width: 200, height: 60 }]);
    for (const margin of [0, 8, 40]) {
      const c = classifyEvent(e, ACTIVE, { margin });
      expect(c.status).toBe("PARTIALLY_OUTSIDE");
      expect(c.needsFix).toBe(true);
      expect(c.touchingBoundary).toBe(false);
      expect(c.objects[0]!.overflow.bottom).toBe(1);
    }
  });

  it("leaves a comfortably inside subtitle SAFE and untouched", () => {
    const e = oneEvent([{ objectId: 0, x: 800, y: 700, width: 200, height: 60 }]);
    const c = classifyEvent(e, ACTIVE, { margin: 8 });
    expect(c.status).toBe("SAFE");
    expect(c.needsFix).toBe(false);
    expect(c.touchingBoundary).toBe(false);
  });

  it("judges the visible pixels, not the object canvas", () => {
    // A 200x200 bitmap whose opaque pixels are only its top 40 rows.
    const e = oneEvent([
      {
        objectId: 0,
        x: 800,
        y: 800,
        width: 200,
        height: 200,
        opaqueRect: { x: 0, y: 0, w: 200, h: 40 },
      },
    ]);
    const c = classifyEvent(e, ACTIVE, { margin: 0 });
    expect(c.objects[0]!.objectRect.height).toBe(200);
    expect(c.objects[0]!.visibleRect).toEqual({ x: 800, y: 800, width: 200, height: 40 });
    expect(c.status).toBe("SAFE");
  });

  it("treats a fully transparent object as SAFE and says so", () => {
    const e = oneEvent([
      {
        objectId: 0,
        x: 800,
        y: 1000,
        width: 200,
        height: 60,
        paletteIndex: 0,
        opaqueRect: { x: 0, y: 0, w: 0, h: 0 },
      },
    ]);
    const c = classifyEvent(e, ACTIVE, { margin: 0 });
    expect(c.objects[0]!.visibleRect).toBeNull();
    expect(c.objects[0]!.fullyTransparent).toBe(true);
    expect(c.status).toBe("SAFE");
    expect(c.objects[0]!.notes.join(" ")).toMatch(/no opaque pixels/);
  });

  it("marks a cropped composition object AMBIGUOUS", () => {
    const e = oneEvent([
      {
        objectId: 0,
        x: 800,
        y: 900,
        width: 200,
        height: 100,
        crop: { x: 0, y: 0, width: 100, height: 50 },
      },
    ]);
    expect(classifyEvent(e, ACTIVE, { margin: 0 }).status).toBe("AMBIGUOUS");
  });

  it("marks an event AMBIGUOUS when the canvas could not be mapped", () => {
    const e = oneEvent([{ objectId: 0, x: 800, y: 800, width: 200, height: 60 }]);
    const c = classifyEvent(e, ACTIVE, { margin: 0, canvasMismatch: true });
    expect(c.status).toBe("AMBIGUOUS");
    expect(c.notes.join(" ")).toMatch(/could not be mapped/);
  });

  it("takes the worst status across several objects", () => {
    const e = oneEvent([
      { objectId: 0, x: 100, y: 800, width: 200, height: 60, windowId: 0 },
      { objectId: 1, x: 900, y: 980, width: 200, height: 60, windowId: 1 },
    ]);
    const c = classifyEvent(e, ACTIVE, { margin: 0 });
    expect(c.objects.map((o) => o.status)).toEqual(["SAFE", "FULLY_OUTSIDE"]);
    expect(c.status).toBe("FULLY_OUTSIDE");
  });
});

describe("classifyEvents / worstStatus", () => {
  it("classifies a whole stream", () => {
    const { events } = eventsFromSpec({
      width: 1920,
      height: 1080,
      events: [
        { ptsMs: 1000, endPtsMs: 2000, objects: [{ x: 800, y: 800, width: 200, height: 60 }] },
        { ptsMs: 3000, endPtsMs: 4000, objects: [{ x: 800, y: 900, width: 200, height: 60 }] },
      ],
    });
    const classified = classifyEvents(events, ACTIVE, { margin: 0 });
    expect(classified.map((c) => c.status)).toEqual(["SAFE", "PARTIALLY_OUTSIDE"]);
  });

  it("orders severity", () => {
    expect(worstStatus(["SAFE", "TOUCHING_BOUNDARY"])).toBe("TOUCHING_BOUNDARY");
    expect(worstStatus(["FULLY_OUTSIDE", "AMBIGUOUS"])).toBe("AMBIGUOUS");
    expect(worstStatus([])).toBe("SAFE");
  });
});
