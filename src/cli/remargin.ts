/**
 * `scope-sub remargin <library...> --plan <dir>`: redo the repairs a plan made
 * with another margin, so every repaired title's subtitles land where this
 * version (or `--margin`) puts them.
 *
 * A repair cannot be nudged: the margin only says where a subtitle that is
 * outside the picture lands, and a repaired title's subtitles are inside. So
 * each such title is put back to its original bytes from the plan's undo
 * record, analyzed again, and repaired again — three steps the tool already
 * has (`revert --in-place`, `plan`, `apply --dangerously-in-place`), run here
 * for exactly the titles that need it. Every step is the verified one those
 * commands run, and the run can be repeated: a title already put back is not
 * put back twice, and one already redone is no longer stale.
 *
 * A dry run unless `--execute` is given.
 */
import { Command } from "commander";
import { applyPlan } from "../batch/apply.js";
import { DateWatch } from "../batch/dates.js";
import { completedByInput, lastWriteToInput, readApplyLog, unfinishedInPlace } from "../batch/log.js";
import { collectPlanTargets, planMismatch, REMARGIN_NOTE, redoIsDue, repairIsStale, runPlan } from "../batch/plan.js";
import {
  PlanFileError,
  planPaths,
  readPatchFile,
  requirePlan,
  type PlanFile,
  type PlanFileEntry,
} from "../batch/planFile.js";
import { revertPlan } from "../batch/revert.js";
import { runDoctor } from "./doctor.js";
import { defaultMargin } from "../geometry/classify.js";
import { createLogger, LOG_LEVELS } from "../scan/log.js";
import { resolve } from "node:path";
import { EXIT, resolveScanArgs, type CliIo, type RawScanOptions } from "./scan.js";

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export interface RawRemarginOptions extends RawScanOptions {
  plan?: string;
  execute?: boolean;
  /** Put each file's modification date back after every write to it. */
  preserveDates?: boolean;
}

/** Whether an entry's planned repair is one to redo (`redoIsDue`); false when unreadable. */
async function isStale(planDir: string, entry: PlanFileEntry, margin: number | undefined): Promise<boolean> {
  if (entry.patchFile === undefined) return false;
  try {
    return redoIsDue(entry, await readPatchFile(planDir, entry.patchFile), margin);
  } catch {
    return false;
  }
}

export interface RemarginSurvey {
  /**
   * Repaired in the file itself with another margin (or put back since and
   * not yet repaired again): put back, analyzed, repaired again.
   */
  repaired: PlanFileEntry[];
  /** Planned with another margin, the file in its original state: planned again. */
  planned: PlanFileEntry[];
  /** Repaired in a copy elsewhere: the copy is not touched; say so. */
  copies: { entry: PlanFileEntry; output: string }[];
  /** An in-place write that never finished (a fix or an undo): finished first, by `apply`. */
  unfinished: PlanFileEntry[];
  /** Of `repaired`, the (resolved) inputs an earlier run already analyzed again: only the repair is left. */
  analyzed: Set<string>;
}

/** Sort the plan's repairs made with another margin by what can be done about each. */
export async function surveyRemargin(
  planDir: string,
  plan: PlanFile,
  margin: number | undefined,
): Promise<RemarginSurvey> {
  const logged = await readApplyLog(planPaths(planDir).applyLog);
  const completed = completedByInput(logged);
  const open = unfinishedInPlace(logged);
  const lastWrites = lastWriteToInput(logged);
  const survey: RemarginSurvey = { repaired: [], planned: [], copies: [], unfinished: [], analyzed: new Set() };
  for (const entry of plan.files) {
    if (entry.action !== "fix") continue;
    const stale = await isStale(planDir, entry, margin);
    const done = completed.get(entry.input);
    // Put back by an earlier run of this command and analyzed again, but not
    // yet repaired: the run was stopped. Its entry already has the new margin.
    // (Analyzed *after* that revert: a title someone put back on purpose
    // later on has the note too, and is theirs to leave unrepaired.)
    const last = lastWrites.get(entry.input);
    // Likewise a title put back, analyzed again and *kept* (`redo_tried`, set
    // after that revert): its old repair still has to be written back.
    const halfDone =
      done === undefined &&
      last?.event === "reverted" &&
      (((entry.notes ?? []).some((n) => n.startsWith(REMARGIN_NOTE)) &&
        Date.parse(entry.analyzed) > Date.parse(last.time)) ||
        (entry.redo_tried !== undefined &&
          Date.parse(entry.redo_tried.at) > Date.parse(last.time)));
    if (open.has(entry.input)) {
      // Whatever its margin: a half-written file is finished before anything else.
      survey.unfinished.push(entry);
      continue;
    }
    if (!stale && !halfDone) continue;
    if (halfDone) {
      survey.repaired.push(entry);
      survey.analyzed.add(resolve(entry.input));
    } else if (done === undefined && lastWrites.get(entry.input)?.event === "reverted") {
      // Put back in place and not analyzed since.
      survey.repaired.push(entry);
    } else if (done === undefined) {
      survey.planned.push(entry);
    } else if (resolve(done.output ?? entry.input) === resolve(entry.input) || done.event === "replaced") {
      survey.repaired.push(entry);
    } else {
      survey.copies.push({ entry, output: done.output ?? "" });
    }
  }
  return survey;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

export async function runRemargin(
  paths: readonly string[],
  raw: RawRemarginOptions,
  io: CliIo = defaultIo,
): Promise<number> {
  let args: ReturnType<typeof resolveScanArgs>;
  try {
    args = resolveScanArgs(raw);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.BAD_ARGS;
  }
  const dates = raw.preserveDates === true ? { preserveDates: true } : {};
  if (paths.length === 0) {
    io.stderr("no paths given; pass the library directory\n");
    return EXIT.BAD_ARGS;
  }
  if (raw.plan === undefined || raw.plan.trim() === "") {
    io.stderr("--plan <dir> is required: the plan directory kept for this library\n");
    return EXIT.BAD_ARGS;
  }
  const planDir = resolve(raw.plan);
  const execute = raw.execute === true;
  const log = createLogger(args.logLevel, (line) => io.stderr(`${line}\n`));

  let plan: PlanFile;
  let survey: RemarginSurvey;
  try {
    plan = await requirePlan(planDir);
    survey = await surveyRemargin(planDir, plan, args.scan.margin);
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return err instanceof PlanFileError ? EXIT.BAD_ARGS : EXIT.UNSUPPORTED_MEDIA;
  }

  const marginText =
    args.scan.margin === undefined
      ? `the default margin (${defaultMargin(1080)} px at 1080)`
      : `a margin of ${args.scan.margin} px`;

  // Everything that could stop the run is checked before a file is touched: a
  // title put back and then not analyzed is a title left unrepaired.
  const planOptions = {
    ...args.scan,
    method: plan.options.method,
    ...(plan.options.remuxFallback === true ? { remuxFallback: true } : {}),
    ...(plan.options.fastPath === false ? { full: true } : {}),
    remargin: true,
  };
  const mismatch = planMismatch(plan, planOptions, plan.options.method);
  if (mismatch !== null) {
    io.stderr(
      `${planDir} was built ${mismatch}, so this run cannot extend it. No files were modified.\n` +
        (args.scan.margin !== undefined && plan.options.margin === undefined
          ? "This plan uses the default margin. Omit --margin to redo it with the current default.\n"
          : ""),
    );
    return EXIT.BAD_ARGS;
  }
  const { targets, missing } = await collectPlanTargets(paths, args.scan.recursive === true);
  if (missing.length > 0) {
    io.stderr(`not found: ${missing.join(", ")}. No files were modified.\n`);
    return EXIT.BAD_ARGS;
  }
  const found = new Set(targets.map((t) => resolve(t.file)));
  const reachable = survey.repaired.filter((e) => found.has(resolve(e.input)));
  const unreachable = survey.repaired.filter((e) => !found.has(resolve(e.input)));

  io.stdout(
    `Fixes in ${planDir} to redo with ${marginText} (made with another margin, or leaving ` +
      "subtitles an earlier version could not move):\n",
  );
  io.stdout(
    `  ${plural(reachable.length, "title")} fixed in place: reverted, reanalyzed and fixed again, one at a time\n`,
  );
  for (const e of reachable) io.stdout(`    ${e.relative}\n`);
  if (unreachable.length > 0) {
    io.stdout(
      `  ${plural(unreachable.length, "title")} fixed in place but not found under ${paths.join(", ")}` +
        `${args.scan.recursive === true ? "" : " (without --recursive)"}: skipped\n`,
    );
    for (const e of unreachable) io.stdout(`    ${e.input}\n`);
  }
  if (survey.planned.length > 0) {
    io.stdout(`  ${plural(survey.planned.length, "title")} planned but not fixed: planned again (not fixed by this command)\n`);
    for (const e of survey.planned) io.stdout(`    ${e.relative}\n`);
  }
  if (survey.copies.length > 0) {
    io.stdout(
      `  ${plural(survey.copies.length, "title")} fixed as ${survey.copies.length === 1 ? "a copy" : "copies"}: copies and plan entries unchanged\n`,
    );
    for (const c of survey.copies) io.stdout(`    ${c.entry.relative} (${c.output})\n`);
  }
  if (survey.unfinished.length > 0) {
    io.stdout(
      `  ${plural(survey.unfinished.length, "title")} with an unfinished in-place write: ` +
        "completed first, then reassessed\n",
    );
    for (const e of survey.unfinished) io.stdout(`    ${e.relative}\n`);
  }
  const blocked = unreachable.length > 0;
  if (reachable.length === 0 && survey.planned.length === 0 && survey.unfinished.length === 0) {
    io.stdout("\nNothing to redo.\n");
    return blocked ? EXIT.UNSUPPORTED_MEDIA : EXIT.OK;
  }
  if (!execute) {
    io.stdout(
      "\nDry run: no files were modified. Each fixed title would be read in full once. " +
        "Pass --execute to proceed.\n",
    );
    return EXIT.OK;
  }
  const doctor = await runDoctor();
  if (!doctor.ok) {
    io.stderr(
      "Required tools are not working (run `scope-sub doctor`). Titles cannot be " +
        "reanalyzed without them. No files were modified.\n",
    );
    return EXIT.DEPENDENCY_MISSING;
  }

  // A write that never finished comes first: `apply` finishes it either way
  // round (a fix carried through, an undo turned back into the repair), and
  // the title is then judged like any other.
  if (survey.unfinished.length > 0) {
    io.stdout(`\nFinishing ${plural(survey.unfinished.length, "interrupted write")}…\n`);
    const inputs = survey.unfinished.map((e) => e.input);
    let unfinishedLeft = inputs.length;
    try {
      const finished = await applyPlan(planDir, { inPlace: true, execute: true, only: inputs, ...dates }, { log });
      unfinishedLeft = finished.files.filter((f) => f.status !== "applied" && f.status !== "skipped").length;
      for (const f of finished.files) {
        if (f.status !== "applied" && f.status !== "skipped") {
          io.stdout(`  ${f.relative}: ${f.status} — ${f.reason ?? "unknown reason"}\n`);
        }
      }
    } catch (err) {
      io.stderr(`${errorText(err)}\n`);
    }
    const stillOpen = unfinishedInPlace(await readApplyLog(planPaths(planDir).applyLog));
    if (unfinishedLeft > 0 || inputs.some((p) => stillOpen.has(p))) {
      io.stderr("An interrupted write could not be completed; no other files were modified. Run `review` for details.\n");
      return EXIT.UNSUPPORTED_MEDIA;
    }
    return runRemargin(paths, raw, io);
  }

  // One title at a time, so at most one is ever without its repair: put it
  // back, analyze it, repair it. Whatever the analysis says, the last step
  // runs — on the new entry, or on the one the plan kept — so a title leaves
  // this loop repaired unless the repair itself fails.
  let redone = 0;
  const kept: { relative: string; reason: string }[] = [];
  const failures: { relative: string; reason: string }[] = [];
  const say = (text: string): void => io.stdout(`${text}\n`);
  // One watch over the kept dates for every step of every title: each file is
  // watched while the run goes on, and the run waits once, at its end.
  const dateWatch = new DateWatch({ log });

  for (const [n, entry] of reachable.entries()) {
    const input = entry.input;
    say(`\n[${n + 1}/${reachable.length}] ${entry.relative}`);
    try {
      const reverted = await revertPlan(
        planDir,
        { inPlace: true, execute: true, only: [input], ...dates },
        { log, dateWatch },
      );
      const back = reverted.files.find((f) => resolve(f.input) === resolve(input));
      if (back?.status === "failed") {
        failures.push({ relative: entry.relative, reason: `could not be reverted (${back.reason ?? "unknown reason"}); unchanged` });
        say(`  could not be reverted: ${back.reason ?? "unknown reason"}; unchanged`);
        continue;
      }
    } catch (err) {
      failures.push({ relative: entry.relative, reason: `could not be reverted (${errorText(err)}); unchanged` });
      say(`  could not be reverted: ${errorText(err)}; unchanged`);
      continue;
    }

    let keptWhy: string | undefined;
    try {
      const run = await runPlan(paths, planDir, { ...planOptions, only: [input] }, { log });
      keptWhy =
        run.remarginKept.find((k) => resolve(k.input) === resolve(input))?.reason ??
        (run.unreadable.some((f) => resolve(f) === resolve(input))
          ? "it could not be read for reanalysis"
          : undefined);
    } catch (err) {
      keptWhy = `analysis failed (${errorText(err)})`;
    }

    // Repair it: with the new margin, or — when the plan kept its entry — as
    // it was before, which is always better than leaving it unrepaired.
    let status = "failed";
    let reason: string | undefined;
    try {
      const applied = await applyPlan(
        planDir,
        { inPlace: true, execute: true, only: [input], ...dates },
        { log, dateWatch },
      );
      const file = applied.files.find((f) => resolve(f.input) === resolve(input));
      status = file?.status ?? "failed";
      reason = file?.reason ?? (file === undefined ? "the plan no longer lists it as a fix" : undefined);
    } catch (err) {
      reason = errorText(err);
    }
    // What the title's repair now is, from the plan itself rather than from
    // what the steps above said they did.
    let atNewMargin = false;
    try {
      const now = (await requirePlan(planDir)).files.find((e) => resolve(e.input) === resolve(input));
      if (now?.patchFile !== undefined) {
        const patchFile = await readPatchFile(planDir, now.patchFile);
        atNewMargin = patchFile.tracks.length > 0 && !repairIsStale(patchFile, args.scan.margin);
      }
    } catch {
      atNewMargin = false;
    }
    if (status !== "applied") {
      // `skipped` here means the repair step did nothing (the file gone, the
      // share dropped): the title was put back and is not repaired.
      failures.push({
        relative: entry.relative,
        reason: `reverted but not fixed again (${reason ?? status}); the file is in its original state — run again`,
      });
      say(`  NOT fixed again: ${reason ?? status}. The file is in its original state.`);
    } else if (!atNewMargin || keptWhy !== undefined) {
      // `keptWhy`: the plan kept the entry it had, whatever its patch file
      // looks like by the margin alone.
      const why = keptWhy ?? "the new analysis was not used";
      kept.push({ relative: entry.relative, reason: why });
      say(`  fixed as before: ${why}`);
    } else {
      redone++;
      say("  fixed again");
    }
  }

  // A date that could not be kept is reported, never a failed repair.
  const dateProblems = (await dateWatch.settle()).map(({ path, problem }) => ({
    relative: reachable.find((e) => resolve(e.input) === resolve(path))?.relative ?? path,
    problem,
  }));

  // Titles planned and never repaired: planned again, they alone.
  if (survey.planned.length > 0) {
    try {
      await runPlan(paths, planDir, { ...planOptions, only: survey.planned.map((e) => e.input) }, { log });
    } catch (err) {
      io.stderr(`${errorText(err)}\n`);
      return err instanceof PlanFileError ? EXIT.BAD_ARGS : EXIT.UNSUPPORTED_MEDIA;
    }
  }

  io.stdout(`\n${plural(redone, "title")} fixed again with ${marginText}.\n`);
  if (kept.length > 0) {
    io.stdout(`${plural(kept.length, "title")} kept as before:\n`);
    for (const k of kept) io.stdout(`  ${k.relative}: ${k.reason}\n`);
  }
  if (dateProblems.length > 0) {
    io.stdout(`${plural(dateProblems.length, "title")} whose date could not be preserved (run \`restore-dates\` to restore it):\n`);
    for (const d of dateProblems) io.stdout(`  ${d.relative}: ${d.problem}\n`);
  }
  if (failures.length > 0) {
    io.stdout(`${plural(failures.length, "title")} with a problem:\n`);
    for (const f of failures) io.stdout(`  ${f.relative}: ${f.reason}\n`);
  }
  // 0 only when every title is at the new margin: a caller must be able to
  // tell "all redone" from "some kept as they were" (1) and from a failure (4).
  if (failures.length > 0 || blocked) return EXIT.UNSUPPORTED_MEDIA;
  return kept.length > 0 ? EXIT.NEEDS_FIX : EXIT.OK;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerRemarginCommand(program: Command, io: CliIo = defaultIo): Command {
  return program
    .command("remargin")
    .description(
      "redo in place the fixes a plan made with another margin: revert, reanalyze and " +
        "fix each title again (dry run without --execute)",
    )
    .argument("<paths...>", "the library directory (or files) the plan is for")
    .requiredOption("--plan <dir>", "the plan directory kept for this library")
    .option("--aspect <ratio>", 'picture aspect ratio (e.g. 2.39), or "auto" to detect it; must match the plan', "auto")
    .option("-r, --recursive", "descend into subdirectories", false)
    .option("--margin <px>", "distance kept between a moved subtitle and the picture edge (default: 24 px at 1080)")
    .option("--jobs <n>", "files analyzed in parallel", "1")
    .option("--execute", "write changes (default: dry run)", false)
    .option(
      "--preserve-dates",
      "restore each file's modification date after writing",
      false,
    )
    .option(`--log-level <level>`, `one of ${LOG_LEVELS.join("|")}`, "info")
    .action(async (paths: string[], options: RawRemarginOptions) => {
      process.exitCode = await runRemargin(paths, options, io);
    });
}
