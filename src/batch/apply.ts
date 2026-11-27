/**
 * `scope-sub apply` — execute a reviewed plan (PRD §17.3).
 *
 * Rules the whole design serves:
 *   - dry run by default; `--execute` is a deliberate act;
 *   - originals are never touched unless `--replace-original` is asked for;
 *   - every output is verified before it counts as a success;
 *   - a failure costs one file, not the run;
 *   - everything is written to a transaction log, so a rerun resumes.
 *
 * For the patch method nothing is re-analyzed: the plan already carries every
 * byte that changes and a positionless fingerprint of each track, so `apply`
 * copies the input once (patching the stream as it passes), proves the copy is
 * intact, and then proves the finished file's PGS is the planned one.
 *
 * `--dangerously-in-place` is the one mode that breaks the second rule on
 * purpose: no copy at all, the planned bytes are written into each input
 * through the same small `r+` writes `revert --in-place` uses. Every other rule
 * still holds — dry run by default, every patched range checked against the
 * plan before the first write and read back after the last, the PGS verified
 * (and the bytes put back if it fails), everything logged. What it gives up is
 * the untouched original: the plan directory becomes the only undo record.
 */
import { constants as fsConstants } from "node:fs";
import { access, mkdir, rename, rm, rmdir, stat, statfs } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildDisplaySets, resolveEvents } from "../pgs/compose.js";
import { classifyEvents } from "../geometry/classify.js";
import type { Bounds } from "../geometry/rect.js";
import { readPgsTracksData } from "../mkv/pgsBlocks.js";
import { countChangedBytes, fixFile, FixError } from "../fix/fixFile.js";
import { PatchVerifyError } from "../fix/patchFile.js";
import type { FixMethod } from "../fix/types.js";
import type { BytePatch } from "../pgs/patch.js";
import { formatBytes } from "../report/format.js";
import { silentLogger, type Logger } from "../scan/log.js";
import { verifyFile } from "../verify/verifyFile.js";
import { fingerprintDifferences, fingerprintTrack, objectsOutsideWindow } from "../verify/pgs.js";
import {
  CopyAbortedError,
  copyWithPatches,
  hashFileChunked,
  partialPathFor,
  DEFAULT_CHUNK_SIZE,
} from "../fix/copyPatch.js";
import { dateToKeep, DateWatch, keepDate } from "./dates.js";
import { APPLY_EXIT } from "./exitCodes.js";
import {
  appendApplyLog,
  completedByInput,
  lastInPlaceWrite,
  pendingReplacements,
  readApplyLog,
  revertedByInput,
  shouldSkipForResume,
  type ApplyLogEvent,
  type OutputState,
} from "./log.js";
import {
  decodePatches,
  outputPathFor,
  planPaths,
  readPatchFile,
  requirePlan,
  sameMtime,
  type PatchFile,
  type PlanFile,
  type PlanFileEntry,
  withInUseHint,
} from "./planFile.js";
import {
  invertPatches,
  RevertError,
  scanPatchState,
  writePatchesInPlace,
  type PatchStateScan,
} from "./revert.js";

export { APPLY_EXIT };

/**
 * Where a repaired file is written when `--replace-original` is used with an
 * `--output-root` whose computed output path IS the input. Staging inside the
 * output root keeps the copy on the same filesystem, so the final swap is still
 * two atomic renames.
 */
export const STAGING_DIR = ".scopefix-staging";

/** A per-file failure, tagged with the exit code it maps onto. */
export type ApplyFailureKind = "fix" | "verification";

class ApplyFailure extends Error {
  constructor(
    message: string,
    readonly kind: ApplyFailureKind,
  ) {
    super(message);
    this.name = "ApplyFailure";
  }
}

/** Refusals that stop the whole run before any file is touched. */
export class ApplyError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number = APPLY_EXIT.BAD_ARGS) {
    super(message);
    this.name = "ApplyError";
    this.exitCode = exitCode;
  }
}

export interface ApplyOptions {
  /** Required, except with `inPlace`, which takes none. */
  outputRoot?: string;
  /** Without this nothing is written at all. */
  execute?: boolean;
  /**
   * `--dangerously-in-place`: write the planned bytes into each input itself,
   * with no copy and no backup. Patch-method entries only.
   */
  inPlace?: boolean;
  /** With `inPlace`: skip the post-write PGS read (a whole-file read each). */
  skipVerify?: boolean;
  /**
   * With `inPlace`: put each file's modification date back after writing it.
   * Off by default — a changed file normally says so.
   */
  preserveDates?: boolean;
  /** How long after a write a kept date is watched; default by filesystem (`settleWindowFor`). */
  dateSettleMs?: number;
  jobs?: number;
  replaceOriginal?: boolean;
  backupSuffix?: string;
  overwriteOutput?: boolean;
  stopOnError?: boolean;
  /** Copy chunk size; injectable for tests. */
  chunkSize?: number;
  /** Free space required beyond the file's own size, as a fraction. */
  headroom?: number;
  /**
   * Only these planned inputs (absolute paths, as the plan records them); the
   * rest of the plan is left out of the run entirely. `review` uses it to apply
   * exactly the titles the operator said yes to.
   */
  only?: readonly string[];
}

/**
 * What a run is doing, for a caller that wants to show it (the desktop app's
 * engine protocol). `index` counts the planned files in the order they start.
 */
export type ApplyProgress =
  | { type: "file-start"; index: number; total: number; input: string; relative: string }
  | {
      /**
       * A patch entry: `copy` carries bytes; `read-back` (re-hashing what was
       * written) and `verify` (the PGS check) are announced once each as they
       * begin. A remux entry: `analyze`, `extract`, `rebuild` and `verify`,
       * once each, without bytes.
       */
      type: "file-progress";
      input: string;
      phase: "copy" | "read-back" | "verify" | "analyze" | "extract" | "rebuild";
      done?: number;
      total?: number;
    }
  | { type: "file-done"; index: number; total: number; result: ApplyFileResult };

export interface ApplyDeps {
  log?: Logger;
  onProgress?: (progress: ApplyProgress) => void;
  /**
   * Stops the run: no further file is started, and a copy in progress is
   * abandoned (its partial output removed, the file reported `failed` with the
   * reason "cancelled"). So is the read-back and the PGS check that follow it:
   * the output is removed, never left unverified. Only an in-place write is
   * finished and verified regardless. A remux is abandoned at any point up
   * to its final rename: the running mkvextract or mkvmerge is terminated and
   * its temp files and partial output removed.
   */
  signal?: AbortSignal;
  /**
   * The caller's watch over kept file dates. Given one, this run adds to it
   * and returns without waiting; the caller calls `settle()` when all its
   * runs are done. Without one the run watches and waits for its own.
   */
  dateWatch?: DateWatch;
  mkvmergePath?: string;
  mkvextractPath?: string;
  /** Injectable so a failing verification can be tested without a bad file. */
  verifyOutput?: (
    output: string,
    patchFile: PatchFile,
    signal?: AbortSignal,
  ) => Promise<OutputVerification>;
}

export type ApplyStatus =
  | "applied"
  | "would-apply"
  | "skipped"
  | "failed"
  | "conflict";

export interface ApplyFileResult {
  input: string;
  output: string;
  relative: string;
  status: ApplyStatus;
  reason: string | undefined;
  failureKind: ApplyFailureKind | undefined;
  method: FixMethod;
  bytesWritten: number;
  sha256: string | undefined;
  verified: boolean;
  replaced: boolean;
  /** Written into the input itself (`--dangerously-in-place`); `output` is the input. */
  inPlace: boolean;
  /**
   * In place only: the file is half patched by an earlier run that was
   * interrupted, and this one finishes (or, as a dry run, would finish) it.
   */
  resuming: boolean;
  /**
   * In place only: an earlier run wrote every change and was interrupted before
   * it recorded the result (during verification). Finishing it writes nothing
   * new — it verifies, and records `patched` or puts the original back.
   */
  awaitingVerification: boolean;
  backup: string | undefined;
  /** One line per verification step, for the report. */
  checks: string[];
  elapsedMs: number;
}

export interface ApplySummary {
  planned: number;
  applied: number;
  verified: number;
  skipped: number;
  failed: number;
  conflicts: number;
  bytesWritten: number;
}

export interface ApplyRunResult {
  dir: string;
  /** Undefined for an in-place run, which has none. */
  outputRoot: string | undefined;
  execute: boolean;
  inPlace: boolean;
  files: ApplyFileResult[];
  summary: ApplySummary;
  exitCode: number;
  elapsedMs: number;
  /** Present (and true) only when `ApplyDeps.signal` stopped the run early. */
  cancelled?: true;
}

// --- pre-flight -----------------------------------------------------------

export interface PreflightInput {
  exists: boolean;
  size: number;
  mtimeMs: number;
}

export type PreflightOutcome =
  | { ok: true }
  | { ok: false; kind: "skip" | "conflict"; reason: string };

export interface PreflightOptions {
  overwriteOutput?: boolean;
  /** Bytes available on the output volume, when it could be measured. */
  freeBytes?: number;
  /** Another planned file maps onto the same output path. */
  duplicateOutput?: boolean;
  /** Fraction of the file size wanted free beyond the file itself. */
  headroom?: number;
  /** The computed output path is the input itself. */
  outputIsInput?: boolean;
  /** `--replace-original` would overwrite an existing backup. */
  backupExists?: boolean;
  /**
   * The file at the output path is one this plan wrote and `revert` then put
   * back in place. It is ours, and it is the original again, so replacing it
   * is what re-applying means — no `--overwrite-output` needed.
   */
  outputWasReverted?: boolean;
  /**
   * In-place only: the log says this tool last wrote the input in place, so its
   * mtime is ours and no longer the plan's. The size must still match; the
   * byte scan that follows decides the rest.
   */
  ignoreMtime?: boolean;
}

/**
 * Everything that must hold before a file is written. Pure, so the table of
 * refusals can be tested without a filesystem.
 */
export function preflightDecision(
  entry: PlanFileEntry,
  input: PreflightInput,
  output: OutputState | null,
  options: PreflightOptions = {},
): PreflightOutcome {
  if (entry.action !== "fix") {
    return { ok: false, kind: "skip", reason: entry.reason ?? "not planned for fixing" };
  }
  if (!input.exists) {
    return { ok: false, kind: "skip", reason: "the original file no longer exists" };
  }
  if (
    input.size !== entry.size ||
    (!sameMtime(input.mtimeMs, entry.mtimeMs) && options.ignoreMtime !== true)
  ) {
    return {
      ok: false,
      kind: "skip",
      reason:
        "the file was modified after the plan was built " +
        `(${entry.size} bytes at ${new Date(entry.mtimeMs).toISOString()} → ` +
        `${input.size} bytes at ${new Date(input.mtimeMs).toISOString()}); re-run plan`,
    };
  }
  if (options.outputIsInput === true) {
    return {
      ok: false,
      kind: "conflict",
      reason: "the output path is the original file; choose a different --output-root",
    };
  }
  if (options.backupExists === true) {
    return {
      ok: false,
      kind: "conflict",
      reason: "a backup from an earlier run is already in the way",
    };
  }
  if (options.duplicateOutput === true) {
    return {
      ok: false,
      kind: "conflict",
      reason: "another planned file maps onto the same output path",
    };
  }
  if (
    output?.exists === true &&
    options.overwriteOutput !== true &&
    options.outputWasReverted !== true
  ) {
    return {
      ok: false,
      kind: "conflict",
      reason: "the output already exists (pass --overwrite-output to replace it)",
    };
  }
  if (options.freeBytes !== undefined) {
    const needed = Math.ceil(entry.size * (1 + (options.headroom ?? 0.02)));
    if (options.freeBytes < needed) {
      return {
        ok: false,
        kind: "skip",
        reason:
          `not enough free space on the output volume: ${formatBytes(needed)} needed, ` +
          `${formatBytes(options.freeBytes)} available`,
      };
    }
  }
  return { ok: true };
}

export type InPlaceDecision =
  | { kind: "write"; resume: boolean }
  | { kind: "skip"; reason: string }
  | { kind: "refuse"; reason: string };

export interface InPlaceCheck {
  /** The input's size now. */
  size: number;
  /** The size the plan recorded. */
  expectedSize: number;
  /** What the input's patched ranges hold now (ranges the plan changes only). */
  scan: PatchStateScan;
  /** The log says this tool last wrote the input in place (`lastInPlaceWrite`). */
  resumable: boolean;
}

/**
 * Whether `--dangerously-in-place` may write into this input.
 *
 * `revert`'s refusal table, the other way round, plus one case of its own: a
 * file that holds the repaired bytes in some ranges and the original in the
 * rest. That is what a killed in-place run leaves, and when the log says the
 * last thing to write the file was this tool, finishing it is the only way
 * back (`revert` refuses a half-patched file). Writing a range that already
 * holds its `after` bytes changes nothing, so finishing is simply writing
 * them all again. Without that log record, the same state means something
 * else has been at the file, and it is refused.
 *
 * Pure, so the whole table is testable without a filesystem.
 */
export function decideInPlace(check: InPlaceCheck): InPlaceDecision {
  if (check.size !== check.expectedSize) {
    return {
      kind: "refuse",
      reason:
        `the file is ${check.size} bytes but the plan recorded ${check.expectedSize}; ` +
        "this is not the file the plan describes",
    };
  }
  const { total, fixed, original, mismatch, firstMismatch } = check.scan;
  if (total === 0) {
    return { kind: "skip", reason: "the plan changes no bytes in this file" };
  }
  if (mismatch > 0) {
    return {
      kind: "refuse",
      reason:
        `${mismatch} of ${total} patched range(s) hold neither the original nor the ` +
        `fixed bytes (first at offset ${firstMismatch}); the file is not the one ` +
        "the plan describes, and nothing was written to it",
    };
  }
  if (original === total) return { kind: "write", resume: false };
  if (check.resumable) return { kind: "write", resume: true };
  return {
    kind: "refuse",
    reason:
      `${fixed} of ${total} patched range(s) already hold the fixed bytes, but the ` +
      "apply log records no in-place run for this file; something else has modified " +
      "it, and nothing was written to it",
  };
}

// --- verification ---------------------------------------------------------

export interface OutputVerification {
  ok: boolean;
  checks: string[];
  problems: string[];
}

/**
 * Prove a patched output is the file the plan described.
 *
 * The input is not read again: everything compared here comes from the patch
 * file written at plan time — the positionless fingerprint of each track and
 * the active area the events were classified against.
 */
export async function verifyPatchedOutput(
  output: string,
  patchFile: PatchFile,
  signal?: AbortSignal,
): Promise<OutputVerification> {
  const checks: string[] = [];
  const problems: string[] = [];
  const numbers = patchFile.tracks.map((t) => t.matroska_number);
  if (numbers.length === 0) return { ok: true, checks, problems };

  // Throwing from the reader's progress hook is how a read is abandoned.
  const data = await readPgsTracksData(
    output,
    numbers,
    signal === undefined
      ? {}
      : {
          onProgress: () => {
            if (signal.aborted) throw new CopyAbortedError();
          },
        },
  );
  throwIfCancelled(signal);
  for (const track of patchFile.tracks) {
    const entry = data.get(track.matroska_number);
    if (!entry) {
      problems.push(`track ${track.mkvmerge_id} is missing from the output`);
      continue;
    }
    const displaySets = buildDisplaySets(entry.segments);
    const differences = fingerprintDifferences(
      track.fingerprint,
      fingerprintTrack(displaySets),
    );
    for (const d of differences) {
      problems.push(`track ${track.mkvmerge_id}: ${d}`);
    }

    const bounds: Bounds = {
      top: track.active_on_canvas.top,
      bottom: track.active_on_canvas.bottom,
      left: track.active_on_canvas.left,
      right: track.active_on_canvas.right,
    };
    const events = resolveEvents(displaySets);
    const outsideWindow = objectsOutsideWindow(events);
    if (track.outside_window !== undefined && outsideWindow > track.outside_window) {
      problems.push(
        `track ${track.mkvmerge_id}: ${outsideWindow} object(s) lie outside their window, ` +
          `${track.outside_window} expected`,
      );
    }
    const classified = classifyEvents(events, bounds, {
      margin: track.margin,
    });
    const offending = classified.filter((c) => c.needsFix).length;
    if (offending > track.expected_offending_after) {
      problems.push(
        `track ${track.mkvmerge_id}: ${offending} event(s) still outside the active area, ` +
          `${track.expected_offending_after} expected`,
      );
    } else {
      checks.push(
        `track ${track.mkvmerge_id}: ${track.events_moved} event(s) moved, ` +
          `${offending} still outside (timing, structure, palettes and bitmaps unchanged)`,
      );
    }
  }

  return { ok: problems.length === 0, checks, problems };
}

// --- the run --------------------------------------------------------------

/** A function, so the compiler does not carry one check's answer to the next. */
function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new CopyAbortedError();
}

async function statInput(path: string): Promise<PreflightInput> {
  try {
    const info = await stat(path);
    return { exists: true, size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0 };
  }
}

async function statOutput(path: string): Promise<OutputState> {
  try {
    const info = await stat(path);
    return { exists: true, size: info.size };
  } catch {
    return { exists: false, size: 0 };
  }
}

/**
 * Free bytes on the volume `path` lives on. A dry run's output root usually does
 * not exist yet, so walk up to the nearest directory that does.
 */
async function freeBytesOn(path: string): Promise<number | undefined> {
  let at = resolve(path);
  for (;;) {
    try {
      const fs = await statfs(at);
      return Number(fs.bsize) * Number(fs.bavail);
    } catch {
      const up = dirname(at);
      if (up === at) return undefined;
      at = up;
    }
  }
}

/** A file's size and mtime for a log record's `stamp`; omitted when unreadable. */
async function stampOf(path: string): Promise<{ stamp?: { size: number; mtimeMs: number } }> {
  try {
    const info = await stat(path);
    return { stamp: { size: info.size, mtimeMs: info.mtimeMs } };
  } catch {
    return {};
  }
}

async function deviceOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).dev;
  } catch {
    return undefined;
  }
}

function emptyResult(
  entry: PlanFileEntry,
  output: string,
  method: FixMethod,
): ApplyFileResult {
  return {
    input: entry.input,
    output,
    relative: entry.relative,
    status: "skipped",
    reason: undefined,
    failureKind: undefined,
    method,
    bytesWritten: 0,
    sha256: undefined,
    verified: false,
    replaced: false,
    inPlace: false,
    resuming: false,
    awaitingVerification: false,
    backup: undefined,
    checks: [],
    elapsedMs: 0,
  };
}

interface RunContext {
  paths: ReturnType<typeof planPaths>;
  plan: PlanFile;
  options: ApplyOptions;
  deps: ApplyDeps;
  log: Logger;
  execute: boolean;
  /** Undefined only for an in-place run. */
  outputRoot: string | undefined;
  duplicates: Set<string>;
  completed: Map<string, ApplyLogEvent>;
  /** Inputs an earlier run moved aside but never swapped back. */
  pending: Map<string, ApplyLogEvent>;
  /** Inputs whose output `revert --in-place` returned to the original bytes. */
  reverted: Map<string, ApplyLogEvent>;
  /** Inputs this tool last wrote in place; see `lastInPlaceWrite`. */
  inPlaceWrites: Map<string, ApplyLogEvent>;
  /** Watches the dates put back this run (`DateWatch`). */
  dateWatch: DateWatch;
}

async function logEvent(
  ctx: RunContext,
  event: ApplyLogEvent,
  options: { sync?: boolean } = {},
): Promise<void> {
  if (!ctx.execute) return;
  await appendApplyLog(ctx.paths.applyLog, event, options);
}

/**
 * Finish a swap an earlier run was killed in the middle of.
 *
 * The log's `backed-up` record plus "the backup is there and the input is not"
 * is the only situation in which the second rename is safe to redo — and doing
 * it is far better than reporting "the input no longer exists".
 *
 * Returns false when nothing was left half-done, i.e. the normal path applies.
 */
async function finishInterruptedReplace(
  ctx: RunContext,
  entry: PlanFileEntry,
  record: ApplyLogEvent,
  method: FixMethod,
  result: ApplyFileResult,
): Promise<boolean> {
  const backup = record.backup;
  const repaired = record.output;
  if (backup === undefined || repaired === undefined) return false;
  if ((await statOutput(entry.input)).exists) return false;
  if (!(await statOutput(backup)).exists) return false;

  const staged = await statOutput(repaired);
  if (!staged.exists) {
    result.status = "failed";
    result.failureKind = "fix";
    result.reason =
      `an earlier run moved ${entry.input} aside to ${backup} but its fixed file ` +
      `(${repaired}) is gone; rename the backup back into place and re-run`;
    ctx.log.error(`failed ${entry.relative}: ${result.reason}`);
    await logEvent(ctx, {
      time: new Date().toISOString(),
      event: "failed",
      input: entry.input,
      output: repaired,
      method,
      reason: result.reason,
    });
    return true;
  }

  if (!ctx.execute) {
    result.status = "would-apply";
    result.bytesWritten = staged.size;
    result.checks.push(
      `an earlier run left ${entry.input} moved aside as ${backup}; ` +
        `${repaired} would be renamed into its place`,
    );
    return true;
  }

  try {
    await rename(repaired, entry.input);
  } catch (err) {
    result.status = "failed";
    result.failureKind = "fix";
    result.reason =
      `an earlier run moved ${entry.input} aside to ${backup}, and its fixed file ` +
      `${repaired} could not be renamed into its place (${errorText(err)}); run again to finish`;
    ctx.log.error(`failed ${entry.relative}: ${result.reason}`);
    return true;
  }
  result.status = "applied";
  result.verified = true;
  result.replaced = true;
  result.backup = backup;
  result.bytesWritten = staged.size;
  result.checks.push(
    `finished an interrupted swap: ${repaired} → ${entry.input} (backup ${backup})`,
  );
  await logEvent(ctx, {
    time: new Date().toISOString(),
    event: "replaced",
    input: entry.input,
    output: entry.input,
    method,
    backup,
    bytes: staged.size,
    ...(await stampOf(entry.input)),
  });
  ctx.log.info(`replaced ${entry.input} (backup ${backup}), finishing an interrupted run`);
  return true;
}

/** Copy + patch + verify one planned file. Never throws; failures are results. */
async function applyOne(
  ctx: RunContext,
  entry: PlanFileEntry,
): Promise<ApplyFileResult> {
  const started = Date.now();
  const method = entry.method ?? ctx.plan.options.method ?? "patch";
  // `applyPlan` only sends an in-place run to `applyInPlaceOne`.
  const outputRoot = ctx.outputRoot ?? "";
  const plannedOutput = outputPathFor(entry, outputRoot);
  // `--replace-original` with the library itself as the output root computes an
  // output path that IS the input. That is exactly the swap-in workflow, so
  // stage the copy beside it instead of refusing: same filesystem, same two
  // atomic renames at the end.
  const staged =
    ctx.options.replaceOriginal === true &&
    resolve(plannedOutput) === resolve(entry.input);
  const output = staged
    ? join(outputRoot, STAGING_DIR, entry.relative)
    : plannedOutput;
  const result = emptyResult(entry, output, method);
  const finish = (): ApplyFileResult => {
    result.elapsedMs = Date.now() - started;
    return result;
  };

  // Resume: a run killed between the two `--replace-original` renames left the
  // original aside and nothing in its place. Finish that before anything else.
  const interrupted = ctx.pending.get(entry.input);
  if (
    interrupted &&
    (await finishInterruptedReplace(ctx, entry, interrupted, method, result))
  ) {
    return finish();
  }

  // Resume: a file finished by an earlier run is left alone.
  const record = ctx.completed.get(entry.input);
  const resume = shouldSkipForResume(record, await statOutput(output), output);
  if (resume.skip) {
    result.status = "skipped";
    result.reason = resume.reason;
    ctx.log.info(`skip ${entry.relative}: ${resume.reason}`);
    return finish();
  }

  const input = await statInput(entry.input);
  const outputState = await statOutput(output);
  const free = await freeBytesOn(outputRoot);
  const backup =
    ctx.options.replaceOriginal === true
      ? `${entry.input}${ctx.options.backupSuffix ?? ".pre-scopefix"}`
      : undefined;
  // A file we wrote and then reverted in place is ours to write over again.
  const revertedRecord = ctx.reverted.get(entry.input);
  const outputWasReverted =
    revertedRecord?.output !== undefined &&
    resolve(revertedRecord.output) === resolve(output);
  const pre = preflightDecision(entry, input, outputState, {
    ...(ctx.options.overwriteOutput === undefined
      ? {}
      : { overwriteOutput: ctx.options.overwriteOutput }),
    ...(free === undefined ? {} : { freeBytes: free }),
    duplicateOutput: ctx.duplicates.has(plannedOutput),
    outputIsInput: resolve(output) === resolve(entry.input),
    outputWasReverted,
    // A file this tool rewrote in place (then reverted) has a new mtime but is
    // still the plan's; the copy checks every patched range's bytes anyway.
    ignoreMtime: ctx.inPlaceWrites.has(entry.input),
    ...(backup === undefined ? {} : { backupExists: (await statOutput(backup)).exists }),
    ...(ctx.options.headroom === undefined ? {} : { headroom: ctx.options.headroom }),
  });
  if (!pre.ok) {
    result.status = pre.kind === "conflict" ? "conflict" : "skipped";
    result.reason = pre.reason;
    ctx.log.warn(`${pre.kind === "conflict" ? "conflict" : "skip"} ${entry.relative}: ${pre.reason}`);
    await logEvent(ctx, {
      time: new Date().toISOString(),
      event: "skipped",
      input: entry.input,
      output,
      method,
      reason: pre.reason,
    });
    return finish();
  }

  if (outputWasReverted && outputState.exists) {
    result.checks.push(
      `${output} was reverted to the original bytes by an earlier run; re-applying over it`,
    );
  }

  if (staged) {
    // Said out loud in both the dry run and the report of a real run: the file
    // is not written where --output-root alone would suggest.
    result.checks.push(
      `--output-root maps this file onto its own path, so it is staged in ` +
        `${join(outputRoot, STAGING_DIR)} (same filesystem) and renamed into place`,
    );
  }

  if (!ctx.execute) {
    result.status = "would-apply";
    result.bytesWritten = entry.size;
    result.checks.push(
      `would write ${formatBytes(entry.size)} to ${output}` +
        (method === "patch"
          ? `, changing ${entry.patch_summary?.bytes_changed ?? 0} byte(s) in ` +
            `${entry.patch_summary?.position_fields ?? 0} position field(s)`
          : " by remuxing with mkvmerge"),
    );
    if (backup !== undefined) {
      result.checks.push(`would then replace ${entry.input}, keeping it as ${backup}`);
    }
    return finish();
  }

  // The tool's own name, so a leftover one is ours to remove and nobody else's
  // file ever is.
  const partial = partialPathFor(output);

  try {
    // Inside the `try`: an output folder that cannot be made (a file in the
    // way, no permission, a volume that is not there) fails this title, not
    // the run.
    await mkdir(dirname(output), { recursive: true });
    await rm(partial, { force: true });
    await logEvent(ctx, {
      time: new Date().toISOString(),
      event: "started",
      input: entry.input,
      output,
      method,
      bytes: entry.size,
    });

    if (method === "patch") {
      if (entry.patchFile === undefined) {
        throw new ApplyError(`${entry.input}: the plan has no patch file`);
      }
      const patchFile = await readPatchFile(ctx.paths.dir, entry.patchFile);
      const patches = decodePatches(patchFile.patches);

      let lastPercent = -1;
      const copy = await copyWithPatches(entry.input, partial, patches, {
        ...(ctx.options.chunkSize === undefined
          ? {}
          : { chunkSize: ctx.options.chunkSize }),
        expectedSize: entry.size,
        ...(ctx.deps.signal === undefined ? {} : { signal: ctx.deps.signal }),
        onProgress: (done, total) => {
          ctx.deps.onProgress?.({
            type: "file-progress",
            input: entry.input,
            phase: "copy",
            done,
            total,
          });
          const percent = Math.floor((done / total) * 10) * 10;
          if (percent !== lastPercent) {
            lastPercent = percent;
            ctx.log.debug(`  ${entry.relative}: ${percent}%`);
          }
        },
      });
      result.bytesWritten = copy.bytesWritten;
      result.sha256 = copy.sha256;
      result.checks.push(
        `copied ${formatBytes(copy.bytesWritten)}, applied ${copy.patchesApplied} patch(es), ` +
          `${copy.bytesChanged} byte(s) changed`,
      );

      // Read the finished file back and hash it: proves the copy landed.
      throwIfCancelled(ctx.deps.signal);
      ctx.deps.onProgress?.({ type: "file-progress", input: entry.input, phase: "read-back" });
      const readBack = await hashFileChunked(
        partial,
        ctx.options.chunkSize ?? DEFAULT_CHUNK_SIZE,
        ctx.deps.signal,
      );
      if (readBack.sha256 !== copy.sha256 || readBack.bytes !== copy.bytesWritten) {
        throw new ApplyFailure(
          `the written file does not match what was written ` +
            `(${copy.bytesWritten} bytes / ${copy.sha256.slice(0, 16)} → ` +
            `${readBack.bytes} bytes / ${readBack.sha256.slice(0, 16)})`,
          "verification",
        );
      }
      result.checks.push(`read back ${formatBytes(readBack.bytes)}, sha256 matches`);

      throwIfCancelled(ctx.deps.signal);
      await rename(partial, output);
      ctx.deps.onProgress?.({ type: "file-progress", input: entry.input, phase: "verify" });

      // From here on the output exists at its final path, so every failure —
      // including one thrown out of the verification itself (MkvError,
      // EbmlError, PgsParseError while re-reading the file) — has to take the
      // output with it. A half-good file must never be left where a verified
      // one belongs.
      try {
        const verify = ctx.deps.verifyOutput ?? verifyPatchedOutput;
        const verification = await verify(output, patchFile, ctx.deps.signal);
        // A check that was cancelled is not a check, whatever it returned.
        throwIfCancelled(ctx.deps.signal);
        result.checks.push(...verification.checks);
        if (!verification.ok) {
          throw new ApplyFailure(
            `PGS verification failed: ${verification.problems.join("; ")}`,
            "verification",
          );
        }
      } catch (err) {
        await rm(output, { force: true });
        if (err instanceof ApplyFailure || err instanceof CopyAbortedError) throw err;
        if (ctx.deps.signal?.aborted === true) throw new CopyAbortedError();
        throw new ApplyFailure(
          `the output could not be verified: ${err instanceof Error ? err.message : String(err)}`,
          "verification",
        );
      }
    } else {
      const fixResult = await fixFile(
        entry.input,
        {
          aspect: ctx.plan.options.aspect,
          ...(ctx.plan.options.margin === undefined
            ? {}
            : { margin: ctx.plan.options.margin }),
          method: "remux",
          output: partial,
          overwriteOutput: true,
        },
        {
          log: ctx.log,
          ...(ctx.deps.signal === undefined ? {} : { signal: ctx.deps.signal }),
          onPhase: (phase) =>
            ctx.deps.onProgress?.({ type: "file-progress", input: entry.input, phase }),
          ...(ctx.deps.mkvmergePath === undefined
            ? {}
            : { mkvmergePath: ctx.deps.mkvmergePath }),
          ...(ctx.deps.mkvextractPath === undefined
            ? {}
            : { mkvextractPath: ctx.deps.mkvextractPath }),
        },
      );
      if (!fixResult.wrote) {
        throw new ApplyFailure(
          "the remux produced no output: the analysis at apply time found nothing to move",
          "fix",
        );
      }
      result.checks.push(
        `remuxed ${fixResult.totals.tracksFixed} track(s), ` +
          `${fixResult.totals.eventsMoved} event(s) moved`,
      );

      throwIfCancelled(ctx.deps.signal);
      ctx.deps.onProgress?.({ type: "file-progress", input: entry.input, phase: "verify" });
      const report = await verifyFile(
        entry.input,
        partial,
        {
          aspect: ctx.plan.options.aspect,
          ...(ctx.plan.options.margin === undefined
            ? {}
            : { margin: ctx.plan.options.margin }),
          hashStreams: true,
        },
        {
          log: ctx.log,
          ...(ctx.deps.signal === undefined ? {} : { signal: ctx.deps.signal }),
          ...(ctx.deps.mkvmergePath === undefined
            ? {}
            : { mkvmergePath: ctx.deps.mkvmergePath }),
          ...(ctx.deps.mkvextractPath === undefined
            ? {}
            : { mkvextractPath: ctx.deps.mkvextractPath }),
        },
      );
      for (const c of report.checks) {
        if (c.pass) continue;
        result.checks.push(`FAIL ${c.name}: ${c.detail}`);
      }
      if (!report.pass) {
        await rm(partial, { force: true });
        throw new ApplyFailure(
          `verification failed: ${report.checks
            .filter((c) => !c.pass)
            .map((c) => c.name)
            .join(", ")}`,
          "verification",
        );
      }
      throwIfCancelled(ctx.deps.signal);
      const written = await statOutput(partial);
      const hashed = await hashFileChunked(partial, DEFAULT_CHUNK_SIZE, ctx.deps.signal);
      result.bytesWritten = written.size;
      result.sha256 = hashed.sha256;
      result.checks.push(
        `verified against the original (${report.payloadMode}), ${formatBytes(written.size)}`,
      );
      await rename(partial, output);
    }

    result.status = "applied";
    result.verified = true;
    await logEvent(ctx, {
      time: new Date().toISOString(),
      event: "verified",
      input: entry.input,
      output,
      method,
      bytes: result.bytesWritten,
      ...(entry.patch_summary === undefined
        ? {}
        : { bytesChanged: entry.patch_summary.bytes_changed }),
      ...(result.sha256 === undefined ? {} : { sha256: result.sha256 }),
      durationMs: Date.now() - started,
    });
    ctx.log.info(`applied ${entry.relative} → ${output}`);

    if (backup !== undefined) {
      // The swap. Whichever step fails, the verified copy must not be left at
      // `output` with nothing to say what it is: the `failed` record below
      // clears its `verified` one, and the next run would then find "an output
      // in the way". So a failed swap either undoes itself completely
      // (original in place, copy removed: the next run simply starts over) or
      // is left exactly as a killed run leaves it, for the next run to finish.
      try {
        if ((await statOutput(backup)).exists) {
          throw new Error(`the backup path ${backup} already exists`);
        }
        await rename(entry.input, backup);
      } catch (err) {
        await rm(output, { force: true });
        throw new ApplyFailure(
          `the original could not be moved aside (${errorText(err)}); it was not ` +
            "modified, and the verified copy was removed",
          "fix",
        );
      }
      // Journalled between the two renames: if the process dies here, the input
      // is missing and the backup exists, and only this record says why.
      let swapError: unknown;
      try {
        await logEvent(ctx, {
          time: new Date().toISOString(),
          event: "backed-up",
          input: entry.input,
          output,
          method,
          backup,
          bytes: result.bytesWritten,
        });
        await rename(output, entry.input);
      } catch (err) {
        swapError = err;
      }
      if (swapError !== undefined) {
        let putBack = false;
        try {
          // Only into an empty place: never over whatever is there now.
          if (!(await statOutput(entry.input)).exists) {
            await rename(backup, entry.input);
            putBack = true;
          }
        } catch {
          putBack = false;
        }
        if (putBack) {
          await rm(output, { force: true });
          throw new ApplyFailure(
            `the fixed file could not be moved into place (${errorText(swapError)}); the ` +
              "original was restored, and the verified copy was removed",
            "fix",
          );
        }
        // Neither way worked. No `failed` record: the `backed-up` one must
        // stand, so the next run finishes the swap (`finishInterruptedReplace`).
        result.status = "failed";
        result.failureKind = "fix";
        result.verified = false;
        result.reason =
          `the fixed file could not be moved into place (${errorText(swapError)}), and the ` +
          `original could not be restored either: it is at ${backup} and the fixed ` +
          `file at ${output}. Run the same command again to finish the swap`;
        ctx.log.error(`failed ${entry.relative}: ${result.reason}`);
        return finish();
      }
      result.replaced = true;
      result.backup = backup;
      result.checks.push(`original moved to ${backup}, fixed file moved into its place`);
      await logEvent(ctx, {
        time: new Date().toISOString(),
        event: "replaced",
        input: entry.input,
        output: entry.input,
        method,
        backup,
        bytes: result.bytesWritten,
        ...(result.sha256 === undefined ? {} : { sha256: result.sha256 }),
        ...(await stampOf(entry.input)),
        durationMs: Date.now() - started,
      });
      ctx.log.info(`replaced ${entry.input} (backup ${backup})`);
    }
  } catch (err) {
    // Best effort: where the folder itself could not be made there is nothing
    // to remove, and the attempt must not turn this title's failure into the run's.
    await rm(partial, { force: true }).catch(() => undefined);
    // A remux that was cancelled fails wherever the signal caught it (a killed
    // mkvextract, an abandoned analysis); say what happened, not how it showed.
    const cancelled =
      ctx.deps.signal?.aborted === true &&
      (method === "remux" || err instanceof CopyAbortedError);
    const message = withInUseHint(
      err,
      cancelled
        ? "cancelled"
        : err instanceof FixError
          ? `${err.message}${err.detail ? ` (${err.detail})` : ""}`
          : err instanceof Error
            ? err.message
            : String(err),
    );
    result.status = "failed";
    result.reason = message;
    // A `before` mismatch means the file is not what the plan described, which
    // is a validation failure; everything else is a failed repair.
    result.failureKind =
      err instanceof ApplyFailure
        ? err.kind
        : err instanceof PatchVerifyError
          ? "verification"
          : "fix";
    result.verified = false;
    ctx.log.error(`failed ${entry.relative}: ${message}`);
    await logEvent(ctx, {
      time: new Date().toISOString(),
      event: "failed",
      input: entry.input,
      output,
      method,
      reason: message,
      durationMs: Date.now() - started,
    });
  }

  return finish();
}

/** Only the ranges the plan actually changes; an unchanged range says nothing. */
function changingPatches(patches: readonly BytePatch[]): BytePatch[] {
  return patches.filter((p) => countChangedBytes([p]) > 0);
}

/** An error's message, plus the "in use" hint where Windows refused a file another program holds. */
function errorText(err: unknown): string {
  return withInUseHint(err, err instanceof Error ? err.message : String(err));
}

/**
 * `--dangerously-in-place` for one planned file: scan, write, read back,
 * verify — into the input itself. Never throws; failures are results.
 *
 * Order matters. Every range is checked before the first write, so a file that
 * is not what the plan describes is refused untouched. The `started` record is
 * written just before the first byte, so a run killed mid-write is recognised
 * (`lastInPlaceWrite`) and finished by the next one. A verification failure puts
 * the original bytes straight back, so a file that did not verify is never left
 * repaired-but-wrong.
 */
async function applyInPlaceOne(
  ctx: RunContext,
  entry: PlanFileEntry,
): Promise<ApplyFileResult> {
  const started = Date.now();
  const method = entry.method ?? ctx.plan.options.method ?? "patch";
  const result = emptyResult(entry, entry.input, method);
  result.inPlace = true;
  const finish = (): ApplyFileResult => {
    result.elapsedMs = Date.now() - started;
    return result;
  };
  const skip = (reason: string): ApplyFileResult => {
    result.status = "skipped";
    result.reason = reason;
    ctx.log.info(`skip ${entry.relative}: ${reason}`);
    return finish();
  };

  // Only a record that says the input *itself* holds the repair counts here; a
  // copy-mode `verified` output elsewhere leaves the input as it was.
  const record = ctx.completed.get(entry.input);
  if (record !== undefined && (record.event === "patched" || record.event === "replaced")) {
    return skip(shouldSkipForResume(record, null).reason ?? "already applied by an earlier run");
  }
  if (ctx.pending.has(entry.input)) {
    return skip(
      "an earlier --replace-original run left this file mid-swap; finish it with " +
        "that run's --output-root and --replace-original",
    );
  }

  const input = await statInput(entry.input);
  const resumable = ctx.inPlaceWrites.has(entry.input);
  const pre = preflightDecision(entry, input, null, { ignoreMtime: resumable });
  if (!pre.ok) {
    result.status = pre.kind === "conflict" ? "conflict" : "skipped";
    result.reason = pre.reason;
    ctx.log.warn(`skip ${entry.relative}: ${pre.reason}`);
    await logEvent(ctx, {
      time: new Date().toISOString(),
      event: "skipped",
      input: entry.input,
      output: entry.input,
      method,
      reason: pre.reason,
      inPlace: true,
    });
    return finish();
  }
  if (method !== "patch" || entry.patchFile === undefined) {
    return skip(
      "--dangerously-in-place needs a patch-method entry with a patch file; " +
        "this one was planned for remux",
    );
  }

  // From here on anything thrown is this file's failure, never the run's.
  let written = false;
  try {
    const patchFile = await readPatchFile(ctx.paths.dir, entry.patchFile);
    const patches = decodePatches(patchFile.patches);
    const changing = changingPatches(patches);
    const bytesChanged = countChangedBytes(changing);

    const scan = await scanPatchState(entry.input, changing);
    // The entry's size, not the patch file's: the pre-flight has already held
    // the input to it, and the patch file's is the size of the *repaired* file
    // wherever that is — a copy elsewhere keeps its size when the input's
    // headers are edited (`adopt` in plan.ts). The byte scan is what proves
    // the patch file fits this input.
    const decision = decideInPlace({
      size: input.size,
      expectedSize: entry.size,
      scan,
      resumable,
    });
    if (decision.kind === "skip") return skip(decision.reason);
    if (decision.kind === "refuse") {
      throw new ApplyFailure(decision.reason, "verification");
    }
    result.resuming = decision.resume && scan.original > 0;
    // Every byte written, the run killed before its `patched` record — during
    // the verification, which is the long part. Finishing it writes nothing
    // new; it verifies, and puts the original back if that fails.
    result.awaitingVerification = decision.resume && scan.original === 0;
    result.checks.push(
      decision.resume
        ? `${scan.fixed} of ${scan.total} patched range(s) already hold the fixed bytes ` +
            "from an interrupted in-place run; finishing it"
        : `all ${scan.total} patched range(s) hold the original bytes the plan recorded`,
    );

    if (!ctx.execute) {
      result.status = "would-apply";
      result.checks.push(
        `would write ${bytesChanged} byte(s) in ${entry.patch_summary?.position_fields ?? changing.length} ` +
          `position field(s) into ${entry.input} itself — no copy, no backup`,
      );
      result.checks.push(
        ctx.options.skipVerify === true
          ? "would not verify the PGS afterwards (--skip-verify)"
          : "would then re-read the PGS tracks and verify them against the plan",
      );
      return finish();
    }

    // Before the `started` record: a read-only mount must fail here, cleanly,
    // not after a record that says a write began.
    try {
      await access(entry.input, fsConstants.W_OK);
    } catch (err) {
      throw new ApplyFailure(
        `${entry.input} cannot be written (${errorText(err)}); check that the library is not mounted read-only`,
        "fix",
      );
    }
    // The date to put back afterwards (`preserveDates`): the one an
    // interrupted write of this file already promised, else the file's own.
    const keepMtimeMs =
      ctx.options.preserveDates === true
        ? dateToKeep(ctx.inPlaceWrites.get(entry.input), input.mtimeMs)
        : undefined;
    const putDateBack = async (): Promise<void> => {
      if (keepMtimeMs === undefined) return;
      const problem = await keepDate(entry.input, keepMtimeMs);
      // Watched from here on, while the run goes on (`DateWatch`).
      ctx.dateWatch.add(entry.input, keepMtimeMs, Date.now(), problem);
      if (problem === undefined) {
        result.checks.push(`preserved the file's date (${new Date(keepMtimeMs).toISOString()})`);
      } else {
        result.checks.push(`the file's date could not be preserved: ${problem}`);
        ctx.log.warn(`${entry.relative}: date could not be preserved: ${problem}`);
      }
    };
    // Synced: this record is all that lets a half-written file be finished,
    // so it must be on disk before the first byte of the file changes.
    await logEvent(
      ctx,
      {
        time: new Date().toISOString(),
        event: "started",
        input: entry.input,
        output: entry.input,
        method,
        bytes: entry.size,
        inPlace: true,
        ...(keepMtimeMs === undefined ? {} : { keepMtimeMs }),
      },
      { sync: true },
    );
    written = true;
    try {
      const write = await writePatchesInPlace(entry.input, patches);
      result.bytesWritten = write.bytesChanged;
      result.checks.push(
        `wrote and read back ${write.patchesWritten} range(s) in place, ` +
          `${write.bytesChanged} byte(s) changed`,
      );
    } catch (err) {
      throw new ApplyFailure(
        `the in-place write did not complete: ${errorText(err)}. The file may be ` +
          "partially modified; re-run apply --dangerously-in-place to finish it (revert " +
          "refuses a partially modified file)",
        err instanceof RevertError && err.exitCode === APPLY_EXIT.VALIDATION_FAILURE
          ? "verification"
          : "fix",
      );
    }

    if (ctx.options.skipVerify === true) {
      result.checks.push("PGS not verified (--skip-verify)");
    } else {
      let problem: string | undefined;
      try {
        const verify = ctx.deps.verifyOutput ?? verifyPatchedOutput;
        const verification = await verify(entry.input, patchFile);
        result.checks.push(...verification.checks);
        if (!verification.ok) {
          problem = `PGS verification failed: ${verification.problems.join("; ")}`;
        }
      } catch (err) {
        problem = `the patched file could not be verified: ${errorText(err)}`;
      }
      if (problem !== undefined) {
        // Put the original bytes back rather than leave a file that did not
        // verify. Every range is known to hold `after` now, so the inverse is
        // exactly the undo `revert --in-place` would write.
        try {
          await writePatchesInPlace(entry.input, invertPatches(patches));
        } catch (err) {
          throw new ApplyFailure(
            `${problem}; restoring the original bytes failed too: ${errorText(err)}. ` +
              `Revert it with scope-sub revert --patch-file ${join(ctx.paths.dir, entry.patchFile)} ` +
              `--target "${entry.input}" --in-place --execute`,
            "verification",
          );
        }
        result.checks.push(`${problem}; the original bytes were restored`);
        await putDateBack();
        await logEvent(ctx, {
          time: new Date().toISOString(),
          event: "reverted",
          input: entry.input,
          output: entry.input,
          method,
          patches: patches.length,
          bytesChanged,
          reason: problem,
          ...(keepMtimeMs === undefined ? {} : { keepMtimeMs }),
          ...(await stampOf(entry.input)),
          durationMs: Date.now() - started,
        });
        throw new ApplyFailure(`${problem}; the original bytes were restored`, "verification");
      }
      result.verified = true;
    }

    result.status = "applied";
    await putDateBack();
    await logEvent(ctx, {
      time: new Date().toISOString(),
      event: "patched",
      input: entry.input,
      output: entry.input,
      method,
      bytes: entry.size,
      bytesChanged,
      patches: patches.length,
      pgsVerified: result.verified,
      inPlace: true,
      ...(keepMtimeMs === undefined ? {} : { keepMtimeMs }),
      ...(await stampOf(entry.input)),
      durationMs: Date.now() - started,
    });
    ctx.log.info(`patched ${entry.relative} in place`);
  } catch (err) {
    result.status = "failed";
    result.reason = errorText(err);
    result.failureKind = err instanceof ApplyFailure ? err.kind : "fix";
    result.verified = false;
    ctx.log.error(`failed ${entry.relative}: ${result.reason}`);
    await logEvent(ctx, {
      time: new Date().toISOString(),
      event: "failed",
      input: entry.input,
      output: entry.input,
      method,
      reason: result.reason,
      inPlace: written,
      durationMs: Date.now() - started,
    });
  }
  return finish();
}

function summarize(files: readonly ApplyFileResult[]): ApplySummary {
  const summary: ApplySummary = {
    planned: files.length,
    applied: 0,
    verified: 0,
    skipped: 0,
    failed: 0,
    conflicts: 0,
    bytesWritten: 0,
  };
  for (const f of files) {
    switch (f.status) {
      case "applied":
        summary.applied++;
        summary.bytesWritten += f.bytesWritten;
        break;
      case "would-apply":
        summary.applied++;
        break;
      case "skipped":
        summary.skipped++;
        break;
      case "failed":
        summary.failed++;
        break;
      case "conflict":
        summary.conflicts++;
        break;
    }
    if (f.verified) summary.verified++;
  }
  return summary;
}

/**
 * PRD §20: a wrong output (7) outranks a repair that never happened (6), which
 * outranks a file that was refused before anything was written (8).
 */
export function applyExitCode(files: readonly ApplyFileResult[]): number {
  const failures = files.filter((f) => f.status === "failed");
  if (failures.some((f) => f.failureKind === "verification")) {
    return APPLY_EXIT.VALIDATION_FAILURE;
  }
  if (failures.length > 0) return APPLY_EXIT.FIX_FAILURE;
  if (files.some((f) => f.status === "conflict")) return APPLY_EXIT.OUTPUT_CONFLICT;
  return APPLY_EXIT.OK;
}

/** Outputs claimed by more than one planned file. */
export function duplicateOutputs(
  entries: readonly PlanFileEntry[],
  outputRoot: string,
): Set<string> {
  const seen = new Map<string, number>();
  for (const entry of entries) {
    if (entry.action !== "fix") continue;
    const path = outputPathFor(entry, outputRoot);
    seen.set(path, (seen.get(path) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([path]) => path));
}

/** Execute (or rehearse) a plan directory. */
export async function applyPlan(
  dir: string,
  options: ApplyOptions,
  deps: ApplyDeps = {},
): Promise<ApplyRunResult> {
  const started = Date.now();
  const log = deps.log ?? silentLogger;
  const planDir = resolve(dir);
  const paths = planPaths(planDir);
  const plan = await requirePlan(planDir);
  const execute = options.execute === true;
  const inPlace = options.inPlace === true;

  if (inPlace) {
    if (options.outputRoot !== undefined) {
      throw new ApplyError(
        "--dangerously-in-place modifies the original files; it does not take --output-root",
      );
    }
    if (options.replaceOriginal === true) {
      throw new ApplyError("--dangerously-in-place and --replace-original cannot be combined; pass one");
    }
    if (options.overwriteOutput === true) {
      throw new ApplyError("--overwrite-output does not apply to --dangerously-in-place (no output files are written)");
    }
  } else {
    if (options.outputRoot === undefined) {
      throw new ApplyError(
        "--output-root <dir> is required (or --dangerously-in-place, to modify the original files)",
      );
    }
    if (options.skipVerify === true) {
      throw new ApplyError("--skip-verify only applies to --dangerously-in-place; a copy is always verified");
    }
  }
  if (options.replaceOriginal === true && !execute) {
    throw new ApplyError("--replace-original requires --execute");
  }

  const outputRoot = options.outputRoot === undefined ? undefined : resolve(options.outputRoot);
  const only = options.only === undefined ? undefined : new Set(options.only.map((p) => resolve(p)));
  const planned = plan.files.filter(
    (f) => f.action === "fix" && (only === undefined || only.has(resolve(f.input))),
  );

  let duplicates = new Set<string>();
  if (outputRoot !== undefined) {
    if (execute) await mkdir(outputRoot, { recursive: true });

    // `--replace-original` finishes with two renames, which only work inside one
    // filesystem. Refuse up front rather than after copying 40 GB.
    if (options.replaceOriginal === true) {
      const rootDev = await deviceOf(outputRoot);
      for (const entry of planned) {
        const dev = await deviceOf(dirname(entry.input));
        if (rootDev !== undefined && dev !== undefined && rootDev !== dev) {
          throw new ApplyError(
            `--replace-original needs --output-root on the same filesystem as the inputs; ` +
              `${outputRoot} and ${dirname(entry.input)} are on different volumes`,
          );
        }
      }
    }

    duplicates = duplicateOutputs(plan.files, outputRoot);
    if (duplicates.size > 0) {
      log.warn(
        `${duplicates.size} output path(s) are claimed by more than one planned file; ` +
          "those files are refused (re-plan with --recursive to mirror the tree)",
      );
    }
  }

  const logged = await readApplyLog(paths.applyLog);
  const completed = completedByInput(logged);
  const pending = pendingReplacements(logged);
  const reverted = revertedByInput(logged);
  const ctx: RunContext = {
    paths,
    plan,
    options,
    deps,
    log,
    execute,
    outputRoot,
    duplicates,
    completed,
    pending,
    reverted,
    inPlaceWrites: lastInPlaceWrite(logged),
    dateWatch:
      deps.dateWatch ??
      new DateWatch({
        ...(options.dateSettleMs === undefined ? {} : { windowMs: options.dateSettleMs }),
        log,
      }),
  };

  if (inPlace) {
    log.info(
      `${execute ? "patching" : "DRY RUN of patching"} ${planned.length} planned file(s) ` +
        "in place: no copies, no backups",
    );
    if (execute) {
      log.warn(
        `--dangerously-in-place: original files are being modified; ${planDir} ` +
          "is the only undo data for them — keep it",
      );
    }
  } else {
    log.info(
      `${execute ? "applying" : "DRY RUN of"} ${planned.length} planned file(s) into ${outputRoot}`,
    );
  }

  const results: ApplyFileResult[] = [];
  const jobs = Math.max(1, Math.floor(options.jobs ?? 1));
  let next = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped || deps.signal?.aborted === true) return;
      const i = next++;
      if (i >= planned.length) return;
      const entry = planned[i]!;
      deps.onProgress?.({
        type: "file-start",
        index: i,
        total: planned.length,
        input: entry.input,
        relative: entry.relative,
      });
      const result = inPlace
        ? await applyInPlaceOne(ctx, entry)
        : await applyOne(ctx, entry);
      results.push(result);
      deps.onProgress?.({ type: "file-done", index: i, total: planned.length, result });
      if (
        options.stopOnError === true &&
        (result.status === "failed" || result.status === "conflict")
      ) {
        stopped = true;
        log.error("stopping: --stop-on-error");
        return;
      }
    }
  };
  // The run's own watch is waited for however the run ends: a watch left
  // running would hold the process open with nothing said. The caller's
  // watch is the caller's to wait for.
  const settleOwnWatch = async (): Promise<void> => {
    if (deps.dateWatch !== undefined) return;
    for (const { path, problem } of await ctx.dateWatch.settle(deps.signal)) {
      log.warn(`${path}: date could not be preserved: ${problem}`);
      // Already said on the file when it is `keepDate`'s own problem.
      const checks = results.find((r) => resolve(r.input) === resolve(path))?.checks;
      if (checks?.some((c) => c.endsWith(problem)) === false) {
        checks.push(`the file's date could not be preserved: ${problem}`);
      }
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(jobs, planned.length)) }, worker),
    );
  } catch (err) {
    await settleOwnWatch();
    throw err;
  }

  // The staging directory only ever holds a file mid-swap; drop it when empty.
  if (execute && options.replaceOriginal === true && outputRoot !== undefined) {
    await rmdir(join(outputRoot, STAGING_DIR)).catch(() => undefined);
  }

  await settleOwnWatch();

  results.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));

  return {
    dir: planDir,
    outputRoot,
    execute,
    inPlace,
    files: results,
    summary: summarize(results),
    exitCode: applyExitCode(results),
    elapsedMs: Date.now() - started,
    ...(deps.signal?.aborted === true ? { cancelled: true as const } : {}),
  };
}
