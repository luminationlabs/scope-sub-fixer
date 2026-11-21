import { describe, expect, it } from "vitest";
import { scaleActiveAreaToCanvas } from "../../src/geometry/canvas.js";
import { activeAreaFromAspect } from "../../src/video/activeArea.js";

describe("scaleActiveAreaToCanvas", () => {
  it("passes the area through unchanged when the canvas matches the frame", () => {
    const active = activeAreaFromAspect(1920, 1080, 2.39);
    const scaled = scaleActiveAreaToCanvas(active, 1920, 1080);
    expect(scaled.status).toBe("OK");
    if (scaled.status !== "OK") return;
    expect(scaled.identity).toBe(true);
    expect(scaled).toMatchObject({ top: 138, bottom: 941, left: 0, right: 1920 });
  });

  it("scales a 1080p PGS canvas onto a 2160p video proportionally", () => {
    const active = activeAreaFromAspect(3840, 2160, 2.39);
    const scaled = scaleActiveAreaToCanvas(active, 1920, 1080);
    expect(scaled.status).toBe("OK");
    if (scaled.status !== "OK") return;
    expect(scaled.identity).toBe(false);
    expect(scaled.scaleX).toBeCloseTo(0.5);
    expect(scaled.top).toBe(Math.round(active.top / 2));
    expect(scaled.bottom).toBe(Math.round(active.bottom / 2));
    expect(scaled.right).toBe(1920);
  });

  it("scales a 2160p canvas onto 1080p video", () => {
    const active = activeAreaFromAspect(1920, 1080, 2.39);
    const scaled = scaleActiveAreaToCanvas(active, 3840, 2160);
    expect(scaled.status).toBe("OK");
    if (scaled.status !== "OK") return;
    expect(scaled.top).toBe(276);
    expect(scaled.bottom).toBe(1882);
  });

  it("flags a canvas whose aspect ratio differs as CANVAS_MISMATCH", () => {
    const active = activeAreaFromAspect(1920, 1080, 2.39);
    const scaled = scaleActiveAreaToCanvas(active, 1920, 1440);
    expect(scaled.status).toBe("CANVAS_MISMATCH");
    if (scaled.status !== "CANVAS_MISMATCH") return;
    expect(scaled.message).toMatch(/does not.*match/);
  });

  it("tolerates a sub-0.5% aspect difference", () => {
    const active = activeAreaFromAspect(1920, 1080, 2.39);
    // 1918x1080 is 0.1% off 16:9.
    expect(scaleActiveAreaToCanvas(active, 1918, 1080).status).toBe("OK");
  });

  it("rejects a zero-sized canvas", () => {
    const active = activeAreaFromAspect(1920, 1080, 2.39);
    expect(scaleActiveAreaToCanvas(active, 0, 0).status).toBe("CANVAS_MISMATCH");
  });
});
