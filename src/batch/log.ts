/**
 * The apply transaction log (PRD §17.3).
 *
 * One JSON object per line, appended as each file reaches a decision point.
 * It is the record of what a batch run actually did — and it is what makes
 * `apply` resumable: a rerun skips any file that already has a `verified` record
 * whose output is still on disk at the recorded size, or a `replaced` or
 * `patched` one.
 */
import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FixMethod } from "../fix/types.js";

export type ApplyEventKind =
  | "started"
  | "skipped"
  | "failed"
  /** The original was renamed aside; the repaired file is not in place yet. */
  | "backed-up"
  | "verified"
  | "replaced"
  /** `apply --dangerously-in-place` wrote the repair into the input itself. */
  | "patched"
  /**
   * `plan` found a different file at a path it had repaired (another size: a
   * patch never changes one) and started that path afresh. Everything the log
   * said about the path before this record is history.
   */
  | "superseded"
  /** `revert` put the original bytes back. See `revertedTo`. */
  | "reverted";

export interface ApplyLogEvent {
  time: string;
  event: ApplyEventKind;
  /** Absolute path of the input MKV; the key everything is grouped by. */
  input: string;
  output?: string;
  method?: FixMethod;
  reason?: string;
  bytes?: number;
  bytesChanged?: number;
  sha256?: string;
  /** Where the original was moved to by --replace-original. */
  backup?: string;
  /**
   * `reverted` only: where the reverted copy was written. Absent for an
   * in-place revert, which is what tells `apply` the repair is gone — a copy
   * leaves the repaired file exactly where it was.
   */
  revertedTo?: string;
  patches?: number;
  durationMs?: number;
  /**
   * Set on the `started`, `patched` and `failed` records of an
   * `apply --dangerously-in-place` run: the bytes were (or were about to be)
   * written into `input` itself.
   */
  inPlace?: boolean;
  /** `patched` only: false when `--skip-verify` left the PGS check out. */
  pgsVerified?: boolean;
  /**
   * On a record that wrote the input's own path (`patched`, `replaced`, an
   * in-place `reverted`): the file's size and mtime right after the write.
   * It is how `plan` tells its own change from someone else's.
   */
  stamp?: { size: number; mtimeMs: number };
  /**
   * On the records of an in-place write made with `preserveDates`: the
   * modification time to put back (`started`), or that was put back
   * (`patched`, `reverted`). Logged before the first byte because the file's
   * own date is gone from then on and a killed run is finished by another
   * one; and on the finishing record because a share may still replace the
   * date afterwards, and the next write has to know which one was meant
   * (`dateToKeep`).
   */
  keepMtimeMs?: number;
}

export async function appendApplyLog(
  path: string,
  event: ApplyLogEvent,
  options: { sync?: boolean } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const line = `${JSON.stringify(event)}\n`;
  if (options.sync !== true) {
    await appendFile(path, line, "utf8");
    return;
  }
  // `sync`: the record must be on disk before the caller goes on. An in-place
  // write's `started` record is the only thing that lets a half-written file
  // be finished, so it may not sit in a cache while the file itself (often on
  // another machine) is already being changed.
  const handle = await open(path, "a");
  try {
    await handle.appendFile(line, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  // The directory entry too, for a log this record created. Not every
  // filesystem lets a directory be opened or synced; the record itself is
  // already safe, so a refusal here is not a failure. Windows cannot open a
  // directory as a file at all (EISDIR), and its rename is durable without it.
  if (process.platform === "win32") return;
  try {
    const dir = await open(dirname(path), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // best effort
  }
}

/**
 * Read the log. A half-written final line (a killed run) is ignored rather
 * than fatal: the point of the log is to survive being interrupted.
 */
export async function readApplyLog(path: string): Promise<ApplyLogEvent[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const events: ApplyLogEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const value = JSON.parse(trimmed) as ApplyLogEvent;
      if (typeof value.input === "string" && typeof value.event === "string") {
        events.push(value);
      }
    } catch {
      // A truncated last line; everything before it still counts.
    }
  }
  return events;
}

/** Whether a record is about the very file a completion vouches for. */
function sameOutput(completion: ApplyLogEvent | undefined, event: ApplyLogEvent): boolean {
  if (completion === undefined) return false;
  // A record that names no output cannot be told apart: it counts, as it
  // always did. A completion without one is about the input itself.
  if (event.output === undefined) return true;
  return resolve(completion.output ?? completion.input) === resolve(event.output);
}

function isCompletion(event: ApplyLogEvent): boolean {
  return event.event === "verified" || event.event === "replaced" || event.event === "patched";
}

/**
 * An in-place write to the input's own path: `apply --dangerously-in-place`'s
 * `started` and `patched`, `revert --in-place`'s `started` (`reason: "revert"`)
 * and `reverted`. A `revert --in-place` of a copy elsewhere writes that copy,
 * not the input, and does not count.
 */
function writesInputInPlace(event: ApplyLogEvent): boolean {
  return writesInputAtOwnPath(event);
}

/** `writesInputInPlace`, for `dates.ts`: an in-place write of the input's own path. */
export function writesInputAtOwnPath(event: ApplyLogEvent): boolean {
  const own = event.output === undefined || event.output === event.input;
  if (!own) return false;
  if (event.event === "started") return event.inPlace === true;
  if (event.event === "patched") return true;
  return event.event === "reverted" && event.revertedTo === undefined;
}

/**
 * The last completion record (`verified`, `replaced` or `patched`) per input
 * path.
 *
 * A `failed` record clears it only when it is about the same output: a failed
 * attempt at one place (the input in place, another output folder) says nothing
 * about a verified copy somewhere else. An in-place `reverted` clears it: the
 * repaired file is the original again, so
 * that input is no longer applied and `apply` may do it over. A revert that
 * wrote a *copy* elsewhere (`revertedTo` set) leaves the repaired file where it
 * was, so the completion still stands. So does an in-place `started` over the
 * very file the completion vouches for: from that moment the file is being
 * rewritten and may be half one thing and half the other (`unfinishedInPlace`
 * is how the run that was writing it is found again). `superseded` — a
 * different file now at the path — clears everything.
 */
export function completedByInput(
  events: readonly ApplyLogEvent[],
): Map<string, ApplyLogEvent> {
  const done = new Map<string, ApplyLogEvent>();
  for (const event of events) {
    if (isCompletion(event)) {
      done.set(event.input, event);
    } else if (event.event === "superseded") {
      done.delete(event.input);
    } else if (event.event === "failed") {
      // A later failure invalidates an earlier success for the same output.
      if (sameOutput(done.get(event.input), event)) done.delete(event.input);
    } else if (event.event === "reverted" && event.revertedTo === undefined) {
      done.delete(event.input);
    } else if (
      event.event === "started" &&
      event.inPlace === true &&
      done.get(event.input)?.output === event.output
    ) {
      done.delete(event.input);
    }
  }
  return done;
}

/**
 * In-place writes that began and never finished, per input: the `started`
 * record (its `output` is the file being written) with no `patched`, in-place
 * `reverted` or `superseded` after it. A `failed` record does not finish one —
 * a write that failed part-way may have left the file half written, which is
 * exactly the state these runs must be allowed to finish.
 */
export function unfinishedInPlace(
  events: readonly ApplyLogEvent[],
): Map<string, ApplyLogEvent> {
  const open = new Map<string, ApplyLogEvent>();
  for (const event of events) {
    if (event.event === "started" && event.inPlace === true) open.set(event.input, event);
    else if (
      event.event === "patched" ||
      event.event === "superseded" ||
      (event.event === "reverted" && event.revertedTo === undefined)
    ) {
      open.delete(event.input);
    }
  }
  return open;
}

/**
 * Inputs whose repaired file was reverted in place and not re-applied since.
 *
 * `apply` uses it to recognise its own output: a file it wrote and then put
 * back is not the "someone else's file is in the way" that `--overwrite-output`
 * exists to guard, so re-applying over it needs no extra flag.
 */
export function revertedByInput(
  events: readonly ApplyLogEvent[],
): Map<string, ApplyLogEvent> {
  const reverted = new Map<string, ApplyLogEvent>();
  for (const event of events) {
    if (event.event === "reverted" && event.revertedTo === undefined) {
      reverted.set(event.input, event);
    } else if (isCompletion(event) || event.event === "superseded") {
      reverted.delete(event.input);
    }
  }
  return reverted;
}

/**
 * Inputs whose bytes this tool itself last wrote in place: an
 * `apply --dangerously-in-place` that started (and perhaps never finished) or
 * patched it, or a `revert --in-place` of the input's own path (started or
 * finished).
 *
 * Only those writes change an input's mtime without changing what the plan says
 * about it, so for these inputs — and only these — `apply` lets the byte scan
 * stand in for the plan's size-and-mtime stamp. That is what lets a killed
 * in-place run be finished, and a reverted one be patched again.
 *
 * Only records that change what is at the input's own path count. An in-place
 * write sets it; `--replace-original`'s renames (`backed-up`, `replaced`) put
 * another file at that path, and `superseded` says a different file is there
 * now, so those clear it. Everything else — a copy-mode `started` or
 * `verified`, a revert of a copy elsewhere, a `skipped` refusal, a `failed`
 * record (which may follow an in-place `started` that left the file half
 * patched: that `started` is exactly what must be remembered) — leaves the
 * input's bytes alone and so leaves the answer alone.
 */
export function lastInPlaceWrite(
  events: readonly ApplyLogEvent[],
): Map<string, ApplyLogEvent> {
  const touched = new Map<string, ApplyLogEvent>();
  for (const event of events) {
    if (writesInputInPlace(event)) touched.set(event.input, event);
    else if (
      event.event === "backed-up" ||
      event.event === "replaced" ||
      event.event === "superseded"
    ) {
      touched.delete(event.input);
    }
  }
  return touched;
}

/**
 * Inputs whose original was renamed aside but whose repaired file was never
 * renamed into its place — a run killed between `apply`'s two renames. The
 * event carries both the backup path and the path the repaired file is at, so
 * a rerun can finish the swap instead of reporting a missing input.
 */
export function pendingReplacements(
  events: readonly ApplyLogEvent[],
): Map<string, ApplyLogEvent> {
  const pending = new Map<string, ApplyLogEvent>();
  for (const event of events) {
    if (event.event === "backed-up") pending.set(event.input, event);
    else if (
      event.event === "replaced" ||
      event.event === "failed" ||
      event.event === "superseded"
    ) {
      pending.delete(event.input);
    }
  }
  return pending;
}

/**
 * Inputs this plan has written to at their own path, with the last such record:
 * an in-place write (`started`, `patched`, in-place `reverted`) or a
 * `backed-up`/`replaced` swap.
 *
 * `plan` never re-analyzes these. Their entry is the undo record — the patch
 * file names exactly the bytes that were changed — and a fresh analysis of the
 * repaired file would reuse that patch file's name for an empty or different
 * list, losing the way back. Nothing but `superseded` clears an input from here:
 * `plan` writes that when a *different* file has taken the path (its size is
 * not the size the plan repaired, which a patch never changes), and only then
 * starts that path afresh — under a new patch file name, the old one kept.
 */
export function lastWriteToInput(
  events: readonly ApplyLogEvent[],
): Map<string, ApplyLogEvent> {
  const written = new Map<string, ApplyLogEvent>();
  for (const event of events) {
    if (
      writesInputInPlace(event) ||
      event.event === "backed-up" ||
      event.event === "replaced"
    ) {
      written.set(event.input, event);
    } else if (event.event === "superseded") {
      written.delete(event.input);
    }
  }
  return written;
}

export interface OutputState {
  exists: boolean;
  size: number;
}

/**
 * Whether a file can be skipped because a previous run already finished it.
 *
 * A `replaced` record needs no output check: the output was renamed onto the
 * original path, so neither the plan's stamp nor the output path still holds.
 *
 * A `verified` record vouches for one file: the output it names. `outputPath`
 * is the output this run would write; when it is given, a record about any
 * other path is no reason to skip — a same-sized file at the same relative
 * path in another folder is not the copy the log verified.
 */
export function shouldSkipForResume(
  record: ApplyLogEvent | undefined,
  output: OutputState | null,
  outputPath?: string,
): { skip: boolean; reason?: string } {
  if (!record) return { skip: false };
  if (record.event === "replaced") {
    return {
      skip: true,
      reason: `already applied and the original was replaced${
        record.backup ? ` (backup: ${record.backup})` : ""
      }`,
    };
  }
  if (record.event === "patched") {
    return { skip: true, reason: "already patched in place by an earlier run" };
  }
  if (record.event === "verified") {
    if (
      outputPath !== undefined &&
      (record.output === undefined || resolve(record.output) !== resolve(outputPath))
    ) {
      return { skip: false };
    }
    if (output?.exists === true && (record.bytes === undefined || output.size === record.bytes)) {
      return { skip: true, reason: "already applied and verified by an earlier run" };
    }
    return { skip: false };
  }
  return { skip: false };
}
