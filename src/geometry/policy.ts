/**
 * Relocation policy (PRD §10).
 *
 * Move a subtitle by the smallest amount that puts its visible pixels back
 * inside the active picture, preserving intent: bottom overflow moves up, top
 * overflow moves down, horizontal position is left alone unless it is actually
 * outside. Anything that cannot be resolved unambiguously is skipped, never
 * guessed at.
 *
 * PGS constrains the result further: a composition object must stay inside its
 * window, so every object sharing a window id within an epoch has to receive
 * the same delta, and that delta applies to every display set in the epoch that
 * uses the window.
 */
import type { PgsEvent, PgsEventObject, Rect } from "../pgs/types.js";
import type { PositionDelta } from "../pgs/patch.js";
import { rectBottom, rectRight, type Bounds } from "./rect.js";

export type { PositionDelta };

export interface MoveObjectDetail {
  objectId: number;
  windowId: number;
  /** The delta actually applied (the window group's delta). */
  delta: PositionDelta;
  /** What this object alone would have needed. */
  required: PositionDelta;
  /** True when the object was already inside and only moves to stay with its window. */
  movedForConsistency: boolean;
}

export interface MovePlanEntry {
  displaySetIndex: number;
  eventIndex: number;
  /** Keyed by composition object id; feeds `applyPositionDelta`. */
  objectDeltas: Map<number, PositionDelta>;
  /** Keyed by window id; feeds `applyPositionDelta`. */
  windowDeltas: Map<number, PositionDelta>;
  objects: MoveObjectDetail[];
  reasons: string[];
}

export interface MoveSkip {
  eventIndex: number;
  displaySetIndex: number;
  windowId: number | undefined;
  reason: string;
}

export interface MovePlan {
  margin: number;
  entries: MovePlanEntry[];
  skipped: MoveSkip[];
  /**
   * Window deltas per epoch id. A fixer must apply these to every display set
   * in the epoch that defines the window, including screen-clearing ones that
   * carry no composition objects.
   */
  windowDeltasByEpoch: Map<number, Map<number, PositionDelta>>;
}

export interface PlanMovesOptions {
  /** Safe margin in canvas pixels, applied vertically. */
  margin?: number;
  /**
   * Epoch id per event, aligned with `events`. Without it every event is
   * treated as its own epoch, which is what a stream of epoch-start display
   * sets amounts to anyway.
   */
  epochIds?: readonly number[];
  /** Canvas bounds used to reject moves that would push a window off-screen. */
  canvasWidth?: number;
  canvasHeight?: number;
}

interface Requirement {
  eventIndex: number;
  displaySetIndex: number;
  objectId: number;
  windowId: number;
  required: PositionDelta;
  /** The rect the move is computed from: the visible pixels when there are any. */
  rect: Rect;
  /** The composition object's own rect — what the PCS x/y actually addresses. */
  objectRect: Rect;
  window: Rect | null;
  canvasWidth: number;
  canvasHeight: number;
  reason: string | null;
}

interface Group {
  epochId: number;
  windowId: number;
  requirements: Requirement[];
  blocked: string | null;
}

/**
 * PRD §10.1-§10.4. A move is triggered by real overflow only — a subtitle
 * already inside the active picture is left exactly where the author put it,
 * however close to an edge it sits (PRD §10.3). The margin says only where an
 * overflowing subtitle *lands*: `active.bottom - margin` or `active.top +
 * margin`.
 *
 * The margin is a preference, never a reason to leave something outside. An
 * object too tall to keep it on both sides (a pop-up graphic, a vertical
 * column of text) is centred in the picture instead, which is the most margin
 * there is room for; `landingMargin` is that rule. Only an object taller than
 * the picture itself cannot be placed.
 */
function landingMargin(rect: Rect, active: Bounds, margin: number): number {
  const slack = active.bottom - active.top - rect.height;
  return Math.max(0, Math.min(margin, Math.floor(slack / 2)));
}

function verticalDelta(rect: Rect, active: Bounds, margin: number): number {
  const m = landingMargin(rect, active, margin);
  if (rectBottom(rect) > active.bottom) {
    return active.bottom - m - rectBottom(rect);
  }
  if (rect.y < active.top) return active.top + m - rect.y;
  return 0;
}

/** True when any pixel of `rect` falls outside `active` — the `needsFix` rule. */
function isOutside(rect: Rect, active: Bounds): boolean {
  return (
    rect.y < active.top ||
    rectBottom(rect) > active.bottom ||
    rect.x < active.left ||
    rectRight(rect) > active.right
  );
}

function horizontalDelta(rect: Rect, active: Bounds): number {
  // No margin horizontally: PRD §10.5 keeps x untouched unless truly outside.
  if (rectRight(rect) > active.right) return active.right - rectRight(rect);
  if (rect.x < active.left) return active.left - rect.x;
  return 0;
}

function pickDelta(values: readonly number[]): { value: number; conflict: boolean } {
  let value = 0;
  let conflict = false;
  for (const v of values) {
    if (v === 0) continue;
    if (value !== 0 && Math.sign(v) !== Math.sign(value)) conflict = true;
    if (Math.abs(v) > Math.abs(value)) value = v;
  }
  return { value, conflict };
}

function objectRectOf(o: PgsEventObject): Rect {
  return o.visibleRect ?? o.objectRect;
}

/**
 * Work out the minimum moves that bring every offending event inside the
 * active area, honouring the per-window consistency rule.
 */
export function planMoves(
  events: readonly PgsEvent[],
  active: Bounds,
  options: PlanMovesOptions = {},
): MovePlan {
  const margin = options.margin ?? 0;
  const epochIds = options.epochIds;
  const entries: MovePlanEntry[] = [];
  const skipped: MoveSkip[] = [];
  const groups = new Map<string, Group>();

  const groupOf = (epochId: number, windowId: number): Group => {
    const key = `${epochId}:${windowId}`;
    let g = groups.get(key);
    if (!g) {
      g = { epochId, windowId, requirements: [], blocked: null };
      groups.set(key, g);
    }
    return g;
  };

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const epochId = epochIds?.[i] ?? i;
    const canvasWidth = options.canvasWidth ?? event.videoWidth;
    const canvasHeight = options.canvasHeight ?? event.videoHeight;
    const eventBlocked =
      event.errors.length > 0
        ? `event ${event.index}: ${event.errors[0]}`
        : null;

    for (const o of event.objects) {
      const g = groupOf(epochId, o.windowId);
      if (eventBlocked && !g.blocked) g.blocked = eventBlocked;

      if (o.cropped && !g.blocked) {
        g.blocked = `object ${o.objectId} is a cropped composition object`;
      }

      const rect = objectRectOf(o);
      let required: PositionDelta = { dx: 0, dy: 0 };
      let reason: string | null = null;

      if (o.visibleRect === null) {
        reason = `object ${o.objectId} draws no opaque pixels`;
      } else if (!isOutside(rect, active)) {
        // Already inside: nothing to do, and nothing that can block the group.
        reason = null;
      } else {
        // The whole picture: the margin gives way to a tall object (`landingMargin`).
        const availableHeight = active.bottom - active.top;
        const availableWidth = active.right - active.left;
        if (rect.height > availableHeight) {
          if (!g.blocked) {
            g.blocked = `object ${o.objectId} is ${rect.height} px tall, taller than the ${availableHeight} px active area`;
          }
        } else if (rect.width > availableWidth) {
          if (!g.blocked) {
            g.blocked = `object ${o.objectId} is ${rect.width} px wide, wider than the ${availableWidth} px active area`;
          }
        } else {
          required = {
            dx: horizontalDelta(rect, active),
            dy: verticalDelta(rect, active, margin),
          };
        }
      }

      g.requirements.push({
        eventIndex: event.index,
        displaySetIndex: event.displaySetIndex,
        objectId: o.objectId,
        windowId: o.windowId,
        required,
        rect,
        objectRect: o.objectRect,
        window: o.window,
        canvasWidth,
        canvasHeight,
        reason,
      });
    }
  }

  // Resolve each (epoch, window) group into one delta.
  const groupDelta = new Map<string, PositionDelta>();
  /** Groups whose objects move inside a window that stays where it is. */
  const stillWindows = new Set<string>();
  const windowDeltasByEpoch = new Map<number, Map<number, PositionDelta>>();

  for (const [key, g] of groups) {
    if (g.blocked) {
      for (const r of dedupeEvents(g.requirements)) {
        skipped.push({
          eventIndex: r.eventIndex,
          displaySetIndex: r.displaySetIndex,
          windowId: g.windowId,
          reason: g.blocked,
        });
      }
      continue;
    }
    const dy = pickDelta(g.requirements.map((r) => r.required.dy));
    const dx = pickDelta(g.requirements.map((r) => r.required.dx));
    if (dy.conflict || dx.conflict) {
      for (const r of dedupeEvents(g.requirements)) {
        skipped.push({
          eventIndex: r.eventIndex,
          displaySetIndex: r.displaySetIndex,
          windowId: g.windowId,
          reason: `window ${g.windowId} needs conflicting moves in one epoch`,
        });
      }
      continue;
    }
    if (dy.value === 0 && dx.value === 0) continue;

    const delta: PositionDelta = { dx: dx.value, dy: dy.value };
    // The window goes with its objects, as it always has. Only when that
    // would take it off the canvas is the other legal arrangement tried: the
    // window stays and the objects move inside it (a disc that declares one
    // full-screen window for every subtitle allows nothing else).
    let windowStays = false;
    let bounds = findBoundsViolation(g.requirements, delta, true);
    if (bounds !== null) {
      const still = findBoundsViolation(g.requirements, delta, false);
      if (still === null) {
        bounds = null;
        windowStays = true;
      } else if (WINDOW_REFUSAL.test(bounds)) {
        // Both arrangements were tried; the one that says why neither works
        // is the second.
        bounds = `${bounds}, and ${still}`;
      }
    }
    const violation = bounds ?? findPushedOutside(g.requirements, delta, active, margin);
    if (violation) {
      for (const r of dedupeEvents(g.requirements)) {
        skipped.push({
          eventIndex: r.eventIndex,
          displaySetIndex: r.displaySetIndex,
          windowId: g.windowId,
          reason: violation,
        });
      }
      continue;
    }

    groupDelta.set(key, delta);
    if (windowStays) {
      stillWindows.add(key);
      continue;
    }
    let byWindow = windowDeltasByEpoch.get(g.epochId);
    if (!byWindow) {
      byWindow = new Map();
      windowDeltasByEpoch.set(g.epochId, byWindow);
    }
    byWindow.set(g.windowId, delta);
  }

  // Emit one entry per event touched by a moving window.
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const epochId = epochIds?.[i] ?? i;
    const objectDeltas = new Map<number, PositionDelta>();
    const windowDeltas = new Map<number, PositionDelta>();
    const details: MoveObjectDetail[] = [];
    const reasons: string[] = [];

    for (const o of event.objects) {
      const key = `${epochId}:${o.windowId}`;
      const delta = groupDelta.get(key);
      if (!delta) continue;
      const g = groups.get(key)!;
      const req =
        g.requirements.find(
          (r) => r.eventIndex === event.index && r.objectId === o.objectId,
        )?.required ?? { dx: 0, dy: 0 };
      const movedForConsistency = req.dx === 0 && req.dy === 0;
      objectDeltas.set(o.objectId, delta);
      if (!stillWindows.has(key)) windowDeltas.set(o.windowId, delta);
      details.push({
        objectId: o.objectId,
        windowId: o.windowId,
        delta,
        required: req,
        movedForConsistency,
      });
      reasons.push(
        describe(o, req, delta, movedForConsistency, active) +
          (stillWindows.has(key) ? `; the window itself stays where it is` : ""),
      );
    }

    if (objectDeltas.size > 0) {
      entries.push({
        displaySetIndex: event.displaySetIndex,
        eventIndex: event.index,
        objectDeltas,
        windowDeltas,
        objects: details,
        reasons,
      });
    }
  }

  return { margin, entries, skipped, windowDeltasByEpoch };
}

/** `findBoundsViolation`'s refusal of a window move, as opposed to an object's. */
const WINDOW_REFUSAL = /^moving window /;

function dedupeEvents(requirements: readonly Requirement[]): Requirement[] {
  const seen = new Set<number>();
  const out: Requirement[] = [];
  for (const r of requirements) {
    if (seen.has(r.eventIndex)) continue;
    seen.add(r.eventIndex);
    out.push(r);
  }
  return out;
}

/**
 * Reject a delta that would push a window or object off the PGS canvas.
 *
 * The object's OWN rect matters as much as its visible pixels: the field the
 * patch rewrites is the composition object's x/y, and a value outside the u16
 * range (or off the canvas) is what `applyPositionDelta` would throw on. A
 * transparent border around the glyphs makes the two rects differ, so both are
 * checked.
 */
function findBoundsViolation(
  requirements: readonly Requirement[],
  delta: PositionDelta,
  windowMoves: boolean,
): string | null {
  for (const r of requirements) {
    const checks: { name: string; rect: Rect }[] = [
      { name: `object ${r.objectId}`, rect: r.rect },
      { name: `object ${r.objectId}`, rect: r.objectRect },
    ];
    if (r.window && windowMoves) checks.push({ name: `window ${r.windowId}`, rect: r.window });
    if (!windowMoves) {
      // A composition object must lie inside its window. With the window
      // left where it is, that is the moved object against the window as
      // declared. (No window on record cannot get here — the event carries
      // an error and its group is blocked — but nothing is offered if it does.)
      const w = r.window;
      const o = r.objectRect;
      const x = o.x + delta.dx;
      const y = o.y + delta.dy;
      if (
        w === null ||
        x < w.x ||
        y < w.y ||
        x + o.width > w.x + w.width ||
        y + o.height > w.y + w.height
      ) {
        return `moving object ${r.objectId} by (${delta.dx}, ${delta.dy}) would take it out of window ${r.windowId}`;
      }
    }
    for (const c of checks) {
      const x = c.rect.x + delta.dx;
      const y = c.rect.y + delta.dy;
      if (x < 0 || y < 0) {
        return `moving ${c.name} by (${delta.dx}, ${delta.dy}) would put it off the top/left of the canvas`;
      }
      if (x + c.rect.width > r.canvasWidth || y + c.rect.height > r.canvasHeight) {
        return `moving ${c.name} by (${delta.dx}, ${delta.dy}) would put it off the ${r.canvasWidth}x${r.canvasHeight} canvas`;
      }
    }
  }
  return null;
}

/**
 * Reject a delta that fixes one member of a window group by pushing another one
 * out of the active area.
 *
 * Every object sharing a window must receive the same delta, and the group's
 * delta is the largest requirement in it. An object that was already inside can
 * therefore be moved further than it needed to be — off the top of the picture,
 * if it sat near the top and a neighbour needed a big move up. Re-classifying
 * every member against the active area after the move is the only way to catch
 * that, and refusing the group is the only correct answer: the members cannot
 * be moved independently.
 */
function findPushedOutside(
  requirements: readonly Requirement[],
  delta: PositionDelta,
  active: Bounds,
  margin: number,
): string | null {
  for (const r of requirements) {
    // Objects that draw no opaque pixels have nothing to place.
    if (r.reason !== null) continue;
    const moved: Rect = {
      x: r.rect.x + delta.dx,
      y: r.rect.y + delta.dy,
      width: r.rect.width,
      height: r.rect.height,
    };
    if (
      verticalDelta(moved, active, margin) !== 0 ||
      horizontalDelta(moved, active) !== 0
    ) {
      return (
        `moving window ${r.windowId} by (${delta.dx}, ${delta.dy}) would push ` +
        `object ${r.objectId} outside the active area`
      );
    }
  }
  return null;
}

function describe(
  o: PgsEventObject,
  required: PositionDelta,
  delta: PositionDelta,
  movedForConsistency: boolean,
  active: Bounds,
): string {
  const rect = objectRectOf(o);
  if (movedForConsistency) {
    return `object ${o.objectId} was already inside; moved (${delta.dx}, ${delta.dy}) with window ${o.windowId} for consistency`;
  }
  const parts: string[] = [];
  if (required.dy < 0) {
    parts.push(
      `visible bottom ${rectBottom(rect)} is past active bottom ${active.bottom}`,
    );
  } else if (required.dy > 0) {
    parts.push(`visible top ${rect.y} is above active top ${active.top}`);
  }
  if (required.dx !== 0) {
    parts.push(
      `visible x ${rect.x}..${rectRight(rect)} is outside ${active.left}..${active.right}`,
    );
  }
  const why = parts.length > 0 ? parts.join("; ") : "window consistency";
  return `object ${o.objectId} (window ${o.windowId}): ${why} → move (${delta.dx}, ${delta.dy})`;
}
