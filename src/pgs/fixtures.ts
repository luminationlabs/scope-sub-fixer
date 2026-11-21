/**
 * Declarative builder for synthetic .sup files. Everything the parser tests
 * need can be described here without shipping real Blu-ray material.
 */
import { msToTicks } from "./parse.js";
import { encodeRle } from "./rle.js";
import { serializeSegmentPayload, serializeSup } from "./serialize.js";
import {
  COMPOSITION_STATE,
  SEGMENT_TYPE,
  SEQUENCE_FLAG,
  type CompositionObject,
  type OdsSegment,
  type PaletteEntry,
  type Segment,
} from "./types.js";

/** Largest payload a segment can carry, since segment_size is a u16. */
export const MAX_SEGMENT_PAYLOAD = 0xffff;
/** object_id u16 + version u8 + flag u8 + data_length u24 + w u16 + h u16. */
const ODS_FIRST_HEADER = 11;
/** object_id u16 + version u8 + flag u8. */
const ODS_CONT_HEADER = 4;

export type CompositionStateName =
  | "epochStart"
  | "acquisitionPoint"
  | "normal";

export interface FixtureRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FixtureObject {
  /** Defaults to the object's position in the event list. */
  objectId?: number;
  x: number;
  y: number;
  /** Required unless `reuse` is set. */
  width?: number;
  height?: number;
  /** Opaque area, relative to the object. Defaults to the whole object. */
  opaqueRect?: FixtureRect;
  /** Palette index used for opaque pixels. Defaults to 1. */
  paletteIndex?: number;
  /** Fill the opaque area with a 1/2 checkerboard so the RLE stays large. */
  noise?: boolean;
  forced?: boolean;
  windowId?: number;
  /** Reference an object defined earlier in the epoch; emits no ODS. */
  reuse?: boolean;
  objectVersion?: number;
  /** Emits a cropped composition object; `crop` is in object coordinates. */
  crop?: { x: number; y: number; width: number; height: number };
}

export interface FixtureWindow {
  windowId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FixtureEvent {
  ptsMs: number;
  /** When set, a clearing display set (PCS with no objects) is emitted here. */
  endPtsMs?: number;
  /** Defaults to "epochStart". */
  state?: CompositionStateName;
  objects: FixtureObject[];
  /** Explicit windows; otherwise derived from the objects. */
  windows?: FixtureWindow[];
  /** Force a WDS on/off. Defaults to on except for "normal" display sets. */
  emitWindows?: boolean;
  /** Force a PDS on/off. Defaults to on except for "normal" display sets. */
  emitPalette?: boolean;
  paletteId?: number;
  paletteVersion?: number;
  compositionNumber?: number;
}

export interface SupSpec {
  /** Canvas size written into every PCS. */
  width: number;
  height: number;
  frameRate?: number;
  /** Defaults to: 0 transparent, 1 opaque white, 2 opaque grey. */
  palette?: PaletteEntry[];
  events: FixtureEvent[];
}

export const DEFAULT_PALETTE: PaletteEntry[] = [
  { entryId: 0, y: 16, cr: 128, cb: 128, alpha: 0 },
  { entryId: 1, y: 235, cr: 128, cb: 128, alpha: 255 },
  { entryId: 2, y: 128, cr: 128, cb: 128, alpha: 255 },
];

const STATE_VALUE: Record<CompositionStateName, number> = {
  epochStart: COMPOSITION_STATE.EPOCH_START,
  acquisitionPoint: COMPOSITION_STATE.ACQUISITION_POINT,
  normal: COMPOSITION_STATE.NORMAL,
};

/** Render an object's index bitmap from its declarative description. */
export function renderObjectPixels(o: FixtureObject): Uint8Array {
  const width = o.width ?? 0;
  const height = o.height ?? 0;
  const pixels = new Uint8Array(width * height);
  const rect = o.opaqueRect ?? { x: 0, y: 0, w: width, h: height };
  const index = o.paletteIndex ?? 1;
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(width, rect.x + rect.w);
  const y1 = Math.min(height, rect.y + rect.h);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      pixels[y * width + x] = o.noise ? ((x + y) % 2 === 0 ? 1 : 2) : index;
    }
  }
  return pixels;
}

/** Split an object's RLE into as many ODS segments as the u16 size demands. */
export function buildOdsSegments(
  objectId: number,
  objectVersion: number,
  width: number,
  height: number,
  rle: Uint8Array,
  pts: number,
): OdsSegment[] {
  const objectDataLength = 4 + rle.length; // width + height + RLE
  const firstCapacity = MAX_SEGMENT_PAYLOAD - ODS_FIRST_HEADER;
  const contCapacity = MAX_SEGMENT_PAYLOAD - ODS_CONT_HEADER;

  if (rle.length <= firstCapacity) {
    return [
      {
        type: SEGMENT_TYPE.ODS,
        pts,
        dts: 0,
        offset: 0,
        size: 0,
        objectId,
        objectVersion,
        sequenceFlag: SEQUENCE_FLAG.FIRST_AND_LAST,
        isFirst: true,
        isLast: true,
        objectDataLength,
        width,
        height,
        rle,
      },
    ];
  }

  const segments: OdsSegment[] = [
    {
      type: SEGMENT_TYPE.ODS,
      pts,
      dts: 0,
      offset: 0,
      size: 0,
      objectId,
      objectVersion,
      sequenceFlag: SEQUENCE_FLAG.FIRST,
      isFirst: true,
      isLast: false,
      objectDataLength,
      width,
      height,
      rle: rle.subarray(0, firstCapacity),
    },
  ];

  let at = firstCapacity;
  while (at < rle.length) {
    const end = Math.min(at + contCapacity, rle.length);
    const isLast = end === rle.length;
    segments.push({
      type: SEGMENT_TYPE.ODS,
      pts,
      dts: 0,
      offset: 0,
      size: 0,
      objectId,
      objectVersion,
      sequenceFlag: isLast ? SEQUENCE_FLAG.LAST : 0x00,
      isFirst: false,
      isLast,
      rle: rle.subarray(at, end),
    });
    at = end;
  }

  return segments;
}

function deriveWindows(objects: FixtureObject[]): FixtureWindow[] {
  const byWindow = new Map<number, FixtureWindow>();
  for (const o of objects) {
    const windowId = o.windowId ?? 0;
    const w = o.crop?.width ?? o.width ?? 0;
    const h = o.crop?.height ?? o.height ?? 0;
    const existing = byWindow.get(windowId);
    if (!existing) {
      byWindow.set(windowId, { windowId, x: o.x, y: o.y, width: w, height: h });
      continue;
    }
    const x = Math.min(existing.x, o.x);
    const y = Math.min(existing.y, o.y);
    const right = Math.max(existing.x + existing.width, o.x + w);
    const bottom = Math.max(existing.y + existing.height, o.y + h);
    byWindow.set(windowId, {
      windowId,
      x,
      y,
      width: right - x,
      height: bottom - y,
    });
  }
  return [...byWindow.values()].sort((a, b) => a.windowId - b.windowId);
}

/** Build the segment list described by `spec`, with sizes and offsets filled in. */
export function buildSupSegments(spec: SupSpec): Segment[] {
  const segments: Segment[] = [];
  let compositionNumber = 0;

  for (const ev of spec.events) {
    const state = ev.state ?? "epochStart";
    const pts = msToTicks(ev.ptsMs);
    const paletteId = ev.paletteId ?? 0;
    const emitWindows = ev.emitWindows ?? state !== "normal";
    const emitPalette = ev.emitPalette ?? state !== "normal";

    const compositionObjects: CompositionObject[] = ev.objects.map((o, i) => {
      const flags = (o.crop ? 0x80 : 0x00) | (o.forced ? 0x40 : 0x00);
      const co: CompositionObject = {
        objectId: o.objectId ?? i,
        windowId: o.windowId ?? 0,
        flags,
        cropped: o.crop !== undefined,
        forced: o.forced === true,
        x: o.x,
        y: o.y,
      };
      if (o.crop) co.crop = { ...o.crop };
      return co;
    });

    segments.push({
      type: SEGMENT_TYPE.PCS,
      pts,
      dts: 0,
      offset: 0,
      size: 0,
      videoWidth: spec.width,
      videoHeight: spec.height,
      frameRate: spec.frameRate ?? 0x10,
      compositionNumber: ev.compositionNumber ?? compositionNumber++,
      compositionState: STATE_VALUE[state],
      paletteUpdateFlag: 0x00,
      paletteUpdate: false,
      paletteId,
      objects: compositionObjects,
    });

    if (emitWindows) {
      const windows = ev.windows ?? deriveWindows(ev.objects);
      segments.push({
        type: SEGMENT_TYPE.WDS,
        pts,
        dts: 0,
        offset: 0,
        size: 0,
        windows: windows.map((w) => ({ ...w })),
      });
    }

    if (emitPalette) {
      segments.push({
        type: SEGMENT_TYPE.PDS,
        pts,
        dts: 0,
        offset: 0,
        size: 0,
        paletteId,
        paletteVersion: ev.paletteVersion ?? 0,
        entries: (spec.palette ?? DEFAULT_PALETTE).map((e) => ({ ...e })),
      });
    }

    for (const [i, o] of ev.objects.entries()) {
      if (o.reuse) continue;
      const objectId = o.objectId ?? i;
      const width = o.width ?? 0;
      const height = o.height ?? 0;
      const rle = encodeRle(renderObjectPixels(o), width, height);
      segments.push(
        ...buildOdsSegments(
          objectId,
          o.objectVersion ?? 0,
          width,
          height,
          rle,
          pts,
        ),
      );
    }

    segments.push({
      type: SEGMENT_TYPE.END,
      pts,
      dts: 0,
      offset: 0,
      size: 0,
    });

    if (ev.endPtsMs !== undefined) {
      const clearPts = msToTicks(ev.endPtsMs);
      segments.push({
        type: SEGMENT_TYPE.PCS,
        pts: clearPts,
        dts: 0,
        offset: 0,
        size: 0,
        videoWidth: spec.width,
        videoHeight: spec.height,
        frameRate: spec.frameRate ?? 0x10,
        compositionNumber: compositionNumber++,
        compositionState: COMPOSITION_STATE.NORMAL,
        paletteUpdateFlag: 0x00,
        paletteUpdate: false,
        paletteId,
        objects: [],
      });
      segments.push({
        type: SEGMENT_TYPE.END,
        pts: clearPts,
        dts: 0,
        offset: 0,
        size: 0,
      });
    }
  }

  return fillSizesAndOffsets(segments);
}

/** Set each segment's `size` and `offset` as if it had been parsed from .sup. */
export function fillSizesAndOffsets(segments: Segment[]): Segment[] {
  let at = 0;
  return segments.map((seg) => {
    const size = serializeSegmentPayload(seg).length;
    const withMeta = { ...seg, size, offset: at } as Segment;
    at += 13 + size;
    return withMeta;
  });
}

/** Build a complete .sup byte stream from a declarative spec. */
export function buildSup(spec: SupSpec): Uint8Array {
  return serializeSup(buildSupSegments(spec));
}
