/**
 * Turn a `MovePlan` into concrete edits.
 *
 * The plan is expressed per event and per (epoch, window); PGS is expressed per
 * display set. This module bridges the two, and it is the only place that knows
 * the rules:
 *
 *  - a display set's composition objects take the delta the plan gave the event
 *    that display set is (screen-clearing display sets have no objects at all);
 *  - a display set's WDS windows take the delta the plan gave that window for
 *    the whole epoch, whether or not this particular display set is an event —
 *    a normal-case display set often carries no WDS while its objects still
 *    need the delta, and an epoch's later WDS must not drift away from it.
 *
 * Segment sizes never change (only u16 x/y fields are rewritten), so the same
 * function serves both `--method patch` (byte edits against the MKV) and
 * `--method remux` (rewritten segments for a new .sup).
 */
import type { MovePlan, PositionDelta } from "../geometry/policy.js";
import {
  BLOCK_HEADER_SIZE,
  applyPositionDelta,
  displaySetSegments,
  type BytePatch,
} from "../pgs/patch.js";
import { SEGMENT_TYPE, type DisplaySet, type Segment } from "../pgs/types.js";

export interface DeltaApplication {
  /** Byte edits against the buffer the display sets were parsed from. */
  patches: BytePatch[];
  /** Rewritten segments, keyed by the original segment offset. */
  replacements: Map<number, Segment>;
  /** Display sets that received at least one edit. */
  displaySetsTouched: number;
  /** Distinct events whose composition objects moved. */
  eventsMoved: number;
}

/**
 * Apply a `MovePlan` to a list of display sets parsed from `headerSize`-headed
 * segments (3 inside an MKV block, 13 in a .sup).
 */
export function applyPlanToDisplaySets(
  displaySets: readonly DisplaySet[],
  epochByDisplaySet: ReadonlyMap<number, number>,
  plan: MovePlan,
  headerSize: number,
): DeltaApplication {
  const entryByDisplaySet = new Map(plan.entries.map((e) => [e.displaySetIndex, e]));
  const patches: BytePatch[] = [];
  const replacements = new Map<number, Segment>();
  let displaySetsTouched = 0;
  let eventsMoved = 0;

  for (const ds of displaySets) {
    const entry = entryByDisplaySet.get(ds.index);
    const epochId = epochByDisplaySet.get(ds.index);
    const windowDeltas: Map<number, PositionDelta> | undefined =
      epochId === undefined ? undefined : plan.windowDeltasByEpoch.get(epochId);
    const objectDeltas = entry?.objectDeltas;
    const haveObjects = (objectDeltas?.size ?? 0) > 0;
    const haveWindows = (windowDeltas?.size ?? 0) > 0;
    if (!haveObjects && !haveWindows) continue;

    const before = displaySetSegments(ds);
    const result = applyPositionDelta(
      before,
      {
        ...(objectDeltas === undefined ? {} : { objectDeltas }),
        ...(windowDeltas === undefined ? {} : { windowDeltas }),
      },
      { headerSize },
    );
    if (result.patches.length === 0) continue;

    displaySetsTouched++;
    if (haveObjects) eventsMoved++;
    patches.push(...result.patches);
    for (let i = 0; i < before.length; i++) {
      const next = result.segments[i]!;
      if (next !== before[i]) replacements.set(before[i]!.offset, next);
    }
  }

  patches.sort((a, b) => a.offset - b.offset);
  return { patches, replacements, displaySetsTouched, eventsMoved };
}

/**
 * Rebuild a whole segment list with the plan applied. Used by the remux path,
 * where the .sup is serialized from scratch.
 */
export function rewriteSegments(
  segments: readonly Segment[],
  application: DeltaApplication,
): Segment[] {
  return segments.map((s) => application.replacements.get(s.offset) ?? s);
}

/**
 * Every byte range in a PGS segment list that holds a composition-object or
 * window position. `verify` uses it to prove that a patched MKV differs from
 * its original only inside those fields.
 */
export interface PositionField {
  offset: number;
  length: 4;
  kind: "object" | "window";
  id: number;
  x: number;
  y: number;
}

export function positionFields(
  segments: readonly Segment[],
  headerSize: number = BLOCK_HEADER_SIZE,
): PositionField[] {
  const out: PositionField[] = [];
  for (const seg of segments) {
    const payload = seg.offset + headerSize;
    if (seg.type === SEGMENT_TYPE.PCS) {
      let at = payload + 11;
      for (const o of seg.objects) {
        out.push({
          offset: at + 4,
          length: 4,
          kind: "object",
          id: o.objectId,
          x: o.x,
          y: o.y,
        });
        at += o.cropped ? 16 : 8;
      }
    } else if (seg.type === SEGMENT_TYPE.WDS) {
      let at = payload + 1;
      for (const w of seg.windows) {
        out.push({
          offset: at + 1,
          length: 4,
          kind: "window",
          id: w.windowId,
          x: w.x,
          y: w.y,
        });
        at += 9;
      }
    }
  }
  return out.sort((a, b) => a.offset - b.offset);
}
