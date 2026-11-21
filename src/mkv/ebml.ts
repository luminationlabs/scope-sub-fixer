/**
 * Minimal, read-only EBML layer over a `fs/promises` FileHandle.
 *
 * The point of this module is *not* to be a general Matroska library: it is to
 * let a caller walk the element tree of a very large MKV, read the handful of
 * small elements it cares about, and physically skip everything else. How much
 * of a 60 GB movie that actually transfers depends on the read strategy below,
 * so every read is counted in `stats` and can be checked rather than assumed.
 *
 * ## Read strategies
 *
 * Walking a cluster costs one read per block: the block header has to be read
 * before its size is known, so there is no way to reach block N+1 without
 * touching block N. That leaves one dial, `maxChunkSize` — how much is pulled
 * in speculatively at each stop — and it trades bytes against round trips:
 *
 *  - a small chunk transfers almost nothing (a few percent of the file) but
 *    needs one syscall per block, which on a 17 GB rip is ~420k round trips;
 *  - a chunk larger than the average block covers several blocks at once, so
 *    the syscall count collapses, but the file is then transferred in full.
 *
 * Measured on one pass over a real Blu-ray rip (blocks average ~40 KB, so a
 * probe-per-block walk needs one read per 40 KB of file):
 *
 *   17.1 GB, local NVMe    sequential  7.1 s, 94% of the file,  15k reads
 *                          adaptive   17.8 s,  3.6%,           431k reads
 *   26.5 GB, SMB over WiFi sequential  ~13 min, 100%,            29k reads
 *                          adaptive   ~111 min, 3.2%,           780k reads
 *
 * Streaming wins on time on both transports, because one read costs far more
 * (98 us locally, 8.7 ms over that share) than transferring one average block.
 * The byte-frugal strategies are for when bandwidth, not time, is the scarce
 * resource — a shared NAS, a metered link. Hence a named strategy
 * (see `READ_STRATEGIES`):
 *
 *  - `maxChunkSize`     size of a speculative fill;
 *  - `probeSize`        size of the fill right after a *large* skip, when the
 *                       previous speculative read was mostly wasted;
 *  - `readThroughBytes` how far past the end of the buffer a skip may land and
 *                       still count as "sequential". A skip beyond that resets
 *                       the next fill to `probeSize`; anything closer keeps
 *                       reading at `maxChunkSize`, so runs of small blocks are
 *                       covered by one read while big video blocks still cost
 *                       only a probe.
 *
 * Skipped bytes are never transferred in any strategy: a skip past the buffer
 * simply moves the file position.
 *
 * Reads larger than `maxChunkSize` bypass the buffer entirely and are issued as
 * one exact-length read.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve, win32 } from "node:path";
import { windowsPowerShellPath } from "../tools/locate.js";

/** Longest legal EBML element ID, in bytes. */
export const MAX_ID_LENGTH = 4;
/** Longest legal EBML data-size vint, in bytes. */
export const MAX_SIZE_LENGTH = 8;

/** How the reader trades transferred bytes against read() round trips. */
export interface ReadStrategy {
  name: string;
  /** Size of a speculative fill. */
  maxChunkSize: number;
  /** Fill size used immediately after a large skip. */
  probeSize: number;
  /**
   * A skip landing no more than this many bytes past the end of the buffer is
   * treated as sequential (keep reading at `maxChunkSize`). `Infinity` never
   * falls back to probing.
   */
  readThroughBytes: number;
}

export type ReadStrategyName = "minimal" | "adaptive" | "balanced" | "sequential";

export const READ_STRATEGIES: Record<ReadStrategyName, ReadStrategy> = {
  /** Fewest bytes possible: probe every block header, never read through. */
  minimal: {
    name: "minimal",
    maxChunkSize: 64 * 1024,
    probeSize: 1024,
    readThroughBytes: 0,
  },
  /** Bytes-first, with room for dense header regions. */
  adaptive: {
    name: "adaptive",
    maxChunkSize: 256 * 1024,
    probeSize: 1024,
    readThroughBytes: 0,
  },
  /**
   * Read through the small audio/subtitle blocks that dominate the block count
   * and keep probing the big video blocks that dominate the bytes.
   */
  balanced: {
    name: "balanced",
    maxChunkSize: 256 * 1024,
    probeSize: 4096,
    readThroughBytes: 64 * 1024,
  },
  /** Plain sequential streaming: fewest round trips, whole file transferred. */
  sequential: {
    name: "sequential",
    maxChunkSize: 1024 * 1024,
    probeSize: 1024 * 1024,
    readThroughBytes: Number.POSITIVE_INFINITY,
  },
};

/**
 * Streaming wins on wall time on every transport measured (see the module
 * docstring); `adaptive`/`minimal` exist for when bandwidth, not time, is the
 * scarce resource.
 */
export const DEFAULT_READ_STRATEGY: ReadStrategyName = "sequential";

export function isReadStrategyName(value: string): value is ReadStrategyName {
  return Object.hasOwn(READ_STRATEGIES, value);
}

/** Resolve a strategy name plus per-field overrides into a concrete strategy. */
export function resolveReadStrategy(options: EbmlReaderOptions = {}): ReadStrategy {
  const base =
    typeof options.strategy === "string"
      ? READ_STRATEGIES[options.strategy]
      : (options.strategy ?? READ_STRATEGIES[DEFAULT_READ_STRATEGY]);
  const maxChunkSize = Math.max(1024, options.maxChunkSize ?? base.maxChunkSize);
  const tuned =
    options.maxChunkSize !== undefined ||
    options.probeSize !== undefined ||
    options.readThroughBytes !== undefined;
  return {
    name: tuned ? `${base.name}*` : base.name,
    maxChunkSize,
    probeSize: Math.min(maxChunkSize, Math.max(64, options.probeSize ?? base.probeSize)),
    readThroughBytes: options.readThroughBytes ?? base.readThroughBytes,
  };
}

export class EbmlError extends Error {
  readonly offset: number | undefined;

  constructor(message: string, offset?: number) {
    super(
      offset === undefined
        ? message
        : `${message} (at file offset ${offset} / 0x${offset.toString(16)})`,
    );
    this.name = "EbmlError";
    this.offset = offset;
  }
}

/** Pretty-print an element ID the way the Matroska spec writes them. */
export function formatId(id: number): string {
  return `0x${id.toString(16).toUpperCase()}`;
}

/**
 * Length in bytes of the vint whose first byte is `firstByte`, from the
 * position of its leading 1 bit. Returns 0 for the invalid all-zero byte.
 */
export function vintLength(firstByte: number): number {
  if (!Number.isInteger(firstByte) || firstByte < 0 || firstByte > 0xff) {
    throw new EbmlError(`vintLength: ${firstByte} is not a byte`);
  }
  if (firstByte === 0) return 0;
  return Math.clz32(firstByte) - 24 + 1;
}

/** Read a big-endian unsigned integer of `length` bytes. */
export function readUintBE(
  bytes: Uint8Array,
  offset: number,
  length: number,
): number {
  if (offset + length > bytes.length) {
    throw new EbmlError(
      `truncated unsigned integer: need ${length} byte(s), ${bytes.length - offset} left`,
    );
  }
  let value = 0;
  for (let i = 0; i < length; i++) {
    // Multiplication, not <<, so values above 2^31 stay correct.
    value = value * 0x100 + bytes[offset + i]!;
  }
  if (!Number.isSafeInteger(value)) {
    throw new EbmlError(`unsigned integer ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return value;
}

export interface DecodedId {
  id: number;
  length: number;
}

/**
 * Decode an element ID. Matroska IDs are used *including* their vint marker
 * bits, so `0x1F43B675` (Cluster) comes back exactly as written in the spec.
 */
export function decodeId(bytes: Uint8Array, offset = 0): DecodedId {
  if (offset >= bytes.length) {
    throw new EbmlError("truncated element ID: no bytes left", offset);
  }
  const first = bytes[offset]!;
  const length = vintLength(first);
  if (length === 0 || length > MAX_ID_LENGTH) {
    throw new EbmlError(
      `invalid element ID: first byte 0x${first.toString(16).padStart(2, "0")}`,
      offset,
    );
  }
  if (offset + length > bytes.length) {
    throw new EbmlError(
      `truncated element ID: need ${length} byte(s), ${bytes.length - offset} left`,
      offset,
    );
  }
  return { id: readUintBE(bytes, offset, length), length };
}

export interface DecodedVint {
  /** Value with the marker bit removed. 0 when `unknown` is true. */
  value: number;
  length: number;
  /** All value bits set: the "unknown size" encoding (0xFF, 0x01FFFFFFFFFFFFFF…). */
  unknown: boolean;
}

/** Decode a data vint (element size, block track number, lacing size…). */
export function decodeVint(bytes: Uint8Array, offset = 0): DecodedVint {
  if (offset >= bytes.length) {
    throw new EbmlError("truncated vint: no bytes left", offset);
  }
  const first = bytes[offset]!;
  const length = vintLength(first);
  if (length === 0 || length > MAX_SIZE_LENGTH) {
    throw new EbmlError(
      `invalid vint: first byte 0x${first.toString(16).padStart(2, "0")}`,
      offset,
    );
  }
  if (offset + length > bytes.length) {
    throw new EbmlError(
      `truncated vint: need ${length} byte(s), ${bytes.length - offset} left`,
      offset,
    );
  }
  let value = first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    const b = bytes[offset + i]!;
    if (b !== 0xff) allOnes = false;
    value = value * 0x100 + b;
  }
  if (allOnes) return { value: 0, length, unknown: true };
  if (!Number.isSafeInteger(value)) {
    throw new EbmlError(`vint value ${value} exceeds Number.MAX_SAFE_INTEGER`, offset);
  }
  return { value, length, unknown: false };
}

/**
 * Decode a *signed* EBML vint (used by EBML lacing for size deltas): the
 * unsigned value minus 2^(7n-1) - 1.
 */
export function decodeSignedVint(bytes: Uint8Array, offset = 0): DecodedVint {
  const v = decodeVint(bytes, offset);
  if (v.unknown) return v;
  const bias = 2 ** (7 * v.length - 1) - 1;
  return { value: v.value - bias, length: v.length, unknown: false };
}

/** One element header, with absolute file (or buffer) offsets. */
export interface EbmlElement {
  id: number;
  /** Payload length in bytes. 0 when `unknown` is true. */
  size: number;
  /** True for the unknown-size encoding, which Segment and Cluster may use. */
  unknown: boolean;
  /** Offset of the element ID's first byte. */
  headerOffset: number;
  /** Offset of the element payload's first byte. */
  dataOffset: number;
}

/** Payload end offset, or `undefined` for an unknown-size element. */
export function elementEnd(el: EbmlElement): number | undefined {
  return el.unknown ? undefined : el.dataOffset + el.size;
}

/**
 * Walk the elements of an in-memory buffer (a master element's payload).
 * `base` is the absolute offset of `bytes[0]` so the yielded offsets can be
 * file offsets. Used for the small elements we read whole: Info, Tracks, and
 * their nested masters.
 */
export function* iterateElements(
  bytes: Uint8Array,
  base = 0,
): Generator<{ element: EbmlElement; data: Uint8Array }> {
  let pos = 0;
  while (pos < bytes.length) {
    const id = decodeId(bytes, pos);
    const sizeAt = pos + id.length;
    const size = decodeVint(bytes, sizeAt);
    const dataAt = sizeAt + size.length;
    if (size.unknown) {
      throw new EbmlError(
        `unknown-size element ${formatId(id.id)} inside an in-memory master element`,
        base + pos,
      );
    }
    if (dataAt + size.value > bytes.length) {
      throw new EbmlError(
        `element ${formatId(id.id)} of ${size.value} byte(s) overruns its parent by ${dataAt + size.value - bytes.length}`,
        base + pos,
      );
    }
    yield {
      element: {
        id: id.id,
        size: size.value,
        unknown: false,
        headerOffset: base + pos,
        dataOffset: base + dataAt,
      },
      data: bytes.subarray(dataAt, dataAt + size.value),
    };
    pos = dataAt + size.value;
  }
}

/** What the reader actually transferred, so savings can be proven. */
export interface EbmlStats {
  fileSize: number;
  /** Bytes actually requested from the filesystem. */
  bytesRead: number;
  /** Number of `read()` calls issued. */
  readCalls: number;
  /** Buffer resets caused by skipping well past the buffered window. */
  seeks: number;
  /** Bytes stepped over without being read. */
  bytesSkipped: number;
  /** bytesRead / fileSize. */
  readRatio: number;
  /** The strategy that produced these numbers. */
  strategy: string;
}

export interface EbmlReaderOptions {
  /** Named strategy or an explicit one. Defaults to `DEFAULT_READ_STRATEGY`. */
  strategy?: ReadStrategyName | ReadStrategy;
  /** Override the strategy's speculative fill size. */
  maxChunkSize?: number;
  /** Override the strategy's post-skip fill size. */
  probeSize?: number;
  /** Override the strategy's read-through threshold. */
  readThroughBytes?: number;
}

/**
 * Buffered, seekable, read-only EBML reader over one file.
 *
 * The element-header path (`readElement`, `readId`, `readVint`, `readUint`) is
 * the hot loop — one pass over a 17 GB rip runs it ~420k times — so it decodes
 * straight out of the buffer and allocates nothing. Only `readBytes` copies.
 */
export class EbmlReader {
  readonly fileSize: number;
  readonly strategy: ReadStrategy;

  #handle: FileHandle;
  #ownsHandle: boolean;
  #closed = false;

  #buf: Buffer;
  #bufStart = 0;
  #bufLen = 0;
  #pos = 0;
  /** Size of the next speculative fill. */
  #nextChunkSize: number;

  #bytesRead = 0;
  #readCalls = 0;
  #seeks = 0;
  #bytesSkipped = 0;

  private constructor(
    handle: FileHandle,
    fileSize: number,
    ownsHandle: boolean,
    options: EbmlReaderOptions = {},
  ) {
    this.#handle = handle;
    this.fileSize = fileSize;
    this.#ownsHandle = ownsHandle;
    this.strategy = resolveReadStrategy(options);
    this.#nextChunkSize = this.strategy.probeSize;
    this.#buf = Buffer.allocUnsafe(this.strategy.maxChunkSize);
  }

  static async open(path: string, options?: EbmlReaderOptions): Promise<EbmlReader> {
    const handle = await open(path, "r");
    try {
      const st = await handle.stat();
      return new EbmlReader(handle, st.size, true, options);
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  static fromHandle(
    handle: FileHandle,
    fileSize: number,
    options?: EbmlReaderOptions,
  ): EbmlReader {
    return new EbmlReader(handle, fileSize, false, options);
  }

  get position(): number {
    return this.#pos;
  }

  get eof(): boolean {
    return this.#pos >= this.fileSize;
  }

  get stats(): EbmlStats {
    return {
      fileSize: this.fileSize,
      bytesRead: this.#bytesRead,
      readCalls: this.#readCalls,
      seeks: this.#seeks,
      bytesSkipped: this.#bytesSkipped,
      readRatio: this.fileSize === 0 ? 0 : this.#bytesRead / this.fileSize,
      strategy: this.strategy.name,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ownsHandle) await this.#handle.close();
  }

  /** Bytes of the current buffer that sit at or after the logical position. */
  #available(): number {
    const end = this.#bufStart + this.#bufLen;
    if (this.#pos < this.#bufStart || this.#pos > end) return 0;
    return end - this.#pos;
  }

  #dropBuffer(): void {
    this.#bufStart = 0;
    this.#bufLen = 0;
  }

  /**
   * Move to an absolute offset. A jump that lands inside the buffer, or no more
   * than `readThroughBytes` past it, counts as sequential and keeps the next
   * fill at full size; anything further resets it to a probe.
   */
  seek(position: number): void {
    if (position < 0) throw new EbmlError(`cannot seek to ${position}`);
    // Callers routinely "seek" to where they already are (an element that was
    // read in full); that must not look like a jump.
    if (position === this.#pos) return;
    const bufEnd = this.#bufStart + this.#bufLen;
    const live = this.#bufLen > 0 && this.#pos >= this.#bufStart && this.#pos <= bufEnd;
    if (live && position >= this.#bufStart && position <= bufEnd) {
      // Still inside the buffered window: nothing to do but move.
      this.#pos = position;
      this.#nextChunkSize = this.strategy.maxChunkSize;
      return;
    }
    const beyond = live ? position - bufEnd : Number.POSITIVE_INFINITY;
    if (beyond >= 0 && beyond <= this.strategy.readThroughBytes) {
      this.#nextChunkSize = this.strategy.maxChunkSize;
    } else {
      this.#seeks++;
      this.#nextChunkSize = this.strategy.probeSize;
    }
    this.#dropBuffer();
    this.#pos = position;
  }

  /** Step over `count` bytes; anything not already buffered is never read. */
  async skip(count: number): Promise<void> {
    if (count < 0) throw new EbmlError(`cannot skip ${count} bytes`, this.#pos);
    const buffered = this.#available();
    if (count > buffered) this.#bytesSkipped += count - buffered;
    this.seek(this.#pos + count);
  }

  /** Make at least `need` bytes available, returning their offset in `#buf`. */
  async #fill(need: number): Promise<number> {
    const have = this.#available();
    if (have >= need) return this.#pos - this.#bufStart;
    if (this.#pos + need > this.fileSize) {
      throw new EbmlError(
        `unexpected end of file: need ${need} byte(s), ${this.fileSize - this.#pos} left`,
        this.#pos,
      );
    }
    const want = Math.min(
      Math.max(need, this.#nextChunkSize),
      this.fileSize - this.#pos,
    );
    if (this.#buf.length < want) this.#buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await this.#handle.read(this.#buf, 0, want, this.#pos);
    this.#bytesRead += bytesRead;
    this.#readCalls++;
    this.#bufStart = this.#pos;
    this.#bufLen = bytesRead;
    if (bytesRead < need) {
      throw new EbmlError(
        `short read: wanted ${need} byte(s), got ${bytesRead}`,
        this.#pos,
      );
    }
    return 0;
  }

  /** Read `count` bytes, advancing the position. */
  async readBytes(count: number): Promise<Uint8Array> {
    if (count < 0) throw new EbmlError(`cannot read ${count} bytes`, this.#pos);
    // Asked before anything is allocated: a corrupt size must not reserve
    // memory for bytes the file does not have.
    if (this.#pos + count > this.fileSize) {
      throw new EbmlError(
        `unexpected end of file: need ${count} byte(s), ${this.fileSize - this.#pos} left`,
        this.#pos,
      );
    }
    const out = new Uint8Array(count);
    if (count === 0) return out;
    let done = 0;
    const buffered = this.#available();
    if (buffered > 0) {
      const take = Math.min(buffered, count);
      const from = this.#pos - this.#bufStart;
      out.set(this.#buf.subarray(from, from + take), 0);
      done = take;
      this.#pos += take;
    }
    const rest = count - done;
    if (rest === 0) return out;
    if (rest >= this.strategy.maxChunkSize) {
      // Too big to be worth buffering: one exact read straight into `out`.
      this.#dropBuffer();
      const view = Buffer.from(out.buffer, out.byteOffset + done, rest);
      let got = 0;
      while (got < rest) {
        const r = await this.#handle.read(view, got, rest - got, this.#pos + got);
        this.#readCalls++;
        this.#bytesRead += r.bytesRead;
        if (r.bytesRead === 0) {
          throw new EbmlError(
            `short read: wanted ${rest} byte(s), got ${got}`,
            this.#pos,
          );
        }
        got += r.bytesRead;
      }
      this.#pos += rest;
      return out;
    }
    const at = await this.#fill(rest);
    out.set(this.#buf.subarray(at, at + rest), done);
    this.#pos += rest;
    return out;
  }

  /** Peek the byte at the current position without advancing. */
  async peekByte(): Promise<number> {
    const at = await this.#fill(1);
    return this.#buf[at]!;
  }

  /** Read one element ID. Decoded in place; allocates nothing. */
  async readId(): Promise<number> {
    let at = await this.#fill(1);
    const first = this.#buf[at]!;
    const length = vintLength(first);
    if (length === 0 || length > MAX_ID_LENGTH) {
      throw new EbmlError(
        `invalid element ID: first byte 0x${first.toString(16).padStart(2, "0")}`,
        this.#pos,
      );
    }
    if (length > 1) at = await this.#fill(length);
    let id = 0;
    for (let i = 0; i < length; i++) id = id * 0x100 + this.#buf[at + i]!;
    this.#pos += length;
    return id;
  }

  /**
   * Read one data vint (element size, block track number, lacing size).
   * Returns the value, or -1 for the unknown-size encoding.
   */
  async readVintValue(): Promise<number> {
    let at = await this.#fill(1);
    const first = this.#buf[at]!;
    const length = vintLength(first);
    if (length === 0 || length > MAX_SIZE_LENGTH) {
      throw new EbmlError(
        `invalid vint: first byte 0x${first.toString(16).padStart(2, "0")}`,
        this.#pos,
      );
    }
    if (length > 1) at = await this.#fill(length);
    const mask = 0xff >> length;
    let value = first & mask;
    let allOnes = value === mask;
    for (let i = 1; i < length; i++) {
      const b = this.#buf[at + i]!;
      if (b !== 0xff) allOnes = false;
      value = value * 0x100 + b;
    }
    this.#pos += length;
    if (allOnes) return -1;
    if (!Number.isSafeInteger(value)) {
      throw new EbmlError(
        `vint value ${value} exceeds Number.MAX_SAFE_INTEGER`,
        this.#pos,
      );
    }
    return value;
  }

  /** `readVintValue` in the shape the pure decoder returns. */
  async readVint(): Promise<DecodedVint> {
    const before = this.#pos;
    const value = await this.readVintValue();
    const length = this.#pos - before;
    return value < 0
      ? { value: 0, length, unknown: true }
      : { value, length, unknown: false };
  }

  /**
   * Read the next element header, or `null` at end of file. Callers decide
   * whether to `readBytes(el.size)` or `skip(el.size)`.
   */
  async readElement(): Promise<EbmlElement | null> {
    if (this.eof) return null;
    const headerOffset = this.#pos;
    const id = await this.readId();
    const size = await this.readVintValue();
    return {
      id,
      size: size < 0 ? 0 : size,
      unknown: size < 0,
      headerOffset,
      dataOffset: this.#pos,
    };
  }

  /** Read an unsigned-integer element payload of `size` bytes. */
  async readUint(size: number): Promise<number> {
    if (size === 0) return 0;
    if (size > 8) throw new EbmlError(`unsigned integer of ${size} bytes`, this.#pos);
    const at = await this.#fill(size);
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 0x100 + this.#buf[at + i]!;
    this.#pos += size;
    if (!Number.isSafeInteger(value)) {
      throw new EbmlError(
        `unsigned integer ${value} exceeds Number.MAX_SAFE_INTEGER`,
        this.#pos,
      );
    }
    return value;
  }

  /** Read a string element payload of `size` bytes (trailing NULs trimmed). */
  async readString(size: number): Promise<string> {
    const bytes = await this.readBytes(size);
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return Buffer.from(bytes.subarray(0, end)).toString("utf8");
  }
}

/**
 * Filesystem types whose reads pay a network round trip. Anything else is
 * treated as locally attached storage.
 */
const NETWORK_FS_TYPES = new Set([
  "smbfs",
  "cifs",
  "nfs",
  "nfs4",
  "afpfs",
  "webdav",
  "ftp",
  "fuse.sshfs",
  "sshfs",
  "afs",
  "9p",
]);

let mountTableCache: { mountPoint: string; type: string }[] | undefined;

/** Parse `mount` once. Both the macOS and the Linux output shapes are handled. */
function mountTable(): { mountPoint: string; type: string }[] {
  if (mountTableCache) return mountTableCache;
  const table: { mountPoint: string; type: string }[] = [];
  // `mount` is in /sbin on macOS, which a GUI app's or a cron job's PATH may
  // not include; try the usual places before giving up.
  let out = "";
  for (const command of ["mount", "/sbin/mount", "/bin/mount", "/usr/bin/mount"]) {
    try {
      out = execFileSync(command, [], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).toString("utf8");
      if (out.trim() !== "") break;
    } catch {
      // Not there, or it failed: try the next.
    }
  }
  // No `mount` at all leaves the table empty (`mountTableKnown`).
  for (const line of out.split("\n")) {
    // macOS:  <dev> on <mp> (smbfs, nodev, ...)
    // Linux:  <dev> on <mp> type nfs4 (rw,...)
    const m = /^.* on (.+?) (?:type (\S+) \(|\(([^,)]+)[,)])/.exec(line);
    if (!m) continue;
    const type = (m[2] ?? m[3] ?? "").trim().toLowerCase();
    table.push({ mountPoint: m[1]!, type });
  }
  mountTableCache = table;
  return table;
}

/**
 * Windows has no mount table. A path is on a network there when it is a UNC
 * path (`\\server\share\…`, `\\?\UNC\…`) or on a drive letter that is
 * a mapped network drive, which one PowerShell query answers:
 * `Win32_LogicalDisk`'s `DriveType` 4 is "network". The answer is kept for
 * `DRIVE_TABLE_TTL_MS`, since drives can be mapped while the engine runs, and
 * a failed query is kept as long, so a missing or slow PowerShell costs one
 * 5 s wait, not one per file.
 */
export const DRIVE_TABLE_TTL_MS = 5 * 60_000;

/** DeviceID and DriveType, one disk per line: `C: 3`. */
const DRIVE_QUERY =
  "Get-CimInstance -ClassName Win32_LogicalDisk | ForEach-Object { '{0} {1}' -f $_.DeviceID, $_.DriveType }";

/** Runs the drive query; returns its stdout, or throws. Replaceable for tests (`setDriveQuery`). */
export type DriveQuery = () => string;

const runDriveQuery: DriveQuery = () =>
  execFileSync(
    windowsPowerShellPath(),
    ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", DRIVE_QUERY],
    { stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true },
  ).toString("utf8");

let driveQuery: DriveQuery = runDriveQuery;
let driveTableCache: { at: number; drives: Map<string, number> | undefined } | undefined;

/** Swap the drive query (tests); `undefined` puts the real one back. Clears the cache. */
export function setDriveQuery(query: DriveQuery | undefined): void {
  driveQuery = query ?? runDriveQuery;
  driveTableCache = undefined;
}

/**
 * The drive query's output as drive letter (upper case) → DriveType, or
 * `undefined` when not one line has the expected shape — a query that did not
 * work, never "no drives". Lines it does not recognise are skipped.
 */
export function parseDriveTypes(output: string): Map<string, number> | undefined {
  const drives = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z]):\s+(\d+)\s*$/.exec(line);
    if (m) drives.set(m[1]!.toUpperCase(), Number(m[2]));
  }
  return drives.size > 0 ? drives : undefined;
}

function driveTable(now: number = Date.now()): Map<string, number> | undefined {
  if (driveTableCache && now - driveTableCache.at < DRIVE_TABLE_TTL_MS) return driveTableCache.drives;
  let drives: Map<string, number> | undefined;
  try {
    drives = parseDriveTypes(driveQuery());
  } catch {
    drives = undefined;
  }
  driveTableCache = { at: now, drives };
  return drives;
}

const NETWORK_DRIVE_TYPE = 4;

/**
 * Whether a Windows path is on a network, given the drive table (`undefined`:
 * unknown, so only UNC paths are known to be). Pure.
 */
export function isWindowsNetworkPath(path: string, drives: Map<string, number> | undefined): boolean {
  const p = win32.resolve(path);
  const lower = p.toLowerCase();
  if (lower.startsWith("\\\\?\\unc\\")) return true;
  // `\\?\C:\…` and `\\.\…` are local device paths, not shares.
  const local = lower.startsWith("\\\\?\\") || lower.startsWith("\\\\.\\") ? p.slice(4) : p;
  if (local === p && p.startsWith("\\\\")) return true;
  const m = /^([A-Za-z]):/.exec(local);
  return m !== null && drives?.get(m[1]!.toUpperCase()) === NETWORK_DRIVE_TYPE;
}

/** False when no mount table could be read, so `isNetworkPath` is only guessing "local". */
export function mountTableKnown(platform: string = process.platform): boolean {
  if (platform === "win32") return driveTable() !== undefined;
  return mountTable().length > 0;
}

/**
 * True when `path` lives on a network filesystem, where every read costs a
 * round trip and bytes are expensive. Used to pick a read strategy, where a
 * wrong answer only costs performance — and by `settleWindowFor` in
 * `batch/dates.ts`, where a wrong "local" means a kept file date is not
 * watched and a share may replace it.
 */
export function isNetworkPath(path: string, platform: string = process.platform): boolean {
  if (platform === "win32") {
    // A UNC path is a share as written. Asked first: resolving one makes
    // Windows look for the server, which takes many seconds when it is not
    // there.
    if (isWindowsNetworkPath(path, undefined)) return true;
    // Follow links on the machine itself (a link into a share is a share);
    // a test of another platform's path takes it as written.
    let resolved = path;
    if (process.platform === "win32") {
      try {
        resolved = realpathSync(path);
      } catch {
        resolved = path;
      }
    }
    // A UNC path needs no query; anything else asks which drives are mapped.
    return isWindowsNetworkPath(resolved, undefined) || isWindowsNetworkPath(resolved, driveTable());
  }
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch {
    resolved = resolve(path);
  }
  let best: { mountPoint: string; type: string } | undefined;
  for (const entry of mountTable()) {
    const mp = entry.mountPoint;
    const matches = resolved === mp || resolved.startsWith(mp.endsWith("/") ? mp : `${mp}/`);
    if (!matches) continue;
    if (!best || mp.length > best.mountPoint.length) best = entry;
  }
  return best ? NETWORK_FS_TYPES.has(best.type) : false;
}
