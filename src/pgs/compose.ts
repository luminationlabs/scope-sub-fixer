import { ticksToMs } from "./parse.js";
import { decodeRle } from "./rle.js";
import {
  COMPOSITION_STATE,
  SEGMENT_TYPE,
  type DecodedObject,
  type DisplaySet,
  type Epoch,
  type OdsSegment,
  type PgsEvent,
  type PgsEventObject,
  type Rect,
  type Segment,
} from "./types.js";

/**
 * Group a flat segment list into display sets. A display set starts at a PCS
 * and ends at the following END segment (or at the next PCS if END is missing).
 * Segments before the first PCS are ignored.
 */
export function buildDisplaySets(segments: Segment[]): DisplaySet[] {
  const sets: DisplaySet[] = [];
  let current: DisplaySet | null = null;

  for (const seg of segments) {
    if (seg.type === SEGMENT_TYPE.PCS) {
      current = {
        index: sets.length,
        pcs: seg,
        pds: [],
        ods: [],
        pts90k: seg.pts,
        ptsMs: ticksToMs(seg.pts),
      };
      sets.push(current);
      continue;
    }
    if (!current) continue; // stray segment before any PCS
    switch (seg.type) {
      case SEGMENT_TYPE.WDS:
        current.wds = seg;
        break;
      case SEGMENT_TYPE.PDS:
        current.pds.push(seg);
        break;
      case SEGMENT_TYPE.ODS:
        current.ods.push(seg);
        break;
      case SEGMENT_TYPE.END:
        current.end = seg;
        current = null;
        break;
    }
  }

  return sets;
}

/**
 * Split display sets into epochs. A new epoch begins at every epoch-start PCS;
 * display sets before the first one form an implicit leading epoch.
 */
export function buildEpochs(displaySets: DisplaySet[]): Epoch[] {
  const epochs: Epoch[] = [];
  let current: Epoch | null = null;

  for (const ds of displaySets) {
    const isStart = ds.pcs.compositionState === COMPOSITION_STATE.EPOCH_START;
    if (isStart || current === null) {
      current = {
        index: epochs.length,
        startDisplaySetIndex: ds.index,
        displaySets: [],
      };
      epochs.push(current);
    }
    current.displaySets.push(ds);
  }

  return epochs;
}

/**
 * Reassemble the ODS fragments in one display set into whole objects.
 * Fragments of an object are concatenated in stream order before decoding.
 */
export function reassembleObjects(ods: OdsSegment[]): {
  objects: DecodedObject[];
  errors: string[];
} {
  const errors: string[] = [];
  const objects: DecodedObject[] = [];

  type Pending = {
    objectId: number;
    objectVersion: number;
    width: number;
    height: number;
    declaredLength: number;
    chunks: Uint8Array[];
    total: number;
  };
  const pending = new Map<number, Pending>();

  for (const seg of ods) {
    if (seg.isFirst) {
      pending.set(seg.objectId, {
        objectId: seg.objectId,
        objectVersion: seg.objectVersion,
        width: seg.width ?? 0,
        height: seg.height ?? 0,
        declaredLength: seg.objectDataLength ?? 0,
        chunks: [seg.rle],
        total: seg.rle.length,
      });
    } else {
      const p = pending.get(seg.objectId);
      if (!p) {
        errors.push(
          `ODS continuation fragment for object ${seg.objectId} has no first fragment`,
        );
        continue;
      }
      p.chunks.push(seg.rle);
      p.total += seg.rle.length;
    }

    if (seg.isLast) {
      const p = pending.get(seg.objectId);
      if (!p) continue;
      pending.delete(seg.objectId);
      const rle = new Uint8Array(p.total);
      let at = 0;
      for (const c of p.chunks) {
        rle.set(c, at);
        at += c.length;
      }
      // object_data_length counts width + height (4 bytes) plus all RLE bytes.
      const expected = p.declaredLength - 4;
      if (expected >= 0 && expected !== rle.length) {
        errors.push(
          `object ${p.objectId}: object_data_length implies ${expected} RLE byte(s), got ${rle.length}`,
        );
      }
      const decoded = decodeRle(rle, p.width, p.height);
      objects.push({
        objectId: p.objectId,
        objectVersion: p.objectVersion,
        width: p.width,
        height: p.height,
        pixels: decoded.pixels,
        warnings: decoded.warnings,
      });
    }
  }

  for (const p of pending.values()) {
    errors.push(`object ${p.objectId}: fragment sequence never terminated`);
  }

  return { objects, errors };
}

/** Palette alphas indexed by entry id; unlisted entries are fully transparent. */
function emptyPalette(): Uint8Array {
  return new Uint8Array(256);
}

function clampRegion(
  obj: DecodedObject,
  crop: Rect | undefined,
): { x: number; y: number; width: number; height: number } {
  if (!crop) return { x: 0, y: 0, width: obj.width, height: obj.height };
  const x = Math.max(0, Math.min(crop.x, obj.width));
  const y = Math.max(0, Math.min(crop.y, obj.height));
  return {
    x,
    y,
    width: Math.max(0, Math.min(crop.width, obj.width - x)),
    height: Math.max(0, Math.min(crop.height, obj.height - y)),
  };
}

/**
 * The lowest palette alpha that counts as drawn. Below it a pixel is invisible
 * on any screen, and counting it breaks the geometry: Avatar (2009)'s forced
 * Na'vi translations are full-frame 1920x1080 objects whose every pixel outside
 * the text is near-black at alpha ~1, which made each one "1080 px tall",
 * outside a 2 px top bar and impossible to move. 16 (about 6%) is far below an
 * anti-aliased glyph edge that matters and far above such a fill.
 */
export const MIN_VISIBLE_ALPHA = 16;

/** Alpha-aware bounding box of a region of an object, in object coordinates. */
function opaqueBounds(
  obj: DecodedObject,
  alphas: Uint8Array,
  region: { x: number; y: number; width: number; height: number },
): Rect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;

  for (let y = region.y; y < region.y + region.height; y++) {
    const row = y * obj.width;
    for (let x = region.x; x < region.x + region.width; x++) {
      if (alphas[obj.pixels[row + x]!]! < MIN_VISIBLE_ALPHA) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) return null;
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

/**
 * Resolve display sets into displayed subtitle events, honouring epoch
 * semantics: objects, palettes and windows defined in an epoch persist across
 * the display sets that follow it until the next epoch start.
 */
export function resolveEvents(displaySets: DisplaySet[]): PgsEvent[] {
  const events: PgsEvent[] = [];

  let objects = new Map<number, DecodedObject>();
  let palettes = new Map<number, Uint8Array>();
  let windows = new Map<number, Rect>();

  for (let i = 0; i < displaySets.length; i++) {
    const ds = displaySets[i]!;
    const errors: string[] = [];

    if (ds.pcs.compositionState === COMPOSITION_STATE.EPOCH_START) {
      objects = new Map();
      palettes = new Map();
      windows = new Map();
    }

    if (ds.wds) {
      for (const w of ds.wds.windows) {
        windows.set(w.windowId, {
          x: w.x,
          y: w.y,
          width: w.width,
          height: w.height,
        });
      }
    }

    for (const pds of ds.pds) {
      // Replace, never merge. ffmpeg's pgssubdec — which is what Kodi decodes
      // these with — clears the palette on every PDS and then writes the
      // entries it carries, so an entry a later PDS omits is transparent on
      // screen whatever an earlier one said. The `paletteUpdate` flag does not
      // change that: matching the decoder the viewer actually runs is what
      // makes the visible bounding box we compute the real one.
      const alphas = emptyPalette();
      for (const e of pds.entries) alphas[e.entryId] = e.alpha;
      palettes.set(pds.paletteId, alphas);
    }

    const reassembled = reassembleObjects(ds.ods);
    errors.push(...reassembled.errors);
    for (const o of reassembled.objects) objects.set(o.objectId, o);

    if (ds.pcs.objects.length === 0) continue; // screen clear, not an event

    const alphas = palettes.get(ds.pcs.paletteId);
    if (!alphas) {
      errors.push(`palette ${ds.pcs.paletteId} referenced but never defined`);
    }

    const eventObjects: PgsEventObject[] = [];
    for (const co of ds.pcs.objects) {
      const obj = objects.get(co.objectId);
      const window = windows.get(co.windowId) ?? null;
      if (!window) {
        errors.push(`window ${co.windowId} referenced but never defined`);
      }
      if (!obj) {
        errors.push(`object ${co.objectId} referenced but never defined`);
        const rect: Rect = {
          x: co.x,
          y: co.y,
          width: co.crop?.width ?? 0,
          height: co.crop?.height ?? 0,
        };
        eventObjects.push({
          objectId: co.objectId,
          windowId: co.windowId,
          x: co.x,
          y: co.y,
          width: rect.width,
          height: rect.height,
          cropped: co.cropped,
          window,
          objectRect: rect,
          visibleRect: null,
          warnings: [],
        });
        continue;
      }

      const region = clampRegion(obj, co.crop);
      const width = co.cropped ? region.width : obj.width;
      const height = co.cropped ? region.height : obj.height;
      const objectRect: Rect = { x: co.x, y: co.y, width, height };

      let visibleRect: Rect | null = null;
      if (alphas) {
        const bounds = opaqueBounds(obj, alphas, region);
        if (bounds) {
          visibleRect = {
            x: co.x + (bounds.x - region.x),
            y: co.y + (bounds.y - region.y),
            width: bounds.width,
            height: bounds.height,
          };
        }
      }

      eventObjects.push({
        objectId: co.objectId,
        windowId: co.windowId,
        x: co.x,
        y: co.y,
        width,
        height,
        cropped: co.cropped,
        window,
        objectRect,
        visibleRect,
        warnings: obj.warnings,
      });
    }

    const next = displaySets[i + 1];
    events.push({
      index: events.length,
      displaySetIndex: ds.index,
      offset: ds.pcs.offset,
      compositionNumber: ds.pcs.compositionNumber,
      pts90k: ds.pts90k,
      ptsMs: ds.ptsMs,
      endPtsMs: next ? next.ptsMs : undefined,
      videoWidth: ds.pcs.videoWidth,
      videoHeight: ds.pcs.videoHeight,
      forced: ds.pcs.objects.some((o) => o.forced),
      objects: eventObjects,
      errors,
    });
  }

  return events;
}
