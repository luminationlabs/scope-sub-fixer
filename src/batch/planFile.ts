/**
 * The on-disk plan directory (PRD §17.2).
 *
 * A plan is a directory rather than a single file:
 *
 *   <dir>/plan.json          one entry per MKV: what was found, what will be done
 *   <dir>/patches/<n>.json   for each file to be patched, every byte that changes
 *   <dir>/apply.log.jsonl    the transaction log `apply` appends to
 *
 * Splitting the byte patches out keeps `plan.json` readable while still making
 * the plan a *complete* description of the repair: `apply` never re-analyzes,
 * it only replays what was reviewed. Patch bytes are stored as hex so the file
 * stays valid, diffable JSON.
 */
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import type { BytePatch } from "../pgs/patch.js";
import type { FileStatus, TrackStatus } from "../scan/types.js";
import type { FixMethod } from "../fix/types.js";
import type { PgsStreamFingerprint } from "../verify/pgs.js";

export const PLAN_FILE_NAME = "plan.json";
export const PATCH_DIR_NAME = "patches";
export const APPLY_LOG_NAME = "apply.log.jsonl";
/** Bumped whenever the shapes below change incompatibly. */
export const PLAN_SCHEMA_VERSION = 1;

/**
 * The generation of the rules a plan's verdicts were made under. A plan is
 * extended only by a build with the same number (`planMismatch`), so bump it
 * when — and only when — verdicts made before and after a change must not sit
 * in one plan. It is deliberately not the tool version: a release, a rename or
 * a fix that old entries can live beside must not make a library's kept plan
 * (its undo record) refuse to extend.
 */
export const PLAN_RULES_VERSION = 1;

/**
 * The generation of the rules that produce a skip verdict, recorded per entry
 * (`area_rules`): the active-area detector and whatever else decides that a
 * title needs nothing or that nothing can be done for it. Unlike
 * `PLAN_RULES_VERSION` a bump here refuses nothing: it lets `plan` pick out,
 * once, the entries a fault made wrong and look at only those again.
 *
 * Bump it when a change makes a known class of recorded skip verdicts wrong,
 * and add the rule that recognises that class to `AREA_RECHECKS` in plan.ts.
 * An entry without the field counts as generation 1.
 */
export const ACTIVE_AREA_RULES = 1;

/**
 * The generation of the rules that decide where a moved subtitle lands and
 * which ones can be moved at all, recorded in each patch file as
 * `placement_rules` (absent: 1).
 *
 * Bump it when a change may let the current rules move subtitles an earlier
 * repair had to leave outside. `remargin` then redoes, once, each repair from
 * an older generation that left subtitles outside (`repairIsStale` in
 * `plan.ts`). Like `ACTIVE_AREA_RULES`, a bump here refuses nothing.
 *
 * A redo puts the original back and fixes it again: two writes to a file. So
 * a bump should come with a narrower test in `repairIsStale` wherever the
 * patch file can say whether the change applies to it — its tracks' `skipped`
 * reasons name what was refused — and a change that lifts a refusal of a
 * whole track has to look at the plan entry's `tracks` (`redoIsDue`), since a
 * track that was not fixed is in no patch file.
 */
export const PLACEMENT_RULES = 1;

/**
 * The rules generation of a plan on disk. A plan without `tool.rules` is of
 * no known generation (0), so `planMismatch` refuses to extend it.
 */
export function planRulesOf(plan: { tool: { rules?: number } }): number {
  return typeof plan.tool.rules === "number" ? plan.tool.rules : 0;
}

/**
 * Whether two recorded mtimes are the same instant. Runtimes disagree below a
 * millisecond — Node reports the fraction, bun a whole number — and a plan
 * written by one must be readable by the other. An mtime put back through
 * `utimes` (float seconds) can also land a whole millisecond off where the
 * runtime truncates. So stamps within 1 ms of each other are the same stamp.
 */
export function sameMtime(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1;
}

/** A plan directory could not be read, or is not a plan directory. */
export class PlanFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanFileError";
  }
}

export interface PlanPaths {
  dir: string;
  planFile: string;
  patchDir: string;
  applyLog: string;
}

export function planPaths(dir: string): PlanPaths {
  return {
    dir,
    planFile: join(dir, PLAN_FILE_NAME),
    patchDir: join(dir, PATCH_DIR_NAME),
    applyLog: join(dir, APPLY_LOG_NAME),
  };
}

// --- schema ---------------------------------------------------------------

export type PlanAction = "fix" | "skip";

export interface PlanBytePatch {
  offset: number;
  length: number;
  /** Lowercase hex, `length` bytes. */
  before: string;
  after: string;
}

export interface PlanMove {
  event_index: number;
  pts_ms: number;
  object_id: number;
  window_id: number;
  dx: number;
  dy: number;
  /** The object was already inside and only moves to stay with its window. */
  for_consistency?: boolean;
}

export interface PatchFileTrack {
  mkvmerge_id: number;
  matroska_number: number;
  language: string;
  name?: string;
  event_count: number;
  offending_event_count: number;
  events_moved: number;
  display_sets_patched: number;
  position_fields: number;
  bytes_changed: number;
  canvas: { width: number; height: number };
  /** Active area in PGS canvas coordinates; `apply` classifies against it. */
  active_on_canvas: { top: number; bottom: number; left: number; right: number };
  margin: number;
  /**
   * Offending events the move policy refused to touch, so `apply` knows how
   * many events may legitimately still be outside the active area afterwards.
   */
  expected_offending_after: number;
  /**
   * Composition objects outside their own window in the input (a fix makes
   * none, so the output may have no more). Absent in older files: not checked.
   */
  outside_window?: number;
  skipped?: string[];
  moves: PlanMove[];
  /** Positionless fingerprint of the input track (see verify/pgs.ts). */
  fingerprint: PgsStreamFingerprint;
}

export interface PatchFile {
  schema: number;
  /** `rules` as in `PlanFile`. */
  tool: { name: string; version: string; rules?: number };
  /** `PLACEMENT_RULES` when the repair was planned; absent: 1. */
  placement_rules?: number;
  created: string;
  input: string;
  size: number;
  mtimeMs: number;
  method: FixMethod;
  tracks: PatchFileTrack[];
  /** Every byte the repair changes, sorted by offset. Patch method only. */
  patches: PlanBytePatch[];
}

export interface PlanTrackEntry {
  mkvmerge_id: number;
  matroska_number: number;
  language: string;
  name?: string;
  forced: boolean;
  default: boolean;
  /** Omitted when the track was not read (the no-letterbox fast path). */
  event_count?: number;
  offending_event_count: number;
  status: TrackStatus;
  action: PlanAction;
  reason?: string;
}

export interface PlanFileEntry {
  /** Absolute path of the input MKV. */
  input: string;
  /** Directory the input was found under, when a directory was scanned. */
  root?: string;
  /**
   * Output path relative to `--output-root` (basename, or mirrored subpath).
   * Stored with `/` on every platform (`storedRelative`); `join` on Windows
   * takes either separator, so it is read as it is.
   */
  relative: string;
  size: number;
  mtimeMs: number;
  /**
   * The Matroska Segment UID, when mkvmerge reported one. It survives a header
   * edit (`mkvpropedit`) and not a re-rip, which is what lets `plan` tell the
   * two apart when only the size changed. Absent from older entries.
   */
  segment_uid?: string;
  status: FileStatus;
  reason?: string;
  video: { w: number; h: number } | null;
  active_area: {
    top: number;
    bottom: number;
    left: number;
    right: number;
    aspect: number;
    source: string;
    classification: string;
  } | null;
  tracks: PlanTrackEntry[];
  action: PlanAction;
  /** Relative path inside the plan directory, e.g. "patches/3.json". */
  patchFile?: string;
  patch_summary?: {
    tracks: number;
    events_moved: number;
    display_sets: number;
    position_fields: number;
    bytes_changed: number;
  };
  /** True when any PGS track carries Matroska content compression. */
  compressed?: boolean;
  /**
   * How this file is repaired. Normally the plan's method; "remux" in a patch
   * plan built with `remuxFallback` for a title patching could not do in full.
   */
  method: FixMethod;
  notes?: string[];
  analyzed: string;
  analysis_ms?: number;
  /**
   * The generation of the rules that produced this verdict
   * (`ACTIVE_AREA_RULES`; absent: 1). See `needsAreaRecheck` in plan.ts.
   */
  area_rules?: number;
  /**
   * Set when `remargin` analyzed this title again and kept this entry because
   * the new repair would have been worse: the margin asked for (null: the
   * default), the `PLACEMENT_RULES` generation, and when. The same redo is not
   * tried again until one of the first two changes (`redoIsDue` in plan.ts).
   */
  redo_tried?: { margin: number | null; rules: number; at: string };
  /**
   * One patched range of this entry's repair, kept beside it so that every
   * run can ask a file this plan fixed whether it still holds the fix — one
   * small read, where the size and the date cannot tell (a fixed file put
   * back from a backup has the original's size and, with most ways of
   * copying, its date). Names the patch file it came from: an entry given
   * another patch file gets another probe. Hex, as patch files spell bytes.
   */
  probe?: { patchFile: string; offset: number; before: string; after: string };
}

export interface PlanFile {
  schema: number;
  /** `rules` is `PLAN_RULES_VERSION` as written (`planRulesOf`). */
  tool: { name: string; version: string; rules?: number };
  created: string;
  updated: string;
  options: {
    aspect: number | "auto";
    margin?: number;
    method: FixMethod;
    recursive: boolean;
    /** Omitted when on (the default); false records a `--no-fast-path` plan. */
    fastPath?: boolean;
    /**
     * True when titles the patch method had to refuse were planned for remux
     * instead (`PlanOptions.remuxFallback`). Omitted when off. Such an entry
     * says so itself, in its own `method`.
     */
    remuxFallback?: boolean;
  };
  /** Inputs given on the command line, for reference. */
  paths: string[];
  files: PlanFileEntry[];
}

// --- hex ------------------------------------------------------------------

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}

export function fromHex(hex: string, what = "patch bytes"): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) {
    throw new PlanFileError(`${what}: "${hex}" is not an even-length hex string`);
  }
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export function encodePatch(patch: BytePatch): PlanBytePatch {
  return {
    offset: patch.offset,
    length: patch.length,
    before: toHex(patch.before),
    after: toHex(patch.after),
  };
}

export function decodePatch(patch: PlanBytePatch): BytePatch {
  const before = fromHex(patch.before, `patch at ${patch.offset} "before"`);
  const after = fromHex(patch.after, `patch at ${patch.offset} "after"`);
  if (before.length !== patch.length || after.length !== patch.length) {
    throw new PlanFileError(
      `patch at offset ${patch.offset} declares length ${patch.length} but carries ` +
        `${before.length}/${after.length} byte(s)`,
    );
  }
  if (!Number.isInteger(patch.offset) || patch.offset < 0) {
    throw new PlanFileError(`patch offset ${patch.offset} is not a file offset`);
  }
  return { offset: patch.offset, length: patch.length, before, after };
}

export function encodePatches(patches: readonly BytePatch[]): PlanBytePatch[] {
  return [...patches].sort((a, b) => a.offset - b.offset).map(encodePatch);
}

export function decodePatches(patches: readonly PlanBytePatch[]): BytePatch[] {
  return patches.map(decodePatch).sort((a, b) => a.offset - b.offset);
}

// --- io -------------------------------------------------------------------

/**
 * A relative path as the plan directory stores it: `/`-separated on every
 * platform, so `relative` and `patchFile` read the same whichever system wrote
 * them. A no-op where the separator already is `/`; on Windows, where
 * `node:path` accepts either, the stored form is used as it is.
 */
export function storedRelative(path: string, separator: string = sep): string {
  return separator === "/" ? path : path.split(separator).join("/");
}

/** Error codes Windows gives a rename onto (or of) a file another program has open. */
const IN_USE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function codeOf(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
}

/**
 * "…: the file is in use by another program" for an error Windows gives a
 * file another program holds open, else undefined. Windows only: on POSIX
 * those codes mean a permission problem, and the system's message says so.
 */
export function inUseHint(err: unknown, platform: string = process.platform): string | undefined {
  const code = codeOf(err);
  return platform === "win32" && code !== undefined && IN_USE_CODES.has(code)
    ? "the file may be in use by another program (an open player, an antivirus scan or the search indexer); close it and try again"
    : undefined;
}

/** `message`, with `inUseHint` appended when it applies and is not there already. */
export function withInUseHint(err: unknown, message: string, platform: string = process.platform): string {
  const hint = inUseHint(err, platform);
  return hint === undefined || message.includes(hint) ? message : `${message}: ${hint}`;
}

export interface RenameRetry {
  /** Attempts in all, the first included. */
  attempts?: number;
  delayMs?: number;
  platform?: string;
  rename?: (from: string, to: string) => Promise<void>;
}

/**
 * `rename`, tried again a few times over about a second when Windows refuses
 * it as in use: an antivirus or the indexer opening the file just written is
 * a known, passing cause there. One try on every other platform, and for any
 * other error.
 */
export async function renameRetrying(from: string, to: string, options: RenameRetry = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const attempts = platform === "win32" ? (options.attempts ?? 5) : 1;
  const delayMs = options.delayMs ?? 250;
  const doRename = options.rename ?? rename;
  for (let attempt = 1; ; attempt++) {
    try {
      await doRename(from, to);
      return;
    } catch (err) {
      const code = codeOf(err);
      if (attempt >= attempts || code === undefined || !IN_USE_CODES.has(code)) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/** Write JSON through a temp file and a rename, so a kill never truncates it. */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  retry?: RenameRetry,
): Promise<void> {
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (retry === undefined) {
    await rename(temp, path);
    return;
  }
  try {
    await renameRetrying(temp, path, retry);
  } catch (err) {
    const hint = inUseHint(err, retry.platform);
    if (hint === undefined) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`${path} could not be replaced (${message}): ${hint}`), {
      code: codeOf(err),
      cause: err,
    });
  }
}

async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new PlanFileError(
      `${path} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new PlanFileError(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Minimal structural validation: enough to fail loudly on the wrong file. */
export function assertPlanFile(value: unknown, path: string): PlanFile {
  if (!isRecord(value) || !Array.isArray(value.files) || !isRecord(value.options)) {
    throw new PlanFileError(`${path} is not a scope-sub plan file`);
  }
  const plan = value as unknown as PlanFile;
  if (plan.schema !== PLAN_SCHEMA_VERSION) {
    throw new PlanFileError(
      `${path} has plan schema ${String(plan.schema)}; this build writes ${PLAN_SCHEMA_VERSION}`,
    );
  }
  for (const entry of plan.files) {
    if (!isRecord(entry) || typeof entry.input !== "string") {
      throw new PlanFileError(`${path} contains a file entry without an input path`);
    }
  }
  return plan;
}

export function assertPatchFile(value: unknown, path: string): PatchFile {
  if (!isRecord(value) || !Array.isArray(value.patches) || !Array.isArray(value.tracks)) {
    throw new PlanFileError(`${path} is not a scope-sub patch file`);
  }
  const file = value as unknown as PatchFile;
  if (file.schema !== PLAN_SCHEMA_VERSION) {
    throw new PlanFileError(
      `${path} has patch schema ${String(file.schema)}; this build writes ${PLAN_SCHEMA_VERSION}`,
    );
  }
  return file;
}

/** Read `<dir>/plan.json`, or null when the directory holds no plan yet. */
export async function readPlan(dir: string): Promise<PlanFile | null> {
  const { planFile } = planPaths(dir);
  try {
    await readFile(planFile);
  } catch {
    return null;
  }
  return assertPlanFile(await readJson(planFile), planFile);
}

/** Read `<dir>/plan.json`, throwing when it is missing. */
export async function requirePlan(dir: string): Promise<PlanFile> {
  const plan = await readPlan(dir);
  if (!plan) {
    throw new PlanFileError(`${join(dir, PLAN_FILE_NAME)} does not exist`);
  }
  return plan;
}

/**
 * Save `plan.json`. The only write here that retries a refused rename
 * (`renameRetrying`): it is rewritten after every title, which is exactly the
 * pattern Windows' antivirus and indexer interfere with.
 */
export async function writePlan(dir: string, plan: PlanFile, retry: RenameRetry = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeJsonAtomic(planPaths(dir).planFile, plan, retry);
}

export async function readPatchFile(dir: string, relative: string): Promise<PatchFile> {
  const path = join(dir, relative);
  return assertPatchFile(await readJson(path), path);
}

export async function writePatchFile(
  dir: string,
  relative: string,
  file: PatchFile,
): Promise<void> {
  await mkdir(join(dir, PATCH_DIR_NAME), { recursive: true });
  await writeJsonAtomic(join(dir, relative), file);
}

/** Next free `patches/<n>.json`, given the entries already in the plan. */
export async function nextPatchFileName(
  dir: string,
  used: readonly string[],
): Promise<string> {
  const taken = new Set(used.map((u) => basename(u)));
  let existing: string[] = [];
  try {
    existing = await readdir(join(dir, PATCH_DIR_NAME));
  } catch {
    existing = [];
  }
  for (const name of existing) taken.add(name);
  let n = 1;
  while (taken.has(`${n}.json`)) n++;
  return `${PATCH_DIR_NAME}/${n}.json`;
}

/**
 * Where a planned file's output goes under `--output-root`.
 *
 * Flat when the plan came from explicit files, mirrored when it came from a
 * recursive directory scan. The basename is never changed: swapping a repaired
 * file in must not break the Kodi library's match.
 */
export function outputPathFor(entry: PlanFileEntry, outputRoot: string): string {
  return join(outputRoot, entry.relative);
}
