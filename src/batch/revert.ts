/**
 * `scope-sub revert` — undo an applied repair.
 *
 * A repair is a list of byte edits, and `patches/<n>.json` records every one of
 * them as `offset`, `before`, `after`. That makes the undo exact rather than
 * approximate: the inverse patch list is the same offsets with `before` and
 * `after` swapped, so reverting is the same operation as applying, run
 * backwards. The plan directory is therefore the complete undo record for a
 * whole library — a few megabytes for tens of terabytes of film.
 *
 * Two ways to write it back:
 *
 *   --output-root  a copy through the shared one-pass `copyWithPatches`,
 *                  hashed and read back exactly the way `apply` verifies;
 *   --in-place     a few thousand two-byte writes to the file itself, then a
 *                  re-read of those same ranges. This is the point of revert:
 *                  putting 4 KB back should not cost a 20 GB copy.
 *
 * Nothing is written without `--execute`, and a file whose bytes are not what
 * the plan says they should be is refused rather than guessed at (PRD §26).
 */
import { open, mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  copyWithPatches,
  hashFileChunked,
  partialPathFor,
  DEFAULT_CHUNK_SIZE,
} from "../fix/copyPatch.js";
import { countChangedBytes } from "../fix/fixFile.js";
import type { BytePatch } from "../pgs/patch.js";
import { formatBytes } from "../report/format.js";
import { dateToKeep, DateWatch, keepDate } from "./dates.js";
import { silentLogger, type Logger } from "../scan/log.js";
import {
  lastInPlaceWrite,
  appendApplyLog,
  completedByInput,
  readApplyLog,
  unfinishedInPlace,
  type ApplyLogEvent,
} from "./log.js";
import {
  decodePatches,
  planPaths,
  readPatchFile,
  requirePlan,
  type PatchFile,
  type PlanFileEntry,
  withInUseHint,
} from "./planFile.js";
import { APPLY_EXIT } from "./exitCodes.js";

/** Refusals that stop the whole run before any file is touched. */
export class RevertError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number = APPLY_EXIT.BAD_ARGS) {
    super(message);
    this.name = "RevertError";
    this.exitCode = exitCode;
  }
}

// --- the inverse patch ----------------------------------------------------

/**
 * The undo of a patch list: the same offsets, with `before` and `after` swapped.
 *
 * Sorted by offset, because `copyWithPatches` walks the file forwards and the
 * in-place writer reports the first problem it meets.
 */
export function invertPatches(patches: readonly BytePatch[]): BytePatch[] {
  return patches
    .map((p) => ({
      offset: p.offset,
      length: p.length,
      before: p.after,
      after: p.before,
    }))
    .sort((a, b) => a.offset - b.offset);
}

/** What the bytes now at a patch's offset say about the file's state. */
export type PatchByteState = "fixed" | "original" | "mismatch";

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Classify one patch's bytes. "fixed" is checked first, so a patch whose
 * `before` and `after` are identical (a field the repair left alone inside a
 * range it rewrote) counts as fixed rather than as an ambiguity.
 */
export function classifyPatchBytes(
  actual: Uint8Array,
  patch: BytePatch,
): PatchByteState {
  if (sameBytes(actual, patch.after)) return "fixed";
  if (sameBytes(actual, patch.before)) return "original";
  return "mismatch";
}

export interface PatchStateScan {
  total: number;
  fixed: number;
  original: number;
  mismatch: number;
  /** Offset of the first patch that is neither state, for the message. */
  firstMismatch: number | undefined;
}

/** Read every patched range out of `path` and classify it. */
export async function scanPatchState(
  path: string,
  patches: readonly BytePatch[],
): Promise<PatchStateScan> {
  const scan: PatchStateScan = {
    total: patches.length,
    fixed: 0,
    original: 0,
    mismatch: 0,
    firstMismatch: undefined,
  };
  const handle = await open(path, "r");
  try {
    for (const patch of patches) {
      const buffer = Buffer.allocUnsafe(patch.length);
      const { bytesRead } = await handle.read(buffer, 0, patch.length, patch.offset);
      const actual = new Uint8Array(
        buffer.buffer,
        buffer.byteOffset,
        Math.max(0, bytesRead),
      );
      const state =
        bytesRead === patch.length ? classifyPatchBytes(actual, patch) : "mismatch";
      if (state === "fixed") scan.fixed++;
      else if (state === "original") scan.original++;
      else {
        scan.mismatch++;
        scan.firstMismatch ??= patch.offset;
      }
    }
  } finally {
    await handle.close();
  }
  return scan;
}

export type RevertDecision =
  | { kind: "revert" }
  | { kind: "already-original"; reason: string }
  | { kind: "refuse"; reason: string };

export interface RevertCheck {
  /** Size of the file on disk; undefined when it is not there. */
  size: number | undefined;
  /** Size the plan recorded — the patch method never changes it. */
  expectedSize: number;
  scan: PatchStateScan;
  /**
   * The log shows an in-place write to this very file that never finished
   * (`unfinishedInPlace`): a half-and-half file is that run's, and finishing
   * it is safe. Without it the same state is refused.
   */
  resumable?: boolean;
}

/**
 * Whether the file in hand is the repaired file this patch list describes.
 *
 * Pure, so the whole refusal table is testable without a filesystem. The rule
 * is the one `apply` uses in the other direction: every byte must be exactly
 * what the record says, or nothing is written.
 */
export function decideRevert(check: RevertCheck): RevertDecision {
  if (check.size === undefined) {
    return { kind: "refuse", reason: "the file is not there" };
  }
  if (check.size !== check.expectedSize) {
    return {
      kind: "refuse",
      reason:
        `the file is ${check.size} bytes but the fixed file was ` +
        `${check.expectedSize}; this is not the file the plan describes`,
    };
  }
  const { total, fixed, original, mismatch, firstMismatch } = check.scan;
  if (total === 0) {
    return { kind: "already-original", reason: "the plan changed no bytes" };
  }
  if (mismatch > 0) {
    return {
      kind: "refuse",
      reason:
        `${mismatch} of ${total} patched range(s) hold neither the fixed nor the ` +
        `original bytes (first at offset ${firstMismatch}); the file has been ` +
        "modified by something else and is not safe to revert",
    };
  }
  if (fixed === 0) {
    return {
      kind: "already-original",
      reason: `all ${total} patched range(s) already hold the original bytes`,
    };
  }
  if (original > 0 && check.resumable !== true) {
    return {
      kind: "refuse",
      reason:
        `${fixed} of ${total} patched range(s) hold the fixed bytes and ` +
        `${original} hold the original: a write to this file was interrupted, and ` +
        "nothing here records which one. Finish it from the plan directory — " +
        "`revert <plan> --in-place` or `apply <plan> --dangerously-in-place` — " +
        "or restore it from a backup",
    };
  }
  return { kind: "revert" };
}

// --- writing --------------------------------------------------------------

export interface InPlaceResult {
  patchesWritten: number;
  bytesChanged: number;
}

/**
 * Write `patches` into `path` itself, then read those same ranges back.
 *
 * `r+` on a read-only mount fails at `open`, and that error is passed through
 * with the path rather than dressed up: EROFS and EPERM already say it.
 */
export async function writePatchesInPlace(
  path: string,
  patches: readonly BytePatch[],
): Promise<InPlaceResult> {
  let handle;
  try {
    handle = await open(path, "r+");
  } catch (err) {
    throw new RevertError(
      `${path} could not be opened for writing: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      APPLY_EXIT.FIX_FAILURE,
    );
  }
  try {
    let bytesChanged = 0;
    for (const patch of patches) {
      await handle.write(
        Buffer.from(patch.after.buffer, patch.after.byteOffset, patch.length),
        0,
        patch.length,
        patch.offset,
      );
      bytesChanged += countChangedBytes([patch]);
    }
    await handle.sync();

    // Read the same ranges back out of the file, not out of our own buffer:
    // an in-place write has no whole-file hash to fall back on, so this is the
    // only proof that what we asked for is what landed.
    for (const patch of patches) {
      const buffer = Buffer.allocUnsafe(patch.length);
      const { bytesRead } = await handle.read(buffer, 0, patch.length, patch.offset);
      const actual = new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
      if (!sameBytes(actual, patch.after)) {
        throw new RevertError(
          `the bytes at offset ${patch.offset} did not read back as written; ` +
            `${path} may now be damaged — restore it from a backup`,
          APPLY_EXIT.VALIDATION_FAILURE,
        );
      }
    }
    return { patchesWritten: patches.length, bytesChanged };
  } finally {
    await handle.close();
  }
}

// --- results --------------------------------------------------------------

export type RevertStatus = "reverted" | "would-revert" | "skipped" | "failed";

export interface RevertFileResult {
  /** The original input path: the key everything in the log is grouped by. */
  input: string;
  /** The repaired file being reverted. */
  target: string;
  /** Where the original bytes were written; the target itself when in place. */
  output: string;
  relative: string;
  inPlace: boolean;
  status: RevertStatus;
  reason: string | undefined;
  /** True for a failure that means the file was not what it claimed to be. */
  validation: boolean;
  patches: number;
  bytesChanged: number;
  bytesWritten: number;
  sha256: string | undefined;
  checks: string[];
  elapsedMs: number;
}

export interface RevertSummary {
  targets: number;
  reverted: number;
  skipped: number;
  failed: number;
  bytesWritten: number;
}

export interface RevertRunResult {
  /** The plan directory, or undefined for a --patch-file run. */
  dir: string | undefined;
  execute: boolean;
  inPlace: boolean;
  outputRoot: string | undefined;
  files: RevertFileResult[];
  summary: RevertSummary;
  exitCode: number;
  elapsedMs: number;
}

export interface RevertOptions {
  /** Only files whose path or relative name contains this substring. */
  file?: string;
  /** Only these inputs, by exact (resolved) path. Combines with `file`. */
  only?: readonly string[];
  inPlace?: boolean;
  /** Directory the reverted copies are written into. */
  outputRoot?: string;
  /** Single-target mode: the one file the reverted copy is written to. */
  output?: string;
  execute?: boolean;
  overwriteOutput?: boolean;
  /**
   * With `inPlace`: put each file's modification date back after writing it.
   * Off by default — a changed file normally says so.
   */
  preserveDates?: boolean;
  /** How long after a write a kept date is watched; default by filesystem (`settleWindowFor`). */
  dateSettleMs?: number;
  /** Copy chunk size; injectable for tests. */
  chunkSize?: number;
}

export interface RevertDeps {
  log?: Logger;
  /** The caller's watch over kept file dates; see `ApplyDeps.dateWatch`. */
  dateWatch?: DateWatch;
}

/** One file to put back, resolved from a plan entry or from the CLI directly. */
interface RevertTarget {
  input: string;
  relative: string;
  /** The repaired file on disk. */
  target: string;
  patchFile: PatchFile;
  /** Where the reverted copy goes; undefined for an in-place revert. */
  output: string | undefined;
  /**
   * The size the repaired file must have. The patch file's, unless the target
   * is the plan entry's own input: `plan` keeps the entry's size up to date
   * with that file (a header edit is adopted), while the patch file may still
   * carry the size of a copy made elsewhere.
   */
  expectedSize: number;
}

/** A result for a file that never got as far as being examined. */
function notRun(
  input: string,
  relative: string,
  target: string,
  inPlace: boolean,
  status: RevertStatus,
  reason: string,
): RevertFileResult {
  const result = emptyResult({ input, relative, target, output: undefined }, inPlace);
  result.status = status;
  result.reason = reason;
  return result;
}

function emptyResult(
  t: Omit<RevertTarget, "patchFile" | "expectedSize"> & { patchFile?: PatchFile },
  inPlace: boolean,
): RevertFileResult {
  return {
    input: t.input,
    target: t.target,
    output: inPlace ? t.target : (t.output ?? ""),
    relative: t.relative,
    inPlace,
    status: "skipped",
    reason: undefined,
    validation: false,
    patches: 0,
    bytesChanged: 0,
    bytesWritten: 0,
    sha256: undefined,
    checks: [],
    elapsedMs: 0,
  };
}

async function sizeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).size;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await sizeOf(path)) !== undefined;
}

interface RunContext {
  options: RevertOptions;
  log: Logger;
  execute: boolean;
  inPlace: boolean;
  /** Where `reverted` records go; undefined outside a plan directory. */
  logPath: string | undefined;
  /** In-place writes the log shows were never finished; see `unfinishedInPlace`. */
  unfinished: Map<string, ApplyLogEvent>;
  /** The last in-place write of each input (`lastInPlaceWrite`); see `dateToKeep`. */
  lastWrites: Map<string, ApplyLogEvent>;
  /** Watches the dates put back this run (`DateWatch`). */
  dateWatch: DateWatch;
  /** True when the watch is the caller's, who waits for it. */
  sharedWatch: boolean;
  /** The log's completions (`completedByInput`); empty outside a plan directory. */
  completed: Map<string, ApplyLogEvent>;
}

async function logEvent(
  ctx: RunContext,
  event: ApplyLogEvent,
  options: { sync?: boolean } = {},
): Promise<void> {
  if (!ctx.execute || ctx.logPath === undefined) return;
  await appendApplyLog(ctx.logPath, event, options);
}

/** Put one repaired file back. Never throws; failures are results. */
async function revertOne(
  ctx: RunContext,
  t: RevertTarget,
): Promise<RevertFileResult> {
  const started = Date.now();
  const result = emptyResult(t, ctx.inPlace);
  const finish = (): RevertFileResult => {
    result.elapsedMs = Date.now() - started;
    return result;
  };

  const patches = decodePatches(t.patchFile.patches);
  const inverse = invertPatches(patches);
  result.patches = inverse.length;
  result.bytesChanged = countChangedBytes(inverse);

  if (t.patchFile.method !== "patch") {
    result.status = "skipped";
    result.reason =
      `the plan fixed this file by remuxing, which records no byte patches; ` +
      "restore the original from its backup instead";
    ctx.log.warn(`skip ${t.relative}: ${result.reason}`);
    return finish();
  }

  const size = await sizeOf(t.target);
  const scan =
    size === t.expectedSize
      ? await scanPatchState(t.target, patches)
      : { total: patches.length, fixed: 0, original: 0, mismatch: 0, firstMismatch: undefined };
  const open = ctx.unfinished.get(t.input);
  const resumable =
    ctx.inPlace && open !== undefined && resolve(open.output ?? t.input) === resolve(t.target);
  const decision = decideRevert({ size, expectedSize: t.expectedSize, scan, resumable });

  // `preserveDates`: the date to put back after an in-place write — the one an
  // interrupted write of this file already promised, else the file's own now.
  const keeping = ctx.inPlace && ctx.options.preserveDates === true;
  // The last in-place write of this very file, if the log has one.
  const lastRecord = ctx.lastWrites.get(t.input);
  const lastOwn =
    lastRecord !== undefined && resolve(lastRecord.output ?? t.input) === resolve(t.target)
      ? lastRecord
      : undefined;
  const before = keeping ? await stat(t.target).catch(() => undefined) : undefined;
  const keepMtimeMs =
    keeping && (resumable || before !== undefined)
      ? dateToKeep(resumable ? open : lastOwn, before?.mtimeMs ?? 0)
      : undefined;
  const putDateBack = async (): Promise<void> => {
    // 0: an interrupted write that promised no date, over a file not stat'ed.
    if (keepMtimeMs === undefined || keepMtimeMs === 0 || !ctx.execute) return;
    const problem = await keepDate(t.target, keepMtimeMs);
    // Watched from here on, while the run goes on (`DateWatch`).
    ctx.dateWatch.add(t.target, keepMtimeMs, Date.now(), problem);
    if (problem === undefined) {
      result.checks.push(`preserved the file's date (${new Date(keepMtimeMs).toISOString()})`);
    } else {
      result.checks.push(`the file's date could not be preserved: ${problem}`);
      ctx.log.warn(`${t.relative}: date could not be preserved: ${problem}`);
    }
  };

  if (decision.kind === "already-original") {
    result.status = "skipped";
    result.reason = `already original: ${decision.reason}`;
    ctx.log.info(`skip ${t.relative}: ${result.reason}`);
    // A revert killed after its last byte but before its record: the file is
    // the original, and only a record can say so and close that run.
    //
    // The same goes for a file the log still calls repaired (`vouched`) that
    // holds the original bytes at every range — the unrepaired file put back
    // from a backup. Without a record `apply` would skip it as done for good.
    const completion = ctx.completed.get(t.input);
    const vouched =
      ctx.inPlace &&
      completion !== undefined &&
      resolve(completion.output ?? t.input) === resolve(t.target) &&
      scan.total > 0 &&
      scan.original === scan.total;
    if ((resumable || vouched) && ctx.execute) {
      if (!resumable) {
        result.reason +=
          "; the log recorded it as fixed, and now records that it is not, so apply will offer it again";
      }
      if (resumable && open?.keepMtimeMs !== undefined) await putDateBack();
      const after = await stat(t.target).catch(() => undefined);
      await logEvent(ctx, {
        time: new Date().toISOString(),
        event: "reverted",
        input: t.input,
        output: t.target,
        method: t.patchFile.method,
        patches: 0,
        bytesChanged: 0,
        reason: resumable
          ? "an interrupted in-place write had already restored every byte"
          : "found holding the original bytes (possibly restored from a backup)",
        ...(resumable && open?.keepMtimeMs !== undefined ? { keepMtimeMs: open.keepMtimeMs } : {}),
        ...(after === undefined ? {} : { stamp: { size: after.size, mtimeMs: after.mtimeMs } }),
      });
    }
    return finish();
  }
  if (decision.kind === "refuse") {
    result.status = "failed";
    result.validation = true;
    result.reason = decision.reason;
    ctx.log.error(`refused ${t.relative}: ${decision.reason}`);
    return finish();
  }

  if (!ctx.inPlace && ctx.options.overwriteOutput !== true && (await exists(result.output))) {
    result.status = "failed";
    result.reason = `${result.output} already exists (pass --overwrite-output to replace it)`;
    ctx.log.error(`refused ${t.relative}: ${result.reason}`);
    return finish();
  }

  result.checks.push(
    `${inverse.length} patched range(s) hold the fixed bytes, ` +
      `${result.bytesChanged} byte(s) to restore`,
  );

  if (!ctx.execute) {
    result.status = "would-revert";
    result.checks.push(
      ctx.inPlace
        ? `would write ${result.bytesChanged} byte(s) into ${t.target} itself`
        : `would write ${formatBytes(t.expectedSize)} to ${result.output}`,
    );
    return finish();
  }

  if (resumable && scan.original > 0) {
    result.checks.push(
      `${scan.original} range(s) are already back to the original from an interrupted ` +
        "in-place write; finishing it",
    );
  }

  try {
    if (ctx.inPlace) {
      // Logged before the first byte: a revert killed mid-write is then
      // recognised (`unfinishedInPlace`) and finished by the next run, instead
      // of leaving a half-reverted file both commands refuse.
      // Synced, for the reason `apply --dangerously-in-place` syncs its own.
      await logEvent(
        ctx,
        {
          time: new Date().toISOString(),
          event: "started",
          input: t.input,
          output: t.target,
          method: t.patchFile.method,
          inPlace: true,
          reason: "revert",
          ...(keepMtimeMs === undefined || keepMtimeMs === 0 ? {} : { keepMtimeMs }),
        },
        { sync: true },
      );
      const written = await writePatchesInPlace(t.target, inverse);
      result.bytesWritten = written.bytesChanged;
      result.checks.push(
        `wrote and read back ${written.patchesWritten} range(s) in place; ` +
          "the file is the original again",
      );
    } else {
      const output = result.output;
      await mkdir(dirname(output), { recursive: true });
      const partial = partialPathFor(output);
      await rm(partial, { force: true });
      const copy = await copyWithPatches(t.target, partial, inverse, {
        ...(ctx.options.chunkSize === undefined
          ? {}
          : { chunkSize: ctx.options.chunkSize }),
        expectedSize: t.expectedSize,
      });
      const readBack = await hashFileChunked(
        partial,
        ctx.options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      );
      if (readBack.sha256 !== copy.sha256 || readBack.bytes !== copy.bytesWritten) {
        await rm(partial, { force: true });
        throw new RevertError(
          `the written file does not match what was written ` +
            `(${copy.sha256.slice(0, 16)} → ${readBack.sha256.slice(0, 16)})`,
          APPLY_EXIT.VALIDATION_FAILURE,
        );
      }
      await rename(partial, output);
      result.bytesWritten = copy.bytesWritten;
      result.sha256 = copy.sha256;
      result.checks.push(
        `copied ${formatBytes(copy.bytesWritten)}, restored ${copy.bytesChanged} byte(s)`,
      );
      result.checks.push(`read back ${formatBytes(readBack.bytes)}, sha256 matches`);
    }

    result.status = "reverted";
    if (ctx.inPlace) await putDateBack();
    // An in-place revert of the input's own path changes its mtime; the stamp
    // is how `plan` knows that change was this tool's.
    const ownPath = ctx.inPlace && resolve(t.target) === resolve(t.input);
    const after = ownPath ? await stat(t.target).catch(() => undefined) : undefined;
    await logEvent(ctx, {
      time: new Date().toISOString(),
      event: "reverted",
      input: t.input,
      output: t.target,
      method: t.patchFile.method,
      ...(ctx.inPlace ? {} : { revertedTo: result.output }),
      patches: inverse.length,
      bytesChanged: result.bytesChanged,
      ...(result.sha256 === undefined ? {} : { sha256: result.sha256 }),
      ...(ctx.inPlace && keepMtimeMs !== undefined && keepMtimeMs !== 0 ? { keepMtimeMs } : {}),
      ...(after === undefined ? {} : { stamp: { size: after.size, mtimeMs: after.mtimeMs } }),
      durationMs: Date.now() - started,
    });
    ctx.log.info(
      ctx.inPlace
        ? `reverted ${t.target} in place`
        : `reverted ${t.target} → ${result.output}`,
    );
  } catch (err) {
    result.status = "failed";
    result.reason = withInUseHint(err, err instanceof Error ? err.message : String(err));
    result.validation =
      err instanceof RevertError && err.exitCode === APPLY_EXIT.VALIDATION_FAILURE;
    ctx.log.error(`failed ${t.relative}: ${result.reason}`);
  }

  return finish();
}

function summarize(files: readonly RevertFileResult[]): RevertSummary {
  const summary: RevertSummary = {
    targets: files.length,
    reverted: 0,
    skipped: 0,
    failed: 0,
    bytesWritten: 0,
  };
  for (const f of files) {
    if (f.status === "reverted") {
      summary.reverted++;
      summary.bytesWritten += f.bytesWritten;
    } else if (f.status === "would-revert") summary.reverted++;
    else if (f.status === "skipped") summary.skipped++;
    else summary.failed++;
  }
  return summary;
}

export function revertExitCode(files: readonly RevertFileResult[]): number {
  const failed = files.filter((f) => f.status === "failed");
  if (failed.some((f) => f.validation)) return APPLY_EXIT.VALIDATION_FAILURE;
  if (failed.length > 0) return APPLY_EXIT.FIX_FAILURE;
  return APPLY_EXIT.OK;
}

/**
 * Where the repaired file for one plan entry ended up.
 *
 * `verified` names the output it wrote; `replaced` swapped that output onto the
 * input's own path, and `patched` (`apply --dangerously-in-place`) repaired the
 * input itself, so for those two the repaired file *is* the input path.
 */
export function repairedPathFor(
  entry: PlanFileEntry,
  record: ApplyLogEvent,
): string {
  // `apply` logs `output: <the input path>` for a `replaced` record, so one
  // rule covers both: the record names where the repaired bytes live now.
  return record.output ?? entry.input;
}

async function runTargets(
  ctx: RunContext,
  targets: readonly RevertTarget[],
  dir: string | undefined,
  started: number,
): Promise<RevertRunResult> {
  const files: RevertFileResult[] = [];
  try {
    for (const t of targets) files.push(await revertOne(ctx, t));
  } finally {
    // The run's own watch is waited for however the run ends; the caller's
    // is the caller's to wait for.
    if (!ctx.sharedWatch) {
      for (const { path, problem } of await ctx.dateWatch.settle()) {
        ctx.log.warn(`${path}: date could not be preserved: ${problem}`);
        // Already said on the file when it is `keepDate`'s own problem.
        const checks = files.find((f) => resolve(f.target) === resolve(path))?.checks;
        if (checks?.some((c) => c.endsWith(problem)) === false) {
          checks.push(`the file's date could not be preserved: ${problem}`);
        }
      }
    }
  }
  files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  return {
    dir,
    execute: ctx.execute,
    inPlace: ctx.inPlace,
    outputRoot: ctx.options.outputRoot === undefined
      ? undefined
      : resolve(ctx.options.outputRoot),
    files,
    summary: summarize(files),
    exitCode: revertExitCode(files),
    elapsedMs: Date.now() - started,
  };
}

function checkDestination(options: RevertOptions, single: boolean): void {
  const destination = single ? options.output : options.outputRoot;
  const flag = single ? "--output" : "--output-root";
  if (options.inPlace === true && destination !== undefined) {
    throw new RevertError(`--in-place and ${flag} are alternatives; pass one`);
  }
  if (options.inPlace !== true && destination === undefined) {
    throw new RevertError(
      `pass --in-place to write the original bytes back into the fixed file, ` +
        `or ${flag} <dir> to write a reverted copy`,
    );
  }
}

/** Revert every applied file a plan directory records. */
export async function revertPlan(
  dir: string,
  options: RevertOptions,
  deps: RevertDeps = {},
): Promise<RevertRunResult> {
  const started = Date.now();
  const log = deps.log ?? silentLogger;
  const planDir = resolve(dir);
  const paths = planPaths(planDir);
  const plan = await requirePlan(planDir);
  checkDestination(options, false);

  const events = await readApplyLog(paths.applyLog);
  const completed = completedByInput(events);
  const unfinished = unfinishedInPlace(events);
  const outputRoot = options.outputRoot === undefined ? undefined : resolve(options.outputRoot);

  const ctx: RunContext = {
    options,
    log,
    execute: options.execute === true,
    inPlace: options.inPlace === true,
    logPath: paths.applyLog,
    unfinished,
    lastWrites: lastInPlaceWrite(events),
    dateWatch:
      deps.dateWatch ??
      new DateWatch({
        ...(options.dateSettleMs === undefined ? {} : { windowMs: options.dateSettleMs }),
        log,
      }),
    sharedWatch: deps.dateWatch !== undefined,
    completed,
  };

  const onlyInputs = options.only === undefined ? undefined : new Set(options.only.map((p) => resolve(p)));
  const wanted = plan.files.filter(
    (e) =>
      e.action === "fix" &&
      (onlyInputs === undefined || onlyInputs.has(resolve(e.input))) &&
      (options.file === undefined ||
        e.input.includes(options.file) ||
        e.relative.includes(options.file)),
  );

  const targets: RevertTarget[] = [];
  const skipped: RevertFileResult[] = [];
  for (const entry of wanted) {
    // An interrupted in-place write leaves no completion, but its file is still
    // this plan's to put back: the `started` record names it.
    const record = completed.get(entry.input) ?? unfinished.get(entry.input);
    if (!record) {
      const reason =
        "the apply log does not record this file as applied, so there is nothing " +
        "to revert";
      log.info(`skip ${entry.relative}: ${reason}`);
      skipped.push(
        notRun(entry.input, entry.relative, entry.input, ctx.inPlace, "skipped", reason),
      );
      continue;
    }
    if (entry.patchFile === undefined) {
      skipped.push(
        notRun(
          entry.input,
          entry.relative,
          repairedPathFor(entry, record),
          ctx.inPlace,
          "failed",
          "the plan entry has no patch file, so the undo is not recorded",
        ),
      );
      continue;
    }
    const target = repairedPathFor(entry, record);
    const patchFile = await readPatchFile(planDir, entry.patchFile);
    targets.push({
      input: entry.input,
      relative: entry.relative,
      target,
      patchFile,
      output: outputRoot === undefined ? undefined : join(outputRoot, entry.relative),
      expectedSize: resolve(target) === resolve(entry.input) ? entry.size : patchFile.size,
    });
  }

  log.info(
    `${ctx.execute ? "reverting" : "DRY RUN of reverting"} ${targets.length} file(s)` +
      (ctx.inPlace ? " in place" : ` into ${outputRoot}`),
  );

  const run = await runTargets(ctx, targets, planDir, started);
  run.files.push(...skipped);
  run.files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  run.summary = summarize(run.files);
  run.exitCode = revertExitCode(run.files);
  return run;
}

export interface RevertOneOptions extends RevertOptions {
  /** Path of a `patches/<n>.json` file. */
  patchFile: string;
  /** The repaired file it describes. */
  target: string;
}

/** Revert one file from an explicit patch file, with no plan directory. */
export async function revertPatchFileTarget(
  options: RevertOneOptions,
  deps: RevertDeps = {},
): Promise<RevertRunResult> {
  const started = Date.now();
  const log = deps.log ?? silentLogger;
  checkDestination(options, true);

  const path = resolve(options.patchFile);
  const patchFile = await readPatchFile(dirname(path), basename(path));
  const target = resolve(options.target);
  if (!(await exists(target))) {
    throw new RevertError(`${target} does not exist`);
  }

  const ctx: RunContext = {
    options,
    log,
    execute: options.execute === true,
    inPlace: options.inPlace === true,
    logPath: undefined,
    unfinished: new Map(),
    lastWrites: new Map(),
    dateWatch:
      deps.dateWatch ??
      new DateWatch({
        ...(options.dateSettleMs === undefined ? {} : { windowMs: options.dateSettleMs }),
        log,
      }),
    sharedWatch: deps.dateWatch !== undefined,
    completed: new Map(),
  };

  return runTargets(
    ctx,
    [
      {
        input: patchFile.input,
        relative: basename(target),
        target,
        patchFile,
        output: options.output === undefined ? undefined : resolve(options.output),
        expectedSize: patchFile.size,
      },
    ],
    undefined,
    started,
  );
}
