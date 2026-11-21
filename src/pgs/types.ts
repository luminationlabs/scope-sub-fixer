/**
 * PGS (Presentation Graphic Stream, "S_HDMV/PGS") segment model.
 *
 * A .sup file is a flat sequence of segments, each prefixed by a 13-byte header:
 *   magic "PG" (2) | PTS u32be (90 kHz) | DTS u32be (90 kHz) | type u8 | size u16be
 * followed by `size` payload bytes.
 *
 * Inside an MKV the same segments appear in block payloads WITHOUT that header;
 * there each segment is just: type u8 | size u16be | payload.
 */

export const SEGMENT_TYPE = {
  PDS: 0x14,
  ODS: 0x15,
  PCS: 0x16,
  WDS: 0x17,
  END: 0x80,
} as const;

/** Composition state values carried in the PCS. */
export const COMPOSITION_STATE = {
  NORMAL: 0x00,
  ACQUISITION_POINT: 0x40,
  EPOCH_START: 0x80,
} as const;

/**
 * ODS `last_in_sequence_flag` bits.
 *
 * 0x80 marks the FIRST fragment of an object — the one carrying
 * object_data_length, width and height — and 0x40 the LAST. A single-fragment
 * object therefore has 0xC0, which is why the two were invisible when swapped:
 * only objects big enough to be split (>~64 KB of RLE) tell them apart. This
 * matches the Blu-ray spec and ffmpeg's `pgssubdec.c`, which reads further RLE
 * data whenever `!(sequence_desc & 0x80)`.
 */
export const SEQUENCE_FLAG = {
  FIRST: 0x80,
  LAST: 0x40,
  FIRST_AND_LAST: 0xc0,
} as const;

/** Fields shared by every segment. */
export interface SegmentBase {
  /** Presentation timestamp in 90 kHz ticks. */
  pts: number;
  /** Decode timestamp in 90 kHz ticks (0 for MKV-sourced segments). */
  dts: number;
  /** Byte offset of the segment header within the input buffer. */
  offset: number;
  /** Payload length in bytes (the u16 `segment_size` field). */
  size: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One composition object entry inside a PCS. */
export interface CompositionObject {
  objectId: number;
  windowId: number;
  /** Raw flags byte: 0x80 = cropped, 0x40 = forced. */
  flags: number;
  cropped: boolean;
  forced: boolean;
  x: number;
  y: number;
  /** Present only when `cropped`. */
  crop?: Rect;
}

/** 0x16 — Presentation Composition Segment. */
export interface PcsSegment extends SegmentBase {
  type: typeof SEGMENT_TYPE.PCS;
  videoWidth: number;
  videoHeight: number;
  frameRate: number;
  compositionNumber: number;
  compositionState: number;
  /** Raw palette_update_flag byte (0x80 = true). */
  paletteUpdateFlag: number;
  paletteUpdate: boolean;
  paletteId: number;
  objects: CompositionObject[];
}

export interface WindowDefinition {
  windowId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 0x17 — Window Definition Segment. */
export interface WdsSegment extends SegmentBase {
  type: typeof SEGMENT_TYPE.WDS;
  windows: WindowDefinition[];
}

/** One YCrCb + alpha palette entry. */
export interface PaletteEntry {
  entryId: number;
  y: number;
  cr: number;
  cb: number;
  alpha: number;
}

/** 0x14 — Palette Definition Segment. */
export interface PdsSegment extends SegmentBase {
  type: typeof SEGMENT_TYPE.PDS;
  paletteId: number;
  paletteVersion: number;
  entries: PaletteEntry[];
}

/** 0x15 — Object Definition Segment (may be one fragment of several). */
export interface OdsSegment extends SegmentBase {
  type: typeof SEGMENT_TYPE.ODS;
  objectId: number;
  objectVersion: number;
  /** Raw last_in_sequence_flag byte: 0x80 first, 0x40 last, 0xC0 both. */
  sequenceFlag: number;
  isFirst: boolean;
  isLast: boolean;
  /**
   * Only on a first fragment: total byte count of everything after this field
   * across all fragments (width + height + all RLE bytes).
   */
  objectDataLength?: number;
  /** Only on a first fragment. */
  width?: number;
  /** Only on a first fragment. */
  height?: number;
  /** Raw RLE bytes carried by THIS fragment. */
  rle: Uint8Array;
}

/** 0x80 — End of Display Set. Empty payload. */
export interface EndSegment extends SegmentBase {
  type: typeof SEGMENT_TYPE.END;
}

export type Segment =
  | PcsSegment
  | WdsSegment
  | PdsSegment
  | OdsSegment
  | EndSegment;

/** A PCS plus everything up to and including its END segment. */
export interface DisplaySet {
  index: number;
  pcs: PcsSegment;
  wds?: WdsSegment;
  pds: PdsSegment[];
  ods: OdsSegment[];
  end?: EndSegment;
  pts90k: number;
  ptsMs: number;
}

/** A run of display sets starting at an epoch-start PCS. */
export interface Epoch {
  index: number;
  /** Index into the display-set array where this epoch begins. */
  startDisplaySetIndex: number;
  displaySets: DisplaySet[];
}

/** A resolved object as it appears on screen for one event. */
export interface PgsEventObject {
  objectId: number;
  windowId: number;
  /** Composition x/y from the PCS. */
  x: number;
  y: number;
  /** Rendered size: crop size when cropped, else the ODS bitmap size. */
  width: number;
  height: number;
  cropped: boolean;
  /** The window this object is composited into, when resolvable. */
  window: Rect | null;
  /** The on-screen rectangle the object occupies (x, y, width, height). */
  objectRect: Rect;
  /**
   * Alpha-aware bounding box of the actually visible pixels, in screen
   * coordinates. `null` when every pixel is fully transparent.
   */
  visibleRect: Rect | null;
  /** Non-fatal RLE decode issues for this object's bitmap. */
  warnings: string[];
}

/** A displayed subtitle: one display set whose PCS has >0 composition objects. */
export interface PgsEvent {
  index: number;
  displaySetIndex: number;
  /** Byte offset of the PCS segment header in the source buffer. */
  offset: number;
  compositionNumber: number;
  pts90k: number;
  ptsMs: number;
  /** PTS of the next display set of any kind, or undefined at end of stream. */
  endPtsMs: number | undefined;
  videoWidth: number;
  videoHeight: number;
  forced: boolean;
  objects: PgsEventObject[];
  /** Unresolvable references etc. Recorded, never thrown. */
  errors: string[];
}

/** A fully reassembled and decoded bitmap object. */
export interface DecodedObject {
  objectId: number;
  objectVersion: number;
  width: number;
  height: number;
  /** width * height palette indices, row-major. */
  pixels: Uint8Array;
  warnings: string[];
}
