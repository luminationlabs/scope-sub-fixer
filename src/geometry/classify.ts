/**
 * Per-event geometry classification (PRD §9). Purely arithmetic: it decides
 * whether a subtitle sits inside the active picture, and how badly it does not.
 */
import type { PgsEvent, PgsEventObject, Rect } from "../pgs/types.js";
import {
  intersectArea,
  outsideAreaPercent,
  overflow,
  type Bounds,
  type Overflow,
} from "./rect.js";

/**
 * `TOUCHING_BOUNDARY` is informational: the subtitle is inside the active area
 * but within the safe margin of an edge. It is reported and never repaired.
 */
export type EventStatus =
  | "SAFE"
  | "TOUCHING_BOUNDARY"
  | "PARTIALLY_OUTSIDE"
  | "FULLY_OUTSIDE"
  | "AMBIGUOUS";

const SEVERITY: Record<EventStatus, number> = {
  SAFE: 0,
  TOUCHING_BOUNDARY: 1,
  PARTIALLY_OUTSIDE: 2,
  FULLY_OUTSIDE: 3,
  AMBIGUOUS: 4,
};

/**
 * The default safe margin on a 1080-high canvas: about 3% of a scope
 * picture's height, where discs that author their subtitles inside the
 * picture tend to put them. A smaller margin puts the descenders of a moved
 * line almost on the edge of the picture.
 */
export const DEFAULT_MARGIN_AT_1080 = 24;

/** Default safe margin: 24 px on a 1080-high canvas, scaled with canvas height. */
export function defaultMargin(canvasHeight: number): number {
  if (!(canvasHeight > 0)) return DEFAULT_MARGIN_AT_1080;
  return Math.round((DEFAULT_MARGIN_AT_1080 * canvasHeight) / 1080);
}

export interface ClassifyOptions {
  /**
   * Safe margin in canvas pixels. Only ever produces the informational
   * `TOUCHING_BOUNDARY` status; what needs fixing is decided by overflow alone.
   */
  margin?: number;
  /** Set when the active area could not be mapped onto this PGS canvas. */
  canvasMismatch?: boolean;
}

export interface ClassifiedObject {
  objectId: number;
  windowId: number;
  cropped: boolean;
  objectRect: Rect;
  visibleRect: Rect | null;
  /** The rectangle actually judged: `visibleRect ?? objectRect`. */
  rect: Rect;
  fullyTransparent: boolean;
  status: EventStatus;
  overflow: Overflow;
  outsideAreaPercent: number;
  notes: string[];
}

export interface ClassifiedEvent {
  index: number;
  displaySetIndex: number;
  compositionNumber: number;
  ptsMs: number;
  endPtsMs: number | undefined;
  forced: boolean;
  canvasWidth: number;
  canvasHeight: number;
  status: EventStatus;
  /**
   * The event should be repaired: at least one pixel of a visible rect falls
   * outside the active area. PRD §10.3 — a subtitle that is already inside is
   * left where the author put it, however close to the edge it sits, so
   * `TOUCHING_BOUNDARY` never sets this.
   */
  needsFix: boolean;
  /**
   * Informational: the event is inside, but within `margin` px of an edge.
   * Reported, never acted on.
   */
  touchingBoundary: boolean;
  objects: ClassifiedObject[];
  notes: string[];
}

export function worstStatus(statuses: readonly EventStatus[]): EventStatus {
  let worst: EventStatus = "SAFE";
  for (const s of statuses) if (SEVERITY[s] > SEVERITY[worst]) worst = s;
  return worst;
}

function classifyRect(rect: Rect, active: Bounds, margin: number): {
  status: EventStatus;
  overflow: Overflow;
  outsideAreaPercent: number;
} {
  const of = overflow(rect, active);
  const outside = outsideAreaPercent(rect, active);
  if (of.top > 0 || of.bottom > 0 || of.left > 0 || of.right > 0) {
    const status: EventStatus =
      intersectArea(rect, active) === 0 ? "FULLY_OUTSIDE" : "PARTIALLY_OUTSIDE";
    return { status, overflow: of, outsideAreaPercent: outside };
  }
  if (margin > 0) {
    const near =
      rect.y - active.top < margin ||
      active.bottom - (rect.y + rect.height) < margin ||
      rect.x - active.left < margin ||
      active.right - (rect.x + rect.width) < margin;
    if (near) {
      return { status: "TOUCHING_BOUNDARY", overflow: of, outsideAreaPercent: outside };
    }
  }
  return { status: "SAFE", overflow: of, outsideAreaPercent: outside };
}

const ZERO_OVERFLOW: Overflow = { top: 0, bottom: 0, left: 0, right: 0 };

export function classifyObject(
  object: PgsEventObject,
  active: Bounds,
  options: ClassifyOptions = {},
): ClassifiedObject {
  const margin = options.margin ?? 0;
  const notes: string[] = [];
  const fullyTransparent = object.visibleRect === null;
  const rect = object.visibleRect ?? object.objectRect;

  if (fullyTransparent) {
    notes.push("no opaque pixels; nothing is actually drawn");
  }
  if (object.cropped) {
    notes.push("cropped composition object");
  }
  for (const w of object.warnings) notes.push(w);

  // A fully transparent object draws nothing, so it can never be out of frame.
  let base = fullyTransparent
    ? { status: "SAFE" as EventStatus, overflow: ZERO_OVERFLOW, outsideAreaPercent: 0 }
    : classifyRect(rect, active, margin);

  if (options.canvasMismatch || object.cropped) {
    base = { ...base, status: "AMBIGUOUS" };
  }

  return {
    objectId: object.objectId,
    windowId: object.windowId,
    cropped: object.cropped,
    objectRect: object.objectRect,
    visibleRect: object.visibleRect,
    rect,
    fullyTransparent,
    status: base.status,
    overflow: base.overflow,
    outsideAreaPercent: base.outsideAreaPercent,
    notes,
  };
}

/**
 * Classify one resolved PGS event against an active area expressed in the same
 * (canvas) coordinate space.
 */
export function classifyEvent(
  event: PgsEvent,
  active: Bounds,
  options: ClassifyOptions = {},
): ClassifiedEvent {
  const notes: string[] = [];
  const ambiguous = options.canvasMismatch === true || event.errors.length > 0;
  for (const e of event.errors) notes.push(e);
  if (options.canvasMismatch) {
    notes.push("active area could not be mapped onto this PGS canvas");
  }

  const objects = event.objects.map((o) =>
    classifyObject(o, active, { ...options, canvasMismatch: ambiguous }),
  );

  const status = ambiguous
    ? "AMBIGUOUS"
    : worstStatus(objects.map((o) => o.status));

  // PRD §10.3: only real overflow needs a fix. The margin decides where an
  // overflowing subtitle lands (§10.1-§10.4), it never drags an already-inside
  // one away from where the author put it.
  const overflowing = objects.some(
    (o) =>
      o.overflow.top > 0 ||
      o.overflow.bottom > 0 ||
      o.overflow.left > 0 ||
      o.overflow.right > 0,
  );
  const needsFix = status !== "AMBIGUOUS" && overflowing;
  const touchingBoundary =
    !needsFix && objects.some((o) => o.status === "TOUCHING_BOUNDARY");

  return {
    index: event.index,
    displaySetIndex: event.displaySetIndex,
    compositionNumber: event.compositionNumber,
    ptsMs: event.ptsMs,
    endPtsMs: event.endPtsMs,
    forced: event.forced,
    canvasWidth: event.videoWidth,
    canvasHeight: event.videoHeight,
    status,
    needsFix,
    touchingBoundary,
    objects,
    notes,
  };
}

export function classifyEvents(
  events: readonly PgsEvent[],
  active: Bounds,
  options: ClassifyOptions = {},
): ClassifiedEvent[] {
  return events.map((e) => classifyEvent(e, active, options));
}
