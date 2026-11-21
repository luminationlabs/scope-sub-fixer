/**
 * PGS stream comparison (PRD §15).
 *
 * A repair is only allowed to change composition-object and window positions.
 * Everything else — timing, composition structure, palettes, bitmaps — must
 * come back byte-identical, so each display set is reduced to a fingerprint
 * that deliberately excludes x/y, and the two fingerprints must match exactly.
 * The positions are then reported separately, as deltas.
 */
import { createHash } from "node:crypto";
import { refusedOffendingCount, type TrackAnalysis } from "../scan/analyze.js";
import type { DisplaySet, PgsEvent } from "../pgs/types.js";
import type { PgsPositionChange, PgsTrackComparison } from "./types.js";

interface ObjectFingerprint {
  objectId: number;
  windowId: number;
  flags: number;
  x: number;
  y: number;
  crop: string;
}

interface WindowFingerprint {
  windowId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DisplaySetFingerprint {
  index: number;
  ptsMs: number;
  compositionNumber: number;
  compositionState: number;
  paletteId: number;
  paletteUpdate: boolean;
  objects: ObjectFingerprint[];
  windows: WindowFingerprint[];
  palettes: string[];
  bitmaps: string[];
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

function fingerprint(ds: DisplaySet): DisplaySetFingerprint {
  const palettes = ds.pds.map((p) => {
    const entries = p.entries
      .map((e) => `${e.entryId}:${e.y},${e.cr},${e.cb},${e.alpha}`)
      .join("|");
    return `${p.paletteId}v${p.paletteVersion}#${sha(Buffer.from(entries, "utf8"))}`;
  });
  // Fragments of one object are hashed in stream order, so a re-fragmented but
  // otherwise identical bitmap would show up — which is what we want.
  const bitmaps = ds.ods.map(
    (o) =>
      `${o.objectId}v${o.objectVersion} ${o.width ?? "-"}x${o.height ?? "-"} ` +
      `${o.sequenceFlag.toString(16)} ${o.rle.length}#${sha(o.rle)}`,
  );
  return {
    index: ds.index,
    ptsMs: ds.ptsMs,
    compositionNumber: ds.pcs.compositionNumber,
    compositionState: ds.pcs.compositionState,
    paletteId: ds.pcs.paletteId,
    paletteUpdate: ds.pcs.paletteUpdate,
    objects: ds.pcs.objects.map((o) => ({
      objectId: o.objectId,
      windowId: o.windowId,
      flags: o.flags,
      x: o.x,
      y: o.y,
      crop: o.crop ? `${o.crop.x},${o.crop.y},${o.crop.width},${o.crop.height}` : "",
    })),
    windows: (ds.wds?.windows ?? []).map((w) => ({
      windowId: w.windowId,
      x: w.x,
      y: w.y,
      width: w.width,
      height: w.height,
    })),
    palettes,
    bitmaps,
  };
}

function comparePositionless(
  a: DisplaySetFingerprint,
  b: DisplaySetFingerprint,
  problems: string[],
): void {
  const where = `display set ${a.index}`;
  const scalar = (name: string, x: unknown, y: unknown): void => {
    if (x !== y) problems.push(`${where}: ${name} ${String(x)} → ${String(y)}`);
  };
  scalar("pts", a.ptsMs, b.ptsMs);
  scalar("composition number", a.compositionNumber, b.compositionNumber);
  scalar("composition state", a.compositionState, b.compositionState);
  scalar("palette id", a.paletteId, b.paletteId);
  scalar("palette update", a.paletteUpdate, b.paletteUpdate);
  if (a.palettes.join(";") !== b.palettes.join(";")) {
    problems.push(`${where}: palette definitions differ`);
  }
  if (a.bitmaps.join(";") !== b.bitmaps.join(";")) {
    problems.push(`${where}: object bitmaps differ`);
  }
  if (a.objects.length !== b.objects.length) {
    problems.push(
      `${where}: ${a.objects.length} composition object(s) → ${b.objects.length}`,
    );
    return;
  }
  for (let i = 0; i < a.objects.length; i++) {
    const x = a.objects[i]!;
    const y = b.objects[i]!;
    if (x.objectId !== y.objectId || x.windowId !== y.windowId || x.flags !== y.flags) {
      problems.push(
        `${where}: object ${x.objectId} (window ${x.windowId}, flags 0x${x.flags.toString(16)}) → ` +
          `object ${y.objectId} (window ${y.windowId}, flags 0x${y.flags.toString(16)})`,
      );
    }
    if (x.crop !== y.crop) {
      problems.push(`${where}: object ${x.objectId} crop ${x.crop} → ${y.crop}`);
    }
  }
  if (a.windows.length !== b.windows.length) {
    problems.push(`${where}: ${a.windows.length} window(s) → ${b.windows.length}`);
    return;
  }
  for (let i = 0; i < a.windows.length; i++) {
    const x = a.windows[i]!;
    const y = b.windows[i]!;
    if (x.windowId !== y.windowId || x.width !== y.width || x.height !== y.height) {
      problems.push(
        `${where}: window ${x.windowId} ${x.width}x${x.height} → ` +
          `window ${y.windowId} ${y.width}x${y.height}`,
      );
    }
  }
}

/** Object statuses in the fixed stream, keyed "eventIndex:objectId". */
function insideByObject(fixed: TrackAnalysis): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const c of fixed.classified) {
    for (const o of c.objects) {
      map.set(
        `${c.index}:${o.objectId}`,
        o.status === "SAFE" || o.status === "TOUCHING_BOUNDARY",
      );
    }
  }
  return map;
}

export interface ComparePgsOptions {
  /** Set when the fixed track is an extra appended by --keep-original-subtitle. */
  appended?: boolean;
  /**
   * Set when this track was deliberately kept as it was — the untouched
   * original in A/B mode, whose corrected twin is a separate pairing. Nothing
   * about it was supposed to move, so everything still outside is expected.
   */
  preserved?: boolean;
  /** Cap on how many individual position changes are listed. */
  maxChanges?: number;
}

export function comparePgsTracks(
  original: TrackAnalysis,
  fixed: TrackAnalysis,
  options: ComparePgsOptions = {},
): PgsTrackComparison {
  const problems: string[] = [];
  const changes: PgsPositionChange[] = [];
  const maxChanges = options.maxChanges ?? 200;

  if (original.error) problems.push(`original track: ${original.error}`);
  if (fixed.error) problems.push(`fixed track: ${fixed.error}`);

  if (original.displaySets.length !== fixed.displaySets.length) {
    problems.push(
      `${original.displaySets.length} display set(s) → ${fixed.displaySets.length}`,
    );
  }
  if (original.events.length !== fixed.events.length) {
    problems.push(`${original.events.length} event(s) → ${fixed.events.length}`);
  }

  const inside = insideByObject(fixed);
  // Every event still outside in the fixed track, not only the moved ones: an
  // event the fixer never touched is just as invisible on screen.
  const stillOutside = fixed.classified
    .filter((c) => c.needsFix)
    .map((c) => ({ eventIndex: c.index, ptsMs: c.ptsMs }));
  const expectedStillOutsideCount =
    options.preserved === true ? stillOutside.length : refusedOffendingCount(original);
  const n = Math.min(original.displaySets.length, fixed.displaySets.length);
  for (let i = 0; i < n; i++) {
    comparePositionless(
      fingerprint(original.displaySets[i]!),
      fingerprint(fixed.displaySets[i]!),
      problems,
    );
  }

  // Event-level facts and the actual moves.
  const events = Math.min(original.events.length, fixed.events.length);
  let changedEventCount = 0;
  for (let i = 0; i < events; i++) {
    const a = original.events[i]!;
    const b = fixed.events[i]!;
    if (a.ptsMs !== b.ptsMs) {
      problems.push(`event ${i}: pts ${a.ptsMs} ms → ${b.ptsMs} ms`);
    }
    if (a.forced !== b.forced) {
      problems.push(`event ${i}: forced ${a.forced} → ${b.forced}`);
    }
    let moved = false;
    for (let j = 0; j < Math.min(a.objects.length, b.objects.length); j++) {
      const ao = a.objects[j]!;
      const bo = b.objects[j]!;
      const dx = bo.x - ao.x;
      const dy = bo.y - ao.y;
      if (dx === 0 && dy === 0) continue;
      moved = true;
      const isInside = inside.get(`${b.index}:${bo.objectId}`) === true;
      if (changes.length < maxChanges) {
        changes.push({
          eventIndex: i,
          ptsMs: b.ptsMs,
          objectId: bo.objectId,
          windowId: bo.windowId,
          dx,
          dy,
          insideActiveArea: isInside,
        });
      }
    }
    if (moved) changedEventCount++;
  }

  const outsideBefore = objectsOutsideWindow(original.events);
  const outsideAfter = objectsOutsideWindow(fixed.events);
  if (outsideAfter > outsideBefore) {
    problems.push(
      `${outsideAfter} object(s) lie outside their window, ${outsideBefore} in the original`,
    );
  }

  // Anything the fixer left behind is worth saying out loud. It is only a
  // failure when there is more of it than the policy deliberately refused.
  return {
    originalTrackId: original.track.id,
    fixedTrackId: fixed.track.id,
    language: fixed.track.language,
    name: fixed.track.name,
    appended: options.appended === true,
    eventCount: fixed.events.length,
    changedEventCount,
    changes,
    stillOutsideCount: stillOutside.length,
    expectedStillOutsideCount,
    stillOutside: stillOutside.slice(0, maxChanges),
    problems,
  };
}

/**
 * How many composition objects lie, in whole or in part, outside the window
 * they are drawn in. The format forbids it. A fix never makes one — the
 * planner moves an object with its window, or inside a window that stays —
 * and this is the independent count that says so of a finished file: it must
 * not be higher than the original's (a disc authored that way keeps its own).
 */
export function objectsOutsideWindow(events: readonly PgsEvent[]): number {
  let n = 0;
  for (const event of events) {
    for (const o of event.objects) {
      const w = o.window;
      const r = o.objectRect;
      if (w === null) continue;
      if (r.x < w.x || r.y < w.y || r.x + r.width > w.x + w.width || r.y + r.height > w.y + w.height) n++;
    }
  }
  return n;
}

/**
 * A positionless summary of a whole PGS track.
 *
 * It is built from exactly the same per-display-set fingerprint the pairwise
 * comparison uses, so it carries the same promise: everything a repair is
 * allowed to change (composition-object and window x/y) is excluded, and
 * everything it must not change is included. `plan` stores one per track and
 * `apply` recomputes it from the finished output, which lets a batch run prove
 * a repair kept the timing, structure, palettes and bitmaps without re-reading
 * the input.
 */
export interface PgsStreamFingerprint {
  displaySetCount: number;
  eventCount: number;
  /** Display-set presentation timestamps, in stream order. */
  ptsHash: string;
  /** Composition numbers/states, object and window identities, crop rects. */
  structureHash: string;
  /** ODS identity plus RLE payloads. */
  bitmapHash: string;
  paletteHash: string;
}

export function fingerprintTrack(
  displaySets: readonly DisplaySet[],
): PgsStreamFingerprint {
  const pts = createHash("sha256");
  const structure = createHash("sha256");
  const bitmaps = createHash("sha256");
  const palettes = createHash("sha256");
  let eventCount = 0;

  for (const ds of displaySets) {
    const f = fingerprint(ds);
    pts.update(`${f.index}:${f.ptsMs}\n`);
    structure.update(
      `${f.index}|${f.compositionNumber}|${f.compositionState}|${f.paletteId}|` +
        `${f.paletteUpdate ? 1 : 0}|` +
        f.objects
          .map((o) => `${o.objectId},${o.windowId},${o.flags},${o.crop}`)
          .join(";") +
        "|" +
        f.windows.map((w) => `${w.windowId},${w.width}x${w.height}`).join(";") +
        "\n",
    );
    bitmaps.update(`${f.bitmaps.join(";")}\n`);
    palettes.update(`${f.palettes.join(";")}\n`);
    if (f.objects.length > 0) eventCount++;
  }

  return {
    displaySetCount: displaySets.length,
    eventCount,
    ptsHash: pts.digest("hex"),
    structureHash: structure.digest("hex"),
    bitmapHash: bitmaps.digest("hex"),
    paletteHash: palettes.digest("hex"),
  };
}

/** Everything in `b` that does not match `a`, in operator-readable form. */
export function fingerprintDifferences(
  a: PgsStreamFingerprint,
  b: PgsStreamFingerprint,
): string[] {
  const out: string[] = [];
  const cmp = (name: string, x: unknown, y: unknown): void => {
    if (x !== y) out.push(`${name} ${String(x)} → ${String(y)}`);
  };
  cmp("display set count", a.displaySetCount, b.displaySetCount);
  cmp("event count", a.eventCount, b.eventCount);
  if (a.ptsHash !== b.ptsHash) out.push("presentation timestamps differ");
  if (a.structureHash !== b.structureHash) out.push("composition structure differs");
  if (a.bitmapHash !== b.bitmapHash) out.push("object bitmaps differ");
  if (a.paletteHash !== b.paletteHash) out.push("palette definitions differ");
  return out;
}
