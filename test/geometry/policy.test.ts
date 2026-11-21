import { describe, expect, it } from "vitest";
import { planMoves } from "../../src/geometry/policy.js";
import type { Bounds } from "../../src/geometry/rect.js";
import { applyPositionDelta, displaySetSegments } from "../../src/pgs/patch.js";
import { buildDisplaySets, resolveEvents } from "../../src/pgs/compose.js";
import { parseSupSegments } from "../../src/pgs/parse.js";
import { buildSup, type SupSpec } from "../../src/pgs/fixtures.js";
import { eventsFromSpec } from "../helpers/scanFixture.js";
import { applyPlanToDisplaySets, rewriteSegments } from "../../src/fix/patchPlan.js";
import { objectsOutsideWindow } from "../../src/verify/pgs.js";

const ACTIVE: Bounds = { top: 138, bottom: 941, left: 0, right: 1920 };

function plan(spec: SupSpec, margin = 0) {
  const { events, epochIds } = eventsFromSpec(spec);
  return {
    events,
    plan: planMoves(events, ACTIVE, {
      margin,
      epochIds,
      canvasWidth: spec.width,
      canvasHeight: spec.height,
    }),
  };
}

describe("planMoves (PRD §24.3)", () => {
  it("moves a bottom-overflowing subtitle up by exactly the overflow", () => {
    // Visible bottom 1000, active bottom 941 -> -59 px.
    const { plan: p } = plan({
      width: 1920,
      height: 1080,
      events: [{ ptsMs: 1000, objects: [{ x: 800, y: 900, width: 200, height: 100 }] }],
    });
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0]!.objectDeltas.get(0)).toEqual({ dx: 0, dy: -59 });
    expect(p.entries[0]!.windowDeltas.get(0)).toEqual({ dx: 0, dy: -59 });
  });

  it("puts the moved rectangle fully inside the active area", () => {
    const spec: SupSpec = {
      width: 1920,
      height: 1080,
      events: [{ ptsMs: 1000, objects: [{ x: 800, y: 900, width: 200, height: 100 }] }],
    };
    const { events, plan: p } = plan(spec);
    const delta = p.entries[0]!.objectDeltas.get(0)!;
    const rect = events[0]!.objects[0]!.visibleRect!;
    expect(rect.y + delta.dy).toBeGreaterThanOrEqual(ACTIVE.top);
    expect(rect.y + rect.height + delta.dy).toBeLessThanOrEqual(ACTIVE.bottom);
  });

  it("moves a top-overflowing subtitle down", () => {
    const { plan: p } = plan({
      width: 1920,
      height: 1080,
      events: [{ ptsMs: 1000, objects: [{ x: 800, y: 20, width: 200, height: 80 }] }],
    });
    expect(p.entries[0]!.objectDeltas.get(0)).toEqual({ dx: 0, dy: 118 });
  });

  it("leaves subtitles already inside alone (PRD §10.3)", () => {
    const { plan: p } = plan({
      width: 1920,
      height: 1080,
      events: [{ ptsMs: 1000, objects: [{ x: 800, y: 800, width: 200, height: 60 }] }],
    });
    expect(p.entries).toHaveLength(0);
  });

  it("adds the safe margin to the move", () => {
    const { plan: p } = plan(
      {
        width: 1920,
        height: 1080,
        events: [{ ptsMs: 1000, objects: [{ x: 800, y: 900, width: 200, height: 100 }] }],
      },
      8,
    );
    expect(p.entries[0]!.objectDeltas.get(0)).toEqual({ dx: 0, dy: -67 });
  });

  it("does NOT move an object that is inside but within the margin (PRD §10.3)", () => {
    // Visible bottom is exactly the active bottom: inside, so it stays put.
    const { plan: p } = plan(
      {
        width: 1920,
        height: 1080,
        events: [{ ptsMs: 1000, objects: [{ x: 800, y: 881, width: 200, height: 60 }] }],
      },
      8,
    );
    expect(p.entries).toHaveLength(0);
    expect(p.skipped).toHaveLength(0);
  });

  it("moves for one pixel of overflow, and lands margin px inside", () => {
    const { plan: p } = plan(
      {
        width: 1920,
        height: 1080,
        events: [{ ptsMs: 1000, objects: [{ x: 800, y: 882, width: 200, height: 60 }] }],
      },
      8,
    );
    // Visible bottom 942, active bottom 941, margin 8 -> lands at 933.
    expect(p.entries[0]!.objectDeltas.get(0)).toEqual({ dx: 0, dy: -9 });
  });

  it("preserves x unless the object is actually outside (PRD §10.5)", () => {
    const { plan: p } = plan({
      width: 1920,
      height: 1080,
      events: [{ ptsMs: 1000, objects: [{ x: 1800, y: 900, width: 200, height: 100 }] }],
    });
    expect(p.entries[0]!.objectDeltas.get(0)).toEqual({ dx: -80, dy: -59 });
  });

  it("skips an object taller than the active area", () => {
    const { plan: p } = plan({
      width: 1920,
      height: 1080,
      events: [{ ptsMs: 1000, objects: [{ x: 0, y: 0, width: 1920, height: 1000 }] }],
    });
    expect(p.entries).toHaveLength(0);
    expect(p.skipped[0]!.reason).toMatch(/taller than/);
  });

  // The active area is 803 px tall. The margin is where a moved subtitle
  // lands, not a reason to leave a tall one outside: it is centred instead.
  it("centres an object too tall for the margin on both sides (top overflow)", () => {
    const { plan: p } = plan(
      {
        width: 1920,
        height: 1080,
        events: [{ ptsMs: 1000, objects: [{ x: 1072, y: 94, width: 679, height: 761 }] }],
      },
      24,
    );
    expect(p.skipped).toHaveLength(0);
    // 42 px to spare: 21 above, 21 below. Top 94 -> 159, bottom 920.
    expect(p.entries[0]!.objectDeltas.get(0)).toEqual({ dx: 0, dy: 65 });
  });

  it("centres an object too tall for the margin on both sides (bottom overflow)", () => {
    const { plan: p } = plan(
      {
        width: 1920,
        height: 1080,
        events: [{ ptsMs: 1000, objects: [{ x: 1500, y: 160, width: 100, height: 790 }] }],
      },
      24,
    );
    expect(p.skipped).toHaveLength(0);
    // 13 px to spare: bottom 950 -> 935 (6 inside), top 145 (7 inside).
    expect(p.entries[0]!.objectDeltas.get(0)).toEqual({ dx: 0, dy: -15 });
  });

  it("keeps the full margin up to the height that just fits, and gives way one pixel later", () => {
    // 803 px of picture, margin 24: 755 px fits with 24 on both sides.
    const at = (height: number) =>
      plan(
        {
          width: 1920,
          height: 1080,
          events: [{ ptsMs: 1000, objects: [{ x: 1500, y: 941 - height + 10, width: 100, height }] }],
        },
        24,
      ).plan.entries[0]!.objectDeltas.get(0);
    expect(at(755)).toEqual({ dx: 0, dy: -34 });
    // 47 px to spare: 23 inside the bottom edge.
    expect(at(756)).toEqual({ dx: 0, dy: -33 });
  });

  it("places an object exactly as tall as the active area edge to edge", () => {
    const { plan: p } = plan(
      {
        width: 1920,
        height: 1080,
        events: [{ ptsMs: 1000, objects: [{ x: 1500, y: 140, width: 100, height: 803 }] }],
      },
      24,
    );
    expect(p.skipped).toHaveLength(0);
    expect(p.entries[0]!.objectDeltas.get(0)).toEqual({ dx: 0, dy: -2 });
  });

  it("still skips an object one pixel taller than the active area", () => {
    const { plan: p } = plan(
      {
        width: 1920,
        height: 1080,
        events: [{ ptsMs: 1000, objects: [{ x: 1500, y: 140, width: 100, height: 804 }] }],
      },
      24,
    );
    expect(p.entries).toHaveLength(0);
    expect(p.skipped[0]!.reason).toMatch(/taller than the 803 px active area/);
  });

  it("skips a cropped composition object", () => {
    const { plan: p } = plan({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          objects: [
            {
              x: 800,
              y: 900,
              width: 200,
              height: 100,
              crop: { x: 0, y: 0, width: 200, height: 100 },
            },
          ],
        },
      ],
    });
    expect(p.entries).toHaveLength(0);
    expect(p.skipped[0]!.reason).toMatch(/cropped/);
  });

  it("gives both objects in one window the same delta", () => {
    // Two objects share window 0; only the lower one overflows.
    const { plan: p } = plan({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          windows: [{ windowId: 0, x: 0, y: 700, width: 1920, height: 300 }],
          objects: [
            { objectId: 0, windowId: 0, x: 100, y: 720, width: 200, height: 60 },
            { objectId: 1, windowId: 0, x: 900, y: 900, width: 200, height: 100 },
          ],
        },
      ],
    });
    const entry = p.entries[0]!;
    expect(entry.objectDeltas.get(0)).toEqual({ dx: 0, dy: -59 });
    expect(entry.objectDeltas.get(1)).toEqual({ dx: 0, dy: -59 });
    expect(entry.objects.find((o) => o.objectId === 0)!.movedForConsistency).toBe(true);
    expect(entry.objects.find((o) => o.objectId === 1)!.movedForConsistency).toBe(false);
    expect(entry.reasons.join(" ")).toMatch(/for consistency/);
  });

  it("refuses a window move that would push another object in it out of view", () => {
    // Object 1 needs -218 px. Object 0 shares its window, so it must take the
    // same delta — and it sits close enough to the top that doing so would put
    // it in the upper letterbox bar. The members cannot move independently, so
    // the whole group is refused rather than trading one loss for another.
    const spec: SupSpec = {
      width: 3840,
      height: 2160,
      events: [
        {
          ptsMs: 1000,
          windows: [{ windowId: 0, x: 0, y: 300, width: 3840, height: 1800 }],
          objects: [
            { objectId: 0, windowId: 0, x: 200, y: 400, width: 400, height: 60 },
            { objectId: 1, windowId: 0, x: 1500, y: 2000, width: 400, height: 100 },
          ],
        },
      ],
    };
    const { events, epochIds } = eventsFromSpec(spec);
    const active: Bounds = { top: 276, bottom: 1882, left: 0, right: 3840 };
    const p = planMoves(events, active, {
      epochIds,
      canvasWidth: 3840,
      canvasHeight: 2160,
    });
    expect(p.entries).toHaveLength(0);
    expect(p.skipped).toHaveLength(1);
    expect(p.skipped[0]!.reason).toMatch(
      /would push object 0 outside the active area/,
    );
  });

  it("moves a subtitle inside a window that cannot move with it", () => {
    // One window over the whole canvas, as some discs declare for every
    // subtitle: it cannot go anywhere, and need not.
    const full = { windowId: 0, x: 0, y: 0, width: 1920, height: 1080 };
    const spec: SupSpec = {
      width: 1920,
      height: 1080,
      events: [
        { ptsMs: 1000, windows: [full], objects: [{ objectId: 0, windowId: 0, x: 638, y: 953, width: 646, height: 68 }] },
        // In the top bar: down, and the window would leave by the bottom.
        { ptsMs: 3000, windows: [full], objects: [{ objectId: 0, windowId: 0, x: 600, y: 64, width: 400, height: 60 }] },
      ],
    };
    const { plan: p } = plan(spec);
    expect(p.skipped).toHaveLength(0);
    expect(p.entries.map((e) => e.objectDeltas.get(0))).toEqual([{ dx: 0, dy: -80 }, { dx: 0, dy: 74 }]);
    for (const entry of p.entries) {
      expect(entry.windowDeltas.size).toBe(0);
      expect(entry.reasons[0]).toContain("the window itself stays where it is");
    }
    expect(p.windowDeltasByEpoch.size).toBe(0);

    // The bytes: only the composition object's position changes.
    const sets = buildDisplaySets(parseSupSegments(buildSup(spec)));
    const first = sets.find((ds) => ds.index === p.entries[0]!.displaySetIndex)!;
    const result = applyPositionDelta(displaySetSegments(first), { objectDeltas: p.entries[0]!.objectDeltas });
    expect(result.patches).toHaveLength(1);
    const moved = resolveEvents(buildDisplaySets(result.segments))[0]!.objects[0]!;
    expect(moved.objectRect.y).toBe(873);
    expect(moved.window).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it("applies a window that stays through the fixer, and counts no object outside its window", () => {
    const full = { windowId: 0, x: 0, y: 0, width: 1920, height: 1080 };
    const spec: SupSpec = {
      width: 1920,
      height: 1080,
      events: [
        { ptsMs: 1000, windows: [full], objects: [{ objectId: 0, windowId: 0, x: 638, y: 953, width: 646, height: 68 }] },
      ],
    };
    const { events, epochIds } = eventsFromSpec(spec);
    const p = planMoves(events, ACTIVE, { epochIds, canvasWidth: 1920, canvasHeight: 1080 });
    const sets = buildDisplaySets(parseSupSegments(buildSup(spec)));
    const epochs = new Map(sets.map((ds) => [ds.index, 0]));
    const applied = applyPlanToDisplaySets(sets, epochs, p, 13);
    // One field: the object's. The window's, in this display set and in the
    // one that clears the screen, is not written.
    expect(applied.patches).toHaveLength(1);
    expect(applied.displaySetsTouched).toBe(1);
    const after = resolveEvents(buildDisplaySets(rewriteSegments(parseSupSegments(buildSup(spec)), applied)));
    expect(after[0]!.objects[0]!.objectRect.y).toBe(873);
    expect(objectsOutsideWindow(after)).toBe(0);
    // What the count is for: an object moved out of a window that hugs it.
    const tight = eventsFromSpec({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          windows: [{ windowId: 0, x: 600, y: 940, width: 700, height: 100 }],
          objects: [{ objectId: 0, windowId: 0, x: 638, y: 873, width: 646, height: 68 }],
        },
      ],
    }).events;
    expect(objectsOutsideWindow(tight)).toBe(1);
  });

  it("moves the window with its objects whenever it can", () => {
    // Unchanged behaviour: a window with room to move goes along, so fixes
    // made before this rule existed come out byte for byte the same.
    const { plan: p } = plan({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          windows: [{ windowId: 0, x: 0, y: 200, width: 1920, height: 850 }],
          objects: [{ objectId: 0, windowId: 0, x: 800, y: 900, width: 200, height: 100 }],
        },
      ],
    });
    expect(p.entries[0]!.windowDeltas.get(0)).toEqual({ dx: 0, dy: -59 });
  });

  it("keeps independent windows independent", () => {
    const { plan: p } = plan({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          windows: [
            { windowId: 0, x: 0, y: 700, width: 900, height: 200 },
            { windowId: 1, x: 900, y: 880, width: 1000, height: 200 },
          ],
          objects: [
            { objectId: 0, windowId: 0, x: 100, y: 720, width: 200, height: 60 },
            { objectId: 1, windowId: 1, x: 950, y: 900, width: 200, height: 100 },
          ],
        },
      ],
    });
    const entry = p.entries[0]!;
    expect(entry.objectDeltas.get(0)).toBeUndefined();
    expect(entry.objectDeltas.get(1)).toEqual({ dx: 0, dy: -59 });
    expect([...entry.windowDeltas.keys()]).toEqual([1]);
  });

  it("applies a window delta to every display set in the epoch using it", () => {
    // One epoch: an offending event, then a normal display set that reuses the
    // same window with an object that was already inside.
    const { plan: p } = plan({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          state: "epochStart",
          windows: [{ windowId: 0, x: 0, y: 700, width: 1920, height: 300 }],
          objects: [{ objectId: 0, windowId: 0, x: 900, y: 900, width: 200, height: 100 }],
        },
        {
          ptsMs: 3000,
          state: "normal",
          objects: [{ objectId: 0, windowId: 0, x: 900, y: 720, width: 200, height: 60, reuse: true }],
        },
      ],
    });
    expect(p.entries).toHaveLength(2);
    expect(p.entries[0]!.objectDeltas.get(0)).toEqual({ dx: 0, dy: -59 });
    expect(p.entries[1]!.objectDeltas.get(0)).toEqual({ dx: 0, dy: -59 });
    expect(p.entries[1]!.objects[0]!.movedForConsistency).toBe(true);
    expect(p.windowDeltasByEpoch.get(0)!.get(0)).toEqual({ dx: 0, dy: -59 });
  });

  it("does not couple events in different epochs", () => {
    const { plan: p } = plan({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          state: "epochStart",
          objects: [{ objectId: 0, windowId: 0, x: 900, y: 900, width: 200, height: 100 }],
        },
        {
          ptsMs: 3000,
          state: "epochStart",
          objects: [{ objectId: 0, windowId: 0, x: 900, y: 700, width: 200, height: 60 }],
        },
      ],
    });
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0]!.eventIndex).toBe(0);
  });

  it("skips a window whose objects need opposite moves", () => {
    const { plan: p } = plan({
      width: 1920,
      height: 1080,
      events: [
        {
          ptsMs: 1000,
          windows: [{ windowId: 0, x: 0, y: 0, width: 1920, height: 1080 }],
          objects: [
            { objectId: 0, windowId: 0, x: 100, y: 20, width: 200, height: 60 },
            { objectId: 1, windowId: 0, x: 900, y: 950, width: 200, height: 60 },
          ],
        },
      ],
    });
    expect(p.entries).toHaveLength(0);
    expect(p.skipped[0]!.reason).toMatch(/conflicting/);
  });

  it("produces deltas applyPositionDelta can consume", () => {
    const spec: SupSpec = {
      width: 1920,
      height: 1080,
      events: [{ ptsMs: 1000, objects: [{ x: 800, y: 900, width: 200, height: 100 }] }],
    };
    const bytes = buildSup(spec);
    const displaySets = buildDisplaySets(parseSupSegments(bytes));
    const events = resolveEvents(displaySets);
    const p = planMoves(events, ACTIVE, {
      canvasWidth: 1920,
      canvasHeight: 1080,
    });
    const entry = p.entries[0]!;
    const ds = displaySets[entry.displaySetIndex]!;
    const patched = applyPositionDelta(displaySetSegments(ds), {
      objectDeltas: entry.objectDeltas,
      windowDeltas: entry.windowDeltas,
    });
    const pcs = patched.segments.find((s) => s.type === 0x16);
    expect(pcs).toBeDefined();
    if (pcs?.type !== 0x16) return;
    expect(pcs.objects[0]!.y).toBe(841);
    expect(patched.patches.length).toBeGreaterThan(0);
  });
});
