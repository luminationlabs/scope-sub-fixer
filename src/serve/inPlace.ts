/**
 * What `serve` adds around the engine's in-place fix and its undo.
 *
 * Nothing here writes a movie file. An in-place fix is `applyPlan({ inPlace:
 * true })` and its undo is `revertPlan({ inPlace: true })`, both in
 * `src/batch/`, both writing only inputs the plan itself names, at the offsets
 * its patch files record. This file is the checks made before either is
 * called: that the files can be written at all, that an undo is aimed at
 * exactly one title and at the original (not at a copy elsewhere), and whether
 * a plan directory holds undo records that must not be thrown away.
 */
import { access, constants } from "node:fs/promises";
import { resolve } from "node:path";
import {
  completedByInput,
  lastWriteToInput,
  unfinishedInPlace,
  type ApplyLogEvent,
} from "../batch/log.js";
import type { PlanFileEntry } from "../batch/planFile.js";

/** The inputs that cannot be opened for writing, with why. */
export async function notWritable(inputs: readonly string[]): Promise<{ input: string; why: string }[]> {
  const refused: { input: string; why: string }[] = [];
  for (const input of inputs) {
    try {
      await access(input, constants.W_OK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A file that is not there is the engine's to report, per title.
      if (code === "ENOENT") continue;
      refused.push({
        input,
        why:
          code === "EROFS"
            ? "the disk or share is read-only"
            : code === "EACCES" || code === "EPERM"
              ? "permission denied"
              : (err instanceof Error ? err.message : String(err)),
      });
    }
  }
  return refused;
}

/** The refusal for `notWritable`'s findings, in words for the person at the screen. */
export function notWritableMessage(
  refused: readonly { input: string; why: string }[],
  asked: number,
  doing: "fix" | "undo",
): string {
  const first = refused[0]!;
  const what = doing === "fix" ? "fixed in place" : "restored";
  return (
    (refused.length === asked
      ? `${asked === 1 ? "This file cannot" : `None of these ${asked} files can`} be modified, so ` +
        `${asked === 1 ? "it" : "they"} cannot be ${what}`
      : `${refused.length} of these ${asked} files cannot be modified, so nothing was started`) +
    `: ${first.why} (${first.input}). ` +
    "If your movies are on a network share or an external disk, check that it is connected with " +
    "write permission, then try again." +
    (doing === "fix" ? " Or turn off in-place fixing to create fixed copies instead." : "")
  );
}

/**
 * The inputs this plan directory holds the undo record of: files it wrote at
 * their own path (an in-place fix or undo, finished or not, or a
 * `--replace-original` swap).
 */
export function undoRecordInputs(events: readonly ApplyLogEvent[]): string[] {
  return [...lastWriteToInput(events).keys()];
}

/**
 * The `file` filter that makes `revertPlan` put back exactly `entry` and
 * nothing else, or null when no filter can.
 *
 * `revertPlan` selects by substring of the input path or relative name. A full
 * input path selects its own entry; it would also select any other entry whose
 * path merely contains it (`/lib/a.mkv` is inside `/lib/x/lib/a.mkv`). Writing
 * to a file nobody asked about is not a risk to take, so that title is refused
 * here instead.
 */
export function exactRevertFilter(
  entry: PlanFileEntry,
  all: readonly PlanFileEntry[],
): string | null {
  const filter = entry.input;
  const hits = all.filter(
    (e) => e.action === "fix" && (e.input.includes(filter) || e.relative.includes(filter)),
  );
  return hits.length === 1 && hits[0] === entry ? filter : null;
}

export type RevertAim =
  | { ok: true }
  | { ok: false; status: "skipped" | "failed"; reason: string };

/**
 * Whether an in-place undo of `entry` would write the original file, which is
 * the only thing the protocol's `revert` is for. A title fixed into a copy has
 * its original untouched; `revertPlan --in-place` would rewrite the *copy*.
 */
export function revertAim(entry: PlanFileEntry, events: readonly ApplyLogEvent[]): RevertAim {
  const record = completedByInput(events).get(entry.input) ?? unfinishedInPlace(events).get(entry.input);
  if (record === undefined) {
    return {
      ok: false,
      status: "skipped",
      reason: "this title has not been fixed in place, so there is nothing to restore",
    };
  }
  const target = record.output ?? entry.input;
  if (resolve(target) !== resolve(entry.input)) {
    return {
      ok: false,
      status: "skipped",
      reason:
        `this title was fixed as a copy (${target}); the original was not modified, ` +
        "so there is nothing to restore",
    };
  }
  return { ok: true };
}
