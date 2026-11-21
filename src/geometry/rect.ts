/**
 * Rectangle and bounds helpers shared by the active-area, classification and
 * relocation code. All coordinates are pixels in one common coordinate space;
 * `bottom`/`right` are exclusive, so a rect whose bottom equals `active.bottom`
 * is still fully inside.
 */
import type { Rect } from "../pgs/types.js";

export type { Rect };

/** An axis-aligned region expressed as edges rather than origin + size. */
export interface Bounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Pixels of a rectangle falling outside each edge of a bounds. Never negative. */
export interface Overflow {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export function rectRight(r: Rect): number {
  return r.x + r.width;
}

export function rectBottom(r: Rect): number {
  return r.y + r.height;
}

export function rectArea(r: Rect): number {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

export function boundsWidth(b: Bounds): number {
  return b.right - b.left;
}

export function boundsHeight(b: Bounds): number {
  return b.bottom - b.top;
}

export function boundsToRect(b: Bounds): Rect {
  return {
    x: b.left,
    y: b.top,
    width: boundsWidth(b),
    height: boundsHeight(b),
  };
}

export function rectToBounds(r: Rect): Bounds {
  return {
    top: r.y,
    bottom: rectBottom(r),
    left: r.x,
    right: rectRight(r),
  };
}

/** How far `rect` pokes outside each edge of `active`, in pixels. */
export function overflow(rect: Rect, active: Bounds): Overflow {
  return {
    top: Math.max(0, active.top - rect.y),
    bottom: Math.max(0, rectBottom(rect) - active.bottom),
    left: Math.max(0, active.left - rect.x),
    right: Math.max(0, rectRight(rect) - active.right),
  };
}

export function hasOverflow(o: Overflow): boolean {
  return o.top > 0 || o.bottom > 0 || o.left > 0 || o.right > 0;
}

export function maxOverflow(o: Overflow): number {
  return Math.max(o.top, o.bottom, o.left, o.right);
}

/** Area of the intersection of `rect` with `active`. */
export function intersectArea(rect: Rect, active: Bounds): number {
  const w = Math.min(rectRight(rect), active.right) - Math.max(rect.x, active.left);
  const h = Math.min(rectBottom(rect), active.bottom) - Math.max(rect.y, active.top);
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/**
 * Percentage of the rectangle's own area that lies outside the active bounds,
 * rounded to two decimals. A zero-area rect counts as fully outside when it
 * sits outside the bounds, and as inside otherwise.
 */
export function outsideAreaPercent(rect: Rect, active: Bounds): number {
  const area = rectArea(rect);
  if (area === 0) return hasOverflow(overflow(rect, active)) ? 100 : 0;
  const outside = area - intersectArea(rect, active);
  return Math.round((outside / area) * 10000) / 100;
}

/** True when no part of `rect` overlaps `active`. */
export function isFullyOutside(rect: Rect, active: Bounds): boolean {
  return intersectArea(rect, active) === 0;
}

/** Smallest distance from any edge of `rect` to the matching edge of `active`. */
export function edgeDistances(rect: Rect, active: Bounds): Overflow {
  return {
    top: rect.y - active.top,
    bottom: active.bottom - rectBottom(rect),
    left: rect.x - active.left,
    right: active.right - rectRight(rect),
  };
}

export function translateRect(r: Rect, dx: number, dy: number): Rect {
  return { x: r.x + dx, y: r.y + dy, width: r.width, height: r.height };
}
