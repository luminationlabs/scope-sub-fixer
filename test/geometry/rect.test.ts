import { describe, expect, it } from "vitest";
import {
  boundsToRect,
  edgeDistances,
  intersectArea,
  isFullyOutside,
  outsideAreaPercent,
  overflow,
  rectBottom,
  rectRight,
  rectToBounds,
  translateRect,
  type Bounds,
} from "../../src/geometry/rect.js";

/** The PRD §24.2 active area for a 1920x1080 frame at 2.39:1. */
const ACTIVE: Bounds = { top: 138, bottom: 941, left: 0, right: 1920 };

describe("rect helpers", () => {
  it("computes edges and area", () => {
    const r = { x: 10, y: 20, width: 30, height: 40 };
    expect(rectRight(r)).toBe(40);
    expect(rectBottom(r)).toBe(60);
    expect(rectToBounds(r)).toEqual({ top: 20, bottom: 60, left: 10, right: 40 });
    expect(boundsToRect(rectToBounds(r))).toEqual(r);
    expect(translateRect(r, -5, 7)).toEqual({ x: 5, y: 27, width: 30, height: 40 });
  });
});

describe("overflow (PRD §24.2)", () => {
  it("reports a subtitle at y=800..900 as safe", () => {
    const o = overflow({ x: 100, y: 800, width: 400, height: 100 }, ACTIVE);
    expect(o).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it("reports 59 px of bottom overflow for y=900..1000", () => {
    const o = overflow({ x: 100, y: 900, width: 400, height: 100 }, ACTIVE);
    expect(o.bottom).toBe(59);
    expect(o.top).toBe(0);
  });

  it("reports 109 px of bottom overflow for y=950..1050", () => {
    const o = overflow({ x: 100, y: 950, width: 400, height: 100 }, ACTIVE);
    expect(o.bottom).toBe(109);
  });

  it("reports top overflow for y=20..100", () => {
    const o = overflow({ x: 100, y: 20, width: 400, height: 80 }, ACTIVE);
    expect(o.top).toBe(118);
    expect(o.bottom).toBe(0);
  });

  it("treats a subtitle exactly touching the boundary as inside", () => {
    const o = overflow({ x: 0, y: 841, width: 400, height: 100 }, ACTIVE);
    expect(o).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it("reports horizontal overflow on both sides", () => {
    const o = overflow({ x: -10, y: 200, width: 1940, height: 50 }, ACTIVE);
    expect(o.left).toBe(10);
    expect(o.right).toBe(10);
  });

  it("never returns negative pixels", () => {
    const o = overflow({ x: 500, y: 500, width: 10, height: 10 }, ACTIVE);
    expect(Object.values(o).every((v) => v >= 0)).toBe(true);
  });
});

describe("outsideAreaPercent", () => {
  it("is zero for a rect fully inside", () => {
    expect(outsideAreaPercent({ x: 0, y: 200, width: 100, height: 100 }, ACTIVE)).toBe(0);
  });

  it("is 100 for a rect fully in the bottom bar", () => {
    const r = { x: 0, y: 1000, width: 100, height: 50 };
    expect(outsideAreaPercent(r, ACTIVE)).toBe(100);
    expect(isFullyOutside(r, ACTIVE)).toBe(true);
  });

  it("is the fraction of area outside for a straddling rect", () => {
    // 100 px tall, 59 px of it below the active bottom.
    const r = { x: 0, y: 900, width: 200, height: 100 };
    expect(outsideAreaPercent(r, ACTIVE)).toBe(59);
    expect(intersectArea(r, ACTIVE)).toBe(200 * 41);
  });
});

describe("edgeDistances", () => {
  it("measures clearance from every edge", () => {
    const d = edgeDistances({ x: 8, y: 146, width: 100, height: 100 }, ACTIVE);
    expect(d.top).toBe(8);
    expect(d.bottom).toBe(695);
    expect(d.left).toBe(8);
    expect(d.right).toBe(1812);
  });
});
