/**
 * What `verify` says about events that are still outside the active area.
 *
 * The rule: count every event the fixed track still classifies as needing a
 * fix — not only the ones the fixer moved — and hold that against the number
 * the original's own move policy refused. More than that is a real failure;
 * exactly that is the policy working as designed.
 */
import { describe, expect, it } from "vitest";
import { comparePgsTracks } from "../../src/verify/pgs.js";
import type { SupSpec } from "../../src/pgs/fixtures.js";
import { fakeTrackAnalysis, SAFE_SPEC, SCOPE_SPEC } from "../batch/support.js";

/** SCOPE_SPEC with every offending event already moved back inside. */
const FIXED_SPEC: SupSpec = {
  width: 1920,
  height: 1080,
  events: [
    { ptsMs: 1000, endPtsMs: 1800, objects: [{ x: 860, y: 700, width: 200, height: 60 }] },
    { ptsMs: 2000, endPtsMs: 2800, objects: [{ x: 860, y: 833, width: 200, height: 100 }] },
    { ptsMs: 3000, endPtsMs: 3800, objects: [{ x: 860, y: 873, width: 200, height: 60 }] },
    { ptsMs: 4000, endPtsMs: 4800, objects: [{ x: 860, y: 146, width: 200, height: 60 }] },
  ],
};

/** One object taller than the whole active area: the policy always refuses it. */
const UNFIXABLE_SPEC: SupSpec = {
  width: 1920,
  height: 1080,
  events: [
    { ptsMs: 1000, endPtsMs: 1800, objects: [{ x: 100, y: 100, width: 200, height: 900 }] },
  ],
};

describe("comparePgsTracks", () => {
  it("counts a repaired track as nothing left outside", () => {
    const c = comparePgsTracks(
      fakeTrackAnalysis({ spec: SCOPE_SPEC }),
      fakeTrackAnalysis({ spec: FIXED_SPEC }),
    );
    expect(c.problems).toEqual([]);
    expect(c.changedEventCount).toBe(3);
    expect(c.stillOutsideCount).toBe(0);
    expect(c.expectedStillOutsideCount).toBe(0);
  });

  it("counts events the fixer never touched, not only the moved ones", () => {
    // The "fixed" file is the original: nothing moved, so the old count (which
    // only looked at moved objects) was 0 while three events are still in the
    // bar. Nothing was expected to be refused, so this is a failure.
    const c = comparePgsTracks(
      fakeTrackAnalysis({ spec: SCOPE_SPEC }),
      fakeTrackAnalysis({ spec: SCOPE_SPEC }),
    );
    expect(c.changedEventCount).toBe(0);
    expect(c.stillOutsideCount).toBe(3);
    expect(c.expectedStillOutsideCount).toBe(0);
    expect(c.stillOutside.map((e) => e.eventIndex)).toEqual([1, 2, 3]);
  });

  it("expects exactly the events the move policy refused", () => {
    const c = comparePgsTracks(
      fakeTrackAnalysis({ spec: UNFIXABLE_SPEC }),
      fakeTrackAnalysis({ spec: UNFIXABLE_SPEC }),
    );
    expect(c.stillOutsideCount).toBe(1);
    expect(c.expectedStillOutsideCount).toBe(1);
    expect(c.stillOutside[0]!.ptsMs).toBe(1000);
  });

  it("expects nothing outside for a track that never needed a fix", () => {
    const c = comparePgsTracks(
      fakeTrackAnalysis({ spec: SAFE_SPEC }),
      fakeTrackAnalysis({ spec: SAFE_SPEC }),
    );
    expect(c.stillOutsideCount).toBe(0);
    expect(c.expectedStillOutsideCount).toBe(0);
  });

  it("expects everything to stay put in the preserved half of an A/B pair", () => {
    const c = comparePgsTracks(
      fakeTrackAnalysis({ spec: SCOPE_SPEC }),
      fakeTrackAnalysis({ spec: SCOPE_SPEC }),
      { preserved: true },
    );
    expect(c.stillOutsideCount).toBe(3);
    expect(c.expectedStillOutsideCount).toBe(3);
  });
});
