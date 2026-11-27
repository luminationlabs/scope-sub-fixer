/**
 * Extract the PGS (S_HDMV/PGS) blocks of one Matroska track by walking the
 * container directly.
 *
 * `mkvextract` spawns a process and writes a whole temp .sup to hand back one
 * subtitle track. This walker parses only the headers it needs (EBML header,
 * Info, Tracks) and then steps through clusters, physically skipping every
 * block that does not belong to the requested track — no subprocess, no temp
 * file, and, above all, the absolute file offsets the patcher needs. How many
 * bytes that transfers depends on the read strategy (`DEFAULT_READ_STRATEGY`
 * streams the file); see `EbmlReader.stats` for what a pass actually cost.
 *
 * ## Absolute offset contract
 *
 * `PgsBlock.fileOffset` is the offset, **in the MKV**, of the first byte of the
 * block's frame data — i.e. the first byte of the first PGS segment carried by
 * that block. `readPgsTracksData` uses it to rewrite every parsed segment's
 * `offset` from "relative to its block payload" to "absolute in the MKV", so
 * that for any returned segment:
 *
 *     mkvBytes.subarray(seg.offset, seg.offset + BLOCK_HEADER_SIZE + seg.size)
 *       === serializeBlockSegment(seg)
 *
 * That makes `applyPositionDelta(segments, deltas, { headerSize: BLOCK_HEADER_SIZE })`
 * produce byte patches whose offsets can be written straight into the MKV.
 *
 * The contract holds only when the track carries no Matroska content
 * compression (mkvmerge zlib-compresses subtitle tracks by default; MakeMKV
 * remuxes normally do not). For a compressed track the payload is inflated in
 * memory, so segment offsets no longer address file bytes — pass
 * `requireByteAddressable: true` to turn that into an error instead, or check
 * `PgsTrackData.compressed`.
 */
import { inflateSync } from "node:zlib";

import {
  DEFAULT_READ_STRATEGY,
  EbmlError,
  EbmlReader,
  decodeSignedVint,
  decodeVint,
  formatId,
  iterateElements,
  readUintBE,
  type EbmlElement,
  type EbmlReaderOptions,
  type EbmlStats,
} from "./ebml.js";
import { parseBlockSegments, type Segment } from "../pgs/index.js";

/** Matroska element IDs, including their vint marker bits. */
export const EBML_ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackUID: 0x73c5,
  TrackType: 0x83,
  CodecID: 0x86,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  ContentEncodings: 0x6d80,
  ContentEncoding: 0x6240,
  ContentEncodingType: 0x5033,
  ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254,
  ContentCompSettings: 0x4255,
  ContentEncryption: 0x5035,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  Cues: 0x1c53bb6b,
  Tags: 0x1254c367,
  Attachments: 0x1941a469,
  Chapters: 0x1043a770,
  Void: 0xec,
  CRC32: 0xbf,
  Position: 0xa7,
  PrevSize: 0xab,
  BlockAdditions: 0x75a1,
  ReferenceBlock: 0xfb,
  DiscardPadding: 0x75a2,
} as const;

/** Children legal directly inside a Cluster, for unknown-size cluster termination. */
const CLUSTER_CHILD_IDS = new Set<number>([
  EBML_ID.Timecode,
  EBML_ID.SimpleBlock,
  EBML_ID.BlockGroup,
  EBML_ID.Position,
  EBML_ID.PrevSize,
  EBML_ID.CRC32,
  EBML_ID.Void,
  0x5854, // SilentTracks (deprecated)
]);

export const PGS_CODEC_ID = "S_HDMV/PGS";
/** Matroska's default TimecodeScale: 1 ms per cluster/block tick. */
export const DEFAULT_TIMECODE_SCALE = 1_000_000;

export class MkvError extends Error {
  readonly offset: number | undefined;

  constructor(message: string, offset?: number) {
    super(
      offset === undefined
        ? message
        : `${message} (at file offset ${offset} / 0x${offset.toString(16)})`,
    );
    this.name = "MkvError";
    this.offset = offset;
  }
}

/** The requested track number is not in the file's Tracks element. */
export class MkvTrackNotFoundError extends MkvError {
  constructor(
    readonly trackNumber: number,
    readonly available: MkvTrackInfo[],
  ) {
    const list = available
      .map((t) => `${t.trackNumber} (${t.trackType}, ${t.codecId})`)
      .join(", ");
    super(
      `no track with Matroska track number ${trackNumber}; file has ${list || "no tracks"}`,
    );
    this.name = "MkvTrackNotFoundError";
  }
}

/** The requested track exists but is not S_HDMV/PGS. */
export class MkvTrackCodecError extends MkvError {
  constructor(
    readonly trackNumber: number,
    readonly codecId: string,
  ) {
    super(
      `track ${trackNumber} has CodecID "${codecId}", expected "${PGS_CODEC_ID}"`,
    );
    this.name = "MkvTrackCodecError";
  }
}

/**
 * A laced block was encountered that could not be split into frames. All three
 * Matroska lacing modes are decoded; this is thrown when the lacing header is
 * inconsistent with the block size (mkvmerge never laces subtitles).
 */
export class UnsupportedLacingError extends MkvError {
  constructor(
    readonly lacing: number,
    message: string,
    offset?: number,
  ) {
    super(message, offset);
    this.name = "UnsupportedLacingError";
  }
}

/** Track-level ContentEncoding this reader cannot undo. */
export class UnsupportedCompressionError extends MkvError {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedCompressionError";
  }
}

export interface MkvContentCompression {
  /** 0 zlib, 1 bzlib, 2 lzo1x, 3 header stripping. */
  algorithm: number;
  /** Bytes stripped from the front of every frame (algorithm 3 only). */
  settings?: Uint8Array;
}

export interface MkvTrackInfo {
  trackNumber: number;
  /** Hex, because a TrackUID routinely exceeds Number.MAX_SAFE_INTEGER. */
  trackUid?: string;
  trackType: number;
  codecId: string;
  language?: string;
  compression?: MkvContentCompression;
}

/** One Matroska block carrying PGS segment bytes. */
export interface PgsBlock {
  trackNumber: number;
  /** (cluster timecode + block relative timecode) scaled by TimecodeScale. */
  timestampMs: number;
  /** The block's frame data: a concatenation of `type u8 | size u16be | body`. */
  payload: Uint8Array;
  /** Absolute offset of the payload's first byte in the MKV. */
  fileOffset: number;
  /** Absolute offset of the enclosing Cluster element header. */
  clusterOffset: number;
  blockKind: "SimpleBlock" | "BlockGroup";
  /** BlockDuration in ms, when the BlockGroup carried one. */
  duration?: number;
  /** True when `payload` was inflated, so `fileOffset` addresses compressed bytes. */
  compressed: boolean;
  /** Bytes the payload occupies in the file (differs from payload.length when compressed). */
  fileLength: number;
  /**
   * True when the enclosing Cluster (or BlockGroup) carries a CRC-32 element.
   * Patching such a block in place would invalidate the checksum, so the fixer
   * refuses. mkvmerge and MakeMKV never write cluster CRCs.
   */
  clusterHasCrc: boolean;
}

/**
 * A block reduced to what a consumer still needs once its segments have been
 * parsed out: where it lives in the file, when it plays, and whether its
 * cluster is CRC-protected.
 *
 * `readPgsTracksData` keeps one of these per block rather than the block
 * itself. A two-hour PGS track is tens of thousands of blocks and every payload
 * is already represented by the parsed segments, so holding the payloads too
 * doubles the memory the scanner needs for nothing.
 */
export interface PgsBlockRecord {
  trackNumber: number;
  /** (cluster timecode + block relative timecode) scaled by TimecodeScale. */
  timestampMs: number;
  /** Absolute offset of the payload's first byte in the MKV. */
  fileOffset: number;
  /** Bytes the payload occupies in the file (differs from payload.length when compressed). */
  fileLength: number;
  /** Absolute offset of the enclosing Cluster element header. */
  clusterOffset: number;
  /** True when the enclosing Cluster (or BlockGroup) carries a CRC-32 element. */
  clusterHasCrc: boolean;
}

export interface PgsScanProgress {
  /** Current read position in the file. */
  position: number;
  fileSize: number;
  /** PGS blocks yielded so far. */
  blocks: number;
  stats: EbmlStats;
}

export interface ReadPgsBlocksOptions extends EbmlReaderOptions {
  /** Called after every yielded block and once when the walk finishes. */
  onProgress?: (progress: PgsScanProgress) => void;
  /** Called once with the final reader stats. */
  onStats?: (stats: EbmlStats) => void;
  /** Called once the Info and Tracks elements have been read. */
  onInfo?: (info: { timecodeScale: number; tracks: MkvTrackInfo[] }) => void;
  /** Throw instead of inflating a zlib-compressed track (see the offset contract). */
  requireByteAddressable?: boolean;
}

interface WalkContext {
  reader: EbmlReader;
  /** Every Matroska track number being collected in this pass. */
  trackNumbers: Set<number>;
  timecodeScale: number;
  tracks: Map<number, MkvTrackInfo>;
  segmentEnd: number;
  blocks: number;
  requireByteAddressable: boolean;
}

function tickToMs(ticks: number, timecodeScale: number): number {
  const ms = (ticks * timecodeScale) / 1e6;
  // Whole milliseconds for the (near universal) 1 ms scale; otherwise keep the
  // fraction but drop float noise.
  return Number.isInteger(ms) ? ms : Math.round(ms * 1e6) / 1e6;
}

/** Parse a Tracks element payload into track descriptors. */
export function parseTracks(bytes: Uint8Array, base = 0): MkvTrackInfo[] {
  const tracks: MkvTrackInfo[] = [];
  for (const { element, data } of iterateElements(bytes, base)) {
    if (element.id !== EBML_ID.TrackEntry) continue;
    let trackNumber = -1;
    let trackUid: string | undefined;
    let trackType = -1;
    let codecId = "";
    let language: string | undefined;
    let compression: MkvContentCompression | undefined;
    for (const child of iterateElements(data, element.dataOffset)) {
      switch (child.element.id) {
        case EBML_ID.TrackNumber:
          trackNumber = readUintBE(child.data, 0, child.data.length);
          break;
        case EBML_ID.TrackUID:
          trackUid = Buffer.from(child.data).toString("hex");
          break;
        case EBML_ID.TrackType:
          trackType = readUintBE(child.data, 0, child.data.length);
          break;
        case EBML_ID.CodecID:
          codecId = decodeAscii(child.data);
          break;
        case EBML_ID.Language:
        case EBML_ID.LanguageBCP47:
          language ??= decodeAscii(child.data);
          break;
        case EBML_ID.ContentEncodings:
          compression = parseContentEncodings(
            child.data,
            child.element.dataOffset,
          );
          break;
        default:
          break;
      }
    }
    const info: MkvTrackInfo = { trackNumber, trackType, codecId };
    if (trackUid !== undefined) info.trackUid = trackUid;
    if (language !== undefined) info.language = language;
    if (compression !== undefined) info.compression = compression;
    tracks.push(info);
  }
  return tracks;
}

function decodeAscii(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return Buffer.from(bytes.subarray(0, end)).toString("utf8");
}

function parseContentEncodings(
  bytes: Uint8Array,
  base: number,
): MkvContentCompression | undefined {
  let result: MkvContentCompression | undefined;
  for (const { element, data } of iterateElements(bytes, base)) {
    if (element.id !== EBML_ID.ContentEncoding) continue;
    let type = 0;
    let compression: MkvContentCompression | undefined;
    for (const child of iterateElements(data, element.dataOffset)) {
      if (child.element.id === EBML_ID.ContentEncodingType) {
        type = readUintBE(child.data, 0, child.data.length);
      } else if (child.element.id === EBML_ID.ContentCompression) {
        // ContentCompAlgo defaults to 0 (zlib) when absent.
        let algorithm = 0;
        let settings: Uint8Array | undefined;
        for (const c of iterateElements(child.data, child.element.dataOffset)) {
          if (c.element.id === EBML_ID.ContentCompAlgo) {
            algorithm = readUintBE(c.data, 0, c.data.length);
          } else if (c.element.id === EBML_ID.ContentCompSettings) {
            settings = c.data.slice();
          }
        }
        compression = settings ? { algorithm, settings } : { algorithm };
      } else if (child.element.id === EBML_ID.ContentEncryption) {
        type = 1;
      }
    }
    if (type === 1) {
      throw new UnsupportedCompressionError(
        "track uses content encryption, which this reader cannot undo",
      );
    }
    if (compression) result = compression;
  }
  return result;
}

/** Undo a track's ContentCompression for one frame. */
function decompressFrame(
  frame: Uint8Array,
  compression: MkvContentCompression | undefined,
): Uint8Array {
  if (!compression) return frame;
  switch (compression.algorithm) {
    case 0: {
      const out = inflateSync(Buffer.from(frame));
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    }
    case 3: {
      const head = compression.settings ?? new Uint8Array(0);
      if (head.length === 0) return frame;
      const out = new Uint8Array(head.length + frame.length);
      out.set(head, 0);
      out.set(frame, head.length);
      return out;
    }
    default:
      throw new UnsupportedCompressionError(
        `unsupported ContentCompAlgo ${compression.algorithm} (only zlib and header stripping are handled)`,
      );
  }
}

interface LacedFrame {
  data: Uint8Array;
  /** Offset of this frame relative to the start of the block's frame data. */
  offset: number;
}

/**
 * Split a block's frame data according to its lacing flags. All three Matroska
 * lacing modes are decoded; PGS is never laced in practice, but audio in the
 * same file is, so getting this right costs little.
 */
export function splitLacedFrames(
  body: Uint8Array,
  lacing: number,
  blockOffset: number,
): LacedFrame[] {
  if (lacing === 0) return [{ data: body, offset: 0 }];
  if (body.length < 1) {
    throw new UnsupportedLacingError(lacing, "laced block has no frame count", blockOffset);
  }
  const frameCount = body[0]! + 1;
  let pos = 1;
  const sizes: number[] = [];

  if (lacing === 2) {
    // Fixed-size lacing: every frame is the same size.
    const rest = body.length - pos;
    if (rest % frameCount !== 0) {
      throw new UnsupportedLacingError(
        lacing,
        `fixed lacing: ${rest} byte(s) do not divide into ${frameCount} frames`,
        blockOffset,
      );
    }
    for (let i = 0; i < frameCount; i++) sizes.push(rest / frameCount);
  } else if (lacing === 1) {
    // Xiph lacing: 255-terminated byte runs for the first n-1 frames.
    for (let i = 0; i < frameCount - 1; i++) {
      let size = 0;
      for (;;) {
        if (pos >= body.length) {
          throw new UnsupportedLacingError(
            lacing,
            "Xiph lacing: truncated size run",
            blockOffset,
          );
        }
        const b = body[pos++]!;
        size += b;
        if (b !== 255) break;
      }
      sizes.push(size);
    }
    sizes.push(-1);
  } else if (frameCount === 1) {
    // EBML lacing codes n-1 sizes, so a single frame carries none at all.
    sizes.push(-1);
  } else {
    // EBML lacing: first size is an unsigned vint, the rest are signed deltas.
    const first = decodeVint(body, pos);
    pos += first.length;
    sizes.push(first.value);
    let previous = first.value;
    for (let i = 1; i < frameCount - 1; i++) {
      const delta = decodeSignedVint(body, pos);
      pos += delta.length;
      previous += delta.value;
      sizes.push(previous);
    }
    sizes.push(-1);
  }

  const frames: LacedFrame[] = [];
  let at = pos;
  for (let i = 0; i < sizes.length; i++) {
    const declared = sizes[i]!;
    const size = declared === -1 ? body.length - at : declared;
    if (size < 0 || at + size > body.length) {
      throw new UnsupportedLacingError(
        lacing,
        `lacing sizes overrun the block: frame ${i} wants ${size} byte(s), ${body.length - at} left`,
        blockOffset,
      );
    }
    frames.push({ data: body.subarray(at, at + size), offset: at });
    at += size;
  }
  if (at !== body.length) {
    throw new UnsupportedLacingError(
      lacing,
      `lacing left ${body.length - at} trailing byte(s)`,
      blockOffset,
    );
  }
  return frames;
}

/**
 * Read a SimpleBlock / Block element. Returns an empty array (having skipped
 * the payload) unless the block belongs to the requested track.
 */
async function collectBlock(
  ctx: WalkContext,
  element: EbmlElement,
  kind: "SimpleBlock" | "BlockGroup",
  clusterOffset: number,
  clusterTimecode: number,
  hasCrc: boolean,
): Promise<PgsBlock[]> {
  const { reader } = ctx;
  if (element.unknown) {
    throw new MkvError("block with unknown size", element.headerOffset);
  }
  const end = element.dataOffset + element.size;
  const trackNumber = await reader.readVintValue();
  if (!ctx.trackNumbers.has(trackNumber)) {
    // The whole point: never transfer another track's payload.
    await reader.skip(end - reader.position);
    return [];
  }
  const head = await reader.readBytes(3);
  const relative = (((head[0]! << 8) | head[1]!) << 16) >> 16; // int16 BE
  const flags = head[2]!;
  const lacing = (flags & 0x06) >> 1;
  const bodyOffset = reader.position;
  const body = await reader.readBytes(end - bodyOffset);

  const timestampMs = tickToMs(clusterTimecode + relative, ctx.timecodeScale);
  const compression = ctx.tracks.get(trackNumber)?.compression;
  const out: PgsBlock[] = [];
  for (const frame of splitLacedFrames(body, lacing, element.headerOffset)) {
    out.push({
      trackNumber,
      timestampMs,
      payload: decompressFrame(frame.data, compression),
      fileOffset: bodyOffset + frame.offset,
      clusterOffset,
      blockKind: kind,
      compressed: compression !== undefined,
      fileLength: frame.data.length,
      clusterHasCrc: hasCrc,
    });
  }
  ctx.blocks += out.length;
  return out;
}

async function* readBlockGroup(
  ctx: WalkContext,
  group: EbmlElement,
  clusterOffset: number,
  clusterTimecode: number,
  clusterHasCrc: boolean,
): AsyncGenerator<PgsBlock> {
  const { reader } = ctx;
  if (group.unknown) {
    throw new MkvError("BlockGroup with unknown size", group.headerOffset);
  }
  const end = group.dataOffset + group.size;
  // BlockDuration may follow the Block, so hold the blocks until the group has
  // been walked and only then attach the duration.
  let pending: PgsBlock[] = [];
  let duration: number | undefined;
  // CRC-32 is mandated to be the first child of its master element, so it is
  // always seen before the Block it protects.
  let hasCrc = clusterHasCrc;
  while (reader.position < end) {
    const child = await reader.readElement();
    if (!child) break;
    if (child.id === EBML_ID.CRC32) {
      hasCrc = true;
      await reader.skip(child.size);
    } else if (child.id === EBML_ID.Block) {
      pending = await collectBlock(
        ctx,
        child,
        "BlockGroup",
        clusterOffset,
        clusterTimecode,
        hasCrc,
      );
      reader.seek(child.dataOffset + child.size);
    } else if (child.id === EBML_ID.BlockDuration) {
      duration = tickToMs(await reader.readUint(child.size), ctx.timecodeScale);
    } else {
      await reader.skip(child.size);
    }
  }
  reader.seek(end);
  for (const block of pending) {
    if (duration !== undefined) block.duration = duration;
    yield block;
  }
}

async function* readCluster(
  ctx: WalkContext,
  cluster: EbmlElement,
): AsyncGenerator<PgsBlock> {
  const { reader } = ctx;
  const end = cluster.unknown ? ctx.segmentEnd : cluster.dataOffset + cluster.size;
  let clusterTimecode = 0;
  let hasCrc = false;
  while (reader.position < end && !reader.eof) {
    const before = reader.position;
    const child = await reader.readElement();
    if (!child) break;
    if (cluster.unknown && !CLUSTER_CHILD_IDS.has(child.id)) {
      // An unknown-size cluster ends at the first element that cannot be its
      // child; hand it back to the segment-level loop.
      reader.seek(before);
      return;
    }
    switch (child.id) {
      case EBML_ID.CRC32:
        hasCrc = true;
        await reader.skip(child.size);
        break;
      case EBML_ID.Timecode:
        clusterTimecode = await reader.readUint(child.size);
        break;
      case EBML_ID.SimpleBlock: {
        const blocks = await collectBlock(
          ctx,
          child,
          "SimpleBlock",
          cluster.headerOffset,
          clusterTimecode,
          hasCrc,
        );
        reader.seek(child.dataOffset + child.size);
        yield* blocks;
        break;
      }
      case EBML_ID.BlockGroup:
        yield* readBlockGroup(
          ctx,
          child,
          cluster.headerOffset,
          clusterTimecode,
          hasCrc,
        );
        break;
      default:
        await reader.skip(child.size);
        break;
    }
  }
  if (!cluster.unknown) reader.seek(end);
}


/**
 * The most a SeekHead, Info or Tracks element is read as. Real ones are a few
 * kilobytes; a size beyond this is a damaged length, not a header.
 */
const MAX_HEADER_BYTES = 16 * 1024 * 1024;

/**
 * What a SeekHead lists: for each element ID, the file offset of the first
 * entry for it. SeekPosition counts from the first byte of the Segment's data.
 */
export function seekHeadPositions(
  bytes: Uint8Array,
  baseOffset: number,
  segmentDataOffset: number,
): Map<number, number> {
  const found = new Map<number, number>();
  for (const seek of iterateElements(bytes, baseOffset)) {
    if (seek.element.id !== EBML_ID.Seek) continue;
    let id: number | undefined;
    let position: number | undefined;
    for (const child of iterateElements(seek.data, seek.element.dataOffset)) {
      if (child.element.id === EBML_ID.SeekID) {
        id = readUintBE(child.data, 0, child.data.length);
      } else if (child.element.id === EBML_ID.SeekPosition && child.data.length > 0) {
        position = readUintBE(child.data, 0, child.data.length);
      }
    }
    if (id !== undefined && position !== undefined && !found.has(id)) {
      found.set(id, segmentDataOffset + position);
    }
  }
  return found;
}

/**
 * Walk the file once, yielding the blocks of every requested track in stream
 * order. Each block carries its own `trackNumber`.
 *
 * `trackNumbers` are Matroska TrackNumbers — `mkvmerge -J`'s
 * `properties.number`, not its `id`.
 */
export async function* readPgsBlocks(
  file: string,
  trackNumbers: number | readonly number[],
  options: ReadPgsBlocksOptions = {},
): AsyncGenerator<PgsBlock> {
  const wanted = typeof trackNumbers === "number" ? [trackNumbers] : [...trackNumbers];
  if (wanted.length === 0) return;
  const readerOptions: EbmlReaderOptions = {
    strategy: options.strategy ?? DEFAULT_READ_STRATEGY,
  };
  if (options.maxChunkSize !== undefined) readerOptions.maxChunkSize = options.maxChunkSize;
  if (options.probeSize !== undefined) readerOptions.probeSize = options.probeSize;
  if (options.readThroughBytes !== undefined) {
    readerOptions.readThroughBytes = options.readThroughBytes;
  }
  const reader = await EbmlReader.open(file, readerOptions);
  const ctx: WalkContext = {
    reader,
    trackNumbers: new Set(wanted),
    timecodeScale: DEFAULT_TIMECODE_SCALE,
    tracks: new Map(),
    segmentEnd: reader.fileSize,
    blocks: 0,
    requireByteAddressable: options.requireByteAddressable ?? false,
  };
  const report = (): void => {
    options.onProgress?.({
      position: reader.position,
      fileSize: reader.fileSize,
      blocks: ctx.blocks,
      stats: reader.stats,
    });
  };

  try {
    // --- EBML header -----------------------------------------------------
    const header = await reader.readElement();
    if (!header || header.id !== EBML_ID.EBML) {
      throw new MkvError(
        `not a Matroska file: expected an EBML header, found ${header ? formatId(header.id) : "end of file"}`,
        0,
      );
    }
    await reader.skip(header.size);

    // --- Segment ---------------------------------------------------------
    let segment: EbmlElement | undefined;
    while (!reader.eof) {
      const el = await reader.readElement();
      if (!el) break;
      if (el.id === EBML_ID.Segment) {
        segment = el;
        break;
      }
      if (el.unknown) {
        throw new MkvError(
          `unknown-size top-level element ${formatId(el.id)}`,
          el.headerOffset,
        );
      }
      await reader.skip(el.size);
    }
    if (!segment) throw new MkvError("no Segment element found");
    // Only the first Segment is read. Multi-segment files are legal but are
    // never produced by remuxing tools, so they are out of scope.
    ctx.segmentEnd = segment.unknown
      ? reader.fileSize
      : Math.min(segment.dataOffset + segment.size, reader.fileSize);

    // --- Segment children -------------------------------------------------
    let sawTracks = false;
    let sawInfo = false;
    /** What the file's SeekHead(s) list, as file offsets; see `fetchHeaders`. */
    const index = new Map<number, number>();
    const segmentData = segment.dataOffset;
    const takeSeekHead = (bytes: Uint8Array, dataOffset: number): void => {
      // Anything unreadable in a SeekHead is no reason to refuse a file that
      // is otherwise in order: it is only ever a hint.
      try {
        for (const [id, at] of seekHeadPositions(bytes, dataOffset, segmentData)) {
          if (!index.has(id)) index.set(id, at);
        }
      } catch {
        // Not a usable index.
      }
    };
    /** The data of a header element (SeekHead, Info, Tracks): never more than a header can be. */
    const headerBytes = async (el: EbmlElement, what: string): Promise<Uint8Array> => {
      if (el.size > MAX_HEADER_BYTES) {
        throw new MkvError(
          `the ${what} element claims ${el.size} bytes, more than any header holds; the file is damaged there`,
          el.headerOffset,
        );
      }
      return reader.readBytes(el.size);
    };
    /** True once a cluster has been walked: its blocks were timed by the scale in hand then. */
    let clustersRead = false;
    const takeInfo = async (el: EbmlElement): Promise<void> => {
      const bytes = await headerBytes(el, "Info");
      let scale = DEFAULT_TIMECODE_SCALE;
      for (const child of iterateElements(bytes, el.dataOffset)) {
        if (child.element.id === EBML_ID.TimecodeScale) {
          scale = readUintBE(child.data, 0, child.data.length);
        }
      }
      // An Info that turns up after blocks were timed, and says otherwise:
      // those times were wrong, and nothing can put them right from here.
      if (clustersRead && scale !== ctx.timecodeScale) {
        throw new MkvError(
          `the file's Info element comes after its clusters with a timestamp scale of ${scale}, ` +
            `and its index did not say where to find it first; its subtitles cannot be timed`,
          el.headerOffset,
        );
      }
      ctx.timecodeScale = scale;
      sawInfo = true;
    };
    /**
     * The element of kind `id` the index lists, with the reader at its data;
     * undefined when it lists none there — nothing at all, a place outside the
     * Segment, another element, or bytes that are no element. The index is a
     * hint: what it gets wrong is the same as what it does not say.
     */
    const listed = async (id: number): Promise<EbmlElement | undefined> => {
      const at = index.get(id);
      if (at === undefined || at < segmentData || at >= ctx.segmentEnd) return undefined;
      try {
        reader.seek(at);
        const el = await reader.readElement();
        return el && el.id === id && !el.unknown ? el : undefined;
      } catch (err) {
        if (err instanceof EbmlError) return undefined;
        throw err;
      }
    };
    /** `read` for something only hinted at: an unreadable hint is no hint. */
    const hinted = async (read: () => Promise<void>): Promise<void> => {
      try {
        await read();
      } catch (err) {
        // Unreadable bytes, or a header with an impossible size: a bad hint.
        if (!(err instanceof EbmlError) && !(err instanceof MkvError)) throw err;
      }
    };
    /**
     * Before the first cluster is read: whatever of Info and Tracks has not
     * been met yet is fetched from where the SeekHead says it is. Some muxers
     * (MakeMKV 1.9, for one) write Tracks after the clusters, and the first
     * SeekHead may only point at a second one that lists it. Block offsets are
     * the file's own either way; the reader is put back where it was.
     */
    let headersFetched = false;
    const fetchHeaders = async (cluster: EbmlElement): Promise<void> => {
      // Once: a file with no Info at all must not send every cluster looking.
      if (headersFetched || (sawTracks && sawInfo)) return;
      headersFetched = true;
      if (!index.has(EBML_ID.Tracks) || (!sawInfo && !index.has(EBML_ID.Info))) {
        await hinted(async () => {
          const second = await listed(EBML_ID.SeekHead);
          if (second && second.size <= MAX_HEADER_BYTES) {
            takeSeekHead(await reader.readBytes(second.size), second.dataOffset);
          }
        });
      }
      // The scale blocks are timed by. Not found here, the default stands —
      // and an Info met later that says otherwise stops the read (`takeInfo`).
      if (!sawInfo) {
        await hinted(async () => {
          const info = await listed(EBML_ID.Info);
          if (info) await takeInfo(info);
        });
      }
      if (!sawTracks) {
        const at = index.get(EBML_ID.Tracks);
        const why =
          at === undefined
            ? "the file's index does not say where Tracks is"
            : at >= ctx.segmentEnd
              ? "the file's index puts Tracks beyond the end of the file's data"
              : undefined;
        const tracks = why === undefined ? await listed(EBML_ID.Tracks) : undefined;
        if (!tracks) {
          throw new MkvError(
            `cluster reached before the Tracks element, and ${why ?? "the file's index points at something else"}; cannot tell which track to read`,
            cluster.headerOffset,
          );
        }
        await takeTracks(tracks);
      }
      reader.seek(cluster.dataOffset);
    };
    const takeTracks = async (el: EbmlElement): Promise<void> => {
      const bytes = await headerBytes(el, "Tracks");
      const tracks = parseTracks(bytes, el.dataOffset);
      for (const number of ctx.trackNumbers) {
        const found = tracks.find((t) => t.trackNumber === number);
        if (!found) throw new MkvTrackNotFoundError(number, tracks);
        if (found.codecId !== PGS_CODEC_ID) {
          throw new MkvTrackCodecError(number, found.codecId);
        }
        if (found.compression && ctx.requireByteAddressable) {
          throw new UnsupportedCompressionError(
            `track ${number} uses Matroska content compression (algo ${found.compression.algorithm}); its segment offsets cannot address file bytes`,
          );
        }
        ctx.tracks.set(number, found);
      }
      sawTracks = true;
      options.onInfo?.({
        timecodeScale: ctx.timecodeScale,
        tracks: [...ctx.tracks.values()],
      });
    };
    while (reader.position < ctx.segmentEnd && !reader.eof) {
      const el = await reader.readElement();
      if (!el) break;
      switch (el.id) {
        case EBML_ID.Info: {
          // Met again in its own place, after being fetched early: skip it.
          if (sawInfo) await reader.skip(el.size);
          else await takeInfo(el);
          break;
        }
        case EBML_ID.SeekHead: {
          if (el.unknown) {
            throw new MkvError("unknown-size element SeekHead inside Segment", el.headerOffset);
          }
          // A hint, and never a large one: an oversized SeekHead is passed over.
          if (el.size > MAX_HEADER_BYTES) await reader.skip(el.size);
          else takeSeekHead(await reader.readBytes(el.size), el.dataOffset);
          break;
        }
        case EBML_ID.Tracks: {
          // Met again in its own place, after being fetched early: skip it.
          if (sawTracks) await reader.skip(el.size);
          else await takeTracks(el);
          break;
        }
        case EBML_ID.Cluster: {
          await fetchHeaders(el);
          clustersRead = true;
          yield* readCluster(ctx, el);
          report();
          break;
        }
        default: {
          // SeekHead, Cues, Tags, Attachments, Chapters, Void: not needed.
          if (el.unknown) {
            throw new MkvError(
              `unknown-size element ${formatId(el.id)} inside Segment`,
              el.headerOffset,
            );
          }
          await reader.skip(el.size);
          break;
        }
      }
    }
    if (!sawTracks) throw new MkvError("no Tracks element found");
    report();
    options.onStats?.(reader.stats);
  } finally {
    await reader.close();
  }
}

export interface PgsTrackData {
  trackNumber: number;
  /**
   * Every PGS segment of the track in stream order, with `offset` rewritten to
   * be absolute in the MKV (see the module docstring).
   */
  segments: Segment[];
  /** One record per block, without the payload; see `PgsBlockRecord`. */
  blocks: PgsBlockRecord[];
  stats: EbmlStats;
  timecodeScale: number;
  /** True when the track's frames were zlib/header-stripped in the file. */
  compressed: boolean;
}

const EMPTY_STATS: EbmlStats = {
  fileSize: 0,
  bytesRead: 0,
  readCalls: 0,
  seeks: 0,
  bytesSkipped: 0,
  readRatio: 0,
  strategy: "none",
};

/**
 * Read several PGS tracks in ONE pass over the file.
 *
 * A cluster walk costs one read per block, so doing it per track multiplies the
 * whole cost by the number of tracks — and a Blu-ray rip routinely carries a
 * dozen PGS tracks. Every requested track must exist and be S_HDMV/PGS; the
 * returned map is keyed by Matroska track number and every requested number is
 * present (with empty arrays if the track carries no blocks). The `stats` on
 * each entry describe the single shared pass.
 */
export async function readPgsTracksData(
  file: string,
  trackNumbers: readonly number[],
  options: ReadPgsBlocksOptions = {},
): Promise<Map<number, PgsTrackData>> {
  const result = new Map<number, PgsTrackData>();
  for (const number of trackNumbers) {
    result.set(number, {
      trackNumber: number,
      segments: [],
      blocks: [],
      stats: EMPTY_STATS,
      timecodeScale: DEFAULT_TIMECODE_SCALE,
      compressed: false,
    });
  }
  if (result.size === 0) return result;

  let stats: EbmlStats | undefined;
  let timecodeScale = DEFAULT_TIMECODE_SCALE;
  const opts: ReadPgsBlocksOptions = {
    ...options,
    onStats: (s) => {
      stats = s;
      options.onStats?.(s);
    },
    onInfo: (info) => {
      timecodeScale = info.timecodeScale;
      options.onInfo?.(info);
    },
  };

  for await (const block of readPgsBlocks(file, [...result.keys()], opts)) {
    const entry = result.get(block.trackNumber)!;
    // The payload is not kept: the segments below carry everything in it, and
    // a long track has tens of thousands of blocks.
    entry.blocks.push({
      trackNumber: block.trackNumber,
      timestampMs: block.timestampMs,
      fileOffset: block.fileOffset,
      fileLength: block.fileLength,
      clusterOffset: block.clusterOffset,
      clusterHasCrc: block.clusterHasCrc,
    });
    if (block.compressed) entry.compressed = true;
    for (const seg of parseBlockSegments(block.payload, block.timestampMs)) {
      // parseBlockSegments reports offsets relative to the block payload; make
      // them absolute so byte patches can be applied to the MKV directly.
      seg.offset += block.fileOffset;
      entry.segments.push(seg);
    }
  }
  for (const entry of result.values()) {
    entry.stats = stats ?? EMPTY_STATS;
    entry.timecodeScale = timecodeScale;
  }
  return result;
}

export { EbmlError };

/**
 * Reads every requested PGS track in a single pass, keyed by Matroska track
 * number. The multi-track counterpart of `PgsTrackSource`.
 */
export type PgsMultiTrackSource = (
  file: string,
  tracks: readonly { id: number; number: number }[],
) => Promise<Map<number, Segment[]>>;
