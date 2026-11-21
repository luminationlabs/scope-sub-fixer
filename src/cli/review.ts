/**
 * `scope-sub review` — check a library for new titles and fix the ones that
 * need it, one yes/no at a time.
 *
 * The incremental workflow in one command, for a plan directory kept for good:
 *
 *   1. `plan` the library into it. Unchanged titles are reused, and so are the
 *      ones this plan repaired (`lastWriteToInput`), so only new or changed
 *      titles are analyzed.
 *   2. Say what those new titles turned out to be.
 *   3. Rehearse `apply --dangerously-in-place` to find every title that still
 *      needs fixing — the new ones, and any declined before — and ask about
 *      each. The rehearsal already checks every range against the plan.
 *   4. Repair exactly the approved ones, in place (`ApplyOptions.only`).
 *
 * The plan directory is therefore both the record of what has been checked and
 * the undo record for everything this command has ever repaired.
 */
import { closeSync, constants, openSync, readSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { Command } from "commander";
import { applyExitCode, applyPlan, type ApplyFileResult } from "../batch/apply.js";
import { APPLY_EXIT } from "../batch/exitCodes.js";
import { runPlan, type PlanRunResult } from "../batch/plan.js";
import { PlanFileError, type PlanFileEntry } from "../batch/planFile.js";
import { createLogger, LOG_LEVELS, type LogLevel } from "../scan/log.js";
import { formatApplyReport } from "./apply.js";
import { EXIT, resolveScanArgs, type CliIo, type RawScanOptions } from "./scan.js";

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export interface RawReviewOptions extends RawScanOptions {
  plan?: string;
  /** Put each repaired file's modification date back after writing it. */
  preserveDates?: boolean;
}

/** Ask one question; resolves with the answer line, or null once input has ended. */
export type Ask = (question: string) => Promise<string | null>;

/** The part of `process.stdin` the drain needs; injectable for tests. */
export interface TypeaheadInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

/**
 * Throw away what was typed at the terminal before a question is asked.
 *
 * The check before the questions can run for hours, and the terminal keeps
 * everything typed meanwhile: a stray "y" would otherwise approve a title
 * before its question was ever read. The same goes for answers typed in a
 * burst — the second one must not answer a question that is not on screen yet.
 *
 * The terminal is in line mode, where only complete lines can be read back, so
 * a "y" typed without Enter would stay behind and be completed by the next
 * Enter. Raw mode makes the unfinished line readable too; it is switched on
 * only for this drain — synchronous, so nothing else runs in between — and
 * always switched off again, whatever the read does. (Node also restores the
 * terminal itself when it exits on a signal.)
 *
 * Does nothing unless stdin is a terminal — piped answers are the answers —
 * and nothing on Windows.
 * Returns how many bytes were discarded.
 */
export function discardTypeahead(
  stdin: TypeaheadInput = process.stdin,
  tty = "/dev/tty",
  platform: string = process.platform,
): number {
  if (stdin.isTTY !== true) return 0;
  // Windows has no `/dev/tty` and no O_NONBLOCK; its console has a different
  // way to flush input that is not used here. `createAsk` still drops lines
  // that arrived before a question was printed, so only typeahead still in
  // the console's own buffer (an unfinished "y", say) can be left over there.
  if (platform === "win32") return 0;
  let fd: number;
  try {
    fd = openSync(tty, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return 0;
  }
  let discarded = 0;
  let raw = false;
  const buffer = Buffer.allocUnsafe(4096);
  try {
    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
      raw = true;
    }
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n <= 0) break;
      discarded += n;
    }
  } catch {
    // EAGAIN: nothing (more) waiting.
  } finally {
    if (raw) {
      try {
        stdin.setRawMode!(false);
      } catch {
        // The terminal went away; there is nothing left to restore.
      }
    }
    closeSync(fd);
  }
  return discarded;
}

export interface AskOptions {
  /**
   * For a terminal: an answer counts only if it arrives after its question was
   * printed. Input is read only while a question is waiting, lines that came
   * in early are dropped, and `drain` (the terminal's own buffer) runs before
   * every question. Off for a pipe, where the lines given are the answers.
   */
  interactive?: boolean;
  /** With `interactive`: empties the terminal's buffer; see `discardTypeahead`. */
  drain?: () => void;
}

/**
 * An `Ask` over a stream, reading one line per question. One reader for the
 * whole session, so piped answers are not lost between questions.
 */
export function createAsk(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  options: AskOptions = {},
): { ask: Ask; close: () => void } {
  const interactive = options.interactive === true;
  const rl = createInterface({ input, terminal: false });
  const lines: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;
  // Between questions an interactive session does not read at all: what is
  // typed then stays in the terminal, where the drain can throw it away.
  if (interactive) rl.pause();
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) {
      if (interactive) rl.pause();
      next(line);
    } else lines.push(line);
  });
  rl.on("close", () => {
    ended = true;
    for (const next of waiting.splice(0)) next(null);
  });
  return {
    ask: (question) => {
      if (interactive && !ended) {
        // Whatever the stream already holds was typed before this question:
        // pull it through (it lands in `lines`), then drop it all.
        while (input.read() !== null) {
          // discarded
        }
        lines.length = 0;
        options.drain?.();
      }
      output.write(question);
      const line = lines.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (ended) {
        output.write("\n");
        return Promise.resolve(null);
      }
      const answer = new Promise<string | null>((resolve) => waiting.push(resolve));
      if (interactive) rl.resume();
      return answer;
    },
    close: () => rl.close(),
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** One line on what the plan concluded about a title. */
export function describeEntry(entry: PlanFileEntry): string {
  if (entry.action === "fix") {
    const s = entry.patch_summary;
    const a = entry.active_area;
    // Said every time: this title's picture changes shape, and the fix is
    // judged by one of its shapes — the person answering should know which.
    const where =
      a?.classification === "MIXED_NARROWEST"
        ? `outside the narrowest picture area (rows ${a.top}–${a.bottom - 1} of ` +
          `${entry.video?.h ?? "?"}; aspect ratio varies)`
        : "outside the picture";
    return (
      `needs fixing: ${plural(s?.tracks ?? 0, "track")}, ` +
      `${plural(s?.events_moved ?? 0, "subtitle")} ${where}`
    );
  }
  switch (entry.status) {
    case "OK":
      return `no changes needed (${entry.reason ?? "nothing outside the picture"})`;
    case "NO_PGS":
      return "no changes needed (no PGS subtitles)";
    case "ERROR":
      return `could not be scanned: ${entry.reason ?? "unknown error"}`;
    case "NEEDS_FIX":
      return `cannot be fixed: ${entry.reason ?? "see plan-show"}`;
    default:
      return `skipped (${entry.status}): ${entry.reason ?? "see plan-show"}`;
  }
}

/** `text` in parentheses after a space, or nothing when there is none. */
function paren(text: string): string {
  return text === "" ? "" : ` (${text})`;
}

/**
 * Ask until the answer is a yes or a no. Anything else — an empty line
 * included — is asked again: Enter presses typed while a long check was running
 * sit in the terminal's buffer, and must not decline titles nobody has seen.
 * The end of input is a no.
 */
async function askYesNo(ask: Ask, question: string): Promise<boolean> {
  for (;;) {
    const answer = await ask(question);
    if (answer === null) return false;
    if (/^\s*y(es)?\s*$/i.test(answer)) return true;
    if (/^\s*no?\s*$/i.test(answer)) return false;
  }
}

/** Quieter than the plan run: the rehearsal's per-file lines are noise here. */
function rehearsalLevel(level: LogLevel): LogLevel {
  return level === "debug" || level === "trace" || level === "error" ? level : "warn";
}

export async function runReview(
  paths: readonly string[],
  raw: RawReviewOptions,
  io: CliIo = defaultIo,
  ask?: Ask,
): Promise<number> {
  let args: ReturnType<typeof resolveScanArgs>;
  try {
    args = resolveScanArgs(raw);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.BAD_ARGS;
  }
  if (paths.length === 0) {
    io.stderr("no paths given; pass the library directory\n");
    return EXIT.BAD_ARGS;
  }
  if (raw.plan === undefined || raw.plan.trim() === "") {
    io.stderr("--plan <dir> is required: the plan directory kept for this library\n");
    return EXIT.BAD_ARGS;
  }
  const log = createLogger(args.logLevel, (line) => io.stderr(`${line}\n`));
  const quiet = createLogger(rehearsalLevel(args.logLevel), (line) => io.stderr(`${line}\n`));

  io.stdout(`Scanning ${paths.join(", ")} for new or changed titles…\n`);
  let run: PlanRunResult;
  try {
    run = await runPlan(paths, raw.plan, { ...args.scan, method: "patch" }, { log });
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof PlanFileError ? EXIT.BAD_ARGS : EXIT.UNSUPPORTED_MEDIA;
  }
  if (run.missingPaths.length > 0) return EXIT.BAD_ARGS;
  const foundCount = run.plan.files.length - run.notFound.length;
  if (foundCount === 0 && run.notFound.length > 0) {
    io.stdout(
      `\nNo titles found in ${paths.join(", ")}, but the plan lists ` +
        `${plural(run.notFound.length, "title")}. Check that the library is mounted. No files were modified.\n`,
    );
    return EXIT.BAD_ARGS;
  }

  const byInput = new Map(run.plan.files.map((e) => [e.input, e]));
  io.stdout(
    `\n${plural(foundCount, "title")}: ${run.reused.toLocaleString("en-US")} ` +
      `unchanged, ${run.analyzed.toLocaleString("en-US")} new or changed\n`,
  );
  if (run.notFound.length > 0) {
    io.stdout(
      `  ${plural(run.notFound.length, "title")} in the plan ${run.notFound.length === 1 ? "was" : "were"} ` +
        "not found (moved or deleted); entries kept\n",
    );
  }
  if (run.adopted.length > 0) {
    io.stdout(
      `  ${plural(run.adopted.length, "title")} had header edits only ` +
        "(video and subtitles unchanged); not rescanned\n",
    );
  }
  const fresh = run.analyzedFiles
    .map((f) => byInput.get(f))
    .filter((e): e is PlanFileEntry => e !== undefined)
    .sort((a, b) => (a.relative < b.relative ? -1 : 1));
  for (const entry of fresh) io.stdout(`  ${entry.relative}: ${describeEntry(entry)}\n`);
  for (const input of run.superseded) {
    io.stdout(
      `  ${byInput.get(input)?.relative ?? input}: replaced by a different file since it ` +
        "was fixed; rescanned (previous undo data kept)\n",
    );
  }
  for (const input of run.keptChanged) {
    io.stdout(
      `  ${byInput.get(input)?.relative ?? input}: modified since it was fixed; ` +
        "undo data kept but may no longer match\n",
    );
  }
  for (const input of run.restored) {
    io.stdout(
      `  ${byInput.get(input)?.relative ?? input}: previously fixed, but the file is the ` +
        "original again (possibly restored from a backup); it can be fixed again\n",
    );
  }
  for (const input of run.unreadable) {
    io.stdout(
      `  ${byInput.get(input)?.relative ?? input}: could not be read; previous result kept\n`,
    );
  }
  // Titles nobody could look at this run: the ones kept unread, and the new
  // ones that came out as an error. Either way the check is not complete, and
  // the exit code must not say it was.
  const unchecked = run.unreadable.length + fresh.filter((e) => e.status === "ERROR").length;
  if (unchecked > 0) {
    io.stdout(
      `\nWARNING: ${plural(unchecked, "title")} could not be scanned. ` +
        "Check that the library is mounted, then run again.\n",
    );
  }
  const withUnchecked = (code: number): number =>
    code !== EXIT.OK ? code : unchecked > 0 ? EXIT.UNSUPPORTED_MEDIA : EXIT.OK;

  const rehearsal = await applyPlan(run.dir, { inPlace: true }, { log: quiet });
  const candidates = rehearsal.files.filter((f) => f.status === "would-apply");
  const refused = rehearsal.files.filter((f) => f.status === "failed" || f.status === "conflict");
  for (const f of refused) io.stdout(`  cannot fix ${f.relative}: ${f.reason ?? ""}\n`);

  const refusedCode = (more: readonly ApplyFileResult[] = []): number =>
    applyExitCode([...refused, ...more]);
  if (candidates.length === 0) {
    io.stdout("\nNothing needs fixing.\n");
    return withUnchecked(refusedCode());
  }

  io.stdout("\n");
  // At a terminal an answer must come after its question: see `AskOptions`.
  const terminal = ask === undefined && process.stdin.isTTY === true;
  if (terminal && discardTypeahead() > 0) {
    io.stdout("(Input typed during the scan was discarded.)\n\n");
  }
  const session =
    ask === undefined
      ? createAsk(
          process.stdin,
          process.stdout,
          terminal ? { interactive: true, drain: () => void discardTypeahead() } : {},
        )
      : undefined;
  const question = ask ?? session!.ask;
  const approved: string[] = [];
  const leftHalfDone: string[] = [];
  const leftUnverified: string[] = [];
  try {
    const analyzed = new Set(run.analyzedFiles);
    for (const c of candidates) {
      const s = byInput.get(c.input)?.patch_summary;
      const what =
        s === undefined
          ? ""
          : `${plural(s.tracks, "track")}, ${plural(s.events_moved, "subtitle")} to move`;
      if (c.resuming) {
        // Not a choice like the others: the file is half one thing, half the other.
        const yes = await askYesNo(
          question,
          `Finish fixing "${c.relative}"? A previous fix was interrupted and the file is ` +
            `partially modified.${paren(what)} [y/n] `,
        );
        if (yes) approved.push(c.input);
        else leftHalfDone.push(c.relative);
        continue;
      }
      if (c.awaitingVerification) {
        // Already written, never confirmed: yes changes nothing more in the
        // file unless the check fails, and then it puts the original back.
        const yes = await askYesNo(
          question,
          `Finish fixing "${c.relative}"? A previous fix was written but not verified.` +
            `${paren(what)} [y/n] `,
        );
        if (yes) approved.push(c.input);
        else leftUnverified.push(c.relative);
        continue;
      }
      // The detail and "previously declined" share one parenthesis after the question.
      const detail = [what, analyzed.has(c.input) ? "" : "previously declined"].filter((p) => p !== "").join("; ");
      if (await askYesNo(question, `Fix "${c.relative}" in place?${paren(detail)} [y/n] `)) {
        approved.push(c.input);
      }
    }
  } finally {
    session?.close();
  }
  for (const relative of leftHalfDone) {
    io.stdout(
      `\nWARNING: "${relative}" is still partially modified. Run again and answer y, or ` +
        "revert it with: scope-sub revert <plan> --in-place --execute\n",
    );
  }

  for (const relative of leftUnverified) {
    io.stdout(
      `\nWARNING: "${relative}" is modified but was not verified or recorded as fixed. Run ` +
        "again and answer y, or revert it with: scope-sub revert <plan> --in-place --execute\n",
    );
  }
  const leftUnfinished = leftHalfDone.length + leftUnverified.length > 0;

  if (approved.length === 0) {
    io.stdout("\nNo files were modified.\n");
    return withUnchecked(leftUnfinished ? APPLY_EXIT.FIX_FAILURE : refusedCode());
  }
  io.stdout(`\nFixing ${plural(approved.length, "title")} in place…\n`);
  const result = await applyPlan(
    run.dir,
    {
      inPlace: true,
      execute: true,
      only: approved,
      ...(raw.preserveDates === true ? { preserveDates: true } : {}),
    },
    { log },
  );
  io.stdout(`\n${formatApplyReport(result)}`);
  return withUnchecked(
    leftUnfinished && result.exitCode === APPLY_EXIT.OK
      ? APPLY_EXIT.FIX_FAILURE
      : refusedCode(result.files),
  );
}

/** Attach the `review` subcommand to a commander program. */
export function registerReviewCommand(program: Command, io: CliIo = defaultIo): Command {
  return program
    .command("review")
    .description(
      "scan a library for new or changed titles and fix those that need it in place, " +
        "asking y/n for each (no backups: the plan directory holds the undo data)",
    )
    .argument("<paths...>", "the library directory (or files) to scan")
    .requiredOption(
      "--plan <dir>",
      "the plan directory for this library: scan results and undo data",
    )
    .option(
      "--aspect <ratio>",
      'picture aspect ratio (e.g. 2.39), or "auto" to detect it; must match the plan',
      "auto",
    )
    .option("-r, --recursive", "descend into subdirectories", false)
    .option("--jobs <n>", "files analyzed in parallel", "1")
    .option(
      "--preserve-dates",
      "restore each file's modification date after writing",
      false,
    )
    .option(`--log-level <level>`, `one of ${LOG_LEVELS.join("|")}`, "info")
    .action(async (paths: string[], options: RawReviewOptions) => {
      process.exitCode = await runReview(paths, options, io);
    });
}
