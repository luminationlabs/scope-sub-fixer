import type { SupSpec } from "../../src/pgs/index.js";

/** One 1920x1080 event: a 200x60 subtitle sitting low in the frame. */
export function simpleSpec(): SupSpec {
  return {
    width: 1920,
    height: 1080,
    events: [
      {
        ptsMs: 1000,
        endPtsMs: 3000,
        objects: [{ objectId: 0, x: 860, y: 950, width: 200, height: 60 }],
      },
    ],
  };
}
