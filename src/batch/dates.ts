/**
 * File dates and the in-place writes.
 *
 * Writing a repair into a file moves its modification time to now, as any edit
 * does, and that is the default. Some libraries hang meaning on that date — a
 * media server's "recently added" shelf sorts by it — so `preserveDates` puts
 * the date the file had back once the write is done (`keepDate`), and
 * `restoreDates` does the same after the fact for files an earlier run
 * already touched, from the date the plan recorded before its first write.
 *
 * Only the modification time is set; the access time is passed through as it
 * is. Nothing here reads or writes a byte of the media.
 */
import { readdir, readFile, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { isNetworkPath, mountTableKnown } from "../mkv/ebml.js";
import { silentLogger, type Logger } from "../scan/log.js";
import {
  lastWriteToInput,
  readApplyLog,
  unfinishedInPlace,
  writesInputAtOwnPath,
  type ApplyLogEvent,
} from "./log.js";
import {
  planPaths,
  requirePlan,
  sameMtime,
  writePlan,
  type PlanFileEntry,
} from "./planFile.js";

/** What a share may round a date it is asked to store by (FAT and some SMB servers: 2 s). */
export const DATE_ROUNDING_MS = 2000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * How long after a write to a file on a network share its date is watched.
 *
 * A share does not date a write when it is made. macOS closes a file on an
 * SMB server lazily, and the server stamps the write when that close arrives:
 * measured against a NAS, 40 to 95 seconds after the last byte. A date set in
 * between is silently replaced by the time of the write, while the client
 * goes on reporting the date it was asked for. A date set after that stays.
 */
export const DATE_SETTLE_MS = 150_000;
const DATE_SETTLE_POLL_MS = 2_000;

/** A date put back after a write, still to be watched (`settleDates`). */
export interface PendingDate {
  path: string;
  mtimeMs: number;
  /** When the file was last touched (ms since the epoch). */
  writtenAt: number;
}

/** How long a write on `path` is watched: the full window on a network share, none on a local disk. */
export function settleWindowFor(path: string, windowMs?: number): number {
  // The full window too when the mount table cannot be read: not watching a
  // share loses the date.
  return windowMs ?? (isNetworkPath(path) || !mountTableKnown() ? DATE_SETTLE_MS : 0);
}

async function setDate(path: string, mtimeMs: number): Promise<void> {
  const info = await stat(path);
  await utimes(path, info.atimeMs / 1000, mtimeMs / 1000);
}

const offBy = (a: number, b: number): boolean => Math.abs(a - b) >= DATE_ROUNDING_MS;

/**
 * Set `path`'s modification time to `mtimeMs`, leaving its access time alone.
 * Returns what went wrong, or undefined: a date that could not be put back is
 * a note on a repair, never a reason to fail one.
 *
 * On a share this is not the end of it: see `DateWatch`.
 */
export async function keepDate(path: string, mtimeMs: number): Promise<string | undefined> {
  try {
    await setDate(path, mtimeMs);
    const after = await stat(path);
    if (offBy(after.mtimeMs, mtimeMs)) {
      return (
        `asked for ${new Date(mtimeMs).toISOString()}, the file now says ` +
        new Date(after.mtimeMs).toISOString()
      );
    }
    return undefined;
  } catch (err) {
    return errorText(err);
  }
}

/** What `DateWatch` could not do for a file. */
export interface DateProblem {
  path: string;
  problem: string;
}

interface Watched {
  path: string;
  mtimeMs: number;
  until: number;
}

/**
 * Watches the dates put back during a run (`DATE_SETTLE_MS` says why). Each
 * file is watched from the moment it is added — the last time the tool
 * touched it, after any verification, since a read may hold the share's
 * handle open as well — until its window has passed: its date is set again
 * whenever the share has replaced it, and once more, whatever the client
 * reports, when the window ends.
 *
 * The watch runs in the background while the run goes on to its next file,
 * so only the files written last are still inside their window when the run
 * ends; `settle` waits for those. One watch can serve several runs
 * (`remargin` gives the same one to every revert and apply), which then wait
 * once between them.
 */
export class DateWatch {
  private readonly entries = new Map<string, Watched>();
  private readonly problems = new Map<string, string>();
  private readonly windowMs: number | undefined;
  private readonly pollMs: number;
  private readonly log: Logger | undefined;
  private loop: Promise<void> | undefined;
  private stopped = false;
  private wake: (() => void) | undefined;

  constructor(options: { windowMs?: number; pollMs?: number; log?: Logger } = {}) {
    this.windowMs = options.windowMs;
    this.pollMs = options.pollMs ?? DATE_SETTLE_POLL_MS;
    this.log = options.log;
  }

  /**
   * Watch `path` for the date `mtimeMs`, the window counted from `since`.
   * A file added again is watched for the later date only. Nothing is
   * watched where there is no window (a local disk). `problem` is why the
   * date could not be set just now (`keepDate`): `settle` reports it unless
   * the watch sets the date after all.
   */
  add(path: string, mtimeMs: number, since: number = Date.now(), problem?: string): void {
    if (problem === undefined) this.problems.delete(path);
    else this.problems.set(path, problem);
    const window = settleWindowFor(path, this.windowMs);
    if (window <= 0) return;
    this.entries.set(path, { path, mtimeMs, until: Math.min(since, Date.now()) + window });
    this.loop ??= this.run();
  }

  private async run(): Promise<void> {
    while (this.entries.size > 0) {
      for (const w of [...this.entries.values()]) {
        // Replaced by a later write of the same file while this pass waited.
        if (this.entries.get(w.path) !== w) continue;
        const last = this.stopped || Date.now() >= w.until;
        try {
          const off = last || offBy((await stat(w.path)).mtimeMs, w.mtimeMs);
          // Never an earlier date over a later one: look again after the wait.
          if (this.entries.get(w.path) !== w) continue;
          if (off) await setDate(w.path, w.mtimeMs);
          if (this.entries.get(w.path) !== w) continue;
          this.problems.delete(w.path);
          if (last && this.stopped && Date.now() < w.until) {
            this.problems.set(
              w.path,
              "date verification was cancelled before the share updated the file's date, " +
                "which may still change (run `restore-dates` to restore it)",
            );
          }
        } catch (err) {
          if (this.entries.get(w.path) !== w) continue;
          this.problems.set(w.path, errorText(err));
        }
        if (last) this.entries.delete(w.path);
      }
      if (this.entries.size === 0) break;
      if (!this.stopped) {
        await new Promise<void>((r) => {
          const timer = setTimeout(r, this.pollMs);
          this.wake = () => {
            clearTimeout(timer);
            r();
          };
        });
        this.wake = undefined;
      }
    }
    this.loop = undefined;
  }

  /**
   * What is still being watched: how many files, and how long until the last
   * window ends (0 when none is left). Read-only; a caller about to `settle`
   * uses it to say that it is waiting.
   */
  remaining(): { files: number; waitMs: number } {
    const until = Math.max(0, ...[...this.entries.values()].map((w) => w.until));
    return { files: this.entries.size, waitMs: Math.max(0, until - Date.now()) };
  }

  /**
   * Wait until every watched file's window has passed and return the files
   * whose date could not be kept. On `signal` the watch ends at once, after
   * one last set of each date, and every file cut short is reported.
   */
  async settle(signal?: AbortSignal): Promise<DateProblem[]> {
    if (this.loop !== undefined) {
      const stop = (): void => {
        this.stopped = true;
        this.wake?.();
      };
      const wait = Math.max(...[...this.entries.values()].map((w) => w.until)) - Date.now();
      if (wait > 0 && signal?.aborted !== true) {
        this.log?.warn(
          `verifying ${this.entries.size} file date(s) for up to ${Math.ceil(wait / 1000)} s: ` +
            "network shares can update a file's date shortly after a write. Please wait.",
        );
      }
      if (signal?.aborted === true) stop();
      else signal?.addEventListener("abort", stop, { once: true });
      try {
        while (this.loop !== undefined) await this.loop;
      } finally {
        signal?.removeEventListener("abort", stop);
        this.stopped = false;
      }
    }
    const problems = [...this.problems].map(([path, problem]) => ({ path, problem }));
    this.problems.clear();
    return problems;
  }
}

/**
 * Watch `pending` until each file's window has passed: `DateWatch` for a
 * list already in hand.
 */
export async function settleDates(
  pending: readonly PendingDate[],
  options: { windowMs?: number; pollMs?: number; signal?: AbortSignal; log?: Logger } = {},
): Promise<DateProblem[]> {
  const watch = new DateWatch(options);
  for (const p of pending) watch.add(p.path, p.mtimeMs, p.writtenAt);
  return watch.settle(options.signal);
}

/** How far a share's clock may differ from this machine's. */
const CLOCK_SLACK_MS = 10 * 60 * 1000;

/**
 * True when `mtimeMs` is the stamp of the write `record` describes: the share
 * dated the file at the time of that write (which ran for `durationMs` up to
 * the record), replacing whatever date the tool had put back.
 */
export function isStampOfWrite(record: ApplyLogEvent, mtimeMs: number): boolean {
  const at = Date.parse(record.time);
  if (!Number.isFinite(at)) return false;
  return mtimeMs >= at - (record.durationMs ?? 0) - CLOCK_SLACK_MS && mtimeMs <= at + CLOCK_SLACK_MS;
}

/**
 * The date an in-place write should put back, given the last in-place record
 * for the file and the date the file has now.
 *
 * Normally the file's own. But when the last write kept a date
 * (`keepMtimeMs`) and the file's date now is that write's own stamp, the file
 * has lost the kept date and it is the one to put back: an unfinished
 * `started` (the interrupted write changed the file), or a finished write the
 * share dated afterwards. A date that is neither — older than the write, or
 * set by something else since — is the file's own and stays.
 */
export function dateToKeep(last: ApplyLogEvent | undefined, currentMtimeMs: number): number {
  if (last === undefined || last.keepMtimeMs === undefined) return currentMtimeMs;
  const at = Date.parse(last.time);
  if (!Number.isFinite(at)) return currentMtimeMs;
  if (last.event === "started") {
    // Nothing says when that write ended; anything from its start on is its.
    return currentMtimeMs < at - CLOCK_SLACK_MS ? currentMtimeMs : last.keepMtimeMs;
  }
  return isStampOfWrite(last, currentMtimeMs) ? last.keepMtimeMs : currentMtimeMs;
}

export type RestoreDateStatus = "restored" | "would-restore" | "already" | "skipped" | "failed";

export interface RestoreDateResult {
  input: string;
  relative: string;
  status: RestoreDateStatus;
  /** The date the file has (had, once restored). */
  from?: number;
  /** The date recorded before this plan first wrote the file. */
  to?: number;
  reason?: string;
}

export interface RestoreDatesOptions {
  /** Only files whose path or relative name contains this substring. */
  file?: string;
  execute?: boolean;
  /** How long after a write a restored date is watched; default by filesystem (`settleWindowFor`). */
  dateSettleMs?: number;
}

export interface RestoreDatesResult {
  dir: string;
  execute: boolean;
  files: RestoreDateResult[];
}

interface PatchHeader {
  name: string;
  input: string;
  created: number;
  mtimeMs: number;
}

/** `input`, `created` and `mtimeMs` of every readable patch file in the plan. */
async function patchHeaders(patchDir: string): Promise<PatchHeader[]> {
  let names: string[];
  try {
    names = (await readdir(patchDir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const headers: PatchHeader[] = [];
  for (const name of names) {
    try {
      const value = JSON.parse(await readFile(join(patchDir, name), "utf8")) as {
        input?: unknown;
        created?: unknown;
        mtimeMs?: unknown;
      };
      const created = typeof value.created === "string" ? Date.parse(value.created) : Number.NaN;
      if (
        typeof value.input === "string" &&
        typeof value.mtimeMs === "number" &&
        Number.isFinite(value.mtimeMs) &&
        value.mtimeMs > 0 &&
        Number.isFinite(created)
      ) {
        headers.push({ name, input: value.input, created, mtimeMs: value.mtimeMs });
      }
    } catch {
      // An unreadable patch file vouches for no date; the title is then skipped.
    }
  }
  return headers;
}

/**
 * When this plan first wrote each input at its own path, and the last time a
 * different file was found there (`superseded`), which starts the history over.
 */
function writeHistory(events: readonly ApplyLogEvent[]): {
  firstWrite: Map<string, number>;
  since: Map<string, number>;
} {
  const firstWrite = new Map<string, number>();
  const since = new Map<string, number>();
  for (const event of events) {
    const time = Date.parse(event.time);
    if (event.event === "superseded") {
      firstWrite.delete(event.input);
      if (Number.isFinite(time)) since.set(event.input, time);
    } else if (
      (writesInputAtOwnPath(event) || event.event === "backed-up" || event.event === "replaced") &&
      !firstWrite.has(event.input) &&
      Number.isFinite(time)
    ) {
      firstWrite.set(event.input, time);
    }
  }
  return { firstWrite, since };
}

/** A day: how long before its `replaced` record a swapped-in copy may have been written. */
const UNSTAMPED_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Put back the modification date of every file this plan wrote at its own
 * path, to the date the plan recorded before its first write.
 *
 * That date is the `mtimeMs` of the last patch file made for the input before
 * the first write — a patch file carries the stamp of the file it was
 * analyzed from, and that one was analyzed from the file the write changed. A file is left alone unless its date is still the one this tool's
 * last write left (the log's `stamp`): any other date is someone else's.
 *
 * The plan entry's `mtimeMs` follows the file, which is what lets the next
 * `plan` find it unchanged without reading it.
 */
export async function restoreDates(
  planDir: string,
  options: RestoreDatesOptions = {},
  deps: { log?: Logger } = {},
): Promise<RestoreDatesResult> {
  const log = deps.log ?? silentLogger;
  const execute = options.execute === true;
  const paths = planPaths(planDir);
  const plan = await requirePlan(planDir);
  const events = await readApplyLog(paths.applyLog);
  const written = lastWriteToInput(events);
  const unfinished = unfinishedInPlace(events);
  const { firstWrite, since } = writeHistory(events);
  const headers = await patchHeaders(paths.patchDir);

  const files: RestoreDateResult[] = [];
  const pending: PendingDate[] = [];
  let planChanged = false;
  const candidates = plan.files.filter(
    (e) =>
      written.has(e.input) &&
      (options.file === undefined ||
        e.input.includes(options.file) ||
        (e.relative ?? "").includes(options.file)),
  );

  const one = async (entry: PlanFileEntry): Promise<RestoreDateResult> => {
    const result: RestoreDateResult = {
      input: entry.input,
      relative: entry.relative,
      status: "skipped",
    };
    const skip = (reason: string): RestoreDateResult => ({ ...result, reason });
    if (unfinished.has(entry.input)) {
      return skip("an in-place write to it did not complete; finish that first");
    }
    const first = firstWrite.get(entry.input);
    const after = since.get(entry.input);
    // The latest analysis from before the first write is the one that write
    // used; an earlier one may describe the file as it was before some other
    // change (a refused attempt makes `plan` analyze again under a new name).
    const source = headers
      .filter(
        (h) =>
          h.input === entry.input &&
          first !== undefined &&
          h.created < first &&
          (after === undefined || h.created > after),
      )
      .sort((a, b) => b.created - a.created)[0];
    if (source === undefined) {
      return skip("the plan has no record of its date from before the first fix");
    }
    result.to = source.mtimeMs;

    let info;
    try {
      info = await stat(entry.input);
    } catch (err) {
      return skip(`it could not be read (${errorText(err)})`);
    }
    result.from = info.mtimeMs;
    if (info.size !== entry.size) {
      return skip(`it is ${info.size} bytes, not the ${entry.size} this plan fixed`);
    }
    if (Math.abs(info.mtimeMs - source.mtimeMs) < DATE_ROUNDING_MS) {
      // A run killed between the date and the plan: bring the plan up to date.
      if (execute && !sameMtime(entry.mtimeMs, info.mtimeMs)) {
        entry.mtimeMs = info.mtimeMs;
        planChanged = true;
      }
      return { ...result, status: "already" };
    }
    const last = written.get(entry.input)!;
    if (isStampOfWrite(last, info.mtimeMs)) {
      // The share's own date for this tool's last write: a kept date that did
      // not hold, or a write made without keeping one. Ours to put back.
    } else if (last.stamp !== undefined) {
      if (last.stamp.size !== info.size || !sameMtime(last.stamp.mtimeMs, info.mtimeMs)) {
        return skip(
          "its date is not the one this tool's last write left " +
            `(${new Date(last.stamp.mtimeMs).toISOString()}): something else has modified it since`,
        );
      }
    } else {
      const recorded = Date.parse(last.time);
      if (
        !Number.isFinite(recorded) ||
        info.mtimeMs > recorded + 5 * 60 * 1000 ||
        info.mtimeMs < recorded - UNSTAMPED_WINDOW_MS
      ) {
        return skip(
          "the log does not say what date this tool's last write left, and the file's " +
            "is not from that write",
        );
      }
    }
    if (!execute) return { ...result, status: "would-restore" };

    const problem = await keepDate(entry.input, source.mtimeMs);
    if (problem !== undefined) {
      log.error(`${entry.relative}: date could not be restored: ${problem}`);
      return { ...result, status: "failed", reason: problem };
    }
    const now = await stat(entry.input).catch(() => undefined);
    entry.mtimeMs = now?.mtimeMs ?? source.mtimeMs;
    planChanged = true;
    // A write made moments ago may yet be dated by the share: watch it.
    const wrote = Date.parse(last.time);
    if (Number.isFinite(wrote)) {
      pending.push({ path: entry.input, mtimeMs: source.mtimeMs, writtenAt: wrote });
    }
    log.info(
      `${entry.relative}: ${new Date(info.mtimeMs).toISOString()} → ` +
        new Date(source.mtimeMs).toISOString(),
    );
    return { ...result, status: "restored" };
  };

  try {
    for (const entry of candidates) files.push(await one(entry));
  } finally {
    if (planChanged) await writePlan(planDir, plan);
  }
  for (const { path, problem } of await settleDates(pending, {
    ...(options.dateSettleMs === undefined ? {} : { windowMs: options.dateSettleMs }),
    log,
  })) {
    log.warn(`${path}: date could not be preserved: ${problem}`);
  }
  return { dir: paths.dir, execute, files };
}
