/**
 * The active movie area: the part of the coded frame that actually carries
 * picture, as opposed to the letterbox bars a scope title is padded with.
 *
 * Two ways to obtain it:
 *   - `activeAreaFromAspect` — deterministic, from a target aspect ratio (PRD §8);
 *   - `detectActiveArea`     — frames sampled with ffmpeg and measured here (PRD §8.2/§8.3).
 */
import type { Bounds } from "../geometry/rect.js";
import { spawn } from "node:child_process";
import { DependencyMissingError } from "../mkv/inspect.js";
import { toolPath } from "../tools/locate.js";

export type ActiveAreaClassification =
  | "CONSTANT"
  /**
   * The picture changes shape, and between clear, repeated shapes: the area
   * is the narrowest of them (`narrowestRepeatedShape`). A film with scope and
   * IMAX scenes.
   */
  | "MIXED_NARROWEST"
  | "MIXED_ASPECT_RATIO"
  | "UNKNOWN";

/** True for an area subtitles can be judged against and moved into. */
export function isUsableArea(active: { classification: string } | null | undefined): boolean {
  return active?.classification === "CONSTANT" || active?.classification === "MIXED_NARROWEST";
}

export interface CropSample {
  timestampMs: number;
  /** The box of the frame that carries picture, or null when nothing usable was seen. */
  crop: { width: number; height: number; x: number; y: number } | null;
  used: boolean;
  reason?: string;
}

export interface ActiveAreaCluster {
  top: number;
  bottom: number;
  left: number;
  right: number;
  count: number;
  timestampsMs: number[];
  /**
   * How many of `count` are one-off samples that lie inside this shape and
   * were counted towards it (`absorbOneOffs`). Absent when none.
   */
  absorbed?: number;
}

/** One distinct bar value and how many samples agreed with it (within tolerance). */
export interface BarValueCount {
  value: number;
  count: number;
}

/**
 * How the CONSTANT top/bottom were chosen, so a reader can see the difference
 * between what most frames showed and what the picture actually is.
 */
export interface ActiveAreaEstimate {
  /** Top/bottom of the modal (largest) cluster — what most samples agreed on. */
  modal: { top: number; bottom: number };
  /** The values actually used. */
  chosen: { top: number; bottom: number };
  /** Distinct top edges seen, smallest first, with their agreeing sample count. */
  tops: BarValueCount[];
  /** Distinct bottom edges seen, largest first, with their agreeing sample count. */
  bottoms: BarValueCount[];
}

export interface ActiveArea extends Bounds {
  frameWidth: number;
  frameHeight: number;
  /** activeWidth / activeHeight, rounded to two decimals. */
  aspect: number;
  source: "manual" | "auto";
  classification: ActiveAreaClassification;
  /** Present for `source === "auto"`. */
  samples?: CropSample[];
  /** Distinct (top, bottom) clusters found, largest first. Auto only. */
  clusters?: ActiveAreaCluster[];
  /**
   * Detected pillarbox, reported only: scope titles are full-width, so the
   * active area's own left/right always span the whole frame.
   */
  pillarbox?: { left: number; right: number; classification: ActiveAreaClassification };
  /** Tolerance used when clustering, in pixels. Auto only. */
  tolerancePx?: number;
  /** How the top/bottom were picked out of the samples. Auto + CONSTANT only. */
  estimate?: ActiveAreaEstimate;
  notes: string[];
}

export function roundAspect(width: number, height: number): number {
  if (height <= 0) return 0;
  return Math.round((width / height) * 100) / 100;
}

/**
 * Centered letterbox geometry for a target aspect ratio (PRD §8).
 * An aspect at or below the frame's own aspect means no bars at all.
 */
export function activeAreaFromAspect(
  frameWidth: number,
  frameHeight: number,
  aspect: number,
): ActiveArea {
  if (!(frameWidth > 0) || !(frameHeight > 0)) {
    throw new RangeError(`invalid frame size ${frameWidth}x${frameHeight}`);
  }
  if (!(aspect > 0) || !Number.isFinite(aspect)) {
    throw new RangeError(`invalid aspect ratio ${aspect}`);
  }
  const notes: string[] = [];
  let activeHeight = Math.round(frameWidth / aspect);
  if (activeHeight >= frameHeight) {
    if (activeHeight > frameHeight) {
      notes.push(
        `target aspect ${aspect} is wider than the frame can show; using the full frame`,
      );
    }
    activeHeight = frameHeight;
  }
  const top = Math.floor((frameHeight - activeHeight) / 2);
  return {
    frameWidth,
    frameHeight,
    top,
    bottom: top + activeHeight,
    left: 0,
    right: frameWidth,
    aspect: roundAspect(frameWidth, activeHeight),
    source: "manual",
    classification: "CONSTANT",
    notes,
  };
}

/** Timestamps in ms, evenly spread between 5% and 95% of the duration. */
export function sampleTimestamps(durationMs: number, samples: number): number[] {
  const n = Math.max(1, Math.floor(samples));
  const start = durationMs * 0.05;
  const end = durationMs * 0.95;
  if (n === 1) return [Math.round((start + end) / 2)];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.round(start + ((end - start) * i) / (n - 1)));
  }
  return out;
}

/** Default clustering tolerance: 4 px at 1080p, scaled with frame height. */
export function defaultTolerance(frameHeight: number): number {
  return Math.max(1, Math.round((4 * frameHeight) / 1080));
}

/** The part of one frame that carries picture; null when the frame shows none. */
export type FrameBox = { top: number; bottom: number; left: number; right: number } | null;

/**
 * Measures one frame of `file` at `timestampMs`. Injectable for tests.
 * Resolves null for a frame with no picture in it; rejects with
 * `FrameSampleError` when the frame could not be had at all.
 */
export type FrameSampler = (
  file: string,
  timestampMs: number,
  signal?: AbortSignal,
) => Promise<FrameBox>;

/** A frame could not be decoded or was not the size expected: not a measurement of anything. */
export class FrameSampleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameSampleError";
  }
}

/**
 * A pixel brighter than this, as a fraction of full scale, is picture.
 *
 * Measured on real discs with the frame converted to full-range grey: the
 * black bars of a 1080p Blu-ray peak at 0.04 (compression noise beside the
 * picture edge), those of a UHD HDR disc at 0.02, and every threshold from
 * 0.07 to 0.094 (1080p) or 0.02 to 0.094 (UHD) found the same picture edges
 * in bright and dark scenes alike.
 */
const PICTURE_LEVEL = 0.07;
/** A row or column is picture when this fraction of its pixels is: one stray pixel is not. */
const PICTURE_SHARE = 0.002;
/** This many black rows, as a fraction of the frame height, separate an island in a bar from the picture. */
const ISLAND_GAP = 0.0075;
/** How far in from a found edge, as a fraction of the frame height, such a gap is looked for. */
const ISLAND_REACH = 0.15;
/** A frame that takes longer than this to come is not coming (a stalled share). */
const SAMPLE_TIMEOUT_MS = 120_000;

/**
 * The box of a frame that carries picture, from its pixels: 16-bit
 * little-endian grey, `width` x `height`.
 *
 * Every pixel is tested on its own. Judging a row by its average brightness
 * would read a dark scene — or a bright one with dark edges — as black bars.
 * Dark picture still has grain above black in nearly every row; a bar has
 * none.
 */
export function pictureBox(gray16le: Uint8Array, width: number, height: number): FrameBox {
  if (width <= 0 || height <= 0 || gray16le.length < width * height * 2) return null;
  const level = Math.round(PICTURE_LEVEL * 65535);
  // About 1920 columns are plenty; a UHD frame is read every second pixel.
  const stride = Math.max(1, Math.round(width / 1920));
  const view = new DataView(gray16le.buffer, gray16le.byteOffset, gray16le.byteLength);
  const rowNeeds = Math.max(2, Math.round((width / stride) * PICTURE_SHARE));
  const rowIsPicture = (y: number): boolean => {
    let n = 0;
    for (let x = 0, at = y * width * 2; x < width; x += stride, at += stride * 2) {
      if (view.getUint16(at, true) > level && ++n >= rowNeeds) return true;
    }
    return false;
  };
  // Rows are looked at once each, from the edges inwards, and only as far as
  // the answer needs.
  const seen = new Map<number, boolean>();
  const picture = (y: number): boolean => {
    let v = seen.get(y);
    if (v === undefined) {
      v = rowIsPicture(y);
      seen.set(y, v);
    }
    return v;
  };
  // Something bright in a bar — a burned-in caption, a logo, a line of
  // garbage at the frame's edge — is not the picture's edge: black rows lie
  // between it and the picture. Such an island near an edge is stepped over.
  // A dark picture with a black band in it loses the part beyond the band,
  // which is the safe way to be wrong: a measurement that comes out smaller
  // is expected (`absorbOneOffs`), one that comes out larger is believed.
  const gap = Math.max(3, Math.round(height * ISLAND_GAP));
  const reach = Math.round(height * ISLAND_REACH);
  const edge = (from: number, dir: 1 | -1): number | undefined => {
    let y = from;
    while (y >= 0 && y < height && !picture(y)) y += dir;
    if (y < 0 || y >= height) return undefined;
    for (;;) {
      // A run of black rows within reach of this edge: what lies before it is an island.
      let black = 0;
      let next: number | undefined;
      for (let at = y; at >= 0 && at < height && Math.abs(at - y) <= reach; at += dir) {
        if (picture(at)) {
          if (black >= gap) {
            next = at;
            break;
          }
          black = 0;
        } else {
          black++;
        }
      }
      if (next === undefined) return y;
      y = next;
    }
  };
  const first = edge(0, 1);
  if (first === undefined) return null;
  const last = edge(height - 1, -1);
  if (last === undefined || last < first) return null;
  const top = first;
  const bottom = last + 1;

  const rowStride = Math.max(1, Math.round((bottom - top) / 1080));
  const colNeeds = Math.max(2, Math.round(((bottom - top) / rowStride) * PICTURE_SHARE));
  const colIsPicture = (x: number): boolean => {
    let n = 0;
    for (let y = top; y < bottom; y += rowStride) {
      if (view.getUint16((y * width + x) * 2, true) > level && ++n >= colNeeds) return true;
    }
    return false;
  };
  let left = 0;
  while (left < width && !colIsPicture(left)) left++;
  if (left === width) return null;
  let right = width;
  while (right > left + 1 && !colIsPicture(right - 1)) right--;
  return { top, bottom, left, right };
}

function frameArgs(file: string, timestampMs: number): string[] {
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    (timestampMs / 1000).toFixed(3),
    // Disc video is limited range whatever a container tag says; taken at
    // its word, a "full range" tag leaves black at 6% of full scale, beside
    // the threshold, and a letterboxed film reads as having no bars.
    "-color_range",
    "tv",
    // The frame as coded: a rotation tag would turn it on its side.
    "-noautorotate",
    "-i",
    file,
    "-map",
    "0:v:0",
    "-frames:v",
    "1",
    // Full-range 16-bit grey whatever the source's depth and range: one
    // threshold then means the same thing for SDR, HDR, 8 and 10 bits.
    "-vf",
    "format=gray16le",
    "-f",
    "rawvideo",
    "-",
  ];
}

/**
 * The real sampler: one ffmpeg per frame, seeking before the input so only
 * the frame's own neighbourhood of the file is read, and the decoded frame
 * measured here (`pictureBox`).
 *
 * Anything but one whole frame of `frameW` x `frameH` is a `FrameSampleError`,
 * never "a frame with no picture": ffmpeg failing, a share that stalls, a
 * file whose frames decode to another size (container cropping) — nothing
 * then says how the rows that came map onto the frame's.
 */
export function createFrameSampler(
  frameW: number,
  frameH: number,
  ffmpegPath = toolPath("ffmpeg"),
): FrameSampler {
  const want = frameW * frameH * 2;
  return (file, timestampMs, signal) =>
    new Promise<FrameBox>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(new Error("cancelled"));
        return;
      }
      const child = spawn(ffmpegPath, frameArgs(file, timestampMs), {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = "";
      let timedOut = false;
      const stop = (): void => {
        child.kill("SIGTERM");
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, SAMPLE_TIMEOUT_MS);
      signal?.addEventListener("abort", stop, { once: true });
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        // One frame is asked for; anything past it is not kept.
        if (size <= want) chunks.push(chunk);
        size += chunk.length;
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text: string) => {
        if (stderr.length < 2000) stderr += text;
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        done();
        if (err.code === "ENOENT") reject(new DependencyMissingError(ffmpegPath));
        else reject(err);
      });
      child.on("close", (code) => {
        done();
        const at = `${(timestampMs / 1000).toFixed(0)} s`;
        const said = stderr.trim().split("\n").at(-1) ?? "";
        if (signal?.aborted === true) reject(new Error("cancelled"));
        else if (timedOut) reject(new FrameSampleError(`no frame at ${at} within ${SAMPLE_TIMEOUT_MS / 1000} s`));
        else if (size === want) resolve(pictureBox(Buffer.concat(chunks), frameW, frameH));
        else if (size === 0) {
          reject(new FrameSampleError(`ffmpeg gave no frame at ${at}${said === "" ? ` (exit ${code})` : `: ${said}`}`));
        } else {
          reject(
            new FrameSampleError(
              `the frame at ${at} is not ${frameW}x${frameH} as the file says ` +
                `(${size} bytes, not ${want}): cropped or rotated by the container?`,
            ),
          );
        }
      });
    });
}

/** Run tasks with at most `limit` in flight, preserving result order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

interface RawCluster {
  top: number;
  bottom: number;
  left: number;
  right: number;
  tops: number[];
  bottoms: number[];
  lefts: number[];
  rights: number[];
  timestampsMs: number[];
}

/** Greedy clustering of (top, bottom) pairs within `tolerance` pixels. */
export function clusterBars(
  entries: readonly { top: number; bottom: number; left: number; right: number; timestampMs: number }[],
  tolerance: number,
): ActiveAreaCluster[] {
  const clusters: RawCluster[] = [];
  for (const e of entries) {
    const hit = clusters.find(
      (c) =>
        Math.abs(c.top - e.top) <= tolerance && Math.abs(c.bottom - e.bottom) <= tolerance,
    );
    if (hit) {
      hit.tops.push(e.top);
      hit.bottoms.push(e.bottom);
      hit.lefts.push(e.left);
      hit.rights.push(e.right);
      hit.timestampsMs.push(e.timestampMs);
    } else {
      clusters.push({
        top: e.top,
        bottom: e.bottom,
        left: e.left,
        right: e.right,
        tops: [e.top],
        bottoms: [e.bottom],
        lefts: [e.left],
        rights: [e.right],
        timestampsMs: [e.timestampMs],
      });
    }
  }
  return clusters
    .map((c) => ({
      // Smallest bars within the cluster, i.e. the largest active area, so a
      // one-off tight detection can never make us over-crop.
      top: Math.min(...c.tops),
      bottom: Math.max(...c.bottoms),
      left: Math.min(...c.lefts),
      right: Math.max(...c.rights),
      count: c.timestampsMs.length,
      timestampsMs: c.timestampsMs.slice().sort((a, b) => a - b),
    }))
    .sort((a, b) => b.count - a.count || a.top - b.top);
}

/**
 * Count how many samples agree with each distinct value, within `tolerance`.
 * Returned in `prefer` order — the order in which we would like to believe them.
 */
function countValues(
  values: readonly number[],
  tolerance: number,
  prefer: "asc" | "desc",
): BarValueCount[] {
  const distinct: number[] = [];
  for (const v of values) {
    if (!distinct.some((d) => Math.abs(d - v) <= tolerance)) distinct.push(v);
  }
  return distinct
    .map((value) => ({
      value,
      count: values.filter((v) => Math.abs(v - value) <= tolerance).length,
    }))
    .sort((a, b) => (prefer === "asc" ? a.value - b.value : b.value - a.value));
}

/**
 * The picture edge, out of every sample rather than out of the modal cluster.
 *
 * A measurement never includes a bar row — a frame can only be too dark to
 * show its picture's edge, never show picture in a bar — so the *largest* picture any sample shows is the true one, and
 * a scene with a dark vignette (or simply dark edges) makes most samples report
 * a smaller one. Taking the modal cluster's own minimum therefore under-reports
 * the picture on a film that is mostly dim at the edges: (500) Days of Summer
 * is really 131..948, and 20-odd of 24 samples call it 140..940.
 *
 * The guard against believing a single frame is repetition: a value only counts
 * when at least two samples agree with it (within tolerance), which is what
 * separates a real picture edge from one frame's dirt or garbage line. With no
 * value repeating at all, the modal cluster is the answer, as before.
 */
function pickEdge(
  counts: readonly BarValueCount[],
  fallback: number,
): number {
  for (const c of counts) if (c.count >= 2) return c.value;
  return fallback;
}

export interface DetectActiveAreaOptions {
  durationMs: number;
  frameW: number;
  frameH: number;
  /**
   * Number of frames to sample. Default 24. A title that shows more than one
   * shape is sampled once more, between those, before it is judged.
   */
  samples?: number;
  /** Clustering tolerance in pixels. Defaults to 4 px scaled from 1080p. */
  tolerancePx?: number;
  /** Concurrent ffmpeg processes. Default 2. */
  concurrency?: number;
  sampler?: FrameSampler;
  ffmpegPath?: string;
  /**
   * Checked before every sample: once aborted no further ffmpeg is started and
   * the detection throws. The samples already running are left to finish.
   */
  signal?: AbortSignal;
}

/** Fraction of valid samples that must agree before we call the title CONSTANT. */
const AGREEMENT = 0.8;
/** Below this many valid samples we refuse to call a title mixed. */
const MIN_VALID_SAMPLES = 6;
/** Fewer usable samples than this say too little about a changing picture to act on. */
const NARROWEST_MIN_SAMPLES = 12;
/**
 * How much taller, on each side and as a fraction of the frame height, another
 * shape must be to be a different shape and not the same one seen with dark
 * edges. Scope against IMAX 1.90:1 is 9.6%; a dark edge is a few rows.
 */
const SHAPE_STEP = 0.04;

/**
 * For a title whose picture changes shape: the narrowest shape it keeps
 * coming back to, or undefined when there is no such thing.
 *
 * A scope film with IMAX scenes alternates between two shapes, each seen
 * again and again, the taller containing the narrower. Treated as its
 * narrowest shape, every subtitle that can be moved is placed inside every
 * shape the film keeps returning to: during the taller scenes it merely sits
 * a little further in. (A shape seen in one sample only is not considered.) A wrong answer here moves a whole film's subtitles for
 * no reason, so everything else stays "left alone", and the rule asks for
 * all of:
 *
 *   - at least `NARROWEST_MIN_SAMPLES` usable samples;
 *   - shapes seen more than once account for `AGREEMENT` of them;
 *   - the narrowest of those is seen more often than any other, so it is the
 *     film's main shape and not an insert, a prologue or a run of dark
 *     scenes in a taller film; it has bars at all, and is centred in the
 *     frame, as letterbox bars are;
 *   - every other repeated shape is taller by a real step (`SHAPE_STEP`) on
 *     both sides. A measurement only ever comes out smaller, so the same shape seen with
 *     dark edges is a few rows narrower — and then nothing says which rows
 *     are the picture's.
 */
export function narrowestRepeatedShape(
  clusters: readonly ActiveAreaCluster[],
  validCount: number,
  frameH: number,
  tolerance: number,
): { top: number; bottom: number } | undefined {
  if (validCount < NARROWEST_MIN_SAMPLES) return undefined;
  const repeated = clusters.filter((c) => c.count >= 2);
  if (repeated.length < 2) return undefined;
  const covered = repeated.reduce((n, c) => n + c.count, 0);
  if (covered / validCount < AGREEMENT) return undefined;
  const narrowest = repeated.reduce((a, b) => (b.bottom - b.top < a.bottom - a.top ? b : a));
  const others = repeated.filter((c) => c !== narrowest);
  if (others.some((c) => c.count >= narrowest.count)) return undefined;
  if (narrowest.top <= tolerance && narrowest.bottom >= frameH - tolerance) return undefined;
  if (Math.abs(narrowest.top - (frameH - narrowest.bottom)) > 2 * tolerance) return undefined;
  const step = SHAPE_STEP * frameH;
  const stepped = others.every(
    (c) => narrowest.top - c.top >= step && c.bottom - narrowest.bottom >= step,
  );
  return stepped ? { top: narrowest.top, bottom: narrowest.bottom } : undefined;
}

/**
 * Count each sample of a shape seen in the dark towards the repeated shape it
 * lies inside.
 *
 * A measurement can only ever come out smaller than the picture — a frame
 * too dark at one edge to show grain there — never larger. So these are a
 * repeated shape seen in a dark scene, and evidence for it, not shapes of
 * their own:
 *
 *   - a shape seen once that fits inside a repeated one;
 *   - a shape seen less often than a repeated one it fits inside and shares
 *     one edge with. Letterbox bars come in pairs; a picture cut short on one
 *     side only is a dark edge, however many frames agree on it.
 *
 * Where several repeated shapes contain it, it counts towards the smallest:
 * the one it says least about beyond what it shows. A shape inside no
 * repeated one stays what it is.
 */
export function absorbOneOffs(
  clusters: readonly ActiveAreaCluster[],
  tolerance: number,
): ActiveAreaCluster[] {
  const out = clusters.map((c) => ({ ...c, timestampsMs: [...c.timestampsMs] }));
  const gone = new Set<ActiveAreaCluster>();
  // Fewest first, so a shape is given away before anything is given to it.
  for (const c of [...out].sort((x, y) => x.count - y.count)) {
    const hosts = out.filter(
      (r) =>
        r !== c &&
        !gone.has(r) &&
        r.count >= 2 &&
        r.bottom - r.top > c.bottom - c.top &&
        c.top >= r.top - tolerance &&
        c.bottom <= r.bottom + tolerance &&
        (c.count === 1 ||
          (r.count > c.count &&
            (Math.abs(c.top - r.top) <= tolerance || Math.abs(c.bottom - r.bottom) <= tolerance))),
    );
    if (hosts.length === 0) continue;
    const host = hosts.reduce((x, y) => (y.bottom - y.top < x.bottom - x.top ? y : x));
    host.count += c.count;
    host.absorbed = (host.absorbed ?? 0) + c.count;
    host.timestampsMs.push(...c.timestampsMs);
    gone.add(c);
  }
  const kept = out.filter((c) => !gone.has(c));
  for (const c of kept) c.timestampsMs.sort((x, y) => x - y);
  return kept.sort((x, y) => y.count - x.count || x.top - y.top);
}

/**
 * Sample frames across the running time, measure the picture in each
 * (`pictureBox`) and decide whether the active area is constant, changes
 * (mixed aspect), or cannot be determined.
 */
export async function detectActiveArea(
  file: string,
  options: DetectActiveAreaOptions,
): Promise<ActiveArea> {
  const { durationMs, frameW, frameH } = options;
  const tolerance = options.tolerancePx ?? defaultTolerance(frameH);
  const notes: string[] = [];

  const unknown = (reason: string): ActiveArea => {
    notes.push(reason);
    return {
      frameWidth: frameW,
      frameHeight: frameH,
      top: 0,
      bottom: frameH,
      left: 0,
      right: frameW,
      aspect: roundAspect(frameW, frameH),
      source: "auto",
      classification: "UNKNOWN",
      samples: [],
      clusters: [],
      tolerancePx: tolerance,
      notes,
    };
  };

  if (!(durationMs > 0)) return unknown("no container duration to sample against");
  if (!(frameW > 0) || !(frameH > 0)) return unknown("unknown video dimensions");

  const sampler = options.sampler ?? createFrameSampler(frameW, frameH, options.ffmpegPath);
  const step = SHAPE_STEP * frameH;

  const samples: CropSample[] = [];
  const valid: {
    top: number;
    bottom: number;
    left: number;
    right: number;
    timestampMs: number;
  }[] = [];

  /** Frames that could not be had at all; see `FrameSampleError`. */
  const failures: string[] = [];
  const take = async (timestamps: readonly number[]): Promise<void> => {
    const boxes = await mapLimit(timestamps, options.concurrency ?? 2, async (t) => {
      if (options.signal?.aborted === true) throw new Error("cancelled");
      try {
        return await sampler(file, t, options.signal);
      } catch (err) {
        if (err instanceof FrameSampleError) return err;
        throw err;
      }
    });
    for (let i = 0; i < timestamps.length; i++) {
      const timestampMs = timestamps[i]!;
      const box = boxes[i]!;
      if (box instanceof FrameSampleError) {
        failures.push(box.message);
        samples.push({ timestampMs, crop: null, used: false, reason: box.message });
        continue;
      }
      if (!box) {
        samples.push({ timestampMs, crop: null, used: false, reason: "no picture in the frame" });
        continue;
      }
      const crop = {
        width: box.right - box.left,
        height: box.bottom - box.top,
        x: box.left,
        y: box.top,
      };
      if (crop.height < frameH * 0.25) {
        samples.push({ timestampMs, crop, used: false, reason: "frame is (near) all black" });
        continue;
      }
      samples.push({ timestampMs, crop, used: true });
      valid.push({ ...box, timestampMs });
    }
    samples.sort((a, b) => a.timestampMs - b.timestampMs);
    valid.sort((a, b) => a.timestampMs - b.timestampMs);
  };

  /** True when `c` is another shape than `of`, not the same one a few rows off. */
  const differs = (c: { top: number; bottom: number }, of: { top: number; bottom: number }): boolean =>
    Math.abs(c.top - of.top) >= step || Math.abs(c.bottom - of.bottom) >= step;

  const timestamps = sampleTimestamps(durationMs, options.samples ?? 24);
  await take(timestamps);

  // More than one shape in sight: look again, between the first samples,
  // before judging. A short run of taller scenes is otherwise one sample, or
  // none, and a shape seen once says nothing.
  if (valid.length > 0 && timestamps.length >= 2) {
    const first = absorbOneOffs(clusterBars(valid, tolerance), tolerance);
    if (first.some((c) => c !== first[0] && differs(c, first[0]!))) {
      const between = timestamps
        .slice(1)
        .map((t, i) => Math.round((t + timestamps[i]!) / 2));
      await take(between);
      notes.push(`more than one picture shape seen: sampled ${between.length} more frames`);
    }
  }

  // Not one frame could be had: that is a failure to look, not a verdict.
  // Thrown, so that a plan keeps the verdict it has and tries again.
  if (failures.length === samples.length && failures.length > 0) {
    throw new Error(`the video could not be sampled: ${failures[0]}`);
  }
  if (failures.length > 0) {
    notes.push(`${failures.length} of ${samples.length} frames could not be sampled: ${failures[0]}`);
  }
  if (valid.length === 0) {
    const area = unknown("no usable picture samples");
    area.samples = samples;
    return area;
  }

  const clusters = absorbOneOffs(clusterBars(valid, tolerance), tolerance);
  const modal = clusters[0]!;
  const agreement = modal.count / valid.length;
  const shapes = clusters
    .map((c) => `y=${c.top}..${c.bottom} (${c.count}x)`)
    .join(", ");
  // Another shape the film keeps returning to: then the question is which
  // shape to judge by (`narrowestRepeatedShape`), and never "which of these
  // edges is the true one" — `pickEdge` must not reach across shapes.
  const otherShape = clusters.some((c) => c !== modal && c.count >= 2 && differs(c, modal));

  // Edges near the modal shape's only, on every valid sample that shows one,
  // so the diagnostics show the same data the decision was made on.
  const near = (edge: number) => (v: number): boolean => Math.abs(v - edge) < step;
  const topCounts = countValues(valid.map((v) => v.top).filter(near(modal.top)), tolerance, "asc");
  const bottomCounts = countValues(
    valid.map((v) => v.bottom).filter(near(modal.bottom)),
    tolerance,
    "desc",
  );

  let classification: ActiveAreaClassification;
  let top: number;
  let bottom: number;
  let estimate: ActiveAreaEstimate | undefined;
  if (otherShape && valid.length >= MIN_VALID_SAMPLES) {
    const narrowest = narrowestRepeatedShape(clusters, valid.length, frameH, tolerance);
    if (narrowest === undefined) {
      classification = "MIXED_ASPECT_RATIO";
      top = 0;
      bottom = frameH;
      notes.push(`active area changes: ${shapes}`);
    } else {
      classification = "MIXED_NARROWEST";
      top = narrowest.top;
      bottom = narrowest.bottom;
      notes.push(
        // Begins as `MIXED_NARROWEST_NOTE` in batch/plan.ts says.
        `aspect ratio varies between scenes: ${shapes}. Judged by the narrowest ` +
          `recurring picture area, y=${top}..${bottom}, so subtitles stay inside the picture throughout`,
      );
    }
  } else if (!otherShape && agreement >= AGREEMENT) {
    classification = "CONSTANT";
    top = pickEdge(topCounts, modal.top);
    bottom = pickEdge(bottomCounts, modal.bottom);
    estimate = {
      modal: { top: modal.top, bottom: modal.bottom },
      chosen: { top, bottom },
      tops: topCounts,
      bottoms: bottomCounts,
    };
    if (top !== modal.top || bottom !== modal.bottom) {
      notes.push(
        `picture edges taken from the widest repeated samples: ` +
          `y=${top}..${bottom} rather than the modal y=${modal.top}..${modal.bottom}` +
          ` (most frames are dark at the edges, and a measurement only ever comes out smaller)`,
      );
    }
    if (valid.length < MIN_VALID_SAMPLES) {
      notes.push(`only ${valid.length} of ${samples.length} samples were usable`);
    }
  } else if (valid.length < MIN_VALID_SAMPLES) {
    classification = "UNKNOWN";
    top = 0;
    bottom = frameH;
    notes.push(
      `samples disagree and only ${valid.length} were usable; active area undetermined`,
    );
  } else {
    classification = "MIXED_ASPECT_RATIO";
    top = 0;
    bottom = frameH;
    notes.push(`active area changes: ${shapes}`);
  }

  // Left/right bars get the same treatment, but are reported only: scope
  // titles are full-width, so the active area always spans the whole frame.
  // `clusterBars` clusters on its top/bottom fields, so left/right go in there.
  const horizontal = clusterBars(
    valid.map((v) => ({
      top: v.left,
      bottom: v.right,
      left: v.left,
      right: v.right,
      timestampMs: v.timestampMs,
    })),
    tolerance,
  );
  const modalH = horizontal[0]!;
  const pillarLeft = modalH.top;
  const pillarRight = modalH.bottom;
  const pillarClassification: ActiveAreaClassification =
    modalH.count / valid.length >= AGREEMENT ? "CONSTANT" : "MIXED_ASPECT_RATIO";
  if (pillarClassification === "CONSTANT" && (pillarLeft > 0 || pillarRight < frameW)) {
    notes.push(
      `pillarbox detected (x=${pillarLeft}..${pillarRight}); reported only, not used`,
    );
  }

  return {
    frameWidth: frameW,
    frameHeight: frameH,
    top,
    bottom,
    left: 0,
    right: frameW,
    aspect: roundAspect(frameW, bottom - top),
    source: "auto",
    classification,
    samples,
    clusters,
    pillarbox: {
      left: pillarLeft,
      right: pillarRight,
      classification: pillarClassification,
    },
    tolerancePx: tolerance,
    ...(estimate === undefined ? {} : { estimate }),
    notes,
  };
}

export { DependencyMissingError };
