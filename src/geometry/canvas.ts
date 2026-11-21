/**
 * PGS composition coordinates live on the PGS canvas declared by the PCS
 * (`event.videoWidth`/`videoHeight`), which need not match the MKV video's
 * coded size — a 1920x1080 PGS track riding on 3840x2160 video is common.
 *
 * The active area is derived from the *video* frame, so it has to be mapped
 * onto the canvas before anything can be compared against it.
 */
import type { ActiveArea } from "../video/activeArea.js";
import type { Bounds } from "./rect.js";

/** Relative aspect difference we are willing to call "the same shape". */
export const CANVAS_ASPECT_TOLERANCE = 0.005;

export interface ScaledActiveAreaOk extends Bounds {
  status: "OK";
  canvasWidth: number;
  canvasHeight: number;
  scaleX: number;
  scaleY: number;
  /** True when no scaling was needed at all. */
  identity: boolean;
}

export interface ScaledActiveAreaMismatch {
  status: "CANVAS_MISMATCH";
  canvasWidth: number;
  canvasHeight: number;
  frameWidth: number;
  frameHeight: number;
  message: string;
}

export type ScaledActiveArea = ScaledActiveAreaOk | ScaledActiveAreaMismatch;

/**
 * Map an active area from video-frame coordinates onto a PGS canvas.
 * Only a proportional mapping is ever attempted: if the canvas has a different
 * shape from the frame we cannot know how the player letterboxes or stretches
 * the overlay, so the caller must treat the track as AMBIGUOUS.
 */
export function scaleActiveAreaToCanvas(
  active: ActiveArea,
  canvasWidth: number,
  canvasHeight: number,
): ScaledActiveArea {
  const { frameWidth, frameHeight } = active;
  const mismatch = (message: string): ScaledActiveAreaMismatch => ({
    status: "CANVAS_MISMATCH",
    canvasWidth,
    canvasHeight,
    frameWidth,
    frameHeight,
    message,
  });

  if (!(canvasWidth > 0) || !(canvasHeight > 0)) {
    return mismatch(`PGS canvas size ${canvasWidth}x${canvasHeight} is not usable`);
  }
  if (!(frameWidth > 0) || !(frameHeight > 0)) {
    return mismatch(`video frame size ${frameWidth}x${frameHeight} is not usable`);
  }

  if (canvasWidth === frameWidth && canvasHeight === frameHeight) {
    return {
      status: "OK",
      canvasWidth,
      canvasHeight,
      scaleX: 1,
      scaleY: 1,
      identity: true,
      top: active.top,
      bottom: active.bottom,
      left: active.left,
      right: active.right,
    };
  }

  const canvasAspect = canvasWidth / canvasHeight;
  const frameAspect = frameWidth / frameHeight;
  const relative = Math.abs(canvasAspect - frameAspect) / frameAspect;
  if (relative > CANVAS_ASPECT_TOLERANCE) {
    return mismatch(
      `PGS canvas ${canvasWidth}x${canvasHeight} (${canvasAspect.toFixed(3)}:1) does not ` +
        `match video ${frameWidth}x${frameHeight} (${frameAspect.toFixed(3)}:1)`,
    );
  }

  const scaleX = canvasWidth / frameWidth;
  const scaleY = canvasHeight / frameHeight;
  return {
    status: "OK",
    canvasWidth,
    canvasHeight,
    scaleX,
    scaleY,
    identity: false,
    top: Math.round(active.top * scaleY),
    bottom: Math.round(active.bottom * scaleY),
    left: Math.round(active.left * scaleX),
    right: Math.round(active.right * scaleX),
  };
}
